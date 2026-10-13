import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArtifactRef,
  ERROR_MESSAGE_LIMIT,
  type Event,
  type Exec,
  type ExecResult,
  type NodeRun,
  type SessionRef,
  type State,
} from "@yok/sdk";
import { uploadArtifacts } from "./samskara.ts";

type Call = Readonly<{ command: string; args: readonly string[]; cwd: string }>;

// Records every call and answers each with `result`.
const recordingExec = (
  result: ExecResult = { code: 0, stdout: "", stderr: "" },
): Readonly<{ exec: Exec; calls: Call[] }> => {
  const calls: Call[] = [];
  const exec: Exec = (command, args, cwd) => {
    calls.push({ command, args, cwd });
    return Promise.resolve(result);
  };
  return { exec, calls };
};

const file = (path: string): ArtifactRef => ({ type: "file", name: path, path });

const completed = (artifacts: readonly ArtifactRef[], session?: SessionRef): Event => ({
  schemaVersion: 1,
  seq: 1,
  id: "evt-1",
  ts: "2026-10-02T10:00:00Z",
  type: "workflow.node.completed",
  source: "test",
  runId: "r-demo",
  nodeId: "design",
  nodeRunId: "design-1",
  payload: {
    status: "completed",
    artifacts: [...artifacts],
    ...(session === undefined ? {} : { session }),
  },
});

const stateOf = (runDir: string, activeSessions: State["activeSessions"]): State => ({
  schemaVersion: 1,
  lastEventSeq: 0,
  runId: "r-demo",
  runName: "demo",
  runDir,
  version: "2.0.0",
  workflow: { name: "task", path: "workflow.yaml" },
  input: {},
  scope: null,
  startedAt: "2026-10-02T10:00:00Z",
  completedAt: null,
  status: "running",
  workspace: { type: "mono", path: "/work", repositories: {} },
  tiers: null,
  nodeRuns: {},
  activeSessions,
  eventHandlers: {},
  subscribers: {},
});

const CLAUDE = [{ agent: "claude", sessionId: "s-1" }] as const;

let runDir: string;

beforeEach(async () => {
  runDir = await realpath(await mkdtemp(join(tmpdir(), "samskara-")));
  await mkdir(join(runDir, "artifacts", "verification"), { recursive: true });
  await Promise.all(
    ["design.md", "plan.md", "verification/proof-report.html", "verification/01_x.mp4"].map(
      (path) => writeFile(join(runDir, "artifacts", path), "x"),
    ),
  );
});

describe("uploadArtifacts", () => {
  test("SC403: design.md goes up alone and verification/proof-report.html sends its whole folder, while plan.md and a link send nothing", async () => {
    const { exec, calls } = recordingExec();
    const link: ArtifactRef = { type: "pull-request", name: "pr", url: "https://x.test/pr/1" };
    const event = completed([
      file("artifacts/design.md"),
      file("artifacts/verification/proof-report.html"),
      link,
    ]);

    const result = await uploadArtifacts({ event, state: stateOf(runDir, [...CLAUDE]) }, exec);

    expect(calls).toEqual([
      {
        command: "samskara",
        args: [
          "artifacts",
          "upload",
          "s-1",
          join(runDir, "artifacts", "design.md"),
          join(runDir, "artifacts", "verification"),
          "--base-dir",
          runDir,
        ],
        cwd: runDir,
      },
    ]);
    expect(result).toEqual({ uploaded: 2, session: "s-1" });
  });

  test("SC404: two artifacts in verification/ send that folder once", async () => {
    const { exec, calls } = recordingExec();
    await mkdir(join(runDir, "artifacts", "verification", "screenshots"));
    await writeFile(join(runDir, "artifacts", "verification", "screenshots", "01.png"), "x");
    const event = completed([
      file("artifacts/verification/proof-report.html"),
      file("artifacts/verification/screenshots/01.png"),
    ]);

    await uploadArtifacts({ event, state: stateOf(runDir, [...CLAUDE]) }, exec);

    expect(calls.map((call) => call.args.slice(3, -2))).toEqual([
      [join(runDir, "artifacts", "verification")],
    ]);
  });

  test("SC405: a symlink to a file outside artifacts/ and a deleted file are dropped; design.md still goes up", async () => {
    const { exec, calls } = recordingExec();
    await writeFile(join(runDir, ".env"), "SECRET=1");
    await symlink(join(runDir, ".env"), join(runDir, "artifacts", "env.md"));
    const event = completed([
      file("artifacts/env.md"),
      file("artifacts/gone.md"),
      file("artifacts/design.md"),
    ]);

    await uploadArtifacts({ event, state: stateOf(runDir, [...CLAUDE]) }, exec);

    expect(calls.map((call) => call.args.slice(3, -2))).toEqual([
      [join(runDir, "artifacts", "design.md")],
    ]);
  });

  test("SC405: a folder linked to artifacts/ itself and a file linked to design.md add nothing; design.md goes up once", async () => {
    const { exec, calls } = recordingExec();
    await symlink(".", join(runDir, "artifacts", "self"));
    await symlink("design.md", join(runDir, "artifacts", "latest.md"));
    const event = completed([
      file("artifacts/self/design.md"),
      file("artifacts/latest.md"),
      file("artifacts/design.md"),
    ]);

    await uploadArtifacts({ event, state: stateOf(runDir, [...CLAUDE]) }, exec);

    expect(calls.map((call) => call.args.slice(3, -2))).toEqual([
      [join(runDir, "artifacts", "design.md")],
    ]);
  });

  test("SC405: when every artifact is outside artifacts/ or gone, samskara never runs and the upload is skipped", async () => {
    const { exec, calls } = recordingExec();
    await writeFile(join(runDir, ".env"), "SECRET=1");
    await symlink(join(runDir, ".env"), join(runDir, "artifacts", "env.md"));
    const event = completed([file("artifacts/env.md"), file("artifacts/gone.md")]);

    const result = await uploadArtifacts({ event, state: stateOf(runDir, [...CLAUDE]) }, exec);

    expect(calls).toEqual([]);
    expect(result).toEqual({ skipped: "no artifact files" });
  });

  test("SC406: a run whose only session is codex skips the upload without running samskara", async () => {
    const { exec, calls } = recordingExec();
    const state = stateOf(runDir, [{ agent: "codex", sessionId: "c-1" }]);

    const result = await uploadArtifacts(
      { event: completed([file("artifacts/design.md")]), state },
      exec,
    );

    expect(calls).toEqual([]);
    expect(result).toEqual({ skipped: "no claude session" });
  });

  test("SC407: with a codex session c-1 listed before claude s-2, the upload goes to s-2", async () => {
    const { exec, calls } = recordingExec();
    const state = stateOf(runDir, [
      { agent: "codex", sessionId: "c-1" },
      { agent: "claude", sessionId: "s-2" },
    ]);

    await uploadArtifacts({ event: completed([file("artifacts/design.md")]), state }, exec);

    expect(calls.map((call) => call.args[2])).toEqual(["s-2"]);
  });

  test("SC407: design-1 ran on s-old; when its upload runs after design-2 replaced it on s-new, the upload still goes to s-old", async () => {
    const { exec, calls } = recordingExec();
    const nextPass: NodeRun = {
      nodeRunId: "design-2",
      nodeType: "agent",
      status: "running",
      startedAt: "2026-10-02T10:06:00Z",
      completedAt: null,
      artifacts: [],
      agentState: { agent: "claude", tier: null, model: null, sessionId: "s-new", tokens: null },
    };
    const state = {
      ...stateOf(runDir, [{ agent: "claude", sessionId: "s-new" }]),
      nodeRuns: { design: nextPass },
    };
    const event = completed([file("artifacts/design.md")], { agent: "claude", sessionId: "s-old" });

    await uploadArtifacts({ event, state }, exec);

    expect(calls.map((call) => call.args[2])).toEqual(["s-old"]);
  });

  test("SC406: a node that ran on codex skips the upload, even when the run also has a claude session", async () => {
    const { exec, calls } = recordingExec();
    const event = completed([file("artifacts/design.md")], { agent: "codex", sessionId: "c-1" });

    const result = await uploadArtifacts({ event, state: stateOf(runDir, [...CLAUDE]) }, exec);

    expect(calls).toEqual([]);
    expect(result).toEqual({ skipped: "no claude session" });
  });

  test("SC408: samskara exiting 1 rejects with the exit code and samskara's own message", async () => {
    const stderr = "Session s-1 does not exist, or is not yours. Stopping.\n";
    const { exec } = recordingExec({ code: 1, stdout: "", stderr });
    const event = completed([file("artifacts/design.md")]);

    const upload = uploadArtifacts({ event, state: stateOf(runDir, [...CLAUDE]) }, exec);

    await expect(upload).rejects.toThrow(/exit 1.*does not exist, or is not yours/);
  });

  test("SC408: a server-change warning on stderr does not hide the refusal samskara printed on stdout", async () => {
    const stderr =
      "Local state was captured against https://old.test. Run `samskara init --force`.\n";
    const stdout = "\nSession s-1 does not exist, or is not yours. Stopping.\n";
    const { exec } = recordingExec({ code: 1, stdout, stderr });
    const event = completed([file("artifacts/design.md")]);

    const upload = uploadArtifacts({ event, state: stateOf(runDir, [...CLAUDE]) }, exec);

    await expect(upload).rejects.toThrow(/captured against[\s\S]*does not exist, or is not yours/);
  });
  test("SC408: a folder upload whose first file fails keeps that file's failure and the count, within the error limit, after 30 ok lines", async () => {
    const shot = (n: number) =>
      `  ok       artifacts/verification/screenshots/${String(n).padStart(2, "0")}_checkout_step_frame.png`;
    const stdout = [
      "  failed   artifacts/verification/00_proof_video.mp4  (tooLarge)",
      ...Array.from({ length: 30 }, (_, i) => shot(i + 1)),
      "",
      "30 uploaded, 1 failed",
    ].join("\n");
    const { exec } = recordingExec({ code: 1, stdout, stderr: "" });
    const event = completed([file("artifacts/verification/proof-report.html")]);

    const upload = uploadArtifacts({ event, state: stateOf(runDir, [...CLAUDE]) }, exec);
    const message = await upload.then(
      () => "",
      (error: Error) => error.message,
    );

    expect(message).toContain("00_proof_video.mp4  (tooLarge)");
    expect(message).toContain("30 uploaded, 1 failed");
    expect(message.length).toBeLessThanOrEqual(ERROR_MESSAGE_LIMIT);
  });
});
