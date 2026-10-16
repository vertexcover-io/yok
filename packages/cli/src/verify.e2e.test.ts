import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "index.ts");

const OK_WORKFLOW = [
  "name: ok",
  "nodes:",
  "  - id: a",
  "    type: exec",
  "    runtime: sh",
  '    script: "true"',
  "    input: null",
  "",
].join("\n");

const CYCLE_WORKFLOW = [
  "name: bad",
  "nodes:",
  "  - id: a",
  "    type: exec",
  "    runtime: sh",
  '    script: "true"',
  "    input: null",
  "    dependsOn: [b]",
  "  - id: b",
  "    type: exec",
  "    runtime: sh",
  '    script: "true"',
  "    input: null",
  "    dependsOn: [a]",
  "",
].join("\n");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const verify = (file: string, content: string | null) => {
  const dir = mkdtempSync(join(tmpdir(), "yok-verify-e2e-"));
  dirs.push(dir);
  if (content !== null) writeFileSync(join(dir, file), content);
  const result = spawnSync("bun", [CLI, "verify", file], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: "" },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe("yok verify", () => {
  test.each([
    ["a valid workflow file", "ok.yaml", OK_WORKFLOW, "ok: workflow ok compiles (1 node)"],
    [
      "a bare name, as the shipped workflow of that name",
      "task",
      null,
      "ok: workflow task compiles",
    ],
  ])("%s compiles, printing its name, and exits 0", (_label, file, content, printed) => {
    const { code, stdout } = verify(file, content);
    expect(code).toBe(0);
    expect(stdout).toContain(printed);
  });

  test.each([
    ["a cyclic workflow", "bad.yaml", CYCLE_WORKFLOW, "cycle: dependency cycle"],
    ["a yaml syntax error", "broken.yaml", "name: [unclosed\n", "yaml:"],
    ["an unknown bare name", "nope", null, "missing-workflow:"],
    ["a missing file", "nope.yaml", null, "missing-workflow:"],
  ])(
    "%s prints its error code and message, without a stack, and exits 1",
    (_label, file, content, error) => {
      const { code, stderr } = verify(file, content);
      expect(code).toBe(1);
      expect(stderr).toContain(error);
      expect(stderr).not.toContain("    at ");
    },
  );
});
