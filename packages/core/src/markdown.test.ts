import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./markdown.ts";

describe("SC701 (regression): renderMarkdown", () => {
  test("SC1: each block carries the source lines it came from, and raw HTML is escaped", () => {
    const html = renderMarkdown(
      "# Title\n\nfirst\nsecond\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>x</script>\n",
    );
    expect(html).toContain('<h1 data-lines="1-1">');
    expect(html).toContain('<p data-lines="3-4">');
    expect(html).toContain('<table data-lines="6-8">');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("SC2: a mermaid fence becomes a diagram block and other fences stay code", () => {
    const html = renderMarkdown("```mermaid\ngraph TD; A-->B\n```\n\n```ts\nconst a = 1;\n```\n");
    expect(html).toContain('class="mermaid"');
    expect(html).toContain("graph TD; A--&gt;B");
    expect(html).toContain('<code class="language-ts">');
    expect(html.match(/class="mermaid"/g)).toHaveLength(1);
  });

  test("a <br> in a table cell breaks the line, while <br> in code and any other HTML stay text", () => {
    const html = renderMarkdown("| Scenario |\n|---|\n| one<br>two<BR/>three `<br>` <b>x</b> |\n");
    expect(html).toContain(
      "<td>one<br>\ntwo<br>\nthree <code>&lt;br&gt;</code> &lt;b&gt;x&lt;/b&gt;</td>",
    );
  });

  test("a bare file name such as plan.md stays text, and only a URL with its scheme becomes a link", () => {
    const html = renderMarkdown("see plan.md, spec.md and CLAUDE.md, or www.example.com\n");
    expect(html).not.toContain("<a");
    expect(renderMarkdown("see https://example.com/a\n")).toContain(
      '<a href="https://example.com/a">https://example.com/a</a>',
    );
  });

  test("a ts fence comes back with its keywords marked for color, and an unknown language stays plain", () => {
    const html = renderMarkdown("```ts\nconst a = 1;\n```\n\n```nosuchlang\n<i>\n```\n");
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain('<code class="language-nosuchlang">&lt;i&gt;\n</code>');
  });

  test("a diff fence colors the code on each line, keeps a comment spanning lines whole, and marks every @@ line as a hunk", () => {
    const html = renderMarkdown(
      [
        "```diff",
        "@@",
        ' import { z } from "zod";',
        "-const old = <b>;",
        "+/* first",
        "+   second */",
        "+export const next = 2;",
        "@@ -1,2 +1,3 @@",
        "```",
        "",
      ].join("\n"),
    );
    const lines = html.split("\n");
    expect(lines[0]).toContain('<span class="diff-line hljs-meta">@@</span>');
    expect(lines[1]).toContain('<span class="diff-line"> <span class="hljs-keyword">import</span>');
    expect(lines[2]).toContain(
      '<span class="diff-line hljs-deletion">-<span class="hljs-keyword">const</span>',
    );
    expect(lines[2]).toContain("&lt;b&gt;");
    expect(lines[3]).toBe(
      '<span class="diff-line hljs-addition">+<span class="hljs-comment">/* first</span></span>',
    );
    expect(lines[4]).toBe(
      '<span class="diff-line hljs-addition">+<span class="hljs-comment">   second */</span></span>',
    );
    expect(lines[5]).toContain(
      '<span class="diff-line hljs-addition">+<span class="hljs-keyword">export</span>',
    );
    expect(lines[6]).toContain('<span class="diff-line hljs-meta">@@ -1,2 +1,3 @@</span>');
  });

  test("a diff of zod schema code that a full guess would read as PHP is colored as TypeScript", () => {
    const html = renderMarkdown(
      [
        "```diff",
        "+export const AskedQuestionSchema = z.strictObject({",
        "+  question: NonEmptyStringSchema,",
        "+  options: z.array(z.string()),",
        "+});",
        "```",
        "",
      ].join("\n"),
    );
    expect(html).toContain(
      '+<span class="hljs-keyword">export</span> <span class="hljs-keyword">const</span>',
    );
    expect(html).not.toContain("hljs-variable");
  });

  test("a diff fence takes its language from the file named on the line before it, where a guess reads YAML", () => {
    const html = renderMarkdown(
      [
        "`packages/sdk/src/hooks.ts` — after `HookCall`",
        "",
        "```diff",
        "+const questionCall = {",
        "+  agent: AgentTypeSchema,",
        "+};",
        "```",
        "",
      ].join("\n"),
    );
    expect(html).toContain('<pre data-lines="3-7" data-file="packages/sdk/src/hooks.ts">');
    expect(html).toContain('+<span class="hljs-keyword">const</span> questionCall = {');
  });

  test("a diff's file is the path that starts the line before it, range and all, or else the first path in its step's title", () => {
    const html = renderMarkdown(
      [
        "1. **Post the moments, in `src/notifier.ts` and `src/other.ts`**",
        "",
        "   `src/hooks.ts:13-18`, `:43-62`",
        "",
        "   ```diff",
        "   +const a = 1;",
        "   ```",
        "",
        "   Questions follow v1's format (`skills/notify.ts:166`): the question in bold.",
        "",
        "   ```diff",
        "   +const b = 2;",
        "   ```",
        "",
      ].join("\n"),
    );
    expect([...html.matchAll(/data-file="([^"]+)"/g)].map(([, file]) => file)).toEqual([
      "src/hooks.ts",
      "src/notifier.ts",
    ]);
  });

  test("each diff hunk is placed in the file it changes: by its new lines once applied, by its old lines before, and not at all when it matches twice", () => {
    const file = [
      "import x;",
      "",
      "const a = 1;",
      "const b = 2;",
      "const c = 3;",
      "",
      "export {};",
    ];
    const repo = {
      read: (path: string) => (path === "src/a.ts" ? file.join("\n") : null),
      exists: (path: string) => path === "src/a.ts",
    };
    const step = (path: string, diff: readonly string[]) =>
      renderMarkdown([`\`${path}\``, "", "```diff", ...diff, "```", ""].join("\n"), repo);
    const hunks = (html: string) =>
      [...html.matchAll(/<span class="hunk"(?: data-from="(\d+)" data-to="(\d+)")?>/g)].map(
        ([, from, to]) => (from ? [Number(from), Number(to)] : null),
      );

    const applied = step("src/a.ts", [
      "@@",
      " const a = 1;",
      "-const b = 9;",
      "+const b = 2;",
      "@@",
      "+export {};",
    ]);
    expect(hunks(applied)).toEqual([
      [3, 4],
      [7, 7],
    ]);
    expect(applied).toContain('data-file="src/a.ts" data-total="7"');

    const pending = step("src/a.ts", [" const b = 2;", "-const c = 3;", "+const c = 4;"]);
    expect(hunks(pending)).toEqual([[4, 5]]);

    expect(hunks(step("src/a.ts", ["+"]))).toEqual([null]);
    const missing = step("src/gone.ts", ["+const z = 1;"]);
    expect(hunks(missing)).toEqual([null]);
    expect(missing).not.toContain("data-total");
  });

  test("inline code naming a repo file links to it, with the line after a colon, and other code stays plain", () => {
    const repo = { read: () => null, exists: (path: string) => path === "src/a.ts" };
    const html = renderMarkdown(
      "`src/a.ts`, `src/a.ts:12`, `src/a.ts:13-18`, `src/gone.ts` and `const a`\n",
      repo,
    );
    expect(html).toContain('<code data-path="src/a.ts">src/a.ts</code>');
    expect(html).toContain('<code data-path="src/a.ts" data-line="12">src/a.ts:12</code>');
    expect(html).toContain('<code data-path="src/a.ts" data-line="13">src/a.ts:13-18</code>');
    expect(html).toContain("<code>src/gone.ts</code>");
    expect(html).toContain("<code>const a</code>");
  });

  test("a list item that starts with [x] or [ ] becomes a checkbox in that state, and other items stay text", () => {
    const html = renderMarkdown(
      "- [x] **F1 Coupon**: changes the total\n- [ ] F2 Quantity\n- [X] F3 Upper\n- plain [x] item\n",
    );
    expect(html).toContain(
      '<li data-lines="1-1" class="task"><input type="checkbox" class="task-box" disabled checked><strong>F1 Coupon</strong>: changes the total</li>',
    );
    expect(html).toContain(
      '<li data-lines="2-2" class="task"><input type="checkbox" class="task-box" disabled>F2 Quantity</li>',
    );
    expect(html).toContain('class="task-box" disabled checked>F3 Upper</li>');
    expect(html).toContain('<li data-lines="4-4">plain [x] item</li>');
    expect(html).not.toContain("[ ]");
  });

  test("a checkbox item with more paragraphs below keeps them, with the box in its first one", () => {
    const html = renderMarkdown("- [x] **R1 Title**\n\n  Given a cart, Then 25.\n\n- [ ] R2\n");
    expect(html).toContain(
      '<li data-lines="1-4" class="task">\n<p data-lines="1-1"><input type="checkbox" class="task-box" disabled checked><strong>R1 Title</strong></p>\n<p data-lines="3-3">Given a cart, Then 25.</p>',
    );
  });
});
