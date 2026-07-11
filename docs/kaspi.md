# Kaspi payments (KZT)

NeuroShot sells 🔫 patron packs in tenge, paid via Kaspi. Crediting always runs
through one path — `grantPurchase` (`src/payments.ts`) — so patrons, referral
payouts and partner cashback are identical no matter how a payment was confirmed.

## The three ways an order gets confirmed

A buyer taps a pack → `createOrder` records a **pending** order → they pay on the
Kaspi page → the order is confirmed by **one** of:

1. **Admin approve (interim, always available).** `/order <id> ok` — an admin
   checks Kaspi and approves. Zero integration needed; this is the fallback the
   product ships with.
2. **«Я оплатил» server-side check (pull).** When the Kaspi merchant REST API is
   configured (`KASPI_API_BASE` + `KASPI_API_TOKEN`), the button *queries* the
   order's real status from Kaspi (`kaspiVerifyOrder`, `src/kaspi.ts`) and
   auto-grants if paid — no admin, no trust-the-button. If the API isn't
   configured it degrades to the admin ping above.
3. **Webhook (push).** When `KASPI_API_SECRET` is set, Kaspi POSTs
   `POST /api/kaspi/callback` on payment status change; we verify the HMAC-SHA256
   signature over the raw body, match the order + amount, and auto-grant. Fully
   hands-off. Disabled (404) until the secret is set, so it never exposes an
   unauthenticated grant path.

`resolveOrder` flips `pending → paid` atomically, so all three paths are
idempotent — a double-confirm (e.g. webhook *and* button) can never double-credit.

## Why a plain link can't auto-approve on its own

A plain `pay.kaspi.kz/pay/<token>` link is a hosted payment page. It gives our
server **no callback and no queryable status**, so it cannot be verified
server-side. Auto-approval (paths 2 and 3) needs a real **Kaspi Pay merchant
integration** (business account + API credentials) — that's what turns
«Я оплатил» from a trusted tap into a real check and lets the webhook fire.

## "Pre-filling the amount"

A plain link's amount can't be reliably set via a query string. The clean way to
show the correct amount per pack is **one fixed-amount Kaspi link per pack**: set
`KASPI_PAY_URL_COMBO`, `KASPI_PAY_URL_START`, … and each buy button opens the
correctly-priced page (`kaspiLinkFor`, `src/config.ts`). Any pack without its own
link falls back to `KASPI_PAY_URL`.

## Going live checklist

1. Set `KASPI_PAY_URL` (and optional per-pack links) → the buy flow is live on the
   admin-approve path immediately.
2. When the merchant API is provisioned, **confirm against Kaspi's live docs**:
   the status endpoint + auth for the pull check (`src/kaspi.ts` currently assumes
   `GET {base}/payments/{orderId}` with a Bearer token), and the callback's field
   names (`orderId` / `status` / `amount`) + signature scheme + header for the
   webhook (`kaspiCallbackResponse`, `src/webapp.ts`).
3. Set `KASPI_API_BASE`/`KASPI_API_TOKEN` and/or `KASPI_API_SECRET`. The manual
   step disappears automatically once either is confirmed working.
