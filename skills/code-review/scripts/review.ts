import { FixRequestSchema, NonEmptyStringSchema } from "@yok/sdk";
import * as z from "zod";

const ReviewFindingSchema = FixRequestSchema.extend({
  id: z.string().regex(/^[a-z]+-\d+$/, "Expected AXIS-N, such as defects-1"),
  file: FixRequestSchema.shape.file.unwrap(),
  severity: FixRequestSchema.shape.severity.unwrap().exclude(["Low"]),
  axis: z.enum(["defects", "spec", "security", "testing", "simplify"]),
  size: FixRequestSchema.shape.size.unwrap(),
});

// Run the cross-field checks even when a field inside a finding is malformed, so one done names
// every problem; skip them when the output, verdict, findings or a finding itself did not parse,
// since the checks read each finding's id. A refine's own issue is custom and never skips the others.
const unparsed = (issue: z.core.$ZodRawIssue): boolean => {
  const path = issue.path ?? [];
  if (path.length === 0) return true;
  if (issue.code === "custom") return false;
  if (path.length === 1) return ["verdict", "findings"].includes(String(path[0]));
  return path.length === 2 && path[0] === "findings";
};
const whenTopLevelParsed = {
  when: (payload: z.core.ParsePayload) => !payload.issues.some(unparsed),
};

export const ReviewOutputSchema = z
  .strictObject({
    verdict: z.enum(["CHANGES_REQUESTED", "APPROVED"]),
    report: NonEmptyStringSchema,
    // the HEAD this pass reviewed in each repo, where the next pass's fix diff starts
    reviewed: z
      .record(NonEmptyStringSchema, NonEmptyStringSchema)
      .refine(
        (heads) => Object.keys(heads).length > 0,
        "reviewed names the head of every repo reviewed",
      ),
    findings: z.array(ReviewFindingSchema),
  })
  .refine((output) => (output.verdict === "CHANGES_REQUESTED") === output.findings.length > 0, {
    path: ["verdict"],
    message: "verdict is CHANGES_REQUESTED exactly when findings[] is non-empty",
    ...whenTopLevelParsed,
  })
  .refine(
    (output) =>
      new Set(output.findings.map((finding) => finding.id)).size === output.findings.length,
    { path: ["findings"], message: "each finding id appears once", ...whenTopLevelParsed },
  );

export const schemas = { "review.output.v1": ReviewOutputSchema };
