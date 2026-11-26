/// <reference path="./vendor-sh.d.ts" />
import { homedir } from "node:os";
import { dirname, join, matchesGlob, resolve } from "node:path";
import {
  type HookDeps,
  type PreToolUseHandler,
  readPolicies,
  spawn,
  type ToolCall,
  type ToolUse,
  type ToolVerdict,
  yokHome,
} from "@yok/sdk";
import { findRunningLeaf } from "@yok/sdk/internal";
import BASH_ANTIPATTERNS from "../../vendor/bash-antipatterns.sh" with { type: "text" };
import { orchestrateLine } from "../runs.ts";
import {
  findSessionRun,
  findSessionState,
  noAnswerBetweenNodesMessage,
  noAnswerMessage,
  noAnswerSubagentMessage,
  recordRunEvent,
  recordSessionEvent,
} from "./common.ts";
import {
  expandPath,
  type PathBase,
  shellRemovedTargets,
  shellWriteTargets,
} from "./write-targets.ts";

const ALLOW: ToolVerdict = { kind: "allow" };
// SQLite's write-ahead log and shared-memory files are the database as much as yok.db is.
const DATABASE_FILES = ["yok.db", "yok.db-wal", "yok.db-shm"];
const BASH_ANTIPATTERNS_TIMEOUT_MS = 10_000;

const GLOB = /[*?[]/;

const matchesPath = (target: string, path: string): boolean =>
  GLOB.test(target) ? matchesGlob(path, target) : target === path;

// The absolute path when PATH is one of the database's files, or a wildcard matching one.
export const databaseFileOf = (path: string, base: PathBase): string | undefined => {
  const abs = expandPath(path, base);
  if (abs === undefined) return undefined;
  const files = DATABASE_FILES.map((file) => join(base.yokHome, file));
  return files.some((file) => matchesPath(abs, file)) ? abs : undefined;
};

// The yok home and every folder above it: deleting or moving one takes the database with it.
const foldersHolding = (yokHome: string): readonly string[] =>
  dirname(yokHome) === yokHome ? [yokHome] : [yokHome, ...foldersHolding(dirname(yokHome))];

const databaseRefusal = (path: string, what: string): string =>
  `${path} ${what} yok's database, so this call was refused. Change a run only through ` +
  "`yok orchestrate` (`next`, `exec`, `done`, `emit`, `link-session`). Reading it is fine.";

type Refusal = Readonly<{ path: string; message: string }>;

const writeTargets = (call: ToolCall, base: PathBase): readonly string[] => {
  if (call.kind === "file-write") return [call.path];
  return call.kind === "shell" ? shellWriteTargets(call.command, base) : [];
};

const fileRefusal = (call: ToolCall, base: PathBase): Refusal | undefined => {
  const path = writeTargets(call, base)
    .map((target) => databaseFileOf(target, base))
    .find((found) => found !== undefined);
  if (path === undefined) return undefined;
  return { path, message: databaseRefusal(path, GLOB.test(path) ? "matches" : "is") };
};

const folderRefusal = (call: ToolCall, base: PathBase): Refusal | undefined => {
  if (call.kind !== "shell") return undefined;
  const folders = foldersHolding(resolve(base.yokHome));
  const path = shellRemovedTargets(call.command, base, DATABASE_FILES).find((target) =>
    folders.some((folder) => matchesPath(target, folder)),
  );
  if (path === undefined) return undefined;
  const what = GLOB.test(path) ? "matches the folder that holds" : "holds";
  return { path, message: databaseRefusal(path, what) };
};

// Refuses a call that writes, moves or deletes yok's database.
export const recordGuard: PreToolUseHandler = {
  name: "record-guard",
  run: async (use, deps) => {
    const base = { cwd: use.cwd, home: homedir(), yokHome: yokHome(deps.env) };
    const refusal = fileRefusal(use.call, base) ?? folderRefusal(use.call, base);
    return refusal === undefined ? ALLOW : { kind: "deny", ...refusal };
  },
};

// The main agent's Bash call or file edit on a blocked run shows it working again, so it closes
// the blocker. A sub-agent shares the session id but may run while the main agent waits on the
// person. Always allows: a failed record must not refuse the call.
export const recordResumed: PreToolUseHandler = {
  name: "record-resumed",
  run: async (use, deps) => {
    if (use.subagent) return ALLOW;
    try {
      const found = await findSessionState(use, deps);
      if (found === undefined) return ALLOW;
      const { run, state } = found;
      if (state.status !== "blocked" || state.blocker === undefined) return ALLOW;
      const { reason } = state.blocker;
      const payload = { agent: use.agent, sessionId: use.sessionId, reason, tool: use.toolName };
      // Another call may have closed the blocker since the read above.
      await recordRunEvent(
        run,
        { type: "agent.resumed", payload },
        deps,
        (latest) => latest?.status === "blocked" && latest.blocker?.reason === reason,
      );
    } catch (error) {
      deps.log.warn({ err: error }, "agent.resumed not recorded");
    }
    return ALLOW;
  },
};

// The vendored script reads a Claude-shaped Bash payload and refuses with exit 2, so any agent's
// shell command is handed to it in that shape. Any other failure allows the call, with a warning.
export const bashAntipatterns: PreToolUseHandler = {
  name: "bash-antipatterns",
  run: async ({ cwd, call }, { log }) => {
    if (call.kind !== "shell") return ALLOW;
    const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: call.command } });
    const result = await spawn("bash", ["-c", BASH_ANTIPATTERNS], {
      cwd,
      input,
      timeoutMs: BASH_ANTIPATTERNS_TIMEOUT_MS,
    });
    if (result.code === 2 && result.stopped === null) {
      return { kind: "deny", message: result.stderr.trim() || "Refused by bash-antipatterns.sh" };
    }
    if (result.code !== 0 || result.stopped !== null) {
      const { code, stopped, stderr } = result;
      log.warn(
        { code, stopped, stderr: stderr.slice(0, 500) },
        "bash-antipatterns.sh failed; allowed",
      );
    }
    return ALLOW;
  },
};

// Records the questions an agent puts to the person, so the notifier can post them.
export const questionNotice: PreToolUseHandler = {
  name: "question-notice",
  run: async ({ agent, sessionId, toolUseId, call }, deps) => {
    // a question whose input could not be read has nothing to post
    if (call.kind !== "question" || call.questions.length === 0) return ALLOW;
    // question-guard refuses it, so it is never asked and must not mark the run as waiting
    const found = await findSessionState({ agent, sessionId }, deps);
    if (found !== undefined && !readPolicies(found.state.policies).interaction) return ALLOW;
    const payload = {
      agent,
      sessionId,
      ...(toolUseId === undefined ? {} : { toolUseId }),
      questions: call.questions.map(({ header, ...question }) =>
        header === undefined ? question : { ...question, header },
      ),
    };
    await recordSessionEvent({ agent, sessionId }, { type: "agent.question.asked", payload }, deps);
    return ALLOW;
  },
};

// With interaction off no one will answer, so the question is refused before it is shown and the
// agent is told what to do instead. Outside a yok run it allows, as before.
export const questionGuard: PreToolUseHandler = {
  name: "question-guard",
  run: async (use, deps) => {
    if (use.call.kind !== "question") return ALLOW;
    const found = await findSessionState(use, deps);
    if (found === undefined || readPolicies(found.state.policies).interaction) return ALLOW;
    // done finishes only an agent node; a loop waiting between its children is not one. The
    // running leaf is the session's, so a subagent's question names none.
    const leaf = use.subagent ? undefined : findRunningLeaf(found.state.nodeRuns);
    const node = leaf?.run.nodeType === "agent" ? leaf : undefined;
    const payload = {
      policy: "interaction",
      effect: "question-refused",
      ...(node === undefined ? {} : { nodeId: node.path.slice(node.path.lastIndexOf(".") + 1) }),
    };
    await recordRunEvent(found.run, { type: "policy.applied", payload }, deps);
    if (use.subagent) return { kind: "deny", message: noAnswerSubagentMessage };
    if (node === undefined) {
      const next = orchestrateLine({ verb: "next", run: found.run });
      return { kind: "deny", message: noAnswerBetweenNodesMessage(next) };
    }
    const done = orchestrateLine({ verb: "done", run: found.run, nodeRunId: node.run.nodeRunId });
    return { kind: "deny", message: noAnswerMessage(done) };
  },
};

// The handlers an agent can register, by the name `orchestrate hook pre-tool-use --handler` takes.
export const preToolUseHandlers: Readonly<Record<string, PreToolUseHandler>> = Object.fromEntries(
  [recordGuard, recordResumed, bashAntipatterns, questionNotice, questionGuard].map((handler) => [
    handler.name,
    handler,
  ]),
);

const calledEvent = (use: ToolUse, handler: string, verdict: ToolVerdict) => ({
  type: "hooks.pre-tool-use.called",
  payload: {
    agent: use.agent,
    sessionId: use.sessionId,
    tool: use.toolName,
    handler,
    decision: verdict.kind,
    ...(verdict.kind === "deny" ? { message: verdict.message } : {}),
    ...(verdict.kind === "deny" && verdict.path !== undefined ? { path: verdict.path } : {}),
  },
});

const logCall = async (
  use: ToolUse,
  handler: string,
  verdict: ToolVerdict,
  deps: HookDeps,
): Promise<void> => {
  const run = await findSessionRun(use, deps).catch((error: unknown) => {
    deps.log.warn({ err: error }, "pre-tool-use call not recorded");
    return undefined;
  });
  if (run !== undefined) await recordRunEvent(run, calledEvent(use, handler, verdict), deps);
};

// A handler that fails lets the call through, or it could trap the session.
export const runPreToolUse = async (
  use: ToolUse,
  handler: PreToolUseHandler,
  deps: HookDeps,
): Promise<ToolVerdict> => {
  const verdict = await handler.run(use, deps).catch((error: unknown): ToolVerdict => {
    deps.log.error({ err: error }, `pre-tool-use allowed: ${handler.name} failed`);
    return ALLOW;
  });
  if (verdict.kind === "allow") return verdict;
  await logCall(use, handler.name, verdict, deps);
  return verdict;
};
