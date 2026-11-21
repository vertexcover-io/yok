import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDirOf } from "@yok/sdk";
import { type Fire, type IStorage, memoryStorage } from "@yok/sdk/internal";
import { importFiles } from "./import-files.ts";
import {
  gitCheckout,
  oldComment,
  oldEvent,
  oldRun,
  writeJson,
  writeOldHome,
  writeRegistry,
  writeRunFolder,
} from "./test-runs.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

const NOTHING_IMPORTED =
  "imported users=0 projects=0 runs=0 events=0 comments=0 triggers=0 fires=0 skipped=0";

const ANA = {
  name: "Ana",
  email: "ana@example.com",
  accounts: { github: { id: 101, login: "ana", token: "gho_a" } },
  slack: "U01",
};
const BO = { name: "Bo", email: "bo@example.com", accounts: { github: { id: 202, login: "bo" } } };

const ADDED_AT = "2026-01-01T00:00:00.000Z";

const projectsYaml = (checkout: string): string =>
  [
    "app:",
    `  path: ${checkout}`,
    "  git: https://github.com/acme/app.git",
    "  addedBy:",
    "    channel: slack",
    "    id: x",
    `  addedAt: "${ADDED_AT}"`,
    "  verdict: ok",
    "",
  ].join("\n");

const checkoutAt = (prefix: string): string => {
  const dir = gitCheckout(prefix);
  dirs.push(dir);
  return dir;
};

// Project app at a checkout holding run r-1, fix-login, with 3 events and 2 comments.
const fixLoginHome = async () => {
  const home = tempDir("yok-import-home-");
  const checkout = checkoutAt("yok-import-app-");
  writeFileSync(join(home, "projects.yaml"), projectsYaml(checkout));
  const run = oldRun("r-1", "fix-login", checkout);
  writeRegistry(home, [run]);
  const events = [1, 2, 3].map((seq) => oldEvent("r-1", seq));
  const comments = [
    oldComment("c1", {
      status: "delivered",
      deliveredAt: "2026-02-01T00:11:00.000Z",
      anchor: { quote: "the plan", before: "b", after: "a", lines: [3, 4] },
    }),
    oldComment("c2", {
      kind: "global",
      status: "answered",
      thread: [
        { by: "user", text: "why?", at: "2026-02-01T00:10:00.000Z" },
        { by: "agent", text: "because", at: "2026-02-01T00:12:00.000Z" },
      ],
    }),
  ];
  const state = await writeRunFolder({ run, events, comments });
  return { home, checkout, run, dir: runDirOf(checkout, "fix-login"), events, comments, state };
};

const TRIGGER = {
  id: "t-aaaa1111",
  name: "digest",
  config: null,
  cron: "0 9 * * *",
  timezone: "Asia/Kolkata",
  nextFireAt: "2026-02-02T03:30:00.000Z",
  createdAt: "2026-01-05T00:00:00.000Z",
  project: "app",
  workflow: "task",
};

// fixLoginHome's project app with trigger t-aaaa1111, and t-bbbb2222 saved before triggers named
// a project, at folder E, which no project holds.
const triggersHome = async () => {
  const base = await fixLoginHome();
  const folder = tempDir("yok-import-e-");
  const workflowPath = join(folder, "nightly.yaml");
  const { project: _project, workflow: _workflow, ...schedule } = TRIGGER;
  const legacy = { ...schedule, id: "t-bbbb2222", name: "nightly", workflowPath, cwd: folder };
  writeJson(join(base.home, "triggers.json"), {
    version: 1,
    triggers: { [TRIGGER.id]: TRIGGER, [legacy.id]: legacy },
  });
  return { ...base, folder, workflowPath };
};

const fire = (triggerId: string, slot: string, run: Readonly<{ runId?: string }> = {}): Fire => ({
  triggerId,
  slot,
  status: "started",
  ...run,
  runName: `digest-${slot.slice(0, 10)}`,
  at: slot,
});

const oldHome = async () => {
  const home = tempDir("yok-import-home-");
  const checkout = checkoutAt("yok-import-app-");
  await writeOldHome(home, checkout);
  return { home, runDir: runDirOf(checkout, "fix-login") };
};

const filesIn = (dir: string): readonly string[] => readdirSync(dir).toSorted();

const rowsIn = async (storage: IStorage) => ({
  users: await storage.users.list(),
  projects: await storage.projects.list(),
  runs: await storage.runs.listRuns(),
  events: await storage.runs.readEvents("r-1"),
  comments: await storage.comments.list("r-1"),
  triggers: await storage.triggers.list(),
  fires: await storage.triggers.readFires("t-aaaa1111", 20),
});

describe("importFiles", () => {
  test("SC702: users u_1a2b3c4d and u_5e6f7a8b keep their ids, GitHub logins, ana's token and Slack link", async () => {
    const home = tempDir("yok-import-home-");
    writeJson(join(home, "users.json"), { u_1a2b3c4d: ANA, u_5e6f7a8b: BO });
    const storage = memoryStorage();

    const report = await importFiles(storage, home);

    expect(await storage.users.find("u_1a2b3c4d")).toEqual(ANA);
    expect(await storage.users.find("u_5e6f7a8b")).toEqual(BO);
    expect((await storage.users.findByAccount("github", "101"))?.[0]).toBe("u_1a2b3c4d");
    expect((await storage.users.findByAccount("slack", "U01"))?.[0]).toBe("u_1a2b3c4d");
    expect(report).toEqual({
      summary: NOTHING_IMPORTED.replace("users=0", "users=2"),
      skipped: [],
    });
  });

  test("users.json.imported keeps ana's login but not her GitHub token, which only yok.db holds", async () => {
    const home = tempDir("yok-import-home-");
    writeJson(join(home, "users.json"), { u_1a2b3c4d: ANA, u_5e6f7a8b: BO });
    const storage = memoryStorage();

    await importFiles(storage, home);

    const { token: _token, ...github } = ANA.accounts.github;
    expect(JSON.parse(readFileSync(join(home, "users.json.imported"), "utf8"))).toEqual({
      u_1a2b3c4d: { ...ANA, accounts: { github } },
      u_5e6f7a8b: BO,
    });
    expect(await storage.users.find("u_1a2b3c4d")).toEqual(ANA);
  });

  test("SC703: project app keeps its path, git URL, channel and time, and drops the old verdict and addedBy.id", async () => {
    const home = tempDir("yok-import-home-");
    const checkout = tempDir("yok-import-app-");
    writeFileSync(join(home, "projects.yaml"), projectsYaml(checkout));
    const storage = memoryStorage();

    await importFiles(storage, home);

    expect(await storage.projects.find("app")).toEqual({
      path: checkout,
      git: "https://github.com/acme/app.git",
      addedBy: { channel: "slack" },
      addedAt: ADDED_AT,
    });
  });

  test("SC717: an unparsable users.json keeps its name and is reported, while projects.yaml still imports", async () => {
    const home = tempDir("yok-import-home-");
    writeFileSync(join(home, "users.json"), "not json");
    writeFileSync(join(home, "projects.yaml"), projectsYaml(tempDir("yok-import-app-")));

    const report = await importFiles(memoryStorage(), home);

    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toStartWith(`${home}/users.json:`);
    expect(existsSync(join(home, "users.json"))).toBe(true);
    expect(existsSync(join(home, "projects.yaml"))).toBe(false);
    expect(existsSync(join(home, "projects.yaml.imported"))).toBe(true);
    expect(report.summary).toBe(
      NOTHING_IMPORTED.replace("projects=0", "projects=1").replace("skipped=0", "skipped=1"),
    );
  });

  test("SC704: run r-1 with its folder reads back with its record in project app, its 3 events, state.json and 2 comments", async () => {
    const { home, checkout, run, events, comments, state } = await fixLoginHome();
    const storage = memoryStorage();

    await importFiles(storage, home);

    expect(await storage.runs.findRun("r-1")).toEqual({ ...run, project: "app", cwd: checkout });
    expect(await storage.runs.readEvents("r-1")).toEqual(events);
    expect(await storage.runs.readState("r-1")).toEqual(state);
    expect(await storage.comments.list("r-1")).toEqual(comments);
  });

  test("SC705: a run at checkout D with no projects.yaml gets a folder project at D, added by the server", async () => {
    const home = tempDir("yok-import-home-");
    const checkout = checkoutAt("yok-import-d-");
    const run = oldRun("r-1", "fix-login", checkout);
    writeRegistry(home, [run]);
    await writeRunFolder({ run, events: [oldEvent("r-1", 1)] });
    const storage = memoryStorage();

    await importFiles(storage, home);

    const projects = Object.entries(await storage.projects.list());
    expect(projects).toHaveLength(1);
    const [name, project] = projects[0] ?? [];
    expect(project?.path).toBe(checkout);
    expect(project?.addedBy.channel).toBe("server");
    expect(await storage.runs.findRun("r-1")).toMatchObject({ project: name, cwd: checkout });
  });

  test("SC706: a workflow.completed at seq 4, stored after state.json was written at seq 3, is folded into the imported state", async () => {
    const home = tempDir("yok-import-home-");
    const checkout = checkoutAt("yok-import-app-");
    const run = oldRun("r-1", "fix-login", checkout);
    writeRegistry(home, [run]);
    const events = [
      ...[1, 2, 3].map((seq) => oldEvent("r-1", seq)),
      oldEvent("r-1", 4, "workflow.completed"),
    ];
    const written = await writeRunFolder({ run, events, stateSeq: 3 });
    expect([written.lastEventSeq, written.status]).toEqual([3, "running"]);
    const storage = memoryStorage();

    await importFiles(storage, home);

    const state = await storage.runs.readState("r-1");
    expect([state?.lastEventSeq, state?.status]).toEqual([4, "completed"]);
    expect(await storage.runs.readEvents("r-1")).toHaveLength(4);
  });

  test("SC707: run r-2 whose .yok/old-task folder is gone is left out and named, and registry.json is still marked imported", async () => {
    const home = tempDir("yok-import-home-");
    const checkout = checkoutAt("yok-import-app-");
    writeRegistry(home, [oldRun("r-2", "old-task", checkout)]);
    const storage = memoryStorage();

    const report = await importFiles(storage, home);

    expect(await storage.runs.findRun("r-2")).toBeUndefined();
    expect(report.skipped).toContain(
      `run r-2 (old-task): its folder ${checkout}/.yok/old-task is gone`,
    );
    expect(existsSync(join(home, "registry.json.imported"))).toBe(true);
    expect(existsSync(join(home, "registry.json"))).toBe(false);
  });

  test("SC708: of r-old (January) and r-new (February), both named fix in one checkout, only r-new is imported, with the folder's events", async () => {
    const home = tempDir("yok-import-home-");
    const checkout = checkoutAt("yok-import-app-");
    const older = oldRun("r-old", "fix", checkout, { createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = oldRun("r-new", "fix", checkout, { createdAt: "2026-02-01T00:00:00.000Z" });
    writeRegistry(home, [older, newer]);
    const events = [oldEvent("r-new", 1), oldEvent("r-new", 2)];
    await writeRunFolder({ run: newer, events });
    const storage = memoryStorage();

    const report = await importFiles(storage, home);

    expect((await storage.runs.findRunsByName("fix")).map((run) => run.id)).toEqual(["r-new"]);
    expect(await storage.runs.readEvents("r-new")).toEqual(events);
    expect(report.skipped).toEqual(["run r-old (fix): a newer run took its name and folder"]);
  });

  test("SC709: run r-3 that never ran init is imported with name null, no state and no events", async () => {
    const home = tempDir("yok-import-home-");
    writeRegistry(home, [oldRun("r-3", null, checkoutAt("yok-import-app-"))]);
    const storage = memoryStorage();

    await importFiles(storage, home);

    expect((await storage.runs.findRun("r-3"))?.name).toBeNull();
    expect(await storage.runs.readState("r-3")).toBeNull();
    expect(await storage.runs.readEvents("r-3")).toEqual([]);
  });

  test("SC710: r-4 keeps its starter u_1a2b3c4d from users.json, and r-5 drops u_99999999, whom users.json never held", async () => {
    const home = tempDir("yok-import-home-");
    const checkout = checkoutAt("yok-import-app-");
    writeJson(join(home, "users.json"), { u_1a2b3c4d: ANA });
    writeRegistry(home, [
      oldRun("r-4", null, checkout, { user: "u_1a2b3c4d" }),
      oldRun("r-5", null, checkout, { user: "u_99999999" }),
    ]);
    const storage = memoryStorage();

    await importFiles(storage, home);

    expect((await storage.runs.findRun("r-4"))?.user).toBe("u_1a2b3c4d");
    const r5 = await storage.runs.findRun("r-5");
    expect(r5).toBeDefined();
    expect(r5).not.toHaveProperty("user");
  });

  test("SC711: an unparsable comments.json leaves r-1 imported with its events and state but no comments, and keeps its name", async () => {
    const { home, dir, events, state } = await fixLoginHome();
    writeFileSync(join(dir, "comments.json"), "{ broken");
    const storage = memoryStorage();

    const report = await importFiles(storage, home);

    expect(await storage.runs.findRun("r-1")).toBeDefined();
    expect(await storage.runs.readEvents("r-1")).toEqual(events);
    expect(await storage.runs.readState("r-1")).toEqual(state);
    expect(await storage.comments.list("r-1")).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toStartWith(`${dir}/comments.json:`);
    for (const file of ["state.json", "event.jsonl"]) {
      expect(existsSync(join(dir, `${file}.imported`))).toBe(true);
    }
    expect(existsSync(join(dir, "comments.json"))).toBe(true);
  });

  test("SC712: r-1 with no state.json is skipped whole, and its event.jsonl and comments.json keep their names", async () => {
    const { home, dir } = await fixLoginHome();
    rmSync(join(dir, "state.json"));
    const storage = memoryStorage();

    const report = await importFiles(storage, home);

    expect(await storage.runs.findRun("r-1")).toBeUndefined();
    expect(await storage.runs.readEvents("r-1")).toEqual([]);
    expect(report.skipped).toEqual([`run r-1 (fix-login): ${dir}/state.json is missing`]);
    expect(existsSync(join(dir, "event.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "comments.json"))).toBe(true);
  });

  test("SC713: trigger t-aaaa1111 and legacy t-bbbb2222 keep their ids, and the legacy one moves to a new project at its folder", async () => {
    const { home, folder, workflowPath } = await triggersHome();
    const storage = memoryStorage();

    await importFiles(storage, home);

    const triggers = await storage.triggers.list();
    expect(triggers.find((trigger) => trigger.id === "t-aaaa1111")).toEqual(TRIGGER);
    const projects = Object.entries(await storage.projects.list());
    const atFolder = projects.find(([, project]) => project.path === folder);
    expect(atFolder).toBeDefined();
    expect(triggers.find((trigger) => trigger.id === "t-bbbb2222")).toMatchObject({
      name: "nightly",
      workflow: workflowPath,
      project: atFolder?.[0],
    });
  });

  test("SC714: t-aaaa1111's fires read back in order, keeping run r-1 and losing r-gone; removed t-cccc3333's fire and the line oops are dropped", async () => {
    const { home } = await triggersHome();
    const kept = fire("t-aaaa1111", "2026-02-01T03:30:00.000Z", { runId: "r-1" });
    const lost = fire("t-aaaa1111", "2026-02-02T03:30:00.000Z", { runId: "r-gone" });
    const orphan = fire("t-cccc3333", "2026-02-02T03:30:00.000Z");
    const lines = [kept, lost, orphan].map((line) => JSON.stringify(line));
    writeFileSync(join(home, "trigger-fires.jsonl"), [...lines, "oops", ""].join("\n"));
    const storage = memoryStorage();

    const report = await importFiles(storage, home);

    const { runId: _gone, ...withoutRun } = lost;
    expect(await storage.triggers.readFires("t-aaaa1111", 20)).toEqual([kept, withoutRun]);
    expect(await storage.triggers.readFires("t-cccc3333", 20)).toEqual([]);
    expect(report.skipped).toEqual([`${home}/trigger-fires.jsonl line 4: not a fire`]);
  });

  test("SC715: a home of 1 user, 1 project, runs r-1 and folderless r-2, 1 trigger and 1 fire imports all but r-2 and renames every file read", async () => {
    const { home, runDir } = await oldHome();

    const report = await importFiles(memoryStorage(), home);

    expect(report.summary).toBe(
      "imported users=1 projects=1 runs=1 events=2 comments=1 triggers=1 fires=1 skipped=1",
    );
    expect(filesIn(home)).toEqual([
      "projects.yaml.imported",
      "registry.json.imported",
      "trigger-fires.jsonl.imported",
      "triggers.json.imported",
      "users.json.imported",
    ]);
    expect(filesIn(runDir)).toEqual([
      "comments.json.imported",
      "event.jsonl.imported",
      "state.json.imported",
      "workflow.yaml",
    ]);
  });

  test("SC716: importing the same home a second time stores nothing, reads back the same rows and renames nothing again", async () => {
    const { home, runDir } = await oldHome();
    const storage = memoryStorage();
    await importFiles(storage, home);
    const first = await rowsIn(storage);

    const report = await importFiles(storage, home);

    expect(report).toEqual({ summary: NOTHING_IMPORTED, skipped: [] });
    expect(await rowsIn(storage)).toEqual(first);
    expect(first.runs.map((run) => run.id)).toEqual(["r-1"]);
    const twice = [...filesIn(home), ...filesIn(runDir)].filter((file) =>
      file.endsWith(".imported.imported"),
    );
    expect(twice).toEqual([]);
  });

  test("an import killed after storing everything but before its renames, run again, stores no second fire or any other row", async () => {
    const { home, runDir } = await oldHome();
    const storage = memoryStorage();
    await importFiles(storage, home);
    const first = await rowsIn(storage);
    for (const dir of [home, runDir]) {
      for (const file of filesIn(dir).filter((name) => name.endsWith(".imported"))) {
        renameSync(join(dir, file), join(dir, file.slice(0, -".imported".length)));
      }
    }

    const report = await importFiles(storage, home);

    expect(await rowsIn(storage)).toEqual(first);
    expect(first.fires).toHaveLength(1);
    expect(report.summary).toContain("runs=0 events=0 comments=0 triggers=0 fires=0");
  });

  test("a run whose store throws is reported, the runs after it still import, and registry.json is marked imported", async () => {
    const home = tempDir("yok-import-home-");
    const checkout = checkoutAt("yok-import-app-");
    writeRegistry(home, [oldRun("r-3", null, checkout), oldRun("r-4", null, checkout)]);
    const real = memoryStorage();
    const storage: IStorage = {
      ...real,
      runs: {
        ...real.runs,
        importRun: async (input) => {
          if (input.run.id === "r-3") throw new Error("database is locked");
          return real.runs.importRun(input);
        },
      },
    };

    const report = await importFiles(storage, home);

    expect(report.skipped).toEqual(["run r-3 (unnamed): database is locked"]);
    expect(await real.runs.findRun("r-4")).toBeDefined();
    expect(existsSync(join(home, "registry.json.imported"))).toBe(true);
  });

  test("a trigger whose project has no row is reported and the trigger after it still imports", async () => {
    const home = tempDir("yok-import-home-");
    writeFileSync(join(home, "projects.yaml"), projectsYaml(tempDir("yok-import-app-")));
    const ghost = { ...TRIGGER, id: "t-dddd4444", name: "ghostly", project: "ghost" };
    writeJson(join(home, "triggers.json"), {
      version: 1,
      triggers: { [ghost.id]: ghost, [TRIGGER.id]: TRIGGER },
    });
    const storage = memoryStorage();

    const report = await importFiles(storage, home);

    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toStartWith("trigger t-dddd4444:");
    expect((await storage.triggers.list()).map((trigger) => trigger.id)).toEqual([TRIGGER.id]);
  });

  test("registry.json and triggers.json read again after a crash before their rename skip the stored run and trigger, and keep the first backups", async () => {
    const { home } = await triggersHome();
    const storage = memoryStorage();
    writeRegistry(home, [oldRun("r-3", null, checkoutAt("yok-import-app-"))]);
    await importFiles(storage, home);
    for (const file of ["registry.json", "triggers.json"]) {
      writeFileSync(join(home, `${file}.imported`), "first backup");
    }
    writeRegistry(home, [oldRun("r-3", null, checkoutAt("yok-import-app-"))]);
    writeJson(join(home, "triggers.json"), { version: 1, triggers: { [TRIGGER.id]: TRIGGER } });

    const report = await importFiles(storage, home);

    expect(report).toEqual({
      summary: NOTHING_IMPORTED.replace("skipped=0", "skipped=2"),
      skipped: [
        "run r-3 (unnamed): run r-3 is already stored",
        "trigger t-aaaa1111: trigger t-aaaa1111 is already stored",
      ],
    });
    for (const file of ["registry.json", "triggers.json"]) {
      expect(readFileSync(join(home, `${file}.imported`), "utf8")).toBe("first backup");
      expect(existsSync(join(home, file))).toBe(false);
    }
  });
});
