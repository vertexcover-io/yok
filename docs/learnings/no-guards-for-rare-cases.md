---
signal: Use when adding a check or branch for a case yok's own flow never produces
paths: ["packages/**/*.ts", "skills/**/scripts/**/*.ts"]
tags: [guards, simplicity]
strength: default
---
# Don't add guards for cases only a manual or made-up action can cause

Write code for the paths yok's own flow takes. A check that only matters when someone does something by hand, such as typing `yok orchestrate init NAME --run-id OTHER` inside a session, adds code and a test for a case that does not happen; leave it out. Checking outside input still stays: Slack payloads, CLI flags, files and environment variables are validated where they enter.

**Occurrences:**
- 2026-10-30 · PR #56: `init` recorded `YOK_SLACK_THREAD` only when `--run-id` matched `$YOK_RUN_ID`, guarding a hand-typed `--run-id`; removed.

**Stale when:** yok itself starts calling `yok orchestrate init` with a `--run-id` other than the session's own `$YOK_RUN_ID`.
