import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 40_000;
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

const DIGEST = [
  "name: digest",
  "inputs:",
  "  prompt: { type: string, required: true }",
  "trigger:",
  '  cron: "0 9 * * *"',
  "  timezone: UTC",
  "  inputs: { prompt: summarise yesterday }",
  "nodes:",
  "  - id: a",
  "    type: exec",
  "    runtime: sh",
  '    script: "true"',
  "    input: null",
  "",
].join("\n");

const makeRepo = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "yok-trigger-e2e-repo-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), ".yok/\n");
  writeFileSync(join(dir, "orchestrate.config.json"), '{ "version": 2 }\n');
  writeFileSync(join(dir, "digest.yaml"), DIGEST);
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const makeEnv = () => {
  const home = mkdtempSync(join(tmpdir(), "yok-trigger-e2e-home-"));
  const socket = `yok-e2e-${randomUUID()}`;
  const fakeOut = join(mkdtempSync(join(tmpdir(), "yok-trigger-e2e-out-")), "out.jsonl");
  const env = {
    ...process.env,
    YOK_HOME: home,
    YOK_TMUX_SOCKET: socket,
    YOK_CLAUDE_BIN: FAKE_AGENT,
    FAKE_AGENT_OUT: fakeOut,
  };
  cleanups.push(() => {
    spawnSync("bun", [NO_DOTENV, CLI, "server", "stop"], { env });
    spawnSync("tmux", ["-L", socket, "kill-server"]);
    rmSync(home, { recursive: true, force: true });
  });
  return { home, fakeOut, env };
};

const yok = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) => {
  const run = spawnSync("bun", [NO_DOTENV, CLI, ...args], { cwd, env, encoding: "utf8" });
  return { code: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
};

// The doctor runs the fake agent with --version; the launch is the call that carries the hooks.
const launches = (fakeOut: string): Array<Record<string, unknown>> =>
  existsSync(fakeOut)
    ? readFileSync(fakeOut, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((record) => Array.isArray(record.argv) && record.argv.includes("--settings"))
    : [];

const waitFor = (predicate: () => boolean, timeoutMs = 10_000): void => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    Bun.sleepSync(100);
  }
};

describe("yok trigger", () => {
  test(
    "add, list, fire, log and rm a trigger: fire starts the agent in auto with the trigger's inputs",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();

      const added = yok(repo, env, "trigger", "add", "digest.yaml");
      expect(added.code).toBe(0);
      expect(added.stdout).toContain("digest: 0 9 * * * (UTC), next fire ");

      const listed = yok(repo, env, "trigger", "list");
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain("digest");
      expect(listed.stdout).toContain("never fired");

      const fired = yok(repo, env, "trigger", "fire", "digest");
      expect(fired.code).toBe(0);
      const runId = fired.stdout.match(/r-[0-9a-f]{8}/)?.[0];
      expect(runId).toBeDefined();
      waitFor(() => launches(fakeOut).length === 1);
      const launched = launches(fakeOut)[0]?.argv;
      const argv = Array.isArray(launched) ? launched.map(String) : [];
      expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("auto");
      expect(argv.at(-1)).toContain('--inputs {"prompt":"summarise yesterday"} --name digest-');

      const log = yok(repo, env, "trigger", "log", "digest");
      expect(log.code).toBe(0);
      expect(log.stdout).toContain(`started`);
      expect(log.stdout).toContain(String(runId));

      expect(yok(repo, env, "trigger", "rm", "digest").code).toBe(0);
      expect(yok(repo, env, "trigger", "list").stdout).not.toContain("digest");
      expect(yok(repo, env, "trigger", "fire", "digest").code).not.toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "a server that starts with a trigger already due fires it with nobody asking",
    () => {
      const repo = makeRepo();
      const { env, home, fakeOut } = makeEnv();
      expect(yok(repo, env, "trigger", "add", "digest.yaml").code).toBe(0);
      yok(repo, env, "server", "stop");
      const path = join(home, "triggers.json");
      const file = JSON.parse(readFileSync(path, "utf8")) as {
        triggers: Record<string, { nextFireAt: string }>;
      };
      const minuteAgo = new Date(Date.now() - 60_000).toISOString();
      for (const trigger of Object.values(file.triggers)) trigger.nextFireAt = minuteAgo;
      writeFileSync(path, JSON.stringify(file));

      expect(yok(repo, env, "trigger", "list").code).toBe(0);

      waitFor(() => launches(fakeOut).length === 1);
      waitFor(() => yok(repo, env, "trigger", "log", "digest").stdout.includes("started"));
    },
    TIMEOUT_MS,
  );

  test(
    "add for a workflow with no trigger block fails and says why",
    () => {
      const repo = makeRepo();
      const { env } = makeEnv();
      writeFileSync(join(repo, "plain.yaml"), DIGEST.replace(/trigger:\n( {2}.*\n){3}/, ""));

      const added = yok(repo, env, "trigger", "add", "plain.yaml");

      expect(added.code).not.toBe(0);
      expect(added.stderr).toContain("has no trigger block");
    },
    TIMEOUT_MS,
  );
});
