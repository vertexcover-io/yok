#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { parseArgs } from "node:util";
import { NonEmptyStringSchema, readProjectEnv } from "@yok/sdk";
import * as z from "zod";

// Backticks, pipes and control characters would break the design index's table row.
export const SafeFilenameSchema = NonEmptyStringSchema.refine(
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  (name) => !/[/\\`|\x00-\x1f\x7f]|^\./.test(name) && !name.includes(".."),
  "Expected one filename with no directory part, no .., no leading dot, no backtick, pipe or control character",
);

const AssetBaseSchema = z.strictObject({
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  type: z.enum([
    "mockup",
    "screenshot",
    "diagram",
    "recording",
    "document",
    "log",
    "code",
    "data",
    "other",
  ]),
  source: NonEmptyStringSchema,
});

const AssetSchema = z.discriminatedUnion("status", [
  AssetBaseSchema.extend({
    status: z.literal("downloaded"),
    path: SafeFilenameSchema,
    mimeType: NonEmptyStringSchema,
    bytes: z.int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  AssetBaseSchema.extend({ status: z.literal("unavailable"), reason: NonEmptyStringSchema }),
]);

export const TicketSchema = z.strictObject({
  schemaVersion: z.literal(1),
  provider: NonEmptyStringSchema,
  id: NonEmptyStringSchema,
  key: NonEmptyStringSchema,
  url: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  // who the ticket is assigned to, by name; absent when nobody is
  assignee: NonEmptyStringSchema.optional(),
  body: z.string(),
  properties: z.record(z.string(), z.json()),
  comments: z.array(
    z.strictObject({
      id: NonEmptyStringSchema,
      body: z.string(),
      author: NonEmptyStringSchema.optional(),
      createdAt: z.iso.datetime().optional(),
    }),
  ),
  references: z.array(
    z.strictObject({ url: NonEmptyStringSchema, kind: NonEmptyStringSchema, context: z.string() }),
  ),
  assets: z.array(AssetSchema),
  complete: z.boolean(),
  fetchedAt: z.iso.datetime(),
});
export type Ticket = z.infer<typeof TicketSchema>;
type Asset = Ticket["assets"][number];

export const TicketFetcherInputSchema = z.strictObject({ request: NonEmptyStringSchema });

export const TicketFetcherOutputSchema = z.strictObject({
  task: NonEmptyStringSchema,
  ticket: z
    .strictObject({
      provider: NonEmptyStringSchema,
      key: NonEmptyStringSchema,
      url: NonEmptyStringSchema,
      path: NonEmptyStringSchema,
      complete: z.boolean(),
    })
    .optional(),
});

export const schemas = {
  "ticket-fetcher.input.v1": TicketFetcherInputSchema,
  "ticket-fetcher.output.v1": TicketFetcherOutputSchema,
};

export type Validation =
  | Readonly<{ ok: true; path: string }>
  | Readonly<{ ok: false; issues: readonly string[] }>;

const readTicketFile = async (path: string): Promise<Ticket | string> => {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return `${path}: cannot read ticket.json`;
  try {
    const parsed = TicketSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : z.prettifyError(parsed.error);
  } catch {
    return `${path}: not valid JSON`;
  }
};

const sha256Of = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

type Downloaded = Extract<Asset, { status: "downloaded" }>;

// Where a downloaded file may be: the ticket folder, or, once the design script moved it, the
// sibling design folder: an image at its name, a mockup as its folder's index.html, and a file a
// mockup links to beside that page.
const homes = (dir: string, ticket: Ticket, asset: Downloaded): readonly string[] => {
  const designDir = join(dir, "..", "design");
  const pages = ticket.assets.filter(
    (a): a is Downloaded => a.status === "downloaded" && classifyAsset(a) === "html-mockup",
  );
  const own =
    classifyAsset(asset) === "html-mockup"
      ? join(designDir, stripExtension(asset.path), "index.html")
      : join(designDir, asset.path);
  return [
    join(dir, asset.path),
    own,
    ...pages.map((p) => join(designDir, stripExtension(p.path), asset.path)),
  ];
};

// Roots are realpaths, so a symlink out of both folders is caught.
const fileIssue = async ({
  roots,
  candidates,
  asset,
}: Readonly<{ roots: readonly string[]; candidates: readonly string[]; asset: Downloaded }>) => {
  const label = `asset ${asset.id} (${asset.path})`;
  const found = await Promise.all(candidates.map((c) => realpath(c).catch(() => undefined)));
  const file = found.find((f) => f !== undefined);
  if (file === undefined) return [`${label}: file is missing`];
  if (!roots.some((root) => file.startsWith(`${root}${sep}`))) {
    return [`${label}: file resolves outside the folder`];
  }
  const info = await stat(file);
  if (!info.isFile()) return [`${label}: not a regular file`];
  if (info.size !== asset.bytes) return [`${label}: bytes is ${info.size}, not ${asset.bytes}`];
  return (await sha256Of(file)) === asset.sha256
    ? []
    : [`${label}: sha256 does not match the file`];
};

const duplicatePaths = (paths: readonly string[]): readonly string[] =>
  paths
    .filter((path, index) => paths.indexOf(path) !== index)
    .map((path) => `duplicate asset path ${path}`);

export const validateTicketDir = async (dir: string): Promise<Validation> => {
  const path = join(dir, "ticket.json");
  const ticket = await readTicketFile(path);
  if (typeof ticket === "string") return { ok: false, issues: [ticket] };
  const files = ticket.assets.filter((asset) => asset.status === "downloaded");
  const roots = await Promise.all(
    [dir, join(dir, "..", "design")].map((d) => realpath(d).catch(() => undefined)),
  );
  const fileIssues = files.map((asset) =>
    fileIssue({
      roots: roots.filter((r) => r !== undefined),
      candidates: homes(dir, ticket, asset),
      asset,
    }),
  );
  const issues = [
    ...duplicatePaths(files.map((asset) => asset.path)),
    ...(ticket.complete && files.length < ticket.assets.length
      ? ["complete must be false while an asset is unavailable"]
      : []),
    ...(await Promise.all(fileIssues)).flat(),
  ];
  return issues.length === 0 ? { ok: true, path } : { ok: false, issues };
};

export type AssetInfo = Readonly<{ path: string; bytes: number; sha256: string; mimeType: string }>;
export type Target = Readonly<{ dir: string; name: string }>;

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const IMAGE_FILE = /\.(png|jpe?g|webp|gif|svg|avif)$/i;

// What a downloaded asset is to the design index.
export type DesignKind = "image" | "html-mockup" | "spec-doc" | "other";

// A screenshot is indexed with the mockups: the design stage drops a row that only shows today's bug.
export const classifyAsset = (asset: Downloaded): DesignKind => {
  const isHtml = asset.mimeType === "text/html" || /\.html?$/i.test(asset.path);
  // Only a page the ticket calls a mockup is opened in the agent's browser; an HTML log is data.
  if (isHtml && asset.type === "mockup") return "html-mockup";
  const drawn = asset.type === "mockup" || asset.type === "screenshot";
  // A download without a Content-Type records application/octet-stream; its extension still says.
  if (drawn && (asset.mimeType.startsWith("image/") || IMAGE_FILE.test(asset.path))) return "image";
  if (asset.type === "document" && /^text\/(markdown|plain)$/.test(asset.mimeType)) {
    return "spec-doc";
  }
  return "other";
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 72 dpi, the density a 1x screen capture records, in the pixels per metre a pHYs chunk counts.
const PIXELS_PER_METRE_AT_1X = 2835;

// The pixel ratio a pHYs chunk records (2 for a Retina capture), read from the chunks before the
// image data; 1 when the file records none, none in metres, or a print density such as 300 dpi,
// which says nothing about the screen it was drawn for.
const pixelRatio = (png: Buffer, offset: number): number => {
  if (offset + 17 > png.length) return 1;
  const type = png.toString("latin1", offset + 4, offset + 8);
  if (type === "IDAT") return 1;
  if (type === "pHYs" && png[offset + 16] === 1) {
    const ratio = Math.round(png.readUInt32BE(offset + 8) / PIXELS_PER_METRE_AT_1X);
    return ratio === 2 || ratio === 3 ? ratio : 1;
  }
  return pixelRatio(png, offset + 12 + png.readUInt32BE(offset));
};

// The width a PNG was drawn for: its IHDR width (a big-endian uint32 at byte 16) over its pixel
// ratio, so a 2x screenshot reads at its CSS width. null for any other format.
const readPngWidth = async (path: string): Promise<number | null> => {
  const png = await readFile(path);
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return Math.round(png.readUInt32BE(16) / pixelRatio(png, 8));
};

const stripExtension = (path: string): string => path.replace(/\.[^.]+$/, "");

// Ticket text written into INDEX.md or spec.md: one line, with no pipe or backtick to end its
// table cell or code span.
const inline = (text: string): string =>
  text
    .trim()
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replaceAll("|", "\\|")
    .replaceAll("`", "'");

const describeSource = (
  file: string,
  assets: readonly Downloaded[],
  slugs: readonly string[],
): string => {
  const asset = assets.find((a) => a.path === file);
  if (asset !== undefined) return `${inline(asset.source)} \`${inline(asset.name)}\``;
  const slug = slugs.find((s) => file.startsWith(`${s}--`));
  if (slug !== undefined) return `HTML mockup \`design/${slug}/index.html\``;
  return file.startsWith("figma--") ? "Figma export" : "added by hand";
};

export type DesignIndex = Readonly<{
  index: string | null;
  mockups: readonly string[];
  figma: readonly string[];
  spec: string | null;
}>;

const isFigma = (url: string): boolean => /(^|\.)figma\.com$/.test(URL.parse(url)?.hostname ?? "");

type Placement = Readonly<{ from: string; to: string }>;

// A design file lives in one place. The first run copies it out of the ticket folder and the
// caller removes the original; a later run, or a restarted one, finds it at its design path.
const place = async ({ from, to }: Placement): Promise<void> => {
  if (await exists(from)) return copyFile(from, to);
  if (await exists(to)) return;
  throw new Error(`${to} is missing and ${from} is gone`);
};

const LINKED_FILE = /(?:src|href)\s*=\s*["']?([^"'\s>]+)|url\(\s*["']?([^"')\s]+)/gi;

// The file names a page's src, href and url() values point at, without any query or fragment.
const linkedFiles = (html: string): ReadonlySet<string> =>
  new Set(
    [...html.matchAll(LINKED_FILE)].map((m) =>
      basename((m[1] ?? m[2] ?? "").split(/[?#]/)[0] ?? ""),
    ),
  );

type Mockup = Readonly<{ linked: readonly string[]; placements: readonly Placement[] }>;

// A mockup's stylesheets and images are the ticket files its markup links to; each lands beside
// the page so its relative links load, and nowhere else: a linked image is part of the page, not
// a frame. A ticket file named index.html stays out, since it would land on the page itself.
const mockupPlacements = async ({
  ticketDir,
  designDir,
  page,
  files,
}: Readonly<{
  ticketDir: string;
  designDir: string;
  page: Downloaded;
  files: readonly Downloaded[];
}>): Promise<Mockup> => {
  const folder = join(designDir, stripExtension(page.path));
  await mkdir(folder, { recursive: true });
  const source = join(ticketDir, page.path);
  const html = await readFile((await exists(source)) ? source : join(folder, "index.html"), "utf8");
  const linked = linkedFiles(html);
  const deps = files.filter((a) => a !== page && a.path !== "index.html" && linked.has(a.path));
  return {
    linked: deps.map((a) => a.path),
    placements: [
      { from: source, to: join(folder, "index.html") },
      ...deps.map((a) => ({ from: join(ticketDir, a.path), to: join(folder, a.path) })),
    ],
  };
};

export const writeDesignIndex = async (
  ticketDir: string,
  designDir: string,
  unavailable: readonly string[],
): Promise<DesignIndex> => {
  const ticket = await readTicketFile(join(ticketDir, "ticket.json"));
  if (typeof ticket === "string") throw new Error(ticket);
  const files = ticket.assets.filter((a): a is Downloaded => a.status === "downloaded");
  const ofKind = (kind: DesignKind) => files.filter((a) => classifyAsset(a) === kind);
  const [images, pages, specs] = [ofKind("image"), ofKind("html-mockup"), ofKind("spec-doc")];
  const missing = [
    ...ticket.assets.flatMap((a) =>
      a.status === "unavailable" && (a.type === "mockup" || a.type === "screenshot")
        ? [`${inline(a.name)} — ${inline(a.reason)}`]
        : [],
    ),
    ...unavailable.map(inline),
  ];
  const figma = ticket.references.map((r) => r.url).filter(isFigma);
  const empty = [images, pages, specs, missing, figma].every((list) => list.length === 0);
  if (empty && !(await exists(designDir))) {
    return { index: null, mockups: [], figma: [], spec: null };
  }

  await mkdir(designDir, { recursive: true });
  const slugs = pages.map((a) => stripExtension(a.path));
  const mockups = await Promise.all(
    pages.map((page) => mockupPlacements({ ticketDir, designDir, page, files })),
  );
  const linked = new Set(mockups.flatMap((m) => m.linked));
  const standalone = images.filter((a) => !linked.has(a.path));
  const placements = [
    ...standalone.map((a) => ({ from: join(ticketDir, a.path), to: join(designDir, a.path) })),
    ...mockups.flatMap((m) => m.placements),
  ];
  await Promise.all(placements.map(place));
  await Promise.all(placements.map((p) => rm(p.from, { force: true })));
  const specTexts = await Promise.all(
    specs.map(
      async (a) => `## ${inline(a.name)}\n\n${await readFile(join(ticketDir, a.path), "utf8")}`,
    ),
  );
  const spec = specTexts.length === 0 ? null : join(designDir, "spec.md");
  if (spec !== null) await writeFile(spec, `${specTexts.join("\n\n")}\n`);

  // The ticket's images are listed by name, since an upload's name may carry no extension; the
  // folder scan finds the frames an agent added on an earlier run.
  const added = (await readdir(designDir)).filter((f) => IMAGE_FILE.test(f));
  const frames = [...new Set([...standalone.map((a) => a.path), ...added])].sort();
  const rows = await Promise.all(
    frames.map(async (f) => {
      const width = (await readPngWidth(join(designDir, f))) ?? "";
      return `|  | \`design/${f}\` | ${width} | ${describeSource(f, files, slugs)} |  |`;
    }),
  );
  const index = join(designDir, "INDEX.md");
  await writeFile(
    index,
    [
      "# Design index",
      "",
      "| Screen | Local file | Width | Source | Source of truth for |",
      "|---|---|---|---|---|",
      ...rows,
      ...(spec === null ? [] : ["", "Spec: `design/spec.md`"]),
      ...(missing.length === 0 ? [] : ["", "## Unavailable", "", ...missing.map((m) => `- ${m}`)]),
      "",
    ].join("\n"),
  );
  return { index, mockups: slugs.map((s) => join(designDir, s, "index.html")), figma, spec };
};

export const targetPath = async ({ dir, name }: Target): Promise<string> => {
  const safe = SafeFilenameSchema.safeParse(name);
  if (!safe.success) {
    throw new Error(`unsafe file name ${JSON.stringify(name)}: ${z.prettifyError(safe.error)}`);
  }
  const path = join(dir, name);
  if (await exists(path)) throw new Error(`${path} already exists`);
  return path;
};

const writeStream = async (body: ReadableStream<Uint8Array>, path: string): Promise<string> => {
  const file = await open(path, "wx");
  const hash = createHash("sha256");
  try {
    await body.pipeTo(
      new WritableStream<Uint8Array>({
        write: async (chunk) => {
          hash.update(chunk);
          await file.write(chunk);
        },
      }),
    );
  } finally {
    await file.close();
  }
  return hash.digest("hex");
};

const save = async (response: Response, path: string): Promise<AssetInfo> => {
  if (!response.ok || response.body === null) {
    throw new Error(`download returned HTTP ${response.status}`);
  }
  // A partial file would make the one allowed retry fail with "already exists".
  const sha256 = await writeStream(response.body, path).catch(async (error: unknown) => {
    await rm(path, { force: true });
    throw error;
  });
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim();
  return {
    path,
    bytes: (await stat(path)).size,
    sha256,
    mimeType: mimeType || "application/octet-stream",
  };
};

// Literal addresses only; a public name that resolves to a private address is not caught.
const PRIVATE_IPV4 = /^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./;
// `::` with at most 32 low bits set covers loopback and IPv4-compatible forms; 64:ff9b:: is NAT64.
const PRIVATE_IPV6 =
  /^\[(?:::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})?)?|::ffff:.*|64:ff9b:.*|f[cd].*|fe[89ab].*)\]$/;

const isPrivateHost = (host: string): boolean =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  PRIVATE_IPV4.test(host) ||
  PRIVATE_IPV6.test(host);

export const assertPublic = (url: URL): void => {
  if (url.protocol !== "https:") throw new Error(`refusing ${url}: only https URLs are fetched`);
  if (isPrivateHost(url.hostname.toLowerCase())) {
    throw new Error(`refusing ${url}: a local or private address`);
  }
};

const MAX_REDIRECTS = 5;

// Each hop is re-checked as a public URL and gets no credentials: only the first request carries them.
const fetchFollowing = async (
  url: URL,
  headers: Record<string, string>,
  hops = 0,
): Promise<Response> => {
  const response = await fetch(url, { headers, redirect: "manual", credentials: "omit" });
  const location = response.headers.get("location");
  if (response.status < 300 || response.status >= 400 || location === null) return response;
  await response.body?.cancel();
  if (hops >= MAX_REDIRECTS) throw new Error(`refusing ${url}: too many redirects`);
  const next = URL.parse(location, url.href);
  if (next === null) throw new Error(`refusing ${url}: invalid redirect to ${location}`);
  assertPublic(next);
  return fetchFollowing(next, {}, hops + 1);
};

export type Download = Readonly<{
  url: URL;
  headers: Record<string, string>;
  path: string;
  allowedOrigin?: string | undefined;
}>;

export const downloadFile = async (download: Download): Promise<AssetInfo> => {
  const { url, headers, path, allowedOrigin } = download;
  if (url.origin !== allowedOrigin) assertPublic(url);
  return save(await fetchFollowing(url, headers), path);
};

// A provider's API. `allowedOrigin` is set only when a test points the provider at a fake
// server, and is the one non-public origin a download may reach.
export type Api = Readonly<{ url: string; key: string; allowedOrigin?: string }>;
export type ApiSource = Readonly<{ keyVar: string; urlVar: string; defaultUrl: string }>;

export const loadApiKey = async (cwd: string, keyVar: string): Promise<string> => {
  const key = await readProjectEnv(cwd, keyVar);
  if (key === undefined || key === "") {
    throw new Error(`${keyVar} is not set; add it to the project .env or the environment`);
  }
  return key;
};

export const loadApi = async (cwd: string, source: ApiSource): Promise<Api> => {
  const override = process.env[source.urlVar];
  return {
    url: override ?? source.defaultUrl,
    key: await loadApiKey(cwd, source.keyVar),
    ...(override === undefined ? {} : { allowedOrigin: new URL(override).origin }),
  };
};

export const runProviderCli = async (
  run: (cwd: string, argv: readonly string[]) => Promise<unknown>,
  argv: readonly string[],
): Promise<void> => {
  try {
    console.log(JSON.stringify(await run(process.cwd(), argv)));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
};

const USAGE =
  "usage: ticket.ts validate DIR | ticket.ts design TICKET_DIR DESIGN_DIR [--unavailable TEXT]...";

const runDesign = async (argv: readonly string[]): Promise<void> => {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { unavailable: { type: "string", multiple: true } },
  });
  const [ticketDir, designDir] = positionals;
  if (ticketDir === undefined || designDir === undefined) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  try {
    const index = await writeDesignIndex(ticketDir, designDir, values.unavailable ?? []);
    console.log(JSON.stringify(index));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
};

export const main = async (argv: readonly string[]): Promise<void> => {
  const [command, dir] = argv;
  if (command === "design") return runDesign(argv.slice(1));
  if (command !== "validate" || dir === undefined) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const result = await validateTicketDir(dir);
  if (result.ok) return console.log(JSON.stringify(result));
  console.error(JSON.stringify(result.issues, null, 2));
  process.exitCode = 1;
};

if (import.meta.main) await main(process.argv.slice(2));
