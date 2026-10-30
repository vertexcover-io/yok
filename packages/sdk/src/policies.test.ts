import { describe, expect, test } from "bun:test";
import {
  type PolicyLayers,
  parsePolicyFlags,
  readPolicies,
  resolvePolicies,
  type SavedPolicies,
  SavedPoliciesSchema,
} from "./policies.ts";

describe("resolvePolicies", () => {
  test.each<[string, PolicyLayers, SavedPolicies]>([
    [
      "nothing set gives the default",
      {},
      {
        values: { interaction: true, learning: true },
        sources: { interaction: "default", learning: "default" },
      },
    ],
    [
      "the config's value wins over the default",
      { config: { interaction: false } },
      {
        values: { interaction: false, learning: true },
        sources: { interaction: "config", learning: "default" },
      },
    ],
    [
      "the workflow's value wins over the config's",
      { config: { interaction: false }, workflow: { interaction: true } },
      {
        values: { interaction: true, learning: true },
        sources: { interaction: "workflow", learning: "default" },
      },
    ],
    [
      "the CLI's value wins over the workflow's",
      {
        config: { interaction: false },
        workflow: { interaction: true },
        cli: { interaction: false },
      },
      {
        values: { interaction: false, learning: true },
        sources: { interaction: "cli", learning: "default" },
      },
    ],
  ])("SC501: %s", (_title, layers, expected) => {
    expect(resolvePolicies(layers)).toEqual(expected);
  });

  test("SC502: an empty workflow layer over the config's false keeps false from the config, not the default", () => {
    expect(resolvePolicies({ config: { interaction: false }, workflow: {} })).toEqual({
      values: { interaction: false, learning: true },
      sources: { interaction: "config", learning: "default" },
    });
  });

  test("SC1: a run with no policy set keeps learning on", () => {
    const { values, sources } = resolvePolicies({});
    expect(values.learning).toBe(true);
    expect(sources.learning).toBe("default");
  });

  test("SC2: --learning false turns learning off for the run", () => {
    const flags = parsePolicyFlags({ learning: "false" });
    if (!flags.ok) throw new Error(flags.error);
    const { values, sources } = resolvePolicies({ cli: flags.value });
    expect(values.learning).toBe(false);
    expect(sources.learning).toBe("cli");
  });
});

describe("readPolicies", () => {
  test("SC3: a run saved before the learning policy existed reads learning as on", () => {
    const saved = SavedPoliciesSchema.parse({
      values: { interaction: false },
      sources: { interaction: "cli" },
    });
    expect(readPolicies(saved)).toEqual({ interaction: false, learning: true });
  });
});

describe("parsePolicyFlags", () => {
  test.each([
    ["the text false is the boolean false", { interaction: "false" }, { interaction: false }],
    ["no flag sets nothing", {}, {}],
  ])("SC503: %s", (_title, flags, expected) => {
    expect(parsePolicyFlags(flags)).toEqual({ ok: true, value: expected });
  });

  test("SC503: --interaction maybe is refused with the flag, its text and the allowed values", () => {
    const parsed = parsePolicyFlags({ interaction: "maybe" });
    if (parsed.ok) throw new Error("expected --interaction maybe to be refused");
    expect(parsed.error).toContain("--interaction maybe");
    expect(parsed.error).toContain("must be true or false");
  });
});
