import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type FileArtifact,
  indexedFrames,
  isBuiltTo,
  isNotBuilt,
  readPlanText,
  type VerifierInput,
  type VerifierResult,
} from "@yok/sdk";

// The planning stage's verifier: every frame in design/INDEX.md is built by a step or recorded as not built.
export const checkDesignCoverage = async (input: VerifierInput): Promise<VerifierResult> => {
  const plan = input.artifacts.find(
    (artifact): artifact is FileArtifact => artifact.type === "plan" && "path" in artifact,
  );
  if (plan === undefined) return { pass: true, findings: [] };
  const artifactsDir = dirname(plan.path);
  const indexPath = join(artifactsDir, "design", "INDEX.md");
  const index = await readFile(indexPath, "utf8").catch(() => undefined);
  if (index === undefined) return { pass: true, findings: [] };
  const text = await readPlanText(artifactsDir);
  const findings = indexedFrames(index)
    .filter((row) => !isBuiltTo(row, text) && !isNotBuilt(row.frame, text))
    .map(({ frame, width }) => ({
      message: `${frame} is in design/INDEX.md, but no step says "build to ${frame}${width === "" ? "" : ` at ${width}px`}" and plan.md has no "${frame} — not built: REASON" line`,
      path: indexPath,
    }));
  return { pass: findings.length === 0, findings };
};

type Table = { header: string[]; rows: string[][] };

const cells = (line: string): string[] =>
  line
    .trim()
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.replaceAll("`", "").trim());

const isSeparator = (line: string): boolean => /^\|[\s:|-]+\|$/.test(line.trim());

// Every markdown table in the text: runs of lines that open with a pipe.
const tables = (text: string): Table[] =>
  text
    .split(/\n(?!\|)/)
    .map((block) => block.split("\n").filter((line) => line.startsWith("|") && !isSeparator(line)))
    .filter((lines) => lines.length > 0)
    .map((lines) => ({ header: cells(lines[0] ?? ""), rows: lines.slice(1).map(cells) }));

type Outcome = { id: string; label: string; home: string };
type Scenario = { id: string; outcomes: string[] };

const matrixOutcomes = (plan: string): Outcome[] | undefined => {
  const section = plan.split(/^## Test Matrix\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  const table = tables(section)[0];
  const outcome = table?.header.indexOf("Outcome") ?? -1;
  const home = table?.header.indexOf("Home") ?? -1;
  if (table === undefined || outcome === -1 || home === -1) return undefined;
  return table.rows.map((row) => ({
    id: /^O\d+\b/.exec(row[outcome] ?? "")?.[0] ?? "",
    label: row[outcome] ?? "",
    home: (row[home] ?? "").replace(/^(SC\d+) \(regression\)$/, "$1"),
  }));
};

const phaseScenarios = async (artifactsDir: string): Promise<Scenario[]> => {
  const dir = join(artifactsDir, "phases");
  const files = (await readdir(dir).catch((): string[] => [])).filter((file) =>
    file.endsWith(".md"),
  );
  const texts = await Promise.all(files.map((file) => readFile(join(dir, file), "utf8")));
  return texts.flatMap(tables).flatMap(({ header, rows }) => {
    const id = header.indexOf("ID");
    const expected = header.indexOf("Expected");
    if (id === -1 || expected === -1) return [];
    return rows.map((row) => ({
      id: /^SC\d+/.exec(row[id] ?? "")?.[0] ?? "",
      outcomes: (row[expected] ?? "").match(/\bO\d+\b/g) ?? [],
    }));
  });
};

const repeated = (ids: string[]): string[] => [
  ...new Set(ids.filter((id, index) => ids.indexOf(id) !== index)),
];

const hasText = (home: string): boolean => /^(existing|deploy):\s*\S/.test(home);

// The planning stage's verifier: every outcome in the Test Matrix has one home, and every scenario row carries
// exactly the outcomes whose home it is.
export const checkOutcomeHomes = async (input: VerifierInput): Promise<VerifierResult> => {
  const plan = input.artifacts.find(
    (artifact): artifact is FileArtifact => artifact.type === "plan" && "path" in artifact,
  );
  if (plan === undefined) return { pass: true, findings: [] };
  const outcomes = matrixOutcomes(await readFile(plan.path, "utf8").catch(() => ""));
  if (outcomes === undefined) {
    return {
      pass: false,
      findings: [
        {
          message: 'plan.md needs a "## Test Matrix" table with "Outcome" and "Home" columns',
          path: plan.path,
        },
      ],
    };
  }
  const scenarios = await phaseScenarios(dirname(plan.path));
  const homeOf = new Map(outcomes.map(({ id, home }) => [id, home]));
  const found = [
    ...outcomes
      .filter(({ id }) => id === "")
      .map(({ label }) => `matrix row "${label}" opens with no outcome id`),
    ...repeated(outcomes.map(({ id }) => id).filter((id) => id !== "")).map(
      (id) => `${id} is on more than one matrix row`,
    ),
    ...repeated(scenarios.map(({ id }) => id)).map(
      (id) => `${id} is the id of more than one scenario row`,
    ),
    ...outcomes
      .filter(({ id, home }) => id !== "" && !/^SC\d+$/.test(home) && !hasText(home))
      .map(({ id, home }) =>
        home.startsWith("ask:")
          ? `${id} still holds a question: ask the user, then give it a home`
          : `${id} needs one home: one scenario id, "existing: TEST" or "deploy: CHECK"`,
      ),
    ...outcomes
      .filter(({ id, home }) => id !== "" && /^SC\d+$/.test(home))
      .flatMap(({ id, home }) => {
        const row = scenarios.find((scenario) => scenario.id === home);
        if (row === undefined) return [`${id} has the home ${home}, which no phase file holds`];
        return row.outcomes.includes(id)
          ? []
          : [`${id} has the home ${home}, whose Expected has no ${id} line`];
      }),
    ...scenarios.flatMap(({ id, outcomes: named }) =>
      [...new Set(named)]
        .filter((outcome) => homeOf.get(outcome) !== id)
        .map((outcome) =>
          homeOf.has(outcome)
            ? `${id} carries ${outcome}, whose home in the matrix is elsewhere`
            : `${id} carries ${outcome}, which the Test Matrix does not list`,
        ),
    ),
    ...scenarios
      .filter(({ outcomes: named }) => named.length === 0)
      .map(
        ({ id }) =>
          `${id} carries no outcome id: open each Expected line with the outcome it proves`,
      ),
  ];
  return {
    pass: found.length === 0,
    findings: found.map((message) => ({ message, path: plan.path })),
  };
};
