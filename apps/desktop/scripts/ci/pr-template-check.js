import { pathToFileURL } from 'node:url';

const REQUIRED_HEADERS = [
    '## Summary',
    '## Related issue or RFC',
    '## AI assistance disclosure',
    '## Testing evidence',
    '## Risk notes',
    '## Screenshots or recordings',
    '## Checklist',
];

const ISSUE_REFERENCE_PATTERN =
    /(?:\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|related to)\s+#\d+\b|(?:^|\s)#\d+\b|TouchAI-org\/TouchAI#\d+\b|https:\/\/github\.com\/[^/\s]+\/[^/\s]+(?:\/(?:issues|pull|discussions)\/\d+)?\b)/im;

function normalizeBody(body) {
    return body.replace(/\r\n/g, '\n');
}

export function extractMarkdownSection(body, header) {
    const normalizedBody = normalizeBody(body);
    const headerIndex = normalizedBody.indexOf(header);
    if (headerIndex < 0) {
        return null;
    }

    const sectionStart = headerIndex + header.length;
    const remainder = normalizedBody.slice(sectionStart);
    const nextHeaderIndex = remainder.search(/\n## /);
    const section = nextHeaderIndex < 0 ? remainder : remainder.slice(0, nextHeaderIndex);

    return section.trim();
}

export function validatePrTemplateBody(body) {
    for (const header of REQUIRED_HEADERS) {
        if (!body.includes(header)) {
            return `Missing required PR template section: ${header}`;
        }
    }

    const relatedSection = extractMarkdownSection(body, '## Related issue or RFC');
    if (relatedSection === null) {
        return 'Missing body for "## Related issue or RFC".';
    }

    if (!relatedSection) {
        return '"## Related issue or RFC" must not be empty.';
    }

    if (!ISSUE_REFERENCE_PATTERN.test(relatedSection)) {
        return '"## Related issue or RFC" must include an issue, RFC, or repository link.';
    }

    return null;
}

function main() {
    const body = process.env.PR_BODY ?? '';
    const error = validatePrTemplateBody(body);

    if (error) {
        console.error(error);
        process.exit(1);
    }

    console.log('PR template structure and linkage checks passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
