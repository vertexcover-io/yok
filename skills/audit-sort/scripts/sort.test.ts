import { describe, expect, test } from "bun:test";
import * as z from "zod";
import { AuditSortOutputSchema } from "./sort.ts";

const result = (overrides: object) => ({
  id: "a-1:yok:flaky:a-test",
  repo: "yok",
  problemType: "flaky",
  state: "needs_approval",
  title: "a test fails at random",
  proof: { where: "a.test.ts:3", summary: "It failed once in three runs.", blocks: [] },
  fix: { summary: "wait for the reply", diff: "-a\n+b" },
  ...overrides,
});

const errorOf = (results: readonly object[]): string => {
  const parsed = AuditSortOutputSchema.safeParse({ results });
  return parsed.success ? "" : z.prettifyError(parsed.error);
};

describe("AuditSortOutputSchema", () => {
  test.each([
    [
      "a needs_approval fix with no diff",
      [result({ fix: { summary: "s" } })],
      "a needs_work fix carries a prompt; any other fix carries a diff",
    ],
    [
      "a needs_work fix with no prompt",
      [result({ state: "needs_work", fix: { summary: "s" } })],
      "a needs_work fix carries a prompt; any other fix carries a diff",
    ],
    ["two results with one id", [result({}), result({})], "each result id appears once"],
  ])("SC16: %s is refused", (_label, results, message) => {
    expect(errorOf(results)).toContain(message);
  });
});
