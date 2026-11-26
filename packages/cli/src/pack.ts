import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { Command } from "@commander-js/extra-typings";
import { createRegistryReader, registryPath, requireRun, runDirOf } from "@yok/sdk";
import { fail } from "./client.ts";

type ZipFile = Readonly<{ name: string; data: Buffer; modified: Date }>;
type Field = readonly [size: 2 | 4, value: number];

// Zip record signatures and header values, from PKWARE's APPNOTE.TXT.
const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const VERSION = 20;
const UTF8_NAMES = 0x0800;
const DEFLATE = 8;

const littleEndian = (fields: readonly Field[]): Buffer =>
  Buffer.concat(
    fields.map(([size, value]) => {
      const bytes = Buffer.alloc(size);
      if (size === 2) bytes.writeUInt16LE(value);
      else bytes.writeUInt32LE(value);
      return bytes;
    }),
  );

// The local times a DOS date can hold.
const DOS_FIRST = new Date(1980, 0, 1).getTime();
const DOS_LAST = new Date(2107, 11, 31, 23, 59, 58).getTime();

// MS-DOS packs local time into 16 bits each: seconds are stored halved, years count from 1980.
const dosDateTime = (modified: Date): readonly Field[] => {
  const at = new Date(Math.min(Math.max(modified.getTime(), DOS_FIRST), DOS_LAST));
  return [
    [2, (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1)],
    [2, ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()],
  ];
};

const zipFiles = (files: readonly ZipFile[]): Buffer => {
  const entries = files.map((file) => {
    const name = Buffer.from(file.name);
    const packed = deflateRawSync(file.data);
    // The fields the local and central headers share, in this order.
    const shared: readonly Field[] = [
      [2, VERSION],
      [2, UTF8_NAMES],
      [2, DEFLATE],
      ...dosDateTime(file.modified),
      [4, crc32(file.data)],
      [4, packed.length],
      [4, file.data.length],
      [2, name.length],
      [2, 0],
    ];
    return { name, packed, shared };
  });
  const locals = entries.map((entry) =>
    Buffer.concat([littleEndian([[4, LOCAL_HEADER], ...entry.shared]), entry.name, entry.packed]),
  );
  const offsets = locals.map((_, i) => locals.slice(0, i).reduce((sum, l) => sum + l.length, 0));
  const central = Buffer.concat(
    entries.map((entry, i) =>
      Buffer.concat([
        littleEndian([
          [4, CENTRAL_HEADER],
          [2, VERSION],
          ...entry.shared,
          [2, 0],
          [2, 0],
          [2, 0],
          [4, 0],
          [4, offsets[i] ?? 0],
        ]),
        entry.name,
      ]),
    ),
  );
  const localsSize = locals.reduce((sum, l) => sum + l.length, 0);
  const end = littleEndian([
    [4, END_OF_CENTRAL],
    [2, 0],
    [2, 0],
    [2, files.length],
    [2, files.length],
    [4, central.length],
    [4, localsSize],
    [2, 0],
  ]);
  return Buffer.concat([...locals, central, end]);
};

// A live run renames its temp and lock files away, so one listed a moment ago may be gone.
const unlessGone = <T>(read: Promise<T>): Promise<T | undefined> =>
  read.catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });

// Every file under the run's folder, named NAME/PATH so the zip unpacks into one folder.
const readRunFiles = async (runDir: string, name: string): Promise<readonly ZipFile[]> => {
  const found = await readdir(runDir, { recursive: true, withFileTypes: true });
  const paths = found.filter((entry) => entry.isFile()).map((e) => join(e.parentPath, e.name));
  const files = await Promise.all(
    paths.map(async (path) =>
      unlessGone(
        Promise.all([readFile(path), stat(path)]).then(([data, info]) => ({
          name: [name, ...relative(runDir, path).split(sep)].join("/"),
          data,
          modified: info.mtime,
        })),
      ),
    ),
  );
  return files.filter((file) => file !== undefined);
};

export const packCommand = () =>
  new Command("pack")
    .description("Zip a run's .yok folder into .yok/NAME.zip and print the zip's path")
    .argument("[name]", "run name in this repo (default: $YOK_RUN_ID)")
    .option("--run-id <id>", "pack by run id instead of name")
    .action(async (name, opts) => {
      const run = await requireRun({
        registry: createRegistryReader(registryPath()),
        name,
        id: opts.runId,
        env: process.env,
        cwd: process.cwd(),
      });
      if (!run.ok) return fail(run.error);
      const runDir = runDirOf(run.value.cwd, run.value.name);
      const zipPath = `${runDir}.zip`;
      await writeFile(zipPath, zipFiles(await readRunFiles(runDir, run.value.name)));
      console.log(zipPath);
    });
