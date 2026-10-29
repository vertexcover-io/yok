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
  isClaudeChoicePending,
} from "./agents/claude.ts";
import { typeLine, unwrap } from "./agents/common.ts";
import { completeContextStep, findContextPlanNode, loadSessionEnv } from "./runs.ts";
import { spawnOrchestrateHelper } from "./stage.ts";
import type { WorkflowAgent } from "./workflow/types.ts";

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
// A long chat can take longer to compact: while Claude shows the compact as busy it may run up
// to the cap, and it fails once Claude has not looked busy for the grace.
const COMPACT_MAX_MS = 600_000;
const COMPACT_GRACE_MS = 30_000;

export const startModelStep = async (run: RunRef, sessionId: string, seq: number): Promise<void> =>
  spawnOrchestrateHelper({ command: "model", id: String(seq), run, sessionId });

export const startCloseStep = (run: RunRef, agent: WorkflowAgent): void =>
  spawnOrchestrateHelper({ command: "close", id: agent, run });

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
  // how the agent was launched; relaunching adds the session's env, the resume prompt and the
  // run's name
  launch: Omit<LaunchOptions, "prompt" | "env" | "name">;
  home: string;
  log: ILogger;
}>;

// Polls until the probe finds something; throws when time runs out.
const pollUntil = async <T>(
  {
    everyMs,
    timeoutMs,
    timeoutError,
  }: Readonly<{ everyMs: number; timeoutMs: number; timeoutError: string }>,
  probe: () => Promise<T | undefined>,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() >= deadline) throw new Error(timeoutError);
    await Bun.sleep(everyMs);
  }
};

const waitForIdle = (terminal: ITerminal): Promise<true> =>
  pollUntil(
    { everyMs: IDLE_POLL_MS, timeoutMs: IDLE_TIMEOUT_MS, timeoutError: "Claude did not go idle" },
    async () => (isClaudeBusy(unwrap(await terminal.capture())) ? undefined : true),
  );

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// What a step threw, or undefined once it finished.
const failureOf = (step: Promise<void>): Promise<unknown> =>
  step.then(
    () => undefined,
    (error: unknown) => error ?? new Error("step failed"),
  );

// Claude is at work, or waits on a person's answer to a permission prompt or question.
const isClaudeHeld = (screen: string): boolean =>
  isClaudeBusy(screen) || isClaudeChoicePending(screen);

const resumePrompt = (run: RunRef): string => `/yok:orchestrate --resume ${run.name}`;

// The session a line goes to, and the step it is typed for.
type LineTarget = Readonly<{
  run: RunRef;
  sessionId: string;
  step: string;
  terminal: ITerminal;
  log: ILogger;
}>;

// Types once the input box shows, even while Claude finishes its turn: it holds the line until
// then. Escape only while the box is hidden and Claude is free: at a box it could interrupt the
// turn or open the Rewind menu; while Claude is held it could cancel a compaction, reject a
// permission or decline a question. false: the box never showed, nothing was typed.
const typeAtInputBox = async (terminal: ITerminal, line: string): Promise<boolean> => {
  const busyUntil = Date.now() + IDLE_TIMEOUT_MS;
  let escapesLeft = CLAUDE_MAX_ESCAPES;
  for (;;) {
    const screen = unwrap(await terminal.capture());
    // A pending choice first: a dialog with an unknown footer under a box left in scrollback would
    // otherwise pass for the box, and Enter there picks its option.
    if (!isClaudeChoicePending(screen) && hasClaudeInputBox(screen)) break;
    if (isClaudeHeld(screen)) {
      if (Date.now() >= busyUntil) return false;
      await Bun.sleep(IDLE_POLL_MS);
      continue;
    }
    if (escapesLeft === 0) return false;
    escapesLeft -= 1;
    unwrap(await terminal.sendKeys(["Escape"]));
    await Bun.sleep(CLAUDE_ESCAPE_PAUSE_MS);
  }
  unwrap(await terminal.sendKeys([CLAUDE_CLEAR_INPUT_KEY]));
  unwrap(await typeLine(terminal, line));
  return true;
};

const isResumed = async (store: IEventStore, afterSeq: number): Promise<boolean> =>
  (await store.read()).some((event) => event.seq > afterSeq && event.type === "orchestrate.resume");

// lost: Claude sat free for RESUME_TIMEOUT_MS without running `orchestrate resume`, so the line
// can be typed again. still-busy: the cap passed with Claude at work or waiting on a person, where
// it may yet take the line, so typing it again could run it twice.
type ResumeWait = "resumed" | "lost" | "still-busy";

// Only unbroken free time counts: Claude holds a line typed during its turn, and may not draw its
// spinner until a moment after Enter.
const waitForResumed = async (
  terminal: ITerminal,
  store: IEventStore,
  afterSeq: number,
): Promise<ResumeWait> => {
  const cap = Date.now() + RESUME_CAP_MS;
  let freeSince: number | undefined;
  for (;;) {
    if (await isResumed(store, afterSeq)) return "resumed";
    const now = Date.now();
    const busy = isClaudeHeld(unwrap(await terminal.capture()));
    freeSince = busy ? undefined : (freeSince ?? now);
    if (freeSince !== undefined && now >= freeSince + RESUME_TIMEOUT_MS) return "lost";
    if (now >= cap) return busy ? "still-busy" : "lost";
    await Bun.sleep(DONE_POLL_MS);
  }
};

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
const watchNewSession = ({ run, nodeRunId }: ContextStepOptions): Promise<true> =>
  pollUntil(
    {
      everyMs: DONE_POLL_MS,
      timeoutMs: DONE_TIMEOUT_MS.new,
      timeoutError: `no SessionStart for the new within ${DONE_TIMEOUT_MS.new / 1000} seconds`,
    },
    async () => ((await findContextPlanNode(run, nodeRunId)).ok ? undefined : true),
  );

const watchCompact = async (
  { run, nodeRunId }: ContextStepOptions,
  terminal: ITerminal,
): Promise<void> => {
  const startedAt = Date.now();
  let busyAt = startedAt;
  for (;;) {
    if (!(await findContextPlanNode(run, nodeRunId)).ok) return;
    // Only watching: one failed read must not end a compaction that is under way.
    const captured = await terminal.capture();
    const screen = captured.ok ? captured.value : "";
    if (screen.includes(CLAUDE_NOTHING_TO_COMPACT)) throw new Error(CLAUDE_NOTHING_TO_COMPACT);
    const now = Date.now();
    if (isClaudeBusy(screen)) busyAt = now;
    const waited = now - startedAt;
    if (waited >= COMPACT_MAX_MS) {
      throw new Error(`no SessionStart for the compact within ${COMPACT_MAX_MS / 1000} seconds`);
    }
    if (now >= Math.max(startedAt + DONE_TIMEOUT_MS.compact, busyAt + COMPACT_GRACE_MS)) {
      const seconds = Math.round(waited / 1000);
      throw new Error(
        `no SessionStart for the compact within ${seconds} seconds, and Claude no longer looks busy`,
      );
    }
    await Bun.sleep(DONE_POLL_MS);
  }
};

// The new session is linked and swapped in before the relaunch, so the run's hooks recognize it
// from its first moment. A relaunch that fails leaves the old session in the pane, so the swap is
// undone and the step fails, which resumes the old session.
const startNewSession = async (options: ContextStepOptions, terminal: ITerminal): Promise<void> => {
  const { run, registry, provider, oldSessionId, log } = options;
  const env = unwrap(await loadSessionEnv(run, provider.type));
  await waitForIdle(terminal);
  const sessionId = randomUUID();
  await registry.linkSession(run.id, { agent: "claude", sessionId });
  await replaceSession(options, oldSessionId, sessionId);
  await recordStarted(options, "new", sessionId);
  const launch = {
    ...options.launch,
    env: sessionEnv(env, run.id, options.home, writeShim(selfArgv(), options.home)),
    prompt: resumePrompt(run),
    name: run.name,
  };
  const relaunch = await failureOf(
    provider.relaunch(terminal, sessionId, launch).then((relaunched) => unwrap(relaunched)),
  );
  if (relaunch !== undefined) {
    await replaceSession(options, sessionId, oldSessionId);
    throw relaunch;
  }
  log.info({ sessionId }, "Claude relaunched on a new session");
  await watchNewSession(options);
  log.info({ sessionId }, "node completed by the new session's SessionStart");
};

const compact = async (
  options: ContextStepOptions,
  target: LineTarget,
  prompt: string | undefined,
): Promise<void> => {
  const { log } = target;
  await recordStarted(options, "compact", target.sessionId);
  const command = prompt === undefined ? "/compact" : `/compact ${prompt}`;
  // Typed once: a compaction can take minutes, so a retype could start a second one. A compaction
  // that did not happen is no emergency: the run goes on in a fuller session.
  if (!(await typeAtInputBox(target.terminal, command))) throw new Error(INPUT_UNREACHABLE);
  log.info({ command }, "compact typed");
  await watchCompact(options, target.terminal);
  log.info({}, "node completed by the compact's SessionStart");
  // Typed here, not in the SessionStart hook: Claude holds a typed prompt until its SessionStart
  // hooks end, so the hook could never see the prompt arrive.
  await resumeRun(target);
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

// Resumes the session in the pane; the --resume skill runs `orchestrate resume` first, which is
// the proof. Only a line never typed on any try pings a person: nobody drives the run. Once typed,
// a notice asking the person to type it could resume twice, so that is only logged.
const resumeRun = async (
  { run, sessionId, step, terminal, log }: LineTarget,
  // set when the session was launched with the line as its prompt: it is then never typed
  launchedAfterSeq?: number,
): Promise<void> => {
  const line = resumePrompt(run);
  let typedOnce = false;
  try {
    const store = jsonlEventStore(runDirOf(run.cwd, run.name));
    const afterSeq = launchedAfterSeq ?? (await store.read()).at(-1)?.seq ?? 0;
    const attempts = launchedAfterSeq === undefined ? RESUME_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (launchedAfterSeq === undefined) {
        if (!(await typeAtInputBox(terminal, line))) {
          log.warn({ line, attempt }, "resume line not typed: Claude's input box did not show");
          continue;
        }
        typedOnce = true;
      }
      const wait = await waitForResumed(terminal, store, afterSeq);
      if (wait === "resumed") return;
      if (wait === "still-busy") {
        return log.warn(
          { line, waitedS: RESUME_CAP_MS / 1000 },
          "resume line not confirmed: Claude is still busy and may yet take it, so it is not typed again",
        );
      }
      log.warn(
        { line, attempt, idleS: RESUME_TIMEOUT_MS / 1000 },
        "resume line lost: Claude sat idle without running orchestrate resume",
      );
    }
    if (typedOnce) {
      return log.error(
        { line, attempts: RESUME_ATTEMPTS },
        "resume line never confirmed: open the session and check whether the run is going on",
      );
    }
  } catch (error) {
    log.error({ err: error, line }, "error while sending resume prompt");
  }
  if (typedOnce) return;
  await appendRunEvent(run, {
    type: "agent.input.unreachable",
    source: "orchestrate",
    payload: { agent: "claude", sessionId, step, line },
  });
};

// A context step that did not happen still completes, so the steps after it run.
const completeNotApplied = async (
  { run, nodeRunId, log }: ContextStepOptions,
  action: ContextOutput["action"],
  reason: string,
): Promise<void> => {
  const output = { action, applied: false as const, reason };
  const failed = await failureOf(
    completeContextStep(run, nodeRunId, output).then((completed) => void unwrap(completed)),
  );
  if (failed !== undefined) log.error({ err: failed }, "context node not completed");
};

// The session in the pane carries on. A new session that is there already holds the resume line
// as its first prompt, so it is never typed again: yok only waits for the proof.
const recover = async (
  options: ContextStepOptions,
  target: LineTarget,
  action: ContextOutput["action"],
  failure: unknown,
  pane: PaneSession,
): Promise<void> => {
  options.log.error({ err: failure, action }, "context step not applied");
  await completeNotApplied(options, action, messageOf(failure));
  await resumeRun({ ...target, sessionId: pane.sessionId }, pane.launchedAfterSeq);
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
  if (terminal === undefined) return completeNotApplied(options, action, "not inside tmux");
  const target = { run, sessionId: options.oldSessionId, step, terminal, log };
  const failure = await failureOf(
    action === "new" ? startNewSession(options, terminal) : compact(options, target, prompt),
  );
  if (failure === undefined) return;
  await recover(options, target, action, failure, await sessionInPane(run, options.oldSessionId));
};

// The session in the pane after a step; launchedAfterSeq is set when a new session was launched
// with the resume line as its prompt: events after it show whether that prompt ran.
type PaneSession = Readonly<{ sessionId: string; launchedAfterSeq?: number }>;

// A new session's relaunch swaps it in, and a relaunch that fails swaps OLD back, so the last swap
// involving OLD says which is there. A log that cannot be read leaves the old session assumed.
const sessionInPane = async (run: RunRef, oldSessionId: string): Promise<PaneSession> => {
  const events = await jsonlEventStore(runDirOf(run.cwd, run.name))
    .read()
    .catch(() => []);
  const swap = events
    .filter((event) => event.type === "workflow.session.replaced")
    .map((event) => ({
      seq: event.seq,
      payload: SessionReplacedEvent.safeParse(event).data?.payload,
    }))
    .findLast(
      ({ payload }) =>
        payload?.previousSessionId === oldSessionId || payload?.sessionId === oldSessionId,
    );
  if (swap?.payload === undefined || swap.payload.sessionId === oldSessionId) {
    return { sessionId: oldSessionId };
  }
  return { sessionId: swap.payload.sessionId, launchedAfterSeq: swap.seq };
};

export type ModelStepOptions = Readonly<{
  run: RunRef;
  // seq of the workflow.model.requested event this helper carries out
  seq: number;
  // the session whose turn just ended; it is resumed on the new model
  sessionId: string;
  terminal: ITerminal | undefined;
  provider: IAgentProvider;
  // how the agent was launched; the relaunch adds the model, the session's env, the resume prompt
  // and the run's name
  launch: Omit<LaunchOptions, "prompt" | "env" | "model" | "effort" | "resume" | "name">;
  home: string;
  log: ILogger;
}>;

// Restarts the same session in its pane on the target model: flags apply to this session only,
// where /model and /effort would also become the user's default for every new session.
const resumeOnModel = async (
  options: ModelStepOptions,
  terminal: ITerminal,
  target: TierModel,
): Promise<void> => {
  const { run, provider, sessionId, launch, home } = options;
  const env = unwrap(await loadSessionEnv(run, provider.type));
  await waitForIdle(terminal);
  const store = jsonlEventStore(runDirOf(run.cwd, run.name));
  const before = (await store.read()).at(-1)?.seq ?? 0;
  unwrap(
    await provider.relaunch(terminal, sessionId, {
      ...launch,
      ...tierLaunch(target),
      resume: true,
      env: sessionEnv(env, run.id, home, writeShim(selfArgv(), home)),
      prompt: resumePrompt(run),
      name: run.name,
    }),
  );
  await waitForResume(store, sessionId, before, target.model);
};

// A relaunch only proves tmux respawned the pane: the switch happened once the resumed session's
// SessionStart arrives, which a Claude that rejects the model never sends.
const waitForResume = (
  store: IEventStore,
  sessionId: string,
  afterSeq: number,
  model: string,
): Promise<true> =>
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
      return resumed ? true : undefined;
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
  const failure: unknown =
    terminal === undefined
      ? new Error("not inside tmux")
      : await failureOf(resumeOnModel(options, terminal, target));
  const request = { requestSeq: seq, node: pending.node, ...target };
  const stored = await recordModelApplied(
    run,
    failure === undefined
      ? { ...request, applied: true }
      : { ...request, applied: false, reason: messageOf(failure) },
  );
  // Unstored, the request stays open; without its lock, the next stop's helper tries again.
  if (!stored.ok) {
    log.error({ err: stored.error, seq }, "model switch result not stored");
    await rm(runLockPath(runDir, lock), { force: true });
  }
  if (failure === undefined) {
    return log.info({ target, sessionId: options.sessionId }, "session resumed on the new model");
  }
  log.error({ err: failure, target }, "model switch failed");
  if (terminal !== undefined) {
    await resumeRun({ run, sessionId: options.sessionId, step: pending.node, terminal, log });
  }
};

export type CloseStepOptions = Readonly<{
  // the run's registered terminal on yok's tmux server; undefined when the run has none
  terminal: ITerminal | undefined;
  provider: IAgentProvider;
}>;

// Two not-busy readings in a row, so the moment between two tool calls of one turn is not taken
// for the end of the turn.
const IDLE_READINGS = 2;

const waitUntilIdle = async (terminal: ITerminal, provider: IAgentProvider): Promise<void> => {
  let readings = 0;
  await pollUntil(
    { everyMs: DONE_POLL_MS, timeoutMs: IDLE_TIMEOUT_MS, timeoutError: "the agent stayed busy" },
    async () => {
      readings = unwrap(await provider.isBusy(terminal)) ? 0 : readings + 1;
      return readings >= IDLE_READINGS ? true : undefined;
    },
  );
};

const killWhenIdle = async (terminal: ITerminal, provider: IAgentProvider): Promise<void> => {
  await waitUntilIdle(terminal, provider);
  const stopped = await provider.stop(terminal);
  if (!stopped.ok && (await terminal.isAlive())) throw new Error(stopped.error);
};

// Started by the `next` that ended the run, wherever it ran, so it runs once per run and is never
// retried; a later `next` in a resumed session finds the run already ended and starts none. It
// kills the run's terminal once the agent is no longer working, an open question included; an
// agent still busy after the idle wait is in use and stays open.
export const runCloseStep = async ({ terminal, provider }: CloseStepOptions): Promise<void> => {
  if (terminal === undefined) return;
  await failureOf(killWhenIdle(terminal, provider));
};
