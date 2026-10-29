import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarize } from "@yok/core";
import { createGit, type LaunchOptions, noopLogger } from "@yok/sdk";
import { createRegistry } from "@yok/sdk/internal";
import { createYokClient } from "./client.ts";
import { dispatchCommand, splitWords, startError } from "./dispatch.ts";
import { fakeHost, fakeProvider } from "./fake-host.ts";
import { isSlackSigned } from "./slack.ts";

// None of these commands reaches the server, so the client points nowhere; launched records
// every agent launch.
const launched: LaunchOptions[] = [];
const dispatch = (text: string) =>
  dispatchCommand(
    text,
    { channel: "C1", ts: "100.1" },
    {
      client: createYokClient({ url: "http://127.0.0.1:1" }),
      log: noopLogger,
      registry: createRegistry(join(tmpdir(), "yok-unused", "registry.json")),
      providerFor: (agent) =>
        fakeProvider(agent, async (options) => {
          launched.push(options);
          return { ok: false, error: "unused" };
        }),
      host: fakeHost("").host,
      home: join(tmpdir(), "yok-unused"),
      publicOrigin: "http://localhost:1",
      checkCheckout: async () => ({ env: { ok: true, value: {} }, report: summarize([]) }),
      git: createGit(),
    },
    async () => undefined,
  );

describe("dispatchCommand", () => {
  test("SC26: run with no --project replies that WORKFLOW and --project NAME are required, with the usage, and launches nothing", async () => {
    const reply = await dispatch("run task fix login");
    expect(reply).toContain("a WORKFLOW and --project NAME are required");
    expect(reply).toContain("usage: run WORKFLOW --project NAME [--name NAME]");
    expect(launched).toEqual([]);
  });

  test("SC4: Slack's <link> and &amp; entities come back as the typed words", () => {
    expect(splitWords("project add web --git <https://github.com/acme/web.git> a &amp; b")).toEqual(
      ["project", "add", "web", "--git", "https://github.com/acme/web.git", "a", "&", "b"],
    );
  });

  test("SC5: an unknown command replies with its words, then the help listing status and help", async () => {
    const reply = await dispatch("frobnicate now");
    expect(reply.split("\n")[0]).toBe("unknown command: frobnicate now");
    expect(reply).toContain("  status");
    expect(reply).toContain("  help");
  });

  test("SC6: an unknown flag replies with the parse error naming it and the command's usage", async () => {
    const reply = await dispatch("status --verbose");
    expect(reply).toContain("--verbose");
    expect(reply.split("\n").at(-1)).toBe("usage: status");
  });

  test("SC7: a mention with no words replies with the help", async () => {
    expect(await dispatch("")).toBe(await dispatch("help"));
    expect(await dispatch("")).toStartWith("Type @yok and one of:");
  });

  test("SC31: help has one usage line for each of the fourteen commands", async () => {
    const commands = (await dispatch("help"))
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/ [A-Z[-]/)[0]);
    expect(commands).toEqual([
      "runs",
      "run status",
      "run",
      "status",
      "project list",
      "project add",
      "project remove",
      "doctor",
      "trigger list",
      "trigger add",
      "trigger fire",
      "trigger log",
      "trigger rm",
      "help",
    ]);
  });

  test("SC33: run status of a run the registry does not hold replies not-found naming it", async () => {
    expect(await dispatch("run status r-404")).toBe("not-found: no run r-404");
  });

  test("SC39: doctor with no --project says --project NAME is required, with the doctor usage", async () => {
    const reply = await dispatch("doctor");
    expect(reply).toContain("--project NAME is required");
    expect(reply).toContain("usage: doctor --project NAME [--workflow WF]");
  });
});

describe("startError", () => {
  test("SC29 (regression): a doctor-blocked start reads as the message, then NAME: DETAIL, then   fix: STEP", () => {
    const report = summarize([
      { name: "git", status: "fail", optional: false, detail: "not found", fix: ["install git"] },
    ]);
    const error = { code: "bad-request", message: "BLOCKED", details: report } as const;
    expect(startError(error)).toBe("BLOCKED\ngit: not found\n  fix: install git");
  });
});

const sign = (secret: string, timestamp: string, body: string): string =>
  `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;

describe("isSlackSigned", () => {
  const now = new Date("2026-10-29T12:00:00.000Z");
  const nowS = now.getTime() / 1000;
  const body = '{"type":"event_callback"}';

  test("SC1: a body signed with s3cret at the current second is accepted", () => {
    const ts = String(nowS);
    expect(isSlackSigned("s3cret", ts, body, sign("s3cret", ts, body), now)).toBe(true);
  });

  test("SC2: a body changed by one character after signing is rejected", () => {
    const ts = String(nowS);
    const changed = body.replace("event", "Event");
    expect(isSlackSigned("s3cret", ts, changed, sign("s3cret", ts, body), now)).toBe(false);
  });

  test("SC3: a valid signature 301 seconds old is rejected, and one 299 seconds old is accepted", () => {
    const at = (age: number) => String(nowS - age);
    expect(isSlackSigned("s3cret", at(301), body, sign("s3cret", at(301), body), now)).toBe(false);
    expect(isSlackSigned("s3cret", at(299), body, sign("s3cret", at(299), body), now)).toBe(true);
  });
});
