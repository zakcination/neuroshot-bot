/**
 * Support entry point and intent router.
 *
 * Two problems this solves, both of which cost money today:
 *
 * 1. There was no way to reach a human. No /help, no /support — the only contact
 *    was an address buried in /terms. Every problem a buyer hit was invisible to
 *    us unless they happened to press "✅ Я оплатил".
 *
 * 2. `bot.on("message:text")` sends ANY text straight to a paid image
 *    generation. So "оплатил, где патроны?" cost the person 2 🔫 and came back
 *    as a picture of their own complaint. The worst possible answer to the worst
 *    possible message, and the owner never saw it.
 *
 * The router is deliberately CONSERVATIVE. A false positive steals a real
 * generation request, so a message is only intercepted when it looks like a
 * question or complaint rather than a scene description — and even then the
 * reply carries a one-tap "нет, это был запрос на картинку" escape, so being
 * wrong costs one tap instead of the request.
 *
 * Nothing here spends the weekly proactive-message budget (config.pushPerWeek):
 * that budget governs messages WE start. Answering someone who just wrote to us
 * is a reply, and relays go to admins, not to users.
 */
import type { Api, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "./config.js";
import { logEvent } from "./db.js";
import { UNIT_EMOJI } from "./text.js";

export type SupportIntent = "payment" | "refund" | "broken" | "price" | "howto" | "privacy";

interface IntentSpec {
  intent: SupportIntent;
  /** Lowercased substrings; any hit selects this intent. */
  cues: string[];
  /** Does a human need to see this? Money and breakage do; questions do not. */
  relay: boolean;
  answer: string;
}

/**
 * Order matters: the first spec that matches wins, so money-shaped messages are
 * classified before the generic "не работает" catch-all.
 */
const INTENTS: IntentSpec[] = [
  {
    intent: "payment",
    relay: true,
    cues: [
      "оплатил", "оплатила", "оплата не", "не пришли патрон", "не пришло", "не начислил",
      "где патрон", "где мои патрон", "деньги ушли", "деньги списал", "списали деньги",
      "перевёл", "перевел", "отправил чек", "скинул чек", "каспи не", "kaspi не",
      "төледім", "ақша",
    ],
    answer:
      `Проверяем оплату вручную — обычно это до 30 минут.\n\n` +
      `Чтобы ускорить: пришлите <b>номер заявки</b> (он был в сообщении со ссылкой на оплату) ` +
      `и скриншот чека. Начислим ${UNIT_EMOJI} патроны, даже если платёж ещё не отобразился у нас — ` +
      `разберёмся потом.\n\nВаше сообщение уже у нас, ответим здесь же.`,
  },
  {
    intent: "refund",
    relay: true,
    cues: ["верните деньги", "вернуть деньги", "возврат", "хочу вернуть", "развод", "обман", "мошенник"],
    answer:
      `Понимаем. Условия возврата — /refund, там же реквизиты продавца.\n\n` +
      `Напишите номер заявки и что именно пошло не так — разберёмся вручную. ` +
      `Сообщение уже передано.`,
  },
  {
    intent: "broken",
    relay: true,
    cues: [
      "не работает", "ошибка", "не получается", "не получилось", "висит", "зависло",
      "долго генер", "ничего не приходит", "истанбул", "не грузит", "жұмыс істемей",
    ],
    answer:
      `Жаль, что не сработало. Если ${UNIT_EMOJI} патроны списались, а результата нет — они ` +
      `возвращаются автоматически, проверьте /balance.\n\n` +
      `Напишите, что именно вы делали — передали в поддержку, разберёмся.`,
  },
  {
    intent: "price",
    relay: false,
    cues: ["сколько стоит", "какая цена", "почём", "почем", "дорого", "цены", "қанша тұрады"],
    answer:
      `Оплата — пакетами ${UNIT_EMOJI} патронов, картой Kaspi. Все пакеты и что на них выйдет: /buy\n\n` +
      `Картинка стоит от 2 патронов, видео — от 10. Точную цену видно на каждой кнопке до нажатия.`,
  },
  {
    intent: "privacy",
    relay: false,
    cues: ["удалите мои", "удалить мои данные", "храните фото", "мои фото", "конфиденциаль", "приватност"],
    answer:
      `Ваши фотографии используются только для вашей же генерации и ни для чего больше — ` +
      `ни в рекламе, ни в примерах.\n\nПолитика — /privacy. Удалить всё о себе — /delete_me.`,
  },
  {
    intent: "howto",
    relay: false,
    cues: [
      "как это работает", "как пользоваться", "что делать", "не понимаю", "не понял",
      "помогите", "помощь", "подскажите", "хелп", "help", "көмек",
    ],
    answer:
      `Всё делается в два шага: пришлите фото → выберите стиль. Больше ничего вводить не нужно.\n\n` +
      `Открыть меню — /menu. Что это вообще такое — /start.`,
  },
];

/**
 * A generation prompt is a description; a support message is a question or a
 * complaint. These are the shapes that make a match trustworthy — without one of
 * them, "не работает" could easily be part of a scene ("телефон не работает").
 */
function looksLikeAQuestion(text: string): boolean {
  return text.includes("?") || /^(где|почему|как|что|когда|сколько|можно|а вы|кто|қалай|неге|қашан)\b/i.test(text);
}

/**
 * Classify a free-text message, or null to let it through to generation.
 *
 * Long messages are never intercepted: past ~120 characters this is someone
 * describing a scene, and cue words inside a long description are coincidence.
 * Short messages containing a money cue are intercepted even without a question
 * mark — "оплатил, патроны не пришли" has no "?" and is the single most
 * important message we can receive.
 */
export function classifySupport(raw: string): SupportIntent | null {
  const text = raw.trim().toLowerCase();
  if (!text || text.length > 120) return null;
  for (const spec of INTENTS) {
    if (!spec.cues.some((c) => text.includes(c))) continue;
    // Money and refunds stand on their own; softer intents need question shape
    // so an image prompt is never mistaken for a plea for help.
    if (spec.intent === "payment" || spec.intent === "refund") return spec.intent;
    if (looksLikeAQuestion(text)) return spec.intent;
    return null;
  }
  return null;
}

export function answerFor(intent: SupportIntent): string {
  return INTENTS.find((i) => i.intent === intent)!.answer;
}

export function shouldRelay(intent: SupportIntent): boolean {
  return INTENTS.find((i) => i.intent === intent)!.relay;
}

/**
 * Texts intercepted by the router, kept so the "это был запрос на картинку"
 * button can run the original request. In memory on purpose: this is a UX escape
 * hatch with a lifetime of seconds, and the cost of losing it on a restart is
 * that someone retypes a sentence. Persisting it would mean storing arbitrary
 * user text for no other reason.
 */
const heldPrompts = new Map<number, { text: string; at: number }>();
const HOLD_MS = 10 * 60 * 1000;

export function holdPrompt(userId: number, text: string): void {
  heldPrompts.set(userId, { text, at: Date.now() });
}

export function takeHeldPrompt(userId: number): string | null {
  const held = heldPrompts.get(userId);
  heldPrompts.delete(userId);
  if (!held || Date.now() - held.at > HOLD_MS) return null;
  return held.text;
}

/** Per-user relay cooldown, so one upset person cannot flood the owner's DMs. */
const lastRelay = new Map<number, number>();
const RELAY_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Forward a user's message to the admins. Never throws into the caller: a
 * failed relay must not turn into an error in front of someone who is already
 * unhappy — we still show them the answer.
 */
export async function relayToAdmins(
  api: Api,
  from: { id: number; first_name?: string; username?: string },
  intent: SupportIntent,
  text: string,
): Promise<void> {
  const last = lastRelay.get(from.id) ?? 0;
  if (Date.now() - last < RELAY_COOLDOWN_MS) return;
  lastRelay.set(from.id, Date.now());
  const who = from.username ? `@${from.username}` : (from.first_name ?? "?");
  const body =
    `🆘 <b>Обращение (${intent})</b>\n` +
    `От: ${who} · <code>${from.id}</code>\n\n` +
    `<i>${text.slice(0, 500).replace(/[<>&]/g, " ")}</i>\n\n` +
    `Ответить: откройте чат с <code>${from.id}</code>`;
  for (const adminId of config.adminIds) {
    await api.sendMessage(adminId, body, { parse_mode: "HTML" }).catch(() => {});
  }
}

/** The /help page: what to do, and how to reach a person. */
export function helpText(): string {
  return (
    `🆘 <b>Помощь</b>\n\n` +
    `<b>Как создать:</b> пришлите фото → выберите стиль. Всё, больше ничего вводить не нужно. /menu\n\n` +
    `<b>Оплатили, а ${UNIT_EMOJI} патроны не пришли?</b> Напишите сюда номер заявки — он был в сообщении ` +
    `со ссылкой на оплату. Проверяем вручную, обычно до 30 минут.\n\n` +
    `<b>Не получился результат?</b> Если патроны списались, а результата нет — они возвращаются ` +
    `автоматически, проверьте /balance.\n\n` +
    `<b>Полезное:</b> /buy — пакеты · /balance — баланс · /refund — возврат · /privacy — данные · ` +
    `/delete_me — удалить всё о себе\n\n` +
    `Просто напишите вопрос в этот чат — он придёт человеку.`
  );
}

/** Marks the next free-text message as a support message, whatever it says. */
export function helpKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("✍️ Написать в поддержку", "support:write").row().text("📋 Меню", "menu:main");
}

/** Record that a support message was seen, for the funnel and for /dash. */
export async function logSupport(userId: number, intent: SupportIntent): Promise<void> {
  await logEvent(userId, "support", intent);
}

/** Reply used when the router intercepted something that WAS a prompt. */
export function escapeKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🎨 Нет, это был запрос на картинку", "support:generate");
}

export type SupportCtx = Context;
