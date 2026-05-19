# Planning Artifact Cleanup — End-to-end verification

**Status:** Verification artifact
**Date:** 2026-05-19
**Branch:** `verify/planning-artifact-cleanup-e2e`

## Why this file exists

This document exists only as a deliberate planning artifact, placed
under `docs/superpowers/` to trigger the
`Planning Artifact Cleanup` workflow after the PR introducing it lands
on `main`. Successful end-to-end behaviour, with **no human
intervention** between the merge of this PR and the merge of the
auto-generated cleanup PR, demonstrates that the two recent fixes work
together:

1. **#688** — `gh pr view --json isInMergeQueue` is no longer used to
   probe merge-queue state; the workflow goes straight to the GraphQL
   API, which is not subject to `gh` CLI version drift on
   `ubuntu-latest` runners.
2. **#690** — After `gh pr create` opens the cleanup PR with
   `GITHUB_TOKEN`, the workflow now pushes an empty commit through the
   deploy-key-authenticated remote so `pull_request: synchronize` fires
   under a real identity. Required checks such as CodeQL react to that
   event and report on the cleanup PR, which lets the merge queue
   dequeue automatically.

## Expected behaviour

1. This PR merges via the standard merge queue.
2. The push to `main` fires `planning-artifact-cleanup.yml`.
3. The workflow detects this file under `docs/superpowers/`, removes
   it on a cleanup branch, opens a new PR, pushes an empty kick
   commit, polls merge-queue state via GraphQL, and enqueues.
4. CodeQL runs against the kick commit, all required checks pass, and
   the cleanup PR lands on `main` without anyone touching the queue.

If the cleanup PR ends up parked in `AWAITING_CHECKS`, one of the two
fixes regressed and the workflow needs another look.

## Out of scope

This file does not describe any product change. It is removed by the
follow-up cleanup PR as soon as that PR lands; no behaviour in the app
depends on it.
