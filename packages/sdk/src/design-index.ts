import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// How the planning and qa verifiers read artifacts/design/INDEX.md and the plan's claims on its
// frames. Both import this one copy, so the two stages never disagree on what a claim is.

export type DesignFrame = Readonly<{ frame: string; width: string }>;

// The `design/FILE` path in each table row of design/INDEX.md, and the Width cell after it.
export const indexedFrames = (index: string): readonly DesignFrame[] =>
  index
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .flatMap((line) => {
      const match = line.match(/`(design\/[^`]+)`\s*\|\s*(\d*)/);
      return match?.[1] === undefined ? [] : [{ frame: match[1], width: match[2] ?? "" }];
    });

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A step that builds to the frame at the width the index gives it; a frame the index gives no
// width needs none. The phrase may wrap or start with a capital.
export const isBuiltTo = ({ frame, width }: DesignFrame, plan: string): boolean =>
  new RegExp(
    `build\\s+to\\s+${escapeRegExp(frame)}(?![\\w./-])${width === "" ? "" : `\\s+at\\s+${width}px\\b`}`,
    "i",
  ).test(plan);

// A "not built" line that gives a reason. It may wrap after the dash or start with a capital, but
// the dash sits on the frame's line and the reason on the colon's, so neither a bullet below the
// frame nor the line after a bare "not built:" is borrowed.
export const isNotBuilt = (frame: string, plan: string): boolean =>
  new RegExp(`${escapeRegExp(frame)}[ \\t]*[—-]\\s*not\\s+built:[ \\t]*\\S`, "i").test(plan);

const readOptional = (path: string): Promise<string | undefined> =>
  readFile(path, "utf8").catch(() => undefined);

// plan.md and every phases/*.md under ARTIFACTS_DIR as one text, backticks dropped so a claim
// reads the same whether or not its path is code-formatted.
export const readPlanText = async (artifactsDir: string): Promise<string> => {
  const phaseFiles = await readdir(join(artifactsDir, "phases")).catch((): string[] => []);
  const paths = [
    join(artifactsDir, "plan.md"),
    ...phaseFiles
      .filter((file) => file.endsWith(".md"))
      .map((file) => join(artifactsDir, "phases", file)),
  ];
  return (await Promise.all(paths.map(readOptional))).join("\n").replaceAll("`", "");
};
