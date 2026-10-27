import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
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

// A checkout in a folder named NAME, so the project yok names after it is predictable.
const makeRepo = (name = "repo"): string => {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "yok-trigger-e2e-"))), name);
  mkdirSync(dir);
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
  return { home, fakeOut, env, socket };
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
    "SC3016: add in checkout digest-repo makes it a project; list, fire from the checkout; log and rm from outside need --project",
    () => {
      const repo = makeRepo("digest-repo");
      const outside = realpathSync(mkdtempSync(join(tmpdir(), "yok-trigger-e2e-outside-")));
      const { env, fakeOut } = makeEnv();

      const added = yok(repo, env, "trigger", "add", "digest.yaml");
      expect(added.code).toBe(0);
      expect(added.stdout).toContain("digest in digest-repo: 0 9 * * * (UTC), next fire ");
      expect(yok(repo, env, "project", "list").stdout).toMatch(
        new RegExp(`digest-repo\\s+ready\\s+${repo}`),
      );

      const listed = yok(repo, env, "trigger", "list");
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain("digest  digest-repo");
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

      const lost = yok(outside, env, "trigger", "log", "digest");
      expect(lost.code).not.toBe(0);
      expect(lost.stderr).toContain("pass --project NAME");

      const log = yok(outside, env, "trigger", "log", "digest", "--project", "digest-repo");
      expect(log.code).toBe(0);
      expect(log.stdout).toContain("started");
      expect(log.stdout).toContain(String(runId));

      expect(yok(outside, env, "trigger", "rm", "digest", "--project", "digest-repo").code).toBe(0);
      expect(yok(repo, env, "trigger", "list").stdout).not.toContain("digest");
    },
    TIMEOUT_MS,
  );

  test(
    "SC3017: a server started over a main-era triggers.json moves its due trigger to the checkout's project, fires it, and refuses to remove that project",
    () => {
      const repo = makeRepo("nightly");
      const { env, home, fakeOut, socket } = makeEnv();
      expect(yok(repo, env, "project", "add").code).toBe(0);
      yok(repo, env, "server", "stop");
      const legacy = {
        id: "t-0000aaaa",
        name: "digest",
        workflowPath: join(repo, "digest.yaml"),
        cwd: repo,
        config: null,
        cron: "0 9 * * *",
        timezone: "UTC",
        nextFireAt: new Date(Date.now() - 60_000).toISOString(),
        createdAt: "2026-10-01T00:00:00.000Z",
      };
      writeFileSync(
        join(home, "triggers.json"),
        JSON.stringify({ version: 1, triggers: { [legacy.id]: legacy } }),
      );

      const listed = yok(repo, env, "trigger", "list");
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain("digest  nightly");

      waitFor(() => launches(fakeOut).length === 1);
      waitFor(() => yok(repo, env, "trigger", "log", "digest").stdout.includes("started"));

      // The run's session ends first, so the trigger is all that holds the project.
      spawnSync("tmux", ["-L", socket, "kill-server"]);
      const removed = yok(repo, env, "project", "remove", "nightly");
      expect(removed.code).not.toBe(0);
      expect(removed.stderr).toContain("digest");
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
