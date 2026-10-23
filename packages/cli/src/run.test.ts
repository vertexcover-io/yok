import { describe, expect, test } from "bun:test";
import { followUps } from "./run.ts";

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
