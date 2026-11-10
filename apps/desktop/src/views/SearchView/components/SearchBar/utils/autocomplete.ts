export interface AutocompleteCompletion {
    index: number;
    text: string;
    implicit: boolean;
}

export function resolveAutocompleteCompletion<T>(
    query: string,
    candidates: readonly T[],
    highlightedIndex: number,
    label: (candidate: T) => string,
    allowImplicit = true
): AutocompleteCompletion | null {
    const implicit = highlightedIndex < 0;
    const index = implicit ? 0 : highlightedIndex;
    const candidate = candidates[index];
    if (!candidate) return null;
    const name = label(candidate);
    const prefix = name.toLowerCase().startsWith(query.toLowerCase());
    if (implicit && (!allowImplicit || candidates.length !== 1 || !query || !prefix)) return null;
    return { index, text: prefix ? name.slice(query.length) : '', implicit };
}

export type AutocompleteDirection = 'up' | 'down' | 'left' | 'right';

export function handleAutocompleteKeyDown(
    event: KeyboardEvent,
    actions: {
        select: () => void;
        close: () => void;
        move: (direction: AutocompleteDirection) => boolean;
    }
): boolean {
    if (
        event.isComposing ||
        event.keyCode === 229 ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey
    )
        return false;

    const direction = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
    }[event.key] as AutocompleteDirection | undefined;
    if (direction) {
        if (!actions.move(direction) && direction !== 'up' && direction !== 'down') return false;
    } else if (event.key === 'Tab' || event.key === 'Enter') {
        if (!event.repeat) actions.select();
    } else if (event.key === 'Escape' || event.key === 'Esc') {
        actions.close();
    } else {
        return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
}
