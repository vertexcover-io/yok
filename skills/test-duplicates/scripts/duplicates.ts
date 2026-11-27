import { NonEmptyStringSchema } from "@yok/sdk";
import * as z from "zod";

const TestAtSchema = z.strictObject({
  file: NonEmptyStringSchema,
  line: z.int().positive(),
  name: NonEmptyStringSchema,
});

export const DuplicatesRepoSchema = z
  .strictObject({
    repo: NonEmptyStringSchema,
    // test cases added in the audit's period
    testsAdded: z.int().nonnegative().nullable(),
    // each added test that proves what its keeper already proves
    duplicates: z.array(
      z.strictObject({ test: TestAtSchema, keeper: TestAtSchema, reason: NonEmptyStringSchema }),
    ),
    notMeasured: NonEmptyStringSchema.nullable(),
    errors: z.array(NonEmptyStringSchema),
  })
  .refine(
    (repo) => (repo.testsAdded === null) === (repo.notMeasured !== null),
    "testsAdded is null exactly when notMeasured says why",
  )
  // audit-publish divides duplicates by testsAdded, so a count past it would store a share over 100%.
  .refine(
    (repo) => repo.duplicates.length <= (repo.testsAdded ?? 0),
    "duplicates are added tests: at most testsAdded, and none when nothing was measured",
  )
  .refine(
    (repo) =>
      new Set(repo.duplicates.map(({ test }) => `${test.file}:${test.line}:${test.name}`)).size ===
      repo.duplicates.length,
    "each added test is listed as a duplicate once",
  );
export type DuplicatesRepo = z.infer<typeof DuplicatesRepoSchema>;

export const TestDuplicatesOutputSchema = z.strictObject({
  repos: z.array(DuplicatesRepoSchema).min(1),
});
export const schemas = { "test-duplicates.output.v1": TestDuplicatesOutputSchema };
