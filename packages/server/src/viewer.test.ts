import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IStorage, ITerminalHost, NodeRun, State, WorkflowRun } from "@yok/sdk";
import { noopLogger, StateSchema } from "@yok/sdk";
import {
  type AuditFix,
  type AuditMetric,
  type AuditResult,
  type AuditResultEvent,
  memoryStorage,
  TEST_AUDIT_METRICS,
  VERSION,
} from "@yok/sdk/internal";
import { stopDeliveries } from "./delivery.ts";
import {
  claudeOver,
  EMPTY_BOX,
  fakeHost,
  RULE,
  seedRun,
  seedState,
  seedUser,
} from "./fake-host.ts";
import {
  type AuditApplyRun,
  type AuditMetricsPoint,
  autoFixedPr,
  formatChange,
  formatMetric,
  meetsLimit,
  metricChange,
  metricSeries,
  newestWins,
  prLabel,
  rejectBody,
  resultActions,
  resultPageState,
  stoppedRunHelp,
  trendRange,
} from "./page-shared.ts";
import { folderSlug } from "./protocol.ts";
import { editorCommand, listArtifacts, resolveArtifactPath, viewerRoutes } from "./viewer.ts";

const tempDir = (prefix: string): string =>
  realpathSync(mkdtempSync(join(tmpdir(), `yok-${prefix}-`)));

const put = (root: string, rel: string, content: string | Uint8Array): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
};

// Each folder is its own project, since a run's cwd is its project's folder.
const runRecord = (id: string, cwd: string, name: string | null): WorkflowRun => ({
  id,
  project: folderSlug(cwd),
  workflow: "w",
  workflowPath: "/w.yaml",
  inputs: {},
  cwd,
  sessions: [{ agent: "claude", sessionId: "s1" }],
  name,
  terminal: null,
  config: null,
  tiers: null,
  createdAt: "2026-01-01T00:00:00.000Z",
});

// Stores STATE as run ID's own, as an engine write would leave it; the run is stored afresh.
const putState = async (storage: IStorage, id: string, state: unknown): Promise<void> => {
  const run = await storage.runs.findRun(id);
  if (run === undefined) throw new Error(`no run ${id}`);
  await storage.runs.removeRun(id);
  await seedRun(storage, run, StateSchema.parse(state));
};

const stateWith = (nodeRuns: unknown): State => ({ nodeRuns }) as unknown as State;

const nodeRun = (artifacts: readonly string[], nodes?: Record<string, unknown>) => ({
  nodeRunId: "n",
  nodeType: "exec",
  status: "completed",
  startedAt: null,
  completedAt: null,
  artifacts: artifacts.map((path) => ({ name: path, path })),
  ...(nodes === undefined ? {} : { nodes }),
});

describe("listArtifacts", () => {
  test("SC3: a file is a draft until a node run hands it over, including inside a loop", async () => {
    const runDir = tempDir("list");
    put(runDir, "artifacts/design.md", "# d");
    put(runDir, "artifacts/notes.md", "# n");
    const state = stateWith({
      loop: nodeRun([], { inner: nodeRun(["artifacts/design.md"]) }),
    });

    const withState = await listArtifacts(runDir, state);
    expect(withState.find((f) => f.path === "artifacts/design.md")?.draft).toBe(false);
    expect(withState.find((f) => f.path === "artifacts/notes.md")?.draft).toBe(true);

    const noState = await listArtifacts(runDir, null);
    expect(noState.every((f) => f.draft)).toBe(true);
  });

  test("SC528: design.md, which the run's state lists as auto-approved, lists as auto-approved and plan.md does not", async () => {
    const runDir = tempDir("list-auto");
    put(runDir, "artifacts/design.md", "# d");
    put(runDir, "artifacts/plan.md", "# p");
    const state = { ...seedState(runDir, {}), autoApproved: ["artifacts/design.md"] };

    const files = await listArtifacts(runDir, state);
    expect(files.map((f) => [f.path, f.autoApproved])).toEqual([
      ["artifacts/design.md", true],
      ["artifacts/plan.md", false],
    ]);
  });
});

describe("listArtifacts symlinks", () => {
  test("a symlink that points outside artifacts/ is not listed", async () => {
    const runDir = tempDir("list-link");
    put(runDir, "artifacts/ok.md", "# ok");
    writeFileSync(join(runDir, "secret.txt"), "outside");
    symlinkSync(join(runDir, "secret.txt"), join(runDir, "artifacts", "leak.txt"));
    const files = await listArtifacts(runDir, null);
    expect(files.map((f) => f.path)).toEqual(["artifacts/ok.md"]);
  });
});

describe("resolveArtifactPath", () => {
  test("SC4: a path that leaves the artifacts folder is refused", () => {
    const runDir = "/runs/x/.yok/n";
    expect(resolveArtifactPath(runDir, "artifacts/../state.json")).toBeNull();
    expect(resolveArtifactPath(runDir, "../../etc/passwd")).toBeNull();
    expect(resolveArtifactPath(runDir, "/etc/passwd")).toBeNull();
    expect(resolveArtifactPath(runDir, "artifacts/a.md")).toBe(`${runDir}/artifacts/a.md`);
  });

  test("a symlink under artifacts/ that points outside the run is refused", () => {
    const runDir = tempDir("viewer-link");
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    writeFileSync(join(runDir, "secret.txt"), "outside");
    symlinkSync(join(runDir, "secret.txt"), join(runDir, "artifacts", "leak.txt"));
    writeFileSync(join(runDir, "artifacts", "ok.md"), "inside");
    expect(resolveArtifactPath(runDir, "artifacts/leak.txt")).toBeNull();
    expect(resolveArtifactPath(runDir, "artifacts/ok.md")).toBe(join(runDir, "artifacts", "ok.md"));
  });
});

// With a screen, the named run gets a live session showing it, so posted comments are really typed.
// delivery.ts remembers each run's last delivery by id, so a test that reads it passes its own id.
const setup = async (screen?: string, alive = true, namedId = "r-named") => {
  const cwd = tempDir("viewer-cwd");
  const storage = memoryStorage();
  const named = runRecord(namedId, cwd, "demo");
  await seedRun(storage, screen === undefined ? named : { ...named, terminal: "s1" });
  await seedRun(storage, runRecord("r-starting", cwd, null));
  await seedRun(storage, runRecord("r-empty", cwd, "bare"));
  const { host, calls } = fakeHost(screen ?? "", alive);
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  const opened: { file: string; line: number | null }[] = [];
  const app = viewerRoutes({
    log: noopLogger,
    providerFor: () => claudeOver(host),
    host,
    now,
    storage,
    stopping: new AbortController().signal,
    openInEditor: (target) => {
      opened.push(target);
      return { ok: true, value: null };
    },
  });
  const get = (path: string, headers: Record<string, string> = { host: "localhost:4000" }) =>
    app.request(path, { headers });
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { host: "localhost:4000", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    namedId,
    cwd,
    storage,
    app,
    get,
    post,
    calls,
    opened,
    runDir: join(cwd, ".yok", "demo"),
  };
};

const until = async (check: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 50 && !(await check()); i++) await Bun.sleep(50);
};

const statusesOf = async (storage: IStorage, runId = "r-named"): Promise<readonly string[]> =>
  (await storage.comments.list(runId)).map((c) => c.status);

describe("viewer routes", () => {
  test("the dashboard's header links to the person's settings", async () => {
    const { get } = await setup();
    const page = await (await get("/")).text();
    expect(page).toMatch(
      /<header class="bar">[\s\S]*<a class="nav" href="\/settings">Settings<\/a>[\s\S]*<\/header>/,
    );
  });

  test("SC8006: /audits serves the Audits page with the running version, and the runs page's bar links to it", async () => {
    const { get } = await setup();
    const res = await get("/audits");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("<title>yok audits</title>");
    expect(page).toContain(`yok v${VERSION}`);
    const runs = await (await get("/")).text();
    expect(runs).toMatch(
      /<header class="bar">[\s\S]*<a class="nav" href="\/audits">Audits<\/a>[\s\S]*<\/header>/,
    );
  });

  test("the dashboard's footer names the running yok version", async () => {
    const { get } = await setup();
    const page = await (await get("/")).text();
    expect(page).toContain(`<footer class="foot">yok v${VERSION}</footer>`);
  });

  test("SC6: the file list shows every artifact with type and draft flag, top-level first", async () => {
    const { get, runDir } = await setup();
    put(runDir, "artifacts/design.md", "# d");
    put(runDir, "artifacts/state.json", "{}");
    put(runDir, "artifacts/history/v1.md", "# v1");
    put(runDir, "artifacts/logs/run.log", "x");
    put(runDir, "artifacts/mockups/login.png", new Uint8Array([1]));

    const body = (await (await get("/runs/r-named/files")).json()) as {
      files: { path: string; type: string }[];
    };

    expect(body.files.map((f) => [f.path, f.type])).toEqual([
      ["artifacts/design.md", "md"],
      ["artifacts/history/v1.md", "md"],
      ["artifacts/logs/run.log", "text"],
      ["artifacts/mockups/login.png", "image"],
    ]);
  });

  test("each file names the first stage, in workflow order, that delivered it, and files no stage delivered come last", async () => {
    const { get, cwd, runDir, storage } = await setup();
    put(
      runDir,
      "workflow.yaml",
      [
        "name: w",
        "nodes:",
        "  - { id: design, type: agent, stage: design, input: {} }",
        "  - { id: plan, type: agent, stage: planning, dependsOn: [design], input: {} }",
        "  - { id: tidy, type: exec, input: {}, runtime: sh, script: 'true', dependsOn: [plan] }",
        "  - { id: review, type: agent, stage: code-review, dependsOn: [tidy], input: {} }",
        "",
      ].join("\n"),
    );
    for (const name of ["a.md", "design.md", "outline.md", "review.md", "tidy.md"]) {
      put(runDir, `artifacts/${name}`, "# x");
    }
    const delivered = (...paths: readonly string[]) => ({
      ...nodeRun([]),
      artifacts: paths.map((path) => ({ type: "file", name: path, path })),
    });
    await putState(
      storage,
      "r-named",
      stateWithRuns(cwd, {
        review: delivered("artifacts/review.md", "artifacts/design.md"),
        tidy: delivered("artifacts/tidy.md"),
        plan: delivered("artifacts/outline.md"),
        design: delivered("artifacts/design.md"),
      }),
    );

    const body = (await (await get("/runs/r-named/files")).json()) as {
      files: { path: string; stage: string | null }[];
    };

    expect(body.files.map((f) => [f.path, f.stage])).toEqual([
      ["artifacts/design.md", "design"],
      ["artifacts/outline.md", "planning"],
      ["artifacts/review.md", "code-review"],
      ["artifacts/a.md", null],
      ["artifacts/tidy.md", null],
    ]);
  });

  test("SC6b: a run with no state leaves the list standing, all drafts", async () => {
    const { get, runDir } = await setup();
    put(runDir, "artifacts/design.md", "# d");
    const body = (await (await get("/runs/r-named/files")).json()) as {
      files: { draft: boolean }[];
    };
    expect(body.files.map((f) => f.draft)).toEqual([true]);
  });

  test("SC10: the file list flags design.md while its running node waits on it, and stops once the node completes", async () => {
    const { get, runDir, storage } = await setup();
    put(runDir, "artifacts/design.md", "# d");
    put(runDir, "artifacts/notes.md", "# n");
    const design = (status: NodeRun["status"]): NodeRun => ({
      nodeRunId: "n1",
      nodeType: "agent",
      status,
      startedAt: null,
      completedAt: null,
      artifacts: [],
      awaitingApproval: "artifacts/design.md",
    });
    const flags = async () => {
      const body = (await (await get("/runs/r-named/files")).json()) as {
        files: { path: string; awaitingApproval: boolean }[];
      };
      return body.files.map((f) => [f.path, f.awaitingApproval]);
    };

    await putState(storage, "r-named", seedState(runDir, { design: design("running") }));
    expect(await flags()).toEqual([
      ["artifacts/design.md", true],
      ["artifacts/notes.md", false],
    ]);

    await putState(storage, "r-named", seedState(runDir, { design: design("completed") }));
    expect(await flags()).toEqual([
      ["artifacts/design.md", false],
      ["artifacts/notes.md", false],
    ]);
  });

  test("SC7: an unnamed run is starting, a named one without artifacts is empty, an unknown one is 404", async () => {
    const { get } = await setup();
    expect(((await (await get("/runs/r-starting/files")).json()) as { state: string }).state).toBe(
      "starting",
    );
    const empty = (await (await get("/runs/r-empty/files")).json()) as {
      state: string;
      files: unknown[];
    };
    expect(empty).toMatchObject({ state: "ready", files: [] });
    expect((await get("/runs/r-missing/files")).status).toBe(404);
  });

  test("SC9: each file type comes back in the form the page shows", async () => {
    const { get, runDir } = await setup();
    put(runDir, "artifacts/a.md", "# Hi\n");
    put(runDir, "artifacts/b.json", '{"a":1}');
    put(runDir, "artifacts/c.html", "<p>x</p>");
    put(runDir, "artifacts/d.png", new Uint8Array([137, 80]));
    put(runDir, "artifacts/e.bin", new Uint8Array([0]));
    const read = async (name: string) =>
      (await (await get(`/runs/r-named/file?path=artifacts/${name}`)).json()) as Record<
        string,
        string
      >;

    expect((await read("a.md")).html).toContain("<h1");
    expect((await read("b.json")).text).toBe('{"a":1}');
    const c = await read("c.html");
    const d = await read("d.png");
    const e = await read("e.bin");
    expect(c.raw).toBe("/runs/r-named/raw/artifacts/c.html");
    expect((await get(c.raw as string)).headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect((await get(d.raw as string)).headers.get("content-type")).toBe("image/png");
    expect([e.html, e.text, e.raw]).toEqual([undefined, undefined, undefined]);
  });

  test("SC709: the run page carries core's document styles in place of their slot, and a markdown diff still comes back placed in the repo", async () => {
    const { get, cwd, runDir } = await setup();
    put(cwd, "src/a.ts", "const a = 1;\nconst b = 2;\n");
    put(runDir, "artifacts/p.md", "`src/a.ts`\n\n```diff\n+const b = 2;\n```\n");

    const page = await (await get("/runs/r-named")).text();
    expect(page).toContain(".diff-line.hljs-addition");
    expect(page).toContain("--syn-keyword");
    expect(page).not.toContain("{{DOC_STYLES}}");
    const file = (await (await get("/runs/r-named/file?path=artifacts/p.md")).json()) as {
      html: string;
    };
    expect(file.html).toContain('data-from="2"');
  });

  test("a range of a repo file comes back as colored lines, an artifact's diffs are placed in the repo, and a path outside the repo is 404", async () => {
    const { get, cwd, runDir } = await setup();
    put(cwd, "src/a.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    put(runDir, "artifacts/p.md", "`src/a.ts`\n\n```diff\n+const b = 2;\n```\n");

    const source = await (await get("/runs/r-named/source?path=src/a.ts&from=2&to=9")).json();
    expect(source).toEqual({
      from: 2,
      to: 3,
      total: 3,
      lines: [
        '<span class="hljs-keyword">const</span> b = <span class="hljs-number">2</span>;',
        '<span class="hljs-keyword">const</span> c = <span class="hljs-number">3</span>;',
      ],
    });
    const page = (await (await get("/runs/r-named/file?path=artifacts/p.md")).json()) as {
      html: string;
    };
    expect(page.html).toContain('<span class="hunk" data-from="2" data-to="2">');
    for (const path of ["../outside.ts", "/etc/hosts", "src/missing.ts"]) {
      expect(
        (await get(`/runs/r-named/source?path=${encodeURIComponent(path)}&from=1&to=2`)).status,
      ).toBe(404);
    }
  });

  test("the source route refuses a secret file and a link to one, and still returns an ordinary file's lines", async () => {
    const { get, cwd } = await setup();
    put(cwd, "src/a.ts", "const a = 1;\n");
    put(cwd, ".env", "TOKEN=hunter2\n");
    symlinkSync(join(cwd, ".env"), join(cwd, "src/env.ts"));
    const source = (path: string) =>
      get(`/runs/r-named/source?path=${encodeURIComponent(path)}&from=1&to=2`);

    for (const path of [".env", "src/env.ts"]) {
      const reply = await source(path);
      expect(reply.status).toBe(404);
      expect(await reply.text()).not.toContain("hunter2");
    }
    expect(((await (await source("src/a.ts")).json()) as { lines: string[] }).lines).toHaveLength(
      1,
    );
  });

  test("opening a repo file or an artifact hands the editor its full path and line, and a path outside the run is refused", async () => {
    const { post, cwd, runDir, opened } = await setup();
    put(cwd, "src/a.ts", "x");
    put(runDir, "artifacts/plan.md", "# p");

    const statuses = [
      (await post("/runs/r-named/open", { path: "src/a.ts", line: 4 })).status,
      (await post("/runs/r-named/open", { path: "artifacts/plan.md" })).status,
      (await post("/runs/r-named/open", { path: "../outside.ts" })).status,
      (await post("/runs/r-named/open", { path: "src/missing.ts" })).status,
      (await post("/runs/r-named/open", { path: 5 })).status,
    ];
    expect(statuses).toEqual([200, 200, 404, 404, 400]);
    expect(opened).toEqual([
      { file: join(cwd, "src/a.ts"), line: 4 },
      { file: join(runDir, "artifacts/plan.md"), line: null },
    ]);
  });

  test("a path outside artifacts, or a missing file, is 404", async () => {
    const { get, runDir } = await setup();
    put(runDir, "state.json", "{}");
    expect((await get("/runs/r-named/file?path=state.json")).status).toBe(404);
    expect((await get("/runs/r-named/file?path=artifacts/../state.json")).status).toBe(404);
    expect((await get("/runs/r-named/file?path=artifacts/none.md")).status).toBe(404);
    expect((await get("/runs/r-named/raw/artifacts/none.html")).status).toBe(404);
  });
});

afterEach(stopDeliveries);

const draft = {
  file: "artifacts/design.md",
  kind: "comment",
  text: "Why one file?",
  anchor: { quote: "one file", before: "a", after: "b", lines: [14, 16], heading: "Approach" },
};

const eventsOf = async (storage: IStorage, runId: string, type: string) =>
  (await storage.runs.readEvents(runId)).filter((event) => event.type === type);

describe("comment routes", () => {
  test("SC316 (SC25): a posted batch is saved, logged with its places, typed into the session with no comments.json written, and bad bodies are refused", async () => {
    const { post, runDir, calls, storage } = await setup(EMPTY_BOX);
    const res = await post("/runs/r-named/comments", {
      comments: [draft, { file: "artifacts/a.md", kind: "global", text: "Ship it" }],
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { comments: { id: string }[] };
    expect(body.comments.map((c) => c.id)).toEqual(["c1", "c2"]);
    const added = await eventsOf(storage, "r-named", "artifact.comment.added");
    expect(added).toHaveLength(1);
    expect(added[0]?.payload).toEqual({
      comments: [
        { id: "c1", ...draft },
        { id: "c2", file: "artifacts/a.md", kind: "global", text: "Ship it" },
      ],
    });
    await until(async () => (await statusesOf(storage)).every((s) => s === "delivered"));
    expect(await statusesOf(storage)).toEqual(["delivered", "delivered"]);
    expect(calls.filter((c) => c.startsWith("text:"))).toHaveLength(1);
    expect(calls[0]).toContain("2 new comments");
    expect(existsSync(join(runDir, "comments.json"))).toBe(false);
    const bad = [
      await post("/runs/r-named/comments", { comments: [{ ...draft, kind: "shout" }] }),
      await post("/runs/r-missing/comments", { comments: [draft] }),
      await post("/runs/r-starting/comments", { comments: [draft] }),
      await post("/runs/r-named/comments", { comments: [{ ...draft, file: "../state.json" }] }),
    ];
    expect(bad.map((r) => r.status)).toEqual([400, 404, 409, 400]);
  });

  test("SC317: an approve on a file no running node waits on is refused with 409 and nothing is stored, and one on the waiting design.md is accepted", async () => {
    const { post, runDir, storage } = await setup();
    put(runDir, "artifacts/design.md", "# d");
    put(runDir, "artifacts/notes.md", "# n");
    const design: NodeRun = {
      nodeRunId: "n1",
      nodeType: "agent",
      status: "running",
      startedAt: null,
      completedAt: null,
      artifacts: [],
      awaitingApproval: "artifacts/design.md",
    };
    await putState(storage, "r-named", seedState(runDir, { design }));
    const approve = (file: string) =>
      post("/runs/r-named/comments", { comments: [{ file, kind: "approve", text: "Approved" }] });

    const refused = await approve("artifacts/notes.md");
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("artifacts/notes.md");
    expect(await statusesOf(storage)).toEqual([]);

    expect((await approve("artifacts/design.md")).status).toBe(201);
  });

  test("SC317 (SC530): a comment on design.md in a run whose interaction policy is off is refused with 409, and nothing is stored or logged", async () => {
    const { post, runDir, storage } = await setup();
    put(runDir, "artifacts/design.md", "# d");
    const state: State = {
      ...seedState(runDir, {}),
      policies: { values: { interaction: false }, sources: { interaction: "cli" } },
    };
    await putState(storage, "r-named", state);

    const refused = await post("/runs/r-named/comments", { comments: [draft] });

    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("interaction");
    expect(await statusesOf(storage)).toEqual([]);
    expect(await storage.runs.readEvents("r-named")).toEqual([]);
  });

  const offPolicies = { values: { interaction: false }, sources: { interaction: "cli" } } as const;

  test("SC317 (SC530): a run saved with interaction off refuses comments though it has no state", async () => {
    const { post, storage, cwd } = await setup();
    await seedRun(storage, { ...runRecord("r-off", cwd, "off"), policies: offPolicies });
    const runDir = join(cwd, ".yok", "off");
    put(runDir, "artifacts/design.md", "# d");

    const refused = await post("/runs/r-off/comments", { comments: [draft] });

    expect(refused.status).toBe(409);
    expect(await statusesOf(storage, "r-off")).toEqual([]);
  });

  test("SC320 (SC530): a reply on a run whose interaction policy is off is refused with 409, and the thread is left as it was", async () => {
    const { post, storage, cwd } = await setup();
    await seedRun(storage, { ...runRecord("r-off", cwd, "off"), policies: offPolicies });
    const runDir = join(cwd, ".yok", "off");
    put(runDir, "artifacts/design.md", "# d");
    await storage.comments.add("r-off", [
      { file: "artifacts/design.md", kind: "global", text: "Why one file?" },
    ]);
    const before = await storage.comments.list("r-off");

    const refused = await post("/runs/r-off/comments/c1/reply", { text: "one more thing" });

    expect(refused.status).toBe(409);
    expect(await storage.comments.list("r-off")).toEqual(before);
    expect(await storage.runs.readEvents("r-off")).toEqual([]);
  });

  const seedWaitingDesign = async () => {
    const ctx = await setup();
    put(ctx.runDir, "artifacts/design.md", "# d");
    const design: NodeRun = {
      nodeRunId: "n1",
      nodeType: "agent",
      status: "running",
      startedAt: null,
      completedAt: null,
      artifacts: [],
      awaitingApproval: "artifacts/design.md",
    };
    await putState(ctx.storage, "r-named", seedState(ctx.runDir, { design }));
    return ctx;
  };
  const approveDraft = { file: "artifacts/design.md", kind: "approve", text: "Approved" };

  test("SC318 (SC10): two approvals of the waiting design.md posted at once - one is accepted with 201, the other refused with 409, and only one approval is stored and logged", async () => {
    const { post, storage } = await seedWaitingDesign();

    const replies = await Promise.all([
      post("/runs/r-named/comments", { comments: [approveDraft] }),
      post("/runs/r-named/comments", { comments: [approveDraft] }),
    ]);

    expect(replies.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await statusesOf(storage)).toHaveLength(1);
    const added = await eventsOf(storage, "r-named", "artifact.comment.added");
    expect(added).toHaveLength(1);
    expect(added[0]?.payload).toMatchObject({ comments: [{ kind: "approve" }] });
  });

  test("SC317 (SC10): one batch holding two approvals of the same design.md is refused with 409 and nothing is stored", async () => {
    const { post, storage } = await seedWaitingDesign();

    const res = await post("/runs/r-named/comments", { comments: [approveDraft, approveDraft] });

    expect(res.status).toBe(409);
    expect(await statusesOf(storage)).toEqual([]);
    expect(await storage.runs.readEvents("r-named")).toEqual([]);
  });

  test("SC319 (SC31): a comment typed to the agent gets its reply, and a user follow-up sends the thread again and is logged", async () => {
    const { post, get, calls, storage } = await setup(EMPTY_BOX);
    await post("/runs/r-named/comments", { comments: [draft] });
    await until(async () => (await statusesOf(storage))[0] === "delivered");
    await storage.comments.reply("r-named", "c1", { status: "answered", text: "Because." });

    const res = await post("/runs/r-named/comments/c1/reply", { text: "Can we bundle it later?" });

    expect(res.status).toBe(200);
    const typedFollowUp = () =>
      calls.some((c) => c.includes("c1 · reply on its thread: Can we bundle it later?"));
    await until(async () => typedFollowUp() && (await statusesOf(storage))[0] === "delivered");
    expect(typedFollowUp()).toBe(true);
    expect(await statusesOf(storage)).toEqual(["delivered"]);
    const listed = (await (await get("/runs/r-named/comments")).json()) as {
      comments: { status: string; thread: { by: string; text: string }[] }[];
    };
    expect(listed.comments[0]?.thread.at(-1)).toMatchObject({
      by: "user",
      text: "Can we bundle it later?",
    });
    expect(
      (await eventsOf(storage, "r-named", "artifact.comment.replied"))[0]?.payload,
    ).toMatchObject({
      id: "c1",
      by: "user",
      status: "sent",
      text: "Can we bundle it later?",
    });
    expect((await post("/runs/r-named/comments/c1/reply", { text: "" })).status).toBe(400);
    expect((await post("/runs/r-named/comments/c9/reply", { text: "x" })).status).toBe(404);
  });
});

type SseEvent = { event: string; data: unknown };

const sseReader = (res: Response) => {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const seen: SseEvent[] = [];
  let buffer = "";
  const parse = (chunk: string): void => {
    const event = /^event: (.*)$/m.exec(chunk)?.[1];
    const data = /^data: (.*)$/m.exec(chunk)?.[1];
    if (event !== undefined && data !== undefined) seen.push({ event, data: JSON.parse(data) });
  };
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      chunks.forEach(parse);
    }
  })().catch(() => undefined);
  const waitFor = async (match: (e: SseEvent) => boolean, ms = 3000): Promise<SseEvent> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = seen.find(match);
      if (hit !== undefined) return hit;
      await Bun.sleep(25);
    }
    throw new Error(`no matching event in ${ms}ms; saw ${JSON.stringify(seen)}`);
  };
  return { seen, waitFor, close: () => reader.cancel().then(() => pump) };
};

describe("run stream", () => {
  test("SC321 (SC30): the stream sends the run's state at once and again when something changes", async () => {
    const { app, storage, cwd } = await setup();
    await seedRun(storage, runRecord("r-late", cwd, null));
    const res = await app.request("/runs/r-late/stream", { headers: { host: "localhost:4000" } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const sse = sseReader(res);
    try {
      await sse.waitFor(
        (e) => e.event === "files" && (e.data as { state: string }).state === "starting",
      );
      await sse.waitFor(
        (e) => e.event === "comments" && (e.data as { comments: unknown[] }).comments.length === 0,
      );

      const lateDir = join(cwd, ".yok", "late");
      const late = { ...stateJson("r-late", cwd, "running"), runName: "late", runDir: lateDir };
      expect((await storage.runs.initRun("r-late", "late", late)).ok).toBe(true);
      await sse.waitFor(
        (e) =>
          e.event === "files" &&
          (e.data as { state: string; files: unknown[] }).state === "ready" &&
          (e.data as { files: unknown[] }).files.length === 0,
      );

      put(lateDir, "artifacts/design.md", "# d\n");
      await sse.waitFor(
        (e) =>
          e.event === "files" &&
          (e.data as { files: { path: string }[] }).files.some(
            (f) => f.path === "artifacts/design.md",
          ),
      );

      sse.seen.length = 0;
      put(lateDir, "artifacts/design.md", "# d\nmore\n");
      await sse.waitFor(
        (e) => e.event === "file" && (e.data as { path: string }).path === "artifacts/design.md",
      );

      await storage.comments.add("r-late", [
        { file: "artifacts/design.md", kind: "global", text: "hi" },
      ]);
      await storage.comments.reply("r-late", "c1", { status: "answered", text: "Because." });
      await sse.waitFor(
        (e) => e.event === "comments" && JSON.stringify(e.data).includes("Because."),
      );
    } finally {
      await sse.close();
    }
  }, 20000);
});

describe("agent status on the stream", () => {
  const agentOf = async (
    screen: string | undefined,
    alive: boolean,
    run: "named" | "starting",
    after?: (s: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  ): Promise<unknown> => {
    const ctx = await setup(screen, alive, `r-named-${crypto.randomUUID()}`);
    const runId = run === "named" ? ctx.namedId : "r-starting";
    const res = await ctx.get(`/runs/${runId}/stream`);
    const sse = sseReader(res);
    try {
      await after?.(ctx);
      const want =
        after === undefined
          ? () => true
          : (e: SseEvent) => JSON.stringify(e.data).includes("waiting");
      return (await sse.waitFor((e) => e.event === "agent" && want(e))).data;
    } finally {
      await sse.close();
    }
  };

  test.each([
    ["an unnamed run is starting", undefined, true, "starting", "starting"],
    ["a run with no terminal is stopped", undefined, true, "named", "stopped"],
    ["a run whose session is dead is stopped", EMPTY_BOX, false, "named", "stopped"],
    ["a live session is running", EMPTY_BOX, true, "named", "running"],
  ] as const)("%s", async (_label, screen, alive, run, state) => {
    expect(await agentOf(screen, alive, run)).toEqual({ state, reason: null });
  });

  test("a live session whose last delivery waits shows the reason", async () => {
    const busyBox = `${RULE}\n❯ half typed\n${RULE}\n  Model: Opus`;
    const data = await agentOf(busyBox, true, "named", async ({ post, namedId }) => {
      await post(`/runs/${namedId}/comments`, {
        comments: [{ file: "artifacts/a.md", kind: "global", text: "hi" }],
      });
    });
    expect(data).toEqual({
      state: "waiting",
      reason: "agent has a menu open or text in its input box",
    });
  });
});

type Anchor = typeof import("./anchor.ts");

// anchor.ts is bundled as text by viewer.ts, so the tests load the code the browser gets.
const loadAnchor = async (): Promise<Anchor> => {
  const { get } = await setup();
  const source = await (await get("/assets/anchor.js")).text();
  return (await import(`data:text/javascript;base64,${btoa(source)}`)) as Anchor;
};

describe("anchor script", () => {
  const text = "retry 3 times here ... retry 3 times there";
  const quote = "retry 3 times";
  const second = text.lastIndexOf(quote);

  test("SC28: a quote is found again by the words around it", async () => {
    const { findQuote } = await loadAnchor();
    expect(findQuote(text, { quote, before: "... ", after: " there" })).toEqual([
      second,
      second + quote.length,
    ]);
    expect(findQuote(text, { quote, before: "", after: " nowhere" })).toEqual([0, quote.length]);
    expect(findQuote("something else", { quote, before: "", after: "" })).toBeNull();
    // Only the words before tell these apart: the second follows "... ".
    const twins = "a retry 3 times x ... retry 3 times x";
    expect(findQuote(twins, { quote, before: "... ", after: " x" })?.[0]).toBe(
      twins.lastIndexOf(quote),
    );
  });

  test("SC29: the words around a quote stop at 32 characters and at the ends of the text", async () => {
    const { quoteContext } = await loadAnchor();
    const long = "x".repeat(200);
    const { before, after } = quoteContext(long, 5, "xx");
    expect(before).toHaveLength(5);
    expect(after).toHaveLength(32);
    const counted = Array.from({ length: 200 }, (_, i) => String.fromCharCode(48 + (i % 40))).join(
      "",
    );
    expect(quoteContext(counted, 100, "xx").before).toBe(counted.slice(68, 100));
  });
});

describe("shared page script", () => {
  test("/assets/shared.js serves the pages' status words and duration format as JavaScript, and refuses another site's host", async () => {
    const { get } = await setup();
    const res = await get("/assets/shared.js");
    expect(res.headers.get("content-type")).toContain("text/javascript");
    const shared = (await import(
      `data:text/javascript;base64,${Buffer.from(await res.text()).toString("base64")}`
    )) as typeof import("./page-shared.ts");
    expect([shared.RUN_STATUS_WORDS.blocked, shared.RUN_STATUS_WORDS.gone]).toEqual([
      "needs you",
      "agent gone",
    ]);
    expect([42_000, 125_000, 3_780_000].map(shared.formatDuration)).toEqual([
      "42s",
      "2m 05s",
      "1h 3m",
    ]);
  });

  test("SC8007: the served shared script formats an audit metric and imports no @yok/sdk package", async () => {
    const { get } = await setup();
    const text = await (await get("/assets/shared.js")).text();
    expect(text).not.toContain("@yok/sdk");
    const shared = (await import(
      `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`
    )) as typeof import("./page-shared.ts");
    expect(shared.formatMetric("percent", 80)).toBe("80%");
  });
});

describe("audit page rules", () => {
  test("SC8001: formatMetric shows percent 81.46 as 81.5%, 222 seconds as 3m 42s and count 1268 as 1,268", () => {
    expect([
      formatMetric("percent", 81.46),
      formatMetric("seconds", 222),
      formatMetric("count", 1268),
    ]).toEqual(["81.5%", "3m 42s", "1,268"]);
  });

  test("SC8002: formatChange shows +2 percent as +2 pts, -35 seconds as −35s and -3 count as −3", () => {
    expect([
      formatChange("percent", 2),
      formatChange("seconds", -35),
      formatChange("count", -3),
    ]).toEqual(["+2 pts", "−35s", "−3"]);
  });

  test("SC8003: metricChange calls a rise better when higher is better, worse when lower is, same at no change, and null with no value before", () => {
    const series = [70, 72, null, 72];
    expect(metricChange("higher", series, 1)).toEqual({ delta: 2, verdict: "better" });
    expect(metricChange("lower", series, 1)).toEqual({ delta: 2, verdict: "worse" });
    expect(metricChange("higher", [72, 72], 1)).toEqual({ delta: 0, verdict: "same" });
    expect([0, 3, -1].map((index) => metricChange("higher", series, index))).toEqual([
      null,
      null,
      null,
    ]);
  });

  test("SC8004: meetsLimit holds coverage at or above 80 and test time at or below 240, and has no answer for a metric with no limit", () => {
    const { coverage, testTime, testCount } = TEST_AUDIT_METRICS;
    expect([meetsLimit(coverage, 80), meetsLimit(coverage, 79.9)]).toEqual([true, false]);
    expect([meetsLimit(testTime, 240), meetsLimit(testTime, 241)]).toEqual([true, false]);
    expect(meetsLimit(testCount, 10)).toBeNull();
  });

  test("SC8005: metricSeries reads one repo's metric at one scope in each run, null where a run has none, never another repo's value", () => {
    const measured = (
      repo: string,
      metric: AuditMetric["metric"],
      scope: string,
      value: number,
    ) => ({
      repo,
      metric,
      scope,
      status: "measured" as const,
      reason: null,
      value,
      how: {},
    });
    const points: readonly AuditMetricsPoint[] = [
      {
        auditRunId: "a1",
        periodEnd: "2026-11-01T00:00:00.000Z",
        metrics: [measured("yok", "coverage", "", 70), measured("web", "coverage", "", 90)],
      },
      { auditRunId: "a2", periodEnd: "2026-11-08T00:00:00.000Z", metrics: [] },
      {
        auditRunId: "a3",
        periodEnd: "2026-11-15T00:00:00.000Z",
        metrics: [measured("yok", "coverage", "", 75), measured("yok", "testCount", "unit", 10)],
      },
    ];
    expect(metricSeries(points, "yok", "coverage", "")).toEqual([70, null, 75]);
    expect(metricSeries(points, "yok", "testCount", "unit")).toEqual([null, null, 10]);
  });

  test.each([
    ["https://github.com/acme/web/pull/112", "PR #112"],
    ["112", "PR #112"],
    ["#112", "PR #112"],
    ["draft", "draft"],
    ["https://example.com/v2", "https://example.com/v2"],
  ])("SC8010: prLabel reads %p as %p", (pr, label) => {
    expect(prLabel(pr)).toBe(label);
  });
});

describe("result buttons", () => {
  test.each([
    [{ kind: "open" }, true, ["accept", "reject"]],
    [{ kind: "needs-work" }, true, ["copy-prompt"]],
    [{ kind: "needs-work" }, false, []],
    [{ kind: "auto-fixed" }, false, []],
    [{ kind: "applying", runId: "r-9" }, false, []],
    [{ kind: "stopped", runId: "r-9" }, false, []],
    [{ kind: "waiting", action: "apply" }, false, ["undo"]],
    [{ kind: "run-failed", runId: "r-9" }, false, ["undo"]],
    [{ kind: "applied", commit: "abc1234", pr: null }, false, ["undo"]],
    [{ kind: "failed", reason: "tests failed" }, false, ["undo"]],
    [{ kind: "rejected", feedback: null }, false, ["undo"]],
  ] as const)("a result in state %o (prompt %p) offers %p", (state, hasPrompt, actions) => {
    expect(resultActions(state, hasPrompt)).toEqual(actions);
  });

  test("a reject with blank feedback sends no feedback; one with text sends it trimmed", () => {
    expect([rejectBody("  \n"), rejectBody("  keeps the fixture ")]).toEqual([
      { type: "rejected" },
      { type: "rejected", feedback: "keeps the fixture" },
    ]);
  });
});

describe("audit page fixes", () => {
  const fixOf = (pr?: string) => ({ summary: "delete it", ...(pr === undefined ? {} : { pr }) });

  test("SC8021: the auto-fixed column names the PR its auto-fixed results share, and none when no PR was made", () => {
    const results = [
      { state: "needs_approval", fix: fixOf("https://github.com/o/web/pull/9") },
      { state: "auto_fixed", fix: fixOf() },
      { state: "auto_fixed", fix: fixOf("https://github.com/o/web/pull/112") },
    ] as const;

    expect(autoFixedPr(results)).toBe("https://github.com/o/web/pull/112");
    expect(autoFixedPr(results.slice(0, 2))).toBeNull();
  });

  test("SC8022: a stopped apply run says how to resume it or remove it, by the run's id", () => {
    expect(stoppedRunHelp("r-1f36b94f")).toBe(
      "resume it with yok resume --run-id r-1f36b94f, or remove it with yok rm r-1f36b94f",
    );
  });

  test("SC8023: of two loads, an older one that ends last is dropped and leaves the state alone", async () => {
    const load = newestWins<{ runId: string }>();
    const state = { runId: "a" };
    let finishA = (): void => {};
    const slowA = load(state, async (draft) => {
      await new Promise<void>((resolve) => {
        finishA = resolve;
      });
      draft.runId = "A";
    });
    const fastB = load(state, async (draft) => {
      draft.runId = "B";
    });

    expect(await fastB).toEqual({ runId: "B" });
    finishA();
    expect(await slowA).toBeNull();
    expect(state).toEqual({ runId: "a" });
  });
});

describe("trendRange", () => {
  // oldest first by period end, as the page orders the list route's runs; b is a longer period overlapping a
  const runs = [
    { id: "a", periodStart: "2026-11-01T00:00:00.000Z", periodEnd: "2026-11-08T00:00:00.000Z" },
    { id: "b", periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-15T00:00:00.000Z" },
    { id: "c", periodStart: "2026-11-15T00:00:00.000Z", periodEnd: "2026-11-22T00:00:00.000Z" },
  ];

  test("a range opening at a short run reaches back to a longer run's earlier start, so the route returns every run in the range", () => {
    expect(trendRange(runs, "a", "c")).toEqual({
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-11-22T00:00:00.000Z",
      runIds: ["a", "b", "c"],
    });
  });

  test("a range from b to c keeps a out of its run ids, though a lies inside b's wider window", () => {
    expect(trendRange(runs, "b", "c").runIds).toEqual(["b", "c"]);
  });
});

describe("resultPageState", () => {
  const result = (
    fix: Partial<AuditFix> | null = null,
    state: AuditResult["state"] = "needs_approval",
  ) => ({
    state,
    fix: fix === null ? null : { summary: "Remove the copy", ...fix },
  });
  const click = (
    type: "accepted" | "rejected" | "undone",
    ts = "2026-11-20T10:00:00.000Z",
    payload: { feedback: string } | Record<string, never> = {},
  ): AuditResultEvent => ({
    id: crypto.randomUUID(),
    ts,
    resultId: "a1:yok:duplicates:x",
    type,
    who: "local",
    startedRunId: null,
    payload,
  });
  const run = (status: AuditApplyRun["status"]): AuditApplyRun => ({ id: "r-9", status });

  test("SC8012: with no decision, a needs-approval result is open, an auto-fixed one auto-fixed and a needs-work one needs-work", () => {
    expect(
      (["needs_approval", "auto_fixed", "needs_work"] as const).map(
        (state) => resultPageState(result(null, state), null, null).kind,
      ),
    ).toEqual(["open", "auto-fixed", "needs-work"]);
  });

  test("SC8013: an accepted result with no commit, no error and no apply run yet is waiting", () => {
    expect(resultPageState(result({}), click("accepted"), null)).toEqual({
      kind: "waiting",
      action: "apply",
    });
  });

  test("SC8014: a starting, running or blocked apply run is applying after an accept or an undo, never open", () => {
    const states = (["starting", "running", "blocked"] as const).flatMap((status) =>
      (["accepted", "undone"] as const).map((type) =>
        resultPageState(result({}), click(type), run(status)),
      ),
    );
    expect(states).toEqual(Array(6).fill({ kind: "applying", runId: "r-9" }));
  });

  test("SC8015: an accepted result with a commit is applied with its PR, or with pr null when it has none", () => {
    const pr = "https://github.com/acme/yok/pull/7";
    expect(
      resultPageState(result({ commit: "abc1234", pr }), click("accepted"), run("completed")),
    ).toEqual({
      kind: "applied",
      commit: "abc1234",
      pr,
    });
    expect(
      resultPageState(result({ commit: "abc1234" }), click("accepted"), run("completed")),
    ).toEqual({
      kind: "applied",
      commit: "abc1234",
      pr: null,
    });
  });

  test("SC8016: an error written after the newest click fails the result; one written before it leaves the result waiting", () => {
    const decision = click("accepted", "2026-11-20T10:00:00.000Z");
    const failed = (at: string) => result({ error: "tests failed", at });
    expect(resultPageState(failed("2026-11-20T10:05:00.000Z"), decision, null)).toEqual({
      kind: "failed",
      reason: "tests failed",
    });
    expect(resultPageState(failed("2026-11-20T09:00:00.000Z"), decision, null)).toEqual({
      kind: "waiting",
      action: "apply",
    });
  });

  test("SC8017: a failed or cancelled apply run with no error written is run-failed, but waiting when a stale error is there", () => {
    expect(
      (["failed", "cancelled"] as const).map((status) =>
        resultPageState(result({}), click("accepted"), run(status)),
      ),
    ).toEqual(Array(2).fill({ kind: "run-failed", runId: "r-9" }));
    const stale = result({ error: "tests failed", at: "2026-11-20T09:00:00.000Z" });
    expect(resultPageState(stale, click("accepted"), run("failed"))).toEqual({
      kind: "waiting",
      action: "apply",
    });
  });

  test("an apply run whose agent is gone reads stopped after an accept or an undo, not run-failed, so its run can be resumed or cancelled", () => {
    expect(
      (["accepted", "undone"] as const).map((type) =>
        resultPageState(result({}), click(type), run("gone")),
      ),
    ).toEqual(Array(2).fill({ kind: "stopped", runId: "r-9" }));
  });

  test("SC8018: a rejected result carries the person's feedback, or null feedback when they gave none", () => {
    const withFeedback = click("rejected", undefined, { feedback: "keeps the fixture" });
    expect(resultPageState(result({}), withFeedback, null)).toEqual({
      kind: "rejected",
      feedback: "keeps the fixture",
    });
    expect(resultPageState(result({}), click("rejected"), null)).toEqual({
      kind: "rejected",
      feedback: null,
    });
  });

  test("SC8019: an undo waits for the revert of an applied commit, and reopens a result that was never applied", () => {
    expect(resultPageState(result({ commit: "abc1234" }), click("undone"), null)).toEqual({
      kind: "waiting",
      action: "revert",
    });
    expect(resultPageState(result({}), click("undone"), null)).toEqual({ kind: "open" });
  });
});

describe("editorCommand", () => {
  test.each([
    ["zed", 12, ["zed", "/r/a.ts:12"]],
    ["code --wait", 12, ["code", "-g", "/r/a.ts:12"]],
    ["/usr/local/bin/cursor", null, ["/usr/local/bin/cursor", "/r/a.ts"]],
    ["subl", 3, ["subl", "/r/a.ts:3"]],
    ["idea", 3, ["idea", "--line", "3", "/r/a.ts"]],
    ["mystery -x", 3, ["mystery", "-x", "/r/a.ts"]],
    ["nvim", 3, null],
  ] as const)(
    "%p at line %p opens the file in the editor's own syntax, and a terminal editor gets no command",
    (editor, line, command) => {
      expect(editorCommand({ editor, file: "/r/a.ts", line })).toEqual(command);
    },
  );
});

const WORKFLOW_YAML = [
  "name: w",
  "nodes:",
  "  - { id: a, type: exec, input: {}, runtime: sh, script: 'true' }",
  "  - { id: b, type: exec, input: {}, runtime: sh, script: 'true' }",
  "",
].join("\n");

const stateJson = (
  runId: string,
  cwd: string,
  status: State["status"],
  extra: Readonly<Record<string, unknown>> = {},
): State =>
  StateSchema.parse({
    schemaVersion: 1,
    lastEventSeq: 1,
    runId,
    runName: "demo",
    runDir: join(cwd, ".yok", "demo"),
    version: "0.0.0",
    workflow: { name: "w", path: "workflow.yaml" },
    input: {},
    scope: null,
    startedAt: "2026-01-03T00:00:00.000Z",
    completedAt: null,
    status,
    workspace: {
      type: "mono",
      path: cwd,
      repositories: { demo: { path: cwd, git: { branch: "m", baseBranch: "m", startSha: "a" } } },
    },
    nodeRuns: {},
    activeSessions: [],
    tiers: null,
    ...extra,
  });

const listRoutes = (storage: IStorage, host: ITerminalHost = fakeHost("").host) => {
  return viewerRoutes({
    log: noopLogger,
    providerFor: () => claudeOver(host),
    host,
    now: () => new Date(),
    storage,
    stopping: new AbortController().signal,
    openInEditor: () => ({ ok: true, value: null }),
  });
};

type ListedRun = { id: string; folder: string; status: string };

describe("runs list", () => {
  test("SC105: GET /runs lists every run newest first, each with its own folder, and a run with a folder carries its state's status", async () => {
    const acme = join(tempDir("list-a"), "acme");
    const beta = join(tempDir("list-b"), "beta");
    const storage = memoryStorage();
    const at = (day: number) => `2026-01-0${day}T00:00:00.000Z`;
    await seedRun(storage, { ...runRecord("r-old", acme, "gone"), createdAt: at(1) });
    await seedRun(storage, { ...runRecord("r-new", beta, null), createdAt: at(3) });
    const mid = { ...runRecord("r-mid", acme, "demo"), createdAt: at(2) };
    await seedRun(storage, mid, stateJson("r-mid", acme, "completed"));
    put(acme, ".yok/demo/workflow.yaml", WORKFLOW_YAML);

    const res = await listRoutes(storage).request("/runs", {
      headers: { host: "localhost:4000" },
    });
    const { runs } = (await res.json()) as { runs: ListedRun[] };

    expect(runs).toMatchObject([
      { id: "r-new", folder: "beta", status: "starting" },
      { id: "r-mid", folder: "acme", status: "completed", steps: { total: 2 } },
      { id: "r-old", folder: "acme", status: "missing" },
    ]);
  });

  test("GET /runs keeps a finished run's files and every run's workflow once read, and re-reads a live run's state", async () => {
    const done = join(tempDir("list-done"), "acme");
    const live = join(tempDir("list-live"), "beta");
    const storage = memoryStorage();
    for (const [cwd, id, status, createdAt] of [
      [done, "r-done", "completed", "2026-01-01T00:00:00.000Z"],
      [live, "r-live", "running", "2026-01-02T00:00:00.000Z"],
    ] as const) {
      await seedRun(
        storage,
        { ...runRecord(id, cwd, "demo"), createdAt },
        stateJson(id, cwd, status),
      );
      put(cwd, ".yok/demo/workflow.yaml", WORKFLOW_YAML);
    }
    const app = listRoutes(storage);
    const list = async () =>
      (
        (await (await app.request("/runs", { headers: { host: "localhost:4000" } })).json()) as {
          runs: ListedRun[];
        }
      ).runs;
    expect(await list()).toMatchObject([
      { id: "r-live", status: "gone", steps: { total: 2 } },
      { id: "r-done", status: "completed", steps: { total: 2 } },
    ]);

    await putState(storage, "r-done", stateJson("r-done", done, "running"));
    await putState(storage, "r-live", stateJson("r-live", live, "failed"));
    rmSync(join(live, ".yok/demo/workflow.yaml"));

    expect(await list()).toMatchObject([
      { id: "r-live", status: "failed", steps: { total: 2 } },
      { id: "r-done", status: "completed", steps: { total: 2 } },
    ]);
  });
});

const QUESTION_BLOCKER = {
  reason: "question",
  node: "planning",
  since: "2026-01-03T00:05:00.000Z",
  details: { questions: [{ question: "Which store?", options: ["sqlite", "postgres"] }] },
};

// Live pane for t-alive, dead pane for every other terminal; records each terminal asked about.
const twoPaneHost = () => {
  const asked: string[] = [];
  const live = fakeHost("", true).host.find("t-alive");
  const dead = fakeHost("", false).host.find("t-dead");
  const host: ITerminalHost = {
    ...fakeHost("").host,
    find: (name) => {
      asked.push(name);
      return name === "t-alive" ? live : dead;
    },
  };
  return { host, asked };
};

describe("runs list liveness", () => {
  test("SC115: GET /runs reports a blocked run with a live terminal as blocked with its blocker and a running run with a dead terminal as gone, asking the host about those two terminals only", async () => {
    const storage = memoryStorage();
    const runs = [
      { id: "r-blocked", terminal: "t-alive", status: "blocked", blocker: QUESTION_BLOCKER },
      { id: "r-gone", terminal: "t-dead", status: "running" },
      { id: "r-done", terminal: "t-done", status: "completed" },
    ] as const;
    for (const [i, run] of runs.entries()) {
      const cwd = tempDir(`list-${run.id}`);
      const createdAt = `2026-01-0${3 - i}T00:00:00.000Z`;
      const state = stateJson(
        run.id,
        cwd,
        run.status,
        "blocker" in run ? { blocker: run.blocker } : {},
      );
      const record = { ...runRecord(run.id, cwd, "demo"), terminal: run.terminal, createdAt };
      await seedRun(storage, record, state);
    }
    const { host, asked } = twoPaneHost();

    const res = await listRoutes(storage, host).request("/runs", {
      headers: { host: "localhost:4000" },
    });
    const body = (await res.json()) as { runs: ListedRun[] };

    expect(body.runs).toMatchObject([
      { id: "r-blocked", status: "blocked", blocker: QUESTION_BLOCKER },
      { id: "r-gone", status: "gone", blocker: null },
      { id: "r-done", status: "completed" },
    ]);
    expect([...asked].sort()).toEqual(["t-alive", "t-dead"]);
  });
});

describe("runs list stream", () => {
  test("SC107: /stream sends the runs at once, with an unnamed run starting, and again once the run is named and has its state", async () => {
    const cwd = tempDir("list-cwd");
    const storage = memoryStorage();
    await seedRun(storage, { ...runRecord("r-live", cwd, null), terminal: "s1" });
    const res = await listRoutes(storage).request("/stream", {
      headers: { host: "localhost:4000" },
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const sse = sseReader(res);
    const statusIs = (status: string) => (e: SseEvent) =>
      e.event === "runs" && (e.data as { runs: ListedRun[] }).runs[0]?.status === status;
    try {
      await sse.waitFor(statusIs("starting"), 500);

      const named = await storage.runs.initRun(
        "r-live",
        "demo",
        stateJson("r-live", cwd, "running"),
      );
      expect(named.ok).toBe(true);
      put(cwd, ".yok/demo/workflow.yaml", WORKFLOW_YAML);
      await sse.waitFor(statusIs("running"));
    } finally {
      await sse.close();
    }
  }, 10000);
});

const THREE_STEPS_YAML = [
  "name: w",
  "nodes:",
  "  - { id: design, type: exec, input: {}, runtime: sh, script: 'true' }",
  "  - { id: build, type: exec, input: {}, runtime: sh, script: 'true', dependsOn: [design] }",
  "  - { id: ship, type: exec, input: {}, runtime: sh, script: 'true', dependsOn: [build] }",
  "",
].join("\n");

const stateWithRuns = (cwd: string, nodeRuns: Record<string, unknown>): State =>
  stateJson("r-named", cwd, "running", { nodeRuns });

type StepsBody = { steps: { id: string; status: string }[] };
const stepsOf = (e: SseEvent): StepsBody["steps"] | null =>
  e.event === "steps" ? (e.data as StepsBody).steps : null;

describe("steps on the run stream", () => {
  test("SC123: a named run streams its folder's steps, a named run with no workflow.yaml streams none, and an unnamed run streams no steps", async () => {
    const { get, cwd, runDir, storage } = await setup();
    put(runDir, "workflow.yaml", THREE_STEPS_YAML);
    await putState(storage, "r-named", stateWithRuns(cwd, { design: nodeRun([]) }));

    const named = sseReader(await get("/runs/r-named/stream"));
    try {
      const first = stepsOf(await named.waitFor((e) => stepsOf(e) !== null)) ?? [];
      expect(first.map((step) => [step.id, step.status])).toEqual([
        ["design", "completed"],
        ["build", "pending"],
        ["ship", "pending"],
      ]);
    } finally {
      await named.close();
    }

    const bare = sseReader(await get("/runs/r-empty/stream"));
    try {
      await bare.waitFor((e) => stepsOf(e)?.length === 0);
    } finally {
      await bare.close();
    }

    const starting = sseReader(await get("/runs/r-starting/stream"));
    try {
      await starting.waitFor((e) => e.event === "comments");
      expect(starting.seen.filter((e) => e.event === "steps")).toEqual([]);
    } finally {
      await starting.close();
    }
  }, 10000);
});

describe("steps on the run stream, live", () => {
  test("SC124: the stream sends the steps at once with design running, and again once state has design completed", async () => {
    const { get, cwd, runDir, storage } = await setup();
    put(runDir, "workflow.yaml", THREE_STEPS_YAML);
    const designIs = (status: string) => (e: SseEvent) => stepsOf(e)?.[0]?.status === status;
    await putState(
      storage,
      "r-named",
      stateWithRuns(cwd, { design: { ...nodeRun([]), status: "running" } }),
    );

    const sse = sseReader(await get("/runs/r-named/stream"));
    try {
      await sse.waitFor(designIs("running"), 1000);

      await putState(storage, "r-named", stateWithRuns(cwd, { design: nodeRun([]) }));
      await sse.waitFor(designIs("completed"));
    } finally {
      await sse.close();
    }
  }, 10000);
});

describe("summary on the run stream", () => {
  test("the run stream sends the run's summary at once, and again when the run blocks with its steps unchanged", async () => {
    const { get, cwd, runDir, storage } = await setup(EMPTY_BOX, true);
    put(runDir, "workflow.yaml", THREE_STEPS_YAML);
    const nodeRuns = { design: { ...nodeRun([]), status: "running" } };
    await putState(storage, "r-named", stateWithRuns(cwd, nodeRuns));
    const statusIs = (status: string) => (e: SseEvent) =>
      e.event === "summary" && (e.data as ListedRun).status === status;

    const sse = sseReader(await get("/runs/r-named/stream"));
    try {
      await sse.waitFor(statusIs("running"), 1000);

      const blocked = { ...stateWithRuns(cwd, nodeRuns), status: "blocked" };
      await putState(storage, "r-named", { ...blocked, blocker: QUESTION_BLOCKER });
      const summary = await sse.waitFor(statusIs("blocked"));
      expect(summary.data).toMatchObject({ id: "r-named", blocker: QUESTION_BLOCKER });
      expect(sse.seen.filter((e) => e.event === "steps")).toHaveLength(1);
    } finally {
      await sse.close();
    }
  }, 10000);

  test("SC126: the run stream's summary names the yok user who started the run, not just their id", async () => {
    const cwd = tempDir("viewer-cwd");
    const storage = memoryStorage();
    const userId = await seedUser(storage, {
      name: "Ritesh",
      github: { id: 1, login: "ritesh-gh" },
    });
    await seedRun(storage, { ...runRecord("r-owned", cwd, "demo"), source: "slack", user: userId });
    const { host } = fakeHost("");
    const app = viewerRoutes({
      log: noopLogger,
      providerFor: () => claudeOver(host),
      host,
      now: () => new Date(),
      storage,
      stopping: new AbortController().signal,
      openInEditor: () => ({ ok: true, value: null }),
    });

    const sse = sseReader(
      await app.request("/runs/r-owned/stream", { headers: { host: "localhost:4000" } }),
    );
    try {
      const summary = await sse.waitFor((e) => e.event === "summary", 1000);
      expect(summary.data).toMatchObject({ startedBy: { user: userId, name: "Ritesh" } });
    } finally {
      await sse.close();
    }
  }, 10000);
});
