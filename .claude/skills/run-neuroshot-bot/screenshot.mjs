#!/usr/bin/env node
// Drives the Mini App (public/app.html) in headless Chromium against a
// locally-started webapp-only server, authenticated via a pre-minted Bearer
// session token (no real Telegram WebApp context needed — see webapp.ts:
// outside Telegram the client falls back to a token in
// localStorage["neuroshot_session"]).
//
// `chromium-cli` (the tool this project's driver-generator skill normally
// expects) isn't installed in this environment — this is the documented
// fallback: the `playwright` package directly (`npx playwright install
// chromium` once, then this script). Same nav -> wait -> screenshot loop.
//
// Usage: node .claude/skills/run-neuroshot-bot/screenshot.mjs [outfile.png]
// Expects the webapp-only server already running (see webapp-only.mjs) and
// WEBAPP_PORT / SESSION_TOKEN env vars set to match it.

import { chromium } from "playwright";

const port = process.env.WEBAPP_PORT ?? "8099";
const token = process.env.SESSION_TOKEN;
const outfile = process.argv[2] ?? "screenshot.png";
if (!token) {
  console.error("Set SESSION_TOKEN (see webapp-only.mjs's WEBAPP_READY log line) before running this.");
  process.exit(1);
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 420, height: 860 } }); // phone-ish, matches the Mini App's real usage

// Must run BEFORE the page's own scripts execute (app.html reads localStorage
// during its first render), so addInitScript (not a post-load evaluate) — a
// plain page.evaluate() after goto() is too late, the app has already
// decided it's unauthenticated by then.
await page.addInitScript((t) => localStorage.setItem("neuroshot_session", t), token);

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`http://localhost:${port}/`, { waitUntil: "domcontentloaded" });

// First real render is the first-run onboarding carousel (#wskipbtn "Пропустить"),
// not the tab bar — the tab bar is already in the DOM underneath (so
// waitForSelector(".tabbtn") alone doesn't prove it's what's ON SCREEN — it'll
// resolve instantly either way). "Пропустить" only jumps to the LAST onboarding
// step (a free-credits claim screen, "ШАГ 5 ИЗ 5"), not past onboarding
// entirely — confirmed by actually screenshotting after clicking it. Getting
// to the real tab-bar studio needs one more click: "Продолжить без патронов".
const skip = page.locator("#wskipbtn");
if (await skip.isVisible({ timeout: 10_000 }).catch(() => false)) {
  await page.screenshot({ path: outfile.replace(/\.png$/, "-1-onboarding.png") });
  await skip.click();
}
const continueLink = page.getByText("Продолжить без патронов");
if (await continueLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
  await page.screenshot({ path: outfile.replace(/\.png$/, "-2-claim-step.png") });
  await continueLink.click();
}

await page.waitForSelector(".tabbtn", { timeout: 10_000 });
await page.locator(".tabbtn").first().waitFor({ state: "visible" }); // on-screen, not just in the DOM
await page.screenshot({ path: outfile });

console.log(`Screenshot saved to ${outfile} (+ -1-onboarding.png if onboarding was shown)`);
console.log(`Page title: ${await page.title()}`);
if (errors.length) console.log(`Console errors: ${errors.join(" | ")}`);

await browser.close();
