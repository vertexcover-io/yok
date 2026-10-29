import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { DoctorReportSchema } from "@yok/core";
import type { ILogger, Result } from "@yok/sdk";
import { parsePolicyFlags } from "@yok/sdk/internal";
import * as z from "zod";
import { apiErrorText, type YokClient } from "./client.ts";
import { listRunSummaries, type RunSummary } from "./overview.ts";
import { type ApiError, StartRunBodySchema } from "./protocol.ts";
import {
  describeFire,
  describeSchedule,
  describeTrigger,
  renderDoctorReport,
  renderProjects,
  startError,
} from "./render.ts";
import { type GitDeps, type RunDeps, startProjectRun } from "./run.ts";

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

// A reply the person reads as is. With `usage`, dispatchCommand adds the command's usage line.
class ChatError extends Error {
  constructor(
    message: string,
    readonly usage = false,
  ) {
    super(message);
  }
}

const needsUsage = (problem = ""): ChatError => new ChatError(problem, true);

const unwrapApi = <T>(result: Result<T, ApiError>): T => {
  if (!result.ok) throw new ChatError(apiErrorText(result.error));
  return result.value;
};

const stringFlag = (args: Args, flag: string): string | undefined => {
  const value = args.values[flag];
  return typeof value === "string" ? value : undefined;
};

// Every --remote command names its project: the server never picks one.
const requireProject = (args: Args): string => {
  const project = stringFlag(args, "project");
  if (project === undefined) throw needsUsage("--project NAME is required");
  return project;
};

const showStatus = async (_args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const { version, pid, startedAt } = unwrapApi(await deps.client.health());
  return [
    `version  ${version}`,
    `pid      ${pid}`,
    `started  ${new Date(startedAt).toISOString()}`,
  ].join("\n");
};

const SILENT_NOTIFIER =
  "this project's notifier is off, so no updates will follow here; follow the run in the dashboard";

// Nobody sits at the run's terminal, so by default no stage waits for an answer, as with
// yok --remote run.
const startRun = async (args: Args, thread: ChatThread, deps: DispatchDeps, say: Say) => {
  const [workflow, ...words] = args.positionals;
  const prompt = [words.join(" "), args.text ?? ""].filter((part) => part !== "").join(" ");
  const project = stringFlag(args, "project");
  if (workflow === undefined || project === undefined) {
    throw needsUsage("a WORKFLOW and --project NAME are required");
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

const listProjects = async (_args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const { projects } = unwrapApi(await deps.client.projects());
  return projects.length === 0
    ? "no projects; add one with @yok project add"
    : renderProjects(projects);
};

const addProject = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const [name] = args.positionals;
  const git = stringFlag(args, "git");
  const path = stringFlag(args, "path");
  if (name === undefined || (git === undefined && path === undefined)) throw needsUsage();
  const { project } = unwrapApi(
    await deps.client.addProject({
      name,
      ...(git === undefined ? {} : { git }),
      ...(path === undefined ? {} : { path }),
      addedBy: { channel: "slack" },
    }),
  );
  return `added ${project.name}  ${project.path}`;
};

const removeProject = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const [name] = args.positionals;
  if (name === undefined) throw needsUsage();
  const { removed, note } = unwrapApi(
    await deps.client.removeProject(name, args.values.purge === true),
  );
  return [`removed ${removed}`, ...(note === null ? [] : [note])].join("\n");
};

const runDoctor = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const project = requireProject(args);
  const workflow = stringFlag(args, "workflow");
  const { report } = unwrapApi(
    await deps.client.doctor({ project, ...(workflow === undefined ? {} : { workflow }) }),
  );
  return renderDoctorReport(DoctorReportSchema.parse(report));
};

const listTriggers = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const { triggers } = unwrapApi(await deps.client.listTriggers());
  const project = stringFlag(args, "project");
  const shown = triggers.filter((t) => project === undefined || t.project === project);
  return shown.length === 0 ? "no triggers" : shown.map(describeTrigger).join("\n");
};

const addTrigger = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const [workflow] = args.positionals;
  const project = requireProject(args);
  if (workflow === undefined) throw needsUsage();
  const config = stringFlag(args, "config");
  const { trigger } = unwrapApi(
    await deps.client.addTrigger({
      project,
      workflow,
      ...(config === undefined ? {} : { config }),
    }),
  );
  return describeSchedule(trigger);
};

// fire, log and rm each name one trigger by its name and project.
const triggerRef = (args: Args): Readonly<{ project: string; name: string }> => {
  const [name] = args.positionals;
  const project = requireProject(args);
  if (name === undefined) throw needsUsage();
  return { project, name };
};

const fireTrigger = async (args: Args, _thread: ChatThread, deps: DispatchDeps) =>
  describeFire(unwrapApi(await deps.client.fireTrigger(triggerRef(args))).fire);

const triggerLog = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const { fires } = unwrapApi(await deps.client.triggerLog(triggerRef(args)));
  return fires.length === 0 ? "never fired" : fires.map(describeFire).join("\n");
};

const removeTrigger = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const ref = triggerRef(args);
  unwrapApi(await deps.client.removeTrigger(ref));
  return `removed ${ref.name} from ${ref.project}`;
};

const RUNS_SHOWN = 20;

// Every project's runs, newest first, or only --project's: a project's runs are the ones whose
// checkout is its folder.
const projectRuns = async (args: Args, deps: DispatchDeps): Promise<readonly RunSummary[]> => {
  const name = stringFlag(args, "project");
  const runs = await listRunSummaries(deps.registry, deps.host);
  if (name === undefined) return runs;
  const { projects } = unwrapApi(await deps.client.projects());
  const project = projects.find((p) => p.name === name);
  if (project === undefined) throw new ChatError(`not-found: no project named ${name}`);
  return runs.filter((run) => run.cwd === project.path);
};

// Filter before slicing: the list spans every project.
const listRuns = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const shown = (await projectRuns(args, deps)).slice(0, RUNS_SHOWN);
  if (shown.length === 0) return "no runs";
  return shown
    .map((run) =>
      [
        run.id,
        run.name ?? "-",
        run.workflow,
        run.status,
        `${run.steps.done}/${run.steps.total ?? "?"}`,
        run.startedAt,
      ].join("  "),
    )
    .join("\n");
};

// An id names one run; a name can recur across projects, so a shared one is refused.
const findRun = (runs: readonly RunSummary[], key: string): RunSummary | undefined => {
  const byId = runs.find((run) => run.id === key);
  if (byId !== undefined) return byId;
  const named = runs.filter((run) => run.name === key);
  if (named.length <= 1) return named[0];
  const ids = named.map((run) => run.id).join(", ");
  throw new ChatError(`ambiguous: runs ${ids} are named ${key}; pass --project NAME or the run id`);
};

const showRun = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const [key] = args.positionals;
  if (key === undefined) throw needsUsage();
  const run = findRun(await projectRuns(args, deps), key);
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

// In the order help lists them.
const COMMANDS: readonly ChatCommand[] = [
  { words: ["runs"], usage: "runs [--project NAME]", options: PROJECT_FLAG, run: listRuns },
  {
    words: ["run", "status"],
    usage: "run status RUN [--project NAME]",
    options: PROJECT_FLAG,
    run: showRun,
  },
  {
    words: ["run"],
    usage:
      "run WORKFLOW --project NAME [--name NAME] [--config FILE] [--interaction true] [--] PROMPT...",
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
    usage: "project add NAME --git URL | --path DIR",
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
    usage: "doctor --project NAME [--workflow WF]",
    options: { ...PROJECT_FLAG, workflow: { type: "string" } },
    run: runDoctor,
  },
  {
    words: ["trigger", "list"],
    usage: "trigger list [--project NAME]",
    options: PROJECT_FLAG,
    run: listTriggers,
  },
  {
    words: ["trigger", "add"],
    usage: "trigger add WORKFLOW --project NAME [--config FILE]",
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

// The longest match wins, so `run status r-1` is never read as running a workflow named status.
const LONGEST_FIRST = [...COMMANDS].sort((a, b) => b.words.length - a.words.length);

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

type Token = Readonly<{ word: string; at: number }>;

// Where the command's own words end: at --, else after the last of its flags and that flag's
// value, else at the end of the text.
const flagsEnd = (tokens: readonly Token[], options: ParseArgsOptionsConfig): number => {
  const dashes = tokens.findIndex(({ word }) => word === "--");
  if (dashes !== -1) return dashes;
  const last = tokens.findLastIndex(
    ({ word }) =>
      word.startsWith("--") && Object.hasOwn(options, word.slice(2).split("=")[0] ?? ""),
  );
  if (last === -1) return tokens.length;
  return last + (tokens[last]?.word.includes("=") === true ? 1 : 2);
};

// A prompt keeps its spacing, newlines and words like --verbose: what follows --, or else the
// last of the command's own flags and its value, is taken as typed.
const splitFreeText = (
  tokens: readonly Token[],
  text: string,
  options: ParseArgsOptionsConfig,
): Readonly<{ words: readonly string[]; text: string }> => {
  const end = flagsEnd(tokens, options);
  const start = tokens[end]?.word === "--" ? end + 1 : end;
  const from = tokens[start]?.at ?? text.length;
  return {
    words: tokens.slice(0, end).map(({ word }) => plainWord(word)),
    text: text.slice(from).trim().replace(/\S+/g, plainWord),
  };
};

const parseWords = (args: readonly string[], options: ParseArgsOptionsConfig): Args => {
  try {
    const { positionals, values } = parseArgs({
      args: [...args],
      options,
      allowPositionals: true,
      strict: true,
    });
    return { positionals, values };
  } catch (error) {
    throw needsUsage(error instanceof Error ? error.message : String(error));
  }
};

const commandArgs = (command: ChatCommand, text: string, words: readonly string[]): Args => {
  if (command.freeText !== true)
    return parseWords(words.slice(command.words.length), command.options);
  const tokens = [...text.matchAll(/\S+/g)].map((match) => ({ word: match[0], at: match.index }));
  const split = splitFreeText(tokens.slice(command.words.length), text, command.options);
  return { ...parseWords(split.words, command.options), text: split.text };
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
  const command = LONGEST_FIRST.find((c) => c.words.every((word, index) => words[index] === word));
  if (command === undefined) {
    return [`unknown command: ${words.join(" ")}`, "", helpText()].join("\n");
  }
  try {
    return await command.run(commandArgs(command, text, words), thread, deps, say);
  } catch (error) {
    if (!(error instanceof ChatError)) throw error;
    const usage = error.usage ? [`usage: ${command.usage}`] : [];
    return [error.message, ...usage].filter((line) => line !== "").join("\n");
  }
};
