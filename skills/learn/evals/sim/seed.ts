// Builds the fake yok run a simulated learn session works in, in the yok home $YOK_HOME under
// the run id $YOK_RUN_ID. run.mjs runs it with bun, since Node cannot open yok.db.
//   seed.ts run NAME REPO [finished]       the run, its folder and its first state
//   seed.ts session SESSION_ID             a Claude session the run started
//   seed.ts comment FILE LINE QUOTE TEXT   a comment the viewer delivered; prints its id
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type IStorage, runDirOf, type State, StateSchema, yokHome } from "@yok/sdk";
import { appendRunEvent, withStorage } from "@yok/sdk/internal";
import { seedRuns } from "../../../../packages/cli/src/test-runs.ts";

const runId = process.env.YOK_RUN_ID ?? "";

// A finished run is one whose PR is up while retro still runs: the Stop hook offers learn on a
// push then.
const simState = (name: string, repo: string, finished: boolean): State => {
  const at = new Date().toISOString();
  const git = { branch: "feat/invoice-id", baseBranch: "main", startSha: "init" };
  const stage = (status: "completed" | "running") => ({
    nodeType: "agent",
    status,
    startedAt: at,
    completedAt: status === "completed" ? at : null,
    artifacts: [],
  });
  return StateSchema.parse({
    schemaVersion: 1,
    lastEventSeq: 0,
    runId,
    runName: name,
    runDir: runDirOf(repo, name),
    version: "2.0.0",
    workflow: { name: "task", path: "workflow.yaml" },
    input: {},
    scope: null,
    startedAt: at,
    completedAt: null,
    status: "running",
    workspace: { type: "mono", path: repo, repositories: { shop: { path: repo, git } } },
    nodeRuns: finished
      ? {
          pr: { nodeRunId: "pr", ...stage("completed") },
          retro: { nodeRunId: "retro", ...stage("running") },
        }
      : {},
    activeSessions: [],
    tiers: null,
    eventHandlers: {},
    subscribers: {},
    config: { path: null, root: repo },
  });
};

const createRun = async (name: string, repo: string, finished: boolean): Promise<void> => {
  const run = {
    id: runId,
    project: "learn-sim",
    workflow: "task",
    workflowPath: join(runDirOf(repo, name), "workflow.yaml"),
    inputs: {},
    cwd: repo,
    sessions: [],
    name,
    terminal: null,
    config: null,
    tiers: null,
    createdAt: new Date().toISOString(),
  };
  await seedRuns(yokHome(), [run], { [runId]: simState(name, repo, finished) });
  mkdirSync(runDirOf(repo, name), { recursive: true });
};

const startSession = async (storage: IStorage, sessionId: string): Promise<void> => {
  const run = await storage.runs.findRun(runId);
  if (run?.name == null) throw new Error(`no initialized run ${runId}`);
  const session = { agent: "claude", sessionId } as const;
  await storage.runs.linkSession(runId, session);
  const payload = { workflow: "task", inputs: {}, activeSessions: [session] };
  const started = await appendRunEvent(
    storage,
    { id: runId, cwd: run.cwd, name: run.name },
    { type: "workflow.started", source: "sim", payload },
  );
  if (!started.ok) throw new Error(started.error);
};

const deliverComment = async (storage: IStorage, args: readonly string[]): Promise<void> => {
  const [file = "", line = "0", quote = "", text = ""] = args;
  const at = Number(line);
  const lines: [number, number] | undefined = at > 0 ? [at, at] : undefined;
  const anchor = { quote, before: "", after: "", ...(lines ? { lines } : {}) };
  const added = await storage.comments.add(runId, [{ file, kind: "comment", text, anchor }]);
  const delivered = await storage.comments.markDelivered(runId, added);
  console.log(delivered[0]?.id ?? "");
};

const [command, ...args] = process.argv.slice(2);
if (command === "run") await createRun(args[0] ?? "", args[1] ?? "", args[2] === "finished");
else if (command === "session") {
  await withStorage(yokHome(), (storage) => startSession(storage, args[0] ?? ""));
} else if (command === "comment") {
  await withStorage(yokHome(), (storage) => deliverComment(storage, args));
} else throw new Error(`unknown command ${command}`);
