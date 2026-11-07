import { ref } from 'vue';

interface UseSearchPanelInteractionOptions {
    onFirstStart?: () => void;
    onLastEnd?: () => void;
}

export function useSearchPanelInteraction(options: UseSearchPanelInteractionOptions) {
    const active = ref(false);
    let depth = 0;

    function begin() {
        depth += 1;
        active.value = true;
        if (depth === 1) options.onFirstStart?.();
    }

    function end() {
        if (depth === 0) return;
        depth -= 1;
        active.value = depth > 0;
        if (depth === 0) options.onLastEnd?.();
    }

    return { active, begin, end };
}
