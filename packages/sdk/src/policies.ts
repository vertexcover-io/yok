import { parse } from "yaml";
import * as z from "zod";
import type { Result } from "./contracts.ts";

// Every run policy: the values it takes, its default and its help text. A new policy is one line
// here; the config, workflows, `yok run --NAME VALUE` and every step reply pick it up.
export const PoliciesSchema = z.strictObject({
  interaction: z
    .boolean({ error: "must be true or false" })
    .default(true)
    .describe(
      "false: no stage asks the person anything; a question with no sensible default fails the run",
    ),
  learning: z
    .boolean({ error: "must be true or false" })
    .default(true)
    .describe(
      "false: the learn stage does nothing and no learning session is offered after the PR",
    ),
});
export type Policies = z.output<typeof PoliciesSchema>;
export type PolicyName = keyof Policies;
export const POLICY_NAMES = PoliciesSchema.keyof().options;

type PolicyShape = typeof PoliciesSchema.shape;

// What one place sets: only the policies it names, each checked, no defaults filled in. partial()
// would fill them, and an empty block would then override a lower layer's value.
export const PolicyLayerSchema = z.strictObject(
  Object.fromEntries(
    POLICY_NAMES.map((name) => [name, PoliciesSchema.shape[name].unwrap().optional()]),
  ) as { [K in PolicyName]: z.ZodOptional<ReturnType<PolicyShape[K]["unwrap"]>> },
);
export type PolicyLayer = z.output<typeof PolicyLayerSchema>;

export const PolicySourceSchema = z.enum(["default", "config", "workflow", "cli"]);

// What the server saves on the run: each value, and where it came from. A policy added after the
// run was saved has no source and reads as its default.
export const SavedPoliciesSchema = z.strictObject({
  values: PoliciesSchema,
  sources: z.partialRecord(PoliciesSchema.keyof(), PolicySourceSchema),
});
export type SavedPolicies = z.output<typeof SavedPoliciesSchema>;

export type PolicyLayers = Readonly<{
  config?: PolicyLayer;
  workflow?: PolicyLayer;
  cli?: PolicyLayer;
}>;

const LAYER_ORDER = ["config", "workflow", "cli"] as const;

// Merged once when the run starts: the CLI wins over the workflow, the workflow over the config,
// and the config over the default.
export const resolvePolicies = (layers: PolicyLayers): SavedPolicies => ({
  values: PoliciesSchema.parse({ ...layers.config, ...layers.workflow, ...layers.cli }),
  sources: Object.fromEntries(
    POLICY_NAMES.map((name) => [
      name,
      LAYER_ORDER.findLast((source) => layers[source]?.[name] !== undefined) ?? "default",
    ]),
  ),
});

// A run saved before policies existed has none, and follows the defaults. Only the values are read,
// so a run the server's client hands back, whose JSON type loosens sources, passes as it is.
export const readPolicies = (saved: Pick<SavedPolicies, "values"> | undefined): Policies =>
  saved?.values ?? PoliciesSchema.parse({});

const readYaml = (text: string): unknown => {
  try {
    return parse(text);
  } catch {
    return text;
  }
};

// `yok run --NAME TEXT`: the text is read as YAML, so `--interaction false` passes the same check
// as `interaction: false` in a file.
export const parsePolicyFlags = (flags: Readonly<Record<string, unknown>>): Result<PolicyLayer> => {
  const given = POLICY_NAMES.flatMap((name) => {
    const text = flags[name];
    return typeof text === "string" ? [[name, text] as const] : [];
  });
  const parsed = PolicyLayerSchema.safeParse(
    Object.fromEntries(given.map(([name, text]) => [name, readYaml(text)])),
  );
  if (parsed.success) return { ok: true, value: parsed.data };
  const errors = parsed.error.issues.map((issue) => {
    const name = String(issue.path[0]);
    return `--${name} ${String(flags[name])}: ${issue.message}`;
  });
  return { ok: false, error: errors.join("\n") };
};
