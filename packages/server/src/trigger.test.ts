import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Check, IStorage, ITriggerRepository, LaunchOptions } from "@yok/sdk";
import { createGit, fail, noopLogger, ok } from "@yok/sdk";
import { memoryStorage, type Trigger, type TriggerDraft } from "@yok/sdk/internal";
import { createApi } from "./app.ts";
import { fakeHost, fakePane, fakeProvider, seedState } from "./fake-host.ts";
import { checkCheckoutWith } from "./server.ts";
import {
  dueSlot,
  fireTrigger,
  nextSlot,
  startScheduler,
  stopScheduler,
  type TriggerDeps,
  tick,
} from "./trigger.ts";

const at = (iso: string): Date => new Date(iso);

describe("nextSlot", () => {
  test.each([
    [
      "9am Kolkata after 10:30 Kolkata is 9am Kolkata the next day",
      { cron: "0 9 * * *", timezone: "Asia/Kolkata" },
      "2026-10-23T05:00:00.000Z",
      "2026-10-24T03:30:00.000Z",
    ],
    [
      "9am London on the day the clocks go forward is 08:00 UTC, not 09:00",
      { cron: "0 9 * * *", timezone: "Europe/London" },
      "2026-03-28T10:00:00.000Z",
      "2026-03-29T08:00:00.000Z",
    ],
    [
      "weekdays only: after Friday's 9am the next slot is Monday",
      { cron: "0 9 * * 1-5", timezone: "UTC" },
      "2026-10-23T09:00:00.000Z",
      "2026-10-26T09:00:00.000Z",
    ],
  ])("%s", (_label, schedule, after, expected) => {
    expect(nextSlot(schedule, at(after)).toISOString()).toBe(expected);
  });
});

describe("dueSlot", () => {
  const daily = { cron: "0 9 * * *", timezone: "UTC" };

  test("a trigger whose next fire is still ahead is not due", () => {
    const trigger = { ...daily, nextFireAt: "2026-10-23T09:00:00.000Z" };
    expect(dueSlot(trigger, at("2026-10-23T08:59:59.000Z"))).toBeNull();
  });

  test("a slot one minute old fires, with nothing missed and the next slot tomorrow", () => {
    const trigger = { ...daily, nextFireAt: "2026-10-23T09:00:00.000Z" };
    expect(dueSlot(trigger, at("2026-10-23T09:01:00.000Z"))).toEqual({
      slot: at("2026-10-23T09:00:00.000Z"),
      missedFrom: null,
      tooLate: false,
      next: at("2026-10-24T09:00:00.000Z"),
    });
  });

  test("after sleeping through three 9am slots, only today's fires and the first missed one is reported", () => {
    const trigger = { ...daily, nextFireAt: "2026-10-20T09:00:00.000Z" };
    expect(dueSlot(trigger, at("2026-10-23T09:05:00.000Z"))).toEqual({
      slot: at("2026-10-23T09:00:00.000Z"),
      missedFrom: at("2026-10-20T09:00:00.000Z"),
      tooLate: false,
      next: at("2026-10-24T09:00:00.000Z"),
    });
  });

  test("a tick 300ms into today's slot, days after the last fire, fires today's slot and not yesterday's", () => {
    const trigger = { ...daily, nextFireAt: "2026-10-20T09:00:00.000Z" };
    expect(dueSlot(trigger, at("2026-10-23T09:00:00.300Z"))?.slot).toEqual(
      at("2026-10-23T09:00:00.000Z"),
    );
  });

  test("a tick 500ms before the next minutely slot, on a stale trigger, fires the slot that has passed and not the one ahead", () => {
    const trigger = {
      cron: "* * * * *",
      timezone: "UTC",
      nextFireAt: "2026-10-23T08:50:00.000Z",
    };
    expect(dueSlot(trigger, at("2026-10-23T09:00:59.500Z"))?.slot).toEqual(
      at("2026-10-23T09:00:00.000Z"),
    );
  });

  test.each([
    ["5h59m old fires", "2026-10-23T14:59:00.000Z", false],
    ["7h old is too late", "2026-10-23T16:00:00.000Z", true],
  ])("a slot %s", (_label, now, tooLate) => {
    const trigger = { ...daily, nextFireAt: "2026-10-23T09:00:00.000Z" };
    expect(dueSlot(trigger, at(now))?.tooLate).toBe(tooLate);
  });
});

const DIGEST = [
  "name: digest",
  "inputs:",
  "  prompt: { type: string, required: true }",
  "trigger:",
  '  cron: "0 9 * * *"',
  "  timezone: UTC",
  "  inputs: { prompt: summarise yesterday }",
  "nodes:",
  "  - id: a",
  "    type: exec",
  "    runtime: sh",
  '    script: "true"',
  "    input: null",
  "",
].join("\n");

const saveOk = async (store: ITriggerRepository, draft: TriggerDraft): Promise<Trigger> => {
  const result = await store.save(draft);
  if (!result.ok) throw new Error(`clashes with ${result.error.name}`);
  return result.value;
};

const makeRepo = (workflow: string = DIGEST): string => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "yok-trigger-repo-")));
  execFileSync("git", ["init", "-q"], { cwd });
  writeFileSync(join(cwd, ".gitignore"), ".yok/\n");
  writeFileSync(join(cwd, "orchestrate.config.json"), '{ "version": 2 }\n');
  writeFileSync(join(cwd, "digest.yaml"), workflow);
  return cwd;
};

// Saves project NAME, in place of any project of that name: a test points web at a clone.
const registerProject = async (
  storage: IStorage,
  name: string,
  project: Readonly<{ path: string; git?: string }>,
): Promise<void> => {
  await storage.projects.remove(name);
  const added = await storage.projects.add(name, {
    ...project,
    addedBy: { channel: "cli" },
    addedAt: "2026-10-23T00:00:00.000Z",
  });
  if (!added.ok) throw new Error(added.error);
};

// A server's view of the world: a fresh home, a repo registered as project web holding the
// workflow, and a provider that records each launch instead of starting an agent.
const setup = async (workflow?: string) => {
  const cwd = makeRepo(workflow);
  const home = mkdtempSync(join(tmpdir(), "yok-trigger-home-"));
  const storage = memoryStorage();
  await registerProject(storage, "web", { path: cwd });
  const launches: LaunchOptions[] = [];
  const store = storage.triggers;
  const deps = (now: string, alive = true): TriggerDeps => ({
    storage,
    providerFor: (agent) =>
      fakeProvider(agent, (options) => {
        launches.push(options);
        return Promise.resolve({
          ok: true,
          value: { terminalName: "s1", terminal: fakePane("s1") },
        });
      }),
    host: fakeHost("", alive).host,
    home,
    publicOrigin: "http://localhost:1",
    git: createGit(),
    // the fake host and provider bring no runtime checks of their own
    checkCheckout: (input) => checkCheckoutWith([], input),
    log: noopLogger,
    now: () => new Date(now),
  });
  const trigger: Trigger = await saveOk(store, {
    name: "digest",
    project: "web",
    workflow: join(cwd, "digest.yaml"),
    config: null,
    cron: "0 9 * * *",
    timezone: "UTC",
    nextFireAt: "2026-10-23T09:00:00.000Z",
  });
  return { cwd, home, store, storage, launches, deps, trigger };
};

const TIMEOUT_MS = 20_000;

describe("tick", () => {
  test(
    "SC516: a due trigger launches once in auto with its inputs and a dated run name, logs started, and moves to the next slot",
    async () => {
      const { store, launches, deps, trigger } = await setup();

      await tick(deps("2026-10-23T09:00:10.000Z"));

      expect(launches).toHaveLength(1);
      expect(launches[0]?.permissionMode).toBe("auto");
      expect(launches[0]?.prompt).toEndWith(
        '--inputs {"prompt":"summarise yesterday"} --name digest-20261023-090000',
      );
      const [fired] = await store.readFires(trigger.id, 20);
      expect(fired).toMatchObject({
        status: "started",
        slot: "2026-10-23T09:00:00.000Z",
        runName: "digest-20261023-090000",
      });
      expect(fired?.runId).toMatch(/^r-/);
      expect((await store.list())[0]?.nextFireAt).toBe("2026-10-24T09:00:00.000Z");
    },
    TIMEOUT_MS,
  );

  test(
    "SC3007: a firing on cloned project web pulls first, launches with the block's acceptEdits and inputs, and saves interaction false from cli",
    async () => {
      const setupEnv = await setup();
      const { home, store, storage, deps } = setupEnv;
      await store.remove(setupEnv.trigger.id);
      const cwd = join(realpathSync(home), "projects", "web");
      mkdirSync(cwd, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd });
      writeFileSync(join(cwd, ".gitignore"), ".yok/\n");
      writeFileSync(join(cwd, "orchestrate.config.json"), '{ "version": 2 }\n');
      writeFileSync(
        join(cwd, "digest.yaml"),
        DIGEST.replace("  timezone: UTC", "  timezone: UTC\n  permissionMode: acceptEdits"),
      );
      await registerProject(storage, "web", { path: cwd, git: "https://example.test/web.git" });
      const trigger = await saveOk(store, {
        name: "digest",
        project: "web",
        workflow: join(cwd, "digest.yaml"),
        config: null,
        cron: "0 9 * * *",
        timezone: "UTC",
        nextFireAt: "2026-10-23T09:00:00.000Z",
      });
      const order: string[] = [];
      const base = deps("2026-10-23T09:00:10.000Z");
      const launched: LaunchOptions[] = [];

      await tick({
        ...base,
        git: {
          ...base.git,
          pullFastForward: (path) => {
            order.push(`pull ${path}`);
            return Promise.resolve({ ok: true, value: null });
          },
        },
        providerFor: (agent) =>
          fakeProvider(agent, (options) => {
            order.push("launch");
            launched.push(options);
            return Promise.resolve({
              ok: true,
              value: { terminalName: "s1", terminal: fakePane("s1") },
            });
          }),
      });

      expect(order).toEqual([`pull ${cwd}`, "launch"]);
      expect(launched[0]?.permissionMode).toBe("acceptEdits");
      expect(launched[0]?.prompt).toEndWith(
        '--inputs {"prompt":"summarise yesterday"} --name digest-20261023-090000',
      );
      const [fired] = await store.readFires(trigger.id, 20);
      expect(fired?.status).toBe("started");
      const run = await storage.runs.findRun(fired?.runId ?? "");
      expect(run?.source).toBe("trigger");
      expect(run?.policies?.values.interaction).toBe(false);
      expect(run?.policies?.sources.interaction).toBe("cli");
    },
    TIMEOUT_MS,
  );

  test(
    "SC3007: a firing whose pull fails logs failed, records no run, and the schedule moves on",
    async () => {
      const { home, store, storage, deps } = await setup();
      const cwd = join(realpathSync(home), "projects", "web");
      mkdirSync(cwd, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd });
      writeFileSync(join(cwd, "orchestrate.config.json"), '{ "version": 2 }\n');
      writeFileSync(join(cwd, "digest.yaml"), DIGEST);
      // Replacing project web deletes its trigger, so it is saved again in the clone.
      await registerProject(storage, "web", { path: cwd, git: "https://example.test/web.git" });
      const trigger = await saveOk(store, {
        name: "digest",
        project: "web",
        workflow: join(cwd, "digest.yaml"),
        config: null,
        cron: "0 9 * * *",
        timezone: "UTC",
        nextFireAt: "2026-10-23T09:00:00.000Z",
      });
      const base = deps("2026-10-23T09:00:10.000Z");

      await tick({
        ...base,
        git: {
          ...base.git,
          pullFastForward: () => Promise.resolve({ ok: false, error: "diverged" }),
        },
      });

      const [fired] = await store.readFires(trigger.id, 20);
      expect(fired).toMatchObject({ status: "failed", slot: "2026-10-23T09:00:00.000Z" });
      expect(fired?.status === "failed" ? fired.reason : "").toContain("git pull");
      expect(await storage.runs.listRuns()).toEqual([]);
      expect((await store.list())[0]?.nextFireAt).toBe("2026-10-24T09:00:00.000Z");
    },
    TIMEOUT_MS,
  );

  test(
    "SC3007: a firing whose project folder is gone logs failed, records no run, and the schedule moves on",
    async () => {
      const { cwd, store, storage, launches, deps, trigger } = await setup();
      rmSync(cwd, { recursive: true, force: true });

      await tick(deps("2026-10-23T09:00:10.000Z"));

      const [fired] = await store.readFires(trigger.id, 20);
      expect(fired?.status).toBe("failed");
      expect(launches).toEqual([]);
      expect(await storage.runs.listRuns()).toEqual([]);
      expect((await store.list())[0]?.nextFireAt).toBe("2026-10-24T09:00:00.000Z");
    },
    TIMEOUT_MS,
  );

  test(
    "SC517: the tick stores the next slot before firing, so a second tick in the same minute fires nothing",
    async () => {
      const { store, launches, deps, trigger } = await setup();
      const seen: (string | undefined)[] = [];
      const readStored: Check = {
        name: "reads the stored trigger",
        fix: [],
        run: async () => {
          seen.push((await store.find("web", "digest"))?.nextFireAt);
          return ok("read");
        },
      };
      const first = deps("2026-10-23T09:00:10.000Z");

      await tick({ ...first, checkCheckout: (input) => checkCheckoutWith([readStored], input) });
      await tick(deps("2026-10-23T09:00:25.000Z"));

      expect(seen).toEqual(["2026-10-24T09:00:00.000Z"]);
      expect(launches).toHaveLength(1);
      expect(await store.readFires(trigger.id, 20)).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  test(
    "SC521, SC7314: a fire 2 minutes after a launch whose agent has not named its run yet logs skipped and launches nothing",
    async () => {
      const { store, storage, launches, deps, trigger } = await setup();
      await tick(deps("2026-10-23T09:00:10.000Z"));

      await fireTrigger(trigger, at("2026-10-23T09:02:10.000Z"), deps("2026-10-23T09:02:10.000Z"));

      expect(launches).toHaveLength(1);
      const fires = await store.readFires(trigger.id, 20);
      expect(fires[1]).toMatchObject({ status: "skipped", reason: "previous run still running" });
      expect(await storage.runs.listRuns()).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  test(
    "a run whose live agent never named it does not block the next day's slot",
    async () => {
      const { launches, deps } = await setup();
      await tick(deps("2026-10-23T09:00:10.000Z"));

      await tick(deps("2026-10-24T09:00:10.000Z"));

      expect(launches).toHaveLength(2);
    },
    TIMEOUT_MS,
  );

  test.each([
    ["has completed fires its next slot", "completed" as const, 2, "started" as const],
    ["is still running logs skipped for its next slot", "running" as const, 1, "skipped" as const],
  ])(
    "SC3015: a trigger whose last run is named and %s, while its agent session stays open",
    async (_label, status, launchCount, outcome) => {
      const { cwd, store, storage, launches, deps, trigger } = await setup();
      await tick(deps("2026-10-23T09:00:10.000Z"));
      const [fired] = await store.readFires(trigger.id, 20);
      const runDir = join(cwd, ".yok", "digest-20261023-090000");
      mkdirSync(runDir, { recursive: true });
      const state = { ...seedState(runDir, {}), status };
      const named = await storage.runs.initRun(fired?.runId ?? "", "digest-20261023-090000", state);
      if (!named.ok) throw new Error(named.error);

      await tick(deps("2026-10-24T09:00:10.000Z"));

      expect(launches).toHaveLength(launchCount);
      const last = (await store.readFires(trigger.id, 20)).at(-1);
      expect(last?.status).toBe(outcome);
      if (outcome === "skipped") expect(last?.reason).toBe("previous run still running");
    },
    TIMEOUT_MS,
  );

  test(
    "a trigger whose last run's agent has exited fires its next slot",
    async () => {
      const { launches, deps } = await setup();
      await tick(deps("2026-10-23T09:00:10.000Z"));

      await tick(deps("2026-10-24T09:00:10.000Z", false));

      expect(launches).toHaveLength(2);
    },
    TIMEOUT_MS,
  );

  test.each([
    ["is not valid YAML", "nodes: [\n", "yaml:"],
    [
      "has no trigger block any more",
      DIGEST.replace(/trigger:\n( {2}.*\n){3}/, ""),
      "has no trigger block any more",
    ],
  ])(
    "when the first trigger's workflow file %s, it logs failed and the second trigger still fires",
    async (_label, broken, reason) => {
      const { cwd, storage, store, launches, deps, trigger } = await setup();
      const otherCwd = makeRepo();
      await registerProject(storage, "other", { path: otherCwd });
      const other = await saveOk(store, {
        ...trigger,
        project: "other",
        workflow: join(otherCwd, "digest.yaml"),
      });
      writeFileSync(join(cwd, "digest.yaml"), broken);

      await tick(deps("2026-10-23T09:00:10.000Z"));

      expect(launches).toHaveLength(1);
      const [failed] = await store.readFires(trigger.id, 20);
      expect(failed?.status).toBe("failed");
      expect(failed?.reason).toContain(reason);
      expect((await store.readFires(other.id, 20)).map((f) => f.status)).toEqual(["started"]);
    },
    TIMEOUT_MS,
  );

  test(
    "SC3008: a firing the doctor refuses logs failed with the BLOCKED verdict line and records no run",
    async () => {
      const { store, storage, launches, deps, trigger } = await setup();
      const base = deps("2026-10-23T09:00:10.000Z");
      const failing: Check = {
        name: "api-key",
        fix: [],
        run: async () => fail("YOK_TRIGGER_UNSET_KEY is not set"),
      };

      await tick({ ...base, checkCheckout: (input) => checkCheckoutWith([failing], input) });

      expect(launches).toHaveLength(0);
      const [fired] = await store.readFires(trigger.id, 20);
      expect(fired?.status).toBe("failed");
      expect(fired?.reason).toStartWith("BLOCKED");
      expect(fired?.reason).toContain("api-key");
      expect(await storage.runs.listRuns()).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test.each([
    ["a trigger removed", null],
    ["SC519: a trigger re-added with an 18:00 cron", "0 18 * * *"],
  ])(
    "%s after the tick listed it does not fire, and keeps what the change saved",
    async (_label, newCron) => {
      const { store, launches, deps, trigger } = await setup();
      if (newCron === null) await store.remove(trigger.id);
      else await store.save({ ...trigger, cron: newCron, nextFireAt: "2026-10-23T18:00:00.000Z" });
      const saved = await store.list();
      const stale = deps("2026-10-23T09:00:10.000Z");
      const triggers = { ...stale.storage.triggers, list: async () => [trigger] };

      await tick({ ...stale, storage: { ...stale.storage, triggers } });

      expect(launches).toHaveLength(0);
      expect(await store.list()).toEqual(saved);
      expect(await store.readFires(trigger.id, 20)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "SC520, SC3009: a trigger removed while its doctor runs reports skipped removed, records no run and leaves no fire row",
    async () => {
      const { store, storage, launches, deps, trigger } = await setup();
      const base = deps("2026-10-23T09:00:10.000Z");
      const rmDuringDoctor: Check = {
        name: "rm lands here",
        fix: [],
        run: async () => {
          await store.remove(trigger.id);
          return ok("removed");
        },
      };

      const fired = await fireTrigger(trigger, at("2026-10-23T09:00:00.000Z"), {
        ...base,
        checkCheckout: (input) => checkCheckoutWith([rmDuringDoctor], input),
      });

      expect(fired).toMatchObject({ status: "skipped", reason: "removed" });
      expect(launches).toHaveLength(0);
      expect(await storage.runs.listRuns()).toEqual([]);
      expect(await store.readFires(trigger.id, 20)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "SC518, SC3014: after sleeping three days it logs one skipped fire for the missed slots, then fires today's slot once",
    async () => {
      const { store, launches, deps, trigger } = await setup();
      await store.setNextFireAt(trigger, "2026-10-20T09:00:00.000Z");

      await tick(deps("2026-10-23T09:05:00.000Z"));

      expect(launches).toHaveLength(1);
      const fires = await store.readFires(trigger.id, 20);
      expect(fires.map((f) => [f.status, f.slot])).toEqual([
        ["skipped", "2026-10-20T09:00:00.000Z"],
        ["started", "2026-10-23T09:00:00.000Z"],
      ]);
      expect(fires[0]?.reason).toBe(
        "missed: slept through the slots up to 2026-10-23T09:00:00.000Z",
      );
    },
    TIMEOUT_MS,
  );

  test(
    "SC3013: a slot 7h old logs skipped too late and launches nothing, and the trigger waits for tomorrow",
    async () => {
      const { store, launches, deps, trigger } = await setup();

      await tick(deps("2026-10-23T16:00:00.000Z"));

      expect(launches).toHaveLength(0);
      const [fired] = await store.readFires(trigger.id, 20);
      expect(fired).toMatchObject({ status: "skipped", slot: "2026-10-23T09:00:00.000Z" });
      expect(fired?.reason).toBe("too late: more than 6h past its slot");
      expect((await store.list())[0]?.nextFireAt).toBe("2026-10-24T09:00:00.000Z");
    },
    TIMEOUT_MS,
  );

  test.each([
    ["SC7323: a test-audit trigger fires once", "test-audit", 1, "started"],
    ["SC7324: a digest trigger is still skipped", "digest", 0, "skipped"],
  ] as const)(
    "%s when its slot is 10 hours old",
    async (_label, name, launchCount, outcome) => {
      const { store, launches, deps, trigger } = await setup();
      await store.remove(trigger.id);
      const saved = await saveOk(store, { ...trigger, name });

      await tick(deps("2026-10-23T19:00:10.000Z"));

      expect(launches).toHaveLength(launchCount);
      const last = (await store.readFires(saved.id, 20)).at(-1);
      expect(last).toMatchObject({ status: outcome, slot: "2026-10-23T09:00:00.000Z" });
      if (outcome === "skipped") expect(last?.reason).toBe("too late: more than 6h past its slot");
      expect((await store.list())[0]?.nextFireAt).toBe("2026-10-24T09:00:00.000Z");
    },
    TIMEOUT_MS,
  );
});

describe("scheduler", () => {
  test(
    "a manual fire sent while the scheduler's first tick fires the same trigger waits its turn and logs skipped",
    async () => {
      const { store, launches, deps, trigger } = await setup();
      const now = new Date();
      await store.save({ ...trigger, cron: "* * * * *", nextFireAt: now.toISOString() });
      const app = createApi({
        ...deps(now.toISOString()),
        pid: 1,
        version: "0.0.0-test",
        startedAt: 0,
        stopping: new AbortController().signal,
      });

      startScheduler(deps(now.toISOString()));
      const reply = await app.request("/triggers/fire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: trigger.project, name: "digest" }),
      });
      await stopScheduler();

      expect(launches).toHaveLength(1);
      expect(((await reply.json()) as { fire: { status: string } }).fire.status).toBe("skipped");
    },
    TIMEOUT_MS,
  );
});

describe("/triggers routes", () => {
  const appFor = async (workflow?: string) => {
    const env = await setup(workflow);
    await env.store.remove(env.trigger.id);
    const app = createApi({
      ...env.deps("2026-10-23T09:00:10.000Z"),
      pid: 1,
      version: "0.0.0-test",
      startedAt: 0,
      stopping: new AbortController().signal,
    });
    const call = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { ...env, call };
  };

  test(
    "add registers the workflow's trigger under its name with the next 9am, and adding again keeps its id",
    async () => {
      const { cwd, call } = await appFor();
      const workflowPath = join(cwd, "digest.yaml");
      const body = { project: "web", workflow: "digest.yaml" };

      const first = await call("POST", "/triggers", body);
      expect(first.status).toBe(201);
      const { trigger } = (await first.json()) as { trigger: Trigger };
      expect(trigger).toMatchObject({
        name: "digest",
        cron: "0 9 * * *",
        timezone: "UTC",
        project: "web",
      });
      expect(trigger.workflow).toBe(workflowPath);
      expect(trigger.nextFireAt).toMatch(/T09:00:00\.000Z$/);
      expect(new Date(trigger.nextFireAt).getTime()).toBeGreaterThan(Date.now());

      writeFileSync(workflowPath, DIGEST.replace('"0 9 * * *"', '"0 18 * * *"'));
      const again = (await (await call("POST", "/triggers", body)).json()) as {
        trigger: Trigger;
      };
      expect(again.trigger).toMatchObject({ id: trigger.id, cron: "0 18 * * *" });
    },
    TIMEOUT_MS,
  );

  test.each([
    ["SC523: add of a second file whose workflow is also named digest", "copy.yaml", DIGEST],
    [
      "add of the same file after its workflow was renamed",
      "digest.yaml",
      DIGEST.replace("digest", "brief"),
    ],
  ])(
    "%s is 409 and leaves the first trigger as it was",
    async (_label, file, workflow) => {
      const { cwd, store, call } = await appFor();
      await call("POST", "/triggers", { project: "web", workflow: "digest.yaml" });
      const before = await store.list();

      writeFileSync(join(cwd, file), workflow);
      const res = await call("POST", "/triggers", { project: "web", workflow: file });

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
        "yok trigger rm digest --project web",
      );
      expect(await store.list()).toEqual(before);
    },
    TIMEOUT_MS,
  );

  test.each([
    ["a workflow with no trigger block", DIGEST.replace(/trigger:\n( {2}.*\n){3}/, ""), "trigger"],
    [
      "trigger inputs the workflow does not accept",
      DIGEST.replace("{ prompt: summarise yesterday }", "{}"),
      "input: trigger.inputs.prompt",
    ],
  ])("add with %s is 400 and stores nothing", async (_label, workflow, message) => {
    const { store, call } = await appFor(workflow);

    const res = await call("POST", "/triggers", { project: "web", workflow: "digest.yaml" });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(message);
    expect(await store.list()).toEqual([]);
  });

  test(
    "SC522, SC3005: a trigger added to project web is listed, fired in web's folder, logged and removed by project and name",
    async () => {
      const { cwd, storage, launches, call } = await appFor();

      const added = await call("POST", "/triggers", { project: "web", workflow: "digest.yaml" });
      expect(added.status).toBe(201);
      const { trigger } = (await added.json()) as { trigger: Trigger };
      expect(trigger).toMatchObject({ project: "web", workflow: join(cwd, "digest.yaml") });

      const fired = await call("POST", "/triggers/fire", { project: "web", name: "digest" });
      expect(fired.status).toBe(200);
      const { fire } = (await fired.json()) as {
        fire: { status: string; runId: string; runName: string };
      };
      expect(fire.status).toBe("started");
      // to the second, so a second fire in the same minute does not reuse the run's folder
      expect(fire.runName).toMatch(/^digest-\d{8}-\d{6}$/);
      expect(launches).toHaveLength(1);
      expect((await storage.runs.findRun(fire.runId))?.cwd).toBe(cwd);

      const listed = (await (await call("GET", "/triggers")).json()) as {
        triggers: { name: string; project: string; lastFire: { runId: string } | null }[];
      };
      expect(listed.triggers.map((t) => [t.name, t.project, t.lastFire?.runId])).toEqual([
        ["digest", "web", fire.runId],
      ]);

      const query = "project=web&name=digest";
      const log = (await (await call("GET", `/triggers/log?${query}`)).json()) as {
        fires: { runId: string }[];
      };
      expect(log.fires.map((f) => f.runId)).toEqual([fire.runId]);

      expect((await call("DELETE", `/triggers?${query}`)).status).toBe(200);
      const gone = await call("GET", `/triggers/log?${query}`);
      expect(gone.status).toBe(404);
      const { error } = (await gone.json()) as { error: { message: string } };
      expect(error.message).toContain("digest");
      expect(error.message).toContain("project web");
      expect((await (await call("GET", "/triggers")).json()) as unknown).toEqual({ triggers: [] });
    },
    TIMEOUT_MS,
  );

  test("SC3006: adding a trigger to unknown project mobile is 400 naming only mobile, and stores nothing", async () => {
    const { call } = await appFor();

    const res = await call("POST", "/triggers", { project: "mobile", workflow: "digest.yaml" });

    expect(res.status).toBe(400);
    const { message } = ((await res.json()) as { error: { message: string } }).error;
    expect(message).toBe('unknown project "mobile"');
    expect((await (await call("GET", "/triggers")).json()) as unknown).toEqual({ triggers: [] });
  });

  test(
    "SC524, SC3010: removing project web while it has triggers digest and nightly is 409 naming both; api and then a trigger-less web remove",
    async () => {
      const { cwd, storage, call } = await appFor();
      writeFileSync(join(cwd, "nightly.yaml"), DIGEST.replace("name: digest", "name: nightly"));
      await registerProject(storage, "api", { path: makeRepo() });
      await call("POST", "/triggers", { project: "web", workflow: "digest.yaml" });
      await call("POST", "/triggers", { project: "web", workflow: "nightly.yaml" });

      const refused = await call("DELETE", "/projects/web");
      expect(refused.status).toBe(409);
      const { error } = (await refused.json()) as { error: { message: string } };
      expect(error.message).toContain("digest");
      expect(error.message).toContain("nightly");
      expect(Object.keys(await storage.projects.list())).toContain("web");

      expect((await call("DELETE", "/projects/api")).status).toBe(200);

      await call("DELETE", "/triggers?project=web&name=digest");
      await call("DELETE", "/triggers?project=web&name=nightly");
      expect((await call("DELETE", "/projects/web")).status).toBe(200);
    },
    TIMEOUT_MS,
  );

  test(
    "two fires of one trigger sent at once launch one run, and the other logs skipped",
    async () => {
      const { launches, call } = await appFor();
      await call("POST", "/triggers", { project: "web", workflow: "digest.yaml" });

      const replies = await Promise.all([
        call("POST", "/triggers/fire", { project: "web", name: "digest" }),
        call("POST", "/triggers/fire", { project: "web", name: "digest" }),
      ]);

      expect(launches).toHaveLength(1);
      const statuses = await Promise.all(
        replies.map(async (r) => ((await r.json()) as { fire: { status: string } }).fire.status),
      );
      expect(statuses.toSorted()).toEqual(["skipped", "started"]);
    },
    TIMEOUT_MS,
  );

  test("fire for a name the project has no trigger under is 404", async () => {
    const { call } = await appFor();
    const res = await call("POST", "/triggers/fire", { project: "web", name: "nope" });
    expect(res.status).toBe(404);
  });

  test("add for a workflow file that is gone is 400", async () => {
    const { cwd, call } = await appFor();
    rmSync(join(cwd, "digest.yaml"));
    const res = await call("POST", "/triggers", { project: "web", workflow: "digest.yaml" });
    expect(res.status).toBe(400);
  });
});

describe("storage.projects.findOrAddFolder", () => {
  test.each([
    ["the project already at the folder", { web: "/c/web" }, "/c/web", "web", {}],
    [
      "a new project named the way yok run names the folder",
      {},
      "/c/Nightly_Jobs",
      "nightly-jobs",
      { "nightly-jobs": "/c/Nightly_Jobs" },
    ],
    [
      "web-2 when web names another folder",
      { web: "/other/web" },
      "/c/web",
      "web-2",
      { "web-2": "/c/web" },
    ],
    [
      "project-2024 for a digit-first folder",
      {},
      "/c/2024",
      "project-2024",
      { "project-2024": "/c/2024" },
    ],
    ["a missing folder, added all the same", {}, "/c/gone", "gone", { gone: "/c/gone" }],
  ])("SC3004: findOrAddFolder returns %s", async (_label, before, folder, expected, added) => {
    const storage = memoryStorage();
    for (const [name, path] of Object.entries(before))
      await registerProject(storage, name, { path });
    const original = await storage.projects.list();

    expect(await storage.projects.findOrAddFolder(folder)).toBe(expected);

    const after = await storage.projects.list();
    expect(Object.keys(after).toSorted()).toEqual(
      [...Object.keys(original), ...Object.keys(added)].toSorted(),
    );
    for (const [name, path] of Object.entries(added)) {
      expect(after[name]).toMatchObject({ path, addedBy: { channel: "server" } });
    }
  });
});
