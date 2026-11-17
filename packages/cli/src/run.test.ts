import { describe, expect, test } from "bun:test";
import { followUps, runPick } from "./run.ts";

describe("followUps", () => {
  test("SC511: only --no-open, --no-attach and the terminal decide the browser and the attach", () => {
    const cases: readonly (readonly [
      string,
      Parameters<typeof followUps>[0],
      ReturnType<typeof followUps>,
    ])[] = [
      [
        "defaults at a terminal",
        { open: true, attach: true, hasTerminal: true },
        { noOpen: false, attach: true },
      ],
      [
        "--no-open",
        { open: false, attach: true, hasTerminal: true },
        { noOpen: true, attach: true },
      ],
      [
        "--no-attach",
        { open: true, attach: false, hasTerminal: true },
        { noOpen: false, attach: false },
      ],
      [
        "no terminal",
        { open: true, attach: true, hasTerminal: false },
        { noOpen: false, attach: false },
      ],
    ];
    for (const [label, input, expected] of cases) {
      expect([label, followUps(input)]).toEqual([label, expected]);
    }
  });
});

describe("runPick", () => {
  test.each<[string, Parameters<typeof runPick>, ReturnType<typeof runPick>]>([
    [
      "--run-id r-1 wins over a name",
      ["demo", { runId: "r-1" }, {}, true],
      { ok: true, value: { id: "r-1" } },
    ],
    [
      "a name with --project web",
      ["demo", { project: "web" }, {}, true],
      { ok: true, value: { project: "web", name: "demo" } },
    ],
    [
      "no name, with YOK_RUN_ID=r-2",
      [undefined, {}, { YOK_RUN_ID: "r-2" }, false],
      { ok: true, value: { id: "r-2" } },
    ],
    [
      "no name with --remote, ignoring this session's YOK_RUN_ID=r-2",
      [undefined, {}, { YOK_RUN_ID: "r-2" }, true],
      { ok: false, error: "no run: pass a run name or --run-id" },
    ],
    [
      "a bare name with --remote",
      ["demo", {}, {}, true],
      { ok: false, error: "--project NAME is required with --remote" },
    ],
    ["a bare name without --remote", ["demo", {}, {}, false], { ok: true, value: "demo" }],
    [
      "a name with --run-id r-1 without --remote, looked up together here",
      ["demo", { runId: "r-1" }, {}, false],
      { ok: true, value: "demo" },
    ],
    [
      "nothing at all",
      [undefined, {}, {}, false],
      { ok: false, error: "no run: pass a run name or --run-id" },
    ],
  ])("SC7111: %s", (_label, args, expected) => {
    expect(runPick(...args)).toEqual(expected);
  });
});
