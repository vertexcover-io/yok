import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  type FileArtifact,
  FixRequestSchema,
  indexedFrames,
  isNotBuilt,
  NonEmptyStringSchema,
  readPlanText,
  type VerifierInput,
  type VerifierResult,
} from "@yok/sdk";
import * as z from "zod";
import { parseReportData } from "./report-media.ts";

// A scenario the pass could not drive, and why; the mechanism names the frame it left uncompared.
const GapSchema = z.strictObject({
  scenario: NonEmptyStringSchema,
  req: NonEmptyStringSchema,
  mechanism: NonEmptyStringSchema,
});

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const QaOutputSchema = z
  .strictObject({
    status: z.enum(["PASS", "PARTIAL", "FAIL", "BLOCKED"]),
    reason: NonEmptyStringSchema.optional(),
    report: NonEmptyStringSchema.nullable(),
    // one entry per requirement the coverage table marks NOT VERIFIED, so the PR and Asana list each
    gaps: z
      .array(GapSchema)
      .refine((gaps) => new Set(gaps.map((gap) => gap.req)).size === gaps.length, {
        message: "each gap req appears once",
      }),
    // the fix stage records one result per id, so two bugs sharing one could never both be closed
    bugs: z
      .array(FixRequestSchema.extend({ askUser: z.boolean() }))
      .refine((bugs) => new Set(bugs.map((bug) => bug.id)).size === bugs.length, {
        message: "each bug id appears once",
      }),
  })
  .refine((output) => output.status === "PASS" || output.reason !== undefined, {
    path: ["reason"],
    message: "reason is required unless status is PASS",
  })
  // A FAIL may defer its report to a later round and a BLOCKED pass drove nothing; any other
  // verdict without the report it rests on is unproven.
  .refine((output) => ["FAIL", "BLOCKED"].includes(output.status) || output.report !== null, {
    path: ["report"],
    message: "report is required when status is PASS or PARTIAL",
  })
  .refine((output) => output.status !== "FAIL" || output.bugs.length > 0, {
    path: ["bugs"],
    message: "a FAIL names at least one bug for the fix round",
  })
  // A bug's scenario is a FAILURE, which makes the derived verdict FAIL; any other verdict that
  // carries one would ship it unfixed, since only a FAIL enters the fix round.
  .refine((output) => output.status === "FAIL" || output.bugs.length === 0, {
    path: ["bugs"],
    message: "only a FAIL names bugs: a bug makes the derived verdict FAIL",
  })
  .refine((output) => output.status !== "PARTIAL" || output.gaps.length > 0, {
    path: ["gaps"],
    message: "a PARTIAL names at least one gap it could not verify",
  });

export const schemas = { "qa.output.v1": QaOutputSchema };

// One line a scenario shows its reader: what should be true, and the proofs that show it.
const checkFields = {
  text: NonEmptyStringSchema,
  saw: z.string().optional(),
  note: z.string().optional(),
  proofs: z.array(NonEmptyStringSchema).optional(),
};

// A scenario's screen read against its design, as the report's data island holds it.
export const VisualMatchSchema = z
  .strictObject({
    baseline: NonEmptyStringSchema.nullable(),
    // the screen as built, report-relative: the re-shoot at the design's width, else a frame of the take
    build: NonEmptyStringSchema.optional(),
    width: z.int().positive().optional(),
    // fail: the build breaks what the design says; warn: worth a look, and the scenario still passes
    checks: z
      .array(z.strictObject({ ...checkFields, result: z.enum(["pass", "fail", "warn"]) }))
      .min(1),
  })
  .refine((match) => match.baseline === null || match.build !== undefined, {
    path: ["build"],
    message: "a drawn screen is shown beside the screen as built",
  })
  .refine((match) => match.width === undefined || match.build !== undefined, {
    path: ["width"],
    message: "a width belongs to a re-shoot",
  });

const ReportScenariosSchema = z.looseObject({
  scenarios: z.array(
    z.looseObject({ n: z.unknown().optional(), visualMatch: VisualMatchSchema.optional() }),
  ),
});

const readOptional = (path: string): Promise<string | undefined> =>
  readFile(path, "utf8").catch(() => undefined);

// ticket-fetcher heads each spec attachment with its name, so an empty attachment still leaves a
// spec.md; only a line that is neither blank nor a heading can state a rule.
const statesRules = (spec: string): boolean =>
  spec.split("\n").some((line) => line.trim() !== "" && !/^\s*#/.test(line));

type Finding = VerifierResult["findings"][number];
type Verdict = { status: "PASS" | "PARTIAL"; gaps: z.infer<typeof GapSchema>[] };

// Every frame the plan builds is some scenario's visualMatch.baseline, or, in a PARTIAL, named in
// a gap. A PARTIAL ships like a PASS, so a frame it left uncompared must be named in the gap that
// says why.
const checkFrames = async (
  index: string,
  data: unknown,
  verdict: Verdict,
  reportPath: string,
): Promise<Finding[]> => {
  const verificationDir = dirname(reportPath);
  const artifactsDir = dirname(verificationDir);
  const parsed = ReportScenariosSchema.safeParse(data);
  if (!parsed.success) {
    const message = `the report-data island is missing or invalid: ${z.prettifyError(parsed.error)}`;
    return [{ message, path: reportPath }];
  }
  const gaps = verdict.status === "PARTIAL" ? verdict.gaps : [];
  const isExcused = (frame: string): boolean =>
    gaps.some(({ mechanism }) =>
      new RegExp(`(?<![\\w./-])${escapeRegExp(frame)}(?![\\w./-])`).test(mechanism),
    );
  const plan = await readPlanText(artifactsDir);
  const compared = parsed.data.scenarios.flatMap(({ visualMatch }) =>
    typeof visualMatch?.baseline === "string"
      ? [
          {
            frame: relative(artifactsDir, resolve(verificationDir, visualMatch.baseline)),
            width: visualMatch.width,
          },
        ]
      : [],
  );
  const baselines = new Set(compared.map(({ frame }) => frame));
  const frames = indexedFrames(index);
  const uncompared = frames
    .filter(({ frame }) => !isNotBuilt(frame, plan) && !baselines.has(frame) && !isExcused(frame))
    .map(({ frame }) => ({
      message: `${frame} is a frame the plan builds, but no scenario's visualMatch.baseline is ../${frame}: compare the scenario on that screen against it, or, when that screen could not be reached, name ${frame} in the mechanism of the gaps[] entry that says why`,
      path: reportPath,
    }));
  // A re-shoot records its width; a scenario shot at the frame's width records none.
  const offWidth = frames.flatMap(({ frame, width }) =>
    compared
      .filter(
        (c) => width !== "" && c.frame === frame && (c.width ?? Number(width)) !== Number(width),
      )
      .map((c) => ({
        message: `a scenario read ${frame} at ${c.width}px, but design/INDEX.md draws it at ${width}px: re-shoot that screen at ${width}px`,
        path: reportPath,
      })),
  );
  return [...uncompared, ...offWidth];
};

// A failed design check makes its scenario a FAILURE, so the verdict that carries one is FAIL.
const checkBlockers = (data: unknown, reportPath: string): Finding[] =>
  (ReportScenariosSchema.safeParse(data).data?.scenarios ?? []).flatMap((scenario, i) =>
    scenario.visualMatch?.checks.some(({ result }) => result === "fail")
      ? [
          {
            message: `scenario ${String(scenario.n ?? i + 1)} has a failed design check, which makes it a FAILURE: give it a bug and report FAIL`,
            path: reportPath,
          },
        ]
      : [],
  );

// spec.md has no fixed format, so its rules cannot be counted; a ledger with no spec row at all
// means the pass never read the spec.
const checkSpecRows = (data: unknown, reportPath: string): Finding[] => {
  const ledger = z
    .looseObject({ coverage: z.array(z.looseObject({ req: z.string() })).default([]) })
    .safeParse(data);
  const specRows = ledger.data?.coverage.filter(({ req }) => /^SPEC:/i.test(req)) ?? [];
  if (specRows.length > 0) return [];
  const message =
    "design/spec.md exists, but coverage[] has no SPEC: row: walk spec.md and give every rule it states its own row";
  return [{ message, path: reportPath }];
};

// The qa stage's verifier, for a PASS or PARTIAL: checkBlockers always, checkFrames when the run
// has design/INDEX.md, and checkSpecRows when its design/spec.md states a rule. A FAIL is not
// rejected, so its bugs reach the fix loop.
export const checkDesignCoverage = async (input: VerifierInput): Promise<VerifierResult> => {
  const report = input.artifacts.find(
    (artifact): artifact is FileArtifact => artifact.type === "proof-report" && "path" in artifact,
  );
  if (report === undefined) return { pass: true, findings: [] };
  const verdict = z
    .looseObject({ status: z.enum(["PASS", "PARTIAL"]), gaps: z.array(GapSchema).default([]) })
    .safeParse(input.output);
  if (!verdict.success) return { pass: true, findings: [] };
  const designDir = join(dirname(dirname(report.path)), "design");
  const index = await readOptional(join(designDir, "INDEX.md"));
  const spec = await readOptional(join(designDir, "spec.md"));
  const hasSpec = spec !== undefined && statesRules(spec);
  const data = parseReportData((await readOptional(report.path)) ?? "");
  const frameFindings =
    index === undefined ? [] : await checkFrames(index, data, verdict.data, report.path);
  const specFindings = hasSpec ? checkSpecRows(data, report.path) : [];
  const all = [...checkBlockers(data, report.path), ...frameFindings, ...specFindings];
  return { pass: all.length === 0, findings: all };
};

// What the report page shows a reader is held loosely here, so that every departure from the
// contract is named in one pass rather than the first one failing the parse.
const record = z.looseObject({});
const list = (value: unknown): readonly Record<string, unknown>[] =>
  z.array(record).safeParse(value).data ?? [];
const strings = (value: unknown): readonly string[] =>
  z.array(z.string()).safeParse(value).data ?? [];
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

// What only a proof's raw may carry: code, a computed colour, a request line.
const GROUP_WORDS = 5;
const RAW_LINES = 15;
const SCRIPT = /=>|\bfunction\s*\(|\bconst\s|\beval\b|querySelector|getBoundingClientRect/;
const TECHNICAL = /`|rgb\(|#[0-9a-f]{6}\b|getComputedStyle|\b(GET|POST|PUT|PATCH|DELETE) \//i;

// The ways one scenario departs from the shape its verdict owes, each as what to do about it.
const shapeProblems = (scenario: Record<string, unknown>): readonly string[] => {
  const driven = ["SUCCESS", "FAILURE"].includes(text(scenario["verdict"]));
  const given = strings(scenario["given"]);
  const steps = list(scenario["steps"]);
  const stepChecks = steps.flatMap((step) => list(step["checks"]));
  const designChecks = list(
    z.looseObject({ checks: z.unknown() }).safeParse(scenario["visualMatch"]).data?.checks,
  );
  const checks = [...stepChecks, ...designChecks];
  const proofs = list(scenario["proofs"]);
  const ids = proofs.map((proof) => text(proof["id"]));
  const group = text(scenario["group"]);
  const recordings = list(scenario["recordings"]);
  const drivenByHand = recordings.some((recording) => list(recording["frames"]).length > 0);
  const raws = proofs.map((proof) => text(proof["raw"]));
  const cited = checks.flatMap((check) => strings(check["proofs"]));
  const failed = checks.filter((check) => check["result"] === "fail");
  const unknown = [...new Set(cited.filter((id) => !ids.includes(id)))];
  const uncited = ids.filter((id) => id !== "" && !cited.includes(id));
  const shown = [
    text(scenario["title"]),
    group,
    ...given,
    ...steps.map((step) => text(step["when"])),
    ...checks.flatMap((check) => [text(check["text"]), text(check["saw"]), text(check["note"])]),
    ...proofs.flatMap((proof) => [text(proof["claim"]), text(proof["found"])]),
  ].filter((line) => TECHNICAL.test(line));
  const problems: readonly (readonly [boolean, string])[] = [
    [text(scenario["title"]) === "", "has no title: write the question the scenario answers"],
    [
      group === "",
      "has no group: set group to journey for a primary journey, else to the heading its group is listed under",
    ],
    [
      group.split(/\s+/).length > GROUP_WORDS,
      `has a group heading longer than ${GROUP_WORDS} words: name what its scenarios share in a few words`,
    ],
    [
      group === "journey" && recordings.length > 0 && !drivenByHand,
      "is a primary journey with no driven recording: drive it, or list it under the heading of the group it belongs to",
    ],
    [
      given.length === 0 || given.some((line) => line.trim() === ""),
      "given is not a list of setup lines: write each fact the scenario starts from as its own line",
    ],
    [
      steps.length === 0,
      "has no steps: drive it again and write each thing the user does as a step with its checks",
    ],
    [
      steps.some((step) => text(step["when"]) === ""),
      "has a step with no when: say what the user does at that step",
    ],
    [
      steps.some((step) => list(step["checks"]).length === 0) ||
        checks.some((check) => text(check["text"]) === ""),
      "has a step without at least one check that says what should be true: give every step its checks, or fold it into the next step",
    ],
    [
      driven && stepChecks.some((check) => !["pass", "fail"].includes(text(check["result"]))),
      "has a check with no result: set pass or fail on every check of a driven scenario",
    ],
    [
      failed.some((check) => text(check["saw"]) === ""),
      "has a failed check with no saw: say what was seen instead",
    ],
    [
      scenario["verdict"] === "SUCCESS" && failed.length > 0,
      "is a SUCCESS with a failed check: a failed check makes the scenario a FAILURE",
    ],
    [
      scenario["verdict"] === "FAILURE" && failed.length === 0,
      "is a FAILURE with no failed check: mark the check that failed and say what was seen",
    ],
    [
      unknown.length > 0,
      `cites ${unknown.join(", ")}, which is not the id of one of its proofs: cite each proof by its id`,
    ],
    [
      uncited.length > 0,
      `has proofs no check cites (${uncited.join(", ")}): cite each under the check it backs, or drop it`,
    ],
    [ids.includes(""), "has a proof with no id: give every proof an id its checks can cite"],
    [
      proofs.some((proof) => typeof proof["holds"] !== "boolean"),
      "has a proof whose holds is not true or false: set holds on each",
    ],
    [
      raws.some((raw) => raw.split("\n").length > RAW_LINES),
      `has a proof whose raw runs past ${RAW_LINES} lines: keep the values its checks rest on and drop the rest`,
    ],
    [
      raws.some((raw) => SCRIPT.test(raw)),
      "has a proof whose raw carries a script: say what was read in the plain first line and keep the values that came back",
    ],
    [
      shown.length > 0,
      `shows the reader a technical original ("${shown[0]}"): say it in plain words and keep the original in a proof's raw`,
    ],
  ];
  return problems.flatMap(([broken, message]) => (broken ? [message] : []));
};

// The qa stage's second verifier, for a PASS or PARTIAL. The report page shows whatever it is
// given, so the contract is held here. A scenario an older round wrote in another shape fails it,
// and is driven again.
export const checkReportShape = async (input: VerifierInput): Promise<VerifierResult> => {
  const report = input.artifacts.find(
    (artifact): artifact is FileArtifact => artifact.type === "proof-report" && "path" in artifact,
  );
  const shipped = z.looseObject({ status: z.enum(["PASS", "PARTIAL"]) }).safeParse(input.output);
  if (report === undefined || !shipped.success) return { pass: true, findings: [] };
  const data = parseReportData((await readOptional(report.path)) ?? "");
  const scenarios = list(z.looseObject({ scenarios: z.unknown() }).safeParse(data).data?.scenarios);
  const findings: Finding[] = scenarios.flatMap((scenario, i) =>
    shapeProblems(scenario).map((problem) => ({
      message: `scenario ${String(scenario["n"] ?? i + 1)} ${problem}`,
      path: report.path,
    })),
  );
  // The reader opens the report to see the happy paths first.
  if (scenarios.length > 0 && !scenarios.some((scenario) => scenario["group"] === "journey"))
    findings.push({
      message:
        "no scenario is a primary journey: set group to journey on each flow a user carries through to what the feature is for",
      path: report.path,
    });
  return { pass: findings.length === 0, findings };
};
