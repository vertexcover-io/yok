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

export const AuditSortOutputSchema = z
  .strictObject({ results: z.array(SortedResultSchema) })
  .refine(
    ({ results }) => new Set(results.map((result) => result.id)).size === results.length,
    "each result id appears once",
  );
export type AuditSortOutput = z.infer<typeof AuditSortOutputSchema>;
export const schemas = { "audit-sort.output.v1": AuditSortOutputSchema };
