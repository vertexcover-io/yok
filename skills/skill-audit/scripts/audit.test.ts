import { describe, expect, test } from "bun:test";
import { SkillAuditOutputSchema } from "./audit.ts";

const finding = (severity: string) => ({
  id: "D5",
  category: "description",
  finding_type: "description_is_feature_list",
  severity,
  deterministic: false,
  location: "SKILL.md:2",
  evidence: "description: duplicate-check, scoring, ownership routing",
  fix: "Lead with a verb and state the condition that should trigger it.",
});
const report = "artifacts/skill-audit/round-1.md";

describe("SkillAuditOutputSchema", () => {
  test.each([
    { clean: true, findings: [] },
    { clean: true, findings: [finding("minor")] },
    { clean: false, findings: [finding("major")] },
    { clean: false, findings: [finding("blocker"), finding("minor")] },
  ])("clean $clean agrees with its findings and parses", (output) => {
    expect(SkillAuditOutputSchema.safeParse({ ...output, report }).success).toBe(true);
  });

  test.each([
    { clean: true, findings: [finding("major")] },
    { clean: true, findings: [finding("blocker")] },
    { clean: false, findings: [finding("minor")] },
    { clean: false, findings: [] },
  ])("clean $clean that disagrees with its findings is rejected on clean", (output) => {
    const result = SkillAuditOutputSchema.safeParse({ ...output, report });

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["clean"]]);
  });

  test("a finding with a severity outside blocker, major and minor is rejected", () => {
    const result = SkillAuditOutputSchema.safeParse({
      clean: false,
      report,
      findings: [finding("High")],
    });

    expect(result.success).toBe(false);
  });
});
