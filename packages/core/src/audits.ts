import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  type FixResult,
  FixResultsSchema,
  type IGit,
  type IStorage,
  type JsonValue,
  NonEmptyStringSchema,
  type Result,
  type RunRef,
  readState,
  runDirOf,
} from "@yok/sdk";
import {
  type AuditFixPatch,
  type AuditRecord,
  type AuditReport,
  AuditReportSchema,
  type AuditResult,
  type AuditRun,
} from "@yok/sdk/internal";
import * as z from "zod";
import { unwrap } from "./agents/common.ts";
import { findNewestArtifacts } from "./workflow/done.ts";

// A project's first audit looks back one week.
const FIRST_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

// create-workspace's output; audit start reads only each repo's name and worktree.
const AuditStartInputSchema = z.object({
  workspace: z.object({
    repos: z
      .array(z.object({ name: NonEmptyStringSchema, worktreeDir: NonEmptyStringSchema }))
      .min(1),
  }),
});

// Each action is an orchestrate reply, so it returns a Result; the steps inside it throw.
const toResult = async <T>(work: () => Promise<T>): Promise<Result<T>> => {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const parseInput = <T>(schema: z.ZodType<T>, input: JsonValue, action: string): T => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error(`audit ${action}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
};

const findProject = async (storage: IStorage, run: RunRef): Promise<string> => {
  const saved = await storage.runs.findRun(run.id);
  if (saved === undefined) throw new Error(`run ${run.name} is not in yok.db`);
  return saved.project;
};

// The audit this yok run opened, if any: an audit run's runId is unique.
const findOwnAudit = async (storage: IStorage, run: RunRef): Promise<AuditRun | undefined> => {
  const audits = await storage.audits.list(await findProject(storage, run), "test");
  return audits.find((audit) => audit.runId === run.id);
};

// Right after create-workspace, each worktree's HEAD is the commit the audit measures.
const readCommits = async (
  git: Pick<IGit, "headSha">,
  repos: readonly Readonly<{ name: string; worktreeDir: string }>[],
): Promise<Record<string, string>> =>
  Object.fromEntries(
    await Promise.all(
      repos.map(async (repo) => {
        const sha = await git.headSha(repo.worktreeDir);
        if (!sha.ok) throw new Error(`audit start: ${repo.name}: ${sha.error}`);
        return [repo.name, sha.value] as const;
      }),
    ),
  );

export const startAudit = (
  storage: IStorage,
  git: Pick<IGit, "headSha">,
  run: RunRef,
  input: JsonValue,
  now: Date,
): Promise<Result<AuditRun>> =>
  toResult(async () => {
    const { workspace } = parseInput(AuditStartInputSchema, input, "start");
    const project = await findProject(storage, run);
    const audits = await storage.audits.list(project, "test");
    // Two audits at once would both cover the same period and both delete the same duplicates.
    // A run that stopped without closing its audit no longer blocks once it is cancelled.
    for (const audit of audits.filter((a) => a.runId !== run.id && a.status === "running")) {
      const status = (await storage.runs.readState(audit.runId))?.status;
      if (status === "running" || status === "blocked") {
        throw new Error(`audit start: run ${audit.runId} is still auditing ${project}`);
      }
    }
    const commits = await readCommits(git, workspace.repos);
    // A failed or unfinished audit measured nothing, so the next one covers its period again.
    const previous = audits.find(
      (audit) =>
        audit.runId !== run.id && (audit.status === "complete" || audit.status === "partial"),
    );
    return unwrap(
      await storage.audits.start({
        runId: run.id,
        project,
        audit: "test",
        periodStart: previous?.periodEnd ?? new Date(now.getTime() - FIRST_PERIOD_MS).toISOString(),
        periodEnd: now.toISOString(),
        commits,
      }),
    );
  });

const findAppliedIds = async (
  storage: IStorage,
  results: readonly AuditResult[],
): Promise<readonly string[]> => {
  const started = await Promise.all(
    results.map(async (result) =>
      (await storage.audits.run(result.id)) === undefined ? [] : [result.id],
    ),
  );
  return started.flat();
};

export const finishAudit = (
  storage: IStorage,
  run: RunRef,
  input: JsonValue,
): Promise<Result<AuditRun>> =>
  toResult(async () => {
    const report = parseInput<AuditReport>(AuditReportSchema, input, "finish");
    const own = await findOwnAudit(storage, run);
    if (own === undefined) throw new Error(`run ${run.name} has no audit; run audit start first`);
    const record = await storage.audits.read(own.id);
    // A retried publish would overwrite the commit, pr or error an apply run wrote on a result.
    const applied = await findAppliedIds(storage, record?.results ?? []);
    if (applied.length > 0) {
      throw new Error(
        `audit ${own.id} is not published again: an apply run already acted on ${applied.join(", ")}`,
      );
    }
    return unwrap(await storage.audits.finish(own.id, report));
  });

export const closeAudit = (storage: IStorage, run: RunRef): Promise<Result<AuditRun | null>> =>
  toResult(async () => {
    const own = await findOwnAudit(storage, run);
    if (own === undefined || own.status !== "running") return own ?? null;
    return unwrap(
      await storage.audits.finish(own.id, { status: "failed", metrics: [], results: [] }),
    );
  });

// The server tick's handover: each result it wrote a *_started row for, and what to do with it.
const AuditWorkInputSchema = z.object({
  results: z
    .array(z.object({ id: NonEmptyStringSchema, action: z.enum(["apply", "revert"]) }))
    .min(1),
});
type AuditWorkItem = z.infer<typeof AuditWorkInputSchema>["results"][number];

// One item in the shape skills/fix reads; its id is the result's.
type FixItem = Readonly<{
  id: string;
  repo: string;
  summary: string;
  trigger: string;
  hint: string;
}>;

export type AuditWork = Readonly<{
  fixes: readonly FixItem[];
  // the repos the fixes touch, which the run's workspace holds
  repos: readonly string[];
  // the newest audit's PR, and its head branch while it is open
  pr: string | null;
  upstream: string | null;
  onPr: boolean;
}>;

export type Gh = (args: readonly string[]) => Result<unknown>;

const runGh: Gh = (args) => {
  const ran = spawnSync("gh", [...args], { encoding: "utf8" });
  if (ran.error !== undefined) return { ok: false, error: ran.error.message };
  if (ran.status !== 0) {
    return { ok: false, error: ran.stderr.trim() || `gh exited ${ran.status}` };
  }
  return { ok: true, value: JSON.parse(ran.stdout) };
};

const PrStateSchema = z.looseObject({
  state: z.string(),
  headRefName: NonEmptyStringSchema,
  isCrossRepository: z.boolean(),
});

// A merged, closed or unreadable PR takes no more commits; the run then opens a new one. Nor
// does a fork's PR: its head name (often main) would be pushed to as a branch of origin.
const readOpenBranch = (gh: Gh, url: string): string | null => {
  const viewed = gh(["pr", "view", "--json", "state,headRefName,isCrossRepository", "--", url]);
  const pr = viewed.ok ? PrStateSchema.safeParse(viewed.value) : undefined;
  if (pr?.success !== true || pr.data.isCrossRepository) return null;
  return pr.data.state === "OPEN" ? pr.data.headRefName : null;
};

const toFixItem = (result: AuditResult, action: AuditWorkItem["action"]): FixItem => {
  const { fix } = result;
  if (fix === null) throw new Error(`audit result ${result.id} has no fix`);
  if (action === "revert") {
    if (fix.commit === undefined) {
      throw new Error(`audit result ${result.id} has no commit to revert`);
    }
    return {
      id: result.id,
      repo: result.repo,
      summary: `Undo: ${result.title}`,
      trigger: `A person undid this fix, applied in commit ${fix.commit}.`,
      hint: `git revert --no-edit ${fix.commit}`,
    };
  }
  const hint =
    fix.diff === undefined
      ? (fix.prompt ?? fix.summary)
      : `Apply this diff with git apply; when it no longer applies, make the change its summary describes.\n${fix.diff}`;
  return { id: result.id, repo: result.repo, summary: result.title, trigger: fix.summary, hint };
};

const readAudits = (storage: IStorage, ids: readonly string[]): Promise<readonly AuditRecord[]> =>
  Promise.all(
    ids.map(async (id) => {
      const record = await storage.audits.read(id);
      if (record === undefined) throw new Error(`no audit run ${id}`);
      return record;
    }),
  );

export const listAuditWork = (
  storage: IStorage,
  input: JsonValue,
  gh: Gh = runGh,
): Promise<Result<AuditWork>> =>
  toResult(async () => {
    const work = parseInput(AuditWorkInputSchema, input, "work");
    // A result id is AUDIT_RUN_ID:repo:problemType:slug, and an audit run id holds no colon.
    const auditIds = new Set(work.results.map((item) => item.id.split(":")[0] ?? item.id));
    const audits = await readAudits(storage, [...auditIds]);
    const results = audits.flatMap((record) => record.results);
    const items = work.results.map((item) => {
      const result = results.find((candidate) => candidate.id === item.id);
      if (result === undefined) throw new Error(`no audit result ${item.id}`);
      return { item, result };
    });
    const fixes = items.map(({ item, result }) => toFixItem(result, item.action));
    // A revert's commit is only on its own PR's branch until that PR merges, so its PR comes
    // first. Then the newest audit's open PR collects the run's commits, whichever audit each
    // result came from: its auto-fix PR may be merged while a later apply run's PR is open.
    const revertPrs = items.flatMap(({ item, result }) =>
      item.action === "revert" && result.fix?.pr !== undefined ? [result.fix.pr] : [],
    );
    const newest = [...audits].sort((a, b) => b.run.periodEnd.localeCompare(a.run.periodEnd))[0];
    const prs = (newest?.results ?? [])
      .flatMap(({ fix }) => (fix?.pr === undefined ? [] : [{ pr: fix.pr, at: fix.at ?? "" }]))
      .sort((a, b) => b.at.localeCompare(a.at))
      .map(({ pr }) => pr);
    const open = [...new Set([...revertPrs, ...prs])]
      .map((pr) => ({ pr, upstream: readOpenBranch(gh, pr) }))
      .find(({ upstream }) => upstream !== null);
    const repos = [...new Set(fixes.map((fix) => fix.repo))].sort();
    return {
      fixes,
      repos,
      pr: open?.pr ?? prs[0] ?? null,
      upstream: open?.upstream ?? null,
      onPr: open !== undefined,
    };
  });

const decidePatch = (
  item: AuditWorkItem,
  fixResults: readonly FixResult[],
  prs: ReadonlyMap<string, string>,
): AuditFixPatch => {
  const done = fixResults.find((entry) => entry.id === item.id);
  if (done === undefined) return { error: "the fix stage did not report this result" };
  if (done.status === "left") return { error: done.reason };
  if (item.action === "revert") return { clear: true };
  const pr = prs.get(item.id.split(":")[1] ?? "");
  return pr === undefined ? { commit: done.commit } : { commit: done.commit, pr };
};

export const recordAuditWork = (
  storage: IStorage,
  run: RunRef,
  input: JsonValue,
): Promise<Result<readonly AuditResult[]>> =>
  toResult(async () => {
    const work = parseInput(AuditWorkInputSchema, input, "record");
    const state = await readState(run, storage);
    if (state === null) throw new Error(`run ${run.name} has no state`);
    const fixResult = findNewestArtifacts("fix-result", state.nodeRuns)[0];
    const fixResults =
      fixResult === undefined || !("path" in fixResult)
        ? []
        : FixResultsSchema.parse(
            JSON.parse(await Bun.file(join(runDirOf(run.cwd, run.name), fixResult.path)).text()),
          );
    // visual-pr names each pull-request artifact after its repo
    const prs = new Map(
      findNewestArtifacts("pull-request", state.nodeRuns).flatMap((ref) =>
        "url" in ref ? [[ref.name, ref.url] as const] : [],
      ),
    );
    // One result at a time, so a refusal stops before the rest are written.
    const recorded: AuditResult[] = [];
    for (const item of work.results) {
      recorded.push(
        unwrap(await storage.audits.setFix(item.id, decidePatch(item, fixResults, prs))),
      );
    }
    return recorded;
  });
