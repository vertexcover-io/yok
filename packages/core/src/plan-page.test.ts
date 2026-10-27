import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoFiles } from "./markdown.ts";
import { buildPlanPage, PLAN_PAGE_PATH, writePlanPage } from "./plan-page.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const tempDir = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `yok-${prefix}-`)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const put = (root: string, path: string, content: string | Uint8Array): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};

// A PNG's signature and IHDR chunk, enough for a reader of its size.
const pngBytes = (width: number, height: number): Uint8Array => {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(bytes);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};

// A JPEG's start marker, a JFIF APP0 segment to skip, then a baseline start-of-frame.
const jpegBytes = (width: number, height: number): Uint8Array => {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...sof, ...Array(9).fill(0), 0xff, 0xd9]);
};

const FENCE = "```";

const build = (artifacts: string, repo = tempDir("plan-repo")): Promise<string> =>
  buildPlanPage(artifacts, repoFiles(repo));

const scriptText = (page: string, id: string): string =>
  page.match(new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`))?.[1] ??
  "null";

const scriptJson = (page: string, id: string): Record<string, unknown> =>
  JSON.parse(scriptText(page, id));

describe("buildPlanPage", () => {
  test("SC702: the page holds plan.md, then phases 1, 2 and 10 in number order, each with its file button, titled from plan.md's heading", async () => {
    const artifacts = tempDir("plan-artifacts");
    put(artifacts, "plan.md", "# Plan: Export\n\nThe plan.\n");
    put(artifacts, "phases/phase-2.md", "# Phase 2: Second\n\n## Goal\n\nShip it.\n");
    put(artifacts, "phases/phase-10.md", "# Phase 10: Tenth\n");
    put(artifacts, "phases/phase-1.md", "# Phase 1: First\n");

    const page = await buildPlanPage(artifacts, repoFiles(tempDir("plan-repo")));

    expect(
      [...page.matchAll(/<article id="([^"]+)" class="doc" hidden>/g)].map((m) => m[1]),
    ).toEqual(["plan", "phase-1", "phase-2", "phase-10"]);
    expect(
      [...page.matchAll(/data-doc="[^"]+"[^>]*><b>([^<]+)<\/b><small>([^<]+)<\/small>/g)].map(
        (m) => `${m[1]} ${m[2]}`,
      ),
    ).toEqual([
      "Plan plan.md",
      "Phase 1 phases/phase-1.md",
      "Phase 2 phases/phase-2.md",
      "Phase 10 phases/phase-10.md",
    ]);
    expect(page).toContain("<title>Plan: Export</title>");
    expect(page).toContain(
      '<article id="phase-2" class="doc" hidden><span class="phase-label">Phase 2</span>',
    );
    expect(page).toMatch(/<h2 id="phase-2-goal"/);
    expect(page).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(scriptJson(page, "plan-images")).toEqual({});
  });

  test("SC703: each step that builds to a frame gets its card under it, sized from the image, with each image embedded once", async () => {
    const artifacts = tempDir("plan-artifacts");
    put(artifacts, "plan.md", "# Plan\n");
    put(
      artifacts,
      "phases/phase-1.md",
      [
        "# Phase 1",
        "",
        "1. **Home**",
        "",
        "   Build to design/wide.png at 1200px.",
        "",
        "2. **Again**",
        "",
        "   Then build to design/wide.png once more.",
        "",
        "3. **Tall**",
        "",
        "   Build to design/tall.jpg.",
        "",
      ].join("\n"),
    );
    const wide = pngBytes(1200, 1000);
    put(artifacts, "design/wide.png", wide);
    put(artifacts, "design/tall.jpg", jpegBytes(400, 4000));
    put(
      artifacts,
      "design/INDEX.md",
      [
        "| Screen | Local file | Width | Source | Source of truth for |",
        "|---|---|---|---|---|",
        "| Home, desktop | `design/wide.png` | 1200 | figma | layout |",
        "",
      ].join("\n"),
    );

    const page = await build(artifacts);

    const phase = page.match(/<article id="phase-1"[\s\S]*?<\/article>/)?.[0] ?? "";
    expect(phase.match(/<\/p>\n?<div class="frames">/g)?.length).toBe(3);
    expect(phase).toContain('<figure class="frame"><img data-img="design/wide.png"');
    expect(phase).toContain('<span class="frame-screen">Home, desktop</span>');
    expect(phase).toContain('<span class="frame-truth" title="layout">layout</span>');
    expect(phase).toContain('<figure class="frame tall"><img data-img="design/tall.jpg"');
    const images = scriptJson(page, "plan-images");
    expect(Object.keys(images).toSorted()).toEqual(["design/tall.jpg", "design/wide.png"]);
    const wideUri = `data:image/png;base64,${Buffer.from(wide).toString("base64")}`;
    expect(images["design/wide.png"]).toBe(wideUri);
    expect(page.split(wideUri).length - 1).toBe(1);
  });

  test("an .avif frame, which ticket-fetcher indexes, is embedded under the step that builds to it", async () => {
    const artifacts = tempDir("plan-artifacts");
    put(artifacts, "plan.md", "# Plan\n");
    put(artifacts, "phases/phase-1.md", "# Phase 1\n\nBuild to design/hero.avif.\n");
    put(artifacts, "design/hero.avif", "avif");

    const page = await build(artifacts);

    expect(page).toContain('<img data-img="design/hero.avif"');
    expect(scriptJson(page, "plan-images")).toEqual({
      "design/hero.avif": `data:image/avif;base64,${Buffer.from("avif").toString("base64")}`,
    });
  });

  test("a step written as a tight list item gets its frame card inside the item, and a loose item gets it once", async () => {
    const artifacts = tempDir("plan-artifacts");
    put(
      artifacts,
      "plan.md",
      [
        "# Plan",
        "",
        "1. Build to design/a.png.",
        "2. Build the modal.",
        "   - a nested note",
        "",
        "- Loose build to design/a.png.",
        "",
        "- Another loose item",
        "",
      ].join("\n"),
    );
    put(artifacts, "design/a.png", pngBytes(1200, 1000));

    const page = await build(artifacts);

    expect(page).toMatch(/<li[^>]*>Build to design\/a\.png\.<div class="frames">/);
    expect(page.match(/<div class="frames">/g)?.length).toBe(2);
  });

  test("a step's Design lines give way to one row of their frames, each frame once", async () => {
    const artifacts = tempDir("plan-artifacts");
    put(artifacts, "plan.md", "# Plan\n");
    put(
      artifacts,
      "phases/phase-1.md",
      [
        "# Phase 1",
        "",
        "1. **Create the modal**",
        "",
        "   Summary.",
        "",
        "   - **Design:** build to design/a.png at 1200px",
        "   - **Design:** build to design/b.png at 560px",
        "   - **Design:** build to design/a.png at 1200px",
        "",
      ].join("\n"),
    );
    put(artifacts, "design/a.png", pngBytes(1200, 1000));
    put(artifacts, "design/b.png", pngBytes(560, 900));

    const page = await build(artifacts);

    expect(page.match(/<div class="frames">/g)?.length).toBe(1);
    expect(page).not.toContain("Design:");
    expect(page.match(/<article id="phase-1"[\s\S]*?<\/article>/)?.[0]).not.toContain("<ul");
    expect(page).toMatch(
      /<p[^>]*>Summary\.<\/p>\s*<div class="frames"><figure class="frame"><img data-img="design\/a\.png"[\s\S]*?<\/figure><figure class="frame tall"><img data-img="design\/b\.png"[\s\S]*?<\/figure><\/div>/,
    );
  });

  test("a phase keeps its own number when a revision left a gap, with no count beside it", async () => {
    const artifacts = tempDir("plan-gap");
    put(artifacts, "plan.md", "# Plan\n");
    put(artifacts, "phases/phase-1.md", "# Phase 1\n");
    put(artifacts, "phases/phase-3.md", "# Phase 3\n");

    const page = await build(artifacts);

    expect(
      [...page.matchAll(/<span class="phase-label">([^<]+)<\/span>/g)].map((m) => m[1]),
    ).toEqual(["Phase 1", "Phase 3"]);
  });

  test("a frame over 20 MB, and any frame past 60 MB of frames in all, is named instead of embedded", async () => {
    const artifacts = tempDir("plan-big-frames");
    const mb = 1_000_000;
    const frame = (name: string, bytes: number): void => {
      put(artifacts, `design/${name}`, pngBytes(1200, 1000));
      truncateSync(join(artifacts, "design", name), bytes);
    };
    frame("huge.png", 21 * mb);
    for (const name of ["a.png", "b.png", "c.png", "d.png"]) frame(name, 19 * mb);
    const steps = ["huge", "a", "b", "c", "d"].map((n) => `Build to design/${n}.png.`);
    put(artifacts, "plan.md", `# Plan\n\n${steps.join("\n\n")}\n`);

    const page = await build(artifacts);

    expect(Object.keys(scriptJson(page, "plan-images")).toSorted()).toEqual([
      "design/a.png",
      "design/b.png",
      "design/c.png",
    ]);
    expect(page).toContain(
      '<p class="frame-missing">frame design/huge.png is too big to embed; open it in artifacts/</p>',
    );
    expect(page).toContain(
      '<p class="frame-missing">frame design/d.png is too big to embed; open it in artifacts/</p>',
    );
  });

  test("a plan, phase or design folder that links outside artifacts/ is not read", async () => {
    const root = tempDir("plan-links");
    const artifacts = join(root, "run", "artifacts");
    const outside = join(root, "outside");
    put(outside, "notes.md", "# Phase 2\n\nOUTSIDE-PHASE\n");
    put(outside, "plan.md", "# Plan\n\nOUTSIDE-PLAN\n");
    put(outside, "design/x.png", pngBytes(1200, 1000));
    put(
      outside,
      "design/INDEX.md",
      "| Screen | Local file | Width | Source | Truth |\n|---|---|---|---|---|\n| Home | `design/x.png` | 1200 | x | y |\n",
    );
    put(artifacts, "plan.md", "# Plan\n\nBuild to design/x.png.\n");
    put(artifacts, "phases/phase-1.md", "# Phase 1\n");
    symlinkSync(join(outside, "notes.md"), join(artifacts, "phases", "phase-2.md"));
    symlinkSync(join(outside, "design"), join(artifacts, "design"));

    const page = await build(artifacts);

    expect(page).not.toContain("OUTSIDE-PHASE");
    expect(page).not.toContain('id="phase-2"');
    expect(Object.keys(scriptJson(page, "plan-images"))).toEqual([]);

    rmSync(join(artifacts, "plan.md"));
    symlinkSync(join(outside, "plan.md"), join(artifacts, "plan.md"));
    await expect(build(artifacts)).rejects.toThrow("plan.md");
  });

  test("SC704: a frame a step builds to that the artifacts lack shows a missing line under the step and is not embedded", async () => {
    const artifacts = tempDir("plan-artifacts");
    put(artifacts, "plan.md", "# Plan\n\nThen build to design/gone.png.\n");

    const page = await build(artifacts);

    expect(page).toContain(
      '<div class="frames"><p class="frame-missing">frame design/gone.png is not in artifacts/</p></div>',
    );
    expect(scriptJson(page, "plan-images")).not.toHaveProperty(["design/gone.png"]);
  });

  test("a frame path that climbs out of artifacts/design is not read or embedded, whatever its extension", async () => {
    const root = tempDir("plan-frame-escape");
    const artifacts = join(root, "artifacts");
    put(root, "secret.png", pngBytes(1200, 1000));
    put(artifacts, "plan.md", "# Plan\n\nBuild to design/../../secret.png.\n");
    put(artifacts, "design/real.png", pngBytes(1200, 1000));
    put(
      artifacts,
      "design/INDEX.md",
      "| Screen | Local file | Width | Source | Truth |\n|---|---|---|---|---|\n| Home | `design/../../secret.png` | 1200 | x | y |\n",
    );

    const page = await build(artifacts);

    expect(page).toContain("is not in artifacts/");
    expect(Object.keys(scriptJson(page, "plan-images"))).toEqual([]);
  });

  test("every table sits in a wrapper that scrolls it sideways, so a wide one cannot widen the page", async () => {
    const artifacts = tempDir("plan-tables");
    const table = "| Test | Strategy |\n|---|---|\n| one | unit |\n";
    put(artifacts, "plan.md", `# Plan\n\n${table}`);
    put(artifacts, "phases/phase-1.md", `# Phase 1\n\n${table}`);

    const page = await build(artifacts);

    expect(page.match(/<table/g)?.length).toBe(2);
    expect(page.match(/<div class="table-wrap"><table/g)?.length).toBe(2);
    expect(page).toMatch(/\.table-wrap > table \{[^}]*overflow-x: auto/);
  });

  test("the outline is built from text nodes, so a heading holding markup cannot inject it", async () => {
    const artifacts = tempDir("plan-outline");
    put(artifacts, "plan.md", "# Plan\n\n## <img src=x onerror=alert(1)>\n");

    const page = await build(artifacts);

    expect(page).not.toContain("outlineHost.innerHTML");
    expect(page).toContain("link.textContent = h.textContent");
  });

  test("SC705: a step's Spec line, in its list form or its older line form, is left off the page, and design/spec.md is never embedded", async () => {
    const artifacts = tempDir("plan-artifacts");
    put(artifacts, "plan.md", "# Plan\n");
    put(
      artifacts,
      "phases/phase-1.md",
      [
        "# Phase 1",
        "",
        "1. **Create `src/Modal.tsx`**",
        "",
        "   Adds the dialog.",
        "",
        "   - **Design:** build to design/a.png at 1200px",
        "   - **Spec:** design/spec.md — 7. Modal · 2. Button",
        "",
        "2. **Change `src/List.tsx`**",
        "   Spec: design/spec.md — the list part",
        "",
        "```markdown",
        "Spec: design/spec.md — quoted in a code block",
        "```",
        "",
      ].join("\n"),
    );
    put(artifacts, "design/a.png", pngBytes(1200, 1000));
    put(artifacts, "design/spec.md", "SPEC-TEXT: the modal is 420px wide.\n");

    const page = await build(artifacts);

    expect(page).not.toContain("SPEC-TEXT");
    expect(page).not.toContain("7. Modal");
    expect(page).not.toContain("the list part");
    expect(page).toContain("Spec: design/spec.md — quoted in a code block");
    expect(page).not.toContain('class="spec"');
    expect(page).not.toContain("plan-spec");
    expect(page).not.toContain("Design:");
    expect(page).toContain(
      '<div class="frames"><figure class="frame"><img data-img="design/a.png"',
    );
  });

  test("SC706: a diff of a repo file is placed as yok view places it, and the file's coloured lines are embedded, while a new file's are not", async () => {
    const artifacts = tempDir("plan-artifacts");
    const repo = tempDir("plan-repo");
    put(
      repo,
      "src/a.ts",
      Array.from({ length: 40 }, (_, i) => `const v${i + 1} = ${i + 1};`).join("\n"),
    );
    put(
      artifacts,
      "plan.md",
      [
        "# Plan",
        "",
        "`src/a.ts`",
        "",
        `${FENCE}diff`,
        "@@ -10,3 +10,3 @@",
        " const v10 = 10;",
        "-const v11 = 0;",
        "+const v11 = 11;",
        " const v12 = 12;",
        FENCE,
        "",
        "`src/new.ts` (new file)",
        "",
        `${FENCE}diff`,
        "+export const fresh = 1;",
        FENCE,
        "",
      ].join("\n"),
    );

    const page = await build(artifacts, repo);

    expect(page).toMatch(/<pre[^>]* data-file="src\/a\.ts" data-total="40">/);
    expect(page).toContain('class="hunk" data-from="10"');
    const sources = scriptJson(page, "plan-sources");
    expect(Object.keys(sources)).toEqual(["src/a.ts"]);
    expect(sources["src/a.ts"]).toHaveLength(40);
  });

  test("a file that holds secrets is never embedded as source, though its diff still renders", async () => {
    const artifacts = tempDir("plan-artifacts");
    const repo = tempDir("plan-repo");
    put(repo, ".env", "TOKEN=hunter2\nOTHER=1\n");
    put(repo, "keys/server.pem", "-----BEGIN PRIVATE KEY-----\nabc\n");
    put(repo, "src/a.ts", "const a = 1;\nconst b = 2;\n");
    const diff = (file: string) => [`\`${file}\``, "", `${FENCE}diff`, "+const b = 2;", FENCE, ""];
    put(
      artifacts,
      "plan.md",
      ["# Plan", "", ...diff(".env"), ...diff("keys/server.pem"), ...diff("src/a.ts")].join("\n"),
    );

    const page = await build(artifacts, repo);

    expect(Object.keys(scriptJson(page, "plan-sources"))).toEqual(["src/a.ts"]);
    expect(page).not.toContain("hunter2");
    expect(page).toContain('data-file="keys/server.pem"');
  });

  test("a source file that is a link to a secret file is not embedded", async () => {
    const artifacts = tempDir("plan-artifacts");
    const repo = tempDir("plan-repo");
    put(repo, ".env", "TOKEN=hunter2\n");
    mkdirSync(join(repo, "src"));
    symlinkSync(join(repo, ".env"), join(repo, "src/config.ts"));
    put(
      artifacts,
      "plan.md",
      ["# Plan", "", "`src/config.ts`", "", `${FENCE}diff`, "+x", FENCE, ""].join("\n"),
    );

    const page = await build(artifacts, repo);

    expect(page).not.toContain("hunter2");
    expect(scriptJson(page, "plan-sources")).toEqual({});
  });

  test("writePlanPage embeds what HEAD holds: no untracked file, no link's target, no local edit, hidden or not, and no smudged plaintext", async () => {
    const cwd = tempDir("plan-git");
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
    git("init", "-q");
    // A smudge filter, as git-crypt uses: HEAD stores ENCRYPTED, the working copy holds the secret.
    git("config", "filter.reveal.clean", "sed s/PLAIN-SECRET/ENCRYPTED/");
    git("config", "filter.reveal.smudge", "sed s/ENCRYPTED/PLAIN-SECRET/");
    put(cwd, ".gitattributes", "*.vault filter=reveal\n");
    put(cwd, "src/a.ts", "const a = 1;\n");
    put(cwd, "src/b.ts", "const b = 1;\n");
    put(cwd, "src/c.ts", "const c = 1;\n");
    put(cwd, "app.vault", "key: PLAIN-SECRET\n");
    put(cwd, "config/secrets.yml", "token: s3cr3t-value\n");
    symlinkSync("../config/secrets.yml", join(cwd, "src/link.ts"));
    git("add", ".gitattributes", "src", "app.vault");
    git("commit", "-q", "-m", "init");
    put(cwd, "src/b.ts", "const b = 'uncommitted-token';\n");
    put(cwd, "src/c.ts", "const c = 'hidden-edit';\n");
    git("update-index", "--skip-worktree", "src/c.ts");
    const diff = (file: string) => [`\`${file}\``, "", `${FENCE}diff`, "+x", FENCE, ""];
    const files = [
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/link.ts",
      "app.vault",
      "config/secrets.yml",
    ];
    put(cwd, ".yok/feat-x/artifacts/plan.md", ["# Plan", "", ...files.flatMap(diff)].join("\n"));

    const page = readFileSync(await writePlanPage({ id: "r-1", cwd, name: "feat-x" }), "utf8");

    const sources = scriptJson(page, "plan-sources");
    expect(Object.keys(sources).toSorted()).toEqual([
      "app.vault",
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/link.ts",
    ]);
    for (const leaked of ["s3cr3t-value", "uncommitted-token", "hidden-edit", "PLAIN-SECRET"]) {
      expect(page).not.toContain(leaked);
    }
    expect(JSON.stringify(sources["app.vault"])).toContain("ENCRYPTED");
    expect(page).toContain('data-file="config/secrets.yml"');
  });

  test("writePlanPage refuses a link planted at its staging name instead of writing through it", async () => {
    const cwd = tempDir("plan-run");
    const outside = join(tempDir("plan-outside"), "victim.txt");
    writeFileSync(outside, "keep me");
    put(cwd, ".yok/feat-x/artifacts/plan.md", "# Plan\n");
    const uuid = "00000000-0000-4000-8000-000000000000";
    const pinned = spyOn(crypto, "randomUUID").mockReturnValue(uuid);
    cleanups.push(() => pinned.mockRestore());
    symlinkSync(outside, join(cwd, ".yok/feat-x", `${PLAN_PAGE_PATH}.${uuid}.tmp`));

    await expect(writePlanPage({ id: "r-1", cwd, name: "feat-x" })).rejects.toThrow("EEXIST");

    expect(readFileSync(outside, "utf8")).toBe("keep me");
  });

  test("writePlanPage replaces a symlink planted at artifacts/plan.html instead of writing through it, and leaves no staging file", async () => {
    const cwd = tempDir("plan-run");
    const outside = join(tempDir("plan-outside"), "victim.txt");
    writeFileSync(outside, "keep me");
    put(cwd, ".yok/feat-x/artifacts/plan.md", "# Plan\n");
    symlinkSync(outside, join(cwd, ".yok/feat-x", PLAN_PAGE_PATH));

    const written = await writePlanPage({ id: "r-1", cwd, name: "feat-x" });

    expect(readFileSync(outside, "utf8")).toBe("keep me");
    expect(readFileSync(written, "utf8")).toContain("<title>Plan</title>");
    expect(readdirSync(dirname(written)).toSorted()).toEqual(["plan.html", "plan.md"]);
  });

  test("SC707: a source line holding </script> stays inside the sources JSON and cannot close the page's script tag", async () => {
    const artifacts = tempDir("plan-artifacts");
    const repo = tempDir("plan-repo");
    const line = 'const s = "</script><img src=x onerror=alert(1)>";';
    put(repo, "src/a.ts", `${line}\nconst t = 2;\n`);
    put(
      artifacts,
      "plan.md",
      ["# Plan", "", "`src/a.ts`", "", `${FENCE}diff`, `+${line}`, FENCE, ""].join("\n"),
    );

    const page = await build(artifacts, repo);

    expect(page).not.toContain("</script><img");
    expect(scriptText(page, "plan-sources")).not.toContain("<");
    expect(scriptJson(page, "plan-sources")["src/a.ts"]).toEqual([
      expect.stringContaining(
        '<span class="hljs-string">&quot;&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;&quot;</span>',
      ),
      expect.any(String),
    ]);
  });

  test("a plan whose text names a slot, such as {{DOCUMENTS}}, keeps that text", async () => {
    const artifacts = tempDir("plan-artifacts");
    put(artifacts, "plan.md", "# Plan\n\nThe page fills {{TITLE}} and {{DOCUMENTS}} once.\n");

    const page = await build(artifacts);

    expect(page).toContain("The page fills {{TITLE}} and {{DOCUMENTS}} once.");
  });

  test("SC708: artifacts with a phase but no plan.md build nothing, and the error names plan.md", async () => {
    const artifacts = tempDir("plan-artifacts");
    put(artifacts, "phases/phase-1.md", "# Phase 1\n");

    await expect(buildPlanPage(artifacts, repoFiles(tempDir("plan-repo")))).rejects.toThrow(
      "plan.md",
    );
  });
});
