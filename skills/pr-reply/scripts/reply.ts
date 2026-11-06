#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

// The same line pr-triage's REPLY_MARKER names: hidden on GitHub, it marks yok's own replies.
const MARKER = "<!-- yok:pr-reply -->";

const USAGE =
  "usage: reply.ts --pr PR --comment TEXT [--link URL]   (--comment - reads the text from stdin)";

// A review-thread comment's link: the reply goes inside that thread. Any other link, a
// conversation comment or a review summary, cannot take a reply, so the reply goes on the
// pull request's conversation.
const THREAD_LINK = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)#discussion_r(\d+)$/;

const ghArgs = (pr: string, link: string, file: string): readonly string[] => {
  const thread = THREAD_LINK.exec(link);
  if (thread === null) return ["pr", "comment", "--body-file", file, "--", pr];
  const [, repo, number, comment] = thread;
  const path = `repos/${repo}/pulls/${number}/comments/${comment}/replies`;
  return ["api", path, "-F", `body=@${file}`, "--jq", ".html_url"];
};

export const replyBody = (text: string): string => `${MARKER}\n${text}`;

const fail = (message: string): void => {
  console.error(message);
  process.exitCode = 1;
};

// gh reads the body from a file, so no length limit or shell quoting touches the text.
const post = (
  pr: string,
  link: string,
  body: string,
): { ok: true; url: string } | { ok: false; error: string } => {
  const dir = mkdtempSync(join(tmpdir(), "pr-reply-"));
  try {
    const file = join(dir, "reply.md");
    writeFileSync(file, body);
    const ran = spawnSync("gh", ghArgs(pr, link, file), { encoding: "utf8" });
    if (ran.error !== undefined) return { ok: false, error: ran.error.message };
    if (ran.status !== 0) return { ok: false, error: ran.stderr.trim() || `gh exited ${ran.status}` };
    return { ok: true, url: ran.stdout.trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const main = async (argv: readonly string[]): Promise<void> => {
  const parsed = (() => {
    try {
      return parseArgs({
        args: [...argv],
        options: { pr: { type: "string" }, link: { type: "string" }, comment: { type: "string" } },
      }).values;
    } catch {
      return undefined;
    }
  })();
  const pr = parsed?.pr;
  const comment = parsed?.comment === "-" ? readFileSync(0, "utf8") : parsed?.comment;
  if (pr === undefined || comment === undefined || comment.trim() === "") return fail(USAGE);
  const posted = post(pr, parsed?.link ?? "", replyBody(comment));
  if (!posted.ok) return fail(posted.error);
  process.stdout.write(`${posted.url}\n`);
};

if (import.meta.main) await main(process.argv.slice(2));
