# Payment compliance & accepted-risk stance

Where NeuroShot's money flow sits relative to Telegram's rules and Kazakhstan's
payment landscape, and the risk positions we're knowingly taking. Companion to
`docs/kaspi.md` (how payments work) and `docs/compliance.md` (AI-content law).

## What we actually do

- Patron packs are sold in **tenge via Kaspi**. Checkout hands the buyer an
  **external hosted Kaspi payment link** (`kaspiLinkFor`, `KASPI_PAY_URL[_<PACK>]`)
  — see `src/webapp.ts` `orderResponse` and `src/payments.ts`.
- We do **NOT** use Telegram's native payment flow: no `sendInvoice`, no
  pre-checkout handler, no **Telegram Stars (XTR)**. (Confirmed: no `sendInvoice`
  / `XTR` / provider-token code anywhere in `src/`.) Telegram is a distribution
  and delivery surface; the transaction happens on Kaspi's page.

## Risk 1 — Telegram Stars / digital-goods ToS

**The rule.** Telegram's bot-payments guidance requires digital goods and
services sold *inside* a bot/Mini App to be paid for with **Telegram Stars**;
this is tied to Apple/Google App Store Guideline 3.1.3(b), so enforcement is
strictest on iOS. Bots taking non-Stars payment for digital products have been
warned/suspended.

**Our exposure.** The narrow "you implemented Telegram invoices wrong" failure
mode **does not apply to us** — we never touch Telegram's native payment flow.
The genuinely open question is whether Telegram's Stars mandate reaches a sale
completed via an **external checkout link opened from a bot chat**. Research on
this was **unable to resolve it**: enforcement appears inconsistently applied to
external-link checkouts, and it's a policy-interpretation question, not a code
one.

**Economic driver.** Kaspi's merchant take is ~**0.95%**; Telegram Stars net
creators ~**70%** (the ~30% mobile-IAP tax passes through). Routing payment
through Kaspi is materially cheaper, which is the reason the external flow exists.

**Accepted-risk position.** For the Kazakhstan market we knowingly route payment
outside Telegram's native flow via Kaspi, accepting the residual
ToS-interpretation risk. Mitigations / revisit triggers:
- Keep checkout as an **external hosted link**, not `sendInvoice`/native invoices,
  so we're not misusing Telegram's payment API.
- **Monitor** for any Telegram warning on the bot; if enforcement lands, the
  fallback is to add a Telegram Stars purchase path (the pack catalog + grant
  path already exist — only the payment leg would change).
- Watch iOS specifically (strictest); the risk is lower for the Android/web-heavy
  KZ audience.

## Risk 2 — KZ unified interbank QR (from 2026-07-19)

Kazakhstan's mandatory unified interbank QR system goes live **2026-07-19**. Its
relevance to NeuroShot's **hosted-payment-link** flow (vs. in-person QR scanning)
is **asserted, not established** — our flow is a redirect to a Kaspi checkout
page, which likely is unaffected. **Action:** confirm with Kaspi merchant support
before the date that hosted `pay.kaspi.kz` links keep working post-mandate; no
code change is anticipated.

## Risk 3 — AI-content disclosure ToS clause (completes `docs/compliance.md`)

KZ Law No. 230-VIII (Art. 21) requires AI-generated output to carry an on-asset
mark **and** a machine-readable marking — both now shipped (the "AI Generated"
badge + metadata, see `docs/compliance.md`). The law does not require a ToS
clause, but a policy disclosure **reinforces** the on-asset mark and documents our
compliance posture. **Drafted** in `docs/legal/terms-of-service.md` §9 — the
clause there (below) plus the full ToS/privacy/refund set still needs a
lawyer's review + placeholders filled in before publishing. **The user
agreement / privacy policy should state:**

> Изображения и видео, создаваемые в NeuroShot, генерируются искусственным
> интеллектом и маркируются как «AI Generated» (визуальная отметка на файле и
> метаданные), в соответствии с законодательством Республики Казахстан.

This clause **does not replace** the on-asset marking (the statute ties the
warning to the distributed output); it sits alongside it.

## Summary of positions

| Risk | Stance | Revisit trigger |
|---|---|---|
| Telegram Stars ToS on external Kaspi link | Accept; keep external link, monitor enforcement, Stars path as fallback | Any Telegram warning/suspension, esp. iOS |
| Unified interbank QR (2026-07-19) | Likely unaffected (hosted link) | Confirm with Kaspi support before go-live |
| AI-content disclosure | On-asset mark shipped; add ToS clause | New implementing decree tightening format |
