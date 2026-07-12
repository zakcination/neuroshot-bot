import type { Api, Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { config, kaspiLinkFor } from "./config.js";
import {
  addCredits,
  createOrder,
  getOrder,
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
  const visible = PACKS.filter((p) => !p.offer || active);
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

/**
 * Grant a completed purchase: credit the patrons, journal it, fire the (abuse-safe,
 * purchase-gated) partner/referral payouts, and notify everyone. Shared by the
 * Kaspi order-approval path (and any future payment provider) so crediting is
 * identical no matter how the payment was confirmed.
 */
export async function grantPurchase(api: Api, userId: number, pack: Pack): Promise<void> {
  await addCredits(userId, pack.credits, "purchase", String(pack.kzt));
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
  await grantPurchase(api, won.user_id, pack);
  return pack;
}

export function registerPayments(bot: Bot): void {
  bot.callbackQuery("show_packs", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Выберите пакет 🔫 патронов (оплата картой Kaspi):", { reply_markup: packsKeyboard() });
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
    const order = await getOrder(orderId);
    if (!order) {
      await ctx.reply("Заявка не найдена. Откройте /buy и попробуйте снова.");
      return;
    }
    if (order.status === "paid") {
      await ctx.reply(`✅ Эта оплата уже подтверждена — ${UNIT_EMOJI} патроны начислены.`);
      return;
    }
    // Server-side check: query Kaspi for the real status of this order.
    const status = await kaspiVerifyOrder(order);
    if (status === "paid") {
      const pack = await settleApprovedOrder(ctx.api, orderId);
      await ctx.reply(
        pack
          ? `✅ Оплата подтверждена автоматически! Начислено ${UNIT_EMOJI} ${nUnits(pack.credits)}.`
          : `✅ Оплата подтверждена — ${UNIT_EMOJI} патроны начислены.`,
      );
      return;
    }
    if (config.kaspiApiBase) {
      // API is live but hasn't seen the payment yet → let the user retry shortly.
      await ctx.reply(
        status === "failed"
          ? "❌ Оплата не найдена или отклонена. Проверьте платёж в Kaspi и попробуйте ещё раз."
          : "⏳ Пока не видим оплату. Если вы только что оплатили — подождите минуту и нажмите «✅ Я оплатил» снова.",
      );
      return;
    }
    // No merchant API configured → interim admin approval.
    await ctx.reply("Спасибо! Проверяем оплату — начислим патроны в ближайшее время ⏳");
    const who = ctx.from ? `${ctx.from.first_name} (@${ctx.from.username ?? ctx.from.id})` : "?";
    for (const adminId of config.adminIds)
      await ctx.api
        .sendMessage(adminId, `💸 Заявка №${orderId}: ${who} отметил оплату. Проверьте Kaspi → /order ${orderId} ok|no`)
        .catch(() => {});
  });
}

export async function sendBalance(ctx: Context, credits: number): Promise<void> {
  await ctx.reply(
    `💰 Баланс: ${UNIT_EMOJI} ${nUnits(credits)}\n\n` +
      `Картинка от 2 · Премиум-фото 11 · Видео 25–76 ${UNIT_EMOJI}`,
    { reply_markup: packsKeyboard() },
  );
}
