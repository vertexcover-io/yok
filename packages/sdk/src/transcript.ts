// Reading a finished or running run after the fact: its events, the Claude Code sessions it used,
// and what the person said in them. Claude Code writes the transcripts, so every field is read
// defensively.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import { type Event, EventSchema, parseJson, SessionRefSchema } from "./contracts.ts";
import { WorkflowStartedEvent } from "./events.ts";
import type { SessionRef } from "./registry.ts";

// One line of a Claude Code transcript.
export type Rec = Readonly<{ line: number; data: Readonly<Record<string, unknown>> }>;

export type Message = Readonly<{
  line: number;
  ts: string;
  // TYPED = the agent was idle; QUEUED = typed while the agent worked
  kind: "TYPED" | "QUEUED";
  text: string;
}>;

// Text that lands where a human message would but nobody typed: client markers, machine
// notifications and a sub-agent's hand-back. A slash command the person typed starts with
// `<command-message>` and is a real message, so that prefix is not here.
const WRAPPER_PREFIXES = [
  "[Request interrupted",
  "<task-notification",
  "<agent-message",
  "<command-name",
  "<local-command",
  "<system-reminder",
  "Caveat:",
  "Base directory for this skill",
];

type Data = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Data =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOf = (value: unknown): string => (typeof value === "string" ? value : "");

type JsonLine = Readonly<{ line: number; value: unknown }>;

// Every line of a JSON-lines file that parses, with its 1-based number. The number is the citation.
const readJsonLines = (path: string): readonly JsonLine[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .flatMap((text, i) => {
      const parsed = parseJson(text);
      return parsed.ok ? [{ line: i + 1, value: parsed.value }] : [];
    });

export const loadRecords = (path: string): readonly Rec[] =>
  readJsonLines(path).flatMap(({ line, value }) =>
    isRecord(value) ? [{ line, data: value }] : [],
  );

const contentOf = (data: Data): unknown =>
  isRecord(data.message) ? data.message.content : undefined;

const blocksOf = (rec: Rec, kind: string): readonly Data[] => {
  const content = contentOf(rec.data);
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Data => isRecord(b) && b.type === kind);
};

// Flattens a content value to its plain text.
const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is Data => isRecord(b) && b.type === "text")
    .map((b) => stringOf(b.text))
    .join("\n");
};

export const bodyOf = (rec: Rec): string => textOf(contentOf(rec.data));

const timestampOf = (rec: Rec): string => stringOf(rec.data.timestamp);

// True for text that only looks like a human message. `[Request interrupted by user]` is a marker
// the client writes; interrupts are read from the incident flags instead.
const isWrapper = (text: string): boolean =>
  WRAPPER_PREFIXES.some((prefix) => text.startsWith(prefix));

const queuedText = (rec: Rec): string | undefined => {
  const { data } = rec;
  const attachment = data.attachment;
  if (
    data.type === "attachment" &&
    isRecord(attachment) &&
    attachment.type === "queued_command" &&
    isRecord(attachment.origin) &&
    attachment.origin.kind === "human"
  ) {
    return stringOf(attachment.prompt);
  }
  const queueOp = data.operation === "enqueue" || data.operation === "remove";
  if (data.type === "queue-operation" && queueOp && typeof data.content === "string") {
    return data.content;
  }
  return undefined;
};

const typedTexts = (rec: Rec): readonly string[] => {
  const { data } = rec;
  if (data.type !== "user" || data.isMeta || blocksOf(rec, "tool_result").length > 0) return [];
  const content = contentOf(data);
  if (typeof content === "string") return [content];
  return blocksOf(rec, "text").map((b) => stringOf(b.text));
};

type Candidate = Readonly<{ line: number; ts: string; kind: Message["kind"]; raw: string }>;

const compareMessages = (a: Message, b: Message): number =>
  a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.line - b.line;

// A message present in both places keeps the QUEUED label, since mid-action is the fact worth
// keeping: corrections live there. The first 200 characters identify a message.
const dedupe = (candidates: readonly Candidate[]): readonly Message[] => {
  const seen = new Set<string>();
  const kept: Message[] = [];
  for (const { line, ts, kind, raw } of candidates) {
    const text = raw.trim();
    if (!text || isWrapper(text) || seen.has(text.slice(0, 200))) continue;
    seen.add(text.slice(0, 200));
    kept.push({ line, ts, kind, text });
  }
  return kept;
};

// Every message the human sent, from both places they land: a plain `user` record while the
// agent was idle, an `attachment` or `queue-operation` record while it worked.
export const humanMessages = (recs: readonly Rec[]): readonly Message[] => {
  const queued = recs.flatMap((rec): readonly Candidate[] => {
    const raw = queuedText(rec);
    return raw === undefined ? [] : [{ line: rec.line, ts: timestampOf(rec), kind: "QUEUED", raw }];
  });
  const typed = recs.flatMap((rec): readonly Candidate[] =>
    typedTexts(rec).map((raw) => ({ line: rec.line, ts: timestampOf(rec), kind: "TYPED", raw })),
  );
  return [...dedupe([...queued, ...typed])].sort(compareMessages);
};

export type Call = Readonly<{ line: number; ts: string; name: string; input: unknown }>;

const callOf = (rec: Rec, block: Data): Call => ({
  line: rec.line,
  ts: timestampOf(rec),
  name: stringOf(block.name) || "?",
  input: block.input,
});

const toolUses = (recs: readonly Rec[]): readonly (readonly [Rec, Data])[] =>
  recs
    .filter((rec) => rec.data.type === "assistant")
    .flatMap((rec) => blocksOf(rec, "tool_use").map((block) => [rec, block] as const));

const callIndex = (recs: readonly Rec[]): ReadonlyMap<string, Call> =>
  new Map(toolUses(recs).map(([rec, block]) => [stringOf(block.id), callOf(rec, block)]));

export type Answer = Readonly<{ call: Call | undefined; line: number; ts: string; text: string }>;

// Each AskUserQuestion paired with the answer that came back.
export const answers = (recs: readonly Rec[]): readonly Answer[] => {
  const index = callIndex(recs);
  const asked = (id: string): boolean => index.get(id)?.name === "AskUserQuestion";
  return recs.flatMap((rec) =>
    blocksOf(rec, "tool_result")
      .filter((block) => asked(stringOf(block.tool_use_id)))
      .map((block) => ({
        call: index.get(stringOf(block.tool_use_id)),
        line: rec.line,
        ts: timestampOf(rec),
        text: textOf(block.content),
      })),
  );
};

export const parseTime = (ts: string | undefined): Date | undefined => {
  if (!ts) return undefined;
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

// The slug depends on the folder the session started in, so every project folder is searched.
export const findTranscript = (projectsDir: string, sessionId: string): string | undefined => {
  if (!existsSync(projectsDir)) return undefined;
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(projectsDir, entry.name, `${sessionId}.jsonl`))
    .find((path) => existsSync(path));
};

// A run's event.jsonl, leaving out any event this yok version does not know.
export const readEvents = (path: string): readonly Event[] =>
  readJsonLines(path).flatMap(({ value }) => {
    const parsed = EventSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });

// Hook, agent and session-replaced events all carry the session they came from in their payload.
const SessionPayloadSchema = z.object({ payload: z.object(SessionRefSchema.shape) });

const sessionsOf = (event: Event): readonly SessionRef[] => {
  if (event.type === "workflow.started") {
    return WorkflowStartedEvent.safeParse(event).data?.payload.activeSessions ?? [];
  }
  const carried = SessionPayloadSchema.safeParse(event);
  return carried.success ? [carried.data.payload] : [];
};

// Every session the run used, in order of first appearance: a `context` node that replaces the
// session adds a new id, so a run can have several.
export const readRunSessions = (events: readonly Event[]): readonly SessionRef[] =>
  events
    .flatMap(sessionsOf)
    .filter((s, i, all) => all.findIndex((o) => o.sessionId === s.sessionId) === i);
