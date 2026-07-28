# Creator partnerships — the end-to-end playbook

The repeatable process for bringing a content creator into the partner program:
outreach → offer → agreement → enrolment → content → tracking → payouts →
renewal. Written so the **second** creator costs a fraction of the first — every
step names its owner, its tool, and its template.

This doc deliberately contains **no negotiated numbers**. Per-creator terms
(grant sizes, tranche amounts, timelines) are confidential commercial data and
live in the signed agreement and the owner's private files — never in this repo,
which is heading toward open source. What lives here is the *structure* every
deal reuses.

Related docs:
- `docs/partner-program.md` — the program mechanics (ladder, withdrawals, schema)
- `docs/creator-program.md` — deal structures & economics guardrails for
  `kind='creator'` (flat-%) deals
- `docs/compliance.md` / `docs/watermark.md` — the AI-disclosure requirement

---

## The pipeline at a glance

| # | Stage | Owner | Tool | Exit criterion |
|---|---|---|---|---|
| 1 | Select & reach out | owner | DM template A | creator replies with interest |
| 2 | Offer | owner | offer template (private) | terms agreed in writing |
| 3 | Agreement | owner (+lawyer) | contract template (private) | signed by both sides |
| 4 | Enrol | admin | `/partner_grant @handle <code>` | code live, creator sees `/partner` |
| 5 | Instruct | owner | instruction template B | creator confirms link placement |
| 6 | Content | creator + owner | brand kit | post is live and compliant |
| 7 | Track | both | `/partner` (creator), `/ref_math` (admin) | — ongoing |
| 8 | Pay out | admin | `/payouts`, `/payout <id> ok` | biweekly, zero pending |
| 9 | Renew / close | owner | ladder stats | next campaign, or code deactivated |

**Rule zero: enrol only after signature.** There is no clawback in the code — a
granted welcome bonus and a live code cannot be taken back, only the code
deactivated going forward. The grant IS the payment; payments come after
contracts.

---

## 1. Selection & outreach

What converts is not follower count but **audience-product fit**: creators whose
audience already makes content about themselves (beauty, family, lifestyle,
marketplace sellers) and whose engagement is comment-shaped, not view-shaped.

Minimum bar before reaching out:
- actively posting (≥3 posts/reels in the last 2 weeks);
- comments in Kazakh or Russian from real accounts;
- no current promo for a competing GenAI service.

First message: short, personal, references a specific post of theirs, one
sentence on what NeuroShot does, and asks only for interest — no terms in the
first DM. Terms discussed in DM before a contract exists are terms you can no
longer change.

## 2. The offer

Every creator offer is assembled from the same blocks; only the numbers change
(and the numbers stay out of this repo):

1. **Production grant** — patrons issued up front to make the content with.
   Sized from real recipes (see `docs/cost-line.md`): enough for the deliverable
   plus retries, not a round number picked for its looks.
2. **Publication tranches** — the remainder of the grant split across
   checkpoints the creator controls: on publish, and after a hold period
   (e.g. +7 days with the post still up). This is the schedule that makes the
   "don't delete it next morning" clause enforceable without lawyers.
3. **Partner enrolment** — the standing income: the standard laddered partner
   terms, *unchanged* (see below). The grant is the fee for the content; the
   partnership is why the link stays in the bio after the campaign ends.
4. **Content rights** — co-authorship, our right to repost/run ads with
   attribution, their right to unlimited own use.
5. **Confidentiality** — neither side discloses the terms.

When stating the grant's ₸ equivalent, quote the honest **range** across the
ladder (a big pack's rate and a small pack's rate differ) — a single number
picked from the most expensive rung overstates the gift and reads as such the
moment the creator opens the pay screen.

**Terms that are NOT negotiable per-creator:**

- **The partner percent and ladder.** Every cash-paying creator is on the same
  `PARTNER_PERCENT` + `PARTNER_TIERS` ladder as everyone else. A bespoke percent
  means `/partner_add` (`kind='creator'`), which is settled off-platform and not
  withdrawable — different machinery, different promises, and a bookkeeping
  burden that does not scale. One program, one ladder.
- **The AI-disclosure watermark.** Legally mandated on every delivery
  (`docs/watermark.md`); it is never a removable perk, never part of a deal.
- **Patron prices.** A creator discount is a distinct pack with its own Kaspi
  link, decided by the owner globally — not a per-deal knob.

## 3. Agreement

The contract template is private (not in this repo). Checklist of what it must
cover, so nothing is re-litigated per deal:

- [ ] parties (we contract with the creator as a physical person unless told
      otherwise), subject, term;
- [ ] deliverables: content types, platforms, link placement, hold period;
- [ ] the grant: total, tranche schedule, and what each tranche is conditioned on;
- [ ] partner terms **by reference to the program** («по действующим условиям
      партнёрской программы, от N%») — не фиксируйте в договоре число, которое
      обгонит лестница;
- [ ] payout mechanics for cashback withdrawals (rate: по тарифу пакета, с
      которого начислен кэшбэк);
- [ ] content rights: co-authorship, repost/ads with attribution, their
      unlimited own use;
- [ ] confidentiality of terms;
- [ ] ⚠️ **taxes** — in-kind income to a physical person + cash cashback; open
      item, needs an accountant's sign-off once, then the clause is reused;
- [ ] termination: what happens to the code (deactivation, not retroactive
      clawback) and to already-earned cashback (it stays earned).

## 4. Enrolment — one ask of the creator, two commands from us

The creator does exactly one thing: **opens the bot and taps Start.**
Send them `t.me/<bot>` — a plain link, not somebody's referral link (first-touch
attribution is immutable; joining through another partner's link would credit
that partner with every purchase this creator ever makes).

Then, admin:

```
/partner_grant @их_хендл их_код
/partner            ← as the creator, to verify (or ask them for a screenshot)
```

- `@username` resolution works because the bot stores and refreshes handles on
  every interaction; if the handle isn't found (creator has no @username, or
  just started seconds ago under a different spelling), the fallback is the
  numeric id — the creator sends `/id` and forwards the number.
- **Vanity code convention:** their public handle + a short campaign
  discriminator, `[a-z0-9_]`, 2–32 chars — e.g. `<handle><MM>` for the launch
  month. One code per campaign, so per-campaign stats come free in `/partner`.
  A taken slug is refused, never silently swapped.
- `/partner_grant` mints `kind='partner'`: laddered rate, withdrawable cashback.
  **Never use `/partner_add` for a cash-paying creator** — it mints
  `kind='creator'`: flat rate, settled off-platform, NOT withdrawable. The two
  look identical in a bio and behave nothing alike at payout.
- Enrolment grants the one-time `PARTNER_WELCOME` (spend-only) and DMs the
  creator that their cabinet is live.
- The production-grant patrons are issued separately per the contract schedule —
  `/grant @их_хендл <n>` per tranche — the welcome bonus is not the grant.

## 5. The instruction (what the creator receives)

Template B — personalize the placeholders, send in the creator's language.
Personalized copies live outside the repo.

> Ссылка: `https://t.me/<bot>?start=p_<код>`
>
> 1. Разместите ссылку в описании профиля и/или под публикацией.
> 2. Каждый, кто придёт по ней, получит приветственный бонус — а вам идёт
>    кэшбэк с **каждой** его оплаты, бессрочно. Ставка растёт с оборотом
>    автоматически.
> 3. Ваш кабинет — команда `/partner` в боте: переходы, покупки, начисления и
>    текущая ставка, в реальном времени.
> 4. Вывод денег — там же, кнопка «Вывести»: от 500 🔫, раз в две недели, на
>    Kaspi.
> 5. Патроны по договору начисляются на этот же аккаунт — баланс виден в боте
>    и в приложении.
>
> Важно: кэшбэк засчитывается за **новых** пользователей, пришедших по вашей
> ссылке. Если человек уже пользовался ботом раньше, его покупки не
> атрибутируются — так работает первое касание.

That last paragraph is not fine print — creators discover attribution rules by
asking «мой подписчик перешёл, а у меня пусто», and the honest answer up front
costs nothing.

## 6. Content & compliance

- Every asset the creator publishes keeps the **AI-disclosure badge** — this is
  the law (KZ 230-VIII, ст. 21), not brand preference, and it is on every
  delivery automatically. A deal cannot waive it.
- We review the draft before publish only for factual claims about the product
  (prices, what's included) — creative control is theirs; wrong prices in a
  reel are ours to prevent.
- Reposts and ads on our side carry their attribution, per the contract.

## 7. Tracking

| Who | Where | What |
|---|---|---|
| creator | `/partner` (bot) or the Mini App partner section | per-code: joined → paying → earned, current rate, ₸ to the next rung |
| admin | `/ref_math` | per-partner: brought revenue, accrued, owed, paid out |
| admin | `/dash`, `/funnel` | acquisition by source (`c_`/`p_` codes are sources) |

The numbers both sides see come from the same tables — there is no separate
"creator report" to compile, which is precisely what makes this scale.

## 8. Payouts

Biweekly cadence, driven by the creator from `/partner` («Вывести», min
`WITHDRAW_MIN`), processed by admin:

```
/payouts            ← list pending withdrawal requests
/payout <id> ok     ← after the Kaspi transfer is actually sent
/payout <id> no     ← reject (refunds the 🔫 back to the balance)
```

Transfer to the creator's Kaspi by phone number, at the contract's stated rate.
Confirm in the bot only **after** the money moved — `ok` is a record of a
payment, not an intention.

## 9. Renewal & close

- **Renew** when a campaign's code shows real volume: the ladder itself is the
  renewal argument («вы в 40 000 ₸ от следующей ставки»). New campaign → new
  vanity code, same account, stats stay separable.
- **Close** by deactivating the code (`/partner` → управление ссылками, or
  admin-side). Deactivation stops NEW attribution; already-attributed users and
  already-earned cashback are untouched — the contract's termination clause
  must say the same thing the code does.

---

## Scaling checklist (per new creator, after the first)

- [ ] outreach DM (template A, personalized)
- [ ] offer from the standard blocks — only sizes change
- [ ] contract from the template — only names, dates, sizes change
- [ ] signed → send plain bot link → creator taps Start
- [ ] `/partner_grant @handle <handle><MM>`
- [ ] issue the production tranche per contract
- [ ] send instruction (template B with their link)
- [ ] verify their `/partner` screenshot
- [ ] calendar: publication check, hold-period check, biweekly `/payouts`
