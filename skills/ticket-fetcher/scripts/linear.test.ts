import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetHostAllowed, downloadAsset, fetchIssue, parseIssueRef } from "./linear.ts";
import type { Api } from "./ticket.ts";

const ASSET_BYTES = "binary-bytes";
const seen: { auth: (string | null)[]; queries: string[] } = { auth: [], queries: [] };

const respond = (query: string, variables: Record<string, unknown>): unknown => {
  if (query.includes("searchIssues")) {
    return { data: { searchIssues: { nodes: [{ id: "i1", identifier: "ENG-1", title: "T" }] } } };
  }
  if (variables.id === "ENG-404") return { data: { issue: null } };
  if (variables.id === "ENG-500") return { errors: [{ message: "boom" }] };
  return {
    data: {
      issue: {
        id: "i1",
        identifier: "ENG-1",
        title: "T",
        comments: { nodes: [{ id: "c0", body: "body 0" }] },
        attachments: { nodes: [{ id: "a1", url: "u1" }] },
      },
    },
  };
};

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    seen.auth.push(req.headers.get("authorization"));
    const url = new URL(req.url);
    if (url.pathname === "/asset") {
      return new Response(ASSET_BYTES, { headers: { "content-type": "image/png; charset=x" } });
    }
    const body = (await req.json()) as { query: string; variables: Record<string, unknown> };
    seen.queries.push(body.query);
    if (body.variables.id === "ENG-HTTP") return new Response("down", { status: 502 });
    return Response.json(respond(body.query, body.variables));
  },
});

const base = `http://${server.hostname}:${server.port}`;
const api: Api = { url: `${base}/graphql`, key: "secret-key" };
const dir = mkdtempSync(join(tmpdir(), "linear-"));
const CLI = join(import.meta.dir, "../../../packages/cli/src/index.ts");
const LINEAR = ["--no-env-file", CLI, "orchestrate", "skill", "run", "ticket-fetcher.linear-api"];

// Async spawn: a sync one would block this process's fake server from answering.
const runCli = async (args: readonly string[], cwd: string) => {
  const { LINEAR_API_KEY: _, ...env } = process.env;
  const child = Bun.spawn(["bun", ...LINEAR, ...args], {
    cwd,
    env: { ...env, LINEAR_API_URL: `${base}/graphql` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

afterAll(() => server.stop(true));

describe("parseIssueRef", () => {
  test.each([
    ["a key", "ENG-123"],
    ["a Linear URL", "https://linear.app/acme/issue/ENG-123/some-slug"],
  ])("reads %s as the issue key", (_label, input) => {
    expect(parseIssueRef(input)).toBe("ENG-123");
  });

  test.each(["nonsense", "https://linear.app/acme/projects/x"])("refuses %p", (input) => {
    expect(() => parseIssueRef(input)).toThrow("not a Linear issue key or URL");
  });
});

describe("fetchIssue", () => {
  test("reads the first 50 comments and attachments in one request", async () => {
    const before = seen.queries.length;
    const issue = await fetchIssue(api, "ENG-1");
    expect(issue).toMatchObject({
      comments: { nodes: [{ id: "c0" }] },
      attachments: { nodes: [{ id: "a1" }] },
    });
    expect(seen.queries.length).toBe(before + 1);
    expect(seen.queries.at(-1)).toContain("comments(first: 50)");
    expect(seen.queries.at(-1)).toContain("attachments(first: 50)");
  });

  test.each([
    ["a missing issue", "ENG-404", "not found"],
    ["a GraphQL error", "ENG-500", "boom"],
    ["an HTTP error, keeping the status", "ENG-HTTP", "502"],
  ])("fails on %s", async (_label, key, message) => {
    await expect(fetchIssue(api, key)).rejects.toThrow(message);
  });
});

describe("downloadAsset", () => {
  const overridden = { ...api, allowedOrigin: base };

  test("refuses a foreign host even with the test override, sending no request", async () => {
    const before = seen.auth.length;
    const target = { dir, name: "evil.bin" };
    await expect(downloadAsset(overridden, "https://evil.example.com/x", target)).rejects.toThrow(
      "not a Linear host",
    );
    await expect(downloadAsset(api, `${base}/asset`, target)).rejects.toThrow("not a Linear host");
    expect(seen.auth.length).toBe(before);
    expect(existsSync(join(dir, "evil.bin"))).toBe(false);
  });

  test("allows Linear hosts over https only", () => {
    expect(assetHostAllowed(api, "https://uploads.linear.app/x")).toBe(true);
    expect(assetHostAllowed(api, "https://linear.app/x")).toBe(true);
    expect(assetHostAllowed(api, "http://uploads.linear.app/x")).toBe(false);
    expect(assetHostAllowed(api, "https://notlinear.app/x")).toBe(false);
    expect(assetHostAllowed(api, "https://linear.app.evil.com/x")).toBe(false);
    expect(assetHostAllowed(overridden, `${base}/asset`)).toBe(true);
  });
});

const withKey = () => {
  const root = mkdtempSync(join(tmpdir(), "linear-cli-"));
  writeFileSync(join(root, ".env"), "LINEAR_API_KEY=cli-key\n");
  return root;
};

describe("SC50: the linear CLI through yok orchestrate skill run", () => {
  test.each([
    ["search", ["search", "export", "--limit", "5"], [{ identifier: "ENG-1" }]],
    [
      "issue",
      ["issue", "https://linear.app/acme/issue/ENG-1/slug"],
      { identifier: "ENG-1", comments: { nodes: [{ id: "c0" }] } },
    ],
    [
      "asset",
      ["asset", `${base}/asset`, "--dir", dir, "--name", "cli.png"],
      { path: join(dir, "cli.png"), bytes: ASSET_BYTES.length, mimeType: "image/png" },
    ],
  ])("%s prints its result as JSON, sending the key from .env", async (_label, args, result) => {
    const { code, stdout } = await runCli(args, withKey());
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject(result);
    expect(seen.auth.at(-1)).toBe("cli-key");
  });

  test.each([
    ["no arguments", []],
    ["search without a query", ["search"]],
    ["asset without --dir and --name", ["asset", "https://uploads.linear.app/x"]],
    ["an unknown command", ["delete", "ENG-1"]],
  ])("%s exits 1 with the usage", async (_label, args) => {
    const { code, stderr } = await runCli(args, withKey());
    expect(code).toBe(1);
    expect(stderr).toContain("usage:");
  });

  test.each(["abc", "0", "-3", "2.5"])(
    "search --limit %p exits 1 before any request",
    async (limit) => {
      const before = seen.queries.length;
      const { code, stderr } = await runCli(["search", "export", "--limit", limit], withKey());
      expect(code).toBe(1);
      expect(stderr).toContain("--limit");
      expect(seen.queries.length).toBe(before);
    },
  );
});

beforeAll(() => {
  seen.auth.length = 0;
});
