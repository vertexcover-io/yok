import { describe, expect, test } from "bun:test";
import { ReviewRegressionTestsOutputSchema } from "./review.ts";

const finding = {
  id: "test-1",
  file: "src/add.test.ts",
  line: 12,
  summary: "R1 checks a total the test set up itself",
  trigger: "add returns the wrong total and the test still passes",
  hint: "assert on the total add returns",
};
const report = "artifacts/test-review.md";

describe("ReviewRegressionTestsOutputSchema", () => {
  test.each([
    { verdict: "APPROVED", findings: [] },
    { verdict: "CHANGES_REQUESTED", findings: [finding] },
  ])("SC8: $verdict with matching findings parses", (output) => {
    expect(ReviewRegressionTestsOutputSchema.safeParse({ ...output, report }).success).toBe(true);
  });

  test.each([
    { verdict: "APPROVED", findings: [finding] },
    { verdict: "CHANGES_REQUESTED", findings: [] },
  ])("SC8: $verdict that disagrees with its findings is rejected on verdict", (output) => {
    const result = ReviewRegressionTestsOutputSchema.safeParse({ ...output, report });

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["verdict"]]);
  });

  test.each(["plan-2", "product-3"])("SC8: a %s finding parses", (id) => {
    const output = { verdict: "CHANGES_REQUESTED", report, findings: [{ ...finding, id }] };

    expect(ReviewRegressionTestsOutputSchema.safeParse(output).success).toBe(true);
  });

  test("SC8: a finding id without its test, plan or product label is rejected", () => {
    const output = {
      verdict: "CHANGES_REQUESTED",
      report,
      findings: [{ ...finding, id: "defects-1" }],
    };

    const result = ReviewRegressionTestsOutputSchema.safeParse(output);

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["findings", 0, "id"]]);
  });

  test("SC8: the same finding id twice is rejected on findings", () => {
    const output = { verdict: "CHANGES_REQUESTED", report, findings: [finding, finding] };

    const result = ReviewRegressionTestsOutputSchema.safeParse(output);

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["findings"]]);
  });
});
