/**
 * SearchView 输入层。
 * 统一承载草稿与附件输入编排，保持输入业务收敛。
 */
import { type Ref, ref } from 'vue';

import { t } from '@/i18n';
import {
    type AttachmentSupportStatus,
    createAttachment,
    type Index,
    isAttachmentSupported,
} from '@/services/AgentService/infrastructure/attachments';
import { clipboardService } from '@/services/ClipboardService';
import type { ClipboardPayload } from '@/services/NativeService/types';

import type { SearchModelCapabilities, SearchModelOverride } from '../types';
import { applyClipboardPayloadToDraft } from '../utils/clipboardDraft';

interface UseSearchAttachmentsOptions {
    attachments?: Ref<Index[]>;
}

interface UseSearchDraftControllerOptions {
    queryText: Ref<string>;
    attachments: Ref<Index[]>;
    modelOverride: Ref<SearchModelOverride>;
    clearAttachments: () => void;
    createAttachmentFromClipboardPath: (type: 'image' | 'file', path: string) => Promise<Index>;
}

interface ImportClipboardPayloadOptions {
    trimTextBoundary?: boolean;
}

/**
 * 搜索页附件输入层。
 * 负责维护附件列表、模型能力对应的支持状态，以及剪贴板导入。
 */
export function useSearchAttachments(options: UseSearchAttachmentsOptions = {}) {
    const attachments = options.attachments ?? ref<Index[]>([]);
    const modelCapabilities = ref<SearchModelCapabilities>({
        supportsImages: false,
        supportsFiles: false,
    });

    function getAttachmentSupportStatus(attachment: Index): AttachmentSupportStatus {
        if (attachment.type === 'image' && !modelCapabilities.value.supportsImages) {
            return 'unsupported-image';
        }
        if (attachment.type === 'file' && !modelCapabilities.value.supportsFiles) {
            return 'unsupported-file';
        }
        return 'supported';
    }

    function syncAttachmentSupport() {
        attachments.value.forEach((attachment) => {
            attachment.supportStatus = getAttachmentSupportStatus(attachment);
        });
    }

    function handleModelChange(capabilities: SearchModelCapabilities) {
        modelCapabilities.value = capabilities;
        syncAttachmentSupport();
    }

    function removeAttachment(id: string) {
        const index = attachments.value.findIndex((attachment) => attachment.id === id);
        if (index === -1) {
            return false;
        }

        attachments.value.splice(index, 1);
        return true;
    }

    function clearAttachments() {
        attachments.value = [];
    }

    function getSupportedAttachments() {
        return attachments.value.filter(isAttachmentSupported);
    }

    function getUnsupportedAttachmentMessage() {
        const unsupported = attachments.value.filter(
            (attachment) => !isAttachmentSupported(attachment)
        );
        if (unsupported.length === 0) {
            return null;
        }

        const hasUnsupportedImage = unsupported.some(
            (attachment) => attachment.supportStatus === 'unsupported-image'
        );
        const hasUnsupportedFile = unsupported.some(
            (attachment) => attachment.supportStatus === 'unsupported-file'
        );

        if (hasUnsupportedImage && hasUnsupportedFile) {
            return t('conversation.attachment.unsupportedImageAndFile');
        }
        if (hasUnsupportedImage) {
            return t('conversation.attachment.unsupportedImage');
        }
        return t('conversation.attachment.unsupportedFile');
    }

    async function createNormalizedAttachment(type: 'image' | 'file', path: string) {
        const attachment = await createAttachment(type, path);
        attachment.supportStatus = getAttachmentSupportStatus(attachment);
        return attachment;
    }

    return {
        attachments,
        handleModelChange,
        syncAttachmentSupport,
        createAttachmentFromClipboardPath: createNormalizedAttachment,
        removeAttachment,
        clearAttachments,
        getSupportedAttachments,
        getUnsupportedAttachmentMessage,
    };
}

/**
 * 搜索页草稿控制器。
 * 负责统一维护搜索词草稿，并在清理时同步收敛附件。
 */
export function useSearchDraftController(options: UseSearchDraftControllerOptions) {
    const {
        queryText,
        attachments,
        modelOverride,
        clearAttachments,
        createAttachmentFromClipboardPath,
    } = options;

    function clearDraft(options?: { preserveModelTag?: boolean }) {
        queryText.value = '';
        clearAttachments();
        if (!options?.preserveModelTag) {
            modelOverride.value = {
                modelId: null,
                providerId: null,
            };
        }
    }

    async function importClipboardPayload(
        payload: ClipboardPayload,
        options: ImportClipboardPayloadOptions = {}
    ) {
        await applyClipboardPayloadToDraft(
            payload,
            {
                queryText,
                attachments,
                appendText: (current, next) =>
                    [current, next].filter(Boolean).join(current ? '\n' : ''),
                createAttachment: createAttachmentFromClipboardPath,
            },
            options
        );
    }

    async function handlePaste() {
        const payload = await clipboardService.readExplicitPastePayload();
        if (!payload) {
            return;
        }

        await importClipboardPayload(payload, { trimTextBoundary: true });
    }

    return {
        clearDraft,
        handlePaste,
        importClipboardPayload,
    };
}
