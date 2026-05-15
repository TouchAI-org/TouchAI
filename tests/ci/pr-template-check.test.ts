import { describe, expect, it } from 'vitest';

async function loadValidator(): Promise<((body: string) => string | null) | undefined> {
    try {
        const module = await import('../../scripts/ci/pr-template-check.js');
        return module.validatePrTemplateBody as (body: string) => string | null;
    } catch {
        return undefined;
    }
}

describe('validatePrTemplateBody', () => {
    it('accepts multiline issue references in the Related issue or RFC section', async () => {
        const validatePrTemplateBody = await loadValidator();
        const body = `## Summary

Describe the change and the user-facing impact.

## Related issue or RFC

Link the issue or RFC:

- Closes #123
- Related to #456

## AI assistance disclosure

- Tool(s) used: Codex

## Testing evidence

\`\`\`text
pnpm test:run
\`\`\`

## Risk notes

- none

## Screenshots or recordings

None.

## Checklist

- [x] ready`;

        expect(validatePrTemplateBody).toBeTypeOf('function');
        expect(validatePrTemplateBody?.(body)).toBeNull();
    });

    it('reports missing issue references when the Related issue or RFC section has no links', async () => {
        const validatePrTemplateBody = await loadValidator();
        const body = `## Summary

Describe the change and the user-facing impact.

## Related issue or RFC

Link the issue or RFC:

## AI assistance disclosure

- Tool(s) used: Codex

## Testing evidence

\`\`\`text
pnpm test:run
\`\`\`

## Risk notes

- none

## Screenshots or recordings

None.

## Checklist

- [x] ready`;

        expect(validatePrTemplateBody).toBeTypeOf('function');
        expect(validatePrTemplateBody?.(body)).toBe(
            '"## Related issue or RFC" must include an issue, RFC, or repository link.'
        );
    });
});
