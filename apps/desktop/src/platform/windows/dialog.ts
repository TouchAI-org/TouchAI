import { open } from '@tauri-apps/plugin-dialog';

async function pick(
    directory: boolean,
    options: { defaultPath?: string; title: string }
): Promise<string | null> {
    const result = await open({ directory, multiple: false, ...options });
    return typeof result === 'string' ? result : null;
}
export const pickDirectory = (options: { defaultPath?: string; title: string }) =>
    pick(true, options);
export const pickFile = (options: { defaultPath?: string; title: string }) => pick(false, options);
