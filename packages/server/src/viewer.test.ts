import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addComments, readComments, replyToComment } from "@yok/core";
import type { ITerminalHost, NodeRun, State, WorkflowRun } from "@yok/sdk";
import { noopLogger } from "@yok/sdk";
import { createRegistry, type Registry } from "@yok/sdk/internal";
import { stopDeliveries } from "./delivery.ts";
import { claudeOver, EMPTY_BOX, fakeHost, RULE, seedState } from "./fake-host.ts";
import {
  editorCommand,
  listArtifacts,
  resolveArtifactPath,
  viewerRoutes,
} from "./viewer.ts";

const tempDir = (prefix: string): string =>
  realpathSync(mkdtempSync(join(tmpdir(), `yok-${prefix}-`)));

const put = (root: string, rel: string, content: string | Uint8Array): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
};

const runRecord = (id: string, cwd: string, name: string | null): WorkflowRun => ({
  id,
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
  const registry = createRegistry(join(tempDir("viewer-reg"), "registry.json"), noopLogger);
  const named = runRecord(namedId, cwd, "demo");
  await registry.addRun(screen === undefined ? named : { ...named, terminal: "s1" });
  await registry.addRun(runRecord("r-starting", cwd, null));
  await registry.addRun(runRecord("r-empty", cwd, "bare"));
  const { host, calls } = fakeHost(screen ?? "", alive);
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  const opened: { file: string; line: number | null }[] = [];
  const app = viewerRoutes({
    registry,
    log: noopLogger,
    providerFor: () => claudeOver(host),
    host,
    now,
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
    registry,
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

const statusesOf = async (runDir: string): Promise<readonly string[]> => {
  const read = await readComments(runDir);
  return read.ok ? read.value.comments.map((c) => c.status) : [];
};

describe("viewer routes", () => {
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

  test("SC6b: a state.json that does not parse leaves the list standing, all drafts", async () => {
    const { get, runDir } = await setup();
    put(runDir, "artifacts/design.md", "# d");
    put(runDir, "state.json", "{not json");
    const body = (await (await get("/runs/r-named/files")).json()) as {
      files: { draft: boolean }[];
    };
    expect(body.files.map((f) => f.draft)).toEqual([true]);
  });

  test("SC10: the file list flags design.md while its running node waits on it, and stops once the node completes", async () => {
    const { get, runDir } = await setup();
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

    put(runDir, "state.json", JSON.stringify(seedState(runDir, { design: design("running") })));
    expect(await flags()).toEqual([
      ["artifacts/design.md", true],
      ["artifacts/notes.md", false],
    ]);

    put(runDir, "state.json", JSON.stringify(seedState(runDir, { design: design("completed") })));
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

const eventsOf = (runDir: string, type: string): { payload: unknown }[] =>
  readFileSync(join(runDir, "event.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; payload: unknown })
    .filter((event) => event.type === type);

describe("comment routes", () => {
  test("SC25: a posted batch is saved, logged with its places, typed into the session, and bad bodies are refused", async () => {
    const { post, runDir, calls } = await setup(EMPTY_BOX);
    const res = await post("/runs/r-named/comments", {
      comments: [draft, { file: "artifacts/a.md", kind: "global", text: "Ship it" }],
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { comments: { id: string }[] };
    expect(body.comments.map((c) => c.id)).toEqual(["c1", "c2"]);
    const added = eventsOf(runDir, "artifact.comment.added");
    expect(added).toHaveLength(1);
    expect(added[0]?.payload).toEqual({
      comments: [
        { id: "c1", ...draft },
        { id: "c2", file: "artifacts/a.md", kind: "global", text: "Ship it" },
      ],
    });
    await until(async () => (await statusesOf(runDir)).every((s) => s === "delivered"));
    expect(await statusesOf(runDir)).toEqual(["delivered", "delivered"]);
    expect(calls.filter((c) => c.startsWith("text:"))).toHaveLength(1);
    expect(calls[0]).toContain("2 new comments");
    const bad = [
      await post("/runs/r-named/comments", { comments: [{ ...draft, kind: "shout" }] }),
      await post("/runs/r-missing/comments", { comments: [draft] }),
      await post("/runs/r-starting/comments", { comments: [draft] }),
      await post("/runs/r-named/comments", { comments: [{ ...draft, file: "../state.json" }] }),
    ];
    expect(bad.map((r) => r.status)).toEqual([400, 404, 409, 400]);
  });

  test("an approve on a file no running node waits on is refused with 409 and nothing is stored, and one on the waiting design.md is accepted", async () => {
    const { post, runDir } = await setup();
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
    put(runDir, "state.json", JSON.stringify(seedState(runDir, { design })));
    const approve = (file: string) =>
      post("/runs/r-named/comments", { comments: [{ file, kind: "approve", text: "Approved" }] });

    const refused = await approve("artifacts/notes.md");
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("artifacts/notes.md");
    expect(await statusesOf(runDir)).toEqual([]);

    expect((await approve("artifacts/design.md")).status).toBe(201);
  });

  test("SC530: a comment on design.md in a run whose interaction policy is off is refused with 409, and nothing is stored or logged", async () => {
    const { post, runDir } = await setup();
    put(runDir, "artifacts/design.md", "# d");
    const state: State = {
      ...seedState(runDir, {}),
      policies: { values: { interaction: false }, sources: { interaction: "cli" } },
    };
    put(runDir, "state.json", JSON.stringify(state));

    const refused = await post("/runs/r-named/comments", { comments: [draft] });

    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("interaction");
    expect(existsSync(join(runDir, "comments.json"))).toBe(false);
    expect(existsSync(join(runDir, "event.jsonl"))).toBe(false);
  });

  const offPolicies = { values: { interaction: false }, sources: { interaction: "cli" } } as const;

  test("SC530: a run the registry saved with interaction off refuses comments though its state.json is missing", async () => {
    const { post, registry, cwd } = await setup();
    await registry.addRun({ ...runRecord("r-off", cwd, "off"), policies: offPolicies });
    const runDir = join(cwd, ".yok", "off");
    put(runDir, "artifacts/design.md", "# d");

    const refused = await post("/runs/r-off/comments", { comments: [draft] });

    expect(refused.status).toBe(409);
    expect(existsSync(join(runDir, "comments.json"))).toBe(false);
  });

  test("SC530: a reply on a run whose interaction policy is off is refused with 409, and the thread is left as it was", async () => {
    const { post, registry, cwd } = await setup();
    await registry.addRun({ ...runRecord("r-off", cwd, "off"), policies: offPolicies });
    const runDir = join(cwd, ".yok", "off");
    put(runDir, "artifacts/design.md", "# d");
    await addComments(
      runDir,
      [{ file: "artifacts/design.md", kind: "global", text: "Why one file?" }],
      new Date(),
    );
    const before = readFileSync(join(runDir, "comments.json"), "utf8");

    const refused = await post("/runs/r-off/comments/c1/reply", { text: "one more thing" });

    expect(refused.status).toBe(409);
    expect(readFileSync(join(runDir, "comments.json"), "utf8")).toBe(before);
    expect(existsSync(join(runDir, "event.jsonl"))).toBe(false);
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
    put(ctx.runDir, "state.json", JSON.stringify(seedState(ctx.runDir, { design })));
    return ctx;
  };
  const approveDraft = { file: "artifacts/design.md", kind: "approve", text: "Approved" };

  test("SC10: two approvals of the waiting design.md posted at once - one is accepted with 201, the other refused with 409, and only one approval is stored and logged", async () => {
    const { post, runDir } = await seedWaitingDesign();

    const replies = await Promise.all([
      post("/runs/r-named/comments", { comments: [approveDraft] }),
      post("/runs/r-named/comments", { comments: [approveDraft] }),
    ]);

    expect(replies.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await statusesOf(runDir)).toHaveLength(1);
    const added = eventsOf(runDir, "artifact.comment.added");
    expect(added).toHaveLength(1);
    expect(added[0]?.payload).toMatchObject({ comments: [{ kind: "approve" }] });
  });

  test("SC10: one batch holding two approvals of the same design.md is refused with 409 and nothing is stored", async () => {
    const { post, runDir } = await seedWaitingDesign();

    const res = await post("/runs/r-named/comments", { comments: [approveDraft, approveDraft] });

    expect(res.status).toBe(409);
    expect(await statusesOf(runDir)).toEqual([]);
    expect(existsSync(join(runDir, "event.jsonl"))).toBe(false);
  });

  test("SC31: a user follow-up sends the thread again and is logged", async () => {
    const { post, get, runDir, calls } = await setup(EMPTY_BOX);
    await post("/runs/r-named/comments", { comments: [draft] });
    await until(async () => (await statusesOf(runDir))[0] === "delivered");
    await replyToComment(runDir, "c1", { status: "answered", text: "Because." }, new Date());

    const res = await post("/runs/r-named/comments/c1/reply", { text: "Can we bundle it later?" });

    expect(res.status).toBe(200);
    const typedFollowUp = () =>
      calls.some((c) => c.includes("c1 · reply on its thread: Can we bundle it later?"));
    await until(async () => typedFollowUp() && (await statusesOf(runDir))[0] === "delivered");
    expect(typedFollowUp()).toBe(true);
    expect(await statusesOf(runDir)).toEqual(["delivered"]);
    const listed = (await (await get("/runs/r-named/comments")).json()) as {
      comments: { status: string; thread: { by: string; text: string }[] }[];
    };
    expect(listed.comments[0]?.thread.at(-1)).toMatchObject({
      by: "user",
      text: "Can we bundle it later?",
    });
    expect(eventsOf(runDir, "artifact.comment.replied")[0]?.payload).toMatchObject({
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
  test("SC30: the stream sends the run's state at once and again when something changes", async () => {
    const { app, registry, cwd } = await setup();
    await registry.addRun(runRecord("r-late", cwd, null));
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

      await registry.initRun("r-late", "late");
      const lateDir = join(cwd, ".yok", "late");
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

      await addComments(
        lateDir,
        [{ file: "artifacts/design.md", kind: "global", text: "hi" }],
        new Date(),
      );
      await replyToComment(lateDir, "c1", { status: "answered", text: "Because." }, new Date());
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
      `data:text/javascript;base64,${btoa(await res.text())}`
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

const stateJson = (runId: string, cwd: string, status: State["status"]): string =>
  JSON.stringify({
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
  });

const listRoutes = (registry: Registry, host: ITerminalHost = fakeHost("").host) => {
  return viewerRoutes({
    registry,
    log: noopLogger,
    providerFor: () => claudeOver(host),
    host,
    now: () => new Date(),
    openInEditor: () => ({ ok: true, value: null }),
  });
};

type ListedRun = { id: string; folder: string; status: string };

describe("runs list", () => {
  test("SC105: GET /runs lists every run newest first, each with its own folder, and a run with a folder carries its state's status", async () => {
    const acme = join(tempDir("list-a"), "acme");
    const beta = join(tempDir("list-b"), "beta");
    const registry = createRegistry(join(tempDir("list-reg"), "registry.json"), noopLogger);
    const at = (day: number) => `2026-01-0${day}T00:00:00.000Z`;
    await registry.addRun({ ...runRecord("r-old", acme, "gone"), createdAt: at(1) });
    await registry.addRun({ ...runRecord("r-new", beta, null), createdAt: at(3) });
    await registry.addRun({ ...runRecord("r-mid", acme, "demo"), createdAt: at(2) });
    put(acme, ".yok/demo/state.json", stateJson("r-mid", acme, "completed"));
    put(acme, ".yok/demo/workflow.yaml", WORKFLOW_YAML);

    const res = await listRoutes(registry).request("/runs", {
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
    const registry = createRegistry(join(tempDir("list-reg"), "registry.json"), noopLogger);
    await registry.addRun({
      ...runRecord("r-done", done, "demo"),
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await registry.addRun({
      ...runRecord("r-live", live, "demo"),
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    for (const [cwd, id, status] of [
      [done, "r-done", "completed"],
      [live, "r-live", "running"],
    ] as const) {
      put(cwd, ".yok/demo/state.json", stateJson(id, cwd, status));
      put(cwd, ".yok/demo/workflow.yaml", WORKFLOW_YAML);
    }
    const app = listRoutes(registry);
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

    put(done, ".yok/demo/state.json", stateJson("r-done", done, "running"));
    put(live, ".yok/demo/state.json", stateJson("r-live", live, "failed"));
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
    const registry = createRegistry(join(tempDir("list-reg"), "registry.json"), noopLogger);
    const runs = [
      { id: "r-blocked", terminal: "t-alive", status: "blocked", blocker: QUESTION_BLOCKER },
      { id: "r-gone", terminal: "t-dead", status: "running" },
      { id: "r-done", terminal: "t-done", status: "completed" },
    ] as const;
    for (const [i, run] of runs.entries()) {
      const cwd = tempDir(`list-${run.id}`);
      const createdAt = `2026-01-0${3 - i}T00:00:00.000Z`;
      await registry.addRun({
        ...runRecord(run.id, cwd, "demo"),
        terminal: run.terminal,
        createdAt,
      });
      const state = {
        ...JSON.parse(stateJson(run.id, cwd, run.status)),
        ...("blocker" in run ? { blocker: run.blocker } : {}),
      };
      put(cwd, ".yok/demo/state.json", JSON.stringify(state));
    }
    const { host, asked } = twoPaneHost();

    const res = await listRoutes(registry, host).request("/runs", {
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
    const registry = createRegistry(join(tempDir("list-reg"), "registry.json"), noopLogger);
    await registry.addRun({ ...runRecord("r-live", cwd, null), terminal: "s1" });
    const res = await listRoutes(registry).request("/stream", {
      headers: { host: "localhost:4000" },
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const sse = sseReader(res);
    const statusIs = (status: string) => (e: SseEvent) =>
      e.event === "runs" && (e.data as { runs: ListedRun[] }).runs[0]?.status === status;
    try {
      await sse.waitFor(statusIs("starting"), 500);

      await registry.initRun("r-live", "demo");
      put(cwd, ".yok/demo/state.json", stateJson("r-live", cwd, "running"));
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

const stateWithRuns = (cwd: string, nodeRuns: Record<string, unknown>): string =>
  JSON.stringify({ ...JSON.parse(stateJson("r-named", cwd, "running")), nodeRuns });

type StepsBody = { steps: { id: string; status: string }[] };
const stepsOf = (e: SseEvent): StepsBody["steps"] | null =>
  e.event === "steps" ? (e.data as StepsBody).steps : null;

describe("steps on the run stream", () => {
  test("SC123: a named run streams its folder's steps, a named run with no workflow.yaml streams none, and an unnamed run streams no steps", async () => {
    const { get, cwd, runDir } = await setup();
    put(runDir, "workflow.yaml", THREE_STEPS_YAML);
    put(runDir, "state.json", stateWithRuns(cwd, { design: nodeRun([]) }));

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
    const { get, cwd, runDir } = await setup();
    put(runDir, "workflow.yaml", THREE_STEPS_YAML);
    const designIs = (status: string) => (e: SseEvent) => stepsOf(e)?.[0]?.status === status;
    put(
      runDir,
      "state.json",
      stateWithRuns(cwd, { design: { ...nodeRun([]), status: "running" } }),
    );

    const sse = sseReader(await get("/runs/r-named/stream"));
    try {
      await sse.waitFor(designIs("running"), 1000);

      put(runDir, "state.json", stateWithRuns(cwd, { design: nodeRun([]) }));
      await sse.waitFor(designIs("completed"));
    } finally {
      await sse.close();
    }
  }, 10000);
});

describe("summary on the run stream", () => {
  test("the run stream sends the run's summary at once, and again when the run blocks with its steps unchanged", async () => {
    const { get, cwd, runDir } = await setup(EMPTY_BOX, true);
    put(runDir, "workflow.yaml", THREE_STEPS_YAML);
    const nodeRuns = { design: { ...nodeRun([]), status: "running" } };
    put(runDir, "state.json", stateWithRuns(cwd, nodeRuns));
    const statusIs = (status: string) => (e: SseEvent) =>
      e.event === "summary" && (e.data as ListedRun).status === status;

    const sse = sseReader(await get("/runs/r-named/stream"));
    try {
      await sse.waitFor(statusIs("running"), 1000);

      const blocked = { ...JSON.parse(stateWithRuns(cwd, nodeRuns)), status: "blocked" };
      put(runDir, "state.json", JSON.stringify({ ...blocked, blocker: QUESTION_BLOCKER }));
      const summary = await sse.waitFor(statusIs("blocked"));
      expect(summary.data).toMatchObject({ id: "r-named", blocker: QUESTION_BLOCKER });
      expect(sse.seen.filter((e) => e.event === "steps")).toHaveLength(1);
    } finally {
      await sse.close();
    }
  }, 10000);
});
