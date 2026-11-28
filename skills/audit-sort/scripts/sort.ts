import { spawnSync } from "node:child_process";
import {
  AuditResultSchema,
  type Finding,
  NonEmptyStringSchema,
  type VerifierInput,
  type VerifierResult,
} from "@yok/sdk";
import * as z from "zod";

const ProofBlockSchema = z.strictObject({
  kind: z.enum(["text", "code", "diff", "test-run", "link", "quote"]),
  title: NonEmptyStringSchema,
  content: z.string(),
});

// What the audit page shows as a result's evidence.
export const ProofSchema = z.strictObject({
  where: NonEmptyStringSchema,
  summary: NonEmptyStringSchema,
  blocks: z.array(ProofBlockSchema),
});

// Before publish a fix is only the instruction; an apply run adds commit, pr or error later.
const InstructionSchema = z.strictObject({
  summary: NonEmptyStringSchema,
  diff: NonEmptyStringSchema.optional(),
  prompt: NonEmptyStringSchema.optional(),
});

export const SortedResultSchema = AuditResultSchema.extend({
  proof: ProofSchema,
  fix: InstructionSchema,
}).refine(
  (result) =>
    result.state === "needs_work" ? result.fix.prompt !== undefined : result.fix.diff !== undefined,
  "a needs_work fix carries a prompt; any other fix carries a diff",
);
export type SortedResult = z.infer<typeof SortedResultSchema>;

// One item for the fix stage, in the shape skills/fix reads; its id is the result's.
const FixItemSchema = z.strictObject({
  id: NonEmptyStringSchema,
  repo: NonEmptyStringSchema,
  file: NonEmptyStringSchema,
  summary: NonEmptyStringSchema,
  trigger: NonEmptyStringSchema,
  hint: NonEmptyStringSchema,
});

export const AuditSortOutputSchema = z
  .strictObject({
    results: z.array(SortedResultSchema),
    // whether the workflow runs the fix stage and visual-pr on fixes
    autoFix: z.boolean(),
    fixes: z.array(FixItemSchema),
  })
  .refine(
    ({ results }) => new Set(results.map((result) => result.id)).size === results.length,
    "each result id appears once",
  )
  .refine(
    ({ results }) =>
      results.every(
        (result) => result.state !== "auto_fixed" || result.problemType === "duplicates",
      ),
    "only a duplicate is auto_fixed",
  )
  .refine(({ results, fixes, autoFix }) => {
    const autoFixed = results
      .filter((result) => result.state === "auto_fixed")
      .map((result) => result.id);
    const items = fixes.map((item) => item.id);
    return (
      autoFix === items.length > 0 &&
      items.length === autoFixed.length &&
      items.every((id) => autoFixed.includes(id))
    );
  }, "fixes holds one item per auto_fixed result, and autoFix is true exactly when it has any");
export type AuditSortOutput = z.infer<typeof AuditSortOutputSchema>;
export const schemas = { "audit-sort.output.v1": AuditSortOutputSchema };

const NodeInputSchema = z.object({
  workspace: z.object({
    repos: z.array(z.object({ name: NonEmptyStringSchema, worktreeDir: NonEmptyStringSchema })),
  }),
});

// A diff offered as a fix must apply to the checkout the audit measured, or Accept can never work.
// git apply --check reads the diff from stdin and changes nothing.
const diffFinding = (result: SortedResult, dirs: ReadonlyMap<string, string>): Finding | null => {
  const diff = result.fix.diff;
  if (diff === undefined) return null;
  const dir = dirs.get(result.repo);
  if (dir === undefined) {
    return {
      message: `${result.id}: the workspace has no repo ${result.repo} to check its diff in`,
    };
  }
  const checked = spawnSync("git", ["-C", dir, "apply", "--check", "-"], {
    input: diff.endsWith("\n") ? diff : `${diff}\n`,
    encoding: "utf8",
  });
  if (checked.status === 0) return null;
  return {
    message: `${result.id}: its diff does not apply with git apply --check: ${checked.stderr.trim()}`,
    hint: "rewrite the diff against the file as it is in the worktree, with its context lines, and check it again",
  };
};

// The audit-sort stage's verifier: every fix diff applies in its repo's worktree.
export const checkDiffsApply = async (input: VerifierInput): Promise<VerifierResult> => {
  const output = AuditSortOutputSchema.safeParse(input.output);
  const nodeInput = NodeInputSchema.safeParse(input.nodeInput);
  if (!output.success)
    return { pass: false, findings: [{ message: "the output is not audit-sort.output.v1" }] };
  if (!nodeInput.success) {
    return {
      pass: false,
      findings: [{ message: "the node input has no workspace to check diffs in" }],
    };
  }
  const dirs = new Map(nodeInput.data.workspace.repos.map((repo) => [repo.name, repo.worktreeDir]));
  const findings = output.data.results.flatMap((result) => diffFinding(result, dirs) ?? []);
  return { pass: findings.length === 0, findings };
};
