/**
 * Regenerates `docs/cost-line.md` — the per-family cost line.
 *
 * Run: `npm run cost-line` (needs BOT_TOKEN/FAL_KEY set to anything; config.ts
 * validates them at import even though nothing here calls a provider).
 *
 * Why a script and not a hand-written table: fal's prices move monthly, and a
 * stale table is worse than none — it is the anchor every pack price is derived
 * from. Everything below is computed from `priceFor()`/`costUsdFor()`, the same
 * functions the bot charges with, so the doc cannot drift from the code.
 */
import { writeFileSync } from "node:fs";
import { MODELS, priceFor, costUsdFor, CREDIT_COST_BASIS, PACKS } from "../src/models.js";

const KZT = 480; // KZT_PER_USD default; digest-only, never used for pricing
const KASPI_FEE = 0.0095; // docs/payment-compliance.md
const PAYOUT_WORST = 0.20; // partner ladder ceiling (docs/partner-program.md)

type Spec = (typeof MODELS)[keyof typeof MODELS];

function familyOf(key: string, spec: Spec): string {
  const hay = `${(spec as { label?: string }).label ?? ""} ${key}`;
  if (/nano_banana|nb2/i.test(hay)) return "Nano Banana";
  if (/gpt.?image|premium/i.test(hay)) return "GPT Image";
  if (/seedream/i.test(hay)) return "Seedream";
  if (/seedance/i.test(hay)) return "Seedance · video";
  if (/kling/i.test(hay)) return "Kling · video";
  if (/hailuo|minimax/i.test(hay)) return "Hailuo · video";
  return spec.kind === "image_to_video" ? "Other · video" : "Other · image";
}

type Variant = { name: string; opts: Record<string, unknown> };

function variantsOf(spec: Spec): Variant[] {
  const s = spec as {
    video?: { durations?: number[]; resolutions?: Array<{ id: string; label: string }> };
    resolutions?: Array<{ id: string; label: string }>;
  };
  const out: Variant[] = [];
  if (s.video?.durations?.length) {
    for (const d of s.video.durations) {
      if (s.video.resolutions?.length) {
        for (const r of s.video.resolutions) out.push({ name: `${d}s · ${r.label}`, opts: { duration: d, resolution: r.id } });
      } else out.push({ name: `${d}s`, opts: { duration: d } });
    }
  } else if (s.resolutions?.length) {
    for (const r of s.resolutions) out.push({ name: r.label, opts: { resolution: r.id } });
  } else out.push({ name: "—", opts: {} });
  return out;
}

// `once` packs are excluded on purpose: a one-off entry set is priced below every
// standing rung, so quoting it as the cheap end of the range would describe a
// price nobody can buy twice. Same rule the buy screen uses (bestValuePackId).
const ladderRates = PACKS.filter((p) => !p.offer && !p.course && !p.retired && !p.once)
  .map((p) => ({ id: p.id, rate: p.kzt / p.credits }))
  .sort((a, b) => b.rate - a.rate);
const dearest = ladderRates[0]; // worst rate the customer can pay (smallest pack)
const cheapest = ladderRates[ladderRates.length - 1];

const L: string[] = [];
L.push("# Cost line — себестоимость и цена по семействам моделей");
L.push("");
L.push("> **Сгенерировано** `scripts/cost-line.mts` (`npm run cost-line`). Не редактировать руками.");
L.push("> Все числа посчитаны теми же `priceFor()`/`costUsdFor()`, которыми бот реально списывает,");
L.push("> поэтому таблица не может разойтись с кодом. Цены fal двигаются — перегенерируйте после правки реестра.");
L.push("");
L.push(`**Базис:** \`CREDIT_COST_BASIS = $${CREDIT_COST_BASIS}\` себестоимости на патрон · курс дайджеста ${KZT} ₸/$ · Kaspi ${(KASPI_FEE * 100).toFixed(2)}% · худший партнёрский payout ${PAYOUT_WORST * 100}%.`);
L.push("");
L.push(`**Правило:** \`credits = ceil(approxCostUsd / ${CREDIT_COST_BASIS})\` ⇒ себестоимость патрона всегда ≤ $${CREDIT_COST_BASIS}.`);
L.push(`Цена клиенту зависит от того, каким пакетом он минтил патроны: **${dearest.rate.toFixed(1)} ₸/🔫** (\`${dearest.id}\`) … **${cheapest.rate.toFixed(1)} ₸/🔫** (\`${cheapest.id}\`).`);
L.push("");

const rows: Array<{ fam: string; key: string; label: string; variant: string; usd: number; cr: number; per: number }> = [];
for (const [key, spec] of Object.entries(MODELS)) {
  for (const v of variantsOf(spec)) {
    const cr = priceFor(spec, v.opts);
    const usd = costUsdFor(spec, v.opts);
    rows.push({ fam: familyOf(key, spec), key, label: (spec as { label?: string }).label ?? key, variant: v.name, usd, cr, per: cr > 0 ? usd / cr : 0 });
  }
}

const ORDER = ["Nano Banana", "GPT Image", "Seedream", "Other · image", "Hailuo · video", "Kling · video", "Seedance · video", "Other · video"];
for (const fam of ORDER) {
  const list = rows.filter((r) => r.fam === fam).sort((a, b) => a.usd - b.usd);
  if (!list.length) continue;
  L.push(`## ${fam}`);
  L.push("");
  L.push(`| model key | вариант | fal $ | 🔫 | $/🔫 | запас до базиса | клиенту @${dearest.rate.toFixed(1)} | @${cheapest.rate.toFixed(1)} |`);
  L.push("|---|---|---|---|---|---|---|---|");
  for (const r of list) {
    const head = CREDIT_COST_BASIS - r.per;
    const flag = head < 1e-9 ? "**0 — на потолке**" : `${((head / CREDIT_COST_BASIS) * 100).toFixed(0)}%`;
    L.push(`| \`${r.key}\` | ${r.variant} | $${r.usd.toFixed(3)} | ${r.cr} | $${r.per.toFixed(4)} | ${flag} | ${Math.round(r.cr * dearest.rate)} ₸ | ${Math.round(r.cr * cheapest.rate)} ₸ |`);
  }
  L.push("");
}

// --- systemic findings -------------------------------------------------------
const base = Object.entries(MODELS).map(([k, s]) => ({ k, s, per: costUsdFor(s, {}) / priceFor(s, {}) }));
const atCeiling = base.filter((b) => Math.abs(b.per - CREDIT_COST_BASIS) < 1e-9);

L.push("## Системные наблюдения");
L.push("");
L.push(`### 1. ${atCeiling.length} из ${base.length} моделей стоят ровно на потолке базиса`);
L.push("");
L.push(`У них \`$/🔫\` = ровно $${CREDIT_COST_BASIS.toFixed(2)} — **нулевой запас**. Любое повышение цены fal немедленно уводит их ниже базиса, а алерт, который это поймал бы (\`userCogsUsd\`/\`usersOverCogsThreshold\`), — мёртвый код без call sites.`);
L.push("");
L.push("| model key | модель | fal $ | 🔫 |");
L.push("|---|---|---|---|");
for (const b of atCeiling) L.push(`| \`${b.k}\` | ${(b.s as { label?: string }).label ?? b.k} | $${costUsdFor(b.s, {}).toFixed(3)} | ${priceFor(b.s, {})} |`);
L.push("");

// resolution multipliers
const resLines: string[] = [];
for (const [k, spec] of Object.entries(MODELS)) {
  const s = spec as { video?: { durations?: number[]; resolutions?: Array<{ id: string; label: string; mult: number }> } };
  const res = s.video?.resolutions;
  if (!res?.length) continue;
  const d = s.video?.durations?.[0];
  const cells = res.map((r) => `${r.label} → ${priceFor(spec, { resolution: r.id, duration: d })}🔫 (mult ${r.mult})`);
  resLines.push(`| \`${k}\` | ${cells.join(" · ")} |`);
}
if (resLines.length) {
  L.push("### 2. Тиры разрешения не меняют цену — неиспользованный рычаг");
  L.push("");
  L.push("У всех тиров `mult: 1`, поэтому 480p стоит ровно столько же, сколько 720p. Для покупателя это выбор без экономического смысла, а для нас — **отсутствующая дешёвая ступень**: единственный способ сделать видео дешевле сегодня — уйти на другую модель, а не понизить разрешение.");
  L.push("");
  L.push("| model key | тиры |");
  L.push("|---|---|");
  L.push(...resLines);
  L.push("");
}

// reroll
L.push("### 3. Реальная цена — за УДЕРЖАННЫЙ результат, а не за генерацию");
L.push("");
L.push("Реролл списывается всегда (рефанд только при сбое провайдера), поэтому **маржа инвариантна к R**, но цена клиента за годный результат растёт линейно. R **никем не измерен** — `rerollRateApprox` написан и не вызывается.");
L.push("");
const rr = ["seedream_edit", "nb2_edit", "nano_banana_pro", "premium_edit", "hailuo_fast"].filter((k) => k in MODELS);
L.push(`| модель | 🔫 | R=1 | R=1.5 | R=2 | R=3 | (цена @${dearest.rate.toFixed(1)} ₸/🔫) |`);
L.push("|---|---|---|---|---|---|---|");
for (const k of rr) {
  const s = MODELS[k as keyof typeof MODELS];
  const p = priceFor(s, {});
  const c = [1, 1.5, 2, 3].map((R) => `${Math.round(p * R * dearest.rate)} ₸`);
  L.push(`| ${(s as { label?: string }).label ?? k} | ${p} | ${c.join(" | ")} | |`);
}
L.push("");
L.push("Для сравнения: дизайнер карточки в KZ берёт **900–1 000 ₸ за штуку**, предметная съёмка — **от 1 000 ₸ за кадр** (поиск 2026-07-27). Карточка на `seedream_edit` остаётся дешевле даже при R=3.");
L.push("");

writeFileSync(new URL("../docs/cost-line.md", import.meta.url), L.join("\n"));
console.log(`docs/cost-line.md updated — ${rows.length} variants across ${new Set(rows.map((r) => r.fam)).size} families, ${atCeiling.length} at the basis ceiling.`);
