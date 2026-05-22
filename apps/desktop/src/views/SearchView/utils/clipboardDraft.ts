import type { Ref } from 'vue';

import type { ClipboardPayload, ClipboardPayloadFragment } from '@/services/NativeService/types';

interface DraftTarget<TAttachment> {
    queryText: Ref<string>;
    attachments: Ref<TAttachment[]>;
    appendText: (current: string, next: string) => string;
    createAttachment: (type: 'image' | 'file', path: string) => Promise<TAttachment>;
}

interface ApplyClipboardPayloadOptions {
    trimTextBoundary?: boolean;
}

const TEXT_BOUNDARY_SPACING =
    /^[\s\u00a0\u1680\u180e\u2000-\u200f\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]+|[\s\u00a0\u1680\u180e\u2000-\u200f\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]+$/g;

/**
 * 判断当前草稿是否允许执行 auto-paste。
 */
export function canAutoPasteIntoDraft(input: {
    queryText: string;
    attachmentCount: number;
    sessionMessageCount: number;
    hasModelOverride: boolean;
}) {
    return (
        !input.queryText.trim() &&
        input.attachmentCount === 0 &&
        input.sessionMessageCount === 0 &&
        !input.hasModelOverride
    );
}

/**
 * 将剪贴板 payload 投影到搜索草稿。
 */
export async function applyClipboardPayloadToDraft<TAttachment>(
    payload: ClipboardPayload,
    target: DraftTarget<TAttachment>,
    options: ApplyClipboardPayloadOptions = {}
) {
    //1. auto-paste/显式粘贴先统一做边界 trim，后续分支消费同一份 payload。
    const normalizedPayload = options.trimTextBoundary
        ? trimClipboardPayloadTextBoundary(payload)
        : payload;

    //2. 有 fragments 时按 HTML 原始顺序投影，避免图片永远被追加到草稿末尾。
    if (normalizedPayload.fragments?.length) {
        await applyOrderedClipboardFragmentsToDraft(normalizedPayload, target);
        return;
    }

    if (normalizedPayload.text?.trim()) {
        target.queryText.value = target.appendText(target.queryText.value, normalizedPayload.text);
    }

    const createdAttachments = await Promise.all([
        ...normalizedPayload.imagePaths.map((path) => target.createAttachment('image', path)),
        ...normalizedPayload.filePaths.map((path) => target.createAttachment('file', path)),
    ]);

    if (createdAttachments.length > 0) {
        target.attachments.value.push(...createdAttachments);
    }
}

/**
 * 按 HTML fragment 顺序投影文本和附件。
 */
async function applyOrderedClipboardFragmentsToDraft<TAttachment>(
    payload: ClipboardPayload,
    target: DraftTarget<TAttachment>
) {
    //1. 先把所有文本片段合并进草稿，得到可用于 offset 计算的纯文本基准。
    const text = payload.fragments
        ?.filter((fragment) => fragment.type === 'text')
        .map((fragment) => fragment.text)
        .join('');

    const currentText = target.queryText.value;
    if (text?.trim()) {
        target.queryText.value = target.appendText(currentText, text);
    }

    const insertionBase = resolveInsertedTextOffset(
        currentText,
        target.queryText.value,
        text ?? ''
    );
    let textOffset = 0;
    const attachments: TAttachment[] = [];

    //2. 再按片段顺序给附件写入 draftInsertionOffset，由 SearchBar 把标签插回原位置。
    for (const fragment of payload.fragments ?? []) {
        if (fragment.type === 'text') {
            textOffset += fragment.text.length;
            continue;
        }

        const attachment = await target.createAttachment(fragment.type, fragment.path);
        setDraftInsertionOffset(attachment, insertionBase + textOffset);
        attachments.push(attachment);
    }

    if (attachments.length > 0) {
        target.attachments.value.push(...attachments);
    }
}

/**
 * 计算本次插入文本在最终草稿中的起点。
 */
function resolveInsertedTextOffset(currentText: string, nextText: string, insertedText: string) {
    if (!insertedText) {
        return nextText.length;
    }

    const offset = nextText.lastIndexOf(insertedText);
    if (offset >= 0) {
        return offset;
    }

    return currentText.length;
}

/**
 * 为附件写入草稿文本插入位置。
 */
function setDraftInsertionOffset<TAttachment>(attachment: TAttachment, offset: number) {
    (attachment as TAttachment & { draftInsertionOffset?: number }).draftInsertionOffset = offset;
}

/**
 * 裁剪剪贴板 payload 的首尾空白。
 */
function trimClipboardPayloadTextBoundary(payload: ClipboardPayload): ClipboardPayload {
    if (payload.fragments?.length) {
        return {
            ...payload,
            text: trimTextBoundary(payload.text) || null,
            fragments: trimClipboardFragmentTextBoundary(payload.fragments),
        };
    }

    return {
        ...payload,
        text: trimTextBoundary(payload.text) || null,
    };
}

/**
 * 裁剪文本首尾空白和不可见空白字符。
 */
function trimTextBoundary(text: string | null | undefined) {
    return text?.replace(TEXT_BOUNDARY_SPACING, '') ?? '';
}

/**
 * 裁剪 fragment 首尾文本片段的边界空白。
 */
function trimClipboardFragmentTextBoundary(
    fragments: ClipboardPayloadFragment[]
): ClipboardPayloadFragment[] {
    //1. 只裁剪首尾文本片段的外侧空白，保留中间文字和图片之间的相对间距。
    const normalizedFragments = fragments.map((fragment) =>
        fragment.type === 'text' ? { ...fragment } : fragment
    );
    const firstTextIndex = normalizedFragments.findIndex((fragment) => fragment.type === 'text');
    const lastTextIndex = findLastTextFragmentIndex(normalizedFragments);

    if (firstTextIndex === -1 || lastTextIndex === -1) {
        return normalizedFragments;
    }

    const firstText = normalizedFragments[firstTextIndex];
    if (firstText?.type === 'text') {
        firstText.text = firstText.text.replace(
            /^[\s\u00a0\u1680\u180e\u2000-\u200f\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]+/,
            ''
        );
    }

    const lastText = normalizedFragments[lastTextIndex];
    if (lastText?.type === 'text') {
        lastText.text = lastText.text.replace(
            /[\s\u00a0\u1680\u180e\u2000-\u200f\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]+$/,
            ''
        );
    }

    //2. 移除被裁空的文本片段，避免空白片段干扰后续 offset 投影。
    return normalizedFragments.filter(
        (fragment) => fragment.type !== 'text' || fragment.text.length > 0
    );
}

/**
 * 查找最后一个文本 fragment 的位置。
 */
function findLastTextFragmentIndex(fragments: ClipboardPayloadFragment[]) {
    for (let index = fragments.length - 1; index >= 0; index -= 1) {
        if (fragments[index]?.type === 'text') {
            return index;
        }
    }

    return -1;
}
