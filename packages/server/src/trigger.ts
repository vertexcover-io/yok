import { compileWithProjectConfig, WorkflowError } from "@yok/core";
import type { ILogger } from "@yok/sdk";
import { runDirOf, SlugSchema } from "@yok/sdk";
import { type Fire, isRunLive, type Trigger, type TriggerStore } from "@yok/sdk/internal";
import { Cron } from "croner";
import type { Context } from "hono";
import { Hono } from "hono";
import { errorResponse, jsonBody, queryParams, type Vars } from "./api.ts";
import { isAgentAlive, readStateOrNull } from "./delivery.ts";
import {
  type AddTriggerBody,
  AddTriggerBodySchema,
  type TriggerRef,
  TriggerRefSchema,
} from "./protocol.ts";
import { launchRun, type RunDeps } from "./run.ts";

type Schedule = Readonly<{ cron: string; timezone: string }>;

// A slot more than 6h old is skipped, not fired: a 9am digest is no use at 6pm.
const LATE_AFTER_MS = 6 * 60 * 60 * 1000;

const parseSchedule = ({ cron, timezone }: Schedule): Cron =>
  new Cron(cron, { mode: "5-part", timezone, paused: true });

export const nextSlot = (schedule: Schedule, after: Date): Date => {
  const next = parseSchedule(schedule).nextRun(after);
  // Can't happen for a saved trigger: compile rejects a cron that never fires.
  if (next === null) throw new Error(`cron "${schedule.cron}" has no next run`);
  return next;
};

export type DueSlot = Readonly<{
  slot: Date;
  // the first slot we slept through, or null if none were missed
  missedFrom: Date | null;
  tooLate: boolean;
  next: Date;
}>;

// Null until nextFireAt has passed. After a sleep, only the latest passed slot fires; the
// skipped ones are reported through missedFrom.
export const dueSlot = (
  trigger: Schedule & Readonly<{ nextFireAt: string }>,
  now: Date,
): DueSlot | null => {
  const due = new Date(trigger.nextFireAt);
  if (now < due) return null;
  // previousRuns only finds slots strictly before the time given, ignoring milliseconds. The
  // extra second lets a slot at exactly `now` count; slots are a minute apart, so it can't
  // reach the next one.
  const [latest] = parseSchedule(trigger).previousRuns(1, new Date(now.getTime() + 1000));
  const slot = latest !== undefined && latest > due ? latest : due;
  return {
    slot,
    missedFrom: slot > due ? due : null,
    tooLate: now.getTime() - slot.getTime() > LATE_AFTER_MS,
    next: nextSlot(trigger, now),
  };
};

export type TriggerRouteDeps = RunDeps & Readonly<{ triggers: TriggerStore }>;
export type TriggerDeps = TriggerRouteDeps & Readonly<{ log: ILogger; now: () => Date }>;

type Outcome = Pick<Fire, "status" | "reason" | "runId" | "runName">;

// NAME-YYYYMMDD-HHMMSS in the trigger's timezone. `orchestrate init` refuses a run folder that
// already exists, so every firing needs a new name.
const runNameFor = (trigger: Trigger, slot: Date): string => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: trigger.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(slot)
      .map((part) => [part.type, part.value]),
  );
  return `${trigger.name}-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
};

// A run names itself in its first minute. One still unnamed after 5 minutes has stalled, so it
// no longer blocks the next firing.
const STARTING_MS = 5 * 60 * 1000;

const isLastRunGoing = async (trigger: Trigger, deps: TriggerDeps): Promise<boolean> => {
  const fires = await deps.triggers.readFires(trigger.id, Number.MAX_SAFE_INTEGER);
  const started = fires.findLast((fire) => fire.status === "started");
  if (started?.runId === undefined) return false;
  const run = await deps.registry.findRun(started.runId);
  if (run === undefined || !(await isAgentAlive(run, deps.host))) return false;
  if (run.name === null) {
    return deps.now().getTime() - new Date(started.at).getTime() < STARTING_MS;
  }
  const state = await readStateOrNull(runDirOf(run.cwd, run.name));
  return state === null || isRunLive(state.status);
};

const launchFiring = async (trigger: Trigger, slot: Date, deps: TriggerDeps): Promise<Outcome> => {
  if (await isLastRunGoing(trigger, deps)) {
    return { status: "skipped", reason: "previous run still running" };
  }
  const plan = await compileWithProjectConfig(trigger.workflowPath, trigger.cwd, trigger.config);
  if (plan.trigger === undefined) {
    return { status: "failed", reason: `${trigger.workflowPath} has no trigger block any more` };
  }
  const runName = runNameFor(trigger, slot);
  const launched = await launchRun(
    {
      plan,
      workflowPath: trigger.workflowPath,
      cwd: trigger.cwd,
      config: trigger.config,
      inputs: plan.trigger.inputs,
      name: runName,
      policies: {},
      permissionMode: plan.trigger.permissionMode,
      // `yok trigger rm` may have run while the doctor was checking; don't start a removed trigger.
      register: async (add) => {
        if ((await deps.triggers.find(trigger.cwd, trigger.name))?.id !== trigger.id) {
          return { ok: false, error: "removed" };
        }
        await add();
        return { ok: true, value: null };
      },
    },
    deps,
    deps.log,
  );
  // Only register refuses with a conflict.
  if (!launched.ok && launched.error.code === "conflict") {
    return { status: "skipped", reason: "removed" };
  }
  if (!launched.ok) return { status: "failed", reason: launched.error.message };
  return { status: "started", runId: launched.value.run.id, runName };
};

const describeError = (error: unknown): string => {
  if (error instanceof WorkflowError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
};

const recordFire = async (
  trigger: Trigger,
  slot: Date,
  outcome: Outcome,
  deps: TriggerDeps,
): Promise<Fire> => {
  const fire: Fire = {
    triggerId: trigger.id,
    slot: slot.toISOString(),
    ...outcome,
    at: deps.now().toISOString(),
  };
  await deps.triggers.appendFire(fire);
  deps.log.info({ trigger: trigger.name, cwd: trigger.cwd, ...fire }, `trigger ${fire.status}`);
  return fire;
};

// Never throws: every outcome, an error included, becomes one line in the fire log.
export const fireTrigger = async (
  trigger: Trigger,
  slot: Date,
  deps: TriggerDeps,
): Promise<Fire> => {
  const outcome = await launchFiring(trigger, slot, deps).catch(
    (error: unknown): Outcome => ({ status: "failed", reason: describeError(error) }),
  );
  return recordFire(trigger, slot, outcome, deps);
};

export const tick = async (deps: TriggerDeps): Promise<void> => {
  const now = deps.now();
  for (const trigger of await deps.triggers.list()) {
    const due = dueSlot(trigger, now);
    if (due === null) continue;
    // Move nextFireAt on before firing, so a crash mid-firing can't fire this slot again.
    // False means the trigger was removed or re-added meanwhile: leave it alone.
    if (!(await deps.triggers.setNextFireAt(trigger, due.next.toISOString()))) continue;
    if (due.missedFrom !== null) {
      const reason = `missed: slept through the slots up to ${due.slot.toISOString()}`;
      await recordFire(trigger, due.missedFrom, { status: "skipped", reason }, deps);
    }
    if (due.tooLate) {
      const reason = "too late: more than 6h past its slot";
      await recordFire(trigger, due.slot, { status: "skipped", reason }, deps);
      continue;
    }
    await fireTrigger(trigger, due.slot, deps);
  }
};

// One check every 15s for what is due, rather than a timer per trigger, so slots missed while
// the laptop slept or the server restarted are caught at the next check.
const TICK_MS = 15_000;
let timer: Timer | undefined;
let scheduling = false;
let firing: Promise<unknown> = Promise.resolve();

// A one-slot lock: jobs run one at a time, in order. Ticks and `yok trigger fire` both go
// through it. If two firings overlapped, both could see "no run going" and each start one.
const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
  const done = firing.then(work);
  firing = done.catch(() => undefined);
  return done;
};

// The next tick is scheduled only after this one ends, so a slow tick never stacks up behind
// another (setInterval would).
const tickThenWait = (deps: TriggerDeps): void => {
  void inTurn(() => tick(deps))
    .catch((error: unknown) => deps.log.error({ err: error }, "trigger tick failed"))
    .then(() => {
      if (scheduling) timer = setTimeout(tickThenWait, TICK_MS, deps);
    });
};

export const startScheduler = (deps: TriggerDeps): void => {
  scheduling = true;
  tickThenWait(deps);
};

export const stopScheduler = (): Promise<void> => {
  scheduling = false;
  clearTimeout(timer);
  timer = undefined;
  return firing.then(() => undefined);
};

const LOG_LIMIT = 20;

const addTrigger = async (
  c: Context<{ Variables: Vars }>,
  deps: TriggerRouteDeps,
  { workflowPath, cwd, config }: AddTriggerBody,
) => {
  const plan = await compileWithProjectConfig(workflowPath, cwd, config ?? null).catch(
    (error: unknown) => new Error(describeError(error)),
  );
  if (plan instanceof Error) return errorResponse(c, 400, "bad-request", plan.message);
  if (plan.trigger === undefined) {
    return errorResponse(c, 400, "bad-request", `${workflowPath} has no trigger block`);
  }
  const name = SlugSchema.safeParse(plan.name);
  if (!name.success) {
    return errorResponse(
      c,
      400,
      "bad-request",
      `workflow name "${plan.name}" must be lowercase words joined by - to name a trigger`,
    );
  }
  const schedule = {
    cron: plan.trigger.cron,
    timezone: plan.trigger.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  const saved = await deps.triggers.save({
    ...schedule,
    name: name.data,
    workflowPath,
    cwd,
    config: config ?? null,
    nextFireAt: nextSlot(schedule, new Date()).toISOString(),
  });
  if (!saved.ok) {
    const clash = saved.error;
    return errorResponse(
      c,
      409,
      "conflict",
      `trigger ${clash.name} already runs ${clash.workflowPath} in this repo; run yok trigger rm ${clash.name} first`,
    );
  }
  const trigger = saved.value;
  c.get("log").info({ trigger }, "trigger saved");
  return c.json({ trigger }, 201);
};

const notFound = (c: Context<{ Variables: Vars }>, { cwd, name }: TriggerRef) =>
  errorResponse(c, 404, "not-found", `no trigger named ${name} in ${cwd}`);

// Mounted at /triggers by app.ts. Chained, so each route's input and output types reach AppType.
export const triggerRoutes = (deps: TriggerRouteDeps) =>
  new Hono<{ Variables: Vars }>()
    .post("/", jsonBody(AddTriggerBodySchema), (c) => addTrigger(c, deps, c.req.valid("json")))
    .get("/", async (c) => {
      const triggers = await Promise.all(
        (await deps.triggers.list()).map(async (trigger) => ({
          ...trigger,
          lastFire: (await deps.triggers.readFires(trigger.id, 1))[0] ?? null,
        })),
      );
      return c.json({ triggers }, 200);
    })
    .post("/fire", jsonBody(TriggerRefSchema), async (c) => {
      const ref = c.req.valid("json");
      const trigger = await deps.triggers.find(ref.cwd, ref.name);
      if (trigger === undefined) return notFound(c, ref);
      const fire = await inTurn(() =>
        fireTrigger(trigger, new Date(), {
          ...deps,
          log: c.get("log").child({ component: "triggers" }),
          now: () => new Date(),
        }),
      );
      return c.json({ fire }, 200);
    })
    .get("/log", queryParams(TriggerRefSchema), async (c) => {
      const ref = c.req.valid("query");
      const trigger = await deps.triggers.find(ref.cwd, ref.name);
      if (trigger === undefined) return notFound(c, ref);
      return c.json({ fires: await deps.triggers.readFires(trigger.id, LOG_LIMIT) }, 200);
    })
    .delete("/", queryParams(TriggerRefSchema), async (c) => {
      const ref = c.req.valid("query");
      const trigger = await deps.triggers.find(ref.cwd, ref.name);
      if (trigger === undefined || !(await deps.triggers.remove(trigger.id))) {
        return notFound(c, ref);
      }
      c.get("log").info({ trigger }, "trigger removed");
      return c.json({ trigger }, 200);
    });
