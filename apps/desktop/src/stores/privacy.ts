import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref, shallowRef } from 'vue';

import {
    type PrivacyFilterFailureAction,
    type PrivacyFilterSettings,
    usePrivacyApi,
} from '@/app/api/privacy';

/** The application owns the writer and review lifetime; the store only mirrors them. */
export const usePrivacyStore = defineStore('privacy', () => {
    const api = usePrivacyApi();
    const privacyFilterSettings = ref(api.getPrivacyFilterSettings());
    const privacyFilterModelId = ref(api.getPrivacyFilterModelId());
    const privacyFilterFailureAction = ref(api.getPrivacyFilterFailureAction());
    const review = shallowRef(api.getReviewSnapshot());
    let disposed = false;
    function mirror() {
        if (disposed) return;
        const next = api.getPrivacyFilterSettings();
        if (JSON.stringify(next) !== JSON.stringify(privacyFilterSettings.value))
            privacyFilterSettings.value = next;
        privacyFilterModelId.value = api.getPrivacyFilterModelId();
        privacyFilterFailureAction.value = api.getPrivacyFilterFailureAction();
    }
    const stopSettings = api.subscribeSettings(mirror);
    const stopReview = api.subscribeReview(() => {
        if (!disposed) review.value = api.getReviewSnapshot();
    });
    onScopeDispose(() => {
        disposed = true;
        stopSettings();
        stopReview();
    });
    async function initialize() {
        await api.initialize();
        mirror();
    }
    async function updatePrivacyFilterSettings(value: PrivacyFilterSettings) {
        await api.updatePrivacyFilterSettings(value);
        mirror();
    }
    async function updatePrivacyFilterModelId(
        value: Parameters<typeof api.updatePrivacyFilterModelId>[0]
    ) {
        await api.updatePrivacyFilterModelId(value);
        mirror();
    }
    async function updatePrivacyFilterFailureAction(value: PrivacyFilterFailureAction) {
        await api.updatePrivacyFilterFailureAction(value);
        mirror();
    }
    return {
        privacyFilterSettings,
        privacyFilterModelId,
        privacyFilterFailureAction,
        initialize,
        updatePrivacyFilterSettings,
        updatePrivacyFilterModelId,
        updatePrivacyFilterFailureAction,
        reviewGeneration: computed(() => review.value.generation),
        hasPrivacyAnnotations(id: number | undefined) {
            return !!id && review.value.annotations.some((entry) => entry.messageId === id);
        },
        selectPrivacyAnnotations(id: number | undefined, text: string, hash: string) {
            void review.value;
            return api.selectPrivacyAnnotations(id, text, hash);
        },
        selectRestoredPrivacyAnnotations(partId: string | undefined, text: string) {
            void review.value;
            return api.selectRestoredPrivacyAnnotations(partId, text);
        },
    };
});
