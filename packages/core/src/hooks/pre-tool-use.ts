/// <reference path="./vendor-sh.d.ts" />
import { homedir } from "node:os";
import {
  type HookDeps,
  type PreToolUseHandler,
  readPolicies,
  readState,
  registryPath,
  runDirOf,
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
  recordRunEvent,
  recordSessionEvent,
} from "./common.ts";
import { expandPath, type PathBase, shellWriteTargets } from "./write-targets.ts";

export type ProtectedRecord =
  | Readonly<{ kind: "state" | "events"; runName: string; path: string }>
  | Readonly<{ kind: "registry"; path: string }>;

const ALLOW: ToolVerdict = { kind: "allow" };
const RUN_RECORD = /[\\/]\.yok[\\/]([^\\/]+)[\\/](state\.json|event\.jsonl)$/;
const BASH_ANTIPATTERNS_TIMEOUT_MS = 10_000;

export const protectedRecordOf = (path: string, base: PathBase): ProtectedRecord | undefined => {
  const abs = expandPath(path, base);
  if (abs === undefined) return undefined;
  if (abs === registryPath(base.yokHome)) return { kind: "registry", path: abs };
  const match = RUN_RECORD.exec(abs);
  const runName = match?.[1];
  if (runName === undefined) return undefined;
  return { kind: match?.[2]?.startsWith("state") ? "state" : "events", runName, path: abs };
};

const recordMessage = (record: ProtectedRecord): string => {
  if (record.kind === "registry") {
    return (
      `${record.path} is the yok registry, so this call was refused. It changes only ` +
      "through `yok orchestrate init NAME` and " +
      "`yok orchestrate link-session --run NAME --agent AGENT --session-id ID`. " +
      "Reading it is fine."
    );
  }
  const run = record.runName;
  return (
    `${record.path} is written only by the orchestrate script, so this call was refused. ` +
    `Move the run with \`yok orchestrate next --run ${run}\`, record a node with ` +
    `\`yok orchestrate exec|done NODE_RUN_ID --run ${run}\`, and add an event with ` +
    `\`yok orchestrate emit TYPE --run ${run} --source SKILL\`. Reading the file is fine.`
  );
};

const callTargets = (call: ToolCall, base: PathBase): readonly string[] => {
  if (call.kind === "file-write") return [call.path];
  return call.kind === "shell" ? shellWriteTargets(call.command, base) : [];
};

// Refuses a call that writes, moves or deletes a run's state.json or event.jsonl, or the registry.
export const recordGuard: PreToolUseHandler = {
  name: "record-guard",
  run: async (use, deps) => {
    const base = { cwd: use.cwd, home: homedir(), yokHome: yokHome(deps.env) };
    const record = callTargets(use.call, base)
      .map((target) => protectedRecordOf(target, base))
      .find((found) => found !== undefined);
    if (record === undefined) return ALLOW;
    return { kind: "deny", message: recordMessage(record), path: record.path };
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
      const run = await findSessionRun(use, deps);
      if (run === undefined) return ALLOW;
      const state = await readState(runDirOf(run.cwd, run.name));
      if (state?.status !== "blocked" || state.blocker === undefined) return ALLOW;
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
    if (call.kind !== "question") return ALLOW;
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
    // done finishes only an agent node; a loop waiting between its children is not one.
    const leaf = findRunningLeaf(found.state.nodeRuns);
    const node = leaf?.run.nodeType === "agent" ? leaf : undefined;
    const payload = {
      policy: "interaction",
      effect: "question-refused",
      ...(node === undefined ? {} : { nodeId: node.path.slice(node.path.lastIndexOf(".") + 1) }),
    };
    await recordRunEvent(found.run, { type: "policy.applied", payload }, deps);
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
