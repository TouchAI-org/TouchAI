export function reportedPointer(
    envelope: Record<string, unknown>
): { x: number; y: number } | undefined {
    const payload = envelope.structuredContent as Record<string, unknown> | undefined;
    const content = Array.isArray(envelope.content)
        ? envelope.content
              .map((item) => (typeof item?.text === 'string' ? item.text : ''))
              .join('\n')
        : '';
    const text =
        typeof payload?.summary === 'string'
            ? payload.summary
            : `${content}\n${JSON.stringify(payload ?? {})}`;
    const points = [
        ...text.matchAll(
            /(?:screen\s*|to (?:Chromium )?pid \d+ at\s*)\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)(?:\s*→\s*\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\))?/g
        ),
    ];
    const point = points[points.length - 1];
    return point ? { x: Number(point[3] ?? point[1]), y: Number(point[4] ?? point[2]) } : undefined;
}
