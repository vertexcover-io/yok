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

describe("isCurrentServer", () => {
  const server = { pid: 1, version: "1.2.3", startedAt: 100 };

  test("keeps a server of this version started at or after replaceBefore", () => {
    expect(isCurrentServer(server, 100, "1.2.3")).toBe(true);
  });

  test("replaces a server started before replaceBefore", () => {
    expect(isCurrentServer(server, 101, "1.2.3")).toBe(false);
  });

  test("replaces a server of another version, so an upgrade by Homebrew or npm takes effect", () => {
    expect(isCurrentServer(server, 0, "1.2.4")).toBe(false);
  });

  test("starts a server when none is running", () => {
    expect(isCurrentServer(null, 0, "1.2.3")).toBe(false);
  });
});
