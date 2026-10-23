import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { uptime } from "node:os";
import { dirname, join } from "node:path";
import {
  type ContextOutput,
  ContextStartedEvent,
  type Event,
  type IAgentProvider,
  type ILogger,
  type ITerminal,
  type JsonValue,
  type LaunchOptions,
  type NodeRun,
  type Result,
  type RunRef,
  readState,
  runDirOf,
  SessionReplacedEvent,
  SessionStartCalledEvent,
  type State,
  sessionEnv,
  type TierModel,
  tierLaunch,
} from "@yok/sdk";
import {
  appendRunEvent,
  foldModelSwitch,
  type IEventStore,
  isProcessAlive,
  jsonlEventStore,
  pickTierModel,
  type Registry,
  runLockPath,
  selfArgv,
  writeShim,
} from "@yok/sdk/internal";
import {
  CLAUDE_CLEAR_INPUT_KEY,
  CLAUDE_ESCAPE_PAUSE_MS,
  CLAUDE_MAX_ESCAPES,
  CLAUDE_NOTHING_TO_COMPACT,
  hasClaudeInputBox,
  isClaudeBusy,
} from "./agents/claude.ts";
import { typeLine } from "./agents/common.ts";
import { completeContextStep, findContextPlanNode, loadSessionEnv } from "./runs.ts";
import { spawnOrchestrateHelper } from "./stage.ts";

const IDLE_TIMEOUT_MS = 30_000;
const IDLE_POLL_MS = 100;
const DONE_POLL_MS = 250;
// how long a new session may take to start, and a compact to finish, before the step fails
const DONE_TIMEOUT_MS = { new: 60_000, compact: 180_000 } as const;
// How long a typed resume line may take to show as the run's `orchestrate resume`, counted over
// continuous time Claude is free, and how long at most in all; and how many times it is typed.
const RESUME_TIMEOUT_MS = 30_000;
const RESUME_CAP_MS = 180_000;
const RESUME_ATTEMPTS = 2;
const INPUT_UNREACHABLE = "Could not reach Claude's input box";

export const startModelStep = async (run: RunRef, sessionId: string, seq: number): Promise<void> =>
  spawnOrchestrateHelper({ command: "model", id: String(seq), run, sessionId });

export const startContextStep = async (
  run: RunRef,
  sessionId: string,
  nodeRunId: string,
): Promise<void> => spawnOrchestrateHelper({ command: "context", id: nodeRunId, run, sessionId });

export type ContextStepOptions = Readonly<{
  run: RunRef;
  nodeRunId: string;
  // the session whose turn just ended, which a new session replaces
  oldSessionId: string;
  // undefined when the helper was not started inside a tmux pane
  terminal: ITerminal | undefined;
  registry: Registry;
  provider: IAgentProvider;
  // how the agent was launched; relaunching adds the session's env and the resume prompt
  launch: Omit<LaunchOptions, "prompt" | "env">;
  home: string;
  log: ILogger;
}>;

// Polls until the probe finds something; it stops at the first error or when time runs out.
const pollUntil = async <T>(
  {
    everyMs,
    timeoutMs,
    timeoutError,
  }: Readonly<{ everyMs: number; timeoutMs: number; timeoutError: string }>,
  probe: () => Promise<Result<T | undefined>>,
): Promise<Result<T>> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await probe();
    if (!found.ok) return found;
    if (found.value !== undefined) return { ok: true, value: found.value };
    if (Date.now() >= deadline) return { ok: false, error: timeoutError };
    await Bun.sleep(everyMs);
  }
};

const waitForIdle = (terminal: ITerminal): Promise<Result<true>> =>
  pollUntil(
    { everyMs: IDLE_POLL_MS, timeoutMs: IDLE_TIMEOUT_MS, timeoutError: "Claude did not go idle" },
    async () => {
      const screen = await terminal.capture();
      if (!screen.ok) return screen;
      return { ok: true, value: isClaudeBusy(screen.value) ? undefined : true };
    },
  );

const resumePrompt = (run: RunRef): string => `/yok:orchestrate --resume ${run.name}`;

// The session a line goes to, and the step it is typed for.
type LineTarget = Readonly<{
  run: RunRef;
  sessionId: string;
  step: string;
  terminal: ITerminal;
  log: ILogger;
}>;

// Sends an Escape while Claude's input box is hidden, up to `left` of them. None goes to a box on
// screen: there it could interrupt Claude's turn or open its Rewind menu. false: never shown.
const revealInputBox = async (terminal: ITerminal, left: number): Promise<Result<boolean>> => {
  const screen = await terminal.capture();
  if (!screen.ok) return screen;
  if (hasClaudeInputBox(screen.value)) return { ok: true, value: true };
  if (left === 0) return { ok: true, value: false };
  const sent = await terminal.sendKeys(["Escape"]);
  if (!sent.ok) return sent;
  await Bun.sleep(CLAUDE_ESCAPE_PAUSE_MS);
  return revealInputBox(terminal, left - 1);
};

// One try at a line, typed once the input box shows, even while Claude finishes its turn: Claude
// holds the line until then. C-u empties the box, where a cancelled line may be left. false: the
// box never showed, so nothing was typed.
const tryLine = async (target: LineTarget, line: string): Promise<Result<boolean>> => {
  const { terminal, log } = target;
  const shown = await revealInputBox(terminal, CLAUDE_MAX_ESCAPES);
  if (!shown.ok) return shown;
  if (!shown.value) {
    log.warn({ line }, INPUT_UNREACHABLE);
    return { ok: true, value: false };
  }
  const emptied = await terminal.sendKeys([CLAUDE_CLEAR_INPUT_KEY]);
  if (!emptied.ok) return emptied;
  const typed = await typeLine(terminal, line);
  return typed.ok ? { ok: true, value: true } : typed;
};

const isResumed = async (store: IEventStore, afterSeq: number): Promise<boolean> =>
  (await store.read()).some((event) => event.seq > afterSeq && event.type === "orchestrate.resume");

// Claude holds a line typed while it finishes a turn, and may not draw its spinner until a moment
// after Enter, so the wait counts only while Claude stays free; a line retyped while it is held or
// worked on would run twice.
const waitForResumed = async (
  terminal: ITerminal,
  store: IEventStore,
  afterSeq: number,
): Promise<boolean> => {
  const cap = Date.now() + RESUME_CAP_MS;
  let freeSince: number | undefined;
  for (;;) {
    if (await isResumed(store, afterSeq)) return true;
    const now = Date.now();
    const screen = await terminal.capture();
    const free = screen.ok && !isClaudeBusy(screen.value);
    freeSince = free ? (freeSince ?? now) : undefined;
    if (now >= cap || (freeSince !== undefined && now >= freeSince + RESUME_TIMEOUT_MS)) {
      return false;
    }
    await Bun.sleep(DONE_POLL_MS);
  }
};

// How the resume line ended: taken, never typed because the input box never showed, or typed and
// never taken.
type ResumeOutcome = "taken" | "unreachable" | "lost";

// Types the resume line until the run's `orchestrate resume`, which the --resume skill runs first,
// shows Claude took it; the outcome is the last try's.
const sendResume = async (target: LineTarget, line: string): Promise<Result<ResumeOutcome>> => {
  const store = jsonlEventStore(runDirOf(target.run.cwd, target.run.name));
  const afterSeq = (await store.read()).at(-1)?.seq ?? 0;
  let outcome: ResumeOutcome = "lost";
  for (let attempt = 1; attempt <= RESUME_ATTEMPTS; attempt += 1) {
    const typed = await tryLine(target, line);
    if (!typed.ok) return typed;
    if (typed.value && (await waitForResumed(target.terminal, store, afterSeq))) {
      return { ok: true, value: "taken" };
    }
    outcome = typed.value ? "lost" : "unreachable";
    target.log.warn({ line, attempt }, "resume line not taken");
  }
  return { ok: true, value: outcome };
};

// A tmux call can throw (a hung tmux times out) and so can reading a half-written event line. The
// helper runs detached, so a throw would end it silently and leave the node open for good: it
// becomes a failed step, logged with its stack.
const catchThrow = <T>(log: ILogger, step: Promise<Result<T>>): Promise<Result<T>> =>
  step.catch((error: unknown): Result<T> => {
    log.error({ err: error }, "context step threw");
    return { ok: false, error: error instanceof Error ? error.message : "context step threw" };
  });

// The Stop hook starts a helper on every stop while its step is pending; only the first one to
// create the step's lock file goes ahead. The file holds the helper's pid, so yok resume can
// tell a lock whose helper died from one still in use.
const claimLock = async (run: RunRef, name: string): Promise<boolean> => {
  const lock = runLockPath(runDirOf(run.cwd, run.name), name);
  const file = await mkdir(dirname(lock), { recursive: true })
    .then(() => open(lock, "wx"))
    .catch(() => null);
  if (file === null) return false;
  // The lock is claimed once the file exists; a pid that fails to write only leaves yok resume
  // treating the lock as dead.
  await file.writeFile(String(process.pid)).catch(() => {});
  await file.close().catch(() => {});
  return true;
};

const SWITCH_LOCK = /^(model|context)-.+\.lock$/;

// A lock written before the last boot is dead even when its pid is alive: the reboot can have
// handed that pid to another process.
const hasLiveOwner = async (path: string): Promise<boolean> => {
  const [text, info] = await Promise.all([
    readFile(path, "utf8").catch(() => ""),
    stat(path).catch(() => null),
  ]);
  const pid = Number(text.trim());
  const bootedAt = Date.now() - uptime() * 1000;
  if (info === null || info.mtimeMs < bootedAt) return false;
  return Number.isInteger(pid) && pid > 0 && isProcessAlive(pid);
};

// A helper keeps its lock after its step ends, so only the lock of a step still open can belong
// to a helper at work: the unanswered model request's, and the running context node's.
const openSwitchLocks = (state: State, events: readonly Event[]): ReadonlySet<string> => {
  const { pending } = foldModelSwitch(events, state.tiers);
  const context = findOpenContextRun(state.nodeRuns);
  return new Set([
    ...(pending === null ? [] : [`model-${pending.seq}.lock`]),
    ...(context === undefined ? [] : [`context-${context.nodeRunId}.lock`]),
  ]);
};

// For yok resume, once the run's session is gone: a model or context lock whose helper died
// would keep the retried step from ever running. Locks of an open step whose helper is alive are
// returned as held.
export const clearDeadSwitchLocks = async (
  runDir: string,
  state: State,
  events: readonly Event[],
): Promise<Readonly<{ removed: readonly string[]; held: readonly string[] }>> => {
  const dir = join(runDir, "locks");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const locks = entries.filter((entry) => entry.isFile() && SWITCH_LOCK.test(entry.name));
  const open = openSwitchLocks(state, events);
  const owned = await Promise.all(
    locks.map((entry) => open.has(entry.name) && hasLiveOwner(join(dir, entry.name))),
  );
  const names = locks.map((entry) => entry.name);
  const removed = names.filter((_, index) => !owned[index]);
  await Promise.all(removed.map((name) => rm(join(dir, name), { force: true })));
  return { removed, held: names.filter((_, index) => owned[index]) };
};

const complete = async (
  options: ContextStepOptions,
  output: ContextOutput,
): Promise<Result<void>> => {
  const completed = await completeContextStep(options.run, options.nodeRunId, output);
  return completed.ok ? { ok: true, value: undefined } : completed;
};

const replaceSession = (
  { run }: ContextStepOptions,
  previousSessionId: string,
  sessionId: string,
): Promise<unknown> =>
  appendRunEvent(run, {
    type: "workflow.session.replaced",
    source: "orchestrate",
    payload: { agent: "claude", previousSessionId, sessionId },
  });

const recordStarted = (
  { run, nodeRunId }: ContextStepOptions,
  action: "new" | "compact",
  sessionId: string,
): Promise<unknown> =>
  appendRunEvent(run, {
    type: "workflow.context.started",
    source: "orchestrate",
    payload: { nodeRunId, action, sessionId },
  });

// The SessionStart hook records success (completeContextOnSessionStart); the helper only watches
// for failure: no SessionStart in time, or a compact Claude refuses.
const watchForFailure = (
  { run, nodeRunId }: ContextStepOptions,
  terminal: ITerminal,
  action: keyof typeof DONE_TIMEOUT_MS,
): Promise<Result<true>> =>
  pollUntil(
    {
      everyMs: DONE_POLL_MS,
      timeoutMs: DONE_TIMEOUT_MS[action],
      timeoutError: `no SessionStart for the ${action} within ${DONE_TIMEOUT_MS[action] / 1000} seconds`,
    },
    async (): Promise<Result<true | undefined>> => {
      if (!(await findContextPlanNode(run, nodeRunId)).ok) return { ok: true, value: true };
      if (action !== "compact") return { ok: true, value: undefined };
      const screen = await terminal.capture();
      if (screen.ok && screen.value.includes(CLAUDE_NOTHING_TO_COMPACT)) {
        return { ok: false, error: CLAUDE_NOTHING_TO_COMPACT };
      }
      return { ok: true, value: undefined };
    },
  );

// The new session is linked and swapped in before the relaunch, so the run's hooks recognize it
// from its first moment. A relaunch that fails leaves the old session in the pane, so the swap is
// undone and the step fails, which resumes the old session.
const startNewSession = async (
  options: ContextStepOptions,
  terminal: ITerminal,
): Promise<Result<void>> => {
  const { run, registry, provider, oldSessionId, log } = options;
  const env = await loadSessionEnv(run, provider.type);
  if (!env.ok) return env;
  const idle = await waitForIdle(terminal);
  if (!idle.ok) return idle;
  const sessionId = randomUUID();
  await registry.linkSession(run.id, { agent: "claude", sessionId });
  await replaceSession(options, oldSessionId, sessionId);
  await recordStarted(options, "new", sessionId);
  const launch = {
    ...options.launch,
    env: sessionEnv(env.value, run.id, options.home, writeShim(selfArgv(), options.home)),
    prompt: resumePrompt(run),
  };
  const relaunched = await catchThrow(log, provider.relaunch(terminal, sessionId, launch));
  if (!relaunched.ok) {
    await replaceSession(options, sessionId, oldSessionId);
    return relaunched;
  }
  log.info({ sessionId }, "Claude relaunched on a new session");
  const done = await watchForFailure(options, terminal, "new");
  if (!done.ok) return done;
  log.info({ sessionId }, "node completed by the new session's SessionStart");
  return { ok: true, value: undefined };
};

const compact = async (
  options: ContextStepOptions,
  target: LineTarget,
  prompt: string | undefined,
): Promise<Result<void>> => {
  const { log } = target;
  await recordStarted(options, "compact", target.sessionId);
  const command = prompt === undefined ? "/compact" : `/compact ${prompt}`;
  // Typed once: a compaction can take minutes, so a retype could start a second one. A compaction
  // that did not happen is no emergency: the run goes on in a fuller session.
  const typed = await tryLine(target, command);
  if (!typed.ok) return typed;
  if (!typed.value) return { ok: false, error: INPUT_UNREACHABLE };
  log.info({ command }, "compact typed");
  const done = await watchForFailure(options, target.terminal, "compact");
  if (!done.ok) return done;
  log.info({}, "node completed by the compact's SessionStart");
  // Typed here, not in the SessionStart hook: Claude holds a typed prompt until its SessionStart
  // hooks end, so the hook could never see the prompt arrive.
  await resumeRun(target);
  return { ok: true, value: undefined };
};

export const findOpenContextRun = (
  nodeRuns: Readonly<Record<string, NodeRun>>,
): NodeRun | undefined => {
  for (const nodeRun of Object.values(nodeRuns)) {
    if (nodeRun.status !== "running") continue;
    if (nodeRun.nodeType === "context") return nodeRun;
    const inside = nodeRun.nodes === undefined ? undefined : findOpenContextRun(nodeRun.nodes);
    if (inside !== undefined) return inside;
  }
  return undefined;
};

// The action the helper began for this node run, from its workflow.context.started event.
const findStartedAction = async (runDir: string, nodeRunId: string) => {
  const events = await jsonlEventStore(runDir).read();
  const started = events
    .filter((event) => event.type === "workflow.context.started")
    .map((event) => ContextStartedEvent.safeParse(event))
    .findLast((parsed) => parsed.success && parsed.data.payload.nodeRunId === nodeRunId);
  return started?.success ? started.data.payload : undefined;
};

// Claude runs SessionStart hooks after a new session starts or a compact ends, before its next
// prompt, so that is when the action is done; it counts only if it matches the action the helper
// began.
export const completeContextOnSessionStart = async (
  run: RunRef,
  sessionId: string,
  source: string,
): Promise<void> => {
  const runDir = runDirOf(run.cwd, run.name);
  const state = await readState(runDir);
  const open = state === null ? undefined : findOpenContextRun(state.nodeRuns);
  if (open === undefined) return;
  const started = await findStartedAction(runDir, open.nodeRunId);
  if (started === undefined || started.sessionId !== sessionId) return;
  const matches =
    (started.action === "new" && source === "startup") ||
    (started.action === "compact" && source === "compact");
  if (!matches) return;
  await completeContextStep(run, open.nodeRunId, {
    action: started.action,
    applied: true,
    sessionId,
  });
};

// The session in the pane carries on: after its compaction, or after a step that did not happen.
// A resume line Claude never takes leaves the run with nobody driving it, so it alone pings a
// person, once, saying whether the input box never showed or the typed line was never taken.
const resumeRun = async (target: LineTarget): Promise<void> => {
  const line = resumePrompt(target.run);
  const sent = await catchThrow(target.log, sendResume(target, line));
  if (!sent.ok) return target.log.error({ err: sent.error }, "resume prompt not taken");
  if (sent.value === "taken") return;
  const { run, sessionId, step, log } = target;
  log.error({ line, outcome: sent.value }, `Claude did not take ${line}`);
  await appendRunEvent(
    run,
    sent.value === "unreachable"
      ? {
          type: "agent.input.unreachable",
          source: "orchestrate",
          payload: { agent: "claude", sessionId, step },
        }
      : {
          type: "agent.line.lost",
          source: "orchestrate",
          payload: { agent: "claude", sessionId, step, line },
        },
  );
};

// A context step that did not happen still completes, and the session in the pane carries on.
const recover = async (
  options: ContextStepOptions,
  target: LineTarget,
  action: ContextOutput["action"],
  reason: string,
): Promise<void> => {
  const { log } = options;
  log.error({ action, reason }, "context step not applied");
  const completed = await catchThrow(log, complete(options, { action, applied: false, reason }));
  if (!completed.ok) log.error({ err: completed.error }, "context node not completed");
  await resumeRun(target);
};

// Runs after the Stop hook that found a context node open: starts a new session in the agent's
// pane, or compacts the one it has, then lets the run carry on.
export const runContextStep = async (options: ContextStepOptions): Promise<void> => {
  const { run, nodeRunId, terminal, log } = options;
  if (!(await claimLock(run, `context-${nodeRunId}`))) {
    return log.info({ nodeRunId }, "another helper has this node");
  }
  const planNode = await findContextPlanNode(run, nodeRunId);
  if (!planNode.ok) return log.info({ nodeRunId, reason: planNode.error }, "no open context node");
  const { action, prompt, id: step } = planNode.value;
  log.info({ nodeRunId, action }, "context step started");
  if (terminal === undefined) {
    const completed = await complete(options, {
      action,
      applied: false,
      reason: "not inside tmux",
    });
    if (!completed.ok) log.error({ err: completed.error }, "context node not completed");
    return;
  }
  const target = { run, sessionId: options.oldSessionId, step, terminal, log };
  const outcome = await catchThrow(
    log,
    action === "new" ? startNewSession(options, terminal) : compact(options, target, prompt),
  );
  if (outcome.ok) return;
  const sessionId = await sessionInPane(run, options.oldSessionId);
  await recover(options, { ...target, sessionId }, action, outcome.error);
};

// The session in the pane after a step that began with OLD there: a new session's relaunch swaps
// it in, and a relaunch that fails swaps OLD back, so the last swap involving OLD says which.
const sessionInPane = async (run: RunRef, oldSessionId: string): Promise<string> => {
  const swap = (await jsonlEventStore(runDirOf(run.cwd, run.name)).read())
    .filter((event) => event.type === "workflow.session.replaced")
    .map((event) => SessionReplacedEvent.safeParse(event).data?.payload)
    .findLast(
      (payload) =>
        payload?.previousSessionId === oldSessionId || payload?.sessionId === oldSessionId,
    );
  return swap?.sessionId ?? oldSessionId;
};

export type ModelStepOptions = Readonly<{
  run: RunRef;
  // seq of the workflow.model.requested event this helper carries out
  seq: number;
  // the session whose turn just ended; it is resumed on the new model
  sessionId: string;
  terminal: ITerminal | undefined;
  provider: IAgentProvider;
  // how the agent was launched; the relaunch adds the model, the session's env and the resume prompt
  launch: Omit<LaunchOptions, "prompt" | "env" | "model" | "effort" | "resume">;
  home: string;
  log: ILogger;
}>;

// Restarts the same session in its pane on the target model: flags apply to this session only,
// where /model and /effort would also become the user's default for every new session.
const resumeOnModel = async (
  options: ModelStepOptions,
  terminal: ITerminal,
  target: TierModel,
): Promise<Result<void>> => {
  const { run, provider, sessionId, launch, home, log } = options;
  const env = await loadSessionEnv(run, provider.type);
  if (!env.ok) return env;
  const idle = await waitForIdle(terminal);
  if (!idle.ok) return idle;
  const store = jsonlEventStore(runDirOf(run.cwd, run.name));
  const before = (await store.read()).at(-1)?.seq ?? 0;
  const relaunched = await catchThrow(
    log,
    provider.relaunch(terminal, sessionId, {
      ...launch,
      ...tierLaunch(target),
      resume: true,
      env: sessionEnv(env.value, run.id, home, writeShim(selfArgv(), home)),
      prompt: resumePrompt(run),
    }),
  );
  if (!relaunched.ok) return relaunched;
  const resumed = await waitForResume(store, sessionId, before, target.model);
  return resumed.ok ? { ok: true, value: undefined } : resumed;
};

// A relaunch only proves tmux respawned the pane: the switch happened once the resumed session's
// SessionStart arrives, which a Claude that rejects the model never sends.
const waitForResume = (
  store: IEventStore,
  sessionId: string,
  afterSeq: number,
  model: string,
): Promise<Result<true>> =>
  pollUntil(
    {
      everyMs: DONE_POLL_MS,
      timeoutMs: DONE_TIMEOUT_MS.new,
      timeoutError: `no SessionStart within ${DONE_TIMEOUT_MS.new / 1000} seconds after resuming on ${model}`,
    },
    async () => {
      const events = await store.read();
      const resumed = events.some((event) => {
        if (event.seq <= afterSeq || event.type !== "hooks.session-start.called") return false;
        const parsed = SessionStartCalledEvent.safeParse(event);
        const payload = parsed.success ? parsed.data.payload : undefined;
        return payload?.sessionId === sessionId && payload.source === "resume";
      });
      return { ok: true, value: resumed ? true : undefined };
    },
  );

const recordModelApplied = (run: RunRef, payload: JsonValue) =>
  appendRunEvent(run, { type: "workflow.model.applied", source: "orchestrate", payload });

// Runs after the Stop hook that found a model switch requested: switches the session's model,
// records how it went, and resumes the run. A failed switch is recorded, and next fails the stage.
export const runModelStep = async (options: ModelStepOptions): Promise<void> => {
  const { run, seq, terminal, log } = options;
  const lock = `model-${seq}`;
  if (!(await claimLock(run, lock))) return log.info({ seq }, "another helper has this switch");
  const runDir = runDirOf(run.cwd, run.name);
  const [state, events] = await Promise.all([readState(runDir), jsonlEventStore(runDir).read()]);
  const { pending } = foldModelSwitch(events, state?.tiers ?? null);
  if (pending?.seq !== seq) return log.info({ seq }, "no open model switch");
  const target = pickTierModel(pending);
  const switched: Result<void> =
    terminal === undefined
      ? { ok: false, error: "not inside tmux" }
      : await catchThrow(log, resumeOnModel(options, terminal, target));
  const request = { requestSeq: seq, node: pending.node, ...target };
  const stored = await recordModelApplied(
    run,
    switched.ok
      ? { ...request, applied: true }
      : { ...request, applied: false, reason: switched.error },
  );
  // Unstored, the request stays open; without its lock, the next stop's helper tries again.
  if (!stored.ok) {
    log.error({ err: stored.error, seq }, "model switch result not stored");
    await rm(runLockPath(runDir, lock), { force: true });
  }
  if (switched.ok) {
    return log.info({ target, sessionId: options.sessionId }, "session resumed on the new model");
  }
  log.error({ err: switched.error, target }, "model switch failed");
  if (terminal !== undefined) {
    await resumeRun({ run, sessionId: options.sessionId, step: pending.node, terminal, log });
  }
};
