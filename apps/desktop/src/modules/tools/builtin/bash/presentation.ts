export interface ParsedBashToolResult {
    shell: string | null;
    duration: string | null;
    output: string | null;
    compressed: boolean;
}

const EMPTY_BASH_OUTPUT_MARKERS = new Set([
    '[命令无输出]',
    '[No command output]',
    'No output',
    '[No output]',
]);

export function isEmptyBashOutputText(output: string | null | undefined): boolean {
    const normalizedOutput = output?.trim();
    return !normalizedOutput || EMPTY_BASH_OUTPUT_MARKERS.has(normalizedOutput);
}

export function parseBashToolResult(result?: string): ParsedBashToolResult {
    const raw = result?.trim();
    if (!raw) {
        return {
            shell: null,
            duration: null,
            output: null,
            compressed: false,
        };
    }

    const normalized = raw.replace(/\r\n/g, '\n');
    const splitIndex = normalized.indexOf('\n\n');
    const headerText = splitIndex >= 0 ? normalized.slice(0, splitIndex) : normalized;
    const outputText = splitIndex >= 0 ? normalized.slice(splitIndex + 2).trim() : null;
    const headerLines = headerText.split('\n');
    const meta: ParsedBashToolResult = {
        shell: null,
        duration: null,
        output: outputText,
        compressed: false,
    };
    let matchedHeader = false;

    for (const line of headerLines) {
        if (line.startsWith('Shell: ')) {
            meta.shell = line.slice('Shell: '.length).trim() || null;
            matchedHeader = true;
            continue;
        }

        if (line.startsWith('Duration: ')) {
            const value = line.slice('Duration: '.length).trim();
            meta.duration = value || null;
            matchedHeader = true;
        }

        if (line === 'Compressed: true') {
            meta.compressed = true;
            matchedHeader = true;
        }
    }

    if (!matchedHeader) {
        meta.output = normalized;
    }

    return meta;
}
