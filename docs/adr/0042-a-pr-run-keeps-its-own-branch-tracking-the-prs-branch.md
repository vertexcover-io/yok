---
status: active
date: 2026-11-05
source: docs/prd-github-pr-bot.md, .yok/github-pr-bot/artifacts/design.md
tags: [create-workspace-stage, implement-stage, shipped-workflows, sdk]
---

# A run on an open pull request keeps its own local branch, tracking the PR's branch, and pushes onto it

## Context and Problem Statement

Every run used to create a fresh branch off base, named after the run; `pr-fix` must instead add commits to a pull request's existing branch. Git checks a branch out in one worktree at a time, and two `/yok` comments on one PR are allowed to run side by side.

## Considered Options

- A local branch named after the run, started from `origin/PR_BRANCH` and tracking it
- The worktree checks out the PR's branch under its own name
- The run pushes a new branch and opens a second pull request against the first

## Decision Outcome

Chosen: a run-named local branch that tracks the PR's branch, because it is the only option that gives two runs on one pull request a worktree each while every commit still lands on the reviewer's branch. Checking out the PR's own name fails the second run at `git worktree add`, and a second pull request splits the review. Stages push with `git push origin HEAD:PR_BRANCH`, never force.

## Consequences

A stage that pushes reads its target from the branch's upstream (`@{upstream}`), never from the local branch's name. With the push rule unchanged, the slower of two runs on one PR may fail at push once the faster one has moved the branch.
