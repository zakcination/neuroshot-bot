/**
 * Ad-hoc sizing of the "marketplace seller" segment (backlog #49/#50). Answers
 * one question with a real number instead of a guess: of the people who actually
 * create something in NeuroShot, how many reach for the product/маркетплейс
 * presets — the behavioural proxy for the stated B2B/SMB seller ICP?
 *
 * Read-only. Deliberately a one-off script, NOT a live dashboard — monitor.ts's
 * philosophy is no cohorts/dashboards before ~1,000 users. Run it when you want
 * a reading; don't wire it into anything.
 *
 * Run: DATABASE_URL=postgres://... npx tsx scripts/segment-sizing.mts
 *
 * ⚠️ The web studio only began logging plain-preset taps in the change that
 * added this script; the bot has always logged them. So an early reading counts
 * all bot usage but only post-change web usage — read it as a FLOOR on the
 * segment, and re-run after a few weeks for a fuller picture.
 */
import { PRESETS } from "../src/models.js";
import { sellerSegmentSizing } from "../src/db.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set — point this at the production DB (read-only query).");
}

const productIds = PRESETS.filter((p) => p.category === "product").map((p) => p.id);
const r = await sellerSegmentSizing(productIds);

console.log("\nMarketplace-seller segment sizing");
console.log("─────────────────────────────────");
console.log(`Product presets tracked : ${productIds.join(", ")}`);
console.log(`Registered users        : ${r.totalUsers}`);
console.log(`Distinct generators     : ${r.totalGenerators}  (users with ≥1 generation)`);
console.log(`Used a product preset   : ${r.productPresetUsers}`);
console.log(`Seller-behaviour share  : ${r.sharePct}%  (of generators)  ← floor, see header note`);
console.log("");
