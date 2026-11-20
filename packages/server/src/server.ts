import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  agentProvider,
  builtInChecks,
  createLogger,
  type DoctorReport,
  loadStartEnv,
  type notifierHooks,
  resolveLevel,
  runDoctor,
  type WorkflowAgent,
  type WorkflowPlan,
  workflowChecks,
  yokTerminalHost,
} from "@yok/core";
import type { Check, IAgentProvider, ILogger, ITerminalHost, Result } from "@yok/sdk";
import { createGit, execWithTimeout, noopLogger } from "@yok/sdk";
import { openStorage, VERSION } from "@yok/sdk/internal";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import prettyFactory from "pino-pretty";
import type { Vars } from "./api.ts";
import { type ApiDeps, createApi } from "./app.ts";
import { createYokClient } from "./client.ts";
import { resumeDeliveries, stopDeliveries } from "./delivery.ts";
import { identityRoutes, requireCaller } from "./identity.ts";
import { CLONE_TIMEOUT_MS } from "./projects.ts";
import { isGated, pidPath, portPath, publicOrigin, readPort, serverDomain } from "./protocol.ts";
import { slackHookRoutes } from "./slack.ts";
import { startScheduler, stopScheduler } from "./trigger.ts";
import { hostGuard, openInEditor, type ViewerDeps, viewerRoutes } from "./viewer.ts";

export type CheckCheckout = (
  // env: the env the session will get, checked instead of the checkout's when given
  input: Readonly<{
    cwd: string;
    config?: string;
    plan?: WorkflowPlan;
    env?: Result<Record<string, string>>;
  }>,
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
  { cwd, config, plan, ...given }: Parameters<CheckCheckout>[0],
): ReturnType<CheckCheckout> => {
  const agent = plan?.agent ?? "claude";
  const env = given.env ?? (await loadStartEnv(config ?? null, cwd, plan ?? { env: {}, agent }));
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

export type RootDeps = ApiDeps &
  ViewerDeps &
  Readonly<{
    port: number;
    domain: string;
    // SERVER_DOMAIN was set when the server started: every route then needs a caller
    gated: boolean;
    slackFetch?: notifierHooks.Fetch;
    githubFetch?: notifierHooks.Fetch;
  }>;

// The API sits under /api so its routes never shadow a dashboard page: the API's GET /runs/view
// once also matched the dashboard's GET /runs/:id. The Slack hook is added before the API, whose
// 404 for an unknown path would otherwise answer first. requireCaller sits here and not in
// createApi, so the in-memory client a Slack command uses is not asked for a login.
export const createRoot = (deps: RootDeps) => {
  const api = createApi(deps);
  // A chat command runs through the API's own routes, so it is checked and answered as one
  // from yok --remote is.
  const self = new Hono().route("/api", api);
  const client = createYokClient({
    url: "http://yok.internal",
    send: async (input, init) => self.request(input, init),
  });
  return new Hono<{ Variables: Vars }>()
    .use("*", hostGuard(deps.port, deps.domain))
    .use("*", requireCaller(deps))
    .route("/api/hooks/slack", slackHookRoutes({ ...deps, client }))
    .route("/api", api)
    .route(
      "/",
      identityRoutes({
        ...deps,
        publicOrigin: publicOrigin(deps.domain),
        log: deps.log.child({ component: "identity" }),
      }),
    )
    .route("/", viewerRoutes({ ...deps, log: deps.log.child({ component: "viewer" }) }));
};

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
      websocket,
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
  // Opened before the port is bound, so an SQLite too old or a yok.db from a newer yok stops the
  // start with nothing listening.
  const storage = openStorage(home);
  // Bound before anything starts, so a named port that is taken leaves nothing running.
  const server = listen(port, readPort(home));
  const boundPort = server.port as number;
  const domain = serverDomain(home, boundPort);
  const origin = publicOrigin(domain);

  const { host, providerFor, checkCheckout } = runtime ?? defaultRuntime(log);
  const version = VERSION;
  const viewerLog = log.child({ component: "viewer" });
  void resumeDeliveries({ storage, providerFor, host, log: viewerLog });
  const triggersLog = log.child({ component: "triggers" });
  const stopping = new AbortController();
  const git = createGit(execWithTimeout(CLONE_TIMEOUT_MS, { GIT_TERMINAL_PROMPT: "0" }));
  startScheduler({
    storage,
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
    storage,
    providerFor,
    host,
    log,
    home,
    publicOrigin: origin,
    pid: process.pid,
    version,
    startedAt: Date.now(),
    stopping: stopping.signal,
    git,
    checkCheckout,
    port: boundPort,
    domain,
    gated: isGated(home),
    now: () => new Date(),
    openInEditor: (target) => openInEditor({ ...target, env: process.env }),
  });
  server.reload({ fetch: root.fetch, websocket });
  await writeFile(portPath(home), String(boundPort));
  await writeFile(pidPath(home), String(process.pid));
  serverLog.info({ port: boundPort, pid: process.pid, version, origin }, "server listening");

  const stop = async (): Promise<void> => {
    stopDeliveries();
    await stopScheduler();
    // The live streams and terminal sockets never finish on their own; end them first. stop()
    // then resolves once the other in-flight requests finish, so a run still launching gets
    // recorded.
    stopping.abort();
    await server.stop();
    await storage.close();
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
