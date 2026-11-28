import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import { AuditSortOutputSchema, checkDiffsApply } from "./sort.ts";

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

describe("checkDiffsApply", () => {
  // A repo whose src/a.ts reads one, two, three; the workspace names it as yok.
  const repoWith = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "audit-sort-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
    git("init", "-q");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "one\ntwo\nthree\n");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    return dir;
  };
  const GOOD = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
  // the context line it names is not in the file
  const BAD = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n zero\n-two\n+TWO\n three\n";
  const verify = (dir: string, diffs: readonly string[]) =>
    checkDiffsApply({
      run: "r",
      nodeRunId: "nr",
      artifacts: [],
      args: {},
      nodeInput: { workspace: { repos: [{ name: "yok", worktreeDir: dir }] } },
      output: {
        results: diffs.map((diff, index) =>
          result({ id: `a-1:yok:flaky:t${index}`, fix: { summary: "fix it", diff } }),
        ),
        autoFix: false,
        fixes: [],
      },
    });

  test("SC19: diffs that apply to the audited checkout pass", async () => {
    expect(await verify(repoWith(), [GOOD])).toEqual({ pass: true, findings: [] });
  });

  test("SC20: a diff that does not apply fails, naming its result, and leaves the checkout alone", async () => {
    const dir = repoWith();
    const checked = await verify(dir, [GOOD, BAD]);

    expect(checked.pass).toBe(false);
    expect(checked.findings).toHaveLength(1);
    expect(checked.findings[0]?.message).toStartWith(
      "a-1:yok:flaky:t1: its diff does not apply with git apply --check",
    );
    expect(readFileSync(join(dir, "src", "a.ts"), "utf8")).toBe("one\ntwo\nthree\n");
  });

  test("SC21: a result in a repo the workspace does not list fails", async () => {
    const checked = await checkDiffsApply({
      run: "r",
      nodeRunId: "nr",
      artifacts: [],
      args: {},
      nodeInput: { workspace: { repos: [] } },
      output: { results: [result({})], autoFix: false, fixes: [] },
    });

    expect(checked.findings[0]?.message).toBe(
      "a-1:yok:flaky:a-test: the workspace has no repo yok to check its diff in",
    );
  });
});
