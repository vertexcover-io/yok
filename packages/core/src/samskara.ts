import { realpath } from "node:fs/promises";
import {
  type ArtifactRef,
  ArtifactRefSchema,
  ERROR_MESSAGE_LIMIT,
  type Exec,
  type ExecResult,
  execWithTimeout,
  SAMSKARA_SUBSCRIBER,
  type Samskara,
  type SessionRef,
  SessionRefSchema,
  type State,
  type Subscriber,
  type SubscriberInput,
  type SubscriberRefs,
} from "@yok/sdk";
import * as z from "zod";
import { realPathsInArtifacts } from "./workflow/done.ts";

// What init freezes as the subscriber's module: the CLI serves this file under that name.
export const SAMSKARA_MODULE = "yok:samskara";
// A proof report's videos take longer than the detached default; v1 allowed this long.
export const SAMSKARA_TIMEOUT_S = 300;

// The flag the upload passes; the doctor refuses a samskara CLI whose upload lacks it.
export const UPLOAD_FLAG = "--base-dir";

// A workflow's samskara block replaces the config's whole.
export const pickSamskara = (
  workflow: Samskara | undefined,
  config: Samskara | undefined,
): Samskara | undefined => workflow ?? config;

export const buildSamskaraSubscribers = (samskara: Samskara | undefined): SubscriberRefs => {
  if (samskara?.enabled !== true) return {};
  const subscriber = {
    name: SAMSKARA_SUBSCRIBER,
    blocking: false,
    timeoutSeconds: SAMSKARA_TIMEOUT_S,
    module: SAMSKARA_MODULE,
    handler: "upload",
  };
  return { "workflow.node.completed": [subscriber] };
};

const NodeArtifactsSchema = z.looseObject({
  artifacts: z.array(ArtifactRefSchema).default([]),
  session: SessionRefSchema.optional(),
});

// artifacts/design.md stays itself; artifacts/verification/report.html sends its whole folder.
const topEntry = (path: string): string => path.split("/").slice(0, 2).join("/");

// Each target sent once: the CLI uploads nothing when two paths name the same file, yet still
// exits 0.
const findUploadTargets = async (
  runDir: string,
  artifacts: readonly ArtifactRef[],
): Promise<readonly string[]> => {
  const entries = artifacts.flatMap((artifact) =>
    "path" in artifact ? [topEntry(artifact.path)] : [],
  );
  return [...new Set(await realPathsInArtifacts(runDir, [...new Set(entries)]))];
};

// The session the completion event names, which is the one the node ran in. The run's current
// session is only a fallback for a node that ran in none, such as a script: by the time a queued
// upload runs, a context step may have replaced it.
const claudeSession = (session: SessionRef | undefined, state: State): string | undefined => {
  if (session !== undefined) return session.agent === "claude" ? session.sessionId : undefined;
  return state.activeSessions.find((active) => active.agent === "claude")?.sessionId;
};

// samskara prints a line per file, its refusals and count on stdout, and its warnings on stderr. A
// big folder's success lines would push the failed file out of the run's capped error message.
const failureLines = ({ stdout, stderr }: ExecResult): string =>
  `${stderr}\n${stdout}`
    .split("\n")
    .filter((line) => line.trim() !== "" && !/^\s*(ok|updated)\s/.test(line))
    .join("\n");

export const uploadArtifacts = async (
  { event, state }: Pick<SubscriberInput, "event" | "state">,
  exec: Exec,
): Promise<Readonly<{ uploaded: number; session: string }> | Readonly<{ skipped: string }>> => {
  const { artifacts, session: ranIn } = NodeArtifactsSchema.safeParse(event.payload).data ?? {
    artifacts: [],
  };
  const targets = await findUploadTargets(state.runDir, artifacts);
  if (targets.length === 0) return { skipped: "no artifact files" };
  const session = claudeSession(ranIn, state);
  if (session === undefined) return { skipped: "no claude session" };
  const runDir = await realpath(state.runDir);
  const args = ["artifacts", "upload", session, ...targets, UPLOAD_FLAG, runDir];
  const result = await exec("samskara", args, runDir);
  if (result.code !== 0) {
    const prefix = `samskara upload failed (exit ${result.code}): `;
    throw new Error(prefix + failureLines(result).slice(-(ERROR_MESSAGE_LIMIT - prefix.length)));
  }
  return { uploaded: targets.length, session };
};

// The subscriber init freezes for `samskara: { enabled: true }`.
export const upload: Subscriber = (input) =>
  uploadArtifacts(input, execWithTimeout(SAMSKARA_TIMEOUT_S * 1000));
