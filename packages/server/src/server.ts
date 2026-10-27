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
import { createRegistry, createTriggerStore, VERSION } from "@yok/sdk/internal";
import { Hono } from "hono";
import prettyFactory from "pino-pretty";
import { type ApiDeps, createApi } from "./app.ts";
import { resumeDeliveries, stopDeliveries } from "./delivery.ts";
import { CLONE_TIMEOUT_MS } from "./projects.ts";
import { pidPath, portPath, publicOrigin, readPort, serverDomain } from "./protocol.ts";
import { adoptLegacyTriggers, startScheduler, stopScheduler } from "./trigger.ts";
import { hostGuard, openInEditor, type ViewerDeps, viewerRoutes } from "./viewer.ts";

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
export const checkCheckoutWith = async (
  runtime: readonly Check[],
  { cwd, config, plan }: Parameters<CheckCheckout>[0],
): ReturnType<CheckCheckout> => {
  const agent = plan?.agent ?? "claude";
  const env = await loadStartEnv(config ?? null, cwd, plan ?? { env: {}, agent });
  const declared = plan === undefined ? [] : workflowChecks(plan.doctor, env);
  const report = await runDoctor({
    cwd,
    config,
    extraChecks: [...runtime, ...declared, ...builtInChecks(plan, env)],
  });
  return { env, report };
};

const checkCheckout: CheckCheckout = (input) =>
  checkCheckoutWith(runtimeChecks(input.plan?.agent ?? "claude"), input);

export type RootDeps = ApiDeps & ViewerDeps & Readonly<{ port: number; domain: string }>;

// The API sits under /api so its routes never shadow a dashboard page: the API's GET /runs/view
// once also matched the dashboard's GET /runs/:id.
export const createRoot = (deps: RootDeps) =>
  new Hono()
    .use("*", hostGuard(deps.port, deps.domain))
    .route("/api", createApi(deps))
    .route("/", viewerRoutes({ ...deps, log: deps.log.child({ component: "viewer" }) }));

// A port the caller names must be free: a service manager or a TLS proxy points at it. The saved
// port falls back to any free one. It answers 503 until startServer loads the app, which needs
// the bound port. The dashboard's /stream stays open and quiet between changes: no idle limit.
const listen = (port: number | undefined, saved: number | null) => {
  const serve = (at: number) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: at,
      idleTimeout: 0,
      fetch: () => new Response("starting", { status: 503 }),
    });
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
  // Bound before anything starts, so a named port that is taken leaves nothing running.
  const server = listen(port, readPort(home));
  const boundPort = server.port as number;
  const domain = serverDomain(home, boundPort);
  const origin = publicOrigin(domain);

  const { host, providerFor, checkCheckout } = runtime ?? defaultRuntime(log);
  const registry = createRegistry(registryPath(home), log);
  const version = VERSION;
  const viewerLog = log.child({ component: "viewer" });
  void resumeDeliveries({ registry, providerFor, host, log: viewerLog, now: () => new Date() });
  const triggers = createTriggerStore(home, log);
  const triggersLog = log.child({ component: "triggers" });
  // Before the first tick and before the routes are served, so nothing sees an unmoved trigger.
  // Those that fail to move stay in the file and do not fire.
  await adoptLegacyTriggers(home, { triggers, log: triggersLog }).catch((error: unknown) =>
    triggersLog.error({ err: error }, "triggers saved with a folder were not moved to projects"),
  );
  const git = createGit(execWithTimeout(CLONE_TIMEOUT_MS));
  startScheduler({
    triggers,
    registry,
    providerFor,
    host,
    home,
    publicOrigin: origin,
    checkCheckout,
    git,
    log: triggersLog,
    now: () => new Date(),
  });
  const root = createRoot({
    registry,
    triggers,
    providerFor,
    host,
    log,
    home,
    publicOrigin: origin,
    pid: process.pid,
    version,
    startedAt: Date.now(),
    git,
    checkCheckout,
    port: boundPort,
    domain,
    now: () => new Date(),
    openInEditor: (target) => openInEditor({ ...target, env: process.env }),
  });
  server.reload({ fetch: root.fetch });
  await writeFile(portPath(home), String(boundPort));
  await writeFile(pidPath(home), String(process.pid));
  serverLog.info({ port: boundPort, pid: process.pid, version, origin }, "server listening");

  const stop = async (): Promise<void> => {
    stopDeliveries();
    await stopScheduler();
    // stop() resolves once in-flight requests finish, so a run still launching gets recorded.
    await server.stop();
    await removeOwnPid(home);
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
