// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 历史消息里连续工具调用的折叠。
 *
 * 一条 assistant 消息可能连续调用十几个工具（每个卡带摘要、来源列表、耗时），
 * 消息级虚拟化救不了它：只要这条消息在视口内，就整体渲染。
 * 这里把「连续的工具调用」合并成一行摘要，展开时才挂载真实卡片。
 */

export interface ToolRunBlock<T> {
    kind: 'tool-run';
    id: string;
    parts: T[];
}

export interface SinglePartBlock<T> {
    kind: 'part';
    part: T;
}

export type RenderedBlock<T, K extends T = T> = ToolRunBlock<K> | SinglePartBlock<T>;

/**
 * 把连续的工具调用合并成块。
 *
 * @param parts 已渲染的部件序列。
 * @param options.isToolCall 判断某部件是否为工具调用（类型守卫，用于缩窄块内元素）。
 * @param options.getId 取部件 id（用于块的稳定 key）。
 * @param options.minRun 触发折叠的最小连续数量；小于该值时逐个渲染。
 * @returns 折叠后的块序列（保持原顺序）。
 */
export function groupToolRuns<T, K extends T = T>(
    parts: readonly T[],
    options: {
        isToolCall: (part: T) => part is K & T;
        getId: (part: T) => string;
        minRun: number;
    }
): RenderedBlock<T, K>[] {
    const blocks: RenderedBlock<T, K>[] = [];
    const minRun = Math.max(2, Math.floor(options.minRun));
    let run: K[] = [];

    const flushRun = () => {
        if (run.length === 0) {
            return;
        }

        if (run.length >= minRun) {
            blocks.push({
                kind: 'tool-run',
                id: `tool-run:${options.getId(run[0]!)}`,
                parts: run,
            });
        } else {
            for (const part of run) {
                blocks.push({ kind: 'part', part });
            }
        }

        run = [];
    };

    for (const part of parts) {
        if (options.isToolCall(part)) {
            run.push(part);
            continue;
        }

        flushRun();
        blocks.push({ kind: 'part', part });
    }

    flushRun();
    return blocks;
}
