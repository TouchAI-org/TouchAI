/** Runs in the native renderer; a DOM-only test cannot establish intrinsic sizing. */
export function measureResultPanel(testId) {
    const panel = document.querySelector(`[data-testid="${testId}"]`);
    const viewport = panel.querySelector('[data-slot="result-panel-viewport"]');
    const rows = [...viewport.querySelectorAll('[data-slot="result-item"]')].map((row) =>
        row.getBoundingClientRect()
    );
    const style = getComputedStyle(viewport);
    const contentHeight =
        Math.max(...rows.map((row) => row.bottom)) - Math.min(...rows.map((row) => row.top));
    return {
        count: rows.length,
        rowCount: new Set(rows.map((row) => row.top)).size,
        viewportHeight: viewport.getBoundingClientRect().height,
        contentHeight:
            contentHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
        panelHeight: panel.getBoundingClientRect().height,
        maxPanelHeight: parseFloat(getComputedStyle(panel).maxHeight),
    };
}

export function assertContentSizedResultPanel(measurement) {
    if (
        !measurement.count ||
        Math.abs(measurement.viewportHeight - measurement.contentHeight) > 1
    ) {
        throw new Error(
            `Short results must fit their content without empty rows: ${JSON.stringify(measurement)}`
        );
    }
    if (measurement.panelHeight > measurement.maxPanelHeight + 1) {
        throw new Error(
            `Results must remain within their height budget: ${JSON.stringify(measurement)}`
        );
    }
}

export function measureCompactSkillRows() {
    const panel = document.querySelector('[data-testid="skill-picker-panel"]');
    const viewport = panel.querySelector('[role="listbox"]').getBoundingClientRect();
    const rows = [...panel.querySelectorAll('[role="option"]')];
    const center = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.top + rect.height / 2;
    };
    return {
        height: panel.getBoundingClientRect().height,
        visibleRows: viewport.height / rows[0].getBoundingClientRect().height,
        names: rows.map((row) =>
            row.querySelector('[data-slot="result-item-label"]').textContent.trim()
        ),
        iconCount: panel.querySelectorAll('[data-slot="result-item-icon"]').length,
        badgeOffsets: rows.map(
            (row) => center(row.querySelector('[data-slot="skill-scope"]')) - center(row)
        ),
        partialRows: rows.filter((row) => {
            const rect = row.getBoundingClientRect();
            return (
                rect.bottom > viewport.top + 0.5 &&
                rect.top < viewport.bottom - 0.5 &&
                (rect.top < viewport.top - 0.5 || rect.bottom > viewport.bottom + 0.5)
            );
        }).length,
    };
}

export function recordResultPanelExpansion() {
    return new Promise((resolve, reject) => {
        const frames = [];
        let previousHeight = 0;
        let stableFrames = 0;
        const started = performance.now();
        function sample() {
            const card = document.querySelector('[data-testid="search-view-card"]');
            const bounds = card.getBoundingClientRect();
            frames.push({
                card: bounds.toJSON(),
                input: document
                    .querySelector('[data-testid="search-bar"]')
                    .getBoundingClientRect()
                    .toJSON(),
                footer: document
                    .querySelector('[data-slot="result-panel-footer"]')
                    .getBoundingClientRect()
                    .toJSON(),
            });
            stableFrames = Math.abs(bounds.height - previousHeight) < 0.1 ? stableFrames + 1 : 0;
            previousHeight = bounds.height;
            if (
                stableFrames >= 10 &&
                performance.now() - started > 400 &&
                !card.getAnimations().length
            ) {
                resolve(frames);
                return;
            }
            if (performance.now() - started > 5000) {
                reject(new Error('Result expansion did not settle'));
                return;
            }
            requestAnimationFrame(sample);
        }
        sample();
        document
            .querySelector('[data-slot="result-panel-viewport"]')
            .dispatchEvent(
                new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })
            );
    });
}
