import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IStorage, ITriggerRepository } from "./repositories.ts";
import { memoryStorage, openStorage } from "./storage.ts";
import type { Fire, Trigger, TriggerDraft } from "./triggers.ts";

const addProjects = async (storage: IStorage): Promise<IStorage> => {
  for (const name of ["web", "api"]) {
    const added = await storage.projects.add(name, {
      path: `/abs/${name}`,
      addedBy: { channel: "cli" },
      addedAt: "2026-10-01T00:00:00.000Z",
    });
    if (!added.ok) throw new Error(added.error);
  }
  return storage;
};

// A trigger row needs its project's row; every trigger here names web or api.
const storageWithProjects = (): Promise<IStorage> => addProjects(memoryStorage());

const draft = (overrides: Partial<TriggerDraft> = {}): TriggerDraft => ({
  name: "daily-digest",
  project: "web",
  workflow: `/abs/repo/${overrides.name ?? "daily-digest"}.yaml`,
  config: null,
  cron: "0 9 * * *",
  timezone: "UTC",
  nextFireAt: "2026-10-24T09:00:00.000Z",
  ...overrides,
});

const saveOk = async (store: ITriggerRepository, toSave: TriggerDraft): Promise<Trigger> => {
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

describe("storage.triggers", () => {
  test("SC501: a saved trigger reads back from the list and by its project and name, with a t- id and a createdAt", async () => {
    const { triggers: store } = await storageWithProjects();

    const saved = await saveOk(store, draft());

    expect(saved.id).toMatch(/^t-[0-9a-f]{8}$/);
    expect(saved.createdAt).toEqual(expect.any(String));
    expect(await store.list()).toEqual([saved]);
    expect(await store.find("web", "daily-digest")).toEqual(saved);
    expect(await store.find("nowhere", "daily-digest")).toBeUndefined();
  });

  test("SC502: saving the same project, name and workflow again changes the cron and keeps the id and createdAt", async () => {
    const { triggers: store } = await storageWithProjects();
    const first = await saveOk(store, draft());

    const second = await saveOk(store, draft({ cron: "0 18 * * *" }));

    expect(await store.list()).toEqual([second]);
    expect(second).toMatchObject({ id: first.id, createdAt: first.createdAt, cron: "0 18 * * *" });
  });

  test("SC503: daily-digest in web and in api is two triggers, found by project, and removing web's leaves api's", async () => {
    const { triggers: store } = await storageWithProjects();
    const web = await saveOk(store, draft());
    const api = await saveOk(store, draft({ project: "api", workflow: "/abs/other/d.yaml" }));

    expect(await store.find("web", "daily-digest")).toEqual(web);
    expect(await store.find("api", "daily-digest")).toEqual(api);

    await store.remove(web.id);

    expect(await store.list()).toEqual([api]);
    expect(await store.find("api", "daily-digest")).toEqual(api);
  });

  test.each([
    ["SC504", "a second workflow under the taken name", { workflow: "/abs/repo/copy.yaml" }],
    [
      "SC505",
      "the same workflow under another name",
      { name: "renamed", workflow: "/abs/repo/daily-digest.yaml" },
    ],
  ])(
    "%s: saving %s in web is refused with the trigger it clashes with, and writes nothing",
    async (_id, _label, clash) => {
      const { triggers: store } = await storageWithProjects();
      const first = await saveOk(store, draft());

      const result = await store.save(draft(clash));

      expect(result).toEqual({ ok: false, error: first });
      expect(await store.list()).toEqual([first]);
    },
  );

  test("SC506: two clashing saves started together on one yok.db through two connections leave one trigger and refuse the other", async () => {
    const home = mkdtempSync(join(tmpdir(), "yok-triggers-"));
    const first = await addProjects(openStorage(home));
    const second = openStorage(home);

    const results = await Promise.all([
      first.triggers.save(draft()),
      second.triggers.save(draft({ workflow: "/abs/repo/copy.yaml" })),
    ]);

    expect(results.map((r) => r.ok).toSorted()).toEqual([false, true]);
    expect(await second.triggers.list()).toHaveLength(1);
    await Promise.all([first.close(), second.close()]);
  });

  test("SC507: removing a trigger takes its fire log, and removing it again reports false", async () => {
    const { triggers: store } = await storageWithProjects();
    const saved = await saveOk(store, draft());
    await store.appendFire(fire(saved.id, "2026-10-22T09:00:00.000Z"));
    await store.appendFire(fire(saved.id, "2026-10-23T09:00:00.000Z"));

    expect(await store.remove(saved.id)).toBe(true);
    expect(await store.remove(saved.id)).toBe(false);
    expect(await store.list()).toEqual([]);
    expect(await store.readFires(saved.id, 20)).toEqual([]);
  });

  test("SC508: moving daily-digest's next fire changes daily-digest only", async () => {
    const { triggers: store } = await storageWithProjects();
    const daily = await saveOk(store, draft());
    const weekly = await saveOk(store, draft({ name: "weekly" }));

    expect(await store.setNextFireAt(daily, "2026-10-25T09:00:00.000Z")).toBe(true);

    expect(await store.find("web", "daily-digest")).toEqual({
      ...daily,
      nextFireAt: "2026-10-25T09:00:00.000Z",
    });
    expect(await store.find("web", "weekly")).toEqual(weekly);
  });

  test.each([
    ["SC509", "cron", { cron: "0 18 * * *", nextFireAt: "2026-10-23T18:00:00.000Z" }],
    ["SC510", "timezone", { timezone: "Asia/Kolkata", nextFireAt: "2026-10-23T03:30:00.000Z" }],
  ])(
    "%s: a next fire worked out from a %s that has since changed is not written",
    async (_id, _field, change) => {
      const { triggers: store } = await storageWithProjects();
      const read = await saveOk(store, draft({ name: "weekly" }));
      const resaved = await saveOk(store, draft({ name: "weekly", ...change }));

      expect(await store.setNextFireAt(read, "2026-10-25T09:00:00.000Z")).toBe(false);

      expect(await store.find("web", "weekly")).toEqual(resaved);
      expect(resaved).toMatchObject(change);
    },
  );

  test("SC511: moving the next fire of a trigger removed since reports false and adds nothing", async () => {
    const { triggers: store } = await storageWithProjects();
    const read = await saveOk(store, draft());
    await store.remove(read.id);

    expect(await store.setNextFireAt(read, "2026-10-25T09:00:00.000Z")).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  test("SC512: readFires(A, 2) returns A's 22 and 23 Oct fires in written order, sharing one at, and not B's", async () => {
    const { triggers: store } = await storageWithProjects();
    const a = await saveOk(store, draft());
    const b = await saveOk(store, draft({ name: "weekly" }));
    const at = "2026-10-23T09:00:05.000Z";
    const slots = ["2026-10-21", "2026-10-22", "2026-10-23"].map((d) => `${d}T09:00:00.000Z`);
    for (const slot of slots) await store.appendFire(fire(a.id, slot, { at }));
    await store.appendFire(fire(b.id, "2026-10-23T10:00:00.000Z"));

    expect(await store.readFires(a.id, 2)).toEqual([
      fire(a.id, "2026-10-22T09:00:00.000Z", { at }),
      fire(a.id, "2026-10-23T09:00:00.000Z", { at }),
    ]);
  });

  test("SC513: a skipped fire with a reason and no run reads back equal, with no runId or runName key", async () => {
    const { triggers: store } = await storageWithProjects();
    const saved = await saveOk(store, draft());
    const skipped = fire(saved.id, "2026-10-23T09:00:00.000Z", {
      status: "skipped",
      reason: "previous run still running",
    });

    await store.appendFire(skipped);

    const [read] = await store.readFires(saved.id, 20);
    expect(read).toEqual(skipped);
    expect(Object.keys(read ?? {})).not.toContain("runId");
    expect(Object.keys(read ?? {})).not.toContain("runName");
  });

  test("SC514: a fire appended for a removed trigger is dropped without an error", async () => {
    const { triggers: store } = await storageWithProjects();
    const saved = await saveOk(store, draft());
    await store.remove(saved.id);

    await store.appendFire(fire(saved.id, "2026-10-23T09:00:00.000Z"));

    expect(await store.readFires(saved.id, 20)).toEqual([]);
  });

  test("SC515: removing project web deletes its trigger and fires, and keeps api's trigger", async () => {
    const storage = await storageWithProjects();
    const web = await saveOk(storage.triggers, draft());
    const api = await saveOk(storage.triggers, draft({ project: "api" }));
    await storage.triggers.appendFire(fire(web.id, "2026-10-23T09:00:00.000Z"));

    expect(await storage.projects.remove("web")).toBe(true);

    expect(await storage.triggers.list()).toEqual([api]);
    expect(await storage.triggers.readFires(web.id, 20)).toEqual([]);
  });
});
