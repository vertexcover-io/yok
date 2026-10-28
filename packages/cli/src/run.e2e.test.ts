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
import { readPort } from "@yok/server";
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
  "inputs:",
  "  prompt: { type: string }",
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
    env: {
      ...process.env,
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
    "a workflow whose required topic input is not given fails the run before any session starts",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();
      writeFileSync(
        join(repo, "topic.yaml"),
        OK_WORKFLOW.replace("nodes:", "  topic: { type: string, required: true }\nnodes:"),
      );

      const result = yok(repo, env, "run", "topic.yaml", "--prompt", "hi", "--no-open");

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("inputs.topic");
      expect(readLines(fakeOut).some(isLaunch)).toBe(false);

      stopServer(repo, env);
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
    "SC308: a run in a checkout whose config is invalid is refused with the config's error, though adding never loads the config, so the checkout stays a project",
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
      expect(listed.projects).toEqual([expect.objectContaining({ path: repo, status: "ready" })]);
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
        (line) => line.msg === "server request finished" && line.path === "/api/runs",
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

  test(
    "--config naming a missing file stops yok run before any run or session starts",
    () => {
      const repo = makeRepo();
      const file = join(repo, "custom.json");
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
    "SC1012: in an empty home, yok run and yok view use the one port in server.port, with no viewer.port and no key, and stop stops the server",
    async () => {
      const repo = makeRepo();
      const { env, home } = makeEnv();

      const run = yok(repo, env, "run", "ok.yaml", "--prompt", "x", "--no-attach", "--no-open");
      expect(run.code).toBe(0);
      const port = readPort(home);
      const [runId = "", , view = ""] = run.stdout.trim().split("\n");
      expect(view).toBe(`view: http://localhost:${port}/runs/${runId}`);
      const page = await fetch(view.slice("view: ".length));
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");

      const printed = yok(repo, env, "view", "--print");
      expect([printed.code, printed.stdout.trim()]).toEqual([0, `http://localhost:${port}/`]);
      expect(existsSync(join(home, "viewer.port"))).toBe(false);
      expect(existsSync(join(home, ".env"))).toBe(false);

      const pid = Number(readFileSync(join(home, "server.pid"), "utf8"));
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
    "SC72, SC108: a dev server in HOME/.yok-dev and a release-home server in YOK_HOME answer on their own ports, list only their own run, and shim it under their own home",
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
      const ask = (home: string, path: string) =>
        fetch(`http://127.0.0.1:${readPort(home)}${path}`);

      const runIds = sides.map(({ env }) => {
        const run = yok(repo, env, "run", "ok.yaml", "--prompt", "x");
        expect(run.code).toBe(0);
        return run.stdout.trim().split("\n")[0] ?? "";
      });

      for (const [index, side] of sides.entries()) {
        const other = sides[1 - index]?.home ?? "";
        expect((await ask(side.home, "/api/health")).status).toBe(200);
        const registry = JSON.parse(readFileSync(join(side.home, "registry.json"), "utf8")) as {
          runs: Record<string, unknown>;
        };
        expect(Object.keys(registry.runs)).toEqual([runIds[index] ?? ""]);
        expect((await ask(other, `/api/runs/${runIds[index]}/view`)).status).toBe(404);
        waitFor(() => readLines(side.fakeOut).some(isLaunch));
        const launched = readLines(side.fakeOut).find(isLaunch)?.env as Record<string, string>;
        const [shimDir = ""] = (launched.PATH ?? "").split(":");
        expect(dirname(shimDir)).toBe(join(side.home, "shims"));
      }
      expect(readPort(devHome)).not.toBe(readPort(releaseHome));

      for (const { env } of sides) stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "SC611: yok run --no-attach --no-open prints three lines: the run id, yok-dev attach --run-id ID, and view: URL",
    () => {
      const repo = makeRepo();
      const { env } = makeEnv();

      const run = yok(repo, env, "run", "ok.yaml", "--prompt", "go", "--no-attach", "--no-open");

      expect(run.code).toBe(0);
      const [runId = "", ...rest] = run.stdout.trim().split("\n");
      expect(runId).toMatch(/^r-[0-9a-f]{8}$/);
      expect(rest).toEqual([
        `yok-dev attach --run-id ${runId}`,
        expect.stringMatching(/^view: http/),
      ]);
      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );
});

describe("yok resume", () => {
  test(
    "yok resume --run-id for a run that never ran orchestrate init tells the person to start it again with yok run",
    () => {
      const repo = makeRepo();
      const { env } = makeEnv();
      const started = yok(
        repo,
        env,
        "run",
        "ok.yaml",
        "--prompt",
        "go",
        "--no-attach",
        "--no-open",
      );
      expect(started.code).toBe(0);
      const runId = started.stdout.trim().split("\n")[0] ?? "";

      const resumed = yok(repo, env, "resume", "--run-id", runId, "--no-attach", "--no-open");

      expect(resumed.code).toBe(1);
      expect(resumed.stderr).toContain(
        `run ${runId} never started its agent session; start it again with yok run`,
      );
      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "SC610: after its tmux server is killed, yok resume demo relaunches claude --resume s-1 with the resume prompt, and a second resume is told to attach",
    () => {
      const repo = makeRepo();
      const { env, fakeOut, socket } = makeEnv();
      const launches = () => readLines(fakeOut).filter(isLaunch);
      const started = yok(
        repo,
        env,
        "run",
        "ok.yaml",
        "--name",
        "demo",
        "--prompt",
        "go",
        "--no-attach",
        "--no-open",
      );
      expect(started.code).toBe(0);
      const runId = started.stdout.trim().split("\n")[0] ?? "";
      waitFor(() => launches().length === 1);
      // what the agent would run inside its session: init names the run, the hook links s-1
      const sessionEnv = launches()[0]?.env as NodeJS.ProcessEnv;
      const orchestrate = (...args: string[]) =>
        spawnSync("bun", [NO_DOTENV, ...ORCHESTRATE, ...args], {
          cwd: repo,
          env: sessionEnv,
          encoding: "utf8",
        });
      expect(orchestrate("init", "demo").status).toBe(0);
      expect(orchestrate("link-session", "--agent", "claude", "--session-id", "s-1").status).toBe(
        0,
      );
      spawnSync("tmux", ["-L", socket, "kill-server"]);

      const resumed = yok(repo, env, "resume", "demo", "--no-attach", "--no-open");

      expect(resumed.code).toBe(0);
      expect(resumed.stdout.trim().split("\n")).toEqual([
        runId,
        `yok-dev attach --run-id ${runId}`,
        expect.stringMatching(/^view: http/),
      ]);
      waitFor(() => launches().length === 2);
      const argv = (launches()[1]?.argv ?? []) as string[];
      expect(argv.slice(0, 2)).toEqual(["--resume", "s-1"]);
      expect(argv.at(-1)).toBe("/yok:orchestrate --resume demo");

      const again = yok(repo, env, "resume", "demo", "--no-attach", "--no-open");
      expect(again.code).toBe(1);
      expect(again.stderr).toContain("use yok attach demo");
      stopServer(repo, env);
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
      expect(added.code).toBe(0);
      expect(added.stdout).toBe(`added demo-repo  ${checkout}\n`);

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

describe("yok run flag checks", () => {
  test(
    "SC509, SC606: yok run --interaction maybe exits 1 naming the flag and the allowed values, and starts no server",
    async () => {
      const { env, home } = makeEnv();
      const args = ["run", "task", "--project", "demo", "--prompt", "x", "--interaction", "maybe"];

      const run = await spawnHarness(makeRepo(), env, args);

      expect(run.code).toBe(1);
      expect(run.stderr).toContain("--interaction maybe: must be true or false");
      expect(existsSync(join(home, "server.pid"))).toBe(false);
    },
    TIMEOUT_MS,
  );
});

describe("remote settings", () => {
  test(
    "SC1013: yok ignores YOK_SERVER_URL and YOK_API_KEY in the shell and in .env, and uses the server on this machine",
    () => {
      const repo = makeRepo();
      const { env, home } = makeEnv();
      const remote = "YOK_SERVER_URL=https://yok.example.com\nYOK_API_KEY=k\n";
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, ".env"), remote);
      const shell = { ...env, YOK_SERVER_URL: "https://yok.example.com", YOK_API_KEY: "k" };

      const listed = yok(repo, shell, "project", "list");
      expect(listed.code).toBe(0);
      expect(listed.stdout).not.toContain("yok.example.com");
      const pid = readFileSync(join(home, "server.pid"), "utf8");
      const status = yok(repo, shell, "server", "status");
      expect(status.stdout).toContain(`pid ${pid}`);
      expect(status.stdout + status.stderr).not.toContain("yok.example.com");
      const use = yok(repo, shell, "server", "use");
      expect(use.code).toBe(1);
      expect(use.stderr).toContain("unknown command 'use'");

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );
});

const REMOTE_PASSWORD = `p#ss'w"rd`;
const REMOTE_BASIC = `Basic ${Buffer.from(`ritesh:${REMOTE_PASSWORD}`).toString("base64")}`;
const STARTED_AT = Date.parse("2026-10-27T08:00:00.000Z");

type SeenRequest = Readonly<{ request: string; body: unknown }>;

// A yok server behind Caddy's basic_auth, as yok remote sees it: 401 without ritesh's login.
const fakeRemote = (
  answers: Readonly<Record<string, () => Response>> = {},
  version: string = VERSION,
): { url: string; seen: SeenRequest[] } => {
  const seen: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      const text = await request.text();
      const body: unknown = text === "" ? null : JSON.parse(text);
      seen.push({ request: `${request.method} ${url.pathname}${url.search}`, body });
      if (request.headers.get("authorization") !== REMOTE_BASIC) {
        return new Response("unauthorized", { status: 401 });
      }
      if (url.pathname === "/api/health") {
        return Response.json({ pid: 4242, version, startedAt: STARTED_AT });
      }
      const answer = answers[`${request.method} ${url.pathname}`];
      return answer === undefined ? new Response("no route", { status: 404 }) : answer();
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, seen };
};

// `yok --remote ARGS` with the login in the shell and an empty YOK_HOME of its own.
const remoteYok = async (
  url: string,
  args: readonly string[],
  password: string = REMOTE_PASSWORD,
): Promise<{ code: number; stdout: string; stderr: string; home: string }> => {
  const home = mkdtempSync(join(tmpdir(), "yok-remote-e2e-home-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const env = {
    ...process.env,
    YOK_HOME: home,
    YOK_SERVER_URL: url,
    YOK_SERVER_USER: "ritesh",
    YOK_SERVER_PASSWORD: password,
  };
  return { ...(await spawnHarness(home, env, ["--remote", ...args])), home };
};

const hasNoServer = (home: string): boolean =>
  !existsSync(join(home, "server.pid")) && !existsSync(join(home, "server.port"));

const routeCalls = (seen: readonly SeenRequest[]): readonly SeenRequest[] =>
  seen.filter((call) => call.request !== "GET /api/health");

const LINEAR_REPORT = {
  results: [
    {
      name: "LINEAR_API_KEY",
      status: "fail",
      optional: false,
      detail: "not set",
      fix: ["add LINEAR_API_KEY to .env"],
    },
  ],
  failed: ["LINEAR_API_KEY"],
  warned: [],
};

const DIGEST = {
  name: "digest",
  project: "web",
  cron: "0 9 * * *",
  timezone: "UTC",
  nextFireAt: "2026-10-28T09:00:00.000Z",
};

const DIGEST_FIRE = {
  triggerId: "t-1",
  slot: "2026-10-27T09:00:00.000Z",
  status: "started",
  runId: "r-9",
  runName: "digest-1",
  at: "2026-10-27T09:00:01.000Z",
};

describe("yok --remote", () => {
  test.each([
    ["a closed port", true],
    ["a proxy answering 502", false],
  ] as const)(
    "SC4006: with %s, a remote command stops with HOST is not answering and starts no local server",
    async (_case, closed) => {
      const proxy = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => new Response("bad gateway", { status: 502 }),
      });
      const host = `127.0.0.1:${proxy.port}`;
      if (closed) proxy.stop(true);
      else cleanups.push(() => proxy.stop(true));

      const listed = await remoteYok(`http://${host}`, ["project", "list"]);

      expect(listed.stderr).toContain(`${host} is not answering`);
      expect(listed.code).toBe(1);
      expect(hasNoServer(listed.home)).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "SC4007: a login the server rejects stops a remote command with the advice to log in again",
    async () => {
      const server = fakeRemote();

      const listed = await remoteYok(server.url, ["project", "list"], "wrong");

      expect(listed.stderr).toContain("wrong username or password; run yok-remote login again");
      expect(listed.code).toBe(1);
      expect(server.seen.map((call) => call.request)).toEqual(["GET /api/health"]);
    },
    TIMEOUT_MS,
  );

  test.each([
    ["the same version", VERSION, ""],
    ["another version", "9.9.9", `warning: this CLI is ${VERSION}, the server is 9.9.9`],
  ])(
    "SC4008: server status --remote against a server on %s prints both versions, the pid and the start time, and warns only on a mismatch",
    async (_case, version, warning) => {
      const server = fakeRemote({}, version);

      const status = await remoteYok(server.url, ["server", "status"]);

      expect(status.code).toBe(0);
      expect(status.stdout).toBe(
        [
          `server   ${server.url}`,
          `cli      ${VERSION}`,
          `version  ${version}`,
          "pid      4242",
          "started  2026-10-27T08:00:00.000Z",
          "",
        ].join("\n"),
      );
      expect(status.stderr.trim()).toBe(warning);
    },
    TIMEOUT_MS,
  );

  test.each([
    ["by default", false, []],
    ["with --interaction true", true, ["--interaction", "true"]],
  ] as const)(
    "SC4009: a remote run %s sends interaction %p, sends the paths as typed, and prints the server's link",
    async (_case, interaction, flags) => {
      const server = fakeRemote({
        "POST /api/runs": () =>
          Response.json(
            { run: { id: "r-1" }, view: "https://yok.example.com/runs/r-1", attach: [] },
            { status: 201 },
          ),
      });
      const args = [
        ...["run", "task", "--project", "web", "--prompt", "fix login"],
        ...["--input", "ticket=ENG-1", "--name", "fix-login", "--config", "cfg/ci.yaml"],
        ...flags,
      ];

      const run = await remoteYok(server.url, args);

      expect(run.stderr).toBe("");
      expect(run.code).toBe(0);
      expect(routeCalls(server.seen)).toEqual([
        {
          request: "POST /api/runs",
          body: {
            project: "web",
            workflow: "task",
            inputs: { prompt: "fix login", ticket: "ENG-1" },
            policies: { interaction },
            name: "fix-login",
            config: "cfg/ci.yaml",
          },
        },
      ]);
      expect(run.stdout).toBe("r-1\nview: https://yok.example.com/runs/r-1\n");
      expect(hasNoServer(run.home)).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "SC4010: a remote run without --project is refused before any request",
    async () => {
      const server = fakeRemote();

      const run = await remoteYok(server.url, ["run", "task", "--prompt", "x"]);

      expect(run.stderr).toContain("--project");
      expect(run.code).not.toBe(0);
      expect(server.seen).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "SC4011: a remote run the server's doctor refuses prints the failing checks and their fixes",
    async () => {
      const refused = { code: "bad-request", message: "BLOCKED: 1 check failed" };
      const server = fakeRemote({
        "POST /api/runs": () =>
          Response.json({ error: { ...refused, details: LINEAR_REPORT } }, { status: 400 }),
      });

      const run = await remoteYok(server.url, ["run", "task", "--project", "web", "--prompt", "x"]);

      expect(run.stderr).toContain("BLOCKED: 1 check failed");
      expect(run.stderr).toContain("LINEAR_API_KEY: not set");
      expect(run.stderr).toContain("  fix: add LINEAR_API_KEY to .env");
      expect(run.code).toBe(1);
    },
    TIMEOUT_MS,
  );

  const WEB = { name: "web", status: "ready", path: "/srv/yok/projects/web" };
  test.each([
    {
      args: ["project", "list"],
      answers: {
        "GET /api/projects": () =>
          Response.json({ projects: [{ ...WEB, addedBy: { channel: "cli" } }] }),
      },
      request: { request: "GET /api/projects", body: null },
      stdout: /^NAME\s+STATUS\s+PATH\s+ADDED BY\nweb\s+ready\s+\/srv\/yok\/projects\/web\s+cli\n$/,
    },
    {
      args: ["project", "add", "web", "--git", "git@github.com:acme/web.git"],
      answers: { "POST /api/projects": () => Response.json({ project: WEB }, { status: 201 }) },
      request: {
        request: "POST /api/projects",
        body: { name: "web", git: "git@github.com:acme/web.git", addedBy: { channel: "cli" } },
      },
      stdout: /^added web {2}\/srv\/yok\/projects\/web\n$/,
    },
    {
      args: ["project", "remove", "web", "--purge"],
      answers: {
        "DELETE /api/projects/web": () =>
          Response.json({ removed: "web", purged: true, note: null }),
      },
      request: { request: "DELETE /api/projects/web?purge=true", body: null },
      stdout: /^removed web\n$/,
    },
  ])(
    "SC4012: yok --remote $args.0 $args.1 calls the project route and prints what the local command prints",
    async ({ args, answers, request, stdout }) => {
      const server = fakeRemote(answers);

      const result = await remoteYok(server.url, args);

      expect(result.stderr).toBe("");
      expect(routeCalls(server.seen)).toEqual([request]);
      expect(result.stdout).toMatch(stdout);
    },
    TIMEOUT_MS,
  );

  test(
    "SC4013: remote doctor sends the project and workflow, prints the report, and exits 1 on a failed check",
    async () => {
      const server = fakeRemote({
        "POST /api/doctor": () => Response.json({ report: LINEAR_REPORT }),
      });

      const doctor = await remoteYok(server.url, [
        ...["doctor", "--project", "web", "--workflow", "task"],
      ]);

      expect(routeCalls(server.seen)).toEqual([
        { request: "POST /api/doctor", body: { project: "web", workflow: "task" } },
      ]);
      expect(doctor.stdout).toContain("ENVIRONMENT");
      expect(doctor.stdout).toContain("VERDICT");
      expect(doctor.code).toBe(1);
    },
    TIMEOUT_MS,
  );

  test.each([
    {
      args: ["trigger", "add", "digest.yaml", "--project", "web", "--config", "cfg/ci.yaml"],
      answers: { "POST /api/triggers": () => Response.json({ trigger: DIGEST }, { status: 201 }) },
      request: {
        request: "POST /api/triggers",
        body: { project: "web", workflow: "digest.yaml", config: "cfg/ci.yaml" },
      },
      stdout: "digest in web: 0 9 * * * (UTC), next fire 2026-10-28T09:00:00.000Z\n",
    },
    {
      args: ["trigger", "list"],
      answers: {
        "GET /api/triggers": () => Response.json({ triggers: [{ ...DIGEST, lastFire: null }] }),
      },
      request: { request: "GET /api/triggers", body: null },
      stdout: "digest  web  0 9 * * * (UTC)  next 2026-10-28T09:00:00.000Z  never fired\n",
    },
    {
      args: ["trigger", "fire", "digest", "--project", "web"],
      answers: { "POST /api/triggers/fire": () => Response.json({ fire: DIGEST_FIRE }) },
      request: { request: "POST /api/triggers/fire", body: { project: "web", name: "digest" } },
      stdout:
        "2026-10-27T09:00:01.000Z  started  slot 2026-10-27T09:00:00.000Z  run r-9 (digest-1)\n",
    },
    {
      args: ["trigger", "log", "digest", "--project", "web"],
      answers: { "GET /api/triggers/log": () => Response.json({ fires: [DIGEST_FIRE] }) },
      request: { request: "GET /api/triggers/log?project=web&name=digest", body: null },
      stdout:
        "2026-10-27T09:00:01.000Z  started  slot 2026-10-27T09:00:00.000Z  run r-9 (digest-1)\n",
    },
    {
      args: ["trigger", "rm", "digest", "--project", "web"],
      answers: { "DELETE /api/triggers": () => Response.json({ trigger: DIGEST }) },
      request: { request: "DELETE /api/triggers?project=web&name=digest", body: null },
      stdout: "removed digest from web\n",
    },
  ])(
    "SC4014: yok --remote trigger $args.1 names the project on its route",
    async ({ args, answers, request, stdout }) => {
      const server = fakeRemote(answers);

      const result = await remoteYok(server.url, args);

      expect(result.stderr).toBe("");
      expect(routeCalls(server.seen)).toEqual([request]);
      expect(result.stdout).toBe(stdout);
    },
    TIMEOUT_MS,
  );

  test.each([
    [["attach"], "yok attach works only on this machine: run it as yok attach, without --remote"],
    [
      ["server", "start"],
      "yok server start works only on the server's machine: run it there, without --remote",
    ],
  ])(
    "SC4021: --remote %j is refused with the command's own line, before any request",
    async (args, message) => {
      const server = fakeRemote();

      const refused = await remoteYok(server.url, args);

      expect(refused.stderr.trim()).toBe(message);
      expect(refused.code).toBe(1);
      expect(server.seen).toEqual([]);
      expect(hasNoServer(refused.home)).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "SC4022: login without --remote is refused and points at yok-remote login",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "yok-remote-e2e-home-"));
      cleanups.push(() => rmSync(home, { recursive: true, force: true }));

      const refused = await spawnHarness(home, { ...process.env, YOK_HOME: home }, [
        ...["login", "https://yok.example.com", "--user", "ritesh", "--password", "x"],
      ]);

      expect(refused.stderr.trim()).toBe(
        "yok login works only with a server on another machine: run it as yok-remote login",
      );
      expect(refused.code).toBe(1);
    },
    TIMEOUT_MS,
  );

  test(
    "SC4023: without --remote, a saved login in HOME/.env is never read: server status answers for this machine",
    async () => {
      const server = fakeRemote();
      const home = mkdtempSync(join(tmpdir(), "yok-remote-e2e-home-"));
      cleanups.push(() => rmSync(home, { recursive: true, force: true }));
      writeFileSync(
        join(home, ".env"),
        `YOK_SERVER_URL=${server.url}\nYOK_SERVER_USER=ritesh\nYOK_SERVER_PASSWORD=${REMOTE_PASSWORD}\n`,
      );

      const status = await spawnHarness(home, { ...process.env, YOK_HOME: home }, [
        ...["server", "status"],
      ]);

      expect(status.stdout.trim()).toBe("not running");
      expect(server.seen).toEqual([]);
    },
    TIMEOUT_MS,
  );
});

// Caddy's basic_auth and reverse_proxy: 401 without ritesh's login, else the request goes to the
// yok server at 127.0.0.1:PORT, with that address as its Host, as Caddy's upstream would get it.
const basicAuthProxy = (port: number): string => {
  const proxy = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      if (request.headers.get("authorization") !== REMOTE_BASIC) {
        return new Response("unauthorized", { status: 401 });
      }
      const { pathname, search } = new URL(request.url);
      const body = request.method === "GET" ? null : await request.text();
      const contentType = request.headers.get("content-type");
      return fetch(`http://127.0.0.1:${port}${pathname}${search}`, {
        method: request.method,
        headers: contentType === null ? {} : { "content-type": contentType },
        body,
      });
    },
  });
  cleanups.push(() => proxy.stop(true));
  return `http://127.0.0.1:${proxy.port}`;
};

describe("yok --remote beside a local server", () => {
  test(
    "SC4019: a run started through a Basic-auth proxy saves interaction false from cli, and the laptop side starts no server",
    async () => {
      const repo = makeRepo();
      const server = makeEnv();
      expect(yok(repo, server.env, "project", "add", "web", "--path", repo).code).toBe(0);
      const proxy = basicAuthProxy(readPort(server.home) ?? 0);

      const remote = await remoteYok(proxy, [
        "run",
        "ok.yaml",
        "--project",
        "web",
        "--prompt",
        "x",
      ]);

      expect(remote.stderr).toBe("");
      expect(remote.code).toBe(0);
      const [runId = "", view = ""] = remote.stdout.trim().split("\n");
      expect(view).toStartWith("view: http://localhost:");
      const registry = JSON.parse(readFileSync(join(server.home, "registry.json"), "utf8"));
      expect(registry.runs[runId].policies).toEqual({
        values: { interaction: false },
        sources: { interaction: "cli" },
      });
      expect(hasNoServer(remote.home)).toBe(true);

      stopServer(repo, server.env);
    },
    TIMEOUT_MS,
  );

  test(
    "SC4020: a server yok starts gives none of the remote login variables to a run's agent session",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();
      const shell = {
        ...env,
        YOK_SERVER_URL: "https://yok.example.com",
        YOK_SERVER_USER: "ritesh",
        YOK_SERVER_PASSWORD: "secret",
      };

      const run = yok(repo, shell, "run", "ok.yaml", "--prompt", "x", "--no-attach", "--no-open");

      expect(run.code).toBe(0);
      waitFor(() => readLines(fakeOut).some(isLaunch));
      const launched = readLines(fakeOut).find(isLaunch)?.env as Record<string, string>;
      expect(Object.keys(launched)).not.toContainAnyValues([
        "YOK_SERVER_URL",
        "YOK_SERVER_USER",
        "YOK_SERVER_PASSWORD",
      ]);

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );
});
