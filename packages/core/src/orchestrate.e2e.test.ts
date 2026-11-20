import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ERROR_MESSAGE_LIMIT,
  EventSchema,
  type JsonValue,
  runDirOf,
  StateSchema,
  SubscriberCalledEvent,
  type WorkflowRun,
} from "@yok/sdk";
import * as z from "zod";
import {
  configuredRepo,
  eventsOf,
  fileArtifact,
  initializedRun,
  orchestrate,
  parseStep,
  readRuns,
  STAGE_SKILLS,
  STAGES_WORKFLOW,
  savedRun,
  seedRuns,
  stageSkills,
  startedRun,
  stateIn,
  tempDir,
  tempRepo,
  waitFor,
} from "./test-orchestrate.ts";

describe("SC26: orchestrate init", () => {
  test("SC23: init NAME --run-id prints { runId, dir }, stores the run's state in yok.db with no state.json, and names the run", async () => {
    const repo = tempRepo();
    const home = tempDir();
    await seedRuns(home, [savedRun(repo)]);

    const init = orchestrate(repo, home, ["init", "fix-login", "--run-id", "r-1"]);

    expect(init.code).toBe(0);
    const dir = join(repo, ".yok", "fix-login");
    expect(JSON.parse(init.stdout)).toEqual({ runId: "r-1", dir });
    expect(existsSync(join(dir, "state.json"))).toBe(false);
    expect((await stateIn(home)).runName).toBe("fix-login");
    expect((await readRuns(home))["r-1"]?.name).toBe("fix-login");
  });

  const threadOf = async (home: string) => (await stateIn(home)).notification?.threadId;

  test("init of the session's own run, with YOK_SLACK_THREAD 100.1, records thread 100.1", async () => {
    const repo = tempRepo();
    const home = tempDir();
    await seedRuns(home, [savedRun(repo)]);

    const init = orchestrate(repo, home, ["init", "fix-login"], {
      YOK_RUN_ID: "r-1",
      YOK_SLACK_THREAD: "100.1",
    });

    expect(init.code).toBe(0);
    expect(await threadOf(home)).toBe("100.1");
  });

  test("SC921: init in a session the server started from a Slack thread keeps the thread's channel C1 and requester U7 in the run's state", async () => {
    const repo = tempRepo();
    const home = tempDir();
    await seedRuns(home, [savedRun(repo)]);

    const init = orchestrate(repo, home, ["init", "fix-login"], {
      YOK_RUN_ID: "r-1",
      YOK_SLACK_THREAD: "100.1",
      SLACK_CHANNEL_ID: "C1",
      SLACK_MEMBER_ID: "U7",
    });

    expect(init.code).toBe(0);
    expect((await stateIn(home)).notification).toEqual({
      provider: "slack",
      threadId: "100.1",
      channel: "C1",
      user: "U7",
    });
  });

  test("SC24: init with no --run-id and no YOK_RUN_ID exits 1 with the no-run message", async () => {
    const init = orchestrate(tempRepo(), tempDir(), ["init", "fix-login"]);

    expect(init.code).toBe(1);
    expect(init.stderr.trim()).not.toBe("");
  });
});

describe("runs kept in yok.db", () => {
  test("SC225: init feat-x --run-id r-1 prints { runId, dir }, copies workflow.yaml, names the run and starts it after the thread event; a second init of r-1 exits 1", async () => {
    const repo = tempRepo();
    const home = tempDir();
    await seedRuns(home, [savedRun(repo)]);
    const env = { YOK_SLACK_THREAD: "100.1" };

    const first = orchestrate(repo, home, ["init", "feat-x", "--run-id", "r-1"], env);
    const second = orchestrate(repo, home, ["init", "feat-x", "--run-id", "r-1"], env);

    const dir = join(repo, ".yok", "feat-x");
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({ runId: "r-1", dir });
    expect(existsSync(join(dir, "workflow.yaml"))).toBe(true);
    expect((await readRuns(home))["r-1"]?.name).toBe("feat-x");
    expect((await eventsOf(home)).slice(0, 2).map((event) => event.type)).toEqual([
      "notification.thread.started",
      "workflow.started",
    ]);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("run r-1 is already initialized as feat-x");
  });

  test("SC222: init, next, exec and next on a fresh home complete the run in yok.db and leave no registry.json, state.json, event.jsonl or their locks", async () => {
    const repo = tempRepo();
    const home = tempDir();
    await seedRuns(home, [savedRun(repo, { inputs: {} })]);
    const run = (args: readonly string[]) => orchestrate(repo, home, args);

    const init = run(["init", "feat-x", "--run-id", "r-1"]);
    const handed = run(["next", "--run", "feat-x"]);
    const exec = run(["exec", parseStep(handed.stdout).nodeRunId, "--run", "feat-x"]);
    const finished = run(["next", "--run", "feat-x"]);

    expect([init.code, handed.code, exec.code, finished.code]).toEqual([0, 0, 0, 0]);
    expect(JSON.parse(finished.stdout)).toEqual({ kind: "finished", status: "completed" });
    const dir = runDirOf(repo, "feat-x");
    for (const path of [
      join(home, "registry.json"),
      join(dir, "state.json"),
      join(dir, "event.jsonl"),
      join(dir, "locks", "state.lock"),
      join(dir, "locks", "event-log.lock"),
    ]) {
      expect(existsSync(path)).toBe(false);
    }
    expect(existsSync(join(home, "yok.db"))).toBe(true);
    expect((await readRuns(home))["r-1"]?.name).toBe("feat-x");
    expect((await stateIn(home)).status).toBe("completed");
    const types = (await eventsOf(home)).map((event) => event.type);
    expect(types[0]).toBe("workflow.started");
    expect(types.filter((type) => type.startsWith("workflow.")).at(-1)).toBe("workflow.completed");
  });
});

describe("SC26: orchestrate emit", () => {
  test("SC22: emit --run NAME stores the event under the run's id and prints it", async () => {
    const repo = tempRepo();
    const home = tempDir();
    await initializedRun(home, repo);

    const emit = orchestrate(repo, home, [
      "emit",
      "custom.review.note",
      "--run",
      "feat-x",
      "--source",
      "review-skill",
      "--payload",
      '{"files":3}',
      "--node-id",
      "review",
      "--node-run-id",
      "review",
      "--stage",
      "review",
      "--id",
      "note-1",
    ]);

    expect(emit.code).toBe(0);
    const printed = JSON.parse(emit.stdout);
    expect(printed).toMatchObject({
      type: "custom.review.note",
      source: "review-skill",
      runId: "r-1",
      payload: { files: 3 },
      nodeId: "review",
      nodeRunId: "review",
      stage: "review",
      id: "note-1",
    });
    expect((await eventsOf(home)).at(-1)).toEqual(printed);
  });

  test("SC28: emit to a name no run has exits 1 naming it", async () => {
    const repo = tempRepo();

    const emit = orchestrate(repo, tempDir(), [
      "emit",
      "custom.x.y",
      "--run",
      "ghost",
      "--source",
      "x",
    ]);

    expect(emit.code).toBe(1);
    expect(emit.stderr).toContain('no run named "ghost"');
  });

  test("SC519: emit policy.applied with a valid payload exits 1 as engine-written and stores nothing", async () => {
    const repo = tempRepo();
    const home = tempDir();
    await initializedRun(home, repo);
    const before = await eventsOf(home);
    const payload = { policy: "interaction", effect: "auto-approved", path: "artifacts/design.md" };
    const attempted = orchestrate(repo, home, [
      "emit",
      "policy.applied",
      "--run",
      "feat-x",
      "--source",
      "design",
      "--payload",
      JSON.stringify(payload),
    ]);
    expect(attempted.code).not.toBe(0);
    expect(attempted.stderr).toContain("policy.applied is written only by the engine");
    expect(await eventsOf(home)).toEqual(before);
  });

  test.each([
    ["SC24: a payload that is not JSON", ["--source", "s", "--payload", "{oops"], "--payload"],
    ["SC30: no --source", [], "--source"],
  ])("%s exits 1 naming the flag and stores nothing", async (_label, flags, flag) => {
    const repo = tempRepo();
    const home = tempDir();
    await initializedRun(home, repo);

    const emit = orchestrate(repo, home, ["emit", "custom.x.y", "--run", "feat-x", ...flags]);

    expect(emit.code).toBe(1);
    expect(emit.stderr).toContain(flag);
    expect(await eventsOf(home)).toEqual([]);
  });
});

const DEMO_SKILL = `---
name: demo
description: A demo skill.
mode: inline
allowed-tools: [Bash]
tier: fast
inputs:
  description: Anything.
  schema: demo.input.v1
outputs:
  description: Anything.
  schema: demo.output.v1
protocols: []
scopes: []
references:
  notes:
    path: notes.md
    description: Notes.
---
`;

const demoSkills = (): string => {
  const skillsDir = tempDir();
  mkdirSync(join(skillsDir, "demo"));
  writeFileSync(join(skillsDir, "demo/SKILL.md"), DEMO_SKILL);
  writeFileSync(join(skillsDir, "demo/notes.md"), "base text\n");
  return skillsDir;
};

describe("SC26: orchestrate skill", () => {
  test("WS32 — skill ref with an extend prints the base text, a blank line, then the extension", async () => {
    const skillsDir = tempDir();
    mkdirSync(join(skillsDir, "demo"));
    writeFileSync(join(skillsDir, "demo/SKILL.md"), DEMO_SKILL);
    writeFileSync(join(skillsDir, "demo/notes.md"), "base text\n");
    const root = configuredRepo({
      extensions: { demo: { references: { notes: { extend: "notes-extra.md" } } } },
    });
    writeFileSync(join(root, "notes-extra.md"), "extension text\n");

    const run = orchestrate(root, tempDir(), ["skill", "ref", "demo.notes"], {
      YOK_SKILLS_DIR: skillsDir,
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe("base text\n\nextension text\n");
  });

  test("skill ref --path prints the path of the skill's own file", async () => {
    const skillsDir = demoSkills();
    const args = ["skill", "ref", "--path", "demo.notes"];

    const run = orchestrate(configuredRepo({}), tempDir(), args, { YOK_SKILLS_DIR: skillsDir });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe(join(skillsDir, "demo/notes.md"));
  });

  test("skill ref --list SKILL prints the skill's references and the project's added ones as JSON", async () => {
    const skillsDir = tempDir();
    mkdirSync(join(skillsDir, "demo"));
    writeFileSync(join(skillsDir, "demo/SKILL.md"), DEMO_SKILL);
    writeFileSync(join(skillsDir, "demo/notes.md"), "base text\n");
    const root = configuredRepo({
      extensions: {
        demo: { references: { jira: { add: "jira.md", description: "Jira issues." } } },
      },
    });
    writeFileSync(join(root, "jira.md"), "jira\n");

    const run = orchestrate(root, tempDir(), ["skill", "ref", "--list", "demo"], {
      YOK_SKILLS_DIR: skillsDir,
    });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([
      { name: "notes", description: "Notes." },
      { name: "jira", description: "Jira issues." },
    ]);
  });

  test.each([
    ["without a dot between skill and reference shows the form", {}, "baseline", "STAGE.REF"],
    ["WS33 — for a skill that does not exist names the skill", {}, "missing.notes", "missing"],
    [
      "on a reference the project made a command points at skill run",
      { demo: { references: { notes: { command: "echo hi" } } } },
      "demo.notes",
      "demo.notes is a command; run it with skill run",
    ],
  ])("skill ref %s and exits 1", (_case, extensions, ref, message) => {
    const run = orchestrate(configuredRepo({ extensions }), tempDir(), ["skill", "ref", ref], {
      YOK_SKILLS_DIR: demoSkills(),
    });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(message);
  });

  test("skill extension prints the project's extension doc for the skill, and nothing without one", async () => {
    const skillsDir = demoSkills();
    const root = configuredRepo({ extensions: { demo: { skill: "demo-extra.md" } } });
    writeFileSync(join(root, "demo-extra.md"), "use pnpm\n");
    const env = { YOK_SKILLS_DIR: skillsDir };

    const run = orchestrate(root, tempDir(), ["skill", "extension", "demo"], env);
    const none = orchestrate(configuredRepo({}), tempDir(), ["skill", "extension", "demo"], env);

    expect(run.code).toBe(0);
    expect(run.stdout).toBe("use pnpm\n");
    expect([none.code, none.stdout]).toEqual([0, ""]);
  });

  test("inside a run, skill ref review.x reads the project skill the run's workflow names review", async () => {
    const { repo, home } = await startedRun(
      "name: r\nnodes:\n  - { id: check, type: agent, stage: stages/review, input: {} }\n",
      undefined,
      {},
      {
        stages: { review: { references: "{ x: { path: x.md, description: X. } }" } },
        files: { "stages/review/x.md": "review x\n" },
      },
    );

    const run = orchestrate(repo, home, ["skill", "ref", "review.x"], {
      YOK_RUN_ID: "r-1",
      YOK_SKILLS_DIR: tempDir(),
    });

    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("review x\n");
  });
});

const STEPS = `name: steps
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: a
    type: exec
    runtime: sh
    script: printf '{"n":1}'
    output: { zodSchema: Json }
    input: {}
  - id: w
    type: wait
    durationMs: 10
    dependsOn: [a]
    input: "{{ nodes.a.output }}"
  - id: b
    type: exec
    runtime: sh
    script: cat
    dependsOn: [w]
    input: "{{ nodes.w.output }}"
`;

const WORKTREE_CONFIG = {
  extensions: {
    producer: { skill: "docs/producer-ext.md", references: { demo: { add: "docs/demo.md" } } },
  },
};

// A run started in a linked worktree of a repo whose main checkout has a config without the
// worktree's extensions, initialized the way yok run + init leave it.
const worktreeRun = async (runOverrides: Partial<WorkflowRun> = {}) => {
  const main = configuredRepo({});
  const worktree = join(main, ".worktrees", "dev");
  execFileSync("git", ["worktree", "add", "-q", "-b", "dev", worktree], { cwd: main });
  writeFileSync(
    join(worktree, "orchestrate.config.json"),
    JSON.stringify({ version: 2, ...WORKTREE_CONFIG }),
  );
  mkdirSync(join(worktree, "docs"));
  writeFileSync(join(worktree, "docs/demo.md"), "worktree-only reference\n");
  writeFileSync(join(worktree, "docs/producer-ext.md"), "producer rules\n");
  const home = tempDir();
  const workflowPath = join(worktree, "stages.yaml");
  writeFileSync(workflowPath, STAGES_WORKFLOW);
  await seedRuns(home, [savedRun(worktree, { workflowPath, ...runOverrides })]);
  const env = { YOK_SKILLS_DIR: stageSkills() };
  const init = orchestrate(worktree, home, ["init", "feat-x", "--run-id", "r-1"], env);
  if (init.code !== 0) throw new Error(init.stderr);
  return { main, worktree, home, env };
};

describe("SC26: a run started in a linked worktree", () => {
  test("VER-289: skill ref and next, given no flags inside the run's session, read the worktree's config that main lacks", async () => {
    const { main, worktree, home, env } = await worktreeRun();
    const session = { ...env, YOK_RUN_ID: "r-1" };

    const ref = orchestrate(main, home, ["skill", "ref", "producer.demo"], session);
    const next = orchestrate(main, home, ["next"], session);

    expect(ref.stdout).toBe("worktree-only reference\n");
    expect(ref.code).toBe(0);
    expect(next.code).toBe(0);
    const reply = parseStep(next.stdout);
    expect(reply.extension).toBe(join(worktree, "docs/producer-ext.md"));
    expect(reply.done).toBe(`yok orchestrate done ${reply.nodeRunId} --run feat-x`);
  });
});

describe("reading a run through orchestrate get, sessions and events", () => {
  const OK_WORKFLOW =
    'name: ok\nnodes:\n  - { id: a, type: exec, input: null, runtime: sh, script: "true" }\n';

  test("SC407: get workspace.repositories.REPO.git.startSha prints the repo's HEAD at init as a JSON string", async () => {
    const { repo, home } = await startedRun(OK_WORKFLOW);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const [repoId] = Object.keys((await stateIn(home)).workspace?.repositories ?? {});

    const got = orchestrate(repo, home, [
      "get",
      `workspace.repositories.${repoId}.git.startSha`,
      "--run",
      "feat-x",
    ]);

    expect(got.code).toBe(0);
    expect(got.stdout.trim().startsWith('"')).toBe(true);
    expect(JSON.parse(got.stdout)).toBe(head);
  });

  test("SC408: get with no key prints the whole state of running run feat-x", async () => {
    const { repo, home } = await startedRun(OK_WORKFLOW);

    const got = orchestrate(repo, home, ["get", "--run", "feat-x"]);

    expect(got.code).toBe(0);
    const state = StateSchema.parse(JSON.parse(got.stdout));
    expect([state.runName, state.status]).toEqual(["feat-x", "running"]);
  });

  test("SC409: get workspace.nope exits 1 with one stderr line naming the key and prints nothing", async () => {
    const { repo, home } = await startedRun(OK_WORKFLOW);

    const got = orchestrate(repo, home, ["get", "workspace.nope", "--run", "feat-x"]);

    expect(got.code).toBe(1);
    expect(got.stdout).toBe("");
    expect(got.stderr.trim().split("\n")).toEqual([
      "run feat-x has no workspace.nope in its state",
    ]);
  });

  test("SC410: sessions lists claude s1 then codex s2 in link order, with s1 linked twice listed once", async () => {
    const { repo, home } = await startedRun(OK_WORKFLOW);
    const link = (agent: string, sessionId: string) =>
      orchestrate(repo, home, [
        "link-session",
        "--agent",
        agent,
        "--session-id",
        sessionId,
        "--run",
        "feat-x",
      ]);
    for (const [agent, id] of [
      ["claude", "s1"],
      ["codex", "s2"],
      ["claude", "s1"],
    ] as const) {
      expect(link(agent, id).code).toBe(0);
    }

    const sessions = orchestrate(repo, home, ["sessions", "--run", "feat-x"]);

    expect(sessions.code).toBe(0);
    expect(JSON.parse(sessions.stdout)).toEqual([
      { agent: "claude", sessionId: "s1" },
      { agent: "codex", sessionId: "s2" },
    ]);
  });

  test("SC411: events lists every stored event oldest first, from workflow.started to the emitted custom.test.note", async () => {
    const { repo, home } = await startedRun(OK_WORKFLOW);
    const emit = orchestrate(repo, home, [
      "emit",
      "custom.test.note",
      "--source",
      "test",
      "--payload",
      '{"n":1}',
      "--run",
      "feat-x",
    ]);
    expect(emit.code).toBe(0);

    const listed = orchestrate(repo, home, ["events", "--run", "feat-x"]);

    expect(listed.code).toBe(0);
    const events = z.array(EventSchema).parse(JSON.parse(listed.stdout));
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events[0]?.type).toBe("workflow.started");
    expect(events.at(-1)).toMatchObject({ type: "custom.test.note", payload: { n: 1 } });
  });

  test("SC412: events by --run, by --run-id from outside the repo and by $YOK_RUN_ID print the same run, and naming none exits 1", async () => {
    const { repo, home } = await startedRun(OK_WORKFLOW);

    const byName = orchestrate(repo, home, ["events", "--run", "feat-x"]);
    const byId = orchestrate(tempDir(), home, ["events", "--run-id", "r-1"]);
    const byEnv = orchestrate(repo, home, ["events"], { YOK_RUN_ID: "r-1" });
    const none = orchestrate(repo, home, ["events"]);

    expect([byName.code, byId.code, byEnv.code]).toEqual([0, 0, 0]);
    expect(byId.stdout).toBe(byName.stdout);
    expect(byEnv.stdout).toBe(byName.stdout);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("no run: pass --run or --run-id, or run inside a yok session");
  });
});

describe("SC26: picking the run", () => {
  test("--run-id picks the run from a folder outside any repo", async () => {
    const { home, env } = await worktreeRun();

    const next = orchestrate(tempDir(), home, ["next", "--run-id", "r-1"], env);

    expect(next.code).toBe(0);
    expect(parseStep(next.stdout).nodeId).toBe("make");
  });

  test("SC11: next finds its run from $YOK_RUN_ID, a --run-id flag wins over it, and the old variable is not read", async () => {
    const { worktree, home, env } = await worktreeRun();
    const workflowPath = join(worktree, "stages.yaml");
    await seedRuns(home, [savedRun(worktree, { id: "r-2", workflowPath })]);
    expect(orchestrate(worktree, home, ["init", "feat-y", "--run-id", "r-2"], env).code).toBe(0);
    const runOf = (result: ReturnType<typeof orchestrate>) => parseStep(result.stdout).done;

    const fromEnv = orchestrate(worktree, home, ["next"], { ...env, YOK_RUN_ID: "r-1" });
    const fromFlag = orchestrate(worktree, home, ["next", "--run-id", "r-2"], {
      ...env,
      YOK_RUN_ID: "r-1",
    });
    // Split so the sweep for the old product name (SC10) does not flag this test.
    const oldOnly = orchestrate(worktree, home, ["next"], {
      ...env,
      [`${["HAR", "NESS"].join("")}_RUN_ID`]: "r-1",
    });

    expect(runOf(fromEnv)).toContain("--run feat-x");
    expect(runOf(fromFlag)).toContain("--run feat-y");
    expect(oldOnly.code).toBe(1);
    expect(oldOnly.stderr).toContain("no run: pass --run or --run-id");
  });

  test("done's refusal names the run id that picked a run it cannot find", async () => {
    const { worktree, home } = await worktreeRun();

    const done = orchestrate(
      worktree,
      home,
      ["done", "nr-1", "--summary", "Did the work.", "--output", "x"],
      {
        YOK_RUN_ID: "r-ghost",
      },
    );

    expect(done.code).toBe(1);
    expect(JSON.parse(done.stderr)).toMatchObject({
      kind: "configuration",
      code: "run",
      path: "r-ghost",
      message: "run r-ghost not found",
    });
  });
});

describe("SC26: orchestrate next and exec", () => {
  test("IW10 — next and exec, called in turn, take an exec, wait and exec workflow from init to finished", async () => {
    const { repo, home } = await startedRun(STEPS);
    const handedOut = ["a", "w", "b"].map((nodeId) => {
      const next = orchestrate(repo, home, ["next", "--run", "feat-x"]);
      expect(next.code).toBe(0);
      const reply = parseStep(next.stdout);
      expect(reply).toEqual({
        kind: "exec",
        nodeRunId: expect.stringMatching(/^nr-[0-9a-f]{16}$/),
        nodeId,
        mode: "inline",
        command: `yok orchestrate exec ${reply.nodeRunId} --run feat-x`,
      });
      const exec = orchestrate(repo, home, ["exec", reply.nodeRunId, "--run", "feat-x"]);
      expect(exec.code).toBe(0);
      expect(JSON.parse(exec.stdout)).toEqual({
        nodeRunId: reply.nodeRunId,
        nodeId,
        status: "completed",
        attempts: 1,
      });
      return reply.nodeRunId;
    });

    const last = orchestrate(repo, home, ["next", "--run", "feat-x"]);
    expect(parseStep(last.stdout)).toEqual({ kind: "finished", status: "completed" });
    const state = await stateIn(home);
    expect(state).toMatchObject({ runId: "r-1", runName: "feat-x", status: "completed" });
    expect(state.nodeRuns.w?.nodeRunId).toBe(handedOut[1]);
    expect(state.nodeRuns.w?.output).toEqual({ n: 1 });
    expect(state.nodeRuns.b).toMatchObject({ nodeType: "exec", output: '{"n":1}' });
    expect(state.nodeRuns.b).not.toHaveProperty("process");
    const ended = (await eventsOf(home)).find(
      (event) => event.nodeRunId === handedOut[2] && event.type === "workflow.node.completed",
    );
    expect(ended?.payload).toMatchObject({
      output: '{"n":1}',
      process: { stdout: '{"n":1}', stderr: "", exitCode: 0 },
    });
  });

  const execAll = (repo: string, home: string, count: number) =>
    Array.from({ length: count }, () => {
      const reply = parseStep(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
      const exec = orchestrate(repo, home, ["exec", reply.nodeRunId, "--run", "feat-x"]);
      expect(exec.stderr).toBe("");
      expect(exec.code).toBe(0);
      return reply.nodeId;
    });

  test("SC87: a runtime: bun exec node runs through yok orchestrate script from a file in the run's scripts folder, reused for the same text", async () => {
    const node = (id: string, extra = "") => `  - id: ${id}
    type: exec
    runtime: bun
    output: { zodSchema: Json }
    input: { id: ${id} }${extra}
    script: |
      import { appendFileSync } from "node:fs";
      const input = await Bun.stdin.json();
      appendFileSync(process.cwd() + "/argv.txt", process.argv[1] + "\\n");
      process.stdout.write(JSON.stringify({ n: 1, seen: Object.keys(input).length }));
`;
    const { repo, home } = await startedRun(
      `name: steps\ninputs:\n  prompt: { type: string, required: true }\nnodes:\n${node("a")}${node("b", "\n    dependsOn: [a]")}`,
    );

    expect(execAll(repo, home, 2)).toEqual(["a", "b"]);

    const state = await stateIn(home);
    expect(state.nodeRuns.a?.output).toEqual({ n: 1, seen: 1 });
    const [first, second] = readFileSync(join(repo, "argv.txt"), "utf8").trim().split("\n");
    expect(first).toStartWith(`${join(runDirOf(repo, "feat-x"), "scripts")}/`);
    expect(first).toEndWith(".ts");
    expect(second).toBe(first);
  });

  test("SC96: an inline bun script outside the checkout imports @yok/sdk and zod with no node_modules", async () => {
    const { repo, home } = await startedRun(`name: steps
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: a
    type: exec
    runtime: bun
    input: {}
    script: |
      import { NonEmptyStringSchema } from "@yok/sdk";
      import { z } from "zod";
      NonEmptyStringSchema.parse("x");
      z.string().parse("y");
      process.stdout.write("ok");
`);
    expect(existsSync(join(repo, "node_modules"))).toBe(false);

    expect(execAll(repo, home, 1)).toEqual(["a"]);

    expect((await stateIn(home)).nodeRuns.a).toMatchObject({ status: "completed", output: "ok" });
  });

  test("IW11 — a script that keeps failing is retried as configured, exec exits 1, and the run ends failed", async () => {
    const { repo, home } = await startedRun(`name: steps
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: a
    type: exec
    runtime: sh
    script: exit 3
    retry: { maxAttempts: 2 }
    input: {}
`);
    const reply = parseStep(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
    const exec = orchestrate(repo, home, ["exec", reply.nodeRunId, "--run", "feat-x"]);
    expect(exec.code).toBe(1);
    expect(JSON.parse(exec.stdout)).toMatchObject({
      status: "failed",
      attempts: 2,
      error: { kind: "exit" },
    });
    expect(JSON.parse(exec.stdout).error).not.toHaveProperty("stack");
    const failed = (await eventsOf(home)).find((event) => event.type === "workflow.node.failed");
    expect(failed?.payload).toMatchObject({ process: { stdout: "", stderr: "", exitCode: 3 } });
    expect(failed?.payload).not.toHaveProperty("output");
    expect((await stateIn(home)).nodeRuns.a?.output).toEqual({
      kind: "exit",
      message: `${reply.nodeRunId} exited with code 3`,
    });
    const next = orchestrate(repo, home, ["next", "--run", "feat-x"]);
    expect(parseStep(next.stdout)).toEqual({ kind: "finished", status: "failed" });
  });

  test("IW12 — exec refuses a node run that already ended or does not exist, recording only the refused calls", async () => {
    const { repo, home } = await startedRun(STEPS);
    const reply = parseStep(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
    orchestrate(repo, home, ["exec", reply.nodeRunId, "--run", "feat-x"]);
    const before = (await eventsOf(home)).length;
    const stateBefore = await stateIn(home);

    const again = orchestrate(repo, home, ["exec", reply.nodeRunId, "--run", "feat-x"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain(reply.nodeRunId);
    const unknown = orchestrate(repo, home, ["exec", "nr-00000000", "--run", "feat-x"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("nr-00000000");
    const added = (await eventsOf(home)).slice(before);
    expect(added.map((event) => event.payload)).toEqual([
      {
        input: { nodeRunId: reply.nodeRunId },
        output: { kind: "error", message: again.stderr.trim() },
      },
      {
        input: { nodeRunId: "nr-00000000" },
        output: { kind: "error", message: unknown.stderr.trim() },
      },
    ]);
    expect(added.map((event) => event.type)).toEqual(["orchestrate.exec", "orchestrate.exec"]);
    expect(await stateIn(home)).toEqual({ ...stateBefore, lastEventSeq: before + 2 });
  });
});

const PARALLEL = `name: parallel
inputs:
  prompt: { type: string, required: true }
nodes:
  - { id: a, type: exec, runtime: sh, script: printf a, input: {} }
  - { id: b, type: exec, runtime: sh, script: printf b, dependsOn: [a], input: {} }
  - { id: c, type: exec, runtime: sh, script: printf c, dependsOn: [a], input: {} }
`;

describe("orchestrate next with parallel nodes", () => {
  test("SC15: once a is done, next prints b and c as one steps list in the background; after b's exec, next prints waiting on c", async () => {
    const { repo, home } = await startedRun(PARALLEL);
    const next = () => orchestrate(repo, home, ["next", "--run", "feat-x"]);
    const a = parseStep(next().stdout);
    expect(orchestrate(repo, home, ["exec", a.nodeRunId, "--run", "feat-x"]).code).toBe(0);

    const both = next();
    expect(both.code).toBe(0);
    const reply = JSON.parse(both.stdout);
    const handOut = (nodeId: string) => ({
      kind: "exec",
      nodeRunId: expect.stringMatching(/^nr-[0-9a-f]{16}$/),
      nodeId,
      mode: "background",
      command: expect.stringMatching(/^yok orchestrate exec nr-[0-9a-f]{16} --run feat-x$/),
    });
    expect(reply).toEqual({ kind: "steps", steps: [handOut("b"), handOut("c")] });
    const [b, c] = reply.steps;

    const exec = orchestrate(repo, home, ["exec", b.nodeRunId, "--run", "feat-x"]);
    expect(JSON.parse(exec.stdout)).toMatchObject({ nodeId: "b", status: "completed" });
    const completed = (await eventsOf(home))
      .filter((event) => event.type === "workflow.node.completed")
      .map((event) => event.nodeId);
    expect(completed).toEqual(["a", "b"]);
    expect((await stateIn(home)).nodeRuns.c?.status).toBe("running");
    expect(JSON.parse(next().stdout)).toEqual({
      kind: "waiting",
      running: [{ nodeRunId: c.nodeRunId, nodeId: "c" }],
    });
  });
});

describe("SC26: subscribers", () => {
  test("SC116: a config subscriber on workflow.node.completed fires when done completes a node", async () => {
    const skills = stageSkills();
    const { repo, home } = await startedRun(STAGES_WORKFLOW, {
      subscribers: { "workflow.node.completed": [{ name: "touch", command: "cat > fired.json" }] },
    });
    const step = (args: readonly string[]) =>
      orchestrate(repo, home, args, { YOK_SKILLS_DIR: skills });
    const make = parseStep(step(["next", "--run", "feat-x"]).stdout);
    writeFileSync(join(runDirOf(repo, "feat-x"), "artifacts", "plan.md"), "plan\n");

    const done = step([
      ...[
        "done",
        make.nodeRunId,
        "--run",
        "feat-x",
        "--summary",
        "Did the work.",
        "--output",
        "{}",
      ],
      ...["--artifact", fileArtifact("plan", "artifacts/plan.md")],
    ]);

    expect(done.code).toBe(0);
    const fired = JSON.parse(readFileSync(join(repo, "fired.json"), "utf8"));
    expect(fired.event).toMatchObject({ type: "workflow.node.completed", nodeId: "make" });
    expect(fired.state).toMatchObject({ runName: "feat-x", lastEventSeq: fired.event.seq });
    const calls = (await eventsOf(home)).filter((event) => event.type === "subscriber.called");
    expect(calls.map((call) => call.payload)).toMatchObject([
      { subscriber: "touch", eventId: fired.event.id, status: "ok" },
    ]);
  });
});

describe("SC26: the samskara upload", () => {
  // A samskara on PATH that records its arguments and refuses the session, as an unpaired CLI does.
  const failingSamskara = () => {
    const bin = tempDir();
    const argsFile = join(bin, "args.txt");
    writeFileSync(
      join(bin, "samskara"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${argsFile}\necho "Session s1 does not exist, or is not yours." >&2\nexit 1\n`,
      { mode: 0o755 },
    );
    return { env: { PATH: `${bin}:${process.env.PATH}` }, argsFile };
  };

  const samskaraCalls = async (home: string) =>
    (await eventsOf(home))
      .filter((event) => event.type === "subscriber.called")
      .flatMap((event) => {
        const call = SubscriberCalledEvent.safeParse(event);
        return call.success && call.data.payload.subscriber === "samskara" ? [call.data] : [];
      });

  test("SC410: with samskara on, a completed node's failed upload is a failed subscriber.called naming exit 1, and next still hands out the following node", async () => {
    const samskara = failingSamskara();
    // init copies the registry's sessions into the state's activeSessions.
    const sessions = [{ agent: "claude" as const, sessionId: "s1" }];
    const { repo, home } = await startedRun(STAGES_WORKFLOW, { samskara: {} }, { sessions });
    const step = (args: readonly string[]) =>
      orchestrate(repo, home, args, { YOK_SKILLS_DIR: STAGE_SKILLS, ...samskara.env });
    const make = parseStep(step(["next", "--run", "feat-x"]).stdout);
    const runDir = runDirOf(repo, "feat-x");
    writeFileSync(join(runDir, "artifacts", "plan.md"), "plan\n");

    const done = step([
      ...["done", make.nodeRunId, "--run", "feat-x", "--summary", "Did the work."],
      ...["--output", "{}", "--artifact", fileArtifact("plan", "artifacts/plan.md")],
    ]);

    expect(done.code).toBe(0);
    await waitFor(async () => (await samskaraCalls(home)).length > 0);
    const [call] = await samskaraCalls(home);
    expect(call?.payload).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("exit 1") },
    });
    const realRunDir = realpathSync(runDir);
    expect(readFileSync(samskara.argsFile, "utf8").trim().split("\n")).toEqual([
      ...["artifacts", "upload", "s1", join(realRunDir, "artifacts", "plan.md")],
      ...["--base-dir", realRunDir],
    ]);
    expect(parseStep(step(["next", "--run", "feat-x"]).stdout)).toMatchObject({ nodeId: "use" });
  }, 30_000);

  test("SC407: done on a node that ran in claude session s1 names s1 in its workflow.node.completed event", async () => {
    const sessions = [{ agent: "claude" as const, sessionId: "s1" }];
    const { repo, home } = await startedRun(STAGES_WORKFLOW, undefined, { sessions });
    const step = (args: readonly string[]) =>
      orchestrate(repo, home, args, { YOK_SKILLS_DIR: STAGE_SKILLS });
    const make = parseStep(step(["next", "--run", "feat-x"]).stdout);
    writeFileSync(join(runDirOf(repo, "feat-x"), "artifacts", "plan.md"), "plan\n");

    step([
      ...["done", make.nodeRunId, "--run", "feat-x", "--summary", "Did the work."],
      ...["--output", "{}", "--artifact", fileArtifact("plan", "artifacts/plan.md")],
    ]);

    const completed = (await eventsOf(home)).find(
      (event) => event.type === "workflow.node.completed",
    );
    expect(completed?.payload).toMatchObject({ session: { agent: "claude", sessionId: "s1" } });
  }, 30_000);
});

const MIXED = `name: mixed
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: fix
    type: loop
    until: "{{ iteration.index >= 3 }}"
    maxIterations: 5
    input: {}
    nodes:
      - { id: test, type: exec, runtime: sh, script: cat, input: "pass {{ iteration.index }}" }
  - id: decide
    type: switch
    dependsOn: [fix]
    expression: "{{ inputs.prompt }}"
    input: {}
    cases:
      - id: hello
        value: hi
        nodes:
          - { id: greet, type: exec, runtime: sh, script: echo hello-case, input: {} }
    default:
      - { id: greet, type: exec, runtime: sh, script: echo default-case, input: {} }
  - { id: sub, type: include, workflow: child.yaml, dependsOn: [decide], input: {} }
  - id: last
    type: exec
    runtime: sh
    script: cat
    dependsOn: [sub, fix]
    input: "{{ nodes.sub.output }} / {{ nodes.fix.output }}"
`;

const CHILD = `name: child
inputs:
  word: { type: string, default: hi }
nodes:
  - { id: say, type: exec, runtime: sh, script: cat, input: "{{ inputs.word }}" }
`;

describe("SC26: orchestrate next and exec with containers", () => {
  test("an exec node with a summary template posts, fills it from its output, and one without stays quiet", async () => {
    const { repo, home } = await startedRun(`name: lint
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: lint
    type: exec
    runtime: sh
    script: printf '{"errors":2}'
    output: { zodSchema: Json }
    summary: "Lint found {{ nodes.lint.output.errors }} errors"
    input: {}
  - { id: tidy, type: exec, runtime: sh, script: "true", dependsOn: [lint], input: {} }
`);
    for (const nodeId of ["lint", "tidy"]) {
      const reply = parseStep(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
      expect(reply).toMatchObject({ kind: "exec", nodeId });
      orchestrate(repo, home, ["exec", reply.nodeRunId, "--run", "feat-x"]);
    }
    const nodes = (await stateIn(home)).nodeRuns;
    expect(nodes.lint).toMatchObject({ notify: true, summary: "Lint found 2 errors" });
    expect(nodes.tidy).toMatchObject({ notify: false });
    expect(nodes.tidy).not.toHaveProperty("summary");
  });

  test("IW28 — next and exec run a workflow mixing a loop, a switch and an include to finished", async () => {
    const { repo, home } = await startedRun(
      MIXED,
      undefined,
      {},
      { files: { "child.yaml": CHILD } },
    );
    const handedOut = ["test", "test", "test", "greet", "say", "last"].map((nodeId) => {
      const reply = parseStep(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
      expect(reply).toMatchObject({ kind: "exec", nodeId });
      const exec = orchestrate(repo, home, ["exec", reply.nodeRunId, "--run", "feat-x"]);
      expect(JSON.parse(exec.stdout)).toMatchObject({ nodeId, status: "completed" });
      return reply.nodeRunId;
    });
    const last = orchestrate(repo, home, ["next", "--run", "feat-x"]);
    expect(parseStep(last.stdout)).toEqual({ kind: "finished", status: "completed" });
    const nodes = (await stateIn(home)).nodeRuns;
    expect(nodes.decide?.nodes?.greet).toMatchObject({ nodeRunId: handedOut[3] });
    expect(nodes.decide).toMatchObject({
      output: "hello-case\n",
      nodes: { greet: { output: "hello-case\n" } },
    });
    expect(nodes.fix).toMatchObject({ iteration: 3, output: '"pass 3"' });
    expect(nodes.sub?.output).toBe('"hi"');
    expect(nodes.last?.input).toBe('"hi" / "pass 3"');
  }, 10_000);
});

const ONE_EXEC = `name: one
inputs:
  prompt: { type: string, required: true }
nodes:
  - { id: a, type: exec, runtime: sh, script: printf done, input: {} }
`;

const AGENT = `name: asked
inputs:
  prompt: { type: string, required: true }
nodes:
  - { id: ask, type: agent, prompt: check it, input: {} }
`;

const callsOf = async (home: string) =>
  (await eventsOf(home))
    .filter((event) => event.type.startsWith("orchestrate."))
    .map(({ type, source, payload }) => ({ type, source, payload }));

const call = (type: string, input: JsonValue, output: JsonValue, status?: string) => ({
  type: `orchestrate.${type}`,
  source: "orchestrate",
  payload: { input, output, ...(status === undefined ? {} : { status }) },
});

describe("SC26: orchestrate call log", () => {
  test("OL1 — next and exec each log their input and whole reply, after the engine events the call recorded", async () => {
    const { repo, home } = await startedRun(ONE_EXEC);
    const step = (args: readonly string[]) => JSON.parse(orchestrate(repo, home, args).stdout);

    const handed = step(["next", "--run", "feat-x"]);
    const [exec] = handed.steps;
    const report = step(["exec", exec.nodeRunId, "--run", "feat-x"]);
    const finished = step(["next", "--run", "feat-x"]);

    expect(exec).toMatchObject({ kind: "exec", nodeId: "a" });
    expect(finished).toEqual({ kind: "finished", status: "completed" });
    expect(await callsOf(home)).toEqual([
      call("next", {}, handed),
      call("exec", { nodeRunId: exec.nodeRunId }, report),
      call("next", {}, finished),
    ]);
    expect((await eventsOf(home)).map((event) => event.type)).toEqual([
      "workflow.started",
      "workflow.node.started",
      "orchestrate.next",
      "workflow.node.completed",
      "orchestrate.exec",
      "workflow.completed",
      "orchestrate.next",
    ]);
  });

  test("OL2 — a stage reply, a refused done, a completed done and the next stage are logged", async () => {
    const run = await startedRun(STAGES_WORKFLOW);
    const env = { YOK_SKILLS_DIR: stageSkills() };
    const step = (args: readonly string[]) => orchestrate(run.repo, run.home, args, env);
    const handed = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    const [stage] = handed.steps;
    const done = ["done", stage.nodeRunId, "--run", "feat-x"];

    const refused = step([
      ...done,
      "--summary",
      "Did the work.",
      "--output",
      '{"ok":true}',
      "--artifact",
      fileArtifact("plan", "artifacts/plan.md"),
    ]);
    writeFileSync(join(runDirOf(run.repo, "feat-x"), "artifacts", "plan.md"), "plan\n");
    const report = JSON.parse(
      step([
        ...done,
        "--summary",
        "Did the work.",
        "--output",
        '{"ok":true}',
        "--artifact",
        fileArtifact("plan", "artifacts/plan.md"),
      ]).stdout,
    );
    const handedNext = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    const [following] = handedNext.steps;

    expect(refused.code).toBe(1);
    expect(stage).toMatchObject({ kind: "stage", nodeId: "make" });
    expect(following).toMatchObject({ kind: "stage", nodeId: "use" });
    const artifacts = [{ type: "plan", name: "plan", path: "artifacts/plan.md" }];
    expect(await callsOf(run.home)).toEqual([
      call("next", {}, handed),
      call(
        "done",
        { nodeRunId: stage.nodeRunId, output: '{"ok":true}', summary: "Did the work.", artifacts },
        { kind: "error", message: refused.stderr.trim().slice(0, ERROR_MESSAGE_LIMIT) },
        "rejected",
      ),
      call(
        "done",
        { nodeRunId: stage.nodeRunId, output: '{"ok":true}', summary: "Did the work.", artifacts },
        report,
        "completed",
      ),
      call("next", {}, handedNext),
    ]);
  });

  test("OL3 — an agent reply and a done --error log the error as the agent reported it", async () => {
    const { repo, home } = await startedRun(AGENT);
    const handed = JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
    const [agent] = handed.steps;
    const failed = orchestrate(repo, home, [
      "done",
      agent.nodeRunId,
      "--run",
      "feat-x",
      "--error",
      "could not",
    ]);

    expect(agent).toMatchObject({ kind: "agent", prompt: "check it" });
    expect(await callsOf(home)).toEqual([
      call("next", {}, handed),
      call(
        "done",
        { nodeRunId: agent.nodeRunId, error: "could not", artifacts: [] },
        JSON.parse(failed.stdout),
        "failed",
      ),
    ]);
  });

  test("OL4 — a next that throws logs the error with its stack, fails as before, and leaves state.json alone but for lastEventSeq", async () => {
    const { repo, home } = await startedRun(ONE_EXEC);
    writeFileSync(join(runDirOf(repo, "feat-x"), "workflow.yaml"), "name: one\nnodes: 3\n");
    const before = await stateIn(home);

    const next = orchestrate(repo, home, ["next", "--run", "feat-x"]);

    expect(next.code).toBe(1);
    expect(next.stdout).toBe("");
    expect(await callsOf(home)).toEqual([
      call(
        "next",
        {},
        {
          kind: "error",
          message: expect.stringContaining("nodes: Invalid input"),
          stack: expect.stringContaining("workflow/compile.ts"),
        },
      ),
    ]);
    expect(await stateIn(home)).toEqual({ ...before, lastEventSeq: before.lastEventSeq + 1 });
  });

  test("OL5 — a next refused over a config broken after init is logged", async () => {
    const { repo, home } = await startedRun(ONE_EXEC, {});
    writeFileSync(join(repo, "orchestrate.config.json"), "{");

    const next = orchestrate(repo, home, ["next", "--run", "feat-x"]);

    expect(next.code).toBe(1);
    expect(next.stderr).toContain("orchestrate.config.json: invalid YAML");
    expect(await callsOf(home)).toEqual([
      call(
        "next",
        {},
        {
          kind: "error",
          message: expect.stringContaining("orchestrate.config.json: invalid YAML"),
        },
      ),
    ]);
  });

  test("OL6 — exec and done refuse an empty node run id before touching the run", async () => {
    const { repo, home } = await startedRun(ONE_EXEC);
    const before = (await eventsOf(home)).length;

    const exec = orchestrate(repo, home, ["exec", "", "--run", "feat-x"]);
    const done = orchestrate(repo, home, [
      "done",
      "",
      "--run",
      "feat-x",
      "--summary",
      "Did the work.",
      "--output",
      "{}",
    ]);

    for (const refused of [exec, done]) {
      expect(refused.code).toBe(1);
      expect(refused.stderr.trim()).toBe("nodeRunId must not be empty");
    }
    expect(await eventsOf(home)).toHaveLength(before);
  });
});

describe("orchestrate workflows", () => {
  type Listed = Readonly<{ name: string; description: string; workflow: string; path: string }>;
  const list = (repo: string): readonly Listed[] => {
    const listed = orchestrate(repo, tempDir(), ["workflows"]);
    expect(listed.code).toBe(0);
    return JSON.parse(listed.stdout) as readonly Listed[];
  };

  test("prints every shipped workflow with its name, description and file as JSON", async () => {
    const workflows = list(tempRepo());

    expect(workflows.map((workflow) => workflow.name)).toEqual([
      "pr-fix",
      "quick",
      "regression",
      "skill",
      "task",
    ]);
    for (const workflow of workflows) {
      expect(workflow.description).not.toBe("");
      expect(workflow.workflow).toBe(workflow.name);
      expect(workflow.path.endsWith(join("workflows", `${workflow.name}.yaml`))).toBe(true);
    }
  });

  test("lists the project's workflows from the config's workflowPath after the shipped ones, run by their path", async () => {
    const repo = configuredRepo({ workflowPath: "flows" });
    mkdirSync(join(repo, "flows"));
    writeFileSync(
      join(repo, "flows", "nightly.yaml"),
      "name: nightly\ndescription: Nightly checks.\nnodes:\n  - id: a\n    type: exec\n    runtime: sh\n    script: 'true'\n    input: null\n",
    );
    writeFileSync(join(repo, "flows", "notes.md"), "not a workflow\n");

    const workflows = list(repo);

    expect(workflows.map((workflow) => workflow.name)).toEqual([
      "pr-fix",
      "quick",
      "regression",
      "skill",
      "task",
      "nightly",
    ]);
    expect(workflows.at(-1)).toEqual({
      name: "nightly",
      description: "Nightly checks.",
      workflow: "flows/nightly.yaml",
      path: join(repo, "flows", "nightly.yaml"),
    });
  });
});
