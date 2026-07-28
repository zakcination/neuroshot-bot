# Partner program v2 — codes, tiered cashback, withdrawals

Gives a partner **unique codes** (not their tg-id), real **cashback**, and
**cash-out** — while staying abuse-safe (you can only withdraw money that real
invitees actually paid).

Enrolment is **by invitation**: an admin runs `/partner_grant`. There is no
self-serve join, and no button anywhere grants the welcome bonus to whoever taps
it.

## The offer (user-facing)

- Персональная ссылка и приветственный бонус в токенах 🔫
- Кэшбэк с каждой оплаты приглашённых — **от 10%, и растёт с оборотом до 20%**
- Кэшбэк в токенах: тратьте в NeuroShot или **выводите деньгами раз в 2 недели**
- Без вложений — делитесь ссылкой и растите вместе с проектом
- До **10 персональных ссылок** на аккаунт

## The ladder (`PARTNER_TIERS`, src/models.ts)

| lifetime attributed revenue | cashback |
|---|---|
| from 0 ₸ | `PARTNER_PERCENT` (10%) |
| from 100 000 ₸ | 12% |
| from 300 000 ₸ | 15% |
| from 1 000 000 ₸ | 20% |

Why a ladder rather than a flat rate: a flat rate pays the same share to a
partner who brought one buyer as to one who brought a hundred — too expensive at
the bottom, and not competitive at the top, where the people who actually move
volume can get better terms elsewhere. The ladder moves that money from the
bottom to the top; the ceiling went **up** (15% → 20%) while the average cost
went down.

Three rules make it safe to change the base:

1. **Volume is money that landed.** Only orders with `granted_at` set count, and
   only through the owner's own `kind='partner'` codes. Invites and clicks move
   nothing.
2. **Nobody's terms get worse.** `partner_codes.percent` is a floor: the
   effective rate is `max(base, tier reached, stored percent)`, resolved per
   owner at PAYOUT time (`partnerRateFor`). Lowering `PARTNER_PERCENT` cannot
   reach back into an existing partner, and minting a fresh link cannot move one
   onto worse terms than their older links.
3. **Creator deals are outside it.** `kind='creator'` codes are paid at exactly
   the negotiated percent — the ladder never moves them, in either direction.

The order that crosses a threshold is itself paid at the new rate (it is already
granted when the payout runs). That is the direction to be generous in.

## How it works

1. **Enrol** (admin `/partner_grant <tg_id>`): sets `partner_joined_at`, grants
   the one-time welcome bonus (`PARTNER_WELCOME`, default 60 🔫), and mints the
   first code. The welcome bonus is **spend-only** — never added to the
   withdrawable balance, so a farmed account can't cash it out. It is paid
   before a single invitee exists, which is the moment we know least about
   whether the partner will work out — hence small, with the money moved into
   the volume rungs instead.
2. **Share** `t.me/<bot>?start=p_<code>`. New users are attributed first-touch
   (immutable `users.partner_code`); they get `PARTNER_INVITEE_BONUS` (5 🔫).
3. **Earn**: when an invitee buys a pack, the partner gets their current ladder
   rate of the pack in 🔫 — credited to their balance **and** to
   `partner_withdrawable`. The payout message names the rate that was applied.
4. **Withdraw** (`/partner` → «Вывести»): moves `withdrawable` 🔫 out of both
   balances into a `withdrawals` row (`pending`). Biweekly, min `WITHDRAW_MIN`
   (500 🔫), one pending request at a time. Admin processes with `/payouts` +
   `/payout <id> ok|no` (reject refunds the 🔫).

## Why it's abuse-safe

- **Only real cashback is withdrawable.** `partner_withdrawable` is incremented
  *only* by `rewardPartnerOnPurchase` for `kind='partner'` codes — i.e. funded by
  an invitee's actual Kaspi purchase. The welcome bonus, purchased, and free 🔫
  are spend-only. So a cash-out is always backed by revenue that already came in.
- The withdrawal request drains `credits` **and** `partner_withdrawable` in one
  atomic guarded statement (`WHERE partner_withdrawable >= amt AND credits >= amt`),
  so it can't be double-spent or drain non-earned credits.
- Codes are unforgeable random slugs (`crypto.randomBytes`, 6 chars); attribution
  is first-touch and exclusive (a buyer credits one code, never stacks).

## Two tiers, one table

`partner_codes.kind`:
- **`partner`** — admin-enrolled, laddered rate (floor `PARTNER_PERCENT`),
  withdrawable cashback, ≤10 active per account, `p_<code>` deep link.
- **`creator`** — admin-negotiated deals (`/partner_add`), custom %, settled
  off-platform (not withdrawable), `c_<code>` deep link. Shown read-only atop
  the partner dashboard for owners.

## Commands

- `/partner` — dashboard: codes + per-code funnel / current rate + ₸ to the next
  rung / withdrawable / withdraw / manage. Non-partners see the pitch and how to
  apply, never a button that enrols them.
- `/partner_grant <tg_id> [code]` — admin: enrol a partner (the only way in).
  The optional slug mints a **vanity** code — a creator's own handle reads better
  in a bio than a random one — and it stays `kind='partner'`, so the ladder and the
  withdrawable cashback come with it. Do **not** reach for `/partner_add` to get a
  named code: that mints `kind='creator'`, which is a flat rate settled off-platform
  and **not** withdrawable. A slug already in use is refused rather than silently
  swapped for a random one.
- `/partner_add <code> <tg_id> <% 1–50> <bonus> [title]` — admin: mint a creator deal.
- `/payouts` · `/payout <id> ok|no` — admin: process cash-outs.

## Env

| Var | Default | Meaning |
|---|---|---|
| `PARTNER_PERCENT` | 0.10 | BASE cashback share; the floor under `PARTNER_TIERS` |
| `PARTNER_WELCOME` | 60 | one-time enrolment bonus 🔫 (spend-only) |
| `PARTNER_INVITEE_BONUS` | 5 | 🔫 the invited user gets |
| `PARTNER_MAX_CODES` | 10 | active codes per account |
| `WITHDRAW_MIN` | 500 | minimum withdrawable 🔫 to request a cash-out |

## Schema

- `partner_codes.kind` (`creator`|`partner`), `.active`
- `users.partner_joined_at`, `users.partner_withdrawable`
- `withdrawals(id, user_id, amount, status, requested_at, processed_at)`
- ledger reasons: `partner` (cashback), `partner_welcome`, `withdrawal`, `withdrawal_reject`
