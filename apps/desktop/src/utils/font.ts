// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import { AppEvent, eventService } from '@services/EventService';
import { paths } from '@services/NativeService';
import { convertFileSrc } from '@tauri-apps/api/core';

/**
 * 字体文件名
 */
const FONT_FILENAME = 'SourceHanSerifSC-VF.ttf.woff2';

/**
 * 加载字体文件并注入 @font-face 规则
 */
async function injectFontFace(): Promise<void> {
    // 获取字体目录路径
    const fontDir = await paths.getAppDirectoryPath('ASSETS_FONT');

    // 构建字体文件的完整路径
    const fontPath = `${fontDir}\\${FONT_FILENAME}`;

    // 转换为前端可用的 URL
    const fontUrl = convertFileSrc(fontPath);

    // 动态注入 @font-face 规则
    const style = document.createElement('style');
    style.textContent = `
        @font-face {
            font-family: 'Source Han Serif SC';
            src: url('${fontUrl}') format('woff2-variations');
            font-weight: 200 900;
            font-style: normal;
            font-display: swap;
        }
    `;
    document.head.appendChild(style);

    console.log('Source Han Serif font loaded successfully from:', fontUrl);
}

/**
 * 初始化字体加载监听器
 *
 * 监听 Rust 后端发送的 `font:ready` 事件，
 * 收到事件后才加载字体文件。
 */
export function initializeFontLoader(): void {
    eventService
        .on(AppEvent.FONT_READY, async () => {
            try {
                await injectFontFace();
            } catch (error) {
                console.error('Failed to load Source Han Serif font:', error);
                // 字体加载失败不应阻止应用运行，只记录错误
            }
        })
        .catch((error) => {
            console.error('Failed to listen for font-ready event:', error);
        });
}
