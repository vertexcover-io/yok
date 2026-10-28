import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowRun } from "@yok/sdk";
import { noopLogger } from "@yok/sdk";
import { createRegistry } from "@yok/sdk/internal";
import { stopDeliveries } from "./delivery.ts";
import { claudeOver, EMPTY_BOX, fakeHost, seedState } from "./fake-host.ts";
import { viewerRoutes } from "./viewer.ts";

const ORCHESTRATE = [
  join(import.meta.dir, "..", "..", "cli", "src", "index.ts"),
  "orchestrate",
] as const;
const SESSION = `viewer-e2e-${process.pid}`;

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "yok-viewer-e2e-")));

const DESIGN = [
  "# Design",
  "",
  "Start small and grow.",
  "",
  "## Approach",
  "",
  "Keep one file per run so the page stays simple. A second sentence follows here.",
  "",
].join("\n");

const CODE = [
  "# Code",
  "",
  "1. Change the schema:",
  "",
  "   ```diff",
  "   -const old = 1;",
  `   +const replacement = "${"a long line that has to wrap inside the box ".repeat(6)}";`,
  "   ```",
  "",
  "> A note from the planner.",
  "",
  "| Requirement | Level | Strategy | Phase |",
  "|---|---|---|---|",
  "| R1 config hooks load and are validated (SC101, SC102, SC103) | unit | `loadConfig` on YAML text, data-driven bad blocks | 1 |",
  "| R3 failing hooks become failed calls (SC104) | unit | `callHook` over throw, missing module, exit code, two timeouts | 1 |",
  "| R2 return value becomes output (SC105) | unit | `callHook` with temp modules and `sh -c` commands | 1 |",
  "| R4 which hooks an event gets (SC106) | unit | `hooksFor` on hand-built states and events | 1 |",
  "| R6 notifier block and reserved name (SC201, SC202) | unit | `loadConfig` | 2 |",
  "| R7, R8 messages per moment (SC203, SC204, SC205) | unit | `noticeOf` and `slackText`, table-driven | 2 |",
  "| R7 Slack client (SC206) | unit | fake `fetch` recording requests | 2 |",
  "| R9 missing variables (SC207, SC208) | unit | temp `.env`; `compileWorkflow` on a temp workflow | 2 |",
  "| R7 thread reuse, uploads, nothing to post (SC210, SC212, SC217) | unit | `notify` with a fake opener | 2 |",
  "| R10 question parsing (SC301) | unit | `parsePreToolUseInput` with Claude-shaped JSON | 3 |",
  "| R12 answer parsing (SC307) | unit | PostToolUse parse on a payload captured from Claude Code (phase 3 step 1) | 3 |",
  "| R10, R11, R12 messages (SC302) | unit | `noticeOf` | 3 |",
  "| R10, R11, R12 Claude settings (SC303) | unit | `claudeSettings` hooks block | 3 |",
  "| R5 init freezes hooks (SC107, SC108, SC109) | integration | `initializeRun` in a temp git repo, as `runs.test.ts` does | 1 |",
  "| R2, R4 blocking hooks recorded before the append returns (SC110) | integration | `appendRunEvent` on a run built with `createState` | 1 |",
  "| R4 a repeated event id runs nothing (SC111) | integration | same run, same id | 1 |",
  "| R3 a failure does not stop the others (SC112) | integration | a throwing hook first | 1 |",
  "| R4 non-blocking runs detached (SC113) | integration | a sleeping command hook, timed append | 1 |",
  "| R4 one hook's detached calls never overlap (SC114) | integration | start/end markers in a file | 1 |",
  "| R4 a hook may store events (SC115) | integration | a module hook calling `emitRunEvent` | 1 |",
  "| R6 notifier frozen, workflow wins (SC209) | integration | `initializeRun` | 2 |",
  "| R7 the first thread lands in state (SC211) | integration | call records appended to a temp run | 2 |",
  "| R3, R9 notifier with no secrets (SC213) | integration | real frozen notifier hook through init and the detached runner, empty env | 2 |",
  "| R9 doctor row (SC214) | integration | `runDoctor` in a temp repo | 2 |",
  "| R10, R12 question and answer recorded and linked (SC304, SC305) | integration | Claude PreToolUse and PostToolUse adapters, temp registry and run | 3 |",
  "| R11 agent stop recorded (SC306) | integration | Claude StopFailure adapter | 3 |",
  "| R1, R4 a real run fires a config hook (SC116) | e2e | orchestrate script as processes | 1 |",
  "",
  "```ts",
  ...Array.from({ length: 50 }, (_, i) => `const line${i + 1} = ${i + 1};`),
  "```",
  "",
].join("\n");

const FILLER = "A paragraph that pushes the next heading further down the page. ".repeat(12);
const OUTLINE = [
  "# Outline",
  ...["One", "Two", "Three"].flatMap((name) => ["", `## ${name}`, "", FILLER, "", FILLER]),
  "",
  "### Three detail",
  "",
  ...Array.from({ length: 6 }, () => [FILLER, ""]).flat(),
].join("\n");

const SAMPLE = Array.from({ length: 40 }, (_, i) => `export const v${i + 1} = ${i + 1};`);
const STEPS = [
  "# Steps",
  "",
  "See `src/sample.ts:5` for the first value.",
  "",
  "`src/sample.ts` — around line 20",
  "",
  "```diff",
  "@@",
  " export const v19 = 19;",
  "-export const v20 = 0;",
  "+export const v20 = 20;",
  " export const v21 = 21;",
  "```",
  "",
].join("\n");

const LIST = ["# List", "", "- First item", "- Second item", "- Third item", ""].join("\n");

const CHECKLIST = [
  "# Factors",
  "",
  "- [x] **F1 Coupon**: changes the total",
  "- [x] **F2 Threshold**: decides the discount",
  "- [ ] **F3 Quantity**: refuses a bad cart",
  "",
].join("\n");

const MOCKUP = `<!doctype html><html><body>
<div class="mk-card"><h2 class="mk-title">Sign in</h2><button id="go">Loading</button></div>
<script>document.getElementById("go").textContent = "Continue";</script>
</body></html>`;

const MODULE_PAGE = `<!doctype html><html><body>
<p id="mod">waiting</p><p id="data">waiting</p>
<script type="module" src="./module.js"></script>
<script>fetch("./module.json").then((r) => r.json()).then((d) => { document.getElementById("data").textContent = d.word; });</script>
</body></html>`;

// Async on purpose: the viewer runs in this process, and a sync spawn would freeze it while the
// browser waits for its page.
const browser = async (...args: string[]): Promise<string> => {
  const run = Bun.spawn(["agent-browser", ...args], {
    env: { ...process.env, AGENT_BROWSER_SESSION: SESSION },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  if (code !== 0) throw new Error(`agent-browser ${args[0]} failed: ${stderr}${stdout}`);
  return stdout.trim();
};

const evaluate = async (js: string): Promise<unknown> => {
  const out = await browser("eval", js);
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
};

const until = async (js: string, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await evaluate(js)) === true) return;
    await Bun.sleep(100);
  }
  throw new Error(`still false after ${ms}ms: ${js}`);
};

const selectText = async (inFrame: boolean, text: string): Promise<void> => {
  const doc = inFrame ? "document.querySelector('#htmlFrame').contentDocument" : "document";
  const root = inFrame ? `${doc}.body` : "document.querySelector('#docRoot')";
  await evaluate(`(() => {
    const doc = ${doc}; const root = ${root};
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.data.indexOf(${JSON.stringify(text)});
      if (at === -1) continue;
      const range = doc.createRange();
      range.setStart(n, at); range.setEnd(n, at + ${text.length});
      const sel = doc.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      return true;
    }
    return false;
  })()`);
};

const belowHead = (heading: string): string => `(() => {
  const head = document.querySelector('#docHead').getBoundingClientRect().bottom;
  const target = [...document.querySelectorAll('#docRoot h1, #docRoot h2, #docRoot h3')].find((h) => h.textContent === ${JSON.stringify(heading)});
  const gap = target.getBoundingClientRect().top - head;
  return gap >= 0 && gap < 40;
})()`;

const barShown = "!document.querySelector('#selbar').hidden";
const commenting = "document.querySelector('#docPane').classList.contains('commenting')";

const ensureCommentMode = async (): Promise<void> => {
  if ((await evaluate(commenting)) !== true) await browser("click", "#modeBtn");
  await until(commenting);
};

const ARTIFACTS: Readonly<Record<string, string>> = {
  "design.md": DESIGN,
  "mock.html": MOCKUP,
  "module.html": MODULE_PAGE,
  "module.js": 'document.getElementById("mod").textContent = "module ran";',
  "module.json": '{ "word": "fetched" }',
  "code.md": CODE,
  "outline.md": OUTLINE,
  "steps.md": STEPS,
  "list.md": LIST,
  "factors.md": CHECKLIST,
  "scenarios.md": CHECKLIST,
};

// Every test starts from the seeded files, no comments, no state, and its own tab. Each test closes
// its tab after: pages only navigated away from kept their event streams open until they used up
// Chrome's six connections to the viewer.
const resetRun = async (runDir: string): Promise<void> => {
  stopDeliveries();
  await browser("tab", "new");
  // A seeded state.json starts at event 0, so events left from other tests would replay onto it.
  for (const name of ["comments.json", "state.json", "event.jsonl"])
    rmSync(join(runDir, name), { force: true });
  for (const [name, text] of Object.entries(ARTIFACTS))
    writeFileSync(join(runDir, "artifacts", name), text);
};

const cardWith = (text: string): string =>
  `[...document.querySelectorAll('#threads .card')].find((c) => c.textContent.includes(${JSON.stringify(text)}))`;

describe("viewer in a browser", () => {
  let home: string;
  let cwd: string;
  let runDir: string;
  let viewer: Readonly<{ origin: string; stop: () => Promise<void> }>;
  let url: string;
  const opened: { file: string; line: number | null }[] = [];
  let typed: readonly string[] = [];

  beforeAll(async () => {
    home = tempDir();
    cwd = tempDir();
    execFileSync("git", ["init", "-q"], { cwd });
    runDir = join(cwd, ".yok", "demo");
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "sample.ts"), `${SAMPLE.join("\n")}\n`);
    const registry = createRegistry(join(home, "registry.json"), noopLogger);
    const run: WorkflowRun = {
      id: "r1",
      workflow: "w",
      workflowPath: "/w.yaml",
      inputs: {},
      cwd,
      sessions: [{ agent: "claude", sessionId: "s1" }],
      name: "demo",
      terminal: "s1",
      config: null,
      tiers: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await registry.addRun(run);
    const { host, calls } = fakeHost(EMPTY_BOX);
    typed = calls;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: viewerRoutes({
        registry,
        providerFor: () => claudeOver(host),
        host,
        log: noopLogger,
        now: () => new Date(),
        openInEditor: (target) => {
          opened.push(target);
          return { ok: true, value: null };
        },
      }).fetch,
    });
    viewer = { origin: `http://localhost:${server.port}`, stop: () => server.stop(true) };
    url = `${viewer.origin}/runs/r1`;
  });

  beforeEach(() => resetRun(runDir), 30000);
  afterEach(() => browser("tab", "close"), 30000);

  afterAll(async () => {
    stopDeliveries();
    // A sync spawn blocks the worker until every holder of its pipes exits, and the browser's
    // background process can hold them for good, so it gets no pipes and a deadline.
    spawnSync("agent-browser", ["close"], {
      env: { ...process.env, AGENT_BROWSER_SESSION: SESSION },
      stdio: "ignore",
      timeout: 10_000,
    });
    await viewer.stop();
  });

  test("SC33, SC14: Comment mode gates the selection bar, Add to batch holds comments listed by place until Send 2, and both reach the agent's status", async () => {
    await browser("open", `${url}#artifacts/design.md`);
    await until("!!document.querySelector('#docRoot')");
    await evaluate("localStorage.setItem('yok-viewer:comment-mode','off')");
    await browser("reload");
    await until("!!document.querySelector('#docRoot')");

    await selectText(false, "one file per run");
    await Bun.sleep(600);
    expect(await evaluate(barShown)).toBe(false);

    await browser("click", "#modeBtn");
    await selectText(false, "one file per run");
    await until(barShown);

    await browser("click", "#selbar button[data-kind=comment]");
    await browser("fill", "#composerText", "Why only one file?");
    await browser("click", "#batchBtn");
    await until("document.querySelector('.batch') !== null");
    expect(await evaluate("document.querySelector('#docRoot mark.hl.is-draft') !== null")).toBe(
      true,
    );
    expect(await evaluate("document.querySelector('.batch .group-label').textContent")).toContain(
      "Not sent yet",
    );

    await selectText(false, "Start small");
    await until(barShown);
    await browser("click", "#selbar button[data-kind=comment]");
    await browser("fill", "#composerText", "How small?");
    await browser("click", "#batchBtn");
    await until("document.querySelectorAll('.batch .card').length === 2");
    expect(
      await evaluate(
        "[...document.querySelectorAll('.batch .card')].map((c) => c.textContent.includes('How small?'))",
      ),
    ).toEqual([true, false]);
    const before = await (await fetch(`${viewer.origin}/runs/r1/comments`)).json();
    expect(before.comments).toEqual([]);

    expect(await evaluate("document.querySelector('#sendBtn').textContent")).toBe(
      "Send 2 to the agent",
    );
    await browser("click", "#sendBtn");
    await until("document.querySelector('.batch') === null");
    await until(
      "[...document.querySelectorAll('#threads .card .status')].filter((s) => s.textContent === 'With the agent').length === 2",
      5000,
    );
  }, 60000);

  test("SC34: a reply and an edit by the agent appear without a reload", async () => {
    const anchor = {
      quote: "one file per run",
      before: "Keep ",
      after: " so the page stays simple.",
      lines: [7, 7],
      heading: "Approach",
    };
    const posted = await fetch(`${url}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        comments: [{ file: "artifacts/design.md", kind: "comment", text: "Why one?", anchor }],
      }),
    });
    expect(posted.status).toBe(201);
    await browser("open", `${url}#artifacts/design.md`);
    await until("!!document.querySelector('#threads .card[data-cid=c1]')");

    const reply = spawnSync(
      "bun",
      [
        ...ORCHESTRATE,
        "comments",
        "reply",
        "--run",
        "demo",
        "--id",
        "c1",
        "--status",
        "answered",
        "--text",
        "Simpler to review.",
      ],
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, YOK_RUN_ID: undefined, YOK_HOME: home },
      },
    );
    expect(reply.status).toBe(0);
    await until(
      "document.querySelector('#threads .card[data-cid=c1]').textContent.includes('Simpler to review.') && document.querySelector('#threads .card[data-cid=c1] .status').textContent === 'Answered'",
      3500,
    );

    writeFileSync(
      join(runDir, "artifacts", "design.md"),
      DESIGN.replace("Keep one file per run so the page stays simple. ", ""),
    );
    await until(
      "document.querySelector('#toast').textContent === 'design.md changed' && !document.querySelector('#toast').hidden",
      3500,
    );
    await until(
      "[...document.querySelectorAll('#threads .group-label')].some((l) => l.textContent === 'Text no longer in the file')",
      3500,
    );
    expect(readFileSync(join(runDir, "comments.json"), "utf8")).toContain("Simpler to review.");
  }, 30000);

  test("SC35: text selected inside an HTML artifact becomes a comment with an element path", async () => {
    await browser("open", `${url}#artifacts/mock.html`);
    await until(
      "document.querySelector('#htmlFrame')?.contentDocument?.getElementById('go')?.textContent === 'Continue'",
    );
    await ensureCommentMode();
    await selectText(true, "Sign in");
    await until(barShown);
    await browser("click", "#selbar button[data-kind=comment]");
    await browser("fill", "#composerText", "Make the title bolder");
    await browser("click", "#batchBtn");
    await until("document.querySelector('.batch') !== null");
    await browser("click", "#sendBtn");
    await until("document.querySelector('.batch') === null");
    await until(
      "[...document.querySelectorAll('#threads .loc')].some((l) => l.textContent.includes('div.mk-card > h2.mk-title'))",
    );
  }, 30000);

  test("an HTML artifact loads a sibling module script and fetches a sibling file, and the fetched text takes a comment", async () => {
    await browser("open", `${url}#artifacts/module.html`);
    const text = (id: string): string =>
      `document.querySelector('#htmlFrame')?.contentDocument?.getElementById('${id}')?.textContent`;
    await until(`${text("mod")} === 'module ran' && ${text("data")} === 'fetched'`);
    await ensureCommentMode();
    await selectText(true, "fetched");
    await until(barShown);
    await browser("click", "#selbar button[data-kind=comment]");
    await browser("fill", "#composerText", "Say where this came from");
    await browser("click", "#sendNowBtn");
    await until(
      "[...document.querySelectorAll('#threads .loc')].some((l) => l.textContent.includes('module.html · p:nth-of-type(2)'))",
    );
    expect(
      await evaluate(
        "[...document.querySelectorAll('#threads .group-label')].some((l) => l.textContent === 'Text no longer in the file')",
      ),
    ).toBe(false);
  }, 30000);

  test("a code block is one wrapped box with diff colors, not a stack of inline chips", async () => {
    await browser("set", "viewport", "1000", "800");
    await browser("open", `${url}#artifacts/code.md`);
    await until("!!document.querySelector('#docRoot pre .hljs-addition')");
    const look = await evaluate(`(() => {
      const pre = document.querySelector('#docRoot pre');
      const style = (sel) => getComputedStyle(document.querySelector(sel));
      return {
        boxed: style('#docRoot pre').backgroundColor !== 'rgba(0, 0, 0, 0)',
        chip: style('#docRoot pre code').backgroundColor,
        wraps: pre.scrollWidth <= pre.clientWidth,
        diffColored: style('#docRoot .hljs-addition').backgroundColor !== style('#docRoot .hljs-deletion').backgroundColor,
        quoteRule: style('#docRoot blockquote').borderLeftStyle,
        hangs: (() => {
          const line = [...document.querySelectorAll('#docRoot .hljs-addition')].find((l) => l.textContent.includes('long line'));
          const range = document.createRange();
          range.selectNodeContents(line);
          const lefts = new Map();
          for (const r of range.getClientRects()) lefts.set(Math.round(r.top), Math.min(lefts.get(Math.round(r.top)) ?? Infinity, r.left));
          const [first, second] = [...lefts.values()];
          return lefts.size > 1 && second > first;
        })(),
        cellWordWhole: [...document.querySelectorAll('#docRoot td')].every((td) => {
          const text = td.firstChild;
          if (text?.nodeType !== Node.TEXT_NODE) return true;
          const word = text.data.split(/\\s/)[0];
          const range = document.createRange();
          range.setStart(text, 0);
          range.setEnd(text, word.length);
          return range.getClientRects().length <= 1;
        }),
      };
    })()`);
    expect(look).toEqual({
      boxed: true,
      chip: "rgba(0, 0, 0, 0)",
      wraps: true,
      diffColored: true,
      quoteRule: "solid",
      hangs: true,
      cellWordWhole: true,
    });
  }, 30000);

  test("the outline lists the file's headings, jumps to one on click, and marks the section in view", async () => {
    await browser("open", `${url}#artifacts/outline.md`);
    await until("document.querySelectorAll('#outline button').length > 0");
    expect(
      await evaluate("[...document.querySelectorAll('#outline button')].map((b) => b.textContent)"),
    ).toEqual(["Outline", "One", "Two", "Three", "Three detail"]);

    await browser("set", "viewport", "1000", "800");
    await browser("click", "#outline li:nth-child(4) button");
    await until(belowHead("Three"));
    expect(await evaluate("location.hash")).toBe("#artifacts/outline.md#three");
    await until(
      "document.querySelector('#outline button[aria-current=\"true\"]')?.textContent === 'Three'",
    );
  }, 30000);

  test("a link to a section opens the file at that section, and a heading's # link points at it", async () => {
    await browser("set", "viewport", "1280", "800");
    await browser("open", `${url}#artifacts/outline.md#three-detail`);
    await until("!!document.querySelector('#docRoot')");
    await until(belowHead("Three detail"));
    expect(
      await evaluate(
        "[...document.querySelectorAll('#docRoot h2')].find((h) => h.textContent === 'Two').querySelector('a.anchor').getAttribute('href')",
      ),
    ).toBe("#artifacts/outline.md#two");
  }, 30000);

  test("a code block copies its code, and one over 40 lines opens folded until asked", async () => {
    await browser("open", `${url}#artifacts/code.md`);
    await until("!!document.querySelector('#docRoot pre .copy-btn')");
    const fold =
      "document.querySelector('#docRoot pre.language-ts, #docRoot pre:has(code.language-ts)')";
    expect(
      await evaluate(
        `${fold}.classList.contains('folded') && ${fold}.clientHeight < ${fold}.scrollHeight`,
      ),
    ).toBe(true);
    expect(await evaluate("document.querySelector('#docRoot .fold-btn').dataset.more")).toBe("20");
    await browser("click", "#docRoot .fold-btn");
    expect(await evaluate(`${fold}.classList.contains('folded')`)).toBe(false);

    // The test browser denies clipboard reads, so record what the page writes instead.
    await evaluate(`(() => {
      const write = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (text) => { window.copiedText = text; return write(text); };
      ${fold}.scrollIntoView({ block: 'center' });
    })()`);
    await browser("click", "#docRoot pre:has(code.language-ts) .copy-btn");
    await until(
      "document.querySelector('#docRoot pre:has(code.language-ts) .copy-btn').dataset.state === 'copied'",
    );
    expect(await evaluate("window.copiedText")).toContain("const line50 = 50;");
  }, 30000);

  test("a diff shows more of its file above and below on request, until the file runs out", async () => {
    await browser("open", `${url}#artifacts/steps.md`);
    await until("!!document.querySelector('#docRoot .hunk .expand-btn')");
    const hunk = "document.querySelector('#docRoot .hunk')";
    const shown = `[${hunk}.dataset.from, ${hunk}.dataset.to].join('-')`;
    expect(await evaluate(shown)).toBe("19-21");

    await browser("click", "#docRoot .expand-btn[data-dir=up]");
    await until(`${shown} === '9-21'`);
    expect(await evaluate(`${hunk}.querySelector('.diff-line').textContent`)).toBe(
      " export const v9 = 9;",
    );
    expect(await evaluate(`!!${hunk}.querySelector('.diff-line .hljs-keyword')`)).toBe(true);

    await browser("click", "#docRoot .expand-btn[data-dir=up]");
    await until(`${shown} === '1-21'`);
    expect(await evaluate(`${hunk}.querySelector('.expand-btn[data-dir=up]').hidden`)).toBe(true);
    for (const expected of ["1-31", "1-40"]) {
      // agent-browser clicks the middle of a button cut off by the window's bottom edge, and misses
      await browser("scrollintoview", "#docRoot .expand-btn[data-dir=down]");
      await browser("click", "#docRoot .expand-btn[data-dir=down]");
      await until(`${shown} === '${expected}'`);
    }
    expect(await evaluate(`${hunk}.querySelector('.expand-btn[data-dir=down]').hidden`)).toBe(true);
  }, 30000);

  test("a file path, a diff and the open artifact each open in the editor at their line", async () => {
    await browser("open", `${url}#artifacts/steps.md`);
    await until("!!document.querySelector('#docRoot code[data-path]')");
    opened.length = 0;
    await browser("click", "#docRoot code[data-path]");
    await until("!document.querySelector('#toast').hidden");
    await browser("click", "#docRoot pre[data-file] .open-btn");
    await browser("click", "#editBtn");
    const sample = join(cwd, "src", "sample.ts");
    for (let i = 0; i < 30 && opened.length < 3; i++) await Bun.sleep(100);
    expect(opened).toEqual([
      { file: sample, line: 5 },
      { file: sample, line: 19 },
      { file: join(runDir, "artifacts", "steps.md"), line: null },
    ]);
  }, 30000);

  test("SC11: Approve shows only on the waiting design.md, and a click sends one approve comment and hides it", async () => {
    const state = seedState(runDir, {
      design: {
        nodeRunId: "n1",
        nodeType: "agent",
        status: "running",
        startedAt: null,
        completedAt: null,
        artifacts: [],
        awaitingApproval: "artifacts/design.md",
      },
    });
    writeFileSync(join(runDir, "state.json"), JSON.stringify(state));
    const typedBefore = typed.length;
    try {
      const approveHidden = "document.querySelector('#approveBtn').hidden";
      await browser("open", `${url}#artifacts/code.md`);
      await until("document.querySelector('#docPath').textContent === 'artifacts/code.md'");
      expect(await evaluate(approveHidden)).toBe(true);

      await browser("open", `${url}#artifacts/design.md`);
      await until(
        `document.querySelector('#docPath').textContent === 'artifacts/design.md' && !${approveHidden}`,
      );
      expect(await evaluate("document.querySelector('#docBadge').textContent")).toBe(
        "Waiting for your approval",
      );
      await browser("click", "#approveBtn");
      expect(await evaluate(approveHidden)).toBe(true);
      await until(
        "[...document.querySelectorAll('#threads .card .chip')].some((c) => c.textContent === 'Approved')",
      );
      expect(await evaluate(approveHidden)).toBe(true);
      const after = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
      expect(after.nodeRuns.design).not.toHaveProperty("awaitingApproval");
      const typedNow = () => typed.slice(typedBefore);
      for (let i = 0; i < 50 && !typedNow().some((t) => t.includes("approved:")); i++)
        await Bun.sleep(100);
      expect(typedNow().filter((t) => t.includes("approved: finish the stage"))).toHaveLength(1);
    } finally {
      rmSync(join(runDir, "state.json"), { force: true });
    }
  }, 30000);

  test("SC531: an unattended run's page draws no Comment mode button", async () => {
    const policies = { values: { interaction: false }, sources: { interaction: "cli" } };
    writeFileSync(
      join(runDir, "state.json"),
      JSON.stringify({ ...seedState(runDir, {}), policies }),
    );
    try {
      await browser("open", `${url}#artifacts/design.md`);
      await until("document.querySelector('#modeBtn').hidden === true");
      expect(await evaluate("getComputedStyle(document.querySelector('#modeBtn')).display")).toBe(
        "none",
      );
    } finally {
      rmSync(join(runDir, "state.json"), { force: true });
    }
  }, 30000);

  test("SC13: Send posts one comment at once, Control+Enter does the same, no batch appears, and stored anchors keep their lines", async () => {
    await browser("set", "viewport", "1280", "800");
    await browser("open", `${url}#artifacts/design.md`);
    await until("document.querySelector('#docPath').textContent === 'artifacts/design.md'");
    await ensureCommentMode();
    await evaluate(`(() => {
      window.sawBatch = false;
      new MutationObserver(() => { if (document.querySelector('.batch')) window.sawBatch = true; })
        .observe(document.body, { childList: true, subtree: true });
      return true;
    })()`);

    await selectText(false, "Start small");
    await until(barShown);
    await browser("click", "#selbar button[data-kind=comment]");
    await browser("fill", "#composerText", "Say how small.");
    await browser("click", "#sendNowBtn");

    await selectText(false, "second sentence");
    await until(barShown);
    await browser("click", "#selbar button[data-kind=comment]");
    await browser("fill", "#composerText", "Cut the second sentence.");
    await browser("press", "Control+Enter");

    for (const text of ["Say how small.", "Cut the second sentence."])
      await until(`${cardWith(text)}?.querySelector('.status')?.textContent === 'With the agent'`);
    expect(await evaluate("window.sawBatch")).toBe(false);
    const stored: { text: string; anchor?: { lines?: unknown } }[] = JSON.parse(
      readFileSync(join(runDir, "comments.json"), "utf8"),
    ).comments;
    expect(
      stored
        .filter((c) => ["Say how small.", "Cut the second sentence."].includes(c.text))
        .map((c) => Array.isArray(c.anchor?.lines)),
    ).toEqual([true, true]);
  }, 30000);

  test("SC15: at desktop width no block shows an L-number label and a card's location reads design.md · Approach with no line", async () => {
    const anchor = {
      quote: "A second sentence",
      before: "the page stays simple. ",
      after: " follows here.",
      lines: [7, 7],
      heading: "Approach",
    };
    const comment = { file: "artifacts/design.md", kind: "comment", text: "Trim it.", anchor };
    const posted = await fetch(`${url}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ comments: [comment] }),
    });
    expect(posted.status).toBe(201);
    await browser("set", "viewport", "1280", "800");
    await browser("open", `${url}#artifacts/design.md`);
    await until(`${cardWith("Trim it.")} !== undefined`);
    expect(
      await evaluate(
        "[...document.querySelectorAll('#docRoot [data-lines]')].map((b) => getComputedStyle(b, '::before').content).filter((c) => /L/.test(c))",
      ),
    ).toEqual([]);
    expect(await evaluate(`${cardWith("Trim it.")}.querySelector('.loc').textContent`)).toBe(
      "design.md · Approach",
    );
  }, 30000);

  test("a failed Send leaves the comment under Not sent yet with the send error, and a failed Approve shows the button again", async () => {
    const state = seedState(runDir, {
      design: {
        nodeRunId: "n1",
        nodeType: "agent",
        status: "running",
        startedAt: null,
        completedAt: null,
        artifacts: [],
        awaitingApproval: "artifacts/design.md",
      },
    });
    writeFileSync(join(runDir, "state.json"), JSON.stringify(state));
    const approveHidden = "document.querySelector('#approveBtn').hidden";
    try {
      await browser("set", "viewport", "1280", "800");
      await browser("open", `${url}#artifacts/design.md`);
      await until(
        `document.querySelector('#docPath').textContent === 'artifacts/design.md' && !${approveHidden}`,
      );
      await evaluate(`(() => {
        const real = window.fetch;
        window.fetch = (input, init) =>
          init?.method === 'POST' && String(input).endsWith('/comments')
            ? Promise.resolve(new Response('disk full', { status: 500 }))
            : real(input, init);
        return true;
      })()`);
      await ensureCommentMode();
      await selectText(false, "Start small");
      await until(barShown);
      await browser("click", "#selbar button[data-kind=comment]");
      await browser("fill", "#composerText", "Never sent.");
      await browser("click", "#sendNowBtn");

      await until(`!!${cardWith("Never sent.")}?.closest('.batch')`);
      expect(await evaluate("document.querySelector('.batch .group-label').textContent")).toBe(
        "Not sent yet · 1",
      );
      expect(await evaluate("document.querySelector('.batch .send-error').textContent")).toContain(
        "disk full",
      );

      await browser("click", "#approveBtn");
      await until("!document.querySelector('#toast').hidden");
      expect(await evaluate("document.querySelector('#toast').textContent")).toContain("disk full");
      await until(`!${approveHidden}`);
    } finally {
      rmSync(join(runDir, "state.json"), { force: true });
    }
  }, 30000);

  test("SC16: hovering the second bullet in comment mode marks that bullet, while the list and the other bullets stay transparent", async () => {
    await browser("open", `${url}#artifacts/list.md`);
    await until("document.querySelectorAll('#docRoot li').length === 3");
    await ensureCommentMode();
    await browser("hover", "#docRoot li:nth-child(2)");
    expect(
      await evaluate(
        "['ul', 'li:nth-child(1)', 'li:nth-child(2)', 'li:nth-child(3)'].map((s) => getComputedStyle(document.querySelector('#docRoot ' + s)).backgroundColor !== 'rgba(0, 0, 0, 0)')",
      ),
    ).toEqual([false, false, true, false]);
  }, 30000);
  const box = (n: number): string => `#docRoot li.task:nth-of-type(${n}) .task-box`;
  const awaiting = (file: string): void => {
    const state = seedState(runDir, {
      gate: {
        nodeRunId: "n1",
        nodeType: "agent",
        status: "running",
        startedAt: null,
        completedAt: null,
        artifacts: [],
        awaitingApproval: `artifacts/${file}`,
      },
    });
    writeFileSync(join(runDir, "state.json"), JSON.stringify(state));
  };
  const openFile = async (file: string): Promise<void> => {
    await browser("open", `${url}#artifacts/${file}`);
    await until(`document.querySelector('#docPath').textContent === 'artifacts/${file}'`);
    await until("!!document.querySelector('#docRoot .task-box')");
  };
  const batchLabel = "(document.querySelector('.batch .group-label')?.textContent ?? '')";

  test("SC40: a checklist's boxes can only be clicked while its file waits for approval", async () => {
    await openFile("factors.md");
    expect(await evaluate(`document.querySelector('${box(1)}').disabled`)).toBe(true);
    awaiting("factors.md");
    try {
      await browser("reload");
      await until("!document.querySelector('#approveBtn').hidden");
      await until(`!document.querySelector('${box(1)}').disabled`);
    } finally {
      rmSync(join(runDir, "state.json"), { force: true });
    }
  }, 30000);

  test("SC41: each box changed from the file adds one draft, a box changed back removes it, and Send delivers them as one message", async () => {
    awaiting("factors.md");
    try {
      await openFile("factors.md");
      await until(`!document.querySelector('${box(2)}').disabled`);
      await browser("click", box(2));
      expect(await evaluate(`document.querySelector('${box(2)}').checked`)).toBe(false);
      await until(`${batchLabel} === 'Not sent yet · 1'`);
      expect(await evaluate(`!!${cardWith("Untick this")}`)).toBe(true);

      await browser("click", box(2));
      await until("!document.querySelector('.batch')");
      expect(await evaluate(`document.querySelector('${box(2)}').checked`)).toBe(true);

      await browser("click", box(2));
      await browser("click", box(3));
      await until(`${batchLabel} === 'Not sent yet · 2'`);
      expect(await evaluate(`!!${cardWith("Tick this")}`)).toBe(true);
      const before = typed.length;
      await browser("click", "#sendBtn");
      await until("!document.querySelector('.batch')");
      for (let i = 0; i < 50 && typed.length === before; i++) await Bun.sleep(100);
      const message = typed.slice(before).join("\n");
      expect(message).toContain(
        'factors.md:4 on "F2 Threshold: decides the discount"\n  Untick this',
      );
      expect(message).toContain('factors.md:5 on "F3 Quantity: refuses a bad cart"\n  Tick this');
    } finally {
      rmSync(join(runDir, "state.json"), { force: true });
    }
  }, 30000);

  test("SC42: Approve sends the waiting drafts with the approval, in one message with the approval last", async () => {
    awaiting("scenarios.md");
    try {
      await openFile("scenarios.md");
      await until(`!document.querySelector('${box(1)}').disabled`);
      await browser("click", box(1));
      await until(`${batchLabel} === 'Not sent yet · 1'`);
      const before = typed.length;
      await browser("click", "#approveBtn");
      await until("!document.querySelector('.batch')");
      for (let i = 0; i < 50 && !typed.slice(before).some((t) => t.includes("approved:")); i++)
        await Bun.sleep(100);
      const message = typed.slice(before).find((t) => t.includes("approved:")) ?? "";
      expect(message).toContain('scenarios.md:3 on "F1 Coupon: changes the total"\n  Untick this');
      expect(message.indexOf("Untick this")).toBeLessThan(message.indexOf("approved:"));
    } finally {
      rmSync(join(runDir, "state.json"), { force: true });
    }
  }, 30000);
});
