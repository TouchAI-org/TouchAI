interface FenceRange {
    start: number;
    end: number;
}

interface ActiveFence {
    marker: '`' | '~';
    length: number;
    start: number;
}

function getFencedCodeRanges(markdown: string): FenceRange[] {
    const ranges: FenceRange[] = [];
    let activeFence: ActiveFence | undefined;
    let lineStart = 0;

    while (lineStart < markdown.length) {
        const newlineIndex = markdown.indexOf('\n', lineStart);
        const hasNewline = newlineIndex !== -1;
        const lineEnd = hasNewline ? newlineIndex : markdown.length;
        const lineAfter = hasNewline ? newlineIndex + 1 : lineEnd;
        const rawLine = markdown.slice(lineStart, lineEnd);
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

        if (activeFence) {
            const closingFence = /^( {0,3})(`+|~+)[ \t]*$/.exec(line);
            const closingMarker = closingFence?.[2];
            if (
                closingMarker?.[0] === activeFence.marker &&
                closingMarker.length >= activeFence.length
            ) {
                ranges.push({ start: activeFence.start, end: lineAfter });
                activeFence = undefined;
            }
        } else {
            const openingFence = /^( {0,3})(`+|~+)(.*)$/.exec(line);
            const openingMarker = openingFence?.[2];
            const info = openingFence?.[3] ?? '';
            if (
                openingMarker &&
                openingMarker.length >= 3 &&
                (openingMarker[0] !== '`' || !info.includes('`'))
            ) {
                activeFence = {
                    marker: openingMarker[0] as '`' | '~',
                    length: openingMarker.length,
                    start: lineStart,
                };
            }
        }

        if (!hasNewline) {
            break;
        }
        lineStart = lineAfter;
    }

    if (activeFence) {
        ranges.push({ start: activeFence.start, end: markdown.length });
    }

    return ranges;
}

interface BacktickRun {
    start: number;
    length: number;
    nextIndex: number;
}

function readBacktickRun(markdown: string, start: number, end: number): BacktickRun | undefined {
    let nextIndex = start;
    while (nextIndex < end && markdown[nextIndex] === '`') {
        nextIndex += 1;
    }

    const runLength = nextIndex - start;
    let backslashCount = 0;
    for (let cursor = start - 1; cursor >= 0 && markdown[cursor] === '\\'; cursor -= 1) {
        backslashCount += 1;
    }

    const escaped = backslashCount % 2 === 1;
    const effectiveLength = runLength - Number(escaped);
    if (effectiveLength === 0) {
        return undefined;
    }

    return {
        start: start + Number(escaped),
        length: effectiveLength,
        nextIndex,
    };
}

function collectBacktickRuns(
    markdown: string,
    start: number,
    end: number,
    nextRunByStart: Map<number, number>
): void {
    const previousRunByLength = new Map<number, number>();
    let index = start;

    while (index < end) {
        if (markdown[index] !== '`') {
            index += 1;
            continue;
        }

        const run = readBacktickRun(markdown, index, end);
        index = run?.nextIndex ?? index + 1;
        if (!run) {
            continue;
        }

        const previousRun = previousRunByLength.get(run.length);
        if (previousRun !== undefined) {
            nextRunByStart.set(previousRun, run.start);
        }
        previousRunByLength.set(run.length, run.start);
    }
}
function getNextBacktickRuns(markdown: string, fences: FenceRange[]): Map<number, number> {
    const nextRunByStart = new Map<number, number>();
    let segmentStart = 0;

    for (const fence of fences) {
        collectBacktickRuns(markdown, segmentStart, fence.start, nextRunByStart);
        segmentStart = fence.end;
    }
    collectBacktickRuns(markdown, segmentStart, markdown.length, nextRunByStart);

    return nextRunByStart;
}

/** Returns whether math delimiters occur outside Markdown code spans and fences. */
export function hasMathDelimiterOutsideCode(markdown: string): boolean {
    const fences = getFencedCodeRanges(markdown);
    const nextRunByStart = getNextBacktickRuns(markdown, fences);
    let fenceIndex = 0;
    let index = 0;

    while (index < markdown.length) {
        const fence = fences[fenceIndex];
        if (fence && index >= fence.start) {
            index = fence.end;
            fenceIndex += 1;
            continue;
        }

        if (markdown[index] === '`') {
            const run = readBacktickRun(markdown, index, markdown.length);
            index = run?.nextIndex ?? index + 1;
            if (!run) {
                continue;
            }

            const closingRun = nextRunByStart.get(run.start);
            if (closingRun !== undefined) {
                index = closingRun + run.length;
            }
            continue;
        }
        if (markdown.startsWith('$$', index) || markdown.startsWith(String.raw`\[`, index)) {
            return true;
        }
        index += 1;
    }

    return false;
}
