# Select repos

Pick which repos from the `workspace` script's `info` go into a multi-repo workspace. You have
the input's `request` (what the run should do) and the `packages` list, where each entry has a
`name`, a `path` and sometimes a `description`.

The request rarely names every repo the change touches, so learn what each repo is before you
pick. For each package, read its `description`; when there is none, read the project's docs for
it or the repo's own `README.md`. Do not read source code to classify a repo.

Then pick every repo the change will touch. That includes the repo the request names, and also
any other repo that talks to it in the feature being fixed or changed. For example, when the
request says a sync from A to B fails, pick both A and B.

- **No request:** pick every repo, and say that you did because there was no request to judge by.
- **Borderline repo:** include it. An extra repo costs one setup run; a missing one stops a later
  stage until someone adds it.
- **No repo clearly matches:** pick all of them, and say so.

Pass the picked names to the `workspace` script's `create` as `--repos NAME1,NAME2`, so the
script runs with `create SPEC_NAME --run SPEC_NAME --repos NAME1,NAME2`. In the summary, say why
each repo was picked.

A later stage that finds it needs another repo adds it to the existing workspace by running the
`workspace` script with `add SPEC_NAME --repos NAME --run SPEC_NAME`.
