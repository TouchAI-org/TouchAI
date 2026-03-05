import { join } from '@tauri-apps/api/path';

import { paths } from './paths';

const DATABASE_FILE_NAME = 'touchai.db';

export const database = {
    /**
     * 获取数据库文件路径
     * @returns 数据库文件的完整路径
     */
    async getDatabasePath(): Promise<string> {
        const dataDirectory = await paths.getAppDirectoryPath('DATA');
        return join(dataDirectory, DATABASE_FILE_NAME);
    },
} as const;
