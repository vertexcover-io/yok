import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPublic,
  downloadFile,
  loadApiKey,
  runProviderCli,
  TicketFetcherOutputSchema,
  TicketSchema,
  targetPath,
  validateTicketDir,
} from "./ticket.ts";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const downloaded = (path: string, text = "hello") => ({
  id: `a-${path}`,
  name: path,
  type: "mockup",
  source: "attachment",
  status: "downloaded",
  path,
  mimeType: "text/plain",
  bytes: Buffer.byteLength(text),
  sha256: sha(text),
});

const unavailable = {
  id: "a-x",
  name: "x.png",
  type: "screenshot",
  source: "attachment",
  status: "unavailable",
  reason: "403",
};

const ticket = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  provider: "linear",
  id: "abc",
  key: "ENG-1",
  url: "https://linear.app/x/issue/ENG-1",
  title: "Add export",
  body: "body",
  properties: { status: "Todo", labels: ["export"] },
  comments: [{ id: "c1", body: "see mockup", author: "Sam", createdAt: "2026-09-30T00:00:00Z" }],
  references: [{ url: "https://example.com", kind: "external", context: "design" }],
  assets: [],
  complete: true,
  fetchedAt: "2026-09-30T00:00:00Z",
  ...overrides,
});

describe("TicketSchema", () => {
  test("SC1: a full ticket with both asset kinds parses", () => {
    const parsed = TicketSchema.safeParse(
      ticket({ assets: [downloaded("m.png"), unavailable], complete: false }),
    );
    expect(parsed.success).toBe(true);
  });

  test.each([
    ["a bad sha256", { assets: [{ ...downloaded("m.png"), sha256: "abc" }] }],
    ["an unavailable asset carrying a path", { assets: [{ ...unavailable, path: "x.png" }] }],
  ])("SC2: rejects %s", (_label, overrides) => {
    expect(TicketSchema.safeParse(ticket(overrides)).success).toBe(false);
  });
});

describe("TicketFetcherOutputSchema", () => {
  test("SC3: task alone is valid, an empty task is not", () => {
    expect(TicketFetcherOutputSchema.safeParse({ task: "do it" }).success).toBe(true);
    expect(TicketFetcherOutputSchema.safeParse({ task: "" }).success).toBe(false);
  });
});

describe("validateTicketDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ticket-"));
  });

  const write = (value: unknown) => writeFileSync(join(dir, "ticket.json"), JSON.stringify(value));

  test("SC4: a good bundle validates", async () => {
    writeFileSync(join(dir, "m.png"), "hello");
    write(ticket({ assets: [downloaded("m.png")] }));
    expect(await validateTicketDir(dir)).toEqual({ ok: true, path: join(dir, "ticket.json") });
  });

  const outside = (target: string) => {
    const folder = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(folder, "secret"), "hello");
    symlinkSync(join(folder, "secret"), target);
  };

  test.each([
    ["SC5: a path that leaves the folder", "no directory part", [downloaded("../m.png")], () => {}],
    ["SC6: a missing file", "(m.png): file is missing", [downloaded("m.png")], () => {}],
    [
      "SC7: a hash mismatch",
      "sha256 does not match",
      [{ ...downloaded("m.png"), bytes: 7 }],
      (d: string) => writeFileSync(join(d, "m.png"), "changed"),
    ],
    [
      "SC9: duplicate paths",
      "duplicate asset path m.png",
      [downloaded("m.png"), { ...downloaded("m.png"), id: "other" }],
      (d: string) => writeFileSync(join(d, "m.png"), "hello"),
    ],
    [
      "SC10: complete true with an unavailable asset",
      "complete must be false",
      [unavailable],
      () => {},
    ],
    [
      "SC11: a symlink pointing outside the folder",
      "file resolves outside the folder",
      [downloaded("m.png")],
      (d: string) => outside(join(d, "m.png")),
    ],
    [
      "SC12: a directory in place of a file",
      "not a regular file",
      [downloaded("m.png")],
      (d: string) => mkdirSync(join(d, "m.png")),
    ],
  ])("%s is an issue", async (_label, issue, assets, arrange) => {
    arrange(dir);
    write(ticket({ assets }));
    const result = await validateTicketDir(dir);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain(issue);
  });

  test("SC8: a size mismatch is the only issue, since the file is not hashed", async () => {
    writeFileSync(join(dir, "m.png"), "hello!");
    write(ticket({ assets: [downloaded("m.png")] }));
    expect(await validateTicketDir(dir)).toEqual({
      ok: false,
      issues: ["asset a-m.png (m.png): bytes is 6, not 5"],
    });
  });

  test("SC13: a missing or malformed ticket.json is an issue", async () => {
    expect((await validateTicketDir(dir)).ok).toBe(false);
    writeFileSync(join(dir, "ticket.json"), "{not json");
    expect((await validateTicketDir(dir)).ok).toBe(false);
  });
});

describe("assertPublic", () => {
  test.each([
    ["IPv6 loopback", "https://[::1]/x"],
    ["IPv4-mapped loopback", "https://[::ffff:127.0.0.1]/x"],
    ["IPv4-compatible loopback", "https://[::7f00:1]/x"],
    ["NAT64 loopback", "https://[64:ff9b::7f00:1]/x"],
    ["unique-local IPv6", "https://[fd00::1]/x"],
    ["link-local IPv4", "https://169.254.169.254/x"],
  ])("refuses %s", (_label, url) => {
    expect(() => assertPublic(new URL(url))).toThrow("a local or private address");
  });

  test("allows a public IPv6 address", () => {
    expect(() => assertPublic(new URL("https://[2606:4700::1111]/x"))).not.toThrow();
  });
});

describe("loadApiKey", () => {
  test("throws naming the variable when neither the project .env nor the environment sets it", async () => {
    const root = mkdtempSync(join(tmpdir(), "ticket-env-"));
    await expect(loadApiKey(root, "YOK_TEST_UNSET_API_KEY")).rejects.toThrow(
      "YOK_TEST_UNSET_API_KEY is not set",
    );
  });
});

describe("targetPath", () => {
  const dir = mkdtempSync(join(tmpdir(), "ticket-target-"));

  test.each(["../escape.png", "sub/x.png", ".hidden", ""])(
    "refuses the unsafe name %p",
    async (name) => {
      await expect(targetPath({ dir, name })).rejects.toThrow("unsafe file name");
    },
  );

  test("refuses a name that already exists in DIR", async () => {
    writeFileSync(join(dir, "keep.txt"), "original");
    await expect(targetPath({ dir, name: "keep.txt" })).rejects.toThrow("exists");
  });
});

const ASSET_BYTES = "binary-bytes";
const requests: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch(req): Response {
    const url = new URL(req.url);
    requests.push(url.pathname);
    if (url.pathname === "/asset") {
      return new Response(ASSET_BYTES, { headers: { "content-type": "image/png; charset=x" } });
    }
    if (url.pathname === "/redirect") {
      return new Response(null, { status: 302, headers: { location: `${base}/asset` } });
    }
    return new Response("no", { status: 403 });
  },
});
afterAll(() => server.stop(true));
const base = `http://${server.hostname}:${server.port}`;

// Promises 100 bytes, sends 7, then drops the connection; Bun.serve cannot cut a body short.
const truncating = createServer((socket) => {
  socket.once("data", () => {
    socket.write("HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\npartial");
    setTimeout(() => socket.destroy(), 20);
  });
});
await new Promise<void>((resolve) => truncating.listen(0, "127.0.0.1", resolve));
const truncatingAddress = truncating.address();
if (truncatingAddress === null || typeof truncatingAddress === "string") throw new Error("no port");
const truncatingOrigin = `http://127.0.0.1:${truncatingAddress.port}`;
afterAll(() => truncating.close());

const withFetchStub = async (
  replies: readonly Response[],
  run: () => Promise<unknown>,
): Promise<Request[]> => {
  const real = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push(new Request(String(input instanceof Request ? input.url : input), init));
    const reply = replies[calls.length - 1];
    if (reply === undefined) throw new Error("unexpected extra request");
    return Promise.resolve(reply);
  }) as typeof fetch;
  try {
    await run().catch(() => undefined);
  } finally {
    globalThis.fetch = real;
  }
  return calls;
};

const redirect = (to: string): Response =>
  new Response(null, { status: 302, headers: { location: to } });

describe("downloadFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "ticket-download-"));
  const local = (path: string, name: string) => ({
    url: new URL(`${base}${path}`),
    headers: {},
    path: join(dir, name),
    allowedOrigin: base,
  });
  const publicFile = (name: string) => ({
    url: new URL("https://files.example.com/x"),
    headers: { authorization: "secret-key" },
    path: join(dir, name),
  });

  test("streams the bytes to the path and reports size, hash and type", async () => {
    expect(await downloadFile(local("/asset", "a.png"))).toEqual({
      path: join(dir, "a.png"),
      bytes: ASSET_BYTES.length,
      sha256: createHash("sha256").update(ASSET_BYTES).digest("hex"),
      mimeType: "image/png",
    });
    expect(readFileSync(join(dir, "a.png"), "utf8")).toBe(ASSET_BYTES);
  });

  test("fails on an HTTP error without creating the file", async () => {
    await expect(downloadFile(local("/denied", "denied.bin"))).rejects.toThrow("403");
    expect(existsSync(join(dir, "denied.bin"))).toBe(false);
  });

  test("a body cut short leaves no partial file behind for the retry to trip on", async () => {
    const cut = { url: new URL(`${truncatingOrigin}/x`), headers: {}, path: join(dir, "cut.bin") };
    await expect(downloadFile({ ...cut, allowedOrigin: truncatingOrigin })).rejects.toThrow();
    expect(existsSync(join(dir, "cut.bin"))).toBe(false);
  });

  test("refuses a local address outside the allowed origin, sending no request", async () => {
    const before = requests.length;
    const { allowedOrigin: _, ...download } = local("/asset", "local.png");
    await expect(downloadFile(download)).rejects.toThrow("refusing");
    expect(requests.length).toBe(before);
    expect(existsSync(join(dir, "local.png"))).toBe(false);
  });

  test("refuses a redirect to a loopback address, even from the allowed origin", async () => {
    await expect(downloadFile(local("/redirect", "r1.bin"))).rejects.toThrow("refusing");
    expect(existsSync(join(dir, "r1.bin"))).toBe(false);
  });

  test("follows a redirect to a public https host without the headers", async () => {
    let result: unknown;
    const calls = await withFetchStub(
      [redirect("https://cdn.example.com/signed"), new Response("ok")],
      async () => {
        result = await downloadFile(publicFile("r2.bin"));
      },
    );
    expect(calls.map((c) => c.url)).toEqual([
      "https://files.example.com/x",
      "https://cdn.example.com/signed",
    ]);
    expect(calls[0]?.headers.get("authorization")).toBe("secret-key");
    expect(calls[1]?.headers.get("authorization")).toBeNull();
    expect(result).toMatchObject({ bytes: 2 });
  });

  test.each([
    ["a private address", "https://169.254.169.254/latest"],
    ["plain http", "http://example.com/a"],
  ])("refuses a redirect to %s", async (_label, to) => {
    const calls = await withFetchStub([redirect(to)], async () => {
      await expect(downloadFile(publicFile("r3.bin"))).rejects.toThrow("refusing");
    });
    expect(calls).toHaveLength(1);
    expect(existsSync(join(dir, "r3.bin"))).toBe(false);
  });

  test("gives up after too many hops", async () => {
    const loop = Array.from({ length: 10 }, () => redirect("https://example.com/next"));
    const calls = await withFetchStub(loop, async () => {
      await expect(downloadFile(publicFile("r5.bin"))).rejects.toThrow("too many redirects");
    });
    expect(calls.length).toBeLessThan(10);
    expect(existsSync(join(dir, "r5.bin"))).toBe(false);
  });
});

describe("runProviderCli", () => {
  test("prints the result as JSON, or prints the error and sets exit code 1", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const exitCode = process.exitCode;
    try {
      await runProviderCli(async (cwd, argv) => ({ cwd, argv }), ["issue", "ENG-1"]);
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({ cwd: process.cwd(), argv: ["issue", "ENG-1"] }),
      );
      expect(process.exitCode).not.toBe(1);

      await runProviderCli(() => Promise.reject(new Error("boom")), []);
      expect(error).toHaveBeenCalledWith(new Error("boom"));
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exitCode;
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe("yok orchestrate skill run ticket-fetcher.validate", () => {
  const CLI = join(import.meta.dir, "../../../packages/cli/src/index.ts");
  const validate = (dir: string) =>
    spawnSync(
      "bun",
      [
        "--no-env-file",
        CLI,
        "orchestrate",
        "skill",
        "run",
        "ticket-fetcher.validate",
        "validate",
        dir,
      ],
      { encoding: "utf8", env: { ...process.env, YOK_RUN_ID: undefined } },
    );

  test("SC52: a valid bundle prints ok and exits 0, and one listing a missing asset prints its issues and exits 1", () => {
    const good = mkdtempSync(join(tmpdir(), "ticket-"));
    writeFileSync(join(good, "m.png"), "hello");
    writeFileSync(
      join(good, "ticket.json"),
      JSON.stringify(ticket({ assets: [downloaded("m.png")] })),
    );
    const broken = mkdtempSync(join(tmpdir(), "ticket-"));
    writeFileSync(
      join(broken, "ticket.json"),
      JSON.stringify(ticket({ assets: [downloaded("m.png")] })),
    );

    const passed = validate(good);
    const failed = validate(broken);

    expect(passed.status).toBe(0);
    expect(JSON.parse(passed.stdout)).toEqual({ ok: true, path: join(good, "ticket.json") });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("m.png");
  });
});
