import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDesignCoverage } from "./plan.ts";

const INDEX = `| Screen | Local file | Width | Source | Source of truth for |
|---|---|---|---|---|
| Home, desktop | \`design/a.png\` | 1440 | mockup | layout |
| Home, mobile | \`design/b.png\` | 390 | mockup | layout |
`;

// An artifacts/ folder holding plan.md and, when given, phases/phase-1.md and design/INDEX.md.
const artifactsWith = (files: { plan: string; phase?: string; index?: string }): string => {
  const dir = join(mkdtempSync(join(tmpdir(), "plan-")), "artifacts");
  mkdirSync(join(dir, "phases"), { recursive: true });
  writeFileSync(join(dir, "plan.md"), files.plan);
  if (files.phase !== undefined) writeFileSync(join(dir, "phases", "phase-1.md"), files.phase);
  if (files.index !== undefined) {
    mkdirSync(join(dir, "design"));
    writeFileSync(join(dir, "design", "INDEX.md"), files.index);
  }
  return dir;
};

const check = (dir: string) =>
  checkDesignCoverage({
    run: "r",
    nodeRunId: "nr-1",
    output: null,
    artifacts: [{ type: "plan", name: "plan", path: join(dir, "plan.md") }],
    args: null,
    nodeInput: null,
  });

describe("checkDesignCoverage", () => {
  test("SC8: a plan whose phase steps build to design/a.png and design/b.png passes", async () => {
    const dir = artifactsWith({
      plan: "# Plan\n",
      phase: "- build to design/a.png at 1440px\n- build to design/b.png at 390px\n",
      index: INDEX,
    });

    expect(await check(dir)).toEqual({ pass: true, findings: [] });
  });

  test("SC9: a plan that builds only design/a.png fails with one finding naming design/b.png, both claims and the index", async () => {
    const dir = artifactsWith({ plan: "- build to design/a.png at 1440px\n", index: INDEX });

    const result = await check(dir);

    expect(result.pass).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.message).toContain("design/b.png");
    expect(result.findings[0]?.message).toContain('"build to design/b.png at 390px"');
    expect(result.findings[0]?.message).toContain('"design/b.png — not built: REASON"');
    expect(result.findings[0]?.path).toBe(join(dir, "design", "INDEX.md"));
  });

  test.each([
    ["the dash form with a reason passes", "design/b.png — not built: same screen as a.png", true],
    ["the hyphen form with a reason passes", "design/b.png - not built: same", true],
    [
      "the dash form with nothing after the colon fails, even with a line below it",
      "design/b.png — not built:\n## Next section\n",
      false,
    ],
    [
      "a not-built bullet below a bare listing of the frame fails",
      "- design/b.png\n- Not built: the empty state, which no frame draws\n",
      false,
    ],
  ])("SC10: a not-built line for design/b.png: %s", async (_name, plan, pass) => {
    const index = "| Home | `design/b.png` | 390 | mockup | layout |\n";

    expect((await check(artifactsWith({ plan, index }))).pass).toBe(pass);
  });

  test.each([
    ["a build claim", "- build to `design/b.png` at 390px\n"],
    ["a not-built line", "`design/b.png` — not built: same screen as a.png\n"],
  ])("%s with the path in backticks claims design/b.png", async (_name, plan) => {
    const index = "| Home | `design/b.png` | 390 | mockup | layout |\n";

    expect((await check(artifactsWith({ plan, index }))).pass).toBe(true);
  });

  test.each([
    ["with a capital B", "- Build to design/b.png at 390px\n"],
    ["wrapped after build to", "- the header, build to\n  design/b.png at 390px\n"],
    [
      "as a not-built line wrapped after the dash",
      "design/b.png —\n  Not built: same screen as a.png\n",
    ],
  ])("a claim written %s claims design/b.png", async (_name, plan) => {
    const index = "| Home | `design/b.png` | 390 | mockup | layout |\n";

    expect((await check(artifactsWith({ plan, index }))).pass).toBe(true);
  });

  test.each([
    ["a build claim with no width fails when the index gives one", "390", "", false],
    ["a build claim with no width passes when the index gives none", "", "", true],
    ["a build claim at a width the index does not give fails", "390", " at 1024px", false],
    ["a build claim on a longer path that starts with the frame's fails", "", ".old", false],
  ])("%s", async (_name, width, claimed, pass) => {
    const index = `| Home | \`design/b.png\` | ${width} | mockup | layout |\n`;
    const plan = `- build to design/b.png${claimed}\n`;

    expect((await check(artifactsWith({ plan, index }))).pass).toBe(pass);
  });

  const DIFF = ["   ```diff", "   + export const Modal = () => null;", "   ```"];
  const designStep = (n: number, frame: string, diff: readonly string[]) => [
    `${n}. **Create \`src/${n}.tsx\`**`,
    "",
    "   Adds the screen.",
    "",
    `   - **Design:** build to ${frame}`,
    "   - **Spec:** design/spec.md — 7. Modal",
    "",
    ...diff,
    "",
  ];

  test("a phase step that builds to a frame with its diff passes, and one without a diff fails, naming the step, the frame and the phase file", async () => {
    const phase = [
      "# Phase 1",
      "",
      "## Steps",
      "",
      ...designStep(1, "design/a.png at 1440px", DIFF),
      ...designStep(2, "design/b.png at 390px", []),
      "## Tests",
      "",
      "```diff",
      "+ unrelated",
      "```",
      "",
    ].join("\n");
    const dir = artifactsWith({ plan: "# Plan\n", phase, index: INDEX });

    const result = await check(dir);

    expect(result.pass).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.message).toContain("step 2");
    expect(result.findings[0]?.message).toContain("design/b.png");
    expect(result.findings[0]?.message).toContain("diff");
    expect(result.findings[0]?.path).toBe(join(dir, "phases", "phase-1.md"));
  });

  test("a design step needs its diff even when the run has no design/INDEX.md", async () => {
    const phase = ["# Phase 1", "", ...designStep(1, "design/a.png", [])].join("\n");

    const result = await check(artifactsWith({ plan: "# Plan\n", phase }));

    expect(result.pass).toBe(false);
    expect(result.findings[0]?.message).toContain("step 1");
  });

  test("SC11 (regression): a plan with no design/INDEX.md beside it passes untouched", async () => {
    const dir = artifactsWith({ plan: "# Plan\n- build the API\n" });

    expect(await check(dir)).toEqual({ pass: true, findings: [] });
  });
});
