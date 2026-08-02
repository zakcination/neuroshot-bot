#!/usr/bin/env node
/*
 * Dead-CSS check for public/app.html.
 *
 * A stylesheet rule whose class no markup ever uses is the signature of a
 * half-finished rebuild: the new block landed, the old one's markup went, and
 * its CSS stayed behind. That is precisely how the Home and Studio screens
 * ended up carrying two designs at once (docs/wireframes/README.md).
 *
 * The whole app is one file, so this can be honest rather than heuristic: every
 * class defined in <style>, minus every class referenced anywhere after it —
 * in markup, in template literals, in classList calls, in querySelector.
 *
 * Reports only. It never fails the build: a class can legitimately be built at
 * runtime (`"tier-" + name`), and a lint that cries wolf gets ignored. Add
 * those to DYNAMIC below so the report stays worth reading.
 */
import { readFileSync } from "node:fs";

const SRC = "public/app.html";
const html = readFileSync(SRC, "utf8");

const style = /<style>([\s\S]*?)<\/style>/.exec(html);
if (!style) {
  console.error(`✗ ${SRC}: no <style> block found`);
  process.exit(1);
}
const css = style[1];
const rest = html.slice(html.indexOf("</style>"));

// Classes DEFINED — selector positions only, so a class inside a comment or a
// url() doesn't count as a definition.
const defined = new Map(); // class -> first line number
const cssStart = html.slice(0, html.indexOf(css)).split("\n").length;
css.split("\n").forEach((line, i) => {
  // Ignore comment-only lines; they explain rules, they don't declare them.
  if (/^\s*(\/\*|\*)/.test(line)) return;
  const selector = line.split("{")[0];
  for (const m of selector.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
    if (!defined.has(m[1])) defined.set(m[1], cssStart + i);
  }
});

// Classes REFERENCED, by every mechanism this file actually uses.
const used = new Set();
const add = (s) => s && used.add(s);
for (const m of rest.matchAll(/class\s*=\s*"([^"]*)"/g)) {
  // Template literals inside class="" are conditional class names; take the
  // static words and let the interpolations fall to the patterns below.
  for (const w of m[1].split(/[\s]+/)) if (w && !w.includes("$") && !w.includes("{")) add(w);
}
for (const m of rest.matchAll(/classList\.\w+\(\s*"([\w-]+)"/g)) add(m[1]);
for (const m of rest.matchAll(/classList\.toggle\(\s*"([\w-]+)"/g)) add(m[1]);
for (const m of rest.matchAll(/querySelector(?:All)?\(\s*["'`][^"'`]*?\.([\w-]+)/g)) add(m[1]);
for (const m of rest.matchAll(/["'`]\.([\w-]+)["'`]/g)) add(m[1]);
// Bare occurrences inside template literals: `<div class="acc ${open ? "open" : ""}">`
for (const m of rest.matchAll(/"([\w-]+)"\s*:\s*""/g)) add(m[1]);
for (const m of rest.matchAll(/\?\s*"([\w-]+)"/g)) add(m[1]);

// Built at runtime from a prefix + a variable, so no literal ever appears.
const DYNAMIC = [
  /^grp-/, // achievement groups: "grp-" + category
  /^tier-/, // partner tiers: "tier-" + level
];
// Not classes at all — file extensions and MIME fragments that look like one.
const NOT_A_CLASS = new Set(["png", "jpg", "jpeg", "svg", "webp", "mp4", "webm", "mov", "woff2", "ts", "md", "js", "html", "css"]);

const dead = [...defined.entries()]
  .filter(([c]) => !used.has(c))
  .filter(([c]) => !NOT_A_CLASS.has(c))
  .filter(([c]) => !DYNAMIC.some((rx) => rx.test(c)))
  .sort((a, b) => a[1] - b[1]);

if (!dead.length) {
  console.log(`✓ No dead CSS — every rule in ${SRC} has markup that uses it.`);
  process.exit(0);
}

console.log(`Dead CSS in ${SRC} — ${dead.length} class${dead.length === 1 ? "" : "es"} defined but never used:\n`);
for (const [cls, line] of dead) console.log(`  ${SRC}:${line}  .${cls}`);
console.log(
  "\nEach of these is a rule with no markup. If it's left over from a rebuild, delete it;" +
    "\nif it's built at runtime, add the prefix to DYNAMIC in scripts/check-dead-css.mjs.",
);
