import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@yok/sdk/internal";
import {
  checkRemoteFlag,
  checkServerUrl,
  connect,
  isCurrentServer,
  shouldOpenBrowser,
  yokClient,
} from "./client.ts";

const base = { noOpen: false, isTTY: true, env: {}, platform: "darwin" as NodeJS.Platform };

describe("shouldOpenBrowser", () => {
  test("SC5: opens only for a person at a terminal, outside CI, with a display on Linux", () => {
    const cases: readonly (readonly [string, Parameters<typeof shouldOpenBrowser>[0], boolean])[] =
      [
        ["plain terminal", base, true],
        ["--no-open", { ...base, noOpen: true }, false],
        ["no TTY", { ...base, isTTY: false }, false],
        ["CI empty", { ...base, env: { CI: "" } }, true],
        ["CI false", { ...base, env: { CI: "false" } }, true],
        ["CI true", { ...base, env: { CI: "true" } }, false],
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

describe("checkRemoteFlag", () => {
  test("SC5005: ls with remote=true passes, needing no --project", () => {
    expect(() => checkRemoteFlag(true, "ls")).not.toThrow();
  });

  test.each([
    ["run", true],
    ["project add", true],
    ["trigger fire", true],
    ["doctor", true],
    ["login", true],
    ["login", false],
    ["logout", true],
    ["logout", false],
    ["server status", true],
    ["resume", true],
    ["retry", true],
    ["run", false],
    ["attach", false],
    ["server start", false],
  ])("SC4024, SC7110: %s with remote=%p passes", (path, remote) => {
    expect(() => checkRemoteFlag(remote, path)).not.toThrow();
  });

  test.each([
    [
      "attach",
      true,
      "yok attach works only on this machine: run it as yok attach, without --remote",
    ],
    [
      "orchestrate done",
      true,
      "yok orchestrate done works only on this machine: run it as yok orchestrate done, without --remote",
    ],
    [
      "server start",
      true,
      "yok server start works only on the server's machine: run it there, without --remote",
    ],
    [
      "server stop",
      true,
      "yok server stop works only on the server's machine: run it there, without --remote",
    ],
  ])("SC4025: %s with remote=%p is refused with its own line", (path, remote, message) => {
    expect(() => checkRemoteFlag(remote, path)).toThrow(message);
  });

  test("SC601: yok rm with --remote is refused, as it works only on this machine", () => {
    expect(() => checkRemoteFlag(true, "rm")).toThrow(
      "yok rm works only on this machine: run it as yok rm, without --remote",
    );
  });

  test("SC701: yok import-files with --remote is refused before anything is read, as it opens this machine's yok.db", () => {
    expect(() => checkRemoteFlag(true, "import-files")).toThrow(
      "yok import-files works only on this machine: run it as yok import-files, without --remote",
    );
  });
});

const homes: string[] = [];
afterAll(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

// A gated yok server: health is open, every other route answers 401 as requireCaller does.
const refusingServer = () =>
  Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) =>
      new URL(request.url).pathname === "/api/health"
        ? Response.json({ pid: 1, version: VERSION, startedAt: 1 })
        : Response.json(
            { error: { code: "unauthenticated", message: "sign in" } },
            { status: 401 },
          ),
  });

describe("a 401 from a gated server", () => {
  test("SC28 (CLI): a plain local command is told to run yok login and use --remote", async () => {
    const server = refusingServer();
    const home = mkdtempSync(join(tmpdir(), "yok-401-home-"));
    homes.push(home);
    writeFileSync(join(home, "server.port"), String(server.port));
    writeFileSync(join(home, ".env"), "SERVER_DOMAIN=yok.example.com\n");

    const listed = await yokClient(home).projects();
    server.stop(true);

    expect(listed).toEqual({
      ok: false,
      error: {
        code: "unauthenticated",
        message:
          "this server needs you signed in: run yok login --server https://yok.example.com, then use --remote on your commands",
      },
    });
  });

  test("a --remote command is told to run yok login --server URL again", async () => {
    const server = refusingServer();
    const home = mkdtempSync(join(tmpdir(), "yok-401-home-"));
    homes.push(home);
    const url = `http://127.0.0.1:${server.port}`;
    const env = { YOK_SERVER_URL: url, YOK_SERVER_TOKEN: "yok_revoked" };

    const { client } = await connect(env, home);
    const listed = await client.projects();
    server.stop(true);

    expect(listed.ok ? "" : listed.error.message).toBe(
      `the server did not accept this login: run yok login --server ${url}`,
    );
  });
});
