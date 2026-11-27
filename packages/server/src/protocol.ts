import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
  AbsolutePathSchema,
  JsonObjectSchema,
  NonEmptyStringSchema,
  PolicyLayerSchema,
  SlugSchema,
  withLock,
  yokHome,
} from "@yok/sdk";
import {
  AUDIT_CLICK_TYPES,
  AuditRunSchema,
  homeEnvPath,
  type Project,
  readHomeFile,
  readServerDomain,
} from "@yok/sdk/internal";
import * as z from "zod";
import { RunStatusSchema } from "./overview.ts";

export {
  folderSlug,
  homeEnvPath,
  type Project,
  ProjectSchema,
  publicOrigin,
  readHomeEnv,
} from "@yok/sdk/internal";

export const portPath = (home: string = yokHome()): string => join(home, "server.port");
export const pidPath = (home: string = yokHome()): string => join(home, "server.pid");
export const logPath = (home: string = yokHome()): string => join(home, "server.log");

export const readPort = (home: string): number | null => {
  const port = Number.parseInt(readHomeFile(portPath(home)), 10);
  return Number.isInteger(port) && port > 0 ? port : null;
};

// The domain a reverse proxy in front of yok answers on; this machine's own address without one.
export const serverDomain = (home: string, port: number): string =>
  readServerDomain(home) ?? `localhost:${port}`;

// A server with a SERVER_DOMAIN is shared, and every caller must sign in; one without is local and open.
export const isGated = (home: string): boolean => readServerDomain(home) !== undefined;

const envLineKey = (line: string): string => line.slice(0, line.indexOf("=")).trim();

type EnvValues = Record<string, string | null>;

// Replaces the named keys' lines and drops the ones set to null; every other line stays. Given a
// function, the values are worked out from the file as it is once the lock is held.
export const updateHomeEnv = async (
  home: string,
  values: EnvValues | ((env: Record<string, string | undefined>) => EnvValues),
): Promise<void> => {
  // before the lock, which would otherwise create the home with the umask's permissions
  await mkdir(home, { recursive: true, mode: 0o700 });
  await withLock(`${homeEnvPath(home)}.lock`, async () => {
    const text = readHomeFile(homeEnvPath(home));
    const changes = typeof values === "function" ? values(parseEnv(text)) : values;
    const kept = text
      .split("\n")
      .filter((line) => line.trim() !== "" && !(envLineKey(line) in changes));
    const added = Object.entries(changes).flatMap(([key, value]) =>
      value === null ? [] : [`${key}=${value}`],
    );
    await writeFile(homeEnvPath(home), [...kept, ...added].map((line) => `${line}\n`).join(""), {
      mode: 0o600,
    });
    // writeFile's mode applies only when it creates the file.
    await chmod(homeEnvPath(home), 0o600);
  });
};

export const ErrorBodySchema = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      "bad-request",
      "unauthenticated",
      "forbidden",
      "not-found",
      "conflict",
      "too-many-requests",
      "agent-failed",
      "git-failed",
      "internal",
    ]),
    message: z.string(),
    // what the route knows beyond the message: the doctor's report when a run is refused
    details: z.json().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
export type ErrorCode = ErrorBody["error"]["code"];

export const DeviceStartBodySchema = z.strictObject({
  hostname: z.string().trim().min(1).max(100),
});

export const DeviceStartReplySchema = z.strictObject({
  deviceCode: NonEmptyStringSchema,
  // what the person types at verificationUrl, like ABCD-EFGH
  userCode: NonEmptyStringSchema,
  verificationUrl: z.url(),
  expiresIn: z.number().int(),
  interval: z.number().int(),
});

export const DeviceTokenBodySchema = z.strictObject({ deviceCode: NonEmptyStringSchema });

// An expired or unknown device code is a 404, not a status.
export const DeviceTokenReplySchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({ status: z.literal("approved"), token: NonEmptyStringSchema }),
]);
export type DeviceTokenReply = z.infer<typeof DeviceTokenReplySchema>;

// The agent, tiers and env come from the compiled workflow and the checkout, on the server.
export const StartRunBodySchema = z.strictObject({
  // a registered project's name; the server never picks one
  project: SlugSchema,
  // a shipped workflow's name, or a workflow file resolved against the project's checkout
  workflow: NonEmptyStringSchema,
  inputs: JsonObjectSchema,
  name: SlugSchema.optional(),
  // a config file read instead of the checkout's own, resolved against the checkout
  config: NonEmptyStringSchema.optional(),
  // the caller's own policy values; the server merges them over the workflow's and the config's
  policies: PolicyLayerSchema.optional(),
});
export type StartRunBody = z.infer<typeof StartRunBodySchema>;

export const DoctorBodySchema = z.strictObject({
  project: SlugSchema,
  // a shipped workflow's name, or a workflow file resolved against the project's checkout
  workflow: NonEmptyStringSchema.optional(),
});
export type DoctorBody = z.infer<typeof DoctorBodySchema>;

export const AddTriggerBodySchema = z.strictObject({
  project: SlugSchema,
  // a shipped workflow's name, or a workflow file resolved against the project's folder
  workflow: NonEmptyStringSchema,
  // a config file read instead of the project's own, resolved against the project's folder
  config: NonEmptyStringSchema.optional(),
});
export type AddTriggerBody = z.infer<typeof AddTriggerBodySchema>;

// A trigger's name is unique within its project.
export const TriggerRefSchema = z.strictObject({ project: SlugSchema, name: SlugSchema });
export type TriggerRef = z.infer<typeof TriggerRefSchema>;

// The run a resume or retry brings back: by id, or by its name inside a registered project.
export const RunPickSchema = z.union([
  z.strictObject({ id: NonEmptyStringSchema }),
  z.strictObject({ project: SlugSchema, name: SlugSchema }),
]);
export type RunPick = z.infer<typeof RunPickSchema>;

// The server builds the session's env and runs the doctor itself, as it does for a new run.
export const ResumeRunBodySchema = z.strictObject({ run: RunPickSchema });
export type ResumeRunBody = z.infer<typeof ResumeRunBodySchema>;

// answered: a person has dealt with what a needs-input failure asked, so retry may rerun it
export const RetryRunBodySchema = ResumeRunBodySchema.extend({ answered: z.boolean().optional() });
export type RetryRunBody = z.infer<typeof RetryRunBodySchema>;

// Query values arrive as text.
const LimitSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/, "limit must be a whole number above 0")
  .transform(Number)
  .pipe(z.int().max(Number.MAX_SAFE_INTEGER, "limit is too large"));

// GET /runs. Query values arrive as text; status is one comma list.
export const ListRunsQuerySchema = z
  .strictObject({
    project: NonEmptyStringSchema.optional(),
    status: z
      .string()
      .transform((text) => text.split(","))
      .pipe(z.array(RunStatusSchema))
      .optional(),
    limit: LimitSchema.optional(),
    all: z.enum(["true", "false"]).optional(),
    // a yok user id, GitHub login, GitHub id or email
    by: NonEmptyStringSchema.optional(),
  })
  .refine((query) => query.all !== "true" || query.limit === undefined, {
    message: "--all and --limit cannot be used together",
  });
export type ListRunsQuery = z.input<typeof ListRunsQuerySchema>;
export type RunsFilter = z.output<typeof ListRunsQuerySchema>;

// GET /audits/projects
export const AuditProjectsQuerySchema = z.strictObject({ audit: AuditRunSchema.shape.audit });

// GET /audits: the run picker, newest period first
export const AuditRunsQuerySchema = AuditProjectsQuerySchema.extend({
  project: SlugSchema,
  // the page asks for 12; past 100 a picker is no longer a picker
  limit: LimitSchema.pipe(z.int().max(100, "limit must be at most 100")).default(12),
});

// GET /audits/metrics: the trend charts of one repo
export const AuditMetricsQuerySchema = AuditProjectsQuerySchema.extend({
  project: SlugSchema,
  repo: NonEmptyStringSchema,
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

// POST /audits/results/:resultId/events: a person's click; the server sets who
export const AuditEventBodySchema = z.strictObject({
  type: z.enum(AUDIT_CLICK_TYPES),
  feedback: NonEmptyStringSchema.optional(),
});
export type AuditEventBody = z.infer<typeof AuditEventBodySchema>;

export type ApiError = ErrorBody["error"];

// Who asked for a project or a run: metadata, never an authentication fact.
export const AddedBySchema = z.strictObject({
  channel: NonEmptyStringSchema,
  id: z.string().optional(),
  name: z.string().optional(),
});

// Any other form, file:// or a transport helper such as ext::, would let any caller read the
// server's own files through a clone. The URL is saved and listed to every caller, so it holds
// no password, and an https one no user name either, since a token often goes there.
const isCredentialFree = (url: URL): boolean =>
  url.password === "" && (url.protocol !== "https:" || url.username === "");

const GitUrlSchema = z
  .string()
  .regex(/^(https:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)\S+$/, "must be an https, ssh or user@host: URL")
  .refine(
    (url) => !URL.canParse(url) || isCredentialFree(new URL(url)),
    "must not hold a password or an https user name; use a git credential helper or an ssh key",
  );

export const AddProjectBodySchema = z
  .strictObject({
    name: SlugSchema,
    git: GitUrlSchema.optional(),
    // with git: where to clone to, default <home>/projects/NAME
    // TODO: any absolute path is accepted here and in claimAndClone (projects.ts); confine it to HOME/projects.
    path: AbsolutePathSchema.optional(),
    addedBy: AddedBySchema.default({ channel: "api" }),
  })
  .refine((body) => body.git !== undefined || body.path !== undefined, "give git, path, or both");
export type AddProjectBody = z.infer<typeof AddProjectBodySchema>;
export type AddProjectRequest = z.input<typeof AddProjectBodySchema>;

export type ProjectView = Project & Readonly<{ name: string; status: "ready" | "missing" }>;
