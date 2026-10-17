import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DoctorJsonSchema } from "@yok/core";
import { VERSION } from "@yok/sdk/internal";
import { readApiKey, readPort } from "@yok/server";
import { restartServer, yokClient } from "./client.ts";

const TIMEOUT_MS = 40_000;
// Bun would load the repo's .env into the CLI, and from there the server and tmux, by itself.
const NO_DOTENV = "--env-file=/dev/null";

const CLI = join(import.meta.dir, "index.ts");
const FAKE_AGENT = join(
  import.meta.dir,
  "..",
  "..",
  "core",
  "src",
  "agents",
  "fixtures",
  "fake-agent.ts",
);
const ORCHESTRATE = [CLI, "orchestrate"] as const;

const OK_WORKFLOW = [
  "name: ok",
  "nodes:",
  "  - id: a",
  "    type: exec",
  "    runtime: sh",
  '    script: "true"',
  "    input: null",
  "",
].join("\n");

const CYCLE_WORKFLOW = [
  "name: bad",
  "nodes:",
  "  - id: a",
  "    type: exec",
  "    runtime: sh",
  '    script: "true"',
  "    input: null",
  "    dependsOn: [b]",
  "  - id: b",
  "    type: exec",
  "    runtime: sh",
  '    script: "true"',
  "    input: null",
  "    dependsOn: [a]",
  "",
].join("\n");

// The binary as packages/cli's build script makes it, written to a temp folder.
const buildBinary = (): string => {
  const cliDir = join(import.meta.dir, "..");
  const { scripts } = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")) as {
    scripts: { build: string };
  };
  const binary = join(mkdtempSync(join(tmpdir(), "yok-bin-")), "yok");
  const built = spawnSync("sh", ["-c", scripts.build.replace("dist/yok", binary)], {
    cwd: cliDir,
    encoding: "utf8",
  });
  if (built.status !== 0) throw new Error(built.stderr);
  return binary;
};

const makeRepo = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "yok-run-e2e-repo-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), ".yok/\n");
  writeFileSync(join(dir, "orchestrate.config.json"), '{ "version": 2 }\n');
  writeFileSync(join(dir, "ok.yaml"), OK_WORKFLOW);
  writeFileSync(join(dir, "bad.yaml"), CYCLE_WORKFLOW);
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
};

// A server started by ensureServer runs with its cwd set to YOK_HOME.
const serverPids = (home: string): readonly number[] =>
  spawnSync("lsof", ["-t", "-a", "-d", "cwd", "+d", home], { encoding: "utf8" })
    .stdout.split("\n")
    .filter((line) => line !== "")
    .map(Number)
    .filter((pid) =>
      spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.includes(
        "server start",
      ),
    );

type TestEnv = Readonly<{ home: string; socket: string; fakeOut: string; env: NodeJS.ProcessEnv }>;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const makeEnv = (owner: Array<() => void> = cleanups): TestEnv => {
  const home = mkdtempSync(join(tmpdir(), "yok-run-e2e-home-"));
  const socket = `yok-e2e-${randomUUID()}`;
  const fakeOut = join(mkdtempSync(join(tmpdir(), "yok-run-e2e-out-")), "out.jsonl");
  owner.push(() => {
    for (const pid of serverPids(home)) process.kill(pid, "SIGKILL");
    spawnSync("tmux", ["-L", socket, "kill-server"]);
    rmSync(home, { recursive: true, force: true });
  });
  return {
    home,
    socket,
    fakeOut,
    // A developer's own remote server must not receive the suite's projects and runs.
    env: {
      ...process.env,
      YOK_SERVER_URL: undefined,
      YOK_API_KEY: undefined,
      YOK_HOME: home,
      YOK_TMUX_SOCKET: socket,
      YOK_CLAUDE_BIN: FAKE_AGENT,
      FAKE_AGENT_OUT: fakeOut,
    },
  };
};

const yok = (
  cwd: string,
  env: NodeJS.ProcessEnv,
  ...args: string[]
): { code: number; stdout: string; stderr: string } => {
  const run = spawnSync("bun", [NO_DOTENV, CLI, ...args], { cwd, env, encoding: "utf8" });
  return { code: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
};

const spawnHarness = (
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolvePromise) => {
    const child = spawn("bun", [NO_DOTENV, CLI, ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });

const stopServer = (cwd: string, env: NodeJS.ProcessEnv): void => {
  yok(cwd, env, "server", "stop");
};

const readLines = (path: string): Array<Record<string, unknown>> =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];

// The doctor runs the fake agent with --version; the launch is the call that carries the hooks.
const isLaunch = (record: Record<string, unknown>): boolean =>
  Array.isArray(record.argv) && record.argv.includes("--settings");

const waitFor = (predicate: () => boolean, timeoutMs = 5000): void => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    Bun.sleepSync(50);
  }
};

describe("yok run", () => {
  test(
    "a supplied --name reaches the launched agent without replacing the prompt input",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();

      const result = yok(
        repo,
        env,
        "run",
        "ok.yaml",
        "--prompt",
        "different",
        "--name",
        "fix-login",
      );
      expect(result.code).toBe(0);
      const isSession = (record: Record<string, unknown>) => isLaunch(record);
      waitFor(() => readLines(fakeOut).some(isSession));
      const launch = readLines(fakeOut).find(isSession);
      const argv = launch?.argv;
      const prompt = Array.isArray(argv) ? argv.at(-1) : undefined;
      expect(prompt).toContain('--inputs {"prompt":"different"} --name fix-login');

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "a run launches the session on the model of the default tier the checkout's config sets",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();
      const tiers = { default: "fast", models: { fast: { model: "haiku-x" } } };
      writeFileSync(
        join(repo, "orchestrate.config.json"),
        JSON.stringify({ version: 2, agents: { claude: { tiers } } }),
      );

      expect(yok(repo, env, "run", "ok.yaml", "--prompt", "hi", "--no-open").code).toBe(0);
      waitFor(() => readLines(fakeOut).some(isLaunch));
      const argv = readLines(fakeOut).find(isLaunch)?.argv;
      const args = Array.isArray(argv) ? argv.map(String) : [];

      expect(args[args.indexOf("--model") + 1]).toBe("haiku-x");

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "SC24: yok run sends the workflow's tiers, so the default deep tier launches on the workflow's opus-y over the config's opus-x",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();
      writeFileSync(
        join(repo, "orchestrate.config.json"),
        JSON.stringify({
          version: 2,
          agents: { claude: { tiers: { models: { deep: { model: "opus-x" } } } } },
        }),
      );
      writeFileSync(
        join(repo, "deep.yaml"),
        `tiers:\n  models:\n    deep: { model: opus-y }\n${OK_WORKFLOW}`,
      );

      expect(yok(repo, env, "run", "deep.yaml", "--prompt", "hi", "--no-open").code).toBe(0);
      waitFor(() => readLines(fakeOut).some(isLaunch));
      const argv = readLines(fakeOut).find(isLaunch)?.argv;
      const args = Array.isArray(argv) ? argv.map(String) : [];

      expect(args[args.indexOf("--model") + 1]).toBe("opus-y");

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "the agent session starts with the .env, config env and workflow env and envFile values",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();
      writeFileSync(join(repo, ".env"), "E2E_DOTENV=dotenv\nE2E_SHARED=dotenv\n");
      writeFileSync(
        join(repo, "orchestrate.config.json"),
        JSON.stringify({ version: 2, env: { E2E_CONFIG: "config", E2E_SHARED: "config" } }),
      );
      writeFileSync(join(repo, "flow.env"), "E2E_FLOW_FILE=file\n");
      writeFileSync(
        join(repo, "env.yaml"),
        `envFile: flow.env\nenv:\n  E2E_SHARED: workflow\n${OK_WORKFLOW}`,
      );

      expect(yok(repo, env, "run", "env.yaml", "--prompt", "hi", "--no-open").code).toBe(0);
      waitFor(() => readLines(fakeOut).some(isLaunch));
      const launched = readLines(fakeOut).find(isLaunch)?.env as Record<string, string>;

      expect(launched).toMatchObject({
        E2E_DOTENV: "dotenv",
        E2E_CONFIG: "config",
        E2E_FLOW_FILE: "file",
        E2E_SHARED: "workflow",
      });

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "the built yok binary loads no .env, so a repo's agent variables never reach the pane",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();
      writeFileSync(join(repo, ".env"), "ANTHROPIC_BASE_URL=http://app-gateway\n");
      const binary = buildBinary();

      const result = spawnSync(binary, ["run", "ok.yaml", "--prompt", "hi", "--no-open"], {
        cwd: repo,
        env,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      waitFor(() => readLines(fakeOut).some(isLaunch));
      const launched = readLines(fakeOut).find(isLaunch)?.env as Record<string, string>;

      expect(launched.ANTHROPIC_BASE_URL).toBeUndefined();

      spawnSync(binary, ["server", "stop"], { cwd: repo, env });
    },
    TIMEOUT_MS,
  );

  test(
    "a workflow whose default tier no layer maps fails the run before any session starts",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();
      writeFileSync(join(repo, "turbo.yaml"), `tiers: { default: turbo }\n${OK_WORKFLOW}`);

      const result = yok(repo, env, "run", "turbo.yaml", "--prompt", "hi", "--no-open");

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('default tier "turbo"');
      expect(readLines(fakeOut).some(isLaunch)).toBe(false);

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "SC308: a run in a checkout whose config is invalid is refused with the config's error and adds no project",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();
      writeFileSync(
        join(repo, "orchestrate.config.json"),
        JSON.stringify({ version: 2, tiers: { deep: { agent: "claude", model: "opus" } } }),
      );

      const result = yok(repo, env, "run", "ok.yaml", "--prompt", "hi", "--no-open");

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('Unrecognized key: "tiers"');
      expect(readLines(fakeOut).some(isLaunch)).toBe(false);
      const listed = JSON.parse(yok(repo, env, "project", "list", "--json").stdout);
      expect(listed.projects).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "SC306: yok run in an unregistered checkout adds it under its folder's name and starts the run; a second run adds nothing",
    () => {
      const repo = makeRepo();
      const { env } = makeEnv();
      const start = () =>
        yok(repo, env, "run", "ok.yaml", "--prompt", "x", "--no-attach", "--no-open");

      const first = start();
      const second = start();

      expect(first.code).toBe(0);
      expect(first.stdout.split("\n")[0]).toMatch(/^r-[0-9a-f]+$/);
      expect(second.code).toBe(0);
      const listed = JSON.parse(yok(repo, env, "project", "list", "--json").stdout);
      expect(listed.projects).toEqual([
        expect.objectContaining({ name: basename(repo).toLowerCase(), path: repo }),
      ]);

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "SC307: a folder name another checkout already holds is refused with the way out, and no run starts",
    () => {
      const inFolder = (): string => {
        const parent = realpathSync(mkdtempSync(join(tmpdir(), "yok-run-e2e-clash-")));
        const dir = join(parent, "repo");
        mkdirSync(dir);
        execFileSync("git", ["init", "-q"], { cwd: dir });
        writeFileSync(join(dir, "ok.yaml"), OK_WORKFLOW);
        return dir;
      };
      const [held, clashing] = [inFolder(), inFolder()];
      const { env, home, fakeOut } = makeEnv();
      expect(yok(held, env, "project", "add").stdout).toContain("added repo");

      const run = yok(clashing, env, "run", "ok.yaml", "--prompt", "x", "--no-open");

      expect(run.code).toBe(1);
      expect(run.stderr).toContain("conflict: a project named repo already exists");
      expect(run.stderr).toContain(
        "add this checkout under another name with yok project add NAME, then pass --project NAME",
      );
      expect(readLines(fakeOut).some(isLaunch)).toBe(false);
      expect(existsSync(join(home, "registry.json"))).toBe(false);

      stopServer(held, env);
    },
    TIMEOUT_MS,
  );

  test(
    "SC106: a run in a repo whose .yok/types is from yok 0.0.0-0 starts and leaves the CLI's types there",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();
      const types = join(repo, ".yok", "types");
      mkdirSync(types, { recursive: true });
      writeFileSync(join(types, "VERSION"), "0.0.0-0\n");

      expect(yok(repo, env, "run", "ok.yaml", "--prompt", "hi", "--no-open").code).toBe(0);
      waitFor(() => readLines(fakeOut).some(isLaunch));

      expect(readFileSync(join(types, "VERSION"), "utf8").trim()).toBe(VERSION);
      expect(existsSync(join(types, "index.d.ts"))).toBe(true);

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  describe("one default run", () => {
    const sharedCleanups: Array<() => void> = [];
    let repo = "";
    let testEnv: TestEnv = { home: "", socket: "", fakeOut: "", env: {} };
    let run = { code: 1, stdout: "", stderr: "" };
    let launch: Record<string, unknown> | undefined;

    beforeAll(() => {
      repo = makeRepo();
      testEnv = makeEnv(sharedCleanups);
      run = yok(repo, testEnv.env, "run", "ok.yaml", "--prompt", "hi");
      waitFor(() => readLines(testEnv.fakeOut).some(isLaunch));
      launch = readLines(testEnv.fakeOut).find(isLaunch);
    }, TIMEOUT_MS);

    afterAll(() => {
      stopServer(repo, testEnv.env);
      for (const cleanup of sharedCleanups.splice(0)) cleanup();
    });

    test("SC12: starts a server, launches the fake agent, and server status shows a pid", () => {
      expect(run.code).toBe(0);
      const [runId, attach] = run.stdout.trim().split("\n");
      expect(runId).toMatch(/^r-[0-9a-f]{8}$/);
      // From source the hint names yok-dev: a plain `yok` is the release binary, whose home has no such run.
      expect(attach).toBe(`yok-dev attach --run-id ${runId}`);

      const status = yok(repo, testEnv.env, "server", "status");
      expect(status.code).toBe(0);
      expect(status.stdout).toMatch(/^pid \d+/);

      const argv = launch?.argv as string[] | undefined;
      expect(argv?.at(-1)).toContain(`/yok:orchestrate --workflow ${join(repo, "ok.yaml")}`);
      expect(launch?.runId).toBe(runId);
    });

    test("SC26, SC18: the launched session carries the Stop and PreToolUse hooks", () => {
      const argv = launch?.argv;
      const args = Array.isArray(argv) ? argv.map(String) : [];
      const settings = JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}");

      expect(settings.hooks.Stop[0].hooks[0].command).toContain(
        "packages/cli/src/index.ts' 'orchestrate' 'hook' 'stop' '--agent' 'claude'",
      );
      expect(settings.hooks.PreToolUse[0].matcher).toBe("Write|Edit|MultiEdit|NotebookEdit|Bash");
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(
        "packages/cli/src/index.ts' 'orchestrate' 'hook' 'pre-tool-use' '--agent' 'claude'",
      );
    });

    test(
      "SC6: the run starts with no session, its terminal is the launched tmux name, and a SessionStart hook call links the session",
      () => {
        const runId = run.stdout.trim().split("\n")[0] ?? "";
        expect(launch?.argv).not.toContain("--session-id");

        const registryFile = join(testEnv.home, "registry.json");
        const saved = () => JSON.parse(readFileSync(registryFile, "utf8")).runs[runId];
        expect(saved().sessions).toEqual([]);
        const tmuxNames = spawnSync(
          "tmux",
          ["-L", testEnv.socket, "list-sessions", "-F", "#{session_name}"],
          { encoding: "utf8" },
        ).stdout.split("\n");
        expect(tmuxNames).toContain(saved().terminal);

        const hook = spawnSync(
          "bun",
          [
            ...ORCHESTRATE,
            "hook",
            "session-start",
            "--agent",
            "claude",
            "--handler",
            "link-session",
          ],
          {
            cwd: String(launch?.cwd),
            env: launch?.env as NodeJS.ProcessEnv,
            input: JSON.stringify({
              session_id: "claude-chose-this",
              source: "startup",
              cwd: repo,
            }),
            encoding: "utf8",
          },
        );
        expect(hook.status).toBe(0);
        expect(saved().sessions).toEqual([{ agent: "claude", sessionId: "claude-chose-this" }]);
      },
      TIMEOUT_MS,
    );
  });

  test(
    "at LOG_LEVEL=debug, run logs its run id, and each request's reqId matches server.log",
    () => {
      const repo = makeRepo();
      const { env, home } = makeEnv();

      const run = yok(repo, { ...env, LOG_LEVEL: "debug" }, "run", "ok.yaml", "--prompt", "hi");
      expect(run.code).toBe(0);
      const runId = run.stdout.trim().split("\n")[0];
      const cliLines = run.stderr
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(cliLines).toContainEqual(
        expect.objectContaining({ component: "cli", command: "run", msg: "run started", runId }),
      );
      const post = cliLines.find(
        (line) => line.msg === "server request finished" && line.path === "/runs",
      );
      expect(typeof post?.reqId).toBe("string");
      expect(readFileSync(join(home, "server.log"), "utf8")).toContain(`"reqId":"${post?.reqId}"`);

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "SC309: a workflow's env check for an unset key blocks the run before any agent launches",
    () => {
      const repo = makeRepo();
      const { env, home, fakeOut } = makeEnv();
      const doctor = [
        "doctor:",
        "  - check: env",
        "    key: YOK_E2E_UNSET_KEY",
        "    fix: Set YOK_E2E_UNSET_KEY in .env",
      ];
      writeFileSync(join(repo, "needs-key.yaml"), [...doctor, OK_WORKFLOW].join("\n"));
      const { YOK_E2E_UNSET_KEY: _, ...withoutKey } = env;

      const run = yok(repo, withoutKey, "run", "needs-key.yaml", "--prompt", "x");
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("BLOCKED env:YOK_E2E_UNSET_KEY");
      const launches = readLines(fakeOut).filter((record) => isLaunch(record));
      expect(launches).toEqual([]);
      expect(existsSync(join(home, "registry.json"))).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "a notifier without the Slack keys blocks the run; the same keys in the workflow's env let it start",
    () => {
      const repo = makeRepo();
      const { env } = makeEnv();
      const { SLACK_BOT_TOKEN: _token, SLACK_CHANNEL_ID: _channel, ...withoutKeys } = env;
      const notifierWorkflow = `notifier: {}\n${OK_WORKFLOW}`;
      writeFileSync(join(repo, "bare.yaml"), notifierWorkflow);
      writeFileSync(
        join(repo, "keyed.yaml"),
        `env:\n  SLACK_BOT_TOKEN: xoxb-e2e\n  SLACK_CHANNEL_ID: C1\n${notifierWorkflow}`,
      );

      const blocked = yok(repo, withoutKeys, "run", "bare.yaml", "--prompt", "x");
      expect(blocked.code).toBe(1);
      expect(blocked.stderr).toContain("BLOCKED notifier");

      const started = yok(repo, withoutKeys, "run", "keyed.yaml", "--prompt", "x", "--no-open");
      expect(started.stderr).not.toContain("BLOCKED");
      expect(started.code).toBe(0);

      stopServer(repo, withoutKeys);
    },
    TIMEOUT_MS,
  );

  test(
    "a workflow with samskara: {} and a samskara that exits 127 blocks the run before any agent launches",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();
      const bin = mkdtempSync(join(tmpdir(), "yok-run-e2e-bin-"));
      cleanups.push(() => rmSync(bin, { recursive: true, force: true }));
      writeFileSync(join(bin, "samskara"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
      writeFileSync(join(repo, "samskara.yaml"), `samskara: {}\n${OK_WORKFLOW}`);

      const run = yok(
        repo,
        { ...env, PATH: `${bin}:${env.PATH}` },
        "run",
        "samskara.yaml",
        "--prompt",
        "x",
      );

      expect(run.code).toBe(1);
      expect(run.stderr).toContain("BLOCKED samskara-upload");
      expect(readLines(fakeOut).filter((record) => isLaunch(record))).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "--config FILE, resolved against the current folder, is saved on the run and recorded by init, even with no config in the repo",
    () => {
      const repo = makeRepo();
      rmSync(join(repo, "orchestrate.config.json"));
      mkdirSync(join(repo, "configs"));
      const file = join(repo, "configs", "custom.json");
      writeFileSync(file, '{ "version": 2 }\n');
      const { env, home, fakeOut } = makeEnv();

      const run = yok(
        join(repo, "configs"),
        env,
        "run",
        "../ok.yaml",
        "--prompt",
        "hi",
        "--config",
        "custom.json",
      );
      expect(run.stderr).not.toContain("BLOCKED");
      expect(run.code).toBe(0);
      const runId = run.stdout.trim().split("\n")[0] ?? "";
      const registry = JSON.parse(readFileSync(join(home, "registry.json"), "utf8"));
      expect(registry.runs[runId].config).toBe(file);
      waitFor(() => readLines(fakeOut).some(isLaunch));
      const launch = readLines(fakeOut).find(isLaunch);
      const init = spawnSync("bun", [...ORCHESTRATE, "init", "fix-login"], {
        cwd: String(launch?.cwd),
        env: launch?.env as NodeJS.ProcessEnv,
        encoding: "utf8",
      });
      expect(init.status).toBe(0);
      const state = JSON.parse(readFileSync(join(repo, ".yok", "fix-login", "state.json"), "utf8"));
      expect(state.config).toEqual({ path: file, root: join(repo, "configs") });

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test.each([
    ["--interaction false", ["ok.yaml", "--interaction", "false"], "cli"],
    ["a workflow file with interaction: false", ["unattended.yaml"], "workflow"],
  ] as const)(
    "SC510: %s is saved on the run as interaction false, with where it came from",
    (_case, args, source) => {
      const repo = makeRepo();
      writeFileSync(
        join(repo, "unattended.yaml"),
        OK_WORKFLOW.replace("name: ok", "name: ok\npolicies:\n  interaction: false"),
      );
      const { env, home } = makeEnv();

      const run = yok(repo, env, "run", ...args, "--prompt", "x");

      expect(run.stderr).not.toContain("BLOCKED");
      expect(run.code).toBe(0);
      const runId = run.stdout.trim().split("\n")[0] ?? "";
      const registry = JSON.parse(readFileSync(join(home, "registry.json"), "utf8"));
      expect(registry.runs[runId].policies).toEqual({
        values: { interaction: false },
        sources: { interaction: source },
      });

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test.each([
    ["a missing file", (_file: string) => {}],
    ["an invalid file", (file: string) => writeFileSync(file, "{")],
    ["a directory", (file: string) => mkdirSync(file)],
  ])(
    "--config naming %s stops yok run before any run or session starts",
    (_case, create) => {
      const repo = makeRepo();
      const file = join(repo, "custom.json");
      create(file);
      const { env, home, fakeOut } = makeEnv();

      const run = yok(repo, env, "run", "ok.yaml", "--prompt", "x", "--config", "custom.json");

      expect(run.code).toBe(1);
      expect(run.stderr).toContain(file);
      expect(readLines(fakeOut).some(isLaunch)).toBe(false);
      expect(existsSync(join(home, "registry.json"))).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "SC13: a cyclic workflow fails to compile on the server and records no run",
    () => {
      const repo = makeRepo();
      const { env, home } = makeEnv();

      const run = yok(repo, { ...env, LOG_LEVEL: "" }, "run", "bad.yaml", "--prompt", "x");
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("cycle: dependency cycle among");
      expect(run.stderr).not.toContain("    at ");
      expect(existsSync(join(home, "registry.json"))).toBe(false);

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "SC105: the first command in an empty home starts a server it can use, a request without the key is 401, and stop stops it",
    async () => {
      const repo = makeRepo();
      const { env, home, fakeOut } = makeEnv();
      const unused = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const stalePort = unused.port;
      await unused.stop(true);
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "server.port"), String(stalePort));

      const run = yok(repo, env, "run", "ok.yaml", "--prompt", "x", "--no-attach", "--no-open");
      expect(run.code).toBe(0);
      waitFor(() => readLines(fakeOut).some(isLaunch));
      expect(readApiKey(home)).toMatch(/^[\w-]{40,}$/);
      const port = readPort(home);
      const pid = Number(readFileSync(join(home, "server.pid"), "utf8"));

      const anonymous = await fetch(`http://127.0.0.1:${port}/runs/view`);
      expect(anonymous.status).toBe(401);

      expect(yok(repo, env, "server", "stop").code).toBe(0);
      expect(existsSync(join(home, "server.pid"))).toBe(false);
      expect(() => process.kill(pid, 0)).toThrow();
    },
    TIMEOUT_MS,
  );

  test(
    "SC15: two runs started together succeed with different ids and one server",
    async () => {
      const repo = makeRepo();
      const { env, home } = makeEnv();

      const [a, b] = await Promise.all([
        spawnHarness(repo, env, ["run", "ok.yaml", "--prompt", "x"]),
        spawnHarness(repo, env, ["run", "ok.yaml", "--prompt", "x"]),
      ]);
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      const idA = a.stdout.trim().split("\n")[0];
      const idB = b.stdout.trim().split("\n")[0];
      expect(idA).not.toBe(idB);

      const registry = JSON.parse(readFileSync(join(home, "registry.json"), "utf8")) as {
        runs: Record<string, unknown>;
      };
      expect(Object.keys(registry.runs).sort()).toEqual(
        [idA, idB].filter((id) => id !== undefined).sort(),
      );
      expect(serverPids(home)).toHaveLength(1);

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "from source, a run replaces the server an earlier command started, so it runs the new code",
    () => {
      const repo = makeRepo();
      const { env, home } = makeEnv();
      const pid = (): string => yok(repo, env, "server", "status").stdout.split(",")[0] ?? "";

      expect(yok(repo, env, "run", "ok.yaml", "--prompt", "x").code).toBe(0);
      const first = pid();
      expect(yok(repo, env, "run", "ok.yaml", "--prompt", "x").code).toBe(0);
      const second = pid();

      expect(first).toMatch(/^pid \d+$/);
      expect(second).toMatch(/^pid \d+$/);
      expect(second).not.toBe(first);
      expect(serverPids(home)).toHaveLength(1);

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "restartServer replaces a running server and leaves a stopped one down",
    async () => {
      const repo = makeRepo();
      const { env, home } = makeEnv();
      const self = process.env.YOK_SELF;
      process.env.YOK_SELF = JSON.stringify(["bun", NO_DOTENV, CLI]);
      cleanups.push(() => {
        if (self === undefined) delete process.env.YOK_SELF;
        else process.env.YOK_SELF = self;
      });
      // A client is bound to the port the server had when it was made.
      const health = () => yokClient(home).health();

      await restartServer(home);
      expect((await health()).ok).toBe(false);

      expect(yok(repo, env, "run", "ok.yaml", "--prompt", "x").code).toBe(0);
      const before = await health();
      await restartServer(home);
      const after = await health();

      expect(before.ok && after.ok).toBe(true);
      expect(after.ok && after.value.pid).not.toBe(before.ok && before.value.pid);
      expect(serverPids(home)).toHaveLength(1);

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "SC16: server stop removes the pid file but the run's tmux session stays alive",
    () => {
      const repo = makeRepo();
      const { env, home, socket } = makeEnv();

      const run = yok(repo, env, "run", "ok.yaml", "--prompt", "x");
      expect(run.code).toBe(0);

      const stop = yok(repo, env, "server", "stop");
      expect(stop.code).toBe(0);
      expect(existsSync(join(home, "server.pid"))).toBe(false);

      const sessions = spawnSync("tmux", ["-L", socket, "list-sessions", "-F", "#{session_name}"], {
        encoding: "utf8",
      });
      expect(sessions.stdout.trim().length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  test(
    "SC17: doctor --json rows include tmux and claude",
    () => {
      const repo = makeRepo();
      const { env } = makeEnv();

      const result = yok(repo, env, "doctor", "--json");
      const json = DoctorJsonSchema.parse(JSON.parse(result.stdout));
      const names = json.results.map((row) => row.name);
      expect(names).toContain("tmux");
      expect(names).toContain("claude");
    },
    TIMEOUT_MS,
  );

  test(
    "SC72, SC108: a dev server in HOME/.yok-dev and a release-home server in YOK_HOME answer on their own ports with their own keys, list only their own run, and shim it under their own home",
    async () => {
      const repo = makeRepo();
      const base = makeEnv();
      const { YOK_HOME: _home, ...withoutHome } = base.env;
      const userHome = realpathSync(mkdtempSync(join(tmpdir(), "yok-user-home-")));
      const devHome = join(userHome, ".yok-dev");
      const releaseHome = join(userHome, ".yok");
      const out = (name: string) => join(base.home, `${name}.jsonl`);
      const sides = [
        { home: devHome, fakeOut: out("dev"), env: { ...withoutHome, HOME: userHome } },
        {
          home: releaseHome,
          fakeOut: out("release"),
          env: {
            ...base.env,
            YOK_HOME: releaseHome,
            YOK_TMUX_SOCKET: `${base.socket}-release`,
          },
        },
      ].map((side) => ({ ...side, env: { ...side.env, FAKE_AGENT_OUT: side.fakeOut } }));
      cleanups.push(() => {
        for (const { home } of sides)
          for (const pid of serverPids(home)) process.kill(pid, "SIGKILL");
        spawnSync("tmux", ["-L", `${base.socket}-release`, "kill-server"]);
      });
      const ask = (home: string, path: string, keyHome: string = home) =>
        fetch(`http://127.0.0.1:${readPort(home)}${path}`, {
          headers: { authorization: `Bearer ${readApiKey(keyHome)}` },
        });

      const runIds = sides.map(({ env }) => {
        const run = yok(repo, env, "run", "ok.yaml", "--prompt", "x");
        expect(run.code).toBe(0);
        return run.stdout.trim().split("\n")[0] ?? "";
      });

      for (const [index, side] of sides.entries()) {
        const other = sides[1 - index]?.home ?? "";
        expect((await ask(side.home, "/health")).status).toBe(200);
        const registry = JSON.parse(readFileSync(join(side.home, "registry.json"), "utf8")) as {
          runs: Record<string, unknown>;
        };
        expect(Object.keys(registry.runs)).toEqual([runIds[index] ?? ""]);
        expect((await ask(other, `/runs/${runIds[index]}/view`)).status).toBe(404);
        expect((await ask(other, "/runs/view", side.home)).status).toBe(401);
        waitFor(() => readLines(side.fakeOut).some(isLaunch));
        const launched = readLines(side.fakeOut).find(isLaunch)?.env as Record<string, string>;
        const [shimDir = ""] = (launched.PATH ?? "").split(":");
        expect(dirname(shimDir)).toBe(join(side.home, "shims"));
      }
      expect(readPort(devHome)).not.toBe(readPort(releaseHome));
      expect(readApiKey(devHome)).not.toBe(readApiKey(releaseHome));

      for (const { env } of sides) stopServer(repo, env);
    },
    TIMEOUT_MS,
  );
});

describe("server ownership", () => {
  // Stands in for another local user's process on the port in server.port, while this home's
  // server is down. It claims to be a current yok server with the given pid.
  const squat = (home: string, pid: number) => {
    const seen: Array<string | null> = [];
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        seen.push(request.headers.get("authorization"));
        return Response.json({ pid, version: VERSION, startedAt: Date.now() + 3_600_000 });
      },
    });
    cleanups.push(() => void squatter.stop(true));
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "server.port"), String(squatter.port));
    return { seen, port: squatter.port };
  };

  test(
    "a process on the saved port whose pid is not this home's server.pid gets no key, and this home starts its own server on another port",
    async () => {
      const repo = makeRepo();
      const { env, home } = makeEnv();
      const { seen, port } = squat(home, 1);

      const listed = await spawnHarness(repo, env, ["project", "list"]);

      expect(listed.code).toBe(0);
      expect(listed.stdout).toBe("no projects; add one with yok project add\n");
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.filter((authorization) => authorization !== null)).toEqual([]);
      expect(readPort(home)).not.toBe(port);

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "a server from before the HTTP API, still on HOME/yok.sock and named in server.pid, is stopped and its socket removed when a command starts the new one",
    async () => {
      const repo = makeRepo();
      const { env, home } = makeEnv();
      mkdirSync(home, { recursive: true });
      const socket = join(home, "yok.sock");
      const serve = `Bun.serve({ unix: ${JSON.stringify(socket)}, fetch: () => Response.json({ pid: process.pid, version: "0.0.0", startedAt: 0 }) })`;
      const old = spawn("bun", ["-e", serve]);
      cleanups.push(() => old.kill("SIGKILL"));
      writeFileSync(join(home, "server.pid"), String(old.pid));
      waitFor(() => existsSync(socket));

      const listed = await spawnHarness(repo, env, ["project", "list"]);

      expect(listed.code).toBe(0);
      for (let i = 0; i < 50 && old.signalCode === null && old.exitCode === null; i++) {
        await Bun.sleep(100);
      }
      expect(old.signalCode).toBe("SIGTERM");
      expect(existsSync(socket)).toBe(false);
      expect(readFileSync(join(home, "server.pid"), "utf8")).not.toBe(String(old.pid));

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test.skipIf(process.platform !== "linux")(
    "a server the CLI starts gets neither YOK_API_KEY nor YOK_SERVER_URL from the CLI's environment",
    () => {
      const repo = makeRepo();
      const { env, home } = makeEnv();
      const exported = { ...env, YOK_API_KEY: "remote-key-leak", YOK_SERVER_URL: "" };

      expect(yok(repo, exported, "project", "list").code).toBe(0);

      const pid = readFileSync(join(home, "server.pid"), "utf8");
      const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      expect(environ.filter((entry) => entry.startsWith("YOK_API_KEY="))).toEqual([]);
      expect(environ.filter((entry) => entry.startsWith("YOK_SERVER_URL="))).toEqual([]);
      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "a process on the saved port that replays a server.pid naming a dead process gets no key, and this home starts its own server",
    async () => {
      const repo = makeRepo();
      const { env, home } = makeEnv();
      const dead = spawnSync("true").pid;
      const { seen, port } = squat(home, dead);
      writeFileSync(join(home, "server.pid"), String(dead));

      const listed = await spawnHarness(repo, env, ["project", "list"]);

      expect(listed.code).toBe(0);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.filter((authorization) => authorization !== null)).toEqual([]);
      expect(readPort(home)).not.toBe(port);

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "server stop signals no pid that only a reply on the port vouches for",
    async () => {
      const repo = makeRepo();
      const { env, home } = makeEnv();
      const bystander = spawn("sleep", ["30"]);
      cleanups.push(() => bystander.kill("SIGKILL"));
      squat(home, bystander.pid ?? 0);

      const stop = await spawnHarness(repo, env, ["server", "stop"]);

      expect(stop.code).toBe(1);
      expect(stop.stderr).toContain("not running");
      expect(bystander.signalCode).toBeNull();
      expect(bystander.exitCode).toBeNull();
    },
    TIMEOUT_MS,
  );
});

describe("yok project", () => {
  test(
    "SC209: yok project add in a checkout, list and remove round-trip from the CLI",
    () => {
      const parent = realpathSync(mkdtempSync(join(tmpdir(), "yok-project-e2e-")));
      const checkout = join(parent, "Demo_Repo");
      mkdirSync(checkout);
      execFileSync("git", ["init", "-q"], { cwd: checkout });
      const { env } = makeEnv();

      const added = yok(checkout, env, "project", "add");
      expect(added.stdout).toContain(`added demo-repo  ${checkout}`);
      expect(added.stdout).toContain("ENVIRONMENT");
      expect(added.stdout).toContain("VERDICT");

      const listed = yok(checkout, env, "project", "list");
      expect(listed.code).toBe(0);
      expect(listed.stdout).toMatch(new RegExp(`^demo-repo +\\w+ +${checkout} +cli$`, "m"));

      const removed = yok(checkout, env, "project", "remove", "demo-repo");
      expect(removed.code).toBe(0);
      expect(removed.stdout).toBe("removed demo-repo\n");
      expect(yok(checkout, env, "project", "list").stdout).toBe(
        "no projects; add one with yok project add\n",
      );

      stopServer(checkout, env);
    },
    TIMEOUT_MS,
  );

  test(
    "yok project list under umask 002 creates a missing YOK_HOME as 700, not the 775 the start lock left",
    () => {
      const { env } = makeEnv();
      const home = join(env.YOK_HOME ?? "", "fresh");
      const freshEnv = { ...env, YOK_HOME: home };

      const listed = spawnSync(
        "sh",
        ["-c", 'umask 002; exec bun "$@"', "sh", NO_DOTENV, CLI, "project", "list"],
        {
          cwd: tmpdir(),
          env: freshEnv,
          encoding: "utf8",
        },
      );

      expect(listed.status).toBe(0);
      expect(statSync(home).mode & 0o777).toBe(0o700);
      stopServer(tmpdir(), freshEnv);
    },
    TIMEOUT_MS,
  );

  test.each([
    [["Bad_Name"], '"Bad_Name" is not a valid project name'],
    [[], 'cannot name the project from "1checkout"; pass a NAME'],
  ])("yok project add %p in the checkout 1checkout refuses with %p", (args, message) => {
    const checkout = join(
      realpathSync(mkdtempSync(join(tmpdir(), "yok-project-e2e-"))),
      "1checkout",
    );
    mkdirSync(checkout);
    execFileSync("git", ["init", "-q"], { cwd: checkout });

    const added = yok(checkout, makeEnv().env, "project", "add", ...args);

    expect(added.code).toBe(1);
    expect(added.stderr).toContain(message);
  });
});

describe("yok run against a fake server", () => {
  // A server that records every request body and starts run r-1 with interaction off.
  const fakeServer = () => {
    const bodies: unknown[] = [];
    const run = {
      id: "r-1",
      policies: { values: { interaction: false }, sources: { interaction: "cli" } },
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        if (new URL(req.url).pathname === "/health") return Response.json({ pid: 1 });
        bodies.push(await req.json());
        return Response.json({ run, attach: ["tmux"], view: "http://x/runs/r-1" }, { status: 201 });
      },
    });
    cleanups.push(() => server.stop(true));
    const { env } = makeEnv();
    const laptop = { ...env, YOK_SERVER_URL: server.url.origin, YOK_API_KEY: "k" };
    return { bodies, laptop, cwd: makeRepo() };
  };

  test(
    "SC605: yok run --interaction false sends the flag as the request's policies, and neither opens nor attaches",
    async () => {
      const { bodies, laptop, cwd } = fakeServer();
      const args = ["run", "task", "--project", "demo", "--prompt", "x", "--interaction", "false"];

      const run = await spawnHarness(cwd, laptop, args);

      expect(run.code).toBe(0);
      expect(bodies).toEqual([
        {
          project: "demo",
          workflow: "task",
          inputs: { prompt: "x" },
          policies: { interaction: false },
        },
      ]);
      expect(run.stdout).toBe("r-1\nview: http://x/runs/r-1\n");
    },
    TIMEOUT_MS,
  );

  test(
    "SC509, SC606: yok run --interaction maybe exits 1 naming the flag and the allowed values, and sends no request",
    async () => {
      const { bodies, laptop, cwd } = fakeServer();
      const args = ["run", "task", "--project", "demo", "--prompt", "x", "--interaction", "maybe"];

      const run = await spawnHarness(cwd, laptop, args);

      expect(run.code).toBe(1);
      expect(run.stderr).toContain("--interaction maybe: must be true or false");
      expect(bodies).toEqual([]);
    },
    TIMEOUT_MS,
  );
});

describe("remote server", () => {
  // Server A in its own home with project demo, and the env of a CLI in an empty home B that
  // points at it, as a laptop would.
  const remoteSetup = () => {
    const repo = makeRepo();
    const a = makeEnv();
    const b = makeEnv();
    expect(yok(repo, a.env, "project", "add", "demo").code).toBe(0);
    const url = `http://127.0.0.1:${readPort(a.home)}`;
    const key = readApiKey(a.home) ?? "";
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "yok-laptop-")));
    cleanups.push(() => stopServer(repo, a.env));
    return { repo, a, b, url, key, elsewhere };
  };

  test(
    "SC403: a CLI pointed at another home's server lists its projects and starts a run there, without attaching or starting a server of its own",
    () => {
      const { a, b, url, key, elsewhere } = remoteSetup();
      const laptop = { ...b.env, YOK_SERVER_URL: url, YOK_API_KEY: key };

      const listed = yok(elsewhere, laptop, "project", "list");
      const run = yok(elsewhere, laptop, "run", "ok.yaml", "--project", "demo", "--prompt", "x");

      expect(listed.code).toBe(0);
      expect(listed.stdout).toMatch(/^demo /m);
      expect(run.code).toBe(0);
      const [runId = "", view = "", ...rest] = run.stdout.trim().split("\n");
      expect(view).toStartWith("view: ");
      expect(rest).toEqual([]);
      expect(run.stdout).not.toContain("attach");
      const registry = JSON.parse(readFileSync(join(a.home, "registry.json"), "utf8"));
      expect(Object.keys(registry.runs)).toEqual([runId]);
      for (const file of ["server.pid", "server.port", ".env"]) {
        expect(existsSync(join(b.home, file))).toBe(false);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "SC405: yok server use saves the URL and key, start is refused while it is set, and use local clears it",
    () => {
      const { b, url, key, elsewhere } = remoteSetup();
      const clientEnv = join(b.home, "client.env");

      const used = yok(elsewhere, b.env, "server", "use", url, "--key", key);
      expect(used.code).toBe(0);
      expect(used.stdout).toBe(`using ${url}, 1 projects\n`);
      expect(readFileSync(clientEnv, "utf8")).toBe(`YOK_SERVER_URL=${url}\nYOK_API_KEY=${key}\n`);
      expect(statSync(clientEnv).mode & 0o777).toBe(0o600);

      expect(yok(elsewhere, b.env, "project", "list").stdout).toMatch(/^demo /m);
      const start = yok(elsewhere, b.env, "server", "start");
      expect(start.code).toBe(1);
      expect(start.stderr).toContain("run yok server use local first");

      expect(yok(elsewhere, b.env, "server", "use", "local").code).toBe(0);
      expect(existsSync(clientEnv)).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "SC406: yok server use refuses plain http to another machine and a wrong key, and writes nothing",
    () => {
      const { b, url, elsewhere } = remoteSetup();

      const plain = yok(elsewhere, b.env, "server", "use", "http://example.com", "--key", "K");
      const wrong = yok(elsewhere, b.env, "server", "use", url, "--key", "wrong");

      expect(plain.code).toBe(1);
      expect(plain.stderr).toContain("must use https:// unless the server is on this machine");
      expect(wrong.code).toBe(1);
      expect(wrong.stderr).toContain("unauthorized");
      expect(existsSync(join(b.home, "client.env"))).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "SC407: a remote server that does not answer is reported, and nothing local starts",
    () => {
      const b = makeEnv();
      const laptop = { ...b.env, YOK_SERVER_URL: "http://127.0.0.1:1", YOK_API_KEY: "k" };
      const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "yok-laptop-")));

      const listed = yok(elsewhere, laptop, "project", "list");

      expect(listed.code).toBe(1);
      expect(listed.stderr).toContain("the yok server at http://127.0.0.1:1 is not answering");
      expect(existsSync(join(b.home, "server.pid"))).toBe(false);
    },
    TIMEOUT_MS,
  );
});
