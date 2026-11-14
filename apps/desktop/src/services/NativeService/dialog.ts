import { open } from '@tauri-apps/plugin-dialog';

export const dialog = {
    openAttachmentFiles(): Promise<string[] | null> {
        return open({ multiple: true, directory: false });
    },
} as const;
