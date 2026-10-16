import { FixRequestSchema, NonEmptyStringSchema } from "@yok/sdk";
import * as z from "zod";

const TestFindingSchema = FixRequestSchema.extend({
  id: z.string().regex(/^(test|plan|product)-\d+$/, "Expected LABEL-N, such as test-1"),
});

export const ReviewRegressionTestsOutputSchema = z
  .strictObject({
    verdict: z.enum(["CHANGES_REQUESTED", "APPROVED"]),
    report: NonEmptyStringSchema,
    findings: z.array(TestFindingSchema),
  })
  .refine((output) => (output.verdict === "CHANGES_REQUESTED") === output.findings.length > 0, {
    path: ["verdict"],
    message: "verdict is CHANGES_REQUESTED exactly when findings[] is non-empty",
  })
  .refine(
    (output) =>
      new Set(output.findings.map((finding) => finding.id)).size === output.findings.length,
    { path: ["findings"], message: "each finding id appears once" },
  );

export const schemas = { "review-regression-tests.output.v1": ReviewRegressionTestsOutputSchema };
