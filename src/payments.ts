import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { addCredits, db } from "./db.js";
import { PACKS, REFERRAL_BONUS } from "./models.js";

export function packsKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const pack of PACKS) {
    kb.text(`${pack.title} — ⭐${pack.stars}`, `buy:${pack.id}`).row();
  }
  return kb;
}

export function registerPayments(bot: Bot): void {
  bot.callbackQuery("show_packs", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Выберите пакет кредитов (оплата Telegram Stars):", {
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
      `${pack.credits} кредитов на генерации`,
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

    addCredits(ctx.from.id, pack.credits, "purchase", String(payment.total_amount));

    const user = db.prepare("SELECT referrer_id FROM users WHERE id = ?").get(ctx.from.id) as
      | { referrer_id: number | null }
      | undefined;
    if (user?.referrer_id) {
      const bonus = Math.floor(pack.credits * REFERRAL_BONUS);
      if (bonus > 0) {
        addCredits(user.referrer_id, bonus, "referral", String(ctx.from.id));
        await ctx.api
          .sendMessage(user.referrer_id, `🎁 +${bonus} кредитов — ваш реферал купил пакет!`)
          .catch(() => {});
      }
    }
    await ctx.reply(`✅ Начислено ${pack.credits} кредитов. Пришлите фото или напишите идею!`);
  });
}

export async function sendBalance(ctx: Context, credits: number): Promise<void> {
  await ctx.reply(
    `💰 Баланс: ${credits} кредитов\n\nКартинка = 1 кр · Стиль/премиум = 4 кр · Видео = 8 кр`,
    { reply_markup: packsKeyboard() },
  );
}
