import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarize, yokTerminalHost } from "@yok/core";
import type { IStorage, State, WorkflowRun } from "@yok/sdk";
import { noopLogger } from "@yok/sdk";
import { memoryStorage, openStorage, withStorage } from "@yok/sdk/internal";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { type Browser, chromium, type Page } from "playwright";
import { stopDeliveries } from "./delivery.ts";
import {
  claudeOver,
  EMPTY_BOX,
  fakeHost,
  fakePane,
  seedRun,
  seedState,
  seedUser,
} from "./fake-host.ts";
import { sessionSecret, signValue } from "./identity.ts";
import { forgetFinishedRun } from "./overview.ts";
import { readPort } from "./protocol.ts";
import { startServer } from "./server.ts";
import { terminalRoutes } from "./terminal.ts";
import { viewerRoutes } from "./viewer.ts";

const ORCHESTRATE = [
  join(import.meta.dir, "..", "..", "cli", "src", "index.ts"),
  "orchestrate",
] as const;

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

// One browser for the file; every test gets its own context, so no tab, storage or viewport leaks
// from one test into the next.
let chrome: Browser;
let page: Page;

beforeAll(async () => {
  chrome = await chromium.launch();
}, 30000);
afterAll(() => chrome.close());
beforeEach(async () => {
  page = await (await chrome.newContext()).newPage();
});
afterEach(() => page.context().close());

const evaluate = (js: string): Promise<unknown> => page.evaluate<unknown>(js);

const until = async (js: string, ms = 5000): Promise<void> => {
  await page.waitForFunction(js, undefined, { timeout: ms }).catch(() => {
    throw new Error(`still false after ${ms}ms: ${js}`);
  });
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

const gapBelowHead = (heading: string): string => `(() => {
  const head = document.querySelector('#docHead').getBoundingClientRect().bottom;
  const target = [...document.querySelectorAll('#docRoot h1, #docRoot h2, #docRoot h3')].find((h) => h.textContent === ${JSON.stringify(heading)});
  return target.getBoundingClientRect().top - head;
})()`;

const untilBelowHead = async (heading: string): Promise<void> => {
  const gap = gapBelowHead(heading);
  await until(`${gap} >= 0 && ${gap} < 40`).catch(async () => {
    const pane = await evaluate(
      "(() => { const p = document.querySelector('#docPane'); return { scrollTop: p.scrollTop, maxScroll: p.scrollHeight - p.clientHeight, hash: location.hash, viewport: [innerWidth, innerHeight] }; })()",
    );
    throw new Error(
      `"${heading}" sits ${await evaluate(gap)}px below the header, not 0-39px: ${JSON.stringify(pane)}`,
    );
  });
};

const barShown = "!document.querySelector('#selbar').hidden";
const commenting = "document.querySelector('#docPane').classList.contains('commenting')";

const ensureCommentMode = async (): Promise<void> => {
  if ((await evaluate(commenting)) !== true) await page.click("#modeBtn");
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

// Stores the run afresh, with STATE or none: a seeded state starts at event 0, so events left
// from another test would replay onto it.
const storeRun = async (storage: IStorage, run: WorkflowRun, state?: State): Promise<void> => {
  await storage.runs.removeRun(run.id);
  await seedRun(storage, run, state);
};

// Every test starts from the seeded files, no comments and no state: removing the run row takes
// its comments.
const resetRun = async (storage: IStorage, run: WorkflowRun, runDir: string): Promise<void> => {
  stopDeliveries();
  await storeRun(storage, run);
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
  // a file storage: the orchestrate commands this suite spawns open the same home's yok.db
  let storage: IStorage;
  let run: WorkflowRun;
  const putState = (state: State) => storeRun(storage, run, state);

  beforeAll(async () => {
    home = tempDir();
    storage = openStorage(home);
    cwd = tempDir();
    execFileSync("git", ["init", "-q"], { cwd });
    runDir = join(cwd, ".yok", "demo");
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "sample.ts"), `${SAMPLE.join("\n")}\n`);
    run = {
      id: "r1",
      project: "demo",
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
    const { host, calls } = fakeHost(EMPTY_BOX);
    typed = calls;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: viewerRoutes({
        providerFor: () => claudeOver(host),
        host,
        log: noopLogger,
        now: () => new Date(),
        storage,
        stopping: new AbortController().signal,
        openInEditor: (target) => {
          opened.push(target);
          return { ok: true, value: null };
        },
      }).fetch,
    });
    viewer = { origin: `http://localhost:${server.port}`, stop: () => server.stop(true) };
    url = `${viewer.origin}/runs/r1`;
  });

  beforeEach(() => resetRun(storage, run, runDir));

  afterAll(async () => {
    stopDeliveries();
    await viewer.stop();
    await storage.close();
  });

  test("SC33, SC14: Comment mode gates the selection bar, Add to batch holds comments listed by place until Send 2, and both reach the agent's status", async () => {
    await page.goto(`${url}#artifacts/design.md`);
    await until("!!document.querySelector('#docRoot')");
    await evaluate("localStorage.setItem('yok-viewer:comment-mode','off')");
    await page.reload();
    await until("!!document.querySelector('#docRoot')");

    await selectText(false, "one file per run");
    await Bun.sleep(600);
    expect(await evaluate(barShown)).toBe(false);

    await page.click("#modeBtn");
    await selectText(false, "one file per run");
    await until(barShown);

    await page.click("#selbar button[data-kind=comment]");
    await page.fill("#composerText", "Why only one file?");
    await page.click("#batchBtn");
    await until("document.querySelector('.batch') !== null");
    expect(await evaluate("document.querySelector('#docRoot mark.hl.is-draft') !== null")).toBe(
      true,
    );
    expect(await evaluate("document.querySelector('.batch .group-label').textContent")).toContain(
      "Not sent yet",
    );

    await selectText(false, "Start small");
    await until(barShown);
    await page.click("#selbar button[data-kind=comment]");
    await page.fill("#composerText", "How small?");
    await page.click("#batchBtn");
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
    await page.click("#sendBtn");
    await until("document.querySelector('.batch') === null");
    await until(
      "[...document.querySelectorAll('#threads .card .status')].filter((s) => s.textContent === 'With the agent').length === 2",
      5000,
    );
  }, 60000);

  test("SC324 (SC34): a reply sent by the agent from another process and an edit by the agent appear without a reload", async () => {
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
    await page.goto(`${url}#artifacts/design.md`);
    await until("!!document.querySelector('#threads .card[data-cid=c1]')");

    // Not spawnSync: that would freeze this process, whose server may hold a run lock the command waits for.
    const reply = Bun.spawn(
      [
        "bun",
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
        env: { ...process.env, YOK_RUN_ID: undefined, YOK_HOME: home },
        stdout: "ignore",
        stderr: "inherit",
      },
    );
    expect(await reply.exited).toBe(0);
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
    const [c1] = await storage.comments.list("r1");
    expect(c1?.thread.at(-1)).toMatchObject({ by: "agent", text: "Simpler to review." });
  }, 30000);

  test("SC35: text selected inside an HTML artifact becomes a comment with an element path", async () => {
    await page.goto(`${url}#artifacts/mock.html`);
    await until(
      "document.querySelector('#htmlFrame')?.contentDocument?.getElementById('go')?.textContent === 'Continue'",
    );
    await ensureCommentMode();
    await selectText(true, "Sign in");
    await until(barShown);
    await page.click("#selbar button[data-kind=comment]");
    await page.fill("#composerText", "Make the title bolder");
    await page.click("#batchBtn");
    await until("document.querySelector('.batch') !== null");
    await page.click("#sendBtn");
    await until("document.querySelector('.batch') === null");
    await until(
      "[...document.querySelectorAll('#threads .loc')].some((l) => l.textContent.includes('div.mk-card > h2.mk-title'))",
    );
  }, 30000);

  test("an HTML artifact loads a sibling module script and fetches a sibling file, and the fetched text takes a comment", async () => {
    await page.goto(`${url}#artifacts/module.html`);
    const text = (id: string): string =>
      `document.querySelector('#htmlFrame')?.contentDocument?.getElementById('${id}')?.textContent`;
    await until(`${text("mod")} === 'module ran' && ${text("data")} === 'fetched'`);
    await ensureCommentMode();
    await selectText(true, "fetched");
    await until(barShown);
    await page.click("#selbar button[data-kind=comment]");
    await page.fill("#composerText", "Say where this came from");
    await page.click("#sendNowBtn");
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
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto(`${url}#artifacts/code.md`);
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
    await page.goto(`${url}#artifacts/outline.md`);
    await until("document.querySelectorAll('#outline button').length > 0");
    expect(
      await evaluate("[...document.querySelectorAll('#outline button')].map((b) => b.textContent)"),
    ).toEqual(["Outline", "One", "Two", "Three", "Three detail"]);

    await page.setViewportSize({ width: 1000, height: 800 });
    await page.click("#outline li:nth-child(4) button");
    await untilBelowHead("Three");
    expect(await evaluate("location.hash")).toBe("#artifacts/outline.md#three");
    await until(
      "document.querySelector('#outline button[aria-current=\"true\"]')?.textContent === 'Three'",
    );
  }, 30000);

  test("a code block copies its code, and one over 40 lines opens folded until asked", async () => {
    await page.goto(`${url}#artifacts/code.md`);
    await until("!!document.querySelector('#docRoot pre .copy-btn')");
    const fold =
      "document.querySelector('#docRoot pre.language-ts, #docRoot pre:has(code.language-ts)')";
    expect(
      await evaluate(
        `${fold}.classList.contains('folded') && ${fold}.clientHeight < ${fold}.scrollHeight`,
      ),
    ).toBe(true);
    expect(await evaluate("document.querySelector('#docRoot .fold-btn').dataset.more")).toBe("20");
    await page.click("#docRoot .fold-btn");
    expect(await evaluate(`${fold}.classList.contains('folded')`)).toBe(false);

    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.click("#docRoot pre:has(code.language-ts) .copy-btn");
    await until(
      "document.querySelector('#docRoot pre:has(code.language-ts) .copy-btn').dataset.state === 'copied'",
    );
    expect(await evaluate("navigator.clipboard.readText()")).toContain("const line50 = 50;");
  }, 30000);

  test("a diff shows more of its file above and below on request, until the file runs out", async () => {
    await page.goto(`${url}#artifacts/steps.md`);
    await until("!!document.querySelector('#docRoot .hunk .expand-btn')");
    const hunk = "document.querySelector('#docRoot .hunk')";
    const shown = `[${hunk}.dataset.from, ${hunk}.dataset.to].join('-')`;
    expect(await evaluate(shown)).toBe("19-21");

    await page.click("#docRoot .expand-btn[data-dir=up]");
    await until(`${shown} === '9-21'`);
    expect(await evaluate(`${hunk}.querySelector('.diff-line').textContent`)).toBe(
      " export const v9 = 9;",
    );
    expect(await evaluate(`!!${hunk}.querySelector('.diff-line .hljs-keyword')`)).toBe(true);

    await page.click("#docRoot .expand-btn[data-dir=up]");
    await until(`${shown} === '1-21'`);
    expect(await evaluate(`${hunk}.querySelector('.expand-btn[data-dir=up]').hidden`)).toBe(true);
    for (const expected of ["1-31", "1-40"]) {
      await page.click("#docRoot .expand-btn[data-dir=down]");
      await until(`${shown} === '${expected}'`);
    }
    expect(await evaluate(`${hunk}.querySelector('.expand-btn[data-dir=down]').hidden`)).toBe(true);
  }, 30000);

  test("a file path, a diff and the open artifact each open in the editor at their line", async () => {
    await page.goto(`${url}#artifacts/steps.md`);
    await until("!!document.querySelector('#docRoot code[data-path]')");
    opened.length = 0;
    await page.click("#docRoot code[data-path]");
    await until("!document.querySelector('#toast').hidden");
    await page.click("#docRoot pre[data-file] .open-btn");
    await page.click("#editBtn");
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
    await putState(state);
    const typedBefore = typed.length;
    try {
      const approveHidden = "document.querySelector('#approveBtn').hidden";
      await page.goto(`${url}#artifacts/code.md`);
      await until("document.querySelector('#docPath').textContent === 'artifacts/code.md'");
      expect(await evaluate(approveHidden)).toBe(true);

      await page.goto(`${url}#artifacts/design.md`);
      await until(
        `document.querySelector('#docPath').textContent === 'artifacts/design.md' && !${approveHidden}`,
      );
      expect(await evaluate("document.querySelector('#docBadge').textContent")).toBe(
        "Waiting for your approval",
      );
      await page.click("#approveBtn");
      expect(await evaluate(approveHidden)).toBe(true);
      await until(
        "[...document.querySelectorAll('#threads .card .chip')].some((c) => c.textContent === 'Approved')",
      );
      expect(await evaluate(approveHidden)).toBe(true);
      const after = await storage.events("r1").readState();
      expect(after?.nodeRuns.design).not.toHaveProperty("awaitingApproval");
      const typedNow = () => typed.slice(typedBefore);
      for (let i = 0; i < 50 && !typedNow().some((t) => t.includes("approved:")); i++)
        await Bun.sleep(100);
      expect(typedNow().filter((t) => t.includes("approved: finish the stage"))).toHaveLength(1);
    } finally {
      await storeRun(storage, run);
    }
  }, 30000);

  test("SC531: an unattended run's page draws no Comment mode button", async () => {
    const policies = { values: { interaction: false }, sources: { interaction: "cli" as const } };
    await putState({ ...seedState(runDir, {}), policies });
    try {
      await page.goto(`${url}#artifacts/design.md`);
      await until("document.querySelector('#modeBtn').hidden === true");
      expect(await evaluate("getComputedStyle(document.querySelector('#modeBtn')).display")).toBe(
        "none",
      );
    } finally {
      await storeRun(storage, run);
    }
  }, 30000);

  test("SC13: Send posts one comment at once, Control+Enter does the same, no batch appears, and stored anchors keep their lines", async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${url}#artifacts/design.md`);
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
    await page.click("#selbar button[data-kind=comment]");
    await page.fill("#composerText", "Say how small.");
    await page.click("#sendNowBtn");

    await selectText(false, "second sentence");
    await until(barShown);
    await page.click("#selbar button[data-kind=comment]");
    await page.fill("#composerText", "Cut the second sentence.");
    await page.keyboard.press("Control+Enter");

    for (const text of ["Say how small.", "Cut the second sentence."])
      await until(`${cardWith(text)}?.querySelector('.status')?.textContent === 'With the agent'`);
    expect(await evaluate("window.sawBatch")).toBe(false);
    const stored = await storage.comments.list("r1");
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
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${url}#artifacts/design.md`);
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
    await putState(state);
    const approveHidden = "document.querySelector('#approveBtn').hidden";
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${url}#artifacts/design.md`);
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
      await page.click("#selbar button[data-kind=comment]");
      await page.fill("#composerText", "Never sent.");
      await page.click("#sendNowBtn");

      await until(`!!${cardWith("Never sent.")}?.closest('.batch')`);
      expect(await evaluate("document.querySelector('.batch .group-label').textContent")).toBe(
        "Not sent yet · 1",
      );
      expect(await evaluate("document.querySelector('.batch .send-error').textContent")).toContain(
        "disk full",
      );

      await page.click("#approveBtn");
      await until("!document.querySelector('#toast').hidden");
      expect(await evaluate("document.querySelector('#toast').textContent")).toContain("disk full");
      await until(`!${approveHidden}`);
    } finally {
      await storeRun(storage, run);
    }
  }, 30000);

  test("SC16: hovering the second bullet in comment mode marks that bullet, while the list and the other bullets stay transparent", async () => {
    await page.goto(`${url}#artifacts/list.md`);
    await until("document.querySelectorAll('#docRoot li').length === 3");
    await ensureCommentMode();
    await page.hover("#docRoot li:nth-child(2)");
    expect(
      await evaluate(
        "['ul', 'li:nth-child(1)', 'li:nth-child(2)', 'li:nth-child(3)'].map((s) => getComputedStyle(document.querySelector('#docRoot ' + s)).backgroundColor !== 'rgba(0, 0, 0, 0)')",
      ),
    ).toEqual([false, false, true, false]);
  }, 30000);
  const box = (n: number): string => `#docRoot li.task:nth-of-type(${n}) .task-box`;
  const awaiting = async (file: string): Promise<void> => {
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
    await putState(state);
  };
  const openFile = async (file: string): Promise<void> => {
    await page.goto(`${url}#artifacts/${file}`);
    await until(`document.querySelector('#docPath').textContent === 'artifacts/${file}'`);
    await until("!!document.querySelector('#docRoot .task-box')");
  };
  const batchLabel = "(document.querySelector('.batch .group-label')?.textContent ?? '')";

  test("SC40: a checklist's boxes can only be clicked while its file waits for approval", async () => {
    await openFile("factors.md");
    expect(await evaluate(`document.querySelector('${box(1)}').disabled`)).toBe(true);
    await awaiting("factors.md");
    try {
      await page.reload();
      await until("!document.querySelector('#approveBtn').hidden");
      await until(`!document.querySelector('${box(1)}').disabled`);
    } finally {
      await storeRun(storage, run);
    }
  }, 30000);

  test("SC41: each box changed from the file adds one draft, a box changed back removes it, and Send delivers them as one message", async () => {
    await awaiting("factors.md");
    try {
      await openFile("factors.md");
      await until(`!document.querySelector('${box(2)}').disabled`);
      await page.click(box(2));
      expect(await evaluate(`document.querySelector('${box(2)}').checked`)).toBe(false);
      await until(`${batchLabel} === 'Not sent yet · 1'`);
      expect(await evaluate(`!!${cardWith("Untick this")}`)).toBe(true);

      await page.click(box(2));
      await until("!document.querySelector('.batch')");
      expect(await evaluate(`document.querySelector('${box(2)}').checked`)).toBe(true);

      await page.click(box(2));
      await page.click(box(3));
      await until(`${batchLabel} === 'Not sent yet · 2'`);
      expect(await evaluate(`!!${cardWith("Tick this")}`)).toBe(true);
      const before = typed.length;
      await page.click("#sendBtn");
      await until("!document.querySelector('.batch')");
      for (let i = 0; i < 50 && typed.length === before; i++) await Bun.sleep(100);
      const message = typed.slice(before).join("\n");
      expect(message).toContain(
        'factors.md:4 on "F2 Threshold: decides the discount"\n  Untick this',
      );
      expect(message).toContain('factors.md:5 on "F3 Quantity: refuses a bad cart"\n  Tick this');
    } finally {
      await storeRun(storage, run);
    }
  }, 30000);

  test("SC42: Approve sends the waiting drafts with the approval, in one message with the approval last", async () => {
    await awaiting("scenarios.md");
    try {
      await openFile("scenarios.md");
      await until(`!document.querySelector('${box(1)}').disabled`);
      await page.click(box(1));
      await until(`${batchLabel} === 'Not sent yet · 1'`);
      const before = typed.length;
      await page.click("#approveBtn");
      await until("!document.querySelector('.batch')");
      for (let i = 0; i < 50 && !typed.slice(before).some((t) => t.includes("approved:")); i++)
        await Bun.sleep(100);
      const message = typed.slice(before).find((t) => t.includes("approved:")) ?? "";
      expect(message).toContain('scenarios.md:3 on "F1 Coupon: changes the total"\n  Untick this');
      expect(message.indexOf("Untick this")).toBeLessThan(message.indexOf("approved:"));
    } finally {
      await storeRun(storage, run);
    }
  }, 30000);
  test("the file list groups files under the stage that delivered them, with folders, the rest after a divider, and a bare link opens the first stage's file", async () => {
    const delivered = (...paths: readonly string[]) => ({
      nodeRunId: "n",
      nodeType: "agent" as const,
      status: "completed" as const,
      startedAt: null,
      completedAt: null,
      artifacts: paths.map((path) => ({ type: "file", name: path, path })),
    });
    writeFileSync(
      join(runDir, "workflow.yaml"),
      [
        "name: w",
        "nodes:",
        "  - { id: design, type: agent, stage: design, input: {} }",
        "  - { id: plan, type: agent, stage: planning, dependsOn: [design], input: {} }",
        "  - { id: review, type: agent, stage: code-review, dependsOn: [plan], input: {} }",
        "",
      ].join("\n"),
    );
    mkdirSync(join(runDir, "artifacts", "ux"));
    writeFileSync(join(runDir, "artifacts", "ux", "flow.md"), "# Flow\n");
    mkdirSync(join(runDir, "artifacts", "notes"));
    writeFileSync(join(runDir, "artifacts", "notes", "todo.md"), "# Todo\n");
    const state = seedState(runDir, {
      design: delivered("artifacts/design.md"),
      plan: delivered("artifacts/outline.md", "artifacts/code.md"),
      review: delivered("artifacts/mock.html", "artifacts/ux/flow.md"),
    });
    await putState(state);
    try {
      await page.goto(`${url}#artifacts/design.md`);
      await until(
        "document.querySelectorAll('#fileList .stage').length === 3 && document.querySelectorAll('#fileList .folder').length === 2",
      );
      const tree = await evaluate(
        "(function walk(ul) { return [...ul.children].map((li) => { if (li.classList.contains('divider')) return '---'; const label = li.querySelector(':scope > .stage, :scope > .folder'); return label ? [label.textContent, walk(li.querySelector(':scope > ul'))] : li.querySelector('.name').textContent; }); })(document.querySelector('#fileList'))",
      );
      expect(tree).toEqual([
        ["design", ["design.md"]],
        ["planning", ["code.md", "outline.md"]],
        ["code-review", ["mock.html", ["ux/", ["flow.md"]]]],
        "---",
        "factors.md",
        "list.md",
        "module.html",
        "module.js",
        "module.json",
        "scenarios.md",
        "steps.md",
        ["notes/", ["todo.md"]],
      ]);
      expect(await evaluate("document.querySelectorAll('#fileList .draft-dot').length")).toBe(0);

      await page.goto(url);
      await until(
        "document.querySelector('#fileList [aria-current=\"true\"] .name')?.textContent === 'design.md'",
      );
    } finally {
      rmSync(join(runDir, "workflow.yaml"), { force: true });
      await storeRun(storage, run);
      rmSync(join(runDir, "artifacts", "ux"), { recursive: true, force: true });
      rmSync(join(runDir, "artifacts", "notes"), { recursive: true, force: true });
    }
  }, 30000);
});

// The runs page reads the run list from /stream, so this suite seeds the runs and the users
// and drives that page.
describe("runs page in a browser", () => {
  let viewer: Readonly<{ origin: string; stop: () => Promise<void> }>;
  const storage: IStorage = memoryStorage();

  beforeAll(async () => {
    const cwd = tempDir();
    const ritesh = await seedUser(storage, {
      name: "ritesh-gh",
      email: "ritesh@example.com",
      github: { id: 8675309, login: "ritesh-gh" },
    });
    const asha = await seedUser(storage, {
      name: "Asha",
      email: "asha@example.com",
      github: { id: 42, login: "asha-gh" },
    });
    const base = {
      project: "demo",
      workflow: "w",
      workflowPath: "/w.yaml",
      inputs: {},
      cwd,
      sessions: [],
      name: null,
      terminal: null,
      config: null,
      tiers: null,
    };
    const owners = [
      ["r-1", ritesh],
      ["r-2", asha],
      ["r-3", ritesh],
      ["r-4", undefined],
    ] as const;
    for (const [n, [id, user]] of owners.entries()) {
      const createdAt = `2026-10-29T10:0${n}:00.000Z`;
      // ritesh-gh's runs are named with no run folder, so they read missing and land in the Recent table.
      const name = user === ritesh ? id : null;
      await seedRun(storage, {
        ...base,
        id,
        name,
        createdAt,
        ...(user === undefined ? {} : { user }),
      });
    }
    const runDir = join(cwd, ".yok", "stuck");
    mkdirSync(runDir, { recursive: true });
    const blocker = {
      reason: "question" as const,
      node: "planning",
      since: "2026-10-29T10:06:00.000Z",
      details: { questions: [{ question: "Which store for Asha?", options: ["a", "b"] }] },
    };
    const stuck = {
      ...seedState(runDir, {}),
      runName: "stuck",
      status: "blocked" as const,
      blocker,
    };
    await seedRun(
      storage,
      {
        ...base,
        id: "r-5",
        name: "stuck",
        terminal: "s1",
        user: asha,
        createdAt: "2026-10-29T10:05:00.000Z",
      },
      stuck,
    );
    const { host } = fakeHost(EMPTY_BOX);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: viewerRoutes({
        providerFor: () => claudeOver(host),
        host,
        log: noopLogger,
        now: () => new Date(),
        storage,
        stopping: new AbortController().signal,
        openInEditor: () => ({ ok: true, value: null }),
      }).fetch,
    });
    viewer = { origin: `http://localhost:${server.port}`, stop: () => server.stop(true) };
  });

  afterAll(() => viewer.stop());

  const allCount = "document.querySelector('#tabs .tab .n').textContent";
  const shownIds =
    "[...document.querySelectorAll('#list .item a.open')].map((a) => a.getAttribute('href').split('/').pop())";
  const byCells =
    "[...document.querySelectorAll('#list .row.item .owner')].map((s) => s.textContent)";
  const bannerShown =
    "[...document.querySelectorAll('#list .banner')].map((b) => b.textContent.includes('Which store for Asha?'))";

  test("SC126 (SC41): picking ritesh-gh in Started by, or searching ritesh@, narrows All to ritesh-gh's 2 runs, and Asha's blocked run keeps its banner", async () => {
    await page.goto(viewer.origin);
    await until("document.querySelectorAll('#who option').length === 3");
    expect(
      await evaluate("[...document.querySelectorAll('#who option')].map((o) => o.textContent)"),
    ).toEqual(["Anyone", "Asha (asha-gh)", "ritesh-gh (ritesh-gh)"]);

    await page.selectOption("#who", { label: "ritesh-gh (ritesh-gh)" });
    await until(`${allCount} === "2"`);
    expect(await evaluate(shownIds)).toEqual(["r-3", "r-1"]);
    expect(await evaluate(byCells)).toEqual(["ritesh-gh (ritesh-gh)", "ritesh-gh (ritesh-gh)"]);
    expect(await evaluate(bannerShown)).toEqual([true]);

    await page.selectOption("#who", { label: "Anyone" });
    await until(`${allCount} === "5"`);
    await page.fill("#search", "ritesh@");
    await until(`${allCount} === "2"`);
    expect(await evaluate(shownIds)).toEqual(["r-3", "r-1"]);
    expect(await evaluate(byCells)).toEqual(["ritesh-gh (ritesh-gh)", "ritesh-gh (ritesh-gh)"]);
    expect(await evaluate(bannerShown)).toEqual([true]);
  }, 60000);

  test("the header stays at the top and the version footer at the bottom of the window on a long page at its top and at its end, and on a page too short to scroll", async () => {
    const edges =
      "(() => ({ header: document.querySelector('header.bar').getBoundingClientRect().top, footer: Math.round(document.querySelector('footer.foot').getBoundingClientRect().bottom), height: innerHeight }))()";
    await page.setViewportSize({ width: 393, height: 300 });
    await page.goto(viewer.origin);
    await until(`${allCount} === "5"`);
    expect(await evaluate("document.documentElement.scrollHeight > innerHeight + 100")).toBe(true);
    expect(await evaluate(edges)).toEqual({ header: 0, footer: 300, height: 300 });
    await evaluate("window.scrollTo(0, document.documentElement.scrollHeight)");
    expect(await evaluate(edges)).toEqual({ header: 0, footer: 300, height: 300 });

    await page.setViewportSize({ width: 1280, height: 2000 });
    expect(await evaluate(edges)).toEqual({ header: 0, footer: 2000, height: 2000 });
  }, 60000);

  test("focusing the search box or a status tab after scrolling down the list leaves the page where it was", async () => {
    await page.setViewportSize({ width: 393, height: 420 });
    await page.goto(viewer.origin);
    await until(`${allCount} === "5"`);
    await evaluate("window.scrollTo(0, 200)");
    expect(await evaluate("scrollY")).toBe(200);
    await page.keyboard.press("/");
    expect(await evaluate("[document.activeElement.id, scrollY]")).toEqual(["search", 200]);
    await evaluate("document.querySelector('#tabs .tab').focus()");
    expect(await evaluate("scrollY")).toBe(200);
  }, 60000);

  test.each([
    [1280, 240],
    [393, 420],
  ])(
    "at %ix%i, Tab and Shift+Tab through the runs list never leave the focused link under the pinned header or footer",
    async (width, height) => {
      // Each stop reads null outside the list, "ok" when the focused element is clear of both bars, else its text.
      const stop =
        "(() => { const el = document.activeElement; if (!document.querySelector('#list').contains(el)) return null; const r = el.getBoundingClientRect(); const clear = r.top >= document.querySelector('.top').getBoundingClientRect().bottom - 1 && r.bottom <= document.querySelector('footer.foot').getBoundingClientRect().top + 1; return clear ? 'ok' : el.textContent.trim().slice(0, 40); })()";
      await page.setViewportSize({ width, height });
      await page.goto(viewer.origin);
      await until(`${allCount} === "5"`);
      expect(await evaluate("document.documentElement.scrollHeight > innerHeight + 100")).toBe(
        true,
      );
      const stops: unknown[] = [];
      for (const key of [...Array(30).fill("Tab"), ...Array(30).fill("Shift+Tab")]) {
        await page.keyboard.press(key);
        stops.push(await evaluate(stop));
      }
      expect(stops.filter((s) => s === "ok").length).toBeGreaterThan(5);
      expect(stops.filter((s) => s !== null && s !== "ok")).toEqual([]);
    },
    60000,
  );

  test("a starter's name that is one long word wraps inside its card on a phone, so the page never scrolls sideways", async () => {
    const rename = (name: string) =>
      storage.users.saveGitHubUser({
        id: 42,
        login: "asha-gh",
        name,
        email: "asha@example.com",
        token: "gho_x",
      });
    const long = "A".repeat(80);
    await rename(long);
    try {
      await page.setViewportSize({ width: 393, height: 852 });
      await page.goto(viewer.origin);
      await until(
        `[...document.querySelectorAll('.card .owner')].some((s) => s.textContent.startsWith(${JSON.stringify(long)}))`,
      );
      expect(
        await evaluate(
          "document.documentElement.scrollWidth - document.documentElement.clientWidth",
        ),
      ).toBe(0);
    } finally {
      await rename("Asha");
    }
  }, 60000);
});

describe("terminal tab in a browser", () => {
  const pane = "term-e2e";
  const socket = `yok-test-${randomUUID()}`;
  let serve: (() => void) | null = null;
  let stop: () => Promise<void> = async () => {};
  let url: string;
  let upgrades = 0;

  const tmux = (...args: string[]) =>
    spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
  const clientCount = (): number =>
    tmux("list-clients", "-t", `=${pane}:`, "-F", "#{client_name}")
      .stdout.split("\n")
      .filter((line) => line !== "").length;
  const windowWidth = (): number =>
    Number(tmux("display", "-p", "-t", `=${pane}:`, "#{window_width}").stdout.trim());
  const waitFor = async (check: () => boolean, ms = 10_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out waiting");
      await Bun.sleep(100);
    }
  };

  const screen = `(() => {
    const b = window.yokTerminal?.buffer.active;
    if (!b) return "";
    return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? "").join("\\n");
  })()`;
  const stateText = "document.querySelector('#termStateText').textContent";
  const stateHidden = "document.querySelector('#termState').hidden";

  const openTerminal = async (): Promise<void> => {
    await page.goto(url);
    await until("!document.querySelector('#tabTerminal').hidden", 10_000);
    await page.click("#tabTerminal");
    await until(`${screen}.includes("pane-ready") && ${stateHidden}`, 20_000);
    await waitFor(() => clientCount() === 1);
  };

  beforeAll(async () => {
    const home = tempDir();
    const cwd = tempDir();
    mkdirSync(join(cwd, ".yok", "demo", "artifacts"), { recursive: true });
    writeFileSync(join(cwd, ".yok", "demo", "artifacts", "design.md"), DESIGN);
    const host = yokTerminalHost({ YOK_HOME: home, YOK_TMUX_SOCKET: socket });
    const created = await host.create({
      name: pane,
      cwd,
      argv: ["sh", "-c", "echo pane-ready; exec sh"],
      env: { PS1: "$ " },
    });
    if (!created.ok) throw new Error(created.error);
    const storage = memoryStorage();
    await seedRun(storage, {
      id: "r1",
      project: "demo",
      workflow: "w",
      workflowPath: "/w.yaml",
      inputs: {},
      cwd,
      sessions: [{ agent: "claude", sessionId: "s1" }],
      name: "demo",
      terminal: pane,
      config: null,
      tiers: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const app = new Hono()
      .use("/api/runs/*", async (_c, next) => {
        upgrades++;
        await next();
      })
      .route(
        "/api/runs",
        terminalRoutes({ storage, host, log: noopLogger, stopping: new AbortController().signal }),
      )
      .route(
        "/",
        viewerRoutes({
          providerFor: () => claudeOver(host),
          host,
          log: noopLogger,
          now: () => new Date(),
          storage,
          stopping: new AbortController().signal,
          openInEditor: () => ({ ok: true, value: null }),
        }),
      );
    let port = 0;
    serve = () => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        idleTimeout: 0,
        fetch: app.fetch,
        websocket,
      });
      port = server.port as number;
      stop = () => server.stop(true);
    };
    serve();
    url = `http://localhost:${port}/runs/r1`;
  }, 30000);

  afterAll(async () => {
    stopDeliveries();
    await stop();
    tmux("kill-server");
  });

  test("SC13: the Terminal tab opens the live session's screen", async () => {
    await openTerminal();

    expect(await evaluate("document.querySelector('#tabTerminal').hidden")).toBe(false);
    expect(await evaluate(`${screen}.includes("pane-ready")`)).toBe(true);
    expect(await evaluate(stateHidden)).toBe(true);
    expect(
      await evaluate(
        "[...document.styleSheets].some((s) => s.href?.endsWith('xterm.css') && s.cssRules.length > 0)",
      ),
    ).toBe(true);
  }, 60000);

  test("SC13: two clicks while xterm.js loads open one terminal", async () => {
    await page.goto(url);
    await until("!document.querySelector('#tabTerminal').hidden", 10_000);

    await evaluate(
      "(() => { const tab = document.querySelector('#tabTerminal'); tab.click(); tab.click(); return true; })()",
    );
    await until(`${screen}.includes("pane-ready") && ${stateHidden}`, 20_000);
    await waitFor(() => clientCount() === 1);

    expect(await evaluate("document.querySelectorAll('#termHost .xterm').length")).toBe(1);
  }, 60000);

  const couldNotLoad = `${stateText}.startsWith("Could not load the terminal")`;
  const addonUrl =
    "https://cdn.jsdelivr.net/npm/@xterm/addon-unicode11@0.9.0/lib/addon-unicode11.js";

  test("SC13: a CDN file that is not the pinned one is refused", async () => {
    await page.route(addonUrl, (route) => route.fulfill({ body: JSON.stringify("tampered") }));
    try {
      await page.goto(url);
      await until("!document.querySelector('#tabTerminal').hidden", 10_000);
      await page.click("#tabTerminal");

      await until(couldNotLoad, 20_000);
    } finally {
      await page.unroute(addonUrl);
    }
  }, 60000);

  test("SC13: when the CDN cannot be reached it says so, and opening the tab again retries", async () => {
    await page.route(addonUrl, (route) => route.abort());
    try {
      await page.goto(url);
      await until("!document.querySelector('#tabTerminal').hidden", 10_000);
      await page.click("#tabTerminal");
      await until(couldNotLoad, 20_000);
    } finally {
      await page.unroute(addonUrl);
    }

    await page.click("#tabTerminal");

    await until(`${screen}.includes("pane-ready") && ${stateHidden}`, 20_000);
    await waitFor(() => clientCount() === 1);
  }, 60000);

  test("SC13: when xterm's stylesheet cannot be loaded it says so and opens no terminal", async () => {
    const cssUrl = "https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.css";
    await page.route(cssUrl, (route) => route.abort());
    try {
      await page.goto(url);
      await until("!document.querySelector('#tabTerminal').hidden", 10_000);
      await page.click("#tabTerminal");

      await until(couldNotLoad, 20_000);
      expect(await evaluate("document.querySelectorAll('#termHost .xterm').length")).toBe(0);
    } finally {
      await page.unroute(cssUrl);
    }
  }, 60000);

  test("SC20: a hyperlink whose text hides its address opens only after the address is confirmed", async () => {
    await openTerminal();
    // A program in the pane prints the link, as an agent's command would.
    tmux(
      "send-keys",
      "-t",
      `=${pane}:`,
      "-l",
      "printf '\\e]8;;https://evil.example/\\agithub.com\\e]8;;\\a\\n'",
    );
    tmux("send-keys", "-t", `=${pane}:`, "Enter");
    await until(`${screen}.split("\\n").includes("github.com")`, 10_000);
    const at = (await evaluate(`(() => {
      const row = ${screen}.split("\\n").indexOf("github.com");
      const r = document.querySelector('#termHost .xterm-screen').getBoundingClientRect();
      return { x: Math.round(r.left + 2.5 * (r.width / window.yokTerminal.cols)), y: Math.round(r.top + (row + 0.5) * (r.height / window.yokTerminal.rows)) };
    })()`)) as { x: number; y: number };
    const clickLink = async (): Promise<void> => {
      // Move in from another row: xterm looks for a link only when the mouse enters a new cell.
      await page.mouse.move(at.x, at.y + 60);
      await page.mouse.move(at.x, at.y);
      await Bun.sleep(200);
      await page.mouse.down();
      await page.mouse.up();
    };
    const stub = (answer: boolean): Promise<unknown> =>
      evaluate(`(() => {
        window.asked = []; window.opened = [];
        window.confirm = (text) => { window.asked.push(text); return ${answer}; };
        window.open = (uri) => { window.opened.push(uri); return null; };
        return true;
      })()`);

    await stub(false);
    await clickLink();
    await until("window.asked.length + window.opened.length > 0");
    expect(await evaluate("window.opened")).toEqual([]);
    expect(await evaluate("window.asked[0]")).toContain("https://evil.example/");

    await stub(true);
    await clickLink();
    await until("window.opened.length === 1");
    expect(await evaluate("window.opened")).toEqual(["https://evil.example/"]);
  }, 60000);

  test("SC20: a program in the pane can copy to the browser's clipboard but not read it", async () => {
    await openTerminal();
    await evaluate(`(() => {
      window.copied = [];
      Object.defineProperty(navigator, "clipboard", { value: { readText: async () => "secret-clip", writeText: async (text) => { window.copied.push(text); } } });
      window.sentFrames = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) { window.sentFrames.push(String(data)); return send.call(this, data); };
      window.yokTerminal.write("\\x1b]52;c;?\\x07");
      window.yokTerminal.write("\\x1b]52;c;${btoa("copied-out")}\\x07");
      return true;
    })()`);
    await Bun.sleep(500);

    const sent = (await evaluate("window.sentFrames.join('\\n')")) as string;
    expect(sent).not.toContain(btoa("secret-clip"));
    expect(await evaluate("window.copied")).toEqual(["copied-out"]);
  }, 60000);

  // tmux leaves the selection field of its OSC 52 empty, as a mouse-drag copy does.
  test("SC20: a tmux copy reaches the browser's clipboard", async () => {
    await openTerminal();
    await evaluate(`(() => {
      window.copied = [];
      Object.defineProperty(navigator, "clipboard", { value: { readText: async () => "", writeText: async (text) => { window.copied.push(text); } } });
      return true;
    })()`);
    const client = tmux("list-clients", "-t", `=${pane}:`, "-F", "#{client_name}").stdout.trim();

    tmux("set-buffer", "-w", "-t", client, "copied-by-tmux");

    await until(`window.copied.includes("copied-by-tmux")`);
  }, 60000);

  // The fitted terminal must fit the window both ways: a row or column too many hides Claude's
  // mode line or scrolls the page sideways.
  test.each([
    ["1280", "800"],
    ["900", "700"],
    ["600", "700"],
  ])(
    "SC15: at %sx%s the fitted terminal stays inside the window",
    async (width, height) => {
      await page.setViewportSize({ width: Number(width), height: Number(height) });
      await openTerminal();
      const deadline = Date.now() + 10_000;
      while ((await evaluate("window.yokTerminal.cols")) !== windowWidth()) {
        if (Date.now() > deadline) throw new Error("tmux never matched the terminal's width");
        await Bun.sleep(100);
      }

      const fit = (await evaluate(`(() => {
        const s = document.querySelector('#termHost .xterm-screen').getBoundingClientRect();
        const d = document.documentElement;
        return { bottom: s.bottom, right: s.right, tall: d.scrollHeight - innerHeight, wide: d.scrollWidth - d.clientWidth };
      })()`)) as { bottom: number; right: number; tall: number; wide: number };
      expect(fit.bottom).toBeLessThanOrEqual(Number(height));
      expect(fit.right).toBeLessThanOrEqual(Number(width));
      expect(fit.tall).toBeLessThanOrEqual(0);
      expect(fit.wide).toBe(0);
    },
    60000,
  );

  test("SC14: keys typed in the terminal reach the session", async () => {
    await openTerminal();

    await page.keyboard.type("echo typed-$((40+2))");
    await page.keyboard.press("Enter");

    await waitFor(() =>
      tmux("capture-pane", "-p", "-t", `=${pane}:`).stdout.split("\n").includes("typed-42"),
    );
    await until(`${screen}.split("\\n").includes("typed-42")`);
  }, 60000);

  test("SC15: the terminal follows the window's size", async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openTerminal();
    const sameWidth = async (): Promise<number> => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const cols = await evaluate("window.yokTerminal.cols");
        if (cols === windowWidth()) return cols as number;
        await Bun.sleep(100);
      }
      throw new Error("tmux never matched the terminal's width");
    };
    const wide = await sameWidth();

    await page.setViewportSize({ width: 900, height: 700 });
    await until(`window.yokTerminal.cols < ${wide}`);
    const narrow = await sameWidth();

    expect(narrow).toBeLessThan(wide);
  }, 60000);

  test("SC16: Ctrl-\\ detaches to a Reattach button, and Reattach comes back", async () => {
    await openTerminal();

    await page.keyboard.press("Control+\\");
    await until(`${stateText} === "Detached from the run's session."`);
    expect(await evaluate("!document.querySelector('#reattachBtn').hidden")).toBe(true);
    const seen: number[] = [];
    for (let i = 0; i < 30; i++) {
      seen.push(clientCount());
      await Bun.sleep(100);
    }
    expect(Math.max(...seen)).toBe(0);

    await page.click("#reattachBtn");
    await until(stateHidden);
    await waitFor(() => clientCount() === 1);
  }, 60000);

  test("SC17: a dropped connection reconnects by itself", async () => {
    await openTerminal();

    await stop();
    await until(`${stateText}.startsWith("Connection lost. Reconnecting")`);
    serve?.();

    await until(stateHidden, 15_000);
    await waitFor(() => clientCount() === 1);
  }, 60000);

  // Last: it ends the session the other tests attach to.
  test("SC18: a session that ends shows the attach wording, with no reconnect loop, and the tab hides", async () => {
    await openTerminal();

    tmux("kill-session", "-t", `=${pane}`);
    await until(`${stateText} === "Detached from the run's session."`);
    await page.click("#reattachBtn");
    await until(
      `${stateText} === "Run demo has no running session. Resume it with: yok resume demo"`,
    );
    const before = upgrades;
    await Bun.sleep(3000);

    expect(upgrades).toBe(before);
    await until("document.querySelector('#pillText').textContent === 'Agent not running'", 10_000);
    expect(await evaluate("document.querySelector('#tabTerminal').hidden")).toBe(true);
  }, 60000);
});

describe("resume and retry buttons in a browser", () => {
  let runDir: string;
  const storage = memoryStorage();
  let run: WorkflowRun;
  let viewer: Readonly<{ stop: () => Promise<void> }>;
  let url: string;
  // what the pane reports; the page's stream reads it once a second
  let alive = false;
  // the stub's next answers, in order, and every request it saw
  let answers: (() => Response | Promise<Response>)[] = [];
  const posted: { path: string; body: unknown }[] = [];

  beforeAll(async () => {
    const cwd = tempDir();
    execFileSync("git", ["init", "-q"], { cwd });
    runDir = join(cwd, ".yok", "demo");
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    run = {
      id: "r1",
      project: "demo",
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
    await seedRun(storage, run);
    const fake = fakeHost(EMPTY_BOX).host;
    const host = { ...fake, find: () => ({ ...fakePane("s1"), isAlive: async () => alive }) };
    // The routes phase 1's tests cover; here only what the page does with their answers.
    const stub = new Hono().post("/api/runs/:action", async (c) => {
      posted.push({ path: c.req.path, body: await c.req.json() });
      const answer = answers.shift();
      return answer === undefined
        ? c.json({ error: { code: "conflict", message: "none" } }, 409)
        : answer();
    });
    const views = viewerRoutes({
      providerFor: () => claudeOver(host),
      host,
      log: noopLogger,
      now: () => new Date(),
      storage,
      openInEditor: () => ({ ok: true, value: null }),
      stopping: new AbortController().signal,
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: (request) =>
        request.method === "POST" && new URL(request.url).pathname.startsWith("/api/runs/")
          ? stub.fetch(request)
          : views.fetch(request),
    });
    viewer = { stop: () => server.stop(true) };
    url = `http://localhost:${server.port}/runs/r1`;
  });

  beforeEach(() => {
    stopDeliveries();
    alive = false;
    answers = [];
    posted.length = 0;
  });

  afterAll(async () => {
    stopDeliveries();
    await viewer.stop();
  });

  // The server keeps a finished run's files, so a status another test wrote would stay.
  const seedStatus = async (status: State["status"]): Promise<void> => {
    await storeRun(storage, run, { ...seedState(runDir, {}), status });
    forgetFinishedRun(runDir);
  };

  const open = async (): Promise<void> => {
    await page.goto(url);
    await until("document.querySelector('#pillText').textContent !== 'Agent starting'", 10_000);
  };

  const hidden = (id: string) => evaluate(`document.querySelector('#${id}').hidden`);

  test.each([
    ["failed", false, { resume: true, retry: true }],
    ["blocked", false, { resume: true, retry: false }],
    ["completed", false, { resume: false, retry: false }],
    ["failed", true, { resume: false, retry: false }],
  ] as const)(
    "SC7115: a %s run whose agent is running=%p shows Resume and Retry as %o",
    async (status, running, shown) => {
      await seedStatus(status);
      alive = running;

      await open();
      await until(`!!document.querySelector('#runSummary').textContent`);

      expect({ resume: !(await hidden("resumeBtn")), retry: !(await hidden("retryBtn")) }).toEqual(
        shown,
      );
    },
    30000,
  );

  test("SC7116: Retry reads Retrying… with both buttons disabled while the request runs, then toasts and hands over to the running agent", async () => {
    await seedStatus("failed");
    const held = Promise.withResolvers<void>();
    answers = [
      async () => {
        await held.promise;
        return Response.json({ run: { id: "r1" }, attach: [], view: url });
      },
    ];
    await open();
    await until("!document.querySelector('#retryBtn').hidden");

    await page.click("#retryBtn");
    await until("document.querySelector('#retryBtn').textContent === 'Retrying…'");

    expect(await evaluate("document.querySelector('#retryBtn').disabled")).toBe(true);
    expect(await evaluate("document.querySelector('#resumeBtn').disabled")).toBe(true);
    expect(posted).toEqual([{ path: "/api/runs/retry", body: { run: { id: "r1" } } }]);

    held.resolve();
    await until(
      "document.querySelector('#toast').textContent === 'Run retried; the agent is starting'",
    );
    alive = true;
    await until("!document.querySelector('#tabTerminal').hidden", 10_000);
    expect(await hidden("retryBtn")).toBe(true);
    expect(await hidden("resumeBtn")).toBe(true);
  }, 30000);

  test("SC7117: a resume the doctor refuses keeps the message and the failing check with its fix on the page", async () => {
    await seedStatus("blocked");
    const report = {
      results: [
        {
          name: "LINEAR_API_KEY",
          status: "fail",
          optional: false,
          detail: "not set",
          fix: ["add it to .env"],
        },
      ],
      failed: ["LINEAR_API_KEY"],
      warned: [],
    };
    answers = [
      () =>
        Response.json(
          { error: { code: "bad-request", message: "BLOCKED LINEAR_API_KEY", details: report } },
          { status: 400 },
        ),
    ];
    await open();
    await until("!document.querySelector('#resumeBtn').hidden");

    await page.click("#resumeBtn");
    await until("!document.querySelector('#relaunchError').hidden");
    await Bun.sleep(4000);

    expect(await hidden("relaunchError")).toBe(false);
    expect(await evaluate("document.querySelector('#relaunchErrorText').textContent")).toBe(
      "BLOCKED LINEAR_API_KEY\nLINEAR_API_KEY: not set\n  fix: add it to .env",
    );
    expect(await hidden("answeredBtn")).toBe(true);
    expect(await evaluate("document.querySelector('#resumeBtn').disabled")).toBe(false);
  }, 30000);

  test("SC7118: a retry refused for a step waiting on an answer offers Retry as answered, which sends answered: true", async () => {
    await seedStatus("failed");
    const needsInput =
      "two failed needing a person's answer: Which database?\nOnce a person has dealt with it, retry with --answered";
    answers = [
      () => Response.json({ error: { code: "conflict", message: needsInput } }, { status: 409 }),
      () => Response.json({ run: { id: "r1" }, attach: [], view: url }),
    ];
    await open();
    await until("!document.querySelector('#retryBtn').hidden");

    await page.click("#retryBtn");
    await until("!document.querySelector('#answeredBtn').hidden");
    expect(await evaluate("document.querySelector('#relaunchErrorText').textContent")).toBe(
      needsInput,
    );

    await page.click("#answeredBtn");
    await until(
      "document.querySelector('#toast').textContent === 'Run retried; the agent is starting'",
    );

    expect(posted.map((call) => call.body)).toEqual([
      { run: { id: "r1" } },
      { run: { id: "r1" }, answered: true },
    ]);
    expect(await hidden("relaunchError")).toBe(true);
  }, 30000);

  test("on a 390px phone a failed run's Resume and Retry sit on one row with the agent pill", async () => {
    await seedStatus("failed");
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await open();
      await until("!document.querySelector('#retryBtn').hidden");

      const middles = await evaluate(
        "['resumeBtn', 'retryBtn', 'agentPill'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return Math.round(r.top + r.height / 2); })",
      );

      const [resume, retry, pill] = middles as number[];
      expect(Math.abs((resume ?? 0) - (retry ?? 0))).toBeLessThanOrEqual(2);
      expect(Math.abs((retry ?? 0) - (pill ?? 0))).toBeLessThanOrEqual(2);
    } finally {
      await page.setViewportSize({ width: 1280, height: 800 });
    }
  }, 30000);

  test("a refusal naming an 80-character key wraps inside a 390px phone, so the page never scrolls sideways", async () => {
    await seedStatus("failed");
    const key = "A_VERY_LONG_KEY_NAME_THAT_A_REAL_PROJECT_MIGHT_USE_FOR_ITS_STAGING_DATABASE_URL";
    answers = [
      () =>
        Response.json(
          { error: { code: "bad-request", message: `BLOCKED env:${key}` } },
          { status: 400 },
        ),
    ];
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await open();
      await until("!document.querySelector('#retryBtn').hidden");

      await page.click("#retryBtn");
      await until("!document.querySelector('#relaunchError').hidden");

      expect(
        await evaluate(
          "document.documentElement.scrollWidth - document.documentElement.clientWidth",
        ),
      ).toBe(0);
    } finally {
      await page.setViewportSize({ width: 1280, height: 800 });
    }
  }, 30000);
});

describe("a shared server's dashboard in a browser", () => {
  const readyCheckout = async () => ({
    env: { ok: true as const, value: {} },
    report: summarize([]),
  });

  // A started server with SERVER_DOMAIN set, holding run r-1 and the user Ada.
  const sharedServer = async () => {
    const home = tempDir();
    writeFileSync(join(home, ".env"), "SERVER_DOMAIN=yok.example.com\n");
    const cwd = tempDir();
    const userId = await withStorage(home, async (store) => {
      await seedRun(store, {
        id: "r-1",
        project: "demo",
        workflow: "w",
        workflowPath: join(cwd, "w.yaml"),
        inputs: {},
        cwd,
        sessions: [],
        name: null,
        terminal: null,
        config: null,
        tiers: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      return seedUser(store, { name: "Ada", github: { id: 1, login: "ada" } });
    });
    const { host } = fakeHost(EMPTY_BOX);
    const server = await startServer({
      home,
      runtime: { host, providerFor: () => claudeOver(host), checkCheckout: readyCheckout },
    });
    const session = signValue(await sessionSecret(home), {
      sub: userId,
      purpose: "session",
      exp: Date.now() + 60_000,
    });
    return { server, origin: `http://127.0.0.1:${readPort(home)}`, session };
  };

  test("SC6: a signed-out browser opening a run's page lands on /login, and a request the page makes after its cookie goes also does", async () => {
    const { server, origin, session } = await sharedServer();
    try {
      await page.goto(`${origin}/runs/r-1`);
      expect(new URL(page.url()).pathname).toBe("/login");
      expect(new URL(page.url()).searchParams.get("next")).toBe("/runs/r-1");

      await page.context().addCookies([{ name: "yok_session", value: session, url: origin }]);
      await page.goto(`${origin}/runs/r-1`);
      await until("document.querySelector('#runId').textContent === 'r-1'");
      await page.context().clearCookies();
      await page.evaluate(
        'import("/assets/shared.js").then((shared) => shared.fetchSignedIn("/runs/r-1/files"))',
      );
      await page.waitForURL(`${origin}/login?next=%2Fruns%2Fr-1`);
    } finally {
      await server.stop();
    }
  }, 30000);
});
