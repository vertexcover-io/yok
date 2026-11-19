import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeRun, WorkflowRun } from "@yok/sdk";
import { noopLogger, runDirOf } from "@yok/sdk";
import { type IStorage, memoryStorage } from "@yok/sdk/internal";
import { deliverComments, lastDelivery, scheduleDelivery, stopDeliveries } from "./delivery.ts";
import { claudeOver, EMPTY_BOX, fakeHost, RULE, seedRun, seedState } from "./fake-host.ts";

const MENU = `${RULE}\n Which colour?\n ❯ 1. Red\n   2. Blue\n Enter to select · Esc to cancel`;

const setup = async (
  overrides: Partial<WorkflowRun> = {},
  nodeRuns: Readonly<Record<string, NodeRun>> = {},
) => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "yok-delivery-")));
  const run: WorkflowRun = {
    id: "r-1",
    project: "demo",
    workflow: "w",
    workflowPath: "/w.yaml",
    inputs: {},
    cwd,
    sessions: [{ agent: "claude", sessionId: "s1" }],
    name: "demo",
    terminal: "s1",
    config: null,
    tiers: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
  const runDir = runDirOf(cwd, "demo");
  mkdirSync(runDir, { recursive: true });
  const storage = memoryStorage();
  await seedRun(storage, run, seedState(runDir, nodeRuns));
  await storage.comments.add(run.id, [
    { file: "artifacts/a.md", kind: "global", text: "one" },
    { file: "artifacts/a.md", kind: "global", text: "two" },
  ]);
  return { run, runDir, storage };
};

const statuses = async (storage: IStorage, runId: string): Promise<string[]> =>
  (await storage.comments.list(runId)).map((c) => c.status);

describe("deliverComments", () => {
  test("SC311 (SC23): two sent comments are typed once, submitted once, marked delivered and logged", async () => {
    const { run, storage } = await setup();
    const { host, calls } = fakeHost(EMPTY_BOX);

    const outcome = await deliverComments(run, {
      storage,
      providerFor: () => claudeOver(host),
      host,
      log: noopLogger,
    });

    expect(outcome).toEqual({ kind: "delivered", ids: ["c1", "c2"] });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("2 new comments");
    expect(calls[1]).toBe("keys:Enter");
    const stored = await storage.comments.list(run.id);
    expect(stored.map((c) => [c.status, typeof c.deliveredAt])).toEqual([
      ["delivered", "string"],
      ["delivered", "string"],
    ]);
    const delivered = (await storage.events(run.id).read()).filter(
      (e) => e.type === "artifact.comment.delivered",
    );
    expect(delivered.map((e) => e.payload)).toEqual([{ ids: ["c1", "c2"] }]);
  });

  test("comments are typed into an empty box while Claude works under a spinner", async () => {
    const { run, storage } = await setup();
    const { host, calls } = fakeHost(`· Ionizing… (6s · ↓ 359 tokens)\n${EMPTY_BOX}`);

    const outcome = await deliverComments(run, {
      storage,
      providerFor: () => claudeOver(host),
      host,
      log: noopLogger,
    });

    expect(outcome).toEqual({ kind: "delivered", ids: ["c1", "c2"] });
    expect(calls[0]).toContain("2 new comments");
    expect(await statuses(storage, run.id)).toEqual(["delivered", "delivered"]);
  });

  test("SC312 (SC24): delivery waits with its own reason and changes nothing when typing is unsafe", async () => {
    const context: NodeRun = {
      nodeRunId: "n1",
      nodeType: "context",
      status: "running",
      startedAt: null,
      completedAt: null,
      artifacts: [],
    };
    const cases = [
      [await setup({ name: null }), EMPTY_BOX, true, "run has no name yet"],
      [await setup({}, { c: context }), EMPTY_BOX, true, "agent is clearing its context"],
      [await setup(), MENU, true, "agent has a menu open or text in its input box"],
    ] as const;

    for (const [{ run, storage }, screen, alive, reason] of cases) {
      const { host, calls } = fakeHost(screen, alive);
      const outcome = await deliverComments(run, {
        storage,
        providerFor: () => claudeOver(host),
        host,
        log: noopLogger,
      });
      expect(outcome).toEqual({ kind: "waiting", reason });
      expect(calls).toEqual([]);
      expect(await statuses(storage, run.id)).toEqual(["sent", "sent"]);
    }
  });

  test("SC312: a session that is gone fails delivery without retrying, and changes nothing", async () => {
    for (const [made, alive] of [
      [await setup({ terminal: null }), true],
      [await setup(), false],
    ] as const) {
      const { host, calls } = fakeHost(EMPTY_BOX, alive);
      const deps = {
        storage: made.storage,
        providerFor: () => claudeOver(host),
        host,
        log: noopLogger,
      };
      const outcome = await deliverComments(made.run, deps);
      expect(outcome).toEqual({ kind: "failed", reason: "agent session is not running" });
      expect(calls).toEqual([]);
      expect(await statuses(made.storage, made.run.id)).toEqual(["sent", "sent"]);
    }
  });
});

describe("scheduleDelivery", () => {
  afterEach(stopDeliveries);

  const scheduled = async (screen: () => string) => {
    const made = await setup();
    const { host, calls } = fakeHost(screen);
    const deps = {
      storage: made.storage,
      providerFor: () => claudeOver(host),
      host,
      log: noopLogger,
    };
    return { ...made, deps, calls };
  };

  test("SC313: a batch held back by a menu is typed once the menu closes, without a new request", async () => {
    let screen = MENU;
    const { run, storage, deps, calls } = await scheduled(() => screen);

    await scheduleDelivery(run.id, deps);
    expect(lastDelivery(run.id)?.kind).toBe("waiting");
    expect(calls).toEqual([]);

    screen = EMPTY_BOX;
    for (let i = 0; i < 40 && (await statuses(storage, run.id))[0] !== "delivered"; i++)
      await Bun.sleep(100);
    expect(await statuses(storage, run.id)).toEqual(["delivered", "delivered"]);
    expect(calls.filter((c) => c.startsWith("text:"))).toHaveLength(1);
  });

  test("SC313: two deliveries started at once type the batch only once", async () => {
    const { run, storage, deps, calls } = await scheduled(() => EMPTY_BOX);

    await Promise.all([scheduleDelivery(run.id, deps), scheduleDelivery(run.id, deps)]);

    expect(calls.filter((c) => c.startsWith("text:"))).toHaveLength(1);
    expect(await statuses(storage, run.id)).toEqual(["delivered", "delivered"]);
  });
});
