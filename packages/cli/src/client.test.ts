import { describe, expect, test } from "bun:test";
import { isCurrentServer, shouldOpenBrowser } from "./client.ts";

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
