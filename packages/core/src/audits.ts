import {
  type IGit,
  type IStorage,
  type JsonValue,
  NonEmptyStringSchema,
  type Result,
  type RunRef,
} from "@yok/sdk";
import {
  type AuditFixPatch,
  AuditFixPatchSchema,
  type AuditReport,
  AuditReportSchema,
  type AuditResult,
  type AuditRun,
} from "@yok/sdk/internal";
import * as z from "zod";
import { unwrap } from "./agents/common.ts";

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
    const commits = await readCommits(git, workspace.repos);
    // A failed or unfinished audit measured nothing, so the next one covers its period again.
    const previous = (await storage.audits.list(project, "test")).find(
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

export const setAuditFix = (
  storage: IStorage,
  resultId: string,
  input: JsonValue,
): Promise<Result<AuditResult>> =>
  toResult(async () =>
    unwrap(
      await storage.audits.setFix(
        resultId,
        parseInput<AuditFixPatch>(AuditFixPatchSchema, input, "fix"),
      ),
    ),
  );
