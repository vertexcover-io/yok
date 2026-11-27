import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import {
  accessSync,
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
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  captureLogger,
  compilePlan,
  type DoctorReport,
  loadStartEnv,
  summarize,
  unwrap,
} from "@yok/core";
import type {
  Exec,
  IAgentProvider,
  ITerminal,
  LaunchOptions,
  Result,
  State,
  WorkflowRun,
} from "@yok/sdk";
import {
  createGit,
  type Event,
  EventSchema,
  execWithTimeout,
  type IStorage,
  noopLogger,
  runDirOf,
  sessionEnv,
  WorkflowRunSchema,
} from "@yok/sdk";
import { type EventDraft, memoryStorage } from "@yok/sdk/internal";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import * as z from "zod";
import { createApi } from "./app.ts";
import { createYokClient } from "./client.ts";
import { type DispatchDeps, dispatchCommand } from "./dispatch.ts";
import {
  EMPTY_BOX,
  fakeHost,
  fakePane,
  fakeProvider,
  seedState,
  seedUser,
  seedRun as storeRun,
} from "./fake-host.ts";
import { hashToken, sessionSecret, signValue } from "./identity.ts";
import { AddProjectBodySchema, ErrorBodySchema, type ListRunsQuery } from "./protocol.ts";
import { type Reply, replyText } from "./render.ts";
import { startProjectRun } from "./run.ts";
import { type CheckCheckout, checkCheckoutWith, createRoot } from "./server.ts";

type Workspace = Readonly<{ workflowPath: string; cwd: string }>;

// Registers PATH as project NAME, as yok project add would, cloned from GIT when given.
const addProjectEntry = async (
  storage: IStorage,
  name: string,
  path: string,
  git?: string,
): Promise<void> => {
  const project = { path, ...(git === undefined ? {} : { git }), addedBy: { channel: "api" } };
  unwrap(await storage.projects.add(name, { ...project, addedAt: "2026-01-01T00:00:00.000Z" }));
};

const OK_NODES = [{ id: "a", type: "exec", runtime: "sh", script: "true", input: null }];
const okWorkflow = (extra: object = {}): string =>
  JSON.stringify({
    name: "ok",
    inputs: { prompt: { type: "string", required: false } },
    nodes: OK_NODES,
    ...extra,
  });

// A git checkout holding WORKFLOW as ok.yaml, registered as project "demo".
const tempWorkspace = async (storage: IStorage, workflow = okWorkflow()): Promise<Workspace> => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "yok-app-")));
  execFileSync("git", ["init", "-q"], { cwd });
  const workflowPath = join(cwd, "ok.yaml");
  writeFileSync(workflowPath, workflow);
  await addProjectEntry(storage, "demo", cwd);
  return { workflowPath, cwd };
};

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
  // in the home, as the server keeps it: sessionEnv looks a run's owner up there
  const home = mkdtempSync(join(tmpdir(), "yok-home-"));
  const asked: string[] = [];
  return {
    asked,
    providerFor: (agent: IAgentProvider["type"]) => {
      asked.push(agent);
      return fakeProvider(agent, launch);
    },
    // the run's tmux session is gone unless a test says otherwise
    host: fakeHost("", false).host,
    log,
    home,
    storage: memoryStorage(),
    publicOrigin: "http://localhost:1",
    pid: 4242,
    version: "0.0.0-test",
    startedAt: 1_700_000_000_000,
    stopping: new AbortController().signal,
    git: createGit(),
    checkCheckout: readyCheckout,
    now: () => new Date(),
  };
};

const runBody = (extra: object = {}) =>
  JSON.stringify({ project: "demo", workflow: "ok.yaml", inputs: {}, ...extra });

const postRun = (app: ReturnType<typeof createApi>, extra: object = {}) =>
  app.request("/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
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

const post = (app: ReturnType<typeof createApi>, body: unknown) =>
  app.request("/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const listProjects = async (app: ReturnType<typeof createApi>) => {
  const res = await app.request("/projects");
  return ((await res.json()) as { projects: Array<Record<string, unknown>> }).projects;
};

const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error;

describe("POST /runs", () => {
  test("SC32 (regression): a run started through POST /runs records no owner and keeps the project's GH_TOKEN and the server's gh config", async () => {
    const launches: LaunchOptions[] = [];
    const deps = await buildDeps((options) => {
      launches.push(options);
      return launchesOk();
    });
    const { cwd } = await tempWorkspace(deps.storage);
    writeFileSync(join(cwd, ".env"), "GH_TOKEN=server\n");

    expect((await postRun(createApi(deps))).status).toBe(201);

    const [run] = await deps.storage.runs.listRuns();
    expect(run).not.toHaveProperty("user");
    expect(launches[0]?.env?.GH_TOKEN).toBe("server");
    expect(launches[0]?.env).not.toHaveProperty("GH_CONFIG_DIR");
  });

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
    await tempWorkspace(deps.storage);

    const res = await createApi(deps).request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
    const { workflowPath, cwd } = await tempWorkspace(deps.storage);

    const res = await postRun(createApi(deps), { inputs: { prompt: "x" } });

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
    expect(await deps.storage.runs.findRun(json.run.id)).toMatchObject({
      workflow: "ok",
      workflowPath,
      cwd,
      terminal: "session-xyz",
      source: "api",
    });
  });

  test("SC302, SC2013: a doctor that blocks refuses the run with its report, records nothing and leaves the projects unchanged and the project ready", async () => {
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
    await tempWorkspace(deps.storage);
    const app = createApi(deps);
    const before = await deps.storage.projects.list();

    const res = await postRun(app);

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as {
      error: { code: string; message: string; details: DoctorReport };
    };
    expect(error.code).toBe("bad-request");
    expect(error.message).toBe("BLOCKED LINEAR_API_KEY");
    expect(error.details.failed).toEqual(["LINEAR_API_KEY"]);
    expect(launched).toBe(false);
    expect(await deps.storage.runs.listRuns()).toEqual([]);
    expect(await deps.storage.projects.list()).toEqual(before);
    expect(await listProjects(app)).toEqual([
      expect.objectContaining({ name: "demo", status: "ready" }),
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
    const { cwd } = await tempWorkspace(deps.storage);
    writeFileSync(join(cwd, "orchestrate.config.yaml"), "version: 2\nnope: 1\n");

    const res = await postRun(createApi(deps));

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { details?: DoctorReport } };
    expect(error.details).toEqual(BLOCKED_REPORT);
    expect(await deps.storage.runs.listRuns()).toEqual([]);
  });

  test.each([
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
    const { cwd } = await tempWorkspace(deps.storage);
    writeFileSync(join(cwd, "bad.yaml"), "name: [unclosed\n");
    writeFileSync(join(cwd, "envfile.yaml"), okWorkflow({ envFile: "missing.env" }));

    const res = await postRun(createApi(deps), extra);

    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toContain(holds(cwd));
    expect(launched).toBe(false);
    expect(await deps.storage.runs.listRuns()).toEqual([]);
  });

  test("SC2003: a start that names no project is 400 and names no project, even when only one exists", async () => {
    let launched = false;
    const deps = await buildDeps(() => {
      launched = true;
      return launchesOk();
    });
    await tempWorkspace(deps.storage);

    const res = await createApi(deps).request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok.yaml", inputs: {} }),
    });

    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe("bad-request");
    expect(error.message).toContain("project");
    expect(error.message).not.toContain("demo");
    expect(launched).toBe(false);
    expect(await deps.storage.runs.listRuns()).toEqual([]);
  });

  test("SC2004: a start on an unknown project is 400 naming only that project", async () => {
    let launched = false;
    const deps = await buildDeps(() => {
      launched = true;
      return launchesOk();
    });
    await tempWorkspace(deps.storage);
    await addProjectEntry(deps.storage, "other", gitRepo());

    const res = await postRun(createApi(deps), { project: "nope" });

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({
      code: "bad-request",
      message: 'unknown project "nope"',
    });
    expect(launched).toBe(false);
    expect(await deps.storage.runs.listRuns()).toEqual([]);
  });

  // A checkout yok cloned for project web: under HOME/projects and saved with its git URL.
  const clonedWorkspace = async (storage: IStorage, home: string): Promise<string> => {
    const cwd = join(realpathSync(home), "projects", "web");
    mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd });
    writeFileSync(join(cwd, "ok.yaml"), okWorkflow());
    await addProjectEntry(storage, "web", cwd, "https://example.test/web.git");
    return cwd;
  };

  // Deps whose launch and git pull both write to ORDER; the pull answers PULLED.
  const pullingDeps = async (pulled: Result<null, string> = { ok: true, value: null }) => {
    const order: string[] = [];
    const doctorAsked: string[] = [];
    const base = await buildDeps(() => {
      order.push("launch");
      return launchesOk();
    });
    const deps = {
      ...base,
      git: {
        ...base.git,
        pullFastForward: (cwd: string) => {
          order.push(`pull ${cwd}`);
          return Promise.resolve(pulled);
        },
      },
      checkCheckout: ((input) => {
        doctorAsked.push(input.cwd);
        return readyCheckout(input);
      }) satisfies CheckCheckout,
    };
    return { deps, order, doctorAsked };
  };

  test("SC2005: a run on a project yok cloned pulls its checkout before the launch", async () => {
    const { deps, order } = await pullingDeps();
    const cwd = await clonedWorkspace(deps.storage, deps.home);

    const res = await postRun(createApi(deps), { project: "web" });

    expect(res.status).toBe(201);
    expect(order).toEqual([`pull ${cwd}`, "launch"]);
  });

  test("SC2006: a failed pull refuses the run with 422 git-failed without git's message, registering nothing and asking no doctor", async () => {
    const message = "fatal: Not possible to fast-forward, aborting.";
    const { deps, order, doctorAsked } = await pullingDeps({ ok: false, error: message });
    const cwd = await clonedWorkspace(deps.storage, deps.home);

    const res = await postRun(createApi(deps), { project: "web" });

    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe("git-failed");
    expect(error.message).not.toContain(message);
    expect(error.message).toContain("see the server log");
    expect(order).toEqual([`pull ${cwd}`]);
    expect(doctorAsked).toEqual([]);
    expect(await deps.storage.runs.listRuns()).toEqual([]);
  });

  test.each([
    ["outside the home", (_home: string) => gitRepo()],
    [
      "inside HOME/projects with no git URL",
      (home: string) => {
        const dir = join(realpathSync(home), "projects", "placed");
        mkdirSync(dir, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: dir });
        return dir;
      },
    ],
  ])("SC2007: a project added by path %s is never pulled", async (_label, folder) => {
    const { deps, order } = await pullingDeps();
    const cwd = folder(deps.home);
    writeFileSync(join(cwd, "ok.yaml"), okWorkflow());
    await addProjectEntry(deps.storage, "placed", cwd);

    const res = await postRun(createApi(deps), { project: "placed" });

    expect(res.status).toBe(201);
    expect(order).toEqual(["launch"]);
  });

  test("SC305: a codex workflow invokes the skill the way the agent does, with $orchestrate", async () => {
    let prompt: string | undefined;
    const deps = await buildDeps((options) => {
      prompt = options.prompt;
      return launchesOk();
    });
    const { workflowPath } = await tempWorkspace(deps.storage, okWorkflow({ agent: "codex" }));

    const res = await postRun(createApi(deps));

    expect(res.status).toBe(201);
    expect(prompt).toBe(`$orchestrate --workflow ${workflowPath} --inputs {}`);
  });

  test("SC305: the run is stored before its agent starts, so the agent's orchestrate init finds it", async () => {
    let savedAtLaunch: unknown;
    const deps = await buildDeps(async (options) => {
      savedAtLaunch = await deps.storage.runs.findRun(String(options.env?.YOK_RUN_ID));
      return launchesOk();
    });
    const { workflowPath, cwd } = await tempWorkspace(deps.storage);

    const res = await postRun(createApi(deps));

    expect(res.status).toBe(201);
    expect(savedAtLaunch).toMatchObject({ workflowPath, cwd, sessions: [], name: null });
  });

  test("a config file in the body is resolved against the checkout and saved on the run; with none the run's config is null", async () => {
    const deps = await buildDeps(launchesOk);
    const { cwd } = await tempWorkspace(deps.storage);
    const app = createApi(deps);
    writeFileSync(join(cwd, "custom.json"), '{"version": 2}');

    const runOf = async (extra: object) =>
      z.object({ run: WorkflowRunSchema }).parse(await (await postRun(app, extra)).json()).run;
    const withConfig = await runOf({ config: "custom.json" });
    const without = await runOf({});

    expect(withConfig.config).toBe(join(cwd, "custom.json"));
    expect((await deps.storage.runs.findRun(withConfig.id))?.config).toBe(join(cwd, "custom.json"));
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
    const { cwd } = await tempWorkspace(deps.storage, workflow);
    writeFileSync(join(cwd, "tiers.yaml"), config);
    const res = await postRun(createApi(deps), { config: "tiers.yaml" });
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
    expect((await deps.storage.runs.findRun(run.id))?.tiers).toEqual(tiers);
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
      const { cwd } = await tempWorkspace(deps.storage, okWorkflow(layer(workflow)));
      const configText = config === undefined ? "" : `policies:\n  interaction: ${config}\n`;
      writeFileSync(join(cwd, "policy.yaml"), `version: 2\n${configText}`);

      const res = await postRun(createApi(deps), { config: "policy.yaml", ...layer(request) });

      expect(res.status).toBe(201);
      const { run } = z.object({ run: WorkflowRunSchema }).parse(await res.json());
      const policies = { values: { interaction: value }, sources: { interaction: source } };
      expect(run.policies).toEqual(policies);
      expect((await deps.storage.runs.findRun(run.id))?.policies).toEqual(policies);
    },
  );

  test.each([
    ["SC602: a policy value that is not a boolean", { policies: { interaction: "maybe" } }],
  ])("%s is 400 bad-request and saves no run", async (_label, extra) => {
    const deps = await buildDeps(launchesOk);
    await tempWorkspace(deps.storage);

    const res = await postRun(createApi(deps), extra);

    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("bad-request");
    expect(await deps.storage.runs.listRuns()).toEqual([]);
  });

  test("SC305: the session starts with the checkout's .env, under yok's own variables", async () => {
    const seen: LaunchOptions[] = [];
    const deps = await buildDeps((options) => {
      seen.push(options);
      return launchesOk();
    });
    const { cwd } = await tempWorkspace(deps.storage);
    writeFileSync(join(cwd, ".env"), "API_URL=http://x\nYOK_RUN_ID=spoofed\n");

    const res = await postRun(createApi(deps));

    expect(res.status).toBe(201);
    const { run } = z.object({ run: WorkflowRunSchema }).parse(await res.json());
    expect(seen[0]?.env).toEqual({
      API_URL: "http://x",
      PATH: expect.stringContaining(join(deps.home, "shims")),
      YOK_RUN_ID: run.id,
      YOK_HOME: deps.home,
      YOK_SERVER_TOKEN: "",
      YOK_SERVER_USER: "",
      YOK_SERVER_PASSWORD: "",
    });
  });

  test("SC66, SC305: from source, a run's session gets a shim folder under the home first on PATH, holding an executable yok, and the repo as its plugin folder", async () => {
    const seen: LaunchOptions[] = [];
    const deps = await buildDeps((options) => {
      seen.push(options);
      return launchesOk();
    });
    await tempWorkspace(deps.storage);

    const res = await postRun(createApi(deps));

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
    expect(await deps.storage.runs.listRuns()).toEqual([]);
  });

  test("SC11: a failing provider is 502 agent-failed and records no run", async () => {
    const deps = await buildDeps(() => Promise.resolve({ ok: false, error: "boom" }));
    await tempWorkspace(deps.storage);

    const res = await postRun(createApi(deps));

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("agent-failed");
    expect(await deps.storage.runs.listRuns()).toEqual([]);
  });

  test("a handler that throws answers 500 with an internal error body and logs it", async () => {
    const { log, at } = captureLogger();
    const deps = await buildDeps(() => Promise.reject(new Error("tmux timed out")), log);
    await tempWorkspace(deps.storage);

    const res = await postRun(createApi(deps));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "internal", message: "tmux timed out" } });
    expect(at("error").some((line) => line.msg === "request failed with an unexpected error")).toBe(
      true,
    );
    expect(await deps.storage.runs.listRuns()).toEqual([]);
  });
});

describe("POST /doctor", () => {
  const postDoctor = (app: ReturnType<typeof createApi>, body: object) =>
    app.request("/doctor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("SC2010: the doctor on request returns the checkout's report and stores nothing", async () => {
    const asked: Array<Parameters<CheckCheckout>[0]> = [];
    const deps = {
      ...(await buildDeps(launchesOk)),
      checkCheckout: ((input) => {
        asked.push(input);
        return Promise.resolve({ env: { ok: true, value: {} }, report: BLOCKED_REPORT });
      }) satisfies CheckCheckout,
    };
    const { cwd } = await tempWorkspace(deps.storage);
    const before = await deps.storage.projects.list();

    const res = await postDoctor(createApi(deps), { project: "demo" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ report: BLOCKED_REPORT });
    expect(asked).toEqual([{ cwd }]);
    expect(await deps.storage.projects.list()).toEqual(before);
    expect(await deps.storage.runs.listRuns()).toEqual([]);
  });

  test("SC2011: the doctor on request with a workflow adds that workflow's own checks to the report", async () => {
    const key = "YOK_DOCTOR_UNSET_KEY";
    const deps = {
      ...(await buildDeps(launchesOk)),
      checkCheckout: ((input) => checkCheckoutWith([], input)) satisfies CheckCheckout,
    };
    const { cwd } = await tempWorkspace(deps.storage);
    writeFileSync(
      join(cwd, "check.yaml"),
      okWorkflow({ doctor: [{ check: "env", key, fix: "set it" }] }),
    );
    const app = createApi(deps);
    const rowsOf = async (body: object) => {
      const res = await postDoctor(app, body);
      expect(res.status).toBe(200);
      return ((await res.json()) as { report: DoctorReport }).report.results;
    };

    const withWorkflow = await rowsOf({ project: "demo", workflow: "check.yaml" });
    const without = await rowsOf({ project: "demo" });

    expect(withWorkflow).toContainEqual(
      expect.objectContaining({ name: expect.stringContaining(key), status: "fail" }),
    );
    expect(without.filter((row) => row.name.includes(key))).toEqual([]);
  });

  test.each([
    ["no project", {}, "project"],
    ["an unknown project", { project: "nope" }, 'unknown project "nope"'],
    ["a missing workflow", { project: "demo", workflow: "missing.yaml" }, "no workflow at"],
    ["a workflow that is not valid YAML", { project: "demo", workflow: "bad.yaml" }, "yaml:"],
  ])(
    "SC2012: %s is 400 bad-request and leaves the projects unchanged",
    async (_label, body, holds) => {
      const deps = await buildDeps(launchesOk);
      const { cwd } = await tempWorkspace(deps.storage);
      writeFileSync(join(cwd, "bad.yaml"), "name: [unclosed\n");
      const before = await deps.storage.projects.list();

      const res = await postDoctor(createApi(deps), body);

      expect(res.status).toBe(400);
      const error = await errorOf(res);
      expect(error.code).toBe("bad-request");
      expect(error.message).toContain(holds);
      expect(await deps.storage.projects.list()).toEqual(before);
    },
  );
});

describe("checkCheckoutWith", () => {
  test("SC7101: a key the handed env holds passes the workflow's env check, and fails without that env", async () => {
    const key = "YOK_RELAUNCH_KEY";
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "yok-check-")));
    execFileSync("git", ["init", "-q"], { cwd });
    writeFileSync(
      join(cwd, "check.yaml"),
      okWorkflow({ doctor: [{ check: "env", key, fix: "set it" }] }),
    );
    const plan = unwrap(await compilePlan(join(cwd, "check.yaml"), cwd, null));
    const env = { ok: true as const, value: { [key]: "1" } };
    const failedOn = (report: DoctorReport) => report.failed.filter((name) => name.includes(key));

    const handed = await checkCheckoutWith([], { cwd, plan, env });
    const own = await checkCheckoutWith([], { cwd, plan });

    expect(failedOn(handed.report)).toEqual([]);
    expect(handed.env).toBe(env);
    expect(failedOn(own.report)).not.toEqual([]);
  });
});

describe("startProjectRun", () => {
  test("SC2017: a start the caller no longer wants is refused with a conflict after the doctor, recording nothing", async () => {
    const order: string[] = [];
    const base = await buildDeps(() => {
      order.push("launch");
      return launchesOk();
    });
    const deps = {
      ...base,
      checkCheckout: ((input) => {
        order.push("doctor");
        return readyCheckout(input);
      }) satisfies CheckCheckout,
    };
    await tempWorkspace(deps.storage);
    const stillWanted = () => {
      order.push("stillWanted");
      return Promise.resolve(false);
    };

    const started = await startProjectRun(
      { project: "demo", workflow: "ok.yaml", inputs: {} },
      deps,
      noopLogger,
      { source: "api", stillWanted },
    );

    expect(started.ok ? null : started.error.status).toBe(409);
    expect(started.ok ? null : started.error.code).toBe("conflict");
    expect(order).toEqual(["doctor", "stillWanted"]);
    expect(await deps.storage.runs.listRuns()).toEqual([]);
  });

  test("SC2018: a start with a permission mode records it on the run and launches with it", async () => {
    const seen: LaunchOptions[] = [];
    const deps = await buildDeps((options) => {
      seen.push(options);
      return launchesOk();
    });
    await tempWorkspace(deps.storage);

    const started = await startProjectRun(
      { project: "demo", workflow: "ok.yaml", inputs: {} },
      deps,
      noopLogger,
      { source: "api", permissionMode: "bypassPermissions" },
    );

    expect(started.ok).toBe(true);
    const [run] = await deps.storage.runs.listRuns();
    expect(run?.permissionMode).toBe("bypassPermissions");
    expect(seen.map((options) => options.permissionMode)).toEqual(["bypassPermissions"]);
  });
});

describe("GET /health", () => {
  test("SC103: GET /health answers 200 with the pid, version and start time", async () => {
    const deps = await buildDeps(() => Promise.resolve({ ok: false, error: "unused" }));

    const res = await createApi(deps).request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pid: 4242,
      version: "0.0.0-test",
      startedAt: 1_700_000_000_000,
    });
  });
});

describe("POST /runs logging", () => {
  test("no log line carries an env value from the checkout's .env", async () => {
    const { log, lines } = captureLogger();
    const deps = await buildDeps(launchesOk, log);
    const { cwd } = await tempWorkspace(deps.storage);
    writeFileSync(join(cwd, ".env"), "API_KEY=top-secret-value\n");

    const res = await postRun(createApi(deps));

    expect(res.status).toBe(201);
    expect(JSON.stringify(lines)).not.toContain("top-secret-value");
  });

  test("SC36: a working provider logs 'run started' and an http 201 line with x-request-id", async () => {
    const { log, at } = captureLogger();
    const deps = await buildDeps(launchesOk, log);
    await tempWorkspace(deps.storage);

    const res = await postRun(createApi(deps));

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
    await tempWorkspace(deps.storage);

    await postRun(createApi(deps));

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

  test("SC104: calls the real routes over loopback HTTP and returns their typed bodies", async () => {
    const deps = await buildDeps(launchesOk);
    const { cwd } = await tempWorkspace(deps.storage);
    const { url, server } = serveOn(new Hono().route("/api", createApi(deps)).fetch);
    try {
      const client = createYokClient({ url });

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

  test("SC26 (SC1003): the client calls every route under /api, sending Authorization: Bearer when given a token and never Basic", async () => {
    const seen: Array<readonly [string, string | null]> = [];
    const { url, server } = serveOn((request) => {
      seen.push([new URL(request.url).pathname, request.headers.get("authorization")]);
      return Response.json({});
    });
    try {
      const keyless = createYokClient({ url });
      await keyless.health();
      await keyless.viewRuns();
      const withToken = createYokClient({ url, token: "yok_abc-123" });
      await withToken.health();
      await withToken.viewRuns();
      await createYokClient({ url: `${url}/` }).health();
    } finally {
      await server.stop(true);
    }

    const bearer = "Bearer yok_abc-123";
    expect(seen).toEqual([
      ["/api/health", null],
      ["/api/runs/view", null],
      ["/api/health", bearer],
      ["/api/runs/view", bearer],
      ["/api/health", null],
    ]);
  });

  test("SC2019: doctor() returns the typed report over HTTP and brings a refusal back as bad-request", async () => {
    const deps = {
      ...(await buildDeps(launchesOk)),
      checkCheckout: (() =>
        Promise.resolve({
          env: { ok: true, value: {} },
          report: BLOCKED_REPORT,
        })) satisfies CheckCheckout,
    };
    await tempWorkspace(deps.storage);
    const { url, server } = serveOn(new Hono().route("/api", createApi(deps)).fetch);
    try {
      const client = createYokClient({ url });

      const checked = await client.doctor({ project: "demo" });
      const refused = await client.doctor({ project: "nope" });

      expect(checked).toEqual({ ok: true, value: { report: BLOCKED_REPORT } });
      expect(refused).toEqual({
        ok: false,
        error: { code: "bad-request", message: 'unknown project "nope"' },
      });
    } finally {
      await server.stop(true);
    }
  });

  test("a non-JSON error reply comes back as an internal error, not a thrown parse error", async () => {
    const { url, server } = serveOn(() => new Response("Internal Server Error", { status: 500 }));
    try {
      expect(await createYokClient({ url }).health()).toEqual({
        ok: false,
        error: { code: "internal", message: "500 Internal Server Error" },
      });
    } finally {
      await server.stop(true);
    }
  });

  test("SC104: nothing listening at the URL is an unreachable error", async () => {
    expect(await createYokClient({ url: "http://127.0.0.1:1" }).health()).toEqual({
      ok: false,
      error: { code: "internal", message: "server unreachable" },
    });
  });
});

// The one app the server's listener serves, on port 4000 behind DOMAIN, with project demo and a
// named run r-1 on its checkout; launched counts agent launches.
const rootApp = async (domain: string, gated = false) => {
  let launched = 0;
  const deps = await buildDeps(() => {
    launched += 1;
    return launchesOk();
  });
  const { cwd } = await tempWorkspace(deps.storage);
  const run = WorkflowRunSchema.parse({
    id: "r-1",
    project: "demo",
    workflow: "ok",
    workflowPath: join(cwd, "ok.yaml"),
    inputs: {},
    cwd,
    sessions: [],
    name: "named",
    terminal: null,
    config: null,
    tiers: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await storeRun(deps.storage, run);
  mkdirSync(runDirOf(cwd, "named"), { recursive: true });
  const app = createRoot({
    ...deps,
    port: 4000,
    domain,
    gated,
    now: () => new Date(),
    openInEditor: () => ({ ok: true, value: null }),
  });
  return {
    app,
    deps,
    launched: () => launched,
  };
};

const send = (
  app: ReturnType<typeof createRoot>,
  method: string,
  path: string,
  headers: Record<string, string>,
) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(method === "POST"
      ? { body: path === "/api/runs" ? runBody() : JSON.stringify({ comments: [] }) }
      : {}),
  });

describe("audits page", () => {
  test("SC8020: an audit published through storage reads back through the routes, and an Accept is saved as the person's event without starting a run", async () => {
    const { app, deps, launched } = await rootApp("yok.example.com");
    const headers = { host: "yok.example.com", origin: "https://yok.example.com" };
    const auditRun = WorkflowRunSchema.parse({
      id: "r-audit",
      project: "demo",
      workflow: "test-audit",
      workflowPath: "/abs/demo/test-audit.yaml",
      inputs: { coverageLimit: 75 },
      cwd: "/abs/demo",
      sessions: [],
      name: "audit",
      terminal: null,
      config: null,
      tiers: null,
      createdAt: "2026-11-23T02:00:00.000Z",
    });
    await storeRun(deps.storage, auditRun, {
      ...seedState("/abs/demo/.yok/audit", {}),
      runId: "r-audit",
      runName: "audit",
      status: "completed",
      startedAt: "2026-11-23T02:00:00.000Z",
      completedAt: "2026-11-23T02:11:00.000Z",
    });
    const started = await deps.storage.audits.start({
      runId: "r-audit",
      project: "demo",
      audit: "test",
      periodStart: "2026-11-16T00:00:00.000Z",
      periodEnd: "2026-11-23T00:00:00.000Z",
      commits: { yok: "8c38b2c1d2" },
    });
    if (!started.ok) throw new Error(started.error);
    const id = started.value.id;
    const resultId = `${id}:yok:duplicates:copy-of-login`;
    await deps.storage.audits.finish(id, {
      status: "complete",
      metrics: [
        {
          repo: "yok",
          metric: "coverage",
          scope: "",
          status: "measured",
          reason: null,
          value: 78,
          how: {},
        },
      ],
      results: [
        {
          id: resultId,
          repo: "yok",
          problemType: "duplicates",
          state: "needs_approval",
          title: "Remove the copy of the login test",
          proof: { summary: "Two tests check the same login", where: "login.test.ts" },
          fix: { summary: "Delete the copy", diff: "-test()" },
        },
      ],
    });
    const json = async (path: string) => {
      const res = await send(app, "GET", path, headers);
      expect([path, res.status]).toEqual([path, 200]);
      return res.json();
    };

    expect((await send(app, "GET", "/audits", headers)).headers.get("content-type")).toContain(
      "text/html",
    );
    expect(await json("/api/audits/projects?audit=test")).toEqual({ projects: ["demo"] });
    const { runs } = await json("/api/audits?project=demo&audit=test&limit=52");
    expect(runs.map((run: { id: string; commits: object }) => [run.id, run.commits])).toEqual([
      [id, { yok: "8c38b2c1d2" }],
    ]);
    const { points } = await json(
      "/api/audits/metrics?project=demo&audit=test&repo=yok&from=2026-11-16T00:00:00.000Z&to=2026-11-23T00:00:00.000Z",
    );
    expect(
      points.map((point: { metrics: { value: number }[] }) => point.metrics.map((m) => m.value)),
    ).toEqual([[78]]);
    const detail = await json(`/api/audits/${encodeURIComponent(id)}`);
    expect([detail.run.startedAt, detail.run.endedAt]).toEqual([
      "2026-11-23T02:00:00.000Z",
      "2026-11-23T02:11:00.000Z",
    ]);
    expect(detail.limits.coverage).toEqual({ unit: "percent", better: "higher", limit: 75 });
    expect(
      detail.results.map((r: { decision: unknown; applyRun: unknown }) => [r.decision, r.applyRun]),
    ).toEqual([[null, null]]);

    const accepted = await app.request(
      `/api/audits/results/${encodeURIComponent(resultId)}/events`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ type: "accepted" }),
      },
    );
    expect(accepted.status).toBe(201);
    const { event } = await accepted.json();
    expect([event.type, event.who, event.startedRunId]).toEqual(["accepted", "local", null]);
    expect(await deps.storage.audits.decision(resultId)).toEqual(event);
    const after = await json(`/api/audits/${encodeURIComponent(id)}`);
    expect(after.results[0].decision.type).toBe("accepted");
    expect(launched()).toBe(0);
  });
});

describe("createRoot guard", () => {
  test("SC1004: with SERVER_DOMAIN set, its Host and https Origin reach the API and the dashboard", async () => {
    const { app, deps } = await rootApp("yok.example.com");
    const headers = { host: "yok.example.com", origin: "https://yok.example.com" };

    const projects = await send(app, "GET", "/api/projects", headers);
    expect(projects.status).toBe(200);
    expect(JSON.stringify(await projects.json())).toContain('"demo"');
    const started = await send(app, "POST", "/api/runs", headers);
    expect(started.status).toBe(201);
    expect((await deps.storage.runs.listRuns()).length).toBe(2);
    for (const path of ["/runs/r-1", "/"]) {
      const page = await send(app, "GET", path, headers);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
    }
  });

  test("SC4 mount: the root app serves /login and /settings from the identity routes, behind the host guard", async () => {
    const { app } = await rootApp("yok.example.com");
    const headers = { host: "yok.example.com" };

    const login = await send(app, "GET", "/login", headers);
    expect(login.status).toBe(200);
    expect(await login.text()).toContain("Sign in with GitHub");
    expect((await send(app, "GET", "/settings", headers)).status).toBe(302);
    expect((await send(app, "GET", "/login", { host: "evil.example.com" })).status).toBe(403);
  });

  test("SC1005: a foreign Host gets 403 naming it on API and dashboard paths, and nothing is written", async () => {
    const { app, deps, launched } = await rootApp("yok.example.com");
    const headers = { host: "evil.example:4000" };
    const requests = [
      ["GET", "/api/health"],
      ["GET", "/api/projects"],
      ["POST", "/api/runs"],
      ["GET", "/"],
      ["GET", "/runs/r-1"],
      ["GET", "/stream"],
      ["GET", "/assets/shared.js"],
    ] as const;

    for (const [method, path] of requests) {
      const res = await send(app, method, path, headers);
      expect([path, res.status]).toEqual([path, 403]);
      expect(await res.text()).toContain("evil.example:4000");
    }
    expect(launched()).toBe(0);
    expect((await deps.storage.runs.listRuns()).map((run) => run.id)).toEqual(["r-1"]);
  });

  test.each(["http://evil.example", "http://yok.example.com"])(
    "SC322 (SC1006): Origin %p gets 403 with an accepted Host, and nothing is written, no comment either",
    async (origin) => {
      const { app, deps, launched } = await rootApp("yok.example.com");
      const headers = { host: "localhost:4000", origin };
      const requests = [
        ["POST", "/api/runs"],
        ["GET", "/api/projects"],
        ["GET", "/runs/r-1"],
        ["POST", "/runs/r-1/comments"],
      ] as const;

      for (const [method, path] of requests) {
        expect([path, (await send(app, method, path, headers)).status]).toEqual([path, 403]);
      }
      expect(launched()).toBe(0);
      expect((await deps.storage.runs.listRuns()).map((run) => run.id)).toEqual(["r-1"]);
      expect(await deps.storage.comments.list("r-1")).toEqual([]);
    },
  );

  test("SC1007: without SERVER_DOMAIN only this machine's Host and Origin pass the guard", async () => {
    const { app } = await rootApp("localhost:4000");
    const status = async (headers: Record<string, string>, path: string) =>
      (await send(app, "GET", path, headers)).status;
    const passing = [
      { host: "localhost:4000" },
      { host: "localhost:4000", origin: "http://localhost:4000" },
      { host: "127.0.0.1:4000", origin: "http://127.0.0.1:4000" },
    ];

    for (const headers of passing) {
      expect([await status(headers, "/api/health"), await status(headers, "/")]).toEqual([
        200, 200,
      ]);
    }
    expect(await status({ host: "yok.example.com" }, "/api/health")).toBe(403);
    expect(
      await status({ host: "localhost:4000", origin: "https://yok.example.com" }, "/api/health"),
    ).toBe(403);
  });
});

const DOMAIN = "yok.example.com";
const SIGNED_IN = { host: DOMAIN, origin: `https://${DOMAIN}` };

// A gated root with Ada signed in two ways: a session cookie, and a CLI token.
const gatedRoot = async () => {
  const root = await rootApp(DOMAIN, true);
  const { storage, home } = root.deps;
  const userId = await seedUser(storage, { name: "Ada", github: { id: 1, login: "ada" } });
  const session = signValue(await sessionSecret(home), {
    sub: userId,
    purpose: "session",
    exp: Date.now() + 60_000,
  });
  const token = `yok_${randomBytes(32).toString("base64url")}`;
  await storage.users.createToken(userId, "laptop", hashToken(token));
  return {
    ...root,
    userId,
    cookie: { cookie: `yok_session=${session}` },
    bearer: { authorization: `Bearer ${token}` },
  };
};

// Routes the gate leaves open: the paths are the spec's list, not read from the code under test.
const OPEN = [
  "/api/health",
  "/login",
  "/auth/github",
  "/auth/github/callback",
  "/api/hooks/slack",
  "/api/auth/device",
  "/api/auth/device/token",
];

// A path from a registered route pattern, with a made-up value for each parameter or wildcard.
const concretePath = (pattern: string): string =>
  pattern.replace(/:[A-Za-z]+/g, "x").replace(/\*/g, "x");

describe("createRoot caller gate", () => {
  test("SC1: with the gate on, a bare request to every registered route outside the open list is refused", async () => {
    const { app } = await gatedRoot();
    const routes = app.routes;
    const gated = routes.filter((route) => !OPEN.includes(route.path.replace(/\/$/, "")));

    expect(routes.map((route) => route.path)).toEqual(
      expect.arrayContaining(["/api/runs", "/api/runs/:id/terminal", "/settings", "/runs/:id"]),
    );
    expect(gated.length).toBeGreaterThan(20);
    for (const route of gated) {
      const res = await app.request(concretePath(route.path), {
        method: route.method === "ALL" ? "GET" : route.method,
        headers: { host: DOMAIN },
      });
      expect([route.method, route.path, [302, 401].includes(res.status)]).toEqual([
        route.method,
        route.path,
        true,
      ]);
    }
  });

  test("SC1: the open routes still answer a bare request", async () => {
    const { app, deps } = await gatedRoot();
    writeFileSync(join(deps.home, ".env"), "SUPER_ADMIN_LOGINS=ada\n");
    const get = async (path: string, method = "GET") =>
      (await app.request(path, { method, headers: { host: DOMAIN } })).status;

    expect(await get("/api/health")).toBe(200);
    expect(await get("/login")).toBe(200);
    expect(await get("/auth/github")).toBe(503);
    expect(await get("/auth/github/callback")).toBe(503);
    expect(await get("/api/hooks/slack", "POST")).toBe(503);
    expect(await get("/api/auth/device", "POST")).toBe(400);
    expect(await get("/api/auth/device/token", "POST")).toBe(400);
    expect(await get("/device")).toBe(401);
  });

  test("SC2: without SERVER_DOMAIN the dashboard, the API and a run start answer a bare request as before", async () => {
    const { app, deps } = await rootApp("localhost:4000");
    const headers = { host: "localhost:4000", "content-type": "application/json" };

    for (const path of ["/", "/runs", "/runs/r-1", "/api/projects"]) {
      const res = await app.request(path, { headers });
      expect([path, res.status]).toEqual([path, 200]);
    }
    const started = await app.request("/api/runs", { method: "POST", headers, body: runBody() });
    expect(started.status).toBe(201);
    expect((await deps.storage.runs.listRuns()).length).toBe(2);
    expect(await (await app.request("/api/me", { headers })).json()).toEqual({ user: null });
  });

  test("SC3: a valid Bearer token reaches /api/me as its user and stamps the token's last use", async () => {
    const { app, deps, userId, bearer } = await gatedRoot();
    const [before] = await deps.storage.users.listTokens(userId);
    expect(before?.lastUsedAt).toBeNull();

    const res = await app.request("/api/me", { headers: { host: DOMAIN, ...bearer } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { id: userId, name: "Ada", email: "", login: "ada" },
    });
    const [after] = await deps.storage.users.listTokens(userId);
    expect(after?.lastUsedAt).not.toBeNull();
  });

  test("SC3: a valid session cookie reaches /api/me as its user", async () => {
    const { app, userId, cookie } = await gatedRoot();

    const res = await app.request("/api/me", { headers: { host: DOMAIN, ...cookie } });

    expect(((await res.json()) as { user: { id: string } }).user.id).toBe(userId);
  });

  test("SC3: a token nobody issued, a bad cookie and a Bearer header with no token are refused", async () => {
    const { app } = await gatedRoot();
    const refused = [
      { authorization: "Bearer yok_nope" },
      { authorization: "Bearer " },
      { cookie: "yok_session=garbage" },
    ];

    for (const headers of refused) {
      const res = await app.request("/api/me", { headers: { host: DOMAIN, ...headers } });
      expect([headers, res.status]).toEqual([headers, 401]);
    }
  });

  test("SC23: DELETE /api/tokens/current with a token revokes that token, so it no longer works, and leaves the person's other tokens", async () => {
    const { app, deps, userId, bearer } = await gatedRoot();
    await deps.storage.users.createToken(userId, "ci", hashToken("yok_other"));
    const status = async () =>
      (await app.request("/api/me", { headers: { host: DOMAIN, ...bearer } })).status;
    expect(await status()).toBe(200);

    const res = await app.request("/api/tokens/current", {
      method: "DELETE",
      headers: { host: DOMAIN, ...bearer },
    });

    expect(res.status).toBe(200);
    expect(await status()).toBe(401);
    expect((await deps.storage.users.listTokens(userId)).map((t) => t.name)).toEqual(["ci"]);
  });

  test("DELETE /api/tokens/current from a browser session has no token to revoke and answers 400", async () => {
    const { app, deps, userId, cookie } = await gatedRoot();

    const res = await app.request("/api/tokens/current", {
      method: "DELETE",
      headers: { host: DOMAIN, ...cookie, origin: SIGNED_IN.origin },
    });

    expect(res.status).toBe(400);
    expect(await deps.storage.users.listTokens(userId)).toHaveLength(1);
  });

  test("SC4: a user with access revoked is refused by cookie and by token; a restore brings the cookie back, not the deleted token", async () => {
    const { app, deps, userId, cookie, bearer } = await gatedRoot();
    const status = async (headers: Record<string, string>) =>
      (await app.request("/api/me", { headers: { host: DOMAIN, ...headers } })).status;
    expect([await status(cookie), await status(bearer)]).toEqual([200, 200]);

    await deps.storage.users.setAccessRevokedAt(userId, new Date().toISOString());

    expect([await status(cookie), await status(bearer)]).toEqual([401, 401]);
    await deps.storage.users.setAccessRevokedAt(userId, null);
    expect([await status(cookie), await status(bearer)]).toEqual([200, 401]);
  });

  test("SC5: a cookie caller's POST with no Origin is refused and starts nothing; with the Origin, or by token, it goes through", async () => {
    const { app, deps, cookie, bearer } = await gatedRoot();
    const post = (headers: Record<string, string>) =>
      app.request("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json", host: DOMAIN, ...headers },
        body: runBody(),
      });

    expect((await post(cookie)).status).toBe(403);
    expect((await deps.storage.runs.listRuns()).length).toBe(1);
    expect((await post({ ...cookie, origin: SIGNED_IN.origin })).status).toBe(201);
    expect((await post(bearer)).status).toBe(201);
    const read = await app.request("/api/projects", { headers: { host: DOMAIN, ...cookie } });
    expect(read.status).toBe(200);
  });

  test("SC6: a browser navigation to a page with no caller is redirected to /login with the page as next", async () => {
    const { app } = await gatedRoot();
    const browser = { host: DOMAIN, accept: "text/html,application/xhtml+xml" };

    for (const [path, next] of [
      ["/", "%2F"],
      ["/runs/r-1?tab=terminal", "%2Fruns%2Fr-1%3Ftab%3Dterminal"],
      ["/settings", "%2Fsettings"],
    ] as const) {
      const res = await app.request(path, { headers: browser });
      expect([path, res.status, res.headers.get("location")]).toEqual([
        path,
        302,
        `/login?next=${next}`,
      ]);
    }
  });

  test("SC6: a dashboard data request with no caller gets 401 text, not a redirect", async () => {
    const { app } = await gatedRoot();

    for (const path of ["/runs", "/stream", "/runs/r-1/files", "/assets/shared.js"]) {
      const res = await app.request(path, { headers: { host: DOMAIN, accept: "*/*" } });
      expect([path, res.status, res.headers.get("content-type")]).toEqual([
        path,
        401,
        expect.stringContaining("text/plain"),
      ]);
    }
  });

  test("SC7: an /api/* request with no caller gets 401 JSON with the code unauthenticated", async () => {
    const { app } = await gatedRoot();

    const res = await app.request("/api/runs", { headers: { host: DOMAIN } });

    expect(res.status).toBe(401);
    expect(ErrorBodySchema.parse(await res.json()).error.code).toBe("unauthenticated");
  });

  // The upgrade request as a browser sends it, over a real listener, since app.request cannot
  // upgrade. It reports how the server answered: a plain reply (the refusal) or the upgrade.
  const upgrade = async (app: ReturnType<typeof createRoot>, headers: Record<string, string>) => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket });
    try {
      return await new Promise<"upgraded" | number>((resolve, reject) => {
        const req = httpRequest({
          host: "127.0.0.1",
          port: server.port,
          path: "/api/runs/r-1/terminal",
          headers: {
            host: DOMAIN,
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": randomBytes(16).toString("base64"),
            ...headers,
          },
        });
        req.on("response", (res) => resolve(res.statusCode ?? 0));
        req.on("upgrade", (_res, socket) => {
          socket.destroy();
          resolve("upgraded");
        });
        req.on("error", reject);
        req.end();
      });
    } finally {
      await server.stop(true);
    }
  };

  test("SC8: a terminal websocket upgrade with no caller is answered 401 before the upgrade", async () => {
    const { app } = await gatedRoot();

    expect(await upgrade(app, {})).toBe(401);
  });

  test("SC8: the same upgrade with a session cookie still upgrades, so the 401 comes from the gate", async () => {
    const { app, cookie } = await gatedRoot();

    expect(await upgrade(app, { ...cookie, origin: SIGNED_IN.origin })).toBe("upgraded");
  });
});

const SLACK_NOW = new Date("2026-10-29T12:00:00.000Z");
const SLACK_ENV =
  "SLACK_SIGNING_SECRET=s3cret\nSLACK_COMMAND_CHANNEL=C1\nSLACK_BOT_TOKEN=xoxb-test\n";

type SlackPost = Readonly<{ url: string; form: Readonly<Record<string, string>> }>;

// The root on localhost:4000 with HOME/.env holding ENV; posts records every Slack Web API call.
const slackRoot = async (
  env = SLACK_ENV,
  launch: Parameters<typeof buildDeps>[0] = launchesOk,
  checkCheckout: CheckCheckout = readyCheckout,
  gated = false,
) => {
  const deps = { ...(await buildDeps(launch)), checkCheckout };
  writeFileSync(join(deps.home, ".env"), env);
  const posts: SlackPost[] = [];
  const app = createRoot({
    ...deps,
    port: 4000,
    domain: "localhost:4000",
    gated,
    now: () => SLACK_NOW,
    openInEditor: () => ({ ok: true, value: null }),
    slackFetch: async (url, init) => {
      posts.push({ url, form: Object.fromEntries(new URLSearchParams(String(init.body))) });
      return Response.json({ ok: true });
    },
  });
  return { app, deps, posts };
};

const signedHook = async (
  app: ReturnType<typeof createRoot>,
  payload: unknown,
  secret = "s3cret",
): Promise<Response> => {
  const body = JSON.stringify(payload);
  const ts = String(SLACK_NOW.getTime() / 1000);
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
  return app.request("/api/hooks/slack", {
    method: "POST",
    headers: {
      host: "localhost:4000",
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": signature,
    },
    body,
  });
};

const mention = (text: string, extra: object = {}, eventId = "Ev1") => ({
  type: "event_callback",
  event_id: eventId,
  event: { type: "app_mention", channel: "C1", ts: "100.1", user: "U7", text, ...extra },
});

// The hook acks before it posts, so a test waits on the fake's recorded calls.
const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 50 && !check(); i++) await Bun.sleep(20);
};

describe("Slack hook", () => {
  test("SC17: @yok login from U7 in thread 100.1 posts ephemeral to U7 in that thread, while help still posts to everyone", async () => {
    const { app, posts } = await slackRoot();

    await signedHook(app, mention("<@UBOT> login"));
    await until(() => posts.length > 0);
    await signedHook(app, mention("<@UBOT> help", {}, "Ev2"));
    await until(() => posts.length > 1);

    expect(posts[0]?.url).toBe("https://slack.com/api/chat.postEphemeral");
    expect(posts[0]?.form).toMatchObject({ channel: "C1", thread_ts: "100.1", user: "U7" });
    expect(posts[1]?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(posts[1]?.form.user).toBeUndefined();
  });

  test("SC8: @yok help from the command channel gets one reply in its thread, as blocks with a text fallback", async () => {
    const { app, posts } = await slackRoot();

    const res = await signedHook(app, mention("<@UBOT> help"));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    await until(() => posts.length > 0);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(posts[0]?.form).toMatchObject({ channel: "C1", thread_ts: "100.1" });
    expect(posts[0]?.form.text).toBe("*Type `@yok` and one of:*");
    expect(replies(posts)[0]).toStartWith("*Type `@yok` and one of:*\n• `ls ");
    expect(replies(posts)[0]).toEndWith("\n• `help`");
  });

  test("SC9: @yok status replies with the server's own version and pid", async () => {
    const { app, posts } = await slackRoot();

    await signedHook(app, mention("<@UBOT> status"));

    await until(() => posts.length > 0);
    expect(replies(posts)[0]).toContain("*Version* `0.0.0-test`");
    expect(replies(posts)[0]).toContain("*PID* `4242`");
  });

  test("SC10: a mention typed inside thread 90.0 replies in that thread, not under its own ts", async () => {
    const { app, posts } = await slackRoot();

    await signedHook(app, mention("<@UBOT> help", { thread_ts: "90.0" }));

    await until(() => posts.length > 0);
    expect(posts[0]?.form.thread_ts).toBe("90.0");
  });

  test("SC11: a request signed with another secret gets 401 and Slack is never called", async () => {
    const { app, posts } = await slackRoot();

    const res = await signedHook(app, mention("<@UBOT> help"), "other");

    expect(res.status).toBe(401);
    await Bun.sleep(100);
    expect(posts).toEqual([]);
  });

  test("SC12: a mention from channel C2 gets 200 and no reply", async () => {
    const { app, posts } = await slackRoot();

    const res = await signedHook(app, mention("<@UBOT> help", { channel: "C2" }));

    expect(res.status).toBe(200);
    await Bun.sleep(100);
    expect(posts).toEqual([]);
  });

  test("SC13: the same event delivered twice gets one reply", async () => {
    const { app, posts } = await slackRoot();

    const first = await signedHook(app, mention("<@UBOT> help"));
    const second = await signedHook(app, mention("<@UBOT> help"));

    expect([first.status, second.status]).toEqual([200, 200]);
    await until(() => posts.length > 0);
    await Bun.sleep(100);
    expect(posts).toHaveLength(1);
  });

  test("SC14: Slack's URL check gets its challenge back", async () => {
    const { app } = await slackRoot();

    const res = await signedHook(app, { type: "url_verification", challenge: "abc" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "abc" });
  });

  test("SC15: without SLACK_SIGNING_SECRET the hook answers 503 and Slack is never called", async () => {
    const { app, posts } = await slackRoot("SLACK_COMMAND_CHANNEL=C1\nSLACK_BOT_TOKEN=xoxb-test\n");

    const res = await signedHook(app, mention("<@UBOT> help"));

    expect(res.status).toBe(503);
    await Bun.sleep(100);
    expect(posts).toEqual([]);
  });

  test("a command that throws replies with internal: and the error's message", async () => {
    const { app, deps, posts } = await slackRoot();
    Object.assign(deps.storage.runs, {
      listRuns: async () => {
        throw new Error("EACCES: /srv/secret/yok.db");
      },
    });

    await signedHook(app, mention("<@UBOT> ls"));

    await until(() => posts.length > 0);
    expect(replies(posts)).toEqual(["internal: EACCES: /srv/secret/yok.db"]);
  });

  test("a reply echoing <!channel> posts it escaped, so it never pings the channel", async () => {
    const { app, posts } = await slackRoot();

    await signedHook(app, mention("<@UBOT> &lt;!channel&gt;"));

    await until(() => posts.length > 0);
    expect(posts[0]?.form.text).toBe("unknown command: &lt;!channel&gt;");
    expect(replies(posts)[0]).toStartWith("unknown command: &lt;!channel&gt;\n");
    expect(JSON.stringify(posts[0]?.form)).not.toContain("<!channel>");
  });

  test("after 1001 distinct events the first id counts as new again, and the newest is still dropped", async () => {
    const { app, posts } = await slackRoot();
    for (let i = 0; i <= 1000; i++) await signedHook(app, mention("<@UBOT> help", {}, `Ev${i}`));
    await until(() => posts.length >= 1001);

    await signedHook(app, mention("<@UBOT> help", {}, "Ev0"));
    await until(() => posts.length >= 1002);
    await signedHook(app, mention("<@UBOT> help", {}, "Ev1000"));
    await Bun.sleep(100);

    expect(posts).toHaveLength(1002);
  });

  test("without SLACK_COMMAND_CHANNEL a mention gets 200 and no reply", async () => {
    const { app, posts } = await slackRoot(
      "SLACK_SIGNING_SECRET=s3cret\nSLACK_BOT_TOKEN=xoxb-test\n",
    );

    const res = await signedHook(app, mention("<@UBOT> help"));

    expect(res.status).toBe(200);
    await Bun.sleep(100);
    expect(posts).toEqual([]);
  });

  test("an event other than app_mention gets 200 and no reply", async () => {
    const { app, posts } = await slackRoot();
    const message = mention("<@UBOT> help");

    const res = await signedHook(app, { ...message, event: { ...message.event, type: "message" } });

    expect(res.status).toBe(200);
    await Bun.sleep(100);
    expect(posts).toEqual([]);
  });

  test("a signed payload of no known shape gets an empty 200 and no reply", async () => {
    const { app, posts } = await slackRoot();

    const res = await signedHook(app, { type: "event_callback", event: { type: "app_mention" } });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    await Bun.sleep(100);
    expect(posts).toEqual([]);
  });

  test("SC16: /api/health and /api/projects answer through the root as the bare API does, and /api/hooks/other is 404", async () => {
    const { app, deps } = await slackRoot();
    await tempWorkspace(deps.storage);
    const bare = new Hono().route("/api", createApi(deps));
    const get = (target: { request: typeof app.request }, path: string) =>
      target.request(path, { headers: { host: "localhost:4000" } });

    for (const path of ["/api/health", "/api/projects"]) {
      const viaRoot = await get(app, path);
      expect(viaRoot.status).toBe(200);
      expect(await viaRoot.json()).toEqual(await (await get(bare, path)).json());
    }
    expect((await get(app, "/api/hooks/other")).status).toBe(404);
  });
});

type SlackRunSetup = Readonly<{
  // the project's .env value for SLACK_CHANNEL_ID
  channel?: string;
  // the project config's notifier block
  notifier?: string;
  checkCheckout?: CheckCheckout;
  gated?: boolean;
}>;

// slackRoot with project demo holding ok.yaml, a config turning the notifier on and a .env that
// sends its updates to C1; launches records every agent launch.
const slackRunRoot = async (setup: SlackRunSetup = {}) => {
  const {
    channel = "C1",
    notifier = "{ type: slack }",
    checkCheckout = readyCheckout,
    gated = false,
  } = setup;
  const launches: LaunchOptions[] = [];
  const recordLaunch = (options: LaunchOptions) => {
    launches.push(options);
    return launchesOk();
  };
  const root = await slackRoot(SLACK_ENV, recordLaunch, checkCheckout, gated);
  const { cwd } = await tempWorkspace(root.deps.storage);
  writeFileSync(join(cwd, "orchestrate.config.yaml"), `version: 2\nnotifier: ${notifier}\n`);
  writeFileSync(join(cwd, ".env"), `SLACK_CHANNEL_ID=${channel}\nSLACK_BOT_TOKEN=xoxb-test\n`);
  return { ...root, launches, cwd };
};

type Cell = { text?: string; elements?: { elements: { text: string }[] }[] };
type Block = { type: string; text?: { text: string }; rows?: Cell[][] };

const cellText = (cell: Cell): string => cell.text ?? cell.elements?.[0]?.elements[0]?.text ?? "";

// A section reads as its text, a table as one line per row, its cells two spaces apart.
const blockText = (block: Block): string =>
  block.type === "table"
    ? (block.rows ?? []).map((row) => row.map(cellText).join("  ")).join("\n")
    : (block.text?.text ?? "");

// Each post's blocks as text.
const replies = (posts: readonly SlackPost[]): readonly string[] =>
  posts.map((post) => (JSON.parse(String(post.form.blocks)) as Block[]).map(blockText).join("\n"));

describe("Slack run command", () => {
  test("SC20: @yok run ok.yaml --project demo --prompt 'fix login' launches once with YOK_SLACK_THREAD=100.1, prompt input and interaction off, and replies starting then the run id and view", async () => {
    const { app, deps, posts, launches } = await slackRunRoot();

    await signedHook(app, mention('<@UBOT> run ok.yaml --project demo --prompt "fix login"'));

    await until(() => posts.length >= 2);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.env?.YOK_SLACK_THREAD).toBe("100.1");
    const [run] = await deps.storage.runs.listRuns();
    expect(run?.inputs).toEqual({ prompt: "fix login" });
    expect(run?.policies?.values.interaction).toBe(false);
    const [starting, started] = replies(posts);
    expect(starting).toBe("Starting `ok.yaml` on *demo*…");
    // the member is linked to no yok user, so a not-linked line follows (SC29)
    expect(started?.split("\n")[0]).toBe(
      `*\`${run?.id}\` started* · http://localhost:1/runs/${run?.id}`,
    );
    expect(posts.every((post) => post.form.thread_ts === "100.1")).toBe(true);
  });

  test("SC21: --interaction true still saves the run with interaction off, and the reply says why", async () => {
    const { app, deps, posts } = await slackRunRoot();

    await signedHook(
      app,
      mention('<@UBOT> run ok.yaml --project demo --prompt "fix login" --interaction true'),
    );

    await until(() => posts.length >= 2);
    const [run] = await deps.storage.runs.listRuns();
    expect(run?.policies?.values.interaction).toBe(false);
    expect(replies(posts)[1]).toContain(
      "questions stay off: nobody is at the terminal of a run started from Slack",
    );
  });

  test("SC22: a project whose .env sends updates to C9 still starts from C1, with SLACK_CHANNEL_ID=C1, SLACK_MEMBER_ID=U7 (who typed it) and YOK_SLACK_THREAD=100.1 in the session", async () => {
    const { app, deps, posts, launches } = await slackRunRoot({ channel: "C9" });

    await signedHook(app, mention('<@UBOT> run ok.yaml --project demo --prompt "fix login"'));

    await until(() => posts.length >= 2);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.env?.SLACK_CHANNEL_ID).toBe("C1");
    expect(launches[0]?.env?.SLACK_MEMBER_ID).toBe("U7");
    expect(launches[0]?.env?.YOK_SLACK_THREAD).toBe("100.1");
    expect(replies(posts)[1]).not.toContain("no updates will follow here");
    expect(await deps.storage.runs.listRuns()).toHaveLength(1);
  });

  test("SC914: a mention whose user is empty sets no SLACK_MEMBER_ID, so the env's member stays the one tagged", async () => {
    const { app, posts, launches } = await slackRunRoot({ channel: "C9" });

    await signedHook(
      app,
      mention('<@UBOT> run ok.yaml --project demo --prompt "go"', { user: "" }),
    );

    await until(() => posts.length >= 2);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.env).not.toHaveProperty("SLACK_MEMBER_ID");
    expect(launches[0]?.env?.SLACK_CHANNEL_ID).toBe("C1");
  });

  test("SC23: a project with its notifier off starts without YOK_SLACK_THREAD and says no updates will follow", async () => {
    const { app, posts, launches } = await slackRunRoot({ notifier: "{ enabled: false }" });

    await signedHook(app, mention('<@UBOT> run ok.yaml --project demo --prompt "fix login"'));

    await until(() => posts.length >= 2);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.env).not.toHaveProperty("YOK_SLACK_THREAD");
    expect(replies(posts)[1]?.split("\n").at(-1)).toContain("no updates will follow here");
  });

  test("SC24: a run mention delivered twice launches once and registers one run", async () => {
    const { app, deps, posts, launches } = await slackRunRoot();
    const payload = mention('<@UBOT> run ok.yaml --project demo --prompt "fix login"');

    await signedHook(app, payload);
    await signedHook(app, payload);

    await until(() => posts.length >= 2);
    await Bun.sleep(100);
    expect(launches).toHaveLength(1);
    expect(await deps.storage.runs.listRuns()).toHaveLength(1);
  });

  test("SC25: a start the doctor blocks on git replies with the check and its fix and registers no run", async () => {
    const blocked: CheckCheckout = async (input) => ({
      ...(await readyCheckout(input)),
      report: summarize([
        { name: "git", status: "fail", optional: false, detail: "not found", fix: ["install git"] },
      ]),
    });
    const { app, deps, posts } = await slackRunRoot({ checkCheckout: blocked });

    await signedHook(app, mention('<@UBOT> run ok.yaml --project demo --prompt "fix login"'));

    await until(() => posts.length >= 2);
    const reply = replies(posts)[1];
    expect(reply).toContain("CHECK  DETAIL  FIX\ngit  not found  install git");
    expect(await deps.storage.runs.listRuns()).toEqual([]);
  });

  test("SC27: a run named Bad_Name is refused as bad-request naming name, and no run is registered", async () => {
    const { app, deps, posts } = await slackRunRoot();

    await signedHook(
      app,
      mention('<@UBOT> run ok.yaml --project demo --name Bad_Name --prompt "go"'),
    );

    await until(() => posts.length > 0);
    const [reply] = replies(posts);
    expect(reply).toStartWith("bad-request:");
    expect(reply).toContain("name");
    expect(await deps.storage.runs.listRuns()).toEqual([]);
  });

  test.each([
    ["a workflow that does not exist", "nosuch", "", "no workflow nosuch"],
    ["a project config that does not parse", "ok.yaml", "version: [2\n", "invalid YAML"],
  ])(
    "%s gets a bad-request reply naming the problem",
    async (_label, workflow, config, problem) => {
      const { app, deps, posts, cwd } = await slackRunRoot();
      if (config !== "") writeFileSync(join(cwd, "orchestrate.config.yaml"), config);

      await signedHook(app, mention(`<@UBOT> run ${workflow} --project demo --prompt "fix login"`));

      await until(() => posts.length >= 2);
      expect(replies(posts)[1]).toStartWith("bad-request: ");
      expect(replies(posts)[1]).toContain(problem);
      expect(await deps.storage.runs.listRuns()).toEqual([]);
    },
  );

  test("SC28 (regression): POST /api/runs replies with no threaded key and launches with no YOK_SLACK_THREAD", async () => {
    const launches: LaunchOptions[] = [];
    const deps = await buildDeps((options) => {
      launches.push(options);
      return launchesOk();
    });
    await tempWorkspace(deps.storage);

    const res = await postRun(createApi(deps));

    expect(res.status).toBe(201);
    expect(await res.json()).not.toHaveProperty("threaded");
    expect(launches[0]?.env).not.toHaveProperty("YOK_SLACK_THREAD");
  });
});

// buildDeps whose client answers through createApi in memory, as createRoot wires it; launches
// records every agent launch.
const chatDeps = async () => {
  const launches: LaunchOptions[] = [];
  const deps = await buildDeps((options) => {
    launches.push(options);
    return launchesOk();
  });
  const api = new Hono().route("/api", createApi(deps));
  const client = createYokClient({
    url: "http://yok.internal",
    send: async (input, init) => api.request(input, init),
  });
  return { deps: { ...deps, client, gated: false, now: () => new Date() }, launches };
};

const chatReply = (deps: DispatchDeps, text: string): Promise<Reply> =>
  dispatchCommand(text, { channel: "C1", ts: "100.1" }, deps, async () => undefined);

const chat = async (deps: DispatchDeps, text: string): Promise<string> =>
  replyText(await chatReply(deps, text));

// The first cell of each table row.
const firstCells = async (deps: DispatchDeps, text: string): Promise<readonly string[]> =>
  ((await chatReply(deps, text)).table?.rows ?? []).map((row) => row[0] ?? "");

// Registers run ID in the project at CWD, added when there is none, as created at CREATEDAT,
// with no state yet.
const addRunAt = async (
  storage: IStorage,
  {
    cwd,
    ...run
  }: Pick<WorkflowRun, "id" | "cwd" | "createdAt"> & Partial<Pick<WorkflowRun, "name" | "user">>,
) =>
  storage.runs.addRun({
    project: await storage.projects.findOrAddFolder(cwd),
    workflow: "ok",
    workflowPath: join(cwd, "ok.yaml"),
    inputs: {},
    sessions: [],
    name: null,
    terminal: null,
    config: null,
    tiers: null,
    ...run,
  });

// The shown runs' ids and the matched total from GET /runs.
const listIds = async (deps: DispatchDeps, query: ListRunsQuery) => {
  const listed = await deps.client.runs(query);
  if (!listed.ok) throw new Error(listed.error.message);
  return { ids: listed.value.runs.map((run) => run.id), total: listed.value.total };
};

const ritesh = { id: 7, login: "ritesh-gh" };
const CONNECTED = "gho_u1";

// Project demo, Ritesh linked to Slack member U7 holding TOKEN, and a GitHub whose /user answers
// with STATUS or throws; from(MEMBER) runs `@yok run` as that Slack member.
const ownedRunSetup = async (token: string | undefined, github: number | "down" = 200) => {
  const { deps, launches } = await chatDeps();
  await tempWorkspace(deps.storage);
  const userId = await seedUser(deps.storage, {
    name: "Ritesh",
    github: { ...ritesh, ...(token === undefined ? {} : { token }) },
    slack: "U7",
  });
  const githubFetch = async (): Promise<Response> => {
    if (github === "down") throw new Error("ECONNREFUSED");
    return new Response("{}", { status: github });
  };
  const owned = { ...deps, githubFetch };
  const from = async (member: string) =>
    replyText(
      await dispatchCommand(
        'run ok.yaml --project demo --prompt "x"',
        { channel: "C1", ts: "100.1", user: member },
        owned,
        async () => undefined,
      ),
    );
  return { deps, launches, userId, from };
};

describe("Slack run owner", () => {
  test("SC125 (SC28): @yok run from U7, linked to Ritesh with a live token, records Ritesh as owner, launches with Ritesh's token, and warns about nothing", async () => {
    const { deps, launches, userId, from } = await ownedRunSetup(CONNECTED);

    const reply = await from("U7");

    expect((await deps.storage.runs.listRuns())[0]).toMatchObject({
      source: "slack",
      user: userId,
    });
    expect(launches[0]?.env?.GH_TOKEN).toBe("gho_u1");
    expect(reply).not.toContain("not linked");
    expect(reply).not.toContain("not connected");
  });

  test("SC125 (SC29): @yok run from unlinked U8 on a server that is not gated starts as a Slack run with no user and no GitHub token, and tells the member to type @yok login", async () => {
    const { deps, launches, from } = await ownedRunSetup(CONNECTED);

    const reply = await from("U8");

    const [run] = await deps.storage.runs.listRuns();
    expect(run?.source).toBe("slack");
    expect(run?.user).toBeUndefined();
    expect(launches[0]?.env?.GH_TOKEN).toBe("");
    expect(launches[0]?.env?.GH_CONFIG_DIR).toBe(join(deps.home, "gh-owned"));
    expect(reply).toContain("not linked to a yok user, so the run cannot push");
    expect(reply).toContain("@yok login");
  });

  test("SC125 (SC30): a token GitHub answers 401 for is dropped, the account kept, and the run starts as Ritesh with no token and the settings link", async () => {
    const { deps, launches, userId, from } = await ownedRunSetup(CONNECTED, 401);

    const reply = await from("U7");

    expect((await deps.storage.users.find(userId))?.accounts.github).toEqual(ritesh);
    expect((await deps.storage.runs.listRuns())[0]?.user).toBe(userId);
    expect(launches[0]?.env?.GH_TOKEN).toBe("");
    expect(reply).toContain("GitHub is not connected for Ritesh");
    expect(reply).toContain("http://localhost:1/settings");
  });

  test("SC125: @yok run from U7, linked to Ritesh with no GitHub token, starts as Ritesh with no token and the settings link, and leaves the stored users alone", async () => {
    const { deps, launches, userId, from } = await ownedRunSetup(undefined, "down");
    const before = await deps.storage.users.list();

    const reply = await from("U7");

    expect((await deps.storage.runs.listRuns())[0]?.user).toBe(userId);
    expect(launches[0]?.env?.GH_TOKEN).toBe("");
    expect(reply).toContain("GitHub is not connected for Ritesh");
    expect(reply).toContain("http://localhost:1/settings");
    expect(await deps.storage.users.list()).toEqual(before);
  });

  test("SC125: @yok run with no Slack member on the thread is treated as unlinked: a Slack run with no user", async () => {
    const { deps } = await ownedRunSetup(CONNECTED);

    const reply = await chat(deps, 'run ok.yaml --project demo --prompt "x"');

    const [run] = await deps.storage.runs.listRuns();
    expect(run?.source).toBe("slack");
    expect(run?.user).toBeUndefined();
    expect(reply).toContain("`@yok login`");
  });

  test("SC125 (SC31): when GitHub cannot be reached the token is kept and the run launches with it", async () => {
    const { deps, launches, userId, from } = await ownedRunSetup(CONNECTED, "down");

    await from("U7");

    expect((await deps.storage.users.find(userId))?.accounts.github?.token).toBe(CONNECTED);
    expect(launches[0]?.env?.GH_TOKEN).toBe("gho_u1");
  });
});

const LOGIN_HINT = "`@yok login`";

// A gated Slack root with project demo; Ada is linked to member U7 and Bo to U9, whose access is
// revoked. Member U8 has no yok user.
const gatedSlack = async (checkCheckout: CheckCheckout = readyCheckout) => {
  const root = await slackRunRoot({ gated: true, checkCheckout });
  const { storage } = root.deps;
  const ada = await seedUser(storage, {
    name: "Ada",
    github: { id: 1, login: "ada" },
    slack: "U7",
  });
  const bo = await seedUser(storage, { name: "Bo", github: { id: 2, login: "bo" }, slack: "U9" });
  await storage.users.setAccessRevokedAt(bo, SLACK_NOW.toISOString());
  const say = async (member: string, text: string, eventId: string, count = 1) => {
    const before = root.posts.length;
    await signedHook(root.app, mention(`<@UBOT> ${text}`, { user: member }, eventId));
    await until(() => root.posts.length >= before + count);
    await Bun.sleep(60);
    return root.posts.slice(before);
  };
  return { ...root, ada, say };
};

const COMMANDS_AS_UNLINKED = [
  'run ok.yaml --project demo --prompt "x"',
  "ls",
  "project list",
  "status",
  "logout",
];

describe("Slack gate", () => {
  test.each(COMMANDS_AS_UNLINKED)(
    "SC29: %s from a member linked to no yok user gets one private reply naming @yok login, and nothing runs",
    async (command) => {
      const { say, launches, deps } = await gatedSlack();

      const posts = await say("U8", command, "Ev1");

      expect(posts).toHaveLength(1);
      expect(posts[0]?.url).toBe("https://slack.com/api/chat.postEphemeral");
      expect(posts[0]?.form).toMatchObject({ channel: "C1", thread_ts: "100.1", user: "U8" });
      expect(replies(posts)[0]).toContain(LOGIN_HINT);
      expect(launches).toEqual([]);
      expect(await deps.storage.runs.listRuns()).toEqual([]);
    },
  );

  test("SC29: a mention that names no Slack member is refused the same way", async () => {
    const { app, posts, launches } = await gatedSlack();
    const noUser = mention("<@UBOT> status");
    await signedHook(app, { ...noUser, event: { ...noUser.event, user: undefined } });

    await until(() => posts.length > 0);
    await Bun.sleep(60);
    expect(posts).toHaveLength(1);
    expect(replies(posts)[0]).toContain(LOGIN_HINT);
    expect(launches).toEqual([]);
  });

  test.each(COMMANDS_AS_UNLINKED)(
    "SC30: %s from a member linked to a user whose access was revoked gets the same private refusal",
    async (command) => {
      const { say, launches, deps } = await gatedSlack();

      const posts = await say("U9", command, "Ev1");

      expect(posts).toHaveLength(1);
      expect(posts[0]?.url).toBe("https://slack.com/api/chat.postEphemeral");
      expect(posts[0]?.form.user).toBe("U9");
      expect(replies(posts)[0]).toContain(LOGIN_HINT);
      expect(launches).toEqual([]);
      expect(await deps.storage.runs.listRuns()).toEqual([]);
    },
  );

  test("SC31: help, whoami and login from an unlinked member still work", async () => {
    const { say } = await gatedSlack();

    const help = await say("U8", "help", "Ev1");
    const whoami = await say("U8", "whoami", "Ev2");
    const login = await say("U8", "login", "Ev3");

    expect(replies(help)[0]).toStartWith("*Type `@yok` and one of:*");
    expect(replies(whoami)[0]).toContain("not linked to a yok user");
    expect(login[0]?.url).toBe("https://slack.com/api/chat.postEphemeral");
    expect(replies(login)[0]).toContain("/link/slack?state=");
  });

  test("SC31: a revoked member's login points them to sign in again, or to link another yok account, not to an already-linked line", async () => {
    const { say } = await gatedSlack();

    const login = await say("U9", "login", "Ev1");

    expect(login[0]?.url).toBe("https://slack.com/api/chat.postEphemeral");
    expect(replies(login)[0]).toContain("/login");
    expect(replies(login)[0]).toContain("/link/slack?state=");
    expect(replies(login)[0]).not.toContain("Already linked");
  });

  test("a linked member with access runs a command on a gated server", async () => {
    const { say, launches } = await gatedSlack();

    const posts = await say("U7", 'run ok.yaml --project demo --prompt "x"', "Ev1", 2);

    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts.every((post) => post.form.user === undefined)).toBe(true);
    expect(launches).toHaveLength(1);
  });

  test("an ungated server still runs an unlinked member's command, as it did before", async () => {
    const { app, posts, launches } = await slackRunRoot();

    await signedHook(
      app,
      mention('<@UBOT> run ok.yaml --project demo --prompt "x"', { user: "U8" }),
    );

    await until(() => posts.length >= 2);
    expect(launches).toHaveLength(1);
  });
});

describe("run and project owners", () => {
  test("SC32: a token caller who starts a run is recorded as its user, and the run keeps the server's GitHub login", async () => {
    const { app, deps, userId, bearer } = await gatedRoot();

    const started = await app.request("/api/runs", {
      method: "POST",
      headers: { host: DOMAIN, "content-type": "application/json", ...bearer },
      body: runBody(),
    });

    expect(started.status).toBe(201);
    const { run } = (await started.json()) as { run: { id: string } };
    const stored = await deps.storage.runs.findRun(run.id);
    expect(stored).toMatchObject({ source: "api", user: userId });
    const env = await sessionEnv(deps.storage, { GH_TOKEN: "server" }, run.id, deps.home, "/shims");
    expect(env.GH_TOKEN).toBe("server");
  });

  test("SC32: a cookie caller who adds a project is recorded as its user", async () => {
    const { app, deps, userId, cookie } = await gatedRoot();
    const path = gitRepo();

    const added = await app.request("/api/projects", {
      method: "POST",
      headers: {
        host: DOMAIN,
        origin: SIGNED_IN.origin,
        "content-type": "application/json",
        ...cookie,
      },
      body: JSON.stringify({ name: "mine", path }),
    });

    expect(added.status).toBe(201);
    expect((await deps.storage.projects.find("mine"))?.addedBy).toEqual({
      channel: "api",
      user: userId,
    });
  });

  test("a signed-in caller cannot resume or retry another person's run, which would launch with that person's GitHub token", async () => {
    const { app, deps, bearer } = await gatedRoot();
    const github = { id: 2, login: "bo", token: "gho_bo" };
    const other = await seedUser(deps.storage, { name: "Bo", github });
    const run = await seedRun(deps.storage, { run: { source: "slack", user: other } });

    const answers = await Promise.all(
      ["resume", "retry"].map((action) =>
        app.request(`/api/runs/${action}`, {
          method: "POST",
          headers: { host: DOMAIN, "content-type": "application/json", ...bearer },
          body: JSON.stringify({ run: { id: run.id } }),
        }),
      ),
    );

    for (const res of answers) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string; message: string } }).error).toEqual({
        code: "forbidden",
        message: `run ${run.name} belongs to Bo; only Bo can resume or retry it`,
      });
    }
  });

  test("a signed-in caller resumes their own run past the owner check", async () => {
    const { app, deps, userId, bearer } = await gatedRoot();
    const run = await seedRun(deps.storage, { run: { source: "slack", user: userId } });

    const res = await app.request("/api/runs/resume", {
      method: "POST",
      headers: { host: DOMAIN, "content-type": "application/json", ...bearer },
      body: JSON.stringify({ run: { id: run.id } }),
    });

    expect(res.status).not.toBe(403);
  });

  test("SC32: a caller cannot name another user in the body: the caller is the one recorded", async () => {
    const { app, deps, userId, bearer } = await gatedRoot();
    const other = await seedUser(deps.storage, { name: "Bo", github: { id: 2, login: "bo" } });

    await app.request("/api/projects", {
      method: "POST",
      headers: { host: DOMAIN, "content-type": "application/json", ...bearer },
      body: JSON.stringify({
        name: "mine",
        path: gitRepo(),
        addedBy: { channel: "api", id: other },
      }),
    });

    expect((await deps.storage.projects.find("mine"))?.addedBy.user).toBe(userId);
  });

  test("SC32: a linked Slack member who adds a project is recorded as its user", async () => {
    const { say, deps, ada } = await gatedSlack();

    await say("U7", `project add mine --path ${gitRepo()}`, "Ev1");

    expect((await deps.storage.projects.find("mine"))?.addedBy).toEqual({
      channel: "slack",
      user: ada,
    });
  });

  test("SC32: a linked Slack member who starts a run is recorded as its user", async () => {
    const { say, deps, ada } = await gatedSlack();

    await say("U7", 'run ok.yaml --project demo --prompt "x"', "Ev1", 2);

    expect((await deps.storage.runs.listRuns())[0]).toMatchObject({ source: "slack", user: ada });
  });

  test("SC34: a YOK_SERVER_TOKEN in the server's own env reaches no launched agent session as anything but an empty string", async () => {
    const withToken: CheckCheckout = async (input) => {
      const checked = await readyCheckout(input);
      return {
        ...checked,
        env: checked.env.ok
          ? { ok: true, value: { ...checked.env.value, YOK_SERVER_TOKEN: "yok_secret" } }
          : checked.env,
      };
    };
    const { say, launches } = await gatedSlack(withToken);

    await say("U7", 'run ok.yaml --project demo --prompt "x"', "Ev1", 2);

    expect(launches).toHaveLength(1);
    expect(launches[0]?.env?.YOK_SERVER_TOKEN).toBe("");
  });
});

describe("GET /runs", () => {
  const minute = (n: number): string => new Date(Date.UTC(2026, 9, 29, 10, n)).toISOString();

  test("SC5006: 21 runs list the newest 20 by default, limit=5 shows 5, all=true shows 21, limit=0 is bad-request", async () => {
    const { deps } = await chatDeps();
    const cwd = gitRepo();
    for (let n = 0; n < 21; n++) {
      await addRunAt(deps.storage, { id: `r-${n}`, name: `run-${n}`, cwd, createdAt: minute(n) });
    }

    const byDefault = await listIds(deps, {});
    expect(byDefault.ids).toHaveLength(20);
    expect(byDefault.ids[0]).toBe("r-20");
    expect(byDefault.ids).not.toContain("r-0");
    expect(byDefault.total).toBe(21);
    expect(await listIds(deps, { limit: "5" })).toMatchObject({ total: 21 });
    expect((await listIds(deps, { limit: "5" })).ids).toHaveLength(5);
    expect((await listIds(deps, { all: "true" })).ids).toHaveLength(21);
    const refused = await deps.client.runs({ limit: "0" });
    expect(!refused.ok && refused.error.code).toBe("bad-request");
    const both = await deps.client.runs({ all: "true", limit: "5" });
    expect(!both.ok && both.error.code).toBe("bad-request");
    expect(!both.ok && both.error.message).toContain("--all");
    expect((await listIds(deps, { all: "false", limit: "5" })).ids).toHaveLength(5);
  });

  test("SC5007: a run in demo's folder carries project demo, and one in another folder carries that folder's project", async () => {
    const { deps } = await chatDeps();
    const registered = gitRepo();
    const elsewhere = gitRepo();
    await addProjectEntry(deps.storage, "demo", registered);
    await addProjectEntry(deps.storage, "other", elsewhere);
    await addRunAt(deps.storage, { id: "r-a", cwd: registered, createdAt: minute(1) });
    await addRunAt(deps.storage, { id: "r-b", cwd: elsewhere, createdAt: minute(2) });

    const listed = await deps.client.runs({});

    expect(listed.ok && listed.value.runs.map((run) => [run.id, run.project])).toEqual([
      ["r-b", "other"],
      ["r-a", "demo"],
    ]);
  });

  test("SC5008: project=demo keeps demo's two runs, and project=nope is a 404 not-found naming it", async () => {
    const { deps } = await chatDeps();
    const demo = gitRepo();
    const other = gitRepo();
    await addProjectEntry(deps.storage, "demo", demo);
    await addProjectEntry(deps.storage, "other", other);
    await addRunAt(deps.storage, { id: "r-1", cwd: demo, createdAt: minute(1) });
    await addRunAt(deps.storage, { id: "r-2", cwd: demo, createdAt: minute(2) });
    await addRunAt(deps.storage, { id: "r-3", cwd: other, createdAt: minute(3) });

    expect(await listIds(deps, { project: "demo" })).toEqual({ ids: ["r-2", "r-1"], total: 2 });
    const unknown = await deps.client.runs({ project: "nope" });
    expect(!unknown.ok && unknown.error).toMatchObject({
      code: "not-found",
      message: "no project named nope",
    });
  });

  test("SC5009: status filters before the cut, takes a comma list, and bogus is bad-request naming the valid statuses", async () => {
    const { deps } = await chatDeps();
    const cwd = gitRepo();
    await addRunAt(deps.storage, { id: "r-0", cwd, createdAt: minute(0) });
    for (let n = 1; n < 21; n++) {
      await addRunAt(deps.storage, { id: `r-${n}`, name: `run-${n}`, cwd, createdAt: minute(n) });
    }

    expect(await listIds(deps, { status: "starting", limit: "5" })).toEqual({
      ids: ["r-0"],
      total: 1,
    });
    const runDir = runDirOf(cwd, "done-run");
    mkdirSync(runDir, { recursive: true });
    await addRunAt(deps.storage, { id: "r-done", cwd, createdAt: minute(30) });
    const done = { ...seedState(runDir, {}), status: "completed" as const };
    unwrap(await deps.storage.runs.initRun("r-done", "done-run", done));

    const both = await listIds(deps, { status: "starting,missing", limit: "30" });
    expect(both.ids).toHaveLength(21);
    expect(both.ids).not.toContain("r-done");
    expect(both.total).toBe(21);
    expect(await listIds(deps, { status: "completed" })).toEqual({ ids: ["r-done"], total: 1 });
    const bogus = await deps.client.runs({ status: "bogus" });
    expect(!bogus.ok && bogus.error.code).toBe("bad-request");
    for (const valid of ["running", "blocked", "unreadable"]) {
      expect(!bogus.ok && bogus.error.message).toContain(valid);
    }
  });
});

// Two runs by Ritesh (ritesh-gh, GitHub id 8675309), one by Asha and one with no owner.
const ownedRunsDeps = async () => {
  const { deps } = await chatDeps();
  const ritesh = await seedUser(deps.storage, {
    name: "Ritesh",
    email: "ritesh@example.com",
    github: { id: 8675309, login: "ritesh-gh" },
  });
  const asha = await seedUser(deps.storage, {
    name: "Asha",
    email: "asha@example.com",
    github: { id: 42, login: "asha-gh" },
  });
  const cwd = gitRepo();
  const owners = [
    ["r-1", ritesh],
    ["r-2", asha],
    ["r-3", ritesh],
    ["r-4", undefined],
  ] as const;
  for (const [n, [id, user]] of owners.entries()) {
    const createdAt = `2026-10-29T10:0${n}:00.000Z`;
    await addRunAt(deps.storage, { id, cwd, createdAt, ...(user === undefined ? {} : { user }) });
  }
  return deps;
};

describe("GET /runs by", () => {
  test("SC126 (SC39): by=ritesh-gh, by=8675309 and by=ritesh@example.com each list Ritesh's two runs, and by=nobody is an empty 200", async () => {
    const deps = await ownedRunsDeps();

    for (const by of ["ritesh-gh", "8675309", "ritesh@example.com"]) {
      const listed = await deps.client.runs({ by });
      expect(listed.ok && listed.value.total).toBe(2);
      expect(listed.ok && listed.value.runs.map((run) => [run.id, run.startedBy?.login])).toEqual([
        ["r-3", "ritesh-gh"],
        ["r-1", "ritesh-gh"],
      ]);
    }
    expect(await listIds(deps, { by: "nobody" })).toEqual({ ids: [], total: 0 });
  });

  test("SC126 (SC40): @yok ls --by ritesh-gh lists Ritesh's two runs and no others", async () => {
    const deps = await ownedRunsDeps();

    expect(await firstCells(deps, "ls --by ritesh-gh")).toEqual(["r-3", "r-1"]);
  });
});

const DAILY = [
  "name: daily",
  "trigger:",
  '  cron: "0 9 * * *"',
  "  timezone: UTC",
  "nodes:",
  "  - id: a",
  "    type: exec",
  "    runtime: sh",
  '    script: "true"',
  "    input: null",
  "",
].join("\n");

describe("Slack commands", () => {
  test("SC32: run status fix-login shows run r-1 and launches nothing, not a workflow named status", async () => {
    const { deps, launches } = await chatDeps();
    await addRunAt(deps.storage, {
      id: "r-1",
      name: "fix-login",
      cwd: gitRepo(),
      createdAt: "2026-10-29T10:00:00.000Z",
    });

    const reply = await chat(deps, "run status fix-login");

    expect(reply.split("\n")[0]).toBe("*`r-1`* · fix-login · `ok`");
    expect(reply).toContain("http://localhost:1/runs/r-1");
    expect(launches).toEqual([]);
  });

  test("SC33: run status of a run yok.db does not hold replies not-found naming it", async () => {
    const { deps } = await chatDeps();

    expect(await chat(deps, "run status r-404")).toBe("not-found: no run r-404");
  });

  test("SC34: ls --project demo lists demo's two runs newest first and not other's; ls lists all three", async () => {
    const { deps } = await chatDeps();
    const demo = gitRepo();
    const other = gitRepo();
    await addProjectEntry(deps.storage, "demo", demo);
    await addProjectEntry(deps.storage, "other", other);
    await addRunAt(deps.storage, { id: "r-10", cwd: demo, createdAt: "2026-10-29T10:00:00.000Z" });
    await addRunAt(deps.storage, { id: "r-11", cwd: demo, createdAt: "2026-10-29T11:00:00.000Z" });
    await addRunAt(deps.storage, {
      id: "r-12",
      cwd: other,
      createdAt: "2026-10-29T12:00:00.000Z",
    });

    expect(await firstCells(deps, "ls --project demo")).toEqual(["r-11", "r-10"]);
    expect(await firstCells(deps, "ls")).toEqual(["r-12", "r-11", "r-10"]);
  });

  test("SC5015 (regression): run status of a name two projects share is ambiguous; --project or the id picks one", async () => {
    const { deps } = await chatDeps();
    const demo = gitRepo();
    const other = gitRepo();
    await addProjectEntry(deps.storage, "demo", demo);
    await addProjectEntry(deps.storage, "other", other);
    const at = "2026-10-29T10:00:00.000Z";
    await addRunAt(deps.storage, { id: "r-1", name: "fix-login", cwd: demo, createdAt: at });
    await addRunAt(deps.storage, { id: "r-2", name: "fix-login", cwd: other, createdAt: at });
    const firstLine = async (text: string) => (await chat(deps, text)).split("\n")[0];

    expect(await chat(deps, "run status fix-login")).toBe(
      "ambiguous: runs r-1, r-2 are named fix-login; pass --project NAME or the run id",
    );
    expect(await firstLine("run status fix-login --project other")).toStartWith("*`r-2`*");
    expect(await firstLine("run status r-2")).toStartWith("*`r-2`*");
  });

  test.each([
    ["in straight quotes", '--prompt "fix --verbose\nthen  login"', "fix --verbose\nthen  login"],
    ["in the curly quotes Slack types", "--prompt “keep --name x”", "keep --name x"],
    ["before the other flags", '--prompt "fix login" --project demo', "fix login"],
  ])("a --prompt %s is the run's prompt input, as typed", async (_label, rest, prompt) => {
    const { deps, launches } = await chatDeps();
    await tempWorkspace(deps.storage);

    const reply = await chat(deps, `run ok.yaml --project demo ${rest}`);

    expect(reply).toContain("started");
    expect(launches).toHaveLength(1);
    const [run] = await deps.storage.runs.listRuns();
    expect(run?.inputs).toEqual({ prompt });
    expect(run?.name).toBeNull();
  });

  test("--input KEY=VALUE adds run inputs beside the prompt, as yok run does", async () => {
    const { deps } = await chatDeps();
    const optional = { type: "string", required: false };
    await tempWorkspace(
      deps.storage,
      okWorkflow({ inputs: { prompt: optional, mode: optional, ticket: optional } }),
    );

    await chat(
      deps,
      'run ok.yaml --project demo --prompt "go" --input mode=full --input ticket=T-1',
    );

    const [run] = await deps.storage.runs.listRuns();
    expect(run?.inputs).toEqual({ prompt: "go", mode: "full", ticket: "T-1" });
  });

  test("an --input without = is refused with the usage, and nothing starts", async () => {
    const { deps, launches } = await chatDeps();

    const reply = await chat(deps, 'run ok.yaml --project demo --prompt "go" --input mode');

    expect(reply).toContain('--input must be KEY=VALUE, got "mode"');
    expect(launches).toHaveLength(0);
  });

  test("SC5012: ls replies 'Showing 20 of 21 runs' with the shared table, r-20 first, r-0 absent, PROJECT demo", async () => {
    const { deps } = await chatDeps();
    const cwd = gitRepo();
    await addProjectEntry(deps.storage, "demo", cwd);
    for (let i = 0; i < 21; i++) {
      const minute = String(i).padStart(2, "0");
      await addRunAt(deps.storage, {
        id: `r-${i}`,
        cwd,
        createdAt: `2026-10-29T10:${minute}:00.000Z`,
      });
    }

    const { text, table } = await chatReply(deps, "ls");

    expect(text).toBe("Showing 20 of 21 runs\nUse --limit N or --all to see more");
    expect(table?.headers).toEqual([
      "ID",
      "NAME",
      "PROJECT",
      "WORKFLOW",
      "STATUS",
      "STEPS",
      "STARTED (UTC)",
    ]);
    expect(table?.rows).toHaveLength(20);
    expect(table?.rows[0]?.[0]).toBe("r-20");
    expect(table?.rows.map((row) => row[0])).not.toContain("r-0");
    expect(table?.rows[0]?.[2]).toBe("demo");
  });

  test("SC5013: ls passes --status, --limit and --all to the route, and a bogus status is a bad-request naming the valid ones", async () => {
    const { deps } = await chatDeps();
    const cwd = gitRepo();
    await addRunAt(deps.storage, { id: "r-0", cwd, createdAt: "2026-10-29T10:00:00.000Z" });
    await addRunAt(deps.storage, {
      id: "r-1",
      name: "one",
      cwd,
      createdAt: "2026-10-29T10:01:00.000Z",
    });
    await addRunAt(deps.storage, {
      id: "r-2",
      name: "two",
      cwd,
      createdAt: "2026-10-29T10:02:00.000Z",
    });

    expect(await firstCells(deps, "ls --status starting")).toEqual(["r-0"]);
    expect((await chatReply(deps, "ls --limit 1")).text).toBe(
      "Showing 1 of 3 runs\nUse --limit N or --all to see more",
    );
    expect((await chatReply(deps, "ls --all")).text).toBe("3 runs");
    const bogus = await chat(deps, "ls --status bogus");
    expect(bogus).toStartWith("bad-request:");
    for (const valid of ["running", "blocked", "unreadable"]) expect(bogus).toContain(valid);
  });

  test("SC5014: runs is an unknown command followed by the help, and ls --json is refused naming --json and the ls usage", async () => {
    const { deps } = await chatDeps();

    const unknown = await chat(deps, "runs");
    expect(unknown.split("\n")[0]).toBe("unknown command: runs");
    expect(unknown).toContain("*Type `@yok` and one of:*");
    const json = await chat(deps, "ls --json");
    expect(json).toContain("--json");
    expect(json.split("\n").at(-1)).toStartWith("usage: `ls ");
  });

  test("SC35: project add demo2 --path DIR replies that it added demo2 at DIR, and project list shows it added by slack", async () => {
    const { deps } = await chatDeps();
    const dir = gitRepo();

    expect(await chat(deps, `project add demo2 --path ${dir}`)).toBe(`Added *demo2* at \`${dir}\``);

    const { table } = await chatReply(deps, "project list");
    expect(table?.headers).toEqual(["NAME", "STATUS", "PATH", "ADDED BY"]);
    expect(table?.rows.find((row) => row[0] === "demo2")).toEqual(["demo2", "ready", dir, "slack"]);
  });

  test("SC36: project remove demo2 --force on a folder yok did not clone keeps it and says so", async () => {
    const { deps } = await chatDeps();
    const dir = gitRepo();
    await chat(deps, `project add demo2 --path ${dir}`);

    expect(await chat(deps, "project remove demo2 --force")).toBe(
      `Removed *demo2*\nkept ${dir}: yok deletes only the folders it cloned`,
    );
    expect(existsSync(dir)).toBe(true);
  });

  test("SC618: project remove demo --force removes finished run r-done, names it, and says the checkout was kept", async () => {
    const { deps } = await chatDeps();
    const dir = gitRepo();
    await chat(deps, `project add demo --path ${dir}`);
    await storeNamedRun(deps.storage, {
      project: "demo",
      root: dir,
      id: "r-done",
      name: "done-run",
      status: "completed",
    });

    expect(await chat(deps, "project remove demo --force")).toBe(
      `Removed *demo* and its runs r-done\nkept ${dir}: yok deletes only the folders it cloned`,
    );
    expect(await deps.storage.runs.findRun("r-done")).toBeUndefined();
  });

  test("SC37: project remove nope replies with the API's refusal as the CLI prints it", async () => {
    const { deps } = await chatDeps();
    expect(await chat(deps, "project remove nope")).toBe("not-found: no project named nope");
  });

  test("SC38: doctor --project demo replies with the verdict, then a table of every check", async () => {
    const { deps } = await chatDeps();
    await tempWorkspace(deps.storage);

    const reply = await chatReply(deps, "doctor --project demo");

    expect(reply.text).toStartWith("*Verdict:* ");
    expect(reply.table?.headers).toEqual(["CHECK", "REQUIRED", "STATUS", "DETAIL", "FIX"]);
  });

  test("SC40: a trigger added from Slack is listed, fires, and its fire shows in its log", async () => {
    const { deps } = await chatDeps();
    await tempWorkspace(deps.storage, DAILY);

    expect(await chat(deps, "trigger add ok.yaml --project demo")).toMatch(
      /^\*daily\* in \*demo\*: `0 9 \* \* \*` \(UTC\), next fire \d\d-\d\d \d\d:\d\d UTC$/,
    );
    const listed = (await chatReply(deps, "trigger list --project demo")).table?.rows ?? [];
    expect(listed).toHaveLength(1);
    expect(listed[0]?.slice(0, 3)).toEqual(["daily", "demo", "0 9 * * * (UTC)"]);

    const fired = await chat(deps, "trigger fire daily --project demo");
    const status = fired.match(/^\*(\w+)\* at /)?.[1];
    expect(status).toBeDefined();
    const logged = (await chatReply(deps, "trigger log daily --project demo")).table?.rows ?? [];
    expect(logged.map((row) => row[1])).toContain(status);
  });

  test("SC41: trigger rm removes the trigger, and the list then says no triggers", async () => {
    const { deps } = await chatDeps();
    await tempWorkspace(deps.storage, DAILY);
    await chat(deps, "trigger add ok.yaml --project demo");

    expect(await chat(deps, "trigger rm daily --project demo")).toBe("Removed *daily* from *demo*");
    expect(await chat(deps, "trigger list --project demo")).toBe("No triggers.");
  });
});

describe("run page URL", () => {
  test("SC11: POST /runs returns the page URL, GET /runs/:id/view returns it later, and a missing run is 404", async () => {
    const deps = { ...(await buildDeps(launchesOk)), publicOrigin: "http://localhost:4321" };
    await tempWorkspace(deps.storage);
    const app = createApi(deps);

    const started = await postRun(app);
    const { run, view } = (await started.json()) as { run: { id: string }; view: string };
    expect(view).toBe(`http://localhost:4321/runs/${run.id}`);

    const again = await app.request(`/runs/${run.id}/view`);
    expect(await again.json()).toEqual({ view });

    const missing = await app.request("/runs/r-missing/view");
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

  test.each([
    "https://user:token@github.com/o/r.git",
    "https://ghp_token@github.com/o/r.git",
    "ssh://git:pw@h/o/r",
  ])("refuses the git URL %s, which holds a credential every GET /projects would echo", (git) => {
    const parsed = AddProjectBodySchema.safeParse({ name: "demo", git });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(
      "must not hold a password or an https user name; use a git credential helper or an ssh key",
    );
  });
});

type NamedRunSeed = Readonly<{
  project: string;
  root: string;
  id: string;
  name: string;
  status: State["status"];
  terminal?: string;
}>;

// Run ID named NAME in PROJECT at ROOT, as orchestrate init leaves it: its .yok/NAME folder
// holds a file, its state is STATUS and its session is TERMINAL. PROJECT is added at ROOT when
// there is none.
const storeNamedRun = async (
  storage: IStorage,
  { project, root, id, name, status, terminal = "t1" }: NamedRunSeed,
): Promise<string> => {
  const runDir = runDirOf(root, name);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "notes.md"), "kept until yok rm\n");
  const run: WorkflowRun = {
    id,
    project,
    workflow: "ok",
    workflowPath: join(root, "ok.yaml"),
    inputs: {},
    cwd: root,
    sessions: [{ agent: "claude", sessionId: "s1" }],
    name,
    terminal,
    config: null,
    tiers: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  await storeRun(storage, run, { ...seedState(runDir, {}), runId: id, runName: name, status });
  return runDir;
};

// A run still starting, or left starting by a server that died: no name and no terminal yet.
const storeUnnamedRun = (storage: IStorage, id: string, createdAt: string) =>
  storage.runs.addRun({
    id,
    project: "demo",
    workflow: "ok",
    workflowPath: "/srv/ok.yaml",
    inputs: {},
    sessions: [],
    name: null,
    terminal: null,
    config: null,
    tiers: null,
    createdAt,
  });

const deleteRun = (deps: Parameters<typeof createApi>[0], id: string) =>
  createApi(deps).request(`/runs/${id}`, { method: "DELETE" });

const runEvent = (runId: string, id: string): EventDraft => ({
  id,
  ts: "2026-01-01T00:00:01.000Z",
  type: "workflow.note",
  source: "workflow",
  runId,
  payload: {},
});

describe("DELETE /runs/:id", () => {
  test("SC605: removing finished run r-done deletes its row, events, comments, folder and open session, and a new run can take the name demo-run", async () => {
    const { deps } = await projectDeps();
    const { host, calls } = fakeHost(EMPTY_BOX, true);
    const root = gitRepo();
    const runDir = await storeNamedRun(deps.storage, {
      project: "demo",
      root,
      id: "r-done",
      name: "demo-run",
      status: "completed",
    });
    await appendEvent(deps.storage, runEvent("r-done", "e-1"));
    await appendEvent(deps.storage, runEvent("r-done", "e-2"));
    await deps.storage.comments.add("r-done", [
      { file: "artifacts/a.md", kind: "global", text: "done?" },
    ]);

    const res = await deleteRun({ ...deps, host }, "r-done");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: "r-done" });
    expect(await deps.storage.runs.findRun("r-done")).toBeUndefined();
    expect(await deps.storage.runs.readEvents("r-done")).toEqual([]);
    expect(await deps.storage.comments.list("r-done")).toEqual([]);
    expect(existsSync(runDir)).toBe(false);
    expect(calls).toContain("kill");
    await storeUnnamedRun(deps.storage, "r-next", "2026-01-02T00:00:00.000Z");
    const state = { ...seedState(runDir, {}), runId: "r-next", runName: "demo-run" };
    expect(await deps.storage.runs.initRun("r-next", "demo-run", state)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  test("SC606: running run r-live with its session alive is refused with 409 and keeps its row, events and folder, killing nothing", async () => {
    const { deps } = await projectDeps();
    const { host, calls } = fakeHost(EMPTY_BOX, true);
    const runDir = await storeNamedRun(deps.storage, {
      project: "demo",
      root: gitRepo(),
      id: "r-live",
      name: "demo-run",
      status: "running",
    });
    await appendEvent(deps.storage, runEvent("r-live", "e-1"));

    const res = await deleteRun({ ...deps, host }, "r-live");

    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe(
      "run demo-run is still going; yok rm removes only a run that has finished or lost its session",
    );
    expect(await deps.storage.runs.findRun("r-live")).toBeDefined();
    expect(await deps.storage.runs.readEvents("r-live")).toHaveLength(1);
    expect(existsSync(runDir)).toBe(true);
    expect(calls).not.toContain("kill");
  });

  test("SC607: run r-starting launched a moment ago with no terminal yet is refused with 409 and kept", async () => {
    const { deps } = await projectDeps();
    await addProjectEntry(deps.storage, "demo", gitRepo());
    await storeUnnamedRun(deps.storage, "r-starting", new Date().toISOString());

    const res = await deleteRun(deps, "r-starting");

    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toContain("r-starting is still going");
    expect(await deps.storage.runs.findRun("r-starting")).toBeDefined();
  });

  test("SC608: run r-stale left starting since 2026-01-01 by a dead server is removed, leaving the project's .yok folder alone", async () => {
    const { deps } = await projectDeps();
    const root = gitRepo();
    await addProjectEntry(deps.storage, "demo", root);
    const other = join(runDirOf(root, "other"), "notes.md");
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, "another run's\n");
    await storeUnnamedRun(deps.storage, "r-stale", "2026-01-01T00:00:00.000Z");

    const res = await deleteRun(deps, "r-stale");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: "r-stale" });
    expect(await deps.storage.runs.findRun("r-stale")).toBeUndefined();
    expect(readFileSync(other, "utf8")).toBe("another run's\n");
  });

  test("SC609: removing r-nope, which does not exist, is 404 not-found no run with id r-nope", async () => {
    const { deps } = await projectDeps();

    const res = await deleteRun(deps, "r-nope");

    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ code: "not-found", message: "no run with id r-nope" });
  });
});

describe("/projects", () => {
  test("SC203: a checkout is added without running the doctor, and listed as ready", async () => {
    const root = gitRepo();
    const { deps, calls } = await projectDeps();
    const app = createApi(deps);

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
    const app = createApi({ ...deps, git: gitServing(url, { "README.md": "hi\n" }) });

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
      const app = createApi(deps);
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
    const app = createApi({ ...deps, git: { ...deps.git, clone: slowClone } });

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
    await tempWorkspace(deps.storage);
    await addProjectEntry(deps.storage, "spare", gitRepo());
    const { promise: cloneHeld, resolve: releaseClone } = Promise.withResolvers<void>();
    const slowClone = async (_cwd: string, _url: string, dest: string): Promise<Result<void>> => {
      await cloneHeld;
      execFileSync("git", ["init", "-q", dest]);
      return { ok: true, value: undefined };
    };
    const app = createApi({ ...deps, git: { ...deps.git, clone: slowClone } });
    const within2s = (res: Response | Promise<Response>) =>
      Promise.race([
        Promise.resolve(res).then((answered) => answered.status),
        Bun.sleep(2_000).then(() => "blocked"),
      ]);

    const slow = post(app, { name: "big", git: "https://example.test/big.git" });
    await Bun.sleep(50);
    const started = await within2s(postRun(app));
    const removed = await within2s(app.request("/projects/spare", { method: "DELETE" }));
    releaseClone();

    expect(started).not.toBe("blocked");
    expect(removed).toBe(200);
    expect((await slow).status).toBe(201);
  });

  test("SC205: a clone into the folder of a project whose checkout is gone is refused 409 and the clone removed", async () => {
    const { deps } = await projectDeps();
    const path = join(mkdtempSync(join(tmpdir(), "yok-gone-")), "checkout");
    await addProjectEntry(deps.storage, "old", path);
    const initClone = async (_cwd: string, _url: string, dest: string): Promise<Result<void>> => {
      execFileSync("git", ["init", "-q", dest]);
      return { ok: true, value: undefined };
    };
    const app = createApi({ ...deps, git: { ...deps.git, clone: initClone } });

    const res = await post(app, { name: "other", git: "https://example.test/o.git", path });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe(`${path} is already project old`);
    expect(existsSync(path)).toBe(false);
  });

  test("SC2009: a clone whose orchestrate.config.yaml is invalid is added and listed ready, without loading its config or running the doctor", async () => {
    const url = "https://example.test/bad.git";
    const bad = { "orchestrate.config.yaml": "version: 2\nnope: 1\n" };
    const { deps, calls } = await projectDeps();
    const app = createApi({ ...deps, git: gitServing(url, bad) });

    const res = await post(app, { name: "bad", git: url });

    expect(res.status).toBe(201);
    expect(await listProjects(app)).toEqual([
      expect.objectContaining({ name: "bad", status: "ready" }),
    ]);
    expect(existsSync(join(deps.home, "projects", "bad", "orchestrate.config.yaml"))).toBe(true);
    expect(calls).toEqual([]);
  });

  test("SC2008: a clone that fails removes its folder and answers 422 git-failed", async () => {
    const { deps, calls } = await projectDeps();
    const app = createApi(deps);

    const res = await post(app, { name: "none", git: "https://127.0.0.1:1/none.git" });

    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe("git-failed");
    expect(error.message).toBe("git clone failed; see the server log");
    expect(existsSync(join(deps.home, "projects", "none"))).toBe(false);
    expect(await listProjects(app)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("SC207, SC2016: a project with a live run cannot be removed until the run's terminal is gone", async () => {
    const root = gitRepo();
    const { deps } = await projectDeps();
    expect((await post(createApi(deps), { name: "demo", path: root })).status).toBe(201);
    await deps.storage.runs.addRun({
      id: "r-live",
      project: "demo",
      workflow: "ok",
      workflowPath: join(root, "ok.yaml"),
      inputs: {},
      sessions: [{ agent: "claude", sessionId: "s1" }],
      name: "demo-run",
      terminal: "t1",
      config: null,
      tiers: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const remove = (app: ReturnType<typeof createApi>) =>
      app.request("/projects/demo", { method: "DELETE" });
    const alive = createApi({ ...deps, host: fakeHost(EMPTY_BOX, true).host });
    const gone = createApi({ ...deps, host: fakeHost(EMPTY_BOX, false).host });

    const refused = await remove(alive);
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).message).toContain("r-live");
    expect((await listProjects(alive)).map((project) => project.name)).toEqual(["demo"]);

    const kept = await remove(gone);
    expect(kept.status).toBe(409);
    expect((await errorOf(kept)).message).toBe(
      "demo has runs: r-live; remove them with yok rm RUN, or pass --force",
    );
    await deps.storage.runs.removeRun("r-live");
    const removed = await remove(gone);
    expect(removed.status).toBe(200);
    expect(await listProjects(gone)).toEqual([]);
  });

  test.each([
    [
      "started a moment ago holds it",
      new Date().toISOString(),
      "demo has runs still going: r-starting; --force does not remove a run still going",
    ],
    [
      "left starting for over ten minutes holds only its row",
      "2026-01-01T00:00:00.000Z",
      "demo has runs: r-starting; remove them with yok rm RUN, or pass --force",
    ],
  ])("SC207: a run still starting with no terminal yet, %s", async (_case, createdAt, message) => {
    const root = gitRepo();
    const { deps } = await projectDeps();
    const app = createApi(deps);
    expect((await post(app, { name: "demo", path: root })).status).toBe(201);
    await deps.storage.runs.addRun({
      id: "r-starting",
      project: "demo",
      workflow: "ok",
      workflowPath: join(root, "ok.yaml"),
      inputs: {},
      sessions: [],
      name: null,
      terminal: null,
      config: null,
      tiers: null,
      createdAt,
    });

    const res = await app.request("/projects/demo", { method: "DELETE" });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe(message);
  });

  test("SC223 (SC207, SC2015): a project removed while its run is being checked stops the start with project demo was removed, recording and launching nothing", async () => {
    let launched = false;
    const base = await buildDeps(() => {
      launched = true;
      return launchesOk();
    });
    const deps = {
      ...base,
      checkCheckout: (async (input) => {
        await createApi(base).request("/projects/demo", { method: "DELETE" });
        return readyCheckout(input);
      }) satisfies CheckCheckout,
    };
    await tempWorkspace(deps.storage);

    const res = await postRun(createApi(deps));

    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe("project demo was removed");
    expect(launched).toBe(false);
    expect(await deps.storage.runs.listRuns()).toEqual([]);
  });

  test("SC207: a run that has finished does not hold its project, though its session is still open", async () => {
    const root = gitRepo();
    const { deps } = await projectDeps();
    const app = createApi({ ...deps, host: fakeHost(EMPTY_BOX, true).host });
    expect((await post(app, { name: "demo", path: root })).status).toBe(201);
    const runDir = runDirOf(root, "demo-run");
    mkdirSync(runDir, { recursive: true });
    const state = { ...seedState(runDir, {}), status: "completed" as const };
    const run = {
      id: "r-done",
      project: "demo",
      workflow: "ok",
      workflowPath: join(root, "ok.yaml"),
      inputs: {},
      cwd: root,
      sessions: [{ agent: "claude" as const, sessionId: "s1" }],
      name: "demo-run",
      terminal: "t1",
      config: null,
      tiers: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await storeRun(deps.storage, run, state);

    const res = await app.request("/projects/demo", { method: "DELETE" });

    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe(
      "demo has runs: r-done; remove them with yok rm RUN, or pass --force",
    );
    await deps.storage.runs.removeRun("r-done");
    expect((await app.request("/projects/demo", { method: "DELETE" })).status).toBe(200);
    expect(await listProjects(app)).toEqual([]);
  });

  test("SC221, SC616: removing web with a live run is 409 runs still going, api with a finished run is 409 has runs, and docs with none is 200 and leaves the list", async () => {
    const { deps } = await projectDeps();
    const app = createApi({ ...deps, host: fakeHost(EMPTY_BOX, true).host });
    const roots = { web: gitRepo(), api: gitRepo(), docs: gitRepo() };
    for (const [name, path] of Object.entries(roots)) {
      expect((await post(app, { name, path })).status).toBe(201);
    }
    const runIn = (project: "web" | "api", id: string): WorkflowRun => ({
      id,
      project,
      workflow: "ok",
      workflowPath: join(roots[project], "ok.yaml"),
      inputs: {},
      cwd: roots[project],
      sessions: [{ agent: "claude", sessionId: "s1" }],
      name: `${project}-run`,
      terminal: "t1",
      config: null,
      tiers: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const stateIn = (project: "web" | "api", status: State["status"]): State => ({
      ...seedState(runDirOf(roots[project], `${project}-run`), {}),
      status,
    });
    await storeRun(deps.storage, runIn("web", "r-web"), stateIn("web", "running"));
    await storeRun(deps.storage, runIn("api", "r-api"), stateIn("api", "completed"));
    const remove = (name: string) => app.request(`/projects/${name}`, { method: "DELETE" });

    const web = await remove("web");
    expect(web.status).toBe(409);
    expect((await errorOf(web)).message).toBe(
      "web has runs still going: r-web; --force does not remove a run still going",
    );
    const api = await remove("api");
    expect(api.status).toBe(409);
    expect((await errorOf(api)).message).toBe(
      "api has runs: r-api; remove them with yok rm RUN, or pass --force",
    );
    const docs = await remove("docs");
    expect(docs.status).toBe(200);
    expect(await docs.json()).toEqual({ removed: "docs", runs: [], purged: false, note: null });
    expect((await listProjects(app)).map((project) => project.name)).toEqual(["web", "api"]);
  });

  test("SC208, SC617: --force deletes a folder yok cloned and keeps one it did not, even one added by path inside the clones folder", async () => {
    const { deps } = await projectDeps();
    const cloned = join(deps.home, "projects", "cloned");
    const placed = join(deps.home, "projects", "placed");
    mkdirSync(cloned, { recursive: true });
    mkdirSync(placed, { recursive: true });
    const outside = gitRepo();
    await addProjectEntry(deps.storage, "cloned", cloned, "https://example.test/cloned.git");
    await addProjectEntry(deps.storage, "outside", outside);
    await addProjectEntry(deps.storage, "placed", placed);
    const app = createApi(deps);
    const forceRemove = async (name: string) => {
      const res = await app.request(`/projects/${name}?force=true`, {
        method: "DELETE",
      });
      return res.json();
    };

    expect(await forceRemove("cloned")).toEqual({
      removed: "cloned",
      runs: [],
      purged: true,
      note: null,
    });
    expect(await forceRemove("outside")).toEqual({
      removed: "outside",
      runs: [],
      purged: false,
      note: `kept ${outside}: yok deletes only the folders it cloned`,
    });
    expect(await forceRemove("placed")).toEqual({
      removed: "placed",
      runs: [],
      purged: false,
      note: `kept ${placed}: yok deletes only the folders it cloned`,
    });
    expect(existsSync(cloned)).toBe(false);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(placed)).toBe(true);
  });

  test("SC208: --force keeps the target of a symlink in the clones folder, even one registered with a git URL", async () => {
    const { deps } = await projectDeps();
    const target = gitRepo();
    const link = join(deps.home, "projects", "link");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link);
    await addProjectEntry(deps.storage, "link", link, "https://example.test/link.git");

    const res = await createApi(deps).request("/projects/link?force=true", {
      method: "DELETE",
    });

    expect(await res.json()).toMatchObject({ removed: "link", purged: false });
    expect(readdirSync(target)).toEqual([".git"]);
  });

  const removeWith = (deps: Parameters<typeof createApi>[0], path: string) =>
    createApi(deps).request(path, { method: "DELETE" });

  const storeFinished = (storage: IStorage, project: string, root: string, id: string) =>
    storeNamedRun(storage, { project, root, id, name: `${id}-run`, status: "completed" });

  test("SC610: removing demo with finished runs r-a and r-b and no flag is 409 naming both and the way out, and deletes nothing", async () => {
    const { deps } = await projectDeps();
    const root = gitRepo();
    const dirs = [
      await storeFinished(deps.storage, "demo", root, "r-a"),
      await storeFinished(deps.storage, "demo", root, "r-b"),
    ];

    const res = await removeWith(deps, "/projects/demo");

    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe(
      "demo has runs: r-a, r-b; remove them with yok rm RUN, or pass --force",
    );
    expect((await listProjects(createApi(deps))).map((project) => project.name)).toEqual(["demo"]);
    expect((await deps.storage.runs.listRuns()).map((run) => run.id)).toEqual(["r-a", "r-b"]);
    expect(dirs.filter((dir) => existsSync(dir))).toEqual(dirs);
  });

  test("SC611: --force on demo with live run r-live is 409 saying --force does not remove it, and finished r-done keeps its row and folder", async () => {
    const { deps } = await projectDeps();
    const host = fakeHost(EMPTY_BOX, true).host;
    const root = gitRepo();
    await storeNamedRun(deps.storage, {
      project: "demo",
      root,
      id: "r-live",
      name: "live-run",
      status: "running",
    });
    const doneDir = await storeFinished(deps.storage, "demo", root, "r-done");

    const res = await removeWith({ ...deps, host }, "/projects/demo?force=true");

    expect(res.status).toBe(409);
    const { message } = await errorOf(res);
    expect(message).toContain("r-live");
    expect(message).toContain("--force does not remove a run still going");
    expect(await deps.storage.runs.findRun("r-done")).toBeDefined();
    expect(existsSync(doneDir)).toBe(true);
    expect((await listProjects(createApi(deps))).map((project) => project.name)).toEqual(["demo"]);
  });

  test("SC612: --force on demo, added by path, deletes runs r-a (session open) and r-b (session gone) and their folders, and keeps the checkout and its README.md", async () => {
    const { deps } = await projectDeps();
    const root = gitRepo();
    writeFileSync(join(root, "README.md"), "# demo\n");
    const open = fakeHost(EMPTY_BOX, true);
    const gone = fakeHost(EMPTY_BOX, false);
    const host = {
      ...open.host,
      find: (name: string) => (name === "t-a" ? open : gone).host.find(name),
    };
    const finished = { project: "demo", root, status: "completed" } as const;
    const dirs = [
      await storeNamedRun(deps.storage, { ...finished, id: "r-a", name: "a-run", terminal: "t-a" }),
      await storeNamedRun(deps.storage, { ...finished, id: "r-b", name: "b-run", terminal: "t-b" }),
    ];

    const res = await removeWith({ ...deps, host }, "/projects/demo?force=true");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      removed: "demo",
      runs: ["r-a", "r-b"],
      purged: false,
      note: `kept ${root}: yok deletes only the folders it cloned`,
    });
    expect(await deps.storage.runs.listRuns()).toEqual([]);
    expect(dirs.filter((dir) => existsSync(dir))).toEqual([]);
    expect(open.calls).toContain("kill");
    expect(gone.calls).not.toContain("kill");
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("# demo\n");
    expect(await listProjects(createApi(deps))).toEqual([]);
  });

  // Project cloned at HOME/projects/cloned, as yok project add --git leaves it, with finished run r-a.
  const clonedWithRun = async (storage: IStorage, home: string): Promise<string> => {
    const cloned = join(home, "projects", "cloned");
    mkdirSync(cloned, { recursive: true });
    await addProjectEntry(storage, "cloned", cloned, "https://example.test/cloned.git");
    await storeFinished(storage, "cloned", cloned, "r-a");
    return cloned;
  };

  test("SC613: --force alone deletes the folder yok cloned along with its run r-a", async () => {
    const { deps } = await projectDeps();
    const cloned = await clonedWithRun(deps.storage, deps.home);

    const res = await removeWith(deps, "/projects/cloned?force=true");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      removed: "cloned",
      runs: ["r-a"],
      purged: true,
      note: null,
    });
    expect(existsSync(cloned)).toBe(false);
    expect(await deps.storage.runs.findRun("r-a")).toBeUndefined();
  });

  test("SC614: remove without --force on cloned with run r-a is 409 has runs, keeping the clone and the run", async () => {
    const { deps } = await projectDeps();
    const cloned = await clonedWithRun(deps.storage, deps.home);

    const res = await removeWith(deps, "/projects/cloned");

    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe(
      "cloned has runs: r-a; remove them with yok rm RUN, or pass --force",
    );
    expect(existsSync(cloned)).toBe(true);
    expect(await deps.storage.runs.findRun("r-a")).toBeDefined();
  });

  test("SC615: --force on web with trigger digest is 409 still has triggers, before finished run r-a is touched", async () => {
    const { deps } = await projectDeps();
    const root = gitRepo();
    const runDir = await storeFinished(deps.storage, "web", root, "r-a");
    const saved = await deps.storage.triggers.save({
      project: "web",
      name: "digest",
      workflow: "digest",
      config: null,
      cron: "0 9 * * *",
      timezone: "UTC",
      nextFireAt: "2026-01-02T09:00:00.000Z",
    });
    expect(saved.ok).toBe(true);

    const res = await removeWith(deps, "/projects/web?force=true");

    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toBe(
      "web still has triggers: digest; remove them first with yok trigger rm NAME --project web",
    );
    expect(await deps.storage.runs.findRun("r-a")).toBeDefined();
    expect(existsSync(runDir)).toBe(true);
  });

  test("a run started in demo after the remove checked its runs makes the remove 409 naming that run, keeping demo", async () => {
    const { deps } = await projectDeps();
    const root = gitRepo();
    await addProjectEntry(deps.storage, "demo", root);
    const storage: IStorage = {
      ...deps.storage,
      projects: {
        ...deps.storage.projects,
        remove: async (name) => {
          await storeFinished(deps.storage, "demo", root, "r-late");
          return deps.storage.projects.remove(name);
        },
      },
    };

    const res = await removeWith({ ...deps, storage }, "/projects/demo?force=true");

    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toContain("r-late");
    expect((await listProjects(createApi(deps))).map((project) => project.name)).toEqual(["demo"]);
  });

  test("SC210, SC2014: the listing reads ready or missing only", async () => {
    const { deps } = await projectDeps();
    const kept = gitRepo();
    await addProjectEntry(deps.storage, "kept", kept);
    await addProjectEntry(deps.storage, "gone", "/no/such/checkout");

    const res = await createApi(deps).request("/projects");

    expect(res.status).toBe(200);
    const { projects } = (await res.json()) as { projects: Array<Record<string, unknown>> };
    expect(projects.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: "kept", status: "ready" },
      { name: "gone", status: "missing" },
    ]);
    expect(projects.filter((project) => "verdict" in project)).toEqual([]);
  });
});

// The copy of the workflow orchestrate init keeps in the run folder: one exec node, two, that fails.
const RUN_WORKFLOW =
  'name: ok\nnodes:\n  - { id: two, type: exec, runtime: sh, script: "exit 1", input: {} }\n';

// RUN_WORKFLOW with a doctor that needs RELAUNCH_KEY, which no test sets in the server's env.
const RELAUNCH_KEY = "YOK_RELAUNCH_KEY";
const GATED_WORKFLOW = JSON.stringify({
  name: "ok",
  doctor: [{ check: "env", key: RELAUNCH_KEY, fix: `add ${RELAUNCH_KEY} to .env` }],
  nodes: [{ id: "two", type: "exec", runtime: "sh", script: "exit 1", input: {} }],
});

// What the doctor's own checks need of a checkout, so only a workflow's checks can block it.
const passBuiltInChecks = (cwd: string): void => {
  writeFileSync(join(cwd, ".gitignore"), ".yok/\n");
  writeFileSync(join(cwd, "orchestrate.config.json"), '{ "version": 2 }\n');
};

const TIERS = {
  default: "fast",
  models: { fast: { model: "haiku-x" }, deep: { model: "opus-x" } },
};

type Seed = Readonly<{
  status?: State["status"];
  // false leaves the switch to opus-x requested with no applied event
  applied?: boolean;
  run?: Partial<WorkflowRun>;
  // the run folder's workflow.yaml, and the checkout's .env
  workflow?: string;
  dotenv?: string;
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

// Stores DRAFT as the run's next event without folding it into the run's state, as an event
// stored after the state's last write leaves it.
const appendEvent = async (storage: IStorage, draft: EventDraft): Promise<Event> => {
  const expectedSeq = (await storage.runs.readEvents(draft.runId)).length;
  const event = EventSchema.parse({ ...draft, schemaVersion: 1, seq: expectedSeq + 1 });
  const appended = await storage.runs.appendEvent(draft.runId, { event, state: null, expectedSeq });
  if (appended.kind !== "stored") throw new Error(`event ${draft.id} was not stored`);
  return event;
};

// A run named demo on sessions s-0 then s-1, whose state and event log say it switched to opus-x.
// Its checkout is a git repo holding the run folder's workflow.yaml, as orchestrate init leaves it.
const seedRun = async (storage: IStorage, seed: Seed = {}): Promise<WorkflowRun> => {
  const cwd = seed.run?.cwd ?? mkdtempSync(join(tmpdir(), "yok-resume-"));
  execFileSync("git", ["init", "-q"], { cwd });
  const runDir = runDirOf(cwd, "demo");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "workflow.yaml"), seed.workflow ?? RUN_WORKFLOW);
  if (seed.dotenv !== undefined) writeFileSync(join(cwd, ".env"), seed.dotenv);
  const run: WorkflowRun = {
    id: "r-1a2b3c4d",
    project: "demo",
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
  const status = seed.status ?? "running";
  const blocker =
    status === "blocked"
      ? {
          blocker: {
            reason: "stuck" as const,
            since: "2026-01-01T00:00:02.000Z",
            details: { message: null },
          },
        }
      : {};
  await storeRun(storage, run, { ...seedState(runDir, {}), status, tiers: TIERS, ...blocker });
  const requested = await appendEvent(storage, modelEvent("workflow.model.requested", {}));
  if (seed.applied === false) return run;
  await appendEvent(
    storage,
    modelEvent("workflow.model.applied", { requestSeq: requested.seq, applied: true }),
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

// run: the run's id, or a whole run pick such as { project, name }
const resume = (deps: Parameters<typeof createApi>[0], run: object | string) =>
  createApi(deps).request("/runs/resume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ run: typeof run === "string" ? { id: run } : run }),
  });

describe("POST /runs/resume", () => {
  test("SC127 (SC34): resuming a run owned by a connected user, with an empty body env, launches with their GitHub token", async () => {
    const { deps, launches } = await resumeDeps();
    const github = { id: 1, login: "ritesh-gh", token: "gho_u1" };
    const userId = await seedUser(deps.storage, { name: "R", github });
    const run = await seedRun(deps.storage, { run: { source: "slack", user: userId } });

    expect((await resume(deps, run.id)).status).toBe(200);

    expect(launches[0]?.env?.GH_TOKEN).toBe("gho_u1");
  });

  test("SC602, SC7102: a running run whose session is gone continues s-1 on opus-x, the model it last switched to, in its old terminal, with the env the server built from its checkout's .env", async () => {
    const { deps, launches } = await resumeDeps();
    const run = await seedRun(deps.storage, { dotenv: "FOO=bar\n" });

    const res = await resume(deps, run.id);

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
    expect(await deps.storage.runs.findRun(run.id)).toEqual(run);
  });

  test("SC7103: a body that still carries an env is 400 bad-request and nothing launches", async () => {
    const { deps, launches } = await resumeDeps();
    const run = await seedRun(deps.storage);

    const res = await createApi(deps).request("/runs/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run: { id: run.id }, env: { FOO: "bar" } }),
    });

    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("bad-request");
    expect(launches).toEqual([]);
  });

  test("SC7104: a run named demo inside project demo, registered at its checkout, resumes continuing its s-1", async () => {
    const { deps, launches } = await resumeDeps();
    await seedRun(deps.storage);

    const res = await resume(deps, { project: "demo", name: "demo" });

    expect(res.status).toBe(200);
    expect(launches.map((options) => options.continueSession?.id)).toEqual(["s-1"]);
  });

  test.each([
    ["an unknown project", { project: "nope", name: "demo" }, 'unknown project "nope"'],
    ["an unknown run name", { project: "demo", name: "other" }, 'no run named "other"'],
  ])("SC7105: %s is 404 not-found and nothing launches", async (_label, pick, holds) => {
    const { deps, launches } = await resumeDeps();
    await seedRun(deps.storage);

    const res = await resume(deps, pick);

    expect(res.status).toBe(404);
    const error = await errorOf(res);
    expect(error.code).toBe("not-found");
    expect(error.message).toContain(holds);
    expect(launches).toEqual([]);
  });

  test("SC7106: a resume whose workflow's doctor needs YOK_RELAUNCH_KEY is 400 with the doctor's report until the checkout's .env holds it", async () => {
    const { deps: base, launches } = await resumeDeps();
    const deps = {
      ...base,
      checkCheckout: ((input) => checkCheckoutWith([], input)) satisfies CheckCheckout,
    };
    const run = await seedRun(deps.storage, { workflow: GATED_WORKFLOW });
    passBuiltInChecks(run.cwd);

    const blocked = await resume(deps, run.id);

    expect(blocked.status).toBe(400);
    const { error }: { error: { code: string; message: string; details: DoctorReport } } =
      await blocked.json();
    expect(error.code).toBe("bad-request");
    expect(error.message).toStartWith("BLOCKED");
    expect(error.details.failed).toEqual([`env:${RELAUNCH_KEY}`]);
    expect(launches).toEqual([]);

    writeFileSync(join(run.cwd, ".env"), `${RELAUNCH_KEY}=1\n`);
    expect((await resume(deps, run.id)).status).toBe(200);
    expect(launches).toHaveLength(1);
  });

  test("a resume whose run folder's workflow.yaml no longer compiles is 409 conflict and nothing launches", async () => {
    const { deps, launches } = await resumeDeps();
    const run = await seedRun(deps.storage, { workflow: "name: ok\nnodes: 3\n" });

    const res = await resume(deps, run.id);

    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe("conflict");
    expect(error.message).toStartWith("run demo cannot start a session: ");
    expect(launches).toEqual([]);
  });

  test("a claude workflow's run whose last session was codex runs its doctor for codex, the agent it resumes on", async () => {
    const { deps: base } = await resumeDeps();
    const checked: string[] = [];
    const deps = {
      ...base,
      checkCheckout: (async (input) => {
        checked.push(input.plan?.agent ?? "none");
        return readyCheckout(input);
      }) satisfies CheckCheckout,
    };
    const run = await seedRun(deps.storage, {
      run: {
        sessions: [
          { agent: "claude", sessionId: "s-0" },
          { agent: "codex", sessionId: "s-1" },
        ],
      },
    });

    expect((await resume(deps, run.id)).status).toBe(200);

    expect(checked).toEqual(["codex"]);
  });

  test.each([
    [
      "a trigger's run resumes in the permission mode saved on it",
      { permissionMode: "auto" as const },
      "auto",
    ],
    ["a yok run run resumes with no permission mode", {}, undefined],
  ])("%s", async (_label, saved, expected) => {
    const { deps, launches } = await resumeDeps();
    const run = await seedRun(deps.storage, { run: saved });

    await resume(deps, run.id);

    expect<string | undefined>(launches[0]?.permissionMode).toBe(expected);
  });

  test("a run whose last linked session s-2 never started continues s-1, the last session whose SessionStart was logged", async () => {
    const { deps, launches } = await resumeDeps();
    const run = await seedRun(deps.storage, {
      run: {
        sessions: [
          { agent: "claude", sessionId: "s-1" },
          { agent: "claude", sessionId: "s-2" },
        ],
      },
    });
    await appendEvent(deps.storage, {
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
      const run = await seedRun(deps.storage, { status });

      const res = await resume(deps, run.id);

      expect(res.status).toBe(200);
      expect(launches).toHaveLength(1);
    },
  );

  test.each(["completed", "failed", "cancelled"] as const)(
    "SC812: a %s run whose session is gone resumes with one launch continuing s-1 in claude-demo-3c4d",
    async (status) => {
      const { deps, launches } = await resumeDeps();
      const run = await seedRun(deps.storage, { status });

      const res = await resume(deps, run.id);

      expect(res.status).toBe(200);
      expect(launches).toHaveLength(1);
      expect(launches[0]?.continueSession).toEqual({
        id: "s-1",
        terminalName: "claude-demo-3c4d",
      });
      expect(launches[0]?.prompt).toBe("/orchestrate --resume demo");
    },
  );

  test("SC813: a completed run whose tmux session is still alive is 409 conflict pointing at yok attach demo, and nothing launches", async () => {
    const { deps: base, launches } = await resumeDeps();
    const deps = { ...base, host: fakeHost("", true).host };
    const run = await seedRun(deps.storage, { status: "completed" });

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

  test("SC604: a switch to opus-x requested but never applied launches on haiku-x, the default tier's model", async () => {
    const { deps, launches } = await resumeDeps();
    const run = await seedRun(deps.storage, { applied: false });

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
      const run = await seedRun(deps.storage, { run: overrides });

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

  test.each<
    [string, Partial<WorkflowRun>, (storage: IStorage, run: WorkflowRun) => Promise<void>, string]
  >([
    [
      "a last session on pi",
      { sessions: [{ agent: "pi", sessionId: "s-1" }] },
      async () => {},
      "run demo ran on pi, which yok cannot resume",
    ],
    [
      "no stored state",
      {},
      async (storage, run) => {
        await storage.runs.removeRun(run.id);
        await storeRun(storage, run);
      },
      "run demo has no readable state",
    ],
  ])(
    "a run with %s is 409 conflict and nothing launches",
    async (_label, overrides, spoil, message) => {
      const { deps, launches } = await resumeDeps();
      const run = await seedRun(deps.storage, { run: overrides });
      await spoil(deps.storage, run);

      const res = await resume(deps, run.id);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: { code: "conflict", message } });
      expect(launches).toEqual([]);
    },
  );

  test("SC608: a launch that fails with boom is 502 agent-failed and leaves the stored run unchanged", async () => {
    const deps = await buildDeps(() => Promise.resolve({ ok: false, error: "boom" }));
    const run = await seedRun(deps.storage);

    const res = await resume(deps, run.id);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: "agent-failed", message: "boom" } });
    expect(await deps.storage.runs.findRun(run.id)).toEqual(run);
  });

  test("SC609: a run whose last session is codex asks for the codex provider and prompts $orchestrate --resume demo", async () => {
    const { deps, launches } = await resumeDeps();
    const run = await seedRun(deps.storage, {
      run: { sessions: [{ agent: "codex", sessionId: "s-1" }] },
    });

    await resume(deps, run.id);

    expect(deps.asked).toEqual(["codex"]);
    expect(launches.map((options) => options.prompt)).toEqual(["$orchestrate --resume demo"]);
  });

  test("SC607: a run whose tmux session is still alive is 409 conflict pointing at yok attach demo, and nothing launches", async () => {
    const { deps: base, launches } = await resumeDeps();
    const deps = { ...base, host: fakeHost("", true).host };
    const run = await seedRun(deps.storage);

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
    const run = await seedRun(deps.storage);
    const helper = Bun.spawn(["true"]);
    await helper.exited;
    const lock = join(runDirOf(run.cwd, "demo"), "locks", "model-2.lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, String(helper.pid));

    const res = await resume(deps, run.id);

    expect(res.status).toBe(200);
    expect(existsSync(lock)).toBe(false);
  });

  test("SC315: a comment posted while the session was down is typed into the resumed session once resume returns 200", async () => {
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
    const run = await seedRun(deps.storage);
    await deps.storage.comments.add(run.id, [
      { file: "artifacts/a.md", kind: "global", text: "while away" },
    ]);

    const res = await resume(deps, run.id);
    for (let i = 0; i < 20 && typed.length === 0; i++) await Bun.sleep(25);

    expect(res.status).toBe(200);
    expect(typed).toHaveLength(1);
    expect(typed[0]).toContain("while away");
  });

  test("a model-1.lock of a finished switch is gone once resume returns 200, though another live process now holds its pid", async () => {
    const { deps, launches } = await resumeDeps();
    const run = await seedRun(deps.storage);
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
    const run = await seedRun(deps.storage, { applied: false });
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

// demo, failed on its workflow's exec node two: two started, two failed, then the run failed.
const seedFailedRun = async (
  storage: IStorage,
  seed: Seed = {},
  error: Readonly<{ kind: string; message: string }> = { kind: "exit", message: "exit 1" },
): Promise<WorkflowRun> => {
  const run = await seedRun(storage, { status: "failed", ...seed });
  const two = { nodeId: "two", nodeRunId: "nr-two" };
  const events = [
    { type: "workflow.node.started", ...two, payload: { nodeType: "exec" } },
    {
      type: "workflow.node.failed",
      ...two,
      payload: { nodeType: "exec", attempts: 1, error },
    },
    { type: "workflow.failed", payload: {} },
  ];
  for (const [index, event] of events.entries()) {
    await appendEvent(storage, {
      id: `e-fail-${index}`,
      ts: "2026-01-01T00:00:03.000Z",
      source: "workflow",
      runId: run.id,
      ...event,
    });
  }
  return run;
};

const retry = (deps: Parameters<typeof createApi>[0], runId: string, answered?: boolean) =>
  createApi(deps).request("/runs/retry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ run: { id: runId }, ...(answered === undefined ? {} : { answered }) }),
  });

const stateOf = async (storage: IStorage, run: WorkflowRun): Promise<State> => {
  const state = await storage.runs.readState(run.id);
  if (state === null) throw new Error(`run ${run.id} has no state`);
  return state;
};

describe("POST /runs/retry", () => {
  test("SC12: a failed run gets its failed step two reopened and continues s-1 with the resume prompt", async () => {
    const { deps, launches } = await resumeDeps();
    const run = await seedFailedRun(deps.storage, { dotenv: "FOO=bar\n" });

    const res = await retry(deps, run.id);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      run,
      attach: ["tmux", "attach-session", "-t", "%9"],
      view: `http://localhost:1/runs/${run.id}`,
    });
    expect(launches).toHaveLength(1);
    expect(launches[0]?.prompt).toBe("/orchestrate --resume demo");
    expect(launches[0]?.continueSession).toEqual({ id: "s-1", terminalName: "claude-demo-3c4d" });
    expect(launches[0]?.env).toMatchObject({ FOO: "bar" });
    const state = await stateOf(deps.storage, run);
    expect(state.status).toBe("running");
    expect(state.nodeRuns.two?.status).toBe("interrupted");
  });

  test("a failed run the runs list already showed is listed as no longer failed once it is retried", async () => {
    const { deps } = await resumeDeps();
    const run = await seedFailedRun(deps.storage);
    const listedStatus = async () => {
      const res = await createApi(deps).request("/runs");
      const body: { runs: readonly { id: string; status: string }[] } = await res.json();
      return body.runs.find((listed) => listed.id === run.id)?.status;
    };
    expect(await listedStatus()).toBe("failed");

    expect((await retry(deps, run.id)).status).toBe(200);

    // Running again, with no agent session behind it: the fake launch starts none.
    expect(await listedStatus()).toBe("gone");
  });

  test("a run whose step two failed needing an answer is 409 and stays failed until answered: true, which reopens it and launches", async () => {
    const { deps, launches } = await resumeDeps();
    const run = await seedFailedRun(
      deps.storage,
      {},
      {
        kind: "needs-input",
        message: "Which database?",
      },
    );

    const refused = await retry(deps, run.id);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(await refused.json())).toContain("Which database?");
    expect(launches).toEqual([]);
    expect((await stateOf(deps.storage, run)).status).toBe("failed");

    expect((await retry(deps, run.id, true)).status).toBe(200);
    expect(launches).toHaveLength(1);
    expect((await stateOf(deps.storage, run)).status).toBe("running");
  });

  test("SC7107: a retry the doctor refuses is 400, leaves the run and its step two failed, and nothing launches", async () => {
    const { deps: base, launches } = await resumeDeps();
    const deps = {
      ...base,
      checkCheckout: ((input) => checkCheckoutWith([], input)) satisfies CheckCheckout,
    };
    const run = await seedFailedRun(deps.storage, { workflow: GATED_WORKFLOW });
    passBuiltInChecks(run.cwd);
    const before = await stateOf(deps.storage, run);

    const res = await retry(deps, run.id);

    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("bad-request");
    expect(await stateOf(deps.storage, run)).toEqual(before);
    expect(before.status).toBe("failed");
    expect(launches).toEqual([]);
  });

  test("a retry whose agent session comes back while its doctor runs is 409, leaves step two failed, and nothing launches", async () => {
    const { deps: base, launches } = await resumeDeps();
    let alive = false;
    const deps = {
      ...base,
      host: {
        ...base.host,
        find: (name: string) => ({ ...base.host.find(name), isAlive: async () => alive }),
      },
      // another resume launches the session while this request's doctor runs
      checkCheckout: (async (input) => {
        alive = true;
        return readyCheckout(input);
      }) satisfies CheckCheckout,
    };
    const run = await seedFailedRun(deps.storage);
    const before = await stateOf(deps.storage, run);

    const res = await retry(deps, run.id);

    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toContain("still has its agent session");
    expect(await stateOf(deps.storage, run)).toEqual(before);
    expect(launches).toEqual([]);
  });

  test("SC13:a failed codex run asks for the codex provider and prompts $orchestrate --resume demo", async () => {
    const { deps, launches } = await resumeDeps();
    const run = await seedFailedRun(deps.storage, {
      run: { sessions: [{ agent: "codex", sessionId: "s-1" }] },
    });

    const res = await retry(deps, run.id);

    expect(res.status).toBe(200);
    expect(deps.asked).toEqual(["codex"]);
    expect(launches.map((options) => options.prompt)).toEqual(["$orchestrate --resume demo"]);
  });

  test("SC14: a completed run is 409 conflict saying retry brings back only a failed run, and nothing launches", async () => {
    const { deps, launches } = await resumeDeps();
    const run = await seedRun(deps.storage, { status: "completed" });

    const res = await retry(deps, run.id);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "conflict",
        message: "run demo is completed; retry brings back only a failed run",
      },
    });
    expect(launches).toEqual([]);
  });

  test("SC15: a failed run whose tmux session is still alive is 409 pointing at yok attach demo, stays failed, and nothing launches", async () => {
    const { deps: base, launches } = await resumeDeps();
    const deps = { ...base, host: fakeHost("", true).host };
    const run = await seedFailedRun(deps.storage);

    const res = await retry(deps, run.id);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "conflict",
        message: "run demo still has its agent session; use yok attach demo",
      },
    });
    expect(launches).toEqual([]);
    expect((await stateOf(deps.storage, run)).status).toBe("failed");
  });

  test("SC16: a launch that fails after the retry is 502 saying yok resume demo starts the reopened run", async () => {
    const deps = await buildDeps(() => Promise.resolve({ ok: false, error: "boom" }));
    const run = await seedFailedRun(deps.storage);

    const res = await retry(deps, run.id);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: {
        code: "agent-failed",
        message: "boom; its failed steps are reopened, so yok resume demo starts it",
      },
    });
    expect((await stateOf(deps.storage, run)).status).toBe("running");
  });
});
