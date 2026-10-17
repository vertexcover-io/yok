import { type ILogger, noopLogger, type Result } from "@yok/sdk";
import type { ClientResponse } from "hono/client";
import { hc } from "hono/client";
import type { SuccessStatusCode } from "hono/utils/http-status";
import type { AppType } from "./app.ts";
import {
  type AddProjectRequest,
  type ApiError,
  ErrorBodySchema,
  type StartRunRequest,
} from "./protocol.ts";

// What the client sends requests through; a caller inside the server passes its app's request.
export type Transport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type YokClientOptions = Readonly<{
  url: string;
  apiKey: string;
  log?: ILogger;
  transport?: Transport;
}>;

// The body a response carries on its 2xx statuses, as the server's routes declare it.
type SuccessBody<R> =
  R extends ClientResponse<infer Body, infer Status, "json">
    ? Status extends SuccessStatusCode
      ? Body
      : never
    : never;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// A non-JSON reply (a proxy, a crash mid-response) still comes back as an ApiError.
const replyError = (status: number, text: string, json: unknown): ApiError => {
  const body = ErrorBodySchema.safeParse(json);
  if (body.success) return body.data.error;
  return { code: "internal", message: `${status} ${text.trim().slice(0, 200)}`.trim() };
};

const unwrap = async <R extends ClientResponse<unknown, number, "json">>(
  pending: Promise<R>,
): Promise<Result<SuccessBody<R>, ApiError>> => {
  const res = await pending.catch(() => null);
  if (res === null)
    return { ok: false, error: { code: "internal", message: "server unreachable" } };
  const text = await res.text();
  const json = parseJson(text);
  return res.ok
    ? { ok: true, value: json as SuccessBody<R> }
    : { ok: false, error: replyError(res.status, text, json) };
};

const loggedFetch = (log: ILogger, transport: Transport) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const start = Date.now();
    const url = input instanceof Request ? input.url : input.toString();
    const fields = { method: init?.method ?? "GET", path: new URL(url).pathname };
    const res = await transport(input, init).catch((error: unknown) => {
      log.debug({ ...fields, err: error }, "server not reachable");
      throw error;
    });
    // reqId matches the server's own line for this request in server.log.
    const reqId = res.headers.get("x-request-id") ?? undefined;
    log.debug(
      { ...fields, status: res.status, reqId, durationMs: Date.now() - start },
      "server request finished",
    );
    return res;
  }) as typeof fetch;

// One method per API call, named like the CLI command that makes it. Inputs and outputs are
// typed from the server's routes, so neither side restates the other's schemas.
export const createYokClient = ({
  url,
  apiKey,
  log = noopLogger,
  transport = (input, init) => fetch(input, init),
}: YokClientOptions) => {
  const send = loggedFetch(log.child({ component: "client" }), transport);
  // /health goes without the key: the CLI asks it to learn whether the port is still its own
  // server's, and another local user may have taken the port while the server was down.
  const open = hc<AppType>(url, { fetch: send });
  const api = hc<AppType>(url, { fetch: send, headers: { authorization: `Bearer ${apiKey}` } });
  return {
    health: () => unwrap(open.health.$get()),
    run: (body: StartRunRequest) => unwrap(api.runs.$post({ json: body })),
    projects: () => unwrap(api.projects.$get()),
    addProject: (body: AddProjectRequest) => unwrap(api.projects.$post({ json: body })),
    removeProject: (name: string, purge: boolean) =>
      unwrap(
        api.projects[":name"].$delete({
          param: { name },
          query: { purge: purge ? "true" : "false" },
        }),
      ),
    view: (runId: string) => unwrap(api.runs[":id"].view.$get({ param: { id: runId } })),
    viewRuns: () => unwrap(api.runs.view.$get()),
    showRun: (runId: string) => unwrap(api.runs[":id"].$get({ param: { id: runId } })),
    runFiles: (runId: string) => unwrap(api.runs[":id"].files.$get({ param: { id: runId } })),
    runFile: (runId: string, path: string) =>
      unwrap(api.runs[":id"].file.$get({ param: { id: runId }, query: { path } })),
  };
};

export type YokClient = ReturnType<typeof createYokClient>;
