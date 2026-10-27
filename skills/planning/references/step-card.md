# The step card

An implementation step in `phases/phase-N.md` is a **card**: a fixed set of parts. The card
governs where things go and what they are called. It never governs how much a step says.

## The parts

| Part | Include when | How it is written |
|---|---|---|
| **Title**: the action and its file | always | `1. **Change \`src/x.ts:31-40\`**` |
| **Summary**: what the step makes true and why | always | two or three sentences under the title, as **The summary** below says |
| **Design**: the frame this step builds, and where its spec rules are | the step builds the screen, component or interaction a frame draws | two list items, as **Designs** below shows |
| **UI mapping**: the component behind each element of the frame | the step has a Design part | a table right after the list items, as **Designs** below shows |
| **Diff**: the change | the step changes code, whether or not it has a Design part or a Spec line | a line naming the file and range, then a ```` ```diff ```` block |
| **Pattern**: existing code to imitate | the step copies a shape from elsewhere rather than changing that code | a fenced block, with the reason it is shown on the line above |
| **Why this way**: the rejected alternative, or the constraint | the location or shape had a plausible alternative | closing sentence |
| **Trap**: what breaks if the developer does the obvious thing | code that looks safe to change and is not | its own paragraph |

**Write the parts in the table's order.** Parts are triggered, not filled. An omitted part costs
nothing; a padded part states "considered, nothing found".

**Some parts are owed.** A step that changes code carries its Diff. A step that builds what a
frame in `design/INDEX.md` draws carries its Design part and its UI mapping.

A step can also say something that is none of these. An environment warning, or a note on how
to see the change, is plain prose.

## The summary

The summary is the part every reader of the plan reads: the developer before the diff, the
reviewer deciding whether to approve, and qa deciding what to check. Write it so each of them
understands the step after one read, in two or three sentences of plain English, present tense.

1. **Outcome first.** The first sentence says what is true once the step lands, seen from outside
   the file: what a user, an API caller or another part of the system can now do, now gets, or
   no longer gets.
2. **Then the reason.** The next sentence says why the step is needed: the requirement it serves,
   or what goes wrong without it.
3. **Then what stays the same**, when a reader would worry about it: the behaviour the change
   leaves untouched.

**Leave the mechanics to the diff.** The names the diff adds, renames and deletes, its branches
and its error paths are read in the diff's code. A rejected alternative goes in **Why this way**,
and a hazard goes in **Trap**.

**Gloss every name you use.** A function, type, route or file the summary names gets a few words
saying what it is, in the sentence that first names it.

**Write only for the reader.** Every diff is written against the file as the earlier phases
leave it, for the whole plan, so a step states only what is true of this step. Test counts
belong to the scenarios. Anything that depends on what another phase did is settled before the
step is written, and the step states the settled answer.

## Show the change as a diff

Every change is a **unified diff**: removed lines open with `-`, added lines with `+`, context
lines with a space, and a hunk header `@@ -from,count +to,count @@` separates hunks. A
before-and-after pair makes the coder rebuild what the diff hands them.

- **A new file** is one block of `+` lines, every line of it.
- **A change inside a file** carries at least one context line on each side, and a hunk header
  when the line numbers are known.
- **Two changes apart in one file** are two hunks in one block, each with its header.
- **A moved block** is `-` lines where it was and `+` lines where it goes.
- **A rename or one-token edit** is still a diff: `-` the old line, `+` the new.

Keep a diff as long as the change and no longer. Every line in the block opens with `+`, `-`,
`@@` or a space.

Existing code the step does not change appears only when the step **imitates** it, as a plain
fenced block with the reason above it: `bull-queue.ts:1678 — createFlow, the
parent-plus-children builder`. Unlabeled current code reads as the target state, and the coder
builds it.

## Addresses

A line reference is an **address**. Give one where the developer must open that spot, the code
they change, delete, move or replace, and name what is there:
`header.js:859-972 — the AccountMenu memo`. Repo-relative always. The diff label carries the
address for a change; the title repeats it only when the step has no diff.

Everywhere else, state the fact. Where they must keep something exactly, quote it. An address
asks them to fetch what the step could have handed them.

## Designs

**Put the frame on the step that builds what it shows.** The Design part belongs to the step
whose diff creates the screen, component or interaction the frame draws: its markup, its states
and the behaviour the user sees. A step that only imports, mounts or calls that component names
it in its summary and leaves the frame to the step that built it. The plan page shows each frame
under the step that carries it, beside the code that draws it.

**Two list items name the frame and the spec**, each on its own line:

```markdown
   - **Design:** build to design/FILE at WIDTHpx
   - **Spec:** design/spec.md — PART · PART
```

The Design line names the frame and the width `design/INDEX.md` gives it. The Spec line names
every part of `design/spec.md` the surface must keep, in the spec's own words, on that one line.
The rule text stays in spec.md: implement and qa read those parts there and check them.

**The UI mapping follows the list items**, as a table with these columns:

```markdown
   | Element | Component | Use |
   |---|---|---|
```

One row per element the step's frames show. **Element** names what the user sees, in the frame's own
words. **Component** names the component that draws it: a component from the repo with its
repo-relative file, a library component with its package name, or the new component this step
creates. **Use** is `reuse` when the component is taken as it is, `extend` when the diff changes it,
and `new` when this step builds it. The plan page shows the mapping under the step's frames, closed
until the reader opens it.

**The frame shows the screen; the diff builds it.** What the frame settles, its element order,
spacing, type, colour roles, component variants and copy, lands in the diff's code, never in a
prose description of the screen.

**Where no design exists, say so in the summary.** A surface with no design is one the developer
is authorized to invent.

## Register

Write each step the way you would say it to a colleague with the file already open. A step is
finished when a developer who was not in this conversation can act on it after one read.

**Open with an imperative verb**: Create · Change · Move · Delete · Add · Replace.

**Name the change, not the effect.**

| Instead of | Write |
|---|---|
| the avatar grows to 32px | Change it to 32 |
| leaves the memo stale | the memo returns stale output |
| copied as-is that ships a blank gap where the label belongs | if you copy it as-is, it prints a blank where the label should be |

## What earns a step

A step carries a new function's design, a new file's location, a change to an existing type or
signature, or an algorithm whose correctness is not obvious. A step that is only "modify X to do
Y" is mechanical: fold its diff into the step it serves. Steps are not a change list.

## One step

````markdown
2. **Reject duplicate emails in `src/services/user.ts:31 — createUser`**

   Stops a second account being created for an email that is already registered. `createUser`
   now checks for the address first and refuses with `DuplicateError`, so the caller can tell
   the user the email is taken. Sign-up with a new email works as before.

   `src/services/user.ts:31-33`

   ```diff
   @@ -31,3 +31,4 @@
    export async function createUser(email: string, name: string) {
   +  if (await findByEmail(email)) throw new DuplicateError(email)
      const user = await users.insert({ email, name })
   ```

   Use `findByEmail` rather than catching the unique-index error: the constraint error does not
   say which column collided.
````
