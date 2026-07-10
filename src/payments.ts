import type { Api, Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "./config.js";
import {
  addCredits,
  createOrder,
  logEvent,
  rewardPartnerOnPurchase,
  rewardReferralOnPurchase,
} from "./db.js";
import { PACKS, packById, REFERRAL_MILESTONES, type ModelSpec, type Pack } from "./models.js";
import { nResults, nUnits, UNIT_EMOJI } from "./text.js";

/** Pack list for the buy menu — Kaspi/KZT priced; the combo offer leads. */
export function packsKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  // Show the limited-time combo offer first, then the ladder.
  const ordered = [...PACKS].sort((a, b) => Number(b.offer ?? false) - Number(a.offer ?? false));
  for (const pack of ordered) {
    kb.text(`${pack.title} — ${pack.kzt} ₸`, `buy:${pack.id}`).row();
  }
  return kb;
}

/** The entry-price pack, framed as the anchor CTA on the paywall (the combo offer). */
const ENTRY_PACK = PACKS.find((p) => p.offer) ?? PACKS[0];

/** How many of `model`'s results the entry pack buys (≥1, for the "N результатов" framing). */
function resultsPerEntryPack(model: ModelSpec): number {
  return Math.max(1, Math.floor(ENTRY_PACK.credits / model.credits));
}

/**
 * Paywall as a sales page (not a naked "недостаточно"): outcome-first headline,
 * the entry pack anchored and framed as "≈ N таких результатов", one dominant
 * CTA (buy the entry pack) + a secondary "все пакеты". Contextual to the exact
 * result the user just tried.
 */
export function paywallText(model: ModelSpec, credits: number): string {
  const n = resultsPerEntryPack(model);
  return (
    `✨ <b>Ещё один шаг до результата!</b>\n\n` +
    `«${model.label}» — ${nUnits(model.credits)}. У вас ${nUnits(credits)}.\n\n` +
    `🔥 «${ENTRY_PACK.title}»: <b>${nResults(n)}</b> за ${ENTRY_PACK.kzt} ₸ — оплата картой Kaspi.`
  );
}

/** Short pack name for the CTA. */
const ENTRY_SHORT = ENTRY_PACK.title.replace(/^🔥\s*/, "").split(/[—:]/)[0].trim();

/** Primary CTA = the entry pack (framed by results); secondary = all packs. */
export function paywallKeyboard(model: ModelSpec): InlineKeyboard {
  const n = resultsPerEntryPack(model);
  return new InlineKeyboard()
    .text(`${ENTRY_PACK.kzt} ₸ · ${ENTRY_SHORT}: ${nResults(n)}`, `buy:${ENTRY_PACK.id}`)
    .row()
    .text("💎 Все пакеты", "show_packs");
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
    if (!config.kaspiPayUrl) {
      await ctx.reply(
        "💳 Оплата картой Kaspi скоро откроется — всё уже готово, мы сообщим! " +
          "А пока попробуйте бесплатный сценарий 🎁",
      );
      return;
    }
    const orderId = await createOrder(ctx.from.id, pack.id, pack.kzt);
    await ctx.reply(
      `🧾 <b>${pack.title}</b> — <b>${pack.kzt} ₸</b>\n\n` +
        `1️⃣ Оплатите по ссылке Kaspi:\n${config.kaspiPayUrl}\n\n` +
        `2️⃣ После оплаты нажмите «✅ Я оплатил» — мы проверим платёж и начислим ${UNIT_EMOJI} патроны.\n\n` +
        `Заявка №${orderId}`,
      { parse_mode: "HTML", reply_markup: paidKeyboard(orderId) },
    );
  });

  // "I paid" → ping the admins to verify the payment against Kaspi and approve.
  bot.callbackQuery(/^paid:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const orderId = Number(ctx.match[1]);
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
