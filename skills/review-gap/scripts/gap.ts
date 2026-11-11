#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadCheckoutConfig, type Result } from "@yok/sdk";
import * as z from "zod";

const SeveritySchema = z.enum(["critical", "high", "medium", "low", "unknown"]);
const PersonaSchema = z.enum([
  "defects",
  "spec",
  "security",
  "testing",
  "reuse",
  "simplification",
  "efficiency",
  "altitude",
]);
const DropReasonSchema = z.enum(["drift-bot", "boilerplate", "style", "praise"]);

const GhUserSchema = z.object({ login: z.string() });
const GhCommentSchema = z.object({
  id: z.number(),
  user: GhUserSchema,
  path: z.string(),
  original_line: z.number().nullable(),
  original_commit_id: z.string(),
  in_reply_to_id: z.number().nullable().optional(),
  body: z.string(),
});
const GhReviewSchema = z.object({
  user: GhUserSchema,
  state: z.string(),
  commit_id: z.string().nullable(),
  body: z.string(),
});
const GhIssueCommentSchema = z.object({ id: z.number(), user: GhUserSchema, body: z.string() });
const GhPrSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  merged_at: z.string().nullable(),
  base: z.object({ sha: z.string(), ref: z.string() }),
  head: z.object({ sha: z.string() }),
});
const GhCommitSchema = z.object({ sha: z.string(), commit: z.object({ message: z.string() }) });

export const FindingSchema = z.object({
  id: z.string(),
  commentId: z.number(),
  reviewer: z.string(),
  severity: SeveritySchema,
  category: z.string(),
  title: z.string(),
  path: z.string(),
  line: z.number().nullable(),
  commitSha: z.string(),
  body: z.string(),
  replies: z.array(z.object({ user: z.string(), body: z.string() })),
  humanReply: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const BundleSchema = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  prBody: z.string(),
  state: z.string(),
  mergedAt: z.string().nullable(),
  baseRef: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  diffLines: z.number(),
  findings: z.array(FindingSchema),
  dropped: z.array(
    z.object({
      commentId: z.number(),
      reviewer: z.string(),
      reason: DropReasonSchema,
      excerpt: z.string(),
    }),
  ),
  reviews: z.array(
    z.object({ reviewer: z.string(), state: z.string(), commitSha: z.string(), body: z.string() }),
  ),
  issueComments: z.array(z.object({ reviewer: z.string(), body: z.string() })),
  commits: z.array(z.object({ sha: z.string(), message: z.string() })),
});
export type Bundle = z.infer<typeof BundleSchema>;

export const JudgementSchema = z.object({
  id: z.string(),
  verdict: z.enum(["real", "false-positive", "unclear", "out-of-scope"]),
  evidence: z.string(),
  fixedAfterReview: z.boolean(),
  humanReply: z.string().optional(),
  scope: z.string().optional(),
  lens: z.enum(["A", "B", "C", "other"]).optional(),
  mechanism: z.string().optional(),
  personas: z
    .array(
      z.object({
        name: PersonaSchema,
        promptCoverage: z.enum(["explicit", "implicit", "none"]),
        quote: z.string(),
        why: z.string(),
      }),
    )
    .default([]),
  contextNeeded: z.array(z.string()).default([]),
  matchHint: z.string().optional(),
});
export const AnalysisSchema = z.object({
  repo: z.string(),
  number: z.number(),
  sha: z.string(),
  mergeBase: z.string(),
  plan: z.string(),
  findings: z.array(JudgementSchema),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export const ReplayResultSchema = z.object({
  id: z.string(),
  persona: PersonaSchema,
  result: z.enum(["caught", "partial", "miss"]),
  evidence: z.string(),
  cause: z.enum(["agent-miss", "prompt-gap"]).optional(),
  citation: z.string().optional(),
  proposal: z.string().optional(),
  proposalFile: z.string().optional(),
});
export const ReplaySchema = z.object({
  repo: z.string(),
  number: z.number(),
  sha: z.string(),
  results: z.array(ReplayResultSchema),
});
export type ReplayResult = z.infer<typeof ReplayResultSchema>;

export const ClustersSchema = z.record(
  z.string(),
  z.object({ title: z.string(), findingIds: z.array(z.string()) }),
);
const LedgerRowSchema = z.object({
  key: z.string(),
  commentIds: z.array(z.number()),
  at: z.string(),
});

const PrStatusSchema = z.enum(["collected", "skipped-ledger", "diff-too-large", "fetch-failed"]);
const CollectIndexSchema = z.object({
  at: z.string(),
  days: z.number(),
  state: z.string(),
  repos: z.array(z.string()),
  prs: z.array(
    z.object({
      repo: z.string(),
      number: z.number(),
      status: PrStatusSchema,
      dir: z.string().optional(),
      findings: z.number().default(0),
      dropped: z.number().default(0),
      diffLines: z.number().default(0),
      error: z.string().optional(),
    }),
  ),
});
type CollectIndex = z.infer<typeof CollectIndexSchema>;
type PrEntry = CollectIndex["prs"][number];

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });

const BUFFER = 256 * 1024 * 1024;

const sh = (command: string, args: readonly string[], cwd?: string): Result<string> => {
  const run = spawnSync(command, [...args], { cwd, encoding: "utf8", maxBuffer: BUFFER });
  if (run.error) return fail(`${command} ${args.join(" ")}: ${run.error.message}`);
  if (run.status !== 0) {
    return fail(`${command} ${args.join(" ")} exited ${run.status}: ${run.stderr.trim()}`);
  }
  return ok(run.stdout);
};

const readJson = <T>(path: string, schema: z.ZodType<T>): Result<T> => {
  if (!existsSync(path)) return fail(`no file at ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return fail(`${path}: ${String(error)}`);
  }
  const checked = schema.safeParse(parsed);
  return checked.success ? ok(checked.data) : fail(`${path}: ${z.prettifyError(checked.error)}`);
};

const writeJson = (path: string, value: unknown): void => {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

const readJsonLines = <T>(path: string, schema: z.ZodType<T>): readonly T[] => {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      const parsed = schema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    });
};

// --- bundle: raw GitHub JSON -> one bundle.json per PR ---------------------------------------

const BOT = /\[bot\]$/;
const DRIFT = /drift ?bot|8090|sofa-driftbot/i;
const STYLE_CATEGORIES = new Set(["style", "readability", "naming", "formatting", "documentation"]);
const PRAISE = /^\s*(lgtm|looks good|nice|great|nit:)/i;

export const parseSeverity = (body: string): z.infer<typeof SeveritySchema> => {
  const badge = /severity\/(critical|high|medium|low)/.exec(body)?.[1];
  const parsed = SeveritySchema.safeParse(badge);
  return parsed.success ? parsed.data : "unknown";
};

export const parseCategory = (body: string): string =>
  /category\/([a-z]+)/.exec(body)?.[1] ?? "unknown";

export const parseTitle = (body: string): string => {
  const first = body.split("\n").find((line) => line.trim() !== "") ?? "";
  const clean = first
    .replace(/<picture>.*?<\/picture>/gs, "")
    .replace(/^#+\s*/, "")
    .replace(/\*\*/g, "")
    .trim();
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
};

export const dropReason = (
  reviewer: string,
  body: string,
): z.infer<typeof DropReasonSchema> | undefined => {
  if (DRIFT.test(reviewer) || DRIFT.test(body)) return "drift-bot";
  if (STYLE_CATEGORIES.has(parseCategory(body))) return "style";
  if (body.length < 300 && /no issues (found|detected)/i.test(body)) return "boilerplate";
  if (body.length < 200 && PRAISE.test(body) && !body.includes("`")) return "praise";
  return undefined;
};

export const countDiffLines = (patch: string): number =>
  patch.split("\n").filter((line) => /^[+-](?![+-]{2})/.test(line)).length;

type RawPr = Readonly<{
  pr: z.infer<typeof GhPrSchema>;
  inline: readonly z.infer<typeof GhCommentSchema>[];
  reviews: readonly z.infer<typeof GhReviewSchema>[];
  issue: readonly z.infer<typeof GhIssueCommentSchema>[];
  commits: readonly z.infer<typeof GhCommitSchema>[];
  patch: string;
}>;

const readRaw = (dir: string): Result<RawPr> => {
  const pr = readJson(join(dir, "pr.json"), GhPrSchema);
  if (!pr.ok) return pr;
  const inline = readJson(join(dir, "inline.json"), z.array(GhCommentSchema));
  if (!inline.ok) return inline;
  const reviews = readJson(join(dir, "reviews.json"), z.array(GhReviewSchema));
  if (!reviews.ok) return reviews;
  const issue = readJson(join(dir, "issue.json"), z.array(GhIssueCommentSchema));
  if (!issue.ok) return issue;
  const commits = readJson(join(dir, "commits.json"), z.array(GhCommitSchema));
  if (!commits.ok) return commits;
  const patchPath = join(dir, "diff.patch");
  if (!existsSync(patchPath)) return fail(`no file at ${patchPath}`);
  return ok({
    pr: pr.value,
    inline: inline.value,
    reviews: reviews.value,
    issue: issue.value,
    commits: commits.value,
    patch: readFileSync(patchPath, "utf8"),
  });
};

const toFinding = (
  repo: string,
  number: number,
  comment: z.infer<typeof GhCommentSchema>,
  all: readonly z.infer<typeof GhCommentSchema>[],
): Finding => {
  const replies = all
    .filter((c) => c.in_reply_to_id === comment.id)
    .map((c) => ({ user: c.user.login, body: c.body }));
  return {
    id: `${repo}#${number}:${comment.id}`,
    commentId: comment.id,
    reviewer: comment.user.login,
    severity: parseSeverity(comment.body),
    category: parseCategory(comment.body),
    title: parseTitle(comment.body),
    path: comment.path,
    line: comment.original_line,
    commitSha: comment.original_commit_id,
    body: comment.body,
    replies,
    humanReply: replies.find((r) => !BOT.test(r.user))?.body ?? "",
  };
};

export const buildBundle = (repo: string, raw: RawPr): Bundle => {
  const top = raw.inline.filter((c) => c.in_reply_to_id === null || c.in_reply_to_id === undefined);
  const dropped = top.flatMap((c) => {
    const reason = dropReason(c.user.login, c.body);
    return reason === undefined
      ? []
      : [{ commentId: c.id, reviewer: c.user.login, reason, excerpt: parseTitle(c.body) }];
  });
  const droppedIds = new Set(dropped.map((d) => d.commentId));
  return {
    repo,
    number: raw.pr.number,
    title: raw.pr.title,
    prBody: raw.pr.body ?? "",
    state: raw.pr.state,
    mergedAt: raw.pr.merged_at,
    baseRef: raw.pr.base.ref,
    baseSha: raw.pr.base.sha,
    headSha: raw.pr.head.sha,
    diffLines: countDiffLines(raw.patch),
    findings: top
      .filter((c) => !droppedIds.has(c.id))
      .map((c) => toFinding(repo, raw.pr.number, c, raw.inline)),
    dropped,
    reviews: raw.reviews
      .filter((r) => r.body.trim() !== "")
      .map((r) => ({
        reviewer: r.user.login,
        state: r.state,
        commitSha: r.commit_id ?? "",
        body: r.body,
      })),
    issueComments: raw.issue.map((c) => ({ reviewer: c.user.login, body: c.body })),
    commits: raw.commits.map((c) => ({ sha: c.sha, message: c.commit.message })),
  };
};

export const bundleDir = (dir: string, repo: string): Result<Bundle> => {
  const raw = readRaw(dir);
  if (!raw.ok) return raw;
  const bundle = buildBundle(repo, raw.value);
  writeJson(join(dir, "bundle.json"), bundle);
  return ok(bundle);
};

// --- collect: list PRs, fetch each, bundle, log ---------------------------------------------

const REMOTE = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

export const repoOfRemote = (url: string): string | undefined => {
  const match = REMOTE.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
};

const originRepo = (dir: string): Result<string> => {
  const url = sh("git", ["-C", dir, "remote", "get-url", "origin"]);
  if (!url.ok) return url;
  const repo = repoOfRemote(url.value);
  return repo === undefined
    ? fail(`${dir}: origin is not a GitHub remote: ${url.value}`)
    : ok(repo);
};

// The workspace's packages when the config lists any, else the current checkout's origin.
const resolveRepos = async (flag: string | undefined, cwd: string): Promise<Result<string[]>> => {
  if (flag)
    return ok(
      flag
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean),
    );
  const checkout = await loadCheckoutConfig(cwd);
  if (!checkout.ok) return checkout;
  const paths = Object.values(checkout.value.config.packages).map((p) =>
    join(checkout.value.root, p.path),
  );
  const dirs = paths.length === 0 ? [cwd] : paths;
  const repos = dirs.map(originRepo);
  const failed = repos.find((r) => !r.ok);
  if (failed && !failed.ok) return failed;
  return ok([...new Set(repos.flatMap((r) => (r.ok ? [r.value] : [])))]);
};

const sinceDate = (days: number, now: Date): string =>
  new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);

const listPrs = (repo: string, state: string, since: string, limit: number): Result<number[]> => {
  const search = state === "merged" ? `merged:>=${since}` : `updated:>=${since}`;
  const listed = sh("gh", [
    "pr",
    "list",
    "-R",
    repo,
    "--state",
    state,
    "--search",
    search,
    "--limit",
    String(limit),
    "--json",
    "number",
  ]);
  if (!listed.ok) return listed;
  const parsed = z.array(z.object({ number: z.number() })).safeParse(JSON.parse(listed.value));
  return parsed.success
    ? ok(parsed.data.map((p) => p.number))
    : fail(`gh pr list: ${parsed.error}`);
};

const ghPages = (path: string): Result<string> => {
  const fetched = sh("gh", ["api", "--paginate", "--slurp", path]);
  if (!fetched.ok) return fetched;
  const pages = z.array(z.array(z.unknown())).safeParse(JSON.parse(fetched.value));
  return pages.success ? ok(JSON.stringify(pages.data.flat())) : fail(`${path}: not pages`);
};

const fetchPr = (repo: string, number: number, dir: string): Result<void> => {
  mkdirSync(dir, { recursive: true });
  const files: readonly (readonly [string, Result<string>])[] = [
    ["pr.json", sh("gh", ["api", `repos/${repo}/pulls/${number}`])],
    ["inline.json", ghPages(`repos/${repo}/pulls/${number}/comments`)],
    ["reviews.json", ghPages(`repos/${repo}/pulls/${number}/reviews`)],
    ["issue.json", ghPages(`repos/${repo}/issues/${number}/comments`)],
    ["commits.json", ghPages(`repos/${repo}/pulls/${number}/commits`)],
    ["diff.patch", sh("gh", ["pr", "diff", "-R", repo, String(number)])],
  ];
  const failed = files.find(([, r]) => !r.ok);
  if (failed && !failed[1].ok) return failed[1];
  for (const [name, result] of files) {
    if (result.ok) writeFileSync(join(dir, name), result.value);
  }
  return ok(undefined);
};

const ledgerKey = (bundle: Bundle): string => `${bundle.repo}#${bundle.number}@${bundle.headSha}`;

const topCommentIds = (bundle: Bundle): readonly number[] =>
  [...bundle.findings.map((f) => f.commentId), ...bundle.dropped.map((d) => d.commentId)].sort(
    (a, b) => a - b,
  );

export const inLedger = (
  ledger: readonly z.infer<typeof LedgerRowSchema>[],
  bundle: Bundle,
): boolean => {
  const known = new Set(
    ledger.filter((row) => row.key === ledgerKey(bundle)).flatMap((row) => row.commentIds),
  );
  return known.size > 0 && topCommentIds(bundle).every((id) => known.has(id));
};

type CollectOptions = Readonly<{
  out: string;
  repos: readonly string[];
  days: number;
  state: string;
  prs: readonly number[];
  maxPrs: number;
  maxDiffLines: number;
  ledger: string;
  now: Date;
}>;

const NO_COUNTS = { findings: 0, dropped: 0, diffLines: 0 };

const collectOne = (
  repo: string,
  number: number,
  options: CollectOptions,
  ledger: readonly z.infer<typeof LedgerRowSchema>[],
): PrEntry => {
  const dir = join(options.out, repo, String(number));
  const fetched = existsSync(join(dir, "diff.patch")) ? ok(undefined) : fetchPr(repo, number, dir);
  const bundle = fetched.ok ? bundleDir(dir, repo) : fetched;
  if (!bundle.ok) {
    return { repo, number, status: "fetch-failed", error: bundle.error, ...NO_COUNTS };
  }
  const counts = {
    dir,
    findings: bundle.value.findings.length,
    dropped: bundle.value.dropped.length,
    diffLines: bundle.value.diffLines,
  };
  if (inLedger(ledger, bundle.value)) return { repo, number, status: "skipped-ledger", ...counts };
  if (bundle.value.diffLines > options.maxDiffLines) {
    return { repo, number, status: "diff-too-large", ...counts };
  }
  return { repo, number, status: "collected", ...counts };
};

const collectRepo = (
  repo: string,
  options: CollectOptions,
  ledger: readonly z.infer<typeof LedgerRowSchema>[],
): Result<readonly PrEntry[]> => {
  const numbers =
    options.prs.length > 0
      ? ok([...options.prs])
      : listPrs(repo, options.state, sinceDate(options.days, options.now), options.maxPrs);
  if (!numbers.ok) return numbers;
  console.error(`${repo}: ${numbers.value.length} PRs`);
  return ok(numbers.value.map((n) => collectOne(repo, n, options, ledger)));
};

export const collect = (options: CollectOptions): Result<CollectIndex> => {
  const ledger = readJsonLines(options.ledger, LedgerRowSchema);
  const perRepo = options.repos.map((repo) => collectRepo(repo, options, ledger));
  const failed = perRepo.find((r) => !r.ok);
  if (failed && !failed.ok) return failed;
  const index: CollectIndex = {
    at: options.now.toISOString(),
    days: options.days,
    state: options.state,
    repos: [...options.repos],
    prs: perRepo.flatMap((r) => (r.ok ? r.value : [])),
  };
  writeJson(join(options.out, "collect.json"), index);
  return ok(index);
};

const summarize = (index: CollectIndex): string => {
  const by = (status: PrEntry["status"]): number =>
    index.prs.filter((p) => p.status === status).length;
  const findings = index.prs
    .filter((p) => p.status === "collected")
    .reduce((sum, p) => sum + p.findings, 0);
  const lines = index.prs.map(
    (p) =>
      `${p.repo}#${p.number}\t${p.status}\t${p.findings} findings, ${p.dropped} dropped, ${p.diffLines} diff lines${p.error ? `\t${p.error}` : ""}`,
  );
  return [
    ...lines,
    `collected ${by("collected")} (${findings} findings), skipped-ledger ${by("skipped-ledger")}, diff-too-large ${by("diff-too-large")}, fetch-failed ${by("fetch-failed")}`,
  ].join("\n");
};

// --- checkout: a clone that holds nothing after the reviewed commit --------------------------

// The commit most findings were left on; ties go to the earlier one in the PR's commit order.
export const pickSha = (bundle: Bundle): string => {
  const counts = new Map<string, number>();
  for (const f of bundle.findings) counts.set(f.commitSha, (counts.get(f.commitSha) ?? 0) + 1);
  const order = bundle.commits.map((c) => c.sha);
  const best = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]),
  )[0];
  return best?.[0] ?? bundle.headSha;
};

const git = (dir: string, args: readonly string[]): Result<string> =>
  sh("git", ["-C", dir, ...args]);

const deleteOtherRefs = (dir: string): Result<void> => {
  const refs = git(dir, ["for-each-ref", "--format=%(refname)"]);
  if (!refs.ok) return refs;
  const keep = new Set(["refs/heads/review", "refs/heads/base"]);
  const gone = refs.value
    .split("\n")
    .filter((ref) => ref !== "" && !keep.has(ref))
    .map((ref) => git(dir, ["update-ref", "-d", ref]))
    .find((r) => !r.ok);
  return gone && !gone.ok ? gone : ok(undefined);
};

const isolate = (dir: string): Result<void> => {
  const steps = [
    () => deleteOtherRefs(dir),
    () => git(dir, ["remote", "remove", "origin"]),
    () => git(dir, ["reflog", "expire", "--expire=now", "--all"]),
    () => git(dir, ["gc", "-q", "--prune=now"]),
  ];
  for (const step of steps) {
    const done = step();
    if (!done.ok) return done;
  }
  return ok(undefined);
};

const mergeBaseOf = (dir: string, bundle: Bundle, sha: string): Result<string> => {
  const direct = git(dir, ["merge-base", bundle.baseSha, sha]);
  if (direct.ok) return ok(direct.value.trim());
  const viaRef = git(dir, ["merge-base", `origin/${bundle.baseRef}`, sha]);
  return viaRef.ok ? ok(viaRef.value.trim()) : viaRef;
};

type Checkout = Readonly<{ dir: string; sha: string; mergeBase: string }>;

// The reviewed commit is fetched by SHA: a force-push after the review leaves it unreachable
// from the PR ref, and GitHub still serves it.
const cloneAt = (bundle: Bundle, sha: string, prDir: string, dir: string): Result<Checkout> => {
  rmSync(dir, { recursive: true, force: true });
  const cloned = sh("gh", ["repo", "clone", bundle.repo, dir, "--", "-q"]);
  if (!cloned.ok) return cloned;
  const pr = `refs/pr/${bundle.number}`;
  const fetched = [
    git(dir, ["fetch", "-q", "origin", `refs/pull/${bundle.number}/head:${pr}`]),
    git(dir, ["fetch", "-q", "origin", sha]),
  ].find((r) => !r.ok);
  if (fetched && !fetched.ok) return fetched;
  const mergeBase = mergeBaseOf(dir, bundle, sha);
  if (!mergeBase.ok) return mergeBase;
  const after = git(dir, ["diff", sha, pr]);
  if (!after.ok) return after;
  writeFileSync(join(prDir, "after.patch"), after.value);
  const branches = [
    git(dir, ["checkout", "-q", "-B", "review", sha]),
    git(dir, ["branch", "-f", "base", mergeBase.value]),
  ].find((r) => !r.ok);
  if (branches && !branches.ok) return branches;
  const isolated = isolate(dir);
  return isolated.ok ? ok({ dir, sha, mergeBase: mergeBase.value }) : isolated;
};

const existingCheckout = (dir: string, sha: string): Checkout | undefined => {
  if (!existsSync(join(dir, ".git"))) return undefined;
  const head = git(dir, ["rev-parse", "review"]);
  const base = git(dir, ["rev-parse", "base"]);
  if (!head.ok || !base.ok || head.value.trim() !== sha) return undefined;
  return { dir, sha, mergeBase: base.value.trim() };
};

const GOVERNANCE = [
  ".claude/yok/code-review-reference.md",
  "CONTRIBUTING.md",
  "CODING_STANDARDS.md",
  "STYLE_GUIDE.md",
  "CLAUDE.md",
  "AGENTS.md",
];

const governanceFiles = (dir: string): readonly string[] => {
  const rules = join(dir, ".claude", "rules");
  const ruleFiles = existsSync(rules) ? readdirSync(rules).map((f) => join(rules, f)) : [];
  return [...ruleFiles, ...GOVERNANCE.map((f) => join(dir, f)).filter((f) => existsSync(f))];
};

export const renderMap = (checkout: Checkout, commits: string, numstat: string): string => {
  const files = numstat
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, removed, path] = line.split("\t");
      return `  - ${path} (+${added} -${removed})`;
    });
  const commitLines = commits
    .split("\n")
    .filter(Boolean)
    .map((line) => `  - ${line}`);
  const governance = governanceFiles(checkout.dir).map((f) => `  - ${f}`);
  return [
    "## Map",
    `- Repo checkout: ${checkout.dir} (branch \`review\` is the change, branch \`base\` is the merge-base)`,
    `- Diff command: \`git -C ${checkout.dir} diff base...review\``,
    "- Commits:",
    ...commitLines,
    "- Changed files (volume):",
    ...files,
    "- Governance sources found (rungs 1-3):",
    ...(governance.length > 0 ? governance : ["  - none"]),
    "",
  ].join("\n");
};

const writeMap = (checkout: Checkout, path: string): Result<void> => {
  const commits = git(checkout.dir, ["log", "base..review", "--oneline"]);
  if (!commits.ok) return commits;
  const numstat = git(checkout.dir, ["diff", "--numstat", "base...review"]);
  if (!numstat.ok) return numstat;
  writeFileSync(path, renderMap(checkout, commits.value, numstat.value));
  return ok(undefined);
};

type CheckoutOptions = Readonly<{
  prDir: string;
  sha?: string | undefined;
  copies: readonly string[];
}>;

export const checkout = (options: CheckoutOptions): Result<Record<string, unknown>> => {
  const bundle = readJson(join(options.prDir, "bundle.json"), BundleSchema);
  if (!bundle.ok) return bundle;
  const sha = options.sha ?? pickSha(bundle.value);
  const dir = join(options.prDir, "checkout");
  const existing = existingCheckout(dir, sha);
  const made = existing ? ok(existing) : cloneAt(bundle.value, sha, options.prDir, dir);
  if (!made.ok) return made;
  const mapped = writeMap(made.value, join(options.prDir, "map.md"));
  if (!mapped.ok) return mapped;
  const copies: Record<string, string> = {};
  for (const name of options.copies) {
    const copy = `${dir}-${name}`;
    if (!existsSync(copy)) cpSync(dir, copy, { recursive: true });
    const copyMap = writeMap({ ...made.value, dir: copy }, join(options.prDir, `map-${name}.md`));
    if (!copyMap.ok) return copyMap;
    copies[name] = copy;
  }
  const offCommit = bundle.value.findings.filter((f) => f.commitSha !== sha).map((f) => f.id);
  return ok({
    checkout: dir,
    sha,
    mergeBase: made.value.mergeBase,
    map: join(options.prDir, "map.md"),
    afterPatch: join(options.prDir, "after.patch"),
    copies,
    offCommit,
  });
};

// --- aggregate: analyses + replays -> report, findings.jsonl, ledger -------------------------

type PrRecord = Readonly<{
  bundle: Bundle;
  analysis: Analysis | undefined;
  replay: readonly ReplayResult[];
}>;

const readPr = (dir: string): Result<PrRecord> => {
  const bundle = readJson(join(dir, "bundle.json"), BundleSchema);
  if (!bundle.ok) return bundle;
  const analysisPath = join(dir, "analysis.json");
  const analysis = existsSync(analysisPath) ? readJson(analysisPath, AnalysisSchema) : undefined;
  if (analysis && !analysis.ok) return analysis;
  const replayPath = join(dir, "replay.json");
  const replay = existsSync(replayPath) ? readJson(replayPath, ReplaySchema) : undefined;
  if (replay && !replay.ok) return replay;
  return ok({
    bundle: bundle.value,
    analysis: analysis?.value,
    replay: replay?.value.results ?? [],
  });
};

// PR folders sit at OUT/OWNER/NAME/NUMBER; a checkout folder inside one is never a PR.
const readPrs = (dir: string, depth = 3): Result<readonly PrRecord[]> => {
  if (existsSync(join(dir, "bundle.json"))) {
    const pr = readPr(dir);
    return pr.ok ? ok([pr.value]) : pr;
  }
  if (depth === 0) return ok([]);
  const children = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("checkout"))
    .map((entry) => readPrs(join(dir, entry.name), depth - 1));
  const failed = children.find((c) => !c.ok);
  if (failed && !failed.ok) return failed;
  return ok(children.flatMap((c) => (c.ok ? c.value : [])));
};

type Row = Readonly<{
  id: string;
  repo: string;
  pr: number;
  headSha: string;
  commentId: number;
  reviewer: string;
  severity: Finding["severity"];
  title: string;
  path: string;
  line: number | null;
  verdict: z.infer<typeof JudgementSchema>["verdict"] | "unjudged";
  scope: string | undefined;
  lens: string | undefined;
  mechanism: string | undefined;
  cluster: string;
  fixedAfterReview: boolean | undefined;
  personas: z.infer<typeof JudgementSchema>["personas"];
  replay: readonly ReplayResult[];
}>;

type Clusters = z.infer<typeof ClustersSchema>;

const clusterOf = (clusters: Clusters, id: string, lens: string | undefined): string =>
  Object.entries(clusters).find(([, c]) => c.findingIds.includes(id))?.[0] ??
  `lens-${lens ?? "none"}`;

export const toRows = (prs: readonly PrRecord[], clusters: Clusters): readonly Row[] =>
  prs.flatMap(({ bundle, analysis, replay }) =>
    bundle.findings.map((f) => {
      const judged = analysis?.findings.find((j) => j.id === f.id);
      return {
        id: f.id,
        repo: bundle.repo,
        pr: bundle.number,
        headSha: bundle.headSha,
        commentId: f.commentId,
        reviewer: f.reviewer,
        severity: f.severity,
        title: f.title,
        path: f.path,
        line: f.line,
        verdict: judged?.verdict ?? "unjudged",
        scope: judged?.scope,
        lens: judged?.lens,
        mechanism: judged?.mechanism,
        cluster: clusterOf(clusters, f.id, judged?.lens),
        fixedAfterReview: judged?.fixedAfterReview,
        personas: judged?.personas ?? [],
        replay: replay.filter((r) => r.id === f.id),
      };
    }),
  );

const WEIGHT: Record<Finding["severity"], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 1,
};

type Cluster = Readonly<{ key: string; title: string; rows: readonly Row[]; score: number }>;

const LENS_TITLES: Record<string, string> = {
  "lens-A": "What else can this value be?",
  "lens-B": "Where else is this fact decided?",
  "lens-C": "What if it stops halfway or runs twice?",
  "lens-other": "Other mechanism",
  "lens-none": "No lens recorded",
};

export const rankClusters = (rows: readonly Row[], clusters: Clusters): readonly Cluster[] => {
  const real = rows.filter((r) => r.verdict === "real");
  const keys = [...new Set(real.map((r) => r.cluster))];
  return keys
    .map((key) => {
      const members = real.filter((r) => r.cluster === key);
      const worst = Math.max(...members.map((r) => WEIGHT[r.severity]));
      const prs = new Set(members.map((r) => `${r.repo}#${r.pr}`)).size;
      const title = clusters[key]?.title ?? LENS_TITLES[key] ?? key;
      return { key, title, rows: members, score: worst * prs };
    })
    .sort((a, b) => b.score - a.score || b.rows.length - a.rows.length);
};

type Precision = Readonly<{ reviewer: string; real: number; fp: number; unclear: number }>;

export const precisionByReviewer = (rows: readonly Row[]): readonly Precision[] => {
  const reviewers = [...new Set(rows.map((r) => r.reviewer))].sort();
  return reviewers.map((reviewer) => {
    const mine = rows.filter((r) => r.reviewer === reviewer);
    const count = (verdict: Row["verdict"]): number =>
      mine.filter((r) => r.verdict === verdict).length;
    return {
      reviewer,
      real: count("real"),
      fp: count("false-positive"),
      unclear: count("unclear"),
    };
  });
};

const pct = (num: number, den: number): string =>
  den === 0 ? "n/a" : `${Math.round((100 * num) / den)}%`;

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

const replayCell = (row: Row): string =>
  row.replay.length === 0
    ? "not replayed"
    : row.replay.map((r) => `${r.persona}: ${r.result}`).join(", ");

const renderMiss = (row: Row, miss: ReplayResult): string =>
  [
    `- **${cell(row.title)}** (${row.repo}#${row.pr}, ${miss.persona}): ${miss.cause ?? "cause not recorded"}.`,
    miss.citation
      ? `  ${miss.cause === "agent-miss" ? "Had" : "Missing step"}: ${cell(miss.citation)}`
      : "",
    miss.proposal
      ? `  Proposed: ${cell(miss.proposal)}${miss.proposalFile ? ` (in \`${miss.proposalFile}\`)` : ""}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

const renderCluster = (cluster: Cluster, rank: number): string => {
  const prs = new Set(cluster.rows.map((r) => `${r.repo}#${r.pr}`)).size;
  const table = cluster.rows.map(
    (r) =>
      `| ${r.repo}#${r.pr} | ${r.severity} | ${cell(r.title)} | ${r.fixedAfterReview === undefined ? "?" : r.fixedAfterReview ? "yes" : "no"} | ${replayCell(r)} |`,
  );
  const misses = cluster.rows.flatMap((r) =>
    r.replay.filter((x) => x.result === "miss").map((x) => renderMiss(r, x)),
  );
  return [
    `### ${rank}. ${cluster.title} (score ${cluster.score}: worst severity x ${prs} PR${prs === 1 ? "" : "s"})`,
    "",
    "| PR | Severity | Finding | Fixed after review | Replay |",
    "|---|---|---|---|---|",
    ...table,
    "",
    misses.length > 0 ? `**Misses**\n\n${misses.join("\n")}` : "No misses in this cluster.",
    "",
  ].join("\n");
};

const renderDropped = (prs: readonly PrRecord[], rows: readonly Row[]): string => {
  const early = prs.flatMap((p) =>
    p.bundle.dropped.map(
      (d) =>
        `- ${p.bundle.repo}#${p.bundle.number} ${d.reviewer}: ${d.reason}, "${cell(d.excerpt)}"`,
    ),
  );
  const judged = rows
    .filter((r) => r.verdict === "out-of-scope")
    .map(
      (r) => `- ${r.repo}#${r.pr} ${r.reviewer}: ${r.scope ?? "out of scope"}, "${cell(r.title)}"`,
    );
  const lines = [...early, ...judged];
  return lines.length > 0 ? lines.join("\n") : "- none";
};

const renderIndex = (index: CollectIndex | undefined): readonly string[] => {
  if (index === undefined) return [];
  const by = (status: PrEntry["status"]): readonly PrEntry[] =>
    index.prs.filter((p) => p.status === status);
  const named = (status: PrEntry["status"]): string =>
    by(status)
      .map((p) => `${p.repo}#${p.number}`)
      .join(", ");
  return [
    `| PRs collected | ${by("collected").length} of ${index.prs.length} listed (${index.state}, last ${index.days} days, repos: ${index.repos.join(", ")}) |`,
    `| Skipped, already judged | ${by("skipped-ledger").length}${by("skipped-ledger").length ? ` (${named("skipped-ledger")})` : ""} |`,
    `| Skipped, diff too large | ${by("diff-too-large").length}${by("diff-too-large").length ? ` (${named("diff-too-large")})` : ""} |`,
    `| Fetch failed | ${by("fetch-failed").length}${by("fetch-failed").length ? ` (${named("fetch-failed")})` : ""} |`,
  ];
};

export const renderReport = (
  prs: readonly PrRecord[],
  rows: readonly Row[],
  clusters: Clusters,
  index: CollectIndex | undefined,
  now: Date,
): string => {
  const count = (verdict: Row["verdict"]): number =>
    rows.filter((r) => r.verdict === verdict).length;
  const replays = rows.flatMap((r) => r.replay);
  const byResult = (result: ReplayResult["result"]): number =>
    replays.filter((r) => r.result === result).length;
  const misses = replays.filter((r) => r.result === "miss");
  const byCause = (cause: ReplayResult["cause"]): number =>
    misses.filter((r) => r.cause === cause).length;
  const dropped = prs.reduce((n, p) => n + p.bundle.dropped.length, 0) + count("out-of-scope");
  const precision = precisionByReviewer(rows.filter((r) => r.verdict !== "out-of-scope"));
  const ranked = rankClusters(rows, clusters);
  const unjudged = rows.filter((r) => r.verdict === "unjudged");
  return [
    "# Review gap report",
    "",
    `Generated ${now.toISOString().slice(0, 10)}. Findings by outside reviewers on real PRs, checked against the code they reviewed, then replayed blind through the \`code-review\` personas that should have caught them.`,
    "",
    "## Counts",
    "",
    "| | |",
    "|---|---|",
    ...renderIndex(index),
    `| Findings kept | ${rows.length} |`,
    `| Dropped as out of scope | ${dropped} |`,
    `| Real / false positive / unclear | ${count("real")} / ${count("false-positive")} / ${count("unclear")} |`,
    `| Replays: caught / partial / miss | ${byResult("caught")} / ${byResult("partial")} / ${byResult("miss")} |`,
    `| Misses: agent-miss / prompt-gap | ${byCause("agent-miss")} / ${byCause("prompt-gap")} |`,
    "",
    "## Reviewer precision",
    "",
    "| Reviewer | Real | False positive | Unclear | Precision (real / judged) |",
    "|---|---|---|---|---|",
    ...precision.map(
      (p) =>
        `| ${p.reviewer} | ${p.real} | ${p.fp} | ${p.unclear} | ${pct(p.real, p.real + p.fp + p.unclear)} |`,
    ),
    "",
    "## Clusters, ranked by worst severity x distinct PRs",
    "",
    ...(ranked.length > 0
      ? ranked.map((c, i) => renderCluster(c, i + 1))
      : ["No real findings.", ""]),
    "## Proposed skill changes",
    "",
    "Filled in by the report step from the misses above: one general rule per cluster with a miss, and the file it goes in.",
    "",
    "## Dropped as out of scope",
    "",
    "Style, naming, user preference and learnings are out of scope for now; praise, bot boilerplate and blueprint-drift notes are not findings.",
    "",
    renderDropped(prs, rows),
    "",
    "## Not judged",
    "",
    unjudged.length > 0
      ? unjudged.map((r) => `- ${r.id}: ${cell(r.title)}`).join("\n")
      : "- every kept finding has a verdict",
    "",
  ].join("\n");
};

const toJsonl = (rows: readonly Row[]): string =>
  rows
    .map((r) =>
      JSON.stringify({
        ...r,
        personas: r.personas.map((p) => `${p.name}:${p.promptCoverage}`),
        replay: r.replay.map((x) => ({ persona: x.persona, result: x.result, cause: x.cause })),
      }),
    )
    .join("\n");

const appendLedger = (path: string, prs: readonly PrRecord[], now: Date): number => {
  const known = new Set(readJsonLines(path, LedgerRowSchema).map((r) => r.key));
  const fresh = prs
    .filter((p) => p.analysis !== undefined && !known.has(ledgerKey(p.bundle)))
    .map((p) => ({
      key: ledgerKey(p.bundle),
      commentIds: topCommentIds(p.bundle),
      at: now.toISOString(),
    }));
  if (fresh.length === 0) return 0;
  mkdirSync(resolve(path, ".."), { recursive: true });
  appendFileSync(path, `${fresh.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return fresh.length;
};

type AggregateOptions = Readonly<{
  out: string;
  report: string;
  findings: string;
  ledger: string | undefined;
  clusters: string | undefined;
  now: Date;
}>;

export const aggregate = (options: AggregateOptions): Result<string> => {
  const prs = readPrs(options.out);
  if (!prs.ok) return prs;
  const clusters =
    options.clusters && existsSync(options.clusters)
      ? readJson(options.clusters, ClustersSchema)
      : ok({});
  if (!clusters.ok) return clusters;
  const indexPath = join(options.out, "collect.json");
  const index = existsSync(indexPath) ? readJson(indexPath, CollectIndexSchema) : undefined;
  if (index && !index.ok) return index;
  const rows = toRows(prs.value, clusters.value);
  mkdirSync(resolve(options.report, ".."), { recursive: true });
  writeFileSync(
    options.report,
    renderReport(prs.value, rows, clusters.value, index?.value, options.now),
  );
  mkdirSync(resolve(options.findings, ".."), { recursive: true });
  writeFileSync(options.findings, `${toJsonl(rows)}\n`);
  const recorded = options.ledger ? appendLedger(options.ledger, prs.value, options.now) : 0;
  return ok(
    `${rows.length} findings across ${prs.value.length} PRs -> ${options.report}, ${options.findings}; ${recorded} PRs added to the ledger`,
  );
};

const listReal = (out: string): Result<string> => {
  const prs = readPrs(out);
  if (!prs.ok) return prs;
  const lines = toRows(prs.value, {})
    .filter((r) => r.verdict === "real")
    .map((r) => `${r.id}\t${r.severity}\t${r.lens ?? "-"}\t${r.mechanism ?? "-"}\t${r.title}`);
  return ok(["id\tseverity\tlens\tmechanism\ttitle", ...lines].join("\n"));
};

// --- CLI ---------------------------------------------------------------------------------------

const USAGE = `usage:
  gap.ts collect --out DIR [--repos OWNER/NAME,...] [--days 30] [--state merged|all] [--prs 1,2]
                 [--max-prs 30] [--max-diff-lines 3000] [--ledger PATH]
  gap.ts bundle PR_DIR --repo OWNER/NAME
  gap.ts checkout PR_DIR [--sha SHA] [--copies defects,spec]
  gap.ts list --out DIR
  gap.ts aggregate --out DIR --report PATH --findings PATH [--ledger PATH] [--clusters PATH]`;

type Values = Readonly<{
  out?: string;
  repos?: string;
  repo?: string;
  days?: string;
  state?: string;
  prs?: string;
  "max-prs"?: string;
  "max-diff-lines"?: string;
  ledger?: string;
  sha?: string;
  copies?: string;
  report?: string;
  findings?: string;
  clusters?: string;
}>;

const DEFAULT_LEDGER = join(".yok", "review-gap", "ledger.jsonl");

const integer = (text: string | undefined, fallback: number): Result<number> => {
  if (text === undefined) return ok(fallback);
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 ? ok(n) : fail(`expected a whole number, got "${text}"`);
};

const runCollect = async (values: Values): Promise<Result<string>> => {
  if (!values.out) return fail(USAGE);
  if (values.state !== undefined && values.state !== "merged" && values.state !== "all") {
    return fail(`--state must be merged or all, got "${values.state}"`);
  }
  const days = integer(values.days, 30);
  if (!days.ok) return days;
  const maxPrs = integer(values["max-prs"], 30);
  if (!maxPrs.ok) return maxPrs;
  const maxDiffLines = integer(values["max-diff-lines"], 3000);
  if (!maxDiffLines.ok) return maxDiffLines;
  const prs = (values.prs ?? "").split(",").filter(Boolean).map(Number);
  if (prs.some((n) => !Number.isInteger(n) || n <= 0)) return fail(`bad --prs: ${values.prs}`);
  const repos = await resolveRepos(values.repos, process.cwd());
  if (!repos.ok) return repos;
  const index = collect({
    out: resolve(values.out),
    repos: repos.value,
    days: days.value,
    state: values.state ?? "merged",
    prs,
    maxPrs: maxPrs.value,
    maxDiffLines: maxDiffLines.value,
    ledger: resolve(values.ledger ?? DEFAULT_LEDGER),
    now: new Date(),
  });
  return index.ok ? ok(summarize(index.value)) : index;
};

const runBundle = (values: Values, rest: readonly string[]): Result<string> => {
  const [dir] = rest;
  if (!dir || !values.repo) return fail(USAGE);
  const bundle = bundleDir(resolve(dir), values.repo);
  if (!bundle.ok) return bundle;
  const { findings, dropped, diffLines } = bundle.value;
  return ok(`${findings.length} findings, ${dropped.length} dropped, ${diffLines} diff lines`);
};

const runCheckout = (values: Values, rest: readonly string[]): Result<string> => {
  const [dir] = rest;
  if (!dir) return fail(USAGE);
  const made = checkout({
    prDir: resolve(dir),
    sha: values.sha,
    copies: (values.copies ?? "").split(",").filter(Boolean),
  });
  return made.ok ? ok(JSON.stringify(made.value, null, 2)) : made;
};

const runAggregate = (values: Values): Result<string> => {
  if (!values.out || !values.report || !values.findings) return fail(USAGE);
  return aggregate({
    out: resolve(values.out),
    report: resolve(values.report),
    findings: resolve(values.findings),
    ledger: values.ledger ? resolve(values.ledger) : undefined,
    clusters: values.clusters ? resolve(values.clusters) : undefined,
    now: new Date(),
  });
};

const dispatch = (
  command: string | undefined,
  values: Values,
  rest: readonly string[],
): Promise<Result<string>> | Result<string> => {
  if (command === "collect") return runCollect(values);
  if (command === "bundle") return runBundle(values, rest);
  if (command === "checkout") return runCheckout(values, rest);
  if (command === "list") return values.out ? listReal(resolve(values.out)) : fail(USAGE);
  if (command === "aggregate") return runAggregate(values);
  return fail(USAGE);
};

export const main = async (argv: readonly string[]): Promise<void> => {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      out: { type: "string" },
      repos: { type: "string" },
      repo: { type: "string" },
      days: { type: "string" },
      state: { type: "string" },
      prs: { type: "string" },
      "max-prs": { type: "string" },
      "max-diff-lines": { type: "string" },
      ledger: { type: "string" },
      sha: { type: "string" },
      copies: { type: "string" },
      report: { type: "string" },
      findings: { type: "string" },
      clusters: { type: "string" },
    },
  });
  const [command, ...rest] = positionals;
  const result = await dispatch(command, values, rest);
  if (!result.ok) {
    console.error(result.error);
    process.exitCode = 1;
    return;
  }
  console.log(result.value);
};

if (import.meta.main) {
  await main(process.argv.slice(2));
}
