import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  buildEvent,
  eventsDir,
  logEvent,
  parseTranscript,
  resolveEvidence,
  runSessionId,
  skillVersion,
  validate,
} from "./log-learning-event.mjs";

const valid = {
  trigger: "auto",
  whyTriggered: "User said caught errors in jobs must go to Sentry",
  proposedLearning: "Report caught errors in background jobs to Sentry",
  outcome: "new",
  status: "accepted",
  optionsShown: ["rethrow", "structured logger", "Sentry"],
};

const root = realpathSync(mkdtempSync(join(tmpdir(), "learn-log-learning-event-")));
after(() => rmSync(root, { recursive: true, force: true }));
const tempDir = (prefix) => mkdtempSync(join(root, prefix));

const line = (record) => JSON.stringify(record);
const transcript = [
  line({
    type: "user",
    uuid: "u1",
    message: { role: "user", content: "add retry to the email job" },
  }),
  line({
    type: "assistant",
    uuid: "a1",
    message: { content: [{ type: "thinking", thinking: "I'll use console.error" }] },
  }),
  line({
    type: "assistant",
    uuid: "a2",
    message: {
      content: [{ type: "text", text: "I'll wrap it in try/catch with   console.error." }],
    },
  }),
  line({
    type: "assistant",
    uuid: "a3",
    message: {
      content: [{ type: "tool_use", name: "Edit", input: { new_string: "console.error(err)" } }],
    },
  }),
  line({
    type: "user",
    uuid: "r1",
    message: { content: [{ type: "tool_result", content: "console.error(err) applied" }] },
  }),
  line({
    type: "user",
    uuid: "u2",
    message: {
      content: "No, I told you, errors go to Sentry. And fix log-learning-event.mjs too.",
    },
  }),
  line({
    type: "user",
    uuid: "m1",
    isMeta: true,
    message: { content: "errors go to Sentry (skill text)" },
  }),
  line({
    type: "assistant",
    uuid: "a4",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Bash",
          input: { command: "node log-learning-event.mjs <<EOF errors go to Sentry" },
        },
      ],
    },
  }),
  "not json",
].join("\n");

// A session whose transcript is the one above, in a config dir of its own, and a fresh repo folder.
const session = (id, raw = transcript) => {
  const config = tempDir("learn-config-");
  mkdirSync(join(config, "projects", "-some-repo"), { recursive: true });
  writeFileSync(join(config, "projects", "-some-repo", `${id}.jsonl`), raw);
  return { env: { CLAUDE_CONFIG_DIR: config }, cwd: tempDir("learn-cwd-") };
};
const noTranscript = () => ({ env: { CLAUDE_CONFIG_DIR: "/nowhere" }, cwd: tempDir("learn-cwd-") });
const eventsFile = (cwd, id) => join(cwd, ".yok", "learning-events", `${id}.jsonl`);
const readEvents = (file) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((entry) => JSON.parse(entry));

test("accepts a new learning that replaces an old one, and rejects the old replaced outcome", () => {
  assert.deepEqual(validate({ ...valid, replaces: "docs/learnings/use-npm.md" }), []);
  assert.deepEqual(validate({ ...valid, outcome: "replaced" }), [
    "outcome must be one of new, occurrence, lint, rejected",
  ]);
  assert.deepEqual(validate({ ...valid, replaces: 1 }), ["replaces must be text"]);
});

test("finalLearning goes with status edited and nothing else", () => {
  assert.deepEqual(validate({ ...valid, status: "edited", finalLearning: "A1" }), []);
  assert.deepEqual(validate({ ...valid, status: "edited" }), [
    "finalLearning is required when status is edited",
  ]);
  assert.deepEqual(validate({ ...valid, status: "accepted", finalLearning: "A1" }), [
    "finalLearning is only for status edited",
  ]);
});

test("reports every missing required field", () => {
  assert.deepEqual(validate({}), [
    "trigger is required",
    "whyTriggered is required",
    "proposedLearning is required",
    "outcome is required",
    "status is required",
  ]);
});

test("rejects values outside the enums, wrong types, unknown fields and non-objects", () => {
  assert.deepEqual(
    validate({
      ...valid,
      outcome: "maybe",
      status: "sure",
      optionsShown: "a",
      evidenceFrom: 1,
      evidence_form: "x",
    }),
    [
      "evidence_form is not a known field",
      "evidenceFrom must be text",
      "optionsShown must be a list",
      "outcome must be one of new, occurrence, lint, rejected",
    ],
  );
  assert.deepEqual(validate(null), ["the event must be a JSON object"]);
  assert.deepEqual(validate([]), ["the event must be a JSON object"]);
});

test("each outcome allows only its own statuses", () => {
  assert.deepEqual(validate({ ...valid, outcome: "new", status: "existing" }), [
    "status for outcome new must be one of accepted, edited",
  ]);
  assert.deepEqual(validate({ ...valid, outcome: "lint", status: "rejected" }), []);
});

test("only what the user said and the agent wrote or ran is searchable, minus calls to this script", () => {
  assert.deepEqual(
    parseTranscript(transcript).map((message) => message.uuid),
    ["u1", "a2", "a3", "u2"],
  );
});

test("finds the messages that start and end the exchange, ignoring case and spacing", () => {
  const { ids, missing } = resolveEvidence(
    parseTranscript(transcript),
    "wrap it in try/catch with console.error",
    "ERRORS GO TO SENTRY",
  );
  assert.deepEqual(ids, { evidenceFromMessage: "a2", evidenceToMessage: "u2" });
  assert.deepEqual(missing, []);
});

test("the start is the last mistake before the first correction, so an earlier mention cannot stretch it", () => {
  const messages = [
    { uuid: "early", text: "ran npm install for setup" },
    { uuid: "mistake", text: "running npm install" },
    { uuid: "fix", byUser: true, text: "use pnpm here" },
    { uuid: "again", text: "npm install once more" },
  ];
  assert.deepEqual(resolveEvidence(messages, "npm install", "use pnpm").ids, {
    evidenceFromMessage: "mistake",
    evidenceToMessage: "fix",
  });
});

test("a correction that quotes the agent's words is not taken for the mistake", () => {
  const messages = [
    { uuid: "mistake", byUser: false, text: "i'll wrap it: catch (e) { console.log(e) }" },
    {
      uuid: "fix",
      byUser: true,
      text: "you wrote catch (e) { console.log(e) }, nobody reads those logs. send it to sentry",
    },
  ];
  assert.deepEqual(
    resolveEvidence(messages, "catch (e) { console.log(e) }", "send it to sentry").ids,
    {
      evidenceFromMessage: "mistake",
      evidenceToMessage: "fix",
    },
  );
});

test("the end of the exchange is only ever something the user said", () => {
  const messages = [
    { uuid: "agent", byUser: false, text: "i will use pnpm here from now on" },
    { uuid: "user", byUser: true, text: "yes, use pnpm here" },
  ];
  assert.equal(resolveEvidence(messages, "", "use pnpm here").ids.evidenceToMessage, "user");
});

test("snippets that were given but not found, or a start only after the end, are reported missing", () => {
  const messages = parseTranscript(transcript);
  assert.deepEqual(resolveEvidence(messages, "never said", "errors go to Sentry").missing, [
    "evidenceFrom was not found in your own messages or tool calls before evidenceTo (it must be your words or code, never the user's)",
  ]);
  assert.deepEqual(resolveEvidence(messages, "errors go to Sentry", "add retry").missing, [
    "evidenceFrom was not found in your own messages or tool calls before evidenceTo (it must be your words or code, never the user's)",
  ]);
  assert.deepEqual(resolveEvidence(messages, "", "  ").missing, []);
  assert.deepEqual(resolveEvidence(messages, "", "never said").missing, [
    "evidenceTo was not found",
  ]);
});

test("fills id, timestamp, cwd and version, and swaps the snippets for message ids", () => {
  const event = buildEvent({ ...valid, evidenceFrom: "x", evidenceTo: "y" }, "abc", {
    now: new Date("2026-10-06T10:00:00Z"),
    cwd: "/r",
    evidence: { evidenceFromMessage: "a2", evidenceToMessage: "u2" },
    version: "yok@1.0.0",
  });
  assert.equal(event.sessionId, "abc");
  assert.equal(event.timestamp, "2026-10-06T10:00:00.000Z");
  assert.equal(event.cwd, "/r");
  assert.equal(event.skillVersion, "yok@1.0.0");
  assert.deepEqual([event.evidenceFromMessage, event.evidenceToMessage], ["a2", "u2"]);
  assert.equal("evidenceFrom" in event, false);
  assert.match(event.eventId, /^[0-9a-f-]{36}$/);
});

// One line of a run's event.jsonl, as yok writes it.
const runEvent = (seq, type, payload) =>
  JSON.stringify({
    schemaVersion: 1,
    seq,
    id: `e${seq}`,
    ts: "2026-10-15T10:00:00.000Z",
    type,
    source: "test",
    runId: "r-1",
    payload,
  });

test("without a session id, the event goes under the run's current session", () => {
  const runDir = tempDir("run-");
  writeFileSync(
    join(runDir, "event.jsonl"),
    `${[
      runEvent(1, "workflow.started", {
        workflow: "task",
        inputs: {},
        activeSessions: [{ agent: "codex", sessionId: "first" }],
      }),
      runEvent(2, "workflow.session.replaced", {
        agent: "codex",
        previousSessionId: "first",
        sessionId: "after-compact",
      }),
    ].join("\n")}\n`,
  );
  assert.equal(runSessionId(runDir), "after-compact");
  assert.equal(runSessionId(tempDir("empty-run-")), undefined);
});

test("generated fields win over the same keys in the input", () => {
  const input = {
    ...valid,
    eventId: "dup",
    sessionId: "x",
    timestamp: "yesterday",
    cwd: "/x",
    skillVersion: "fake",
  };
  const event = buildEvent(input, "real", {
    now: new Date("2026-10-06T10:00:00Z"),
    cwd: "/r",
    version: "yok@1.0.0",
  });
  assert.notEqual(event.eventId, "dup");
  assert.equal(event.sessionId, "real");
  assert.equal(event.timestamp, "2026-10-06T10:00:00.000Z");
  assert.equal(event.cwd, "/r");
  assert.equal(event.skillVersion, "yok@1.0.0");
});

test("the version is the plugin's name and version, or empty when the manifest is missing", () => {
  assert.match(skillVersion(), /^yok@\d+\.\d+\.\d+/);
  assert.equal(skillVersion("/nowhere/plugin.json"), "");
});

test("events go to .yok/learning-events at the git top level, even from a subfolder", () => {
  const repo = tempDir("learn-repo-");
  spawnSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, "packages", "web"), { recursive: true });
  assert.equal(eventsDir(join(repo, "packages", "web")), join(repo, ".yok", "learning-events"));
});

test("outside a git repo, events go to .yok/learning-events in the current folder", () => {
  const dir = tempDir("learn-plain-");
  assert.equal(eventsDir(dir), join(dir, ".yok", "learning-events"));
});

test("appends one JSON line per event to the session's file, with ids from its transcript", () => {
  const { env, cwd } = session("s1");
  const withEvidence = { ...valid, evidenceFrom: "try/catch", evidenceTo: "errors go to Sentry" };
  const file = logEvent(JSON.stringify(withEvidence), "s1", { env, cwd });
  logEvent(JSON.stringify({ ...valid, outcome: "rejected", status: "rejected" }), "s1", {
    env,
    cwd,
  });
  assert.equal(file, eventsFile(cwd, "s1"));
  const events = readEvents(file);
  assert.deepEqual(
    events.map((entry) => entry.outcome),
    ["new", "rejected"],
  );
  assert.deepEqual([events[0].evidenceFromMessage, events[0].evidenceToMessage], ["a2", "u2"]);
  assert.deepEqual([events[1].evidenceFromMessage, events[1].evidenceToMessage], ["", ""]);
});

test("refuses a snippet that matches no message, and writes nothing", () => {
  const { env, cwd } = session("s4");
  const input = { ...valid, evidenceFrom: "never said this", evidenceTo: "errors go to Sentry" };
  assert.throws(
    () => logEvent(JSON.stringify(input), "s4", { env, cwd }),
    /evidenceFrom was not found/,
  );
  assert.throws(() => readFileSync(eventsFile(cwd, "s4")));
});

test("without a transcript, logs with empty message ids", () => {
  const { env, cwd } = noTranscript();
  const file = logEvent(JSON.stringify({ ...valid, evidenceTo: "x" }), "s9", { env, cwd });
  assert.equal(readEvents(file)[0].evidenceToMessage, "");
});

test("refuses an invalid event and writes nothing", () => {
  const { env, cwd } = noTranscript();
  assert.throws(
    () => logEvent(JSON.stringify({ outcome: "new" }), "s3", { env, cwd }),
    /trigger is required/,
  );
  assert.throws(() => readFileSync(eventsFile(cwd, "s3")));
});
