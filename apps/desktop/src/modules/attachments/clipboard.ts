export type ClipboardPayloadFragment =
    | {
          type: 'text';
          text: string;
      }
    | {
          type: 'image';
          path: string;
      }
    | {
          type: 'file';
          path: string;
      };

export interface ClipboardHtmlImage {
    source: string;
    path: string | null;
}

export interface ClipboardPayload {
    snapshotId: string;
    observedAt: number;
    text: string | null;
    html?: string | null;
    htmlSourceUrl?: string | null;
    htmlImages?: ClipboardHtmlImage[];
    imagePaths: string[];
    filePaths: string[];
    fragments?: ClipboardPayloadFragment[];
}

export interface ClipboardDraftApi {
    readExplicitPastePayload(clipboardData?: Pick<DataTransfer, 'getData' | 'items' | 'files'> | null): Promise<ClipboardPayload | null>;
    consumeShortcutAutoPastePayload(maxAgeMs: number): Promise<ClipboardPayload | null>;
    createAttachment(type: 'image' | 'file', path: string): Promise<import('./types').AttachmentIndex>;
}
