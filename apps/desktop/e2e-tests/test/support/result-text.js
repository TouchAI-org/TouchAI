/** Runs in the renderer so the measurement uses the product font and native DPI. */
export function measureGridResultText(names) {
    return [...document.querySelectorAll('.quick-search-grid [data-slot="result-item-label"]')]
        .filter((label) => names.includes(label.textContent.trim()))
        .map((label) => {
            const bounds = label.getBoundingClientRect();
            const item = label.closest('[data-slot="result-item"]').getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(label);
            const fragments = [...range.getClientRects()];
            return {
                name: label.textContent.trim(),
                top: bounds.top,
                bottom: bounds.bottom,
                itemTop: item.top,
                itemBottom: item.bottom,
                textTop: Math.min(...fragments.map((fragment) => fragment.top)),
                textBottom: Math.max(...fragments.map((fragment) => fragment.bottom)),
                lineCount: new Set(fragments.map((fragment) => fragment.top.toFixed(2))).size,
            };
        });
}

export function assertGridResultTextFits(measurements, names) {
    for (const name of names) {
        const item = measurements.find((measurement) => measurement.name === name);
        if (
            !item ||
            item.lineCount !== 2 ||
            item.textTop < item.top - 0.25 ||
            item.textBottom > item.bottom + 0.25 ||
            item.top < item.itemTop ||
            item.bottom > item.itemBottom
        ) {
            throw new Error(
                `Both filename lines must fit without clipping: ${JSON.stringify(item)}`
            );
        }
    }
}
