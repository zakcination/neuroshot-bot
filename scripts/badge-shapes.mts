/**
 * Generates the 7 achievement-group medallion silhouettes (`--shape` custom
 * properties consumed by `public/app.html`'s `.grp-*` rules) from the same
 * concave-sampling recipe `docs/achievements.md` describes in prose: pick N
 * anchor vertices, pull each edge's midpoint toward the centre (concavity),
 * then sample a quadratic Bézier per edge into plain `polygon()` points.
 *
 * `clip-path: path()` takes literal px and won't rescale across the 44px
 * shelf tile / 190px spin / full-screen sizes one badge renders at, so the
 * output is always a percentage `polygon()` — never `path()` — same trick
 * the original single shield silhouette used.
 *
 * Deliberately a one-off, run-when-you-want-to-retune-a-shape script, not a
 * build step — nothing imports this. Paste its stdout over the matching
 * `.grp-*` block in `public/app.html`.
 *
 * Run: npx tsx scripts/badge-shapes.mts
 */

type Point = [number, number];

function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

function polygonCss(points: Point[]): string {
  return `polygon(${points.map(([x, y]) => `${fmt(x)}% ${fmt(y)}%`).join(", ")})`;
}

/** Explicit closing point (duplicate the first vertex at the end) so every
 *  edge — including the one between the last and first anchor — is drawn
 *  from two adjacent listed points, not the implicit polygon() auto-close.
 *  A future edit reordering/trimming points can't silently break one edge
 *  differently from the rest. */
function closeExplicitly(points: Point[]): Point[] {
  return [...points, points[0]];
}

function quadraticBezier(p0: Point, control: Point, p1: Point, t: number): Point {
  const x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * control[0] + t ** 2 * p1[0];
  const y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * control[1] + t ** 2 * p1[1];
  return [x, y];
}

/** N anchor vertices, each edge bowed toward the centre by `bow` (0 = straight,
 *  1 = midpoint pulled all the way to the centre), sampled at `segs` steps
 *  per edge. This is the hexagon/cushion/triangle family. */
function keyPointShape(anchors: Point[], bow: number, segs: number, cx = 50, cy = 50): Point[] {
  const points: Point[] = [];
  const n = anchors.length;
  for (let i = 0; i < n; i++) {
    const p0 = anchors[i];
    const p1 = anchors[(i + 1) % n];
    const mid: Point = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    const control: Point = [mid[0] + (cx - mid[0]) * bow, mid[1] + (cy - mid[1]) * bow];
    for (let s = 0; s < segs; s++) {
      points.push(quadraticBezier(p0, control, p1, s / segs));
    }
  }
  return points;
}

/** A radius function sampled at even angular steps — the rosette/quatrefoil
 *  family, where concavity comes from the radius itself dipping between
 *  lobes rather than from a per-edge bow. */
function radialShape(rOfTheta: (theta: number) => number, n: number, cx = 50, cy = 50): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < n; i++) {
    const theta = (2 * Math.PI * i) / n;
    const r = rOfTheta(theta);
    points.push([cx + r * Math.sin(theta), cy - r * Math.cos(theta)]);
  }
  return points;
}

function shoelaceAreaPct(points: Point[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    a += x1 * y2 - x2 * y1;
  }
  return (Math.abs(a) / 2 / (100 * 100)) * 100;
}

// ---- The 7 groups ----
// output (Работы) isn't generated here: `.badge`'s aspect-ratio (1/1.12,
// taller than wide) means a polygon with equal x/y percentage radius renders
// as an ellipse, not a circle — CSS percentages resolve independently per
// axis. `circle(<pct>)` instead resolves its radius against
// sqrt(width²+height²)/√2 (a single scalar, applied equally in every
// direction), which is what actually stays a true circle regardless of the
// box's aspect ratio. So `.grp-output` is hand-set to
// `circle(45% at 50% 50%)` directly in `public/app.html` — nothing to run
// here for it.

const SHAPES: Record<string, Point[]> = {
  formats: closeExplicitly([
    // Rounded top-left corner (180°→270°), then top edge, then rounded
    // top-right corner (270°→360°) — quarter-circle arcs, centre (18,18) and
    // (82,18), radius 16.
    ...Array.from({ length: 9 }, (_, i) => {
      const a = Math.PI + (Math.PI / 2) * (i / 8);
      return [18 + 16 * Math.cos(a), 18 + 16 * Math.sin(a)] as Point;
    }),
    ...Array.from({ length: 9 }, (_, i) => {
      const a = -Math.PI / 2 + (Math.PI / 2) * (i / 8);
      return [82 + 16 * Math.cos(a), 18 + 16 * Math.sin(a)] as Point;
    }),
    [98, 78], // right edge down to the flare point
    [100, 100], // right flare tip
    [50, 76], // concave swallow-tail notch, pulled up to the centre line
    [0, 100], // left flare tip
    [2, 78], // left edge back up — closed explicitly by closeExplicitly()
  ]),

  exploration: closeExplicitly(
    keyPointShape(
      Array.from({ length: 6 }, (_, i) => {
        const a = -Math.PI / 2 + (i * Math.PI) / 3 + Math.PI / 6; // flat-top hexagon
        return [50 + 46 * Math.cos(a), 51 + 46 * Math.sin(a)] as Point;
      }),
      0.16,
      7,
      50,
      51,
    ),
  ),

  // Larger base square (74×74, was 64×64) and a shallower bow (0.22, was
  // 0.30) than the first cut — that combination rendered at 32.8% of the
  // box, a visible size outlier against every sibling's 47-81%.
  engagement: closeExplicitly(keyPointShape([[13, 13], [87, 13], [87, 87], [13, 87]], 0.22, 10)),

  // 8-ray sunburst — the doc table calls this "8-лучевая звезда"; the
  // radial ripple's frequency IS the ray count, so N=8 here keeps the shape
  // and its own description in sync (the previous cut used an unrelated
  // 10-point hand list).
  support: closeExplicitly(
    radialShape((theta) => 36 + 12 * Math.cos(8 * theta), 64),
  ),

  community: closeExplicitly(
    radialShape((theta) => 30 + 20 * (0.5 + 0.5 * Math.cos(4 * theta)) ** 0.7, 56),
  ),

  progress: closeExplicitly(
    radialShape((theta) => 38 + 12 * Math.cos(3 * theta), 54, 50, 51),
  ),
};

for (const [name, points] of Object.entries(SHAPES)) {
  for (const [x, y] of points) {
    if (x < 0 || x > 100 || y < 0 || y > 100) {
      throw new Error(
        `.grp-${name}: point (${fmt(x)}%, ${fmt(y)}%) falls outside the 0-100 box — ` +
          `reduce its radius/amplitude before pasting this into app.html.`,
      );
    }
  }
}

console.log("/* --shape values — paste into the matching .grp-* rule in public/app.html */\n");
for (const [name, points] of Object.entries(SHAPES)) {
  console.log(`.grp-${name} { --shape: ${polygonCss(points)}; }`);
}

console.log("\n/* metrics (verify before pasting: area should sit near the 45-60% band,");
console.log("   min/max radius should leave a couple of percent of margin) */");
for (const [name, points] of Object.entries(SHAPES)) {
  const dists = points.map(([x, y]) => Math.hypot(x - 50, y - 50));
  console.log(
    `${name}: ${points.length} points, area=${shoelaceAreaPct(points).toFixed(1)}%, ` +
      `radius min=${Math.min(...dists).toFixed(1)} max=${Math.max(...dists).toFixed(1)}`,
  );
}
