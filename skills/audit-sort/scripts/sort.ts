import { AuditResultSchema, NonEmptyStringSchema } from "@yok/sdk";
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
