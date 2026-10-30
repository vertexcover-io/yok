import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { DoctorReportSchema } from "@yok/core";
import { type ILogger, POLICY_NAMES, type Result } from "@yok/sdk";
import { parsePolicyFlags } from "@yok/sdk/internal";
import * as z from "zod";
import { apiErrorText, type YokClient } from "./client.ts";
import { type ApiError, StartRunBodySchema } from "./protocol.ts";
import {
  doctorReply,
  fireLine,
  fireTable,
  projectTable,
  type Reply,
  runsReply,
  scheduleLine,
  shortTime,
  startErrorReply,
  triggerTable,
} from "./render.ts";
import { type ChatThread, type GitDeps, type RunDeps, startProjectRun } from "./run.ts";

// Posts one message in the thread before the command's final reply.
export type Say = (reply: Reply) => Promise<void>;

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
}>;

// readonly fields, not Readonly<…>: mapping over a type that holds YokClient makes tsc give up
// with "type instantiation is excessively deep" wherever COMMANDS is mapped.
type ChatCommand = {
  readonly words: readonly string[];
  readonly usage: string;
  readonly options: ParseArgsOptionsConfig;
  readonly run: (args: Args, thread: ChatThread, deps: DispatchDeps, say: Say) => Promise<Reply>;
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

const stringsFlag = (args: Args, flag: string): readonly string[] => {
  const value = args.values[flag];
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
};

// Every --remote command names its project: the server never picks one.
const requireProject = (args: Args): string => {
  const project = stringFlag(args, "project");
  if (project === undefined) throw needsUsage("--project NAME is required");
  return project;
};

const showStatus = async (_args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const { version, pid, startedAt } = unwrapApi(await deps.client.health());
  const started = shortTime(new Date(startedAt).toISOString());
  return { text: `*Version* \`${version}\` · *PID* \`${pid}\` · *Started* ${started} UTC` };
};

const SILENT_NOTIFIER =
  "this project's notifier is off, so no updates will follow here; follow the run in the dashboard";

const QUESTIONS_OFF = "questions stay off: nobody is at the terminal of a run started from Slack";

// --input KEY=VALUE, repeatable, as yok run takes it.
const runInputs = (pairs: readonly string[]): Readonly<Record<string, string>> =>
  Object.fromEntries(
    pairs.map((pair) => {
      const at = pair.indexOf("=");
      if (at === -1) throw needsUsage(`--input must be KEY=VALUE, got "${pair}"`);
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
  );

// Flags as yok run takes them: the prompt in --prompt, inputs and policies as --NAME VALUE.
// Nobody sits at the run's terminal, so interaction is off whatever the flag says.
const startRun = async (args: Args, thread: ChatThread, deps: DispatchDeps, say: Say) => {
  const [workflow, ...extra] = args.positionals;
  const project = stringFlag(args, "project");
  const prompt = stringFlag(args, "prompt");
  if (workflow === undefined || project === undefined) {
    throw needsUsage("a WORKFLOW and --project NAME are required");
  }
  if (extra.length > 0) {
    throw needsUsage(`unexpected words: ${extra.join(" ")}; put the prompt in --prompt "TEXT"`);
  }
  if (prompt === undefined) throw needsUsage('--prompt "TEXT" is required');
  const inputs = runInputs(stringsFlag(args, "input"));
  // Each flag's text, not a boolean: parsePolicyFlags reads it as YAML.
  const policies = parsePolicyFlags(args.values);
  if (!policies.ok) throw needsUsage(policies.error);
  const name = stringFlag(args, "name");
  const config = stringFlag(args, "config");
  const body = StartRunBodySchema.safeParse({
    project,
    workflow,
    inputs: { prompt, ...inputs },
    ...(name === undefined ? {} : { name }),
    ...(config === undefined ? {} : { config }),
    policies: { ...policies.value, interaction: false },
  });
  if (!body.success) return { text: `bad-request: ${z.prettifyError(body.error)}` };
  await say({ text: `Starting \`${workflow}\` on *${project}*…` });
  const log = deps.log.child({ component: "slack" });
  const started = await startProjectRun(body.data, deps, log, { thread });
  if (!started.ok) return startErrorReply(started.error);
  const { run, view, threaded } = started.value;
  const notes = [
    ...(threaded === true ? [] : [SILENT_NOTIFIER]),
    ...(policies.value.interaction === true ? [QUESTIONS_OFF] : []),
  ];
  return {
    text: [`*\`${run.id}\` started* · ${view}`, ...notes.map((note) => `_${note}_`)].join("\n"),
  };
};

const listProjects = async (_args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const { projects } = unwrapApi(await deps.client.projects());
  if (projects.length === 0) return { text: "No projects yet; add one with `@yok project add`." };
  return { text: plural(projects.length, "project"), table: projectTable(projects) };
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
  return { text: `Added *${project.name}* at \`${project.path}\`` };
};

const removeProject = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const [name] = args.positionals;
  if (name === undefined) throw needsUsage();
  const { removed, note } = unwrapApi(
    await deps.client.removeProject(name, args.values.purge === true),
  );
  return { text: [`Removed *${removed}*`, ...(note === null ? [] : [note])].join("\n") };
};

const runDoctor = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const project = requireProject(args);
  const workflow = stringFlag(args, "workflow");
  const { report } = unwrapApi(
    await deps.client.doctor({ project, ...(workflow === undefined ? {} : { workflow }) }),
  );
  return doctorReply(DoctorReportSchema.parse(report));
};

const listTriggers = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const { triggers } = unwrapApi(await deps.client.listTriggers());
  const project = stringFlag(args, "project");
  const shown = triggers.filter((t) => project === undefined || t.project === project);
  if (shown.length === 0) return { text: "No triggers." };
  return { text: plural(shown.length, "trigger"), table: triggerTable(shown) };
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
  return { text: scheduleLine(trigger) };
};

const triggerRef = (args: Args): Readonly<{ project: string; name: string }> => {
  const [name] = args.positionals;
  const project = requireProject(args);
  if (name === undefined) throw needsUsage();
  return { project, name };
};

const fireTrigger = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => ({
  text: fireLine(unwrapApi(await deps.client.fireTrigger(triggerRef(args))).fire),
});

const FIRES_SHOWN = 50;

const triggerLog = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const { fires } = unwrapApi(await deps.client.triggerLog(triggerRef(args)));
  if (fires.length === 0) return { text: "Never fired." };
  const shown = fires.slice(-FIRES_SHOWN);
  const heading =
    shown.length === fires.length
      ? plural(fires.length, "fire")
      : `The newest ${shown.length} of ${fires.length} fires`;
  return { text: heading, table: fireTable(shown) };
};

const removeTrigger = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const ref = triggerRef(args);
  unwrapApi(await deps.client.removeTrigger(ref));
  return { text: `Removed *${ref.name}* from *${ref.project}*` };
};

// The flags go to GET /runs as typed; the route checks them, as it does for yok ls.
const listRuns = async (args: Args, _thread: ChatThread, deps: DispatchDeps) => {
  const project = stringFlag(args, "project");
  const status = stringFlag(args, "status");
  const limit = stringFlag(args, "limit");
  const listed = unwrapApi(
    await deps.client.runs({
      ...(project === undefined ? {} : { project }),
      ...(status === undefined ? {} : { status }),
      ...(limit === undefined ? {} : { limit }),
      ...(args.values.all === true ? { all: "true" } : {}),
    }),
  );
  return runsReply(listed, { project, status });
};

// An id names one run; a name can recur across projects, so a shared one is refused.
const findRun = <T extends { id: string; name: string | null }>(
  runs: readonly T[],
  key: string,
): T | undefined => {
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
  const project = stringFlag(args, "project");
  const { runs } = unwrapApi(
    await deps.client.runs({ all: "true", ...(project === undefined ? {} : { project }) }),
  );
  const run = findRun(runs, key);
  if (run === undefined) return { text: `not-found: no run ${key}` };
  const { current, blocker, steps } = run;
  const step = current === null ? "-" : `${current} (${steps.done}/${steps.total ?? "?"})`;
  const blocked =
    blocker === null
      ? "-"
      : `${blocker.reason}${blocker.node === undefined ? "" : ` at ${blocker.node}`}`;
  return {
    text: [
      `*\`${run.id}\`* · ${run.name ?? "unnamed"} · \`${run.workflow}\``,
      `*Status* ${run.status} · *Step* ${step}`,
      `*Blocked* ${blocked} · *PR* ${run.pr ?? "-"}`,
      `${deps.publicOrigin}/runs/${run.id}`,
    ].join("\n"),
  };
};

const PROJECT_FLAG = { project: { type: "string" } } as const;

// In the order help lists them.
const COMMANDS: readonly ChatCommand[] = [
  {
    words: ["ls"],
    usage: "ls [--project NAME] [--status STATUS] [--limit N] [--all]",
    options: {
      project: { type: "string" },
      status: { type: "string" },
      limit: { type: "string" },
      all: { type: "boolean" },
    },
    run: listRuns,
  },
  {
    words: ["run", "status"],
    usage: "run status RUN [--project NAME]",
    options: PROJECT_FLAG,
    run: showRun,
  },
  {
    words: ["run"],
    usage:
      'run WORKFLOW --project NAME --prompt "TEXT" [--name NAME] [--config FILE] [--input KEY=VALUE] [--POLICY VALUE]',
    options: {
      project: { type: "string" },
      prompt: { type: "string" },
      name: { type: "string" },
      config: { type: "string" },
      input: { type: "string", multiple: true },
      ...Object.fromEntries(POLICY_NAMES.map((name) => [name, { type: "string" } as const])),
    },
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
  { words: ["help"], usage: "help", options: {}, run: async () => ({ text: helpText() }) },
];

// The longest match wins, so `run status r-1` is never read as running a workflow named status.
const LONGEST_FIRST = [...COMMANDS].sort((a, b) => b.words.length - a.words.length);

const helpText = (): string =>
  ["*Type `@yok` and one of:*", ...COMMANDS.map((command) => `• \`${command.usage}\``)].join("\n");

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

// Slack sends a link as <url> or <url|label>, and &, < and > as entities.
const plainWord = (token: string): string =>
  token
    .replace(/^<([^|>]+)(?:\|[^>]*)?>$/, "$1")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

// The quote that closes each opening one. Slack's editor often turns typed quotes into curly
// ones, so “…” and ‘…’ quote too.
const CLOSING: Readonly<Record<string, string>> = { '"': '"', "'": "'", "“": "”", "‘": "’" };

type Split = Readonly<{
  words: readonly string[];
  word: string | null;
  // the quote that ends the quoted text the next character is in, or null outside quotes
  closing: string | null;
  // the last character was the \\ of a \\" inside double quotes
  escaped: boolean;
}>;

const addTo = (state: Split, char: string): Split => ({
  ...state,
  word: `${state.word ?? ""}${char}`,
  escaped: false,
});

// Inside quotes a character joins the word, and \\" keeps a quote inside double quotes. Outside,
// a space ends the word and an opening quote starts quoted text.
const splitStep = (state: Split, char: string, next: string | undefined): Split => {
  const { words, word, closing } = state;
  if (state.escaped) return addTo(state, char);
  if (closing !== null) {
    if (char === "\\" && closing === '"' && next === '"') return { ...state, escaped: true };
    if (char === closing) return { ...state, word: word ?? "", closing: null };
    return addTo(state, char);
  }
  if (/\s/.test(char))
    return { ...state, words: word === null ? words : [...words, word], word: null };
  const opening = CLOSING[char];
  if (opening !== undefined) return { ...state, word: word ?? "", closing: opening };
  return addTo(state, char);
};

// Words split as a shell splits them: on spaces outside quotes, the quotes removed.
export const splitWords = (text: string): Result<readonly string[]> => {
  const chars = [...text];
  const end = chars.reduce<Split>(
    (state, char, index) => splitStep(state, char, chars[index + 1]),
    { words: [], word: null, closing: null, escaped: false },
  );
  if (end.closing !== null) {
    return {
      ok: false,
      error: `a quote is not closed: put a matching ${end.closing} at the end of the quoted text`,
    };
  }
  const words = end.word === null ? end.words : [...end.words, end.word];
  return { ok: true, value: words.map(plainWord) };
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

export const dispatchCommand = async (
  text: string,
  thread: ChatThread,
  deps: DispatchDeps,
  say: Say,
): Promise<Reply> => {
  const split = splitWords(text);
  if (!split.ok) return { text: split.error };
  const words = split.value;
  if (words.length === 0) return { text: helpText() };
  const command = LONGEST_FIRST.find((c) => c.words.every((word, index) => words[index] === word));
  if (command === undefined) {
    return { text: [`unknown command: ${words.join(" ")}`, "", helpText()].join("\n") };
  }
  try {
    const args = parseWords(words.slice(command.words.length), command.options);
    return await command.run(args, thread, deps, say);
  } catch (error) {
    if (!(error instanceof ChatError)) throw error;
    const usage = error.usage ? [`usage: \`${command.usage}\``] : [];
    return { text: [error.message, ...usage].filter((line) => line !== "").join("\n") };
  }
};
