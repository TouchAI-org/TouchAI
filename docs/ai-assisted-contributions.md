# AI-Assisted Contributions

TouchAI allows AI-assisted contributions, including code, tests, documentation, issues, RFC drafts, and pull request text.

This is a permissive policy, not a relaxed quality bar. The human submitter remains fully responsible for correctness, architecture impact, licensing risk, test coverage, and reviewability.

## Core rules

### 1. Human review is mandatory

- Review every AI-assisted change yourself before asking maintainers to review it.
- Be able to explain the `why`, `what`, and `how` of the change without relying on the AI tool.
- Re-run the relevant tests and verify that the change fixes the real problem instead of hiding it or bypassing checks.

If you cannot confidently explain or verify the result, do not submit it.

### 2. Stay inside the existing architecture by default

- Prefer small, focused edits that follow the current layering, naming, and ownership boundaries.
- Do not add new services, abstractions, entities, state machines, schemas, storage layers, or generic frameworks unless they are clearly necessary.
- Do not let an AI assistant rewrite large blocks of working code just because it can.

For TouchAI, review cost and architecture churn matter more than AI output volume.

### 3. New architecture is still RFC-first

AI assistance does not change the existing escalation path.

If the work introduces a new architecture, new cross-boundary abstraction, schema/migration rewrite, or a meaningful change to core system shape, open an RFC first and wait for agreement before implementation.

The following areas remain `RFC-first` even when AI tools are involved:

- `AgentService`
- conversation runtime
- tool execution
- session persistence
- context construction
- instruction loading
- agent orchestration
- MCP integration
- database schema and migrations

AI may help draft the RFC. It must not be used to bypass the RFC process.

### 4. Disclose material AI assistance for auditability

If AI tools materially shaped the submitted content, disclose that usage so maintainers can audit the contribution appropriately.

Preferred disclosure methods:

- Add an `AI assistance disclosure` section in the pull request description
- Add a commit trailer such as `Assisted-by: <tool or workflow>`

Your disclosure should state:

- which tools or workflows were used
- which parts of the contribution they materially affected
- what you personally reviewed or rewrote before submission

If your team workflow already uses `Co-authored-by:` for AI disclosure, also include a plain-language note in the pull request description so reviewers do not need to infer intent from commit metadata alone.

### 5. Do not submit bulk low-quality AI content

The project does not accept AI-assisted contribution spam.

The following are not acceptable:

- batch-submitting low-quality pull requests
- large repo-wide churn with weak justification
- unrelated rewrites mixed into a targeted fix
- copy-pasted AI issue reports, security reports, or review replies that you have not verified yourself
- using maintainers as the first meaningful review pass for AI output

Maintainers may close these contributions without detailed review. Repeated low-quality AI submissions may lead to a permanent ban from the project spaces.

### 6. No autonomous repository actions without human approval

Do not use autonomous agents to open pull requests, reply to review comments, or perform other repository actions without explicit human review and approval.

Every submitted PR, comment, and design decision must reflect a real human judgment.

## Recommended uses

AI tools are usually most helpful when they are used to assist, not replace, contributor judgment:

- learning the codebase
- drafting or polishing documentation
- translation and language cleanup
- generating small, reviewable edits inside existing patterns
- helping draft RFCs before human revision

## Review expectations

Maintainers may apply stricter review to AI-assisted contributions when appropriate. That can include requests for:

- smaller diffs
- clearer architecture justification
- stronger testing evidence
- more detailed explanation of provenance or prompts

If the contribution is not clearly worth the review cost, maintainers may decline it.