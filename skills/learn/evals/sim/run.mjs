#!/usr/bin/env node
// One simulated session: a real agent (claude -p, resumed each turn) in a fresh dummy repo, a
// simulated user (another model) that reacts to what the agent actually says, then checks.
// It tests the plugin this file sits in. See README.md for cost and setup.
// Usage: node run.mjs <scenario> <outDir>
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRepo } from "./fixture.mjs";
import { APP_FILE, SCENARIOS } from "./scenarios.mjs";

// skills/learn/evals/sim/ → the plugin's root, whose manifest names it.
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const pluginName = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")).name;
const plugin = { dir: PLUGIN_ROOT, events: join(`.${pluginName}`, "learning-events") };
const MAX_TURNS = 12;
// The simulated user and the grader stay on SIM_MODEL; SIM_AGENT_MODEL varies only the agent under test.
const MODEL = process.env.SIM_MODEL || "sonnet";
const AGENT_MODEL = process.env.SIM_AGENT_MODEL || MODEL;

const [scenarioName, outDir] = process.argv.slice(2);
const scenario = SCENARIOS[scenarioName];
if (!scenario || !outDir) {
  console.error(`usage: node run.mjs <scenario> <outDir>\nscenarios: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

// The prompt goes on stdin: --tools takes a list and would swallow a trailing argument.
const claude = (args, prompt, cwd, timeoutMs, env = process.env) => {
  const result = spawnSync("claude", ["-p", "--output-format", "json", "--setting-sources", "project", ...args], {
    cwd,
    input: prompt,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { is_error: true, result: `claude failed (status ${result.status}): ${(result.stderr || result.stdout || "").slice(0, 2000)}` };
  }
};

// RECHECK=1 re-runs only the checks on a finished session in outDir.
const previous = process.env.RECHECK ? JSON.parse(readFileSync(join(outDir, "result.json"), "utf8")) : null;
const repo = previous?.repo ?? realpathSync(mkdtempSync(join(tmpdir(), "learn-sim-repo-")));
const simCwd = realpathSync(mkdtempSync(join(tmpdir(), "learn-sim-user-")));
if (!previous) createRepo(repo, scenario.files);

// Every scenario runs inside a fake yok run, since learn works only in one: a private yok home whose registry names the run, the
// run's folder with its workflow and event log, and a `yok` on PATH that runs this checkout's CLI.
// The event log gets workflow.started, naming the session, once the first turn gives its id.
const RUN = { id: "learn-sim-run", name: "sim" };
const runDir = join(repo, ".yok", RUN.name);
const yokHome = join(simCwd, "yok-home");
const yokBin = join(simCwd, "bin");
const writeRegistry = (sessions) =>
  writeFileSync(
    join(yokHome, "registry.json"),
    JSON.stringify({
      version: 1,
      runs: {
        [RUN.id]: {
          id: RUN.id, workflow: "task", workflowPath: join(PLUGIN_ROOT, "workflows", "task.yaml"), inputs: {},
          cwd: repo, sessions, name: RUN.name, terminal: null, config: null, tiers: null, createdAt: new Date().toISOString(),
        },
      },
    }),
  );
const startRun = (id) => {
  writeRegistry([{ agent: "claude", sessionId: id }]);
  const started = {
    schemaVersion: 1, seq: 1, id: "sim-started", ts: new Date().toISOString(), type: "workflow.started", source: "sim", runId: RUN.id,
    payload: { workflow: "task", inputs: {}, activeSessions: [{ agent: "claude", sessionId: id }] },
  };
  writeFileSync(join(runDir, "event.jsonl"), `${JSON.stringify(started)}\n`);
};
// An afterRun scenario starts once the run's PR is up while retro still runs: state.json has the
// `pr` stage completed and the run still running, the repo
// has a remote to push to, and the session gets yok's offer-learn Stop hook, as `yok run` installs it.
const finishRun = () => {
  const at = new Date().toISOString();
  const state = {
    schemaVersion: 1, lastEventSeq: 1, runId: RUN.id, runName: RUN.name, runDir, version: "2.0.0",
    workflow: { name: "task", path: "workflow.yaml" }, input: {}, scope: null, startedAt: at, completedAt: null, status: "running",
    workspace: { type: "mono", path: repo, repositories: { shop: { path: repo, git: { branch: "feat/invoice-id", baseBranch: "main", startSha: "init" } } } },
    nodeRuns: {
      pr: { nodeRunId: "pr", nodeType: "agent", status: "completed", startedAt: at, completedAt: at, artifacts: [] },
      retro: { nodeRunId: "retro", nodeType: "agent", status: "running", startedAt: at, completedAt: null, artifacts: [] },
    },
    activeSessions: [], tiers: null, eventHandlers: {}, subscribers: {}, config: { path: null, root: repo },
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
  const remote = join(simCwd, "origin.git");
  spawnSync("git", ["init", "-q", "--bare", remote]);
  spawnSync("git", ["remote", "add", "origin", remote], { cwd: repo });
  spawnSync("git", ["checkout", "-qb", "feat/invoice-id"], { cwd: repo });
  spawnSync("git", ["push", "-qu", "origin", "feat/invoice-id"], { cwd: repo });
};
if (!previous) {
  mkdirSync(runDir, { recursive: true });
  mkdirSync(yokHome, { recursive: true });
  mkdirSync(yokBin, { recursive: true });
  writeFileSync(join(runDir, "workflow.yaml"), readFileSync(join(PLUGIN_ROOT, "workflows", "task.yaml")));
  writeFileSync(join(yokBin, "yok"), `#!/bin/sh\nexec bun ${join(PLUGIN_ROOT, "packages", "cli", "src", "index.ts")} "$@"\n`, { mode: 0o755 });
  writeRegistry([]);
  if (scenario.afterRun) finishRun();
}
const hookSettings = scenario.afterRun
  ? ["--settings", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `${join(yokBin, "yok")} orchestrate hook stop --agent claude --handler offer-learn`, timeout: 30 }] }] } })]
  : [];
// What the viewer does with a comment: store it in the run's comments.json and type the same
// [review] message the server delivers (deliveryMessage in packages/core/src/comments.ts).
// The simulated user sometimes writes a chat line before the comment; the viewer's message goes
// first, as the server would deliver it, and the chat line follows.
const COMMENT = /COMMENT:\s*"([^"]+)"\s*=>\s*([\s\S]+)$/;
const deliverComment = (said) => {
  const match = said.match(COMMENT);
  if (!match) return said;
  const [, quote, text] = match;
  const chat = said.slice(0, match.index).trim();
  const file = "artifacts/plan.md";
  const commentsPath = join(runDir, "comments.json");
  const stored = existsSync(commentsPath) ? JSON.parse(readFileSync(commentsPath, "utf8")) : { version: 1, comments: [] };
  const id = `c${stored.comments.length + 1}`;
  const planPath = join(runDir, file);
  const line = existsSync(planPath) ? readFileSync(planPath, "utf8").split("\n").findIndex((l) => l.includes(quote)) + 1 : 0;
  const at = new Date().toISOString();
  stored.comments.push({
    id, file, kind: "comment", text: text.trim(), status: "delivered", createdAt: at, deliveredAt: at,
    anchor: { quote, before: "", after: "", ...(line > 0 ? { lines: [line, line] } : {}) },
    thread: [{ by: "user", text: text.trim(), at }],
  });
  writeFileSync(commentsPath, JSON.stringify(stored, null, 2));
  return [
    "[review] 1 new comment from the viewer:",
    `${id} · ${file}${line > 0 ? `:${line}` : ""} on "${quote}"\n  ${text.trim()}`,
    `Reply to each: yok orchestrate comments reply --run ${RUN.name} --id ID --status answered|changed|declined --text -`,
    ...(chat ? ["", chat] : []),
  ].join("\n");
};

const agentEnv = { ...process.env, PATH: `${yokBin}:${process.env.PATH}`, YOK_HOME: yokHome, YOK_RUN_ID: RUN.id };

// --- the simulated user ------------------------------------------------------------------------
const SPEAKER = { user: "YOU", agent: "AGENT", stage: "PIPELINE (starts the learn stage, not you)" };
const clip = (text, max = 6000) => (text.length > max ? `…${text.slice(-max)}` : text);

const simulatedUserPrompt = (conversation) => `You are playing the user in a conversation with an AI coding agent working in your repo. Stay in character as a busy, friendly developer. Write only the next message you would type: no quotes, no labels, no narration.

The task you want done: ${scenario.task}

What you know about this repo (the agent does not know this unless you tell it): ${scenario.knowledge}

How you behave, in order:
${scenario.behaviour.map((line, index) => `${index + 1}. ${line}`).join("\n")}

React to what the agent actually said. If it asks you something, answer it from what you know above. Never invent facts: no paths, repo names, URLs, versions or access details you were not given. If the agent needs something you don't know (another repo, credentials, a release), say you'll handle that part yourself and ask it to finish the rest. Keep messages short, like a real person typing. If nothing is left to do per the steps above, reply exactly DONE.

Conversation so far:
${conversation.length === 0 ? "(nothing yet; write your first message)" : conversation.map((turn) => `${SPEAKER[turn.role]}: ${clip(turn.text)}`).join("\n\n")}

Your next message:`;

const nextUserMessage = (conversation) => {
  const reply = claude(["--model", MODEL, "--tools", ""], simulatedUserPrompt(conversation), simCwd, 5 * 60_000);
  return (reply.result ?? "").trim().replace(/^["']|["']$/g, "");
};

// The session's records, from Claude Code's own transcript file.
const transcriptPath = (id) => {
  const projects = join(homedir(), ".claude", "projects");
  return readdirSync(projects).map((dir) => join(projects, dir, `${id}.jsonl`)).find(existsSync) ?? null;
};
const readRecords = (id) => {
  const path = transcriptPath(id);
  return path
    ? readFileSync(path, "utf8").split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      })
    : [];
};
const recordText = (record) => {
  const content = record?.message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((block) => block.text ?? JSON.stringify(block.input ?? "")).join("\n") : "";
};
// Everything the agent wrote since `sent`, as a person at the terminal sees it. `claude -p` prints
// only the last message, which loses the reply before a Stop hook sent the agent back. A message
// not found as typed (a slash command is stored differently) gives "", and the caller falls back.
const agentTextSince = (id, sent) => {
  const records = readRecords(id);
  const start = records.findLastIndex((record) => record.type === "user" && recordText(record).trim() === sent.trim());
  if (start === -1) return "";
  return records.slice(start + 1)
    .filter((record) => record.type === "assistant" && Array.isArray(record.message?.content))
    .flatMap((record) => record.message.content.filter((block) => block.type === "text").map((block) => block.text.trim()))
    .filter(Boolean)
    .join("\n\n");
};

// --- the agent ---------------------------------------------------------------------------------
const agentTurn = (message, sessionId, firstId) =>
  claude(
    [
      "--plugin-dir", plugin.dir,
      "--permission-mode", "bypassPermissions",
      "--model", AGENT_MODEL,
      ...(sessionId ? ["--resume", sessionId] : firstId ? ["--session-id", firstId] : []),
      ...hookSettings,
    ],
    message,
    repo,
    20 * 60_000,
    agentEnv,
  );

// An auto or stage scenario has the learn stage: once the user is done, the pipeline starts it in
// the same session, and the user answers its questions.
const STAGE_PROMPT = `Run the ${pluginName}:learn skill now as the pipeline's learn stage (trigger auto). This session is inside the yok run $YOK_RUN_ID; there is no done command to call.`;

const conversation = previous?.conversation ?? [];
let sessionId = previous?.sessionId ?? null;
// After the run there is no stage: learn starts only when the user takes the offer.
const runsStage = (scenario.auto || scenario.stage) && !scenario.afterRun;
// The run must name the session before its first turn ends, for the Stop hook to find the run.
const firstId = scenario.afterRun && !previous ? randomUUID() : null;
if (firstId) startRun(firstId);
let stageStarted = false;
for (let turn = 0; !previous && turn < MAX_TURNS; turn += 1) {
  const said = nextUserMessage(conversation);
  const done = !said || said === "DONE" || said.endsWith("\nDONE");
  const startStage = done && runsStage && !stageStarted;
  if (done && !startStage) break;
  stageStarted ||= startStage;
  const sent = done ? STAGE_PROMPT : deliverComment(said.replace(/^\/learn\b/, `/${pluginName}:learn`));
  conversation.push({ role: done ? "stage" : "user", text: sent });
  const reply = agentTurn(sent, sessionId, firstId);
  if (!firstId && !sessionId && reply.session_id) startRun(reply.session_id);
  sessionId = reply.session_id ?? sessionId;
  const text = (sessionId && agentTextSince(sessionId, sent)) || reply.result || "(no reply)";
  conversation.push({ role: "agent", text, error: reply.is_error === true });
  if (reply.is_error && !reply.session_id) break;
}

// --- what happened -----------------------------------------------------------------------------
const transcript = sessionId ? readRecords(sessionId) : [];

const eventsDir = join(repo, plugin.events);
const events = existsSync(eventsDir)
  ? readdirSync(eventsDir).flatMap((file) =>
      readFileSync(join(eventsDir, file), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    )
  : [];
const learningsDir = join(repo, "docs", "learnings");
const learnings = existsSync(learningsDir)
  ? Object.fromEntries(readdirSync(learningsDir).map((file) => [file, readFileSync(join(learningsDir, file), "utf8")]))
  : {};
const changedFiles = spawnSync("git", ["status", "--porcelain", "-uall"], { cwd: repo, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);

// What the agent wrote to files during the session: Edit/Write calls, and shell commands that
// name a file (agents often write with heredocs or scripts).
const writeOf = (block) => {
  if (block.type !== "tool_use") return [];
  const { file_path: filePath, content, new_string: newString, command } = block.input ?? {};
  if (filePath) return [{ file: filePath, text: [content, newString].filter(Boolean).join("\n") }];
  // Only shell commands that write, and only to their target: a redirect or tee target, an in-place
  // sed, or a path a script opens for writing. A path merely mentioned in the written text is not one.
  if (typeof command !== "string") return [];
  const targets = [
    ...command.matchAll(/(?:^|[^2&<])>{1,2}\s*["']?([\w./-]+)/g),
    ...command.matchAll(/\btee\s+(?:-a\s+)?["']?([\w./-]+)/g),
    ...command.matchAll(/sed -i(?:\s+''|\s+"")?\s+(?:-e\s+)?(?:'[^']*'|"[^"]*")\s+["']?([\w./-]+)/g),
    ...command.matchAll(/(?:writeFileSync|open)\(\s*["']([\w./-]+)["']/g),
    ...command.matchAll(/^p\s*=\s*["']([\w./-]+)["']/gm),
  ].map((match) => match[1]);
  // A command that starts with `cd DIR &&` writes relative to DIR.
  const dir = command.match(/^\s*cd\s+["']?([\w./-]+)["']?\s*&&/)?.[1];
  const resolved = targets.map((file) => (dir && !file.startsWith("/") ? `${dir}/${file}` : file));
  return [...new Set(resolved)].map((file) => ({ file, text: command }));
};
const writes = transcript.flatMap((record) => (Array.isArray(record.message?.content) ? record.message.content : []).flatMap(writeOf));

// Every shell command the agent ran, for mistakes that are commands rather than writes (npm install).
const commands = transcript.flatMap((record) =>
  (Array.isArray(record.message?.content) ? record.message.content : [])
    .filter((block) => block.type === "tool_use" && typeof block.input?.command === "string")
    .map((block) => block.input.command),
);
const mistakeFiles = scenario.mistake(writes, commands, conversation);
// After the run, the offer needs a push of review changes on top of the run's own first push.
const pushes = commands.filter((command) => /(?:^|[\s;&|(])git\s+(?:-[Cc]\s+\S+\s+|-\S+\s+)*push\b/.test(command)).length;
const expected = scenario.afterRun && pushes < 2
  ? { notExercised: "the agent pushed only once, so there was no review push to offer learn after" }
  : scenario.expect(mistakeFiles.length > 0);
const userMessages = conversation.filter((turn) => turn.role === "user").map((turn) => turn.text.trim());
const addedLearningFiles = () => changedFiles.filter((line) => line.startsWith("??") && /docs\/learnings\/(?!index\.md)/.test(line));

const readRunEvents = () =>
  existsSync(join(runDir, "event.jsonl"))
    ? readFileSync(join(runDir, "event.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];

// --- checks ------------------------------------------------------------------------------------
const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });

check("session ran", sessionId !== null && transcript.length > 0, sessionId ?? "no session");
// Where in the transcript the skill started: the user's /learn, or the agent's own Skill call.
const skillStart = transcript.findIndex((record) =>
  (record.type === "user" && recordText(record).trim().startsWith(`/${pluginName}:learn`)) ||
  (Array.isArray(record.message?.content) &&
    record.message.content.some((block) => block.type === "tool_use" && block.name === "Skill" && /(^|:)learn$/.test(block.input?.skill ?? ""))),
);
const typedLearn = userMessages.some((text) => text.startsWith(`/${pluginName}:learn`));
if (scenario.afterRun) {
  check("user never typed /learn", !typedLearn);
  // Each offer comes back as hook feedback; its learn pass may start only after the user's answer.
  const isOffer = (record) => record.type === "user" && recordText(record).includes("You pushed changes after the run's PR was created");
  const isTyped = (record) => record.type === "user" && userMessages.includes(recordText(record).trim());
  const isLearn = (record) =>
    (Array.isArray(record.message?.content) ? record.message.content : []).some((block) => block.type === "tool_use" && block.name === "Skill" && /(^|:)learn$/.test(block.input?.skill ?? ""));
  const learnStarts = transcript.flatMap((record, index) => (isLearn(record) ? [index] : []));
  const askedFirst = learnStarts.every((start) => {
    const offer = transcript.findLastIndex((record, index) => index < start && isOffer(record));
    return offer !== -1 && transcript.slice(offer + 1, start).some(isTyped);
  });
  check(
    mistakeFiles.length > 0 ? "learn ran, and each pass only after the user answered an offer" : "learn never ran",
    mistakeFiles.length > 0 ? learnStarts.length > 0 && askedFirst : learnStarts.length === 0,
    `learn at records ${learnStarts.join(", ")}`,
  );
  // yok's Stop hook offers on a push once the PR stage is done, when the user typed something
  // since the last learning session. The agent asks only when that corrected it: not after the
  // first push (nothing corrected yet), yes after the review fix's push. The push of just the
  // learning file comes with nothing typed since learn's mark, so it gets no question.
  const offers = transcript.flatMap((record, index) => (isOffer(record) ? [index] : []));
  const secondTyped = transcript.findIndex((record, index) => isTyped(record) && transcript.slice(0, index).some(isTyped));
  check("the first push (the run's own PR) was offered too", offers.length > 0 && (secondTyped === -1 || offers[0] < secondTyped), `offers at records ${offers.join(", ")}`);
  const asked = offers.map((offer) => {
    const next = transcript.findIndex((record, index) => index > offer && isTyped(record));
    return transcript.slice(offer + 1, next === -1 ? undefined : next).some((record) =>
      record.type === "assistant" && /learning session/i.test(recordText(record)) && recordText(record).includes("?"));
  });
  check("did not ask after the first push, with nothing corrected yet", asked[0] === false, `asked per offer: ${asked.join(", ")}`);
  // When it does not ask, its whole reply to the offer is the one line the offer gives it.
  const replies = offers.map((offer) => {
    const next = transcript.findIndex((record, index) => index > offer && isTyped(record));
    return transcript.slice(offer + 1, next === -1 ? undefined : next)
      .filter((record) => record.type === "assistant").map(recordText).join(" ").trim();
  });
  const notQuiet = replies.filter((reply, i) => !asked[i] && !/^No new learnings from your messages\.?$/.test(reply));
  check("when it does not ask, it replies only \"No new learnings from your messages\"", notQuiet.length === 0, notQuiet.join(" | ").slice(0, 300));
  if (mistakeFiles.length > 0) {
    check("asked after the review fix's push", asked.slice(1).includes(true), `asked per offer: ${asked.join(", ")}`);
    const lastLearn = learnStarts.at(-1) ?? Number.POSITIVE_INFINITY;
    check("did not ask again after the learning session", asked.every((ask, i) => !ask || offers[i] < lastLearn), `offers at records ${offers.join(", ")}, learn at ${lastLearn}`);
  } else {
    check("never asked: nothing typed was a correction", !asked.includes(true), `asked per offer: ${asked.join(", ")}`);
  }
} else if (scenario.auto) {
  check("user never typed /learn", !typedLearn);
  if (!expected.none) check("the learn stage ran", skillStart !== -1);
} else if (!expected.none) {
  check("learn ran", typedLearn || skillStart !== -1);
}

const eventChecks = (event, label) => {
  const statuses = [expected.status].flat();
  check(`${label}status is ${statuses.join(" or ")}`, statuses.includes(event.status), event.status);
  const triggers = scenario.auto || scenario.afterRun ? ["auto"] : ["manual", "auto"];
  check(`${label}trigger is ${triggers.join(" or ")}`, triggers.includes(event.trigger), event.trigger);
  if (event.trigger === "auto") {
    // The proposal must wait for the corrected work: no app edits between logging the learning and
    // the user's next message (work the user asks for afterwards is fine).
    const isAppWrite = (record) =>
      (Array.isArray(record.message?.content) ? record.message.content : []).flatMap(writeOf).some((write) => APP_FILE.test(write.file));
    const logged = transcript.findIndex((record) =>
      (Array.isArray(record.message?.content) ? record.message.content : []).some((block) => block.type === "tool_use" && /log-learning-event/.test(block.input?.command ?? "")),
    );
    const nextUser = transcript.findIndex((record, index) => index > logged && record.type === "user" && typeof record.message?.content === "string");
    const lateWrite = transcript.slice(logged + 1, nextUser === -1 ? undefined : nextUser).findIndex(isAppWrite);
    check(`${label}proposed only after the corrected work was done`, logged !== -1 && lateWrite === -1, `logged at record ${logged}${lateWrite === -1 ? "" : `, app edited ${lateWrite + 1} records later in the same turn`}`);
  }
  check(`${label}skillVersion is ${pluginName}@…`, event.skillVersion?.startsWith(`${pluginName}@`), event.skillVersion);
  if (event.status === "edited") check(`${label}finalLearning filled`, Boolean(event.finalLearning));
  if (expected.picked) check(`${label}optionUserPicked is ${expected.picked}`, event.optionUserPicked === expected.picked, event.optionUserPicked);

  const toRecord = transcript.find((record) => record.uuid === event.evidenceToMessage);
  const fromRecord = transcript.find((record) => record.uuid === event.evidenceFromMessage);
  check(`${label}evidenceTo is a message in the transcript`, toRecord, event.evidenceToMessage);
  // A rule the user stated with nothing corrected has no mistake to point at.
  const fromOptional = scenario.ruleInLearn && !event.evidenceFromMessage;
  check(`${label}evidenceFrom is a message in the transcript`, fromOptional || fromRecord, event.evidenceFromMessage);
  const toText = recordText(toRecord).trim();
  // When the user typed the rule with /learn, that message is the evidence.
  // A /learn that carries the rule is the user's own words too; a bare /learn is not evidence.
  const learnWithRule = /<command-args>\s*\S/.test(toText);
  check(
    `${label}evidenceTo is something the user typed (a bare /learn does not count)`,
    toRecord?.type === "user" && (userMessages.some((text) => text === toText) || learnWithRule),
    toText.slice(0, 200),
  );
  const fromIndex = transcript.indexOf(fromRecord);
  const toIndex = transcript.indexOf(toRecord);
  check(`${label}evidenceFrom comes before evidenceTo`, fromOptional || (fromIndex !== -1 && toIndex !== -1 && fromIndex <= toIndex));
  if (expected.fromViewer) {
    check(`${label}evidenceTo is the viewer's [review] message`, toText.startsWith("[review]"), toText.slice(0, 120));
  }
  if (expected.options) {
    const count = event.optionsShown?.length ?? 0;
    check(`${label}offered ${expected.options.label}`, expected.options.test(count), `${count} option(s): ${JSON.stringify(event.optionsShown)}`);
  }

  if (event.outcome === "rejected") {
    check(`${label}rejection reason logged`, Boolean(event.rejectionReason?.trim()), event.rejectionReason);
    check(`${label}no learning file written`, addedLearningFiles().length === 0, addedLearningFiles().join(", "));
    return;
  }
  if (event.outcome === "lint") {
    check(`${label}learningFile is the lint config`, event.learningFile === expected.learningFile, event.learningFile);
    check(`${label}lint config changed`, changedFiles.some((line) => line.endsWith(expected.learningFile)), changedFiles.join(", "));
    check(`${label}no learning file written`, addedLearningFiles().length === 0, addedLearningFiles().join(", "));
    return;
  }
  const file = event.learningFile?.split("/").pop();
  const learning = learnings[file];
  check(`${label}learning file exists`, Boolean(learning), event.learningFile);
  if (learning) {
    check(`${label}learning has frontmatter, Occurrences and Stale when`, /^---\n[\s\S]*signal:[\s\S]*paths:[\s\S]*strength:[\s\S]*\n---/.test(learning) && learning.includes("**Occurrences:**") && learning.includes("**Stale when:**"));
    check(`${label}index.md links it`, (learnings["index.md"] ?? "").includes(`(${file})`));
  }
  if (expected.learningFile) {
    check(`${label}points at the existing learning`, event.learningFile === expected.learningFile, event.learningFile);
    check(`${label}existing learning got a second occurrence`, (learning?.match(/^- \d{4}-\d{2}-\d{2} ·/gm) ?? []).length >= 2);
    check(`${label}no duplicate learning file`, addedLearningFiles().length === 0, addedLearningFiles().join(", "));
  }
  if (expected.replaces) {
    const old = expected.replaces.split("/").pop();
    check(`${label}replaces names the old learning`, event.replaces === expected.replaces, event.replaces);
    check(`${label}old learning file deleted`, !(old in learnings));
    check(`${label}old learning's index line removed`, !(learnings["index.md"] ?? "").includes(`(${old})`));
  }
};

// Every learn pass must find the run itself and leave its mark, so a later /learn starts after it
// instead of reading the whole session again. A scenario where learn never ran has no pass.
if (typedLearn || skillStart !== -1) {
  const runEvents = readRunEvents();
  // After the run, each offer the user takes is a pass, and they may decline some.
  const offers = runEvents.filter((event) => event.type === "learning.offered").length;
  const passes = scenario.afterRun ? 1 : (scenario.passes ?? 1);
  // With $YOK_RUN_ID set the script lists the run (from the last mark) whatever the arguments.
  const listCalls = commands.filter((command) => /learn\.candidates|scripts\/candidates\.ts/.test(command));
  // A rule the user stated with /learn is the only candidate, so nothing is listed.
  if (!scenario.ruleInLearn) check("candidates listed for each pass", listCalls.length >= passes, listCalls.join(" | ").slice(0, 300));
  const marks = runEvents.filter((event) => event.type === "learning.reviewed").length;
  const marksOk = scenario.afterRun ? marks >= 1 && marks <= offers : marks === passes;
  check(scenario.afterRun ? `each pass left a learning.reviewed mark (1 to ${offers})` : `each pass left a learning.reviewed mark (${passes})`, marksOk, `${marks} mark(s)`);
  const triggers = [...new Set(events.map((event) => event.trigger))];
  if (passes > 1 && events.length > 1) check("the stage logged auto and /learn logged manual", triggers.includes("auto") && triggers.includes("manual"), triggers.join(", "));
}

// A proposal the user rejected, where none was expected, is a false positive the skill recorded,
// not a broken pipeline; it is reported apart from passes and failures.
const falsePositive = expected.none && events.length > 0 && events.every((event) => event.status === "rejected" && event.rejectionReason);
if (expected.notExercised) {
  // Reported apart from passes and failures: the scenario's setup did not happen.
} else if (expected.none) {
  check(falsePositive ? "no event logged (false positive: proposed, user rejected, reason logged)" : "no event logged", events.length === 0 || falsePositive, `${events.length} event(s)`);
  check("no learning written", addedLearningFiles().length === 0, addedLearningFiles().join(", "));
} else {
  const count = typeof expected.count === "function" ? expected.count(mistakeFiles) : (expected.count ?? 1);
  const matching = events.filter((event) => event.outcome === expected.outcome);
  check(`${count} event(s), outcome ${expected.outcome}`, events.length === count && matching.length === count, `${events.length} event(s): ${events.map((e) => `${e.outcome}/${e.status}`).join(", ")}`);
  matching.forEach((event, index) => eventChecks(event, count > 1 ? `#${index + 1} ` : ""));
  if (count > 1) {
    const ends = new Set(matching.map((event) => event.evidenceToMessage));
    check("each event points at a different correction", ends.size === matching.length);
  }
}

// The lesson itself is judged by a model: wording varies, the meaning must not.
if (expected.lesson) {
  const event = events.find((candidate) => candidate.outcome === expected.outcome);
  const learning = event ? learnings[event.learningFile?.split("/").pop()] : null;
  const verdict = claude(
    ["--model", MODEL, "--tools", ""],
    `You grade whether a written learning says the intended lesson. Reply with JSON only: {"pass": true|false, "reason": "<one sentence>"}.

Intended lesson: ${expected.lesson}

Options the agent offered: ${JSON.stringify(event?.optionsShown ?? [])}
Saved learning file:
${learning ?? "(none)"}

Pass if the saved learning tells a future agent the same thing as the intended lesson. Wording, examples and how broadly it is phrased may differ; fail only if the meaning differs or the lesson is missing.`,
    simCwd,
    5 * 60_000,
  );
  try {
    const parsed = JSON.parse((verdict.result ?? "").replace(/^```json\s*|```$/g, "").trim());
    check("learning says the intended lesson (graded)", parsed.pass, parsed.reason);
  } catch {
    check("learning says the intended lesson (graded)", false, `grader reply unreadable: ${verdict.result}`);
  }
}

const result = {
  plugin: pluginName,
  scenario: scenarioName,
  source: scenario.source,
  repo,
  sessionId,
  transcript: sessionId ? transcriptPath(sessionId) : null,
  conversation,
  mistakeMade: mistakeFiles.length > 0,
  mistakeFiles,
  expected,
  passed: checks.every((entry) => entry.pass),
  falsePositive,
  notExercised: expected.notExercised ?? null,
  checks,
  events,
  learnings,
  changedFiles,
};
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
writeFileSync(
  join(outDir, "conversation.md"),
  conversation.map((turn) => `### ${{ user: "User (simulated)", agent: "Agent", stage: "Pipeline" }[turn.role]}${turn.error ? " (error)" : ""}\n\n${turn.text}\n`).join("\n"),
);
const verdict = expected.notExercised ? "NOT EXERCISED" : result.passed ? (falsePositive ? "FALSE POSITIVE" : "PASS") : "FAIL";
console.log(`${pluginName} ${scenarioName}: ${verdict} (mistake made: ${result.mistakeMade})`);
for (const entry of checks) console.log(`  ${entry.pass ? "✓" : "✗"} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
