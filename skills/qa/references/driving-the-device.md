# Driving the Device

**Read this when:** driving UI scenarios on a device (Step 2) or re-driving a bug's repro there (Step 4), for an
environment entry whose `platform` is `ios` or `android`. Everything here is done with the app open on a simulator,
emulator or phone through the `agent-device` CLI; grading, videos and the report are in `writing-the-report.md`.
The browser twin of this file is `driving-the-browser.md`, and the two never apply to the same scenario.

**Contents:**

- Setup
- The loop — snapshot, act with `--settle`, read the diff
- Asserts — the quoted output is the evidence
- Batches
- The capture loop — act, assert, capture to staging, promote
- Fresh state
- Replaying on another device

What depends on the app — how sign-in works, which screens lie about their own state, which permission prompt
appears first — is knowledge the project owns, held in its own skills and `CLAUDE.md`. Look for it before your first
`open`; a project that has been verified before has usually written its traps down.

## Setup

**Keep `AGENT_DEVICE_SESSION` exported**, with the value Step 1 set for the device you are driving, for every
command here and for Step 7's close. A session is bound to one device, so switching device means exporting that
device's session name; every command then lands on it.

**Step 1 opened the app** on each device with `agent-device open APP --platform PLATFORM --device "DEVICE"
--relaunch`, filled from the entry's fields, under that device's session name, and its reply was the first
interactive snapshot, with refs. Resume from that session and continue from its current screen; open again only
for a scenario that starts from a cold app (see *Fresh state*), since `--relaunch` wipes the state the scenario
before it built.

The CLI ships its own guide, version-matched to the binary and authoritative on the basics — refs, selectors, the
`wait` verbs, recovery, platform limits:

```bash
agent-device help workflow        # the full loop. Look things up here.
agent-device help COMMAND         # one command's exact shape
```

## The loop — snapshot, act with `--settle`, read the diff

1. **Get refs** with `agent-device snapshot -i`: the interactive elements only, each with an `@eN` ref. Copy a ref
   exactly, including any `~sN` pin; refs go stale after the screen mutates, so take a new snapshot after every
   action that moved the screen.
2. **Act with `--settle`**: `press @eN --settle`, `fill @eN "TEXT" --settle`, `scroll down --settle`,
   `back --settle`. The flag waits for the UI to go quiet and prints the diff against the tree before the action.
   Continue from that diff; run `snapshot -i` again only when the diff lacks the next target or did not settle.
3. **Prefer refs, then selectors** (`id=`, `label=`, `role=`, `text=`); fall back to coordinates only after
   `snapshot -i` shows no semantic target, and re-snapshot afterwards.
4. **Reach an off-screen target in one command**: `scroll down --until 'label="TEXT"' --settle`.
5. **Wait on the real condition** for a late result — `wait text "TEXT"`, `wait @eN`, `wait absent SELECTOR` —
   never a polling loop of snapshots.

`--settle` belongs on `press`, `click`, `fill`, `longpress`, `scroll` and `back` only; `open`, `snapshot` and
`close` refuse it.

## Asserts — the quoted output is the evidence

There is no `eval` on a device: nothing runs inside the app. Every claim is settled by one of these read-only
commands, and **the command's printed output, quoted verbatim, is the evidence** the scenario's `reason` cites:

| Need | Command | What it proves |
|---|---|---|
| a string on screen | `get text @eN` | the text as rendered |
| a rect, size or state | `get attrs @eN` | the element's frame and attributes; the 44px touch-target rule is measured here |
| an element shown | `is visible SELECTOR` | the element is present and visible |
| a label holds a value | `is text SELECTOR "TEXT"` | the rendered text equals the expected one |
| a late result landed | `wait text "TEXT"` | the text appeared within the timeout |
| an element went away | `wait absent SELECTOR` | zero matches on a complete, settled capture |

Pass `--json` when the reply is structured, and quote the JSON. A reply that reports no match, or a selector that
matched more than one element, is a failed lookup, never a pass. A bare screenshot or snapshot is not
verification: a frame is evidence only beside the assert that names what it shows.

## Batches

`agent-device batch --steps-file PATH --json` runs many commands in one daemon request against the same session
and returns one result per step. Write the steps file under the staging dir. Each step is
`{"command": NAME, "input": {...}}`, and `input` holds the command's structured fields rather than its terminal
spelling: a positional becomes a named field, a flag becomes a camelCase key (`--settle` is `"settle": true`,
`-i` is `"interactiveOnly": true`), and a target is `{"kind":"ref","ref":"@e12"}` or
`{"kind":"selector","selector":"id=\"save\""}`. `agent-device help batch` lists the accepted commands and the
exact spelling of each; read it before writing the first file.

- **One batch has a 60 second work budget.** A batch that runs past it is cancelled mid-step and returns
  `daemon_request_timeout` with the steps that did run; split a long walk into several batches rather than one.
- **Act, wait, then assert and screenshot in one batch**, so a toast or banner is measured and shot while it is
  still on screen. Pass `--on-error stop` so a failed step does not leave later ones acting on the wrong screen.
- **Keep `open`, `close` and `session` out of a batch** and run them on their own.

## The capture loop — act, assert, capture to staging, promote

**Film the whole life of the scenario, not a checklist of its steps.** Every step earns at least one frame, many earn
more — a scenario with more *promoted* frames than steps is doing it right.

**Capture to staging, promote only what you verified.** Shoot into `.yok/RUN/verify-staging/` — scratch, a sibling
of `verification/` and never part of it — and move a frame into `screenshots/` only once it earns its place.
Re-takes, dead ends and missed presses stay in staging and are discarded at cleanup.

**Re-driving a scenario an earlier round filmed? Delete its old evidence first, then capture:**

```bash
rm .yok/RUN/artifacts/verification/screenshots/NN_* .yok/RUN/artifacts/verification/NN_*
```

Step 5 builds each video from every frame still under that prefix, and keeps any `NN_SLUG.mp4` it finds beside the
report. So a frame or a video from a walk that no longer exists passes for a fresh one, and nobody can tell them
apart.

For every action, in this order:

1. **Act and assert** — a press or fill with `--settle`, then the assert from the table above that names what the
   action should have changed.
2. **Screenshot to an absolute staging path**: `agent-device screenshot /abs/path/to/.yok/RUN/verify-staging/
   NN_SLUG__SS_STEP.png`. Write the path absolute; the shell's working folder resets between calls.
3. **Read the staged PNG** and confirm it shows what you think — the round-trip you never skip. Frames lag
   renders, so a frame that disagrees with its assert is re-shot after a `wait` on the condition, never promoted.
4. **Promote it** once the assert passed and your eyes agree: move it into `verification/screenshots/` under its
   `NN_SLUG__SS_STEP.png` name, and record the assert's quoted output for the scenario's `reason`.

You need both checks. The assert answers whether the state took hold — a press that silently no-ops looks identical
to one that landed until you ask the tree. The read answers whether the frame shows it.

Frame a non-feature element at the top and bottom edge of each shot, so the frame carries the feature's neighbours:
a tab bar that moved, a header that misaligned once the feature mounted, an orphaned action. Prefer a plain
screenshot over `--crop-on`: it keeps the frame readable at video size and keeps those neighbours in.

## Fresh state

A scenario that must start from a cold app — first launch, a logged-out start, a cleared draft — reopens it with
the same `open … --relaunch` command Step 1 used, which terminates the process before launching. Open
once per such scenario, and take a new `snapshot -i` afterwards: every ref from before the relaunch is stale.
State the app keeps on disk survives a relaunch; clearing it is the project's own procedure, from its stack skill.

## Replaying on another device

A device walk is already on a real device, so there is no `agent-browser` phone replay. Its second widths are the
later devices the entry's `devices` list names — a smaller phone, a tablet — and each one replays every flow.

**Drive the whole scenario again on each later device.** Export that device's session name, then walk it from its
first press — the same batches and the same asserts as the main walk, under the replay's own `NN_SLUG`, and
with the device named in the scenario's title. A layout breaks on the way to the final screen rather than on it,
so a frame shot at the end proves nothing.

The replay carries a verdict, so the walk answers the same question it answered on the first device:

- **The closing assert returns the value it returned on the first device** — the outcome, not a similar-looking
  screen. This is what the scenario's `expected` already claims, now claimed at this device's size.
- **Every control the replay drove is at least 44px on its short side**, read from `get attrs`.
- **Controls are reached the way this device presents them** — a tablet that shows a sidebar where the phone
  showed a tab bar is driven through the sidebar, the way the user gets to it.

A replay that fails is a `FAILURE` scenario and a `bugs[]` entry like any other, and its `reachedBy` writes itself:
the user on that device, and the surface they touched. A project that ships both platforms declares two entries,
and each is its own run.
