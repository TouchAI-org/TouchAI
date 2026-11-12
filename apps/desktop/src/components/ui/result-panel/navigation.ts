export type ResultDirection = 'up' | 'down' | 'left' | 'right';

export function nextResultIndex(
    current: number,
    count: number,
    direction: ResultDirection,
    columns = 1,
    allowEmptySelection = true
): number | null {
    if (!count) return null;
    if (current < 0) return direction === 'down' ? 0 : null;
    const stride = Math.max(columns, 1);
    switch (direction) {
        case 'up':
            return current < stride ? (allowEmptySelection ? -1 : current) : current - stride;
        case 'down':
            return Math.min(current + stride, count - 1);
        case 'left':
            return Math.max(current - 1, 0);
        case 'right':
            return Math.min(current + 1, count - 1);
    }
}

export function resultExpansionAfterNavigation({
    expanded,
    currentIndex,
    nextIndex,
    direction,
    collapsedRows,
    columns = 1,
}: {
    expanded: boolean;
    currentIndex: number;
    nextIndex: number;
    direction: ResultDirection;
    collapsedRows: number;
    columns?: number;
}): boolean {
    const firstBatchSize = collapsedRows * Math.max(columns, 1);
    if (direction === 'up' && nextIndex < firstBatchSize && nextIndex < currentIndex) {
        return false;
    }
    if (direction === 'down' && nextIndex >= firstBatchSize && nextIndex > currentIndex) {
        return true;
    }
    return expanded;
}

export function revealResultRange(
    viewport: HTMLElement,
    top: number,
    bottom: number,
    padding: number
) {
    if (viewport.clientHeight <= 0) return;
    let next = viewport.scrollTop;
    if (top < next + padding) next = top - padding;
    else if (bottom > next + viewport.clientHeight - padding) {
        next = bottom - viewport.clientHeight + padding;
    }
    const max = Math.max(viewport.scrollHeight - viewport.clientHeight, 0);
    next = Math.min(Math.max(next, 0), max);
    if (Math.abs(viewport.scrollTop - next) > 0.5) viewport.scrollTop = next;
}
