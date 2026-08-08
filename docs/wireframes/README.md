# Wireframes — the UI contract

A wireframe here is **the scope boundary for a screen**, not a sketch. If a block
is on the screen in `public/app.html` and not in the current wireframe, one of
the two is wrong — and it's usually the code.

These were living in an ephemeral session scratchpad until 2 Aug, which is
exactly why the screens drifted: there was nothing durable to check against, so
"rebuild the promo banner" quietly became "add a second promo banner next to
the first one". They live in git now.

## Naming

```
docs/wireframes/<screen>.v<N>.html
```

- `<screen>` — the surface, not the feature: `home-studio`, `director-mode`,
  `tv-banner`. A screen keeps its name for life.
- `v<N>` — integer, bumped on every **approved** change. Never edit an approved
  file in place; copy it to `v<N+1>` and change that. Superseded versions stay
  in the repo — being able to trade back to "what did we agree in v1" is the
  whole point.

Published artifact titles mirror the filename so the claude.ai artifact list
sorts and reads the same way:

```
NeuroShot — <Screen> — v<N>
```

## Index

| Screen | Version | Status | Date | Artifact |
|---|---|---|---|---|
| `home-studio` | **v1** | superseded by v2 | 30 Jul 2026 | [костяк экранов](https://claude.ai/code/artifact/68737391-34c0-42dd-bd84-fab249f487f0) |
| `home-studio` | **v2** | superseded by v3 | 2 Aug 2026 | [Главная + Студия — v2](https://claude.ai/code/artifact/ebfe8e5b-e55f-468e-9c82-f6978975a2db) |
| `home-studio` | **v3** | current, shipped | 3 Aug 2026 | [Главная + Студия — v3](https://claude.ai/code/artifact/0266cf09-8969-44e3-8d28-9f6bff2859d6) |
| `director-mode` | **v1** | superseded by v2 | 1 Aug 2026 | [Режиссёрский режим](https://claude.ai/code/artifact/421907d2-ad0b-4fc9-96c0-23d8108606ea) |
| `director-mode` | **v2** | superseded by v3 | 3 Aug 2026 | [Режиссёрский режим — v2](https://claude.ai/code/artifact/e9b5deab-2ef0-4e6d-9d17-dfca5d158060) |
| `director-mode` | **v3** | current, shipped | 8 Aug 2026 | [Режиссёрский режим — v3](https://claude.ai/code/artifact/17ce4fb6-83cd-4161-8756-9b412bf953b9) |
| `director-mode` | **v4** | proposed, pending approval | 8 Aug 2026 | [Режиссёрский режим — v4](https://claude.ai/code/artifact/c34f9219-2b7c-4023-9e41-c4a4b88c3e18) |
| `tv-banner` | **v1** | current, shipped | 1 Aug 2026 | [ТВ-баннер](https://claude.ai/code/artifact/7cd6baaf-d296-4d22-8912-7a852beef573) |

Related, not wireframes: the [Director Mode
spec](https://claude.ai/code/artifact/3bcaf3c2-6a1e-4b02-9dd1-09dc0e9a46d7) and
the [competitor UX
analysis](https://claude.ai/code/artifact/5912b969-141b-4a46-b018-13b274a3ced2).

## The rule this exists to enforce

**"Rebuild" / "remake" / "переделать" means delete the old implementation in the
same commit.** Not deprecate it, not leave it behind a flag, not keep it "just in
case" — delete it. The old version is recoverable from git; a screen carrying
both versions at once is not recoverable from anything, it's just broken.

You should never have to say "and remove the old one" — that is what rebuild
already means.

Concretely, when a change lands:

1. The block it replaces is **gone from the markup** — and its CSS, its helper
   functions, its state fields and its handlers are gone with it. A stylesheet
   rule with no markup is the signature of a half-finished rebuild.
2. The wireframe is bumped to `v<N+1>` in the same PR. A screen change that
   isn't in a wireframe isn't approved yet.
3. Anything on the screen that is **not** in the current wireframe is cut. If
   it's worth keeping, it goes into the wireframe first.
4. A feature removed on purpose gets a paragraph in
   [`docs/graveyard.md`](../graveyard.md) — what it was, why it went, what
   replaced it. The *idea* stays recoverable without the *code* staying alive.

### Verifying a rebuild actually removed things

Dead CSS is the cheapest signal that a rebuild left litter:

```bash
npm run check:dead-css
```

It reports selectors defined in `<style>` that no markup, `classList` call or
`querySelector` ever references.
