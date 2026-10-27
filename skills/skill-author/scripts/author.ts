import { isAbsolute } from "node:path";
import { NonEmptyStringSchema } from "@yok/sdk";
import * as z from "zod";

export const SkillAuthorOutputSchema = z.strictObject({
  name: NonEmptyStringSchema,
  // the review loop reads the skill from here, whatever folder the run started in
  path: NonEmptyStringSchema.refine(isAbsolute, "Expected an absolute path"),
});

export const schemas = { "skill-author.output.v1": SkillAuthorOutputSchema };
