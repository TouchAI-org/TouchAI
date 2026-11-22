// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * 会话内容块的视觉契约。
 *
 * tool 运行块和代码块是奶油色画布上的卡片：中性白或冷灰会读成「比页面更亮 /
 * 更灰」，而不是「页面里的一块内容」。这个文件把「暖色 tint + 暖色边 + 暖色
 * 投影」钉在语义 token 上，同时守住阅读画布本身不变。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const stylesDirectory = resolve(testDirectory, '../../src/styles');

const readStyle = (relativePath: string) =>
    readFileSync(resolve(stylesDirectory, relativePath), 'utf8');
const readAppFile = (relativePath: string) =>
    readFileSync(resolve(testDirectory, '../../', relativePath), 'utf8');

const primitiveCss = readStyle('tokens/primitive.css');
const semanticCss = readStyle('tokens/semantic.css');
const markdownCss = readStyle('markdown.css');
const toolCallSection = readAppFile(
    'src/views/SearchView/components/ConversationPanel/components/ToolCallSection.vue'
);

function tokenValue(source: string, token: string): string | undefined {
    return new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(source)?.[1]?.trim();
}

function resolveToken(token: string, depth = 0): string {
    if (depth > 8) {
        throw new Error(`var() chain too deep at ${token}`);
    }

    const declared = tokenValue(semanticCss, token) ?? tokenValue(primitiveCss, token) ?? undefined;
    if (!declared) {
        throw new Error(`Token not declared: ${token}`);
    }

    const reference = /^var\((--[a-zA-Z0-9-]+)\)$/.exec(declared);
    return reference ? resolveToken(reference[1]!, depth + 1) : declared;
}

function rgbTriplet(colour: string): [number, number, number] {
    const value = /#([0-9a-f]{6})/i.exec(colour)?.[1];
    if (!value) {
        throw new Error(`Expected a hex colour, received ${colour}`);
    }

    return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16)) as [
        number,
        number,
        number,
    ];
}

describe('user reads tool and code blocks on the warm conversation canvas', () => {
    it('user sees block cards tinted warm instead of neutral white', () => {
        const surface = rgbTriplet(resolveToken('--color-content-block-surface'));

        // 暖色：红 > 绿 > 蓝，与品牌棕色调一致。
        expect(surface[0]).toBeGreaterThan(surface[1]);
        expect(surface[1]).toBeGreaterThan(surface[2]);

        // 只在画布上走一小步：够分辨，又不抢正文。
        const canvas = rgbTriplet(resolveToken('--color-background'));
        expect(surface[0]).toBeLessThan(canvas[0]);
        expect(canvas[0] - surface[0]).toBeLessThanOrEqual(24);
    });

    it('user sees the code block and its header share one warm surface', () => {
        expect(markdownCss).toContain('background-color: var(--color-content-block-surface);');
        expect(markdownCss).toContain(
            'background-color: var(--color-content-block-surface) !important;'
        );
        expect(markdownCss).not.toContain('rgba(255, 255, 255, 0.96)');
    });

    it('user sees consecutive blocks separated by their own warm edge and elevation', () => {
        expect(markdownCss).toContain('border-color: var(--color-content-block-border);');
        expect(markdownCss).toContain('box-shadow: var(--shadow-content-block);');
        expect(markdownCss).toContain('margin: var(--touchai-flow-codeblock-y) 0;');

        expect(toolCallSection).toContain('border: 1px solid var(--color-content-block-border);');
        expect(toolCallSection).toContain('background: var(--color-content-block-surface);');
        expect(toolCallSection).toContain('box-shadow: var(--shadow-content-block);');
        // 面板里连续两条 tool 记录之间留出可见间隙。
        expect(toolCallSection).toContain('space-y-2');
        // 冷灰和中性白不能再回到这两个会话块上。
        expect(toolCallSection).not.toMatch(/rgba?\(\s*249,\s*250,\s*251/);
        expect(toolCallSection).not.toMatch(/rgba?\(\s*255,\s*255,\s*255/);
    });

    it('user keeps the reading canvas it already had', () => {
        expect(resolveToken('--color-background')).toBe('#fbfbf6');
        expect(tokenValue(semanticCss, '--color-markdown-surface-soft')).toBe(
            'rgba(251, 249, 245, 0.98)'
        );
    });
});
