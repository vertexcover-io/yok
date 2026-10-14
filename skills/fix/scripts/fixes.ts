import {
  type Finding,
  NonEmptyStringSchema,
  parseJson,
  type Result,
  readText,
  type VerifierInput,
  type VerifierResult,
} from "@yok/sdk";
import * as z from "zod";

// What the fix stage did with one fix request, written to artifacts/fixes/SOURCE-ROUND.json.
const fixResultBase = { id: NonEmptyStringSchema, decision: NonEmptyStringSchema.optional() };
const FixResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...fixResultBase,
    status: z.literal("closed"),
    commit: NonEmptyStringSchema,
  }),
  z.strictObject({ ...fixResultBase, status: z.literal("left"), reason: NonEmptyStringSchema }),
]);

const FixResultsSchema = z
  .array(FixResultSchema)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
    message: "each id appears once",
  });

type FixResult = z.infer<typeof FixResultSchema>;

const readResults = async (path: string): Promise<Result<readonly FixResult[], Finding[]>> => {
  const text = await readText(path);
  if (!text.ok) return { ok: false, error: [{ message: text.error, path }] };
  const json = parseJson(text.value);
  if (!json.ok) return { ok: false, error: [{ message: json.error, path }] };
  const parsed = FixResultsSchema.safeParse(json.value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const error = parsed.error.issues.map((issue) => ({
    message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    path,
  }));
  return { ok: false, error };
};

const findingsIn = async (path: string): Promise<readonly Finding[]> => {
  const results = await readResults(path);
  return results.ok ? [] : results.error;
};

// A node handed source and round owes a result file; one without them reports in its reply.
// fixes may also be a path to a list, which this check does not open.
const LoopRoundSchema = z.looseObject({
  source: NonEmptyStringSchema,
  round: z.number(),
  fixes: z
    .array(z.looseObject({ id: NonEmptyStringSchema, askUser: z.boolean().optional() }))
    .optional()
    .catch(undefined),
});
type Requested = NonNullable<z.infer<typeof LoopRoundSchema>["fixes"]>;

// The round's file answers each requested item once, in order, with the user's answer where asked.
const roundFindings = async (path: string, requested: Requested): Promise<readonly Finding[]> => {
  const results = await readResults(path);
  if (!results.ok) return results.error;
  const want = requested.map((item) => item.id);
  const got = results.value.map((item) => item.id);
  const inOrder = want.length === got.length && want.every((id, index) => id === got[index]);
  const order = inOrder
    ? []
    : [
        {
          message: `expected one entry per requested item, in order: ${want.join(", ")}; got ${got.join(", ") || "none"}`,
          path,
        },
      ];
  const unasked = requested
    .filter((item) => item.askUser)
    .filter((item) => results.value.some((result) => result.id === item.id && !result.decision))
    .map((item) => ({
      message: `${item.id} has askUser: ask the user and record the answer as its decision`,
      path,
    }));
  return [...order, ...unasked];
};

// The fix stage's verifier: every fix-result artifact the stage names must hold a valid result list.
export const checkFixResults = async (input: VerifierInput): Promise<VerifierResult> => {
  const paths = input.artifacts.flatMap((artifact) =>
    artifact.type === "fix-result" && "path" in artifact ? [artifact.path] : [],
  );
  const round = LoopRoundSchema.safeParse(input.nodeInput);
  const file = round.success && `artifacts/fixes/${round.data.source}-${round.data.round}.json`;
  if (file && !paths.some((path) => path.endsWith(`/${file}`))) {
    const message = `this round's fix-result artifact is ${file}: write it and pass it with --artifact`;
    return { pass: false, findings: [{ message }] };
  }
  const requested = round.success ? round.data.fixes : undefined;
  const check = (path: string) =>
    file && requested && path.endsWith(`/${file}`)
      ? roundFindings(path, requested)
      : findingsIn(path);
  const findings = (await Promise.all(paths.map(check))).flat();
  return { pass: findings.length === 0, findings };
};
