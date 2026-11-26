import { type ILogger, noopLogger, type Result } from "@yok/sdk";
import type { ClientResponse } from "hono/client";
import { hc } from "hono/client";
import type { SuccessStatusCode } from "hono/utils/http-status";
import type { ApiType } from "./app.ts";
import {
  type AddProjectRequest,
  type AddTriggerBody,
  type ApiError,
  type DoctorBody,
  ErrorBodySchema,
  type ListRunsQuery,
  type ResumeRunBody,
  type RetryRunBody,
  type StartRunBody,
  type TriggerRef,
} from "./protocol.ts";

export type YokClientOptions = Readonly<{
  url: string;
  token?: string;
  // what a 401 says instead of the server's own text, which cannot know how this caller logs in
  unauthenticated?: string;
  log?: ILogger;
  // what sends each request; the network's fetch unless the caller answers it in memory
  send?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
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

export const apiErrorText = (error: ApiError): string => `${error.code}: ${error.message}`;

const unwrap = async <R extends ClientResponse<unknown, number, "json">>(
  pending: Promise<R>,
  unauthenticated?: string,
): Promise<Result<SuccessBody<R>, ApiError>> => {
  const res = await pending.catch(() => null);
  if (res === null)
    return { ok: false, error: { code: "internal", message: "server unreachable" } };
  const text = await res.text();
  const json = parseJson(text);
  if (res.status === 401 && unauthenticated !== undefined) {
    return { ok: false, error: { code: "unauthenticated", message: unauthenticated } };
  }
  return res.ok
    ? { ok: true, value: json as SuccessBody<R> }
    : { ok: false, error: replyError(res.status, text, json) };
};

const loggedFetch = (
  log: ILogger,
  send: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const start = Date.now();
    const url = input instanceof Request ? input.url : input.toString();
    const fields = { method: init?.method ?? "GET", path: new URL(url).pathname };
    const res = await send(input, init).catch((error: unknown) => {
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
// typed from the server's routes, so neither side restates the other's schemas. url is the
// server's origin; token is the CLI token a gated server asks every caller for.
export const createYokClient = ({
  url,
  token,
  unauthenticated,
  log = noopLogger,
  send = (input, init) => fetch(input, init),
}: YokClientOptions) => {
  const logged = loggedFetch(log.child({ component: "client" }), send);
  const headers = token === undefined ? {} : { authorization: `Bearer ${token}` };
  const api = hc<ApiType>(`${url.replace(/\/+$/, "")}/api`, { fetch: logged, headers });
  const call = <R extends ClientResponse<unknown, number, "json">>(pending: Promise<R>) =>
    unwrap(pending, unauthenticated);
  return {
    health: () => call(api.health.$get()),
    me: () => call(api.me.$get()),
    revokeCurrentToken: () => call(api.tokens.current.$delete()),
    run: (body: StartRunBody) => call(api.runs.$post({ json: body })),
    resume: (body: ResumeRunBody) => call(api.runs.resume.$post({ json: body })),
    retry: (body: RetryRunBody) => call(api.runs.retry.$post({ json: body })),
    projects: () => call(api.projects.$get()),
    addProject: (body: AddProjectRequest) => call(api.projects.$post({ json: body })),
    removeProject: (name: string, flags: Readonly<{ force: boolean }>) =>
      call(
        api.projects[":name"].$delete({
          param: { name },
          query: { force: flags.force ? "true" : "false" },
        }),
      ),
    doctor: (body: DoctorBody) => call(api.doctor.$post({ json: body })),
    view: (runId: string) => call(api.runs[":id"].view.$get({ param: { id: runId } })),
    viewRuns: () => call(api.runs.view.$get()),
    runs: (query: ListRunsQuery) => call(api.runs.$get({ query })),
    removeRun: (id: string) => call(api.runs[":id"].$delete({ param: { id } })),
    addTrigger: (body: AddTriggerBody) => call(api.triggers.$post({ json: body })),
    listTriggers: () => call(api.triggers.$get()),
    fireTrigger: (ref: TriggerRef) => call(api.triggers.fire.$post({ json: ref })),
    triggerLog: (ref: TriggerRef) => call(api.triggers.log.$get({ query: ref })),
    removeTrigger: (ref: TriggerRef) => call(api.triggers.$delete({ query: ref })),
  };
};

export type YokClient = ReturnType<typeof createYokClient>;
