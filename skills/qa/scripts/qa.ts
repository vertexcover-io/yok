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

// A scenario's screen read against its design, as the report's data island holds it.
export const VisualMatchSchema = z.strictObject({
  baseline: NonEmptyStringSchema.nullable(),
  fidelity: z.number().min(0).max(100).nullable(),
  matched: z.string().optional(),
  // the screen re-shot at the width the design was drawn at, report-relative, and that width
  build: NonEmptyStringSchema.optional(),
  width: z.int().positive().optional(),
  // each design/spec.md rule a plan step cites, and whether the build kept it
  specRules: z
    .array(
      z.strictObject({
        rule: NonEmptyStringSchema,
        held: z.boolean(),
        evidence: NonEmptyStringSchema,
      }),
    )
    .optional(),
  findings: z
    .array(
      z.strictObject({
        severity: z.enum(["BLOCKER", "HIGH"]),
        what: NonEmptyStringSchema,
        baselineShows: z.string(),
        buildShows: z.string(),
        evidence: NonEmptyStringSchema,
      }),
    )
    .optional(),
});

const ReportScenariosSchema = z.looseObject({
  scenarios: z.array(z.looseObject({ visualMatch: VisualMatchSchema.optional() })),
});

const readOptional = (path: string): Promise<string | undefined> =>
  readFile(path, "utf8").catch(() => undefined);

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
  const baselines = new Set(
    parsed.data.scenarios.flatMap(({ visualMatch }) =>
      typeof visualMatch?.baseline === "string"
        ? [relative(artifactsDir, resolve(verificationDir, visualMatch.baseline))]
        : [],
    ),
  );
  return indexedFrames(index)
    .filter(({ frame }) => !isNotBuilt(frame, plan) && !baselines.has(frame) && !isExcused(frame))
    .map(({ frame }) => ({
      message: `${frame} is a frame the plan builds, but no scenario's visualMatch.baseline is ../${frame}: compare the scenario on that screen against it, or, when that screen could not be reached, name ${frame} in the mechanism of the gaps[] entry that says why`,
      path: reportPath,
    }));
};

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

// The qa stage's verifier, for a PASS or PARTIAL: checkFrames when the run has design/INDEX.md,
// and checkSpecRows when it has design/spec.md. A FAIL is not rejected, so its bugs reach the fix
// loop.
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
  const hasSpec = (await readOptional(join(designDir, "spec.md"))) !== undefined;
  if (index === undefined && !hasSpec) return { pass: true, findings: [] };
  const data = parseReportData((await readOptional(report.path)) ?? "");
  const frameFindings =
    index === undefined ? [] : await checkFrames(index, data, verdict.data, report.path);
  const specFindings = hasSpec ? checkSpecRows(data, report.path) : [];
  const all = [...frameFindings, ...specFindings];
  return { pass: all.length === 0, findings: all };
};
