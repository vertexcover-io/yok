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
import { runDirOf } from "@yok/sdk";
import { claudeOver, EMPTY_BOX, fakeHost } from "./fake-host.ts";
import { ensureApiKey } from "./protocol.ts";
import { type CheckCheckout, runtimeChecks, startServer } from "./server.ts";

const readyCheckout: CheckCheckout = () =>
  Promise.resolve({ env: { ok: true, value: {} }, report: summarize([]) });

test("SC101: a first start writes a key to the home's .env with mode 0600, and a later start keeps it", async () => {
  const home = join(mkdtempSync(join(tmpdir(), "yok-key-")), "home");

  const key = await ensureApiKey(home);
  const again = await ensureApiKey(home);

  const text = readFileSync(join(home, ".env"), "utf8");
  expect(key).toMatch(/^[\w-]{40,}$/);
  expect(again).toBe(key);
  expect(text.match(/YOK_API_KEY=/g)).toHaveLength(1);
  expect(text).toContain(`YOK_API_KEY=${key}\n`);
  expect(statSync(join(home, ".env")).mode & 0o777).toBe(0o600);
});

test("SC101: a home whose .env already holds other lines keeps them beside the new key, and the file becomes 0600", async () => {
  const home = mkdtempSync(join(tmpdir(), "yok-key-"));
  writeFileSync(join(home, ".env"), "LINEAR_API_KEY=lin\n", { mode: 0o644 });

  const key = await ensureApiKey(home);

  expect(readFileSync(join(home, ".env"), "utf8")).toBe(
    `LINEAR_API_KEY=lin\n\nYOK_API_KEY=${key}\n`,
  );
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
    const health = await fetch(`http://127.0.0.1:${port}/health`);
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
