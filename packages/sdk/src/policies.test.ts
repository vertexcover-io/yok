import { describe, expect, test } from "bun:test";
import {
  type PolicyLayers,
  parsePolicyFlags,
  resolvePolicies,
  type SavedPolicies,
} from "./policies.ts";

describe("resolvePolicies", () => {
  test.each<[string, PolicyLayers, SavedPolicies]>([
    [
      "nothing set gives the default",
      {},
      { values: { interaction: true }, sources: { interaction: "default" } },
    ],
    [
      "the config's value wins over the default",
      { config: { interaction: false } },
      { values: { interaction: false }, sources: { interaction: "config" } },
    ],
    [
      "the workflow's value wins over the config's",
      { config: { interaction: false }, workflow: { interaction: true } },
      { values: { interaction: true }, sources: { interaction: "workflow" } },
    ],
    [
      "the CLI's value wins over the workflow's",
      {
        config: { interaction: false },
        workflow: { interaction: true },
        cli: { interaction: false },
      },
      { values: { interaction: false }, sources: { interaction: "cli" } },
    ],
  ])("SC501: %s", (_title, layers, expected) => {
    expect(resolvePolicies(layers)).toEqual(expected);
  });

  test("SC502: an empty workflow layer over the config's false keeps false from the config, not the default", () => {
    expect(resolvePolicies({ config: { interaction: false }, workflow: {} })).toEqual({
      values: { interaction: false },
      sources: { interaction: "config" },
    });
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
