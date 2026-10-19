import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { captureLogger, type DoctorReport, loadStartEnv, summarize } from "@yok/core";
import type { Exec, IAgentProvider, ITerminal, LaunchOptions, Result, WorkflowRun } from "@yok/sdk";
import { createGit, execWithTimeout, noopLogger, runDirOf, WorkflowRunSchema } from "@yok/sdk";
import { createRegistry } from "@yok/sdk/internal";
import * as z from "zod";
import { createApp } from "./app.ts";
import { createYokClient } from "./client.ts";
import { EMPTY_BOX, fakeHost, seedState } from "./fake-host.ts";
import { AddProjectBodySchema } from "./protocol.ts";
import type { CheckCheckout } from "./server.ts";

type Workspace = Readonly<{ workflowPath: string; cwd: string }>;

// Registers PATH as project NAME in HOME, as yok project add would.
const addProjectEntry = (home: string, name: string, path: string): void =>
  appendFileSync(
    join(home, "projects.yaml"),
    `${name}:\n  path: ${path}\n  addedBy: { channel: api }\n  addedAt: 2026-01-01T00:00:00.000Z\n  verdict: READY\n`,
  );

const OK_NODES = [{ id: "a", type: "exec", runtime: "sh", script: "true", input: null }];
const okWorkflow = (extra: object = {}): string =>
  JSON.stringify({ name: "ok", nodes: OK_NODES, ...extra });

// A git checkout holding WORKFLOW as ok.yaml, registered in HOME as project "demo".
const tempWorkspace = (home: string, workflow = okWorkflow()): Workspace => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "yok-app-")));
  execFileSync("git", ["init", "-q"], { cwd });
  const workflowPath = join(cwd, "ok.yaml");
  writeFileSync(workflowPath, workflow);
  addProjectEntry(home, "demo", cwd);
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

const READY_REPORT: DoctorReport = summarize([]);

// READY, with the env the real loadStartEnv layers from the checkout, so env tests stay real.
const readyCheckout: CheckCheckout = async ({ cwd, config, plan }) => ({
  env: await loadStartEnv(config ?? null, cwd, plan ?? { env: {}, agent: "claude" }),
  report: READY_REPORT,
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
    log,
    home: mkdtempSync(join(tmpdir(), "yok-home-")),
    viewerOrigin: "http://localhost:1",
    pid: 4242,
    version: "0.0.0-test",
    startedAt: 1_700_000_000_000,
    apiKey: "test-key",
    host: fakeHost(EMPTY_BOX).host,
    git: createGit(),
    checkCheckout: readyCheckout,
  };
};

// The key buildDeps gives the app, on every request but the ones that test the key itself.
const authed = (headers: Record<string, string> = {}) => ({
  authorization: "Bearer test-key",
  ...headers,
});

const runBody = (extra: object = {}) =>
  JSON.stringify({ project: "demo", workflow: "ok.yaml", inputs: {}, ...extra });

const postRun = (app: ReturnType<typeof createApp>, extra: object = {}) =>
  app.request("/runs", {
    method: "POST",
    headers: authed({ "content-type": "application/json" }),
    body: runBody(extra),
  });

const launchesOk = (): Promise<Result<{ terminalName: string; terminal: ITerminal }>> =>
  Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } });

// A git repository at its real path, as the server stores a project's root.
const gitRepo = (prefix = "yok-project-"): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
};

// A real git whose clone of URL fetches a local bare repository holding FILES.
const gitServing = (url: string, files: Readonly<Record<string, string>>) => {
  const source = gitRepo("yok-source-");
  const commit = (...args: string[]) => execFileSync("git", args, { cwd: source });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(source, name), text);
  commit("add", ".");
  commit("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "first");
  const bare = `${mkdtempSync(join(tmpdir(), "yok-bare-"))}/repo.git`;
  execFileSync("git", ["clone", "-q", "--bare", source, bare]);
  const real = execWithTimeout(60_000);
  const swapUrl: Exec = (command, args, cwd) =>
    real(
      command,
      args.map((arg) => (arg === url ? bare : arg)),
      cwd,
    );
  return createGit(swapUrl);
};

const BLOCKED_REPORT: DoctorReport = summarize([
  {
    name: "orchestrate-config",
    status: "fail",
    optional: false,
    detail: "no orchestrate.config.yaml",
    fix: ["yok setup"],
  },
]);

const projectDeps = async (checkCheckout: CheckCheckout = readyCheckout) => {
  const calls: string[] = [];
  const deps = {
    ...(await buildDeps(() => Promise.resolve({ ok: false, error: "unused" }))),
    checkCheckout: ((input) => {
      calls.push(input.cwd);
      return checkCheckout(input);
    }) satisfies CheckCheckout,
  };
  return { deps, calls };
};

const post = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request("/projects", {
    method: "POST",
    headers: authed({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });

const listProjects = async (app: ReturnType<typeof createApp>) => {
  const res = await app.request("/projects", { headers: authed() });
  return ((await res.json()) as { projects: Array<Record<string, unknown>> }).projects;
};

const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error;

describe("POST /runs", () => {
  test.each([
    ["a body that is not JSON", "{not json"],
    ["an invalid supplied name", runBody({ name: "Bad/Name" })],
    ["a body with the old cwd field", runBody({ cwd: "/tmp" })],
  ])("%s is 400 bad-request and launches nothing", async (_label, body) => {
    let launched = false;
    const deps = await buildDeps(() => {
      launched = true;
      return launchesOk();
    });
    tempWorkspace(deps.home);

    const res = await createApp(deps).request("/runs", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body,
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad-request");
    expect(launched).toBe(false);
  });

  test("SC301: a run starts from a project name with only a workflow and a prompt, on the project's checkout", async () => {
    const seen: LaunchOptions[] = [];
    const deps = await buildDeps((options) => {
      seen.push(options);
      return Promise.resolve({
        ok: true,
        value: { terminalName: "session-xyz", terminal: fakePane("%7") },
      });
    });
    const { workflowPath, cwd } = tempWorkspace(deps.home);

    const res = await postRun(createApp(deps), { inputs: { prompt: "x" } });

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
      `/orchestrate --workflow ${workflowPath} --inputs ${JSON.stringify({ prompt: "x" })}`,
    );
    expect(launchOptions?.env?.YOK_RUN_ID).toBe(json.run.id);
    expect(await deps.registry.findRun(json.run.id)).toMatchObject({
      workflow: "ok",
      workflowPath,
      cwd,
      terminal: "session-xyz",
    });
  });

  test("SC302: a doctor that blocks refuses the run with its report, records nothing and marks the project blocked", async () => {
    let launched = false;
    const report = summarize([
      {
        name: "LINEAR_API_KEY",
        status: "fail",
        optional: false,
        detail: "not set",
        fix: ["add it to .env"],
      },
    ]);
    const deps = {
      ...(await buildDeps(() => {
        launched = true;
        return launchesOk();
      })),
      checkCheckout: (() =>
        Promise.resolve({ env: { ok: true, value: {} }, report })) satisfies CheckCheckout,
    };
    tempWorkspace(deps.home);
    const app = createApp(deps);

    const res = await postRun(app);

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as {
      error: { code: string; message: string; findings: DoctorReport };
    };
    expect(error.code).toBe("bad-request");
    expect(error.message).toBe("BLOCKED LINEAR_API_KEY");
    expect(error.findings.failed).toEqual(["LINEAR_API_KEY"]);
    expect(launched).toBe(false);
    expect(await deps.registry.listRuns()).toEqual([]);
    expect(await listProjects(app)).toEqual([
      expect.objectContaining({ name: "demo", status: "blocked" }),
    ]);
  });

  test("SC302: a checkout config broken after the project was added refuses the run with the doctor's report, not a config error", async () => {
    const deps = {
      ...(await buildDeps(launchesOk)),
      checkCheckout: (() =>
        Promise.resolve({
          env: { ok: true, value: {} },
          report: BLOCKED_REPORT,
        })) satisfies CheckCheckout,
    };
    const { cwd } = tempWorkspace(deps.home);
    writeFileSync(join(cwd, "orchestrate.config.yaml"), "version: 2\nnope: 1\n");

    const res = await postRun(createApp(deps));

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { findings?: DoctorReport } };
    expect(error.findings).toEqual(BLOCKED_REPORT);
    expect(await deps.registry.listRuns()).toEqual([]);
  });

  test.each([
    [
      "an unknown project",
      { project: "nope" },
      () => 'unknown project "nope"; known projects: demo',
    ],
    [
      "a missing workflow",
      { workflow: "missing.yaml" },
      (cwd: string) => `no workflow at ${join(cwd, "missing.yaml")}`,
    ],
    ["a workflow that is not valid YAML", { workflow: "bad.yaml" }, () => "yaml:"],
    [
      "a missing config file",
      { config: "missing.yaml" },
      (cwd: string) => join(cwd, "missing.yaml"),
    ],
    [
      "a workflow whose envFile is missing",
      { workflow: "envfile.yaml" },
      (cwd: string) => join(cwd, "missing.env"),
    ],
  ])("SC303: %s refuses the run with 400 and records nothing", async (_label, extra, holds) => {
    let launched = false;
    const deps = await buildDeps(() => {
      launched = true;
      return launchesOk();
    });
    const { cwd } = tempWorkspace(deps.home);
    writeFileSync(join(cwd, "bad.yaml"), "name: [unclosed\n");
    writeFileSync(join(cwd, "envfile.yaml"), okWorkflow({ envFile: "missing.env" }));

    const res = await postRun(createApp(deps), extra);

    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toContain(holds(cwd));
    expect(launched).toBe(false);
    expect(await deps.registry.listRuns()).toEqual([]);
  });

  test("SC304: no project named picks the only one, and with two the reply names them", async () => {
    const deps = await buildDeps(launchesOk);
    const { cwd } = tempWorkspace(deps.home);
    const app = createApp(deps);
    const body = { workflow: "ok.yaml", inputs: {} };
    const start = () =>
      app.request("/runs", {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: JSON.stringify(body),
      });

    const only = await start();
    addProjectEntry(deps.home, "other", gitRepo());
    const two = await start();

    expect(only.status).toBe(201);
    expect(((await only.json()) as { run: { cwd: string } }).run.cwd).toBe(cwd);
    expect(two.status).toBe(400);
    expect((await errorOf(two)).message).toBe("name a project; known projects: demo, other");
  });

  test("SC305: a codex workflow invokes the skill the way the agent does, with $orchestrate", async () => {
    let prompt: string | undefined;
    const deps = await buildDeps((options) => {
      prompt = options.prompt;
      return launchesOk();
    });
    const { workflowPath } = tempWorkspace(deps.home, okWorkflow({ agent: "codex" }));

    const res = await postRun(createApp(deps));

    expect(res.status).toBe(201);
    expect(prompt).toBe(`$orchestrate --workflow ${workflowPath} --inputs {}`);
  });

  test("SC305: the run is in the registry before its agent starts, so the agent's orchestrate init finds it", async () => {
    let savedAtLaunch: unknown;
    const deps = await buildDeps(async (options) => {
      savedAtLaunch = await deps.registry.findRun(String(options.env?.YOK_RUN_ID));
      return launchesOk();
    });
    const { workflowPath, cwd } = tempWorkspace(deps.home);

    const res = await postRun(createApp(deps));

    expect(res.status).toBe(201);
    expect(savedAtLaunch).toMatchObject({ workflowPath, cwd, sessions: [], name: null });
  });

  test("a config file in the body is resolved against the checkout and saved on the run; with none the run's config is null", async () => {
    const deps = await buildDeps(launchesOk);
    const { cwd } = tempWorkspace(deps.home);
    const app = createApp(deps);
    writeFileSync(join(cwd, "custom.json"), '{"version": 2}');

    const runOf = async (extra: object) =>
      z.object({ run: WorkflowRunSchema }).parse(await (await postRun(app, extra)).json()).run;
    const withConfig = await runOf({ config: "custom.json" });
    const without = await runOf({});

    expect(withConfig.config).toBe(join(cwd, "custom.json"));
    expect((await deps.registry.findRun(withConfig.id))?.config).toBe(join(cwd, "custom.json"));
    expect(without.config).toBeNull();
  });

  // Starts a run of a workflow whose agent is AGENT and whose tiers are TIERS, with the config
  // file CONFIG holds; gives back the reply and the launch options the provider saw.
  const startTiered = async (agent: string, config: string, tiers?: object) => {
    const seen: LaunchOptions[] = [];
    const deps = await buildDeps((options) => {
      seen.push(options);
      return launchesOk();
    });
    const workflow = okWorkflow({ agent, ...(tiers === undefined ? {} : { tiers }) });
    const { cwd } = tempWorkspace(deps.home, workflow);
    writeFileSync(join(cwd, "tiers.yaml"), config);
    const res = await postRun(createApp(deps), { config: "tiers.yaml" });
    const launched = seen.map(({ model, effort }) => ({ model, effort }));
    return { res, launched, deps };
  };

  test.each([
    [
      "SC305: a claude run with no tiers anywhere launches on the built-in deep tier",
      "claude",
      "version: 2\n",
      { model: "claude-opus-5-5", effort: "high" },
    ],
    [
      "SC305: a codex run with no tiers anywhere launches on the built-in deep tier",
      "codex",
      "version: 2\n",
      { model: "gpt-6-sol", effort: "high" },
    ],
    [
      "SC305: a codex run launches on the model and effort of its config's default tier",
      "codex",
      "version: 2\nagents:\n  codex:\n    tiers:\n      default: deep\n      models:\n        deep: { model: gpt-5-codex, effort: high }\n",
      { model: "gpt-5-codex", effort: "high" },
    ],
  ] as const)("%s", async (_label, agent, config, model) => {
    const { res, launched } = await startTiered(agent, config);

    expect(res.status).toBe(201);
    expect(launched).toEqual([model]);
  });

  test("SC305: the run saved at start holds the built-in, config and workflow tiers merged, and launches on its default fast tier's haiku-x", async () => {
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

  test.each([
    [undefined, undefined, undefined, true, "default"],
    [false, undefined, undefined, false, "config"],
    [false, true, undefined, true, "workflow"],
    [true, true, false, false, "cli"],
  ] as const)(
    "SC601: interaction set to %p in the config, %p in the workflow and %p in the request is saved as %p from %p",
    async (config, workflow, request, value, source) => {
      const deps = await buildDeps(launchesOk);
      const layer = (interaction: boolean | undefined) =>
        interaction === undefined ? {} : { policies: { interaction } };
      const { cwd } = tempWorkspace(deps.home, okWorkflow(layer(workflow)));
      const configText = config === undefined ? "" : `policies:\n  interaction: ${config}\n`;
      writeFileSync(join(cwd, "policy.yaml"), `version: 2\n${configText}`);

      const res = await postRun(createApp(deps), { config: "policy.yaml", ...layer(request) });

      expect(res.status).toBe(201);
      const { run } = z.object({ run: WorkflowRunSchema }).parse(await res.json());
      const policies = { values: { interaction: value }, sources: { interaction: source } };
      expect(run.policies).toEqual(policies);
      expect((await deps.registry.findRun(run.id))?.policies).toEqual(policies);
    },
  );

  test.each([
    ["SC602: a policy value that is not a boolean", { policies: { interaction: "maybe" } }],
  ])("%s is 400 bad-request and saves no run", async (_label, extra) => {
    const deps = await buildDeps(launchesOk);
    tempWorkspace(deps.home);

    const res = await postRun(createApp(deps), extra);

    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("bad-request");
    expect(await deps.registry.listRuns()).toEqual([]);
  });

  test("SC305: the session starts with the checkout's .env, under yok's own variables", async () => {
    const seen: LaunchOptions[] = [];
    const deps = await buildDeps((options) => {
      seen.push(options);
      return launchesOk();
    });
    const { cwd } = tempWorkspace(deps.home);
    writeFileSync(join(cwd, ".env"), "API_URL=http://x\nYOK_RUN_ID=spoofed\n");

    const res = await postRun(createApp(deps));

    expect(res.status).toBe(201);
    const { run } = z.object({ run: WorkflowRunSchema }).parse(await res.json());
    expect(seen[0]?.env).toEqual({
      API_URL: "http://x",
      PATH: expect.stringContaining(join(deps.home, "shims")),
      YOK_RUN_ID: run.id,
      YOK_HOME: deps.home,
    });
  });

  test("SC66, SC305: from source, a run's session gets a shim folder under the home first on PATH, holding an executable yok, and the repo as its plugin folder", async () => {
    const seen: LaunchOptions[] = [];
    const deps = await buildDeps((options) => {
      seen.push(options);
      return launchesOk();
    });
    tempWorkspace(deps.home);

    const res = await postRun(createApp(deps));

    expect(res.status).toBe(201);
    const { run } = z.object({ run: WorkflowRunSchema }).parse(await res.json());
    const [shimDir = ""] = (seen[0]?.env?.PATH ?? "").split(delimiter);
    expect(dirname(shimDir)).toBe(join(deps.home, "shims"));
    accessSync(join(shimDir, "yok"), constants.X_OK);
    expect(seen[0]?.env?.YOK_RUN_ID).toBe(run.id);
    const pluginDir = seen[0]?.pluginDir ?? "";
    expect(existsSync(join(pluginDir, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  test("a workflow whose tiers default names a tier no layer maps is 400 and launches nothing", async () => {
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
    const deps = await buildDeps(() => Promise.resolve({ ok: false, error: "boom" }));
    tempWorkspace(deps.home);

    const res = await postRun(createApp(deps));

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("agent-failed");
    const saved = existsSync(deps.registryPath)
      ? JSON.parse(readFileSync(deps.registryPath, "utf8")).runs
      : {};
    expect(saved).toEqual({});
  });

  test("a handler that throws answers 500 with an internal error body and logs it", async () => {
    const { log, at } = captureLogger();
    const deps = await buildDeps(() => Promise.reject(new Error("tmux timed out")), log);
    tempWorkspace(deps.home);

    const res = await postRun(createApp(deps));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "internal", message: "tmux timed out" } });
    expect(at("error").some((line) => line.msg === "request failed with an unexpected error")).toBe(
      true,
    );
    expect(JSON.parse(readFileSync(deps.registryPath, "utf8")).runs).toEqual({});
  });
});

describe("API key", () => {
  test.each([
    ["no authorization header", {}],
    ["a wrong key", { authorization: "Bearer wrong" }],
    ["a key much longer than the right one", { authorization: `Bearer ${"x".repeat(500)}` }],
  ])("SC102: POST /runs with %s is 401 unauthorized and launches nothing", async (_label, auth) => {
    let launched = false;
    const deps = await buildDeps(() => {
      launched = true;
      return launchesOk();
    });
    tempWorkspace(deps.home);

    const res = await createApp(deps).request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: runBody(),
    });

    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
    expect(launched).toBe(false);
    expect(await deps.registry.listRuns()).toEqual([]);
  });

  test("SC103: GET /health answers 200 without a key", async () => {
    const deps = await buildDeps(() => Promise.resolve({ ok: false, error: "unused" }));

    const res = await createApp(deps).request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pid: 4242,
      version: "0.0.0-test",
      startedAt: 1_700_000_000_000,
    });
  });

  test("SC110: no log line carries the right key or a wrong one", async () => {
    const { log, lines } = captureLogger();
    const deps = await buildDeps(() => Promise.resolve({ ok: false, error: "unused" }), log);
    const app = createApp(deps);

    await app.request("/runs/view", { headers: authed() });
    await app.request("/runs/view", { headers: { authorization: "Bearer wrong-key-value" } });

    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain("test-key");
    expect(JSON.stringify(lines)).not.toContain("wrong-key-value");
  });
});

describe("POST /runs logging", () => {
  test("no log line carries an env value from the checkout's .env", async () => {
    const { log, lines } = captureLogger();
    const deps = await buildDeps(launchesOk, log);
    const { cwd } = tempWorkspace(deps.home);
    writeFileSync(join(cwd, ".env"), "API_KEY=top-secret-value\n");

    const res = await postRun(createApp(deps));

    expect(res.status).toBe(201);
    expect(JSON.stringify(lines)).not.toContain("top-secret-value");
  });

  test("SC36: a working provider logs 'run started' and an http 201 line with x-request-id", async () => {
    const { log, at } = captureLogger();
    const deps = await buildDeps(launchesOk, log);
    tempWorkspace(deps.home);

    const res = await postRun(createApp(deps));

    expect(res.headers.get("x-request-id")).toBeString();
    const runStarted = at("info").find((line) => line.msg === "run started");
    expect(runStarted).toMatchObject({ runId: expect.any(String), terminalName: "s1" });
    const httpLine = at("info").find(
      (line) => line.component === "http" && line.msg === "request finished",
    );
    expect(httpLine).toMatchObject({ status: 201 });
  });

  test("SC36: a failing provider logs one error line 'launch failed'", async () => {
    const { log, at } = captureLogger();
    const deps = await buildDeps(() => Promise.resolve({ ok: false, error: "boom" }), log);
    tempWorkspace(deps.home);

    await postRun(createApp(deps));

    const failures = at("error").filter(
      (line) => line.msg === "run not started: the agent session failed to launch",
    );
    expect(failures).toHaveLength(1);
  });
});

describe("createYokClient", () => {
  const serveOn = (fetch: (request: Request) => Response | Promise<Response>) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
    return { url: `http://127.0.0.1:${server.port}`, server };
  };

  test("SC104: calls the real routes over loopback HTTP with the key and returns their typed bodies", async () => {
    const deps = await buildDeps(launchesOk);
    const { cwd } = tempWorkspace(deps.home);
    const { url, server } = serveOn(createApp(deps).fetch);
    try {
      const client = createYokClient({ url, apiKey: "test-key" });

      const health = await client.health();
      expect(health).toEqual({
        ok: true,
        value: { pid: 4242, version: "0.0.0-test", startedAt: 1_700_000_000_000 },
      });
      expect(await client.viewRuns()).toEqual({ ok: true, value: { view: "http://localhost:1/" } });

      const started = await client.run({ project: "demo", workflow: "ok.yaml", inputs: {} });
      expect(started.ok && started.value.run.sessions).toEqual([]);

      const refused = await client.run({ project: "demo", workflow: "missing.yaml", inputs: {} });
      expect(refused).toEqual({
        ok: false,
        error: { code: "bad-request", message: `no workflow at ${join(cwd, "missing.yaml")}` },
      });
    } finally {
      await server.stop(true);
    }
  });

  test("the key goes on every request but /health, so whatever holds the port learns nothing from a health check", async () => {
    const seen: Array<readonly [string, string | null]> = [];
    const { url, server } = serveOn((request) => {
      seen.push([new URL(request.url).pathname, request.headers.get("authorization")]);
      return Response.json({});
    });
    try {
      const client = createYokClient({ url, apiKey: "test-key" });
      await client.health();
      await client.viewRuns();
    } finally {
      await server.stop(true);
    }

    expect(seen).toEqual([
      ["/health", null],
      ["/runs/view", "Bearer test-key"],
    ]);
  });

  test("SC104: a wrong key comes back as an unauthorized error", async () => {
    const deps = await buildDeps(() => Promise.resolve({ ok: false, error: "unused" }));
    const { url, server } = serveOn(createApp(deps).fetch);
    try {
      expect(await createYokClient({ url, apiKey: "wrong" }).viewRuns()).toEqual({
        ok: false,
        error: { code: "unauthorized", message: "missing or wrong API key" },
      });
    } finally {
      await server.stop(true);
    }
  });

  test("a non-JSON error reply comes back as an internal error, not a thrown parse error", async () => {
    const { url, server } = serveOn(() => new Response("Internal Server Error", { status: 500 }));
    try {
      expect(await createYokClient({ url, apiKey: "test-key" }).health()).toEqual({
        ok: false,
        error: { code: "internal", message: "500 Internal Server Error" },
      });
    } finally {
      await server.stop(true);
    }
  });

  test("SC104: nothing listening at the URL is an unreachable error", async () => {
    expect(await createYokClient({ url: "http://127.0.0.1:1", apiKey: "k" }).health()).toEqual({
      ok: false,
      error: { code: "internal", message: "server unreachable" },
    });
  });
});

describe("run page URL", () => {
  test("SC11: POST /runs returns the page URL, GET /runs/:id/view returns it later, and a missing run is 404", async () => {
    const deps = { ...(await buildDeps(launchesOk)), viewerOrigin: "http://localhost:4321" };
    tempWorkspace(deps.home);
    const app = createApp(deps);

    const started = await postRun(app);
    const { run, view } = (await started.json()) as { run: { id: string }; view: string };
    expect(view).toBe(`http://localhost:4321/runs/${run.id}`);

    const again = await app.request(`/runs/${run.id}/view`, { headers: authed() });
    expect(await again.json()).toEqual({ view });

    const missing = await app.request("/runs/r-missing/view", { headers: authed() });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("not-found");
  });
});

describe("AddProjectBodySchema", () => {
  test.each(["https://github.com/o/r.git", "ssh://git@h/o/r", "git@github.com:o/r.git"])(
    "SC202: accepts the git URL %s",
    (git) => {
      expect(AddProjectBodySchema.safeParse({ name: "demo", git }).success).toBe(true);
    },
  );

  test.each(["file:///etc", "/srv/repo", "ext::sh -c id", "--upload-pack=x"])(
    "SC202: refuses the git URL %s with the URL message",
    (git) => {
      const parsed = AddProjectBodySchema.safeParse({ name: "demo", git });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe("must be an https, ssh or user@host: URL");
    },
  );

  test.each(["https://user:token@github.com/o/r.git", "ssh://git:pw@h/o/r"])(
    "refuses the git URL %s, which holds a password every GET /projects would echo",
    (git) => {
      const parsed = AddProjectBodySchema.safeParse({ name: "demo", git });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe(
        "must not hold a password; use a git credential helper or an ssh key",
      );
    },
  );
});

describe("/projects", () => {
  test("SC203: a checkout is added without running the doctor, and listed as ready", async () => {
    const root = gitRepo();
    const { deps, calls } = await projectDeps();
    const app = createApp(deps);

    const res = await post(app, { name: "demo", path: root });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      project: expect.objectContaining({ path: root, status: "ready" }),
    });
    expect(calls).toEqual([]);
    expect(readdirSync(root)).toEqual([".git"]);
    expect(await listProjects(app)).toEqual([
      expect.objectContaining({
        name: "demo",
        path: root,
        addedBy: { channel: "api" },
        status: "ready",
      }),
    ]);
  });

  test("SC204: a git URL is cloned into the home and added, and the same URL again is refused", async () => {
    const url = "https://example.test/demo.git";
    const { deps } = await projectDeps();
    const app = createApp({ ...deps, git: gitServing(url, { "README.md": "hi\n" }) });

    const res = await post(app, { name: "demo", git: url });
    const again = await post(app, { name: "demo2", git: url });

    expect(res.status).toBe(201);
    const { project } = (await res.json()) as { project: { path: string; git: string } };
    expect(project.path).toBe(join(realpathSync(deps.home), "projects", "demo"));
    expect(project.git).toBe(url);
    expect(readFileSync(join(project.path, "README.md"), "utf8")).toBe("hi\n");
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("conflict");
    expect(existsSync(join(deps.home, "projects", "demo2"))).toBe(false);
  });

  const refusals: ReadonlyArray<
    readonly [string, (taken: string) => Record<string, unknown>, number, string]
  > = [
    ["a taken name", () => ({ name: "taken", path: gitRepo() }), 409, "conflict"],
    ["a path already a project", (taken) => ({ name: "other", path: taken }), 409, "conflict"],
    ["a missing path", () => ({ name: "other", path: "/no/such/folder" }), 400, "bad-request"],
    [
      "a plain folder",
      () => ({ name: "other", path: mkdtempSync(join(tmpdir(), "yok-plain-")) }),
      400,
      "bad-request",
    ],
    [
      "a subfolder of a repository",
      () => {
        const sub = join(gitRepo(), "sub");
        mkdirSync(sub);
        return { name: "other", path: sub };
      },
      400,
      "bad-request",
    ],
    [
      "an invalid orchestrate.config.yaml",
      () => {
        const root = gitRepo();
        writeFileSync(join(root, "orchestrate.config.yaml"), "version: 2\nnope: 1\n");
        return { name: "other", path: root };
      },
      400,
      "bad-request",
    ],
    ["neither git nor path", () => ({ name: "other" }), 400, "bad-request"],
    [
      "a clone name too long for the file system",
      () => ({ name: "a".repeat(300), git: "https://example.test/long.git" }),
      400,
      "bad-request",
    ],
  ];

  test.each(refusals)(
    "SC205: %s is refused with no entry saved and no doctor run",
    async (_label, body, status, code) => {
      const taken = gitRepo();
      const { deps, calls } = await projectDeps();
      const app = createApp(deps);
      expect((await post(app, { name: "taken", path: taken })).status).toBe(201);
      const before = await listProjects(app);

      const res = await post(app, body(taken));

      expect(res.status).toBe(status);
      expect((await errorOf(res)).code).toBe(code);
      expect(await listProjects(app)).toEqual(before);
      expect(calls).toEqual([]);
    },
  );

  test("SC204: while a clone is still running, other adds go through and a second add of its name is refused without cloning", async () => {
    const { deps } = await projectDeps();
    const clones: string[] = [];
    const { promise: cloneHeld, resolve: releaseClone } = Promise.withResolvers<void>();
    const slowClone = async (_cwd: string, _url: string, dest: string): Promise<Result<void>> => {
      clones.push(dest);
      await cloneHeld;
      execFileSync("git", ["init", "-q", dest]);
      return { ok: true, value: undefined };
    };
    const app = createApp({ ...deps, git: { ...deps.git, clone: slowClone } });

    const slow = post(app, { name: "big", git: "https://example.test/big.git" });
    await Bun.sleep(50);
    const other = await Promise.race([
      Promise.resolve(post(app, { name: "small", path: gitRepo() })).then((res) => res.status),
      Bun.sleep(2_000).then(() => "blocked"),
    ]);
    const twin = await post(app, { name: "big", git: "https://example.test/big2.git" });
    releaseClone();

    expect(other).toBe(201);
    expect(twin.status).toBe(409);
    expect((await slow).status).toBe(201);
    expect(clones).toEqual([join(deps.home, "projects", "big")]);
    expect((await listProjects(app)).map((project) => project.name).sort()).toEqual([
      "big",
      "small",
    ]);
  });

  test("SC204: a run start and a project remove answer while a clone is still running", async () => {
    const { deps } = await projectDeps();
    tempWorkspace(deps.home);
    addProjectEntry(deps.home, "spare", gitRepo());
    const { promise: cloneHeld, resolve: releaseClone } = Promise.withResolvers<void>();
    const slowClone = async (_cwd: string, _url: string, dest: string): Promise<Result<void>> => {
      await cloneHeld;
      execFileSync("git", ["init", "-q", dest]);
      return { ok: true, value: undefined };
    };
    const app = createApp({ ...deps, git: { ...deps.git, clone: slowClone } });
    const within2s = (res: Response | Promise<Response>) =>
      Promise.race([
        Promise.resolve(res).then((answered) => answered.status),
        Bun.sleep(2_000).then(() => "blocked"),
      ]);

    const slow = post(app, { name: "big", git: "https://example.test/big.git" });
    await Bun.sleep(50);
    const started = await within2s(postRun(app));
    const removed = await within2s(
      app.request("/projects/spare", { method: "DELETE", headers: authed() }),
    );
    releaseClone();

    expect(started).not.toBe("blocked");
    expect(removed).toBe(200);
    expect((await slow).status).toBe(201);
  });

  test("SC205: a clone into the folder of a project whose checkout is gone is refused 409 and the clone removed", async () => {
    const { deps } = await projectDeps();
    const path = join(mkdtempSync(join(tmpdir(), "yok-gone-")), "checkout");
    addProjectEntry(deps.home, "old", path);
    const initClone = async (_cwd: string, _url: string, dest: string): Promise<Result<void>> => {
      execFileSync("git", ["init", "-q", dest]);
      return { ok: true, value: undefined };
    };
    const app = createApp({ ...deps, git: { ...deps.git, clone: initClone } });

    const res = await post(app, { name: "other", git: "https://example.test/o.git", path });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe(`${path} is already project old`);
    expect(existsSync(path)).toBe(false);
  });

  test("SC205: a clone whose orchestrate.config.yaml is invalid is refused 400 and its folder removed", async () => {
    const url = "https://example.test/bad.git";
    const bad = { "orchestrate.config.yaml": "version: 2\nnope: 1\n" };
    const { deps } = await projectDeps();
    const app = createApp({ ...deps, git: gitServing(url, bad) });

    const res = await post(app, { name: "bad", git: url });

    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("bad-request");
    expect(existsSync(join(deps.home, "projects", "bad"))).toBe(false);
    expect(await listProjects(app)).toEqual([]);
  });

  test("SC206: a clone that fails removes its folder and answers 502 git-failed", async () => {
    const { deps, calls } = await projectDeps();
    const app = createApp(deps);

    const res = await post(app, { name: "none", git: "https://127.0.0.1:1/none.git" });

    expect(res.status).toBe(502);
    const error = await errorOf(res);
    expect(error.code).toBe("git-failed");
    expect(error.message).toContain("127.0.0.1");
    expect(existsSync(join(deps.home, "projects", "none"))).toBe(false);
    expect(await listProjects(app)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("SC207: a project with a live run cannot be removed until the run's terminal is gone", async () => {
    const root = gitRepo();
    const { deps } = await projectDeps();
    expect((await post(createApp(deps), { name: "demo", path: root })).status).toBe(201);
    const run: WorkflowRun = {
      id: "r-live",
      workflow: "ok",
      workflowPath: join(root, "ok.yaml"),
      inputs: {},
      cwd: root,
      sessions: [{ agent: "claude", sessionId: "s1" }],
      name: "demo-run",
      terminal: "t1",
      config: null,
      tiers: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await deps.registry.addRun(run);
    const remove = (app: ReturnType<typeof createApp>) =>
      app.request("/projects/demo", { method: "DELETE", headers: authed() });
    const alive = createApp({ ...deps, host: fakeHost(EMPTY_BOX, true).host });
    const gone = createApp({ ...deps, host: fakeHost(EMPTY_BOX, false).host });

    const refused = await remove(alive);
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).message).toContain("r-live");
    expect((await listProjects(alive)).map((project) => project.name)).toEqual(["demo"]);

    const removed = await remove(gone);
    expect(removed.status).toBe(200);
    expect(await listProjects(gone)).toEqual([]);
  });

  test.each([
    ["started a moment ago holds it", new Date().toISOString(), 409],
    ["left starting for over ten minutes does not", "2026-01-01T00:00:00.000Z", 200],
  ])("SC207: a run still starting with no terminal yet, %s", async (_case, createdAt, status) => {
    const root = gitRepo();
    const { deps } = await projectDeps();
    const app = createApp(deps);
    expect((await post(app, { name: "demo", path: root })).status).toBe(201);
    await deps.registry.addRun({
      id: "r-starting",
      workflow: "ok",
      workflowPath: join(root, "ok.yaml"),
      inputs: {},
      cwd: root,
      sessions: [],
      name: null,
      terminal: null,
      config: null,
      tiers: null,
      createdAt,
    });

    const res = await app.request("/projects/demo", { method: "DELETE", headers: authed() });

    expect(res.status).toBe(status);
  });

  test("SC207: a project removed while its run is being checked stops the start, recording and launching nothing", async () => {
    let launched = false;
    const base = await buildDeps(() => {
      launched = true;
      return launchesOk();
    });
    const deps = {
      ...base,
      checkCheckout: (async (input) => {
        await createApp(base).request("/projects/demo", { method: "DELETE", headers: authed() });
        return readyCheckout(input);
      }) satisfies CheckCheckout,
    };
    tempWorkspace(deps.home);

    const res = await postRun(createApp(deps));

    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toContain("demo");
    expect(launched).toBe(false);
    expect(await deps.registry.listRuns()).toEqual([]);
  });

  test("SC207: a run that has finished does not hold its project, though its session is still open", async () => {
    const root = gitRepo();
    const { deps } = await projectDeps();
    const app = createApp({ ...deps, host: fakeHost(EMPTY_BOX, true).host });
    expect((await post(app, { name: "demo", path: root })).status).toBe(201);
    const runDir = runDirOf(root, "demo-run");
    mkdirSync(runDir, { recursive: true });
    const state = { ...seedState(runDir, {}), status: "completed" };
    writeFileSync(join(runDir, "state.json"), JSON.stringify(state));
    await deps.registry.addRun({
      id: "r-done",
      workflow: "ok",
      workflowPath: join(root, "ok.yaml"),
      inputs: {},
      cwd: root,
      sessions: [{ agent: "claude", sessionId: "s1" }],
      name: "demo-run",
      terminal: "t1",
      config: null,
      tiers: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const res = await app.request("/projects/demo", { method: "DELETE", headers: authed() });

    expect(res.status).toBe(200);
    expect(await listProjects(app)).toEqual([]);
  });

  test("SC208: purge deletes a folder yok cloned and keeps one it did not, even one added by path inside the clones folder", async () => {
    const { deps } = await projectDeps();
    const cloned = join(deps.home, "projects", "cloned");
    const placed = join(deps.home, "projects", "placed");
    mkdirSync(cloned, { recursive: true });
    mkdirSync(placed, { recursive: true });
    const outside = gitRepo();
    const entry = (path: string, git = "") =>
      `  path: ${path}\n${git}  addedBy: { channel: api }\n  addedAt: 2026-01-01T00:00:00.000Z\n  verdict: READY\n`;
    writeFileSync(
      join(deps.home, "projects.yaml"),
      `cloned:\n${entry(cloned, "  git: https://example.test/cloned.git\n")}outside:\n${entry(outside)}placed:\n${entry(placed)}`,
    );
    const app = createApp(deps);
    const purge = async (name: string) => {
      const res = await app.request(`/projects/${name}?purge=true`, {
        method: "DELETE",
        headers: authed(),
      });
      return res.json();
    };

    expect(await purge("cloned")).toEqual({ removed: "cloned", purged: true, note: null });
    expect(await purge("outside")).toEqual({
      removed: "outside",
      purged: false,
      note: `kept ${outside}: yok deletes only the folders it cloned`,
    });
    expect(await purge("placed")).toEqual({
      removed: "placed",
      purged: false,
      note: `kept ${placed}: yok deletes only the folders it cloned`,
    });
    expect(existsSync(cloned)).toBe(false);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(placed)).toBe(true);
  });

  test("SC208: purge keeps the target of a symlink in the clones folder, even one registered with a git URL", async () => {
    const { deps } = await projectDeps();
    const target = gitRepo();
    const link = join(deps.home, "projects", "link");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link);
    writeFileSync(
      join(deps.home, "projects.yaml"),
      `link:\n  path: ${link}\n  git: https://example.test/link.git\n  addedBy: { channel: api }\n  addedAt: 2026-01-01T00:00:00.000Z\n  verdict: READY\n`,
    );

    const res = await createApp(deps).request("/projects/link?purge=true", {
      method: "DELETE",
      headers: authed(),
    });

    expect(await res.json()).toMatchObject({ removed: "link", purged: false });
    expect(readdirSync(target)).toEqual([".git"]);
  });

  test("SC210: a project whose folder is gone is listed as missing", async () => {
    const { deps } = await projectDeps();
    writeFileSync(
      join(deps.home, "projects.yaml"),
      "gone:\n  path: /no/such/checkout\n  addedBy: { channel: cli }\n  addedAt: 2026-01-01T00:00:00.000Z\n  verdict: READY\n",
    );

    expect(await listProjects(createApp(deps))).toEqual([
      expect.objectContaining({ name: "gone", status: "missing" }),
    ]);
  });

  test.each([
    ["GET", "/projects"],
    ["POST", "/projects"],
    ["DELETE", "/projects/x"],
  ])("SC211: %s %s without the key is 401", async (method, path) => {
    const { deps } = await projectDeps();

    const res = await createApp(deps).request(path, { method });

    expect(res.status).toBe(401);
  });
});
