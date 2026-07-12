import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { UserFromGetMe } from "grammy/types";
import type { Context } from "grammy";
import { Bot, GrammyError, HttpError, InlineKeyboard, InputFile, InputMediaBuilder, Keyboard } from "grammy";
import { config } from "./config.js";
import {
  addCredits,
  createPartnerCode,
  deactivatePartnerCode,
  ensureRefCode,
  funnel,
  getGeneration,
  getOrCreateUser,
  getPartnerCode,
  getUser,
  getUserIdByRefCode,
  hasFreeScenario,
  joinPartnerProgram,
  listPartnerCodes,
  logEvent,
  myPartnerCodes,
  myWithdrawals,
  partnerAccount,
  pendingOrders,
  resolveOrder,
  partnerStats,
  pendingWithdrawals,
  phoneClaimedFree,
  referralStats,
  requestWithdrawal,
  resolveWithdrawal,
  setPending,
  setUserPhone,
  stats,
  upsertPartnerCode,
  type PartnerCodeRow,
  type UserRow,
} from "./db.js";
import { isUploadedSource as isReusableUpload, modelByKey, runFreeScenario, runGeneration } from "./generate.js";
import { buildDigest, formatDigest } from "./monitor.js";
import {
  CAMPAIGNS,
  campaignById,
  entryLinkFor,
  FREE_SCENARIOS,
  freeScenarioById,
  IMAGE_MODEL_PICKER,
  MODELS,
  packById,
  PRESET_MODEL,
  PRESETS,
  REFERRAL_MILESTONES,
  VIDEO_MODEL_PICKER,
  type Campaign,
  type EntryRoute,
  type Preset,
} from "./models.js";
import { grantPurchase, registerPayments, sendBalance } from "./payments.js";
import { nUnits, UNIT_EMOJI, withPhotoTip } from "./text.js";

async function user(
  ctx: { from?: { id: number; username?: string } },
  referrerId: number | null = null,
  partner: PartnerCodeRow | null = null,
  source: string | null = null,
): Promise<UserRow> {
  if (!ctx.from) throw new Error("no ctx.from");
  return getOrCreateUser(
    ctx.from.id,
    ctx.from.username,
    referrerId,
    config.freeCredits,
    config.referralJoinBonus,
    partner,
    source,
  );
}

/**
 * UX rules (vs the model-first aggregator bots):
 * - buttons name the OUTCOME, never the model;
 * - every path reaches a generation in ≤2 taps, no prompt required;
 * - price in credits on every button that spends;
 * - every delivered result carries a "next step" keyboard.
 *
 * @param opts.featured  prepend a one-tap "🆕 Новинка недели" row (recurring reason)
 * @param opts.hasPhoto  prepend "продолжить с вашим фото" (try-on-your-last-photo hook)
 */
export function mainMenu(
  opts: { featured?: Campaign; hasPhoto?: boolean; freeScenario?: boolean } = {},
): InlineKeyboard {
  // Deliberately minimal: only the anchors that get a newcomer to a result
  // fast (upload → wow). Secondary surfaces (product, text→image, top-models,
  // balance, invite) live behind commands (/buy, /ref) and inside the studio,
  // so the chat stays a clean, high-converting funnel — not a control panel.
  const kb = new InlineKeyboard();
  // 1) The hook: one free video from a single photo (shown until claimed).
  if (opts.freeScenario) kb.text("🎁 Бесплатное видео за 1 фото — без оплаты", "menu:free").row();
  // 2) Contextual fast path: keep going with the photo already on file.
  if (opts.hasPhoto) kb.text("📸 Продолжить с вашим фото", "menu:styles").row();
  // 3) The two core create anchors that showcase product quality.
  kb.text("📸 AI-фотосессия по вашему фото", "menu:photoshoot").row();
  kb.text("🎬 Сценарии: сказки • кумиры • кино", "menu:campaigns").row();
  // 4) The studio (create, gallery, pricing) — the full surface, one tap away.
  if (config.webappUrl) kb.webApp("🌐 Открыть студию NeuroShot", config.webappUrl).row();
  return kb;
}

/** Picker of the top text-to-image models (famous names, priced). */
function imageModelsKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const key of IMAGE_MODEL_PICKER) {
    const m = MODELS[key];
    kb.text(`${m.label} (${m.credits} 🔫)`, `txt:${key}`).row();
  }
  return kb.text("🎬 Видео из фото →", "menu:animate").row().text("📋 Меню", "menu:main");
}

/** Picker of the top image-to-video models (famous names, priced). Needs a photo. */
function videoModelsKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const key of VIDEO_MODEL_PICKER) {
    const m = MODELS[key];
    kb.text(`${m.label} (${m.credits} 🔫)`, `act:${key}`).row();
  }
  return kb.text("📋 Меню", "menu:main");
}

function presetsKeyboard(category: Preset["category"]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of PRESETS.filter((x) => x.category === category)) {
    kb.text(`${p.label} (${PRESET_MODEL.credits} 🔫)`, `preset:${p.id}`).row();
  }
  kb.text(`✍️ Свой промпт (${MODELS.premium_edit.credits} 🔫)`, "act:premium_edit").row();
  kb.text("📋 Меню", "menu:main");
  return kb;
}

// Preview images (expected results) live next to the built bot; shipped in the repo.
const PREVIEW_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "previews");

/** Example-results album for a category, so newcomers see outcomes before spending. */
async function sendPreviewAlbum(ctx: Context, category: Preset["category"]): Promise<void> {
  const items = PRESETS.filter((p) => p.category === category)
    .map((p) => ({ p, file: join(PREVIEW_DIR, `${p.id}.jpg`) }))
    .filter((x) => existsSync(x.file));
  if (items.length >= 2) {
    try {
      await ctx.replyWithMediaGroup(
        items.map((x) => InputMediaBuilder.photo(new InputFile(x.file), { caption: x.p.label })),
      );
    } catch (e) {
      // Previews are a nicety — never let an album failure block the keyboard below.
      console.error("preview album failed:", e);
    }
  }
}

/** Preview album + the tappable preset keyboard (used once a photo is on file). */
async function showPresets(ctx: Context, category: Preset["category"], header: string): Promise<void> {
  await sendPreviewAlbum(ctx, category);
  await ctx.reply(header, { reply_markup: presetsKeyboard(category) });
}

// Menu-level media (hero, per-flow examples) shipped in the repo.
const MENU_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "menu");

/** Main menu with the hero image (if shipped) carrying the caption + keyboard. */
async function sendMainMenu(
  ctx: Context,
  caption: string,
  menuOpts: { featured?: Campaign; hasPhoto?: boolean; freeScenario?: boolean } = {},
): Promise<void> {
  const hero = join(MENU_DIR, "hero.jpg");
  if (existsSync(hero)) {
    try {
      await ctx.replyWithPhoto(new InputFile(hero), {
        caption,
        parse_mode: "HTML",
        reply_markup: mainMenu(menuOpts),
      });
      return;
    } catch (e) {
      console.error("hero image failed:", e);
    }
  }
  await ctx.reply(caption, { parse_mode: "HTML", reply_markup: mainMenu(menuOpts) });
}

/** Send a menu example video (e.g. the animate preview) if the asset exists. */
async function sendMenuVideo(ctx: Context, name: string): Promise<void> {
  const file = join(MENU_DIR, `${name}.mp4`);
  if (!existsSync(file)) return;
  try {
    await ctx.replyWithVideo(new InputFile(file));
  } catch (e) {
    console.error(`menu video ${name} failed:`, e);
  }
}

/** Send a small album of example images for a flow (e.g. text-to-image). */
async function sendMenuAlbum(ctx: Context, names: string[]): Promise<void> {
  const files = names.map((n) => join(MENU_DIR, `${n}.jpg`)).filter((f) => existsSync(f));
  if (files.length < 2) return;
  try {
    await ctx.replyWithMediaGroup(files.map((f) => InputMediaBuilder.photo(new InputFile(f))));
  } catch (e) {
    console.error("menu album failed:", e);
  }
}

const WELCOME = [
  "📸 <b>NeuroShot</b> — AI-фотосессии и продающие фото товаров в один тап.",
  "",
  "Никаких промптов: выбираете, что хотите получить — остальное сделаем мы.",
  "",
  "Что создаём?",
].join("\n");

/**
 * Persona-routed entry: pre-select the first action for an acquisition-source
 * deep link (see ENTRY_LINKS) so a targeted click lands straight on the scenario
 * that fits — set the pending mode, show the relevant preview, and ask for the
 * right photo (with the quality tip), all in ONE message (`intro` carries the
 * welcome/credits line, so no separate generic menu is sent). Returns false when
 * it can't route (e.g. the free gift is already used) so the caller falls back to
 * the normal menu. No extra patrons are granted, so the public link stays
 * un-farmable.
 */
async function routeEntry(
  ctx: Context,
  userId: number,
  route: EntryRoute,
  intro = "",
): Promise<boolean> {
  const lead = intro ? `${intro}\n\n` : "";
  const say = (body: string) => ctx.reply(`${lead}${body}`, { parse_mode: "HTML" });
  if (route.kind === "free") {
    if (!(await hasFreeScenario(userId))) return false; // gift used → let the menu show
    const s = freeScenarioById(route.id);
    if (!s) return false;
    await setPending(userId, `mode_free_${s.id}`, null);
    await say(`${route.headline}\n\n${withPhotoTip(s.ask)}`);
    return true;
  }
  if (route.kind === "camp") {
    const c = campaignById(route.id);
    if (!c) return false;
    await setPending(userId, `mode_camp_${c.id}`, null);
    await say(`${route.headline}\n\n${withPhotoTip(c.ask)}`);
    return true;
  }
  if (route.kind === "product") {
    await setPending(userId, "mode_product", null); // product photos: no face-tip
    await sendPreviewAlbum(ctx, "product");
    await say(route.headline);
    return true;
  }
  // photoshoot: mirror the menu:photoshoot flow so the next photo lands in styles.
  await setPending(userId, "mode_photo", null);
  await sendPreviewAlbum(ctx, "photo");
  await say(withPhotoTip(route.headline));
  return true;
}

export function createBot(botInfo?: UserFromGetMe): Bot {
  const bot = new Bot(config.botToken, botInfo ? { botInfo } : undefined);

  // Behavioural analytics: one central logger for every interaction (sessions,
  // menu selects, photo uploads). Generation/paywall/purchase events are logged
  // at their source. Runs before handlers; never blocks them.
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (from) {
      try {
        const data = ctx.callbackQuery?.data;
        if (data) {
          if (data.startsWith("preset:")) await logEvent(from.id, "preset", data.slice(7));
          else if (data.startsWith("cpre:")) await logEvent(from.id, "preset", data.slice(5));
          else await logEvent(from.id, "select", data); // menu:* | camp:* | act:* | buy:* | show_packs
        } else if (ctx.message?.photo) {
          await logEvent(from.id, "photo");
        } else if (ctx.message?.text?.startsWith("/start")) {
          await logEvent(from.id, "menu_open", "start");
        } else if (ctx.message?.text === "/menu") {
          await logEvent(from.id, "menu_open", "menu");
        }
      } catch (e) {
        console.error("analytics log failed:", e);
      }
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    const payload = ctx.match?.trim();
    // Deep-link payloads: numeric = a LEGACY friend-referral link (raw tg id —
    // links minted before the opaque ref_code existed; still honored so old
    // shares keep crediting), c_<code>/p_<code> = creator/partner code,
    // anything else = try it as the new opaque ref_code, else it's an
    // acquisition-source slug (t.me/<bot>?start=src_tiktok1) for /dash.
    const legacyReferrerId = payload && /^\d+$/.test(payload) ? Number(payload) : null;
    // c_<code> = admin creator deal · p_<code> = self-serve partner code — both
    // live in partner_codes, so one lookup resolves either (first-touch attribution).
    const partner =
      payload && /^[cp]_/.test(payload)
        ? ((await getPartnerCode(payload.slice(2).toLowerCase())) ?? null)
        : null;
    // New opaque referral code (never the raw tg id) — a lookup, not a format
    // guess, so it can never collide with a future source-slug naming choice.
    const codeReferrerId =
      payload && !legacyReferrerId && !partner ? await getUserIdByRefCode(payload) : null;
    const referrerId = legacyReferrerId ?? codeReferrerId;
    const source =
      payload && !referrerId && !partner && payload !== "buy"
        ? payload.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32) || null
        : null;
    const u = await user(ctx, referrerId, partner, source);
    let msg = `${WELCOME}\n\n`;
    if (u.justCreated) {
      msg += `🎁 Вам начислено <b>${UNIT_EMOJI} ${nUnits(u.credits)}</b> на старт.`;
      if (u.joinBonus && u.joinBonus > 0) {
        msg +=
          u.joinVia === "partner"
            ? `\nИз них <b>+${nUnits(u.joinBonus)}</b> — подарок от ${partner?.title ?? "партнёра"} 🤝`
            : `\nИз них <b>+${nUnits(u.joinBonus)}</b> — бонус за приглашение. Спасибо другу! 🤝`;
      }
    } else {
      msg += `💰 На балансе: <b>${UNIT_EMOJI} ${nUnits(u.credits)}</b>.`;
    }
    // Lean funnel: the free gift is the headline, plus a one-tap continue-with-
    // your-last-photo shortcut for returning users. No secondary noise.
    const freeScenario = await hasFreeScenario(u.id);
    const menuOpts = u.justCreated
      ? { freeScenario }
      : { hasPhoto: !!u.pending_file_id, freeScenario };
    if (freeScenario) msg += `\n\n🎁 <b>Подарок:</b> одно фото → видео (принцесса или футбол) — бесплатно, без оплаты!`;
    // Persona-routed deep link (src_football / src_revive / src_product …): land
    // STRAIGHT on the matching first action — one message (credits line + the
    // scenario prompt), no generic menu. Falls back to the menu if it can't route
    // (e.g. the free gift is already used).
    const route = entryLinkFor(source);
    const intro = u.justCreated
      ? `🎁 Вам начислено <b>${UNIT_EMOJI} ${nUnits(u.credits)}</b> на старт!`
      : `💰 Баланс: <b>${UNIT_EMOJI} ${nUnits(u.credits)}</b>`;
    const routed = route ? await routeEntry(ctx, u.id, route, intro) : false;
    if (!routed) await sendMainMenu(ctx, msg, menuOpts);
    // Deep link from the Mini App's "Пополнить" button.
    if (payload === "buy") await sendBalance(ctx, u.credits);
  });

  bot.command("menu", async (ctx) => {
    const u = await user(ctx);
    await setPending(u.id, null, u.pending_file_id); // escape any mode/prompt-await, keep the photo
    await sendMainMenu(ctx, "Что создаём? Одно фото — и готово 👇", {
      hasPhoto: !!u.pending_file_id,
      freeScenario: await hasFreeScenario(u.id),
    });
  });

  bot.command("app", async (ctx) => {
    await user(ctx);
    if (!config.webappUrl) {
      await ctx.reply("Приложение скоро откроется 🌐");
      return;
    }
    await ctx.reply("🌐 Ваш личный кабинет: баланс, галерея работ и статистика.", {
      reply_markup: new InlineKeyboard().webApp("Открыть приложение", config.webappUrl),
    });
  });

  bot.command("balance", async (ctx) => sendBalance(ctx, (await user(ctx)).credits));
  bot.command("buy", async (ctx) => sendBalance(ctx, (await user(ctx)).credits));

  bot.command("ref", async (ctx) => sendRefLink(ctx));

  // Self-serve partner program (docs/partner-program.md): join → get welcome
  // bonus + personal codes → 15% cashback → withdraw. Admin creator deals (c_)
  // still exist via /partner_add and show read-only below.
  /** Read-only block for admin-negotiated creator (c_) codes, if the user owns any. */
  async function creatorCodesBlock(ctx: Context, userId: number): Promise<string> {
    const creator = (await listPartnerCodes(userId)).filter((c) => c.kind === "creator");
    if (!creator.length) return "";
    const blocks: string[] = [];
    for (const c of creator) {
      const st = await partnerStats(c.code);
      blocks.push(
        `🔗 <b>${c.title ?? c.code}</b> · <code>https://t.me/${ctx.me.username}?start=c_${c.code}</code>\n` +
          `   👥 пришло: <b>${st.joined}</b> · 💳 покупают: <b>${st.paying}</b> · ` +
          `заработано: <b>${nUnits(st.earned)}</b> · ${Math.round(c.percent * 100)}%`,
      );
    }
    return `🎓 <b>Ваши авторские коды (по договорённости)</b>\n${blocks.join("\n")}\n\n`;
  }

  async function sendPartnerDash(ctx: Context): Promise<void> {
    const u = await user(ctx);
    const acct = await partnerAccount(u.id);
    const pct = Math.round(config.partnerPercent * 100);
    const creatorBlock = await creatorCodesBlock(ctx, u.id);

    if (!acct.joined) {
      const kb = new InlineKeyboard().text("🚀 Стать партнёром", "partner:join");
      await ctx.reply(
        creatorBlock +
          `🤝 <b>Партнёрская программа NeuroShot</b>\n\n` +
          `• Персональная ссылка и приветственный бонус <b>≈$20</b> в токенах 🔫\n` +
          `• <b>${pct}% кэшбэка</b> с каждой оплаты приглашённых пользователей\n` +
          `• Кэшбэк — в токенах: тратьте в NeuroShot или <b>выводите деньгами раз в 2 недели</b>\n` +
          `• Без вложений — просто делитесь ссылкой и растите вместе с проектом\n\n` +
          `До 10 персональных ссылок на аккаунт.`,
        { parse_mode: "HTML", reply_markup: kb },
      );
      return;
    }

    const codes = await myPartnerCodes(u.id);
    const codeBlocks = codes.length
      ? codes
          .map(
            (c) =>
              `🔗 <code>https://t.me/${ctx.me.username}?start=p_${c.code}</code>\n` +
              `   👥 <b>${c.joined}</b> · 💳 <b>${c.paying}</b> · заработано <b>${nUnits(c.earned)}</b>`,
          )
          .join("\n")
      : "У вас пока нет ссылок — создайте первую 👇";

    const kb = new InlineKeyboard();
    if (acct.activeCodes < config.partnerMaxCodes) kb.text("➕ Новая ссылка", "partner:newcode");
    if (acct.withdrawable >= config.withdrawMin) kb.text(`💸 Вывести ${acct.withdrawable} 🔫`, "partner:withdraw");
    kb.row().text("📜 История выплат", "partner:history");
    if (codes.length) kb.text("⚙️ Управление ссылками", "partner:manage");

    await ctx.reply(
      creatorBlock +
        `🤝 <b>Партнёрский кабинет</b>\n\n` +
        `👥 Приглашено: <b>${acct.invited}</b> · 💳 покупают: <b>${acct.paying}</b>\n` +
        `💰 Всего заработано: <b>${UNIT_EMOJI} ${nUnits(acct.earned)}</b>\n` +
        `💸 Доступно к выводу: <b>${UNIT_EMOJI} ${nUnits(acct.withdrawable)}</b> ` +
        `(мин. ${config.withdrawMin}, раз в 2 недели)\n\n` +
        `<b>Ваши ссылки</b> (${acct.activeCodes}/${config.partnerMaxCodes}):\n${codeBlocks}\n\n` +
        `Условия: <b>${pct}%</b> кэшбэка с покупок · +${config.partnerInviteeBonus} 🔫 новым по вашей ссылке.`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  }

  bot.command("partner", (ctx) => sendPartnerDash(ctx));

  bot.callbackQuery("partner:join", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    const res = await joinPartnerProgram(u.id, config.partnerWelcome);
    // First code is minted on join so the partner leaves with a shareable link.
    if (res.justJoined) await createPartnerCode(u.id, config.partnerPercent, config.partnerInviteeBonus, config.partnerMaxCodes);
    if (res.justJoined && res.welcome > 0) {
      await ctx.reply(`🎉 Добро пожаловать! Начислен бонус <b>${UNIT_EMOJI} ${nUnits(res.welcome)}</b>.`, {
        parse_mode: "HTML",
      });
    }
    await sendPartnerDash(ctx);
  });

  bot.callbackQuery("partner:newcode", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (!(await partnerAccount(u.id)).joined) { await sendPartnerDash(ctx); return; }
    const res = await createPartnerCode(u.id, config.partnerPercent, config.partnerInviteeBonus, config.partnerMaxCodes);
    if (!res.ok) {
      await ctx.reply(`Достигнут лимит в ${config.partnerMaxCodes} активных ссылок. Деактивируйте одну, чтобы создать новую.`);
      return;
    }
    await ctx.reply(
      `✅ Новая ссылка готова:\n<code>https://t.me/${ctx.me.username}?start=p_${res.code}</code>`,
      { parse_mode: "HTML" },
    );
    await sendPartnerDash(ctx);
  });

  bot.callbackQuery("partner:withdraw", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    const acct = await partnerAccount(u.id);
    if (!acct.joined) { await sendPartnerDash(ctx); return; }
    const res = await requestWithdrawal(u.id, acct.withdrawable, config.withdrawMin);
    if (!res.ok) {
      const msg =
        res.error === "too_small"
          ? `Минимальная сумма вывода — ${config.withdrawMin} 🔫.`
          : res.error === "pending"
            ? "У вас уже есть заявка на вывод в обработке."
            : "Недостаточно средств к выводу.";
      await ctx.reply(msg);
      return;
    }
    await ctx.reply(
      `💸 Заявка на вывод <b>${UNIT_EMOJI} ${nUnits(acct.withdrawable)}</b> создана (№${res.id}). ` +
        `Выплаты обрабатываются раз в 2 недели — мы свяжемся с вами.`,
      { parse_mode: "HTML" },
    );
    for (const adminId of config.adminIds)
      await ctx.api.sendMessage(adminId, `💸 Заявка на вывод №${res.id}: ${acct.withdrawable} 🔫 от ${u.id}. /payouts`).catch(() => {});
  });

  bot.callbackQuery("partner:manage", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (!(await partnerAccount(u.id)).joined) { await sendPartnerDash(ctx); return; }
    const codes = await myPartnerCodes(u.id);
    const kb = new InlineKeyboard();
    for (const c of codes) kb.text(`🗑 ${c.code} (${c.paying} 💳)`, `partner:deact:${c.code}`).row();
    kb.text("← Назад", "partner:back");
    await ctx.reply(
      "⚙️ Деактивация освобождает слот для новой ссылки. Уже приглашённые по ней продолжат приносить кэшбэк.",
      { reply_markup: kb },
    );
  });

  bot.callbackQuery(/^partner:deact:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (!(await partnerAccount(u.id)).joined) { await sendPartnerDash(ctx); return; }
    const ok = await deactivatePartnerCode(u.id, ctx.match[1]);
    await ctx.reply(ok ? "✅ Ссылка деактивирована." : "Ссылка не найдена.");
    await sendPartnerDash(ctx);
  });

  bot.callbackQuery("partner:back", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPartnerDash(ctx);
  });

  bot.callbackQuery("partner:history", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (!(await partnerAccount(u.id)).joined) { await sendPartnerDash(ctx); return; }
    const rows = await myWithdrawals(u.id);
    if (!rows.length) {
      await ctx.reply("Заявок на вывод ещё не было.");
      return;
    }
    const label = (s: string) => (s === "paid" ? "✅ выплачено" : s === "rejected" ? "↩️ отклонено" : "⏳ в обработке");
    await ctx.reply(
      "📜 <b>История выплат</b>\n" +
        rows.map((r) => `№${r.id} · ${nUnits(r.amount)} · ${label(r.status)}`).join("\n"),
      { parse_mode: "HTML" },
    );
  });

  // Admin: pending cash-outs + resolve. /payouts | /payout <id> ok|no
  bot.command("payouts", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const rows = await pendingWithdrawals();
    if (!rows.length) {
      await ctx.reply("Заявок на вывод нет.");
      return;
    }
    await ctx.reply(
      "💸 <b>Заявки на вывод</b>\n" +
        rows.map((r) => `№${r.id} · пользователь ${r.user_id} · ${nUnits(r.amount)}`).join("\n") +
        "\n\nОбработать: /payout <id> ok  или  /payout <id> no",
      { parse_mode: "HTML" },
    );
  });

  bot.command("payout", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const [idS, verdict] = (ctx.match ?? "").trim().split(/\s+/);
    const id = Number(idS);
    if (!Number.isInteger(id) || (verdict !== "ok" && verdict !== "no")) {
      await ctx.reply("Формат: /payout <id> ok|no");
      return;
    }
    const ok = await resolveWithdrawal(id, verdict === "ok");
    if (!ok) {
      await ctx.reply(`Заявка №${id} не найдена или уже обработана.`);
      return;
    }
    await ctx.reply(verdict === "ok" ? `✅ Заявка №${id} отмечена выплаченной.` : `↩️ Заявка №${id} отклонена, 🔫 возвращены.`);
  });

  // Admin: pending Kaspi purchase orders + confirm. /orders | /order <id> ok|no
  bot.command("orders", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const rows = await pendingOrders();
    if (!rows.length) {
      await ctx.reply("Заявок на оплату нет.");
      return;
    }
    await ctx.reply(
      "🧾 <b>Заявки на оплату (Kaspi)</b>\n" +
        rows.map((r) => `№${r.id} · пользователь ${r.user_id} · ${r.pack_id} · ${r.amount_kzt} ₸`).join("\n") +
        "\n\nПодтвердить: /order <id> ok  или  /order <id> no",
      { parse_mode: "HTML" },
    );
  });

  bot.command("order", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const [idS, verdict] = (ctx.match ?? "").trim().split(/\s+/);
    const id = Number(idS);
    if (!Number.isInteger(id) || (verdict !== "ok" && verdict !== "no")) {
      await ctx.reply("Формат: /order <id> ok|no");
      return;
    }
    const order = await resolveOrder(id, verdict === "ok");
    if (!order) {
      await ctx.reply(`Заявка №${id} не найдена или уже обработана.`);
      return;
    }
    if (verdict === "ok") {
      const pack = packById(order.pack_id);
      if (!pack) {
        await ctx.reply(`Заявка №${id}: пакет «${order.pack_id}» больше не существует.`);
        return;
      }
      await grantPurchase(ctx.api, order.user_id, pack); // credits + referral/partner payouts + notify
      await ctx.reply(`✅ Заявка №${id} подтверждена — начислено ${pack.credits} 🔫 пользователю ${order.user_id}.`);
    } else {
      await ctx.reply(`↩️ Заявка №${id} отклонена.`);
    }
  });

  // Admin: create/update a creator code with per-deal terms.
  // /partner_add <code> <tg_id> <percent 1–50> <join_bonus> [display title]
  bot.command("partner_add", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const [rawCode, idS, pctS, bonusS, ...titleParts] = args;
    const ownerId = Number(idS);
    const pct = Number(pctS);
    const bonus = Number(bonusS ?? 0);
    if (!rawCode || !/^[a-z0-9_]{2,32}$/i.test(rawCode) || !Number.isFinite(ownerId) || !Number.isFinite(pct) || pct <= 0 || pct > 50 || !Number.isFinite(bonus) || bonus < 0) {
      await ctx.reply(
        "Формат: /partner_add <код a-z0-9_> <tg_id> <процент 1–50> <бонус_новым> [название]\n" +
          "Пример: /partner_add mentor 123456789 25 10 Курс Ментора\n" +
          "⚠️ >25% съедает целевую маржу 3.5× на минимальном пакете — см. docs/creator-program.md",
      );
      return;
    }
    const code = rawCode.toLowerCase();
    await upsertPartnerCode(code, ownerId, pct / 100, Math.floor(bonus), titleParts.join(" ") || null);
    await ctx.reply(
      `✅ Код <code>c_${code}</code> → ${ownerId}: ${pct}% с покупок, +${Math.floor(bonus)} 🔫 новым.\n` +
        `Ссылка: https://t.me/${ctx.me.username}?start=c_${code}`,
      { parse_mode: "HTML" },
    );
  });

  // Premium text-to-image: /premium <prompt> (GPT Image 2, high quality).
  bot.command("premium", async (ctx) => {
    const u = await user(ctx);
    const prompt = ctx.match?.trim();
    if (!prompt) {
      await ctx.reply(
        `💎 Премиум-картинка (${MODELS.premium_image.credits} 🔫) — напишите запрос сразу после команды:\n/premium флакон духов на мокром чёрном мраморе`,
      );
      return;
    }
    await runGeneration(ctx, u, MODELS.premium_image, prompt);
  });

  bot.command("stats", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const s = await stats();
    await ctx.reply(
      `👥 Users: ${s.users}\n💳 Paying: ${s.paid}\n🎨 Generations: ${s.generations}\n💰 Выручка: ${s.kztRevenue} ₸`,
    );
  });

  // Admin: top up 🔫 for testing (self by default, or a target user).
  // /grant <amount>  |  /grant <tg_id> <amount>  (amount may be negative to deduct)
  bot.command("grant", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const targetId = args.length === 2 ? Number(args[0]) : ctx.from.id;
    const amount = Number(args.length === 2 ? args[1] : args[0]);
    // Exactly 1 or 2 args — reject trailing tokens so a mistyped command can't
    // silently grant something other than what the admin meant.
    if (
      args.length < 1 ||
      args.length > 2 ||
      !Number.isInteger(targetId) ||
      !Number.isInteger(amount) ||
      amount === 0
    ) {
      await ctx.reply("Формат: /grant <кол-во> или /grant <tg_id> <кол-во>\nПример: /grant 9999");
      return;
    }
    const target = await getUser(targetId);
    if (!target) {
      await ctx.reply(`Пользователь ${targetId} не найден — пусть сначала откроет /start.`);
      return;
    }
    await addCredits(targetId, amount, "admin_grant", String(ctx.from.id));
    // Defensive re-read: fall back to the computed balance if the row vanished.
    const balance = (await getUser(targetId))?.credits ?? target.credits + amount;
    await ctx.reply(
      `✅ ${amount > 0 ? "Начислено" : "Списано"} ${UNIT_EMOJI} ${nUnits(Math.abs(amount))} → ${targetId}. ` +
        `Баланс: ${UNIT_EMOJI} ${nUnits(balance)}.`,
    );
  });

  // Admin: the daily digest on demand — /dash [days], default 24h, cap 30d.
  // Same 6 numbers the scheduler pushes each morning (src/monitor.ts).
  bot.command("dash", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const days = Math.min(30, Math.max(1, Number((ctx.match ?? "").trim()) || 1));
    await ctx.reply(formatDigest(await buildDigest(days * 24)), { parse_mode: "HTML" });
  });

  // Admin conversion funnel + "why didn't they order" drop-off buckets.
  bot.command("funnel", async (ctx) => {
    if (!ctx.from || !config.adminIds.includes(ctx.from.id)) return;
    const f = await funnel();
    const pct = (n: number) => (f.visitors ? `${Math.round((n / f.visitors) * 100)}%` : "—");
    await ctx.reply(
      [
        "📊 Воронка (по посетителям)",
        `Визитов: ${f.visits} · Уникальных: ${f.visitors}`,
        `📸 Загрузили фото: ${f.uploadedPhoto} (${pct(f.uploadedPhoto)})`,
        `⚙️ Начали генерацию: ${f.startedGen} (${pct(f.startedGen)})`,
        `✅ Получили результат: ${f.succeededGen} (${pct(f.succeededGen)})`,
        `💳 Дошли до оплаты: ${f.hitPaywall} (${pct(f.hitPaywall)})`,
        `💰 Купили: ${f.paid} (${pct(f.paid)})`,
        "",
        "❓ Почему не купили:",
        `• не начали генерить: ${f.dropoff.neverGenerated} (активация)`,
        `• была ошибка провайдера: ${f.dropoff.genFailedNoPaid} (надёжность)`,
        `• видели пейволл, не купили: ${f.dropoff.paywallNoPaid} (цена/ценность)`,
        `• израсходовали бесплатные, не купили: ${f.dropoff.triedFreeNoPaid} (ценность)`,
      ].join("\n"),
    );
  });

  registerPayments(bot);

  // ---- Main menu navigation ----

  bot.callbackQuery("menu:main", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    await setPending(u.id, null, u.pending_file_id); // escape any mode/prompt-await, keep the photo
    await ctx.reply("Что создаём?", { reply_markup: mainMenu() });
  });

  // Top-level entry: always ask for a FRESH photo (a new request must never
  // silently reuse a previous photo). The "just-uploaded" convenience lives in
  // the pick:* handlers below; deliberate reuse lives in menu:styles.
  bot.callbackQuery("menu:photoshoot", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    await setPending(u.id, "mode_photo", null);
    await sendPreviewAlbum(ctx, "photo");
    await ctx.reply(
      "Вот что можно получить 👆 Пришлите своё фото 📸 (портрет без ретуши работает лучше всего) — и выберите стиль.",
    );
  });

  bot.callbackQuery("menu:product", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    await setPending(u.id, "mode_product", null);
    await sendPreviewAlbum(ctx, "product");
    await ctx.reply("Вот примеры 👆 Пришлите фото товара 🛍 (можно прямо со стола — фон мы заменим).");
  });

  // "What to do with this photo" shortcuts: use the photo the user JUST uploaded
  // (pending_file_id is a fresh upload here) — reuse only within the upload flow.
  bot.callbackQuery("pick:photo", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (!isReusableUpload(u.pending_file_id)) {
      await ctx.reply("Пришлите фото 📸 — и выберите стиль.");
      return;
    }
    await showPresets(ctx, "photo", "Выберите стиль — один тап, без промптов:");
  });

  bot.callbackQuery("pick:product", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (!isReusableUpload(u.pending_file_id)) {
      await ctx.reply("Пришлите фото товара 🛍.");
      return;
    }
    await showPresets(ctx, "product", "Выберите подачу товара:");
  });

  // ---- Free one-time scenario (onboarding hook): princess or football ----
  // Whole chain (Seedream scene → Hailuo video) at zero credits, watermarked.

  bot.callbackQuery("menu:free", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (!(await hasFreeScenario(u.id))) {
      await ctx.reply("🎁 Бесплатный сценарий уже использован. Создайте свой в /menu 🙂");
      return;
    }
    const kb = new InlineKeyboard();
    for (const s of FREE_SCENARIOS) kb.text(s.label, `free:${s.id}`).row();
    kb.text("📋 Меню", "menu:main");
    await ctx.reply(
      "🎁 Один сценарий-видео — бесплатно и без списания патронов! Что снимаем?",
      { reply_markup: kb },
    );
  });

  bot.callbackQuery(/^free:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = freeScenarioById(ctx.match[1]);
    if (!s) return;
    const u = await user(ctx);
    if (!(await hasFreeScenario(u.id))) {
      await ctx.reply("🎁 Бесплатный сценарий уже использован 🙂");
      return;
    }
    // Identity gate (optional, default off): verify a phone before unlocking the
    // gift, so it can't be farmed across throwaway accounts. Remember the chosen
    // scenario; the contact handler resumes it once the number is shared.
    if (config.freeGateEnabled && !u.phone) {
      await setPending(u.id, `gate_free_${s.id}`, null);
      await ctx.reply(
        "🔒 Чтобы получить бесплатный подарок, подтвердите номер телефона — так мы защищаем подарок от накрутки. Это займёт секунду 👇",
        { reply_markup: new Keyboard().requestContact("📱 Поделиться номером").resized().oneTime() },
      );
      return;
    }
    // Always ask for the right photo (child vs self) — don't reuse a stale one.
    await setPending(u.id, `mode_free_${s.id}`, null);
    await ctx.reply(withPhotoTip(s.ask));
  });

  // Phone shared → verify identity and resume a gated free scenario (or just ack).
  bot.on("message:contact", async (ctx) => {
    const u = await user(ctx);
    const contact = ctx.message.contact;
    // Only accept the sender's OWN number (a forwarded contact carries a different user_id).
    if (contact.user_id && contact.user_id !== ctx.from?.id) {
      await ctx.reply("Пожалуйста, поделитесь СВОИМ номером 🙂");
      return;
    }
    await setUserPhone(u.id, contact.phone_number);
    const gated = u.pending_action?.startsWith("gate_free_") ? freeScenarioById(u.pending_action.slice("gate_free_".length)) : null;
    if (gated) {
      if (await phoneClaimedFree(contact.phone_number)) {
        await setPending(u.id, null, null);
        await ctx.reply("Этот номер уже получал бесплатный подарок 🙂 Но всё можно создать за 🔫 — /menu", {
          reply_markup: { remove_keyboard: true },
        });
        return;
      }
      await setPending(u.id, `mode_free_${gated.id}`, null);
      await ctx.reply(`✅ Номер подтверждён!\n\n${withPhotoTip(gated.ask)}`, { reply_markup: { remove_keyboard: true } });
      return;
    }
    await ctx.reply("✅ Спасибо, номер подтверждён!", { reply_markup: { remove_keyboard: true } });
  });

  // ---- Campaigns: one-click viral scenarios (image → optional video upsell) ----

  function campaignPresetKeyboard(c: Campaign): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (const p of c.presets) kb.text(`${p.label} (${PRESET_MODEL.credits} 🔫)`, `cpre:${c.id}:${p.id}`).row();
    kb.text("📋 Меню", "menu:main");
    return kb;
  }

  bot.callbackQuery("menu:campaigns", async (ctx) => {
    await ctx.answerCallbackQuery();
    await user(ctx);
    const kb = new InlineKeyboard();
    for (const c of CAMPAIGNS) kb.text(c.label, `camp:${c.id}`).row();
    kb.text("📋 Меню", "menu:main");
    await ctx.reply("🎉 Готовые сценарии — один тап, результат сразу:", { reply_markup: kb });
  });

  bot.callbackQuery(/^camp:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const c = campaignById(ctx.match[1]);
    if (!c) return;
    const u = await user(ctx);
    // Always ask for a fresh photo — each scenario wants its own (a kid's photo
    // for a fairy tale, your own for football) — never reuse a leftover photo.
    await setPending(u.id, `mode_camp_${c.id}`, null);
    await ctx.reply(withPhotoTip(c.ask));
  });

  // One-tap campaign render; on success, offer the one-tap animate upsell that
  // runs on the GENERATED image (referenced by generation id on the result kb).
  bot.callbackQuery(/^cpre:([^:]+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const c = campaignById(ctx.match[1]);
    const preset = c?.presets.find((p) => p.id === ctx.match[2]);
    if (!c || !preset) {
      await ctx.reply("Эта кампания больше недоступна — откройте /menu 🙂");
      return;
    }
    const u = await user(ctx);
    if (!u.pending_file_id) {
      await ctx.reply(withPhotoTip(c.ask));
      return;
    }
    // The delivered result carries the "оживить" upsell (camv:<camp>:<genId>) on
    // its keyboard — referencing the result by id, not by stashing its URL in
    // pending_file_id (which must stay the user's upload).
    await runGeneration(ctx, u, PRESET_MODEL, preset.prompt, u.pending_file_id, {
      crafted: true,
      allowFreeFirst: true,
      animate: c.id,
    });
  });

  // Animate a specific campaign RESULT (referenced by generation id, resolved
  // from the gallery) — never reuses a stale pending photo.
  bot.callbackQuery(/^camv:([^:]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const c = campaignById(ctx.match[1]);
    const u = await user(ctx);
    const gen = await getGeneration(Number(ctx.match[2]), u.id);
    if (!c || !gen || !gen.output_url) {
      await ctx.reply("Сначала создайте картинку в кампании 🙂");
      return;
    }
    await runGeneration(ctx, u, c.animateModel, c.animatePrompt, gen.output_url, { crafted: true });
  });

  bot.callbackQuery("menu:animate", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    await sendMenuVideo(ctx, "animate"); // example of the expected result
    // Top-level entry → always ask for a fresh photo (menu:videopick keeps the
    // just-uploaded photo for the in-flow "pick a video model" step).
    await setPending(u.id, "mode_animate", null);
    await ctx.reply("Вот пример 👆 Пришлите фото 🎬 — и выберите модель (Kling / Seedance).");
  });

  bot.callbackQuery("menu:videopick", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (!u.pending_file_id) {
      await ctx.reply("Сначала пришлите фото 🙂");
      return;
    }
    await ctx.reply("🎬 Выберите видео-модель:", { reply_markup: videoModelsKeyboard() });
  });

  bot.callbackQuery("menu:text", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    await setPending(u.id, null, u.pending_file_id); // leave photo mode so the next text becomes a t2i prompt
    await sendMenuAlbum(ctx, ["text_example_1", "text_example_2"]); // examples of the expected result
    await ctx.reply("✨ Выберите модель для картинки по тексту:", {
      reply_markup: imageModelsKeyboard(),
    });
  });

  // Top-models hub: image-model picker + a route into the video-model picker.
  bot.callbackQuery("menu:models", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    await setPending(u.id, null, u.pending_file_id);
    await ctx.reply(
      "⚡ Топовые модели ИИ.\nКартинка по тексту — выберите модель (или пришлите фото для видео):",
      { reply_markup: imageModelsKeyboard() },
    );
  });

  bot.callbackQuery("menu:balance", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendBalance(ctx, (await user(ctx)).credits);
  });

  bot.callbackQuery("menu:ref", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendRefLink(ctx);
  });

  // "Ещё стиль" on a delivered result: reuse the last photo if we still have it.
  bot.callbackQuery("menu:styles", async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    if (!u.pending_file_id) {
      await ctx.reply("Пришлите фото — и выбирайте стиль 🙂");
      return;
    }
    await showPresets(ctx, "photo", "Выберите стиль:");
  });

  async function sendRefLink(ctx: Context) {
    const u = await user(ctx);
    const code = await ensureRefCode(u.id);
    const link = `https://t.me/${ctx.me.username}?start=${code}`;
    const st = await referralStats(u.id);
    const pct = Math.round(config.referralPercent * 100);

    // One-tap share: opens Telegram's share sheet with the link + a prefilled pitch.
    const pitch =
      `Держи ${nUnits(config.referralJoinBonus)} 🔫 в подарок на AI-фото и видео в NeuroShot 🎁 ` +
      `Оживляй фото, делай карточки товара и аватары:`;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(pitch)}`;

    const next = REFERRAL_MILESTONES.find((m) => st.paying < m.friends);
    const milestone = next
      ? `🏆 До бонуса <b>+${nUnits(next.bonus)}</b>: ещё ${next.friends - st.paying} друзей с покупкой`
      : "🏆 Все бонусы-вехи получены — вы легенда! 🔥";

    const text =
      `🎁 <b>Приглашайте друзей — зарабатывайте ${UNIT_EMOJI} патроны</b>\n\n` +
      `👥 Приглашено: <b>${st.invited}</b>   ·   💳 покупают: <b>${st.paying}</b>\n` +
      `💰 Всего заработано: <b>${UNIT_EMOJI} ${nUnits(st.earned)}</b>\n\n` +
      `<b>Как это работает:</b>\n` +
      `• Друг получает <b>+${nUnits(config.referralJoinBonus)}</b> при входе по ссылке\n` +
      `• Вы — <b>+${nUnits(config.referralFirstPurchaseBonus)}</b> за его первую покупку\n` +
      `• И <b>${pct}%</b> с каждого его пакета — навсегда\n` +
      `• ${milestone}\n\n` +
      `🔗 Ваша ссылка:\n<code>${link}</code>`;

    const kb = new InlineKeyboard().url("📣 Поделиться с другом", shareUrl);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }

  // ---- Photo in → route by selected mode (or show the action menu) ----

  bot.on("message:photo", async (ctx) => {
    const u = await user(ctx);
    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1].file_id; // largest size
    const mode = u.pending_action;

    if (mode === "mode_product") {
      await setPending(u.id, "await_action", fileId);
      await showPresets(ctx, "product", "Отличный кадр! Выберите подачу товара:");
      return;
    }
    if (mode === "mode_photo") {
      await setPending(u.id, "await_action", fileId);
      await showPresets(ctx, "photo", "Выберите стиль — один тап, без промптов:");
      return;
    }
    if (mode === "mode_animate") {
      await setPending(u.id, "await_action", fileId);
      await ctx.reply("🎬 Выберите видео-модель:", { reply_markup: videoModelsKeyboard() });
      return;
    }
    if (mode?.startsWith("mode_free_")) {
      const s = freeScenarioById(mode.slice("mode_free_".length));
      if (s) {
        // runFreeScenario manages pending state (and keeps the freebie on failure).
        await runFreeScenario(ctx, u, s, fileId);
        return;
      }
    }
    if (mode?.startsWith("mode_camp_")) {
      const c = campaignById(mode.slice("mode_camp_".length));
      if (c) {
        await setPending(u.id, "await_action", fileId);
        await ctx.reply(c.header, { reply_markup: campaignPresetKeyboard(c) });
        return;
      }
    }

    await setPending(u.id, "await_action", fileId);
    const kb = new InlineKeyboard()
      .text("📸 AI-фотосессия — стили", "pick:photo")
      .row()
      .text("🛍 Продающее фото товара", "pick:product")
      .row()
      .text(`🖼 Редактировать по описанию (${MODELS.photo_edit.credits} 🔫)`, "act:photo_edit")
      .row()
      .text("🎬 Оживить в видео (Kling / Seedance)", "menu:videopick");
    await ctx.reply("Что сделать с этим фото?", { reply_markup: kb });
  });

  bot.callbackQuery(/^act:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    const model = modelByKey(ctx.match[1]);
    if (!model || !u.pending_file_id) {
      await ctx.reply("Сначала пришлите фото 🙂");
      return;
    }
    await setPending(u.id, model.key, u.pending_file_id);
    await ctx.reply(
      model.kind === "image_to_video"
        ? "Опишите движение (например: «медленный наезд камеры, волосы развеваются»):"
        : "Опишите, что изменить (например: «замени фон на парижскую улицу на закате»):",
    );
  });

  // Text-to-image model picked from a picker — no photo needed, next text runs it.
  bot.callbackQuery(/^txt:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    const model = modelByKey(ctx.match[1]);
    if (!model || model.kind !== "text_to_image") {
      await ctx.reply("Модель недоступна 🙂");
      return;
    }
    await setPending(u.id, model.key, null); // text model: no photo
    await ctx.reply(`✍️ Напишите, что нарисовать — ${model.label} (${model.credits} 🔫):`);
  });

  // One-tap presets: curated prompt through the premium model, no typing.
  bot.callbackQuery(/^preset:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await user(ctx);
    const preset = PRESETS.find((p) => p.id === ctx.match[1]);
    if (!preset) {
      await ctx.reply("Этот стиль больше недоступен — пришлите фото и выберите заново 🙂");
      return;
    }
    if (!u.pending_file_id) {
      await ctx.reply("Сначала пришлите фото 🙂");
      return;
    }
    await runGeneration(ctx, u, PRESET_MODEL, preset.prompt, u.pending_file_id, {
      crafted: true,
      allowFreeFirst: true,
    });
  });

  // ---- Text in → prompt for a pending action, or plain text-to-image ----

  bot.on("message:text", async (ctx) => {
    const u = await user(ctx);
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;

    if (u.pending_action?.startsWith("mode_")) {
      // They picked a photo-based use case but typed text — gently re-route.
      if (u.pending_action !== "mode_animate" || !u.pending_file_id) {
        await ctx.reply("Пришлите фото 📸 — или просто напишите /menu, чтобы выбрать другое.");
        return;
      }
    }

    if (u.pending_action && u.pending_action !== "await_action" && !u.pending_action.startsWith("mode_")) {
      const model = modelByKey(u.pending_action);
      if (model?.kind === "text_to_image") {
        await runGeneration(ctx, u, model, text); // picked text model, no photo needed
        return;
      }
      if (model && u.pending_file_id) {
        await runGeneration(ctx, u, model, text, u.pending_file_id);
        return;
      }
    }
    await runGeneration(ctx, u, MODELS.text_to_image, text);
  });

  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) console.error("telegram error:", e.description);
    else if (e instanceof HttpError) console.error("network error:", e);
    else console.error("unhandled error:", e);
  });

  return bot;
}
