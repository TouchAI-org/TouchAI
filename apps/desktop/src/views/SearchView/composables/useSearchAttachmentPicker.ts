import { onUnmounted, type Ref, ref, watch } from 'vue';

import { t } from '@/i18n';
import type { Index } from '@/services/AgentService/infrastructure/attachments';
import { log } from '@/services/ObservabilityService';
import { isImagePath } from '@/utils/path';

interface AttachmentPickerOptions {
    openFiles: () => Promise<string[] | null>;
    createAttachment: (type: 'image' | 'file', path: string) => Promise<Index>;
    insertAttachment: (attachment: Index) => void;
    draftVersion: Ref<number>;
}

export function useSearchAttachmentPicker(options: AttachmentPickerOptions) {
    const busy = ref(false);
    const error = ref('');
    let disposed = false;
    onUnmounted(() => {
        disposed = true;
    });
    watch(
        options.draftVersion,
        () => {
            error.value = '';
        },
        { flush: 'sync' }
    );

    async function pickAttachments() {
        if (busy.value || disposed) return;
        const version = options.draftVersion.value;
        const isCurrent = () => !disposed && version === options.draftVersion.value;
        busy.value = true;
        error.value = '';
        try {
            const paths = await options.openFiles();
            for (const path of paths ?? []) {
                if (!isCurrent()) return;
                try {
                    const attachment = await options.createAttachment(
                        isImagePath(path) ? 'image' : 'file',
                        path
                    );
                    if (!isCurrent()) return;
                    options.insertAttachment(attachment);
                } catch (cause) {
                    if (isCurrent()) error.value = t('search.toolbar.attachmentFailed');
                    log.error('[SearchView] Failed to add attachment:', cause);
                }
            }
        } catch (cause) {
            if (isCurrent()) error.value = t('search.toolbar.attachmentFailed');
            log.error('[SearchView] Failed to open attachment picker:', cause);
        } finally {
            busy.value = false;
        }
    }

    return { busy, error, pickAttachments };
}
