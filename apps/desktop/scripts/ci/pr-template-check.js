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
const RELEASE_PLEASE_HEAD_PREFIX = 'release-please--branches--';

function normalizeBody(body) {
    return body.replace(/\r\n/g, '\n');
}

function isReleasePleaseGeneratedBody(body) {
    const normalizedBody = normalizeBody(body).trim();

    return (
        normalizedBody.startsWith(':robot: I have created a release *beep* *boop*\n---') &&
        normalizedBody.includes(
            'This PR was generated with [Release Please](https://github.com/googleapis/release-please)'
        )
    );
}

function isReleasePleasePr(body, options) {
    return (
        options?.headRef?.startsWith(RELEASE_PLEASE_HEAD_PREFIX) &&
        isReleasePleaseGeneratedBody(body)
    );
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

export function validatePrTemplateBody(body, options = {}) {
    const normalizedBody = normalizeBody(body);

    if (isReleasePleasePr(normalizedBody, options)) {
        return null;
    }

    for (const header of REQUIRED_HEADERS) {
        if (!normalizedBody.includes(header)) {
            return `Missing required PR template section: ${header}`;
        }
    }

    const relatedSection = extractMarkdownSection(normalizedBody, '## Related issue or RFC');
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
    const error = validatePrTemplateBody(body, {
        headRef: process.env.PR_HEAD_REF ?? '',
    });

    if (error) {
        console.error(error);
        process.exit(1);
    }

    console.log('PR template structure and linkage checks passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
