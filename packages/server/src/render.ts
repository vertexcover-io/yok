import { type DoctorReport, DoctorReportSchema, type DoctorRow, verdict } from "@yok/core";
import type { Fire, Trigger } from "@yok/sdk/internal";
import { apiErrorText } from "./client.ts";
import type { ApiError, ProjectView } from "./protocol.ts";

// The text the CLI prints and a chat command replies with, so both read the same.

const columnWidths = (
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): readonly number[] =>
  headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );

// Two spaces between columns; trimEnd drops the last column's padding.
const alignRow = (values: readonly string[], widths: readonly number[]): string =>
  values
    .map((value, column) => value.padEnd(widths[column] ?? 0))
    .join("  ")
    .trimEnd();

const PROJECT_HEADERS = ["NAME", "STATUS", "PATH", "ADDED BY"] as const;

export const renderProjects = (projects: readonly ProjectView[]): string => {
  const rows = projects.map((p) => [p.name, p.status, p.path, p.addedBy.name ?? p.addedBy.channel]);
  const widths = columnWidths(PROJECT_HEADERS, rows);
  return [PROJECT_HEADERS, ...rows].map((row) => alignRow(row, widths)).join("\n");
};

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

const FAIL_ADVICE = "Fix the FAIL rows above.";
const WARN_ADVICE = "Every required check passed. Each WARN costs the one stage it unblocks.";

const advice = (report: DoctorReport): readonly string[] => {
  if (report.failed.length > 0) return [FAIL_ADVICE];
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
    ...advice(report),
  ].join("\n");

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
