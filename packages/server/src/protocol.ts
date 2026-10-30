import { readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
  AbsolutePathSchema,
  JsonObjectSchema,
  NonEmptyStringSchema,
  PolicyLayerSchema,
  SlugSchema,
  yokHome,
} from "@yok/sdk";
import * as z from "zod";
import { RunStatusSchema } from "./overview.ts";

export const portPath = (home: string = yokHome()): string => join(home, "server.port");
export const homeEnvPath = (home: string = yokHome()): string => join(home, ".env");
export const pidPath = (home: string = yokHome()): string => join(home, "server.pid");
export const logPath = (home: string = yokHome()): string => join(home, "server.log");

const readHomeFile = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

export const readPort = (home: string): number | null => {
  const port = Number.parseInt(readHomeFile(portPath(home)), 10);
  return Number.isInteger(port) && port > 0 ? port : null;
};

export const readHomeEnv = (home: string): Record<string, string | undefined> =>
  parseEnv(readHomeFile(homeEnvPath(home)));

// The domain a reverse proxy in front of yok answers on; this machine's own address without one.
// A browser sends its Host lowercase and without a scheme, so the saved value is cleaned to match.
export const serverDomain = (home: string, port: number): string => {
  const domain = (readHomeEnv(home).SERVER_DOMAIN ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/\/+$/, "");
  return domain || `localhost:${port}`;
};

// Plain http only for this machine: any other domain is reached through a proxy doing https.
export const publicOrigin = (domain: string): string =>
  `${/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(domain) ? "http" : "https"}://${domain}`;

const envLineKey = (line: string): string => line.slice(0, line.indexOf("=")).trim();

// Replaces the named keys' lines and drops the ones set to null; every other line stays.
export const updateHomeEnv = async (
  home: string,
  values: Record<string, string | null>,
): Promise<void> => {
  const kept = readHomeFile(homeEnvPath(home))
    .split("\n")
    .filter((line) => line.trim() !== "" && !(envLineKey(line) in values));
  const added = Object.entries(values).flatMap(([key, value]) =>
    value === null ? [] : [`${key}=${value}`],
  );
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(homeEnvPath(home), [...kept, ...added].map((line) => `${line}\n`).join(""), {
    mode: 0o600,
  });
  // writeFile's mode applies only when it creates the file.
  await chmod(homeEnvPath(home), 0o600);
};

export const ErrorBodySchema = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      "bad-request",
      "not-found",
      "conflict",
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

// "Refrens_Main" -> "refrens-main": the project name `yok run` gives a new checkout, and the
// server gives the folder of a trigger saved on main. Empty or digit-first when the folder has
// no usable name.
export const folderSlug = (folder: string): string =>
  folder
    .replace(/\.git$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// The env the resumed session starts with, which yok resume builds the way yok run does
export const ResumeRunBodySchema = z.strictObject({ env: z.record(z.string(), z.string()) });
export type ResumeRunBody = z.infer<typeof ResumeRunBodySchema>;

// GET /runs. Query values arrive as text; status is one comma list.
export const ListRunsQuerySchema = z.strictObject({
  project: NonEmptyStringSchema.optional(),
  status: z
    .string()
    .transform((text) => text.split(","))
    .pipe(z.array(RunStatusSchema))
    .optional(),
  limit: z
    .string()
    .regex(/^[1-9][0-9]*$/, "limit must be a whole number above 0")
    .transform(Number)
    .optional(),
  all: z.enum(["true", "false"]).optional(),
}).refine((query) => query.all !== "true" || query.limit === undefined, {
  message: "--all and --limit cannot be used together",
});
export type ListRunsQuery = z.input<typeof ListRunsQuerySchema>;
export type RunsFilter = z.output<typeof ListRunsQuerySchema>;

export type ApiError = ErrorBody["error"];

// Who asked for a project or a run: metadata, never an authentication fact.
export const AddedBySchema = z.strictObject({
  channel: NonEmptyStringSchema,
  id: z.string().optional(),
  name: z.string().optional(),
});

export const ProjectSchema = z.strictObject({
  path: AbsolutePathSchema,
  git: z.string().optional(),
  addedBy: AddedBySchema,
  addedAt: z.iso.datetime(),
});
export type Project = z.infer<typeof ProjectSchema>;

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
