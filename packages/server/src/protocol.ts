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
export const serverDomain = (home: string, port: number): string =>
  readHomeEnv(home).SERVER_DOMAIN || `localhost:${port}`;

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
  workflowPath: AbsolutePathSchema,
  // the repo root the trigger's runs start in
  cwd: AbsolutePathSchema,
  config: AbsolutePathSchema.optional(),
});
export type AddTriggerBody = z.infer<typeof AddTriggerBodySchema>;

// A trigger's name is unique within its repo.
export const TriggerRefSchema = z.strictObject({ cwd: AbsolutePathSchema, name: SlugSchema });
export type TriggerRef = z.infer<typeof TriggerRefSchema>;

// The env the resumed session starts with, which yok resume builds the way yok run does
export const ResumeRunBodySchema = z.strictObject({ env: z.record(z.string(), z.string()) });
export type ResumeRunBody = z.infer<typeof ResumeRunBodySchema>;

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

// Any other form, file:// or a transport helper such as ext::, would let a key holder read the
// server's own files through a clone. The URL is saved and listed to every caller, so it holds
// no password.
const GitUrlSchema = z
  .string()
  .regex(/^(https:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)\S+$/, "must be an https, ssh or user@host: URL")
  .refine(
    (url) => !URL.canParse(url) || new URL(url).password === "",
    "must not hold a password; use a git credential helper or an ssh key",
  );

export const AddProjectBodySchema = z
  .strictObject({
    name: SlugSchema,
    git: GitUrlSchema.optional(),
    // with git: where to clone to, default <home>/projects/NAME
    path: AbsolutePathSchema.optional(),
    addedBy: AddedBySchema.default({ channel: "api" }),
  })
  .refine((body) => body.git !== undefined || body.path !== undefined, "give git, path, or both");
export type AddProjectBody = z.infer<typeof AddProjectBodySchema>;
export type AddProjectRequest = z.input<typeof AddProjectBodySchema>;

export type ProjectView = Project & Readonly<{ name: string; status: "ready" | "missing" }>;
