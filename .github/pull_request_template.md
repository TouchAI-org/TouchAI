## Summary

Describe the change and the user-facing impact.

## Related issue or RFC

Link the issue or RFC:

- Closes #
- Related to #

For code changes, link the tracking issue. Only documentation wording, link fixes, or comment-only cleanups may skip the issue-first flow.

## Testing evidence

List the commands you ran and the results you observed.

```text
pnpm type:check
pnpm lint:check
pnpm format:check
pnpm test:run
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --manifest-path src-tauri/Cargo.toml --all-targets
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
- [ ] If this touches `AgentService`, runtime, MCP, or schema boundaries, there is an accepted RFC.
- [ ] I added tests or explained why tests are not appropriate.
- [ ] I updated docs when behavior changed.
