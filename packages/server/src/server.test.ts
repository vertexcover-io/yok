import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addComments, agentBinary, readComments, summarize } from "@yok/core";
import type { WorkflowRun } from "@yok/sdk";
import { noopLogger, registryPath, runDirOf } from "@yok/sdk";
import { createRegistry } from "@yok/sdk/internal";
import { claudeOver, EMPTY_BOX, fakeHost } from "./fake-host.ts";
import { publicOrigin, serverDomain, updateHomeEnv } from "./protocol.ts";
import { type CheckCheckout, runtimeChecks, startServer } from "./server.ts";

const readyCheckout: CheckCheckout = () =>
  Promise.resolve({ env: { ok: true, value: {} }, report: summarize([]) });

test.each([
  ["SERVER_DOMAIN=yok.example.com\n", "yok.example.com"],
  ["SERVER_DOMAIN=Yok.Example.com\n", "yok.example.com"],
  ["SERVER_DOMAIN=https://yok.example.com\n", "yok.example.com"],
  ["SERVER_DOMAIN=http://yok.example.com/\n", "yok.example.com"],
  ["SERVER_DOMAIN=yok.example.com//\n", "yok.example.com"],
  ["SERVER_DOMAIN=HTTPS://Yok.Example.com:8443/\n", "yok.example.com:8443"],
  [null, "localhost:7777"],
  ["LINEAR_API_KEY=lin\n", "localhost:7777"],
])(
  "SC1001: a home whose .env holds %p gives the server domain %p, ignoring SERVER_DOMAIN in the process env",
  (env, domain) => {
    const home = mkdtempSync(join(tmpdir(), "yok-domain-"));
    if (env !== null) writeFileSync(join(home, ".env"), env);
    const before = process.env.SERVER_DOMAIN;
    process.env.SERVER_DOMAIN = "decoy.example.com";
    try {
      expect(serverDomain(home, 7777)).toBe(domain);
    } finally {
      if (before === undefined) delete process.env.SERVER_DOMAIN;
      else process.env.SERVER_DOMAIN = before;
    }
  },
);

test.each([
  ["localhost", "http"],
  ["localhost:7777", "http"],
  ["127.0.0.1:7777", "http"],
  ["[::1]:7777", "http"],
  ["yok.example.com", "https"],
  ["yok.example.com:8443", "https"],
  ["localhost.example.com", "https"],
])("SC1002: the domain %p gets a %p origin", (domain, scheme) => {
  expect(publicOrigin(domain)).toBe(`${scheme}://${domain}`);
});

test("SC102: updateHomeEnv sets and removes keys in .env, keeps the other lines, and leaves the file 0600", async () => {
  const home = join(mkdtempSync(join(tmpdir(), "yok-env-")), "home");

  await updateHomeEnv(home, { YOK_SERVER_URL: "https://a.example", YOK_API_KEY: "key-a" });
  await updateHomeEnv(home, { LINEAR_API_KEY: "lin" });
  await updateHomeEnv(home, { YOK_SERVER_URL: null, YOK_API_KEY: "key-b" });

  expect(readFileSync(join(home, ".env"), "utf8")).toBe("LINEAR_API_KEY=lin\nYOK_API_KEY=key-b\n");
  expect(statSync(join(home, ".env")).mode & 0o777).toBe(0o600);
});

test("SC26: a restarted server types the comments an earlier one left behind, with no viewer request", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "yok-srv-")));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "yok-srv-cwd-")));
  const run: WorkflowRun = {
    id: "r-1",
    workflow: "w",
    workflowPath: "/w.yaml",
    inputs: {},
    cwd,
    sessions: [{ agent: "claude", sessionId: "s1" }],
    name: "demo",
    terminal: "s1",
    config: null,
    tiers: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  writeFileSync(join(home, "registry.json"), JSON.stringify({ version: 1, runs: { "r-1": run } }));
  const runDir = runDirOf(cwd, "demo");
  mkdirSync(runDir, { recursive: true });
  await addComments(runDir, [{ file: "artifacts/a.md", kind: "global", text: "hi" }], new Date());
  const { host, calls } = fakeHost(EMPTY_BOX);

  const server = await startServer({
    home,
    runtime: { host, providerFor: () => claudeOver(host), checkCheckout: readyCheckout },
  });

  const delivered = async (): Promise<boolean> => {
    const read = await readComments(runDir);
    return read.ok && read.value.comments[0]?.status === "delivered";
  };
  for (let i = 0; i < 50 && !(await delivered()); i++) await Bun.sleep(100);
  await server.stop();
  expect(await delivered()).toBe(true);
  expect(calls[0]).toContain("1 new comment");
});

test("SC128: each agent's runtime checks carry its plugin check, run against the binary agentBinary names", () => {
  expect(runtimeChecks("claude").map((check) => check.name)).toContain("claude-plugin");
  expect(runtimeChecks("codex").map((check) => check.name)).toContain("codex-plugin");
  expect(agentBinary("claude", { YOK_CLAUDE_BIN: "/x/claude" })).toBe("/x/claude");
  expect(agentBinary("codex", { YOK_CODEX_BIN: "/x/codex" })).toBe("/x/codex");
  expect([agentBinary("claude", {}), agentBinary("codex", {})]).toEqual(["claude", "codex"]);
});

test("SC106: a named port is bound or the start fails, and an unnamed start falls back from a taken saved port", async () => {
  const tempHome = () => realpathSync(mkdtempSync(join(tmpdir(), "yok-srv-")));
  const [a, b, c] = [tempHome(), tempHome(), tempHome()];
  const runtime = () => {
    const { host } = fakeHost(EMPTY_BOX);
    return { host, providerFor: () => claudeOver(host), checkCheckout: readyCheckout };
  };
  const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(free.port);
  await free.stop(true);

  const first = await startServer({ home: a, runtime: runtime(), port });
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.status).toBe(200);
    expect(readFileSync(join(a, "server.port"), "utf8")).toBe(String(port));

    await expect(startServer({ home: b, runtime: runtime(), port })).rejects.toThrow();
    expect(existsSync(join(b, "server.pid"))).toBe(false);

    writeFileSync(join(c, "server.port"), String(port));
    const third = await startServer({ home: c, runtime: runtime() });
    const moved = Number(readFileSync(join(c, "server.port"), "utf8"));
    await third.stop();
    expect(moved).not.toBe(port);
    expect(moved).toBeGreaterThan(0);
  } finally {
    await first.stop();
  }
});

test("SC106: a stopping server leaves server.pid alone once a newer server has written its own pid there, and removes its own", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "yok-srv-")));
  const runtime = () => {
    const { host } = fakeHost(EMPTY_BOX);
    return { host, providerFor: () => claudeOver(host), checkCheckout: readyCheckout };
  };

  const replaced = await startServer({ home, runtime: runtime() });
  writeFileSync(join(home, "server.pid"), "424242");
  await replaced.stop();
  expect(readFileSync(join(home, "server.pid"), "utf8")).toBe("424242");

  const own = await startServer({ home, runtime: runtime() });
  await own.stop();
  expect(existsSync(join(home, "server.pid"))).toBe(false);
});

test("a first start creates the home readable by this user alone", async () => {
  const home = join(realpathSync(mkdtempSync(join(tmpdir(), "yok-srv-"))), "home");
  const { host } = fakeHost(EMPTY_BOX);

  const server = await startServer({
    home,
    runtime: { host, providerFor: () => claudeOver(host), checkCheckout: readyCheckout },
  });
  await server.stop();

  expect(statSync(home).mode & 0o777).toBe(0o700);
});

const fakeRuntime = () => {
  const { host } = fakeHost(EMPTY_BOX);
  return { host, providerFor: () => claudeOver(host), checkCheckout: readyCheckout };
};

const namedRun = (id: string): WorkflowRun => ({
  id,
  workflow: "w",
  workflowPath: "/w.yaml",
  inputs: {},
  cwd: "/nowhere",
  sessions: [],
  name: id,
  terminal: null,
  config: null,
  tiers: null,
  createdAt: "2026-01-01T00:00:00.000Z",
});

// A server started in a fresh home, asked at the port it wrote to server.port.
const startedServer = async (env?: string) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "yok-srv-")));
  if (env !== undefined) writeFileSync(join(home, ".env"), env);
  await createRegistry(registryPath(home), noopLogger).addRun(namedRun("r-1"));
  const server = await startServer({ home, runtime: fakeRuntime() });
  const port = Number(readFileSync(join(home, "server.port"), "utf8"));
  return { home, server, port, origin: `http://127.0.0.1:${port}` };
};

test.each([
  ["SERVER_DOMAIN=yok.example.com\n", "https://yok.example.com"],
  [undefined, null],
])(
  "SC1008: with .env %p, dashboard links start with %p, else http://localhost:PORT",
  async (env, domainOrigin) => {
    const { server, port, origin } = await startedServer(env);
    const expected = domainOrigin ?? `http://localhost:${port}`;
    try {
      expect(await (await fetch(`${origin}/api/runs/view`)).json()).toEqual({
        view: `${expected}/`,
      });
      expect(await (await fetch(`${origin}/api/runs/r-1/view`)).json()).toEqual({
        view: `${expected}/runs/r-1`,
      });
    } finally {
      await server.stop();
    }
  },
);

test("SC1009: a server started in an empty home answers the API with no authorization header and writes no key", async () => {
  const home = join(realpathSync(mkdtempSync(join(tmpdir(), "yok-srv-"))), "home");
  const server = await startServer({ home, runtime: fakeRuntime() });
  const origin = `http://127.0.0.1:${readFileSync(join(home, "server.port"), "utf8")}`;
  try {
    const health = await fetch(`${origin}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      pid: process.pid,
      version: expect.any(String),
      startedAt: expect.any(Number),
    });
    const projects = await fetch(`${origin}/api/projects`);
    expect([projects.status, await projects.json()]).toEqual([200, { projects: [] }]);
    expect((await fetch(`${origin}/health`)).status).toBe(404);
  } finally {
    await server.stop();
  }
  expect(existsSync(join(home, ".env"))).toBe(false);
  expect(existsSync(join(home, "viewer.port"))).toBe(false);
});

test("SC1010: on the one port in server.port, /runs/view is the dashboard page and /api/runs/view is the API's link", async () => {
  const { server, origin } = await startedServer();
  try {
    const page = await fetch(`${origin}/runs/view`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const link = await fetch(`${origin}/api/runs/view`);
    expect(link.status).toBe(200);
    expect(await link.json()).toEqual({
      view: expect.stringMatching(/^http:\/\/localhost:\d+\/$/),
    });
  } finally {
    await server.stop();
  }
});

// Reads the stream until the next whole runs event and returns its data.
type RunsEvent = { runs: { id: string }[] };

const nextRunsEvent = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<RunsEvent> => {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const match = /event: runs\ndata: (.*)\n\n/.exec(text);
    if (match?.[1] !== undefined) return JSON.parse(match[1]) as RunsEvent;
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream closed after: ${text}`);
    text += decoder.decode(value, { stream: true });
  }
};

test("SC1011: a dashboard /stream connection stays open through 11 idle seconds and delivers the next change", async () => {
  const { home, server, origin } = await startedServer();
  const controller = new AbortController();
  try {
    const res = await fetch(`${origin}/stream`, { signal: controller.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    expect((await nextRunsEvent(reader)).runs.map((run) => run.id)).toEqual(["r-1"]);

    // Bun checks its 10-second idle limit in coarse ticks and cuts at about 12 seconds.
    await Bun.sleep(13_000);
    await createRegistry(registryPath(home), noopLogger).addRun(namedRun("r-2"));

    const next = await Promise.race([nextRunsEvent(reader), Bun.sleep(3_000).then(() => null)]);
    expect(next?.runs.map((run) => run.id).sort()).toEqual(["r-1", "r-2"]);
  } finally {
    controller.abort();
    await server.stop();
  }
}, 30_000);
