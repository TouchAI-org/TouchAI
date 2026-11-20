import { tt } from '@/i18n';
import type { AttachmentIndex } from '@/modules/attachments/public';

export type { AttachmentSupportStatus, Index } from '@/modules/attachments/public';
export { buildAttachmentPromptMetas, isAttachmentSupported } from '@/modules/attachments/public';
export { convertFileSrc as attachmentPreviewUrl } from '@/platform/files';

export function getAttachmentSupportMessage(attachment: AttachmentIndex): string | null {
    if (attachment.supportStatus === 'unsupported-image') return tt('该模型不支持图片');
    if (attachment.supportStatus === 'unsupported-file') return tt('该模型不支持文件');
    return null;
}
