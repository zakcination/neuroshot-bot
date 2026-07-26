/**
 * Quality grid — a QA harness, not part of the running product.
 *
 * Usage:  set -a; . ./.env; set +a;  npx tsx scripts/quality-grid.mts
 * Output: /tmp/<scratch>/grid/*.jpg  (subjects + one render per job)
 *
 * COSTS REAL MONEY at the provider. Keep the job list to the questions you
 * actually need answered — a full preset x subject matrix is rarely one of
 * them.
 *
 * Quality grid. Renders through the REAL registry entries — same endpoint,
 * same input builder, same prompt the user gets — so a pass here means the
 * product works, not that a test harness does.
 *
 * Subjects are synthetic Central Asian faces: our market, and a real user's
 * upload cannot be repurposed as test material (given for their result, not
 * for ours).
 */
import { fal } from "@fal-ai/client";
import { writeFile, mkdir } from "node:fs/promises";
import { MODELS, PRESETS, presetModel } from "../src/models.js";

const OUT = "/tmp/claude-0/grid";
await mkdir(OUT, { recursive: true });

const SUBJECTS = [
  { id: "man", prompt: "Candid smartphone photo of a Kazakh man, 34, plain grey t-shirt, standing indoors near a window, neutral expression, natural daylight, slightly imperfect amateur framing, photorealistic, sharp face" },
  { id: "woman", prompt: "Candid smartphone selfie of a Kazakh woman, 29, dark hair down, plain top, holding the phone at arm's length so her arm is visible, indoors, soft window light, everyday amateur photo, photorealistic, sharp face" },
  { id: "group", prompt: "Candid smartphone photo of three Kazakh friends standing together indoors, two women and one man in their late twenties, casual clothes, all faces clearly visible, everyday amateur framing, natural light, photorealistic" },
  { id: "child", prompt: "Candid smartphone photo of a Kazakh boy, 7 years old, plain blue t-shirt, standing in a living room, natural expression, daylight from a window, amateur framing, photorealistic, sharp face" },
];

const save = async (name: string, url: string) => {
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  await writeFile(`${OUT}/${name}.jpg`, buf);
};

// ---- 1. subjects, through the registry's text_to_image entry --------------
const t2i = MODELS.text_to_image;
const subjectUrls: Record<string, string> = {};
const { access } = await import("node:fs/promises");
for (const s of SUBJECTS) {
  // Re-use a subject already on disk: a verification pass should pay only for
  // what it is verifying.
  const cached = `${OUT}/subject-${s.id}.jpg`;
  try {
    await access(cached);
    const up = await fal.storage.upload(new Blob([await (await import("node:fs/promises")).readFile(cached)]));
    subjectUrls[s.id] = up;
    console.log("subject", s.id, "cached");
    continue;
  } catch { /* not cached — render it */ }
  const r = await fal.subscribe(t2i.falEndpoint, { input: t2i.input(s.prompt, undefined, {}) });
  const url = (r.data as { images?: Array<{ url: string }> }).images?.[0]?.url;
  if (!url) { console.error("SUBJECT FAIL", s.id); continue; }
  subjectUrls[s.id] = url;
  await save(`subject-${s.id}`, url);
  console.log("subject", s.id, "ok");
}

// ---- 2. the four presets with known defects -------------------------------
// cinematic on ALL subjects (it was dead on all four); the others only where
// their defect showed, so the run stays cheap and answers real questions.
const JOBS: Array<{ preset: string; subject: string }> = [
  { preset: "headshot", subject: "woman" },      // selfie arm + phone survive
  { preset: "bento_birthday", subject: "child" },// child replaced by an adult
];

for (const j of JOBS) {
  const p = PRESETS.find((x) => x.id === j.preset);
  const src = subjectUrls[j.subject];
  if (!p || !src) { console.error("SKIP", j.preset, j.subject); continue; }
  const m = presetModel(p);
  try {
    const r = await fal.subscribe(m.falEndpoint, {
      input: m.input(p.prompt, src, {}),
    });
    const url = (r.data as { images?: Array<{ url: string }> }).images?.[0]?.url;
    if (!url) { console.error("NO IMAGE", j.preset, j.subject); continue; }
    await save(`${j.preset}--${j.subject}`, url);
    console.log("ok", j.preset, j.subject, `(${m.key})`);
  } catch (e) {
    console.error("FAIL", j.preset, j.subject, e instanceof Error ? e.message : e);
  }
}
console.log("done");
