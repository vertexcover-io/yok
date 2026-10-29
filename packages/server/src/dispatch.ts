import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { type DoctorReport, DoctorReportSchema, type DoctorRow, verdict } from "@yok/core";
import type { ILogger, Result } from "@yok/sdk";
import { type Fire, parsePolicyFlags, type Trigger } from "@yok/sdk/internal";
import * as z from "zod";
import { apiErrorText, type YokClient } from "./client.ts";
import { listRunSummaries, type RunSummary } from "./overview.ts";
import { type ApiError, type ProjectView, StartRunBodySchema } from "./protocol.ts";
import { type GitDeps, type RunDeps, startProjectRun } from "./run.ts";

// The CLI prints with these too, so a command typed in Slack replies as yok --remote prints it.
const PROJECT_HEADERS = ["NAME", "STATUS", "PATH", "ADDED BY"] as const;

export const renderProjects = (projects: readonly ProjectView[]): string => {
  const rows = projects.map((p) => [p.name, p.status, p.path, p.addedBy.name ?? p.addedBy.channel]);
  const widths = PROJECT_HEADERS.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (values: readonly string[]): string =>
    values
      .map((value, column) => value.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(PROJECT_HEADERS), ...rows.map(line)].join("\n");
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

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

const cells = (row: DoctorRow): readonly string[] => [
  row.name,
  row.optional ? "no" : "yes",
  row.status.toUpperCase(),
  truncate(row.detail, MAX_DETAIL),
  row.status === "ok" ? "-" : (row.fix[0] ?? "-"),
];

// One line per check. A fix with several steps wraps under the FIX column.
export const renderTable = (results: readonly DoctorRow[]): string => {
  const rows = results.map(cells);
  const widths = DOCTOR_HEADERS.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (values: readonly string[]): string =>
    values
      .map((value, column) =>
        column === values.length - 1 ? value : value.padEnd(widths[column] ?? 0),
      )
      .join("  ")
      .trimEnd();
  const fixIndent = " ".repeat(widths.slice(0, -1).reduce((total, width) => total + width + 2, 0));
  const body = results.flatMap((result, index) => {
    const extraSteps = result.status === "ok" ? [] : result.fix.slice(1);
    return [line(rows[index] ?? []), ...extraSteps.map((step) => `${fixIndent}${step}`)];
  });
  return [line(DOCTOR_HEADERS), ...body].join("\n");
};

const FAIL_ADVICE = "Fix the FAIL rows above.";
const WARN_ADVICE = "Every required check passed. Each WARN costs the one stage it unblocks.";

const advice = (report: DoctorReport): readonly string[] => {
  if (report.failed.length > 0) return [FAIL_ADVICE];
  if (report.warned.length > 0) return [WARN_ADVICE];
  return [];
};

export const renderText = (report: DoctorReport): string =>
  [
    "ENVIRONMENT",
    renderTable(report.results),
    "",
    "VERDICT",
    verdict(report),
    ...advice(report),
  ].join("\n");

// The message a command answers under: the channel it was typed in and the thread's first message.
export type ChatThread = Readonly<{ channel: string; ts: string }>;

// Posts one message in the thread before the command's final reply.
export type Say = (text: string) => Promise<void>;

export type DispatchDeps = RunDeps &
  GitDeps &
  Readonly<{
    // the server's own API, answered in memory: a chat command runs the route yok --remote calls
    client: YokClient;
    log: ILogger;
  }>;

type Args = Readonly<{
  positionals: readonly string[];
  values: Readonly<Record<string, unknown>>;
  // a freeText command's text after its flags, as typed
  text?: string;
}>;

// readonly fields, not Readonly<…>: mapping over a type that holds YokClient makes tsc give up
// with "type instantiation is excessively deep" wherever COMMANDS is mapped.
type ChatCommand = {
  readonly words: readonly string[];
  readonly usage: string;
  readonly options: ParseArgsOptionsConfig;
  // the text after the last of its flags, or after --, is kept as typed rather than parsed
  readonly freeText?: true;
  readonly run: (args: Args, thread: ChatThread, deps: DispatchDeps, say: Say) => Promise<string>;
};

const showStatus = async (_args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const health = await deps.client.health();
  if (!health.ok) return apiErrorText(health.error);
  const { version, pid, startedAt } = health.value;
  return [
    `version  ${version}`,
    `pid      ${pid}`,
    `started  ${new Date(startedAt).toISOString()}`,
  ].join("\n");
};

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

const stringFlag = (args: Args, flag: string): string | undefined => {
  const value = args.values[flag];
  return typeof value === "string" ? value : undefined;
};

const RUN_USAGE =
  "run WORKFLOW --project NAME [--name NAME] [--config FILE] [--interaction true] [--] PROMPT...";

const SILENT_NOTIFIER =
  "this project's notifier is off, so no updates will follow here; follow the run in the dashboard";

// Nobody sits at the run's terminal, so by default no stage waits for an answer, as with
// yok --remote run.
const startRun = async (args: Args, thread: ChatThread, deps: DispatchDeps, say: Say) => {
  const [workflow, ...words] = args.positionals;
  const prompt = [words.join(" "), args.text ?? ""].filter((part) => part !== "").join(" ");
  const project = stringFlag(args, "project");
  if (workflow === undefined || project === undefined) {
    return `a WORKFLOW and --project NAME are required\nusage: ${RUN_USAGE}`;
  }
  // The flag's text, not a boolean: parsePolicyFlags reads it as YAML.
  const policies = parsePolicyFlags({ interaction: stringFlag(args, "interaction") ?? "false" });
  if (!policies.ok) return policies.error;
  const name = stringFlag(args, "name");
  const config = stringFlag(args, "config");
  const body = StartRunBodySchema.safeParse({
    project,
    workflow,
    inputs: prompt === "" ? {} : { prompt },
    ...(name === undefined ? {} : { name }),
    ...(config === undefined ? {} : { config }),
    policies: policies.value,
  });
  if (!body.success) return `bad-request: ${z.prettifyError(body.error)}`;
  await say(`starting ${workflow} on ${project}…`);
  const log = deps.log.child({ component: "slack" });
  const started = await startProjectRun(body.data, deps, log, { thread });
  if (!started.ok) return startError(started.error);
  const { run, view, threaded } = started.value;
  return [
    `${run.id} started`,
    `view: ${view}`,
    ...(threaded === true ? [] : [SILENT_NOTIFIER]),
  ].join("\n");
};

// Every --remote command names its project: the server never picks one.
const needProject = (args: Args, usage: string): Result<string> => {
  const project = stringFlag(args, "project");
  return project === undefined
    ? { ok: false, error: `--project NAME is required\nusage: ${usage}` }
    : { ok: true, value: project };
};

const listProjects = async (_args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const listed = await deps.client.projects();
  if (!listed.ok) return apiErrorText(listed.error);
  const { projects } = listed.value;
  return projects.length === 0
    ? "no projects; add one with @yok project add"
    : renderProjects(projects);
};

const ADD_USAGE = "project add NAME --git URL | --path DIR";

const addProject = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const [name] = args.positionals;
  const git = stringFlag(args, "git");
  const path = stringFlag(args, "path");
  if (name === undefined || (git === undefined && path === undefined)) {
    return `usage: ${ADD_USAGE}`;
  }
  const added = await deps.client.addProject({
    name,
    ...(git === undefined ? {} : { git }),
    ...(path === undefined ? {} : { path }),
    addedBy: { channel: "slack" },
  });
  if (!added.ok) return apiErrorText(added.error);
  return `added ${added.value.project.name}  ${added.value.project.path}`;
};

const removeProject = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const [name] = args.positionals;
  if (name === undefined) return "usage: project remove NAME [--purge]";
  const removed = await deps.client.removeProject(name, args.values.purge === true);
  if (!removed.ok) return apiErrorText(removed.error);
  const { note } = removed.value;
  return [`removed ${removed.value.removed}`, ...(note === null ? [] : [note])].join("\n");
};

const DOCTOR_USAGE = "doctor --project NAME [--workflow WF]";

const checkProject = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const project = needProject(args, DOCTOR_USAGE);
  if (!project.ok) return project.error;
  const workflow = stringFlag(args, "workflow");
  const checked = await deps.client.doctor({
    project: project.value,
    ...(workflow === undefined ? {} : { workflow }),
  });
  if (!checked.ok) return apiErrorText(checked.error);
  return renderText(DoctorReportSchema.parse(checked.value.report));
};

const listTriggers = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const listed = await deps.client.listTriggers();
  if (!listed.ok) return apiErrorText(listed.error);
  const project = stringFlag(args, "project");
  const shown = listed.value.triggers.filter((t) => project === undefined || t.project === project);
  return shown.length === 0 ? "no triggers" : shown.map(describeTrigger).join("\n");
};

const TRIGGER_ADD_USAGE = "trigger add WORKFLOW --project NAME [--config FILE]";

const addTrigger = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const [workflow] = args.positionals;
  const project = needProject(args, TRIGGER_ADD_USAGE);
  if (!project.ok) return project.error;
  if (workflow === undefined) return `usage: ${TRIGGER_ADD_USAGE}`;
  const config = stringFlag(args, "config");
  const added = await deps.client.addTrigger({
    project: project.value,
    workflow,
    ...(config === undefined ? {} : { config }),
  });
  return added.ok ? describeSchedule(added.value.trigger) : apiErrorText(added.error);
};

// fire, log and rm each name one trigger by its name and project.
const triggerRef = (
  args: Args,
  verb: string,
): Result<Readonly<{ project: string; name: string }>> => {
  const usage = `trigger ${verb} NAME --project NAME`;
  const [name] = args.positionals;
  const project = needProject(args, usage);
  if (!project.ok) return project;
  return name === undefined
    ? { ok: false, error: `usage: ${usage}` }
    : { ok: true, value: { project: project.value, name } };
};

const fireTrigger = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const ref = triggerRef(args, "fire");
  if (!ref.ok) return ref.error;
  const fired = await deps.client.fireTrigger(ref.value);
  return fired.ok ? describeFire(fired.value.fire) : apiErrorText(fired.error);
};

const triggerLog = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const ref = triggerRef(args, "log");
  if (!ref.ok) return ref.error;
  const logged = await deps.client.triggerLog(ref.value);
  if (!logged.ok) return apiErrorText(logged.error);
  const { fires } = logged.value;
  return fires.length === 0 ? "never fired" : fires.map(describeFire).join("\n");
};

const removeTrigger = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const ref = triggerRef(args, "rm");
  if (!ref.ok) return ref.error;
  const removed = await deps.client.removeTrigger(ref.value);
  if (!removed.ok) return apiErrorText(removed.error);
  return `removed ${ref.value.name} from ${ref.value.project}`;
};

const RUNS_SHOWN = 20;

const runLine = (run: RunSummary): string =>
  [
    run.id,
    run.name ?? "-",
    run.workflow,
    run.status,
    `${run.steps.done}/${run.steps.total ?? "?"}`,
    run.startedAt,
  ].join("  ");

// A project's runs are the ones whose checkout is its folder.
const projectFolder = async (deps: DispatchDeps, name: string): Promise<Result<string>> => {
  const listed = await deps.client.projects();
  if (!listed.ok) return { ok: false, error: apiErrorText(listed.error) };
  const found = listed.value.projects.find((project) => project.name === name);
  return found === undefined
    ? { ok: false, error: `not-found: no project named ${name}` }
    : { ok: true, value: found.path };
};

// Every project's runs, newest first, or only --project's.
const projectRuns = async (
  args: Args,
  deps: DispatchDeps,
): Promise<Result<readonly RunSummary[]>> => {
  const project = stringFlag(args, "project");
  const folder = project === undefined ? undefined : await projectFolder(deps, project);
  if (folder !== undefined && !folder.ok) return folder;
  const runs = await listRunSummaries(deps.registry, deps.host);
  return {
    ok: true,
    value: runs.filter((run) => folder === undefined || run.cwd === folder.value),
  };
};

// Filter before slicing: the list spans every project.
const listRuns = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const runs = await projectRuns(args, deps);
  if (!runs.ok) return runs.error;
  const shown = runs.value.slice(0, RUNS_SHOWN);
  return shown.length === 0 ? "no runs" : shown.map(runLine).join("\n");
};

const RUN_STATUS_USAGE = "run status RUN [--project NAME]";

// An id names one run; a name can recur across projects, so a shared one is refused.
const findRun = (runs: readonly RunSummary[], key: string): Result<RunSummary | undefined> => {
  const byId = runs.find((run) => run.id === key);
  if (byId !== undefined) return { ok: true, value: byId };
  const named = runs.filter((run) => run.name === key);
  if (named.length <= 1) return { ok: true, value: named[0] };
  const ids = named.map((run) => run.id).join(", ");
  return {
    ok: false,
    error: `ambiguous: runs ${ids} are named ${key}; pass --project NAME or the run id`,
  };
};

const showRun = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const [key] = args.positionals;
  if (key === undefined) return `usage: ${RUN_STATUS_USAGE}`;
  const runs = await projectRuns(args, deps);
  if (!runs.ok) return runs.error;
  const found = findRun(runs.value, key);
  if (!found.ok) return found.error;
  const run = found.value;
  if (run === undefined) return `not-found: no run ${key}`;
  const { current, blocker, steps } = run;
  const step = current === null ? "-" : `${current} (${steps.done}/${steps.total ?? "?"})`;
  const blocked =
    blocker === null
      ? "-"
      : `${blocker.reason}${blocker.node === undefined ? "" : ` at ${blocker.node}`}`;
  return [
    `id        ${run.id}`,
    `name      ${run.name ?? "-"}`,
    `workflow  ${run.workflow}`,
    `status    ${run.status}`,
    `step      ${step}`,
    `blocked   ${blocked}`,
    `pr        ${run.pr ?? "-"}`,
    `view      ${deps.publicOrigin}/runs/${run.id}`,
  ].join("\n");
};

const PROJECT_FLAG = { project: { type: "string" } } as const;

const COMMANDS: readonly ChatCommand[] = [
  { words: ["runs"], usage: "runs [--project NAME]", options: PROJECT_FLAG, run: listRuns },
  { words: ["run", "status"], usage: RUN_STATUS_USAGE, options: PROJECT_FLAG, run: showRun },
  {
    words: ["run"],
    usage: RUN_USAGE,
    options: {
      project: { type: "string" },
      name: { type: "string" },
      config: { type: "string" },
      interaction: { type: "string" },
    },
    freeText: true,
    run: startRun,
  },
  { words: ["status"], usage: "status", options: {}, run: showStatus },
  { words: ["project", "list"], usage: "project list", options: {}, run: listProjects },
  {
    words: ["project", "add"],
    usage: ADD_USAGE,
    options: { git: { type: "string" }, path: { type: "string" } },
    run: addProject,
  },
  {
    words: ["project", "remove"],
    usage: "project remove NAME [--purge]",
    options: { purge: { type: "boolean" } },
    run: removeProject,
  },
  {
    words: ["doctor"],
    usage: DOCTOR_USAGE,
    options: { ...PROJECT_FLAG, workflow: { type: "string" } },
    run: checkProject,
  },
  {
    words: ["trigger", "list"],
    usage: "trigger list [--project NAME]",
    options: PROJECT_FLAG,
    run: listTriggers,
  },
  {
    words: ["trigger", "add"],
    usage: TRIGGER_ADD_USAGE,
    options: { ...PROJECT_FLAG, config: { type: "string" } },
    run: addTrigger,
  },
  {
    words: ["trigger", "fire"],
    usage: "trigger fire NAME --project NAME",
    options: PROJECT_FLAG,
    run: fireTrigger,
  },
  {
    words: ["trigger", "log"],
    usage: "trigger log NAME --project NAME",
    options: PROJECT_FLAG,
    run: triggerLog,
  },
  {
    words: ["trigger", "rm"],
    usage: "trigger rm NAME --project NAME",
    options: PROJECT_FLAG,
    run: removeTrigger,
  },
  { words: ["help"], usage: "help", options: {}, run: async () => helpText() },
];

const helpText = (): string =>
  ["Type @yok and one of:", ...COMMANDS.map((command) => `  ${command.usage}`)].join("\n");

// Slack sends a link as <url> or <url|label>, and &, < and > as entities.
const plainWord = (token: string): string =>
  token
    .replace(/^<([^|>]+)(?:\|[^>]*)?>$/, "$1")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

// Slack turns straight quotes into curly ones, so no quoting is honoured: words split on
// whitespace only.
export const splitWords = (text: string): readonly string[] =>
  text
    .split(/\s+/)
    .filter((word) => word !== "")
    .map(plainWord);

// The longest match wins, so `run status r-1` is never read as running a workflow named status.
const findCommand = (words: readonly string[]): ChatCommand | undefined =>
  [...COMMANDS]
    .sort((a, b) => b.words.length - a.words.length)
    .find((command) => command.words.every((word, index) => words[index] === word));

type Token = Readonly<{ word: string; at: number }>;

// A prompt keeps its spacing, newlines and words like --verbose: what follows --, or else the
// last of the command's own flags and its value, is taken as typed.
const splitFreeText = (
  tokens: readonly Token[],
  text: string,
  options: ParseArgsOptionsConfig,
): Readonly<{ words: readonly string[]; text: string }> => {
  const isFlag = ({ word }: Token) =>
    word.startsWith("--") && Object.hasOwn(options, word.slice(2).split("=")[0] ?? "");
  const dashes = tokens.findIndex(({ word }) => word === "--");
  const last = tokens.findLastIndex(isFlag);
  const flagEnd = last + (tokens[last]?.word.includes("=") === true ? 1 : 2);
  const end = dashes !== -1 ? dashes : last === -1 ? tokens.length : flagEnd;
  const start = dashes !== -1 ? dashes + 1 : end;
  const from = tokens[start]?.at ?? text.length;
  return {
    words: tokens.slice(0, end).map(({ word }) => plainWord(word)),
    text: text.slice(from).trim().replace(/\S+/g, plainWord),
  };
};

const parseWords = (args: readonly string[], options: ParseArgsOptionsConfig): Result<Args> => {
  try {
    const { positionals, values } = parseArgs({
      args: [...args],
      options,
      allowPositionals: true,
      strict: true,
    });
    return { ok: true, value: { positionals, values } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

// The words after the mention in, the final reply text out. `say` posts anything the command
// reports before it finishes.
export const dispatchCommand = async (
  text: string,
  thread: ChatThread,
  deps: DispatchDeps,
  say: Say,
): Promise<string> => {
  const words = splitWords(text);
  if (words.length === 0) return helpText();
  const command = findCommand(words);
  if (command === undefined) {
    return [`unknown command: ${words.join(" ")}`, "", helpText()].join("\n");
  }
  const tokens = [...text.matchAll(/\S+/g)].map((match) => ({ word: match[0], at: match.index }));
  const split =
    command.freeText === true
      ? splitFreeText(tokens.slice(command.words.length), text, command.options)
      : { words: words.slice(command.words.length), text: undefined };
  const parsed = parseWords(split.words, command.options);
  if (!parsed.ok) return `${parsed.error}\nusage: ${command.usage}`;
  const args = split.text === undefined ? parsed.value : { ...parsed.value, text: split.text };
  return command.run(args, thread, deps, say);
};
