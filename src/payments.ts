import type { Api, Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { config, kaspiLinkFor } from "./config.js";
import {
  addCredits,
  awardPurchaseXp,
  claimOfferRedemption,
  createOrder,
  getOrder,
  grantOrderCredits,
  logEvent,
  markPaidClaimed,
  offerBonusFor,
  resolveOrder,
  type ApprovalPath,
  rewardPartnerOnPurchase,
  rewardReferralOnPurchase,
  type UserRow,
} from "./db.js";
import { kaspiVerifyOrder } from "./kaspi.js";
import { MODELS, PACKS, packById, REFERRAL_MILESTONES, type ModelSpec, type Pack } from "./models.js";
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
  const visible = PACKS.filter((p) => (!p.offer || active) && !p.course && !p.retired);
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
 *
 * The anchor must actually CLOSE THE GAP the user is standing in front of. The
 * combo is 36 🔫 while the video models cost 42 / 61 / 76 🔫, so anchoring it
 * unconditionally promised a result the pack cannot buy: the buyer pays 1000 ₸,
 * lands back on the same paywall, and asks for a refund — with an ad click burnt
 * on the way in. So we size against the SHORTFALL (`model.credits` minus what
 * they already hold), not against the sticker price, and step up the ladder only
 * as far as we have to. Every campaign video scene is affected, which is exactly
 * what paid traffic would be pointed at.
 */
function entryPack(model?: ModelSpec, credits = 0): Pack {
  const shortfall = model ? Math.max(0, model.credits - credits) : 0;
  const covers = (p: Pack): boolean => p.credits >= shortfall;
  if (comboActive()) {
    const offer = PACKS.find((p) => p.offer && !p.retired && covers(p));
    if (offer) return offer;
  }
  // Ladder packs only — course tiers are sold via /course and must never anchor
  // a generation paywall, and retired packs exist solely to resolve old orders.
  // Sorted by size rather than trusting declaration order: PACKS groups packs by
  // PURPOSE (ladder, then the purpose-built sets), so `video_set` at 650 🔫 is
  // declared after `studio` at 900 🔫. `find` on the raw array would hand a
  // 700 🔫 shortfall the 42 000 ₸ pack when the 31 000 ₸ one covers it.
  const ladder = PACKS.filter((p) => !p.offer && !p.course && !p.retired).sort((a, b) => a.credits - b.credits);
  return ladder.find(covers) ?? ladder[ladder.length - 1] ?? PACKS[0];
}

/**
 * How many of `model`'s results the buyer can run ONCE THIS PACK LANDS — their
 * remaining balance counts too, which is the number they actually experience.
 * No clamp: a floor of 1 is what made the old copy lie. `entryPack` already
 * guarantees ≥1 by construction (the top ladder pack is an order of magnitude
 * above the priciest model), so an honest count is also always a positive one.
 */
function resultsAfterPack(pack: Pack, model: ModelSpec, credits: number): number {
  return Math.floor((credits + pack.credits) / model.credits);
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
  const pack = entryPack(model, credits);
  const n = resultsAfterPack(pack, model, credits);
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
  const credits = user?.credits ?? 0;
  const pack = entryPack(model, credits);
  const n = resultsAfterPack(pack, model, credits);
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
  // XP for the money, and the inviter's share of it. Runs behind the same
  // claim as the credits, so it can only ever fire for a purchase that really
  // landed — never for a refunded or half-granted one. Never fatal: a failure
  // here must not roll back credits the buyer has already been told about.
  await awardPurchaseXp(userId, orderId, pack.kzt).catch((err) =>
    console.error(`[xp] purchase XP failed for order #${orderId}:`, err),
  );

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
  // Personal offer from a conversion push, if one is still live. Claimed
  // separately from the credit grant so it can be at most once per user ever,
  // and read from the push itself so the window can never disagree with what
  // the user was actually told. Ships inert (bonus 0) — the mechanism deploys
  // ahead of the decision about the number.
  let bonus = 0;
  if (config.pushOfferBonus > 0 && (await offerBonusFor(userId, config.pushOfferHours))) {
    if (await claimOfferRedemption(userId)) {
      bonus = config.pushOfferBonus;
      await addCredits(userId, bonus, "push_offer", pack.id);
    }
  }
  await api
    .sendMessage(
      userId,
      `✅ Начислено ${UNIT_EMOJI} ${nUnits(pack.credits)}.` +
        (bonus > 0 ? ` Плюс бонус по вашему предложению: ${UNIT_EMOJI} ${nUnits(bonus)}!` : "") +
        ` Пришлите фото или напишите идею!`,
    )
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
 *
 * `via` records WHICH of those callers believed the payment — stamped on the
 * order in the same statement as the transition (see resolveOrder), so a
 * granted order is never anonymous.
 */
export async function settleApprovedOrder(
  api: Api,
  orderId: number,
  via: ApprovalPath = "admin",
): Promise<Pack | null> {
  // Resolve the pack BEFORE the atomic paid-transition: if a pack id was removed
  // or renamed while the order was pending, we must NOT mark it paid (that would
  // strand the order "paid but ungranted"). Leaving it pending keeps it
  // recoverable. Mirrors the webhook's order→pack→resolve→grant ordering.
  const order = await getOrder(orderId);
  if (!order || order.status !== "pending") return null;
  const pack = packById(order.pack_id);
  if (!pack) return null;
  const won = await resolveOrder(orderId, true, via);
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
  // Start the clock on "someone is out of pocket and waiting" BEFORE we go and
  // ask Kaspi: if the verifier hangs or throws, the buyer has still told us they
  // paid, and that is precisely the case the stuck-payment alert exists to catch.
  await markPaidClaimed(orderId);
  const status = await kaspiVerifyOrder(order);
  if (status === "paid" && config.kaspiAutoGrant) {
    const pack = await settleApprovedOrder(api, orderId, "kaspi_api");
    return { kind: "granted", credits: pack ? pack.credits : null };
  }
  // Only trust a verdict the merchant API actually produced. "unknown" means we
  // never got an answer (token missing, endpoint wrong, Kaspi down) — falling
  // through to the admin ping there is the difference between a buyer waiting a
  // few minutes and a buyer who paid being told forever that we see no payment.
  if (status === "pending" || status === "failed") return { kind: "pending", failed: status === "failed" };
  // Everything else — including "Kaspi says paid but auto-grant is off" — goes
  // to a human. The verifier's own verdict rides along so the decision is one
  // informed tap rather than a fresh investigation.
  const hint = status === "paid" ? "\n✅ Kaspi подтверждает оплату (авто-начисление выключено)." : "";
  for (const adminId of config.adminIds)
    await api
      .sendMessage(
        adminId,
        `💸 Заявка №${orderId}: ${who} отметил оплату.${hint}\nПроверьте Kaspi → /order ${orderId} ok|no`,
      )
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
        `Заявка №${orderId}\n\n` +
        // Who is taking the money and on what terms, ON the screen where the
        // money is taken — not one tab away in an app the buyer may never open.
        `<i>Продавец: ИП «Z8 Capital», БИН 030722500509 · komekforyou@gmail.com\n` +
        `Условия и возврат: /refund</i>`,
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
      // Name the order and a real deadline. "В ближайшее время" is what a buyer
      // reads right before deciding they have been scammed: it carries no number
      // to quote, no time to wait for, and no way to ask again. The number is
      // also what the owner needs typed back at them to run `/order N ok`.
      await ctx.reply(
        `✅ Спасибо! Заявка <b>№${orderId}</b> принята — проверяем оплату вручную.\n\n` +
          `Обычно это занимает <b>до 30 минут</b>. Если ${UNIT_EMOJI} патроны не пришли за это время — ` +
          `напишите /help и укажите номер заявки, разберёмся.`,
        { parse_mode: "HTML" },
      );
    }
  });
}

/**
 * The price crib on the balance screen, DERIVED from the registry rather than
 * typed out. The hand-written version had drifted to "Видео 25–76" while the
 * cheapest video actually costs 10 🔫 — quoting a floor 2.5× too high on the
 * one screen where people decide whether video is worth paying for. Reading the
 * numbers from MODELS means a re-priced or newly added model can never leave a
 * stale figure in front of a buyer.
 */
function priceCrib(): string {
  const of = (kinds: ModelSpec["kind"][]): number[] =>
    Object.values(MODELS)
      .filter((m) => kinds.includes(m.kind))
      .map((m) => m.credits);
  const range = (xs: number[]): string => {
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    return lo === hi ? `${lo}` : `${lo}–${hi}`;
  };
  return `Картинка ${range(of(["text_to_image", "image_edit"]))} · Видео ${range(of(["image_to_video"]))} ${UNIT_EMOJI}`;
}

export async function sendBalance(ctx: Context, credits: number): Promise<void> {
  await ctx.reply(`💰 Баланс: ${UNIT_EMOJI} ${nUnits(credits)}\n\n` + priceCrib(), {
    reply_markup: packsKeyboard(),
  });
}
