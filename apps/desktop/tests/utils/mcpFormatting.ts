import { vi } from 'vitest';

import { createPersistedAttachmentFromData } from '@/modules/attachments';
import { createMcpFormatting } from '@/modules/tools';

import { toolMessages } from './toolMessages';

const filesystem = vi.hoisted(() => ({ files: new Map<string, Uint8Array>() }));
export const mcpResultFiles = filesystem.files;

vi.mock('@tauri-apps/api/path', async (original) => ({
    ...(await original<typeof import('@tauri-apps/api/path')>()),
    join: async (...parts: string[]) => parts.join('/'),
}));
vi.mock('@tauri-apps/plugin-fs', async (original) => ({
    ...(await original<typeof import('@tauri-apps/plugin-fs')>()),
    mkdir: async () => undefined,
    exists: async (path: string) => filesystem.files.has(path),
    writeFile: async (path: string, bytes: Uint8Array) => {
        filesystem.files.set(path, Uint8Array.from(bytes));
    },
}));
vi.mock('tauri-plugin-fs-pro-api', () => ({ icon: async () => '/fixture/icon.png' }));

export const mcpFormatting = createMcpFormatting(toolMessages, {
    create: createPersistedAttachmentFromData,
});
