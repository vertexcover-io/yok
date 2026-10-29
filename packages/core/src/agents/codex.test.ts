import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ITerminal, ITerminalHost, TerminalSpec } from "@yok/sdk";
import * as z from "zod";
import { codexArgs, codexProvider, codexRunArgs, redactCodexRunArgs } from "./codex.ts";

const ARGV = ["/b", "/o.ts"];

describe("codexArgs", () => {
  test("SC7: launch argv has the bypass flag, the three hook overrides for codex, and the prompt last", () => {
    const args = codexArgs({ orchestrateArgv: ARGV, prompt: "go" });

    expect(args[0]).toBe("--dangerously-bypass-hook-trust");
    expect(args.at(-1)).toBe("go");
    const overrides = args.flatMap((arg, i) => (args[i - 1] === "-c" ? [arg] : []));
    expect(overrides.map((o) => o.split("=")[0])).toEqual([
      "hooks.SessionStart",
      "hooks.Stop",
      "hooks.PreToolUse",
    ]);
    for (const override of overrides) expect(override).toContain("--agent");
    expect(overrides.join("\n")).toContain("'codex'");
    expect(overrides[0]).toBe(
      `hooks.SessionStart=[{hooks = [{type = "command", command = "'/b' '/o.ts' 'hook' 'session-start' '--agent' 'codex' '--handler' 'link-session'", timeout = 30}]}]`,
    );
    expect(overrides[2]).toContain(`matcher = "Bash|shell|exec_command|local_shell|apply_patch"`);
    expect(overrides[2]).toContain("'record-guard'");
    expect(overrides[2]).toContain("'record-resumed'");
    expect(overrides[2]).not.toContain("bash-antipatterns");
  });

  test("SC7: model, effort and developer instructions appear only when given", () => {
    expect(codexArgs({ prompt: "go" })).toEqual(["--dangerously-bypass-hook-trust", "go"]);
    expect(
      codexArgs({ model: "gpt-5", effort: "high", systemPrompt: 'be "terse"', prompt: "go" }),
    ).toEqual([
      "--dangerously-bypass-hook-trust",
      "-m",
      "gpt-5",
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      'developer_instructions="be \\"terse\\""',
      "go",
    ]);
  });
});

describe("codexRunArgs", () => {
  test("SC8: resume and fork put the subcommand first and the thread id before the prompt", () => {
    const base = { prompt: "next", cwd: "/r" };
    expect(codexRunArgs({ ...base, session: { mode: "resume", id: "t1" } })).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "t1",
      "next",
    ]);
    expect(codexRunArgs({ ...base, session: { mode: "fork", id: "t1" } }).slice(0, 2)).toEqual([
      "exec",
      "fork",
    ]);
    expect(codexRunArgs({ ...base, model: "m" }, "/s.json")).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-m",
      "m",
      "--output-schema",
      "/s.json",
      "next",
    ]);
  });
});

type Created = { spec?: TerminalSpec };

const fakeHost = (created: Created): ITerminalHost => {
  const pane = { isAlive: () => Promise.resolve(true) } as unknown as ITerminal;
  return {
    checks: [],
    create: (spec) => {
      created.spec = spec;
      return Promise.resolve({ ok: true, value: pane });
    },
    find: () => pane,
    list: () => Promise.resolve([]),
  };
};

// A stand-in codex binary: prints fixed stdout, exits with a fixed code, and records its argv and
// the schema file's text (which is removed once the run ends).
const fakeCodex = (options: { stdout: string; stderr?: string; exitCode?: number }) => {
  const dir = mkdtempSync(join(tmpdir(), "fake-codex-"));
  const path = join(dir, "codex");
  const record = join(dir, "record.json");
  writeFileSync(
    path,
    `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const i = args.indexOf("--output-schema");
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, schemaFile: args[i + 1], schema: i < 0 ? null : readFileSync(args[i + 1], "utf8") }));
process.stdout.write(${JSON.stringify(options.stdout)});
process.stderr.write(${JSON.stringify(options.stderr ?? "")});
process.exit(${options.exitCode ?? 0});
`,
  );
  chmodSync(path, 0o755);
  return { path, record: () => JSON.parse(readFileSync(record, "utf8")) };
};

const jsonl = (...events: unknown[]): string =>
  `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
const started = { type: "thread.started", thread_id: "th-1" };
const message = (text: string) => ({
  type: "item.completed",
  item: { type: "agent_message", text },
});

const runWith = (
  binary: string,
  request: Partial<Parameters<ReturnType<typeof codexProvider>["run"]>[0]> = {},
) =>
  codexProvider({ host: fakeHost({}), binary }).run({
    prompt: "hi",
    cwd: process.cwd(),
    ...request,
  });

describe("codexProvider.run", () => {
  test("SC8: the last agent message is the output and the thread id the session", async () => {
    const fake = fakeCodex({
      stdout: jsonl(started, message("draft"), message("done"), { type: "turn.completed" }),
    });

    expect(await runWith(fake.path)).toEqual({ ok: true, output: "done", sessionId: "th-1" });
    expect(fake.record().args).toEqual(["exec", "--json", "--skip-git-repo-check", "hi"]);
  });

  test("SC8: an answer is parsed against outputFormat, through a schema file removed afterwards", async () => {
    const fake = fakeCodex({ stdout: jsonl(started, message('{"a":1}')) });
    const outputFormat = z.object({ a: z.number() });

    const result = await runWith(fake.path, { outputFormat });

    expect(result).toEqual({ ok: true, output: { a: 1 }, sessionId: "th-1" });
    const { schema, schemaFile } = fake.record();
    expect(JSON.parse(schema)).toMatchObject({ properties: { a: { type: "number" } } });
    expect(existsSync(schemaFile)).toBe(false);

    const bad = fakeCodex({ stdout: jsonl(started, message('{"a":"x"}')) });
    const failed = await runWith(bad.path, { outputFormat });
    expect(failed.ok === false && failed.error.message).toContain("codex result failed schema");
    expect(failed.sessionId).toBe("th-1");
  });

  test("SC8: turn.failed, error events, invalid JSONL and a non-zero exit are errors", async () => {
    const failed = await runWith(
      fakeCodex({ stdout: jsonl(started, { type: "turn.failed", error: { message: "no quota" } }) })
        .path,
    );
    expect(failed.ok === false && failed.error.message).toBe("no quota");
    expect(failed.sessionId).toBe("th-1");

    const errored = await runWith(
      fakeCodex({ stdout: jsonl({ type: "error", message: "bad" }) }).path,
    );
    expect(errored.ok === false && errored.error.message).toBe("bad");

    const invalid = await runWith(fakeCodex({ stdout: "not json\n" }).path);
    expect(invalid.ok === false && invalid.error.message).toContain("invalid JSONL");

    const stderr = `${"x".repeat(500)}SECRET_TAIL`;
    const exited = await runWith(fakeCodex({ stdout: jsonl(started), stderr, exitCode: 2 }).path);
    expect(exited.ok === false && exited.error.message).toContain("exited with code 2");
    expect(exited.ok === false && exited.error.message).not.toContain("SECRET_TAIL");
    expect(exited.sessionId).toBe("th-1");
  });
});

describe("codexProvider.launch", () => {
  test("puts the folder in the session's codex config as trusted before the pane starts", async () => {
    const home = mkdtempSync(join(tmpdir(), "yok-codex-home-"));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "yok-codex-cwd-")));
    const provider = codexProvider({ host: fakeHost({}), newId: () => "u1" });

    await provider.launch({ cwd, env: { CODEX_HOME: home } });

    expect(Bun.TOML.parse(readFileSync(join(home, "config.toml"), "utf8"))).toEqual({
      projects: { [cwd]: { trust_level: "trusted" } },
    });
  });

  test("names the tmux session by a fresh id and runs the codex binary with the launch argv", async () => {
    const created: Created = {};
    const provider = codexProvider({
      host: fakeHost(created),
      binary: "codex-x",
      newId: () => "u1",
    });

    const launched = await provider.launch({ cwd: "/repo", prompt: "go" });

    expect(launched.ok && launched.value.terminalName).toBe("u1");
    expect(created.spec).toMatchObject({
      name: "u1",
      cwd: "/repo",
      argv: ["codex-x", "--dangerously-bypass-hook-trust", "go"],
    });
  });

  test("SC13: the status bar runs the orchestrate script's statusline for the run in the launch env", async () => {
    const created: Created = {};
    const provider = codexProvider({ host: fakeHost(created), newId: () => "u1" });

    await provider.launch({
      cwd: "/repo",
      env: { YOK_RUN_ID: "r-9" },
      orchestrateArgv: ["bun", "/o/orchestrate.ts"],
    });

    expect(created.spec?.statusLine).toEqual([
      "bun",
      "/o/orchestrate.ts",
      "statusline",
      "--run-id",
      "r-9",
    ]);
  });

  test("SC13: without orchestrateArgv or a run id there is no status bar", async () => {
    const created: Created = {};
    const provider = codexProvider({ host: fakeHost(created), newId: () => "u1" });

    await provider.launch({ cwd: "/repo", env: { YOK_RUN_ID: "r-9" } });

    expect(created.spec?.statusLine).toBeUndefined();
  });

  test("SC620: with a session to continue it runs codex-x resume t-1 under the given terminal name, the prompt last and the status bar kept", async () => {
    const created: Created = {};
    const provider = codexProvider({
      host: fakeHost(created),
      binary: "codex-x",
      newId: () => "fresh",
    });

    const launched = await provider.launch({
      cwd: "/repo",
      model: "gpt-x",
      prompt: "$orchestrate --resume demo",
      env: { YOK_RUN_ID: "r-9" },
      orchestrateArgv: ARGV,
      continueSession: { id: "t-1", terminalName: "codex-demo-3c4d" },
    });

    expect(launched.ok && launched.value.terminalName).toBe("codex-demo-3c4d");
    const argv = created.spec?.argv ?? [];
    expect(created.spec?.name).toBe("codex-demo-3c4d");
    expect(argv.slice(0, 4)).toEqual([
      "codex-x",
      "resume",
      "t-1",
      "--dangerously-bypass-hook-trust",
    ]);
    expect(argv.slice(argv.indexOf("-m"), argv.indexOf("-m") + 2)).toEqual(["-m", "gpt-x"]);
    expect(argv.at(-1)).toBe("$orchestrate --resume demo");
    expect(created.spec?.statusLine).toEqual([...ARGV, "statusline", "--run-id", "r-9"]);
  });
});

type PaneCall = readonly [string, unknown];

const screenPane = (screen: string) => {
  const calls: PaneCall[] = [];
  const ok = (call: PaneCall) => {
    calls.push(call);
    return Promise.resolve({ ok: true as const, value: undefined });
  };
  const pane = {
    sendText: (text: string) => ok(["sendText", text]),
    sendKeys: (keys: readonly string[]) => ok(["sendKeys", keys]),
    capture: () => Promise.resolve({ ok: true as const, value: screen }),
    isAlive: () => Promise.resolve(true),
    kill: () => ok(["kill", null]),
    respawn: (spec: unknown) => ok(["respawn", spec]),
  } as unknown as ITerminal;
  return { pane, calls };
};

// What Codex 0.164 draws for its input box, colors kept: a bold ›, then a dim hint when it is empty.
const HINT_BOX = "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m";
const WORKING = "• Working (3s • esc to interrupt)";

describe("codexProvider.promptWhenReady", () => {
  const cases: readonly (readonly [string, string, boolean, "sent" | "not-ready"])[] = [
    ["an empty input marker", "header\n›\nfooter", false, "sent"],
    ["a box showing only Codex's dim hint", HINT_BOX, false, "sent"],
    ["a box holding typed text", "\x1b[1m›\x1b[0m half typed", false, "not-ready"],
    ["undimmed text after the marker", "› Ask Codex to do anything", false, "not-ready"],
    ["an empty marker while Codex works", `${WORKING}\n${HINT_BOX}`, false, "not-ready"],
    ["an empty marker while Codex works, sent while busy", `${WORKING}\n${HINT_BOX}`, true, "sent"],
    ["typed text while Codex works, sent while busy", `${WORKING}\n› half`, true, "not-ready"],
    ["no input marker at all", "Select an option\n1. Yes", false, "not-ready"],
  ];
  for (const [name, screen, whileBusy, expected] of cases) {
    test(`${name} is ${expected}`, async () => {
      const { pane, calls } = screenPane(screen);
      const result = await codexProvider({ host: fakeHost({}) }).promptWhenReady(pane, "continue", {
        whileBusy,
      });

      expect(result).toEqual({ ok: true, value: expected });
      expect(calls.length > 0).toBe(expected === "sent");
    });
  }
});

describe("codexProvider pane control", () => {
  test("stop kills the pane, and relaunch respawns codex in it with the launch argv", async () => {
    const provider = codexProvider({ host: fakeHost({}), binary: "codex-x" });
    const { pane, calls } = screenPane("");

    await provider.stop(pane);
    await provider.relaunch(pane, "s1", { cwd: "/repo", prompt: "go" });

    expect(calls).toEqual([
      ["kill", null],
      [
        "respawn",
        { cwd: "/repo", argv: ["codex-x", "--dangerously-bypass-hook-trust", "go"], env: {} },
      ],
    ]);
  });

  test("trusts the folder it respawns in", async () => {
    const home = mkdtempSync(join(tmpdir(), "yok-codex-home-"));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "yok-codex-cwd-")));
    const provider = codexProvider({ host: fakeHost({}) });

    await provider.relaunch(screenPane("").pane, "s1", { cwd, env: { CODEX_HOME: home } });

    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain(JSON.stringify(cwd));
  });

  test("SC29: a relaunch with resume is refused and respawns nothing", async () => {
    const provider = codexProvider({ host: fakeHost({}), binary: "codex-x" });
    const { pane, calls } = screenPane("");

    const result = await provider.relaunch(pane, "s-1", { cwd: "/repo", resume: true });

    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test("an aborted run is an error", async () => {
    const fake = fakeCodex({ stdout: jsonl(started, message("done")) });
    const controller = new AbortController();
    controller.abort();

    const result = await runWith(fake.path, { abortSignal: controller.signal });

    expect(result.ok === false && result.error.message).toBe("run aborted");
  });
});

describe("redactCodexRunArgs", () => {
  test("the prompt and developer instructions are hidden, every other argument kept", () => {
    const args = codexRunArgs({
      prompt: "my secret task",
      cwd: "/repo",
      model: "gpt-5",
      systemPrompt: "secret rules",
    });

    const redacted = redactCodexRunArgs(args);

    expect(redacted.join(" ")).not.toContain("secret");
    expect(redacted.at(-1)).toBe("[redacted]");
    expect(redacted.slice(0, 3)).toEqual(["exec", "--json", "--skip-git-repo-check"]);
    expect(redacted).toContain("gpt-5");
  });
});
