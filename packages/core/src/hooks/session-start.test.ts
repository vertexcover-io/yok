import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noopLogger, runDirOf } from "@yok/sdk";
import { memoryStorage, type RunDraft } from "@yok/sdk/internal";
import { linkSession } from "./session-start.ts";

const setup = async (name: string | null) => {
  const home = mkdtempSync(join(tmpdir(), "yok-session-start-"));
  const cwd = mkdtempSync(join(tmpdir(), "yok-session-start-repo-"));
  const run: RunDraft = {
    id: "r-1",
    project: "repo",
    workflow: "demo",
    workflowPath: join(cwd, "demo.yaml"),
    inputs: {},
    sessions: [],
    name,
    terminal: null,
    config: null,
    tiers: null,
    createdAt: new Date().toISOString(),
  };
  const storage = memoryStorage();
  const addedAt = new Date().toISOString();
  await storage.projects.add("repo", { path: cwd, addedBy: { channel: "cli" }, addedAt });
  await storage.runs.addRun(run);
  if (name !== null) mkdirSync(runDirOf(cwd, name), { recursive: true });
  const deps = { storage, env: { YOK_RUN_ID: "r-1", YOK_HOME: home }, log: noopLogger };
  return { storage, deps, events: () => storage.runs.readEvents("r-1") };
};

const input = { agent: "codex", sessionId: "s1", source: "startup" } as const;

describe("link-session", () => {
  test("SC3: a session starting before init is linked to its pending run and records no event", async () => {
    const { storage, deps, events } = await setup(null);

    await linkSession.run(input, deps);

    expect((await storage.runs.findRun("r-1"))?.sessions).toEqual([
      { agent: "codex", sessionId: "s1" },
    ]);
    expect(await events()).toEqual([]);
  });

  test("SC3: a session starting on a named run is linked and records the session-start event", async () => {
    const { storage, deps, events } = await setup("feat-x");

    await linkSession.run(input, deps);

    expect((await storage.runs.findRun("r-1"))?.sessions).toEqual([
      { agent: "codex", sessionId: "s1" },
    ]);
    expect(await events()).toMatchObject([
      { type: "hooks.session-start.called", payload: { agent: "codex", sessionId: "s1" } },
    ]);
  });
});
