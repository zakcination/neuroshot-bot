import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "./config.js";
import { addCredits, logEvent, rewardPartnerOnPurchase, rewardReferralOnPurchase } from "./db.js";
import { PACKS, REFERRAL_MILESTONES, type ModelSpec } from "./models.js";
import { nUnits, UNIT_EMOJI } from "./text.js";

export function packsKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const pack of PACKS) {
    kb.text(`${pack.title} — ⭐${pack.stars}`, `buy:${pack.id}`).row();
  }
  return kb;
}

/** The entry-price pack, framed as the anchor CTA on the paywall. */
const ENTRY_PACK = PACKS[0];

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
    `⭐ Пакет «${ENTRY_PACK.title}» = до <b>${n}</b> таких результатов — оплата в пару тапов через Telegram Stars.`
  );
}

/** Primary CTA = the entry pack (framed by results); secondary = all packs. */
export function paywallKeyboard(model: ModelSpec): InlineKeyboard {
  const n = resultsPerEntryPack(model);
  return new InlineKeyboard()
    .text(`⭐${ENTRY_PACK.stars} · ${ENTRY_PACK.title} — до ${n} результатов`, `buy:${ENTRY_PACK.id}`)
    .row()
    .text("💎 Все пакеты", "show_packs");
}

export function registerPayments(bot: Bot): void {
  bot.callbackQuery("show_packs", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Выберите пакет 🔫 патронов (оплата Telegram Stars):", {
      reply_markup: packsKeyboard(),
    });
  });

  bot.callbackQuery(/^buy:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const pack = PACKS.find((p) => p.id === ctx.match[1]);
    if (!pack) return;
    // Telegram Stars: currency XTR, empty provider token, amount = stars (no cents).
    await ctx.replyWithInvoice(
      pack.title,
      `${nUnits(pack.credits)} на генерации`,
      `pack:${pack.id}`,
      "XTR",
      [{ label: pack.title, amount: pack.stars }],
    );
  });

  bot.on("pre_checkout_query", (ctx) => ctx.answerPreCheckoutQuery(true));

  bot.on("message:successful_payment", async (ctx) => {
    const payment = ctx.message.successful_payment;
    const packId = payment.invoice_payload.replace("pack:", "");
    const pack = PACKS.find((p) => p.id === packId);
    if (!pack || !ctx.from) return;

    await addCredits(ctx.from.id, pack.credits, "purchase", String(payment.total_amount));
    await logEvent(ctx.from.id, "purchase", `${packId}:${payment.total_amount}`);

    // Attribution is exclusive: a buyer came via a creator code OR a friend link.
    // Both payout paths are purchase-gated (abuse-safe by construction).
    const partnerPayout = await rewardPartnerOnPurchase(ctx.from.id, pack.credits);
    if (partnerPayout && partnerPayout.amount > 0) {
      await ctx.api
        .sendMessage(
          partnerPayout.ownerId,
          `🤝 +${nUnits(partnerPayout.amount)} — покупка по вашему коду c_${partnerPayout.code}!`,
        )
        .catch(() => {});
    }
    const payout = partnerPayout
      ? null
      : await rewardReferralOnPurchase(ctx.from.id, pack.credits, {
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
      if (lines.length) await ctx.api.sendMessage(payout.referrerId, lines.join("\n")).catch(() => {});
    }
    await ctx.reply(`✅ Начислено ${UNIT_EMOJI} ${nUnits(pack.credits)}. Пришлите фото или напишите идею!`);
  });
}

export async function sendBalance(ctx: Context, credits: number): Promise<void> {
  await ctx.reply(
    `💰 Баланс: ${UNIT_EMOJI} ${nUnits(credits)}\n\n` +
      `Картинка от 2 · Премиум-фото 11 · Видео 25–76 ${UNIT_EMOJI}`,
    { reply_markup: packsKeyboard() },
  );
}
