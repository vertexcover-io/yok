#!/usr/bin/env node
// Appends one learning event (JSON on stdin) to the session's events file.
// Usage: yok orchestrate skill run learn.log-learning-event [SESSION_ID] <<'EOF'
//        { ...event fields... }
//        EOF
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createRegistryReader,
  readEvents,
  readRunSessions,
  registryPath,
  requireRun,
  runDirOf,
} from "@yok/sdk";
import { PLUGIN, readPlugin } from "./plugin.mjs";
import { parseRecords } from "./transcript.mjs";

// What the skill may send. Every field is text unless it is a list.
const FIELDS = {
  trigger: { required: true, oneOf: ["manual", "auto"] },
  whyTriggered: { required: true },
  evidenceFrom: {},
  evidenceTo: {},
  optionsShown: { list: true },
  proposedLearning: { required: true },
  optionUserPicked: {},
  outcome: { required: true, oneOf: ["new", "occurrence", "lint", "rejected"] },
  status: { required: true },
  finalLearning: {},
  rejectionReason: {},
  learningFile: {},
  replaces: {},
};
// Which statuses each outcome can have: the table in SKILL.md step 7, enforced.
const STATUSES_BY_OUTCOME = {
  new: ["accepted", "edited"],
  occurrence: ["existing"],
  lint: ["accepted", "rejected"],
  rejected: ["rejected"],
};

// Events sit beside the plugin's other artifacts: in .<plugin>/ at the git top level.
export const eventsDir = (cwd) => {
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).stdout?.trim();
  return join(root || cwd, `.${PLUGIN.name}`, "learning-events");
};

export const skillVersion = (manifestPath) => {
  const { name, version } = manifestPath ? readPlugin(manifestPath) : PLUGIN;
  return version ? `${name}@${version}` : "";
};

// The run's current session, from its event log: the hooks record each session the run starts and
// each one a context step replaces, for every agent. Undefined when the log names none.
export const runSessionId = (runDir) => {
  const path = join(runDir, "event.jsonl");
  return existsSync(path) ? readRunSessions(readEvents(path)).at(-1)?.sessionId : undefined;
};

const currentRunSessionId = async () => {
  const run = await requireRun({
    registry: createRegistryReader(registryPath()),
    env: process.env,
    cwd: process.cwd(),
  });
  if (!run.ok) throw new Error(`learn works only in a yok run: ${run.error}`);
  const sessionId = runSessionId(runDirOf(run.value.cwd, run.value.name));
  if (sessionId === undefined) throw new Error("the run's event log names no session");
  return sessionId;
};

const transcriptPath = (sessionId, env) => {
  const projects = join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  if (!existsSync(projects)) return null;
  return (
    readdirSync(projects)
      .map((dir) => join(projects, dir, `${sessionId}.jsonl`))
      .find((path) => existsSync(path)) ?? null
  );
};

const normalize = (text) => text.replace(/\s+/g, " ").trim().toLowerCase();

const stringsIn = (value) => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
};

// What the user said and what the agent wrote or ran. Thinking, tool output, injected skill text
// and compaction summaries are left out, and so are calls to this script, whose heredoc repeats
// both snippets.
const searchableText = (record) => {
  if (record.type !== "user" && record.type !== "assistant") return null;
  if (record.isMeta || record.isCompactSummary || !record.uuid) return null;
  const content = record.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .flatMap((block) => {
      if (block.type === "text") return [block.text];
      if (block.type !== "tool_use" || String(block.input?.command).includes("log-learning-event"))
        return [];
      return stringsIn(block.input);
    })
    .join("\n");
  return text || null;
};

export const parseTranscript = (raw) =>
  parseRecords(raw).flatMap((record) => {
    const text = searchableText(record);
    return text
      ? [{ uuid: record.uuid, byUser: record.type === "user", text: normalize(text) }]
      : [];
  });

// The exchange ends at the first message from the user with the `to` snippet (the correction) and
// starts at the agent's last message with the `from` snippet before it (the mistake it corrected).
// So a phrase that also appears earlier cannot stretch the range, and a correction that quotes the
// agent's words cannot be taken for the mistake. Missing lists the snippets given but not found.
export const resolveEvidence = (messages, from = "", to = "") => {
  const needles = { from: normalize(from), to: normalize(to) };
  const toIndex = needles.to
    ? messages.findIndex((message) => message.byUser && message.text.includes(needles.to))
    : -1;
  const before = toIndex === -1 ? messages : messages.slice(0, toIndex);
  const fromIndex = needles.from
    ? before.findLastIndex((message) => !message.byUser && message.text.includes(needles.from))
    : -1;
  return {
    ids: {
      evidenceFromMessage: messages[fromIndex]?.uuid ?? "",
      evidenceToMessage: messages[toIndex]?.uuid ?? "",
    },
    missing: [
      ...(needles.from && fromIndex === -1
        ? [
            `evidenceFrom was not found in your own messages or tool calls${toIndex === -1 ? "" : " before evidenceTo"} (it must be your words or code, never the user's)`,
          ]
        : []),
      ...(needles.to && toIndex === -1 ? ["evidenceTo was not found"] : []),
    ],
  };
};

const fieldErrors = (event, key, rule) => {
  const value = event[key];
  if (value === undefined) return rule.required ? [`${key} is required`] : [];
  if (rule.list) return Array.isArray(value) ? [] : [`${key} must be a list`];
  if (typeof value !== "string") return [`${key} must be text`];
  if (rule.required && value === "") return [`${key} is required`];
  if (rule.oneOf && !rule.oneOf.includes(value))
    return [`${key} must be one of ${rule.oneOf.filter(Boolean).join(", ")}`];
  return [];
};

export const validate = (event) => {
  if (!event || typeof event !== "object" || Array.isArray(event))
    return ["the event must be a JSON object"];
  return [
    ...Object.keys(event)
      .filter((key) => !(key in FIELDS))
      .map((key) => `${key} is not a known field`),
    ...Object.entries(FIELDS).flatMap(([key, rule]) => fieldErrors(event, key, rule)),
    ...(STATUSES_BY_OUTCOME[event.outcome] &&
    typeof event.status === "string" &&
    event.status &&
    !STATUSES_BY_OUTCOME[event.outcome].includes(event.status)
      ? [
          `status for outcome ${event.outcome} must be one of ${STATUSES_BY_OUTCOME[event.outcome].join(", ")}`,
        ]
      : []),
    ...(event.status === "edited" && !event.finalLearning
      ? ["finalLearning is required when status is edited"]
      : []),
    ...(event.status !== "edited" && event.finalLearning
      ? ["finalLearning is only for status edited"]
      : []),
  ];
};

// The snippets are only for finding the messages; the event keeps their ids. Generated fields come
// last, so nothing the model sends can override them.
export const buildEvent = (
  { evidenceFrom, evidenceTo, ...input },
  sessionId,
  { now = new Date(), cwd = process.cwd(), evidence = {}, version = skillVersion() } = {},
) => ({
  ...input,
  evidenceFromMessage: evidence.evidenceFromMessage ?? "",
  evidenceToMessage: evidence.evidenceToMessage ?? "",
  eventId: randomUUID(),
  sessionId,
  timestamp: now.toISOString(),
  cwd,
  skillVersion: version,
});

// Snippets are only checked against a transcript that was found: without one (Codex's, which this
// does not read) the event is logged with empty ids.
export const logEvent = (raw, sessionId, { env = process.env, cwd = process.cwd() } = {}) => {
  const input = JSON.parse(raw);
  const invalid = validate(input);
  if (invalid.length > 0) throw new Error(invalid.join("; "));
  const path = transcriptPath(sessionId, env);
  const messages = path ? parseTranscript(readFileSync(path, "utf8")) : [];
  const { ids, missing } = resolveEvidence(messages, input.evidenceFrom, input.evidenceTo);
  if (messages.length > 0 && missing.length > 0) {
    throw new Error(
      `${missing.join("; ")}; copy a few words exactly from one message of this session`,
    );
  }
  const event = buildEvent(input, sessionId, { cwd, evidence: ids });
  const dir = eventsDir(cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  appendFileSync(file, `${JSON.stringify(event)}\n`);
  return file;
};

// `yok orchestrate skill run` imports this file and calls main. Run directly, it calls main itself;
// Node before 24.2 has no import.meta.main, so the file's own path decides there.
export const main = async (argv) => {
  try {
    const sessionId = argv[0] || (await currentRunSessionId());
    console.log(`logged to ${logEvent(readFileSync(0, "utf8"), sessionId)}`);
    return 0;
  } catch (error) {
    console.error(`log-learning-event: ${error.message}`);
    return 1;
  }
};

if (import.meta.main ?? import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
