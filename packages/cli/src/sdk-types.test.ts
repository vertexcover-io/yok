import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildSdkTypes, SDK_TYPES_FILE } from "../../../scripts/sdk-types.ts";

describe("sdk-types.json", () => {
  test("SC103: the committed sdk-types.json equals what the SDK source builds today", () => {
    const committed: unknown = JSON.parse(readFileSync(SDK_TYPES_FILE, "utf8"));

    expect(
      committed,
      "packages/cli/src/sdk-types.json is stale: run `bun run sdk-types`",
    ).toStrictEqual(buildSdkTypes());
  });

  test("SC106, SC215: the public types hold the run, project and event repository interfaces, sessionEnv takes an IStorage, and nothing names drizzle-orm, bun:sqlite or the store", () => {
    const { files } = buildSdkTypes();
    expect(Object.keys(files)).toContain("repositories.d.ts");
    expect(Object.keys(files)).not.toContain("storage.d.ts");
    for (const name of ["IStorage", "IRunRepository", "IProjectRepository", "IEventStore"]) {
      expect(files["repositories.d.ts"]).toContain(`export interface ${name}`);
    }
    expect(files["env.d.ts"]).toContain("sessionEnv: (storage: IStorage,");
    const leaking = Object.entries(files).filter(([, text]) => /drizzle-orm|bun:sqlite/.test(text));
    expect(leaking.map(([name]) => name)).toEqual([]);
  });
});
