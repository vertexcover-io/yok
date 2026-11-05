import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { main, replyBody } from "./reply.ts";

const MARKER = "<!-- yok:pr-reply -->";
const realPath = process.env.PATH ?? "";

afterEach(() => {
  process.env.PATH = realPath;
  process.exitCode = 0;
});

// A gh that records its arguments and the body file, then prints a URL or fails.
const fakeGh = (fail?: string): { calls: () => string; body: () => string } => {
  const dir = mkdtempSync(join(tmpdir(), "reply-test-"));
  const args = join(dir, "args");
  const body = join(dir, "body");
  const script = fail
    ? `#!/bin/sh\necho x >> "${args}"\necho "${fail}" >&2\nexit 1\n`
    : `#!/bin/sh\necho "$@" >> "${args}"\ncp "$4" "${body}"\necho https://github.com/o/r/pull/42#issuecomment-1\n`;
  writeFileSync(join(dir, "gh"), script);
  chmodSync(join(dir, "gh"), 0o755);
  process.env.PATH = `${dir}${delimiter}${realPath}`;
  return {
    calls: () => (existsSync(args) ? readFileSync(args, "utf8") : ""),
    body: () => readFileSync(body, "utf8"),
  };
};

const capture = async (run: () => Promise<void>): Promise<{ out: string; err: string }> => {
  const out: string[] = [];
  const err: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const error = console.error;
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    out.push(String(chunk));
    return true;
  };
  console.error = (...parts: unknown[]) => {
    err.push(parts.join(" "));
  };
  try {
    await run();
  } finally {
    process.stdout.write = write;
    console.error = error;
  }
  return { out: out.join(""), err: err.join("\n") };
};

describe("replyBody", () => {
  test('SC38: the body is the marker line, a newline, then the text byte for byte, with quotes, $(id) and a backtick untouched', () => {
    const text = 'say "hi" $(id)\nand `ls`';
    expect(replyBody(text)).toBe(`${MARKER}\n${text}`);
  });
});

describe("main", () => {
  test("SC39: --pr 42 --comment posts once with gh pr comment --body-file FILE -- 42 and prints the URL", async () => {
    const gh = fakeGh();
    const { out } = await capture(() =>
      main(["--pr", "42", "--comment", "Ready for another look."]),
    );

    expect(gh.calls().trim().split("\n")).toHaveLength(1);
    expect(gh.calls()).toMatch(/^pr comment --body-file \S+ -- 42$/m);
    expect(gh.body()).toBe(`${MARKER}\nReady for another look.`);
    expect(out).toBe("https://github.com/o/r/pull/42#issuecomment-1\n");
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("SC40: --comment - posts the stdin text unchanged under the marker", async () => {
    const gh = fakeGh();
    const text = "One.\n\nTwo.\n\nThree.\n";
    const script = `import { main } from ${JSON.stringify(join(import.meta.dir, "reply.ts"))};await main(["--pr","42","--comment","-"]);`;
    const proc = Bun.spawn(["bun", "-e", script], {
      stdin: new TextEncoder().encode(text),
      stdout: "pipe",
      env: { ...process.env },
    });
    await proc.exited;

    expect(gh.body()).toBe(`${MARKER}\n${text}`);
  });

  test.each([
    ["no --pr", ["--comment", "x"]],
    ["no --comment", ["--pr", "42"]],
    ["a blank --comment", ["--pr", "42", "--comment", " "]],
  ])("SC41: %s exits 1 with the usage line and gh is not called", async (_name, argv) => {
    const gh = fakeGh();
    const { err } = await capture(() => main(argv));

    expect(process.exitCode).toBe(1);
    expect(err).toContain("usage: reply.ts --pr PR --comment TEXT");
    expect(gh.calls()).toBe("");
  });

  test("SC41: a gh failure exits 1 and prints gh's reason", async () => {
    fakeGh("no pull requests found");
    const { err, out } = await capture(() => main(["--pr", "42", "--comment", "x"]));

    expect(process.exitCode).toBe(1);
    expect(err).toBe("no pull requests found");
    expect(out).toBe("");
  });
});
