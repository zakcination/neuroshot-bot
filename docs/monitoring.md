# Solo-CEO monitoring — the dashboard interrupts you

Philosophy (growth corpus): **no analytics theater at the start** — no
dashboards with 3 users, no CAC/LTV math before ~1,000 people through the
funnel. You don't watch a dashboard; the dashboard interrupts you. One daily
digest, alerts on exceptions, a 30-minute weekly review. Everything else is
procrastination dressed as diligence.

## Stage gates

| Stage | North star | Watch | Ignore |
|---|---|---|---|
| 0 → first 10 payments | payments this week | raw events + talk to every user | everything else |
| 10 payments → $1K MRR | cost per paying user, per source | funnel per creative, error rate, margin | cohorts, LTV, churn curves |
| $1K → $10K MRR | quarterly payback ≥ ×4 | retention D7/D30, repeat purchase, credit liability | installs, views, MAU |

## What's implemented (src/monitor.ts)

### The daily digest — 6 numbers, pushed to admins at `DIGEST_HOUR_UTC` (default 6 = 09:00 МСК)

1. **Новых** — by acquisition source (the only daily decision: which
   source/creative gets tomorrow's budget)
2. **Активация** — of the new users, how many reached a first generation
3. **Пейволл** — views + distinct users
4. **Оплат** — count + ⭐ revenue, split by source (payers vs freeloaders)
5. **Выручка / себестоимость / маржа** — stars × `STAR_USD` (conservative
   $0.01) vs per-model provider cost from `models.ts`
6. **Генерации + ошибки + возвраты · обязательства** — sold-but-unspent 🔫
   are future API costs you've already been paid for

On demand: **`/dash`** (admin) = same digest, `/dash 7` = trailing week.

### Alerts — checked every 10 min, each key fires at most once per 24h

| Alert | Threshold | Why it interrupts |
|---|---|---|
| Model error rate | >5% over the last hour (min 5 runs) | fal endpoint drift = silent revenue stop |
| Gross margin | <50% for the trailing day (when revenue > 0) | token costs creeping past the genre's band |
| Dead funnel | 48h with ≥30 generations and ZERO payments | a step broke — walk the payment path by hand |

## Source tracking

First-touch, immutable (`users.source`):
- friend referral link → `ref`
- creator code `?start=c_seymur` → `c_seymur`
- **any other deep-link payload → its slug**: give every creative/channel its
  own link — `t.me/<bot>?start=src_tiktok1`, `?start=vk_post3` — and /dash
  splits the funnel by it. Slug = lowercase `[a-z0-9_-]`, 32 chars max.

## The 3-month gate

Calendar it the day you launch paid traffic: **>10 sales in 3 months = pour
budget; 0 = kill.** No dashboards required for that decision.

## Env

- `DIGEST_HOUR_UTC` (default 6) — daily digest hour, UTC
- `STAR_USD` (default 0.01) — conservative payout per ⭐ for margin math only
