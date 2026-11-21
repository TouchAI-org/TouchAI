import { computed, onBeforeUnmount, type Ref, ref, watch } from 'vue';

import { log } from '@/app/api/diagnostics';
import { hashPrivacyText } from '@/app/api/privacy';
import { usePrivacyStore } from '@/stores/privacy';

export function usePrivacyAnnotations(messageId: Ref<number | undefined>, text: Ref<string>) {
    const privacy = usePrivacyStore();
    const textHash = ref('');
    let sequence = 0;
    watch(
        [messageId, text, () => privacy.hasPrivacyAnnotations(messageId.value)],
        async ([id, value]) => {
            const request = ++sequence;
            textHash.value = '';
            if (!id || !value || !privacy.hasPrivacyAnnotations(id)) return;
            const generation = privacy.reviewGeneration;
            try {
                const hash = await hashPrivacyText(value);
                if (request === sequence && generation === privacy.reviewGeneration) {
                    textHash.value = hash;
                }
            } catch {
                log.warn('[PrivacyProtection] Could not verify annotated text');
            }
        },
        { immediate: true }
    );
    onBeforeUnmount(() => {
        sequence += 1;
    });
    return computed(() =>
        privacy.selectPrivacyAnnotations(messageId.value, text.value, textHash.value)
    );
}
