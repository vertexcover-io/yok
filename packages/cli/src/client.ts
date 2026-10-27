import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  compileWithProjectConfig,
  createLogger,
  resolveLevel,
  WorkflowError,
  type WorkflowPlan,
} from "@yok/core";
import { type ILogger, type Result, spawnDetached, withLock, yokHome } from "@yok/sdk";
import { isCompiled, selfArgv, VERSION } from "@yok/sdk/internal";
import { type ApiError, logPath, pidPath, readPort } from "@yok/server";
import { createYokClient, type YokClient } from "@yok/server/client";

const HEALTH_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;

let level: ReturnType<typeof resolveLevel> | null = null;
// Read once, so a bad LOG_LEVEL warns once.
const cliLevel = (): ReturnType<typeof resolveLevel> => {
  level ??= resolveLevel(process.env, "warn");
  return level;
};

let logger: ILogger | null = null;
// Logs go to stderr, so `--json` output on stdout stays parseable.
export const cliLog = (): ILogger => {
  logger ??= createLogger(
    { service: "yok-cli" },
    {
      destination: { write: (chunk: string) => void process.stderr.write(chunk) },
      level: cliLevel(),
    },
  );
  return logger;
};

export const commandLog = (command: string): ILogger =>
  cliLog().child({ component: "cli", command });

const stackOf = (error: Error): string => {
  const own = error.stack ?? error.message;
  return error.cause instanceof Error ? `${own}\nCaused by: ${stackOf(error.cause)}` : own;
};

// The terminal shows only the message; LOG_LEVEL=debug adds the stack.
export const fail = (problem: string | Error): void => {
  const debug = cliLevel() === "debug" || cliLevel() === "trace";
  const text = typeof problem === "string" ? problem : debug ? stackOf(problem) : problem.message;
  console.error(text);
  process.exitCode = 1;
};

// The original error stays as the cause, so LOG_LEVEL=debug still shows its stack.
export const errorText = (error: unknown): string | Error => {
  if (error instanceof WorkflowError) {
    return new Error(`${error.code}: ${error.message}`, { cause: error });
  }
  return error instanceof Error ? error : String(error);
};

// null means the error is already printed and the exit code set.
export const compileOrFail = async (
  path: string,
  cwd: string,
  configFile: string | null = null,
): Promise<WorkflowPlan | null> => {
  return compileWithProjectConfig(path, cwd, configFile).catch((error: unknown) => {
    fail(errorText(error));
    return null;
  });
};

export const apiErrorText = (error: ApiError): string => `${error.code}: ${error.message}`;

// With no port file yet, port 1 answers nothing and the server counts as unreachable.
export const localUrl = (home: string): string => `http://127.0.0.1:${readPort(home) ?? 1}`;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Plain http is allowed only on this machine, so a login never crosses the network in clear.
export const checkServerUrl = (url: string): Result<string> => {
  if (!URL.canParse(url)) return { ok: false, error: `not a URL: ${url}` };
  const { protocol, hostname } = new URL(url);
  if (protocol === "https:") return { ok: true, value: url };
  if (protocol === "http:" && LOOPBACK_HOSTS.has(hostname)) return { ok: true, value: url };
  return { ok: false, error: `${url} must use https:// unless the server is on this machine` };
};

// Read on every call, since the first server start writes the port.
export const yokClient = (home: string = yokHome()): YokClient =>
  createYokClient({ url: localUrl(home), log: cliLog() });

const tailOf = (path: string, lines = 20): string =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").slice(-lines).join("\n") : "";

// Signal 0 only checks that the process exists and belongs to this user.
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readServerPid = (home: string): number | null => {
  try {
    const pid = Number.parseInt(readFileSync(pidPath(home), "utf8"), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
};

type Running = Readonly<{ pid: number; version: string; startedAt: number }>;

// The server yok runs here, or null when the pid on the port is not the one in server.pid.
// Another user's process could be on that port.
export const runningServer = async (home: string = yokHome()): Promise<Running | null> => {
  const health = await yokClient(home).health();
  if (!health.ok) return null;
  const { pid } = health.value;
  return pid === readServerPid(home) && isAlive(pid) ? health.value : null;
};

// The starting server writes its port only once it listens, so the port is re-read on each poll.
const waitForHealth = async (home: string, deadline: number): Promise<boolean> => {
  while (Date.now() < deadline) {
    if ((await runningServer(home)) !== null) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return (await runningServer(home)) !== null;
};

// Takes a pid runningServer vouched for. The server's tmux sessions keep running.
export const stopServer = async (pid: number): Promise<void> => {
  const log = cliLog().child({ component: "cli" });
  const startedAt = Date.now();
  process.kill(pid, "SIGTERM");
  while (isAlive(pid) && Date.now() < startedAt + STOP_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
  }
  if (!isAlive(pid)) {
    log.info({ pid, durationMs: Date.now() - startedAt }, "server stopped");
    return;
  }
  log.warn({ pid }, "server still running 5s after SIGTERM");
  throw new Error(`server (pid ${pid}) is still running ${STOP_TIMEOUT_MS / 1000}s after SIGTERM`);
};

// From source, a server older than this command runs stale code and is replaced.
const defaultReplaceBefore = (): number => (isCompiled ? 0 : performance.timeOrigin);

// A server of another version is replaced too: an upgrade swaps the binary without a restart.
export const isCurrentServer = (
  server: Running | null,
  replaceBefore: number,
  version: string,
): boolean => server !== null && server.startedAt >= replaceBefore && server.version === version;

// Starts the server under a lock, replacing one started before replaceBefore (epoch ms).
export const ensureServer = async (
  home: string = yokHome(),
  replaceBefore: number = defaultReplaceBefore(),
): Promise<void> => {
  const isFresh = (server: Running | null): boolean =>
    isCurrentServer(server, replaceBefore, VERSION);
  // Checked again inside the lock: another command may have started the server meanwhile.
  if (isFresh(await runningServer(home))) return;
  // withLock would create a missing home with the umask's mode.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  await withLock(join(home, ".start.lock"), async () => {
    const running = await runningServer(home);
    if (isFresh(running)) return;
    const log = cliLog().child({ component: "cli" });
    if (running !== null) {
      log.info({ pid: running.pid, startedAt: running.startedAt }, "replacing an older server");
      await stopServer(running.pid);
    }

    const [command, ...args] = [...selfArgv(), "server", "start"];
    const startedAt = Date.now();
    const pid = spawnDetached(command, args, {
      cwd: home,
      env: { YOK_HOME: home },
      output: logPath(home),
    });
    log.info({ pid, command: [command, ...args], log: logPath(home) }, "server process started");

    const started = await waitForHealth(home, Date.now() + HEALTH_TIMEOUT_MS);
    if (started) {
      log.info({ pid, durationMs: Date.now() - startedAt }, "server answering /health");
      return;
    }
    const tail = tailOf(logPath(home));
    log.error({ pid, tail }, "server did not answer /health within 5s");
    throw new Error(`yok server did not start within ${HEALTH_TIMEOUT_MS / 1000}s\n${tail}`);
  });
};

// A stopped server stays down: the next command that needs one starts it.
export const restartServer = async (home: string = yokHome()): Promise<boolean> => {
  if ((await runningServer(home)) === null) return false;
  await ensureServer(home, Date.now());
  return true;
};

type OpenDecision = Readonly<{
  noOpen: boolean;
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}>;

// Over SSH with no display, xdg-open can start a text browser that takes over the terminal.
export const shouldOpenBrowser = ({ noOpen, isTTY, env, platform }: OpenDecision): boolean => {
  if (noOpen || !isTTY) return false;
  if (env.CI !== undefined && env.CI !== "" && env.CI !== "false") return false;
  if (platform !== "linux") return true;
  return Boolean(env.DISPLAY) || Boolean(env.WAYLAND_DISPLAY);
};

const openerFor = (
  platform: NodeJS.Platform,
  url: string,
): readonly [string, readonly string[]] => {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
};

// The URL is always printed as well, so a failed open is only logged.
export const openInBrowser = (url: string): void => {
  const [command, args] = openerFor(process.platform, url);
  try {
    spawnDetached(command, args, { cwd: process.cwd(), output: "ignore" });
  } catch (error) {
    cliLog().debug({ err: error, command }, "could not open the browser");
  }
};

export const openForPerson = (url: string, noOpen: boolean): void => {
  const isTTY = process.stdout.isTTY === true;
  if (shouldOpenBrowser({ noOpen, isTTY, env: process.env, platform: process.platform })) {
    openInBrowser(url);
  }
};
