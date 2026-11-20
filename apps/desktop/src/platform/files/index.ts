export { convertFileSrc } from '@tauri-apps/api/core';
export {
    appCacheDir,
    appDataDir,
    basename,
    desktopDir,
    dirname,
    extname,
    isAbsolute,
    join,
    resolve,
    tempDir,
} from '@tauri-apps/api/path';
export type { DirEntry, FileHandle, FileInfo } from '@tauri-apps/plugin-fs';
export {
    copyFile,
    exists,
    mkdir,
    open,
    readDir,
    readFile,
    readTextFile,
    readTextFileLines,
    remove,
    rename,
    stat,
    writeFile,
    writeTextFile,
} from '@tauri-apps/plugin-fs';
export { fullName, icon, size } from 'tauri-plugin-fs-pro-api';
