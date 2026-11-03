# Stack Up

**Read this when:** Step 1 brings up the stack from the config's `environments` block, and again at teardown.

## Pick the entry

`environments.entries` maps an entry name to its steps. The `environment` variable names the entry; `default`
means the one `environments.default` names. When the variable names an entry the block lacks, stop: return
`BLOCKED` with a `reason` opening `no-infra:` that names the requested entry and lists the ones that exist.

## The surface

Three fields beside the steps say what the entry drives. `platform` is `web`, `ios` or `android`; absent means
`web`. `app` is the app id the device opens (the iOS bundle id or the Android package), required on `ios` and
`android`. `devices` is an optional list of device names as `agent-device devices` prints them; the first is
the main walk and each later one replays every flow, and with no list the walk runs on whichever device is
booted. **An entry whose platform is `ios` or `android` is a device walk; a `web` entry is a browser walk.**
One entry is one platform; a project that ships both declares two entries.

## The steps

An entry maps a step name to one command. The names below are the usual ones; an entry may leave any out or add
its own, whose name says what it does. On a device walk the same names cover the app: `stackUp` builds, installs
and runs it on the device beside any services it needs, `stackStatus` says whether it is installed and running,
and `stackDown` uninstalls it.

| Step | What it does |
|---|---|
| `stackStatus` | reads whether the stack is up, with no side effects |
| `stackUp` | creates or updates the stack |
| `stackWait` | blocks until the stack is live or failed |
| `stackUrls` | prints where each service is reached |
| `servicePort` | prints one service's port |
| `seed` | creates the accounts and records the scenarios start from |
| `auth` | gives the browser or client a signed-in session |
| `stackDown` | releases the stack; on a device, uninstalls the app |

Run them in this order: `stackStatus`, then `stackUp` only for what is not already up, then `stackWait` (with no
`stackWait`, poll `stackStatus`), then `stackUrls`, `seed` and `auth`. The base URL comes from `stackUrls` or
`servicePort` output, never from an assumed port. A step that blocks for minutes runs in the background while you
read code, and you check its output before the first walk. At teardown, `stackDown` releases only what this
attempt brought up.

On a device walk, three more rules:

1. **One session per device.** Before the first step, export `AGENT_DEVICE_SESSION` as `RUN-DEVICE`, where
   DEVICE is the device name in kebab-case (`RUN` alone when the entry lists no devices), so an app a step opens
   lands in the session every later command on that device names.
2. **`stackUp`, `stackStatus` and `stackDown` run once per listed device**, with `{DEVICE}` filled with that
   device's name; a command with no `{DEVICE}` runs once. The other steps run once.
3. **Open the app on each device once the steps are done**, with
   `agent-device open APP --platform PLATFORM --device "DEVICE" --relaunch` (no `--device` when the entry lists no
   devices), filled from the entry's fields and with that device's session exported. It returns the first screen
   and binds the device.

A step that exits non-zero is retried once when its output says the failure was transient. A stack that still
will not come up is SKILL.md's `no-infra:` block, its `reason` quoting the command as it ran.

## Fill the placeholders

A command is a template. Fill every placeholder before running it; a brace or bracket must never reach the shell.

| Form | Meaning | Example template | Runs as |
|---|---|---|---|
| `{NAME}` | exactly one value | `up {BRANCH}` | `up feat-auth` |
| `{NAME...}` | one or more values, space separated | `up {SERVICE...}` | `up api web` |
| `[...]` inside braces | an optional part of each value | `{REPO[@REF]...}` | `api web@main` |
| `[...]` outside braces | a segment included only when the run needs what it carries; the brackets go | `up [--seed-demo]` | `up` or `up --seed-demo` |

Where the values come from:

- `BRANCH` is the input's `workspace.branch`; without a workspace, the current checkout's branch.
- `DEVICE` is one name from the entry's `devices` list, and the command runs once per name.
- Every other name is the project's. Its extension to this reference, below when it has one, says what each name
  and optional segment means and when to use it; it wins over the defaults here.
- With no extension rule for a name, choose from what this run changed: the repos in `workspace.repos`, the
  services or packages the diff touches. Leave an optional part or segment out unless the task or the diff needs
  it.

Record each command exactly as it ran, placeholders filled, in the report's environment findings.
