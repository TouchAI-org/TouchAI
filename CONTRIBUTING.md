# Contributing to TouchAI

Thanks for your interest in contributing to TouchAI.

TouchAI is still evolving quickly. At this stage we prefer clean architecture over preserving outdated compatibility layers, and we prefer smaller, reviewable changes over large surprise pull requests.

## Before you start

Install the local toolchain first:

```bash
pnpm install
pnpm tauri dev
```

## Choose the right entry point

Use one of these paths before you write code:

- Documentation wording, link fixes, or comment-only cleanups: you can open a pull request directly.
- Any code fix or feature work: open an issue first, then send a pull request.
- High-risk architecture or schema changes: open an RFC issue first, wait for agreement, then send a pull request.

The following areas are always `RFC-first`:

- `AgentService`
- conversation runtime
- tool execution
- session persistence
- context construction
- instruction loading
- agent orchestration
- MCP integration
- database schema and migrations

If the work touches one of these areas without prior discussion, expect the pull request to be redirected back to an RFC.

## AI-assisted contributions

TouchAI allows AI-assisted contributions, but the responsibility stays with the human submitter.

- Review every AI-assisted change yourself before asking for review.
- Keep changes small, focused, and inside the existing architecture unless there is a clear reason not to.
- New architecture, cross-boundary abstractions, and existing `RFC-first` areas are still `RFC-first` even if AI helped draft the idea or code.
- Material AI assistance must be disclosed in the pull request description and/or commit metadata so the contribution can be audited.
- Do not use AI to mass-submit low-quality pull requests, issue spam, or unreviewed review replies.

Maintainers may close low-quality AI-assisted contributions without detailed review. Repeated low-quality AI submissions may lead to a permanent ban from the project spaces.

See [AI-assisted contributions](docs/ai-assisted-contributions.md) for the full policy.

## Branches, draft PRs, and review

TouchAI uses GitHub `Draft PR` as the only supported work-in-progress flow.

- Use a `Draft PR` for large or still-evolving work.
- Do not use `[WIP]`, `[DO NOT MERGE]`, or similar title prefixes.
- Convert the PR to `Ready for review` only when you want a real review pass.
- Draft PRs still run CI, so open them early if you want integration feedback.

## Commit messages and PR titles

TouchAI uses `squash merge`, so the pull request title becomes the final commit on `main`.

Both commit messages and PR titles must follow Conventional Commits, for example:

```text
feat(agent-service): recover background tasks after restart
fix(database): reset drizzle baseline for development schema
docs(contributing): clarify RFC-first workflow
```

Rules:

- Allowed types: `feat`, `fix`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `perf`, `revert`
- Use lowercase types
- Keep the subject non-empty
- Do not end the subject with a period
- Keep the header concise

Local hooks check commit messages, and CI checks both commit messages and PR titles.

## Self-assigning work

TouchAI supports lightweight self-assignment on eligible issues.

- Comment `/assign` on an open issue to claim it for yourself.
- Comment `/unassign` to release it.
- Claims are allowed only on issues labeled `good first issue`, `help wanted`, or `status:accepted`.
- RFC issues are discussion records and cannot be claimed.

To keep a claim active, leave a visible progress update in the issue thread within 7 days. If a claimed issue stays inactive for 14 days, the claim may be released automatically so someone else can pick it up.

## Before opening a pull request

Run the checks that CI expects:

```bash
pnpm type:check
pnpm lint:check
pnpm format:check
pnpm test:run
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --manifest-path src-tauri/Cargo.toml --all-targets
```

## Pull request checklist

A good pull request should:

- link the related issue or RFC
- explain the user-facing impact
- stay focused on one problem
- include screenshots when UI changes are involved
- include tests or explain why tests are not appropriate
- explain database schema impact, baseline resets, or migration rewrites when relevant
- update docs when behavior changes
- disclose material AI assistance when AI tools materially shaped the submitted content

## Reporting bugs, asking for help, and security

- Bugs and accepted feature work belong in GitHub Issues.
- Usage questions and general help belong in GitHub Discussions once enabled, or the support channel listed in `SUPPORT.md`.
- Security issues must not be reported in public issues. Follow `SECURITY.md`.