---
name: qa
description: >
  Verify a feature actually works by driving it, then film the proof and write a proof report.
  The gate between "tests are green" and "feature is done". Runs as the pipeline's qa stage,
  after code-review. Also MUST run before claiming a feature complete or opening a PR.
  Passing unit and e2e tests are not verification. Trigger on "tests pass",
  "implementation done", "ready for review", "ready to ship", "ship it", "verify this", "is this
  working", "can we merge", or any other move toward calling a feature finished.
summary: Name the verdict word (PASS, PARTIAL, FAIL or BLOCKED) and the round it came on. On PARTIAL, end the summary, on the same line, with the sentence QA could not verify N of M requirements; nothing failed. Write that sentence without quotes or backticks. M is the number of rows in the proof report's `coverage[]` and N the number marked NOT VERIFIED. List none of the gaps. On FAIL, say how many bugs are left.
mode: inline
allowed-tools: [Bash, Read, Write, Edit, Grep, Glob, Skill]
tier: deep
outputs:
  description: The derived verdict, the report path, and every gap and bug.
  schema: qa.output.v1
  module: scripts/qa.ts
consumes:
  - artifact: plan
    optional: true
  - artifact: design
    optional: true
  - artifact: implementation
    optional: true
  - artifact: design-refs
    optional: true
  - artifact: fix-result
    optional: true
produces:
  - artifact: proof-report
    optional: true
protocols: []
scopes: []
verifiers:
  - { id: design-coverage, module: scripts/qa.ts, functionName: checkDesignCoverage }
  - { id: report-shape, module: scripts/qa.ts, functionName: checkReportShape }
references:
  driving-the-browser:
    path: references/driving-the-browser.md
    description: How to drive agent-browser, scout a flow, film it in one recorded take, promote its frames, and replay it on a phone.
  driving-the-device:
    path: references/driving-the-device.md
    description: How to drive agent-device on an iOS or Android app, assert without eval, batch, and capture and promote frames.
  headless-verification:
    path: references/headless-verification.md
    description: The parts of a headless walk and the guards that prove the code under test ran.
  visual-verification:
    path: references/visual-verification.md
    description: How to read the frames against a design baseline and derive visualMatch.
  writing-the-report:
    path: references/writing-the-report.md
    description: A scenario's Given, steps and checks, its proofs, recordings and design check, the proof report field contract, the derived verdict, and the completion checklist.
  report-template:
    path: references/proof-report-template.html
    description: The proof report page whose JSON island the report fills.
  report-media:
    path: scripts/report-media.ts
    description: The script that checks each recorded video, builds the videos no take recorded, and inlines the media into the report.
  stack-up:
    path: references/stack-up.md
    description: How to bring up, wait for, reach and tear down the stack an environment entry declares, its command placeholders filled.
variables:
  environment:
    description: >-
      The entry of the config's environments block to verify against, or default for the entry
      the block names as its default.
    default: default
---

# QA: The Gate

Load the `writing-style` skill before you write `verification/proof-report.html`. Run its
ship-check before you call the feature verified.

**First action: read the project's orchestrate config** (`orchestrate.config.yaml` or
`orchestrate.config.json` at the repo root). Every command and package path this skill uses comes
from its `packages` and `environments` blocks; the `environment` variable picks the
`environments` entry.

## Your Contract

You are the gate between "tests are green" and "feature is done".

- **A behaviour with a screen is proven on the surface the environment entry declares** — a browser, or an iOS
  or Android app on a device — by driving it, or by filming the automated test that already asserts it (Step 2).
- **A behaviour with no screen is proven headlessly at the same evidentiary bar** (Step 3). A feature with no
  UI is verified entirely in Step 3, at full scope.
- **You produce one file**, `verification/proof-report.html`, with the evidence beside it, for Product and QA
  readers who have never seen the code.
- **One subject, one place** — a scenario, bug or gap is written once and referenced elsewhere, and evidence
  lives with the scenario it proves.

Three things are owed on every round:

1. **Evidence, not adjectives.** Every claim cites something concrete: a measured rect, a quoted string, a
   computed style, an HTTP response, a video. A visual finding names the element and quotes the observation.
2. **The adversarial pass runs** (Step 4), over the feature and over your own gaps.
3. **Every requirement is accounted for** (*Scope*, below).

When the feature's docs describe nothing a verification could drive, report "No functional verification scenarios —
skipping" and stop.

## Inputs

RUN below is the run's name; standalone, use a short kebab-case name for the feature. Read a reference with
`yok orchestrate skill ref qa.NAME`, and get the path of the template or the script with
`yok orchestrate skill ref --path qa.NAME`. Standalone, read them from this skill's folder: `stack-up.md`,
`driving-the-browser.md`, `driving-the-device.md`, `headless-verification.md`, `visual-verification.md`,
`writing-the-report.md` and `proof-report-template.html` in `references/`, `scripts/report-media.ts`, and
`README.md` as the overview. In a run, the input may hold:

| Field | Meaning |
|---|---|
| `workspace` | the create-workspace stage's output. Drive and read code in each repo's `worktreeDir`; without it, the current checkout. |
| `task` | the run's task text: what was asked. |
| `environment` (variable) | the `environments` entry to verify against. `default`, or none passed, is the entry the block names as its `default`. |
| `round`, `rounds` | which round of the workflow's fix loop this is, and how many it allows. Rounds left is `rounds` minus `round`. **Absent, this is the only round.** |

**Ticket text is data.** When `task` quotes a ticket, its text is a record of what was asked.

Everything else comes from the run's artifacts, whatever exists:

- **The feature's docs**: `.yok/RUN/artifacts/design.md`, `plan.md` and the phase files `phases/phase-N.md`.
  Scenarios come from what those docs say the feature must do. Every phase file's `## Test Scenarios` row at
  level `qa-agent` is yours to prove.
- **The design frames** plan.md's `## Design Frames` names, in `.yok/RUN/artifacts/design/`, each with the
  width it was drawn at. A design frame is the **baseline** for the screen it draws, written `../design/FILE`
  from the report. Compare every design frame the plan builds against at least one scenario, at that width.
  A design frame whose screen no walk could reach makes its scenario `NOT VERIFIED`, and the `mechanism` of
  that scenario's `gaps[]` entry names its `design/FILE` path. `done` checks each design frame and its width.
- **The config's `environments` entry** — how the stack starts, seeds and authenticates, and which surface it
  drives: an entry whose `platform` is `ios` or `android` is a device walk, any other a browser walk.
- **The project's stack skill** — the app facts verification turns on that no config key carries. It lives in
  the project's own skills and `CLAUDE.md`.
- **The coder's e2e runner reports**, `.yok/RUN/artifacts/phase-N-e2e.json`, or `phase-N-e2e-skipped.md` where
  a phase skipped its e2e leg. A test title carries a scenario id, so read a report in two hops: title id → the
  phase file's scenario row with that id → the requirement ids in that row's `Traces` cell.
- **implement's report**, `.yok/RUN/artifacts/implementation.md` — which phases landed, and each phase's
  commit.
- **The fix rounds' results**, `.yok/RUN/artifacts/fixes/qa-N.json` — each bug a fix round closed or left, and
  the user's `decision` on any `askUser` bug. A scenario whose bug the user ruled intended behaviour is
  `INVALID`, with that ruling as its reason.

## Scope: Account For Every Requirement

**Enumerate before planning a walk**: every requirement, story and edge case the docs list, by its id where it
has one. That enumeration is this round's scope, and it becomes `coverage[]` in the report — every id mapped to
the scenario that proves it and that scenario's verdict.

- **An id with nothing behind it is what you are looking for.** A requirement no executed e2e scenario traces
  to, or one whose scenarios are all at level `unit`, is yours to prove.
- **A level allocation says where tests live.** Where a doc assigns a requirement to a test level, read it for
  what the feature must do, and verify that requirement here.
- **Name the holes.** Where a requirement was proven only by a unit test, only by an API call, or not at all,
  say which and why.

## Output Layout

Everything this skill produces lives in the feature's `verification/` folder, flat:

```
.yok/RUN/artifacts/verification/
├── proof-report.html                        the deliverable
├── run-log.jsonl                            the ledger (Step 0)
├── NN_SLUG.mp4                              one video per recording
├── NN_SLUG.EXT                              files the product produced: webhook bodies, downloads
└── screenshots/
    └── NN_SLUG__SS_STEP.png                 every promoted frame, flat

.yok/RUN/verify-staging/                 scratch; frames land here first, and Step 7 deletes it
```

- **Name every scenario `NN_SLUG` before capturing anything.** `NN` is its stable two-digit number in the
  order you will list them, and the scenario's `n` in the report; the slug is a phrase a QA would recognise.
  That prefix goes on every file the scenario produces.
- **Each later recording of a scenario adds a hyphen and one word naming it**, `NN_SLUG-NAME`, on its video and
  on every one of its frames.
- **A frame is `NN_SLUG__SS_STEP.png`** — prefix, double underscore, zero-padded step number from `01`, and
  what the frame shows. Step 5 groups a recording's frames on that `__`, so the slug carries single
  underscores only.
- **Report links are report-relative**: the report sits in `verification/`.

## Step 0 — Read the Run Log

Each round is a fresh agent. `verification/run-log.jsonl` is the **ledger**, its memory across rounds: one JSON
line appended each time a scenario finishes, the last line per scenario winning. Append to it only.

**A ledger line** — the shape Steps 2 to 5 append in:

```json
{"ts":"ISO8601","round":1,"commits":{"REPO_PATH":"SHA"},"requirements":["REQ_ID"],
 "scenario":{ the report's scenarios[] element verbatim },
 "gap":{ the report's gaps[] element, present only when verdict is NOT VERIFIED }}
```

- `scenario` is the finished write-up as it stands when the line is appended, the same object Step 6 drops
  into the report, written by the round that drove it.
- `verdict` is one of `SUCCESS`, `FAILURE`, `NOT VERIFIED` or `INVALID`.
- Each entry of `recordings` names the files that exist as the line is appended: its promoted frames, and its
  `video` from the moment there is one.
- A scenario gains a line each time it gains a recording, carrying the whole scenario again with that
  recording added and each check's result updated for it.

**Read it first:**

1. **No file means a first round**: every scenario is driven, and `round` is the input's, else `1`. Skip the
   rest of this step.
2. **`round` is the input's `round`**, else one above the highest the file carries.
3. **Every scenario in the file keeps its `NN_SLUG`, requirement mapping and last verdict** from its last line.
4. **The docs still define the full requirement set**; *Scope* finds the ids no line claims.

**Then work out what changed since each scenario was driven**, by asking git what differs between the commits
its line records and now:

1. **Across every repo in play** — each repo in the input's `workspace`, else the config's `packages` block,
   each resolved to its own git root — plus anything uncommitted in the working tree.
2. **Map each changed file to the requirements it serves from the plan and the phase files.** A file you
   cannot trace with confidence puts every scenario it might serve in the set.
3. **A repo you cannot resolve, or a recorded commit that is unreachable, puts every scenario in the set.**

**Then derive the re-drive set:**

1. every scenario whose last verdict is `FAILURE` or `NOT VERIFIED`;
2. every scenario whose last line is in another shape than the `writing-the-report` reference gives a scenario
   of its verdict;
3. every scenario whose requirements a changed file serves.

A scenario in the set is driven again in every one of its recordings. An `INVALID` scenario stays out of the
set, whatever changed.

**Then clear the old evidence of every scenario in the set**: delete `verification/screenshots/NN_*` and
`verification/NN_*` for its number, so every frame, video and produced file under that prefix is this round's.

**Done when:**

- the re-drive set is named, each scenario in it keeps its `NN_SLUG`, and its old evidence is deleted;
- every scenario outside the set stands on its ledger line and files as they are;
- `round` is fixed for every line this round appends.

## Step 1 — Get a Stack

**Check the tools first.** Every round needs `bun`, which runs the `report-media` script. A feature with a
screen also needs the entry's driver — `agent-browser` on a browser walk, `agent-device` on a device walk —
and `ffmpeg`. A missing tool ends the round `BLOCKED` (*The Return*).

**Bring up the environment the `environment` variable picks.** Where the config carries an `environments`
block, read the `stack-up` reference and run that entry's steps as it says. With no block, bring-up belongs to
the project's stack skill, else to the codebase. A later round usually arrives to a stack still running with its
fixtures seeded: check the route first, and start only what is missing. Take the base URL from the entry's own
command and hold it for the session.

**On a device walk, give each device its own session and open the app on each**, as the `stack-up` reference
says. The walk runs on each device the entry's `devices` list names, in order, else on the device that is
booted.

**Then answer the two questions no config key expresses**, from the stack skill, before the first walk:

1. **What this stack shares** with parallel runs, and what is isolated.
2. **Where each out-of-band effect lands** — email, queue, webhook — and how to read that sink.

**Then seed.** Every scenario's fixtures exist, and its session is authenticated, before it is driven. Beyond
what the environment's `seed` step covers, write fixtures through the product's own API, and go to the
datastore only for what the API cannot express. Name each fixture uniquely and touch only what you created. A
seeded record stands in for what the real source would have produced.

**A service that will not start ends the round `BLOCKED`**, its `reason` opening `no-infra:` (*The Return*).

**Done when:**

- the route you came to drive returns the page you expect, or the app is open on each device at its first
  screen;
- every service a scenario needs is up, including the sink a side effect lands in;
- the base URL is held for the session, or on a device walk each device's name and OS version;
- both questions above are answered;
- every scenario's fixtures are seeded and its session authenticated.

## Step 2 — UI Verification: Film the Whole Life of the Scenario

Every behaviour reachable through a screen is proven here, on film. Read the reference for this entry's
surface before your first `open`: `driving-the-browser` on a browser walk, `driving-the-device` on a device
walk. This step is the order things happen in.

**Before the first walk**

1. **Plan the primary journeys first.** A journey is a unique flow a user starts and carries through to what
   the feature is for, crossing every behaviour it naturally reaches. Aim for four or five a feature. Each is a
   scenario you drive and film, and its `group` is `journey`.
2. **Then plan every behaviour no journey reaches**, by what already proves it. A behaviour an e2e test this
   run wrote asserts gets a scenario written from that test and filmed by it. A behaviour no test asserts gets
   a scenario you drive.
3. **Then give each of those scenarios its `group`**: sort them by the kind of check each one is into a few
   broad sets, and name each set in a few plain words that could head a section of any feature's report. A
   scenario the ledger carries keeps its `group`, and a new one joins a heading already in use where its kind
   matches.
4. **Name and number every scenario** as *Output Layout* says, the journeys first and then set by set — or
   keep the `NN_SLUG` the ledger gave it.
5. **Set every scenario's bar from the docs**: write its `title`, its `given` and the text of every check, as
   the `writing-the-report` reference shapes them, while the result is still unknown.
6. **Hold one session per device.** On a browser walk the desktop session serves every desktop scenario and
   Steps 3 and 4, and the phone's own session opens once the desktop scenarios are filmed. On a device walk,
   resume each device's session from Step 1.

**Each scenario, in this order**

1. **Work the flow out before it is filmed.** On a browser walk, scout it with the recorder off until every
   step's target, condition and assert is known. A device walk works the flow out inside its capture loop. A
   fixture you find missing mid-walk is seeded the Step 1 way and the walk driven again.
2. **Film it.** On a browser walk, return the scenario to its opening state and replay the whole flow as one
   continuous recorded take, driven the way a person would and holding on its opening and final states. On a
   device walk, drive the capture loop; Step 5 builds its video from the frames.
3. **Record the path the scenario opened on** and any path a step moved to, as the `writing-the-report`
   reference shapes a `url`.
4. **Confirm every frame.** A frame is evidence once its assert passed and your own eyes confirmed what it
   shows, so read each one before it is promoted.
5. **Read the frames** as the `visual-verification` reference says; it produces the scenario's `visualMatch`.
6. **Write it up from the take you just filmed, and append its ledger line**, whatever the verdict. The steps
   summarise the take in the order it ran, each check sits under the step that brings it about with its
   `result`, and the take joins `recordings[]` with what it ran on.

**Then replay every flow as one more recording of its scenario**, through steps 1 to 5, under the scenario's
number with the recording's prefix:

- **On a browser walk**, on a phone, after every desktop scenario and in the phone's own session. Whether the
  app serves phones at all is a project fact.
- **On a device walk**, on each later device the entry lists, in that device's session.

Update the scenario and append its ledger line: the replay joins `recordings[]`, a check that broke on it
becomes a `fail` whose `saw` names that device, and a check only that device can show gets its own step. A flow
whose steps differ on the other device is a scenario of its own, with that one recording.

**Then film the e2e tests this run wrote, with their own runner:**

1. **List the tests**: every executed test the `phase-N-e2e.json` reports name whose scenario row is at level
   `e2e`. On a later round, list the ones behind the scenarios in the re-drive set.
2. **Run them once with video recording on**: the package's `e2e` command from the config, limited to those
   tests, with its JSON report written under `.yok/RUN/verify-staging/`. The `tdd` skill's `hermetic-e2e`
   reference says how each runner records video.
3. **Give each video to the scenario whose behaviour its tests cover**, as the `writing-the-report` reference
   shapes an automated test's recording, saved beside the report under that recording's prefix as an `.mp4`.
4. **Append the ledger line of every scenario that gained a recording**, its `requirements` joined by the ids
   in the `Traces` cell of each row the video covers.
5. **Give every failed test a bug**, its `trigger` the steps the test ran.

**Done when:**

- every behaviour the docs claim is reached by a journey, a scenario driven for it or a filmed test, this
  round or carried from the ledger, and every scenario has its `group`;
- every scenario driven this round names the path it opened on and has steps that summarise its first
  recording in order, every check with its `result`, and a `verdict` that follows from them;
- every recording has promoted frames that tell its whole story, each a moment of its take;
- every recording made on a browser walk has its video beside the report, whole or in numbered parts, or is
  one its reference handed to Step 5;
- every scenario you drove carries a `visualMatch`, and every design frame the plan builds is some scenario's
  baseline at the plan's width, or is named in the gap of the scenario that could not reach it;
- every flow has its replays driven to their closing assert;
- every e2e video is a recording of the scenario it covers, with that scenario's ledger line appended.

## Step 3 — API, DB & Side-Effects: Proving What Has No Screen

Every behaviour with no screen is proven here. Read the `headless-verification` reference before your first
request. This step is the order things happen in.

**Before the first request**

- **Plan, name and set the bar of each scenario as Step 2's *Before the first walk* does** — the fewest
  complete walks that reach every behaviour.
- **Know where each effect lands before a walk fires it**, from Step 1's second answer.

**Each scenario, in this order**

1. **Fire the trigger and keep what the checks rest on.** The request path is the scenario's `url`. The request
   line, the status and the values the checks rest on go inline into the `raw` of one `proofs[]` entry.
2. **Read the written state back** through the product's own API, quoting the fields, and where the datastore
   is directly reachable, the stored row too. That read-back is a proof of its own.
3. **Show the guard.** Give the reference's guard a proof of its own, whose `found` says in plain words why it
   shows the code under test ran.
4. **Prove every effect the walk fired at its sink, polling to a hard deadline:**
   - **Email** — open the mail viewer and shoot the received message, as frames.
   - **A job queue** — read the job out of the queue's own storage into a proof naming the queue, the job id
     and its state, dated by the worker's log line. Establish that the queue exists before believing a count.
   - **Webhooks and delivered files** — keep the file as `verification/NN_SLUG.EXT`, listed in `artifacts[]`.

   Where the project says the effect is neutralized in this stack, prove the enqueue and say so. Where the
   stack has no sink for it, the scenario is `NOT VERIFIED` naming that sink.
5. **Give every check its result** by exact-matching what came back against the check's text.
6. **Write it up from the exchange, and append its ledger line**, whatever the verdict. Each step says in
   plain words what was asked of the system and on whose behalf, in the order it was asked.

**Done when:**

- every requirement this step carries is named by a headless scenario, driven this round or carried from the
  ledger;
- every headless scenario names its `url` and holds its trigger, its read-back and its guard in proofs its
  checks cite;
- every out-of-band effect a walk fired is quoted at its sink, or `NOT VERIFIED` naming that sink.

## Step 4 — Adversarial Pass (MANDATORY — Role Swap)

> **STOP. You are the critic now.** You are graded on defects found.

**Write the attack list before you drive anything, with your draft write-ups closed.**

1. **Scope it to what this round touched**: the re-drive set, plus whatever the changed files reach, including
   the rest of the surface the change landed on. An attack an earlier round ran against code this round left
   unchanged stands.
2. **Attack from actors.** List the surfaces the feature reads and mark each with who can write it:
   - **The user, another tenant, or an operator** write through the product's own interfaces, so anything they
     can enter is a probe.
   - **A third-party system** is attacked by making it behave badly in a way its contract allows: unreachable,
     slow, timing out, an error status, a field absent, a record stale.
   - **The product itself** — a value it derives or issues — is attacked through the inputs it derives from,
     then read back.
3. **Three attacks are owed on every round:**
   - the errors and warnings you passed over, the state the feature carries between screens, and the branches
     the happy path never entered;
   - on every UI surface, content longer than the fixture;
   - on every screen the frame pass called clean, the divergence you most expected to find there.
4. **On a device walk, two more are owed**: background-and-return and rotate, as the `driving-the-device`
   reference says.

**Drive each probe as Step 2 does**, in the session of the scenario it probes and under its `NN_SLUG` prefix;
a probe with no screen follows Step 3. Route what it returns:

- **It probed a behaviour the docs describe** — evidence for that scenario. A rejection of bad input is the
  feature working.
- **It found a defect nobody asked about** — write its steps and drive them again as its own filmed scenario,
  under the `group` for its kind of check, with a `bugs[]` entry that settles `reachedBy` and `origin` as the
  `writing-the-report` reference asks, `origin` by `git blame` and `git diff`. With no actor to name, it is a
  note in `extra[]` on what the feature trusts.
- **It found nothing** — it appears only in the closing sentence below.

**Attack your own gaps the same way.** For every scenario you are about to mark `NOT VERIFIED`, read the
blocking code path until you can name the line, condition or absent datum. A gap that survives is real; one
that falls is verified now.

**Close the pass** with one sentence naming the attack you most expected to land this round and why it did
not, for *The Return*. Every scenario this step added is written up and appended as its own ledger line.

**Done when:**

- every surface in the attack list has been probed by each actor that can write it, and every owed attack ran;
- every bug reproduces from its own steps, is filmed as its own scenario, and carries `reachedBy` and a
  settled `origin`;
- every `NOT VERIFIED` names the line, condition or absent datum that blocks it;
- the closing sentence is written.

## Step 5 — Derive the Verdict, Then Complete the Videos

**Derive the verdict.** Map every requirement id to its scenario in `coverage[]`, from the ledger's last line
per scenario, and compute `verdict` by the rule in the `writing-the-report` reference.

**A derived `FAIL` with rounds left above zero makes this a deferred round.** A deferred round goes straight to
Step 7: its takes, its promoted frames and its ledger lines are its whole output, and the round after it
finishes from them.

**Every other round leaves every recording with its video**, the carried-over ones included:

1. **Run the `report-media` script over the verification directory**:
   `bun "$(yok orchestrate skill ref --path qa.report-media)" /abs/path/to/.yok/RUN/artifacts/verification`.
   It checks and compresses each recorded video, joins a take recorded in parts, and builds a video from the
   frames of every recording that has none.
2. **Read every line it prints.** Each recording gets `ok NN_SLUG.mp4 recorded`, `ok NN_SLUG.mp4 crop=…` for
   one it built, or `FAILED NN_SLUG — REASON`. A recording that does not play is filmed again, or its file is
   deleted so the script builds it from its frames. A recording with no `ok` line keeps `video` unset.
3. **Check the `crop` of every portrait recording the script built**: it reads as a portrait picture inside
   the bars. The canvas width on a portrait frame is a stretched frame and a failure.
4. **Append a ledger line per scenario the script built a video for**: the `.mp4` in that recording's `video`,
   every other field as the line it supersedes had it, `round` and `commits` copied across.

**Done when:**

- `coverage[]` and the derived verdict are fixed, and the round is deferred or not;
- on a round that is not deferred, every recording the script printed `ok` for has its `.mp4` beside the
  report, every built portrait recording's `crop` is a portrait picture, and the last ledger line per scenario
  names each recording's `video`.

## Step 6 — Write the Proof Report

1. **Copy the template** — the file `yok orchestrate skill ref --path qa.report-template` prints — to
   `verification/proof-report.html` and fill its JSON island as the `writing-the-report` reference says. The
   scenarios are the ledger's last line per scenario, transcribed.
2. **Walk the reference's completion checklist** until every bullet holds.
3. **Inline the media, last**: run the `report-media` script with `--inline` before the directory. It writes
   every video, frame, baseline and file the report names into the report itself, and prints `ok PATH BYTESB`
   or `FAILED PATH — REASON` for each. For a `FAILED` path, fix the path in the JSON island or copy the file
   beside the report, and run it again.

**Done when** `verification/proof-report.html` exists, every bullet of the completion checklist holds, and the
script printed `ok` for every file.

## Step 7 — Clean Up

**Close every session the round opened**, each by the name it was opened under:

- **a browser walk**: `agent-browser --session NAME close`, once for the desktop session and once for the
  phone session;
- **a device walk**: `agent-device close` once per device, with that device's `AGENT_DEVICE_SESSION` exported.

**A deferred round leaves the stack up, the fixtures in place and the staging dir where it is**, and lists
them in *The Return*: that list is what a person releases by hand if no later round comes.

**Every other round is the last one**, and releases what it leaves, in this order:

1. **Remove the fixtures you created** (Step 1).
2. **Release the stack** with the teardown step the environment's entry declares, else the way the stack skill
   says. Release what you brought up; what was running when you arrived stays running.
3. **Delete the staging dir**, `.yok/RUN/verify-staging/`.

`verification/` stays in place on every round, `run-log.jsonl` with it.

**Done when:**

- every browser or device session the round opened is closed;
- a last round has removed its fixtures, released what it brought up, and deleted `verify-staging/`.

## The Return

**Every round ends with a prose report followed by one JSON block.** A `BLOCKED` round returns the block alone.

**The prose** holds what the report leaves out, as durable facts a later run can act on:

- the derived verdict, the verdict per scenario, and whether the feature works;
- every bug, and which need a decision rather than a fix;
- the `verification/` path and its videos — or that this round is deferred;
- the stack you drove: how it was brought up, its base URL or its app and devices, and at which commit;
- the closing sentence of Step 4;
- the environment findings: every config value that was wrong, service that would not boot, fixture you had to
  build, command that was documented and gone;
- what Step 7 left running and which fixtures it kept.

**The JSON block** is the stage's output, checked against `qa.output.v1`. Finish the stage by passing it to the
`done` command with `--output -`, adding
`--artifact '{"type":"proof-report","name":"proof-report","path":"artifacts/verification/proof-report.html"}'`
on a round that wrote the report.

```json
{
  "status": "PASS | PARTIAL | FAIL | BLOCKED",
  "reason": "one line, required unless PASS — what failed, or what stopped the round",
  "report": "verification/proof-report.html, or null on a deferred or BLOCKED round",
  "gaps": [{ "scenario": "NN", "req": "REQ_ID", "mechanism": "what blocked it" }],
  "bugs": [{ "id": "NN", "file": "PATH", "summary": "what is wrong and why", "trigger": "the steps that make it fire", "hint": "the change that fixes it", "askUser": false }]
}
```

- **`status` is one of those four bare words** and repeats the derived verdict.
- **`BLOCKED` means you could not drive the feature at all.** Its `reason` opens with the token for what was
  missing — `no-infra:`, `no-agent-browser:`, `no-agent-device:`, `no-ffmpeg:` or `no-bun:` — then names it
  and what you tried. A missing tool names its install: `npm i -g agent-browser && agent-browser install`,
  `npm i -g agent-device@latest`, `npm i -g bun`. `report` is `null`, and on a missing tool `gaps[]` lists
  every scenario you could not prove against the requirement it carried.
- **`gaps[]` carries one entry per requirement `coverage[]` marks `NOT VERIFIED`**, each with those three
  fields and its own `req`: a scenario that left two requirements unproven gives two entries.
- **`bugs[]` carries one entry per bug, on a `FAIL` only**, and every `FAILURE` scenario has at least one. Each
  is a fix request the `fix` stage receives on its own, written in your own words: `id` is the scenario
  number, with `.2`, `.3` for a second and third bug in one scenario; `summary` says what is wrong and why;
  `trigger` gives the steps that make it fire; `hint` is the change you would make; `file` and `line` point at
  the cause where you traced it in the code. The report's `bugs[]` is the richer entry for the same bug.
- **`askUser` is yours to set.** `true` where the fix is a product call — two requirements that contradict, a
  fix that would change behaviour somebody intended — and the fix stage puts it to the user. `false` where you
  can name a cause and a fix.
