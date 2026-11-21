import { readFile } from "node:fs/promises";
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

// The planning stage's verifier: every frame in design/INDEX.md is built by a step or recorded as not built.
export const checkDesignCoverage = async (input: VerifierInput): Promise<VerifierResult> => {
  const plan = input.artifacts.find(
    (artifact): artifact is FileArtifact => artifact.type === "plan" && "path" in artifact,
  );
  if (plan === undefined) return { pass: true, findings: [] };
  const artifactsDir = dirname(plan.path);
  const indexPath = join(artifactsDir, "design", "INDEX.md");
  const index = await readFile(indexPath, "utf8").catch(() => undefined);
  if (index === undefined) return { pass: true, findings: [] };
  const text = await readPlanText(artifactsDir);
  const findings = indexedFrames(index)
    .filter((row) => !isBuiltTo(row, text) && !isNotBuilt(row.frame, text))
    .map(({ frame, width }) => ({
      message: `${frame} is in design/INDEX.md, but no step says "build to ${frame}${width === "" ? "" : ` at ${width}px`}" and plan.md has no "${frame} — not built: REASON" line`,
      path: indexPath,
    }));
  return { pass: findings.length === 0, findings };
};
