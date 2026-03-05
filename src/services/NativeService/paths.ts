import { invoke } from '@tauri-apps/api/core';

export type AppDirectoryKey = 'DATA' | 'LOGS' | 'CACHE' | 'CACHE_ICONS' | 'ASSETS' | 'ASSETS_FONT';

export const paths = {
    /**
     * 获取应用指定目录的绝对路径
     */
    getAppDirectoryPath(directory: AppDirectoryKey): Promise<string> {
        return invoke<string>('get_app_directory_path', { directory });
    },
} as const;
