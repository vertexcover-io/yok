import { describe, expect, test } from "bun:test";
import { SkillAuthorOutputSchema } from "./author.ts";

describe("SkillAuthorOutputSchema", () => {
  test("an absolute path parses", () => {
    const output = { name: "pdf-tables", path: "/home/me/.agents/skills/pdf-tables" };

    expect(SkillAuthorOutputSchema.safeParse(output).success).toBe(true);
  });

  test.each([".agents/skills/pdf-tables", "~/.agents/skills/pdf-tables"])(
    "a path that is not absolute, %s, is rejected on path",
    (path) => {
      const result = SkillAuthorOutputSchema.safeParse({ name: "pdf-tables", path });

      expect(result.error?.issues.map((issue) => issue.path)).toEqual([["path"]]);
    },
  );
});
