> First external contributors may need to complete the `CLA Assistant` check before merge.
> For code changes, this PR must link the related issue or RFC in the section below.

## Summary

Describe the change and the user-facing impact.

## Related issue or RFC

Link the issue or RFC:

- Closes #
- Related to #

For code changes, link the tracking issue. Only documentation wording, link fixes, or comment-only cleanups may skip the issue-first flow.

## AI assistance disclosure

If AI tools materially assisted this contribution, disclose that here or point to the relevant commit trailer.

- Tool(s) used:
- Scope of assistance:
- Human review or rewrite performed:
- Architecture or boundary impact:

## Testing evidence

List the commands you ran and the results you observed.

- Every code PR: `pnpm test:pr` (includes type check, lint, format, all tests, and frontend coverage)
- Rust behavior / test changes: `pnpm test:coverage:rust` (requires cargo-tarpaulin, or rely on CI)
- Desktop startup / window / search / popup / settings / E2E harness / workflow changes: `pnpm test:e2e`
- If any command could not run locally, state the exact blocker and rely on CI evidence before merge.

Did you follow TDD (test-first) for feature and fix work? Strongly recommended. See [docs/testing/testing.md](../docs/testing/testing.md).

```text
pnpm test:pr
pnpm test:coverage:rust
pnpm test:e2e
```

## Risk notes

- `AgentService`, runtime, MCP, or schema impact:
- database baseline or migration impact:
- release or packaging impact:

## Screenshots or recordings

Include UI evidence here when the change affects the interface.

## Checklist

- [ ] The PR title follows Conventional Commits and is valid for squash merge.
- [ ] This PR is either ready for review or explicitly marked as a Draft PR.
- [ ] I did not use `[WIP]` or similar title prefixes.
- [ ] If AI materially assisted this PR, I disclosed the tools and scope and I personally reviewed every affected change.
- [ ] I can explain the why, what, and how of this change without relying on an AI tool.
- [ ] If this touches `AgentService`, runtime, MCP, or schema boundaries, there is an accepted RFC.
- [ ] If this changes architecture or adds a new cross-boundary abstraction, there is an accepted RFC.
- [ ] I ran `pnpm test:pr` for this code PR, or this is a docs-only change.
- [ ] If I changed Rust behavior or tests, I reviewed `pnpm test:coverage:rust` or relied on CI coverage evidence.
- [ ] If I changed desktop startup/window/search/popup/settings/E2E paths, I ran `pnpm test:e2e` locally or documented why CI is the first valid proof.
- [ ] I added tests or explained why tests are not appropriate.
- [ ] I updated docs when behavior changed.
