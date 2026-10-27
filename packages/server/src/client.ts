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
  type ResumeRunBody,
  type StartRunBody,
  type TriggerRef,
} from "./protocol.ts";

export type YokClientOptions = Readonly<{
  url: string;
  login?: Readonly<{ user: string; password: string }>;
  log?: ILogger;
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

const loggedFetch = (log: ILogger) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const start = Date.now();
    const url = input instanceof Request ? input.url : input.toString();
    const fields = { method: init?.method ?? "GET", path: new URL(url).pathname };
    const res = await fetch(input, init).catch((error: unknown) => {
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
// server's origin; login is for the reverse proxy in front of a remote server.
export const createYokClient = ({ url, login, log = noopLogger }: YokClientOptions) => {
  const fetch = loggedFetch(log.child({ component: "client" }));
  const basic = login && Buffer.from(`${login.user}:${login.password}`).toString("base64");
  const headers = basic === undefined ? {} : { authorization: `Basic ${basic}` };
  const api = hc<ApiType>(`${url.replace(/\/+$/, "")}/api`, { fetch, headers });
  return {
    health: () => unwrap(api.health.$get()),
    run: (body: StartRunBody) => unwrap(api.runs.$post({ json: body })),
    resume: (runId: string, body: ResumeRunBody) =>
      unwrap(api.runs[":id"].resume.$post({ param: { id: runId }, json: body })),
    projects: () => unwrap(api.projects.$get()),
    addProject: (body: AddProjectRequest) => unwrap(api.projects.$post({ json: body })),
    removeProject: (name: string, purge: boolean) =>
      unwrap(
        api.projects[":name"].$delete({
          param: { name },
          query: { purge: purge ? "true" : "false" },
        }),
      ),
    doctor: (body: DoctorBody) => unwrap(api.doctor.$post({ json: body })),
    view: (runId: string) => unwrap(api.runs[":id"].view.$get({ param: { id: runId } })),
    viewRuns: () => unwrap(api.runs.view.$get()),
    addTrigger: (body: AddTriggerBody) => unwrap(api.triggers.$post({ json: body })),
    listTriggers: () => unwrap(api.triggers.$get()),
    fireTrigger: (ref: TriggerRef) => unwrap(api.triggers.fire.$post({ json: ref })),
    triggerLog: (ref: TriggerRef) => unwrap(api.triggers.log.$get({ query: ref })),
    removeTrigger: (ref: TriggerRef) => unwrap(api.triggers.$delete({ query: ref })),
  };
};

export type YokClient = ReturnType<typeof createYokClient>;
