# Prompt craft — the director's rules for every curated prompt

Every curated prompt in `src/models.ts` (presets, campaign scenes, free
scenarios, quiz fragments) is written to one house style, distilled from
Higgsfield's prompt-engineering guide and applied with a director's eye so a
**one-shot render ships without re-rolls**. When you add or edit a prompt,
follow these rules — they are the reason results stopped being "sometimes
awful".

## The rules

1. **Persona is the hero, always.** The real person/child stays foreground,
   centered, face sharp and well lit (`KID_FOCUS`), and their identity is
   locked (`KEEP_ID` / `KEEP_KID`). Any famous "cast" member stands *beside and
   behind* — never competing for the frame.

2. **Image edits describe the CHANGE, not the input.** The models already have
   the uploaded face; the prompt paints the new world (scene, wardrobe, light),
   not the person's existing features. Redescribing the subject fights identity.

3. **Video prompts describe MOTION — one clean beat.** The still frame is the
   start image; the prompt is the *shot*: `[camera move] → [one action with a
   beginning-middle-payoff] → [environment motion] → [mood]`. One continuous
   beat that lands on a shareable money-shot. Never redescribe the static frame.

4. **Camera is the narrator.** Every motion prompt names exactly one deliberate
   move — slow push-in, heroic orbit, tracking sweep, locked-off — not a soup of
   moves that the model averages into mush.

5. **Positive phrasing only.** "one single instance" / "exactly once" / "tack-
   sharp face" — never "don't duplicate" / "no blur". Most fal models expose no
   negative prompt; negatives read as *subjects*.

6. **Keep it tight (< ~200 tokens).** Long, conflicting prompts distort. Say the
   scene, the light, the beat, the identity guard — then stop.

7. **Don't ask a model for text it can't render.** Seedream/Hailuo garble
   legible titles, so posters use *"clean negative space for a title"* instead
   of *"bold title typography"*. Route genuine on-image text to GPT-Image-2.

8. **Avoid heavy filters that eat the face.** A gentle grade is fine; teal-orange
   + haze is not — it washes out the identity the whole product sells.

9. **Real public figures & trademarked characters are IP-risk.** The World Cup
   stars and cartoon characters are kept *at the user's explicit request* for
   personal family images; providers may still refuse them (`ip_detected`), and
   the pipeline fails-and-refunds automatically when they do.

## Shared guards (single source of truth)

`KEEP_ID`, `KEEP_KID`, `KID_FOCUS`, `NO_CLONES` are declared once above
`PRESETS` and reused everywhere. Edit the constant, not the copies.

## Model levers (beyond prompts)

Prompts are one lever; the model is the bigger one. For face-anchored scene
edits the quality ladder is `seedream_edit (v4)` → **Seedream 4.5 edit** →
**Nano Banana Pro edit**, and true identity fidelity is a trained face model
(Higgsfield Soul-ID / a fal LoRA) — the proper fix when a preset keeps losing
the face. Those are tracked separately from this prompt pass.
