import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { addComments, captureLogger } from "@yok/core";
import type {
  IAgentProvider,
  ITerminal,
  LaunchOptions,
  Result,
  SavedPolicies,
  State,
  WorkflowRun,
} from "@yok/sdk";
import { noopLogger, runDirOf, WorkflowRunSchema } from "@yok/sdk";
import { createRegistry, jsonlEventStore, type Registry } from "@yok/sdk/internal";
import * as z from "zod";
import { createApp } from "./app.ts";
import { createYokClient } from "./client.ts";
import { fakeHost, seedState } from "./fake-host.ts";
import { socketPath } from "./protocol.ts";

type Workspace = Readonly<{ workflowPath: string; cwd: string }>;

// A git checkout, as yok run sends: the server reads its config to pick the launch model.
const tempWorkspace = (): Workspace => {
  const cwd = mkdtempSync(join(tmpdir(), "yok-app-"));
  execFileSync("git", ["init", "-q"], { cwd });
  const workflowPath = join(cwd, "ok.yaml");
  writeFileSync(workflowPath, "name: ok\nnodes: []\n");
  return { workflowPath, cwd };
};

const done = () => Promise.resolve({ ok: true as const, value: undefined });

const fakePane = (name: string): ITerminal => ({
  sendText: done,
  sendKeys: done,
  capture: () => Promise.resolve({ ok: true, value: "" }),
  isAlive: () => Promise.resolve(true),
  rename: done,
  respawn: done,
  kill: done,
  attachCommand: () => ["tmux", "attach-session", "-t", name],
});

const fakeProvider = (
  type: IAgentProvider["type"],
  launch: (
    options: LaunchOptions,
  ) => Promise<Result<{ terminalName: string; terminal: ITerminal }>>,
): IAgentProvider => ({
  type,
  skillPrefix: type === "codex" ? "$" : "/",
  checks: [],
  launch,
  relaunch: () => Promise.resolve({ ok: true, value: undefined }),
  prompt: () => Promise.resolve({ ok: true, value: undefined }),
  stop: () => Promise.resolve({ ok: true, value: undefined }),
  run: () => Promise.resolve({ ok: false, error: new Error("not implemented") }),
  limitResetWait: () => Promise.resolve(null),
  promptWhenReady: () => Promise.resolve({ ok: true, value: "not-ready" }),
});

const buildDeps = async (
  launch: (
    options: LaunchOptions,
  ) => Promise<Result<{ terminalName: string; terminal: ITerminal }>>,
  log = noopLogger,
) => {
  const registryPath = join(mkdtempSync(join(tmpdir(), "yok-registry-")), "registry.json");
  const registry = createRegistry(registryPath, log);
  const asked: string[] = [];
  return {
    registryPath,
    registry,
    asked,
    providerFor: (agent: IAgentProvider["type"]) => {
      asked.push(agent);
      return fakeProvider(agent, launch);
    },
    // the run's tmux session is gone unless a test says otherwise
    host: fakeHost("", false).host,
    log,
    home: mkdtempSync(join(tmpdir(), "yok-home-")),
    viewerOrigin: "http://localhost:1",
    pid: 4242,
    version: "0.0.0-test",
    startedAt: 1_700_000_000_000,
  };
};

describe("POST /runs", () => {
  test.each([
    ["a body that is not JSON", () => "{not json"],
    [
      "SC9: a relative workflowPath",
      ({ cwd }: Workspace) =>
        JSON.stringify({ workflow: "ok", env: {}, workflowPath: "ok.yaml", inputs: {}, cwd }),
    ],
    [
      "an invalid supplied name",
      ({ workflowPath, cwd }: Workspace) =>
        JSON.stringify({
          workflow: "ok",
          env: {},
          workflowPath,
          inputs: {},
          cwd,
          name: "Bad/Name",
        }),
    ],
    [
      "a request without env",
      ({ workflowPath, cwd }: Workspace) =>
        JSON.stringify({ workflow: "ok", workflowPath, inputs: {}, cwd }),
    ],
  ])("%s is 400 bad-request and launches nothing", async (_label, body) => {
    let launched = false;
    const deps = await buildDeps(() => {
      launched = true;
      return Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } });
    });

    const res = await createApp(deps).request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body(tempWorkspace()),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad-request");
    expect(launched).toBe(false);
  });

  test("SC10: a working provider launches with the orchestrate prompt and returns the run and attach command", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const seen: LaunchOptions[] = [];
    const deps = await buildDeps((options) => {
      seen.push(options);
      return Promise.resolve({
        ok: true,
        value: { terminalName: "session-xyz", terminal: fakePane("%7") },
      });
    });
    const app = createApp(deps);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", env: {}, workflowPath, inputs: { a: 1 }, cwd }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      run: { id: string; sessions: unknown[]; terminal: string | null };
      attach: string[];
    };
    expect(json.run.sessions).toEqual([]);
    expect(json.run.terminal).toBe("session-xyz");
    // The pane id, not the session name, so the attach survives init renaming the session.
    expect(json.attach).toEqual(["tmux", "attach-session", "-t", "%7"]);

    const [launchOptions] = seen;
    expect(launchOptions?.cwd).toBe(cwd);
    expect(launchOptions?.prompt).toBe(
      `/orchestrate --workflow ${workflowPath} --inputs ${JSON.stringify({ a: 1 })}`,
    );
    expect(launchOptions?.env?.YOK_RUN_ID).toBe(json.run.id);

    expect((await deps.registry.findRun(json.run.id))?.terminal).toBe("session-xyz");
  });

  test("SC16: the first prompt invokes the skill the way the agent does: $orchestrate for codex", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    let prompt: string | undefined;
    const deps = await buildDeps((options) => {
      prompt = options.prompt;
      return Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } });
    });

    const res = await createApp(deps).request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow: "ok",
        env: {},
        workflowPath,
        inputs: {},
        cwd,
        agent: "codex",
      }),
    });

    expect(res.status).toBe(201);
    expect(prompt).toBe(`$orchestrate --workflow ${workflowPath} --inputs {}`);
  });

  test("the run is in the registry before its agent starts, so the agent's orchestrate init finds it", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    let savedAtLaunch: unknown;
    const deps = await buildDeps(async (options) => {
      savedAtLaunch = await deps.registry.findRun(String(options.env?.YOK_RUN_ID));
      return { ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } };
    });
    const app = createApp(deps);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", env: {}, workflowPath, inputs: {}, cwd }),
    });

    expect(res.status).toBe(201);
    expect(savedAtLaunch).toMatchObject({ workflowPath, cwd, sessions: [], name: null });
  });

  test("a config file in the body is saved on the run; with none the run's config is null", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const deps = await buildDeps(() =>
      Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } }),
    );
    const app = createApp(deps);
    const config = join(cwd, "custom.json");
    writeFileSync(config, '{"version": 2}');
    const start = (extra: object) =>
      app.request("/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow: "ok", env: {}, workflowPath, inputs: {}, cwd, ...extra }),
      });

    const runOf = async (extra: object) =>
      z.object({ run: WorkflowRunSchema }).parse(await (await start(extra)).json()).run;
    const withConfig = await runOf({ config });
    const without = await runOf({});

    expect(withConfig.config).toBe(config);
    expect((await deps.registry.findRun(withConfig.id))?.config).toBe(config);
    expect(without.config).toBeNull();
  });

  // Starts a run of AGENT with the config file CONFIG holds and the request's TIERS; gives back the
  // reply and the launch options the provider saw.
  const startTiered = async (agent: string, config: string, tiers?: object, policies?: object) => {
    const { workflowPath, cwd } = tempWorkspace();
    const configPath = join(cwd, "tiers.yaml");
    writeFileSync(configPath, config);
    const seen: LaunchOptions[] = [];
    const deps = await buildDeps((options) => {
      seen.push(options);
      return Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } });
    });
    const res = await createApp(deps).request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow: "ok",
        env: {},
        workflowPath,
        inputs: {},
        cwd,
        agent,
        config: configPath,
        ...(tiers === undefined ? {} : { tiers }),
        ...(policies === undefined ? {} : { policies }),
      }),
    });
    const launched = seen.map(({ model, effort }) => ({ model, effort }));
    return { res, launched, deps };
  };

  test.each([
    [
      "a claude run with no tiers anywhere launches on the built-in deep tier",
      "claude",
      "version: 2\n",
      { model: "claude-opus-5-5", effort: "high" },
    ],
    [
      "a codex run with no tiers anywhere launches on the built-in deep tier",
      "codex",
      "version: 2\n",
      { model: "gpt-6-sol", effort: "high" },
    ],
    [
      "a codex run launches on the model and effort of its config's default tier",
      "codex",
      "version: 2\nagents:\n  codex:\n    tiers:\n      default: deep\n      models:\n        deep: { model: gpt-5-codex, effort: high }\n",
      { model: "gpt-5-codex", effort: "high" },
    ],
  ] as const)("%s", async (_label, agent, config, model) => {
    const { res, launched } = await startTiered(agent, config);

    expect(res.status).toBe(201);
    expect(launched).toEqual([model]);
  });

  test("the run saved at start holds the built-in, config and request tiers merged, and launches on its default fast tier's haiku-x", async () => {
    const config =
      "version: 2\nagents:\n  claude:\n    tiers:\n      default: fast\n      models:\n        fast: { model: haiku-x }\n";
    const { res, launched, deps } = await startTiered("claude", config, {
      models: { deep: { model: "opus-y" } },
    });

    expect(res.status).toBe(201);
    const { run } = z.object({ run: WorkflowRunSchema }).parse(await res.json());
    const tiers = {
      default: "fast",
      models: { fast: { model: "haiku-x" }, deep: { model: "opus-y" } },
    };
    expect((await deps.registry.findRun(run.id))?.tiers).toEqual(tiers);
    expect(launched).toEqual([{ model: "haiku-x", effort: undefined }]);
  });

  test("SC506: the CLI's interaction false wins over the config's and workflow's true, saved on the run and returned", async () => {
    const { res, deps } = await startTiered(
      "claude",
      "version: 2\npolicies:\n  interaction: true\n",
      undefined,
      { workflow: { interaction: true }, cli: { interaction: false } },
    );

    expect(res.status).toBe(201);
    const { run } = z.object({ run: WorkflowRunSchema }).parse(await res.json());
    const policies: SavedPolicies = {
      values: { interaction: false },
      sources: { interaction: "cli" },
    };
    expect(run.policies).toEqual(policies);
    expect((await deps.registry.findRun(run.id))?.policies).toEqual(policies);
  });

  test("SC507: a request with no policies starts a run with interaction true from the default", async () => {
    const { res } = await startTiered("claude", "version: 2\n");

    expect(res.status).toBe(201);
    const { run } = z.object({ run: WorkflowRunSchema }).parse(await res.json());
    expect(run.policies).toEqual({
      values: { interaction: true },
      sources: { interaction: "default" },
    });
  });

  test("the session starts with the env the request carries, under yok's own variables", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const seen: LaunchOptions[] = [];
    const deps = await buildDeps((options) => {
      seen.push(options);
      return Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } });
    });

    const res = await createApp(deps).request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow: "ok",
        workflowPath,
        inputs: {},
        cwd,
        env: { API_URL: "http://x", YOK_RUN_ID: "spoofed" },
      }),
    });

    expect(res.status).toBe(201);
    const { run } = z.object({ run: WorkflowRunSchema }).parse(await res.json());
    expect(seen[0]?.env).toEqual({
      API_URL: "http://x",
      PATH: expect.stringContaining(join(deps.home, "shims")),
      YOK_RUN_ID: run.id,
      YOK_HOME: deps.home,
    });
  });

  test("SC66: from source, a run's session gets a shim folder under the home first on PATH, holding an executable yok, and the repo as its plugin folder", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const seen: LaunchOptions[] = [];
    const deps = await buildDeps((options) => {
      seen.push(options);
      return Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } });
    });

    const res = await createApp(deps).request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", workflowPath, inputs: {}, cwd, env: {} }),
    });

    expect(res.status).toBe(201);
    const { run } = z.object({ run: WorkflowRunSchema }).parse(await res.json());
    const [shimDir = ""] = (seen[0]?.env?.PATH ?? "").split(delimiter);
    expect(dirname(shimDir)).toBe(join(deps.home, "shims"));
    accessSync(join(shimDir, "yok"), constants.X_OK);
    expect(seen[0]?.env?.YOK_RUN_ID).toBe(run.id);
    const pluginDir = seen[0]?.pluginDir ?? "";
    expect(existsSync(join(pluginDir, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  test("a request whose tiers default names a tier no layer maps is 400 and launches nothing", async () => {
    const { res, launched, deps } = await startTiered("claude", "version: 2\n", {
      default: "turbo",
    });

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe("bad-request");
    expect(error.message).toContain('default tier "turbo"');
    expect(launched).toEqual([]);
    expect(await deps.registry.listRuns()).toEqual([]);
  });

  test("SC11: a failing provider is 502 agent-failed and records no run", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const deps = await buildDeps(() => Promise.resolve({ ok: false, error: "boom" }));
    const app = createApp(deps);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", env: {}, workflowPath, inputs: {}, cwd }),
    });

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("agent-failed");
    const saved = existsSync(deps.registryPath)
      ? JSON.parse(readFileSync(deps.registryPath, "utf8")).runs
      : {};
    expect(saved).toEqual({});
  });

  test("a handler that throws answers 500 with an internal error body and logs it", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const { log, at } = captureLogger();
    const deps = await buildDeps(() => Promise.reject(new Error("tmux timed out")), log);
    const app = createApp(deps);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", env: {}, workflowPath, inputs: {}, cwd }),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "internal", message: "tmux timed out" } });
    expect(at("error").some((line) => line.msg === "request failed with an unexpected error")).toBe(
      true,
    );
    expect(JSON.parse(readFileSync(deps.registryPath, "utf8")).runs).toEqual({});
  });
});

describe("POST /runs logging", () => {
  test("no log line carries an env value from the request", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const { log, lines } = captureLogger();
    const deps = await buildDeps(
      () => Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } }),
      log,
    );

    const res = await createApp(deps).request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow: "ok",
        workflowPath,
        inputs: {},
        cwd,
        env: { API_KEY: "top-secret-value" },
      }),
    });

    expect(res.status).toBe(201);
    expect(JSON.stringify(lines)).not.toContain("top-secret-value");
  });

  test("SC36: a working provider logs 'run started' and an http 201 line with x-request-id", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const { log, lines, at } = captureLogger();
    const deps = await buildDeps(
      () => Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } }),
      log,
    );
    const app = createApp(deps);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", env: {}, workflowPath, inputs: {}, cwd }),
    });

    expect(res.headers.get("x-request-id")).toBeString();
    const runStarted = at("info").find((line) => line.msg === "run started");
    expect(runStarted).toMatchObject({ runId: expect.any(String), terminalName: "s1" });
    const httpLine = at("info").find(
      (line) => line.component === "http" && line.msg === "request finished",
    );
    expect(httpLine).toMatchObject({ status: 201 });
    void lines;
  });

  test("SC36: a failing provider logs one error line 'launch failed'", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const { log, at } = captureLogger();
    const deps = await buildDeps(() => Promise.resolve({ ok: false, error: "boom" }), log);
    const app = createApp(deps);

    await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", env: {}, workflowPath, inputs: {}, cwd }),
    });

    const failures = at("error").filter(
      (line) => line.msg === "run not started: the agent session failed to launch",
    );
    expect(failures).toHaveLength(1);
  });
});

describe("createYokClient", () => {
  const serveOn = (fetch: (request: Request) => Response | Promise<Response>) => {
    const home = mkdtempSync(join(tmpdir(), "yok-home-"));
    return { home, server: Bun.serve({ unix: socketPath(home), fetch }) };
  };

  test("calls the real routes over the socket and returns their typed bodies", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const deps = await buildDeps(() =>
      Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } }),
    );
    const { home, server } = serveOn(createApp(deps).fetch);
    try {
      const client = createYokClient({ home });

      const health = await client.health();
      expect(health).toEqual({
        ok: true,
        value: { pid: 4242, version: "0.0.0-test", startedAt: 1_700_000_000_000 },
      });

      const started = await client.run({ workflow: "ok", env: {}, workflowPath, inputs: {}, cwd });
      expect(started.ok && started.value.run.sessions).toEqual([]);

      const refused = await client.run({
        workflow: "ok",
        env: {},
        workflowPath: join(cwd, "missing.yaml"),
        inputs: {},
        cwd,
      });
      expect(refused).toEqual({
        ok: false,
        error: { code: "bad-request", message: "workflowPath and cwd must exist" },
      });
    } finally {
      await server.stop(true);
    }
  });

  test("a non-JSON error reply comes back as an internal error, not a thrown parse error", async () => {
    const { home, server } = serveOn(() => new Response("Internal Server Error", { status: 500 }));
    try {
      expect(await createYokClient({ home }).health()).toEqual({
        ok: false,
        error: { code: "internal", message: "500 Internal Server Error" },
      });
    } finally {
      await server.stop(true);
    }
  });

  test("no server behind the socket is an unreachable error", async () => {
    const home = mkdtempSync(join(tmpdir(), "yok-home-"));
    expect(await createYokClient({ home }).health()).toEqual({
      ok: false,
      error: { code: "internal", message: "server unreachable" },
    });
  });
});

describe("run page URL", () => {
  test("SC11: POST /runs returns the page URL, GET /runs/:id/view returns it later, and a missing run is 404", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const deps = {
      ...(await buildDeps(() =>
        Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } }),
      )),
      viewerOrigin: "http://localhost:4321",
    };
    const app = createApp(deps);

    const started = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", env: {}, workflowPath, inputs: {}, cwd }),
    });
    const { run, view } = (await started.json()) as { run: { id: string }; view: string };
    expect(view).toBe(`http://localhost:4321/runs/${run.id}`);

    const again = await app.request(`/runs/${run.id}/view`);
    expect(await again.json()).toEqual({ view });

    const missing = await app.request("/runs/r-missing/view");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("not-found");
  });
});

const TIERS = {
  default: "fast",
  models: { fast: { model: "haiku-x" }, deep: { model: "opus-x" } },
};

type Seed = Readonly<{
  status?: State["status"];
  // false leaves the switch to opus-x requested with no applied event
  applied?: boolean;
  run?: Partial<WorkflowRun>;
}>;

const modelEvent = (
  type: "workflow.model.requested" | "workflow.model.applied",
  payload: object,
) => ({
  id: `e-${type}`,
  ts: "2026-01-01T00:00:01.000Z",
  type,
  source: "workflow",
  runId: "r-1a2b3c4d",
  payload: { node: "think", model: "opus-x", ...payload },
});

// A run named demo on sessions s-0 then s-1, whose state and event log say it switched to opus-x.
const seedRun = async (registry: Registry, seed: Seed = {}): Promise<WorkflowRun> => {
  const cwd = mkdtempSync(join(tmpdir(), "yok-resume-"));
  const run: WorkflowRun = {
    id: "r-1a2b3c4d",
    workflow: "ok",
    workflowPath: join(cwd, "ok.yaml"),
    inputs: {},
    cwd,
    sessions: [
      { agent: "claude", sessionId: "s-0" },
      { agent: "claude", sessionId: "s-1" },
    ],
    name: "demo",
    terminal: "claude-demo-3c4d",
    config: null,
    tiers: TIERS,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...seed.run,
  };
  await registry.addRun(run);
  const runDir = runDirOf(cwd, "demo");
  mkdirSync(runDir, { recursive: true });
  const status = seed.status ?? "running";
  const blocker =
    status === "blocked"
      ? {
          blocker: {
            reason: "stuck",
            since: "2026-01-01T00:00:02.000Z",
            details: { message: null },
          },
        }
      : {};
  const state = { ...seedState(runDir, {}), status, tiers: TIERS, ...blocker };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state));
  const store = jsonlEventStore(runDir);
  const requested = await store.append(modelEvent("workflow.model.requested", {}));
  if (!requested.ok) throw new Error(requested.error);
  if (seed.applied === false) return run;
  await store.append(
    modelEvent("workflow.model.applied", { requestSeq: requested.value.seq, applied: true }),
  );
  return run;
};

// A deps whose provider records every launch and answers with pane %9.
const resumeDeps = async () => {
  const launches: LaunchOptions[] = [];
  const deps = await buildDeps((options) => {
    launches.push(options);
    return Promise.resolve({
      ok: true,
      value: { terminalName: "claude-demo-3c4d", terminal: fakePane("%9") },
    });
  });
  return { deps, launches };
};

const resume = (deps: Parameters<typeof createApp>[0], runId: string, env = {}) =>
  createApp(deps).request(`/runs/${runId}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ env }),
  });

describe("POST /runs/:id/resume", () => {
  test("SC602: a running run whose session is gone continues s-1 on opus-x, the model it last switched to, in its old terminal", async () => {
    const { deps, launches } = await resumeDeps();
    const run = await seedRun(deps.registry);

    const res = await resume(deps, run.id, { FOO: "bar" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      run,
      attach: ["tmux", "attach-session", "-t", "%9"],
      view: `http://localhost:1/runs/${run.id}`,
    });
    expect(launches).toHaveLength(1);
    const [options] = launches;
    expect(options?.continueSession).toEqual({ id: "s-1", terminalName: "claude-demo-3c4d" });
    expect(options?.model).toBe("opus-x");
    expect(options?.prompt).toBe("/orchestrate --resume demo");
    expect(options?.cwd).toBe(run.cwd);
    expect(options?.env).toMatchObject({ FOO: "bar", YOK_RUN_ID: run.id, YOK_HOME: deps.home });
    expect(await deps.registry.findRun(run.id)).toEqual(run);
  });

  test("a run whose last linked session s-2 never started continues s-1, the last session whose SessionStart was logged", async () => {
    const { deps, launches } = await resumeDeps();
    const run = await seedRun(deps.registry, {
      run: {
        sessions: [
          { agent: "claude", sessionId: "s-1" },
          { agent: "claude", sessionId: "s-2" },
        ],
      },
    });
    const store = jsonlEventStore(runDirOf(run.cwd, "demo"));
    await store.append({
      id: "e-start",
      ts: "2026-01-01T00:00:02.000Z",
      type: "hooks.session-start.called",
      source: "hooks",
      runId: run.id,
      payload: { agent: "claude", sessionId: "s-1", source: "startup" },
    });

    const res = await resume(deps, run.id);

    expect(res.status).toBe(200);
    expect(launches.map((options) => options.continueSession?.id)).toEqual(["s-1"]);
  });

  test.each(["running", "blocked"] as const)(
    "SC603: a %s run resumes with one launch",
    async (status) => {
      const { deps, launches } = await resumeDeps();
      const run = await seedRun(deps.registry, { status });

      const res = await resume(deps, run.id);

      expect(res.status).toBe(200);
      expect(launches).toHaveLength(1);
    },
  );

  test.each(["completed", "failed", "cancelled"] as const)(
    "SC603: a %s run is 409 conflict naming its status and telling the person to start a new run with yok run, and nothing launches",
    async (status) => {
      const { deps, launches } = await resumeDeps();
      const run = await seedRun(deps.registry, { status });

      const res = await resume(deps, run.id);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: {
          code: "conflict",
          message: `run demo is ${status}; there is nothing to resume, so start a new run with yok run`,
        },
      });
      expect(launches).toEqual([]);
    },
  );

  test("SC604: a switch to opus-x requested but never applied launches on haiku-x, the default tier's model", async () => {
    const { deps, launches } = await resumeDeps();
    const run = await seedRun(deps.registry, { applied: false });

    await resume(deps, run.id);

    expect(launches.map((options) => options.model)).toEqual(["haiku-x"]);
  });

  test("SC605: an unknown run id r-nope is 404 not-found and nothing launches", async () => {
    const { deps, launches } = await resumeDeps();

    const res = await resume(deps, "r-nope");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not-found", message: "no run with id r-nope" },
    });
    expect(launches).toEqual([]);
  });

  test.each<[string, Partial<WorkflowRun>]>([
    ["no name", { name: null }],
    ["no linked session", { sessions: [] }],
  ])(
    "SC606: a run with %s is 409 conflict telling the person to start it again with yok run",
    async (_label, overrides) => {
      const { deps, launches } = await resumeDeps();
      const run = await seedRun(deps.registry, { run: overrides });

      const res = await resume(deps, run.id);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: {
          code: "conflict",
          message: `run ${run.id} never started its agent session; start it again with yok run`,
        },
      });
      expect(launches).toEqual([]);
    },
  );

  test.each<[string, Partial<WorkflowRun>, (runDir: string) => void, (runDir: string) => string]>([
    [
      "a last session on pi",
      { sessions: [{ agent: "pi", sessionId: "s-1" }] },
      () => {},
      () => "run demo ran on pi, which yok cannot resume",
    ],
    [
      "a state.json that does not parse",
      {},
      (runDir) => writeFileSync(join(runDir, "state.json"), "garbage"),
      (runDir) => `run demo has no readable state in ${runDir}`,
    ],
  ])(
    "a run with %s is 409 conflict and nothing launches",
    async (_label, overrides, spoil, message) => {
      const { deps, launches } = await resumeDeps();
      const run = await seedRun(deps.registry, { run: overrides });
      const runDir = runDirOf(run.cwd, "demo");
      spoil(runDir);

      const res = await resume(deps, run.id);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: { code: "conflict", message: message(runDir) } });
      expect(launches).toEqual([]);
    },
  );

  test("SC608: a launch that fails with boom is 502 agent-failed and leaves the run in the registry unchanged", async () => {
    const deps = await buildDeps(() => Promise.resolve({ ok: false, error: "boom" }));
    const run = await seedRun(deps.registry);

    const res = await resume(deps, run.id);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: "agent-failed", message: "boom" } });
    expect(await deps.registry.findRun(run.id)).toEqual(run);
  });

  test("SC609: a run whose last session is codex asks for the codex provider and prompts $orchestrate --resume demo", async () => {
    const { deps, launches } = await resumeDeps();
    const run = await seedRun(deps.registry, {
      run: { sessions: [{ agent: "codex", sessionId: "s-1" }] },
    });

    await resume(deps, run.id);

    expect(deps.asked).toEqual(["codex"]);
    expect(launches.map((options) => options.prompt)).toEqual(["$orchestrate --resume demo"]);
  });

  test("SC607: a run whose tmux session is still alive is 409 conflict pointing at yok attach demo, and nothing launches", async () => {
    const { deps: base, launches } = await resumeDeps();
    const deps = { ...base, host: fakeHost("", true).host };
    const run = await seedRun(deps.registry);

    const res = await resume(deps, run.id);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "conflict",
        message: "run demo still has its agent session; use yok attach demo",
      },
    });
    expect(launches).toEqual([]);
  });

  test("SC633: a model-2.lock whose helper is dead is gone once resume returns 200", async () => {
    const { deps } = await resumeDeps();
    const run = await seedRun(deps.registry);
    const helper = Bun.spawn(["true"]);
    await helper.exited;
    const lock = join(runDirOf(run.cwd, "demo"), "locks", "model-2.lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, String(helper.pid));

    const res = await resume(deps, run.id);

    expect(res.status).toBe(200);
    expect(existsSync(lock)).toBe(false);
  });

  test("a comment posted while the session was down is typed into the resumed session once resume returns 200", async () => {
    const { deps: base, launches } = await resumeDeps();
    const typed: string[] = [];
    const pane = { ...fakePane("%9"), isAlive: () => Promise.resolve(launches.length > 0) };
    const deps = {
      ...base,
      host: { ...base.host, find: () => pane },
      providerFor: (agent: IAgentProvider["type"]) => ({
        ...base.providerFor(agent),
        promptWhenReady: (_pane: ITerminal, text: string) => {
          typed.push(text);
          return Promise.resolve({ ok: true as const, value: "sent" as const });
        },
      }),
    };
    const run = await seedRun(deps.registry);
    await addComments(
      runDirOf(run.cwd, "demo"),
      [{ file: "artifacts/a.md", kind: "global", text: "while away" }],
      new Date("2026-01-01T00:00:03.000Z"),
    );

    const res = await resume(deps, run.id);
    for (let i = 0; i < 20 && typed.length === 0; i++) await Bun.sleep(25);

    expect(res.status).toBe(200);
    expect(typed).toHaveLength(1);
    expect(typed[0]).toContain("while away");
  });

  test("a model-1.lock of a finished switch is gone once resume returns 200, though another live process now holds its pid", async () => {
    const { deps, launches } = await resumeDeps();
    const run = await seedRun(deps.registry);
    const lock = join(runDirOf(run.cwd, "demo"), "locks", "model-1.lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, String(process.pid));

    const res = await resume(deps, run.id);

    expect(res.status).toBe(200);
    expect(launches).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
  });

  test("a model-1.lock whose switch is still requested and whose helper is alive is 409 conflict asking to try again in a minute, and nothing launches", async () => {
    const { deps, launches } = await resumeDeps();
    const run = await seedRun(deps.registry, { applied: false });
    const lock = join(runDirOf(run.cwd, "demo"), "locks", "model-1.lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, String(process.pid));

    const res = await resume(deps, run.id);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "conflict",
        message: "run demo is still switching its model or context; try again in a minute",
      },
    });
    expect(launches).toEqual([]);
    expect(existsSync(lock)).toBe(true);
  });
});
