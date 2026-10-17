import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  agentProvider,
  builtInChecks,
  createLogger,
  type DoctorReport,
  loadStartEnv,
  resolveLevel,
  runDoctor,
  type WorkflowAgent,
  type WorkflowPlan,
  workflowChecks,
  yokTerminalHost,
} from "@yok/core";
import type { Check, IAgentProvider, ILogger, ITerminalHost, Result } from "@yok/sdk";
import { createGit, execWithTimeout, noopLogger, registryPath } from "@yok/sdk";
import { createRegistry, VERSION } from "@yok/sdk/internal";
import prettyFactory from "pino-pretty";
import { createApp } from "./app.ts";
import { resumeDeliveries, stopDeliveries } from "./delivery.ts";
import { CLONE_TIMEOUT_MS } from "./projects.ts";
import { ensureApiKey, pidPath, portPath, readPort } from "./protocol.ts";
import { startViewer } from "./viewer.ts";

export type CheckCheckout = (
  input: Readonly<{ cwd: string; config?: string; plan?: WorkflowPlan }>,
) => Promise<Readonly<{ env: Result<Record<string, string>>; report: DoctorReport }>>;

export type Runtime = Readonly<{
  host: ITerminalHost;
  providerFor: (agent: WorkflowAgent) => IAgentProvider;
  checkCheckout: CheckCheckout;
}>;

export const defaultRuntime = (log: ILogger = noopLogger): Runtime => {
  const host = yokTerminalHost(process.env, log);
  return {
    host,
    providerFor: (agent) => agentProvider({ agent, host, env: process.env, log }),
    checkCheckout,
  };
};

export const runtimeChecks = (agent: WorkflowAgent): readonly Check[] => {
  const { host, providerFor } = defaultRuntime();
  return [...host.checks, ...providerFor(agent).checks];
};

// What yok doctor checks on a checkout, plus a workflow's own checks when one is starting. Its
// env checks fall back to process.env, which is the server's.
const checkCheckout: CheckCheckout = async ({ cwd, config, plan }) => {
  const agent = plan?.agent ?? "claude";
  const env = await loadStartEnv(config ?? null, cwd, plan ?? { env: {}, agent });
  const declared = plan === undefined ? [] : workflowChecks(plan.doctor, env);
  const report = await runDoctor({
    cwd,
    config,
    extraChecks: [...runtimeChecks(agent), ...declared, ...builtInChecks(plan, env)],
  });
  return { env, report };
};

type Fetch = (request: Request) => Response | Promise<Response>;

// A port the caller names must be free: a service manager or a TLS proxy points at it. The saved
// port falls back to any free one.
const listen = (fetch: Fetch, port: number | undefined, saved: number | null) => {
  const serve = (at: number) => Bun.serve({ hostname: "127.0.0.1", port: at, fetch });
  if (port !== undefined) return serve(port);
  try {
    return serve(saved ?? 0);
  } catch {
    return serve(0);
  }
};

// A newer server may already have written its own pid, and the CLI trusts only server.pid.
const removeOwnPid = async (home: string): Promise<void> => {
  const pid = await readFile(pidPath(home), "utf8").catch(() => "");
  if (pid === String(process.pid)) await rm(pidPath(home), { force: true });
};

// Callers check /health first: this always starts.
export const startServer = async ({
  home,
  runtime,
  port,
}: {
  home: string;
  runtime?: Runtime;
  port?: number;
}): Promise<Readonly<{ stop: () => Promise<void> }>> => {
  const isTTY = process.stdout.isTTY === true;
  const level = resolveLevel(process.env);
  const log = createLogger(
    { service: "yok-server" },
    isTTY
      ? {
          level,
          destination: prettyFactory({
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname",
          }),
        }
      : { level },
  );

  const serverLog = log.child({ component: "server" });
  // Only a home this creates gets 0700; one that exists keeps the mode its owner gave it.
  await mkdir(home, { recursive: true, mode: 0o700 });
  const apiKey = await ensureApiKey(home);

  const { host, providerFor, checkCheckout } = runtime ?? defaultRuntime(log);
  const registry = createRegistry(registryPath(home), log);
  const version = VERSION;
  const viewerLog = log.child({ component: "viewer" });
  const viewer = await startViewer({ home, registry, providerFor, host, log: viewerLog });
  void resumeDeliveries({ registry, providerFor, host, log: viewerLog, now: () => new Date() });
  const app = createApp({
    registry,
    providerFor,
    log,
    home,
    viewerOrigin: viewer.origin,
    pid: process.pid,
    version,
    startedAt: Date.now(),
    apiKey,
    host,
    git: createGit(execWithTimeout(CLONE_TIMEOUT_MS)),
    checkCheckout,
  });

  // The viewer is already listening; a named port that is taken must not leave it running.
  const server = await Promise.resolve()
    .then(() => listen(app.fetch, port, readPort(home)))
    .catch(async (error: unknown) => {
      await viewer.stop();
      throw error;
    });
  await writeFile(portPath(home), String(server.port));
  await writeFile(pidPath(home), String(process.pid));
  serverLog.info(
    { port: server.port, pid: process.pid, version, viewer: viewer.origin },
    "server listening",
  );

  const stop = async (): Promise<void> => {
    stopDeliveries();
    // stop() resolves once in-flight requests finish, so a run still launching gets recorded.
    await server.stop();
    await Promise.all([viewer.stop(), removeOwnPid(home)]);
  };

  const shutdown = (signal: string): void => {
    serverLog.info({ signal }, `received ${signal}; stopping once in-flight requests finish`);
    void stop().then(() => {
      serverLog.info({}, "server stopped; tmux sessions keep running");
      process.exit(0);
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  return { stop };
};
