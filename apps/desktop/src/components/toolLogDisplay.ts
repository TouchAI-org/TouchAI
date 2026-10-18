interface BashOutputDisplay {
    shell: string;
    workingDirectory: string;
    exitCode: string;
    output: string;
}

export function parseBashLogOutput(output: string | null | undefined): BashOutputDisplay | null {
    if (!output) return null;

    const normalized = output.replace(/\r\n/g, '\n');
    const separator = normalized.indexOf('\n\n');
    if (separator < 0) return null;

    const lines = normalized.slice(0, separator).split('\n');
    if (
        (lines.length !== 4 && !(lines.length === 5 && lines[4] === 'Compressed: true')) ||
        !lines[0]?.startsWith('Shell: ') ||
        !lines[1]?.startsWith('Working directory: ') ||
        !lines[2]?.startsWith('Exit code: ') ||
        !/^Duration: \d+ms$/.test(lines[3] ?? '') ||
        !lines[0].slice('Shell: '.length).trim() ||
        !lines[1].slice('Working directory: '.length).trim()
    ) {
        return null;
    }

    return {
        shell: lines[0].slice('Shell: '.length),
        workingDirectory: lines[1].slice('Working directory: '.length),
        exitCode: lines[2].slice('Exit code: '.length),
        output: normalized.slice(separator + 2),
    };
}

export function parseBashLogInput(input: string): {
    command: string;
    workingDirectory: string | null;
} | null {
    try {
        const parsed: unknown = JSON.parse(input);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

        const args = parsed as Record<string, unknown>;
        if (typeof args.command !== 'string') return null;

        return {
            command: args.command,
            workingDirectory:
                typeof args.workingDirectory === 'string' ? args.workingDirectory : null,
        };
    } catch {
        return null;
    }
}
