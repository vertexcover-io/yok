#!/usr/bin/env bash
# Builds the two-layer repo evals 5 and 6 run in: make-two-layer-repo.sh TARGET_DIR
# A Vitest unit layer, a Playwright e2e layer whose config retries failures, an e2e runner script,
# and a CI workflow that runs only the unit layer.
set -euo pipefail

dir="$1"
mkdir -p "$dir/src" "$dir/e2e" "$dir/.github/workflows"
cd "$dir"
git init -q -b main

cat > package.json <<'EOF'
{
  "name": "two-layer-repo",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "e2e": "node e2e/run.mjs"
  },
  "devDependencies": {
    "@playwright/test": "^1.48.0",
    "http-server": "^14.1.1",
    "vitest": "^2.1.0"
  }
}
EOF

cat > vitest.config.ts <<'EOF'
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
EOF

cat > src/sum.ts <<'EOF'
export const sum = (a: number, b: number): number => a + b;
EOF

cat > src/sum.test.ts <<'EOF'
import { expect, test } from "vitest";
import { sum } from "./sum";

test("adds two numbers", () => {
  expect(sum(2, 3)).toBe(5);
});
EOF

cat > e2e/page.html <<'EOF'
<!doctype html>
<title>sum</title>
<output id="total">5</output>
EOF

cat > e2e/sum.spec.ts <<'EOF'
import { expect, test } from "@playwright/test";

test("the page shows the total", async ({ page }) => {
  await page.goto("/page.html");
  await expect(page.locator("#total")).toHaveText("5");
});
EOF

cat > e2e/playwright.config.ts <<'EOF'
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  retries: 2,
  use: { baseURL: "http://localhost:4173" },
  webServer: { command: "npx http-server . -p 4173 -s", url: "http://localhost:4173/page.html" },
});
EOF

cat > e2e/run.mjs <<'EOF'
import { spawnSync } from "node:child_process";

const args = ["playwright", "test", "-c", "e2e/playwright.config.ts", ...process.argv.slice(2)];
process.exit(spawnSync("npx", args, { stdio: "inherit" }).status ?? 1);
EOF

cat > .github/workflows/ci.yml <<'EOF'
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install
      - run: npm test
EOF

git add -A
git -c user.email=eval@example.com -c user.name=eval commit -q -m "two layers"
