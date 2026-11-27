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

const errorOf = (
  results: readonly object[],
  fixes: readonly object[] = [],
  autoFix = fixes.length > 0,
): string => {
  const parsed = AuditSortOutputSchema.safeParse({ results, autoFix, fixes });
  return parsed.success ? "" : z.prettifyError(parsed.error);
};

const duplicate = result({
  id: "a-1:yok:duplicates:copy",
  problemType: "duplicates",
  state: "auto_fixed",
  fix: { summary: "delete copy", diff: "-copy" },
});

const itemFor = (id: string) => ({
  id,
  repo: "yok",
  file: "a.test.ts",
  summary: "delete copy",
  trigger: "one proves the same rule",
  hint: "a.test.ts:3 still passes",
});

const TIE =
  "fixes holds one item per auto_fixed result, and autoFix is true exactly when it has any";

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

  test("SC28: an auto_fixed duplicate with its one matching item and autoFix true parses", () => {
    expect(errorOf([duplicate], [itemFor(duplicate.id)])).toBe("");
  });

  test.each([
    ["autoFix true with no items", [duplicate], [], true, TIE],
    [
      "an auto_fixed flaky result",
      [{ ...duplicate, problemType: "flaky" }],
      [itemFor(duplicate.id)],
      true,
      "only a duplicate is auto_fixed",
    ],
    [
      "an item for a needs_approval result",
      [result({})],
      [itemFor("a-1:yok:flaky:a-test")],
      true,
      TIE,
    ],
  ])("SC28: %s is refused", (_label, results, fixes, autoFix, message) => {
    expect(errorOf(results, fixes, autoFix)).toContain(message);
  });
});
