import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type FileArtifact,
  indexedFrames,
  isBuiltTo,
  isNotBuilt,
  readPlanText,
  type VerifierInput,
  type VerifierResult,
} from "@yok/sdk";

type Finding = VerifierResult["findings"][number];

const readOptional = (path: string): Promise<string | undefined> =>
  readFile(path, "utf8").catch(() => undefined);

// Every frame in design/INDEX.md is built by a step or recorded as not built.
const checkFrames = async (artifactsDir: string): Promise<Finding[]> => {
  const indexPath = join(artifactsDir, "design", "INDEX.md");
  const index = await readOptional(indexPath);
  if (index === undefined) return [];
  const text = await readPlanText(artifactsDir);
  return indexedFrames(index)
    .filter((row) => !isBuiltTo(row, text) && !isNotBuilt(row.frame, text))
    .map(({ frame, width }) => ({
      message: `${frame} is in design/INDEX.md, but no step says "build to ${frame}${width === "" ? "" : ` at ${width}px`}" and plan.md has no "${frame} — not built: REASON" line`,
      path: indexPath,
    }));
};

// A step is a numbered line at the start of a line, running to the next step or heading.
const STEP_OR_HEADING = /^(?=\d+\.\s|#{1,6}\s)/m;
const BUILD_TO = /build\s+to\s+`?(design\/[^\s`]+)/i;
const DIFF_FENCE = /^[ \t]*```diff\b/m;

// A step that builds to a frame shows the code that builds it, as every code step does.
const checkDesignDiffs = async (artifactsDir: string): Promise<Finding[]> => {
  const names = await readdir(join(artifactsDir, "phases")).catch((): string[] => []);
  const phases = names.filter((name) => name.endsWith(".md")).toSorted();
  const findings = await Promise.all(
    phases.map(async (name) => {
      const path = join(artifactsDir, "phases", name);
      const steps = ((await readOptional(path)) ?? "")
        .split(STEP_OR_HEADING)
        .filter((chunk) => /^\d+\.\s/.test(chunk) && !DIFF_FENCE.test(chunk));
      return steps.flatMap((step) => {
        const frame = BUILD_TO.exec(step)?.[1];
        const n = /^\d+/.exec(step)?.[0];
        return frame === undefined
          ? []
          : [
              {
                message: `phases/${name} step ${n} builds to ${frame} but has no diff: show the code the step changes in a \`\`\`diff block, as every code step does`,
                path,
              },
            ];
      });
    }),
  );
  return findings.flat();
};

// The planning stage's verifier: every frame in design/INDEX.md is claimed, and every step that
// builds to a frame carries its diff.
export const checkDesignCoverage = async (input: VerifierInput): Promise<VerifierResult> => {
  const plan = input.artifacts.find(
    (artifact): artifact is FileArtifact => artifact.type === "plan" && "path" in artifact,
  );
  if (plan === undefined) return { pass: true, findings: [] };
  const artifactsDir = dirname(plan.path);
  const findings = [
    ...(await checkFrames(artifactsDir)),
    ...(await checkDesignDiffs(artifactsDir)),
  ];
  return { pass: findings.length === 0, findings };
};
