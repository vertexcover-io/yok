#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, parseEnv } from "node:util";

// The same line pr-triage's REPLY_MARKER names: hidden on GitHub, it marks yok's own replies.
const MARKER = "<!-- yok:pr-reply -->";

const USAGE =
  "usage: reply.ts --pr PR --comment TEXT [--link URL]   (--comment - reads the text from stdin;\n" +
  "       --started in place of --comment posts a link to the run's page)";

const readOr = (path: string, fallback: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
};

// The run's page on the yok server, worked out as the server's serverDomain and publicOrigin
// (packages/server/src/protocol.ts) work it out: SERVER_DOMAIN from the yok home's .env, else
// this machine on the server's port, over http only for this machine.
export const runUrl = (env: NodeJS.ProcessEnv): { ok: true; url: string } | { ok: false; error: string } => {
  const home = env.YOK_HOME;
  const runId = env.YOK_RUN_ID;
  if (home === undefined || runId === undefined) {
    return { ok: false, error: "--started needs YOK_HOME and YOK_RUN_ID; run it inside a yok run" };
  }
  const domain = (parseEnv(readOr(join(home, ".env"), "")).SERVER_DOMAIN ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/\/+$/, "");
  const host = domain || `localhost:${readOr(join(home, "server.port"), "").trim()}`;
  const scheme = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? "http" : "https";
  return { ok: true, url: `${scheme}://${host}/runs/${runId}` };
};

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
        options: {
          pr: { type: "string" },
          link: { type: "string" },
          comment: { type: "string" },
          started: { type: "boolean" },
        },
      }).values;
    } catch {
      return undefined;
    }
  })();
  const pr = parsed?.pr;
  if (pr === undefined) return fail(USAGE);
  const link = parsed?.link ?? "";
  if (parsed?.started === true) {
    const page = runUrl(process.env);
    if (!page.ok) return fail(page.error);
    return send(pr, link, `Started a yok run on this: ${page.url}`);
  }
  const comment = parsed?.comment === "-" ? readFileSync(0, "utf8") : parsed?.comment;
  if (comment === undefined || comment.trim() === "") return fail(USAGE);
  return send(pr, link, comment);
};

const send = (pr: string, link: string, text: string): void => {
  const posted = post(pr, link, replyBody(text));
  if (!posted.ok) return fail(posted.error);
  process.stdout.write(`${posted.url}\n`);
};

if (import.meta.main) await main(process.argv.slice(2));
