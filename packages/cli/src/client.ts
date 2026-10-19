import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseEnv } from "node:util";
import { compilePlan, createLogger, resolveLevel, type WorkflowPlan } from "@yok/core";
import { type ILogger, type Result, spawnDetached, withLock, yokHome } from "@yok/sdk";
import { isCompiled, selfArgv, VERSION } from "@yok/sdk/internal";
import { logPath, pidPath, readApiKey, readPort, SLACK_STOP_WAIT_MS } from "@yok/server";
import { createYokClient, type YokClient } from "@yok/server/client";

const HEALTH_TIMEOUT_MS = 5_000;
// Longer than the server's own shutdown wait, so a server still finishing its work is not
// reported as hung.
const STOP_TIMEOUT_MS = SLACK_STOP_WAIT_MS + 5_000;
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

// null means the error is already printed and the exit code set.
export const compileOrFail = async (
  path: string,
  cwd: string,
  configFile: string | null = null,
): Promise<WorkflowPlan | null> => {
  const plan = await compilePlan(path, cwd, configFile);
  if (plan.ok) return plan.value;
  fail(plan.error);
  return null;
};

export { apiErrorText } from "@yok/server";

// Before any server has started there is no port file; port 1 answers nothing, so the client
// reports the server as unreachable.
export const localUrl = (home: string): string => `http://127.0.0.1:${readPort(home) ?? 1}`;

export const clientEnvPath = (home: string): string => join(home, "client.env");

export type Target =
  | Readonly<{ kind: "local" }>
  | Readonly<{ kind: "remote"; url: string; apiKey: string }>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// https anywhere; plain http only on this machine, so the key never crosses the network in clear.
export const checkServerUrl = (url: string): Result<string> => {
  if (!URL.canParse(url)) return { ok: false, error: `not a URL: ${url}` };
  const { protocol, hostname } = new URL(url);
  if (protocol === "https:") return { ok: true, value: url };
  if (protocol === "http:" && LOOPBACK_HOSTS.has(hostname)) return { ok: true, value: url };
  return { ok: false, error: `${url} must use https:// unless the server is on this machine` };
};

const readClientEnv = (home: string): Record<string, string | undefined> => {
  try {
    return parseEnv(readFileSync(clientEnvPath(home), "utf8"));
  } catch {
    return {};
  }
};

// A URL in the environment wins over the home's client.env; neither set means the local server.
// The key comes from wherever the URL did, so one server's key is never sent to another.
export const resolveTarget = (
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Result<Target> => {
  const source = env.YOK_SERVER_URL ? env : readClientEnv(home);
  const url = source.YOK_SERVER_URL;
  if (!url) return { ok: true, value: { kind: "local" } };
  const apiKey = source.YOK_API_KEY;
  if (!apiKey) return { ok: false, error: `YOK_SERVER_URL is ${url}, but YOK_API_KEY is not set` };
  const checked = checkServerUrl(url);
  if (!checked.ok) return checked;
  return { ok: true, value: { kind: "remote", url: url.replace(/\/+$/, ""), apiKey } };
};

// index.ts prints the thrown error, as it does any command's.
const targetOrThrow = (home: string): Target => {
  const target = resolveTarget(home);
  if (!target.ok) throw new Error(target.error);
  return target.value;
};

// The remote server's URL, or null for the local one.
export const remoteUrl = (home: string = yokHome()): string | null => {
  const target = targetOrThrow(home);
  return target.kind === "remote" ? target.url : null;
};

// Read on every call: the first server start writes the port and the key.
export const yokClient = (home: string = yokHome()): YokClient => {
  const target = targetOrThrow(home);
  if (target.kind === "remote") {
    return createYokClient({ url: target.url, apiKey: target.apiKey, log: cliLog() });
  }
  return createYokClient({ url: localUrl(home), apiKey: readApiKey(home) ?? "", log: cliLog() });
};

const tailOf = (path: string, lines = 20): string =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").slice(-lines).join("\n") : "";

// Signal 0 checks that the process exists and that this user may signal it, without touching it.
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

// This home's local server, or null; a remote server is another machine's process, never one to
// stop or restart. A reply on the port counts only when its pid is the one in server.pid and this
// user may signal it: while the server is down, another local user can take the port, and must
// get neither the key nor a signal.
export const runningServer = async (home: string = yokHome()): Promise<Running | null> => {
  if (remoteUrl(home) !== null) return null;
  const health = await yokClient(home).health();
  if (!health.ok) return null;
  const { pid } = health.value;
  return pid === readServerPid(home) && isAlive(pid) ? health.value : null;
};

// Asked afresh each time: the starting server writes its port only once it listens.
const waitForHealth = async (home: string, deadline: number): Promise<boolean> => {
  while (Date.now() < deadline) {
    if ((await runningServer(home)) !== null) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return (await runningServer(home)) !== null;
};

// Signal only a pid runningServer vouched for, never one a reply on the port alone names.
// Its tmux sessions keep running.
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
  log.warn({ pid }, `server still running ${STOP_TIMEOUT_MS / 1000}s after SIGTERM`);
  throw new Error(`server (pid ${pid}) is still running ${STOP_TIMEOUT_MS / 1000}s after SIGTERM`);
};

// A server from before the HTTP API listens only on yok.sock, where no command looks any more; its
// shutdown would delete the new server's server.pid, so it must be gone before that one starts.
const stopSocketServer = async (home: string): Promise<void> => {
  const socket = join(home, "yok.sock");
  if (!existsSync(socket)) return;
  const pid = await fetch("http://localhost/health", {
    unix: socket,
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  })
    .then((res) => res.json())
    .then((body: { pid?: unknown }) => (typeof body.pid === "number" ? body.pid : null))
    .catch(() => null);
  if (pid !== null && pid === readServerPid(home) && isAlive(pid)) await stopServer(pid);
  rmSync(socket, { force: true });
};

// From source, a server holds the code as it was when it started. Replacing only servers older
// than this command keeps two commands started together from stopping each other's server.
const defaultReplaceBefore = (): number => (isCompiled ? 0 : performance.timeOrigin);

// A server of another version is replaced too: Homebrew and npm swap the binary without
// restarting the server.
export const isCurrentServer = (
  server: Running | null,
  replaceBefore: number,
  version: string,
): boolean => server !== null && server.startedAt >= replaceBefore && server.version === version;

// The lock stops two CLIs from starting two servers. A server started before replaceBefore
// (epoch ms) is replaced.
export const ensureServer = async (
  home: string = yokHome(),
  replaceBefore: number = defaultReplaceBefore(),
): Promise<void> => {
  // A remote server is only checked: replacing it would signal a pid on another machine.
  const remote = remoteUrl(home);
  if (remote !== null) {
    if ((await yokClient(home).health()).ok) return;
    throw new Error(`the yok server at ${remote} is not answering`);
  }
  const isFresh = (server: Running | null): boolean =>
    isCurrentServer(server, replaceBefore, VERSION);
  // Checked again inside the lock, with a new client: another command may have started the
  // server meanwhile, on a port this one has not read yet.
  if (isFresh(await runningServer(home))) return;
  // Before the lock: withLock would create a missing home with the umask's mode.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  await withLock(join(home, ".start.lock"), async () => {
    await stopSocketServer(home);
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
      // The server's env reaches every run's session, where no API key may go.
      env: { YOK_HOME: home, YOK_API_KEY: undefined, YOK_SERVER_URL: undefined },
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

// An unattended run has no one to watch or answer it, so yok run neither opens nor attaches.
export const followUpRun = ({
  interaction,
  open,
  attach,
  hasTerminal,
}: Readonly<{ interaction: boolean; open: boolean; attach: boolean; hasTerminal: boolean }>) => ({
  noOpen: !open || !interaction,
  attach: attach && hasTerminal && interaction,
});

export const openForPerson = (url: string, noOpen: boolean): void => {
  const isTTY = process.stdout.isTTY === true;
  if (shouldOpenBrowser({ noOpen, isTTY, env: process.env, platform: process.platform })) {
    openInBrowser(url);
  }
};
