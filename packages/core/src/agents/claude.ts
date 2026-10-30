import { randomUUID } from "node:crypto";
import {
  type AgentResult,
  checkBinary,
  type Effort,
  type IAgentProvider,
  type ILogger,
  type ITerminal,
  type ITerminalHost,
  type LaunchOptions,
  noopLogger,
  type PermissionMode,
  parseJson,
  type Result,
  type RunRequest,
  spawn,
} from "@yok/sdk";
import { VERSION } from "@yok/sdk/internal";
import * as z from "zod";
import { pluginCheck } from "../plugin.ts";
import { claudeSettings } from "./claude-hooks.ts";
import { limitMenuKeys, readResetWait } from "./claude-limit.ts";
import {
  parseJsonAnswer,
  promptTerminal,
  respawnAgent,
  stopTerminal,
  summarize,
  typeLine,
} from "./common.ts";

// What Claude Code 2.1.285 shows in its pane. While it works, a spinner line (`✻ Compacting…`)
// or the hint under a queued prompt is on screen.
const SPINNER = /^[·✢✳✶✻✽*] \S.*…/;
export const CLAUDE_NOTHING_TO_COMPACT = "Not enough messages to compact.";
// Empties the input line; C-c would exit Claude when the box is already empty.
export const CLAUDE_CLEAR_INPUT_KEY = "C-u";
// Claude reads an Escape followed within 50 ms by another key as one Alt key, so the Escape is
// lost; after this pause it counts as a lone Escape (300 ms was proven on a live pane).
export const CLAUDE_ESCAPE_PAUSE_MS = 300;
// One Escape may not close a popup: /config opens with focus in its search box, where the first
// Escape only leaves the box. Two Escapes on a bare prompt open the Rewind menu, so another is
// sent only while the input box stays hidden, up to this many in all.
export const CLAUDE_MAX_ESCAPES = 3;

const ClaudeScreenSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), text: z.string() }),
  z.object({ kind: z.literal("busy") }),
  // a choice or list waits on a person: no key may be sent
  z.object({ kind: z.literal("menu") }),
  // something with no cursor covers the box; Escape closes it
  z.object({ kind: z.literal("popup") }),
  z.object({ kind: z.literal("unknown") }),
]);
export type ClaudeScreen = z.infer<typeof ClaudeScreenSchema>;

// The rule over and under the input box, with a named session's name in the top one:
// `──── fix-login ─`, with fewer dashes before the name in a narrow pane, or none. Box corners and
// bars mark a panel's edge, such as /config's search box, never a rule.
const RULE = /^(?:─*\s*[^─\s][^─]*\s)?─+$/;
const BOX_EDGE = /[╭╮╰╯┌┐└┘│]/;

const isRule = (line: string): boolean => {
  const trimmed = line.trim();
  return RULE.test(trimmed) && !BOX_EDGE.test(trimmed);
};

// More lines under the box than this mean a panel drawn under an old box, or a status area too
// tall to tell apart from one.
const MAX_STATUS_LINES = 4;

const isCursorLine = (line: string): boolean => line.trim().startsWith("❯");
// The box's bottom edge and a dialog's edges never carry a title, and a line of text can end in " ─".
const isPlainRule = (line: string): boolean => /^─+$/.test(line.trim());

// The transcript above the lowest rule holds the user's old messages, which also start with ❯, so
// only a ❯ under it counts. The question dialog draws a rule above its last option, so its cursor
// sits between the two lowest rules; that counts only with a rule above, or it is transcript.
export const readClaudeBox = (screen: string): ClaudeScreen => {
  if (screen.trim() === "") return { kind: "unknown" };
  const lines = screen.split("\n");
  const rule = lines.findLastIndex(isPlainRule);
  if (lines.slice(rule + 1).some(isCursorLine)) return { kind: "menu" };
  const input = lines[rule - 1] ?? "";
  if (isCursorLine(input) && isRule(lines[rule - 2] ?? "")) {
    return lines.length - rule - 1 <= MAX_STATUS_LINES
      ? { kind: "ready", text: input.trim().slice(1).trim() }
      : { kind: "unknown" };
  }
  const ruleAbove = lines.slice(0, rule).findLastIndex(isPlainRule);
  return ruleAbove >= 0 && lines.slice(ruleAbove + 1, rule).some(isCursorLine)
    ? { kind: "menu" }
    : { kind: "popup" };
};

// Claude shows the queued-messages hint in its input box; the transcript may quote it too.
export const readClaudeScreen = (screen: string): ClaudeScreen => {
  const box = readClaudeBox(screen);
  const busy =
    screen.split("\n").some((line) => SPINNER.test(line)) ||
    (box.kind === "ready" && box.text.includes("Press up to edit queued messages"));
  return busy ? { kind: "busy" } : box;
};

// Some Claude versions preselect "Upgrade your plan" in the limit menu, so a bare Enter would buy
// an upgrade; this picks "Stop and wait". Returns the screen to judge next, or null for a menu it
// cannot answer safely. It answers once: a menu still open leaves no empty box, so nothing is typed.
const answerLimitMenu = async (
  terminal: ITerminal,
  screen: string,
): Promise<Result<string | null>> => {
  const keys = limitMenuKeys(screen);
  if (keys === null) return { ok: true, value: null };
  if (keys.length === 0) return { ok: true, value: screen };
  const answered = await terminal.sendKeys(keys);
  if (!answered.ok) return answered;
  return terminal.capture();
};

const limitResetWait = async (terminal: ITerminal, message: string, now: Date) => {
  const screen = await terminal.capture();
  return readResetWait({ message, screen: screen.ok ? screen.value : "", now });
};

// Claude queues a message submitted while it works, so whileBusy ignores the busy sign. The box
// must already be empty, so a person's half-typed text is never cleared mid-turn.
const promptWhenReady = async (
  terminal: ITerminal,
  text: string,
  options: Readonly<{ whileBusy?: boolean }> = {},
): Promise<Result<"sent" | "not-ready">> => {
  const whileBusy = options.whileBusy === true;
  const captured = await terminal.capture();
  if (!captured.ok) return captured;
  const screen = await answerLimitMenu(terminal, captured.value);
  if (!screen.ok) return screen;
  if (screen.value === null) return { ok: true, value: "not-ready" };
  const box = whileBusy ? readClaudeBox(screen.value) : readClaudeScreen(screen.value);
  if (box.kind !== "ready" || box.text !== "") return { ok: true, value: "not-ready" };
  if (!whileBusy) {
    const cleared = await terminal.sendKeys([CLAUDE_CLEAR_INPUT_KEY]);
    if (!cleared.ok) return cleared;
  }
  const typed = await typeLine(terminal, text);
  return typed.ok ? { ok: true, value: "sent" } : typed;
};

export type ClaudeArgOptions = Readonly<{
  model?: string;
  effort?: Effort;
  permissionMode?: PermissionMode;
  systemPrompt?: string;
  name?: string;
  prompt?: string;
  orchestrateArgv?: readonly string[];
  pluginDir?: string | undefined;
}>;

// A plugin folder loads as yok@inline, and Claude keeps an installed yok@yok on beside
// it, so the installed one is turned off. Claude reads only the last --settings, hence one object.
const sessionSettings = (options: ClaudeArgOptions): Record<string, unknown> => ({
  ...(options.orchestrateArgv !== undefined ? claudeSettings(options.orchestrateArgv) : {}),
  ...(options.pluginDir !== undefined ? { enabledPlugins: { "yok@yok": false } } : {}),
});

export const claudeArgs = (options: ClaudeArgOptions): string[] => {
  const settings = sessionSettings(options);
  return [
    ...(options.model !== undefined ? ["--model", options.model] : []),
    ...(options.effort !== undefined ? ["--effort", options.effort] : []),
    ...(options.permissionMode !== undefined ? ["--permission-mode", options.permissionMode] : []),
    ...(options.systemPrompt !== undefined ? ["--append-system-prompt", options.systemPrompt] : []),
    ...(options.name !== undefined ? ["--name", options.name] : []),
    ...(Object.keys(settings).length > 0 ? ["--settings", JSON.stringify(settings)] : []),
    ...(options.pluginDir !== undefined ? ["--plugin-dir", options.pluginDir] : []),
    ...(options.prompt !== undefined ? [options.prompt] : []),
  ];
};

export const claudeRunArgs = <T>(request: RunRequest<T>): string[] => [
  "-p",
  request.prompt,
  "--output-format",
  "json",
  ...(request.model !== undefined ? ["--model", request.model] : []),
  ...(request.effort !== undefined ? ["--effort", request.effort] : []),
  ...(request.systemPrompt !== undefined ? ["--append-system-prompt", request.systemPrompt] : []),
  ...(request.session?.mode === "resume" ? ["--resume", request.session.id] : []),
  ...(request.session?.mode === "fork" ? ["--resume", request.session.id, "--fork-session"] : []),
  ...(request.outputFormat !== undefined
    ? ["--json-schema", JSON.stringify(z.toJSONSchema(request.outputFormat))]
    : []),
];

// The claude binary's headless stdout shape; session_id is missing on some early failures.
const ClaudeCliOutputSchema = z.object({
  result: z.string(),
  session_id: z.string().optional(),
  is_error: z.boolean(),
});

// Logged in place of the full argv: prompt and system-prompt text can hold anything the user typed.
const REDACTED_RUN_FLAGS = new Set(["-p", "--append-system-prompt"]);
const redactRunArgs = (args: readonly string[]): string[] =>
  args.map((arg, i) => (REDACTED_RUN_FLAGS.has(args[i - 1] ?? "") ? "[redacted]" : arg));

export type ClaudeProviderOptions = Readonly<{
  host: ITerminalHost;
  log?: ILogger;
  binary?: string;
  newId?: () => string;
}>;

// Turns `claude -p --output-format json` stdout and its exit code into an AgentResult.
export const interpretOutput = <T>(
  { code, stdout, stderr }: Readonly<{ code: number; stdout: string; stderr: string }>,
  outputFormat?: z.ZodType<T>,
): AgentResult<T> => {
  const json = parseJson(stdout);
  if (!json.ok && code !== 0) {
    return {
      ok: false,
      error: new Error(`claude exited with code ${code} ${summarize(stderr.trim())}`),
    };
  }
  if (!json.ok) {
    return {
      ok: false,
      error: new Error(`claude produced invalid JSON output ${summarize(stdout)}`),
    };
  }
  const parsed = ClaudeCliOutputSchema.safeParse(json.value);
  if (!parsed.success) {
    return {
      ok: false,
      error: new Error(`claude output failed validation: ${parsed.error.message}`),
    };
  }

  const { result, session_id: sessionId, is_error: isError } = parsed.data;
  const withSession = sessionId !== undefined ? { sessionId } : {};
  if (code !== 0) {
    return { ok: false, error: new Error(`claude exited with code ${code}`), ...withSession };
  }
  if (isError) return { ok: false, error: new Error(result), ...withSession };
  if (sessionId === undefined) {
    return { ok: false, error: new Error("claude output is missing session_id") };
  }
  if (!outputFormat) return { ok: true, output: result as T, sessionId };
  return parseJsonAnswer("claude", result, outputFormat, sessionId);
};

export const claudeProvider = ({
  host,
  log: parentLog = noopLogger,
  binary = "claude",
  newId = randomUUID,
}: ClaudeProviderOptions): IAgentProvider => {
  const log = parentLog.child({ component: "claude" });

  const launch = async (
    options: LaunchOptions,
  ): Promise<Result<{ terminalName: string; terminal: ITerminal }>> => {
    const { continueSession } = options;
    const terminalName = continueSession?.terminalName ?? newId();
    const session = continueSession === undefined ? [] : ["--resume", continueSession.id];
    const sessionLog = log.child({ terminalName });
    const settings = {
      cwd: options.cwd,
      model: options.model,
      permissionMode: options.permissionMode,
    };
    const created = await host.create({
      name: terminalName,
      cwd: options.cwd,
      argv: [binary, ...session, ...claudeArgs(options)],
      env: options.env ?? {},
    });
    if (!created.ok) {
      sessionLog.error({ err: created.error }, "claude not started: the terminal session failed");
      return created;
    }
    sessionLog.info(settings, "claude session started");
    return { ok: true, value: { terminalName, terminal: created.value } };
  };

  const relaunch = async (
    terminal: ITerminal,
    sessionId: string,
    options: LaunchOptions,
  ): Promise<Result<void>> => {
    const session = options.resume === true ? ["--resume", sessionId] : ["--session-id", sessionId];
    const spec = {
      cwd: options.cwd,
      argv: [binary, ...session, ...claudeArgs(options)],
      env: options.env ?? {},
    };
    return respawnAgent("claude", terminal, spec, log.child({ sessionId }));
  };

  const prompt = (terminal: ITerminal, text: string): Promise<Result<void>> =>
    promptTerminal(terminal, text, log);

  const stop = (terminal: ITerminal): Promise<Result<void>> =>
    stopTerminal("claude", terminal, log);

  const run = async <T = string>(request: RunRequest<T>): Promise<AgentResult<T>> => {
    const args = claudeRunArgs(request);
    const startedAt = Date.now();

    const finish = (result: AgentResult<T>): AgentResult<T> => {
      const fields = {
        sessionId: result.sessionId,
        cwd: request.cwd,
        args: redactRunArgs(args),
        durationMs: Date.now() - startedAt,
      };
      if (result.ok) log.info(fields, "headless claude -p finished");
      else log.error({ ...fields, err: result.error }, "headless claude -p failed");
      return result;
    };

    const spawned = await spawn(binary, args, {
      cwd: request.cwd,
      ...(request.env === undefined ? {} : { env: request.env }),
      ...(request.abortSignal === undefined ? {} : { signal: request.abortSignal }),
    });
    if (spawned.stopped === "aborted")
      return finish({ ok: false, error: new Error("run aborted") });
    return finish(interpretOutput(spawned, request.outputFormat));
  };

  return {
    type: "claude",
    skillPrefix: "/yok:",
    checks: [
      {
        name: "claude",
        fix: ["npm i -g @anthropic-ai/claude-code"],
        run: checkBinary(binary),
      },
      pluginCheck("claude", binary, VERSION),
    ],
    launch,
    relaunch,
    prompt,
    stop,
    limitResetWait,
    promptWhenReady,
    run,
  };
};
