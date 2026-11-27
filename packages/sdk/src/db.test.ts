import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkSqliteVersion, MIGRATIONS, openDatabase } from "./db.ts";

describe("checkSqliteVersion", () => {
  test("SC101: 3.37.2 is refused with Update macOS. on darwin and Update yok. on linux; 3.38.0, 3.43.2 and 3.100.0 pass", () => {
    expect(checkSqliteVersion("3.37.2", "darwin")).toEqual({
      ok: false,
      error: "SQLite 3.37.2 is too old; yok needs 3.38.0 or newer. Update macOS.",
    });
    expect(checkSqliteVersion("3.37.2", "linux")).toEqual({
      ok: false,
      error: "SQLite 3.37.2 is too old; yok needs 3.38.0 or newer. Update yok.",
    });
    for (const version of ["3.38.0", "3.43.2", "3.100.0"]) {
      expect(checkSqliteVersion(version, "linux")).toEqual({ ok: true, value: undefined });
    }
  });
});

describe("migrations", () => {
  test("SC102: MIGRATIONS holds every .sql file in packages/sdk/src/migrations, in file-name order", () => {
    const folder = join(import.meta.dir, "migrations");
    const files = readdirSync(folder)
      .filter((file) => file.endsWith(".sql"))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    expect(MIGRATIONS).toEqual(files.map((file) => readFileSync(join(folder, file), "utf8")));
  });
});

describe("schema checks", () => {
  const seeded = () => {
    const db = openDatabase(":memory:");
    const at = "2026-11-19T00:00:00.000Z";
    db.run(
      "INSERT INTO users (id, name, email, created_at, updated_at) VALUES ('u_1', 'R', '', ?, ?)",
      [at, at],
    );
    db.run(
      "INSERT INTO projects (name, path, channel, created_at, updated_at) VALUES ('web', '/w', 'cli', ?, ?)",
      [at, at],
    );
    const insertRun = (id: string, inputs: string) =>
      db.run(
        "INSERT INTO runs (id, project, workflow, workflow_path, inputs, sessions, created_at, updated_at) VALUES (?, 'web', 'task', '/w/task.yaml', ?, '[]', ?, ?)",
        [id, inputs, at, at],
      );
    const insertArtifact = (name: string, path: string | null, url: string | null) =>
      db.run(
        "INSERT INTO artifacts (run_id, node_run_id, type, name, path, url, created_at) VALUES ('r-1', 'n-1', 'plan', ?, ?, ?, ?)",
        [name, path, url, at],
      );
    const insertAccount = (userId: string, providerId: string) =>
      db.run(
        "INSERT INTO user_accounts (user_id, provider, provider_id, created_at, updated_at) VALUES (?, 'slack', ?, ?, ?)",
        [userId, providerId, at, at],
      );
    return { db, insertRun, insertArtifact, insertAccount };
  };

  test("SC112: the schema refuses non-JSON inputs, an artifact with both or neither of path and url, an account for a missing user and a second owner of one account", () => {
    const { db, insertRun, insertArtifact, insertAccount } = seeded();
    expect(() => insertRun("r-bad", "not json")).toThrow("runs_inputs_json");
    insertRun("r-1", "{}");
    expect(() => insertArtifact("both", "plan.md", "https://x")).toThrow("artifacts_path_or_url");
    expect(() => insertArtifact("neither", null, null)).toThrow("artifacts_path_or_url");
    insertArtifact("file", "plan.md", null);
    expect(db.query("SELECT name FROM artifacts").all()).toEqual([{ name: "file" }]);
    expect(() => insertAccount("u_missing", "U7")).toThrow("FOREIGN KEY");
    db.run(
      "INSERT INTO users (id, name, email, created_at, updated_at) VALUES ('u_2', 'A', '', 'x', 'x')",
    );
    insertAccount("u_1", "U7");
    expect(() => insertAccount("u_2", "U7")).toThrow("UNIQUE");
    db.close();
  });
});
