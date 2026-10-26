import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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
  TicketSchema,
  targetPath,
  validateTicketDir,
  writeDesignIndex,
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

  test("a bundle whose designs the design script moved to the sibling design folder still validates", async () => {
    const ticketDir = join(mkdtempSync(join(tmpdir(), "run-")), "ticket");
    mkdirSync(ticketDir);
    const page = '<link href="s.css">';
    writeFileSync(join(ticketDir, "m.png"), "hello");
    writeFileSync(join(ticketDir, "home.html"), page);
    writeFileSync(join(ticketDir, "s.css"), "a{}");
    const image = { ...downloaded("m.png"), mimeType: "image/png" };
    const mockup = { ...downloaded("home.html", page), mimeType: "text/html" };
    const sheet = { ...downloaded("s.css", "a{}"), type: "code", mimeType: "text/css" };
    writeFileSync(
      join(ticketDir, "ticket.json"),
      JSON.stringify(ticket({ assets: [image, mockup, sheet] })),
    );
    await writeDesignIndex(ticketDir, join(ticketDir, "..", "design"), []);

    expect(await validateTicketDir(ticketDir)).toEqual({
      ok: true,
      path: join(ticketDir, "ticket.json"),
    });
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

// The 8-byte PNG signature and an IHDR chunk carrying WIDTH, all the index reads.
const png = (width: number): Buffer => {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12);
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(100, 20);
  return head;
};

// A whole IHDR chunk, then a pHYs chunk recording PIXELS_PER_METRE, as a 2x screenshot writes it.
const densePng = (width: number, pixelsPerMetre: number): Buffer => {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(100, 12);
  const phys = Buffer.alloc(21);
  phys.writeUInt32BE(9, 0);
  phys.write("pHYs", 4);
  phys.writeUInt32BE(pixelsPerMetre, 8);
  phys.writeUInt32BE(pixelsPerMetre, 12);
  phys.writeUInt8(1, 16);
  return Buffer.concat([png(0).subarray(0, 8), ihdr, phys]);
};

const asset = (path: string, mimeType: string, type = "mockup") => ({
  ...downloaded(path),
  mimeType,
  type,
});

describe("writeDesignIndex", () => {
  let ticketDir: string;
  let designDir: string;
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "design-"));
    ticketDir = join(root, "ticket");
    designDir = join(root, "design");
    mkdirSync(ticketDir);
  });

  const arrange = (files: Record<string, string | Buffer>, overrides: Record<string, unknown>) => {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(ticketDir, name), body);
    writeFileSync(join(ticketDir, "ticket.json"), JSON.stringify(ticket(overrides)));
  };

  const readIndex = () => readFileSync(join(designDir, "INDEX.md"), "utf8");
  const tableRows = () =>
    readIndex()
      .split("\n")
      .filter((line) => line.startsWith("|  |"));

  const sc1Ticket = () =>
    arrange(
      { "list.png": png(1440), "invoices.html": "<html></html>" },
      { assets: [asset("list.png", "image/png"), asset("invoices.html", "text/html")] },
    );

  test("SC1 (design): an image and an HTML mockup land in the design folder, and the index lists the image with its width", async () => {
    sc1Ticket();

    const result = await writeDesignIndex(ticketDir, designDir, []);

    expect(existsSync(join(designDir, "list.png"))).toBe(true);
    expect(readFileSync(join(designDir, "invoices", "index.html"), "utf8")).toBe("<html></html>");
    expect(tableRows()).toEqual(["|  | `design/list.png` | 1440 | attachment `list.png` |  |"]);
    expect(result).toEqual({
      index: join(designDir, "INDEX.md"),
      mockups: [join(designDir, "invoices", "index.html")],
      figma: [],
      spec: null,
    });
  });

  test("an image and an HTML mockup leave the ticket folder: each exists once, under design/", async () => {
    sc1Ticket();

    await writeDesignIndex(ticketDir, designDir, []);

    expect(existsSync(join(ticketDir, "list.png"))).toBe(false);
    expect(existsSync(join(ticketDir, "invoices.html"))).toBe(false);
    expect(existsSync(join(designDir, "list.png"))).toBe(true);
    expect(existsSync(join(designDir, "invoices", "index.html"))).toBe(true);
  });

  test("a design file gone from both the ticket folder and its design path fails the run, naming the path", async () => {
    sc1Ticket();
    await writeDesignIndex(ticketDir, designDir, []);
    rmSync(join(designDir, "list.png"));

    await expect(writeDesignIndex(ticketDir, designDir, [])).rejects.toThrow(
      join(designDir, "list.png"),
    );
  });

  test("SC2 (design): a second run indexes the mockup shot and the Figma export the agent added, sorted by file name", async () => {
    sc1Ticket();
    await writeDesignIndex(ticketDir, designDir, []);
    writeFileSync(join(designDir, "invoices--empty.png"), png(390));
    writeFileSync(join(designDir, "figma--header.png"), png(800));

    await writeDesignIndex(ticketDir, designDir, []);

    expect(tableRows()).toEqual([
      "|  | `design/figma--header.png` | 800 | Figma export |  |",
      "|  | `design/invoices--empty.png` | 390 | HTML mockup `design/invoices/index.html` |  |",
      "|  | `design/list.png` | 1440 | attachment `list.png` |  |",
    ]);
  });

  test.each([
    ["a 2x screenshot at 144 dpi", 2880, 5669, "1440"],
    ["a 3x export at 216 dpi", 1170, 8504, "390"],
    ["a 96 dpi export", 1440, 3780, "1440"],
    ["a 300 dpi print export", 1440, 11811, "1440"],
  ])("%s is indexed at the width it was drawn for", async (_, width, pixelsPerMetre, cell) => {
    arrange(
      { "list.png": densePng(width, pixelsPerMetre) },
      { assets: [asset("list.png", "image/png")] },
    );

    await writeDesignIndex(ticketDir, designDir, []);

    expect(tableRows()).toEqual([
      `|  | \`design/list.png\` | ${cell} | attachment \`list.png\` |  |`,
    ]);
  });

  test("a .png mockup served without a Content-Type is indexed by its extension", async () => {
    arrange(
      { "home.png": png(1440), "notes.bin": "x" },
      {
        assets: [
          asset("home.png", "application/octet-stream"),
          asset("notes.bin", "application/octet-stream"),
        ],
      },
    );

    await writeDesignIndex(ticketDir, designDir, []);

    expect(tableRows()).toEqual(["|  | `design/home.png` | 1440 | attachment `home.png` |  |"]);
  });

  test("an extensionless image and an SVG mockup are each indexed, not only copied", async () => {
    arrange(
      { a1b2c3: png(1440), "logo.svg": "<svg/>" },
      { assets: [asset("a1b2c3", "image/png"), asset("logo.svg", "image/svg+xml")] },
    );

    await writeDesignIndex(ticketDir, designDir, []);

    expect(tableRows()).toEqual([
      "|  | `design/a1b2c3` | 1440 | attachment `a1b2c3` |  |",
      "|  | `design/logo.svg` |  | attachment `logo.svg` |  |",
    ]);
  });

  test("the ticket files an HTML mockup links to land beside it, once: a linked image is part of the page, not a frame", async () => {
    arrange(
      {
        "invoices.html": '<link href="styles.css?v=2"><img src=logo.png><img src="home.png">',
        "styles.css": "a{}",
        "logo.png": png(64),
        "home.png": png(1440),
        "list.png": png(1440),
      },
      {
        assets: [
          asset("invoices.html", "text/html"),
          asset("styles.css", "text/css", "code"),
          asset("logo.png", "image/png"),
          asset("home.png", "image/png"),
          asset("list.png", "image/png"),
        ],
      },
    );

    await writeDesignIndex(ticketDir, designDir, []);

    expect(readFileSync(join(designDir, "invoices", "styles.css"), "utf8")).toBe("a{}");
    expect(existsSync(join(designDir, "invoices", "logo.png"))).toBe(true);
    expect(existsSync(join(designDir, "invoices", "home.png"))).toBe(true);
    expect(existsSync(join(designDir, "invoices", "list.png"))).toBe(false);
    expect(existsSync(join(designDir, "logo.png"))).toBe(false);
    expect(existsSync(join(ticketDir, "styles.css"))).toBe(false);
    expect(tableRows()).toEqual(["|  | `design/list.png` | 1440 | attachment `list.png` |  |"]);
  });

  test("a self-contained HTML mockup's folder holds only index.html; the ticket's images stay frames", async () => {
    arrange(
      { "invoices.html": "<h1>Invoices</h1><p>see list.png</p>", "list.png": png(1440) },
      { assets: [asset("invoices.html", "text/html"), asset("list.png", "image/png")] },
    );

    await writeDesignIndex(ticketDir, designDir, []);

    expect(readdirSync(join(designDir, "invoices"))).toEqual(["index.html"]);
    expect(tableRows()).toEqual(["|  | `design/list.png` | 1440 | attachment `list.png` |  |"]);
  });

  test("a stylesheet two mockups link to sits beside each, and a second run keeps both", async () => {
    arrange(
      { "a.html": "<link href=s.css>", "b.html": "<link href=s.css>", "s.css": "a{}" },
      {
        assets: [
          asset("a.html", "text/html"),
          asset("b.html", "text/html"),
          asset("s.css", "text/css", "code"),
        ],
      },
    );

    await writeDesignIndex(ticketDir, designDir, []);
    await writeDesignIndex(ticketDir, designDir, []);

    expect(readFileSync(join(designDir, "a", "s.css"), "utf8")).toBe("a{}");
    expect(readFileSync(join(designDir, "b", "s.css"), "utf8")).toBe("a{}");
  });

  test("a ticket file named index.html beside a mockup never replaces the mockup's page", async () => {
    arrange(
      { "pricing.html": "<h1>Choose your plan</h1>", "index.html": "<h1>Release notes</h1>" },
      {
        assets: [asset("pricing.html", "text/html"), asset("index.html", "text/html", "document")],
      },
    );

    await writeDesignIndex(ticketDir, designDir, []);

    expect(readFileSync(join(designDir, "pricing", "index.html"), "utf8")).toBe(
      "<h1>Choose your plan</h1>",
    );
  });

  test("an HTML log attached beside a mockup image is no mockup: it gets no folder and no frames", async () => {
    arrange(
      { "list.png": png(1440), "build.html": "<html>log</html>" },
      { assets: [asset("list.png", "image/png"), asset("build.html", "text/html", "log")] },
    );

    const result = await writeDesignIndex(ticketDir, designDir, []);

    expect(result.mockups).toEqual([]);
    expect(existsSync(join(designDir, "build"))).toBe(false);
  });

  test("SC3 (design): a ticket whose only files are a log and a diagram gets no design folder and a null index", async () => {
    arrange(
      { "run.log": "boom", "flow.png": png(600) },
      {
        assets: [asset("run.log", "text/plain", "log"), asset("flow.png", "image/png", "diagram")],
      },
    );

    const result = await writeDesignIndex(ticketDir, designDir, []);

    expect(result).toEqual({ index: null, mockups: [], figma: [], spec: null });
    expect(existsSync(designDir)).toBe(false);
  });

  test("SC4 (design): a markdown spec doc becomes spec.md under its name and adds no table row", async () => {
    arrange(
      { "list.png": png(1440), "spec.md": "Totals sit right." },
      {
        assets: [asset("list.png", "image/png"), asset("spec.md", "text/markdown", "document")],
      },
    );

    const result = await writeDesignIndex(ticketDir, designDir, []);

    expect(readFileSync(join(designDir, "spec.md"), "utf8")).toBe(
      "## spec.md\n\nTotals sit right.\n",
    );
    expect(tableRows()).toHaveLength(1);
    expect(readIndex()).toContain("Spec: `design/spec.md`");
    expect(result.spec).toBe(join(designDir, "spec.md"));
  });

  test("SC5 (design): an unfetched mockup and an unexported Figma link are listed as unavailable under an empty table", async () => {
    arrange(
      {},
      {
        assets: [{ ...unavailable, type: "mockup" }],
        references: [{ url: "https://www.figma.com/file/x", kind: "design", context: "" }],
        complete: false,
      },
    );

    const result = await writeDesignIndex(ticketDir, designDir, [
      "figma.com/file/x — no Figma MCP",
    ]);

    expect(result.figma).toEqual(["https://www.figma.com/file/x"]);
    expect(tableRows()).toEqual([]);
    expect(readIndex()).toContain(
      "## Unavailable\n\n- x.png — 403\n- figma.com/file/x — no Figma MCP\n",
    );
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

  test.each([
    "../escape.png",
    "sub/x.png",
    ".hidden",
    "",
    "home`mobile.png",
    "a|b.png",
    "a\nb.png",
  ])("refuses the unsafe name %p", async (name) => {
    await expect(targetPath({ dir, name })).rejects.toThrow("unsafe file name");
  });

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

const CLI = join(import.meta.dir, "../../../packages/cli/src/index.ts");
const runSkillScript = (script: string, args: readonly string[]) =>
  spawnSync("bun", ["--no-env-file", CLI, "orchestrate", "skill", "run", script, ...args], {
    encoding: "utf8",
    env: { ...process.env, YOK_RUN_ID: undefined },
  });

describe("yok orchestrate skill run ticket-fetcher.design", () => {
  test("SC6 (design): design TICKET_DIR DESIGN_DIR prints the index JSON and exits 0, and a missing DESIGN_DIR prints the usage and exits 1", () => {
    const root = mkdtempSync(join(tmpdir(), "design-cli-"));
    const ticketDir = join(root, "ticket");
    mkdirSync(ticketDir);
    writeFileSync(join(ticketDir, "list.png"), png(1440));
    writeFileSync(
      join(ticketDir, "ticket.json"),
      JSON.stringify(ticket({ assets: [asset("list.png", "image/png")] })),
    );
    const designDir = join(root, "design");

    const passed = runSkillScript("ticket-fetcher.design", [
      "design",
      ticketDir,
      designDir,
      "--unavailable",
      "x — y",
    ]);
    const failed = runSkillScript("ticket-fetcher.design", ["design", ticketDir]);

    expect(passed.status).toBe(0);
    expect(JSON.parse(passed.stdout)).toEqual({
      index: join(designDir, "INDEX.md"),
      mockups: [],
      figma: [],
      spec: null,
    });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("usage:");
  });
});

describe("yok orchestrate skill run ticket-fetcher.validate", () => {
  const validate = (dir: string) => runSkillScript("ticket-fetcher.validate", ["validate", dir]);

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
