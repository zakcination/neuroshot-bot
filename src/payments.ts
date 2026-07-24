import type { Api, Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { config, kaspiLinkFor } from "./config.js";
import {
  createOrder,
  getOrder,
  grantOrderCredits,
  logEvent,
  resolveOrder,
  rewardPartnerOnPurchase,
  rewardReferralOnPurchase,
  type UserRow,
} from "./db.js";
import { kaspiVerifyOrder } from "./kaspi.js";
import { PACKS, packById, REFERRAL_MILESTONES, type ModelSpec, type Pack } from "./models.js";
import { comboActive, comboLeftText } from "./offer.js";
import { nResults, nUnits, UNIT_EMOJI } from "./text.js";

/**
 * Pack list for the buy menu — Kaspi/KZT priced; the limited-time combo offer
 * leads (with its live "осталось Nд Nч" snapshot) while active, and drops off the
 * list once the sale ends — mirroring the Mini App's self-removing offer, so the
 * ladder is never "broken" by a permanent below-ladder price.
 */
export function packsKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  const active = comboActive();
  // Course tiers are excluded here — they carry a cohort invite, not just
  // patrons, and would confuse a plain credit top-up buyer. They're surfaced
  // only via the dedicated /course command (bot.ts), reusing this same buy:<id>
  // callback under the hood.
  const visible = PACKS.filter((p) => (!p.offer || active) && !p.course);
  const ordered = [...visible].sort((a, b) => Number(b.offer ?? false) - Number(a.offer ?? false));
  for (const pack of ordered) {
    const left = pack.offer && active ? ` · ⏳ ${comboLeftText()}` : "";
    kb.text(`${pack.title} — ${pack.kzt} ₸${left}`, `buy:${pack.id}`).row();
  }
  return kb;
}

/**
 * The pack anchored on the paywall: the combo offer while it's live (the tripwire),
 * else the cheapest ladder pack once the sale ends — so an expired offer never
 * anchors the paywall.
 */
function entryPack(): Pack {
  if (comboActive()) {
    const offer = PACKS.find((p) => p.offer);
    if (offer) return offer;
  }
  return PACKS.find((p) => !p.offer) ?? PACKS[0];
}

/** How many of `model`'s results a pack buys (≥1, for the "N результатов" framing). */
function resultsPerPack(pack: Pack, model: ModelSpec): number {
  return Math.max(1, Math.floor(pack.credits / model.credits));
}

/** Short pack name for the CTA (strip the 🔥 and the ": …" tail). */
function packShort(pack: Pack): string {
  return pack.title.replace(/^🔥\s*/, "").split(/[—:]/)[0].trim();
}

/**
 * Paywall as a sales page (not a naked "недостаточно"): outcome-first headline,
 * the entry pack anchored and framed as "≈ N таких результатов", one dominant
 * CTA (buy the entry pack) + a secondary "все пакеты". Contextual to the exact
 * result the user just tried. While the combo sale is live it carries the same
 * countdown the Mini App shows, so urgency lands at the paywall moment.
 */
export function paywallText(model: ModelSpec, credits: number): string {
  const pack = entryPack();
  const n = resultsPerPack(pack, model);
  const left = pack.offer && comboActive() ? `\n⏳ <b>Осталось: ${comboLeftText()}</b> — успейте по акции!` : "";
  return (
    `✨ <b>Ещё один шаг до результата!</b>\n\n` +
    `«${model.label}» — ${nUnits(model.credits)}. У вас ${nUnits(credits)}.\n\n` +
    `🔥 «${pack.title}»: <b>${nResults(n)}</b> за ${pack.kzt} ₸ — оплата картой Kaspi.${left}`
  );
}

/**
 * Primary CTA = the entry pack (framed by results); secondary = all packs.
 * If the caller still has an unclaimed welcome bonus parked (see
 * claimWelcomeBonus in db.ts), that's the FIRST row — cheaper than a paywall
 * for someone who hasn't even collected their free patrons yet.
 */
export function paywallKeyboard(model: ModelSpec, user?: UserRow): InlineKeyboard {
  const pack = entryPack();
  const n = resultsPerPack(pack, model);
  const kb = new InlineKeyboard();
  const pending = user ? user.pendingSignupCredits + user.pendingJoinBonus : 0;
  if (user && !user.welcomeBonusClaimed && pending > 0) {
    kb.text(`🎁 Забрать бесплатные ${nUnits(pending)}`, "claim:welcome").row();
  }
  return kb.text(`${pack.kzt} ₸ · ${packShort(pack)}: ${nResults(n)}`, `buy:${pack.id}`).row().text("💎 Все пакеты", "show_packs");
}

const COURSE_TIER_LABEL: Record<"fast" | "flagship", string> = {
  fast: "«Быстрый старт»",
  flagship: "«AI-контент под ключ»",
};

/**
 * Grant cohort ACCESS for a course purchase: delivery is a private-channel
 * invite (docs/course/README.md), not an in-chat dump. The owner creates the
 * channel manually and sets COURSE_FAST_CHANNEL_ID / COURSE_FLAGSHIP_CHANNEL_ID
 * (src/config.ts) once the bot is an admin there with "invite users via link".
 *
 * This function ONLY grants access — it deliberately has no opinion on who
 * reviews homework inside the channel (that's manual today; a planned AI tutor
 * will slot in later) — a clean, swappable seam by construction.
 *
 * Never throws into the caller: a missing/blank channel id or a Telegram API
 * failure (e.g. the bot isn't actually an admin there) must NOT fail or roll
 * back the purchase — credits are already granted by the time this runs.
 */
async function inviteToCourseCohort(api: Api, userId: number, tier: "fast" | "flagship"): Promise<void> {
  const channelId = tier === "fast" ? config.courseFastChannelId : config.courseFlagshipChannelId;
  const label = COURSE_TIER_LABEL[tier];
  if (!channelId) {
    console.error(
      `[course] cohort channel unset for tier "${tier}" — cannot invite user ${userId} into ${label}. ` +
        `Set COURSE_${tier === "fast" ? "FAST" : "FLAGSHIP"}_CHANNEL_ID once the private channel exists (.env.example).`,
    );
    // A paying buyer must never see NOTHING beyond the credit confirmation —
    // same graceful fallback as the createChatInviteLink-failure path below,
    // just for "not configured yet" instead of a Telegram API error.
    await api
      .sendMessage(
        userId,
        `🎓 Курс ${label} куплен — ссылку на приватный канал пришлём в течение дня, уже готовим доступ.`,
      )
      .catch(() => {});
    return;
  }
  try {
    const invite = await api.createChatInviteLink(channelId, { member_limit: 1, name: `course:${tier}:${userId}` });
    await api
      .sendMessage(
        userId,
        `🎓 Добро пожаловать в когорту ${label}!\n\n` +
          `Ваша персональная ссылка на приватный канал курса (одноразовая):\n${invite.invite_link}`,
      )
      .catch(() => {});
  } catch (err) {
    console.error(`[course] createChatInviteLink failed for tier "${tier}" / user ${userId}:`, err);
    await api
      .sendMessage(
        userId,
        `🎓 Курс ${label} куплен — ссылку на приватный канал пришлём в течение дня, уже готовим доступ.`,
      )
      .catch(() => {});
  }
}

/**
 * Grant a completed purchase: credit the patrons, journal it, fire the (abuse-safe,
 * purchase-gated) partner/referral payouts, and notify everyone. Shared by the
 * Kaspi order-approval path (and any future payment provider) so crediting is
 * identical no matter how the payment was confirmed.
 *
 * grantOrderCredits is the FIRST thing this does — an atomic claim-and-credit
 * that only one caller can win, and that never leaves a half-state (see its
 * doc comment). That makes this whole function safe to retry: the reconciler
 * sweep (monitor.ts), a duplicate webhook delivery, and an admin re-running
 * `/order N ok` can all call this on the same order without ever
 * double-crediting. A caller that loses the race returns immediately.
 */
export async function grantPurchase(api: Api, userId: number, pack: Pack, orderId: number): Promise<void> {
  if (!(await grantOrderCredits(orderId, userId, pack.credits, pack.kzt))) return;
  await logEvent(userId, "purchase", `${pack.id}:${pack.kzt}`);

  // Attribution is exclusive: a buyer came via a creator code OR a friend link.
  const partnerPayout = await rewardPartnerOnPurchase(userId, pack.credits);
  if (partnerPayout && partnerPayout.amount > 0) {
    const prefix = partnerPayout.kind === "partner" ? "p_" : "c_";
    const note =
      partnerPayout.kind === "partner"
        ? `🤝 +${nUnits(partnerPayout.amount)} кэшбэка — покупка по вашей ссылке ${prefix}${partnerPayout.code}! Доступно к выводу.`
        : `🤝 +${nUnits(partnerPayout.amount)} — покупка по вашему коду ${prefix}${partnerPayout.code}!`;
    await api.sendMessage(partnerPayout.ownerId, note).catch(() => {});
  }
  const payout = partnerPayout
    ? null
    : await rewardReferralOnPurchase(userId, pack.credits, {
        percent: config.referralPercent,
        firstPurchaseBonus: config.referralFirstPurchaseBonus,
        milestones: REFERRAL_MILESTONES,
      });
  if (payout) {
    const pct = Math.round(config.referralPercent * 100);
    const lines: string[] = [];
    if (payout.firstPurchase > 0)
      lines.push(`🎉 +${nUnits(payout.firstPurchase)} — ваш друг сделал первую покупку!`);
    if (payout.lifetime > 0) lines.push(`💸 +${nUnits(payout.lifetime)} — друг купил пакет (${pct}%)`);
    for (const m of payout.milestones)
      lines.push(`🏆 +${nUnits(m.bonus)} — ${m.friends} ваших друзей уже покупают!`);
    if (lines.length) await api.sendMessage(payout.referrerId, lines.join("\n")).catch(() => {});
  }
  await api
    .sendMessage(userId, `✅ Начислено ${UNIT_EMOJI} ${nUnits(pack.credits)}. Пришлите фото или напишите идею!`)
    .catch(() => {});

  if (pack.course) await inviteToCourseCohort(api, userId, pack.course);
}

/** Buttons under a pending Kaspi order: "I paid" (pings admins) + all packs. */
function paidKeyboard(orderId: number): InlineKeyboard {
  return new InlineKeyboard().text("✅ Я оплатил", `paid:${orderId}`).row().text("💎 Все пакеты", "show_packs");
}

/**
 * Approve a pending order and grant the pack — the single settle path shared by
 * the admin `/order N ok` command, the signed Kaspi webhook, and the server-side
 * «Я оплатил» verification. resolveOrder flips pending→paid atomically (exactly
 * one winner), so a double-confirm can never double-credit. Returns the granted
 * pack, or null if the order was already resolved / unknown.
 */
export async function settleApprovedOrder(api: Api, orderId: number): Promise<Pack | null> {
  // Resolve the pack BEFORE the atomic paid-transition: if a pack id was removed
  // or renamed while the order was pending, we must NOT mark it paid (that would
  // strand the order "paid but ungranted"). Leaving it pending keeps it
  // recoverable. Mirrors the webhook's order→pack→resolve→grant ordering.
  const order = await getOrder(orderId);
  if (!order || order.status !== "pending") return null;
  const pack = packById(order.pack_id);
  if (!pack) return null;
  const won = await resolveOrder(orderId, true);
  if (!won) return null; // lost the race — already resolved by another path
  await grantPurchase(api, won.user_id, pack, orderId);
  return pack;
}

/** Outcome of an "✅ Я оплатил" claim — mapped to bot replies AND Mini App JSON. */
export type PaidClaim =
  | { kind: "not_found" }
  | { kind: "already" }
  | { kind: "granted"; credits: number | null }
  | { kind: "pending"; failed: boolean }
  | { kind: "admin" };

/**
 * Shared "✅ Я оплатил" handler for BOTH the bot button and the Mini App, so the
 * two surfaces behave identically. Verifies the order against Kaspi server-side
 * and grants automatically when the merchant API confirms it paid; when that API
 * isn't wired (or hasn't seen the payment yet), pings admins for the manual
 * `/order N ok` approval — the same interim path the bot has always used.
 */
export async function claimOrderPaid(api: Api, orderId: number, who: string): Promise<PaidClaim> {
  const order = await getOrder(orderId);
  if (!order) return { kind: "not_found" };
  if (order.status === "paid") return { kind: "already" };
  const status = await kaspiVerifyOrder(order);
  if (status === "paid") {
    const pack = await settleApprovedOrder(api, orderId);
    return { kind: "granted", credits: pack ? pack.credits : null };
  }
  if (config.kaspiApiBase) return { kind: "pending", failed: status === "failed" };
  for (const adminId of config.adminIds)
    await api
      .sendMessage(adminId, `💸 Заявка №${orderId}: ${who} отметил оплату. Проверьте Kaspi → /order ${orderId} ok|no`)
      .catch(() => {});
  return { kind: "admin" };
}

export function registerPayments(bot: Bot): void {
  bot.callbackQuery("show_packs", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(`Выберите пакет ${UNIT_EMOJI} патронов (оплата картой Kaspi):`, { reply_markup: packsKeyboard() });
  });

  // Buy → record a pending order and hand over the Kaspi payment link. While the
  // link is blank (KASPI_PAY_URL unset) we tell the user payment isn't open yet.
  bot.callbackQuery(/^buy:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const pack = packById(ctx.match[1]);
    if (!pack || !ctx.from) return;
    const link = kaspiLinkFor(pack.id);
    if (!link) {
      await ctx.reply(
        "💳 Оплата картой Kaspi скоро откроется — всё уже готово, мы сообщим! " +
          "А пока попробуйте бесплатный сценарий 🎁",
      );
      return;
    }
    const orderId = await createOrder(ctx.from.id, pack.id, pack.kzt);
    await ctx.reply(
      `🧾 <b>${pack.title}</b> — <b>${pack.kzt} ₸</b>\n\n` +
        `1️⃣ Оплатите по ссылке Kaspi:\n${link}\n\n` +
        `2️⃣ После оплаты нажмите «✅ Я оплатил» — мы проверим платёж и начислим ${UNIT_EMOJI} патроны.\n\n` +
        `Заявка №${orderId}`,
      { parse_mode: "HTML", reply_markup: paidKeyboard(orderId) },
    );
  });

  // "I paid" → verify server-side against Kaspi when the merchant API is wired,
  // and grant automatically if paid — no admin in the loop. When the API isn't
  // configured (or can't reach Kaspi), fall back to pinging an admin (interim).
  bot.callbackQuery(/^paid:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const orderId = Number(ctx.match[1]);
    const who = ctx.from ? `${ctx.from.first_name} (@${ctx.from.username ?? ctx.from.id})` : "?";
    const claim = await claimOrderPaid(ctx.api, orderId, who);
    if (claim.kind === "not_found") {
      await ctx.reply("Заявка не найдена. Откройте /buy и попробуйте снова.");
    } else if (claim.kind === "already") {
      await ctx.reply(`✅ Эта оплата уже подтверждена — ${UNIT_EMOJI} патроны начислены.`);
    } else if (claim.kind === "granted") {
      await ctx.reply(
        claim.credits != null
          ? `✅ Оплата подтверждена автоматически! Начислено ${UNIT_EMOJI} ${nUnits(claim.credits)}.`
          : `✅ Оплата подтверждена — ${UNIT_EMOJI} патроны начислены.`,
      );
    } else if (claim.kind === "pending") {
      await ctx.reply(
        claim.failed
          ? "❌ Оплата не найдена или отклонена. Проверьте платёж в Kaspi и попробуйте ещё раз."
          : "⏳ Пока не видим оплату. Если вы только что оплатили — подождите минуту и нажмите «✅ Я оплатил» снова.",
      );
    } else {
      // No merchant API configured → interim admin approval (admins were pinged).
      await ctx.reply("Спасибо! Проверяем оплату — начислим патроны в ближайшее время ⏳");
    }
  });
}

export async function sendBalance(ctx: Context, credits: number): Promise<void> {
  await ctx.reply(
    `💰 Баланс: ${UNIT_EMOJI} ${nUnits(credits)}\n\n` +
      `Картинка от 2 · Премиум-фото 11 · Видео 25–76 ${UNIT_EMOJI}`,
    { reply_markup: packsKeyboard() },
  );
}
