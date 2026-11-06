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

// A gh that records its arguments and the body file (after --body-file, or a body=@FILE field),
// then prints a URL or fails.
const fakeGh = (fail?: string): { calls: () => string; body: () => string } => {
  const dir = mkdtempSync(join(tmpdir(), "reply-test-"));
  const args = join(dir, "args");
  const body = join(dir, "body");
  const script = fail
    ? `#!/bin/sh\necho x >> "${args}"\necho "${fail}" >&2\nexit 1\n`
    : [
        "#!/bin/sh",
        `echo "$@" >> "${args}"`,
        'prev=""',
        "for a in \"$@\"; do",
        `  [ "$prev" = "--body-file" ] && cp "$a" "${body}"`,
        `  case "$a" in body=@*) cp "${"$"}{a#body=@}" "${body}" ;; esac`,
        '  prev="$a"',
        "done",
        "echo https://github.com/o/r/pull/42#issuecomment-1",
        "",
      ].join("\n");
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

  test("SC54: a review-thread --link replies inside that thread through the replies API", async () => {
    const gh = fakeGh();
    const link = "https://github.com/vertexcover-io/web/pull/42#discussion_r7";
    await capture(() => main(["--pr", "42", "--link", link, "--comment", "Fixed in abc123."]));

    expect(gh.calls().trim().split("\n")).toHaveLength(1);
    expect(gh.calls()).toMatch(
      /^api repos\/vertexcover-io\/web\/pulls\/42\/comments\/7\/replies -F body=@\S+ --jq \.html_url$/m,
    );
    expect(gh.body()).toBe(`${MARKER}\nFixed in abc123.`);
    expect(process.exitCode ?? 0).toBe(0);
  });

  test.each([
    ["a conversation comment", "https://github.com/vertexcover-io/web/pull/42#issuecomment-5"],
    ["a review summary", "https://github.com/vertexcover-io/web/pull/42#pullrequestreview-9"],
    ["an empty link", ""],
  ])("SC55: --link to %s posts on the conversation with gh pr comment", async (_name, link) => {
    const gh = fakeGh();
    await capture(() => main(["--pr", "42", "--link", link, "--comment", "Done."]));

    expect(gh.calls()).toMatch(/^pr comment --body-file \S+ -- 42$/m);
    expect(gh.body()).toBe(`${MARKER}\nDone.`);
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
