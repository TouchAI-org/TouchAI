function isCjk(codePoint: number): boolean {
    return (
        (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
        (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7af)
    );
}

/** Estimate tokens from the text's actual CJK and other character counts. */
export function estimateTokens(text: string): number {
    if (!text) {
        return 0;
    }

    let cjk = 0;
    let other = 0;
    for (const char of text) {
        if (isCjk(char.codePointAt(0) ?? 0)) {
            cjk += 1;
        } else {
            other += 1;
        }
    }

    return Math.ceil(cjk / 1.5 + other / 4);
}
