import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactRef, JsonValue } from "@yok/sdk";
import { checkFixResults } from "./fixes.ts";

const dir = mkdtempSync(join(tmpdir(), "fixes-"));

const fileHolding = (name: string, text: string): string => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

const check = (artifacts: ArtifactRef[], nodeInput: JsonValue = null) =>
  checkFixResults({ run: "r", nodeRunId: "nr-1", output: null, artifacts, args: null, nodeInput });

const resultIn = (name: string, items: readonly object[]) =>
  check([fixResult("review-2", fileHolding(name, JSON.stringify(items)))]);

// A review-2 fix node handed `fixes`, with its result file at the path done resolves.
const roundResult = (fixes: JsonValue[], items: readonly object[]) => {
  const fixesDir = join(dir, "artifacts", "fixes");
  mkdirSync(fixesDir, { recursive: true });
  const path = join(fixesDir, "review-2.json");
  writeFileSync(path, JSON.stringify(items));
  return check([fixResult("review-2", path)], { fixes, source: "review", round: 2 });
};

const fixResult = (name: string, path: string): ArtifactRef => ({ type: "fix-result", name, path });

const closed = { id: "a", status: "closed", commit: "abc1234" };
const left = { id: "b", status: "left", reason: "grew past small", decision: "leave it" };

describe("checkFixResults", () => {
  test("SC3: closed, left-with-decision and closed items pass", async () => {
    const third = { id: "c", status: "closed", commit: "def5678" };

    expect(await resultIn("ok.json", [closed, left, third])).toEqual({ pass: true, findings: [] });
  });

  test("SC3: a node without source and round that names no fix-result artifact passes", async () => {
    expect(
      await check([{ type: "plan", name: "plan", path: join(dir, "plan.md") }], { fixes: [] }),
    ).toEqual({
      pass: true,
      findings: [],
    });
  });

  test.each([
    ["names no fix-result artifact", []],
    [
      "passes only fixes/review-1.json",
      [fixResult("review-1", fileHolding("review-1.json", "[]"))],
    ],
  ])(
    "a node with source review and round 2 that %s fails on fixes/review-2.json",
    async (_, artifacts) => {
      const result = await check(artifacts, { fixes: [], source: "review", round: 2 });

      expect(result.pass).toBe(false);
      expect(result.findings.map((finding) => finding.message)).toEqual([
        "this round's fix-result artifact is artifacts/fixes/review-2.json: write it and pass it with --artifact",
      ]);
    },
  );

  test.each([
    ["a left item with no reason", [closed, { id: "b", status: "left" }], /^1\.reason: /],
    ["a closed item with no commit", [{ id: "a", status: "closed" }], /^0\.commit: /],
    ["a left item with an extra key", [{ ...left, fix: "x" }], /^0: /],
    ["status skipped", [{ id: "a", status: "skipped" }], /^0\.status: /],
    ["two items with one id", [closed, { ...closed, commit: "fff0000" }], /each id appears once/],
  ])("SC3: %s fails with one finding", async (_label, items, message) => {
    const result = await resultIn("bad.json", items);

    expect(result.pass).toBe(false);
    expect(result.findings.map((finding) => finding.message)).toEqual([
      expect.stringMatching(message),
    ]);
  });

  test("a node handed fixes as a file path still owes its round file", async () => {
    const result = await check([], { fixes: "fixes-list.json", source: "review", round: 2 });

    expect(result.findings.map((finding) => finding.message)).toEqual([
      "this round's fix-result artifact is artifacts/fixes/review-2.json: write it and pass it with --artifact",
    ]);
  });

  test("a round file holding one entry per requested item, in order, passes", async () => {
    const asked = { id: "b", summary: "s", trigger: "t", hint: "h", askUser: true };

    expect(await roundResult([{ id: "a" }, asked], [closed, left])).toEqual({
      pass: true,
      findings: [],
    });
  });

  test.each([
    ["is empty", []],
    ["omits b", [closed]],
    ["swaps the order", [left, closed]],
    ["invents id c", [closed, { ...left, id: "c" }]],
  ])("a round file for requested a, b that %s fails naming both lists", async (_, items) => {
    const result = await roundResult([{ id: "a" }, { id: "b" }], items);
    const got = items.map((item) => item.id).join(", ") || "none";

    expect(result.findings.map((finding) => finding.message)).toEqual([
      `expected one entry per requested item, in order: a, b; got ${got}`,
    ]);
  });

  test("an askUser item recorded with no decision fails naming it", async () => {
    const leftUnasked = { id: "b", status: "left", reason: "intended" };
    const result = await roundResult(
      [{ id: "a" }, { id: "b", askUser: true }],
      [closed, leftUnasked],
    );

    expect(result.findings.map((finding) => finding.message)).toEqual([
      "b has askUser: ask the user and record the answer as its decision",
    ]);
  });

  test("a round file in the wrong order with an unasked askUser item names both in one check", async () => {
    const leftUnasked = { id: "b", status: "left", reason: "intended" };
    const result = await roundResult(
      [{ id: "a" }, { id: "b", askUser: true }],
      [leftUnasked, closed],
    );

    expect(result.findings.map((finding) => finding.message)).toEqual([
      "expected one entry per requested item, in order: a, b; got b, a",
      "b has askUser: ask the user and record the answer as its decision",
    ]);
  });

  test.each([
    ["a missing file", join(dir, "absent.json"), /cannot read file/],
    ["a directory", dir, /cannot read file/],
    ["a file holding {", fileHolding("broken.json", "{"), /invalid JSON|JSON/],
  ])("SC3: %s fails with one finding naming the path, without throwing", async (_l, path, msg) => {
    const result = await check([fixResult("qa-2", path)]);

    expect(result.findings).toEqual([{ message: expect.stringMatching(msg), path }]);
  });
});
