# Partner program v2 — self-serve codes, cashback, withdrawals

Turns every user into a referrer with **unique codes** (not their tg-id), real
**cashback**, and **cash-out** — while staying abuse-safe (you can only withdraw
money that real invitees actually paid).

## The offer (user-facing)

- Персональная ссылка и приветственный бонус **≈$20** в токенах 🔫
- **15% кэшбэка** с каждой оплаты приглашённых пользователей
- Кэшбэк в токенах: тратьте в NeuroShot или **выводите деньгами раз в 2 недели**
- Без вложений — делитесь ссылкой и растите вместе с проектом
- До **10 персональных ссылок** на аккаунт

## How it works

1. **Join** (`/partner` → «Стать партнёром»): sets `partner_joined_at`, grants
   the one-time welcome bonus (`PARTNER_WELCOME`, default 180 🔫), and mints the
   first code. The welcome bonus is **spend-only** — never added to the
   withdrawable balance, so a farmed account can't cash it out.
2. **Share** `t.me/<bot>?start=p_<code>`. New users are attributed first-touch
   (immutable `users.partner_code`); they get `PARTNER_INVITEE_BONUS` (5 🔫).
3. **Earn**: when an invitee buys a pack, the partner gets `PARTNER_PERCENT`
   (15%) of the pack in 🔫 — credited to their balance **and** to
   `partner_withdrawable`.
4. **Withdraw** (`/partner` → «Вывести»): moves `withdrawable` 🔫 out of both
   balances into a `withdrawals` row (`pending`). Biweekly, min `WITHDRAW_MIN`
   (500 🔫), one pending request at a time. Admin processes with `/payouts` +
   `/payout <id> ok|no` (reject refunds the 🔫).

## Why it's abuse-safe

- **Only real cashback is withdrawable.** `partner_withdrawable` is incremented
  *only* by `rewardPartnerOnPurchase` for `kind='partner'` codes — i.e. funded by
  an invitee's actual Stars purchase. The welcome bonus, purchased, and free 🔫
  are spend-only. So a cash-out is always backed by revenue that already came in.
- The withdrawal request drains `credits` **and** `partner_withdrawable` in one
  atomic guarded statement (`WHERE partner_withdrawable >= amt AND credits >= amt`),
  so it can't be double-spent or drain non-earned credits.
- Codes are unforgeable random slugs (`crypto.randomBytes`, 6 chars); attribution
  is first-touch and exclusive (a buyer credits one code, never stacks).

## Two tiers, one table

`partner_codes.kind`:
- **`partner`** — self-serve, flat `PARTNER_PERCENT`, withdrawable cashback,
  ≤10 active per account, `p_<code>` deep link.
- **`creator`** — admin-negotiated deals (`/partner_add`), custom %, settled
  off-platform (not withdrawable), `c_<code>` deep link. Shown read-only atop
  the partner dashboard for owners.

## Commands

- `/partner` — dashboard: join / codes + per-code funnel / withdrawable / withdraw / manage.
- `/partner_add <code> <tg_id> <% 1–50> <bonus> [title]` — admin: mint a creator deal.
- `/payouts` · `/payout <id> ok|no` — admin: process cash-outs.

## Env

| Var | Default | Meaning |
|---|---|---|
| `PARTNER_PERCENT` | 0.15 | cashback share of invitee purchases |
| `PARTNER_WELCOME` | 180 | one-time join bonus 🔫 (spend-only, ≈$20) |
| `PARTNER_INVITEE_BONUS` | 5 | 🔫 the invited user gets |
| `PARTNER_MAX_CODES` | 10 | active codes per account |
| `WITHDRAW_MIN` | 500 | minimum withdrawable 🔫 to request a cash-out |

## Schema

- `partner_codes.kind` (`creator`|`partner`), `.active`
- `users.partner_joined_at`, `users.partner_withdrawable`
- `withdrawals(id, user_id, amount, status, requested_at, processed_at)`
- ledger reasons: `partner` (cashback), `partner_welcome`, `withdrawal`, `withdrawal_reject`
