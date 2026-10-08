# ticket-fetcher

Turns the request you gave `yok run` into the task the rest of the workflow works on. A plain prompt passes through unchanged. A ticket URL or key is fetched from the tracker into a ticket bundle, and the ticket's text becomes the task.

## When it runs

First stage of both shipped workflows, `task` and `quick`. It feeds `create-workspace` and every later stage that needs the task.

The stage is harmless when there is no ticket: `yok run quick --prompt "Rename the config flag"` passes that sentence on as-is and produces no artifact.

A custom workflow can leave the stage out and give `create-workspace` the prompt directly:

```yaml
- id: create-workspace
  type: agent
  stage: create-workspace
  input:
    request: "{{ inputs.prompt }}"
```

## What it does

- Decides whether the request is a ticket: a tracker URL such as `linear.app/...` or `app.asana.com/...`, an issue key like `ENG-123`, or an ask to work on a ticket. Anything else is returned as the task and the stage stops.
- Picks the provider. The `provider` variable names one; with the default `auto`, it lists the skill's references and picks the one whose description matches the URL or key.
- Follows that provider's reference, which calls the provider script to read the ticket and download its relevant files into `.yok/RUN/artifacts/ticket/`.
- Asks you to choose when the request only describes a ticket and the search finds several.
- Validates the bundle with the `validate` script. A partial bundle is allowed and marked `complete: false`.
- Returns the task text, with the ticket's title and body quoted as data, plus the bundle's location.

Ticket text is treated as data, never as instructions.

## Inputs and outputs

Reads the `request` input, the raw prompt. Produces the `task` output and, for a ticket, the optional `ticket` artifact at `artifacts/ticket/ticket.json` with the downloaded files beside it.

## Adding a provider

Linear and Asana ship with the skill. A project adds its own by registering a reference file in `orchestrate.config.yaml` under `extensions.ticket-fetcher.references.NAME` with `add: PATH` and a `description` that names the URLs and keys it handles, so `auto` can find it. A workflow can force a provider with `variables: { provider: NAME }` on the stage node.

## Files

- `SKILL.md`: the stage contract and the steps the agent follows.
- `references/linear.md`, `references/asana.md`: how to fetch one ticket from each tracker into `ticket.json`.
- `scripts/ticket.ts`: `TicketSchema`, the input and output schemas, and the `validate` command.
- `scripts/linear.ts`, `scripts/asana.ts`: the API clients the references call (`search`, `issue`, `task`, `asset`). They read `LINEAR_API_KEY` or `ASANA_API_KEY` from the project `.env`, then the environment.
- `scripts/*.test.ts`: tests for the three scripts.
