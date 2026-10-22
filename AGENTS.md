# Repository Workflow

## Commit and Push Validated Changes

The repository owner explicitly requests that all validated changes be committed and pushed to `https://github.com/Yvonick/FrankenDraftTool` as part of the task. Do not finish with validated changes existing only in a local checkout or the separate Sites source repository.

- Honor any newer instruction to pause, keep changes local, or avoid committing/pushing.
- Inspect the working tree and fetch the GitHub remote before integrating changes. Preserve unrelated work and untracked files; stage only files belonging to the task.
- Run `npm test` and `npm run build` using Node.js 24. For UI changes, also perform focused browser checks when available. Report validation limits or failures; do not describe untested changes as validated.
- Keep the README and relevant documentation aligned with behavior. Use descriptive commit messages.
- Push the task's validated commits to the appropriate GitHub branch and verify the remote commit. Continue using the repository's current branch workflow; never force-push or discard upstream/user changes to make a push succeed.
- If a push or required check fails, explain the blocker and preserve the work rather than silently skipping it.

## Sites and GitHub

- Production runs on Sites at `https://franken-draft-tool.yvonichou.chatgpt.site`; use the existing project ID from `.openai/hosting.json` and preserve its audience and runtime secrets.
- Sites publication and GitHub synchronization are separate operations. After validating changes in a Sites checkout, integrate that source history into the GitHub checkout and push it as well.
- Before working from an older Sites checkout, compare it with GitHub and retain newer validated code and repository documentation. Do not let a stale checkout erase updates.
- Documentation-only GitHub maintenance does not require redeploying an unchanged application.
- Never commit credentials, the archive password, `.env` values, local databases, uploaded user pools, generated build output, or unrelated working notes. `.sites-runtime/` is local-only.
- Never edit deployed SQL migrations. Change `db/schema.ts` and generate a new migration with `npm run db:generate`.
