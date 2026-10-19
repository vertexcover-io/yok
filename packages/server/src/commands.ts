import { realpath } from "node:fs/promises";
import { basename, isAbsolute, normalize, resolve, sep } from "node:path";
import { Command, type OptionValues } from "@commander-js/extra-typings";
import { type DoctorReport, type DoctorRow, isWorkflowFile, verdict } from "@yok/core";
import { POLICY_NAMES, PoliciesSchema, type PolicyLayer, type Result, type Source } from "@yok/sdk";
import { parsePolicyFlags } from "@yok/sdk/internal";
import type { YokClient } from "./client.ts";
import type { ApiError, ProjectView } from "./protocol.ts";

export const collectInput = (pair: string, acc: Record<string, string>): Record<string, string> => {
  const index = pair.indexOf("=");
  if (index === -1) throw new Error(`--input must be KEY=VALUE, got "${pair}"`);
  return { ...acc, [pair.slice(0, index)]: pair.slice(index + 1) };
};

// "Refrens_Main" -> "refrens-main"; empty or digit-first when the folder has no usable name.
export const folderSlug = (folder: string): string =>
  folder
    .replace(/\.git$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// `yok run` and a channel's run command: the same arguments and options, no action.
export const runDefinition = () => {
  const command = new Command("run")
    .argument("<workflow>", "shipped workflow name (e.g. task), or workflow file to run")
    .argument("[words...]", "the prompt, when --prompt is not given")
    .option("--prompt <text>", "first message sent to the agent")
    .option("--name <name>", "run name (default: derived from the prompt)")
    .option("--project <name>", "project to run on (default: this checkout, added if new)")
    .option("--input <key=value>", "extra input, repeatable", collectInput, {})
    .option("--no-attach", "do not attach to the session's terminal once it starts")
    .option("--config <file>", "orchestrate config file the run reads (default: the checkout's)")
    .option("--no-open", "do not open the run's page in the browser");
  // one `--NAME <value>` option per policy, with the policy's help text
  for (const name of POLICY_NAMES) {
    command.option(`--${name} <value>`, PoliciesSchema.shape[name].description ?? name);
  }
  return command;
};

export const promptFrom = (
  prompt: string | undefined,
  words: readonly string[],
): Result<string> => {
  if (prompt !== undefined && words.length > 0) {
    return { ok: false, error: "give the prompt once: after the workflow or with --prompt" };
  }
  const text = prompt ?? words.join(" ");
  if (text.trim() === "") return { ok: false, error: "no prompt: write it after the workflow" };
  return { ok: true, value: text };
};

// The typed name, else one made from the folder; either must start with a letter.
export const nameProject = (typed: string | undefined, folder: string): Result<string> => {
  if (typed !== undefined && !/^[a-z]/.test(typed)) {
    return {
      ok: false,
      error: `"${typed}" is not a valid project name: use lowercase letters, digits and dashes, starting with a letter`,
    };
  }
  const name = typed ?? folderSlug(folder);
  if (!/^[a-z]/.test(name)) {
    return { ok: false, error: `cannot name the project from "${folder}"; pass a NAME` };
  }
  return { ok: true, value: name };
};

export const projectAddDefinition = () =>
  new Command("add")
    .description("Register a checkout on the server, or clone one")
    .argument("[name]", "project name (default: from the folder or the repository)")
    .option("--git <url>", "clone this repository (https or ssh)")
    .option("--path <dir>", "a checkout on the server, or where --git clones to");

export const projectListDefinition = () =>
  new Command("list")
    .description("List the server's projects")
    .option("--json", "print the reply as JSON");

export const projectRemoveDefinition = () =>
  new Command("remove")
    .description("Forget a project; --purge also deletes a folder yok cloned")
    .argument("<name>", "project name")
    .option("--purge", "delete the folder too, when yok cloned it");

// A quote opens only at a word's start or right after a leading `KEY=` (`--flag=`, `title=`), so
// an apostrophe inside a word (it's) is a plain character; text after the closing quote joins the
// word ("the bug". ends a sentence). A quote that opens and never closes matches nothing.
const WORD = /([^\s"'=]+=)?(?:"([^"]*)"|'([^']*)')(\S*)|(?![^\s"'=]+=["'])([^\s"']\S*)/g;

// Splits typed text on spaces, keeping a quoted stretch as one word without its quotes.
export const tokenize = (text: string): Result<readonly string[]> => {
  if (text.replace(WORD, "").trim() !== "") return { ok: false, error: "unclosed quote" };
  const words = [...text.matchAll(WORD)].map(
    ([, key = "", double, single, rest = "", plain]) =>
      plain ?? `${key}${double ?? single ?? ""}${rest}`,
  );
  return { ok: true, value: words };
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

export const exitCodeFor = (report: DoctorReport): number => (report.failed.length > 0 ? 1 : 0);

const PROJECT_HEADERS = ["NAME", "STATUS", "PATH", "ADDED BY"] as const;

// The header row, then one row per project, as `yok project list` prints them.
export const projectRows = (projects: readonly ProjectView[]): readonly (readonly string[])[] => [
  PROJECT_HEADERS,
  ...projects.map((p) => [p.name, p.status, p.path, p.addedBy.name ?? p.addedBy.channel]),
];

export const renderProjects = (projects: readonly ProjectView[]): string => {
  const rows = projectRows(projects);
  const widths = PROJECT_HEADERS.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (values: readonly string[]): string =>
    values
      .map((value, column) => value.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return rows.map(line).join("\n");
};

export const apiErrorText = (error: ApiError): string => `${error.code}: ${error.message}`;

const blockedText = (message: string, report: DoctorReport): string =>
  [
    message,
    ...report.results
      .filter((row) => row.status === "fail")
      .flatMap((row) => [`${row.name}: ${row.detail}`, ...row.fix.map((step) => `  fix: ${step}`)]),
  ].join("\n");

export const startErrorText = (error: ApiError): string =>
  error.findings === undefined ? apiErrorText(error) : blockedText(error.message, error.findings);

export type ChannelReply = Readonly<{
  ok: boolean;
  text: string;
  // the reply as table rows, header first, for an inbox that draws tables
  rows?: readonly (readonly string[])[];
}>;

const USAGE = [
  "commands:",
  "  run WORKFLOW PROMPT... [--project NAME] [--name NAME] [--input KEY=VALUE] [--config FILE]",
  "  project list",
  "  project add [NAME] --git URL | --path DIR",
  "  project remove NAME [--purge]",
].join("\n");

const refuse = (text: string): ChannelReply => ({ ok: false, text });

// Commander would print and exit on a bad flag; here it throws, and the message is the reply.
const parseWords = <Args extends unknown[], Opts extends OptionValues>(
  command: Command<Args, Opts>,
  words: readonly string[],
): Result<Command<Args, Opts>> => {
  try {
    const silent = { writeOut: () => {}, writeErr: () => {} };
    return {
      ok: true,
      value: command.exitOverride().configureOutput(silent).parse(words, { from: "user" }),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const channelNotes = (typed: PolicyLayer, opts: Readonly<{ attach: boolean; open: boolean }>) => [
  ...(typed.interaction === true
    ? ["interaction is always off from a channel; --interaction was ignored"]
    : []),
  ...(opts.attach && opts.open ? [] : ["--no-attach and --no-open do nothing from a channel"]),
];

// The server quotes a bad file's lines in its error, so a channel names only checkout files.
const leavesCheckout = (path: string): boolean =>
  isAbsolute(path) || normalize(path).split(sep)[0] === "..";

// The channel runs inside the server, so it resolves the file the server will read: a symlink in
// the checkout that points out of it leaves the checkout as surely as `..` does.
const leavesRealCheckout = async (root: string, path: string): Promise<boolean> => {
  const [top, real] = await Promise.all([
    realpath(root).catch(() => root),
    realpath(resolve(root, path)).catch(() => null),
  ]);
  return real !== null && real !== top && !real.startsWith(`${top}${sep}`);
};

// The checkout the server will pick: the named project's, or the only one's.
const projectRoot = async (client: YokClient, name: string | undefined): Promise<string | null> => {
  const listed = await client.projects();
  if (!listed.ok) return null;
  const { projects } = listed.value;
  const only = projects.length === 1 ? projects[0] : undefined;
  const project = name === undefined ? only : projects.find((p) => p.name === name);
  return project?.path ?? null;
};

// The first named file that resolves outside the checkout; a shipped workflow names no file.
const fileOutside = async (
  client: YokClient,
  project: string | undefined,
  paths: readonly (string | undefined)[],
): Promise<string | undefined> => {
  const files = paths.filter((path): path is string => path !== undefined);
  if (files.length === 0) return undefined;
  const root = await projectRoot(client, project);
  if (root === null) return undefined;
  for (const file of files) {
    if (await leavesRealCheckout(root, file)) return file;
  }
  return undefined;
};

// A YAML error quotes the file's lines after its position; a checkout file can hold a secret.
const withoutQuotedLines = (error: string): string =>
  error.replace(/( at line \d+, column \d+):\n[\s\S]*/, "$1");

// The workflow and config go as typed: the server resolves them against the project's checkout.
const startRun = async (
  words: readonly string[],
  source: Source,
  client: YokClient,
): Promise<ChannelReply> => {
  const parsed = parseWords(runDefinition(), words);
  if (!parsed.ok) return refuse(parsed.error);
  const [workflow, promptWords] = parsed.value.processedArgs;
  const opts = parsed.value.opts();
  const outside = [workflow, opts.config].find(
    (path) => path !== undefined && leavesCheckout(path),
  );
  const linked =
    outside ??
    (await fileOutside(client, opts.project, [
      isWorkflowFile(workflow) ? workflow : undefined,
      opts.config,
    ]));
  if (linked !== undefined) return refuse(`${linked}: name a file inside the project's checkout`);
  const prompt = promptFrom(opts.prompt, promptWords);
  if (!prompt.ok) return refuse(prompt.error);
  const typed = parsePolicyFlags(opts);
  if (!typed.ok) return refuse(typed.error);
  const started = await client.run({
    workflow,
    inputs: { prompt: prompt.value, ...opts.input },
    // nobody sits at a channel's terminal to answer the agent
    policies: { ...typed.value, interaction: false },
    source,
    ...(opts.name === undefined ? {} : { name: opts.name }),
    ...(opts.project === undefined ? {} : { project: opts.project }),
    ...(opts.config === undefined ? {} : { config: opts.config }),
  });
  if (!started.ok) return refuse(withoutQuotedLines(startErrorText(started.error)));
  const { run, view } = started.value;
  return {
    ok: true,
    text: [run.id, `view: ${view}`, ...channelNotes(typed.value, opts)].join("\n"),
  };
};

// --json is ignored: the rows already carry the table for an inbox that draws one.
const listProjects = async (words: readonly string[], client: YokClient): Promise<ChannelReply> => {
  const parsed = parseWords(projectListDefinition(), words);
  if (!parsed.ok) return refuse(parsed.error);
  const listed = await client.projects();
  if (!listed.ok) return refuse(apiErrorText(listed.error));
  const { projects } = listed.value;
  if (projects.length === 0) return { ok: true, text: "no projects; add one with yok project add" };
  return { ok: true, text: renderProjects(projects), rows: projectRows(projects) };
};

const addProject = async (
  words: readonly string[],
  source: Source,
  client: YokClient,
): Promise<ChannelReply> => {
  const parsed = parseWords(projectAddDefinition(), words);
  if (!parsed.ok) return refuse(parsed.error);
  const [typedName] = parsed.value.processedArgs;
  const { git, path } = parsed.value.opts();
  // A channel has no current folder to add, as the CLI has none on a remote server.
  if (git === undefined && path === undefined) {
    return refuse("the server is remote: pass --path DIR (a folder on the server) or --git URL");
  }
  const name = nameProject(typedName, basename(path ?? git ?? ""));
  if (!name.ok) return refuse(name.error);
  const added = await client.addProject({
    name: name.value,
    ...(git === undefined ? {} : { git }),
    ...(path === undefined ? {} : { path }),
    addedBy: source,
  });
  if (!added.ok) return refuse(apiErrorText(added.error));
  const { project } = added.value;
  return { ok: true, text: `added ${project.name}  ${project.path}` };
};

const removeProject = async (
  words: readonly string[],
  client: YokClient,
): Promise<ChannelReply> => {
  const parsed = parseWords(projectRemoveDefinition(), words);
  if (!parsed.ok) return refuse(parsed.error);
  const [name] = parsed.value.processedArgs;
  const removed = await client.removeProject(name, parsed.value.opts().purge === true);
  if (!removed.ok) return refuse(apiErrorText(removed.error));
  const { note } = removed.value;
  return {
    ok: true,
    text: [`removed ${removed.value.removed}`, ...(note === null ? [] : [note])].join("\n"),
  };
};

const manageProjects = (
  [command, ...words]: readonly string[],
  source: Source,
  client: YokClient,
): Promise<ChannelReply> | ChannelReply => {
  switch (command) {
    case undefined:
      return refuse(USAGE);
    case "add":
      return addProject(words, source, client);
    case "list":
      return listProjects(words, client);
    case "remove":
      return removeProject(words, client);
    default:
      return refuse(`unknown project command "${command}"; use add, list or remove`);
  }
};

// Typed chat text, read with the CLI's own definitions and answered in the CLI's words.
export const runChannelCommand = async (
  text: string,
  source: Source,
  client: YokClient,
): Promise<ChannelReply> => {
  const words = tokenize(text);
  if (!words.ok) return refuse(`${words.error}\n${USAGE}`);
  if (words.value.length === 0) return refuse(USAGE);
  const [first, ...rest] = words.value;
  if (first === "run") return startRun(rest, source, client);
  if (first === "project") return manageProjects(rest, source, client);
  return refuse(`unknown command "${first}"; use run or project`);
};
