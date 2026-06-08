# Git workflow — souply-api / souply-app / souply-web

The same rules for all three repos. Read once; the goal is **never lose work and
never fight a conflict again.**

## The one rule

**Your local checkout lives on `dev`. Forever. You never check out `staging` or
`main` locally.**

- `dev` — the only branch you edit, commit, and push.
- `staging`, `main` — release pointers. They move **only on the remote**, via
  promotion (below). You never `git switch staging` / `git switch main`.

That single rule removes the entire class of pain you hit.

## Why — what actually went wrong

Traced from the reflog, every incident had the same shape:

1. You `git switch staging` locally to "deploy / merge".
2. That local `staging` was **stale** (12 commits behind origin) and had **no
   pre-commit guard** in souply-api, so edits + a `git reset` happened on it.
3. Switching back / pulling then meant stash dances and conflicts, and any
   **uncommitted** edit was one careless `reset --hard` away from gone.

So: stale release branch + uncommitted WIP + manual reset = "lost commits" and
conflicts. None of it happens if you stay on `dev` and commit often.

## Daily loop (per repo)

```fish
git switch dev          # you should already be here
git fetch
git pull --ff-only      # refuses if you've diverged — that's a feature, reconcile first
# ...work...
git add -A
git commit -m "feat: ..."   # commit small, commit OFTEN
git push                    # push often too
```

- **Never end a session with a dirty tree you care about.** Either commit, or
  `git stash push -m "what-this-is"` and note it. Uncommitted work is the only
  work git can't recover for you.
- `--ff-only` is deliberate: if it refuses, you have local commits that diverge
  from origin — push or reconcile them *before* layering new work on a stale base.

## Promote — entirely on the remote, no local checkout

dev → staging:
```fish
git push                                         # make sure origin/dev is current
gh pr create --base staging --head dev --fill
gh pr merge --merge
```

staging → main (protected branch):
```fish
gh pr create --base main --head staging --fill
gh pr merge --admin --merge
```

Then run your deploy. Local `staging`/`main` are never touched, so they can
never go stale or tangle.

(Solo-dev shortcut, if you ever want linear history instead of merge-commit PRs:
`git push origin dev:staging` fast-forwards remote staging to dev in one command
— only works while staging has no commits dev lacks.)

## Recovery — nothing committed is ever lost

- `git reflog` — every HEAD move for ~90 days. Undo a bad reset:
  `git reset --hard <sha-from-reflog>`.
- `git stash list` — your stashes. `git fsck --lost-found` — orphaned commits.
- Rule of thumb: **commit before any `reset`, `rebase`, or branch switch.** A
  commit always shows up in reflog; uncommitted changes do not.

## Never do

- ❌ `git switch staging` / `git switch main` to "just fix something".
- ❌ Commit on any branch other than `dev` (the pre-commit hook now blocks this
  in all three repos).
- ❌ `git reset --hard` while you have uncommitted changes you want.
- ❌ Let WIP sit uncommitted across a branch switch or a day.

## Guardrails installed

- `pre-commit` (all three repos): blocks commits on staging/main; warns if local
  dev is behind origin/dev.
- `commit-msg`: commitlint (header ≤100 chars, body lines ≤100, single-line ok).
