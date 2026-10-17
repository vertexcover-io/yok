import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "@yok/sdk";
import {
  checkServerUrl,
  followUpRun,
  isCurrentServer,
  resolveTarget,
  runningServer,
  shouldOpenBrowser,
  type Target,
} from "./client.ts";

const base = { noOpen: false, isTTY: true, env: {}, platform: "darwin" as NodeJS.Platform };

describe("shouldOpenBrowser", () => {
  test("SC5: opens only for a person at a terminal, outside CI, with a display on Linux", () => {
    const cases: readonly (readonly [string, Parameters<typeof shouldOpenBrowser>[0], boolean])[] =
      [
        ["plain terminal", base, true],
        ["--no-open", { ...base, noOpen: true }, false],
        ["no TTY", { ...base, isTTY: false }, false],
        ["CI unset", { ...base, env: {} }, true],
        ["CI empty", { ...base, env: { CI: "" } }, true],
        ["CI false", { ...base, env: { CI: "false" } }, true],
        ["CI true", { ...base, env: { CI: "true" } }, false],
        ["darwin without DISPLAY", { ...base, platform: "darwin" }, true],
        ["linux without display", { ...base, platform: "linux" }, false],
        ["linux with DISPLAY", { ...base, platform: "linux", env: { DISPLAY: ":0" } }, true],
        [
          "linux with WAYLAND_DISPLAY",
          { ...base, platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } },
          true,
        ],
      ];
    for (const [label, input, expected] of cases) {
      expect([label, shouldOpenBrowser(input)]).toEqual([label, expected]);
    }
  });
});

describe("followUpRun", () => {
  const attended = { interaction: true, open: true, attach: true, hasTerminal: true };

  test.each([
    ["an attended run at a terminal", attended, { noOpen: false, attach: true }],
    ["--no-open", { ...attended, open: false }, { noOpen: true, attach: true }],
    ["--no-attach", { ...attended, attach: false }, { noOpen: false, attach: false }],
    ["no terminal", { ...attended, hasTerminal: false }, { noOpen: false, attach: false }],
    ["an unattended run", { ...attended, interaction: false }, { noOpen: true, attach: false }],
  ])("%s: yok run gives %j", (_label, input, expected) => {
    expect(followUpRun(input)).toEqual(expected);
  });
});

describe("isCurrentServer", () => {
  const server = { pid: 1, version: "1.2.3", startedAt: 100 };

  test.each([
    [
      "keeps a server of this version started at or after replaceBefore",
      server,
      100,
      "1.2.3",
      true,
    ],
    ["replaces a server started before replaceBefore", server, 101, "1.2.3", false],
    [
      "replaces a server of another version, so an upgrade by Homebrew or npm takes effect",
      server,
      0,
      "1.2.4",
      false,
    ],
    ["starts a server when none is running", null, 0, "1.2.3", false],
  ])("%s", (_label, running, replaceBefore, version, expected) => {
    expect(isCurrentServer(running, replaceBefore, version)).toBe(expected);
  });
});

describe("resolveTarget", () => {
  const homeWith = (clientEnv: string | null): string => {
    const home = mkdtempSync(join(tmpdir(), "yok-target-"));
    if (clientEnv !== null) writeFileSync(join(home, "client.env"), clientEnv);
    return home;
  };
  const fileA = "YOK_SERVER_URL=https://a.example\nYOK_API_KEY=key-a\n";
  const cases: ReadonlyArray<readonly [string, NodeJS.ProcessEnv, string | null, Result<Target>]> =
    [
      ["nothing set is the local server", {}, null, { ok: true, value: { kind: "local" } }],
      [
        "client.env alone points at its server",
        {},
        fileA,
        { ok: true, value: { kind: "remote", url: "https://a.example", apiKey: "key-a" } },
      ],
      [
        "the environment wins over client.env",
        { YOK_SERVER_URL: "https://b.example", YOK_API_KEY: "key-b" },
        fileA,
        { ok: true, value: { kind: "remote", url: "https://b.example", apiKey: "key-b" } },
      ],
      [
        "a URL with no key anywhere is an error naming both",
        { YOK_SERVER_URL: "https://b.example" },
        null,
        { ok: false, error: "YOK_SERVER_URL is https://b.example, but YOK_API_KEY is not set" },
      ],
      [
        "a URL in the environment never takes client.env's key for another server",
        { YOK_SERVER_URL: "https://b.example" },
        fileA,
        { ok: false, error: "YOK_SERVER_URL is https://b.example, but YOK_API_KEY is not set" },
      ],
      [
        "a key alone in the environment does not replace client.env's key for its URL",
        { YOK_API_KEY: "key-b" },
        fileA,
        { ok: true, value: { kind: "remote", url: "https://a.example", apiKey: "key-a" } },
      ],
      [
        "a trailing slash is trimmed",
        { YOK_SERVER_URL: "https://h/", YOK_API_KEY: "k" },
        null,
        { ok: true, value: { kind: "remote", url: "https://h", apiKey: "k" } },
      ],
    ];

  test.each(cases)("SC401: %s", (_label, env, clientEnv, expected) => {
    expect(resolveTarget(homeWith(clientEnv), env)).toEqual(expected);
  });
});

describe("checkServerUrl", () => {
  test.each(["https://yok.example.com", "http://127.0.0.1:7420", "http://localhost:7420"])(
    "SC402: accepts %s",
    (url) => {
      expect(checkServerUrl(url)).toEqual({ ok: true, value: url });
    },
  );

  test.each(["http://yok.example.com", "not a url"])("SC402: refuses %s", (url) => {
    expect(checkServerUrl(url).ok).toBe(false);
  });
});

describe("runningServer", () => {
  test("a home pointed at a remote server has no running server here, whatever pid the remote reports", async () => {
    const remote = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ pid: process.pid, version: "1", startedAt: 0 }),
    });
    const home = mkdtempSync(join(tmpdir(), "yok-remote-"));
    writeFileSync(
      join(home, "client.env"),
      `YOK_SERVER_URL=http://127.0.0.1:${remote.port}\nYOK_API_KEY=k\n`,
    );
    writeFileSync(join(home, "server.pid"), String(process.pid));

    const running = await runningServer(home);
    await remote.stop(true);

    expect(running).toBeNull();
  });
});
