/// <reference path="./text-imports.d.ts" />
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import hljs from "highlight.js/lib/common";
import MarkdownIt, { type Token } from "markdown-it";
import DOC_CSS from "./doc.css" with { type: "text" };
import { isInsideDir } from "./workflow/done.ts";

// The markdown renderer yok view and the plan page share, so a plan reads the same in both.

const lineRange = (map: readonly [number, number]): string => `${map[0] + 1}-${map[1]}`;

// hljs closes a span only where its token ends, so a comment or string that spans lines leaves
// spans open across "\n"; close them at each line end and reopen them on the next line.
const splitHighlighted = (html: string): readonly string[] => {
  const open: string[] = [];
  return html.split("\n").map((raw) => {
    const reopened = open.join("");
    for (const tag of raw.match(/<span[^>]*>|<\/span>/g) ?? []) {
      if (tag === "</span>") open.pop();
      else open.push(tag);
    }
    return reopened + raw + "</span>".repeat(open.length);
  });
};

const DIFF_MARK = /^[+\- ]/;
// A diff fence names no language. Guessing among every grammar reads TypeScript as PHP or Java,
// so the guess is limited to languages a plan is likely to show.
const DIFF_GUESSES = [
  "typescript",
  "javascript",
  "json",
  "yaml",
  "bash",
  "python",
  "css",
  "xml",
  "markdown",
  "sql",
  "go",
  "rust",
];
const DIFF_CLASS: Readonly<Record<string, string>> = {
  "+": " hljs-addition",
  "-": " hljs-deletion",
};

const isHunkHeader = (line: string): boolean => line.startsWith("@@");

const sideOf = (hunk: readonly string[], dropped: string): readonly string[] =>
  hunk
    .filter((line) => line.charAt(0) !== dropped)
    .map((line) => line.replace(DIFF_MARK, "").trimEnd());

// The file holds either side of a hunk, depending on whether the step has run yet. A side that
// matches in more than one place says nothing about where the hunk is.
const placeHunk = (
  fileLines: readonly string[],
  hunk: readonly string[],
): readonly [number, number] | null => {
  const places = [sideOf(hunk, "-"), sideOf(hunk, "+")].map((side) => {
    const starts = fileLines.flatMap((_, at) =>
      side.length > 0 && side.every((line, k) => fileLines[at + k] === line) ? [at] : [],
    );
    return starts.length === 1 && starts[0] !== undefined
      ? ([starts[0] + 1, starts[0] + side.length] as const)
      : null;
  });
  return places.find((place) => place !== null) ?? null;
};

const highlightDiff = (
  source: string,
  options: Readonly<{ language: string | undefined; fileLines: readonly string[] | null }>,
): string => {
  const lines = source.replace(/\n$/, "").split("\n");
  const body = lines
    .filter((line) => !isHunkHeader(line))
    .map((line) => line.replace(DIFF_MARK, ""));
  const code = body.join("\n");
  const colored = options.language
    ? hljs.highlight(code, { language: options.language, ignoreIllegals: true })
    : hljs.highlightAuto(code, DIFF_GUESSES);
  const coded = splitHighlighted(colored.value)[Symbol.iterator]();
  const rendered = lines.map((line) => {
    if (isHunkHeader(line))
      return `<span class="diff-line hljs-meta">${markdown.utils.escapeHtml(line)}</span>`;
    const mark = DIFF_MARK.test(line) ? line.charAt(0) : "";
    return `<span class="diff-line${DIFF_CLASS[mark] ?? ""}">${mark}${coded.next().value ?? ""}</span>`;
  });
  const bounds = [
    -1,
    ...lines.flatMap((line, at) => (isHunkHeader(line) ? [at] : [])),
    lines.length,
  ];
  const pieces = bounds.slice(0, -1).flatMap((start, k) => {
    const header = start >= 0 ? rendered.slice(start, start + 1) : [];
    const end = bounds[k + 1] ?? lines.length;
    if (end - start <= 1) return header;
    const place = options.fileLines && placeHunk(options.fileLines, lines.slice(start + 1, end));
    const at = place ? ` data-from="${place[0]}" data-to="${place[1]}"` : "";
    return [
      ...header,
      `<span class="hunk"${at}>${rendered.slice(start + 1, end).join("\n")}</span>`,
    ];
  });
  return `${pieces.join("\n")}\n`;
};

const highlight = (code: string, lang: string): string =>
  hljs.getLanguage(lang)
    ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    : "";

const markdown: MarkdownIt = new MarkdownIt({ html: false, linkify: true, highlight });
// Only a URL written with its scheme links: a bare plan.md is a file name, not the .md domain.
markdown.linkify.set({ fuzzyLink: false });
// Raw HTML stays escaped, but a markdown table cell holds one line, so <br> is the one tag let
// through: it is how a cell breaks a line on GitHub too.
const BR_TAG = /^<br\s*\/?>/i;
markdown.inline.ruler.before("autolink", "br-tag", (state, silent) => {
  const tag = BR_TAG.exec(state.src.slice(state.pos))?.[0];
  if (tag === undefined) return false;
  if (!silent) state.push("hardbreak", "br", 0);
  state.pos += tag.length;
  return true;
});
markdown.core.ruler.push("source-lines", (state) => {
  for (const token of state.tokens) {
    if (token.nesting === 1 && token.map) token.attrSet("data-lines", lineRange(token.map));
  }
  return true;
});
// A list item starting with [ ] or [x] shows a checkbox, which the page lets a person click only
// while its file waits for approval.
const TASK_MARK = /^\[([ xX])\] /;
markdown.core.ruler.push("task-items", (state) => {
  state.tokens.forEach((token, index) => {
    const inline = state.tokens[index + 2];
    const first = inline?.children?.[0];
    if (token.type !== "list_item_open" || inline?.type !== "inline" || first?.type !== "text") {
      return;
    }
    const mark = TASK_MARK.exec(first.content);
    if (mark === null) return;
    first.content = first.content.slice(mark[0].length);
    token.attrJoin("class", "task");
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input type="checkbox" class="task-box" disabled${mark[1] === " " ? "" : " checked"}>`;
    inline.children = [box, ...(inline.children ?? [])];
  });
  return true;
});

export type RepoFiles = Readonly<{
  read: (path: string) => string | null;
  exists: (path: string) => boolean;
}>;
const NO_REPO: RepoFiles = { read: () => null, exists: () => false };

const REPO_PATH = /^[\w.@-]+(?:\/[\w.@-]+)*\.[A-Za-z0-9]+$/;

const PATH_AT_LINE = /^(.+?)(?::(\d+)(?:-\d+)?)?$/;

const pathOf = (content: string): Readonly<{ path: string; line: string | undefined }> | null => {
  const [, path = "", line] = PATH_AT_LINE.exec(content) ?? [];
  return REPO_PATH.test(path) ? { path, line } : null;
};

const leadingPath = (inline: Token | undefined): string | undefined => {
  const first = inline?.children?.find((child) => child.type !== "text" || child.content.trim());
  return first?.type === "code_inline" ? pathOf(first.content)?.path : undefined;
};

const firstPath = (inline: Token | undefined): string | undefined =>
  inline?.children
    ?.filter((child) => child.type === "code_inline")
    .map((child) => pathOf(child.content)?.path)
    .find((path) => path !== undefined);

// The planning skill's step card starts the line before a diff with the changed file's path. A diff
// without that line changes the file its step's title names; a path elsewhere in prose is a reference.
const fileOf = (tokens: readonly Token[], index: number): string | undefined => {
  const before =
    tokens[index - 1]?.type === "paragraph_close" ? leadingPath(tokens[index - 2]) : undefined;
  if (before) return before;
  const level = (tokens[index]?.level ?? 0) - 1;
  const item = tokens.findLastIndex(
    (t, at) => at < index && t.type === "list_item_open" && t.level === level,
  );
  return item === -1 ? undefined : firstPath(tokens[item + 2]);
};

const languageOf = (path: string): string | undefined => {
  const extension = path.split(".").pop() ?? "";
  return hljs.getLanguage(extension) ? extension : undefined;
};

markdown.renderer.rules.code_inline = (tokens, index, _options, env) => {
  const content = tokens[index]?.content ?? "";
  const target = pathOf(content);
  const repo: RepoFiles = env.repo ?? NO_REPO;
  const html = markdown.utils.escapeHtml;
  if (target === null || !repo.exists(target.path)) return `<code>${html(content)}</code>`;
  const at = target.line ? ` data-line="${target.line}"` : "";
  return `<code data-path="${html(target.path)}"${at}>${html(content)}</code>`;
};

const defaultFence = markdown.renderer.rules.fence;
markdown.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index];
  if (token === undefined || defaultFence === undefined) return "";
  const lines = token.map ? ` data-lines="${lineRange(token.map)}"` : "";
  const lang = token.info.trim().split(/\s+/)[0];
  if (lang === "mermaid") {
    return `<pre class="mermaid"${lines}>${markdown.utils.escapeHtml(token.content)}</pre>\n`;
  }
  if (lang === "diff") {
    const file = fileOf(tokens, index);
    const repo: RepoFiles = env.repo ?? NO_REPO;
    const text = file ? repo.read(file) : null;
    const fileLines =
      text
        ?.replace(/\n$/, "")
        .split("\n")
        .map((line) => line.trimEnd()) ?? null;
    const fileAttr = file ? ` data-file="${markdown.utils.escapeHtml(file)}"` : "";
    const total = fileLines ? ` data-total="${fileLines.length}"` : "";
    const code = highlightDiff(token.content, { language: file && languageOf(file), fileLines });
    return `<pre${lines}${fileAttr}${total}><code class="language-diff">${code}</code></pre>\n`;
  }
  return defaultFence(tokens, index, options, env, self).replace(/^<pre>/, `<pre${lines}>`);
};

export const renderMarkdown = (source: string, repo: RepoFiles = NO_REPO): string =>
  markdown.render(source, { repo });

const MAX_SOURCE_BYTES = 2_000_000;

export const resolveRepoPath = (cwd: string, relPath: string): string | null => {
  const root = resolve(cwd);
  const resolved = resolve(root, relPath);
  if (!isInsideDir(root, resolved)) return null;
  try {
    return isInsideDir(realpathSync(root), realpathSync(resolved)) ? resolved : null;
  } catch {
    return null;
  }
};

// A file that usually holds credentials is never read for the viewer or the plan page, which is
// uploaded to chat: its diff still renders, but it gets no "show more lines".
const SECRET_FILE =
  /(^|\/)(\.env($|\.)|\.npmrc$|\.netrc$|id_(rsa|dsa|ecdsa|ed25519)$|credentials)|\.(pem|key|p12|pfx)$|(^|\/)\.(ssh|aws|gnupg)\//i;
const isSecretFile = (path: string): boolean => SECRET_FILE.test(path);

export const repoFiles = (cwd: string): RepoFiles => ({
  exists: (path) => {
    const abs = resolveRepoPath(cwd, path);
    try {
      return abs !== null && statSync(abs).isFile();
    } catch {
      return false;
    }
  },
  read: (path) => {
    const abs = resolveRepoPath(cwd, path);
    if (abs === null) return null;
    try {
      if (isSecretFile(path) || isSecretFile(realpathSync(abs))) return null;
      const info = statSync(abs);
      return info.isFile() && info.size <= MAX_SOURCE_BYTES ? readFileSync(abs, "utf8") : null;
    } catch {
      return null;
    }
  },
});

export const colorFile = (text: string, path: string): readonly string[] => {
  const language = languageOf(path);
  const body = text.replace(/\n$/, "");
  return splitHighlighted(
    language
      ? hljs.highlight(body, { language, ignoreIllegals: true }).value
      : markdown.utils.escapeHtml(body),
  );
};

// The tokens, base rules and .doc rules the rendered markdown needs, in the viewer and the plan page.
export const DOC_STYLES: string = DOC_CSS;
