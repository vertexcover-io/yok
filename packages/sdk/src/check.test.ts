import { describe, expect, test } from "bun:test";
import type { CheckContext, ExecResult } from "./check.ts";
import { checkBinary } from "./check.ts";

const context = (result: ExecResult): CheckContext => ({
  root: "/repo",
  exec: () => Promise.resolve(result),
});

describe("checkBinary", () => {
  test("a binary that exits 0 is ok with the first line of its version output", async () => {
    const run = checkBinary("git");
    const outcome = await run(
      context({ code: 0, stdout: "git version 2.43.0\nextra line\n", stderr: "" }),
    );
    expect(outcome).toEqual({ status: "ok", detail: "git version 2.43.0" });
  });

  test("a binary that exits non-zero fails with 'not on PATH'", async () => {
    const run = checkBinary("ffmpeg", ["-version"]);
    const outcome = await run(context({ code: 127, stdout: "", stderr: "" }));
    expect(outcome).toEqual({ status: "fail", detail: "not on PATH" });
  });
});
