import { type SQL, sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
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
