import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DoctorJsonSchema } from "@yok/core";
import type { CheckStatus } from "@yok/sdk";

const CLI = join(import.meta.dir, "index.ts");

const WORKFLOW = [
  "name: needs-key",
  "doctor:",
  "  - check: env",
  "    key: DOCTOR_E2E_KEY",
  "    fix: Set DOCTOR_E2E_KEY in .env",
  "nodes:",
  "  - id: a",
  "    type: exec",
  "    runtime: sh",
  '    script: "true"',
  "    input: null",
  "",
].join("\n");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const doctor = (files: Record<string, string>, args: readonly string[], pathPrefix = "") => {
  const dir = mkdtempSync(join(tmpdir(), "yok-doctor-e2e-"));
  dirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  const {
    DOCTOR_E2E_KEY: _unset,
    SLACK_BOT_TOKEN: _token,
    SLACK_CHANNEL_ID: _channel,
    ...env
  } = process.env;
  const result = spawnSync("bun", [CLI, "doctor", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...env, LOG_LEVEL: "", PATH: `${pathPrefix}${env.PATH}` },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};

const rowOf = (stdout: string, name: string) =>
  DoctorJsonSchema.parse(JSON.parse(stdout)).results.find((row) => row.name === name);

describe("yok doctor --workflow", () => {
  test("a declared env key missing from .env blocks and shows the declared fix", () => {
    const { code, stdout } = doctor({ "wf.yaml": WORKFLOW }, ["--workflow", "wf.yaml", "--json"]);
    expect(code).toBe(1);
    expect(rowOf(stdout, "env:DOCTOR_E2E_KEY")).toMatchObject({
      status: "fail",
      optional: false,
      fix: ["Set DOCTOR_E2E_KEY in .env"],
    });
  });

  test("the same key set in .env passes without printing its value", () => {
    const { stdout } = doctor({ "wf.yaml": WORKFLOW, ".env": "DOCTOR_E2E_KEY=top-secret\n" }, [
      "--workflow",
      "wf.yaml",
      "--json",
    ]);
    expect(rowOf(stdout, "env:DOCTOR_E2E_KEY")).toMatchObject({ status: "ok" });
    expect(stdout).not.toContain("top-secret");
  });

  test("a workflow envFile that is missing fails the env check naming the file", () => {
    const { stdout } = doctor({ "wf.yaml": `envFile: gone.env\n${WORKFLOW}` }, [
      "--workflow",
      "wf.yaml",
      "--json",
    ]);
    const row = rowOf(stdout, "env:DOCTOR_E2E_KEY");
    expect(row?.status).toBe("fail");
    expect(row?.detail).toContain("gone.env");
  });

  test("without --workflow the declared checks do not run", () => {
    const { stdout } = doctor({ "wf.yaml": WORKFLOW }, ["--json"]);
    expect(rowOf(stdout, "env:DOCTOR_E2E_KEY")).toBeUndefined();
  });

  test("a workflow that does not compile prints its error and exits 1", () => {
    const { code, stderr } = doctor({}, ["--workflow", "missing.yaml"]);
    expect(code).toBe(1);
    expect(stderr).toContain("missing-workflow:");
  });
});

const NOTIFIER_WORKFLOW = WORKFLOW.replace("name: needs-key\n", "name: notifies\nnotifier: {}\n");

describe("yok doctor's notifier row", () => {
  test.each<[string, Record<string, string>, readonly string[], CheckStatus]>([
    [
      "a workflow notifier with no Slack keys anywhere fails",
      { "wf.yaml": NOTIFIER_WORKFLOW },
      ["--workflow", "wf.yaml"],
      "fail",
    ],
    [
      "a config notifier, without --workflow, with the Slack keys in the config's env is ok",
      {
        "orchestrate.config.json": JSON.stringify({
          version: 2,
          notifier: {},
          env: { SLACK_BOT_TOKEN: "xoxb-e2e", SLACK_CHANNEL_ID: "C1" },
        }),
      },
      [],
      "ok",
    ],
  ])("%s", (_label, files, args, status) => {
    const { stdout } = doctor(files, [...args, "--json"]);
    expect(rowOf(stdout, "notifier")?.status).toBe(status);
  });
});

const PLAIN_WORKFLOW = WORKFLOW.replace(/doctor:\n(?: {2}.*\n)+/, "");

// A samskara first on PATH that is not there: the shell's exit for a command not found.
const missingSamskara = (): string => {
  const bin = mkdtempSync(join(tmpdir(), "yok-doctor-bin-"));
  dirs.push(bin);
  writeFileSync(join(bin, "samskara"), "#!/bin/sh\nexit 127\n");
  chmodSync(join(bin, "samskara"), 0o755);
  return `${bin}:`;
};

describe("yok doctor's samskara-upload row", () => {
  test("SC417: a workflow with samskara: {} and no working samskara fails the row and blocks", () => {
    const files = { "wf.yaml": `samskara: {}\n${PLAIN_WORKFLOW}` };

    const { code, stdout } = doctor(files, ["--workflow", "wf.yaml", "--json"], missingSamskara());

    expect(code).toBe(1);
    expect(rowOf(stdout, "samskara-upload")).toMatchObject({
      status: "fail",
      detail: "on, but not on PATH",
    });
    const { verdict } = DoctorJsonSchema.parse(JSON.parse(stdout));
    expect(verdict).toStartWith("BLOCKED");
    expect(verdict).toContain("samskara-upload");
  });

  test("SC417: the same workflow without the block gives the row ok and off", () => {
    const files = { "wf.yaml": PLAIN_WORKFLOW };

    const { stdout } = doctor(files, ["--workflow", "wf.yaml", "--json"], missingSamskara());

    expect(rowOf(stdout, "samskara-upload")).toMatchObject({ status: "ok", detail: "off" });
  });
});
