// Prints what the user said since the last learn pass, each message with the end of the agent's
// reply before it, for the learn skill to pick corrections from.
//   candidates.ts [--run NAME | --run-id ID]  a yok run's sessions; with neither, $YOK_RUN_ID's
//   candidates.ts --session ID                one session, outside a run
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  answers,
  bodyOf,
  createRegistryReader,
  type Event,
  findTranscript,
  humanMessages,
  loadRecords,
  parseTime,
  type Rec,
  type Result,
  readEvents,
  readRunSessions,
  registryPath,
  requireRun,
  runDirOf,
} from "@yok/sdk";

// Enough to recognise the exchange; a pasted log or a long plan summary is cut.
const USER_CHARS = 500;
const AGENT_CHARS = 300;

export type Exchange = Readonly<{
  ts: string;
  kind: "TYPED" | "QUEUED" | "ANSWER";
  agent: string;
  user: string;
}>;

const head = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n)}…` : text);
const tail = (text: string, n: number): string => (text.length > n ? `…${text.slice(-n)}` : text);

// The time of the last learn pass: everything up to it was already looked at.
export const lastReviewedAt = (events: readonly Event[]): string | undefined =>
  events.findLast((event) => event.type === "learning.reviewed")?.ts;

const agentTexts = (recs: readonly Rec[]): readonly Readonly<{ line: number; text: string }>[] =>
  recs.flatMap((rec) => {
    const text = rec.data.type === "assistant" ? bodyOf(rec).trim() : "";
    return text ? [{ line: rec.line, text }] : [];
  });

// A message with no readable time is kept: showing one too many beats dropping a correction.
const isAfter = (ts: string, since: number | undefined): boolean =>
  since === undefined || (parseTime(ts)?.getTime() ?? Number.POSITIVE_INFINITY) > since;

// The user's messages and answers after `since`, in order, each with the agent text before it.
export const exchanges = (recs: readonly Rec[], since: string | undefined): readonly Exchange[] => {
  const replies = agentTexts(recs);
  const before = (line: number): string =>
    tail(replies.findLast((reply) => reply.line < line)?.text ?? "", AGENT_CHARS);
  const after = parseTime(since)?.getTime();
  const said = [
    ...humanMessages(recs),
    ...answers(recs).map((a) => ({ ...a, kind: "ANSWER" as const })),
  ];
  return said
    .filter((m) => isAfter(m.ts, after))
    .sort((a, b) => a.line - b.line)
    .map((m) => ({
      ts: m.ts,
      kind: m.kind,
      agent: before(m.line),
      user: head(m.text.trim(), USER_CHARS),
    }));
};

const formatExchange = (e: Exchange): string =>
  [`[${e.ts}] ${e.kind}`, ...(e.agent ? [`  agent: ${e.agent}`] : []), `  user:  ${e.user}`].join(
    "\n",
  );

const formatSession = (sessionId: string, list: readonly Exchange[]): string =>
  [`session ${sessionId}`, ...list.map(formatExchange)].join("\n\n");

const readSession = (
  projectsDir: string,
  sessionId: string,
  since: string | undefined,
): readonly Exchange[] | undefined => {
  const path = findTranscript(projectsDir, sessionId);
  return path ? exchanges(loadRecords(path), since) : undefined;
};

const report = (since: string | undefined, blocks: readonly string[]): string => {
  const header = since ? `since ${since} (the last learn pass)` : "since the start";
  return blocks.length === 0 ? `${header}: nothing new was said` : [header, ...blocks].join("\n\n");
};

export const listRun = (options: {
  readonly runDir: string;
  readonly projectsDir: string;
}): Result<string> => {
  const eventsPath = join(options.runDir, "event.jsonl");
  if (!existsSync(eventsPath)) return { ok: false, error: `no event.jsonl in ${options.runDir}` };
  const events = readEvents(eventsPath);
  const since = lastReviewedAt(events);
  const sessions = readRunSessions(events)
    .filter((session) => session.agent === "claude")
    .flatMap(({ sessionId }) => {
      const list = readSession(options.projectsDir, sessionId, since);
      return list && list.length > 0 ? [formatSession(sessionId, list)] : [];
    });
  return { ok: true, value: report(since, sessions) };
};

export const listSession = (options: {
  readonly sessionId: string;
  readonly projectsDir: string;
}): Result<string> => {
  const list = readSession(options.projectsDir, options.sessionId, undefined);
  if (list === undefined) {
    return { ok: false, error: `no transcript for session ${options.sessionId}` };
  }
  return {
    ok: true,
    value: report(undefined, list.length > 0 ? [formatSession(options.sessionId, list)] : []),
  };
};

const findRunDir = async (name?: string, id?: string): Promise<Result<string>> => {
  const run = await requireRun({
    registry: createRegistryReader(registryPath()),
    name,
    id,
    env: process.env,
    cwd: process.cwd(),
  });
  return run.ok ? { ok: true, value: runDirOf(run.value.cwd, run.value.name) } : run;
};

const pick = async (argv: readonly string[]): Promise<Result<string>> => {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      run: { type: "string" },
      "run-id": { type: "string" },
      session: { type: "string" },
      projects: { type: "string" },
    },
  });
  const projectsDir =
    values.projects ??
    join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  // In a run, the run's list is the one that starts after the last pass's mark, so it wins over
  // --session (the agent may pass --session before it has checked $YOK_RUN_ID).
  if (values.session && !process.env.YOK_RUN_ID) {
    return listSession({ sessionId: values.session, projectsDir });
  }
  const runDir = await findRunDir(values.run, values["run-id"]);
  return runDir.ok ? listRun({ runDir: runDir.value, projectsDir }) : runDir;
};

// `yok orchestrate skill run` imports this file and calls main; bun runs it directly outside a run.
export const main = async (argv: readonly string[]): Promise<number> => {
  const result = await pick(argv);
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  console.log(result.value);
  return 0;
};

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
