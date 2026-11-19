import { inject, type InjectionKey } from 'vue';

import type { ClipboardDraftApi } from '@/modules/attachments/public';

export type {
    ClipboardDraftApi,
    ClipboardPayload,
    ClipboardPayloadFragment,
} from '@/modules/attachments/public';

export const clipboardDraftApiKey: InjectionKey<ClipboardDraftApi> = Symbol(
    'touchai.attachments.clipboard-drafts'
);

export function useClipboardDraftApi(): ClipboardDraftApi {
    const api = inject(clipboardDraftApiKey);
    if (!api) throw new Error('CLIPBOARD_DRAFT_HOST_UNAVAILABLE');
    return api;
}
