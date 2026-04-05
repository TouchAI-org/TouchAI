/**
 * SearchView 输入层。
 * 统一承载草稿、附件与 QuickSearch 的输入侧编排，保持输入业务收敛。
 */
import { readClipboard, type ReadClipboardItem } from 'tauri-plugin-clipboard-x-api';
import { computed, type Ref, ref, watch } from 'vue';

import {
    type AttachmentSupportStatus,
    createAttachment,
    type Index,
    isAttachmentSupported,
} from '@/services/AgentService/infrastructure/attachments';
import type { SessionMessage } from '@/types/session';

import type {
    SearchCursorContext,
    SearchModelCapabilities,
    SearchModelDropdownState,
    SearchModelOverride,
    SearchPageController,
} from '../types';

interface UseSearchAttachmentsOptions {
    attachments?: Ref<Index[]>;
}

interface UseSearchDraftControllerOptions {
    queryText: Ref<string>;
    modelOverride: Ref<SearchModelOverride>;
    clearAttachments: () => void;
    importClipboardAttachments: () => Promise<Index[]>;
}

interface UseQuickSearchCoordinatorOptions {
    queryText: Ref<string>;
    attachments: Ref<Index[]>;
    sessionHistory: Ref<SessionMessage[]>;
    cursorContext: Ref<SearchCursorContext>;
    modelOverride: Ref<SearchModelOverride>;
    modelDropdownState: Ref<SearchModelDropdownState>;
    quickSearchOpen: Ref<boolean>;
    controller: SearchPageController;
}

/**
 * 搜索页附件输入层。
 * 负责维护附件列表、模型能力对应的支持状态，以及剪贴板导入。
 *
 * @returns 附件状态与附件域相关操作。
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

    /**
     * 根据模型能力刷新附件支持状态，确保页面展示与后续提交校验一致。
     *
     * @param capabilities 当前模型能力。
     * @returns void
     */
    function handleModelChange(capabilities: SearchModelCapabilities) {
        modelCapabilities.value = capabilities;
        syncAttachmentSupport();
    }

    /**
     * 从当前输入草稿中移除一个附件。
     *
     * @param id 附件 ID。
     * @returns 是否找到并移除了该附件。
     */
    function removeAttachment(id: string) {
        const index = attachments.value.findIndex((attachment) => attachment.id === id);
        if (index === -1) {
            return false;
        }

        attachments.value.splice(index, 1);
        return true;
    }

    /**
     * 清空当前输入草稿中的全部附件。
     *
     * @returns void
     */
    function clearAttachments() {
        attachments.value = [];
    }

    /**
     * 获取当前可随请求提交的附件集合。
     *
     * @returns 支持的附件列表。
     */
    function getSupportedAttachments() {
        return attachments.value.filter(isAttachmentSupported);
    }

    /**
     * 生成当前附件集合的提交前校验提示文案。
     *
     * @returns 若存在不支持附件则返回提示，否则返回 null。
     */
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

        let message = '当前模型不支持';
        if (hasUnsupportedImage && hasUnsupportedFile) {
            message += '图片和文件';
        } else if (hasUnsupportedImage) {
            message += '图片';
        } else {
            message += '文件';
        }
        return `${message}，请移除不支持的附件或切换模型`;
    }

    async function createNormalizedAttachment(type: 'image' | 'file', path: string) {
        const attachment = await createAttachment(type, path);
        attachment.supportStatus = getAttachmentSupportStatus(attachment);
        return attachment;
    }

    /**
     * 从剪贴板读取图片和文件，并纳入当前输入草稿。
     *
     * @returns 本次新加入的附件列表。
     */
    async function importClipboardAttachments() {
        try {
            const clipboard: Partial<{
                text: { type: 'text'; value: string; count: number };
                rtf: { type: 'rtf'; value: string; count: number };
                html: { type: 'html'; value: string; count: number };
                image: ReadClipboardItem<'image'>;
                files: { type: 'files'; value: string[]; count: number };
            }> = await readClipboard();

            const createdAttachments: Index[] = [];

            if (clipboard.image) {
                createdAttachments.push(
                    await createNormalizedAttachment('image', clipboard.image.value)
                );
            }

            if (clipboard.files?.value?.length) {
                const createdFiles = await Promise.all(
                    clipboard.files.value.map((filePath) =>
                        createNormalizedAttachment('file', filePath)
                    )
                );
                createdAttachments.push(...createdFiles);
            }

            if (createdAttachments.length > 0) {
                attachments.value.push(...createdAttachments);
            }

            return createdAttachments;
        } catch (error) {
            console.error('[SearchView] Failed to import clipboard attachments:', error);
            return [];
        }
    }

    return {
        attachments,
        handleModelChange,
        removeAttachment,
        clearAttachments,
        getSupportedAttachments,
        getUnsupportedAttachmentMessage,
        importClipboardAttachments,
    };
}

/**
 * 搜索页草稿控制器。
 * 负责统一维护搜索词草稿，并在清理时同步收敛附件与 QuickSearch。
 *
 * @param options 页面 draft 与附件导入能力。
 * @returns 草稿清理与粘贴处理方法。
 */
export function useSearchDraftController(options: UseSearchDraftControllerOptions) {
    const { queryText, modelOverride, clearAttachments, importClipboardAttachments } = options;

    /**
     * 统一回收当前输入草稿。
     * 由页面直接改写受控 draft，再由 SearchBar 消费这些值去同步编辑器，
     * 避免页面清草稿时还要命令式穿透到子组件内部。
     *
     * @param options 可选的草稿清理策略。
     * @returns void
     */
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

    /**
     * 从剪贴板导入附件并写回页面 draft。
     * 编辑器标签由 SearchBar 消费受控 `attachments` 后自行投影，不再由页面手工调用子组件命令。
     *
     * @returns void
     */
    async function handlePaste() {
        await importClipboardAttachments();
    }

    return {
        clearDraft,
        handlePaste,
    };
}

/**
 * SearchView 中的 QuickSearch 协调层。
 * 负责集中判断何时允许展示 QuickSearch，并通过页面 controller
 * 统一驱动面板打开、关闭和结果刷新。
 *
 * @param options 搜索页状态与页面动作 controller。
 * @returns QuickSearch 状态、业务判定与页面事件处理函数。
 */
export function useQuickSearchCoordinator(options: UseQuickSearchCoordinatorOptions) {
    const {
        queryText,
        attachments,
        sessionHistory,
        cursorContext,
        modelOverride,
        modelDropdownState,
        quickSearchOpen,
        controller,
    } = options;

    const isQuickSearchOpen = computed(() => {
        return quickSearchOpen.value;
    });

    /**
     * 统一判断当前搜索上下文是否允许展示 QuickSearch。
     * SearchBar 只负责上报输入与模型下拉状态，具体业务约束由 SearchView 收口。
     *
     * @param query 当前输入内容。
     * @returns 满足 QuickSearch 展示条件时返回 true。
     */
    function shouldTriggerQuickSearch(query: string) {
        return (
            sessionHistory.value.length === 0 &&
            !modelDropdownState.value.isOpen &&
            !!query.trim() &&
            !cursorContext.value.isMultiLine &&
            !modelOverride.value.modelId &&
            attachments.value.length === 0
        );
    }

    /**
     * 根据顶层业务条件统一驱动 QuickSearch。
     * 允许显示时刷新结果，不允许时立即收敛面板，避免 SearchBar 与兄弟组件互相控制。
     *
     * @param query 可选的输入内容，缺省时使用当前搜索词。
     * @returns void
     */
    function syncQuickSearchPanel(query = queryText.value) {
        if (shouldTriggerQuickSearch(query)) {
            controller.triggerQuickSearch(query);
            return;
        }

        controller.closeQuickSearch();
    }

    watch(
        () => ({
            query: queryText.value,
            attachmentCount: attachments.value.length,
            sessionCount: sessionHistory.value.length,
            isMultiLine: cursorContext.value.isMultiLine,
            selectedModelId: modelOverride.value.modelId,
            isModelDropdownOpen: modelDropdownState.value.isOpen,
        }),
        ({ query }) => {
            syncQuickSearchPanel(query);
        },
        { flush: 'post' }
    );

    return {
        isQuickSearchOpen,
        shouldTriggerQuickSearch,
        syncQuickSearchPanel,
    };
}
