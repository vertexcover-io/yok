import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Exec, type ITerminalHost, noopLogger } from "@yok/sdk";
import { agentProvider, findSessionAgent } from "./index.ts";
import { yokTerminalHost } from "./tmux.ts";

describe("findSessionAgent", () => {
  const sessions = [
    { agent: "claude" as const, sessionId: "c1" },
    { agent: "codex" as const, sessionId: "x1" },
    { agent: "pi" as const, sessionId: "p1" },
  ];

  test.each([
    ["a linked codex session", "x1", "codex"],
    ["a linked claude session", "c1", "claude"],
    ["an unlinked session", "nope", undefined],
    ["a session whose agent has no provider", "p1", undefined],
  ] as const)("%s gives %p", (_label, sessionId, agent) => {
    expect(findSessionAgent(sessions, sessionId)).toBe(agent);
  });
});

describe("agentProvider", () => {
  test("each workflow agent gets a provider of its own type", () => {
    const host = yokTerminalHost({}, noopLogger);
    for (const agent of ["claude", "codex"] as const) {
      expect(agentProvider({ agent, host, env: {}, log: noopLogger }).type).toBe(agent);
    }
  });
});

// Records what each launch would run, and starts nothing.
const recordingHost = (argvs: (readonly string[])[]): ITerminalHost => ({
  checks: [],
  create: (spec) => {
    argvs.push(spec.argv);
    return Promise.resolve({ ok: false, error: "not started" });
  },
  find: () => {
    throw new Error("no pane in this test");
  },
  list: () => Promise.resolve([]),
});

describe("agentProvider binaries", () => {
  test("SC5: YOK_CLAUDE_BIN and YOK_CODEX_BIN choose the program each provider checks and launches", async () => {
    const env = {
      YOK_CLAUDE_BIN: "/bin/fake-claude",
      YOK_CODEX_BIN: "/bin/fake-codex",
      YOK_CLAUDE_CONFIG: join(mkdtempSync(join(tmpdir(), "yok-claude-config-")), ".claude.json"),
    };
    const cases = [
      { agent: "claude", binary: "/bin/fake-claude" },
      { agent: "codex", binary: "/bin/fake-codex" },
    ] as const;
    for (const { agent, binary } of cases) {
      const checked: string[] = [];
      const exec: Exec = (command) => {
        checked.push(command);
        return Promise.resolve({ code: 0, stdout: "1.0.0", stderr: "" });
      };
      const launched: (readonly string[])[] = [];
      const provider = agentProvider({
        agent,
        host: recordingHost(launched),
        env,
        log: noopLogger,
      });

      await Promise.all(provider.checks.map((check) => check.run({ root: "/repo", exec })));
      await provider.launch({ cwd: "/repo" });

      expect(checked).toEqual([binary]);
      expect(launched.map((argv) => argv[0])).toEqual([binary]);
    }
  });
});
