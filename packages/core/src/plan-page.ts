/// <reference path="./text-imports.d.ts" />
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { indexedFrames, type RunRef, runDirOf } from "@yok/sdk";
import { colorFile, DOC_STYLES, type RepoFiles, renderMarkdown, repoFiles } from "./markdown.ts";
import TEMPLATE_IMPORT from "./plan-page.html" with { type: "text" };
import { isInsideDir } from "./workflow/done.ts";

// Bun's types call any .html import an HTMLBundle; a text import is the file's text.
const TEMPLATE = String(TEMPLATE_IMPORT);

// One self-contained artifacts/plan.html: plan.md and each phase as yok view renders them, with
// each frame a step builds to shown under it and design/spec.md in a closed block under each step
// that points at it. Only await-approval and `yok build-plan` write it, so it is never older than
// the markdown.
export const PLAN_PAGE_PATH = "artifacts/plan.html";

type Doc = Readonly<{ id: string; label: string; path: string; markdown: string; phase?: number }>;
type IndexRow = Readonly<{ screen: string; truth: string }>;
type Frame = Readonly<{ uri: string; width: number }>;
type FrameFile = Readonly<{ frame: string; file: string; size: number }>;
type Page = Readonly<{
  repo: RepoFiles;
  rows: ReadonlyMap<string, IndexRow>;
  frames: ReadonlyMap<string, Frame>;
  tooBig: ReadonlySet<string>;
  hasSpec: boolean;
}>;

const THUMB_HEIGHT = 260;
const MAX_FRAME_BYTES = 20_000_000;
// 60 MB of frames is about 80 MB as base64, which keeps the page under Slack's 100 MB upload cap.
const FRAME_BUDGET_BYTES = 60_000_000;
const GIT_TIMEOUT_MS = 10_000;
// The most source a file may add to the page, as in yok view.
const MAX_SOURCE_BYTES = 2_000_000;
const MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};
const FRAME_PATH = /design\/[\w./-]+?\.(?:png|jpe?g|webp|gif|svg|avif)\b/gi;
const PARAGRAPH = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
// A list item's opening text up to its nested list or end, unless it opens with a paragraph.
const TIGHT_ITEM = /<li\b[^>]*>(?!\s*<p\b)((?:(?!<\/?(?:li|ul|ol|p)\b)[\s\S])+)/g;
const HEADING = /<h([1-4])([^>]*)>([\s\S]*?)<\/h\1>/g;
const TABLE = /<table\b[\s\S]*?<\/table>/g;
// A step's pointer into design/spec.md: free text after the path, since the spec has no fixed format.
const SPEC_LINE = /^[ \t]*(?:[-*][ \t]+)?Spec:[ \t]*design\/spec\.md\b(.*)$/m;

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const textOf = (html: string): string =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// The pixel size from a PNG's IHDR or a JPEG's first start-of-frame marker; null for anything else.
const jpegSize = (bytes: Buffer, at: number): Readonly<{ w: number; h: number }> | null => {
  if (at + 9 > bytes.length || bytes[at] !== 0xff) return null;
  const marker = bytes[at + 1] ?? 0;
  const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
  if (isFrame) return { h: bytes.readUInt16BE(at + 5), w: bytes.readUInt16BE(at + 7) };
  return jpegSize(bytes, at + 2 + bytes.readUInt16BE(at + 2));
};

const imageSize = (bytes: Buffer): Readonly<{ w: number; h: number }> | null => {
  if (bytes.length >= 24 && bytes.toString("latin1", 1, 4) === "PNG") {
    return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
  }
  return bytes[0] === 0xff && bytes[1] === 0xd8 ? jpegSize(bytes, 2) : null;
};

// The card is as wide as the image at the thumbnail height, clamped so a tall board keeps a
// readable strip of its top and a wide banner does not take the whole column.
const cardWidth = (size: Readonly<{ w: number; h: number }> | null): number =>
  size === null || size.h === 0
    ? 320
    : Math.round(Math.min(520, Math.max(240, (THUMB_HEIGHT * size.w) / size.h)));

// The page is uploaded to chat, so it reads a file of artifacts/ only when the file's real path is
// inside the real artifacts/: a link an agent planted cannot pull in a file from elsewhere.
const readArtifact = async (artifactsDir: string, path: string): Promise<string | undefined> => {
  try {
    const file = await realpath(join(artifactsDir, path));
    const inside = isInsideDir(await realpath(artifactsDir), file);
    return inside ? await readFile(file, "utf8") : undefined;
  } catch {
    return undefined;
  }
};

// A frame path comes from the plan's text, so it may only name an image inside artifacts/design/,
// links included, measured at its real path.
const locateFrame = async (artifactsDir: string, frame: string): Promise<FrameFile | undefined> => {
  if (MIME[extname(frame).toLowerCase()] === undefined) return undefined;
  try {
    const designDir = join(await realpath(artifactsDir), "design");
    const file = await realpath(join(artifactsDir, frame));
    return isInsideDir(designDir, file)
      ? { frame, file, size: (await stat(file)).size }
      : undefined;
  } catch {
    return undefined;
  }
};

// The frames to embed, in order: each at most MAX_FRAME_BYTES, while their total stays in budget.
const withinBudget = (files: readonly FrameFile[]): readonly FrameFile[] =>
  files.reduce<Readonly<{ kept: readonly FrameFile[]; used: number }>>(
    (acc, f) =>
      f.size > MAX_FRAME_BYTES || acc.used + f.size > FRAME_BUDGET_BYTES
        ? acc
        : { kept: [...acc.kept, f], used: acc.used + f.size },
    { kept: [], used: 0 },
  ).kept;

const loadFrame = async ({ frame, file }: FrameFile): Promise<[string, Frame]> => {
  const bytes = await readFile(file);
  const mime = MIME[extname(frame).toLowerCase()] ?? "application/octet-stream";
  const uri = `data:${mime};base64,${bytes.toString("base64")}`;
  return [frame, { uri, width: cardWidth(imageSize(bytes)) }];
};

// Screen and "Source of truth for" per frame, from design/INDEX.md's
// `Screen | Local file | Width | Source | Source of truth for` rows.
const readIndexRows = (index: string): ReadonlyMap<string, IndexRow> =>
  new Map(
    index.split("\n").flatMap((line) => {
      const cells = line.split("|").map((cell) => cell.trim());
      const frame = cells[2]?.match(/`(design\/[^`]+)`/)?.[1];
      return frame === undefined
        ? []
        : [[frame, { screen: cells[1] ?? "", truth: cells[5] ?? "" }]];
    }),
  );

const frameCard = (frame: string, page: Page): string => {
  const loaded = page.frames.get(frame);
  if (loaded === undefined) {
    const why = page.tooBig.has(frame) ? "is too big to embed; open it in" : "is not in";
    return `<p class="frame-missing">frame ${escapeHtml(frame)} ${why} artifacts/</p>`;
  }
  const row = page.rows.get(frame);
  const screen = row?.screen ? `<span class="frame-screen">${escapeHtml(row.screen)}</span>` : "";
  const truth = row?.truth
    ? `<span class="frame-truth" title="${escapeHtml(row.truth)}">${escapeHtml(row.truth)}</span>`
    : "";
  const name = escapeHtml(frame);
  return `<figure class="frame" style="width:${loaded.width}px"><img data-img="${name}" alt="${name}"><figcaption><span class="frame-name">${name}</span>${screen}${truth}</figcaption></figure>`;
};

const specBlock = (pointer: string, page: Page): string => {
  const body = page.hasSpec
    ? '<div class="spec-body" data-spec></div>'
    : '<p class="frame-missing">design/spec.md is not in artifacts/</p>';
  return `<details class="spec"><summary>Spec · design/spec.md ${escapeHtml(pointer.trim())}</summary>${body}</details>`;
};

// Under a step that builds to frames, their cards; under one that points at spec.md, the spec block.
const decorationsFor = (inner: string, page: Page): string => {
  const text = textOf(inner);
  const frames = /\bbuild\s+to\b/i.test(text) ? [...new Set(text.match(FRAME_PATH) ?? [])] : [];
  const pointer = SPEC_LINE.exec(text);
  const row =
    frames.length === 0
      ? ""
      : `<div class="frames">${frames.map((frame) => frameCard(frame, page)).join("")}</div>`;
  return `${row}${pointer === null ? "" : specBlock(pointer[1] ?? "", page)}`;
};

// A step is a paragraph, or the text a tight list item opens with; a loose item's text is
// already in a paragraph.
const decorateSteps = (html: string, page: Page): string =>
  html
    .replace(PARAGRAPH, (whole, inner: string) => `${whole}${decorationsFor(inner, page)}`)
    .replace(TIGHT_ITEM, (whole, inner: string) => `${whole}${decorationsFor(inner, page)}`);

// As in yok view: doc.css scrolls a wrapped table inside its own box, so a wide one cannot
// widen the page on a phone.
const wrapTables = (html: string): string =>
  html.replace(TABLE, (table) => `<div class="table-wrap">${table}</div>`);

const addHeadingIds = (html: string, prefix: string): string =>
  html.replace(
    HEADING,
    (_whole, level: string, attrs: string, inner: string) =>
      `<h${level} id="${prefix}-${slugify(textOf(inner))}"${attrs}>${inner}</h${level}>`,
  );

const galleryOf = (page: Page): string => {
  const cards = [...page.rows.keys()].map((frame) => frameCard(frame, page)).join("");
  return `<h2 id="plan-design-frames">Design frames</h2><p>Every frame in <code>design/INDEX.md</code>. A step that builds to a frame shows it again under that step.</p><div class="gallery">${cards}</div>`;
};

const renderDoc = (doc: Doc, page: Page): string => {
  // No "of N": a revision that deletes a phase leaves a gap in the numbers.
  const label =
    doc.phase === undefined ? "" : `<span class="phase-label">Phase ${doc.phase}</span>`;
  const body = addHeadingIds(
    wrapTables(decorateSteps(renderMarkdown(doc.markdown, page.repo), page)),
    doc.id,
  );
  const gallery = doc.phase === undefined && page.rows.size > 0 ? galleryOf(page) : "";
  return `<article id="${doc.id}" class="doc" hidden>${label}${body}${gallery}</article>`;
};

const titleOf = (doc: Doc): string => doc.markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? doc.label;

const fileButton = (doc: Doc): string =>
  `<li><button type="button" class="file-btn" data-doc="${doc.id}" title="${escapeHtml(titleOf(doc))}"><b>${doc.label}</b><small>${doc.path}</small></button></li>`;

const readPhase = async (artifactsDir: string, phase: number): Promise<Doc[]> => {
  const path = `phases/phase-${phase}.md`;
  const markdown = await readArtifact(artifactsDir, path);
  return markdown === undefined
    ? []
    : [{ id: `phase-${phase}`, label: `Phase ${phase}`, path, markdown, phase }];
};

const readDocs = async (artifactsDir: string): Promise<readonly [Doc, ...Doc[]]> => {
  const plan = await readArtifact(artifactsDir, "plan.md");
  if (plan === undefined) throw new Error(`no plan.md in ${artifactsDir}`);
  const names = await readdir(join(artifactsDir, "phases")).catch((): string[] => []);
  const numbers = names
    .flatMap((name) => /^phase-(\d+)\.md$/.exec(name)?.slice(1, 2) ?? [])
    .map(Number)
    .toSorted((a, b) => a - b);
  const phases = await Promise.all(numbers.map((phase) => readPhase(artifactsDir, phase)));
  return [{ id: "plan", label: "Plan", path: "plan.md", markdown: plan }, ...phases.flat()];
};

// The template's slots; the style and JSON ones sit in a comment and a string so the file parses.
const SLOT = /\/\* \{\{DOC_STYLES\}\} \*\/|"\{\{[A-Z_]+\}\}"|\{\{[A-Z_]+\}\}/g;

const toScriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

const valuesOf = (html: string, attribute: string): readonly string[] => [
  ...new Set(
    [...html.matchAll(new RegExp(`${attribute}="([^"]+)"`, "g"))].map((m) => textOf(m[1] ?? "")),
  ),
];

export const buildPlanPage = async (artifactsDir: string, repo: RepoFiles): Promise<string> => {
  const docs = await readDocs(artifactsDir);
  const index = (await readArtifact(artifactsDir, "design/INDEX.md")) ?? "";
  const spec = await readArtifact(artifactsDir, "design/spec.md");
  const named = docs.flatMap((doc) => doc.markdown.match(FRAME_PATH) ?? []);
  const wanted = [...new Set([...indexedFrames(index).map((row) => row.frame), ...named])];
  const located = await Promise.all(wanted.map((f) => locateFrame(artifactsDir, f)));
  const found = located.filter((f) => f !== undefined);
  // Only the frames that fit are read, so memory stays within the budget however many a plan names.
  const kept = withinBudget(found);
  const frames = new Map(await Promise.all(kept.map(loadFrame)));
  const page: Page = {
    repo,
    rows: readIndexRows(index),
    frames,
    tooBig: new Set(found.filter((f) => !kept.includes(f)).map((f) => f.frame)),
    hasSpec: spec !== undefined,
  };
  const documents = docs.map((doc) => renderDoc(doc, page)).join("\n");
  const images = Object.fromEntries(
    valuesOf(documents, "data-img").flatMap((f) => {
      const frame = frames.get(f);
      return frame === undefined ? [] : [[f, frame.uri]];
    }),
  );
  const sources = Object.fromEntries(
    valuesOf(documents, "data-file").flatMap((path) => {
      const text = repo.read(path);
      return text === null ? [] : [[path, colorFile(text, path)]];
    }),
  );
  const slots: Readonly<Record<string, string>> = {
    "{{TITLE}}": escapeHtml(titleOf(docs[0])),
    "/* {{DOC_STYLES}} */": DOC_STYLES,
    "{{FILE_BUTTONS}}": docs.map(fileButton).join(""),
    "{{DOCUMENTS}}": documents,
    '"{{IMAGES_JSON}}"': toScriptJson(images),
    '"{{SOURCES_JSON}}"': toScriptJson(sources),
    "{{SPEC}}": spec === undefined ? "" : wrapTables(renderMarkdown(spec)),
  };
  // One pass over the template, so a plan that quotes a slot name never has it filled in its text.
  return TEMPLATE.replace(SLOT, (slot) => slots[slot] ?? slot);
};

// The page is uploaded to chat, so a file's lines come from the blob HEAD holds, which everyone with
// the repo already has, never from the working copy: an untracked file has no blob, and no local
// edit, skip-worktree bit or smudge filter (git-crypt decrypts there) changes what is embedded.
// repoFiles still decides which paths may be read: inside the repo, not secret-named, not too big.
const committedRepoFiles = (cwd: string, repo: RepoFiles): RepoFiles => ({
  exists: repo.exists,
  read: (path) => {
    if (repo.read(path) === null) return null;
    try {
      return execFileSync("git", ["cat-file", "blob", `HEAD:./${normalize(path)}`], {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_SOURCE_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: GIT_TIMEOUT_MS,
      });
    } catch {
      return null;
    }
  },
});

export const writePlanPage = async (run: RunRef): Promise<string> => {
  const runDir = runDirOf(run.cwd, run.name);
  const repo = committedRepoFiles(run.cwd, repoFiles(run.cwd));
  const html = await buildPlanPage(join(runDir, "artifacts"), repo);
  const path = join(runDir, PLAN_PAGE_PATH);
  // A rename replaces a link planted at the path, and the exclusive create refuses a link planted
  // at the staging name, where a plain write would follow either.
  const staged = `${path}.${randomUUID()}.tmp`;
  await writeFile(staged, html, { flag: "wx" });
  await rename(staged, path);
  return path;
};
