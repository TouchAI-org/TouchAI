import { computed, ref } from 'vue';

const FILE_TRIGGER = /(?:^|[\s\ufffc\p{Script=Han}，。；：（(])(@[^\s\ufffc@]*)$/u;
const FILE_INTENT = /(?:^|[\s\ufffc\p{Script=Han}，。；：（(])@/u;

interface FileTrigger {
    query: string;
    from: number;
    to: number;
    token: string;
}

export function containsFileQuery(text: string): boolean {
    return FILE_INTENT.test(text);
}

export function useFileAutocomplete() {
    const trigger = ref<FileTrigger | null>(null);
    let dismissed: string | null = null;

    function refresh(before: string, after: string, caret: number) {
        const match = before.match(FILE_TRIGGER);
        const token = match?.[1];
        if (!token) {
            trigger.value = null;
            dismissed = null;
            return;
        }
        const suffix = after.match(/^[^\s\ufffc@]*/)![0];
        const next = {
            query: token.slice(1),
            from: caret - token.length,
            to: caret + suffix.length,
            token: token + suffix,
        };
        trigger.value = JSON.stringify(next) === dismissed ? null : next;
    }

    function close() {
        if (trigger.value) dismissed = JSON.stringify(trigger.value);
        trigger.value = null;
    }

    function reset() {
        trigger.value = null;
        dismissed = null;
    }

    return { trigger, query: computed(() => trigger.value?.query ?? null), refresh, close, reset };
}
