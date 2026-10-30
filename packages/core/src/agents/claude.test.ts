import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ITerminal,
  type ITerminalHost,
  jsonLogger,
  type Result,
  type TerminalSpec,
} from "@yok/sdk";
import * as z from "zod";
import {
  canTypeComment,
  claudeArgs,
  claudeProvider,
  claudeRunArgs,
  hasClaudeInputBox,
  interpretOutput,
  isClaudeBusy,
  isClaudeChoicePending,
} from "./claude.ts";
import { claudeSettings } from "./claude-hooks.ts";

describe("claudeArgs", () => {
  test("SC1: every option present puts the flags in order with prompt last", () => {
    expect(
      claudeArgs({
        model: "opus",
        effort: "high",
        permissionMode: "plan",
        systemPrompt: "be terse",
        name: "fix-login",
        prompt: "fix the bug",
      }),
    ).toEqual([
      "--model",
      "opus",
      "--effort",
      "high",
      "--permission-mode",
      "plan",
      "--append-system-prompt",
      "be terse",
      "--name",
      "fix-login",
      "fix the bug",
    ]);
  });

  test("SC2: omitted options add nothing, and no --session-id is ever passed", () => {
    expect(claudeArgs({})).toEqual([]);
  });

  test("SC24 — a hook command adds Claude settings with the Stop hook before the prompt", () => {
    const orchestrateArgv = ["/b", "/o.ts"];
    const args = claudeArgs({ orchestrateArgv, prompt: "go" });
    expect(args).toEqual(["--settings", expect.any(String), "go"]);
    expect(JSON.parse(args[1] ?? "")).toEqual(claudeSettings(orchestrateArgv));
  });

  test("SC63: a plugin folder adds --plugin-dir after --settings and before the prompt, and no plugin folder adds nothing", () => {
    const args = claudeArgs({
      pluginDir: "/repo",
      orchestrateArgv: ["/b", "orchestrate"],
      prompt: "go",
    });
    expect(args).toEqual(["--settings", expect.any(String), "--plugin-dir", "/repo", "go"]);
    expect(claudeArgs({ prompt: "go" })).toEqual(["go"]);
  });

  test("SC63: a plugin folder turns the installed yok@yok off in the one --settings, so only the folder's copy loads", () => {
    const orchestrateArgv = ["/b", "orchestrate"];
    const withHooks = claudeArgs({ pluginDir: "/repo", orchestrateArgv });
    expect(JSON.parse(withHooks[1] ?? "")).toEqual({
      ...claudeSettings(orchestrateArgv),
      enabledPlugins: { "yok@yok": false },
    });
    expect(claudeArgs({ pluginDir: "/repo" })).toEqual([
      "--settings",
      JSON.stringify({ enabledPlugins: { "yok@yok": false } }),
      "--plugin-dir",
      "/repo",
    ]);
  });
});

type Call =
  | { readonly method: "create"; readonly spec: TerminalSpec; readonly at: number }
  | {
      readonly method: "sendText";
      readonly pane: string;
      readonly text: string;
      readonly at: number;
    }
  | {
      readonly method: "sendKeys";
      readonly pane: string;
      readonly keys: readonly string[];
      readonly at: number;
    }
  | { readonly method: "kill"; readonly pane: string; readonly at: number }
  | {
      readonly method: "respawn";
      readonly pane: string;
      readonly spec: Omit<TerminalSpec, "name">;
      readonly at: number;
    };

const ok: Result<void> = { ok: true, value: undefined };

// A pane that records every call against its own name, and shows each of `screens` in turn.
const fakePane = (
  pane: string,
  calls: Call[],
  alive: boolean,
  screens: readonly string[] = [""],
): ITerminal => {
  let captures = 0;
  return {
    sendText: (text) => {
      calls.push({ method: "sendText", pane, text, at: Date.now() });
      return Promise.resolve(ok);
    },
    sendKeys: (keys) => {
      calls.push({ method: "sendKeys", pane, keys, at: Date.now() });
      return Promise.resolve(ok);
    },
    kill: () => {
      calls.push({ method: "kill", pane, at: Date.now() });
      return Promise.resolve(ok);
    },
    capture: () =>
      Promise.resolve({ ok: true, value: screens[Math.min(captures++, screens.length - 1)] ?? "" }),
    rename: () => Promise.resolve(ok),
    respawn: (spec) => {
      calls.push({ method: "respawn", pane, spec, at: Date.now() });
      return Promise.resolve(ok);
    },
    isAlive: () => Promise.resolve(alive),
    attachCommand: () => ["tmux", "attach-session", "-t", pane],
  };
};

const fakeHost = (
  options: { alive?: boolean; createOk?: boolean } = {},
): ITerminalHost & { calls: Call[] } => {
  const calls: Call[] = [];
  const alive = options.alive ?? true;
  return {
    calls,
    checks: [],
    create: (spec) => {
      calls.push({ method: "create", spec, at: Date.now() });
      return Promise.resolve(
        options.createOk === false
          ? { ok: false, error: "boom" }
          : { ok: true, value: fakePane(spec.name, calls, alive) },
      );
    },
    find: (name) => fakePane(name, calls, alive),
    list: () => Promise.resolve([]),
  };
};

describe("claudeProvider.prompt", () => {
  test("SC6: a session whose isAlive is false returns ok:false and sends nothing", async () => {
    const host = fakeHost({ alive: false });
    const provider = claudeProvider({ host, newId: () => "s1" });

    const result = await provider.prompt(host.find("s1"), "hello");

    expect(result).toEqual({ ok: false, error: "the agent's terminal is not running" });
    expect(host.calls).toHaveLength(0);
  });

  test("SC7: a live session sends the text into its own pane, then Enter at least 150ms later", async () => {
    const host = fakeHost({ alive: true });
    const provider = claudeProvider({ host, newId: () => "s1" });

    const result = await provider.prompt(host.find("s1"), "hello");

    expect(result).toEqual({ ok: true, value: undefined });
    expect(host.calls.map((c) => c.method)).toEqual(["sendText", "sendKeys"]);
    const [sendText, sendKeys] = host.calls;
    expect(sendText).toMatchObject({ method: "sendText", pane: "s1", text: "hello" });
    expect(sendKeys).toMatchObject({ method: "sendKeys", keys: ["Enter"] });
    expect((sendKeys?.at ?? 0) - (sendText?.at ?? 0)).toBeGreaterThanOrEqual(149);
  });
});

describe("claudeProvider.launch", () => {
  test("a terminal that fails to create the session returns ok:false", async () => {
    const provider = claudeProvider({
      host: fakeHost({ createOk: false }),
      newId: () => "s1",
    });

    expect(await provider.launch({ cwd: "/repo" })).toEqual({ ok: false, error: "boom" });
  });

  test("returns the pane it created, so a later prompt and stop reach it without a name lookup", async () => {
    const host = fakeHost();
    const provider = claudeProvider({ host, newId: () => "s1" });

    const launched = await provider.launch({ cwd: "/repo" });
    if (!launched.ok) throw new Error(launched.error);
    await provider.prompt(launched.value.terminal, "hello");
    await provider.stop(launched.value.terminal);

    expect(launched.value.terminalName).toBe("s1");
    expect(host.calls.map((c) => [c.method, "pane" in c ? c.pane : c.spec.name])).toEqual([
      ["create", "s1"],
      ["sendText", "s1"],
      ["sendKeys", "s1"],
      ["kill", "s1"],
    ]);
  });

  test("SC601: with a session to continue it runs claude --resume s-1 --model opus-x under the given terminal name, never minting an id", async () => {
    const host = fakeHost();
    const minted: string[] = [];
    const provider = claudeProvider({
      host,
      binary: "claude",
      newId: () => {
        minted.push("id");
        return "fresh";
      },
    });

    const launched = await provider.launch({
      cwd: "/repo",
      model: "opus-x",
      prompt: "/yok:orchestrate --resume demo",
      continueSession: { id: "s-1", terminalName: "claude-demo-3c4d" },
    });

    if (!launched.ok) throw new Error(launched.error);
    expect(launched.value.terminalName).toBe("claude-demo-3c4d");
    const [call] = host.calls;
    const spec = call?.method === "create" ? call.spec : undefined;
    expect(spec?.name).toBe("claude-demo-3c4d");
    expect(spec?.argv.slice(0, 5)).toEqual(["claude", "--resume", "s-1", "--model", "opus-x"]);
    expect(spec?.argv.at(-1)).toBe("/yok:orchestrate --resume demo");
    expect(minted).toEqual([]);
  });
  test("puts the folder in the session's Claude config as trusted before the pane starts", async () => {
    const home = mkdtempSync(join(tmpdir(), "yok-claude-home-"));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "yok-claude-cwd-")));
    const provider = claudeProvider({ host: fakeHost(), newId: () => "s1" });

    await provider.launch({ cwd, env: { CLAUDE_CONFIG_DIR: home } });

    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))).toEqual({
      projects: { [cwd]: { hasTrustDialogAccepted: true } },
    });
  });
});

describe("claudeProvider.relaunch", () => {
  test("replaces the program in the pane with claude on the given session id and first prompt", async () => {
    const host = fakeHost();
    const provider = claudeProvider({ host, binary: "/bin/claude", newId: () => "unused" });

    const result = await provider.relaunch(host.find("%3"), "s-new", {
      cwd: "/repo",
      prompt: "/orchestrate --resume feat-x",
      env: { YOK_RUN_ID: "r-1" },
      orchestrateArgv: ["/usr/bin/bun", "/o.ts"],
    });

    expect(result).toEqual({ ok: true, value: undefined });
    const [call] = host.calls;
    expect(call).toMatchObject({ method: "respawn", pane: "%3" });
    const spec = call?.method === "respawn" ? call.spec : undefined;
    expect(spec?.cwd).toBe("/repo");
    expect(spec?.env).toEqual({ YOK_RUN_ID: "r-1" });
    expect(spec?.argv.slice(0, 3)).toEqual(["/bin/claude", "--session-id", "s-new"]);
    expect(spec?.argv).toContain("--settings");
    expect(spec?.argv.at(-1)).toBe("/orchestrate --resume feat-x");
  });

  test("SC28: with resume it respawns claude --resume s-1 --model opus-x, without it claude --session-id s-1", async () => {
    const argvOf = async (resume?: boolean) => {
      const host = fakeHost();
      const provider = claudeProvider({ host, binary: "claude", newId: () => "unused" });
      await provider.relaunch(host.find("%3"), "s-1", {
        cwd: "/repo",
        model: "opus-x",
        ...(resume === undefined ? {} : { resume }),
      });
      const [call] = host.calls;
      return call?.method === "respawn" ? call.spec.argv : [];
    };

    expect((await argvOf(true)).slice(0, 5)).toEqual([
      "claude",
      "--resume",
      "s-1",
      "--model",
      "opus-x",
    ]);
    expect((await argvOf()).slice(0, 3)).toEqual(["claude", "--session-id", "s-1"]);
  });
  test("trusts the folder it respawns in", async () => {
    const home = mkdtempSync(join(tmpdir(), "yok-claude-home-"));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "yok-claude-cwd-")));
    const host = fakeHost();
    const provider = claudeProvider({ host, newId: () => "unused" });

    await provider.relaunch(host.find("%3"), "s-1", { cwd, env: { CLAUDE_CONFIG_DIR: home } });

    expect(readFileSync(join(home, ".claude.json"), "utf8")).toContain(JSON.stringify(cwd));
  });
});

describe("claudeProvider.launch logging", () => {
  test("SC37: no log line contains the prompt or system-prompt text", async () => {
    const lines: string[] = [];
    const log = jsonLogger({ level: "debug", write: (line) => lines.push(line) });
    const provider = claudeProvider({ host: fakeHost(), log, newId: () => "s1" });

    await provider.launch({
      cwd: "/repo",
      prompt: "SECRET_PROMPT_TEXT",
      systemPrompt: "SECRET_SYSTEM_PROMPT_TEXT",
    });

    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain("SECRET_PROMPT_TEXT");
    expect(serialized).not.toContain("SECRET_SYSTEM_PROMPT_TEXT");
  });
});

const outputSchema = z.object({ a: z.number() });
const outputJsonSchema = JSON.stringify(z.toJSONSchema(outputSchema));

describe("claudeRunArgs", () => {
  const head = ["-p", "hi", "--output-format", "json"];
  const schemaArgs = ["--json-schema", outputJsonSchema];
  const resume = ["--resume", "s1"];
  const fork = [...resume, "--fork-session"];

  test.each([
    ["no session behaves like a new one", undefined, false, []],
    ["a new session", { mode: "new" }, false, []],
    ["a new session with a schema", { mode: "new" }, true, schemaArgs],
    ["a resumed session", { mode: "resume", id: "s1" }, false, resume],
    [
      "a resumed session with a schema",
      { mode: "resume", id: "s1" },
      true,
      [...resume, ...schemaArgs],
    ],
    ["a forked session", { mode: "fork", id: "s1" }, false, fork],
    ["a forked session with a schema", { mode: "fork", id: "s1" }, true, [...fork, ...schemaArgs]],
  ] as const)("SC25: %s", (_name, session, withSchema, tail) => {
    const request = {
      prompt: "hi",
      cwd: "/repo",
      ...(session === undefined ? {} : { session }),
      ...(withSchema ? { outputFormat: outputSchema } : {}),
    };
    expect(claudeRunArgs(request)).toEqual([...head, ...tail]);
  });
});

describe("interpretOutput", () => {
  const out = (fields: Record<string, unknown>): string => JSON.stringify(fields);
  const plain = out({ result: "x", session_id: "s", is_error: false });

  test.each([
    ["stdout that is not JSON", "oops", undefined, "invalid JSON output"],
    [
      "output with no session_id",
      out({ result: "hi", is_error: false }),
      undefined,
      "missing session_id",
    ],
    ["a result that is not JSON under a schema", plain, outputSchema, "not valid JSON"],
  ] as const)("%s is ok:false", (_name, stdout, schema, message) => {
    const result = interpretOutput({ code: 0, stdout, stderr: "" }, schema);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : String(result.error)).toContain(message);
  });

  test("a plain result with no schema is returned as text", () => {
    expect(
      interpretOutput({
        code: 0,
        stdout: out({ result: "hi", session_id: "s", is_error: false }),
        stderr: "",
      }),
    ).toEqual({
      ok: true,
      output: "hi",
      sessionId: "s",
    });
  });

  test.each([
    ["long non-JSON stdout", 0, "stdout"],
    ["a non-zero exit with long stderr", 1, "stderr"],
  ] as const)(
    "%s is capped, never logging what follows the first 200 chars",
    (_label, code, stream) => {
      const long = `${"x".repeat(5000)}SECRET_TAIL`;
      const result = interpretOutput({
        code,
        stdout: stream === "stdout" ? long : "oops",
        stderr: stream === "stderr" ? long : "",
      });

      expect(result.ok).toBe(false);
      const message = result.ok ? "" : String(result.error);
      expect(message).not.toContain("SECRET_TAIL");
      expect(message).toContain(`${long.length}`);
    },
  );
});

// Writes a temporary executable that prints fixed stdout and exits with a fixed code,
// standing in for the real claude binary.
const fakeClaudeBinary = (options: { stdout: string; exitCode?: number }): string => {
  const path = join(mkdtempSync(join(tmpdir(), "fake-claude-")), "claude");
  writeFileSync(
    path,
    `#!/usr/bin/env bun\nprocess.stdout.write(${JSON.stringify(options.stdout)});\nprocess.exit(${options.exitCode ?? 0});\n`,
  );
  chmodSync(path, 0o755);
  return path;
};

describe("claudeProvider.run", () => {
  test("SC26: a well-formed result parses against the given schema", async () => {
    const binary = fakeClaudeBinary({
      stdout: JSON.stringify({
        result: JSON.stringify({ a: 1 }),
        session_id: "s",
        is_error: false,
      }),
    });
    const provider = claudeProvider({ host: fakeHost(), binary });

    const result = await provider.run({
      prompt: "hi",
      cwd: process.cwd(),
      outputFormat: outputSchema,
    });

    expect(result).toEqual({ ok: true, output: { a: 1 }, sessionId: "s" });
  });

  test.each([
    ["is_error: true", { result: "boom", session_id: "s", is_error: true }, 0, undefined],
    [
      "a non-zero exit with an otherwise well-formed body",
      { result: "ok", session_id: "s", is_error: false },
      2,
      undefined,
    ],
    [
      "a result failing the schema",
      { result: JSON.stringify({ a: "nope" }), session_id: "s", is_error: false },
      0,
      outputSchema,
    ],
  ] as const)(
    "SC27: %s fails, carrying the session id it reported",
    async (_label, body, exitCode, outputFormat) => {
      const binary = fakeClaudeBinary({ stdout: JSON.stringify(body), exitCode });
      const provider = claudeProvider({ host: fakeHost(), binary });

      const result = await provider.run({
        prompt: "hi",
        cwd: process.cwd(),
        ...(outputFormat === undefined ? {} : { outputFormat }),
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.sessionId).toBe("s");
    },
  );
});

describe("isClaudeBusy", () => {
  test.each([
    ["· Vibing… (3s · ↓ 136 tokens)", true],
    ["✢ Compacting conversation… (15s · ↓ 637 tokens)", true],
    ["  Press up to edit queued messages\n❯ ", true],
    [box("❯ Press up to edit queued messages"), true],
    ["❯ keep only the user's typed or queued messages, newest first\n❯ ", false],
    ["✻ Churned for 8s · done 4:40 PM\n❯ ", false],
    ["❯ ", false],
  ])("SC22: %j is busy: %p", (screen, busy) => {
    expect(isClaudeBusy(screen)).toBe(busy);
  });
});

const RULE = "─".repeat(40);
const box = (line: string): string => `${RULE}\n${line}\n${RULE}`;
// Claude 2.1.286's empty input box, with its status line below.
const PROMPT = `${RULE}\n❯\n${RULE}\n  Model: Opus | Ctx Used: 8.0%`;
// After /name, Claude Code 2.1.310 draws the session's name into the rule above its input box.
const NAMED_RULE = `${RULE} fix-login ─`;
const NAMED_PROMPT = `${NAMED_RULE}\n❯\n${RULE}\n  Model: Opus | Ctx Used: 8.0%`;
const LIMIT_MENU = [
  "What do you want to do?",
  "❯ 1. Upgrade your plan",
  "  2. Stop and wait for limit to reset",
  "Enter to confirm · Esc to cancel",
].join("\n");

describe("claudeProvider.limitResetWait", () => {
  test("reads the reset from the error message, else from the limit banner on the pane's screen", async () => {
    const now = new Date("2026-10-01T13:00:00Z");
    const provider = claudeProvider({ host: fakeHost() });
    const pane = fakePane("p", [], true, [`● You've hit your limit · resets 4pm (UTC)\n${PROMPT}`]);
    const hour = 3_600_000;
    expect(await provider.limitResetWait(pane, "resets 3pm (UTC)", now)).toEqual({
      ms: 2 * hour + 60_000,
      from: "message",
    });
    expect(await provider.limitResetWait(pane, "Usage limit reached", now)).toEqual({
      ms: 3 * hour + 60_000,
      from: "screen",
    });
  });
});

describe("claudeProvider.promptWhenReady", () => {
  const typedInto = async (...screens: readonly string[]) => {
    const calls: Call[] = [];
    const provider = claudeProvider({ host: fakeHost() });
    const result = await provider.promptWhenReady(fakePane("p", calls, true, screens), "continue");
    const typed = calls.map((c) =>
      c.method === "sendText" ? c.text : c.method === "sendKeys" ? c.keys : c.method,
    );
    return { result, typed };
  };
  const SENT = [["C-u"], "continue", ["Enter"]];

  test.each([
    ["an empty input box", [`● Done.\n${PROMPT}`]],
    [
      "a numbered list in Claude's reply above the input box",
      [`1. Fixed the bug\n2. Added a test\n${PROMPT}`],
    ],
  ])("%s: the input is cleared and the text submitted", async (_, screens) => {
    expect(await typedInto(...screens)).toEqual({
      result: { ok: true, value: "sent" },
      typed: SENT,
    });
  });

  test("an open limit menu is answered with Stop and wait before the text is typed", async () => {
    expect(await typedInto(LIMIT_MENU, PROMPT)).toEqual({
      result: { ok: true, value: "sent" },
      typed: [["Down", "Enter"], ...SENT],
    });
  });

  test.each([
    ["a draft in the input box", `${RULE}\n❯ half a message\n${RULE}`],
    ["a permission dialog", "Do you want to run this command?\n❯ 1. Yes\n  2. No"],
    [
      "an unnumbered dialog",
      "Monthly spend limit reached\n❯ Adjust monthly spend limit: $20.00\n  Wait for limit to reset",
    ],
    [
      "a dialog showing only its footer",
      "Do you want to proceed?\nEnter to confirm · Esc to cancel",
    ],
    ["Claude at work above its input box", `· Vibing… (3s)\n${PROMPT}`],
    ["a bare ❯ outside the input box", "● Done.\n❯\n  ? for shortcuts"],
    [
      "a live limit menu without Stop and wait",
      "What do you want to do?\n❯ 1. Upgrade your plan\n  2. Ask your admin",
    ],
  ])("%s: nothing is typed and the answer is not-ready", async (_, screen) => {
    expect(await typedInto(screen)).toEqual({
      result: { ok: true, value: "not-ready" },
      typed: [],
    });
  });
});

describe("canTypeComment", () => {
  test.each([
    ["idle empty box", PROMPT, true],
    [
      "spinner above an empty box",
      `· Ionizing… (6s · ↓ 359 tokens)\n${box("❯")}\n  Model: Opus`,
      true,
    ],
    ["menu footer", `${PROMPT}\nEnter to select · ↑/↓ to navigate · Esc to cancel`, false],
    ["half-typed text", box("❯ half a sentence"), false],
    ["queued-messages hint", box("❯ Press up to edit queued messages"), false],
    [
      "an empty ❯ between rules above the bottom box, which holds text",
      `${box("❯")}\n${box("❯ half")}`,
      false,
    ],
    ["a named session's empty box under a spinner", `· Ionizing… (6s)\n${NAMED_PROMPT}`, true],
  ])("SC14: %s -> %p", (_name, screen, expected) => {
    expect(canTypeComment(screen)).toBe(expected);
  });
});

// What Claude 2.1.309 shows at the bottom of its pane for a permission asked mid-turn: no spinner
// and no input box.
const PERMISSION_PROMPT = [
  RULE,
  " Bash command",
  ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
  " Create empty perm-probe.txt file",
  "╌".repeat(40),
  " │ touch /tmp/perm-probe.txt",
  "╌".repeat(40),
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and always allow access to /tmp from this project",
  "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
  "   4. No",
  " Esc to cancel · Tab to amend",
].join("\n");
const QUESTION = [
  RULE,
  " Which colour?",
  " ❯ 1. Red",
  "   2. Blue",
  " Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

describe("isClaudeChoicePending", () => {
  test.each([
    ["a permission prompt", `● Creating the file.\n${PERMISSION_PROMPT}`, true],
    ["a question", QUESTION, true],
    ["a permission option between rules", `${box("❯ 1. Yes")}\n  2. No`, true],
    [
      "an answered prompt left in scrollback above the box",
      `${PERMISSION_PROMPT}\n● Created the file.\n${PROMPT}`,
      false,
    ],
    [
      "the /config popup",
      "  Theme  Dark\nEnter/Space to change · / to search · Esc to close",
      false,
    ],
    ["a box under a spinner", `· Ionizing… (6s)\n${box("❯ ")}`, false],
    [
      "a numbered list in Claude's reply above the box",
      `1. Fixed it\n2. Tested it\n${PROMPT}`,
      false,
    ],
  ])("%s -> %p", (_name, screen, expected) => {
    expect(isClaudeChoicePending(screen)).toBe(expected);
  });
});

describe("hasClaudeInputBox", () => {
  test.each([
    ["an empty box", PROMPT, true],
    ["a box holding text", box("❯ half a sentence"), true],
    ["a box under a spinner", `· Ionizing… (6s · ↓ 359 tokens)\n${box("❯ ")}`, true],
    [
      "the /config popup",
      "  Theme  Dark\nEnter/Space to change · / to search · Esc to close",
      false,
    ],
    ["the limit menu", LIMIT_MENU, false],
    ["a ❯ with no rules around it", "❯ ", false],
    [
      "a box under transcript text quoting a dialog footer",
      `● Its footer reads Enter to select · Esc to cancel.\n${PROMPT}`,
      true,
    ],
    [
      "a permission dialog whose ❯ 1. Yes sits between rules",
      `${box("❯ 1. Yes")}\n  2. No\nEsc to cancel · Tab to amend`,
      false,
    ],
    [
      "an AskUserQuestion dialog",
      `Which colour?\n${box("❯ 1. Red")}\n  2. Blue\nEnter to select · ↑/↓ to navigate · Esc to cancel`,
      false,
    ],
    [
      "a box left in scrollback above the /config popup with its search box focused",
      `${PROMPT}\n  Search settings\nType to filter · Enter/↓ to select · ↑ to tabs · Esc to clear`,
      false,
    ],
    [
      "a box left in scrollback above the /config popup's list",
      `${PROMPT}\n  Theme  Dark\nEnter/Space to change · / to search · Esc to close`,
      false,
    ],
    [
      "a box with Claude's interrupt hint under it while it works",
      `${box("❯ ")}\n  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt`,
      true,
    ],
    ["a box with Claude's shortcuts hint under it", `${box("❯ ")}\n  ? for shortcuts`, true],
    [
      "a permission dialog whose ❯ 1. Yes sits between rules above a footer yok does not know",
      `${box("❯ 1. Yes")}\n  2. No\n  Tab to amend`,
      false,
    ],
    ["a box holding a cancelled /compact", box("❯ /compact keep the plan"), true],
    [
      "a dialog whose footer reads Enter to select with no Esc to cancel",
      `Which colour?\n${box("❯ 1. Red")}\n  2. Blue\nEnter to select · ↑/↓ to navigate`,
      false,
    ],
    ["a named session's box, its name drawn in the top rule", NAMED_PROMPT, true],
    // In a pane narrow for the name, Claude draws fewer dashes before it, or none and cuts it.
    [
      "a named session's box in a narrow pane, five dashes before the name",
      `───── add-retry-to-the-webhook-delivery-worker ─\n❯\n${RULE}`,
      true,
    ],
    [
      "a named session's box in a pane too narrow for the name, no dashes before it",
      ` add-retry-to-the-webhook-delivery-wo… ─\n❯\n${RULE}`,
      true,
    ],
    [
      "a ❯ under a transcript line that starts with dashes",
      `${"─".repeat(20)} notes\n❯\n${RULE}`,
      false,
    ],
    [
      "a named session's permission dialog whose ❯ 1. Yes sits between rules",
      `${NAMED_RULE}\n❯ 1. Yes\n${RULE}\n  2. No\nEsc to cancel · Tab to amend`,
      false,
    ],
  ])("%s -> %p", (_name, screen, expected) => {
    expect(hasClaudeInputBox(screen)).toBe(expected);
  });
});
