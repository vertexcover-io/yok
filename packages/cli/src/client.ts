import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { CommandUnknownOpts } from "@commander-js/extra-typings";
import {
  compileWithProjectConfig,
  createLogger,
  resolveLevel,
  unwrap,
  WorkflowError,
  type WorkflowPlan,
} from "@yok/core";
import { type ILogger, type Result, spawnDetached, withLock, yokHome } from "@yok/sdk";
import { isCompiled, selfArgv, VERSION } from "@yok/sdk/internal";
import { type ApiError, logPath, pidPath, readHomeEnv, readPort } from "@yok/server";
import { createYokClient, type YokClient } from "@yok/server/client";
import * as z from "zod";

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

export const ENV_KEYS = {
  url: "YOK_SERVER_URL",
  user: "YOK_SERVER_USER",
  password: "YOK_SERVER_PASSWORD",
} as const;

export type RemoteSettings = Readonly<Record<keyof typeof ENV_KEYS, string>>;

const REQUEST_TIMEOUT_MS = 10_000;
export const WRONG_LOGIN = "wrong username or password";

// All three come from the shell when it sets YOK_SERVER_URL, else all three from HOME/.env, so a
// shell password is never sent to the saved server and a CI job needs no login.
export const remoteSettings = (
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): RemoteSettings => {
  const source = env[ENV_KEYS.url] ? env : readHomeEnv(home);
  const settings = {
    url: source[ENV_KEYS.url] ?? "",
    user: source[ENV_KEYS.user] ?? "",
    password: source[ENV_KEYS.password] ?? "",
  };
  const missing = Object.values(ENV_KEYS).filter((key) => !source[key]);
  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} not set; run yok-remote login URL --user USER`);
  }
  unwrap(checkServerUrl(settings.url));
  return { ...settings, url: settings.url.replace(/\/+$/, "") };
};

// The typed client folds every failure into one ApiError, and login and the health check need
// the status itself: Caddy answers 401 for a wrong login and 502 when yok is down.
export const getWithLogin = async (
  { url, user, password }: RemoteSettings,
  path: string,
  wrongLogin: string,
): Promise<Response> => {
  const host = new URL(url).host;
  const basic = Buffer.from(`${user}:${password}`).toString("base64");
  const reply = await fetch(`${url}${path}`, {
    headers: { authorization: `Basic ${basic}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => null);
  if (reply === null || reply.status === 502) throw new Error(`${host} is not answering`);
  if (reply.status === 401) throw new Error(wrongLogin);
  if (reply.ok) return reply;
  const text = (await reply.text().catch(() => "")).trim().slice(0, 200);
  throw new Error(`${host} answered ${path} with ${reply.status}${text === "" ? "" : `: ${text}`}`);
};

const HealthSchema = z.object({ pid: z.number(), version: z.string(), startedAt: z.number() });

export type Remote = Readonly<{
  client: YokClient;
  url: string;
  health: z.infer<typeof HealthSchema>;
}>;

// Every --remote command but login starts here. It never starts a server, which needs the
// server's own machine. A version mismatch only warns, since most releases change no routes.
export const connect = async (
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): Promise<Remote> => {
  const settings = remoteSettings(env, home);
  const reply = await getWithLogin(
    settings,
    "/api/health",
    `${WRONG_LOGIN}; run yok-remote login again`,
  );
  const health = HealthSchema.safeParse(await reply.json().catch(() => null));
  if (!health.success) {
    throw new Error(`${new URL(settings.url).host} did not answer /api/health as a yok server`);
  }
  if (health.data.version !== VERSION) {
    console.error(`warning: this CLI is ${VERSION}, the server is ${health.data.version}`);
  }
  const { url, user, password } = settings;
  const client = createYokClient({ url, login: { user, password }, log: cliLog() });
  return { client, url, health: health.data };
};

// The root --remote flag, read from the leaf command that runs.
export const isRemote = (command: CommandUnknownOpts): boolean =>
  command.optsWithGlobals().remote === true;

// The folder you are in means nothing on the server, so every --remote command names its project
// and checks it before resolveClient sends anything.
export const PROJECT_REQUIRED = "--project NAME is required with --remote";

// The saved login is read only with --remote, so a plain command never leaves this machine.
export const resolveClient = async (remote: boolean): Promise<YokClient> => {
  if (remote) return (await connect(process.env, yokHome())).client;
  await ensureServer();
  return yokClient();
};

// "server status" for a subcommand, "run" for a top-level one.
export const commandPath = (command: CommandUnknownOpts): string =>
  command.parent === null ? "" : `${commandPath(command.parent)} ${command.name()}`.trim();

const REMOTE_COMMANDS = new Set(["run", "project", "trigger", "doctor", "login", "server status"]);
const SERVER_MACHINE_COMMANDS = new Set(["server start", "server stop"]);

// Refuses --remote on a command that acts on this machine, and login without it, before the
// action runs: the message names the command and the exact thing to type instead.
export const checkRemoteFlag = (remote: boolean, path: string): void => {
  const [head = ""] = path.split(" ");
  if (!remote) {
    if (path !== "login") return;
    throw new Error(
      "yok login works only with a server on another machine: run it as yok-remote login",
    );
  }
  if (REMOTE_COMMANDS.has(path) || REMOTE_COMMANDS.has(head)) return;
  if (SERVER_MACHINE_COMMANDS.has(path)) {
    throw new Error(
      `yok ${path} works only on the server's machine: run it there, without --remote`,
    );
  }
  throw new Error(
    `yok ${path} works only on this machine: run it as yok ${path}, without --remote`,
  );
};

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
      // The server's env reaches every run's agent session, so a remote login set in this shell
      // stays out of it.
      env: {
        YOK_HOME: home,
        YOK_SERVER_URL: undefined,
        YOK_SERVER_USER: undefined,
        YOK_SERVER_PASSWORD: undefined,
      },
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
