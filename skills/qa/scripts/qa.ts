import { FixRequestSchema, NonEmptyStringSchema } from "@yok/sdk";
import * as z from "zod";

export const QaOutputSchema = z
  .strictObject({
    status: z.enum(["PASS", "PARTIAL", "FAIL", "BLOCKED"]),
    reason: NonEmptyStringSchema.optional(),
    report: NonEmptyStringSchema.nullable(),
    // one entry per requirement the coverage table marks NOT VERIFIED, so the PR and Asana list each
    gaps: z
      .array(
        z.strictObject({
          scenario: NonEmptyStringSchema,
          req: NonEmptyStringSchema,
          mechanism: NonEmptyStringSchema,
        }),
      )
      .refine((gaps) => new Set(gaps.map((gap) => gap.req)).size === gaps.length, {
        message: "each gap req appears once",
      }),
    // the fix stage records one result per id, so two bugs sharing one could never both be closed
    bugs: z
      .array(FixRequestSchema.extend({ askUser: z.boolean() }))
      .refine((bugs) => new Set(bugs.map((bug) => bug.id)).size === bugs.length, {
        message: "each bug id appears once",
      }),
  })
  .refine((output) => output.status === "PASS" || output.reason !== undefined, {
    path: ["reason"],
    message: "reason is required unless status is PASS",
  })
  // A FAIL may defer its report to a later round and a BLOCKED pass drove nothing; any other
  // verdict without the report it rests on is unproven.
  .refine((output) => ["FAIL", "BLOCKED"].includes(output.status) || output.report !== null, {
    path: ["report"],
    message: "report is required when status is PASS or PARTIAL",
  })
  .refine((output) => output.status !== "FAIL" || output.bugs.length > 0, {
    path: ["bugs"],
    message: "a FAIL names at least one bug for the fix round",
  })
  // A bug's scenario is a FAILURE, which makes the derived verdict FAIL; any other verdict that
  // carries one would ship it unfixed, since only a FAIL enters the fix round.
  .refine((output) => output.status === "FAIL" || output.bugs.length === 0, {
    path: ["bugs"],
    message: "only a FAIL names bugs: a bug makes the derived verdict FAIL",
  })
  .refine((output) => output.status !== "PARTIAL" || output.gaps.length > 0, {
    path: ["gaps"],
    message: "a PARTIAL names at least one gap it could not verify",
  });

export const schemas = { "qa.output.v1": QaOutputSchema };
