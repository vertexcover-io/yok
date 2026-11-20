import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as z from "zod";
import {
  type Event,
  type EventHandlerRef,
  type EventHandlerRefs,
  type GitState,
  type Result,
  SlugSchema,
  type State,
  StateSchema,
  type SubscriberRefs,
} from "./contracts.ts";
import { buildEvent, builtInHandlers, type EmitInput, type RunRef } from "./events.ts";
import { loadFunction, parseYaml, readText } from "./files.ts";
import { createGit } from "./git.ts";
import type { SessionRef } from "./registry.ts";
import type { IEventStore, IStorage } from "./repositories.ts";
import { useStorage } from "./storage.ts";
import { triggerSubscribers } from "./subscribers.ts";

export type EventHandler = (state: State, event: Event) => State;
export type EventHandlers = Readonly<Record<string, EventHandler>>;
export type ExtensionHandlers = Readonly<Record<string, readonly EventHandler[]>>;

type Projection = Readonly<{
  state: State;
  events: readonly Event[];
  handlers: EventHandlers;
  extensions?: ExtensionHandlers;
}>;

const applyEvent = (state: State, event: Event, projection: Projection): State => {
  if (event.seq <= state.lastEventSeq) return state;
  const builtIn = projection.handlers[event.type];
  const chain = [...(builtIn ? [builtIn] : []), ...(projection.extensions?.[event.type] ?? [])];
  const handled = chain.reduce((current, handler) => handler(current, event), state);
  const parsed = StateSchema.safeParse({ ...handled, lastEventSeq: event.seq });
  if (!parsed.success) {
    throw new Error(`Event ${event.seq} (${event.type}): ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
};

export const projectEvents = (projection: Projection): State =>
  projection.events.reduce(
    (state, event) => applyEvent(state, event, projection),
    projection.state,
  );

// The run's stored state; null before init.
export const readState = (run: RunRef, storage?: IStorage): Promise<State | null> =>
  useStorage(storage, process.env, (opened) => opened.events(run.id).readState());

// Oldest first.
export const readRunEvents = (run: RunRef, storage?: IStorage): Promise<readonly Event[]> =>
  useStorage(storage, process.env, (opened) => opened.events(run.id).read());

// First linked first; the last is the session working on the run now.
export const readRunSessions = (run: RunRef, storage?: IStorage): Promise<readonly SessionRef[]> =>
  useStorage(
    storage,
    process.env,
    async (opened) => (await opened.runs.findRun(run.id))?.sessions ?? [],
  );

const git = createGit();

export const readGit = async (cwd: string): Promise<GitState> => {
  const [branch, sha, defaultBranch] = await Promise.all([
    git.currentBranch(cwd),
    git.headSha(cwd),
    git.defaultBranch(cwd),
  ]);
  const branchName = branch.ok ? branch.value : "HEAD";
  return {
    branch: branchName,
    startSha: sha.ok ? sha.value : "",
    baseBranch: defaultBranch ?? branchName,
  };
};

// Repository keys in the run's state are slugs, but package names are camelCase and mono repos use their folder name.
export const toRepoId = (name: string): string => {
  const slug = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "repo" : slug;
};

const workflowNameOf = async (runDir: string): Promise<string> => {
  const path = join(runDir, "workflow.yaml");
  const text = await readText(path);
  if (!text.ok) throw new Error(text.error);
  const yaml = parseYaml(text.value, path);
  if (!yaml.ok) throw new Error(yaml.error);
  return z.object({ name: SlugSchema }).parse(yaml.value).name;
};

// A run's first state, built from the run folder: a run folder is CWD/.yok/NAME, holding the
// workflow.yaml init copied in. Writes nothing; init stores it with the run's name. Events then
// fill in the rest (inputs, startedAt).
export const createState = async ({
  runId,
  runDir,
  version,
  eventHandlers,
  subscribers,
  config,
  tiers = null,
  policies,
}: Readonly<{
  runId: string;
  runDir: string;
  version: string;
  eventHandlers: EventHandlerRefs;
  subscribers?: SubscriberRefs;
  config?: State["config"];
  tiers?: State["tiers"];
  policies?: State["policies"];
}>): Promise<State> => {
  const cwd = dirname(dirname(runDir));
  const state: State = {
    schemaVersion: 1,
    lastEventSeq: 0,
    runId,
    runName: basename(runDir),
    runDir,
    version,
    workflow: { name: await workflowNameOf(runDir), path: "workflow.yaml" },
    input: {},
    scope: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: "running",
    workspace: {
      type: "mono",
      path: cwd,
      repositories: { [toRepoId(basename(cwd))]: { path: cwd, git: await readGit(cwd) } },
    },
    nodeRuns: {},
    activeSessions: [],
    tiers,
    ...(policies === undefined ? {} : { policies }),
    eventHandlers,
    subscribers: subscribers ?? {},
    ...(config === undefined ? {} : { config }),
  };
  return state;
};

const loadHandler = async (ref: EventHandlerRef): Promise<Result<EventHandler>> => {
  const loaded = await loadFunction<EventHandler>(ref.module, ref.handler);
  if (loaded.ok) return loaded;
  return {
    ok: false,
    error: `event handler "${ref.handler}" in ${ref.module}: ${loaded.error.message}`,
  };
};

const loadEventHandlers = async (refs: EventHandlerRefs): Promise<Result<ExtensionHandlers>> => {
  const chains = await Promise.all(
    Object.entries(refs).map(
      async ([type, list]) => [type, await Promise.all(list.map(loadHandler))] as const,
    ),
  );
  const errors = chains.flatMap(([, loaded]) => loaded.flatMap((r) => (r.ok ? [] : [r.error])));
  if (errors.length > 0) return { ok: false, error: errors.join("; ") };
  const handlers = chains.map(([type, loaded]) => [
    type,
    loaded.flatMap((r) => (r.ok ? [r.value] : [])),
  ]);
  return { ok: true, value: Object.fromEntries(handlers) };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const fold = (
  state: State | null,
  events: readonly Event[],
  extensions: ExtensionHandlers,
): Result<State | null> => {
  if (state === null) return { ok: true, value: null };
  try {
    return {
      ok: true,
      value: projectEvents({ state, events, handlers: builtInHandlers, extensions }),
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
};

const loadRunHandlers = (state: State | null): Promise<Result<ExtensionHandlers>> =>
  state === null
    ? Promise.resolve({ ok: true, value: {} })
    : loadEventHandlers(state.eventHandlers);

// The run's stored state with any stored event it lags folded in, by the built-in handlers and
// then the run's own; null before init. Writes nothing: every event's write carries its state.
export const syncState = async (storage: IStorage, runId: string): Promise<State | null> => {
  const store = storage.events(runId);
  const [current, events] = await Promise.all([store.readState(), store.read()]);
  const extensions = await loadRunHandlers(current);
  if (!extensions.ok) throw new Error(extensions.error);
  const latest = fold(current, events, extensions.value);
  if (!latest.ok) throw new Error(latest.error);
  return latest.value;
};

type Saved = Readonly<{ event: Event; state: State | null; fresh: boolean }>;

// Each lost race means another writer stored an event, so many short tries let a dozen or more
// writers on one run all land without one waiting long.
const MAX_TRIES = 40;
const RETRY_PAUSE_MS = 10;
const MAX_PAUSE_GROWTH = 5;

// One try against the run as it reads now. "conflict": another writer stored an event since the
// read, so nothing was written. fresh: this try stored the event, rather than finding it stored.
const tryAppend = async (
  store: IEventStore,
  runId: string,
  draft: EmitInput & Readonly<{ id: string }>,
  allowed: (state: State | null) => boolean,
): Promise<Result<Saved> | "conflict"> => {
  const [current, events] = await Promise.all([store.readState(), store.read()]);
  const extensions = await loadRunHandlers(current);
  if (!extensions.ok) return extensions;
  const latest = fold(current, events, extensions.value);
  if (!latest.ok) return { ok: false, error: `state not synchronized: ${latest.error}` };
  if (!allowed(latest.value)) return { ok: false, error: "condition-failed" };
  const stored = events.find((event) => event.id === draft.id);
  if (stored !== undefined) {
    return { ok: true, value: { event: stored, state: latest.value, fresh: false } };
  }
  const event = buildEvent(runId, draft, events.length + 1);
  if (!event.ok) return event;
  // A stored event no handler can apply would stall the run's state for good.
  const next = fold(latest.value, [event.value], extensions.value);
  if (!next.ok) {
    return { ok: false, error: `event not stored, a handler could not apply it: ${next.error}` };
  }
  const appended = await store.append({
    event: event.value,
    state: next.value,
    expectedSeq: events.length,
  });
  if (appended.kind !== "stored") return "conflict";
  return { ok: true, value: { event: event.value, state: next.value, fresh: true } };
};

const appendWithRetries = async (
  store: IEventStore,
  runId: string,
  draft: EmitInput & Readonly<{ id: string }>,
  allowed: (state: State | null) => boolean,
  tries = 1,
): Promise<Result<Saved>> => {
  const tried = await tryAppend(store, runId, draft, allowed);
  if (tried !== "conflict") return tried;
  if (tries === MAX_TRIES) {
    return { ok: false, error: `event not stored: run ${runId} changed during ${MAX_TRIES} tries` };
  }
  // A random pause, longer each try, so writers that lost the same race do not race again in step.
  await sleep(Math.random() * RETRY_PAUSE_MS * Math.min(tries, MAX_PAUSE_GROWTH));
  return appendWithRetries(store, runId, draft, allowed, tries + 1);
};

// Stores an event on the run with the state it leads to, then calls the subscribers that listen
// to it once the write has landed. It hands back that state (null before init), so a caller
// storing many events need not read the run again after each one.
export const appendRunEventIf = async (
  storage: IStorage,
  run: RunRef,
  input: EmitInput,
  allowed: (state: State | null) => boolean,
): Promise<Result<Readonly<{ event: Event; state: State | null }>>> => {
  // The id is fixed before the first try, so a retry finds the event a lost race stored.
  const draft = { ...input, id: input.id ?? crypto.randomUUID() };
  const saved = await appendWithRetries(storage.events(run.id), run.id, draft, allowed).catch(
    (error: unknown) => ({ ok: false as const, error: `event not stored: ${errorMessage(error)}` }),
  );
  if (!saved.ok) return saved;
  const { event, state, fresh } = saved.value;
  if (fresh && state !== null) await triggerSubscribers(storage, run, event, state);
  return { ok: true, value: { event, state } };
};

export const appendRunEvent = (
  storage: IStorage,
  run: RunRef,
  input: EmitInput,
): Promise<Result<Readonly<{ event: Event; state: State | null }>>> =>
  appendRunEventIf(storage, run, input, () => true);

// The event families the engine writes and then trusts: workflow.* moves the run's nodes,
// orchestrate.done counts a node's rejected attempts, and a context node completes on
// hooks.session-start.called. Extension code may record anything else.
const ENGINE_OWNED: readonly (readonly [prefix: string, reason: string])[] = [
  ["workflow.", "is engine-owned; use next, exec, or done for workflow lifecycle"],
  ["orchestrate.", "is written only by the orchestrate script"],
  ["hooks.", "is written only by the agent's hooks"],
  ["subscriber.", "is written only by the run's subscribers"],
  ["policy.", "is written only by the engine and the agent's hooks, as a policy applies"],
];

export const emitRunEvent = async (
  run: RunRef,
  input: EmitInput,
  storage?: IStorage,
): Promise<Result<Event>> => {
  const owned = ENGINE_OWNED.find(([prefix]) => input.type.startsWith(prefix));
  if (owned !== undefined) return { ok: false, error: `${input.type} ${owned[1]}` };
  const appended = await useStorage(storage, process.env, (opened) =>
    appendRunEvent(opened, run, input),
  );
  return appended.ok ? { ok: true, value: appended.value.event } : appended;
};
