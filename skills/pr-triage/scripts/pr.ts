#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { NonEmptyStringSchema, type Result } from "@yok/sdk";
import * as z from "zod";

// pr-reply opens every comment it posts with this line, so triage can leave yok's own answers out.
export const REPLY_MARKER = "<!-- yok:pr-reply -->";

export const PrTriageInputSchema = z.strictObject({
  // a pull request number in the project's repo, or its URL
  pr: NonEmptyStringSchema,
  prompt: NonEmptyStringSchema,
});

const ItemSchema = z.strictObject({
  kind: z.enum(["conflict", "review-comment", "review", "comment", "request"]),
  // where the item is and what was asked, quoted, with its author
  source: NonEmptyStringSchema,
});

const PullRequestSchema = z.strictObject({
  // OWNER/NAME
  repo: NonEmptyStringSchema,
  number: z.number().int().positive(),
  url: z.url(),
  branch: NonEmptyStringSchema,
  base: NonEmptyStringSchema,
  // the head commit when triage read the pull request; review covers the commits after it
  head: z.string().regex(/^[0-9a-f]{40}$/),
});

export const PrTriageOutputSchema = z.strictObject({
  task: NonEmptyStringSchema,
  pr: PullRequestSchema,
  hasConflicts: z.boolean(),
  items: z.array(ItemSchema),
  leftOut: z.array(ItemSchema),
});

export const schemas = {
  "pr-triage.input.v1": PrTriageInputSchema,
  "pr-triage.output.v1": PrTriageOutputSchema,
};

const AuthorSchema = z.looseObject({ login: z.string() }).nullable();
const NoteSchema = z.looseObject({
  author: AuthorSchema,
  authorAssociation: z.string().optional(),
  body: z.string(),
  url: z.string(),
});

const ViewSchema = z.looseObject({
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  body: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string(),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  isCrossRepository: z.boolean(),
  comments: z.array(NoteSchema),
  reviews: z.array(
    z.looseObject({
      author: AuthorSchema,
      authorAssociation: z.string().optional(),
      body: z.string(),
      state: z.string(),
    }),
  ),
});
type View = z.infer<typeof ViewSchema>;

const ThreadSchema = z.looseObject({
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: z.string(),
  line: z.number().int().nullable(),
  comments: z.looseObject({
    pageInfo: z.looseObject({ hasNextPage: z.boolean() }).optional(),
    nodes: z.array(NoteSchema),
  }),
});
const ThreadsReplySchema = z.looseObject({
  data: z.looseObject({
    repository: z.looseObject({
      pullRequest: z.looseObject({
        reviewThreads: z.looseObject({
          pageInfo: z
            .looseObject({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })
            .optional(),
          nodes: z.array(ThreadSchema),
        }),
      }),
    }),
  }),
});
type Thread = z.infer<typeof ThreadSchema>;

// A comment that starts a run, matched as the GitHub Action template matches it.
const TRIGGER = /^@yok(\s|$)/;

const isWork = (body: string): boolean => !body.includes(REPLY_MARKER) && !TRIGGER.test(body);

// The roles the GitHub Action lets start a run. A missing role counts as none.
const WRITERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const canWrite = (item: { authorAssociation?: string | undefined }): boolean =>
  WRITERS.has(item.authorAssociation ?? "");

const login = (author: z.infer<typeof AuthorSchema>): string => author?.login ?? "ghost";

const note = (item: z.infer<typeof NoteSchema>) => ({
  author: login(item.author),
  body: item.body,
  url: item.url,
});

const repoOf = (url: string): string => {
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url);
  if (match?.[1] === undefined) throw new Error(`not a GitHub pull request URL: ${url}`);
  return match[1];
};

// What triage reads: open threads only, yok's own replies and @yok triggers left out, reviews
// that say something. A trigger is another run's request, so a thread one started and a review
// summary that is one are left out too. Only someone who can start a run sets its work: a thread
// counts once one of them has commented in it, and everything else goes to fromOthers.
export const toFacts = (view: unknown, threads: unknown) => {
  const pr = ViewSchema.parse(view);
  const nodes = ThreadsReplySchema.parse(threads).data.repository.pullRequest.reviewThreads.nodes;
  const open = nodes
    .filter((thread) => !thread.isResolved)
    .filter((thread) => isWork(thread.comments.nodes[0]?.body ?? ""))
    .map((thread) => ({
      path: thread.path,
      line: thread.line,
      outdated: thread.isOutdated,
      writer: thread.comments.nodes.some(canWrite),
      comments: thread.comments.nodes.filter((item) => !item.body.includes(REPLY_MARKER)).map(note),
    }));
  const comments = pr.comments.filter((item) => isWork(item.body));
  const reviews = pr.reviews.filter((review) => review.body.trim() !== "" && isWork(review.body));
  const review = (item: (typeof reviews)[number]) => ({
    author: login(item.author),
    state: item.state,
    body: item.body,
  });
  const thread = ({ writer: _, ...rest }: (typeof open)[number]) => rest;
  return {
    pr: {
      repo: repoOf(pr.url),
      number: pr.number,
      url: pr.url,
      branch: pr.headRefName,
      base: pr.baseRefName,
      head: pr.headRefOid,
      title: pr.title,
      body: pr.body,
      fromFork: pr.isCrossRepository,
    },
    hasConflicts: pr.mergeable === "CONFLICTING",
    threads: open.filter((item) => item.writer).map(thread),
    comments: comments.filter(canWrite).map(note),
    reviews: reviews.filter(canWrite).map(review),
    fromOthers: {
      threads: open.filter((item) => !item.writer).map(thread),
      comments: comments.filter((item) => !canWrite(item)).map(note),
      reviews: reviews.filter((item) => !canWrite(item)).map(review),
    },
  };
};

const VIEW_FIELDS =
  "number,url,title,body,headRefName,baseRefName,headRefOid,mergeable,isCrossRepository,comments,reviews";

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved isOutdated path line
          comments(first: 100) {
            pageInfo { hasNextPage }
            nodes { author { login } authorAssociation body url }
          }
        }
      }
    }
  }
}`;

export type Gh = (args: readonly string[]) => Result<unknown>;

const runGh: Gh = (args) => {
  const ran = spawnSync("gh", args, { encoding: "utf8" });
  if (ran.error !== undefined) return { ok: false, error: ran.error.message };
  if (ran.status !== 0) return { ok: false, error: ran.stderr.trim() || `gh exited ${ran.status}` };
  return { ok: true, value: JSON.parse(ran.stdout) };
};

const MERGEABLE_TRIES = 5;
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// GitHub works out mergeable after a push, answering UNKNOWN meanwhile; ask again a few times,
// then fail rather than call a pull request that may not merge conflict-free.
const viewPr = async (pr: string, gh: Gh, waitMs: number): Promise<Result<View>> => {
  for (let attempt = 1; ; attempt += 1) {
    const viewed = gh(["pr", "view", pr, "--json", VIEW_FIELDS]);
    if (!viewed.ok) return viewed;
    const view = ViewSchema.parse(viewed.value);
    if (view.mergeable !== "UNKNOWN") return { ok: true, value: view };
    if (attempt === MERGEABLE_TRIES) {
      const error = `GitHub has not yet worked out whether pull request ${pr} can merge`;
      return { ok: false, error: `${error} into its base; try again in a minute` };
    }
    await sleep(waitMs);
  }
};

// Every review thread, page by page: resolved threads fill pages too, so one page misses open ones.
const readThreads = (view: View, gh: Gh): Result<readonly Thread[]> => {
  const [owner, name] = repoOf(view.url).split("/");
  const threads: Thread[] = [];
  for (let after: string | null = null; ; ) {
    const args = ["api", "graphql", "-f", `query=${THREADS_QUERY}`];
    const vars = [`owner=${owner}`, `name=${name}`, `number=${view.number}`];
    const cursor = after === null ? [] : [`after=${after}`];
    const replied = gh([...args, ...[...vars, ...cursor].flatMap((value) => ["-F", value])]);
    if (!replied.ok) return replied;
    const { pageInfo, nodes } =
      ThreadsReplySchema.parse(replied.value).data.repository.pullRequest.reviewThreads;
    threads.push(...nodes);
    if (pageInfo?.hasNextPage !== true || pageInfo.endCursor === null) break;
    after = pageInfo.endCursor;
  }
  const long = threads.find((thread) => thread.comments.pageInfo?.hasNextPage === true);
  if (long !== undefined) {
    const error = `the review thread on ${long.path} has more comments than triage reads (100)`;
    return { ok: false, error };
  }
  return { ok: true, value: threads };
};

export const collect = async (pr: string, gh: Gh = runGh, waitMs = 2000) => {
  const viewed = await viewPr(pr, gh, waitMs);
  if (!viewed.ok) return viewed;
  // The run pushes to origin's branch of the head's name, which for a fork is someone else's.
  if (viewed.value.isCrossRepository) {
    const error = `pull request ${pr} comes from a fork; yok works only on same-repo pull requests`;
    return { ok: false as const, error };
  }
  const threads = readThreads(viewed.value, gh);
  if (!threads.ok) return threads;
  const reviewThreads = { nodes: threads.value };
  const reply = { data: { repository: { pullRequest: { reviewThreads } } } };
  return { ok: true as const, value: toFacts(viewed.value, reply) };
};

const USAGE = "usage: pr.ts collect PR   (a pull request number in this repo, or its URL)";

export const main = async (argv: readonly string[]): Promise<void> => {
  const [command, pr, ...extra] = argv;
  if (command !== "collect" || pr === undefined || extra.length > 0) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const facts = await collect(pr);
  if (!facts.ok) {
    console.error(facts.error);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(facts.value, null, 2)}\n`);
};

if (import.meta.main) await main(process.argv.slice(2));
