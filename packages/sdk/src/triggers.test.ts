import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTriggerStore,
  type Fire,
  type Trigger,
  type TriggerDraft,
  type TriggerStore,
  TriggersFileSchema,
  triggerFiresPath,
  triggersPath,
} from "./triggers.ts";

const tempHome = (): string => mkdtempSync(join(tmpdir(), "yok-triggers-"));

const draft = (overrides: Partial<TriggerDraft> = {}): TriggerDraft => ({
  name: "daily-digest",
  workflowPath: `/abs/repo/${overrides.name ?? "daily-digest"}.yaml`,
  cwd: "/abs/repo",
  config: null,
  cron: "0 9 * * *",
  timezone: "UTC",
  nextFireAt: "2026-10-24T09:00:00.000Z",
  ...overrides,
});

const saveOk = async (store: TriggerStore, toSave: TriggerDraft): Promise<Trigger> => {
  const result = await store.save(toSave);
  if (!result.ok) throw new Error(`clashes with ${result.error.name}`);
  return result.value;
};

const fire = (triggerId: string, slot: string, overrides: Partial<Fire> = {}): Fire => ({
  triggerId,
  slot,
  status: "started",
  at: slot,
  ...overrides,
});

describe("createTriggerStore", () => {
  test("a saved trigger lists back with a t- id and a createdAt, and the file parses strictly", async () => {
    const home = tempHome();
    const store = createTriggerStore(home);

    const saved = await saveOk(store, draft());

    expect(saved.id).toMatch(/^t-[0-9a-f]{8}$/);
    expect(await store.list()).toEqual([saved]);
    const file = TriggersFileSchema.parse(JSON.parse(await readFile(triggersPath(home), "utf8")));
    expect(file.triggers[saved.id]).toEqual(saved);
  });

  test("saving the same repo and name again updates the schedule and keeps its id and createdAt", async () => {
    const store = createTriggerStore(tempHome());
    const first = await saveOk(store, draft());

    const second = await saveOk(store, draft({ cron: "0 18 * * *" }));

    expect(await store.list()).toEqual([second]);
    expect(second).toMatchObject({ id: first.id, createdAt: first.createdAt, cron: "0 18 * * *" });
  });

  test("the same name in two repos is two triggers, and find picks by repo and name", async () => {
    const store = createTriggerStore(tempHome());
    const a = await saveOk(store, draft());
    const b = await saveOk(store, draft({ cwd: "/abs/other", workflowPath: "/abs/other/d.yaml" }));

    expect((await store.list()).map((t) => t.id).toSorted()).toEqual([a.id, b.id].toSorted());
    expect(await store.find("/abs/other", "daily-digest")).toEqual(b);
    expect(await store.find("/abs/nowhere", "daily-digest")).toBeUndefined();
  });

  test.each([
    ["a second file under the same name", { workflowPath: "/abs/repo/copy.yaml" }],
    [
      "the same file under another name",
      { name: "renamed", workflowPath: "/abs/repo/daily-digest.yaml" },
    ],
  ])(
    "saving %s is refused with the trigger it clashes with, and writes nothing",
    async (_label, clash) => {
      const store = createTriggerStore(tempHome());
      const first = await saveOk(store, draft());

      const result = await store.save(draft(clash));

      expect(result).toEqual({ ok: false, error: first });
      expect(await store.list()).toEqual([first]);
    },
  );

  test("two saves of different files under one name started together: one lands, the other is refused", async () => {
    const store = createTriggerStore(tempHome());

    const results = await Promise.all([
      store.save(draft()),
      store.save(draft({ workflowPath: "/abs/repo/copy.yaml" })),
    ]);

    expect(results.map((r) => r.ok).toSorted()).toEqual([false, true]);
    expect(await store.list()).toHaveLength(1);
  });

  test("two saves started together both land on disk", async () => {
    const store = createTriggerStore(tempHome());

    await Promise.all([saveOk(store, draft()), saveOk(store, draft({ name: "weekly" }))]);

    expect((await store.list()).map((t) => t.name).toSorted()).toEqual(["daily-digest", "weekly"]);
  });

  test("remove deletes the trigger and reports false for an id it does not hold", async () => {
    const store = createTriggerStore(tempHome());
    const saved = await saveOk(store, draft());

    expect(await store.remove(saved.id)).toBe(true);
    expect(await store.list()).toEqual([]);
    expect(await store.remove(saved.id)).toBe(false);
  });

  test("setNextFireAt moves only that trigger's next fire and reports true", async () => {
    const store = createTriggerStore(tempHome());
    const a = await saveOk(store, draft());
    const b = await saveOk(store, draft({ name: "weekly" }));

    expect(await store.setNextFireAt(a, "2026-10-25T09:00:00.000Z")).toBe(true);

    expect(await store.find(a.cwd, a.name)).toMatchObject({
      nextFireAt: "2026-10-25T09:00:00.000Z",
    });
    expect(await store.find(b.cwd, b.name)).toEqual(b);
  });

  test("setNextFireAt on a trigger removed since, or whose cron changed since, reports false and writes nothing", async () => {
    const store = createTriggerStore(tempHome());
    const removed = await saveOk(store, draft());
    await store.remove(removed.id);
    const old = await saveOk(store, draft({ name: "weekly" }));
    const changed = await saveOk(store, draft({ name: "weekly", cron: "0 18 * * *" }));

    expect(await store.setNextFireAt(removed, "2026-10-25T09:00:00.000Z")).toBe(false);
    expect(await store.setNextFireAt(old, "2026-10-25T09:00:00.000Z")).toBe(false);

    expect(await store.list()).toEqual([changed]);
  });

  test.each([
    ["a hand-edited bad line", '{"triggerId":"t-1","slo\n'],
    ["a line torn by a crash mid-append, with no newline", '{"triggerId":"t-1","slo'],
  ])("readFires skips %s and still returns the fires around it in order", async (_label, bad) => {
    const home = tempHome();
    const store = createTriggerStore(home);
    await store.appendFire(fire("t-1", "2026-10-22T09:00:00.000Z"));
    await appendFile(triggerFiresPath(home), bad);
    await store.appendFire(fire("t-1", "2026-10-23T09:00:00.000Z"));

    const fires = await store.readFires("t-1", 20);

    expect(fires.map((f) => f.slot)).toEqual([
      "2026-10-22T09:00:00.000Z",
      "2026-10-23T09:00:00.000Z",
    ]);
  });

  test("a triggers.json with a key the schema does not know is refused, not read", async () => {
    const home = tempHome();
    const store = createTriggerStore(home);
    const saved = await saveOk(store, draft());
    await writeFile(
      triggersPath(home),
      JSON.stringify({ version: 1, triggers: { [saved.id]: { ...saved, extra: 1 } } }),
    );

    expect(store.list()).rejects.toThrow();
  });
});

describe("trigger fire log", () => {
  test("readFires returns the trigger's own fires, oldest first, at most the limit", async () => {
    const store = createTriggerStore(tempHome());
    const slots = ["2026-10-21", "2026-10-22", "2026-10-23"].map((d) => `${d}T09:00:00.000Z`);
    for (const slot of slots) await store.appendFire(fire("t-aaaaaaaa", slot));
    await store.appendFire(fire("t-bbbbbbbb", "2026-10-23T10:00:00.000Z"));

    expect(await store.readFires("t-aaaaaaaa", 2)).toEqual([
      fire("t-aaaaaaaa", "2026-10-22T09:00:00.000Z"),
      fire("t-aaaaaaaa", "2026-10-23T09:00:00.000Z"),
    ]);
  });

  test("a trigger that never fired has no fires", async () => {
    expect(await createTriggerStore(tempHome()).readFires("t-aaaaaaaa", 20)).toEqual([]);
  });
});
