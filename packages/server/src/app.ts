import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { ILogger } from "@yok/sdk";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { errorResponse, type Vars } from "./api.ts";
import { type ProjectDeps, projectRoutes } from "./projects.ts";
import { type RunDeps, runRoutes } from "./run.ts";

// Hashed first: timingSafeEqual throws on inputs of different lengths.
const digest = (text: string): Buffer => createHash("sha256").update(text).digest();

// /health stays open: ensureServer polls it before the server has written the key.
const requireKey =
  (apiKey: string): MiddlewareHandler<{ Variables: Vars }> =>
  async (c, next) => {
    if (c.req.path === "/health") return next();
    const given = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!timingSafeEqual(digest(given), digest(apiKey))) {
      return errorResponse(c, 401, "unauthorized", "missing or wrong API key");
    }
    return next();
  };

const requestLogger =
  (log: ILogger): MiddlewareHandler<{ Variables: Vars }> =>
  async (c, next) => {
    const reqId = randomUUID();
    const reqLog = log.child({ component: "http", reqId });
    c.set("log", reqLog);
    const route = { method: c.req.method, path: c.req.path };
    const start = Date.now();
    await next();
    c.header("x-request-id", reqId);
    const fields = { ...route, status: c.res.status, durationMs: Date.now() - start };
    // Every CLI command checks /health first, so it would drown the other lines at info.
    if (c.res.status >= 500) reqLog.error(fields, "request finished");
    else if (route.path === "/health") reqLog.debug(fields, "request finished");
    else reqLog.info(fields, "request finished");
  };

export type AppDeps = RunDeps &
  ProjectDeps &
  Readonly<{
    log: ILogger;
    pid: number;
    version: string;
    startedAt: number;
    apiKey: string;
  }>;

// Routes are chained so their input and output types build up in the app's type, which the
// client (client.ts) reads through AppType.
export const createApp = (deps: AppDeps) =>
  new Hono<{ Variables: Vars }>()
    .use("*", requestLogger(deps.log))
    .use("*", requireKey(deps.apiKey))
    .onError((error, c) => {
      if (error instanceof HTTPException && error.status === 400) {
        return errorResponse(c, 400, "bad-request", error.message);
      }
      c.get("log").error({ err: error }, "request failed with an unexpected error");
      return errorResponse(c, 500, "internal", error.message);
    })
    .get("/health", (c) =>
      c.json({ pid: deps.pid, version: deps.version, startedAt: deps.startedAt }, 200),
    )
    .route("/runs", runRoutes(deps))
    .route("/projects", projectRoutes(deps));

export type AppType = ReturnType<typeof createApp>;
