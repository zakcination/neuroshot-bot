# «Быстрый старт» — что мешает продавать

> Результат прогона команды из 10 ролей, 2026-07-26. Каждое утверждение о продукте
> перепроверено против кода вручную.

## What stops the $9 «Быстрый старт» from being sold on Monday

Nine genuine blockers. Everything else in the ten submissions is a quality problem, not a gate.

---

### 1. Nobody can pay. — OWNER
`.env` contains only `BOT_TOKEN, FAL_KEY, DATABASE_PATH, FREE_CREDITS, ADMIN_IDS`. `KASPI_PAY_URL` is therefore `""` (`/home/user/neuroshot-bot/src/config.ts:52`), and `buy:course_fast` short-circuits to *«💳 Оплата картой Kaspi скоро откроется»* (`/home/user/neuroshot-bot/src/payments.ts:325-332`). No order is even created.
**Clears it:** owner sets `KASPI_PAY_URL` (or `KASPI_PAY_URL_COURSE_FAST`) to a live merchant link.
**Second half nobody costed:** `KASPI_API_SECRET` is also unset, so the callback route is disabled and every «✅ Я оплатил» falls back to an admin ping requiring a manual `/order N ok`. Selling Monday means someone is on call to approve payments by hand, or purchases sit uncredited. Owner decision, not an engineering one.

### 2. Nothing is delivered after payment. — OWNER (+ 1 line from ENGINEER)
`COURSE_FAST_CHANNEL_ID` is unset (`config.ts:145`). `inviteToCourseCohort` then sends *«ссылку … пришлём в течение дня»* and returns — the purchase succeeds with no access (`/home/user/neuroshot-bot/src/payments.ts:123-142`). `/course_post fast 1` refuses to run at all (`/home/user/neuroshot-bot/src/bot.ts:926-933`).
**Clears it:** owner creates the private channel **with a linked discussion group**, makes the bot admin with invite rights, sets the env var. The discussion group is not optional — all five packaged lessons submit homework as albums + screenshots, and all five left `{{ССЫЛКА НА ЧАТ КОГОРТЫ}}` unresolved. A bare channel means zero of the five homeworks can be submitted.
**Engineer:** `courseText()` promises *«доступ к каналу открывается автоматически сразу после оплаты»* (`bot.ts:170-171`) — a pre-payment statement the fallback path contradicts. Either the channel exists before you sell, or that line says «в течение 24 часов».

### 3. `/course_post` publishes a different, wrong course than the one that was packaged. — ENGINEER
`fastStartLessonMessages` (`bot.ts:270-380`) is still the stale text and is what the command actually sends. Verified still present today: L1 step 1 = «🖼 Редактирование фото» (no such button) and «10–20 секунд» (no SLA anywhere); L2 homework = «снимите 11–12 фото … ⬜️ Белый фон и 🛍 Продающая карточка» = 143 🔫 against 60 included; L3 = «5-секундным видео» (hailuo default is 6) plus the paywall-mechanics lesson; L4 = «Под любым результатом фото — кнопка 🎬 Оживить в видео», which `afterKeyboard` only attaches for campaign renders (`/home/user/neuroshot-bot/src/generate.ts:300-302`, `animate` passed only at `bot.ts:1870`).
The five packagers rewrote all of this correctly — **into chat messages, not into the codebase.** Nobody landed the copy. Until `fastStartLessonMessages` is replaced (and `docs/course/01-fast-start.md` regenerated or marked non-canonical), publishing is either a manual copy-paste operation or it ships the broken version.

### 4. The pre-payment budget claim is false. — OWNER decision, ENGINEER edit
`bot.ts:165` sells «60 🔫 внутри (с запасом на весь курс)» on the screen shown *before* the buy button. Against the shipped homework the arc costs ~143 🔫 in Lesson 2 alone. This is the claim most likely to produce a refund demand, and it is made pre-contract by the seller.
**Clears it:** ship the repackaged homeworks (total 45 🔫, leaving 15 🔫 for retries) *and* the claim becomes true — the fix is blocker 3. If blocker 3 slips, delete the words «с запасом на весь курс» from `bot.ts:165` and from `01-fast-start.md:4-5` before Monday.

### 5. No licence for the source material. — OWNER, then LAWYER
`docs/course/README.md:25-42` records that the curriculum spine, three prompt templates, the Instagram growth formula (**"close to verbatim"**) and the 7-day playbook come from Seymur Ragimov's paid «Нейро-Карьера» master group export. There is no licence, permission, or clearance anywhere in the repo, and a revenue-share («mentor co-brand», `docs/course-funnel.md:17`) is not a content licence.
**This is the failure this pass exists to catch.** Legal called it the largest IP exposure. The curriculum auditor logged it as "cannot verify from the repo" and moved on. And the Lesson 5 packager then reproduced the derived material — the 5-in-description / 25-in-comments split, the 10/10/10 breakdown, the profile-packaging checklist — as finished sale copy, without flagging provenance. Four roles touched this material; one treated it as a gate.
**Clears it:** owner obtains written permission before publishing; lawyer reviews scope (derivative course sold commercially).

### 6. Pre-payment promises with no implementation. — OWNER
- **Сертификат** appears on the `/course` overview screen itself (`bot.ts:168`), i.e. before payment, and again at `bot.ts:374, 473`. `grep -i certificate src/` returns nothing. The Lesson-5 packager quietly omitted it from their post — that does not fix the buy screen.
- **«цена $9 засчитывается»** (`docs/course/02-flagship.md:4`, `docs/course-funnel.md:40`). No upgrade, coupon, or credit path exists in `grantPurchase`. A Fast Start buyer pays the full 25 000 ₸.
**Clears it:** delete both claims from customer-facing surfaces Monday, or implement them. Deleting is a 10-minute edit.

### 7. A bot-only buyer has no route to seller identity, refund terms, or support. — ENGINEER (+ OWNER sign-off)
There is no `/terms`, `/privacy`, or `/refund` command (verified against the full `bot.command(...)` list). The documents are served only from the Mini App «Ещё» tab — and `WEBAPP_URL` is also unset in `.env`, so today those documents are reachable by nobody at all. The buy screen shows pack title, price, Kaspi link, order number (`payments.ts:335-341`). Nothing else.
**Raised only by legal; silently dropped by all nine other roles.**
**Clears it:** add the three commands and a footer link line in `courseText()`; state seller (ИП Z8 Capital, БИН 030722500509), what is delivered and when, refund terms, and `komekforyou@gmail.com` on the screen that precedes payment.

### 8. The refund policy does not cover a course. — LAWYER, then OWNER
`grep -i "курс\|course" docs/legal/refund-policy.md` returns **zero hits**. The policy is written entirely around patron packs: refund within 14 days while patrons are unspent. Read literally, a buyer joins the cohort, reads all five lessons, spends no patrons, and refunds in full — and is never warned that consuming content might forfeit that right.
**Clears it:** counsel drafts the digital-content clause (consumption/immediate-delivery consent under KZ consumer law); owner publishes it and links it from blocker 7's screen. The file's own header already flags it as unreviewed by counsel.

### 9. `WEBAPP_URL` unset kills the only working path in Lessons 4 and 5. — OWNER
Under a preset result there is no animate button, so «оживите карточку из Урока 2» has exactly two routes: the studio («Мои работы» → 🎬 Оживить в видео) or save-to-gallery-and-re-upload. The Lesson 4 packager built Path A on the studio and Lesson 5's entire «Маршрут по кнопкам» retrieves assets from it. With `WEBAPP_URL` blank, `/app` answers «Приложение скоро откроется», the «🌐 Открыть студию» row disappears (`bot.ts:150`, `generate.ts:308`), and both lessons lose their primary route.
**Clears it:** owner confirms the Mini App is deployed and sets `WEBAPP_URL`, **or** engineer passes `animate` on preset renders (`bot.ts:2104-2108`) so the button exists in chat — which would also delete half of Lesson 4's copy. Either is fine; leaving it undecided is not, because the two lessons are written for opposite answers.

---

### Raised by one role, dropped by the others — and correctly *not* blockers

- **Cartoon/celebrity IP and the ToS deepfake contradiction** (`terms-of-service.md:99` vs the Месси/Роналду/SpongeBob presets at `models.ts:1388-1470`). Legal verified the Fast Start lessons name no third-party character — this blocks the **flagship** (Module 3 teaches reselling output), not Monday's $9 tier. Close `README.md:91-92` as a standing rule, don't hold the launch on it.
- **AI-disclosure on course assets.** `/course_post` sends text only (`bot.ts:929-932`), so nothing synthetic is distributed yet. Becomes live the day a lesson carries an example image or a promo banner ships.
- **Combo offer undercutting the course** (1 000 ₸ / 36 🔫 = 28 ₸/🔫 vs the 62 ₸/🔫 a course buyer just paid, `payments.ts:48-56`). Raised by the funnel auditor, dropped by everyone. Real damage to the price-parity pitch; not a gate.
- **Free-guide errors** — «$9» at `00-free-guide.md:149`, «3 🔫» instead of 4, and the `?start=c_guide` partner code that may not exist in `partner_codes`. Blockers only if the guide publishes Monday; if it does, they are owner-level and cheap.

**Shortest honest path to Monday:** owner clears 1, 2, 5, 6, 9 (all config, permission, or copy deletion); engineer clears 3, 4, 7 in one pass over `bot.ts`; 8 goes to counsel and gates nothing if 6 and 7 are done and the refund terms are stated plainly on the buy screen in the meantime.