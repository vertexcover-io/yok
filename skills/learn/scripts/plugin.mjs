// The plugin this skill ships in, read from its manifest. Its name is where events go (`.<name>/`).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".claude-plugin",
  "plugin.json",
);

export const readPlugin = (manifestPath = MANIFEST) => {
  try {
    const { name, version } = JSON.parse(readFileSync(manifestPath, "utf8"));
    return { name, version };
  } catch {
    return { name: "plugin", version: "" };
  }
};

export const PLUGIN = readPlugin();
