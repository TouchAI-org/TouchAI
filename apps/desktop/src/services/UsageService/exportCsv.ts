// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { UsageCallRow, UsageFilter } from '@database/queries/usageStats';
import { getUsageCallPage } from '@database/queries/usageStats';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';

import { t } from '@/i18n';

/** 单次导出的上限，避免把整年明细拉进内存 */
const MAX_EXPORT_ROWS = 50_000;
const PAGE_SIZE = 500;

/** 导出取消（用户在保存对话框里点了取消） */
export class UsageExportCancelledError extends Error {
    readonly code = 'USAGE_EXPORT_CANCELLED';

    constructor() {
        super(t('settings.usage.export.cancelled'));
        this.name = 'UsageExportCancelledError';
    }
}

export function isUsageExportCancelledError(error: unknown): error is UsageExportCancelledError {
    return (
        error instanceof UsageExportCancelledError ||
        (typeof error === 'object' &&
            error !== null &&
            (error as { code?: unknown }).code === 'USAGE_EXPORT_CANCELLED')
    );
}

/** CSV 字段转义：含逗号、引号、换行时加引号并双写内部引号 */
function escapeCsvField(value: string | number | boolean | null | undefined): string {
    if (value === null || value === undefined) {
        return '';
    }

    const text = String(value);
    if (/[",\n\r]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }

    return text;
}

function toCsvLine(fields: Array<string | number | boolean | null | undefined>): string {
    return fields.map(escapeCsvField).join(',');
}

const HEADERS = [
    'created_at',
    'model',
    'provider',
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'reasoning_tokens',
    'cost_usd',
    'priced',
    'ttft_ms',
    'duration_ms',
    'finish_reason',
    'session',
    'error',
] as const;

function toCsvRow(row: UsageCallRow): string {
    return toCsvLine([
        row.createdAt,
        row.modelName,
        row.providerName,
        row.inputTokens,
        row.outputTokens,
        row.cacheReadTokens,
        row.cacheWriteTokens,
        row.reasoningTokens,
        // 微元 → 货币单位，保留 6 位，避免把极小成本压成 0
        (row.costMicros / 1_000_000).toFixed(6),
        row.priced ? 1 : 0,
        row.ttftMs,
        row.durationMs,
        row.finishReason,
        row.sessionTitle,
        row.errorMessage,
    ]);
}

/**
 * 把当前筛选下的调用账本导出为 CSV。
 *
 * 导出的是**账本明细**而不是聚合：聚合结果可以在表格软件里自行汇总，
 * 反过来则做不到。未定价调用的 `cost_usd` 留 0 且 `priced=0`，
 * 方便在外部用 `priced` 列排除，而不是把未知成本混进合计。
 *
 * @returns 写入的文件路径；用户取消时抛出 `UsageExportCancelledError`
 */
export async function exportUsageCallsCsv(
    filter: UsageFilter,
    onProgress?: (loaded: number, total: number) => void
): Promise<string> {
    const targetPath = await save({
        defaultPath: buildDefaultFileName(),
        filters: [{ name: 'CSV', extensions: ['csv'] }],
        title: t('settings.usage.export.dialogTitle'),
    });

    if (!targetPath) {
        throw new UsageExportCancelledError();
    }

    const lines: string[] = [toCsvLine([...HEADERS])];

    let offset = 0;
    while (offset < MAX_EXPORT_ROWS) {
        const page = await getUsageCallPage(filter, offset, PAGE_SIZE);
        const total = page.total;

        if (page.rows.length === 0) {
            break;
        }

        for (const row of page.rows) {
            lines.push(toCsvRow(row));
        }

        offset += page.rows.length;
        onProgress?.(offset, Math.min(total, MAX_EXPORT_ROWS));

        if (offset >= total) {
            break;
        }
    }

    // BOM 让 Excel 正确识别 UTF-8，否则中文模型名会乱码
    await writeTextFile(targetPath, `\uFEFF${lines.join('\r\n')}\r\n`);

    return targetPath;
}

function buildDefaultFileName(): string {
    const now = new Date();
    const stamp = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
    ].join('');

    return `touchai-usage-${stamp}.csv`;
}

/** 供测试直接验证转义与行构造 */
export const __testing = { escapeCsvField, toCsvRow, toCsvLine, HEADERS, MAX_EXPORT_ROWS };
