## What and why

<!-- What does this change, and why? Link the issue it fixes, for example "Fixes #123". -->

## How it was tested

<!-- Commands you ran, and anything reviewers should try. -->

## Checklist

- [ ] Tests added or updated, and they pass locally for every SDK this touches.
- [ ] Docs, docstrings and examples updated for any change users can see.
- [ ] The PR title and commits follow [Conventional Commits](https://www.conventionalcommits.org/), with an SDK scope where it applies. Breaking changes are marked with `!`. The changelog is generated from them, so no `CHANGELOG.md` was edited by hand.
- [ ] If `spec/` changed: generated files were regenerated with the tools in `tools/`, the SDK copies were refreshed, and every SDK's tests pass.
- [ ] Shared behaviour (retries, errors, streaming, key handling) matches the ADRs in `docs/adr/`, or this PR adds a new ADR.
- [ ] `python3 tools/check_public.py` prints `nothing private found`.
- [ ] No API keys, webhook secrets, signed links or internal details in code, tests, fixtures or this description.
