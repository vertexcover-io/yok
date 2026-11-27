import { type SQL, sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

const createdAt = () => text("created_at").notNull();
const updatedAt = () =>
  text("updated_at")
    .notNull()
    .$onUpdate(() => new Date().toISOString());
const json = (name: string) => text(name, { mode: "json" });
const jsonValid = (column: AnySQLiteColumn): SQL => sql`json_valid(${column})`;

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// A user's account at another service: GitHub signs them in, Slack is linked afterwards.
export const userAccounts = sqliteTable(
  "user_accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    // the provider's permanent id for the person
    providerId: text("provider_id").notNull(),
    // their name there; it can change, so it is never matched on
    username: text("username"),
    // only for a provider yok acts through, such as GitHub
    token: text("token"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.provider] }), unique().on(t.provider, t.providerId)],
);

export const projects = sqliteTable("projects", {
  name: text("name").primaryKey(),
  // the project's folder on this machine
  path: text("path").notNull(),
  git: text("git"),
  // where the request came from: cli, server, api or slack
  channel: text("channel").notNull(),
  addedBy: text("added_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    project: text("project")
      .notNull()
      .references(() => projects.name, { onDelete: "restrict" }),
    // null until init
    name: text("name"),
    workflow: text("workflow").notNull(),
    workflowPath: text("workflow_path").notNull(),
    config: text("config"),
    terminal: text("terminal"),
    permissionMode: text("permission_mode"),
    // api, slack or trigger
    source: text("source"),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    inputs: json("inputs").notNull(),
    // the agent sessions the run started
    sessions: json("sessions").notNull(),
    tiers: json("tiers"),
    policies: json("policies"),
    // null until init
    state: json("state"),
    lastEventSeq: integer("last_event_seq").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique().on(t.project, t.name),
    check("runs_inputs_json", jsonValid(t.inputs)),
    check("runs_sessions_json", jsonValid(t.sessions)),
    check("runs_tiers_json", jsonValid(t.tiers)),
    check("runs_policies_json", jsonValid(t.policies)),
    check("runs_state_json", jsonValid(t.state)),
  ],
);

export const events = sqliteTable(
  "events",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    id: text("id").notNull(),
    ts: text("ts").notNull(),
    type: text("type").notNull(),
    source: text("source").notNull(),
    nodeId: text("node_id"),
    nodeRunId: text("node_run_id"),
    stage: text("stage"),
    schemaVersion: integer("schema_version").notNull(),
    payload: json("payload").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.seq] }),
    unique().on(t.runId, t.id),
    check("events_payload_json", jsonValid(t.payload)),
  ],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    // the step that produced it
    nodeRunId: text("node_run_id").notNull(),
    type: text("type").notNull(),
    name: text("name").notNull(),
    // a file, relative to the run folder
    path: text("path"),
    // or a link, such as a pull request
    url: text("url"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.nodeRunId, t.type, t.name] }),
    check("artifacts_path_or_url", sql`(${t.path} IS NULL) <> (${t.url} IS NULL)`),
  ],
);

export const comments = sqliteTable(
  "comments",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    file: text("file").notNull(),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    status: text("status").notNull(),
    deliveredAt: text("delivered_at"),
    anchor: json("anchor"),
    thread: json("thread").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.id] }),
    check("comments_anchor_json", jsonValid(t.anchor)),
    check("comments_thread_json", jsonValid(t.thread)),
  ],
);

export const triggers = sqliteTable(
  "triggers",
  {
    id: text("id").primaryKey(),
    project: text("project")
      .notNull()
      .references(() => projects.name, { onDelete: "cascade" }),
    name: text("name").notNull(),
    workflow: text("workflow").notNull(),
    config: text("config"),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull(),
    nextFireAt: text("next_fire_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique().on(t.project, t.name)],
);

export const triggerFires = sqliteTable(
  "trigger_fires",
  {
    triggerId: text("trigger_id")
      .notNull()
      .references(() => triggers.id, { onDelete: "cascade" }),
    slot: text("slot").notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    runName: text("run_name"),
    at: text("at").notNull(),
  },
  (t) => [index("trigger_fires_by_trigger").on(t.triggerId, t.at)],
);

// One periodic audit of a project. The row is written when the audit starts and updated when it
// publishes; its run holds the project, audit and period until the run is removed.
export const auditRuns = sqliteTable(
  "audit_runs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .unique()
      .references(() => runs.id, { onDelete: "cascade" }),
    project: text("project")
      .notNull()
      .references(() => projects.name, { onDelete: "restrict" }),
    // test, qa or review
    audit: text("audit").notNull(),
    // the window the audit looks at
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    // repo name to the commit audited
    commits: json("commits").notNull(),
    // running, complete, partial or failed
    status: text("status").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique().on(t.project, t.audit, t.periodStart, t.periodEnd),
    check("audit_runs_commits_json", jsonValid(t.commits)),
  ],
);

// No limit column: a metric's limit is defined in code, not per measurement.
export const auditMetrics = sqliteTable(
  "audit_metrics",
  {
    auditRunId: text("audit_run_id")
      .notNull()
      .references(() => auditRuns.id, { onDelete: "cascade" }),
    repo: text("repo").notNull(),
    metric: text("metric").notNull(),
    // '' for the whole suite
    scope: text("scope").notNull(),
    // measured or not_measured
    status: text("status").notNull(),
    reason: text("reason"),
    value: real("value"),
    how: json("how").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.auditRunId, t.repo, t.metric, t.scope] }),
    check("audit_metrics_how_json", jsonValid(t.how)),
  ],
);

export const auditResults = sqliteTable(
  "audit_results",
  {
    id: text("id").primaryKey(),
    auditRunId: text("audit_run_id")
      .notNull()
      .references(() => auditRuns.id, { onDelete: "cascade" }),
    repo: text("repo").notNull(),
    problemType: text("problem_type").notNull(),
    // auto_fixed, needs_approval or needs_work
    state: text("state").notNull(),
    title: text("title").notNull(),
    proof: json("proof").notNull(),
    fix: json("fix"),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("audit_results_by_audit_run").on(t.auditRunId),
    check("audit_results_proof_json", jsonValid(t.proof)),
    check("audit_results_fix_json", jsonValid(t.fix)),
  ],
);

// Append-only: a later click is a new row, and the newest row is the result's decision.
export const auditResultEvents = sqliteTable(
  "audit_result_events",
  {
    id: text("id").primaryKey(),
    resultId: text("result_id")
      .notNull()
      .references(() => auditResults.id, { onDelete: "cascade" }),
    // accepted, rejected or undone
    type: text("type").notNull(),
    who: text("who").notNull(),
    ts: text("ts").notNull(),
    // the apply or revert run the click started, not the audit's own run
    startedRunId: text("started_run_id").references(() => runs.id, { onDelete: "set null" }),
    payload: json("payload").notNull(),
  },
  (t) => [
    index("audit_result_events_by_result").on(t.resultId),
    check("audit_result_events_payload_json", jsonValid(t.payload)),
  ],
);
