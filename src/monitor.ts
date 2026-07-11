/**
 * Solo-CEO monitoring: the dashboard interrupts YOU, not the reverse.
 *   • one daily digest pushed to admins (the 6 numbers that matter);
 *   • exception ALERTS for the moments that deserve an interrupt;
 *   • /dash renders the same digest on demand.
 * Deliberately NO dashboards/cohorts/LTV math — meaningless before ~1,000
 * users through the funnel; the only daily decision is "which source gets
 * tomorrow's budget", so everything splits by acquisition source and payers.
 */
import { config } from "./config.js";
import {
  addCredits,
  logEvent,
  markNudged,
  nudgedOnUtcDay,
  query,
  reapStalePending,
  usersToNudge,
  type NudgeTarget,
} from "./db.js";
import { cheapestModel, CREDIT_COST_BASIS, MODELS } from "./models.js";

const MODEL_COST = new Map(Object.values(MODELS).map((m) => [m.key, m.approxCostUsd]));

export interface Digest {
  hours: number;
  newBySource: Array<{ source: string; users: number }>;
  paysBySource: Array<{ source: string; payments: number; kzt: number }>;
  newUsers: number;
  newActivated: number; // of the new users, how many started a generation
  paywallViews: number;
  paywallUsers: number;
  payments: number;
  kzt: number; // gross revenue in tenge (Kaspi)
  genOk: number;
  genError: number;
  refunds: number;
  costUsd: number; // provider cost of delivered generations (approx)
  revenueUsd: number; // kzt ÷ KZT_PER_USD
  marginPct: number | null; // null when no revenue in the window
  creditLiability: number; // sold-but-unspent 🔫 across all users
}

const num = (v: unknown) => Number(v ?? 0);

/** Collect the digest numbers for the trailing window (default 24h). */
export async function buildDigest(hours = 24): Promise<Digest> {
  const win = `${Math.max(1, Math.floor(hours))} hours`;

  const newRows = await query(
    `SELECT COALESCE(source, 'organic') AS source, COUNT(*)::int AS users
     FROM users WHERE created_at > now() - $1::interval
     GROUP BY 1 ORDER BY 2 DESC`,
    [win],
  );
  const payRows = await query(
    `SELECT COALESCE(u.source, 'organic') AS source, COUNT(*)::int AS payments,
            COALESCE(SUM(CAST(l.meta AS INTEGER)), 0)::int AS kzt
     FROM ledger l JOIN users u ON u.id = l.user_id
     WHERE l.reason = 'purchase' AND l.created_at > now() - $1::interval
     GROUP BY 1 ORDER BY 3 DESC`,
    [win],
  );
  const activated = await query(
    `SELECT COUNT(*)::int AS c FROM users u
     WHERE u.created_at > now() - $1::interval
       AND EXISTS (SELECT 1 FROM events e WHERE e.user_id = u.id AND e.type = 'gen_start')`,
    [win],
  );
  const paywall = await query(
    `SELECT COUNT(*)::int AS views, COUNT(DISTINCT user_id)::int AS users
     FROM events WHERE type = 'paywall' AND created_at > now() - $1::interval`,
    [win],
  );
  const gens = await query(
    `SELECT model, status, COUNT(*)::int AS c, COALESCE(SUM(credits), 0)::int AS credits
     FROM generations WHERE created_at > now() - $1::interval GROUP BY 1, 2`,
    [win],
  );
  const refunds = await query(
    `SELECT COUNT(*)::int AS c FROM ledger WHERE reason = 'refund' AND created_at > now() - $1::interval`,
    [win],
  );
  const liability = await query(`SELECT COALESCE(SUM(credits), 0)::int AS c FROM users`);

  let genOk = 0;
  let genError = 0;
  let costUsd = 0;
  for (const g of gens) {
    const c = num(g.c);
    if (g.status === "ok") {
      genOk += c;
      // Unknown/legacy model keys fall back to the credit cost basis.
      costUsd += MODEL_COST.get(String(g.model)) != null
        ? MODEL_COST.get(String(g.model))! * c
        : num(g.credits) * CREDIT_COST_BASIS;
    } else if (g.status === "error") {
      genError += c;
    }
  }

  const payments = payRows.reduce((a, r) => a + num(r.payments), 0);
  const kzt = payRows.reduce((a, r) => a + num(r.kzt), 0);
  const revenueUsd = kzt / config.kztPerUsd;

  return {
    hours,
    newBySource: newRows.map((r) => ({ source: String(r.source), users: num(r.users) })),
    paysBySource: payRows.map((r) => ({
      source: String(r.source),
      payments: num(r.payments),
      kzt: num(r.kzt),
    })),
    newUsers: newRows.reduce((a, r) => a + num(r.users), 0),
    newActivated: num(activated[0]?.c),
    paywallViews: num(paywall[0]?.views),
    paywallUsers: num(paywall[0]?.users),
    payments,
    kzt,
    genOk,
    genError,
    refunds: num(refunds[0]?.c),
    costUsd,
    revenueUsd,
    marginPct: revenueUsd > 0 ? Math.round((1 - costUsd / revenueUsd) * 100) : null,
    creditLiability: num(liability[0]?.c),
  };
}

/** The 6 numbers, one message, payers split from freeloaders. */
export function formatDigest(d: Digest): string {
  const bySrc = d.newBySource.length
    ? d.newBySource.map((s) => `${s.source} ${s.users}`).join(" · ")
    : "—";
  const paySrc = d.paysBySource.length
    ? d.paysBySource.map((s) => `${s.source}: ${s.payments} (${s.kzt} ₸)`).join(" · ")
    : "—";
  const errRate = d.genOk + d.genError > 0
    ? Math.round((d.genError / (d.genOk + d.genError)) * 100)
    : 0;
  return [
    `📟 <b>NeuroShot — сводка за ${d.hours} ч</b>`,
    `👥 Новых: <b>${d.newUsers}</b> (${bySrc})`,
    `⚡ Активация (первая генерация): <b>${d.newActivated}/${d.newUsers}</b>`,
    `🧱 Пейволл: <b>${d.paywallViews}</b> показов · ${d.paywallUsers} чел.`,
    `💳 Оплат: <b>${d.payments}</b> на <b>${d.kzt} ₸</b> — ${paySrc}`,
    `📈 Выручка ≈ $${d.revenueUsd.toFixed(2)} · себестоимость ≈ $${d.costUsd.toFixed(2)} · ` +
      (d.marginPct == null ? "маржа: — (нет оплат)" : `маржа <b>${d.marginPct}%</b>`),
    `🎨 Генераций: ${d.genOk} ok / ${d.genError} err (${errRate}%) · возвратов: ${d.refunds}`,
    `🏦 Обязательства: <b>${d.creditLiability} 🔫</b> продано и не потрачено`,
    cheapLine(),
  ].join("\n");
}

/**
 * The daily cheapest-model line: which model is today's cheapest entry per
 * kind, and whether the free 🔫 cover it (the free-trial anchor). Recomputed
 * from the registry every digest — a fal price update moves it automatically.
 */
function cheapLine(): string {
  const img = cheapestModel("image_edit");
  const vid = cheapestModel("image_to_video");
  const trial = img.credits <= config.freeCredits ? "✅ бесплатной пробы хватает" : "⚠️ дороже бесплатных 🔫";
  return (
    `💡 Дешёвый вход: фото — ${img.label} ${img.credits} 🔫 ($${img.approxCostUsd.toFixed(2)}, ${trial}) · ` +
    `видео — ${vid.label} ${vid.credits} 🔫 ($${vid.approxCostUsd.toFixed(2)})`
  );
}

export interface Alert {
  key: string; // dedupe key — the same condition doesn't re-alert for 24h
  text: string;
}

/**
 * The interrupts a solo CEO actually needs (pure check — dedupe lives in the
 * scheduler): provider drift, margin floor, dead funnel.
 */
export async function checkAlerts(): Promise<Alert[]> {
  const out: Alert[] = [];

  // 1) Error rate >5% on any model over the last hour (min 5 runs) — fal
  //    endpoint drift is the #1 operational risk: a silent revenue stop.
  const perModel = await query(
    `SELECT model, COUNT(*)::int AS total,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)::int AS errs
     FROM generations WHERE created_at > now() - interval '1 hour' AND status IN ('ok','error')
     GROUP BY model`,
  );
  for (const m of perModel) {
    const total = num(m.total);
    const errs = num(m.errs);
    if (total >= 5 && errs / total > 0.05) {
      out.push({
        key: `err:${String(m.model)}`,
        text: `🚨 <b>${String(m.model)}</b>: ${errs}/${total} ошибок за час (${Math.round((errs / total) * 100)}%). Проверьте эндпоинт на fal.ai — возможен дрейф модели.`,
      });
    }
  }

  // 2) Gross margin <50% today (only meaningful when there IS revenue).
  const day = await buildDigest(24);
  if (day.marginPct != null && day.marginPct < 50) {
    out.push({
      key: "margin",
      text: `🚨 Маржа за сутки <b>${day.marginPct}%</b> (< 50%): выручка ≈ $${day.revenueUsd.toFixed(2)}, себестоимость ≈ $${day.costUsd.toFixed(2)}. Проверьте цены моделей в models.ts.`,
    });
  }

  // 3) Dead funnel: real usage for 48h but ZERO payments — a step broke.
  const usage = await query(
    `SELECT COUNT(*)::int AS c FROM events WHERE type = 'gen_start' AND created_at > now() - interval '48 hours'`,
  );
  const paid48 = await query(
    `SELECT COUNT(*)::int AS c FROM ledger WHERE reason = 'purchase' AND created_at > now() - interval '48 hours'`,
  );
  if (num(usage[0]?.c) >= 30 && num(paid48[0]?.c) === 0) {
    out.push({
      key: "deadfunnel",
      text: `🚨 48 часов без оплат при ${num(usage[0]?.c)} генерациях. Воронка сломана на каком-то шаге — пройдите путь оплаты руками (/buy → инвойс → платёж).`,
    });
  }

  return out;
}

type SendFn = (chatId: number, text: string) => Promise<unknown>;

/**
 * The re-engagement DM, tailored to the strongest reason to come back:
 *   • never claimed the free gift → lead with it (the biggest un-taken value);
 *   • has 🔫 left → remind them their patrons are waiting;
 *   • otherwise → a fresh-content nudge.
 */
export function nudgeText(u: NudgeTarget): string {
  if (!u.free_scenario_used) {
    return (
      "🎁 Вы не забрали свой <b>бесплатный подарок</b>! Одно фото → готовое видео " +
      "(принцесса 👸 или футбол ⚽️), без оплаты. Откройте меню — /menu"
    );
  }
  if (u.credits > 0) {
    return "✨ Ваши 🔫 патроны ждут — создайте новый шедевр за пару тапов. Открыть меню — /menu";
  }
  return "🆕 В NeuroShot новые сценарии и модели — загляните и сделайте что-нибудь крутое: /menu";
}

/**
 * Reaper: refund generations stuck in 'pending' beyond genStaleMinutes — a
 * detached render whose process died mid-flight (the early-ack means Telegram
 * won't redeliver, so nothing else recovers them). reapStalePending flips each
 * row pending→error atomically and returns it, so this and a late-recovering tail
 * can never double-refund. Free renders (credits=0) have nothing to refund.
 * Exported for tests. Returns how many rows were reaped.
 */
export async function runReaper(send: SendFn): Promise<number> {
  const stale = await reapStalePending(config.genStaleMinutes);
  for (const g of stale) {
    if (g.credits > 0) await addCredits(g.user_id, g.credits, "refund", g.model);
    await send(g.user_id, "⚠️ Рендер не завершился — 🔫 патроны возвращены. Попробуйте ещё раз.").catch(() => {});
  }
  return stale.length;
}

/**
 * One daily sweep that DMs a capped batch of dormant-but-recent users exactly
 * once each. Marks BEFORE sending so a crash mid-batch or a blocked user (send
 * throws) can never turn into a repeat nudge — a missed nudge is fine, a spammed
 * user is not. Exported for tests.
 */
export async function runReengagement(send: SendFn): Promise<number> {
  const targets = await usersToNudge(config.reengageBatch);
  if (!targets.length) return 0;
  await markNudged(targets.map((t) => t.id));
  let delivered = 0;
  for (const t of targets) {
    // Log the 'nudge' event only on a SUCCESSFUL send, so nudge→return metrics
    // aren't skewed by users who blocked the bot (nudged_at still guards retries).
    const ok = await send(t.id, nudgeText(t)).then(() => true).catch(() => false);
    if (ok) {
      delivered++;
      await logEvent(t.id, "nudge").catch(() => {});
    }
  }
  return delivered;
}

/**
 * Background loop: daily digest at config.digestHourUtc + alert checks every
 * 10 minutes (each alert key fires at most once per 24h). Failures are logged
 * and never crash the bot.
 */
export function startMonitor(send: SendFn): NodeJS.Timeout {
  let lastDigestDay = "";
  let lastNudgeDay = "";
  const lastAlertAt = new Map<string, number>();

  const tick = async () => {
    try {
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      if (now.getUTCHours() === config.digestHourUtc && lastDigestDay !== day) {
        lastDigestDay = day;
        const text = formatDigest(await buildDigest(24));
        for (const id of config.adminIds) await send(id, text).catch(() => {});
      }
      // Daily 48-hour re-engagement sweep (once per day, at most once per user).
      // In-memory lastNudgeDay avoids re-checking every minute within a process;
      // nudgedOnUtcDay makes it restart-safe (a mid-hour restart won't re-sweep).
      if (config.reengageEnabled && now.getUTCHours() === config.reengageHourUtc && lastNudgeDay !== day) {
        lastNudgeDay = day;
        if (!(await nudgedOnUtcDay(day))) {
          const n = await runReengagement(send);
          if (n > 0) console.log(`re-engagement: nudged ${n} dormant user(s)`);
        }
      }
      // Reaper: every 5 minutes, refund renders stuck 'pending' too long.
      if (now.getUTCMinutes() % 5 === 0) {
        const reaped = await runReaper(send);
        if (reaped > 0) console.log(`reaper: refunded ${reaped} stuck generation(s)`);
      }
      // Alerts: every 10 minutes (tick runs each minute).
      if (now.getUTCMinutes() % 10 === 0) {
        for (const a of await checkAlerts()) {
          const last = lastAlertAt.get(a.key) ?? 0;
          if (Date.now() - last < 24 * 60 * 60 * 1000) continue;
          lastAlertAt.set(a.key, Date.now());
          for (const id of config.adminIds) await send(id, a.text).catch(() => {});
        }
      }
    } catch (e) {
      console.error("monitor tick failed:", e);
    }
  };
  const timer = setInterval(() => void tick(), 60 * 1000);
  timer.unref?.(); // never keep the process alive on its own
  return timer;
}
