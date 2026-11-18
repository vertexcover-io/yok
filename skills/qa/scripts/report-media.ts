#!/usr/bin/env bun
// Leaves every verification scenario with one video. A take recorded as numbered parts,
// NN_<slug>.partK.mp4, because it followed the user from one tab to another, is first joined in
// order into NN_<slug>.mp4. A scenario whose take was recorded already
// has its NN_<slug>.mp4 beside the report, with or without frames: that file is shown to play,
// then compressed in place where that makes it smaller, since the report carries every video
// inline. Every other
// scenario gets a video built from its promoted frames, which is then cropdetected, and the
// scenario fails unless the window cropdetect reports still carries the source frame's aspect
// ratio — a frame stretched to fill the canvas shows a geometry that was never on screen.
// A video the script makes takes its NN_<slug>.mp4 name only once it has passed its checks.
// A built video is marked as built, so a later run builds it again from its frames, and removes
// it when those frames no longer pass.
// With --inline it instead writes every file the finished report names into the report itself,
// as data URIs in a `report-media` island the template resolves paths through, so the one html
// file carries its own videos and frames wherever it is moved.
// Usage: report-media.ts [--inline] VERIFICATION_DIR
// Building prints one line per scenario — "ok NN_<slug>.mp4 recorded" for a kept recording, with
// "— trimmed <seconds>s of still picture" where a stretch with no change on screen was cut down,
// "— compressed <bytes>B to <bytes>B" where it was made smaller or "— joined <n> parts" where it
// was recorded in parts,
// "ok NN_<slug>.mp4 crop=<window>" for a built one, or "FAILED NN_<slug> — <reason>" — and
// writes each built NN_<slug>.mp4 beside the report.
// Inlining prints one line per file — "ok <path> <bytes>B", or "FAILED <path> — <reason>" — then
// the finished report's own size as "report <bytes>B", and
// a path that failed shows as missing in the report, which loads nothing from disk.
// Exits 0 when every scenario has its video or every file inlined, and when there are no frames at all;
// 1 when any scenario or file failed; 2 when the arguments, the directory, a missing ffmpeg or a
// missing report makes the run impossible.

import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

type ScenarioResult = {
  readonly prefix: string;
  readonly crop: string | null;
  readonly failure: string | null;
  readonly note: string | null;
};

type FrameSize = {
  readonly width: number;
  readonly height: number;
};

type ShapeCheck = {
  readonly kind: "matches" | "stretched" | "unchecked";
  readonly note: string | null;
};

type InlineResult = {
  readonly path: string;
  readonly bytes: number | null;
  readonly uri: string | null;
  readonly failure: string | null;
};

const REPORT_NAME = "proof-report.html";

const DATA_ISLAND = /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/;
const MEDIA_ISLAND = /<script type="application\/json" id="report-media">[\s\S]*?<\/script>\n?/;

// What the report's modal can show: images, video, and the text files it previews.
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".xml": "application/xml",
  ".html": "text/html",
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Three seconds a frame, the last held two longer. The 1280x720 canvas is fixed and every frame
// letterboxes into it, never reshaped to fill it — widening it to swallow a phone frame's bars is
// what would pass off a landscape shape that was never on screen. A hand rebuild keeps these.
const FILTER_GRAPH =
  "scale=1280:720:force_original_aspect_ratio=decrease," +
  "pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p," +
  "tpad=stop_mode=clone:stop_duration=2";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const namesIn = (dir: string): readonly string[] => (isDirectory(dir) ? readdirSync(dir) : []);

/**
 * The scenario prefixes of a verification directory: those behind its promoted
 * `screenshots/NN_<slug>__SS_<step>.png` frames, and those of each `NN_<slug>.mp4` beside the
 * report, which is all a scenario filmed without frames leaves.
 */
export function scenarioPrefixes(dir: string): readonly string[] {
  const framed = namesIn(join(dir, "screenshots"))
    .filter((name) => name.endsWith(".png") && name.includes("__"))
    .map((name) => name.slice(0, name.indexOf("__")));
  const filmed = namesIn(dir).flatMap((name) => /^(\d\d_[^.]+)\.mp4$/.exec(name)?.[1] ?? []);
  return [...new Set([...framed, ...filmed])].toSorted();
}

/** The last crop window cropdetect reported, which is the picture inside the bars. */
export function parseCropWindow(ffmpegOutput: string): string | null {
  const windows = ffmpegOutput.match(/crop=[0-9:]+/g);
  if (windows === null) return null;
  return windows.at(-1) ?? null;
}

/** The first `bytes` of a file, or null when it cannot be read that far. */
function readHead(path: string, bytes: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(bytes);
    return readSync(fd, head, 0, bytes, 0) === bytes ? head : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** A PNG's dimensions from its IHDR — big-endian uint32 at byte 16 and 20. Null if unreadable. */
export function pngSize(path: string): FrameSize | null {
  const head = readHead(path, 24);
  if (head === null) return null;
  if (!head.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (head.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/** The `W:H` of a `crop=W:H:X:Y` window, when it reports a real rectangle. */
function cropSize(cropWindow: string): FrameSize | null {
  const [width, height] = cropWindow.replace("crop=", "").split(":").map(Number);
  if (width === undefined || height === undefined) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return width > 0 && height > 0 ? { width, height } : null;
}

// cropdetect and the scaler round the window down, so it can read up to 18px short of the real
// picture. That costs a narrow phone window far more aspect than a wide one, so the tolerance
// scales with the window: no flat percentage separates an honest 390x2000 frame (0.017 off) from
// a stretched 1280x800 one (0.178 off). Honest builds use at most 70% of it; stretches go 4x over.
const QUANTISATION_PX = 18;

const aspectTolerance = (crop: FrameSize): number =>
  (QUANTISATION_PX / crop.height) * Math.max(1, crop.width / crop.height);

/** Whether the picture inside the letterbox still has the source frame's shape. */
export function checkFrameShape(source: FrameSize | null, cropWindow: string): ShapeCheck {
  if (source === null || source.width <= 0 || source.height <= 0) {
    return { kind: "unchecked", note: "shape unchecked: the source frame is not a readable PNG" };
  }

  const crop = cropSize(cropWindow);
  if (crop === null) {
    return { kind: "unchecked", note: `shape unchecked: ${cropWindow} is not a rectangle` };
  }

  const sourceAspect = source.width / source.height;
  const cropAspect = crop.width / crop.height;
  if (Math.abs(sourceAspect - cropAspect) <= aspectTolerance(crop)) {
    return { kind: "matches", note: null };
  }

  return {
    kind: "stretched",
    note:
      `the frame was stretched: source ${source.width}x${source.height} is aspect ` +
      `${sourceAspect.toFixed(2)}, ${cropWindow} is aspect ${cropAspect.toFixed(2)}`,
  };
}

function ffmpegFailure(err: unknown): string {
  const stderr = isRecord(err) && typeof err["stderr"] === "string" ? err["stderr"] : "";
  const message = isRecord(err) && typeof err["message"] === "string" ? err["message"] : "";
  const lastLine = stderr.trim().split("\n").at(-1) ?? "";
  return lastLine || message || "ffmpeg exited non-zero";
}

// The comment a video built from frames carries, so a later run builds it again from its frames
// and leaves a recorded take's handling to recordings alone.
const BUILT_MARK = "report-media-built";

function buildVideo(dir: string, prefix: string, output: string): string | null {
  try {
    execFileSync(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-framerate",
        "1/3",
        "-pattern_type",
        "glob",
        "-i",
        join("screenshots", `${prefix}__*.png`),
        "-vf",
        FILTER_GRAPH,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-r",
        "30",
        "-metadata",
        `comment=${BUILT_MARK}`,
        output,
      ],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return null;
  } catch (err) {
    return ffmpegFailure(err);
  }
}

// Decodes the whole file. A recording whose recorder never closed it has no index and does not
// open; one damaged or cut short later opens, and ffmpeg reports the damage while exiting 0.
const plays = (dir: string, video: string): boolean => {
  const decoded = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-i", video, "-f", "null", "-"], {
    cwd: dir,
    encoding: "utf8",
  });
  return decoded.status === 0 && (decoded.stderr ?? "").trim() === "";
};

// A video the script makes is written under a working name and takes the scenario's name only
// once it has passed its checks, so an NN_<slug>.mp4 beside the report is always a checked one.
const workingName = (prefix: string, step: string): string => `${prefix}.${step}.mp4`;

// The comment a compressed recording carries, so a later run keeps it as it is.
const COMPRESSED_MARK = "report-media-compressed";

const COMPRESSED_ENCODING: readonly string[] = [
  "-c:v",
  "libx264",
  "-crf",
  "28",
  "-preset",
  "slow",
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "+faststart",
  "-an",
  "-metadata",
  `comment=${COMPRESSED_MARK}`,
];

const carriesMark = (dir: string, video: string, mark: string): boolean =>
  (
    spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-i", video], { cwd: dir, encoding: "utf8" })
      .stderr ?? ""
  ).includes(mark);

/** Re-encodes a recorded take for the report and keeps whichever file is smaller. */
const STILL_LIMIT_SECONDS = 3;
const STILL_KEPT_SECONDS = 2;

type Cut = { readonly from: number; readonly to: number };

/** The parts of each still stretch past the limit, given when the picture changed. */
export function stillCuts(changes: readonly number[], duration: number): readonly Cut[] {
  const ends = [...changes.slice(1), duration];
  return changes
    .map((from, n) => ({ from: from + STILL_KEPT_SECONDS, to: ends[n] ?? duration }))
    .filter((cut, n) => cut.to - (changes[n] ?? 0) > STILL_LIMIT_SECONDS);
}

/**
 * Cuts every stretch where the picture does not change down to a short hold, so a wait on
 * something off screen does not fill the video. Returns the note for the scenario's line.
 */
function trimStills(dir: string, video: string): string | null {
  const probe = spawnSync(
    "ffmpeg",
    ["-nostdin", "-hide_banner", "-i", video, "-vf", "mpdecimate,showinfo", "-f", "null", "-"],
    { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const log = probe.stderr ?? "";
  const length = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(log);
  if (probe.status !== 0 || length === null) return null;
  const duration = Number(length[1]) * 3600 + Number(length[2]) * 60 + Number(length[3]);
  const changes = [...log.matchAll(/pts_time:(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const cuts = stillCuts(changes, duration);
  if (cuts.length === 0) return null;

  const dropped = cuts.map((cut) => `gte(t,${cut.from})*lt(t,${cut.to})`).join("+");
  const trimmed = `${video}.trimmed.mp4`;
  const encoded = spawnSync(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-y",
      "-i",
      video,
      "-vf",
      `fps=30,select='not(${dropped})',setpts=N/(30*TB)`,
      ...COMPRESSED_ENCODING,
      trimmed,
    ],
    { cwd: dir, stdio: "ignore" },
  );
  if (encoded.status !== 0 || !plays(dir, trimmed)) {
    rmSync(join(dir, trimmed), { force: true });
    return null;
  }
  renameSync(join(dir, trimmed), join(dir, video));
  const seconds = cuts.reduce((sum, cut) => sum + cut.to - cut.from, 0);
  return `trimmed ${seconds.toFixed(1)}s of still picture`;
}

function compressRecording(dir: string, video: string): string | null {
  if (carriesMark(dir, video, COMPRESSED_MARK)) return null;
  const smaller = `${video}.compressed.mp4`;
  const encoded = spawnSync(
    "ffmpeg",
    ["-nostdin", "-v", "error", "-y", "-i", video, ...COMPRESSED_ENCODING, smaller],
    { cwd: dir, stdio: "ignore" },
  );
  const before = statSync(join(dir, video)).size;
  const after = existsSync(join(dir, smaller)) ? statSync(join(dir, smaller)).size : before;
  if (encoded.status !== 0 || after >= before || !plays(dir, smaller)) {
    rmSync(join(dir, smaller), { force: true });
    return null;
  }
  renameSync(join(dir, smaller), join(dir, video));
  return `compressed ${before}B to ${after}B`;
}

const recordedParts = (dir: string, prefix: string): readonly string[] =>
  readdirSync(dir)
    .filter((name) => new RegExp(`^${prefix}\\.part\\d+\\.mp4$`).test(name))
    .toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true }));

const videoSize = (dir: string, video: string): FrameSize | null => {
  const probe = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-i", video], {
    cwd: dir,
    encoding: "utf8",
  });
  const size = /Video:.*?\b(\d{2,5})x(\d{2,5})\b/.exec(probe.stderr ?? "");
  return size === null ? null : { width: Number(size[1]), height: Number(size[2]) };
};

/**
 * Joins a take's parts, in order, into the scenario's one video, then removes the parts.
 * Every part is fitted inside the first part's size, so a pop-up window keeps its shape.
 */
function joinParts(dir: string, prefix: string, parts: readonly string[]): string | null {
  const unplayable = parts.find((part) => !plays(dir, part));
  if (unplayable !== undefined) return `${unplayable} does not play`;
  const size = videoSize(dir, parts[0] ?? "");
  if (size === null) return `${parts[0]} reports no picture size`;
  const fit = `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`;
  const fitted = parts.map((_, n) => `[${n}:v]${fit}[v${n}]`).join(";");
  const labels = parts.map((_, n) => `[v${n}]`).join("");
  const working = workingName(prefix, "join");
  const joined = spawnSync(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-y",
      ...parts.flatMap((part) => ["-i", part]),
      "-filter_complex",
      `${fitted};${labels}concat=n=${parts.length}:v=1:a=0[out]`,
      "-map",
      "[out]",
      ...COMPRESSED_ENCODING,
      working,
    ],
    { cwd: dir, encoding: "utf8" },
  );
  if (joined.status !== 0 || !plays(dir, working)) {
    rmSync(join(dir, working), { force: true });
    return `ffmpeg: ${(joined.stderr ?? "").trim().split("\n").at(-1) || "could not join the parts"}`;
  }
  renameSync(join(dir, working), join(dir, `${prefix}.mp4`));
  for (const part of parts) rmSync(join(dir, part));
  return null;
}

function cropWindow(dir: string, video: string): string | null {
  // cropdetect writes its report to stderr, which only spawnSync hands back on a zero exit.
  // Default loglevel, since -v error silences cropdetect itself.
  const probe = spawnSync(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-ss",
      "1",
      "-t",
      "0.5",
      "-i",
      video,
      "-vf",
      "cropdetect",
      "-f",
      "null",
      "-",
    ],
    { cwd: dir, encoding: "utf8" },
  );
  return parseCropWindow(`${probe.stdout ?? ""}\n${probe.stderr ?? ""}`);
}

const frameNames = (screenshotsDir: string, prefix: string): readonly string[] =>
  existsSync(screenshotsDir)
    ? readdirSync(screenshotsDir)
        .filter((name) => name.startsWith(`${prefix}__`) && name.endsWith(".png"))
        .toSorted()
    : [];

/** The shape of the scenario's first frame, which is the one the cropdetect probe samples. */
function firstFrameSize(screenshotsDir: string, prefix: string): FrameSize | null {
  const first = frameNames(screenshotsDir, prefix).at(0);
  return first === undefined ? null : pngSize(join(screenshotsDir, first));
}

/** Builds a scenario's video from its frames at `working` and checks the shape it came out in. */
function checkedBuild(dir: string, prefix: string, working: string): ScenarioResult {
  const failure = buildVideo(dir, prefix, working);
  if (failure !== null) return { prefix, crop: null, failure: `ffmpeg: ${failure}`, note: null };

  const crop = cropWindow(dir, working);
  if (crop === null) {
    const unread = `cropdetect read no crop window out of ${prefix}.mp4`;
    return { prefix, crop: null, failure: unread, note: null };
  }

  const shape = checkFrameShape(firstFrameSize(join(dir, "screenshots"), prefix), crop);
  if (shape.kind === "stretched") return { prefix, crop, failure: shape.note, note: null };
  return { prefix, crop, failure: null, note: shape.note };
}

function buildFromFrames(dir: string, prefix: string): ScenarioResult {
  const working = workingName(prefix, "build");
  const result = checkedBuild(dir, prefix, working);
  if (result.failure === null) renameSync(join(dir, working), join(dir, `${prefix}.mp4`));
  else rmSync(join(dir, working), { force: true });
  return result;
}

/** Builds a built video again, and removes it when its frames no longer pass the checks. */
function rebuildFromFrames(dir: string, prefix: string): ScenarioResult {
  const result = buildFromFrames(dir, prefix);
  if (result.failure !== null) rmSync(join(dir, `${prefix}.mp4`));
  return result;
}

export function buildScenarios(dir: string): readonly ScenarioResult[] {
  return scenarioPrefixes(dir).map((prefix) => {
    const video = `${prefix}.mp4`;
    const parts = recordedParts(dir, prefix);
    if (parts.length > 0) {
      const failure = joinParts(dir, prefix, parts);
      if (failure !== null) return { prefix, crop: null, failure, note: null };
      const trimmed = trimStills(dir, video);
      const joined = `joined ${parts.length} parts`;
      return {
        prefix,
        crop: null,
        failure: null,
        note: trimmed === null ? joined : `${joined}, ${trimmed}`,
      };
    }
    if (existsSync(join(dir, video))) {
      const built = carriesMark(dir, video, BUILT_MARK);
      if (built && frameNames(join(dir, "screenshots"), prefix).length > 0) {
        return rebuildFromFrames(dir, prefix);
      }
      if (!plays(dir, video)) {
        return { prefix, crop: null, failure: `${video} does not play`, note: null };
      }
      if (built) return { prefix, crop: null, failure: null, note: null };
      // The video is known to play whole, so a trim or compression that fails keeps a good file.
      const note = trimStills(dir, video) ?? compressRecording(dir, video);
      return { prefix, crop: null, failure: null, note };
    }

    return buildFromFrames(dir, prefix);
  });
}

export const formatResult = (result: ScenarioResult): string =>
  result.failure !== null
    ? `FAILED ${result.prefix} — ${result.failure}`
    : `ok ${result.prefix}.mp4 ${result.crop ?? "recorded"}${result.note === null ? "" : ` — ${result.note}`}`;

const hasFfmpeg = (): boolean =>
  spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

/** The report's JSON island, or null when it is absent or does not hold a JSON object. */
export function parseReportData(html: string): Record<string, unknown> | null {
  const json = html.match(DATA_ISLAND)?.[1];
  if (json === undefined) return null;
  try {
    const data: unknown = JSON.parse(json);
    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}

/** A path the report wrote bare, or under `key` of an object. */
const pathOf = (entry: unknown, key: string): unknown => (isRecord(entry) ? entry[key] : entry);

const listOf = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

/** Every file the report names — each recording's video and frames, the design baseline and the screen as built, artifacts, proof pictures — once each, in order. */
export function mediaPaths(data: Record<string, unknown>): readonly string[] {
  const named = listOf(data["scenarios"])
    .filter(isRecord)
    .flatMap((scenario) => [
      ...listOf(scenario["recordings"])
        .filter(isRecord)
        .flatMap((recording) => [
          recording["video"],
          ...listOf(recording["frames"]).map((frame) => pathOf(frame, "src")),
        ]),
      isRecord(scenario["visualMatch"]) ? scenario["visualMatch"]["baseline"] : null,
      isRecord(scenario["visualMatch"]) ? scenario["visualMatch"]["build"] : null,
      ...listOf(scenario["artifacts"]).map((artifact) => pathOf(artifact, "href")),
      ...listOf(scenario["proofs"]).map((proof) => (isRecord(proof) ? proof["image"] : null)),
    ]);
  const local = named
    .filter((path): path is string => typeof path === "string" && path !== "")
    .filter((path) => !/^[a-z][a-z0-9+.-]*:/i.test(path));
  return [...new Set(local)];
}

/** The html with its media island written ahead of the data island, replacing one already there. */
export function withMediaIsland(html: string, media: Readonly<Record<string, string>>): string {
  const island = `<script type="application/json" id="report-media">${JSON.stringify(media)}</script>\n`;
  // A replacer function, since a `$` in a replacement string is a pattern, not a character.
  return html.replace(MEDIA_ISLAND, "").replace(DATA_ISLAND, (dataIsland) => island + dataIsland);
}

const isInside = (dir: string, path: string): boolean => {
  const fromDir = relative(dir, resolve(dir, path));
  return !fromDir.startsWith("..") && !isAbsolute(fromDir);
};

/** One named file as a data URI, or the reason it is left out of the report. */
function inlineFile(dir: string, path: string): InlineResult {
  const mime = MIME_TYPES[extname(path).toLowerCase()];
  if (mime === undefined)
    return { path, bytes: null, uri: null, failure: "not a type the report shows" };
  // A design baseline is an image kept outside the directory; nothing else the report names is,
  // and a text file from outside it has no business inside an html that gets shared.
  if (!mime.startsWith("image/") && !isInside(dir, path)) {
    return { path, bytes: null, uri: null, failure: "outside the verification directory" };
  }
  try {
    const content = readFileSync(resolve(dir, path));
    const uri = `data:${mime};base64,${content.toString("base64")}`;
    return { path, bytes: content.length, uri, failure: null };
  } catch {
    return { path, bytes: null, uri: null, failure: "no such file" };
  }
}

/** Null when the report's data island is unreadable. */
export function inlineMedia(dir: string): readonly InlineResult[] | null {
  const reportPath = join(dir, REPORT_NAME);
  const html = readFileSync(reportPath, "utf8");
  const data = parseReportData(html);
  if (data === null) return null;

  const results = mediaPaths(data).map((path) => inlineFile(dir, path));
  const media = Object.fromEntries(
    results.flatMap((result) => (result.uri === null ? [] : [[result.path, result.uri]])),
  );
  writeFileSync(reportPath, withMediaIsland(html, media));
  return results;
}

export const formatInline = (result: InlineResult): string =>
  result.failure !== null
    ? `FAILED ${result.path} — ${result.failure}`
    : `ok ${result.path} ${result.bytes}B`;

function inlineMain(dir: string): number {
  if (!existsSync(join(dir, REPORT_NAME))) {
    console.error(`no ${REPORT_NAME} under ${dir} — write the report before inlining its media`);
    return 2;
  }

  const results = inlineMedia(dir);
  if (results === null) {
    console.error(`no report-data island holding a JSON object in ${join(dir, REPORT_NAME)}`);
    return 2;
  }

  for (const result of results) console.log(formatInline(result));
  console.log(`report ${statSync(join(dir, REPORT_NAME)).size}B`);
  return results.some((result) => result.failure !== null) ? 1 : 0;
}

function buildMain(dir: string): number {
  if (scenarioPrefixes(dir).length === 0) {
    console.log(`no frames under ${join(dir, "screenshots")} — no videos to build`);
    return 0;
  }

  if (!hasFfmpeg()) {
    console.error("ffmpeg is not on PATH — no video can be built");
    return 2;
  }

  const results = buildScenarios(dir);
  for (const result of results) console.log(formatResult(result));
  return results.some((result) => result.failure !== null) ? 1 : 0;
}

export function main(args: readonly string[]): number {
  const inline = args[0] === "--inline";
  const target = inline ? args[1] : args[0];
  if (target === undefined || args.length > (inline ? 2 : 1)) {
    console.error("usage: report-media.ts [--inline] VERIFICATION_DIR");
    return 2;
  }

  const dir = resolve(target);
  if (!isDirectory(dir)) {
    console.error(`no such directory: ${dir}`);
    return 2;
  }

  return inline ? inlineMain(dir) : buildMain(dir);
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
