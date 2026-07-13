#!/usr/bin/env node
/**
 * Guard: the patron currency mark (🔫) must never be hard-coded in user-facing
 * strings. It lives in exactly two definitions — `UNIT_EMOJI` (src/text.ts) for
 * the bot and `PATRON` (public/app.html) for the Mini App — so the symbol can be
 * rebranded in one line. This check fails CI if a raw 🔫 sneaks back in anywhere
 * else, which would silently break that single-source-of-truth.
 *
 * Rules:
 *   • src/**\/*.ts  — a raw 🔫 is allowed ONLY inside a comment (domain shorthand
 *     in docs is fine); flagged in any code/string/template context. src/text.ts
 *     (the canonical definition) is exempt.
 *   • public/app.html — no raw 🔫 at all; the definition uses a \u escape, and
 *     everything else must interpolate ${PATRON}.
 *
 * Pure static scan, no deps. Exit 1 (with a fix hint) on any violation.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GUN = "\u{1F52B}";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Walk a JS/TS source, returning the line numbers where 🔫 appears OUTSIDE a
 *  comment (i.e. in code, or in a "/'/` string literal). Handles line/block
 *  comments, all three string kinds, escapes, and ${} template nesting. */
function nonCommentGunLines(src) {
  const stack = [];
  let state = "code"; // code | line | block | sq | dq | tpl
  let line = 1;
  const hits = [];
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "\n") line++;
    if (state === "code") {
      if (c === "/" && c2 === "/") { state = "line"; i += 2; continue; }
      if (c === "/" && c2 === "*") { state = "block"; i += 2; continue; }
      if (c === "'") { state = "sq"; i++; continue; }
      if (c === '"') { state = "dq"; i++; continue; }
      if (c === "`") { state = "tpl"; i++; continue; }
      if (c === "}" && stack.length) { state = stack.pop(); i++; continue; }
      if (src.startsWith(GUN, i)) { hits.push(line); i += GUN.length; continue; }
      i++; continue;
    }
    if (state === "line") { if (c === "\n") state = "code"; i++; continue; }
    if (state === "block") { if (c === "*" && c2 === "/") { state = "code"; i += 2; continue; } i++; continue; }
    if (state === "sq" || state === "dq") {
      const q = state === "sq" ? "'" : '"';
      if (c === "\\") { i += 2; continue; }
      if (c === q) { state = "code"; i++; continue; }
      if (src.startsWith(GUN, i)) { hits.push(line); i += GUN.length; continue; }
      i++; continue;
    }
    // tpl
    if (c === "\\") { i += 2; continue; }
    if (c === "`") { state = "code"; i++; continue; }
    if (c === "$" && c2 === "{") { stack.push("tpl"); state = "code"; i += 2; continue; }
    if (src.startsWith(GUN, i)) { hits.push(line); i += GUN.length; continue; }
    i++;
  }
  return hits;
}

/** Every literal 🔫 line in a file (used for app.html, where none are allowed). */
function allGunLines(src) {
  const lines = [];
  src.split("\n").forEach((l, n) => { if (l.includes(GUN)) lines.push(n + 1); });
  return lines;
}

function tsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

const violations = [];

for (const f of tsFiles(join(ROOT, "src"))) {
  if (f.endsWith(join("src", "text.ts"))) continue; // canonical UNIT_EMOJI home
  const hits = nonCommentGunLines(readFileSync(f, "utf8"));
  for (const line of hits) violations.push({ f: f.slice(ROOT.length), line, use: "UNIT_EMOJI" });
}

const html = join(ROOT, "public", "app.html");
for (const line of allGunLines(readFileSync(html, "utf8"))) {
  violations.push({ f: "public/app.html", line, use: "${PATRON}" });
}

if (violations.length) {
  console.error("✗ Raw patron emoji (🔫) found outside its single-source definition:\n");
  for (const v of violations) console.error(`  ${v.f}:${v.line}  → use ${v.use} instead`);
  console.error(
    "\nThe patron mark is defined once (UNIT_EMOJI in src/text.ts, PATRON in " +
      "public/app.html). Interpolate it instead of hard-coding the emoji so the " +
      "symbol stays swappable in one line. (Comments in .ts may use 🔫 freely.)",
  );
  process.exit(1);
}

console.log("✓ No stray patron-emoji literals — currency mark is centralized.");
