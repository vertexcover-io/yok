import { NonEmptyStringSchema } from "@yok/sdk";
import * as z from "zod";

// One entry of skill-audit.json, as scripts/check.py and the judgment pass write it.
const SkillFindingSchema = z.strictObject({
  id: NonEmptyStringSchema,
  category: NonEmptyStringSchema,
  finding_type: NonEmptyStringSchema,
  severity: z.enum(["blocker", "major", "minor"]),
  deterministic: z.boolean(),
  location: NonEmptyStringSchema,
  evidence: z.string(),
  fix: NonEmptyStringSchema,
});

export const SkillAuditOutputSchema = z
  .strictObject({
    clean: z.boolean(),
    report: NonEmptyStringSchema,
    findings: z.array(SkillFindingSchema),
  })
  .refine(
    (output) => output.clean === output.findings.every((finding) => finding.severity === "minor"),
    { path: ["clean"], message: "clean is true exactly when no finding is a blocker or major" },
  );

export const schemas = { "skill-audit.output.v1": SkillAuditOutputSchema };
