import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGit, type IStorage, type RunRef, runDirOf, type State } from "@yok/sdk";
import { withStorage } from "@yok/sdk/internal";
import {
  closeAudit,
  finishAudit,
  type Gh,
  listAuditWork,
  recordAuditWork,
  startAudit,
} from "./audits.ts";
import { savedRun, seedRuns, tempDir, tempRepo } from "./test-orchestrate.ts";

const NOW = new Date("2026-11-28T02:00:00.000Z");

// A temp yok home holding runs r-1 (the run under test), r-2 and r-3 of project `repo`.
const withSeededStorage = async <T>(
  work: (storage: IStorage, run: RunRef, repo: string) => Promise<T>,
): Promise<T> => {
  const home = tempDir();
  const repo = tempRepo();
  await seedRuns(home, [
    savedRun(repo),
    savedRun(repo, { id: "r-2" }),
    savedRun(repo, { id: "r-3" }),
  ]);
  return withStorage(home, (storage) =>
    work(storage, { id: "r-1", cwd: repo, name: "audit" }, repo),
  );
};

const workspaceOf = (repo: string) => ({
  workspace: { repos: [{ name: "yok", worktreeDir: repo }] },
});

const headOf = async (repo: string): Promise<string> => {
  const sha = await createGit().headSha(repo);
  if (!sha.ok) throw new Error(sha.error);
  return sha.value;
};

const resultOf = (auditRunId: string, title = "two tests check one rule") => ({
  id: `${auditRunId}:yok:duplicates:a-test`,
  repo: "yok",
  problemType: "duplicates",
  state: "needs_approval",
  title,
  proof: {},
  fix: { summary: "delete one" },
});

const metric = {
  repo: "yok",
  metric: "coverage",
  scope: "",
  status: "measured",
  reason: null,
  value: 81,
  how: {},
} as const;

const started = async (storage: IStorage, run: RunRef, repo: string) => {
  const audit = await startAudit(storage, createGit(), run, workspaceOf(repo), NOW);
  if (!audit.ok) throw new Error(audit.error);
  return audit.value;
};

describe("startAudit", () => {
  test("SC1: the first audit of a project covers the week before now, at each repo's HEAD", async () => {
    await withSeededStorage(async (storage, run, repo) => {
      const audit = await started(storage, run, repo);
      expect(audit).toMatchObject({
        status: "running",
        audit: "test",
        project: "repo",
        runId: "r-1",
        periodStart: "2026-11-21T02:00:00.000Z",
        periodEnd: "2026-11-28T02:00:00.000Z",
        commits: { yok: await headOf(repo) },
      });
    });
  });

  test("SC2: a later audit starts where the newest complete or partial one ended, skipping a failed one", async () => {
    await withSeededStorage(async (storage, run, repo) => {
      const seed = async (runId: string, periodEnd: string, status: "complete" | "failed") => {
        const audit = await storage.audits.start({
          runId,
          project: "repo",
          audit: "test",
          periodStart: "2026-11-14T02:00:00.000Z",
          periodEnd,
          commits: {},
        });
        if (!audit.ok) throw new Error(audit.error);
        await storage.audits.finish(audit.value.id, { status, metrics: [], results: [] });
      };
      await seed("r-2", "2026-11-21T02:00:00.000Z", "complete");
      await seed("r-3", "2026-11-22T02:00:00.000Z", "failed");
      expect((await started(storage, run, repo)).periodStart).toBe("2026-11-21T02:00:00.000Z");
    });
  });

  test("SC3: starting the same run's audit twice keeps one running audit with the later period end", async () => {
    await withSeededStorage(async (storage, run, repo) => {
      const first = await started(storage, run, repo);
      const later = new Date(NOW.getTime() + 60_000);
      const second = await startAudit(storage, createGit(), run, workspaceOf(repo), later);
      expect(second.ok && second.value.id).toBe(first.id);
      expect(await storage.audits.list("repo", "test")).toEqual([
        expect.objectContaining({
          id: first.id,
          status: "running",
          periodEnd: later.toISOString(),
        }),
      ]);
    });
  });

  test("SC4: a workspace with no repos is refused before any audit is stored", async () => {
    await withSeededStorage(async (storage, run) => {
      const refused = await startAudit(
        storage,
        createGit(),
        run,
        { workspace: { repos: [] } },
        NOW,
      );
      expect(!refused.ok && refused.error).toStartWith("audit start:");
      expect(await storage.audits.list("repo", "test")).toEqual([]);
    });
  });
});

describe("finishAudit", () => {
  test("SC5: finishing publishes a partial report on the run's own audit", async () => {
    await withSeededStorage(async (storage, run, repo) => {
      const audit = await started(storage, run, repo);
      const report = { status: "partial", metrics: [metric], results: [resultOf(audit.id)] };
      expect((await finishAudit(storage, run, report)).ok).toBe(true);
      expect(await storage.audits.read(audit.id)).toMatchObject({
        run: { status: "partial" },
        metrics: [metric],
        results: [resultOf(audit.id)],
      });
    });
  });

  test("SC6: finishing again after an apply run acted on a result is refused with nothing written", async () => {
    await withSeededStorage(async (storage, run, repo) => {
      const audit = await started(storage, run, repo);
      const result = resultOf(audit.id);
      await finishAudit(storage, run, { status: "complete", metrics: [metric], results: [result] });
      await storage.audits.addEvent({
        resultId: result.id,
        type: "apply_started",
        who: "yok",
        payload: {},
        startedRunId: "r-2",
      });
      const refused = await finishAudit(storage, run, {
        status: "complete",
        metrics: [],
        results: [resultOf(audit.id, "a new title")],
      });
      expect(!refused.ok && refused.error).toContain(result.id);
      expect(await storage.audits.read(audit.id)).toMatchObject({
        metrics: [metric],
        results: [result],
      });
    });
  });

  test("SC7: finishing a run that never opened an audit says the run has no audit", async () => {
    await withSeededStorage(async (storage, run) => {
      const refused = await finishAudit(storage, run, {
        status: "complete",
        metrics: [],
        results: [],
      });
      expect(!refused.ok && refused.error).toContain("has no audit");
    });
  });
});

describe("closeAudit", () => {
  test("SC8: closing fails a running audit, leaves a published one, and is null with no audit", async () => {
    await withSeededStorage(async (storage, run, repo) => {
      expect(await closeAudit(storage, run)).toEqual({ ok: true, value: null });
      const audit = await started(storage, run, repo);
      expect(await closeAudit(storage, run)).toMatchObject({
        ok: true,
        value: { status: "failed" },
      });
      const result = resultOf(audit.id);
      await finishAudit(storage, run, { status: "complete", metrics: [], results: [result] });
      expect(await closeAudit(storage, run)).toMatchObject({
        ok: true,
        value: { status: "complete" },
      });
      expect(await storage.audits.read(audit.id)).toMatchObject({ results: [result] });
    });
  });
});

// Publishes, for RUN_ID, an audit ending at PERIOD_END that holds RESULTS made from its own id.
const publish = async (
  storage: IStorage,
  runId: string,
  periodEnd: string,
  results: (auditRunId: string) => readonly object[],
): Promise<string> => {
  const audit = await storage.audits.start({
    runId,
    project: "repo",
    audit: "test",
    periodStart: "2026-11-01T02:00:00.000Z",
    periodEnd,
    commits: { yok: "abc" },
  });
  if (!audit.ok) throw new Error(audit.error);
  const report = { status: "complete" as const, metrics: [], results: results(audit.value.id) };
  const finished = await storage.audits.finish(audit.value.id, report as never);
  if (!finished.ok) throw new Error(finished.error);
  return audit.value.id;
};

const withFix = (id: string, fix: object, state = "needs_approval") => ({
  ...resultOf(id.split(":")[0] ?? id),
  id,
  state,
  fix: { summary: "delete one", ...fix },
});

const ghSaying =
  (state: string): Gh =>
  () => ({ ok: true, value: { state, headRefName: "audit-b" } });

describe("listAuditWork", () => {
  test("SC32: an accepted result applies its diff and an undone one reverts its commit with git revert", async () => {
    await withSeededStorage(async (storage) => {
      const id = await publish(storage, "r-2", "2026-11-21T02:00:00.000Z", (audit) => [
        withFix(`${audit}:yok:flaky:r1`, { diff: "-a\n+b" }),
        withFix(`${audit}:yok:duplicates:r2`, { diff: "-copy", commit: "C" }, "auto_fixed"),
      ]);
      const work = await listAuditWork(
        storage,
        {
          results: [
            { id: `${id}:yok:flaky:r1`, action: "apply" },
            { id: `${id}:yok:duplicates:r2`, action: "revert" },
          ],
        },
        ghSaying("OPEN"),
      );
      if (!work.ok) throw new Error(work.error);
      const [apply, revert] = work.value.fixes;
      expect(apply).toMatchObject({ repo: "yok", summary: "two tests check one rule" });
      expect(apply?.hint).toContain("-a\n+b");
      expect(apply?.hint).toContain("make the change its summary describes");
      expect(revert?.hint).toBe("git revert --no-edit C");
    });
  });

  test.each([
    ["OPEN", "audit-b", true],
    ["MERGED", null, false],
  ])(
    "SC33: the newest audit's PR, %s, gives upstream %s and onPr %s",
    async (state, upstream, onPr) => {
      await withSeededStorage(async (storage) => {
        const older = await publish(storage, "r-2", "2026-11-14T02:00:00.000Z", (audit) => [
          withFix(`${audit}:yok:flaky:old`, { diff: "-o", pr: "https://x/P1" }),
        ]);
        const newer = await publish(storage, "r-3", "2026-11-21T02:00:00.000Z", (audit) => [
          withFix(`${audit}:yok:flaky:new`, { diff: "-n", pr: "https://x/P2" }),
        ]);
        const work = await listAuditWork(
          storage,
          {
            results: [
              { id: `${older}:yok:flaky:old`, action: "apply" },
              { id: `${newer}:yok:flaky:new`, action: "apply" },
            ],
          },
          ghSaying(state),
        );
        expect(work).toMatchObject({ ok: true, value: { pr: "https://x/P2", upstream, onPr } });
      });
    },
  );

  test("the work names each repo its fixes touch once, so the workspace holds only those repos", async () => {
    await withSeededStorage(async (storage) => {
      const id = await publish(storage, "r-2", "2026-11-21T02:00:00.000Z", (audit) => [
        { ...withFix(`${audit}:web:flaky:w1`, { diff: "-w" }), repo: "web" },
        withFix(`${audit}:yok:flaky:y1`, { diff: "-y" }),
        withFix(`${audit}:yok:flaky:y2`, { diff: "-z" }),
      ]);
      const work = await listAuditWork(
        storage,
        {
          results: ["web:flaky:w1", "yok:flaky:y1", "yok:flaky:y2"].map((rest) => ({
            id: `${id}:${rest}`,
            action: "apply",
          })),
        },
        ghSaying("OPEN"),
      );
      expect(work).toMatchObject({ ok: true, value: { repos: ["web", "yok"] } });
    });
  });

  test("SC34: work under an unknown audit names the audit run, and a revert with no commit names the result", async () => {
    await withSeededStorage(async (storage) => {
      const unknown = await listAuditWork(
        storage,
        { results: [{ id: "a-missing:yok:flaky:x", action: "apply" }] },
        ghSaying("OPEN"),
      );
      expect(!unknown.ok && unknown.error).toContain("a-missing");
      const id = await publish(storage, "r-2", "2026-11-21T02:00:00.000Z", (audit) => [
        withFix(`${audit}:yok:flaky:r1`, { diff: "-a" }),
      ]);
      const revert = await listAuditWork(
        storage,
        { results: [{ id: `${id}:yok:flaky:r1`, action: "revert" }] },
        ghSaying("OPEN"),
      );
      expect(!revert.ok && revert.error).toContain(`${id}:yok:flaky:r1`);
    });
  });
});

const stateWith = (runDir: string, nodeRuns: State["nodeRuns"]): State => ({
  schemaVersion: 1,
  lastEventSeq: 0,
  runId: "r-1",
  runName: "audit",
  runDir,
  config: { path: null, root: runDir },
  version: "2.0.0",
  workflow: { name: "test-audit-apply", path: "workflow.yaml" },
  input: {},
  scope: null,
  startedAt: "2026-11-28T02:00:00Z",
  completedAt: null,
  status: "running",
  workspace: {
    type: "mono",
    path: runDir,
    repositories: {
      yok: { path: runDir, git: { branch: "b", baseBranch: "main", startSha: "a" } },
    },
  },
  nodeRuns,
  activeSessions: [],
  tiers: null,
  eventHandlers: {},
  subscribers: {},
});

const finished = (nodeRunId: string, artifacts: State["nodeRuns"][string]["artifacts"]) => ({
  nodeRunId,
  nodeType: "agent" as const,
  status: "completed" as const,
  startedAt: "2026-11-28T02:00:00Z",
  completedAt: "2026-11-28T02:01:00Z",
  artifacts,
  input: null,
});

describe("recordAuditWork", () => {
  test("SC35: an applied fix gets commit and PR, a reverted one is cleared, one left gets its reason, one unreported an error", async () => {
    await withSeededStorage(async (storage, run) => {
      const id = await publish(storage, "r-2", "2026-11-21T02:00:00.000Z", (audit) => [
        withFix(`${audit}:yok:flaky:r1`, { diff: "-1" }),
        withFix(
          `${audit}:yok:duplicates:r2`,
          { diff: "-2", commit: "old", pr: "https://x/old" },
          "auto_fixed",
        ),
        withFix(`${audit}:yok:flaky:r3`, { diff: "-3" }),
        withFix(`${audit}:yok:flaky:r4`, { diff: "-4" }),
      ]);
      const r1 = `${id}:yok:flaky:r1`;
      const r2 = `${id}:yok:duplicates:r2`;
      const r3 = `${id}:yok:flaky:r3`;
      const r4 = `${id}:yok:flaky:r4`;
      const runDir = runDirOf(run.cwd, run.name);
      mkdirSync(join(runDir, "artifacts", "fixes"), { recursive: true });
      writeFileSync(
        join(runDir, "artifacts", "fixes", "audit-apply-1.json"),
        JSON.stringify([
          { id: r1, status: "closed", commit: "c1" },
          { id: r2, status: "closed", commit: "c2" },
          { id: r3, status: "left", reason: "keeper fails" },
        ]),
      );
      const url = "https://github.com/o/yok/pull/9";
      await storage.runs.initRun(
        run.id,
        run.name,
        stateWith(runDir, {
          fix: finished("nr-fix", [
            {
              type: "fix-result",
              name: "audit-apply-1",
              path: "artifacts/fixes/audit-apply-1.json",
            },
          ]),
          "visual-pr": finished("nr-visual-pr", [{ type: "pull-request", name: "yok", url }]),
        }),
      );

      const recorded = await recordAuditWork(storage, run, {
        results: [
          { id: r1, action: "apply" },
          { id: r2, action: "revert" },
          { id: r3, action: "apply" },
          { id: r4, action: "apply" },
        ],
      });
      if (!recorded.ok) throw new Error(recorded.error);
      const [one, two, three, four] = recorded.value;
      expect(one?.fix).toMatchObject({ commit: "c1", pr: url });
      expect(two?.fix).toEqual({ summary: "delete one", diff: "-2" });
      expect(three?.fix?.error).toBe("keeper fails");
      expect(four?.fix?.error).toBe("the fix stage did not report this result");
    });
  });
});
