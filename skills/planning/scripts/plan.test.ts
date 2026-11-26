import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDesignCoverage, checkOutcomeHomes } from "./plan.ts";

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

  test("SC11 (regression): a plan with no design/INDEX.md beside it passes untouched", async () => {
    const dir = artifactsWith({ plan: "# Plan\n- build the API\n" });

    expect(await check(dir)).toEqual({ pass: true, findings: [] });
  });
});

const MATRIX_HEAD = "## Test Matrix\n\n| Outcome | Source | Type | Home |\n|---|---|---|---|\n";
const SCENARIO_HEAD =
  "## Test Scenarios\n\n| ID | Scenario | Given | Expected | Level | Traces |\n|---|---|---|---|---|---|\n";
const scenarioAt = (level: string, id: string, ...outcomes: string[]): string =>
  `| ${id} | s | g | ${outcomes.map((outcome) => `• ${outcome} holds`).join("<br>")} | ${level} | R1 |\n`;
const scenario = (id: string, ...outcomes: string[]): string => scenarioAt("unit", id, ...outcomes);

// An artifacts/ folder holding plan.md and one phase file per entry of `phases`.
const planWith = (plan: string, ...phases: string[]): string => {
  const dir = join(mkdtempSync(join(tmpdir(), "plan-")), "artifacts");
  mkdirSync(join(dir, "phases"), { recursive: true });
  writeFileSync(join(dir, "plan.md"), plan);
  phases.forEach((phase, index) => {
    writeFileSync(join(dir, "phases", `phase-${index + 1}.md`), phase);
  });
  return dir;
};

const checkHomes = (dir: string) =>
  checkOutcomeHomes({
    run: "r",
    nodeRunId: "nr-1",
    output: null,
    artifacts: [{ type: "plan", name: "plan", path: join(dir, "plan.md") }],
    args: null,
    nodeInput: null,
  });

const messages = async (dir: string): Promise<string[]> =>
  (await checkHomes(dir)).findings.map((finding) => finding.message);

describe("checkOutcomeHomes", () => {
  test("every outcome with one home passes: a scenario with or without its regression mark, an existing test, a deploy check", async () => {
    const dir = planWith(
      `${MATRIX_HEAD}| O1 shows a \\| b | R1 | unit | \`SC1\` |\n| O2 two | R1 | unit | SC2 (regression) |\n| O3 three | R1 | e2e | SC3 |\n| O4 four | R2 | integration | existing: a.test.ts "keeps x" |\n| O5 five | K1 | deploy | deploy: publish the package first |\n\n## Acceptance\n| SC9 | not a matrix row |\n- O5 the new version is on npm\n`,
      `${SCENARIO_HEAD}${scenario("SC1", "O1")}`,
      `${SCENARIO_HEAD}${scenario("SC2 (regression)", "O2")}${scenarioAt("e2e", "SC3", "O3")}`,
    );

    expect(await checkHomes(dir)).toEqual({ pass: true, findings: [] });
  });

  test("a separator line with trailing spaces is not read as an outcome", async () => {
    const dir = planWith(
      "## Test Matrix\n\n| Outcome | Source | Type | Home |\n|---|---|---|---|  \n| O1 one | R1 | unit | SC1 |\n",
      `${SCENARIO_HEAD}${scenario("SC1", "O1")}`,
    );

    expect(await checkHomes(dir)).toEqual({ pass: true, findings: [] });
  });

  test.each([
    ["no home", "| O2 two | R1 | unit | |\n", "O2"],
    ["two homes", "| O2 two | R1 | unit | SC1, SC2 |\n", "O2"],
    ["a question still open", "| O2 two | R1 | unit | ask: one line or two? |\n", "O2"],
    ["no outcome id", "| two | R1 | unit | SC1 |\n", "two"],
    ["no type", "| O2 two | R1 | | existing: a.test.ts |\n", "O2"],
    [
      "a deploy check typed as a test level",
      "| O2 two | R1 | unit | deploy: run the migration |\n\n## Acceptance\n- O2 the column exists\n",
      "O2",
    ],
  ])("an outcome with %s fails, naming it", async (_name, row, named) => {
    const dir = planWith(
      `${MATRIX_HEAD}| O1 one | R1 | unit | SC1 |\n${row}`,
      `${SCENARIO_HEAD}${scenario("SC1", "O1")}`,
    );

    const found = await messages(dir);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain(named);
  });

  test("a type its scenario's Level does not have fails, naming the outcome", async () => {
    const dir = planWith(
      `${MATRIX_HEAD}| O1 one | R1 | e2e | SC1 |\n`,
      `${SCENARIO_HEAD}${scenario("SC1", "O1")}`,
    );

    const found = await messages(dir);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain("O1");
  });

  test("a deploy outcome with no line in ## Acceptance fails, naming it", async () => {
    const plan = `${MATRIX_HEAD}| O1 one | R1 | unit | SC1 |\n| O2 two | K1 | deploy | deploy: run the migration |\n`;
    const phase = `${SCENARIO_HEAD}${scenario("SC1", "O1")}`;

    const missing = await messages(planWith(plan, phase));
    const elsewhere = await messages(planWith(`${plan}\n## Notes\n- O2 is risky\n`, phase));

    expect(missing).toEqual([expect.stringContaining("O2")]);
    expect(missing[0]).toContain("## Acceptance");
    expect(elsewhere).toEqual([expect.stringContaining("## Acceptance")]);
  });

  test.each([
    ["a level outside unit, integration, e2e and qa-agent", "smoke", "smoke"],
    ["no Level", "", "unit"],
  ])("a scenario row with %s fails, naming it", async (_name, level, type) => {
    const dir = planWith(
      `${MATRIX_HEAD}| O1 one | R1 | ${type} | SC1 |\n`,
      `${SCENARIO_HEAD}${scenarioAt(level, "SC1", "O1")}`,
    );

    const found = await messages(dir);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain("SC1");
  });

  test("an Expected line that does not open with its outcome id fails, though another line does", async () => {
    const dir = planWith(
      `${MATRIX_HEAD}| O1 one | R1 | unit | SC1 |\n`,
      `${SCENARIO_HEAD}| SC1 | s | g | • O1 saves<br>• an error shows, as in O1 | unit | R1 |\n`,
    );

    const found = await messages(dir);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain("SC1");
  });

  test("an outcome id used on two matrix rows, and a scenario id held by two phase rows, each give one finding", async () => {
    const dir = planWith(
      `${MATRIX_HEAD}| O1 one | R1 | unit | SC1 |\n| O1 again | R2 | unit | SC1 |\n`,
      `${SCENARIO_HEAD}${scenario("SC1", "O1")}`,
      `${SCENARIO_HEAD}${scenario("SC1", "O1")}`,
    );

    expect(await messages(dir)).toEqual([
      expect.stringContaining("O1"),
      expect.stringContaining("SC1"),
    ]);
  });

  test("a home naming a scenario no phase holds, or a scenario whose Expected lacks the outcome, fails", async () => {
    const dir = planWith(
      `${MATRIX_HEAD}| O1 one | R1 | unit | SC1 |\n| O2 two | R1 | unit | SC1 |\n| O3 three | R1 | unit | SC7 |\n`,
      `${SCENARIO_HEAD}${scenario("SC1", "O1")}`,
    );

    expect(await messages(dir)).toEqual([
      expect.stringContaining("O2"),
      expect.stringContaining("SC7"),
    ]);
  });

  test("an Expected line naming an outcome the matrix lacks or homes elsewhere, and a scenario naming no outcome, fail", async () => {
    const dir = planWith(
      `${MATRIX_HEAD}| O1 one | R1 | unit | SC1 |\n| O2 two | R1 | unit | existing: a.test.ts |\n`,
      `${SCENARIO_HEAD}${scenario("SC1", "O1", "O2", "O9")}${scenario("SC2")}`,
    );

    expect(await messages(dir)).toEqual([
      expect.stringContaining("O2"),
      expect.stringContaining("O9"),
      expect.stringContaining("SC2"),
    ]);
  });

  test("ids out of number order down the matrix fail with one finding", async () => {
    const found = await messages(
      planWith(
        `${MATRIX_HEAD}| O2 one | R1 | unit | SC1 |\n| O1 two | R1 | e2e | SC2 |\n`,
        `${SCENARIO_HEAD}${scenario("SC1", "O2")}${scenarioAt("e2e", "SC2", "O1")}`,
      ),
    );

    expect(found).toHaveLength(1);
    expect(found[0]).toContain("O1");
  });

  test("rows in any order of type pass when numbered down the matrix", async () => {
    const dir = planWith(
      `${MATRIX_HEAD}| O1 one | R1 | e2e | SC2 |\n| O2 two | R1 | unit | SC1 |\n`,
      `${SCENARIO_HEAD}${scenario("SC1", "O2")}${scenarioAt("e2e", "SC2", "O1")}`,
    );

    expect(await checkHomes(dir)).toEqual({ pass: true, findings: [] });
  });

  test("a plan with no Test Matrix, or one without the Outcome, Type and Home columns, fails with one finding", async () => {
    const none = planWith("# Plan\n", `${SCENARIO_HEAD}${scenario("SC1", "O1")}`);
    const old = planWith(
      "## Test Matrix\n\n| Requirement | Level | Strategy | Phase |\n|---|---|---|---|\n| R1 | unit | x | 1 |\n",
    );

    const untyped = planWith(
      "## Test Matrix\n\n| Outcome | Source | Home |\n|---|---|---|\n| O1 one | R1 | SC1 |\n",
      `${SCENARIO_HEAD}${scenario("SC1", "O1")}`,
    );

    expect(await messages(none)).toHaveLength(1);
    expect(await messages(old)).toHaveLength(1);
    expect(await messages(untyped)).toHaveLength(1);
  });
});
