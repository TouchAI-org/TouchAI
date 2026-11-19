import { native } from '@/platform/native';
import { awaitAbortable } from '@/utils/abort';

import type { ClipboardDraftApi, ClipboardPayload, ClipboardPayloadFragment } from './clipboard';
import { normalizeClipboardPayload } from './clipboardHtml';
import { createAttachment, createPersistedAttachmentFromData } from './storage.io';

export function createClipboardDrafts() {
    const lifetime = new AbortController();
    let lastAutoPasteSnapshotId: string | null = null;

    async function readExplicitPastePayload(
        clipboardData?: Pick<DataTransfer, 'getData' | 'items' | 'files'> | null
    ): Promise<ClipboardPayload | null> {
        const eventPayload = buildPayloadFromPasteEvent(clipboardData);

        try {
            const nativePayload = await awaitAbortable(
                native.clipboard.readClipboardPayload,
                lifetime.signal
            );
            const mergedPayload = mergeExplicitPastePayloads(nativePayload, eventPayload);
            return normalizeClipboardPayload(
                await withPasteEventAttachments(mergedPayload, clipboardData),
                {
                    preservePlainText: true,
                }
            );
        } catch {
            lifetime.signal.throwIfAborted();
            return normalizeClipboardPayload(
                await withPasteEventAttachments(eventPayload, clipboardData),
                {
                    preservePlainText: true,
                }
            );
        }
    }

    async function consumeShortcutAutoPastePayload(
        maxAgeMs: number
    ): Promise<ClipboardPayload | null> {
        const payload = await awaitAbortable(
            () => native.clipboard.consumeShortcutAutoPastePayload(maxAgeMs),
            lifetime.signal
        );
        if (!payload) {
            return null;
        }

        if (payload.snapshotId === lastAutoPasteSnapshotId) {
            return null;
        }

        lastAutoPasteSnapshotId = payload.snapshotId;
        return normalizeClipboardPayload(payload);
    }

    function buildPayloadFromPasteEvent(
        clipboardData?: Pick<DataTransfer, 'getData' | 'items' | 'files'> | null
    ): ClipboardPayload | null {
        const text = readPasteEventData(clipboardData, 'text/plain');
        const html = readPasteEventData(clipboardData, 'text/html');
        const fileCount = readClipboardEventFiles(clipboardData).length;

        if (!text && !html && fileCount === 0) {
            return null;
        }

        const observedAt = Date.now();
        return {
            snapshotId: `paste-event-${hashClipboardText(
                [text, html, fileCount > 0 ? `files:${fileCount}` : ''].filter(Boolean).join('\n')
            )}`,
            observedAt,
            text,
            html,
            htmlSourceUrl: null,
            htmlImages: [],
            imagePaths: [],
            filePaths: [],
            fragments: text ? [{ type: 'text', text }] : [],
        };
    }

    function readPasteEventData(
        clipboardData: Pick<DataTransfer, 'getData'> | null | undefined,
        type: string
    ) {
        const value = clipboardData?.getData(type)?.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        return value && value.length > 0 ? value : null;
    }

    function clipboardPayloadHasAttachmentData(payload: ClipboardPayload): boolean {
        return Boolean(
            payload.imagePaths.length ||
            payload.filePaths.length ||
            payload.fragments?.some((fragment) => fragment.type !== 'text')
        );
    }

    async function withPasteEventAttachments(
        payload: ClipboardPayload | null,
        clipboardData?: Pick<DataTransfer, 'items' | 'files'> | null
    ): Promise<ClipboardPayload | null> {
        if (!payload || clipboardPayloadHasAttachmentData(payload)) {
            return payload;
        }

        const attachments = await readPasteEventAttachments(clipboardData);
        if (!attachments.imagePaths.length && !attachments.filePaths.length) {
            return payload;
        }

        return {
            ...payload,
            imagePaths: attachments.imagePaths,
            filePaths: attachments.filePaths,
            fragments: [
                ...(payload.fragments ?? []),
                ...buildAttachmentFragments(attachments.imagePaths, attachments.filePaths),
            ],
        };
    }

    async function readPasteEventAttachments(
        clipboardData?: Pick<DataTransfer, 'items' | 'files'> | null
    ): Promise<{ imagePaths: string[]; filePaths: string[] }> {
        const files = readClipboardEventFiles(clipboardData);
        if (!files.length) {
            return { imagePaths: [], filePaths: [] };
        }

        const persisted = await Promise.all(files.map((file) => persistClipboardEventFile(file)));
        return persisted.reduce(
            (result, attachment) => {
                if (!attachment) {
                    return result;
                }

                if (attachment.type === 'image') {
                    result.imagePaths.push(attachment.path);
                } else {
                    result.filePaths.push(attachment.path);
                }
                return result;
            },
            { imagePaths: [] as string[], filePaths: [] as string[] }
        );
    }

    function readClipboardEventFiles(
        clipboardData?: Pick<DataTransfer, 'items' | 'files'> | null
    ): File[] {
        const itemFiles = Array.from(clipboardData?.items ?? [])
            .filter((item) => item.kind === 'file')
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);
        if (itemFiles.length > 0) {
            return itemFiles;
        }

        return Array.from(clipboardData?.files ?? []);
    }

    async function persistClipboardEventFile(file: File): Promise<{
        type: 'image' | 'file';
        path: string;
    } | null> {
        const type = file.type.startsWith('image/') ? 'image' : 'file';
        const name = resolveClipboardEventFileName(file, type);

        try {
            const data = new Uint8Array(
                await awaitAbortable(() => file.arrayBuffer(), lifetime.signal)
            );
            lifetime.signal.throwIfAborted();
            const attachment = await awaitAbortable(
                () =>
                    createPersistedAttachmentFromData({
                        type,
                        name,
                        originPath: `clipboard:${name}`,
                        mimeType: file.type || undefined,
                        size: file.size,
                        data,
                    }),
                lifetime.signal
            );

            return {
                type,
                path: attachment.path,
            };
        } catch {
            lifetime.signal.throwIfAborted();
            return null;
        }
    }

    function resolveClipboardEventFileName(file: File, type: 'image' | 'file') {
        const trimmedName = file.name.trim();
        if (trimmedName) {
            return trimmedName;
        }

        return type === 'image' ? 'pasted-image' : 'pasted-file';
    }

    function mergeExplicitPastePayloads(
        nativePayload: ClipboardPayload | null,
        eventPayload: ClipboardPayload | null
    ): ClipboardPayload | null {
        if (!nativePayload) {
            return eventPayload;
        }
        if (!eventPayload) {
            return nativePayload;
        }

        return {
            ...nativePayload,
            snapshotId: eventPayload.snapshotId,
            observedAt: eventPayload.observedAt,
            text: eventPayload.text ?? nativePayload.text,
            html: eventPayload.html ?? nativePayload.html,
        };
    }

    function buildAttachmentFragments(
        imagePaths: string[],
        filePaths: string[]
    ): ClipboardPayloadFragment[] {
        return [
            ...imagePaths.map((path) => ({ type: 'image', path }) as ClipboardPayloadFragment),
            ...filePaths.map((path) => ({ type: 'file', path }) as ClipboardPayloadFragment),
        ];
    }

    function hashClipboardText(value: string) {
        let hash = 5381;
        for (let index = 0; index < value.length; index += 1) {
            hash = (hash * 33) ^ value.charCodeAt(index);
        }

        return (hash >>> 0).toString(16);
    }

    const api = Object.freeze<ClipboardDraftApi>({
        readExplicitPastePayload,
        consumeShortcutAutoPastePayload,
        createAttachment: (type, path) =>
            awaitAbortable(() => createAttachment(type, path), lifetime.signal),
    });
    return Object.freeze({
        api,
        dispose() {
            lifetime.abort();
            lastAutoPasteSnapshotId = null;
        },
    });
}
