# Writing the Proof Report

**Read this when:** setting a scenario's bar and writing it up (Steps 2 to 5), completing the videos (Step 6), or
writing the report (Step 7). The driving and capture craft is in `driving-the-browser.md` and
`driving-the-device.md`.

**Contents:**

- The reader — Product and QA
- A scenario — one behaviour, written once
- Given, steps and checks
- Proofs — what a check cites
- Recordings — every video of the scenario
- The design check
- Grading — two tracks
- The report format
- Completion checklist — the report is done when all of these hold

## The reader — Product and QA

**The report is read by Product and QA people who have never seen the code.** They open it to learn what the
feature does for its user and whether that held. Every sentence the report shows them — a title, a `given` line,
a step, a check, a `reason`, a proof's `claim` and `found`, a bug's title and body — is written in **plain
language**:

- **Tell it from the user's side**: who does what, what they get, what stays saved.
- **Use the product's own words** for its screens, controls and messages, the way the user sees them, and everyday
  words for everything behind the screen.
- **Name each thing by its kind**: the kind of record, the kind of user, the kind of value. The ids, names and
  amounts the round happened to use belong to the proofs. Quote the product's own wording where that wording is
  the behaviour under test. A proof's `claim` states what its source showed.
- **Describe the application only.** How a recording was driven or filmed goes in that recording's `note`.
- **Keep the technical original out of the sentences**: a request, a response, a status code, a field name, an
  identifier, a command, a computed style, a measurement. Where a check rests on one that no frame shows, it is
  that check's reading, in its proof's `raw`. The code behind a bug or a gap goes in that entry's own fields.
- **Keep each line short**: one sentence, two where the second carries a fact the first cannot.

Read each sentence back as that reader: it makes sense on its own, with no developer beside them.

## A scenario — one behaviour, written once

**A scenario is one behaviour the docs describe.** Everything that proves that behaviour belongs to it: the take,
every replay of it on another device, the automated test that covers it, and every proof. A behaviour with its
own steps is a scenario of its own.

**`title` is a question that names the action and the exact outcome expected**: what the user does, and what
they get, see or are kept from, stated concretely enough that a reader knows the pass condition from the title
alone. The checks under it answer that question yes or no.

**Split a scenario into `parts[]` where its flow runs through stretches that each need the one before**: a
stretch moves to another product or service, or picks up after the product has worked in the background. Each
part is `{title, steps[], recordings[]}`: a title naming that stretch in a few words, the steps it covers, and
its own video. A scenario with parts carries its steps and recordings in them alone. **Flows that do not depend
on each other are separate scenarios.**

**Another device is a recording, never a part.** A replay on another device joins the part whose screens it
replays, labelled by the device, and its checks sit under that part's steps. A replay that crosses several parts
is filmed as one recording per part.

**`group` is the heading the report lists the scenario under** — `journey` for a primary journey, else the
broad heading for the kind of check it is — set when it is planned, as Step 2 says.

**`phone` is the phone replay a browser scenario owes**, set when it is planned: `replay` is `required` or
`not needed`, and `why` is the one line that settled it.

**`thirdParty` names the service whose own screen the scenario's checks are read on**, in plain words, on the
scenarios Step 2 gave one.

## Given, steps and checks

A scenario reads top to bottom: where it starts, then each thing the user does with what should be true once
they have. Its parts are written at two moments, in this order:

1. **Before driving, from the docs: `title`, `given`, and the text of every check.** The checks are the bar the
   run is graded against, set while the result is still unknown, listed in the order they will be proven.
2. **After the run that is the evidence: `steps`, and each check's `result`.** Place every check under the step
   that brings it about, in the order the run reached them, and every step in the part it belongs to.

**`given` is the setup, one fact a line**: who the user is, what data exists and what makes it matter, the
settings and permissions in force. Each line states something true before the user acts.

**A step is one thing the user does, and it exists because something is checked once it is done.** Write `when`
as one short sentence in the present tense, naming the control by its label on screen. Actions that lead up to the
checked moment fold into that step's sentence, so the steps summarise the journey the recording shows. A check
on the same screen on another device sits under the step that reached that screen. A check made on another
surface or on a file the product produced — a downloaded document, a stored record, the service the effect
landed on — gets a step of its own, saying what was opened or read.

**A check is one plain sentence saying what should be true**, with:

- **`req`** — the requirement ids this check proves, set with its text before driving. A design check carries
  the `SPEC:` row it proves, and a check on a bug no requirement names carries an empty list.
- **`result`** — `pass` where the run showed exactly that, `fail` where it showed something else. A check that
  held on one recording and broke on another is a `fail`.
- **`saw`** — on a `fail`, what was seen instead, in one sentence, naming the recording where it differs between
  them.
- **`note`** — one line the reader needs beside the check, where there is one.
- **`proofs`** — the ids of the proofs that show this check, as *Proofs* below says.

**A walk that stopped short** gives a result to every check it reached and leaves the rest without one. **A
scenario nothing could drive** carries its `given` and its steps with their checks, none with a result.

**`reason` belongs to a scenario graded `FAILURE`, `NOT VERIFIED` or `INVALID`**, kept to what the verdict turns
on: which check failed and what that means for the user, with the two facts *Bugs* asks of a `FAILURE`; what
blocked the walk and what would close it; or why the scenario does not apply.

Anything else the walk observed goes to the field that owns it: a divergence from the design to the design
check, a mechanism to the reading of the check it explains, and a remark that fits neither — or a mechanism
behind a check a frame proves — to `extra[]`.

## Proofs — what a check cites

A proof is what the reader opens under a check to see it hold. **Add a proof only where it has a source and
gives the reader confidence the check alone does not.** Choose it as a QA or product person would check the
claim themselves: by looking at the screen where the outcome shows.

- **A source.** A proof is a **picture**, the promoted frame that shows the check, or a **reading**, values read
  from a named witness: the datastore, the product's own API, a third-party service, a log, a file, the page's
  own measurements, the test runner. Every value in a reading is copied from its witness as the run read it.
- **Picture first, and alone.** **A check shown on screen cites the frame that shows it, and that frame is its
  whole proof.** The request behind the screen, the value stored under it and a measure of what the frame already
  shows are the same fact again, and stay out. **An effect that landed on a service with its own pages** — who
  made a change there, what was posted, what it now lists — **is shown on that service's page**, opened in its
  signed-in session and filmed as a step of the take, and that frame is its proof.
- **A reading only where no frame shows the check**: a request and its reply that no screen displays, a stored
  value no page shows, a log line, a value finer than a frame can show.

**One proof backs one check, from one source.** A second check resting on the same witness gets a proof of its
own, holding the values that check rests on. Every entry has these parts:

- **`id`** — a short id unique within the scenario, which the check it backs cites.
- **`label`** — two or three words naming the source. It is the pill the reader clicks.
- **`claim`** — what the source showed, as one short plain sentence. A proof that failed reads as the failure.
- **`holds`** — `true` where the source shows what the check says, `false` where it shows otherwise. A proof
  behind a `warn` that states the finding holds.
- **`image`** — on a picture: the frame's `src` from `recordings[]`. A picture taken outside the take is saved
  as `screenshots/NN_SLUG.NAME.png`.
- **`found`** — on a reading: why it counts, in one or two plain sentences. A witness that stands in for the
  real thing is named as a stand-in here.
- **`raw`** — on a reading: the values that let the reader trust it, **laid out to be read from top to bottom**
  in at most fifteen lines:
  1. a `#` line saying in plain words what was measured or asked;
  2. where the question is short enough to read at a glance — a request line, a rule as its source writes it —
     that line, under a one-word label where that helps;
  3. each value the check rests on, one a line, under a plain name, its text kept exactly as it arrived;
  4. a `→` line with the outcome.

  Keep a value only where the check rests on it. Redact secrets as `<redacted>`.

`artifacts[]` is for files **the product produced** — a webhook body it posted, a file it delivered, a document it
generated — each as `{label, href, note}`.

## Recordings — every video of the scenario

**One flow, one video.** Each part, or a scenario with no parts, has one video that runs from its first step to
the outcome its last check reads, across every product and service the user moves through, and **ends on the
final state the user sees**: where the product works on in the background, the video picks up when the result
arrives and shows it where the user reads it. `driving-the-browser.md` says how a take is filmed so.

`recordings[]` lists the videos of a part, or of a scenario with no parts, in the order they were made: the take,
then a replay on each other device. The report shows them as tabs beside the steps, with each one's frames folded
under it. Each entry:

- **`label`** — the name on its tab: the device, or the way it was driven.
- **`kind`** — how it was driven: a walkthrough by this skill, or an automated test.
- **`device`** and **`browser`** — what it ran on, as the session reported them. An emulated device says it is
  emulated.
- **`size`** — `phone` on a phone replay.
- **`thirdParty`** — on a take filmed in a third party's session, that service, in the scenario's own words.
- **`video`** — the file. The report reads its size, shape and length from the file itself.
- **`frames[]`** — `{src, label}` for each promoted frame of that recording, in order.
- **`note`** — one line about how this recording was made, where a reader needs it.

Every video comes from one of three places:

- **Recorded.** A browser recording is its take, filmed by the round that drove it as `driving-the-browser.md`
  says. Step 6 checks that it plays, compresses it in place, and cuts any stretch where the picture stays still
  for over three seconds down to two. A take that followed the user across tabs or sessions was recorded in
  numbered files, which Step 6 joins into the one video, with a card saying the recording paused before each
  file recorded after a wait.
- **Recorded by the e2e runner.** A browser test's video is the one Step 4 saved beside the report. Step 6
  checks and compresses it like a take.
- **Assembled.** A device recording, a CLI test's terminal recording, and a browser recording whose recorder
  failed, gets its video built by ffmpeg from its promoted frames in `screenshots/`, grouped by the prefix before
  the `__`.

`SKILL.md`'s Step 6 carries the command, which reports one line per recording. **A `FAILED` line fails the
step**: a recording that does not play, a build ffmpeg could not finish, or a **stretched** frame, which the
script catches itself by comparing each source frame's aspect ratio with the crop window cropdetect found in the
video it built. The settings and the reasons for them live in the script.

**Keep the frames** — they are the only machine-readable evidence, and a re-grade or second look needs the PNGs.
A recording whose video cannot be had keeps its frames and leaves `video` unset.

### An automated test's recording

An e2e test joins the scenario whose behaviour it covers, by what it drives:

- **A browser test adds its video** as one more recording, with no `frames[]`.
- **A CLI test adds its terminal recording**: its promoted frames, one per command, `device` naming the
  terminal, `browser` unset, and a `note` saying the frames are drawn from the transcript the test's run wrote.
- **A test that drives neither adds its results alone.**

Its results grade the checks it asserts:

- **Grade each check the test asserts from the runner's report.** Where the test's recording shows the check,
  its frame is the proof; elsewhere the proof is a reading whose `raw` is the runner's own result line for the
  tests behind that check.
- **A failed test fails the checks it asserts**, with what the runner reported in `saw`.

Where no driven scenario covers the plan rows a test proves, the test is the one source of the scenario planned
for it: `title` from the rows' `Scenario` cells, `given` from their `Given`, the steps from the test's code in
the order it runs them, the checks from their `Expected`, and each `result` from the runner's report.

## The design check

Every UI scenario you drove carries a `visualMatch`, which the report shows as its design check: what the screen
was compared with, the design beside the screen as built, and a list of checks. `visual-verification.md` is the
pass that produces it.

- **`baseline`** — the reference image's report-relative path, or `null` for a screen nobody drew.
- **`build`** — the screen as built, shown beside the baseline: the re-shoot at the design's width, else the
  frame of the take that shows the drawn screen. Every scenario with a baseline names one.
- **`width`** — the width of a re-shoot.
- **`checks[]`** — what the pass found, each a check in the shape *Given, steps and checks* gives, written for
  the same reader:
  - **`pass`** — the screen does what the design or the question asks. Say in one sentence what lined up, so a
    reader sees what was looked at.
  - **`fail`** — the build breaks what the design says. **A failed design check makes the scenario a
    `FAILURE`**, with a `bugs[]` entry behind it, filmed from its own repro like any other.
  - **`warn`** — worth a reader's look, and the scenario still passes. Its `note` says why it does not decide
    the verdict.

  A design check says what the user meets on the screen, and cites its proofs as *Proofs* says.

**Grade a divergence by what it changes for the user**, as `visual-verification.md` says; a spacing or pixel
delta against the baseline is no check at all.

**Each `design/spec.md` rule a plan step cites for this screen is covered by a check.** Rules that tell the
reader one thing share one check, worded as that one thing. The check cites a proof whose `raw` holds, for each
rule, the rule as the spec writes it and the values read from the page, laid out as *Proofs* says.

## Grading — two tracks

Grade each scenario on two tracks; they answer different questions and flow to different places.

The **documented check** answers the question you were given: does the run show the behaviour the docs describe?
It is answered one check at a time, each `result` resting on what the run captured: an assert that settled
it, a frame, a reading. **The scenario's `verdict` follows from its checks**: `SUCCESS`
where every check passed, `FAILURE` where any failed.

The **open visual review** asks what's wrong regardless of what was asked for: alignment, contrast, clipping,
overlap, a broken empty state, copy issues. Run it on every scenario, including the ones that passed cleanly.
Treat `truncate` and `line-clamp` on a primary headline as a bug to justify. Anything real you find here is a
bug, and Step 5 owns it. `visual-verification.md` is the one pass that runs it — against the design where the
plan supplies one, and against the screen's own coherence always.

## The report format

**The scenarios come from `verification/run-log.jsonl`, last line per scenario, as the ledger holds them, listed
with the journeys first and then set by set, each set in number order.** On a
feature that has been through a fix round, most scenarios were driven by an earlier round's agent, and that line
is all there is of them. The line's `scenario` object is the `scenarios[]` element itself, so a carried-over
scenario is transcribed into the report, and the `requirements` beside it are what `coverage[]` maps to that
scenario. A carried-over `NOT VERIFIED` scenario's `gaps[]` entry comes from the line's `gap` object the same
way.

**Fill the JSON island of the copy Step 7 made — the `<script type="application/json" id="report-data">`
block — and leave the rest of the file as it is.** Its header comment is the field-by-field guide.

```json
{
  "title": "FEATURE",
  "scenarios": [
    {
      "n": "NN",
      "slug": "NN_SLUG",
      "short": "RAIL LABEL",
      "group": "journey",
      "title": "WHEN THE USER DOES THIS, DO THEY GET THIS EXACT OUTCOME?",
      "verdict": "SUCCESS",
      "url": "PATH?QUERY",
      "phone": { "replay": "required", "why": "THE ONE LINE THAT SETTLED IT" },
      "given": ["ONE FACT THE SCENARIO STARTS FROM"],
      "steps": [
        {
          "when": "WHAT THE USER DOES",
          "checks": [{ "text": "WHAT SHOULD BE TRUE", "req": ["REQ ID"], "result": "pass", "proofs": ["PROOF ID"] }]
        }
      ],
      "recordings": [
        {
          "label": "NAME ON THE CARD",
          "kind": "HOW IT WAS DRIVEN",
          "device": "WHAT IT RAN ON",
          "browser": "BROWSER",
          "video": "NN_SLUG.mp4",
          "frames": [{ "src": "screenshots/NN_SLUG__SS_STEP.png", "label": "WHAT THE FRAME SHOWS" }]
        }
      ],
      "visualMatch": {
        "baseline": "../design/FILE",
        "build": "screenshots/NN_SLUG.design.png",
        "checks": [{ "text": "WHAT THE DESIGN ASKS OF THE SCREEN", "req": ["SPEC: RULE"], "result": "pass", "proofs": ["ANOTHER PROOF ID"] }]
      },
      "proofs": [
        {
          "id": "PROOF ID",
          "label": "THE SCREEN IT SHOWS",
          "claim": "WHAT THE FRAME SHOWS",
          "holds": true,
          "image": "screenshots/NN_SLUG.NAME.png"
        },
        {
          "id": "ANOTHER PROOF ID",
          "label": "WHERE IT COMES FROM",
          "claim": "WHAT THE WITNESS SHOWED",
          "found": "WHY IT COUNTS",
          "holds": true,
          "raw": "THE VALUES THE CHECK RESTS ON, LAID OUT TO BE READ"
        }
      ]
    }
  ]
}
```

A scenario told in parts carries `"parts": [{ "title", "steps", "recordings" }]` in place of its `steps` and
`recordings`; the template's scaffold holds one.

**`url` is the path the scenario opened on** — the path with its query string and no host; the host goes in
the return. One path per scenario. **Redact what the query carries**: keep the parameters that select what was under test, write the
value of any auth or identity parameter as `<redacted>`, and record the path alone for a scenario reached
through a callback or a pre-signed URL. **On a device walk, `url` is the deep link the scenario opened, else the
screen path it reached** — the screen names from the app's root to the one under test, joined with `/` —
redacted the same way. A headless scenario's `url` is the request path it drove. A path a later step moved to
shows in the frame of that step; on a check with no frame, it sits in the `raw` of its reading.

When something fits none of the sections, put it in `extra[]` — `{heading, body, capture}`, all optional.

### Coverage and the derived verdict

`coverage[]` at the top level is the scope ledger: **one entry per requirement id the feature's docs list**,
reached or not, each `{req, scenario, verdict}`. The page does not show it: the verdict is read off it, and a
`NOT VERIFIED` row reaches the reader through its `gaps[]` entry.

**A row is graded by the checks that carry its id in `req`**, wherever they sit, and `scenario` names every
scenario holding one of them. The row is `FAILURE` when any of those checks failed, `NOT VERIFIED` when any
has no result or none exists, and `SUCCESS` when all of them passed. A check that failed fails only the ids it
carries, so the other ids in its scenario keep the verdict their own checks give. Every id in the docs has a
row.

**Every rule in `design/spec.md` is a requirement too.** When the run has a spec, read it top to bottom, whether
or not a plan step points at the part a rule sits in, and give each rule it states its own row, `req` set to
`SPEC:` followed by the rule in a few words. Its verdict comes from the design check that covers it: `SUCCESS`
when that check passed, `FAILURE` when it failed. A rule no scenario reached is `NOT VERIFIED` with a `gaps[]`
entry, and a rule that does not apply to this build is `INVALID` with why. The spec has no fixed format, so read
rules as the spec writes them: a sentence, a bullet or a table row each count.

**`verdict` is derived from `coverage[]`:** any scenario `FAILURE` → `FAIL`; else any requirement
`NOT VERIFIED` → `PARTIAL`; an all-covered, all-`SUCCESS` round is `PASS`. Compute it once every id has its row
and write what it says.

### Bugs

`bugs[]` at the top level is **bugs in the application** — defects that will bite a user or a developer. Each
entry is `{severity, origin, reachedBy, scenario, title, body}`:

- **`scenario`** is the `n` of the scenario that reproduces it — the Step 5 walk you filmed for this bug. It
  carries the reader to the failed check, what was seen and the recording, so the entry leaves those to it.
- **`reachedBy`** is one sentence: the actor who reached it and the surface they used. An entry with no actor to
  name goes to `extra[]` as a note on what the feature trusts.
- **`origin`** is `introduced here`, `pre-existing` or `pre-existing, worsened here`, as `git blame` or the diff
  settled it; `body` says which commit or hunk settled it.
- **`severity`** is `blocker`, `major` or `minor`, and `body` says why that rung and not the one above.
- **`body`** is a report a maintainer could act on without asking a question: what it is, and the repro.

`bugs[]` carries what is still broken as the report is written, most consequential first; a bug a fix round
closed leaves a passing scenario and no entry. A `FAILURE` scenario states `reachedBy` and `origin` in its
`reason`, one sentence each. With no bugs, `bugs` is empty.

What this run could not reach goes in `gaps[]` — one entry per `NOT VERIFIED` scenario, every field filled:
`{scenario, req, mechanism, attempted, wouldClose}`. `mechanism` is the cause Step 5 made you read the blocking
path for: the line, condition, credential or absent datum. `attempted` lists the distinct approaches you ran.
`wouldClose` is the concrete thing a human or a later run can supply.

Your infrastructure adventures, the data you could not find, and the workaround that got the stack up go in
the return.

## Completion checklist — the report is done when all of these hold

- The JSON island parses, and the file opens in a browser showing every scenario — open it and look.
- `coverage[]` has a row for every requirement id the docs list, each graded by the checks that carry its id,
  and `verdict` is what the derivation rule computes from it. Grep the docs for their id pattern and diff that
  set against `coverage[]`.
- Every check names in `req` the requirement ids it proves, proves behaviour this change touches or a
  requirement names, and is the only check in the report that proves it.
- When the run has `design/spec.md`, `coverage[]` has a `SPEC:` row for every rule it states.
- Every scenario has a stable `n`, its `group`, a `title` that asks whether the user's action gets the exact
  outcome expected, a `given` list, and steps that each carry a `when` and at least one check.
- Every scenario with `parts[]` splits only where a stretch needs the one before it, each part titled, holding
  its steps and its own video; flows with no dependency between them are scenarios of their own.
- Every check of a driven scenario has a `result`, every failed check a `saw`, and each scenario's `verdict`
  is what its checks give: `SUCCESS` with every check passed, `FAILURE` with any failed.
- Every scenario graded other than `SUCCESS` has a `reason`. One you could not verify is `NOT VERIFIED` with
  what would close it; one that turned out not to apply is `INVALID` with why. Each keeps its place in the
  report.
- Every sentence the report shows reads to a Product or QA person with no developer beside them: told from the
  user's side, in the product's own words, naming things by their kind, with no technical original in it.
- `title`, `given`, every `when` and every check describe the application and the user alone.
- Every recording is in the `recordings[]` of its part, or of its scenario, with its `label`, `kind`, `device`
  and, on a browser, `browser`; every replay on another device sits in the part whose screens it replays, and
  every automated test with the scenario whose behaviour it shows.
- Every video runs from its first step to the final state the user sees, the result of background work
  included.
- Every executed e2e test the plan names is covered by a scenario of the report.
- Every scenario with a browser recording carries its `phone`, and each `required` one that was driven has a
  recording whose `size` is `phone`.
- Every scenario with a `thirdParty` that was driven has a take filmed on that service's own screen, whose
  `thirdParty` names it; one that is `NOT VERIFIED` leaves every check without a result.
- The steps a recording shows read as a summary of it: play the video with those steps beside it.
- Every frame a recording lists is a moment of its video.
- Every check shown on screen cites the frame that shows it and no reading, and every effect on a service with
  its own pages cites a frame of that page.
- Every proof is a picture or a reading from a named source, gives the reader confidence its check alone does
  not, and is cited by the one check it backs.
- Every reading's `raw` holds only the values its check rests on, in fifteen lines or fewer.
- Every side-effect scenario carries the receipt Step 3 names for its sink, or is `NOT VERIFIED` with that sink
  named.
- Every UI scenario you drove carries a `visualMatch` with at least one check; one with a `baseline` names its
  `build`; every spec rule a step cites is covered by a check with its measurements in a proof; every check
  cites the frame or the reading it rests on; and every failed design check has made its scenario a `FAILURE`
  with a `bugs[]` entry behind it.
- Every scenario that drove a page or a request carries its `url` as *The report format* shapes it.
- Every `url` shows `<redacted>` for the value of an auth or identity parameter, and a path reached through a
  callback or a pre-signed URL carries no query.
- Every `NOT VERIFIED` scenario has a `gaps[]` entry whose `mechanism` names a line, condition, credential or
  absent datum, with `attempted` listing distinct approaches and `wouldClose` naming the concrete unblock.
- Every `bugs[]` entry carries a `reachedBy` naming a real actor and the surface they used, an `origin` settled
  by `git blame` or the diff, and the `n` of a scenario that exists and carries the failed check the entry
  leans on.
- Every path is report-relative, and every file named in `artifacts[]` exists beside the report under its
  scenario's prefix.
- The `report-media` script with `--inline` ran after the last edit to the report and printed `ok` for every
  file it names.
- Things this skill genuinely cannot reach are scenarios too, marked `NOT VERIFIED`.
- The plain sequential `n` values are the only identifiers a reader meets, and each thing is said once.
