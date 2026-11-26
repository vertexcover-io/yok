import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Glob } from "bun";
import { ArtifactRefSchema } from "./contracts";

const filesContaining = (
  pattern: string,
  needle: string | RegExp,
  options?: { excludeTests?: boolean },
): string[] => {
  const matches: string[] = [];
  for (const file of new Glob(pattern).scanSync(".")) {
    if (options?.excludeTests === true && file.includes(".test.")) continue;
    const text = readFileSync(file, "utf8");
    if (typeof needle === "string" ? text.includes(needle) : needle.test(text)) matches.push(file);
  }
  return matches.sort();
};

const PUBLIC_RUNTIME_NAMES = [
  "AbsolutePathSchema",
  "AgentInputUnreachableEvent",
  "AgentResumedEvent",
  "AgentStateSchema",
  "AgentStoppedEvent",
  "AgentStuckEvent",
  "AgentTypeSchema",
  "AnsweredQuestionSchema",
  "ApiErrorReachedEvent",
  "ApiErrorResumedEvent",
  "ApiErrorWaitingEvent",
  "ArtifactRefSchema",
  "AskedQuestionSchema",
  "BlockerSchema",
  "CheckStatusSchema",
  "ConfigSchema",
  "ContextOutputSchema",
  "ContextStartedEvent",
  "CustomStateUpdatedEvent",
  "ERROR_MESSAGE_LIMIT",
  "EffortSchema",
  "EmitInputSchema",
  "EnvLayerSchema",
  "ErrorSchema",
  "EventHandlerRefSchema",
  "EventHandlerRefsSchema",
  "EventSchema",
  "EventTypeSchema",
  "FileArtifactSchema",
  "FindingSchema",
  "FixRequestSchema",
  "GitStateSchema",
  "JsonObjectSchema",
  "LayoutSchema",
  "LimitReachedEvent",
  "LimitResumedEvent",
  "LimitWaitingEvent",
  "LinkArtifactSchema",
  "LogLevelSchema",
  "ModelAppliedEvent",
  "ModelRequestedEvent",
  "NOTIFIER_SUBSCRIBER",
  "NOT_FOUND",
  "NameSchema",
  "NodeIteratedEvent",
  "NodeRunSchema",
  "NodeStartedEvent",
  "NodeTypeSchema",
  "NonEmptyStringSchema",
  "NotificationSchema",
  "NotificationThreadStartedEvent",
  "NotifierSchema",
  "POLICY_NAMES",
  "PermissionModeSchema",
  "PoliciesSchema",
  "PolicyLayerSchema",
  "PreToolUseCalledEvent",
  "ProcessRecordSchema",
  "PullRequestSchema",
  "QuestionAnsweredEvent",
  "QuestionAskedEvent",
  "RepositorySchema",
  "ResolvedTiersSchema",
  "SAMSKARA_SUBSCRIBER",
  "SUBSCRIBER_TIMEOUT_S",
  "SamskaraSchema",
  "SavedPoliciesSchema",
  "SessionRefSchema",
  "SessionReplacedEvent",
  "SessionStartCalledEvent",
  "SkillNameSchema",
  "SkipOutputSchema",
  "SlugSchema",
  "StateSchema",
  "StopCalledEvent",
  "StopReasonSchema",
  "SubscriberCalledEvent",
  "SubscriberEntrySchema",
  "SubscriberRefSchema",
  "SubscriberRefsSchema",
  "SubscribersSchema",
  "TicketSchema",
  "TierModelSchema",
  "TiersConfigSchema",
  "TokenUsageSchema",
  "VerifierErrorReasonSchema",
  "VerifierResultSchema",
  "VerifierRunSchema",
  "WorkflowBlockedEvent",
  "WorkflowEndedEvent",
  "WorkflowRefSchema",
  "WorkflowRunSchema",
  "WorkflowStartedEvent",
  "WorkspaceCreateFailedEvent",
  "WorkspaceCreatedEvent",
  "WorkspaceRemoveFailedEvent",
  "WorkspaceRemovedEvent",
  "WorkspaceRepositoryAddFailedEvent",
  "WorkspaceRepositoryAddedEvent",
  "WorkspaceRepositoryRemoveFailedEvent",
  "WorkspaceRepositoryRemovedEvent",
  "WorkspaceSchema",
  "answers",
  "bodyOf",
  "checkBinary",
  "closingLine",
  "collectEventSessions",
  "createGit",
  "emitRunEvent",
  "eventError",
  "execWithTimeout",
  "fail",
  "findConfigRoot",
  "findRoot",
  "findRunPane",
  "findTranscript",
  "humanMessages",
  "indexedFrames",
  "isBuiltTo",
  "isNormalizedRelativePath",
  "isNotBuilt",
  "jsonLogger",
  "killRunning",
  "loadCheckoutConfig",
  "loadConfig",
  "loadConfigAt",
  "loadConfigFile",
  "loadConfigOrDefault",
  "loadEnv",
  "loadNamedConfig",
  "loadPickedConfig",
  "loadRecordedConfig",
  "loadRecords",
  "loadRunConfig",
  "loadStartConfig",
  "noopLogger",
  "ok",
  "parseFrontmatter",
  "parseJson",
  "parseTime",
  "parseYaml",
  "pickRun",
  "readIfExists",
  "readPlanText",
  "readPolicies",
  "readProjectEnv",
  "readRunEvents",
  "readRunSessions",
  "readState",
  "readText",
  "requireRun",
  "resolveRun",
  "runDirOf",
  "sessionEnv",
  "spawn",
  "spawnDetached",
  "spawnInteractive",
  "stackOf",
  "stopRunningOnSignal",
  "tierLaunch",
  "toRepoId",
  "unknownPackage",
  "warn",
  "withLock",
  "yokHome",
];

describe("source boundaries", () => {
  test('SC33: only packages/sdk/src/git.ts calls exec("git"', () => {
    expect(filesContaining("packages/*/src/**/*.ts", 'exec("git"', { excludeTests: true })).toEqual(
      ["packages/sdk/src/git.ts"],
    );
  });

  test("SC40: sdk src never import pino directly", () => {
    // excludeTests: true, so this assertion's own needle text can't match itself.
    expect(
      filesContaining("packages/sdk/src/**/*.ts", 'from "pino', { excludeTests: true }),
    ).toEqual([]);
  });

  test("SC3: no source file imports the deleted agents package, and the package is gone", () => {
    // Built from parts so this file's own needle text can't match itself.
    const agentsImport = ["@yok", "agents"].join("/");
    const sources = ["packages/*/src/**/*.ts", "skills/**/*.{ts,mts,js,mjs}"].flatMap((pattern) =>
      filesContaining(pattern, agentsImport),
    );
    expect(sources).toEqual([]);
    expect(existsSync("packages/agents")).toBe(false);
  });

  test("SC25: no skill, demo stage or engine source tells anyone to run orchestrate through bun run", () => {
    // Built from parts so this file's own needle text can't match itself.
    const bunRun = new RegExp(["bun run", "(--silent )?orchestrate"].join(" "));
    const sources = ["skills/**/*", "demo-workflows/**/*", "packages/*/src/**/*.ts"].flatMap(
      (pattern) => filesContaining(pattern, bunRun, { excludeTests: true }),
    );
    expect(sources).toEqual([]);
  });

  test("every --artifact a skill or demo stage tells the agent to pass is one artifact JSON object", () => {
    const files = ["skills/**/*.md", "demo-workflows/**/*"].flatMap((pattern) => [
      ...new Glob(pattern).scanSync("."),
    ]);
    const texts = files.map((file) => readFileSync(file, "utf8"));
    expect(files.filter((_, index) => /--artifact [\w-]+=/.test(texts[index] ?? ""))).toEqual([]);
    const objects = texts.flatMap((text) =>
      [...text.matchAll(/--artifact '([^']*)'/g)].map((match) => match[1] ?? ""),
    );
    expect(objects.length).toBeGreaterThan(0);
    const invalid = objects.filter(
      (object) =>
        !ArtifactRefSchema.safeParse(JSON.parse(object.replace(/[A-Z]+_URL/, "https://pr.example")))
          .success,
    );
    expect(invalid).toEqual([]);
  });

  test("SC44: no skill text runs a script through bun run, node or orchestrate script --skill, and every script a skill declares as a reference exports main", () => {
    // Built from parts so this file's own needle text can't match itself.
    const oldRunners = new RegExp(
      [
        ...["workspace", "ticket", "linear", "baseline", "retro"].map((name) => `bun run ${name}`),
        ["node", "--experimental-strip-types"].join(" "),
        ["orchestrate script", "--skill"].join(" "),
      ].join("|"),
    );
    expect(filesContaining("skills/**/*.md", oldRunners)).toEqual([]);
    const scripts = [...new Glob("skills/*/SKILL.md").scanSync(".")].flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/^ +path: (scripts\/\S+\.[cm]?[jt]s)$/gm)].map(
        ([, script]) => join(dirname(file), script ?? ""),
      ),
    );
    expect(scripts.length).toBeGreaterThan(0);
    const broken = scripts.filter(
      (path) =>
        !existsSync(path) ||
        !/export (const|(async )?function) main\b/.test(readFileSync(path, "utf8")),
    );
    expect(broken).toEqual([]);
  });

  test("core's stage.ts never imports the workflow compiler, which imports it", () => {
    expect(
      filesContaining("packages/core/src/stage.ts", /from "\.\/workflow\/compile\.ts"/),
    ).toEqual([]);
  });

  test("sdk never imports core, so it installs as a library on its own", () => {
    // Built from parts so this file's own needle text can't match itself.
    const coreImport = `from "${["@yok", "core"].join("/")}"`;
    expect(filesContaining("packages/sdk/**/*.ts", coreImport)).toEqual([]);
  });

  // A write can name the file through a variable or helper, so the check is on the path itself.
  // yok import-files reads the old files once, and its test helper writes them.
  test("EH11 — no source but yok import-files builds a path to state.json: a run's state lives in yok.db", () => {
    const statePath = /[/"'`]state\.json["'`]/;
    const sources = ["packages/*/src/**/*.ts", "skills/**/*.{ts,mts,js,mjs}"].flatMap((pattern) =>
      filesContaining(pattern, statePath, { excludeTests: true }),
    );
    expect(sources).toEqual(["packages/cli/src/import-files.ts", "packages/cli/src/test-runs.ts"]);
  });

  test("SC404: no skill script names state.json, event.jsonl or registry.json, and the sdk offers the run readers in place of readEvents", async () => {
    // Built from parts so this file's own needle text can't match itself.
    const oldRecords = new RegExp(
      [
        ["state", "json"],
        ["event", "jsonl"],
        ["registry", "json"],
      ]
        .map((parts) => parts.join("\\."))
        .join("|"),
    );
    expect(
      filesContaining("skills/**/*.{ts,mts,js,mjs}", oldRecords, { excludeTests: true }),
    ).toEqual([]);
    const names = Object.keys(await import("@yok/sdk"));
    expect(names).toEqual(
      expect.arrayContaining(["readRunEvents", "readRunSessions", "collectEventSessions"]),
    );
    expect(names).not.toContain("readEvents");
  });

  test("EH12 — no skill script imports @yok/core; skills act on a run through the orchestrate script or the sdk", () => {
    expect(filesContaining("skills/**/*.{ts,mts,js,mjs}", /["']@yok\/core["'/]/)).toEqual([]);
  });

  test("SC5, SC7, SC215: @yok/sdk exports exactly the agreed runtime names, minus the registry reader, and never the storage openers", async () => {
    const names = Object.keys(await import("@yok/sdk")).sort();
    expect(names).toEqual(PUBLIC_RUNTIME_NAMES);
    expect(names).toEqual(
      expect.arrayContaining(["emitRunEvent", "resolveRun", "readState", "VerifierResultSchema"]),
    );
    for (const hidden of [
      "createRegistry",
      "createRegistryReader",
      "registryPath",
      "openStorage",
      "memoryStorage",
      "withStorage",
      "useStorage",
      "syncState",
      "createState",
      "appendRunEvent",
      "builtInHandlers",
      "jsonlEventStore",
      "continueWorkflow",
      "recordGuard",
    ]) {
      expect(names).not.toContain(hidden);
    }
  });

  test("SC106: @yok/sdk still offers sessionEnv but never openStorage, memoryStorage or the SQLite version check", async () => {
    const names = Object.keys(await import("@yok/sdk"));
    expect(names).toContain("sessionEnv");
    for (const hidden of ["openStorage", "memoryStorage", "checkSqliteVersion", "sqliteVersion"]) {
      expect(names).not.toContain(hidden);
    }
  });

  test("SC105: only db.ts, schema.ts, storage.ts and storage/ import bun:sqlite or drizzle-orm", () => {
    // Built from parts so this file's own needle text can't match itself.
    const storeImport = new RegExp(
      `from "(${["bun", "sqlite"].join(":")}|${["drizzle", "orm"].join("-")})`,
    );
    expect(filesContaining("packages/*/src/**/*.ts", storeImport, { excludeTests: true })).toEqual([
      "packages/sdk/src/db.ts",
      "packages/sdk/src/schema.ts",
      "packages/sdk/src/storage.ts",
      "packages/sdk/src/storage/audits.ts",
      "packages/sdk/src/storage/comments.ts",
      "packages/sdk/src/storage/common.ts",
      "packages/sdk/src/storage/projects.ts",
      "packages/sdk/src/storage/runs.ts",
      "packages/sdk/src/storage/triggers.ts",
      "packages/sdk/src/storage/users.ts",
    ]);
  });

  test("SC6: the public index and the internal entry name every export", () => {
    const star = ["export", "*"].join(" ");
    expect(
      ["packages/sdk/src/index.ts", "packages/sdk/src/internal.ts"].filter((file) =>
        readFileSync(file, "utf8").includes(star),
      ),
    ).toEqual([]);
  });

  test("SC7, SC404: no skill script but the learn sim's seed imports the sdk's internal entry", () => {
    const internalImport = ["@yok/sdk", "internal"].join("/");
    // The learn sim builds its fake run in yok.db before any agent starts.
    expect(
      filesContaining("skills/**/*.{ts,mts,js,mjs}", internalImport, { excludeTests: true }),
    ).toEqual(["skills/learn/evals/sim/seed.ts"]);
  });
});
