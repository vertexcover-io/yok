import { describe, expect, test } from "bun:test";
import { type DuplicatesRepo, DuplicatesRepoSchema } from "./duplicates.ts";

const at = (line: number) => ({ file: "a.test.ts", line, name: `test ${line}` });
const duplicate = (line: number) => ({ test: at(line), keeper: at(1), reason: "same check" });

const repo = (overrides: Partial<DuplicatesRepo>): DuplicatesRepo => ({
  repo: "web",
  testsAdded: 2,
  duplicates: [],
  notMeasured: null,
  errors: [],
  ...overrides,
});

describe("DuplicatesRepoSchema", () => {
  test("SC17: duplicates within the tests added are accepted", () => {
    expect(
      DuplicatesRepoSchema.safeParse(repo({ duplicates: [duplicate(2), duplicate(3)] })).success,
    ).toBe(true);
  });

  test.each([
    [
      "more duplicates than tests added",
      repo({ testsAdded: 1, duplicates: [duplicate(2), duplicate(3)] }),
    ],
    ["a duplicate when no test was added", repo({ testsAdded: 0, duplicates: [duplicate(2)] })],
    ["the same added test twice", repo({ duplicates: [duplicate(2), duplicate(2)] })],
    [
      "a duplicate when nothing was measured",
      repo({ testsAdded: null, notMeasured: "git diff failed", duplicates: [duplicate(2)] }),
    ],
  ])("SC18: %s is refused", (_case, output) => {
    expect(DuplicatesRepoSchema.safeParse(output).success).toBe(false);
  });
});
