import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Check, LaunchOptions } from "@yok/sdk";
import { createGit, noopLogger, ok } from "@yok/sdk";
import {
  createRegistry,
  createTriggerStore,
  type Trigger,
  type TriggerDraft,
  type TriggerStore,
} from "@yok/sdk/internal";
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

const saveOk = async (store: TriggerStore, draft: TriggerDraft): Promise<Trigger> => {
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

// A server's view of the world: a fresh home, a repo holding the workflow, and a provider that
// records each launch instead of starting an agent.
const setup = async (workflow?: string) => {
  const cwd = makeRepo(workflow);
  const home = mkdtempSync(join(tmpdir(), "yok-trigger-home-"));
  const launches: LaunchOptions[] = [];
  const store = createTriggerStore(home);
  const registry = createRegistry(join(home, "registry.json"));
  const deps = (now: string, alive = true): TriggerDeps => ({
    triggers: createTriggerStore(home),
    registry,
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
    // the fake host and provider bring no runtime checks of their own
    checkCheckout: (input) => checkCheckoutWith([], input),
    log: noopLogger,
    now: () => new Date(now),
  });
  const trigger: Trigger = await saveOk(store, {
    name: "digest",
    workflowPath: join(cwd, "digest.yaml"),
    cwd,
    config: null,
    cron: "0 9 * * *",
    timezone: "UTC",
    nextFireAt: "2026-10-23T09:00:00.000Z",
  });
  return { cwd, home, store, registry, launches, deps, trigger };
};

const TIMEOUT_MS = 20_000;

describe("tick", () => {
  test(
    "a due trigger launches once in auto with its inputs and a dated run name, logs started, and moves to the next slot",
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
    "a restarted server ticking again in the same minute does not fire the slot a second time",
    async () => {
      const { store, launches, deps, trigger } = await setup();

      await tick(deps("2026-10-23T09:00:10.000Z"));
      await tick(deps("2026-10-23T09:00:25.000Z"));

      expect(launches).toHaveLength(1);
      expect(await store.readFires(trigger.id, 20)).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  test(
    "a fire 2 minutes after a launch whose agent has not named its run yet logs skipped and launches nothing",
    async () => {
      const { store, registry, launches, deps, trigger } = await setup();
      await tick(deps("2026-10-23T09:00:10.000Z"));

      await fireTrigger(trigger, at("2026-10-23T09:02:10.000Z"), deps("2026-10-23T09:02:10.000Z"));

      expect(launches).toHaveLength(1);
      const fires = await store.readFires(trigger.id, 20);
      expect(fires[1]).toMatchObject({ status: "skipped", reason: "previous run still running" });
      expect(await registry.listRuns()).toHaveLength(1);
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
    ["has completed fires its next slot", "completed" as const, 2],
    ["is still running logs skipped for its next slot", "running" as const, 1],
  ])(
    "a trigger whose last run is named and %s, while its agent session stays open",
    async (_label, status, launchCount) => {
      const { cwd, store, registry, launches, deps, trigger } = await setup();
      await tick(deps("2026-10-23T09:00:10.000Z"));
      const [fired] = await store.readFires(trigger.id, 20);
      await registry.initRun(fired?.runId ?? "", "digest-20261023-090000");
      const runDir = join(cwd, ".yok", "digest-20261023-090000");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "state.json"),
        JSON.stringify({ ...seedState(runDir, {}), status }),
      );

      await tick(deps("2026-10-24T09:00:10.000Z"));

      expect(launches).toHaveLength(launchCount);
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
      const { cwd, store, launches, deps, trigger } = await setup();
      const otherCwd = makeRepo();
      const other = await saveOk(store, {
        ...trigger,
        workflowPath: join(otherCwd, "digest.yaml"),
        cwd: otherCwd,
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
    "a workflow whose doctor check fails logs failed with the check's reason and launches nothing",
    async () => {
      const blocked = DIGEST.replace(
        "nodes:",
        "doctor:\n  - check: env\n    key: YOK_TRIGGER_UNSET_KEY\n    fix: set it\nnodes:",
      );
      const { store, launches, deps, trigger } = await setup(blocked);

      await tick(deps("2026-10-23T09:00:10.000Z"));

      expect(launches).toHaveLength(0);
      const [fired] = await store.readFires(trigger.id, 20);
      expect(fired?.status).toBe("failed");
      expect(fired?.reason).toContain("YOK_TRIGGER_UNSET_KEY");
    },
    TIMEOUT_MS,
  );

  test.each([
    ["removed", null],
    ["re-added with an 18:00 cron", "0 18 * * *"],
  ])(
    "a trigger %s after the tick listed it does not fire, and keeps what the change saved",
    async (_label, newCron) => {
      const { store, launches, deps, trigger } = await setup();
      if (newCron === null) await store.remove(trigger.id);
      else await store.save({ ...trigger, cron: newCron, nextFireAt: "2026-10-23T18:00:00.000Z" });
      const saved = await store.list();
      const stale = deps("2026-10-23T09:00:10.000Z");

      await tick({ ...stale, triggers: { ...stale.triggers, list: async () => [trigger] } });

      expect(launches).toHaveLength(0);
      expect(await store.list()).toEqual(saved);
      expect(await store.readFires(trigger.id, 20)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "a trigger removed while its doctor runs logs skipped removed and launches nothing",
    async () => {
      const { store, launches, deps, trigger } = await setup();
      const base = deps("2026-10-23T09:00:10.000Z");
      const rmDuringDoctor: Check = {
        name: "rm lands here",
        fix: [],
        run: async () => {
          await store.remove(trigger.id);
          return ok("removed");
        },
      };

      await tick({ ...base, checkCheckout: (input) => checkCheckoutWith([rmDuringDoctor], input) });

      expect(launches).toHaveLength(0);
      const [fired] = await store.readFires(trigger.id, 20);
      expect(fired).toMatchObject({ status: "skipped", reason: "removed" });
    },
    TIMEOUT_MS,
  );

  test(
    "after sleeping three days it logs one missed line, then fires today's slot once",
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
    },
    TIMEOUT_MS,
  );

  test(
    "a slot 7h old logs skipped too late and launches nothing, and the trigger waits for tomorrow",
    async () => {
      const { store, launches, deps, trigger } = await setup();

      await tick(deps("2026-10-23T16:00:00.000Z"));

      expect(launches).toHaveLength(0);
      const [fired] = await store.readFires(trigger.id, 20);
      expect(fired).toMatchObject({ status: "skipped", slot: "2026-10-23T09:00:00.000Z" });
      expect(fired?.reason).toContain("too late");
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
      const { now: _now, ...scheduled } = deps(now.toISOString());
      const app = createApi({
        ...scheduled,
        pid: 1,
        version: "0.0.0-test",
        startedAt: 0,
        git: createGit(),
      });

      startScheduler(deps(now.toISOString()));
      const reply = await app.request("/triggers/fire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: trigger.cwd, name: "digest" }),
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
    const { now: _now, ...deps } = env.deps("2026-10-23T09:00:10.000Z");
    const app = createApi({
      ...deps,
      pid: 1,
      version: "0.0.0-test",
      startedAt: 0,
      git: createGit(),
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

      const first = await call("POST", "/triggers", { workflowPath, cwd });
      expect(first.status).toBe(201);
      const { trigger } = (await first.json()) as { trigger: Trigger };
      expect(trigger).toMatchObject({ name: "digest", cron: "0 9 * * *", timezone: "UTC", cwd });
      expect(trigger.nextFireAt).toMatch(/T09:00:00\.000Z$/);
      expect(new Date(trigger.nextFireAt).getTime()).toBeGreaterThan(Date.now());

      writeFileSync(workflowPath, DIGEST.replace('"0 9 * * *"', '"0 18 * * *"'));
      const again = (await (await call("POST", "/triggers", { workflowPath, cwd })).json()) as {
        trigger: Trigger;
      };
      expect(again.trigger).toMatchObject({ id: trigger.id, cron: "0 18 * * *" });
    },
    TIMEOUT_MS,
  );

  test.each([
    ["a second file whose workflow is also named digest", "copy.yaml", DIGEST],
    [
      "the same file after its workflow was renamed",
      "digest.yaml",
      DIGEST.replace("digest", "brief"),
    ],
  ])(
    "add of %s is 409 and leaves the first trigger as it was",
    async (_label, file, workflow) => {
      const { cwd, store, call } = await appFor();
      await call("POST", "/triggers", { workflowPath: join(cwd, "digest.yaml"), cwd });
      const before = await store.list();

      writeFileSync(join(cwd, file), workflow);
      const res = await call("POST", "/triggers", { workflowPath: join(cwd, file), cwd });

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
        "yok trigger rm digest",
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
    const { cwd, store, call } = await appFor(workflow);

    const res = await call("POST", "/triggers", { workflowPath: join(cwd, "digest.yaml"), cwd });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(message);
    expect(await store.list()).toEqual([]);
  });

  test(
    "fire runs the trigger now, list shows that firing as its last, log returns it, and rm removes it",
    async () => {
      const { cwd, launches, call } = await appFor();
      await call("POST", "/triggers", { workflowPath: join(cwd, "digest.yaml"), cwd });

      const fired = await call("POST", "/triggers/fire", { cwd, name: "digest" });
      expect(fired.status).toBe(200);
      const { fire } = (await fired.json()) as {
        fire: { status: string; runId: string; runName: string };
      };
      expect(fire.status).toBe("started");
      // to the second, so a second fire in the same minute does not reuse the run's folder
      expect(fire.runName).toMatch(/^digest-\d{8}-\d{6}$/);
      expect(launches).toHaveLength(1);

      const listed = (await (await call("GET", "/triggers")).json()) as {
        triggers: { name: string; lastFire: { runId: string } | null }[];
      };
      expect(listed.triggers.map((t) => [t.name, t.lastFire?.runId])).toEqual([
        ["digest", fire.runId],
      ]);

      const query = `cwd=${encodeURIComponent(cwd)}&name=digest`;
      const log = (await (await call("GET", `/triggers/log?${query}`)).json()) as {
        fires: { runId: string }[];
      };
      expect(log.fires.map((f) => f.runId)).toEqual([fire.runId]);

      expect((await call("DELETE", `/triggers?${query}`)).status).toBe(200);
      expect((await call("DELETE", `/triggers?${query}`)).status).toBe(404);
      expect((await (await call("GET", "/triggers")).json()) as unknown).toEqual({ triggers: [] });
    },
    TIMEOUT_MS,
  );

  test(
    "two fires of one trigger sent at once launch one run, and the other logs skipped",
    async () => {
      const { cwd, launches, call } = await appFor();
      await call("POST", "/triggers", { workflowPath: join(cwd, "digest.yaml"), cwd });

      const replies = await Promise.all([
        call("POST", "/triggers/fire", { cwd, name: "digest" }),
        call("POST", "/triggers/fire", { cwd, name: "digest" }),
      ]);

      expect(launches).toHaveLength(1);
      const statuses = await Promise.all(
        replies.map(async (r) => ((await r.json()) as { fire: { status: string } }).fire.status),
      );
      expect(statuses.toSorted()).toEqual(["skipped", "started"]);
    },
    TIMEOUT_MS,
  );

  test("fire for a name the repo has no trigger under is 404", async () => {
    const { cwd, call } = await appFor();
    expect((await call("POST", "/triggers/fire", { cwd, name: "nope" })).status).toBe(404);
  });

  test("add for a workflow file that is gone is 400", async () => {
    const { cwd, call } = await appFor();
    rmSync(join(cwd, "digest.yaml"));
    const res = await call("POST", "/triggers", { workflowPath: join(cwd, "digest.yaml"), cwd });
    expect(res.status).toBe(400);
  });
});
