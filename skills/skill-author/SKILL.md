---
name: skill-author
description: >
  Write a new agent skill from a prompt, or edit one that exists, and make it a yok stage when
  asked: plan the change, show the plan, settle where a new skill is saved, and write it so any
  agent can run it. Runs as the first stage of the skill workflow; the audit loop after it
  checks and fixes what it wrote.
summary: Say whether the skill was created or edited, its name, where it lives, and what it does in one line.
mode: inline
allowed-tools: [AskUserQuestion, Bash, Read, Write, Edit, Grep, Glob]
outputs:
  description: The skill's name and the absolute path of its folder.
  schema: skill-author.output.v1
  module: scripts/author.ts
protocols: []
scopes: []
references:
  authoring:
    path: references/authoring.md
    description: >-
      The steps for making a skill, from Anthropic's skill-creator: capture intent, write
      SKILL.md, the anatomy of a skill folder, progressive disclosure, writing patterns.
  writing-for-agents:
    path: references/writing-for-agents.md
    description: >-
      Matt Pocock's rules for every line an agent reads: context pointers, the two loads, the
      information hierarchy, completion criteria, leading words, negation, pruning.
  skill-mechanics:
    path: references/skill-mechanics.md
    description: >-
      Matt Pocock's skill-only rules: model-invoked or user-invoked, splitting by invocation,
      router skills.
  yok-stage:
    path: references/yok-stage.md
    description: >-
      The yok stage contract field by field, how to decide each field from what the skill does,
      the body a stage needs, schema and verifier modules, and the check that the contract loads.
---

# Skill author

Create one skill, or edit one that exists, from the prompt. Two sources guide it: `authoring`
gives the steps, and `writing-for-agents` with `skill-mechanics` gives the rules for each line.
When they disagree, `authoring` wins on the steps and `writing-for-agents` wins on wording and
layout.

## Input

| Field | Meaning |
|---|---|
| `skill` | the skill to edit: its folder, or its name. Empty means create, unless the prompt names a skill that exists. |
| `yok` | true makes the skill a yok stage. A skill that already is one stays one. |
| `prompt` | what the skill should do, or what to change in it |
| `path` | for a new skill, the folder its own folder is made in. When set, `scope` and `folder` are ignored. |
| `scope` | for a new skill, `project` (this repo) or `user` (the home folder); empty means ask |
| `folder` | for a new skill, `.agents` or `.claude`; empty means ask |

## 1. Read the references

Read all three in full: `yok orchestrate skill ref skill-author.authoring`, then
`skill-author.writing-for-agents`, then `skill-author.skill-mechanics`. Read
`skill-author.yok-stage` too once step 2 decides the skill is a stage.

## 2. Create or edit

The skill folders are, in order: `REPO_ROOT/.agents/skills`, `REPO_ROOT/.claude/skills`,
`$HOME/.agents/skills`, `$HOME/.claude/skills`, and `path` when set. REPO_ROOT is
`git rev-parse --show-toplevel`.

- **`skill` is a folder:** edit it. It must hold a `SKILL.md`; when it does not, fail the stage
  with an error naming the folder.
- **`skill` is a name:** look for `NAME/SKILL.md` in each skill folder. Two hits that resolve to
  the same real path (`realpath`) are one skill. One skill found: edit it. None: fail the stage
  naming every folder you looked in. More than one: the user picks in step 4.
- **`skill` is empty:** when the prompt asks to change a skill by name or folder and that skill
  is found the same way, edit it. Otherwise create a new one.

The skill is a **stage** when `yok` is true, when the prompt asks for a yok stage (or to
convert the skill to one), or when the skill being edited already is one: its frontmatter has a
`mode:` line. Turning a plain skill into a stage is an edit like any other: the steps below run
the same, with the contract added.

Never edit a skill under a plugin cache (a path holding `/plugins/cache/`): the next plugin
update replaces it. Fail the stage and name the folder the plugin's source lives in, if you can
tell.

## 3. Plan the change

`authoring` starts with an interview. Here the prompt is the interview: answer its questions
from the prompt, and write each guess you make as an assumption in the plan.

To edit, first read the whole skill: `SKILL.md`, every reference, script and eval. The plan
changes only what the prompt asks for, plus what that change breaks elsewhere in the skill.
Everything else stays as it is.

```
Mode: create, or edit SKILL_DIR
Skill: NAME
Triggers when: the branches that should fire it, one per line
Invocation: model-invoked or user-invoked, and why
Stage: no; or yes, with each contract field yok-stage's questions earned and why:
  mode, outputs, produces, consumes, verifiers, variables
Steps:
  1. ...
Files:
  SKILL.md           for an edit, mark each file new, changed or unchanged
  references/...     only what some branches need
  scripts/...        only work a script does the same way every run
  evals/evals.json   at least three evals
Assumptions: ...
Saves to: PATH, or "asked below"
```

For a new skill, NAME is lowercase letters, digits and hyphens, at most 64 characters, and names
the activity. An edit keeps the skill's name unless the prompt asks to rename it; a stage's
name must equal its folder name. A stage's plan answers every question in yok-stage's
"Deciding the fields" section. The plan is
done when every file has a reason to exist and every step ends on a check the agent can tell is
done.

## 4. Show the plan and settle what is open

The open parts are: which skill, when step 2 found more than one; and, for a new skill with no
`path`, `scope` and `folder` when empty.

- **Nothing open:** print the plan and go on to step 5 without waiting.
- **Something open:** ask the user once, in one question block, using your agent's question
  tool as the orchestrate skill's agent reference names it. Ask the plan and only the open
  parts:
  - **Plan:** "Looks good" or "Change it" (they say what to change).
  - **Skill:** each folder step 2 found.
  - **Scope:** `project`, saved in this repo; or `user`, saved in the home folder for every
    project.
  - **Folder:** `.agents`, read by Codex and other agents; or `.claude`, read by Claude Code.

On "Change it", redo the plan once with the change, print it, and go on without asking again.
When no one can answer (the run's `interaction` policy is false): with more than one skill
found, fail the stage naming them; for a new skill, use `project` and `.agents` and say so in
the summary.

## 5. Work out SKILL_DIR

- **Edit:** SKILL_DIR is the skill's folder from step 2 or 4.
- **Create with `path`:** expand a leading `~`, and resolve a relative path against REPO_ROOT.
  SKILL_DIR is `PATH/NAME`.
- **Create with `scope: project`:** SKILL_DIR is `REPO_ROOT/FOLDER/skills/NAME`.
- **Create with `scope: user`:** SKILL_DIR is `$HOME/FOLDER/skills/NAME`.

When creating and `SKILL_DIR/SKILL.md` already exists, stop and fail the stage with an error
naming SKILL_DIR, so a new skill never writes over one that is there.

## 6. Write the skill

Write every new or changed file in the plan into SKILL_DIR, applying `writing-for-agents` to each
line and `skill-mechanics` to the frontmatter. In an edit, change files in place and leave the
unchanged ones alone.

For a stage, write the contract and the body yok-stage describes, and each schema and verifier
module with its test. A conversion keeps every instruction that still holds and adds the
`## Input` table, the artifact paths and the exact reply around them.

Write it for any agent. Name an action by what it does ("ask the user", "run the script"), not
by one agent's tool name. Find a bundled file by its path relative to `SKILL.md`, not by a
variable or folder only one agent has. Name one agent's tool or path only when the prompt asks
for a skill for that agent.

`evals/evals.json` holds at least three evals, one for each promise the skill makes that a run
could break. An edit adds an eval for each promise it adds and updates the ones it changes. The
shape:

```json
{
  "skill_name": "NAME",
  "evals": [
    {
      "id": 1,
      "name": "short-descriptive-name",
      "prompt": "what a real user would type",
      "expected_output": "what a good run produces",
      "files": [],
      "expectations": ["a check anyone can verify from the output"],
      "anti_expectations": ["what a bad run does"]
    }
  ]
}
```

Write the evals only. Running them needs one agent's command line, so this workflow leaves
that to the author. Every bundled script gets a test beside it.

The step is done when each file the plan marks new or changed is written, and `SKILL.md` names
every reference and script it relies on.

## 7. Check a stage's contract

For a stage, run the check in yok-stage's "Check the contract" section on SKILL_DIR, and run
each test you wrote under `scripts/`. Fix what they name and run them again. The step is done
when the check prints `ok` and every test passes.

## 8. Reply

Reply `{ "name": "NAME", "path": "SKILL_DIR" }`, with SKILL_DIR absolute.
