import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as spawnProcess } from "@yok/sdk";
import { VERSION } from "@yok/sdk/internal";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const BIN = join(REPO_ROOT, "node_modules", ".bin", "yok-dev");
const CLI = join(REPO_ROOT, "packages", "cli", "src", "index.ts");

// A request `orchestrate run-subscriber call` accepts on stdin: one module subscriber and a minimal valid input.
const callRequest = (module: string, handler: string) => ({
  subscriber: { name: "probe", blocking: true, timeoutSeconds: 10, module, handler },
  input: {
    event: {
      schemaVersion: 1,
      seq: 1,
      id: "evt-1",
      ts: "2026-10-03T10:00:00Z",
      type: "custom.demo.ping",
      source: "test",
      runId: "r-1",
      payload: null,
    },
    state: {
      schemaVersion: 1,
      lastEventSeq: 1,
      runId: "r-1",
      runName: "demo",
      runDir: "/work/.yok/demo",
      version: "2.0.0",
      workflow: { name: "demo", path: "workflow.yaml" },
      input: {},
      scope: null,
      startedAt: "2026-10-03T10:00:00Z",
      completedAt: null,
      status: "running",
      workspace: {
        type: "mono",
        path: "/work",
        repositories: {
          app: { path: "/work", git: { branch: "b", baseBranch: "main", startSha: "a" } },
        },
      },
      tiers: null,
      nodeRuns: {},
      activeSessions: [],
      eventHandlers: {},
      subscribers: {},
    },
    run: { id: "r-1", cwd: "/work", name: "demo" },
  },
});

const SUBSCRIBERS = `
export const leak = () => process.env.YOK_LEAK ?? "unset";
export const self = () => process.env.YOK_SELF;
`;

// The notifier's name reaches import() only as a runtime value, as it does from state.json.
const SERVED_SUBSCRIBER = `
import { NonEmptyStringSchema } from "@yok/sdk";
import { z } from "zod";
export const probe = async () => {
  const name = ["yok", "notifier"].join(":");
  const { slack } = await import(name);
  const { upload } = await import(["yok", "samskara"].join(":"));
  return {
    parsed: NonEmptyStringSchema.parse("hi"),
    slack: typeof slack,
    upload: typeof upload,
    sameZod: NonEmptyStringSchema instanceof z.ZodType && z.string() instanceof NonEmptyStringSchema.constructor,
  };
};
`;

describe("yok as one program", () => {
  let repo = "";
  let subscribers = "";
  beforeAll(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), "yok-self-")));
    subscribers = join(repo, "subscribers.ts");
    await writeFile(subscribers, SUBSCRIBERS);
    await writeFile(join(repo, ".env"), "YOK_LEAK=1\n");
  });

  const callSubscriberAt = async (
    argv: readonly [string, ...string[]],
    handler: string,
    env: Readonly<Record<string, string>> = {},
  ) => {
    const [program, ...args] = argv;
    const input = JSON.stringify(callRequest(subscribers, handler));
    return await spawnProcess(program, [...args, "orchestrate", "run-subscriber", "call"], {
      cwd: repo,
      env,
      input,
      timeoutMs: 20_000,
    });
  };

  test("SC30: yok orchestrate --help lists the skill actions and hides run-subscriber, which still runs", async () => {
    const help = await spawnProcess(
      process.execPath,
      ["--no-env-file", CLI, "orchestrate", "--help"],
      {
        cwd: REPO_ROOT,
      },
    );
    const listed = [...help.stdout.matchAll(/^ {2}([a-z-]+)/gm)].map((match) => match[1]);
    expect(listed).toEqual(
      expect.arrayContaining([
        "init",
        "link-session",
        "emit",
        "next",
        "exec",
        "done",
        "node",
        "skill",
        "hook",
        "statusline",
        "context",
        "auto-resume",
        "comments",
      ]),
    );
    expect(help.stdout).not.toContain("run-subscriber");
    const called = await callSubscriberAt([process.execPath, "--no-env-file", CLI], "leak");
    expect([called.code, called.stdout]).toEqual([0, JSON.stringify("unset")]);
  }, 30_000);

  test("SC32: a self-call or the yok-dev shebang started in a repo with a .env does not load it", async () => {
    const self = JSON.parse(process.env.YOK_SELF ?? "[]");
    const viaSelf = await callSubscriberAt(self, "leak");
    const viaShebang = await callSubscriberAt([BIN], "leak");
    const version = await spawnProcess(BIN, ["--version"], { cwd: repo });
    expect([viaSelf.stdout, viaShebang.stdout]).toEqual([
      JSON.stringify("unset"),
      JSON.stringify("unset"),
    ]);
    expect(version.stdout.trim()).toBe(VERSION);
  }, 30_000);

  test("SC89: from source, a subscriber outside the repo gets the CLI's @yok/sdk, zod, yok:notifier and yok:samskara", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "yok-served-")));
    const file = join(outside, "served.ts");
    await writeFile(file, SERVED_SUBSCRIBER);
    const [program, ...args] = [process.execPath, "--no-env-file", CLI];

    const result = await spawnProcess(program, [...args, "orchestrate", "run-subscriber", "call"], {
      cwd: outside,
      input: JSON.stringify(callRequest(file, "probe")),
      timeoutMs: 20_000,
    });

    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      parsed: "hi",
      slack: "function",
      upload: "function",
      sameZod: true,
    });
  }, 20_000);

  test("SC33: a process the CLI starts from source sees YOK_SELF naming the CLI, not the stale value its parent set", async () => {
    const result = await callSubscriberAt([process.execPath, "--no-env-file", CLI], "self", {
      YOK_SELF: JSON.stringify(["/stale"]),
    });
    expect(JSON.parse(JSON.parse(result.stdout))).toEqual([process.execPath, "--no-env-file", CLI]);
  }, 20_000);
});
