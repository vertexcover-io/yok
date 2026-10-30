import { type DoctorReport, DoctorReportSchema, type DoctorRow, verdict } from "@yok/core";
import type { Fire, Trigger } from "@yok/sdk/internal";
import { apiErrorText } from "./client.ts";
import type { ListedRun } from "./overview.ts";
import type { ApiError, ProjectView } from "./protocol.ts";

// The text the CLI prints and the rows a chat command replies with, so both read the same.

export type Table = Readonly<{ headers: readonly string[]; rows: readonly (readonly string[])[] }>;

// A chat reply: Slack-style text (*bold*, `code`), and a table under it.
export type Reply = Readonly<{ text: string; table?: Table }>;

const columnWidths = (
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): readonly number[] =>
  headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );

const alignRow = (values: readonly string[], widths: readonly number[]): string =>
  values
    .map((value, column) => value.padEnd(widths[column] ?? 0))
    .join("  ")
    .trimEnd();

// The table as aligned text: a header line, then one line per row.
export const renderTable = ({ headers, rows }: Table): string => {
  const widths = columnWidths(headers, rows);
  return [headers, ...rows].map((row) => alignRow(row, widths)).join("\n");
};

// The reply as plain lines: its text, then its table aligned as the CLI prints one.
export const replyText = ({ text, table }: Reply): string =>
  [text, ...(table === undefined ? [] : [renderTable(table)])]
    .filter((part) => part !== "")
    .join("\n");

// 2026-10-30T05:52:11.000Z → 10-30 05:52, short enough for a table column; the time is UTC.
export const shortTime = (iso: string): string => iso.slice(5, 16).replace("T", " ");

// Only the columns the table shows: a run read back from the API is JSON, whose type is looser
// than ListedRun's.
export type RunRow = Pick<
  ListedRun,
  "id" | "name" | "project" | "workflow" | "status" | "steps" | "startedAt"
>;
export type RunList = Readonly<{ runs: readonly RunRow[]; total: number }>;
// The flags a run list was asked with, as typed.
export type RunFlags = Readonly<{ project: string | undefined; status: string | undefined }>;

const NO_RUNS = "No runs yet. Start one with yok run";
const NO_MATCH = "No runs match";
const MORE_HINT = "Use --limit N or --all to see more";

export const runTable = (runs: readonly RunRow[]): Table => ({
  headers: ["ID", "NAME", "PROJECT", "WORKFLOW", "STATUS", "STEPS", "STARTED (UTC)"],
  rows: runs.map((run) => [
    run.id,
    run.name ?? "-",
    run.project ?? "-",
    run.workflow,
    run.status,
    `${run.steps.done}/${run.steps.total ?? "?"}`,
    shortTime(run.startedAt),
  ]),
});

// "Showing 20 of 200 runs" when cut, "12 runs" when whole; "12 demo runs" with --project demo.
const countLine = ({ runs, total }: RunList, { project }: RunFlags): string => {
  const noun = `${project === undefined ? "" : `${project} `}run${total === 1 ? "" : "s"}`;
  return runs.length === total ? `${total} ${noun}` : `Showing ${runs.length} of ${total} ${noun}`;
};

const emptyText = ({ project, status }: RunFlags): string =>
  project === undefined && status === undefined ? NO_RUNS : NO_MATCH;

// Slack cuts a table only past 100 rows, so a reply cut at the default 20 carries the hint itself.
export const runsReply = (list: RunList, flags: RunFlags): Reply => {
  if (list.total === 0) return { text: emptyText(flags) };
  const cut = list.runs.length < list.total;
  return {
    text: cut ? `${countLine(list, flags)}\n${MORE_HINT}` : countLine(list, flags),
    table: runTable(list.runs),
  };
};

export const renderRuns = (list: RunList, flags: RunFlags, terminal: boolean): string => {
  if (!terminal) return renderTable(runTable(list.runs));
  if (list.total === 0) return emptyText(flags);
  const cut = list.runs.length < list.total;
  return [
    countLine(list, flags),
    renderTable(runTable(list.runs)),
    ...(cut ? [MORE_HINT] : []),
  ].join("\n");
};

export const projectTable = (projects: readonly ProjectView[]): Table => ({
  headers: ["NAME", "STATUS", "PATH", "ADDED BY"],
  rows: projects.map((p) => [p.name, p.status, p.path, p.addedBy.name ?? p.addedBy.channel]),
});

export const renderProjects = (projects: readonly ProjectView[]): string =>
  renderTable(projectTable(projects));

export const describeFire = (fire: Fire): string =>
  [
    fire.at,
    fire.status,
    `slot ${fire.slot}`,
    ...(fire.runId === undefined ? [] : [`run ${fire.runId} (${fire.runName ?? "unnamed"})`]),
    ...(fire.reason === undefined ? [] : [fire.reason]),
  ].join("  ");

type Schedule = Pick<Trigger, "name" | "project" | "cron" | "timezone" | "nextFireAt">;

export const describeSchedule = (trigger: Schedule): string => {
  const { name, project, cron, timezone, nextFireAt } = trigger;
  return `${name} in ${project}: ${cron} (${timezone}), next fire ${nextFireAt}`;
};

type ListedTrigger = Schedule & Readonly<{ lastFire: Pick<Fire, "status" | "at"> | null }>;

export const describeTrigger = (t: ListedTrigger): string => {
  const last = t.lastFire === null ? "never fired" : `last ${t.lastFire.status} ${t.lastFire.at}`;
  return `${t.name}  ${t.project}  ${t.cron} (${t.timezone})  next ${t.nextFireAt}  ${last}`;
};

export const scheduleLine = ({ name, project, cron, timezone, nextFireAt }: Schedule): string =>
  `*${name}* in *${project}*: \`${cron}\` (${timezone}), next fire ${shortTime(nextFireAt)} UTC`;

export const fireLine = (fire: Fire): string =>
  [
    `*${fire.status}* at ${shortTime(fire.at)} UTC`,
    ...(fire.runId === undefined ? [] : [`run \`${fire.runId}\` (${fire.runName ?? "unnamed"})`]),
    ...(fire.reason === undefined ? [] : [fire.reason]),
  ].join(" · ");

export const triggerTable = (triggers: readonly ListedTrigger[]): Table => ({
  headers: ["NAME", "PROJECT", "SCHEDULE", "NEXT FIRE (UTC)", "LAST FIRE (UTC)"],
  rows: triggers.map((t) => [
    t.name,
    t.project,
    `${t.cron} (${t.timezone})`,
    shortTime(t.nextFireAt),
    t.lastFire === null ? "never" : `${t.lastFire.status} ${shortTime(t.lastFire.at)}`,
  ]),
});

export const fireTable = (fires: readonly Fire[]): Table => ({
  headers: ["AT (UTC)", "STATUS", "SLOT (UTC)", "RUN", "REASON"],
  rows: fires.map((fire) => [
    shortTime(fire.at),
    fire.status,
    shortTime(fire.slot),
    fire.runId === undefined ? "-" : `${fire.runId} (${fire.runName ?? "unnamed"})`,
    fire.reason ?? "-",
  ]),
});

const DOCTOR_HEADERS = ["CHECK", "REQUIRED", "STATUS", "DETAIL", "FIX"] as const;
// A version banner (curl prints its whole TLS stack) would push the FIX column off-screen.
const MAX_DETAIL = 64;

const cells = (row: DoctorRow): readonly string[] => [
  row.name,
  row.optional ? "no" : "yes",
  row.status.toUpperCase(),
  row.detail.length <= MAX_DETAIL ? row.detail : `${row.detail.slice(0, MAX_DETAIL - 1)}…`,
  row.status === "ok" ? "-" : (row.fix[0] ?? "-"),
];

// One line per check. A fix with several steps wraps under the FIX column.
export const renderDoctorTable = (results: readonly DoctorRow[]): string => {
  const rows = results.map(cells);
  const widths = columnWidths(DOCTOR_HEADERS, rows);
  const fixIndent = " ".repeat(widths.slice(0, -1).reduce((total, width) => total + width + 2, 0));
  const body = results.flatMap((result, index) => {
    const extraSteps = result.status === "ok" ? [] : result.fix.slice(1);
    return [
      alignRow(rows[index] ?? [], widths),
      ...extraSteps.map((step) => `${fixIndent}${step}`),
    ];
  });
  return [alignRow(DOCTOR_HEADERS, widths), ...body].join("\n");
};

const WARN_ADVICE = "Every required check passed. Each WARN costs the one stage it unblocks.";

// WHERE says where the table sits: the CLI prints it above the verdict, a chat reply below.
const advice = (report: DoctorReport, where: "above" | "below"): readonly string[] => {
  if (report.failed.length > 0) return [`Fix the FAIL rows ${where}.`];
  if (report.warned.length > 0) return [WARN_ADVICE];
  return [];
};

export const renderDoctorReport = (report: DoctorReport): string =>
  [
    "ENVIRONMENT",
    renderDoctorTable(report.results),
    "",
    "VERDICT",
    verdict(report),
    ...advice(report, "above"),
  ].join("\n");

// Unlike the CLI's table, a chat table wraps, so DETAIL keeps its whole text and FIX every step.
export const doctorReply = (report: DoctorReport): Reply => ({
  text: [`*Verdict:* ${verdict(report)}`, ...advice(report, "below")].join("\n"),
  table: {
    headers: DOCTOR_HEADERS,
    rows: report.results.map((row) => [
      row.name,
      row.optional ? "no" : "yes",
      row.status.toUpperCase(),
      row.detail,
      row.status === "ok" ? "-" : row.fix.join("\n") || "-",
    ]),
  },
});

export const blockedText = (message: string, report: DoctorReport): string =>
  [
    message,
    ...report.results
      .filter((row) => row.status === "fail")
      .flatMap((row) => [`${row.name}: ${row.detail}`, ...row.fix.map((step) => `  fix: ${step}`)]),
  ].join("\n");

// A start the doctor blocked carries its report; it reads as the failing checks and their fixes.
export const startError = (error: ApiError): string => {
  const report = DoctorReportSchema.safeParse(error.details);
  return report.success ? blockedText(error.message, report.data) : apiErrorText(error);
};

export const startErrorReply = (error: ApiError): Reply => {
  const report = DoctorReportSchema.safeParse(error.details);
  if (!report.success) return { text: apiErrorText(error) };
  const failed = report.data.results.filter((row) => row.status === "fail");
  return {
    text: `*${error.message}*`,
    table: {
      headers: ["CHECK", "DETAIL", "FIX"],
      rows: failed.map((row) => [row.name, row.detail, row.fix.join("\n") || "-"]),
    },
  };
};
