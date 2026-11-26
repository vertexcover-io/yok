import { describe, expect, test } from "bun:test";
import { createGit, type IStorage, type RunRef } from "@yok/sdk";
import { withStorage } from "@yok/sdk/internal";
import { closeAudit, finishAudit, startAudit } from "./audits.ts";
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
