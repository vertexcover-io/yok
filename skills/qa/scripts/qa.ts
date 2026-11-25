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
  req: z.array(NonEmptyStringSchema).optional(),
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
  // A scenario told in parts keeps each part's steps and takes; read together, they are its own.
  const parts = list(scenario["parts"]);
  const topSteps = list(scenario["steps"]);
  const steps = [...parts.flatMap((part) => list(part["steps"])), ...topSteps];
  const stepChecks = steps.flatMap((step) => list(step["checks"]));
  const designChecks = list(
    z.looseObject({ checks: z.unknown() }).safeParse(scenario["visualMatch"]).data?.checks,
  );
  const checks = [...stepChecks, ...designChecks];
  const proofs = list(scenario["proofs"]);
  const ids = proofs.map((proof) => text(proof["id"]));
  const group = text(scenario["group"]);
  const recordings = [
    ...parts.flatMap((part) => list(part["recordings"])),
    ...list(scenario["recordings"]),
  ];
  const phoneOnly = (part: Record<string, unknown>): boolean => {
    const takes = list(part["recordings"]);
    return takes.length > 0 && takes.every((recording) => recording["size"] === "phone");
  };
  const drivenByHand = recordings.some((recording) => list(recording["frames"]).length > 0);
  const phone = record.safeParse(scenario["phone"]).data ?? {};
  const phoneDecided =
    ["required", "not needed"].includes(text(phone["replay"])) && text(phone["why"]) !== "";
  const filmedOnPhone = recordings.some(
    (recording) => recording["size"] === "phone" && list(recording["frames"]).length > 0,
  );
  const thirdParty = text(scenario["thirdParty"]);
  const filmedOnThirdParty = recordings.some(
    (recording) =>
      text(recording["thirdParty"]) === thirdParty && list(recording["frames"]).length > 0,
  );
  const raws = proofs.map((proof) => text(proof["raw"]));
  const cited = checks.flatMap((check) => strings(check["proofs"]));
  const failed = checks.filter((check) => check["result"] === "fail");
  // a check left without a result was never reached, so it has nothing to cite
  const unproven = checks.filter(
    (check) => text(check["result"]) !== "" && strings(check["proofs"]).length === 0,
  );
  const unknown = [...new Set(cited.filter((id) => !ids.includes(id)))];
  const uncited = ids.filter((id) => id !== "" && !cited.includes(id));
  const shared = [...new Set(cited.filter((id, i) => cited.indexOf(id) !== i))];
  const unsourced = proofs.filter(
    (proof) => text(proof["raw"]) === "" && text(proof["image"]) === "",
  );
  const pictured = new Set(
    proofs.filter((proof) => text(proof["image"]) !== "").map((proof) => text(proof["id"])),
  );
  const doubled = checks.filter((check) => {
    const own = strings(check["proofs"]);
    return own.some((id) => pictured.has(id)) && own.some((id) => !pictured.has(id));
  });
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
      text(scenario["title"]) !== "" && !text(scenario["title"]).endsWith("?"),
      "has a title that is not a question: ask whether the user's action gets the exact outcome expected",
    ],
    [
      parts.some((part) => text(part["title"]) === ""),
      "has a part with no title: name the stretch of the flow each part covers",
    ],
    [
      parts.length > 0 && topSteps.length > 0,
      "has both parts and top-level steps: put every step in the part it belongs to",
    ],
    [
      parts.length > 0 && list(scenario["recordings"]).length > 0,
      "has both parts and top-level recordings: put every recording in the part it films",
    ],
    [
      parts.some(phoneOnly),
      "has a phone replay written as a part of its own: add it as a recording of the part it replays, with its checks under that part's steps",
    ],
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
      recordings.some((recording) => text(recording["browser"]) !== "") && !phoneDecided,
      "has no phone decision: set phone.replay to required where it shows a screen this change adds or lays out anew, else to not needed, and give the reason in phone.why",
    ],
    [
      driven && phone["replay"] === "required" && !filmedOnPhone,
      "owes a phone replay it does not have: film it on the phone as a recording whose size is phone, or grade it NOT VERIFIED",
    ],
    [
      driven && thirdParty !== "" && !filmedOnThirdParty,
      `reads the screen of ${thirdParty} with no take of it: film it on that screen, signed in, as a recording whose thirdParty names it, or grade it NOT VERIFIED`,
    ],
    [
      !driven && thirdParty !== "" && stepChecks.some((check) => text(check["result"]) !== ""),
      `carries a result on a check of ${thirdParty}'s screen it could not open: leave every check of a NOT VERIFIED scenario without a result`,
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
      unproven.length > 0,
      "has a check with a result that cites no proof: cite the frame that shows it or a reading from its source",
    ],
    [
      unknown.length > 0,
      `cites ${unknown.join(", ")}, which is not the id of one of its proofs: cite each proof by its id`,
    ],
    [
      uncited.length > 0,
      `has proofs no check cites (${uncited.join(", ")}): cite each under the check it backs, or drop it`,
    ],
    [
      shared.length > 0,
      `has proofs cited by more than one check (${shared.join(", ")}): give each check a proof of its own`,
    ],
    [
      unsourced.length > 0,
      "has a proof with no reading and no picture: give it the raw read from its source or the frame that shows the check, or drop it",
    ],
    [
      doubled.length > 0,
      "has a check citing both a picture and a reading: the frame that shows a check is its whole proof, so drop the reading",
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
// The verdict is read off coverage[], never chosen: any FAILURE row fails the feature, else any
// NOT VERIFIED row leaves it PARTIAL.
const derivedVerdict = (coverage: readonly Record<string, unknown>[]): string => {
  const verdicts = coverage.map((row) => text(row["verdict"]));
  if (verdicts.includes("FAILURE")) return "FAIL";
  return verdicts.includes("NOT VERIFIED") ? "PARTIAL" : "PASS";
};

const checksOf = (scenario: Record<string, unknown>): readonly Record<string, unknown>[] => {
  const steps = [
    ...list(scenario["parts"]).flatMap((part) => list(part["steps"])),
    ...list(scenario["steps"]),
  ];
  const design = z.looseObject({ checks: z.unknown() }).safeParse(scenario["visualMatch"]).data;
  return [...steps.flatMap((step) => list(step["checks"])), ...list(design?.checks)];
};

// A row's verdict comes from the checks that prove its requirement, so one failed check does not
// fail every requirement that shares its scenario.
const rowVerdict = (checks: readonly Record<string, unknown>[]): string => {
  const results = checks.map((check) => text(check["result"]));
  if (results.includes("fail")) return "FAILURE";
  return results.every((result) => result === "pass") ? "SUCCESS" : "NOT VERIFIED";
};

const coverageProblems = (data: unknown): readonly string[] => {
  const report = z
    .looseObject({ coverage: z.unknown(), scenarios: z.unknown() })
    .safeParse(data).data;
  const checks = list(report?.scenarios).flatMap(checksOf);
  const rows = list(report?.coverage);
  const listed = new Set(rows.map((row) => text(row["req"])));
  // a requirement with no row drops out of the derived verdict, failed checks and all
  const unlisted = [...new Set(checks.flatMap((check) => strings(check["req"])))]
    .filter((req) => !listed.has(req))
    .map(
      (req) =>
        `checks carry ${req}, but coverage[] has no ${req} row: give every requirement a check carries its row`,
    );
  return [
    ...unlisted,
    ...rows.flatMap((row) => {
      const req = text(row["req"]);
      const written = text(row["verdict"]);
      if (req === "" || written === "INVALID") return [];
      const proving = checks.filter((check) => strings(check["req"]).includes(req));
      if (proving.length === 0)
        return written === "NOT VERIFIED"
          ? []
          : [
              `coverage row ${req} names no check: put ${req} in the req of every check that proves it`,
            ];
      const derived = rowVerdict(proving);
      return derived === written
        ? []
        : [
            `coverage row ${req} is ${written} but the checks carrying ${req} give ${derived}: grade each row by its own checks`,
          ];
    }),
  ];
};

const verdictProblems = (data: unknown, status: string): readonly string[] => {
  const report = z
    .looseObject({ coverage: z.unknown(), verdict: z.unknown() })
    .safeParse(data).data;
  const coverage = list(report?.coverage);
  if (coverage.length === 0) return [];
  const derived = derivedVerdict(coverage);
  const written = text(report?.verdict);
  return [
    ...(derived === status
      ? []
      : [
          `the stage returned ${status} but coverage[] derives ${derived}: return the verdict coverage[] gives`,
        ]),
    ...(written === "" || written === derived
      ? []
      : [
          `the report's verdict is ${written} but coverage[] derives ${derived}: write the verdict coverage[] gives`,
        ]),
  ];
};

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
  for (const message of [...coverageProblems(data), ...verdictProblems(data, shipped.data.status)])
    findings.push({ message, path: report.path });
  // The reader opens the report to see the happy paths first.
  if (scenarios.length > 0 && !scenarios.some((scenario) => scenario["group"] === "journey"))
    findings.push({
      message:
        "no scenario is a primary journey: set group to journey on each flow a user carries through to what the feature is for",
      path: report.path,
    });
  return { pass: findings.length === 0, findings };
};
