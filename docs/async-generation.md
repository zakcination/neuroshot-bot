# Async generation & concurrency

Renders (fal.ai calls) take 1–3 minutes. grammY's `bot.start()` long polling
processes updates **sequentially**, so awaiting a render inside a handler froze
the whole bot — no other command (from any user) could run until it finished.
This is fixed by **detaching the render**, with the money/state correctness
worked out and adversarially verified before implementation (a design workflow
ran 3 skeptics against it; the final design below closes all three holes they
found).

## Shape: prologue (sync) + tail (detached)

`runGeneration` / `runFreeScenario` split into:

- **Prologue** — runs on the update loop, returns in milliseconds. It commits
  every money/state decision here, where grammY's sequential dispatch keeps it
  totally ordered (no interleaving): charge (`spendCredits`) or **atomically
  claim** the freebie (`consumeFreeResult` / `consumeFreeScenario`) up front,
  set `pending_file_id`, insert a `pending` generations row, send the progress
  message, then detach and return.
- **Tail** — a detached `void (async () => {…})()` (tracked in a `Set`). It runs
  the provider call, watermarks, delivers via `ctx.api.sendPhoto/sendVideo(chatId,
  …)`, then finalizes. Because it's off the loop, the next update dequeues
  immediately — the user can keep sending commands while a render runs.

We deliberately **do not** add `@grammyjs/runner` / `sequentialize`: the freeze
was self-inflicted inline awaits, not a throughput limit. Keeping sequential
dispatch is a feature — it serializes every prologue for free, so there's no need
for a per-user mutex.

## Correctness properties (and how they're guaranteed)

- **Never reuse a generated output as the next input (bug #1).** `pending_file_id`
  is an invariant: it only ever holds an uploaded Telegram `file_id`, never a
  generated `https` URL. Result continuations (the campaign "оживить" upsell)
  reference the result by **generation id** on the delivered keyboard
  (`camv:<camp>:<genId>` → `getGeneration`), not by stashing its URL in pending.
  New top-level flows (photoshoot / product / campaign / animate) always ask for
  a fresh photo; the just-uploaded convenience lives in `pick:*`, deliberate reuse
  in `menu:styles`. The tail never writes pending, so there's no tail↔handler race.
- **Exactly-once spend + refund.** `spendCredits` is one guarded UPDATE. The tail
  compensates only if it never delivered **and** it wins `completeGeneration`'s
  `pending→error` compare-and-set — so a transient DB error *after* a successful
  send can't refund a delivered render, and nothing double-refunds.
- **Exactly-once free consume.** The freebie is claimed atomically in the prologue
  (before any provider call) across all transports; a failed render calls
  `restoreFree*` (idempotent) so the gift survives to be retried.
- **Durability (reaper).** Detaching means the update is acked before the render
  finishes, so a process recycle mid-render would otherwise charge with no result
  and no refund. The reaper (`monitor.runReaper`, every 5 min) fails any
  generation stuck `pending` beyond `GEN_STALE_MINUTES` via the same atomic CAS
  and refunds it — so the reaper and a late-recovering tail can never both
  compensate one row. On `SIGTERM`/`SIGINT`, `index.ts` stops polling and
  `drainRenders()` lets in-flight tails finish first.

## Tunables

- `GEN_STALE_MINUTES` (15) — reaper threshold.
- The reaper runs on the existing `monitor.ts` tick; no separate process.
