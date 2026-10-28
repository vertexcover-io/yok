# review-gap

Measures where the `code-review` skill misses what outside reviewers found on real pull requests, and proposes what the skill lacks. It collects merged PRs and their review comments, judges each finding against the code the reviewer saw, replays the personas that should have caught it on a clean checkout of that commit, and writes one ranked report.

## When it runs

As the three stages of the `review-gap` workflow: `yok run review-gap --prompt "last 30 days"`. The workflow edits nothing in the repo, so it has no create-workspace stage; it starts in the checkout whose `origin` (or whose config's `packages`) names the repos to collect.

The prompt widens the default: "last 90 days", "PRs 12, 15 and 30", "include closed". Inputs set the caps: `--input maxPrs=30`, `--input maxDiffLines=3000`, `--input replayTop=all`, `--input repos=OWNER/NAME,OWNER/OTHER`.

## What it does

1. `collect`: the `gap` script lists the PRs, fetches each one with `gh` (PR, inline comments and their replies, review bodies, issue comments, commits, diff) and writes one `bundle.json` per PR. Replies, drift-bot notes, style categories, praise and "no issues" boilerplate are dropped there, with the reason kept for the report. A PR already in the ledger, or over the diff cap, is logged and skipped.
2. `analyse`: per PR, the script makes a clean clone at the commit most findings were left on (branches `review` and `base` only; no origin, no later commits, no reflog) and an `after.patch` of what changed afterwards. An analyst sub-agent judges every finding (`real`, `false-positive`, `unclear`, `out-of-scope`) with a `file:line` proof, names the lens that exposes it, and maps it to one or two personas with the persona line that covers it. Then each mapped persona runs blind on its own copy of the clean checkout, with the real `code-review` dispatch brief and persona file. The persona's report is matched to the finding by mechanism (`caught`, `partial`, `miss`), and each miss is classed `agent-miss` or `prompt-gap` with a proposed rule.
3. `report`: the findings are grouped into clusters by mechanism, and the script writes the report (counts, per-reviewer precision, clusters ranked by worst severity times distinct PRs, each cluster's misses and proposals, the dropped items) and `findings.jsonl`, then records the judged PRs in the ledger. The stage fills the proposed skill changes.

## Inputs and outputs

- Reads: the prompt and the string inputs `repos`, `days`, `state`, `prs`, `maxPrs`, `maxDiffLines`, `replayTop`; the `gh` CLI, authenticated; the working-tree `code-review` skill.
- Produces: the `review-gap` artifact at `.yok/RUN_NAME/artifacts/review-gap.md` and the `findings` artifact at `.yok/RUN_NAME/artifacts/findings.jsonl`, one row per finding so later runs can diff. The ledger at `.yok/review-gap/ledger.jsonl` is keyed by `OWNER/NAME#NUMBER@HEAD_SHA` with the comment ids judged.

## Files

- `SKILL.md`: the three phases, the paths, and what each sub-agent receives.
- `references/analyst.md`: the analyst sub-agent's brief and the `analysis.json` shape.
- `references/replay.md`: how a persona is replayed blind, the map format, and how to match a report to a finding and diagnose a miss.
- `scripts/gap.ts`: the script. Commands: `collect`, `bundle`, `checkout`, `list`, `aggregate`.
- `scripts/gap.test.ts`, `evals/`: tests and eval fixtures.
