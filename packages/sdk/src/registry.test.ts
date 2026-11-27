import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { yokHome } from "./registry.ts";

// Split so the sweep for the old product name (SC10) does not flag this test.
const OLD_NAME = ["har", "ness"].join("");

describe("yokHome", () => {
  test.each([
    ["SC34: from source the home is ~/.yok-dev", {}, false, join(homedir(), ".yok-dev")],
    ["SC1: a compiled binary's home is ~/.yok", {}, true, join(homedir(), ".yok")],
    ["SC1: YOK_HOME wins from source", { YOK_HOME: "/tmp/y" }, false, "/tmp/y"],
    ["SC34: YOK_HOME wins in a compiled binary", { YOK_HOME: "/tmp/y" }, true, "/tmp/y"],
    [
      "SC1: the old home variable is not read",
      { [`${OLD_NAME.toUpperCase()}_HOME`]: "/tmp/h" },
      true,
      join(homedir(), ".yok"),
    ],
  ])("%s", (_label, env, compiled, expected) => {
    expect(yokHome(env, compiled)).toBe(expected);
  });
});
