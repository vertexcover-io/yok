import { realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  colorFile,
  DOC_STYLES,
  isInsideDir,
  renderMarkdown,
  repoFiles,
  resolveRepoPath,
  type WorkflowAgent,
} from "@yok/core";
import type {
  EmitInput,
  IAgentProvider,
  ILogger,
  IStorage,
  ITerminalHost,
  NodeRun,
  Result,
  State,
  WorkflowRun,
} from "@yok/sdk";
import { emitRunEvent, NonEmptyStringSchema, readPolicies, runDirOf } from "@yok/sdk";
import {
  CommentDraftSchema,
  commentRepliedEvent,
  commentsAddedEvent,
  VERSION,
} from "@yok/sdk/internal";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import * as z from "zod";
// @ts-expect-error Bun's text import yields the file's source; TypeScript types the module instead.
import ANCHOR_SOURCE from "./anchor.ts" with { type: "text" };
import AUDITS_HTML from "./audits.html" with { type: "text" };
import { isAgentAlive, lastDelivery, readStateOrNull, scheduleDelivery } from "./delivery.ts";
import {
  listRunSummaries,
  listSteps,
  type RunFiles,
  readRunFiles,
  type Step,
  summarizeRun,
  usersById,
} from "./overview.ts";
// @ts-expect-error Bun's text import yields the file's source; TypeScript types the module instead.
import SHARED_SOURCE from "./page-shared.ts" with { type: "text" };
import { publicOrigin } from "./protocol.ts";
import RUNS_HTML from "./runs.html" with { type: "text" };
import VIEWER_HTML from "./viewer.html" with { type: "text" };

// The document styles live in core, shared with the plan page; the viewer page carries a slot for them.
const VIEWER_PAGE = (VIEWER_HTML as unknown as string).replace("/* {{DOC_STYLES}} */", DOC_STYLES);
const RUNS_PAGE = (RUNS_HTML as unknown as string).replace("{{VERSION}}", VERSION);
const AUDITS_PAGE = (AUDITS_HTML as unknown as string).replace("{{VERSION}}", VERSION);

const transpiler = new Bun.Transpiler({ loader: "ts" });
const ANCHOR_JS = transpiler.transformSync(ANCHOR_SOURCE as string);
const SHARED_JS = transpiler.transformSync(SHARED_SOURCE as string);

type EditorTarget = Readonly<{ file: string; line: number | null }>;

export type ViewerDeps = Readonly<{
  openInEditor: (target: EditorTarget) => Result<null>;
  storage: IStorage;
  log: ILogger;
  providerFor: (agent: WorkflowAgent) => IAgentProvider;
  host: ITerminalHost;
  now: () => Date;
  // Aborted when the server stops, so the live streams end instead of holding it open.
  stopping: AbortSignal;
}>;
export type FileType = "md" | "html" | "image" | "text" | "binary";
export type ArtifactEntry = Readonly<{
  path: string;
  type: FileType;
  draft: boolean;
  awaitingApproval: boolean;
  autoApproved: boolean;
}>;
export type ViewedRun =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "starting"; run: WorkflowRun }>
  | Readonly<{ kind: "ready"; run: WorkflowRun; runDir: string }>;

const EXTENSIONS: Readonly<Record<Exclude<FileType, "binary">, readonly string[]>> = {
  md: [".md", ".markdown"],
  html: [".html", ".htm"],
  image: [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"],
  text: [
    ".json",
    ".jsonl",
    ".log",
    ".txt",
    ".yaml",
    ".yml",
    ".ts",
    ".js",
    ".css",
    ".csv",
    ".toml",
    ".sh",
  ],
};

export const fileType = (path: string): FileType => {
  const lower = path.toLowerCase();
  const match = Object.entries(EXTENSIONS).find(([, extensions]) =>
    extensions.some((extension) => lower.endsWith(extension)),
  );
  return (match?.[0] as FileType | undefined) ?? "binary";
};

export const resolveArtifactPath = (runDir: string, relPath: string): string | null => {
  const root = join(resolve(runDir), "artifacts");
  const resolved = resolve(runDir, relPath);
  if (resolved === root || !isInsideDir(root, resolved)) return null;
  // A symlink under artifacts/ can point anywhere, so its real path must stay inside too. A file
  // that does not exist yet has no real path; the route's own existence check answers for it.
  try {
    return isInsideDir(realpathSync(root), realpathSync(resolved)) ? resolved : null;
  } catch {
    return resolved;
  }
};

const GOTO_EDITORS = new Set(["code", "code-insiders", "cursor", "codium", "windsurf", "positron"]);
const COLON_EDITORS = new Set(["zed", "subl", "sublime_text"]);
const LINE_FLAG_EDITORS = new Set(["idea", "webstorm", "pycharm", "goland", "rider", "clion"]);
const TERMINAL_EDITORS = new Set([
  "vi",
  "vim",
  "nvim",
  "nano",
  "pico",
  "emacs",
  "micro",
  "hx",
  "kak",
]);
const WAIT_FLAGS = new Set(["--wait", "-w"]);

export const editorCommand = ({
  editor,
  file,
  line,
}: Readonly<{ editor: string } & EditorTarget>): readonly string[] | null => {
  const [bin = "", ...args] = editor.trim().split(/\s+/);
  const name = basename(bin);
  if (TERMINAL_EDITORS.has(name)) return null;
  const flags = args.filter((arg) => !WAIT_FLAGS.has(arg));
  if (line === null) return [bin, ...flags, file];
  if (GOTO_EDITORS.has(name)) return [bin, ...flags, "-g", `${file}:${line}`];
  if (COLON_EDITORS.has(name)) return [bin, ...flags, `${file}:${line}`];
  if (LINE_FLAG_EDITORS.has(name)) return [bin, ...flags, "--line", String(line), file];
  return [bin, ...args, file];
};

// The server has no terminal to show, so an editor that needs one cannot be opened from the page.
export const openInEditor = ({
  env,
  file,
  line,
}: Readonly<
  { env: Readonly<Record<string, string | undefined>> } & EditorTarget
>): Result<null> => {
  const editor = env.VISUAL || env.EDITOR;
  if (!editor)
    return { ok: false, error: "no editor: set VISUAL or EDITOR where the yok server starts" };
  const command = editorCommand({ editor, file, line });
  if (command === null) {
    return {
      ok: false,
      error: `${editor} runs in a terminal: set VISUAL to an editor with a window, such as zed or code`,
    };
  }
  Bun.spawn([...command], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  return { ok: true, value: null };
};

const flattenNodeRuns = (nodeRuns: Readonly<Record<string, NodeRun>>): readonly NodeRun[] =>
  Object.values(nodeRuns).flatMap((run) => [run, ...flattenNodeRuns(run.nodes ?? {})]);

const findAwaitedFiles = (state: State | null): readonly string[] =>
  flattenNodeRuns(state?.nodeRuns ?? {}).flatMap((run) =>
    run.status === "running" && run.awaitingApproval !== undefined ? [run.awaitingApproval] : [],
  );

const walk = async (dir: string): Promise<readonly string[]> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    ),
  );
  return nested.flat();
};

const byListOrder = (a: string, b: string): number => {
  const aNested = a.includes("/");
  const bNested = b.includes("/");
  if (aNested !== bNested) return aNested ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
};

// The engine writes its own state file and its temp copies beside the artifacts.
const ENGINE_FILES = /^(state\.json|\.state\..*\.tmp)$/;

export const listArtifacts = async (
  runDir: string,
  state: State | null,
): Promise<readonly ArtifactEntry[]> => {
  const artifactsDir = join(runDir, "artifacts");
  const delivered = new Set(
    flattenNodeRuns(state?.nodeRuns ?? {}).flatMap((run) =>
      run.artifacts.flatMap((a) => ("path" in a ? [a.path] : [])),
    ),
  );
  const awaited = new Set(findAwaitedFiles(state));
  const autoApproved = new Set(state?.autoApproved ?? []);
  const inside = (await walk(artifactsDir)).filter(
    (file) => resolveArtifactPath(runDir, relative(runDir, file).split(sep).join("/")) !== null,
  );
  return inside
    .map((file) => relative(artifactsDir, file).split(sep).join("/"))
    .filter((rel) => !ENGINE_FILES.test(rel))
    .sort(byListOrder)
    .map((rel) => {
      const path = `artifacts/${rel}`;
      return {
        path,
        type: fileType(path),
        draft: !delivered.has(path),
        awaitingApproval: awaited.has(path),
        autoApproved: autoApproved.has(path),
      };
    });
};

export const findViewedRun = async (storage: IStorage, runId: string): Promise<ViewedRun> => {
  const run = await storage.runs.findRun(runId);
  if (run === undefined) return { kind: "missing" };
  if (run.name === null) return { kind: "starting", run };
  return { kind: "ready", run, runDir: runDirOf(run.cwd, run.name) };
};

// A page another site serves to this machine's browser can reach the port, directly or through
// DNS rebinding; either way its Host or its Origin is not one of these.
export const hostGuard =
  (port: number, domain: string): MiddlewareHandler =>
  async (c, next) => {
    const hosts = [...new Set([`localhost:${port}`, `127.0.0.1:${port}`, domain])];
    const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`, publicOrigin(domain)];
    const host = c.req.header("host") ?? "";
    const origin = c.req.header("origin");
    if (!hosts.includes(host)) {
      return c.text(`forbidden: Host ${host} is not one of ${hosts.join(", ")}`, 403);
    }
    if (origin !== undefined && !origins.includes(origin)) {
      return c.text(`forbidden: Origin ${origin}`, 403);
    }
    await next();
  };

const notFound = (c: Context) => c.text("not found", 404);

const isFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (info) => info.isFile(),
    () => false,
  );

const contentType = (path: string): string =>
  fileType(path) === "html" ? "text/html; charset=utf-8" : Bun.file(path).type;

type ReadyRun = Extract<ViewedRun, { kind: "ready" }>;

const fileReply = async (c: Context, page: ReadyRun, entry: ArtifactEntry) => {
  const abs = resolveArtifactPath(page.runDir, entry.path);
  if (abs === null || !(await isFile(abs))) return notFound(c);
  if (entry.type === "md") {
    const html = renderMarkdown(await readFile(abs, "utf8"), repoFiles(page.run.cwd));
    return c.json({ ...entry, html });
  }
  if (entry.type === "text") return c.json({ ...entry, text: await readFile(abs, "utf8") });
  if (entry.type === "html" || entry.type === "image") {
    return c.json({ ...entry, raw: `/runs/${page.run.id}/raw/${entry.path}` });
  }
  return c.json(entry);
};

// The run row keeps the policies the run launched with, so a missing or unreadable state
// cannot open an unattended run to comments; the state covers runs saved before policies.
const takesComments = (page: ReadyRun, state: State | null): boolean =>
  readPolicies(page.run.policies ?? state?.policies).interaction;

const refuseUnattended = (c: Context): Response =>
  c.text("this run takes no comments: its interaction policy is off", 409);

const requireReadyRun = async (c: Context, deps: ViewerDeps): Promise<ReadyRun | Response> => {
  const page = await findViewedRun(deps.storage, c.req.param("id") ?? "");
  if (page.kind === "missing") return notFound(c);
  if (page.kind === "starting") return c.text("run has no name yet", 409);
  return page;
};

const BatchSchema = z.strictObject({ comments: z.array(CommentDraftSchema).min(1).max(50) });
const FollowUpSchema = z.strictObject({ text: z.string().trim().min(1) });
const OpenSchema = z.strictObject({
  path: NonEmptyStringSchema,
  line: z.number().int().positive().optional(),
});

const logEvent = async (deps: ViewerDeps, page: ReadyRun, event: EmitInput): Promise<void> => {
  const { id, cwd } = page.run;
  const logged = await emitRunEvent({ id, cwd, name: basename(page.runDir) }, event, deps.storage);
  if (!logged.ok) deps.log.error({ runId: id, error: logged.error }, "comment event not logged");
};

const runQueues = new Map<string, Promise<unknown>>();

// The approve check reads the run's state and the logged event clears the wait; two batches for one
// run running between those steps would both pass, so a run's batches go one at a time.
const inRunQueue = <T>(runId: string, work: () => Promise<T>): Promise<T> => {
  const next = (runQueues.get(runId) ?? Promise.resolve()).then(work);
  const settled = next.catch(() => undefined);
  runQueues.set(runId, settled);
  void settled.then(() => {
    if (runQueues.get(runId) === settled) runQueues.delete(runId);
  });
  return next;
};

const POLL_MS = 1000;

type StagedFile = ArtifactEntry & Readonly<{ stage: string | null }>;
type FilesBody = Readonly<{
  state: "starting" | "ready";
  run: Readonly<{ id: string; name: string | null }>;
  files: readonly StagedFile[];
}>;
type CommentsBody = Readonly<{ comments: readonly unknown[]; delivery: unknown }>;

const flatSteps = (steps: readonly Step[]): readonly Step[] =>
  steps.flatMap((step) => [step, ...flatSteps(step.children)]);

// A file belongs to the first stage, in workflow order, that delivered it; the rest come last.
const withStages = (
  files: readonly ArtifactEntry[],
  steps: readonly Step[],
): readonly StagedFile[] => {
  const staged = flatSteps(steps).filter((step) => step.stage !== null);
  const order = [...new Set(staged.map((step) => step.stage))];
  const stageOf = (path: string): string | null =>
    staged.find((step) => step.artifacts.includes(path))?.stage ?? null;
  const rank = (file: StagedFile): number =>
    file.stage === null ? order.length : order.indexOf(file.stage);
  return files
    .map((file) => ({ ...file, stage: stageOf(file.path) }))
    .sort((a, b) => rank(a) - rank(b));
};

const filesBody = async (
  page: Exclude<ViewedRun, { kind: "missing" }>,
  runFiles: RunFiles,
): Promise<FilesBody> => {
  const run = { id: page.run.id, name: page.run.name };
  if (page.kind === "starting") return { state: "starting", run, files: [] };
  const files = await listArtifacts(page.runDir, runFiles.state);
  return { state: "ready", run, files: withStages(files, stepsBody(runFiles).steps) };
};

const stepsBody = ({ state, workflow }: RunFiles): Readonly<{ steps: readonly Step[] }> => {
  if (state === null || workflow === null) return { steps: [] };
  return { steps: listSteps(workflow.nodes, state.nodeRuns) };
};

const commentsBody = async (
  deps: ViewerDeps,
  page: Exclude<ViewedRun, { kind: "missing" }>,
): Promise<CommentsBody> => {
  if (page.kind === "starting") return { comments: [], delivery: null };
  const comments = await deps.storage.comments.list(page.run.id);
  return { comments, delivery: lastDelivery(page.run.id) ?? null };
};

export type AgentStatus = Readonly<{
  state: "starting" | "running" | "waiting" | "stopped";
  reason: string | null;
}>;

// agentAlive is null for a run that is still starting, whose pane nobody asks about.
const agentStatus = (runId: string, agentAlive: boolean | null): AgentStatus => {
  if (agentAlive === null) return { state: "starting", reason: null };
  if (!agentAlive) return { state: "stopped", reason: null };
  const last = lastDelivery(runId);
  if (last?.kind === "waiting") return { state: "waiting", reason: last.reason };
  return { state: "running", reason: null };
};

type Stamp = Readonly<{ mtimeMs: number; size: number }>;

const fileStamps = async (
  runDir: string,
  files: readonly ArtifactEntry[],
): Promise<ReadonlyMap<string, Stamp>> => {
  const stamps = await Promise.all(
    files.map(async (file) => {
      const info = await stat(join(runDir, file.path)).catch(() => null);
      return [file.path, { mtimeMs: info?.mtimeMs ?? 0, size: info?.size ?? 0 }] as const;
    }),
  );
  return new Map(stamps);
};

const sameStamp = (a: Stamp | undefined, b: Stamp): boolean =>
  a !== undefined && a.mtimeMs === b.mtimeMs && a.size === b.size;

const sendEvent = (stream: SSEStreamingApi, event: string, data: unknown) =>
  stream.writeSSE({ event, data: JSON.stringify(data) });

// Sends the event only when its JSON differs from the last one sent under that name.
const sendChanged = async (
  stream: SSEStreamingApi,
  sent: Map<string, string>,
  event: string,
  data: unknown,
): Promise<void> => {
  const json = JSON.stringify(data);
  if (sent.get(event) === json) return;
  sent.set(event, json);
  await stream.writeSSE({ event, data: json });
};

const streamRun = async (stream: SSEStreamingApi, deps: ViewerDeps, id: string): Promise<void> => {
  const sent = new Map<string, string>();
  // null until the first look at the folder: files already there on connect are not "changed".
  let stamps: ReadonlyMap<string, Stamp> | null = null;
  while (!stream.aborted && !deps.stopping.aborted) {
    const page = await findViewedRun(deps.storage, id);
    if (page.kind === "missing") {
      await stream.sleep(POLL_MS);
      continue;
    }
    const runFiles = await readRunFiles(deps.storage, page.run);
    const agentAlive = page.kind === "ready" ? await isAgentAlive(page.run, deps.host) : null;
    const files = await filesBody(page, runFiles);
    await sendChanged(stream, sent, "files", files);
    if (page.kind === "ready") {
      const now = await fileStamps(page.runDir, files.files);
      for (const [path, stamp] of stamps === null ? [] : now) {
        if (!sameStamp(stamps?.get(path), stamp)) {
          await sendEvent(stream, "file", { path, mtimeMs: stamp.mtimeMs });
        }
      }
      stamps = now;
      await sendChanged(stream, sent, "steps", stepsBody(runFiles));
    }
    await sendChanged(
      stream,
      sent,
      "summary",
      summarizeRun(page.run, runFiles, agentAlive, await usersById(deps.storage)),
    );
    await sendChanged(stream, sent, "agent", agentStatus(page.run.id, agentAlive));
    await sendChanged(stream, sent, "comments", await commentsBody(deps, page));
    await stream.sleep(POLL_MS);
  }
};

const streamRuns = async (stream: SSEStreamingApi, deps: ViewerDeps): Promise<void> => {
  let sent = "";
  while (!stream.aborted && !deps.stopping.aborted) {
    const json = JSON.stringify({
      runs: await listRunSummaries(deps.storage, deps.host),
    });
    if (json !== sent) {
      sent = json;
      await stream.writeSSE({ event: "runs", data: json });
    }
    await stream.sleep(POLL_MS);
  }
};

// createRoot (server.ts) puts hostGuard in front of these routes.
export const viewerRoutes = (deps: ViewerDeps) =>
  new Hono()
    .get("/", (c) => c.html(RUNS_PAGE))
    .get("/runs", async (c) => c.json({ runs: await listRunSummaries(deps.storage, deps.host) }))
    .get("/audits", (c) => c.html(AUDITS_PAGE))
    .get("/stream", (c) => streamSSE(c, (stream) => streamRuns(stream, deps)))
    .get("/runs/:id", (c) => c.html(VIEWER_PAGE))
    .get("/assets/anchor.js", (c) =>
      c.body(ANCHOR_JS, 200, { "content-type": "text/javascript; charset=utf-8" }),
    )
    .get("/assets/shared.js", (c) =>
      c.body(SHARED_JS, 200, { "content-type": "text/javascript; charset=utf-8" }),
    )
    .get("/runs/:id/files", async (c) => {
      const page = await findViewedRun(deps.storage, c.req.param("id"));
      if (page.kind === "missing") return notFound(c);
      return c.json(await filesBody(page, await readRunFiles(deps.storage, page.run)));
    })
    .get("/runs/:id/stream", async (c) => {
      const id = c.req.param("id");
      if ((await findViewedRun(deps.storage, id)).kind === "missing") return notFound(c);
      return streamSSE(c, (stream) => streamRun(stream, deps, id));
    })
    .get("/runs/:id/file", async (c) => {
      const id = c.req.param("id");
      const page = await findViewedRun(deps.storage, id);
      if (page.kind !== "ready") return notFound(c);
      const relPath = c.req.query("path") ?? "";
      const files = await listArtifacts(page.runDir, await readStateOrNull(deps.storage, id));
      const entry = files.find((file) => file.path === relPath);
      return entry === undefined ? notFound(c) : fileReply(c, page, entry);
    })
    .get("/runs/:id/source", async (c) => {
      const page = await findViewedRun(deps.storage, c.req.param("id"));
      if (page.kind !== "ready") return notFound(c);
      const path = c.req.query("path") ?? "";
      const text = repoFiles(page.run.cwd).read(path);
      if (text === null) return notFound(c);
      const lines = colorFile(text, path);
      const from = Math.max(1, Number(c.req.query("from")) || 1);
      const to = Math.min(lines.length, Number(c.req.query("to")) || lines.length);
      return c.json({ from, to, total: lines.length, lines: lines.slice(from - 1, to) });
    })
    .get("/runs/:id/raw/*", async (c) => {
      const id = c.req.param("id");
      const page = await findViewedRun(deps.storage, id);
      if (page.kind !== "ready") return notFound(c);
      const relPath = decodeURIComponent(c.req.path.slice(`/runs/${id}/raw/`.length));
      const abs = resolveArtifactPath(page.runDir, relPath);
      if (abs === null || !(await isFile(abs))) return notFound(c);
      return new Response(Bun.file(abs), { headers: { "content-type": contentType(abs) } });
    })
    .get("/runs/:id/comments", async (c) => {
      const page = await requireReadyRun(c, deps);
      if (page instanceof Response) return page;
      return c.json(await commentsBody(deps, page));
    })
    .post("/runs/:id/comments", async (c) => {
      const id = c.req.param("id");
      const page = await requireReadyRun(c, deps);
      if (page instanceof Response) return page;
      const body = BatchSchema.safeParse(await c.req.json().catch(() => null));
      const drafts = body.success ? body.data.comments : [];
      if (
        drafts.length === 0 ||
        drafts.some((d) => resolveArtifactPath(page.runDir, d.file) === null)
      ) {
        return c.text("invalid comments", 400);
      }
      const approved = drafts.filter((d) => d.kind === "approve").map((d) => d.file);
      if (new Set(approved).size < approved.length) {
        return c.text("a batch can approve each file only once", 409);
      }
      return inRunQueue(id, async () => {
        const state = await readStateOrNull(deps.storage, id);
        if (!takesComments(page, state)) return refuseUnattended(c);
        const awaited = new Set(findAwaitedFiles(state));
        const unawaited = approved.find((file) => !awaited.has(file));
        if (unawaited !== undefined) {
          return c.text(`nothing waits for approval on ${unawaited}`, 409);
        }
        const added = await deps.storage.comments.add(id, drafts);
        await logEvent(deps, page, commentsAddedEvent(added));
        void scheduleDelivery(id, deps);
        return c.json({ comments: added }, 201);
      });
    })
    .post("/runs/:id/open", async (c) => {
      const page = await requireReadyRun(c, deps);
      if (page instanceof Response) return page;
      const body = OpenSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.text("invalid open request", 400);
      const { path, line } = body.data;
      const abs = path.startsWith("artifacts/")
        ? resolveArtifactPath(page.runDir, path)
        : resolveRepoPath(page.run.cwd, path);
      if (abs === null || !(await isFile(abs))) return notFound(c);
      try {
        const opened = deps.openInEditor({ file: abs, line: line ?? null });
        return opened.ok ? c.json({ opened: abs }) : c.text(opened.error, 409);
      } catch (error) {
        deps.log.error({ err: error, file: abs }, "the editor did not start");
        return c.text("the editor did not start; the server log has the reason", 500);
      }
    })
    .post("/runs/:id/comments/:cid/reply", async (c) => {
      const id = c.req.param("id");
      const page = await requireReadyRun(c, deps);
      if (page instanceof Response) return page;
      const body = FollowUpSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.text("invalid reply", 400);
      if (!takesComments(page, await readStateOrNull(deps.storage, id))) return refuseUnattended(c);
      const replied = await deps.storage.comments.addUserReply(
        id,
        c.req.param("cid"),
        body.data.text,
      );
      if (!replied.ok) return notFound(c);
      await logEvent(deps, page, commentRepliedEvent("viewer", replied.value));
      void scheduleDelivery(id, deps);
      return c.json({ comment: replied.value });
    });
