<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div :class="ROOT_CLASS">
        <button
            type="button"
            class="tool-call-log-button"
            :aria-expanded="isExpanded"
            @click="toggleExpanded"
        >
            <span class="tool-call-log-line">
                <span class="tool-call-log-verb">{{ verbText }}</span>
                <span v-if="summaryText" class="tool-call-log-content">
                    {{ ` ${summaryText}` }}
                </span>
                <span v-if="durationText" class="tool-call-log-duration">
                    {{ ` (${durationText})` }}
                </span>
            </span>
        </button>

        <transition name="tool-call-slide">
            <div v-if="isExpanded" class="tool-call-apply-patch-detail">
                <div class="tool-call-apply-patch-panel">
                    <div class="tool-call-apply-patch-header">
                        <span class="tool-call-apply-patch-working-directory">
                            {{ workingDirectoryText }}
                        </span>
                        <div class="tool-call-apply-patch-header-meta">
                            <span :class="['tool-call-apply-patch-status-text', statusClass]">
                                {{ statusText }}
                            </span>
                            <span v-if="durationText" class="tool-call-apply-patch-duration">
                                {{ durationText }}
                            </span>
                        </div>
                    </div>

                    <div v-if="hasStructuredFiles" class="tool-call-apply-patch-files">
                        <button
                            v-for="item in structuredChangeItems"
                            :key="item.key"
                            type="button"
                            :class="
                                selectedChangeKey === item.key
                                    ? 'tool-call-apply-patch-file tool-call-apply-patch-file--active'
                                    : 'tool-call-apply-patch-file'
                            "
                            @click="selectChange(item.key)"
                        >
                            <span class="tool-call-apply-patch-file-operation">
                                {{ formatOperation(item.change.operation) }}
                            </span>
                            <span class="tool-call-apply-patch-file-path">
                                {{ formatFileLabel(item.change) }}
                            </span>
                            <span
                                v-if="formatChangeStats(item.stats)"
                                class="tool-call-apply-patch-file-stats"
                            >
                                {{ formatChangeStats(item.stats) }}
                            </span>
                        </button>
                    </div>

                    <div v-if="selectedChange" class="tool-call-apply-patch-preview">
                        <div class="tool-call-apply-patch-preview-header">
                            <span class="tool-call-apply-patch-preview-path">
                                {{ formatFileLabel(selectedChange) }}
                            </span>
                            <span
                                v-if="formatChangeStats(selectedChangeStats)"
                                class="tool-call-apply-patch-preview-stats"
                            >
                                {{ formatChangeStats(selectedChangeStats) }}
                            </span>
                        </div>

                        <div
                            v-if="selectedPreview?.isBinary"
                            class="tool-call-apply-patch-preview-empty"
                        >
                            二进制文件不显示改前改后内容
                        </div>
                        <div
                            v-else-if="selectedPreview?.omitted"
                            class="tool-call-apply-patch-preview-empty"
                        >
                            文件过大，已省略改前改后预览
                        </div>
                        <div v-else class="tool-call-apply-patch-preview-diff">
                            <header class="tool-call-apply-patch-preview-diff-header">
                                <span>变更预览</span>
                                <span
                                    v-if="
                                        selectedPreview?.beforeTruncated ||
                                        selectedPreview?.afterTruncated
                                    "
                                    class="tool-call-apply-patch-preview-note"
                                >
                                    已截断
                                </span>
                            </header>
                            <div
                                v-if="hasDiffRows"
                                class="tool-call-apply-patch-preview-code custom-scrollbar-thin"
                            >
                                <div
                                    v-for="row in diffRows"
                                    :key="row.key"
                                    :class="[
                                        'tool-call-apply-patch-diff-row',
                                        `tool-call-apply-patch-diff-row--${row.type}`,
                                    ]"
                                >
                                    <span
                                        class="tool-call-apply-patch-diff-prefix"
                                        v-text="row.prefix"
                                    ></span>
                                    <span
                                        class="tool-call-apply-patch-diff-line-number"
                                        v-text="row.beforeLineNumber ?? ''"
                                    ></span>
                                    <span
                                        class="tool-call-apply-patch-diff-line-number"
                                        v-text="row.afterLineNumber ?? ''"
                                    ></span>
                                    <span class="tool-call-apply-patch-diff-text">
                                        <span
                                            v-for="part in row.parts"
                                            :key="part.key"
                                            :class="
                                                part.changed
                                                    ? 'tool-call-apply-patch-diff-inline-change'
                                                    : ''
                                            "
                                            v-text="part.text"
                                        ></span>
                                    </span>
                                </div>
                            </div>
                            <pre
                                v-else
                                class="tool-call-apply-patch-preview-code tool-call-apply-patch-preview-code--empty custom-scrollbar-thin"
                                v-text="diffEmptyText"
                            ></pre>
                        </div>
                    </div>

                    <div v-else class="tool-call-apply-patch-output-block">
                        <pre
                            class="tool-call-apply-patch-output custom-scrollbar-thin"
                            v-text="fallbackOutputText"
                        ></pre>
                    </div>
                </div>
            </div>
        </transition>
    </div>
</template>

<script setup lang="ts">
    import { computed, ref, watch } from 'vue';

    import { parseApplyPatchToolResult } from '@/services/BuiltInToolService/tools/applyPatch';
    import type { ToolCallInfo } from '@/types/session';

    const ROOT_CLASS =
        'tool-call-apply-patch-wrapper tool-call-log-wrapper paragraph-node touchai-markdown touchai-markdown--default';

    interface Props {
        toolCall: ToolCallInfo;
        verbText: string;
        summaryText: string;
        durationText?: string | null;
    }

    type DiffRowType = 'context' | 'remove' | 'add';

    interface DiffTextPart {
        key: string;
        text: string;
        changed: boolean;
    }

    interface DiffRow {
        key: string;
        type: DiffRowType;
        prefix: string;
        text: string;
        beforeLineNumber: number | null;
        afterLineNumber: number | null;
        parts: DiffTextPart[];
    }

    interface DiffStats {
        additions: number;
        deletions: number;
    }

    type ApplyPatchChange = ReturnType<typeof parseApplyPatchToolResult>['changedFiles'][number];
    type DiffRowWithoutKey = Omit<DiffRow, 'key'>;

    interface StructuredChangeItem {
        key: string;
        change: ApplyPatchChange;
        rows: DiffRow[];
        stats: DiffStats;
    }

    const props = defineProps<Props>();

    const isExpanded = ref(false);
    const selectedChangeKey = ref<string | null>(null);
    const parsedResult = computed(() => parseApplyPatchToolResult(props.toolCall.result));
    const structuredChangedFiles = computed(() => parsedResult.value.changedFiles);
    const structuredChangeItems = computed<StructuredChangeItem[]>(() =>
        structuredChangedFiles.value.map((change, index) => {
            const rows = getChangeRows(change);

            return {
                key: getChangeKey(change, index),
                change,
                rows,
                stats: getChangeStats(rows),
            };
        })
    );
    const hasStructuredFiles = computed(() => structuredChangedFiles.value.length > 0);
    const selectedChangeItem = computed(() => {
        const items = structuredChangeItems.value;
        if (items.length === 0) {
            return null;
        }

        return items.find((item) => item.key === selectedChangeKey.value) ?? items[0] ?? null;
    });
    const selectedChange = computed(() => selectedChangeItem.value?.change ?? null);
    const selectedPreview = computed(() => selectedChange.value?.preview ?? null);
    const diffRows = computed(() => selectedChangeItem.value?.rows ?? []);
    const selectedChangeStats = computed(
        () => selectedChangeItem.value?.stats ?? { additions: 0, deletions: 0 }
    );
    const hasDiffRows = computed(() => diffRows.value.length > 0);
    const diffEmptyText = computed(() => {
        if (
            selectedPreview.value?.beforeContent === null &&
            selectedPreview.value?.afterContent === null
        ) {
            return '无内容';
        }

        return '无内容变更';
    });
    const workingDirectoryText = computed(() => {
        return parsedResult.value.workingDirectory || '工作目录未知';
    });
    const fallbackOutputText = computed(() => {
        if (props.toolCall.status === 'awaiting_approval') {
            return '等待用户批准后继续执行...';
        }

        if (props.toolCall.status === 'executing') {
            return '文件修改中...';
        }

        return parsedResult.value.summary || props.toolCall.result?.trim() || '无输出';
    });
    const statusType = computed<'running' | 'error' | 'completed' | 'rejected' | 'cancelled'>(
        () => {
            if (
                props.toolCall.status === 'executing' ||
                props.toolCall.status === 'awaiting_approval'
            ) {
                return 'running';
            }

            if (props.toolCall.status === 'error') {
                return 'error';
            }

            if (props.toolCall.status === 'rejected') {
                return 'rejected';
            }

            if (props.toolCall.status === 'cancelled') {
                return 'cancelled';
            }

            return 'completed';
        }
    );
    const statusClass = computed(() =>
        getStatusClassName('tool-call-apply-patch-status--', statusType.value)
    );
    const statusText = computed(() => {
        return getToolStatusText(props.toolCall.status, statusType.value, {
            completedText: '成功',
        });
    });

    watch(
        structuredChangeItems,
        (items) => {
            if (items.length === 0) {
                selectedChangeKey.value = null;
                return;
            }

            if (!items.some((item) => item.key === selectedChangeKey.value)) {
                selectedChangeKey.value = items[0]?.key ?? null;
            }
        },
        { immediate: true }
    );

    function toggleExpanded() {
        isExpanded.value = !isExpanded.value;
    }

    function selectChange(key: string) {
        selectedChangeKey.value = key;
    }

    function formatOperation(operation: string): string {
        if (operation === 'add') {
            return '新增';
        }
        if (operation === 'delete') {
            return '删除';
        }
        if (operation === 'move') {
            return '移动';
        }
        return '修改';
    }

    function formatFileLabel(change: ApplyPatchChange): string {
        if (change.operation === 'move' && change.newPath) {
            return `${change.path} → ${change.newPath}`;
        }

        return change.path;
    }

    function getChangeKey(change: ApplyPatchChange, index: number): string {
        return [index, change.operation, change.path, change.newPath ?? ''].join(':');
    }

    function getChangeRows(change: ApplyPatchChange): DiffRow[] {
        return buildUnifiedDiffRows(
            change.preview?.beforeContent ?? null,
            change.preview?.afterContent ?? null
        );
    }

    function getChangeStats(rows: DiffRow[]): DiffStats {
        return rows.reduce(
            (stats, row) => {
                if (row.type === 'add') {
                    stats.additions += 1;
                } else if (row.type === 'remove') {
                    stats.deletions += 1;
                }

                return stats;
            },
            { additions: 0, deletions: 0 }
        );
    }

    function formatChangeStats(stats: DiffStats): string {
        if (stats.additions === 0 && stats.deletions === 0) {
            return '';
        }

        return `+${stats.additions} -${stats.deletions}`;
    }

    function buildUnifiedDiffRows(
        beforeContent: string | null,
        afterContent: string | null
    ): DiffRow[] {
        const beforeLines = splitPreviewLines(beforeContent);
        const afterLines = splitPreviewLines(afterContent);
        const rows = addInlineHighlights(diffLines(beforeLines, afterLines));

        return rows.map((row, index) => ({
            key: `${index}-${row.type}-${row.text}`,
            type: row.type,
            prefix: getDiffPrefix(row.type),
            text: row.text,
            beforeLineNumber: row.beforeLineNumber,
            afterLineNumber: row.afterLineNumber,
            parts: row.parts,
        }));
    }

    function splitPreviewLines(content: string | null): string[] {
        if (content === null) {
            return [];
        }

        const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        if (lines[lines.length - 1] === '') {
            lines.pop();
        }

        return lines;
    }

    function diffLines(beforeLines: string[], afterLines: string[]): DiffRowWithoutKey[] {
        const lcs = buildLcsTable(beforeLines, afterLines);
        const rows: DiffRowWithoutKey[] = [];
        let beforeIndex = 0;
        let afterIndex = 0;
        let beforeLineNumber = 1;
        let afterLineNumber = 1;

        while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
            const beforeLine = beforeLines[beforeIndex] ?? '';
            const afterLine = afterLines[afterIndex] ?? '';

            if (beforeLine === afterLine) {
                rows.push(
                    createDiffRow({
                        type: 'context',
                        text: beforeLine,
                        beforeLineNumber,
                        afterLineNumber,
                    })
                );
                beforeIndex += 1;
                afterIndex += 1;
                beforeLineNumber += 1;
                afterLineNumber += 1;
                continue;
            }

            if (lcs[beforeIndex + 1]![afterIndex]! >= lcs[beforeIndex]![afterIndex + 1]!) {
                rows.push(
                    createDiffRow({
                        type: 'remove',
                        text: beforeLine,
                        beforeLineNumber,
                        afterLineNumber: null,
                    })
                );
                beforeIndex += 1;
                beforeLineNumber += 1;
                continue;
            }

            rows.push(
                createDiffRow({
                    type: 'add',
                    text: afterLine,
                    beforeLineNumber: null,
                    afterLineNumber,
                })
            );
            afterIndex += 1;
            afterLineNumber += 1;
        }

        while (beforeIndex < beforeLines.length) {
            rows.push(
                createDiffRow({
                    type: 'remove',
                    text: beforeLines[beforeIndex] ?? '',
                    beforeLineNumber,
                    afterLineNumber: null,
                })
            );
            beforeIndex += 1;
            beforeLineNumber += 1;
        }

        while (afterIndex < afterLines.length) {
            rows.push(
                createDiffRow({
                    type: 'add',
                    text: afterLines[afterIndex] ?? '',
                    beforeLineNumber: null,
                    afterLineNumber,
                })
            );
            afterIndex += 1;
            afterLineNumber += 1;
        }

        return rows;
    }

    function createDiffRow(input: {
        type: DiffRowType;
        text: string;
        beforeLineNumber: number | null;
        afterLineNumber: number | null;
    }): DiffRowWithoutKey {
        return {
            ...input,
            prefix: getDiffPrefix(input.type),
            parts: [{ key: '0', text: input.text, changed: false }],
        };
    }

    function addInlineHighlights(rows: DiffRowWithoutKey[]): DiffRowWithoutKey[] {
        const highlightedRows = [...rows];
        let index = 0;

        while (index < highlightedRows.length) {
            if (highlightedRows[index]?.type !== 'remove') {
                index += 1;
                continue;
            }

            const removeStart = index;
            while (highlightedRows[index]?.type === 'remove') {
                index += 1;
            }

            const addStart = index;
            while (highlightedRows[index]?.type === 'add') {
                index += 1;
            }

            const pairCount = Math.min(addStart - removeStart, index - addStart);
            for (let offset = 0; offset < pairCount; offset += 1) {
                const removeIndex = removeStart + offset;
                const addIndex = addStart + offset;
                const removeRow = highlightedRows[removeIndex]!;
                const addRow = highlightedRows[addIndex]!;
                const [removeParts, addParts] = buildInlineChangeParts(removeRow.text, addRow.text);

                highlightedRows[removeIndex] = { ...removeRow, parts: removeParts };
                highlightedRows[addIndex] = { ...addRow, parts: addParts };
            }
        }

        return highlightedRows;
    }

    function buildInlineChangeParts(
        beforeText: string,
        afterText: string
    ): [DiffTextPart[], DiffTextPart[]] {
        if (beforeText === afterText) {
            return [createTextParts(beforeText, false), createTextParts(afterText, false)];
        }

        let prefixLength = 0;
        const minLength = Math.min(beforeText.length, afterText.length);
        while (prefixLength < minLength && beforeText[prefixLength] === afterText[prefixLength]) {
            prefixLength += 1;
        }

        let suffixLength = 0;
        while (
            suffixLength < minLength - prefixLength &&
            beforeText[beforeText.length - 1 - suffixLength] ===
                afterText[afterText.length - 1 - suffixLength]
        ) {
            suffixLength += 1;
        }

        return [
            createInlineParts(beforeText, prefixLength, suffixLength),
            createInlineParts(afterText, prefixLength, suffixLength),
        ];
    }

    function createInlineParts(
        text: string,
        prefixLength: number,
        suffixLength: number
    ): DiffTextPart[] {
        const changedLength = text.length - prefixLength - suffixLength;
        const parts: DiffTextPart[] = [];

        if (prefixLength > 0) {
            parts.push({ key: 'prefix', text: text.slice(0, prefixLength), changed: false });
        }

        if (changedLength > 0) {
            parts.push({
                key: 'changed',
                text: text.slice(prefixLength, prefixLength + changedLength),
                changed: true,
            });
        }

        if (suffixLength > 0) {
            parts.push({
                key: 'suffix',
                text: text.slice(text.length - suffixLength),
                changed: false,
            });
        }

        return parts.length > 0 ? parts : createTextParts(text, true);
    }

    function createTextParts(text: string, changed: boolean): DiffTextPart[] {
        return [{ key: changed ? 'changed' : 'text', text, changed }];
    }

    function buildLcsTable(beforeLines: string[], afterLines: string[]): number[][] {
        const table = Array.from({ length: beforeLines.length + 1 }, () =>
            Array(afterLines.length + 1).fill(0)
        );

        for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
            for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
                if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
                    table[beforeIndex]![afterIndex] = table[beforeIndex + 1]![afterIndex + 1]! + 1;
                } else {
                    table[beforeIndex]![afterIndex] = Math.max(
                        table[beforeIndex + 1]![afterIndex]!,
                        table[beforeIndex]![afterIndex + 1]!
                    );
                }
            }
        }

        return table;
    }

    function getDiffPrefix(type: DiffRowType): string {
        if (type === 'add') {
            return '+';
        }

        if (type === 'remove') {
            return '-';
        }

        return ' ';
    }

    function getToolStatusText(
        status: ToolCallInfo['status'],
        statusTypeValue: 'running' | 'error' | 'completed' | 'rejected' | 'cancelled',
        options?: {
            completedText?: string;
        }
    ): string {
        if (status === 'awaiting_approval') {
            return '等待批准';
        }

        if (statusTypeValue === 'running') {
            return '运行中';
        }

        if (statusTypeValue === 'error') {
            return '失败';
        }

        if (statusTypeValue === 'rejected') {
            return '已拒绝';
        }

        if (statusTypeValue === 'cancelled') {
            return '已取消';
        }

        return options?.completedText || '完成';
    }

    function getStatusClassName(
        prefix: string,
        statusTypeValue: 'running' | 'error' | 'completed' | 'rejected' | 'cancelled'
    ): string {
        if (statusTypeValue === 'running') {
            return `${prefix}running`;
        }

        if (statusTypeValue === 'error') {
            return `${prefix}error`;
        }

        if (statusTypeValue === 'rejected') {
            return `${prefix}rejected`;
        }

        if (statusTypeValue === 'cancelled') {
            return `${prefix}cancelled`;
        }

        return `${prefix}completed`;
    }
</script>

<style scoped>
    .tool-call-apply-patch-wrapper {
        width: 100%;
        margin: 0;
        cursor: default;
        user-select: none;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
    }

    .tool-call-log-button {
        width: 100%;
        display: block;
        padding: 0;
        border: 0;
        background: transparent;
        text-align: left;
        cursor: default;
        font: inherit;
        color: inherit;
    }

    .tool-call-log-button:focus-visible .tool-call-log-line {
        outline: 1px solid rgba(184, 175, 165, 0.8);
        outline-offset: 2px;
        border-radius: 0.35rem;
    }

    .tool-call-log-line {
        display: block;
        min-width: 0;
        margin: 0;
        overflow: hidden;
        color: rgb(107, 114, 128);
        cursor: default;
        font-family: inherit;
        font-size: inherit;
        font-weight: inherit;
        line-height: inherit;
        letter-spacing: inherit;
        text-overflow: ellipsis;
        white-space: nowrap;
        transition: color 0.16s ease;
    }

    .tool-call-apply-patch-wrapper:hover .tool-call-log-line {
        color: rgb(75, 85, 99);
    }

    .tool-call-log-verb {
        color: inherit;
        font-size: 0.9em;
    }

    .tool-call-log-content,
    .tool-call-log-duration {
        color: rgb(156, 163, 175);
        font-size: 0.9em;
        transition: color 0.16s ease;
    }

    .tool-call-apply-patch-wrapper:hover .tool-call-log-content,
    .tool-call-apply-patch-wrapper:hover .tool-call-log-duration {
        color: rgb(107, 114, 128);
    }

    .tool-call-apply-patch-detail {
        margin-top: 0.68rem;
    }

    .tool-call-apply-patch-panel {
        border-radius: 0.72rem;
        border: 1px solid rgb(235, 231, 227);
        background: transparent;
        box-shadow: 0 1px 2px rgba(107, 114, 128, 0.04);
        padding: 0.72rem 0.78rem;
    }

    .tool-call-apply-patch-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.55rem;
        flex-wrap: wrap;
    }

    .tool-call-apply-patch-working-directory {
        display: block;
        color: rgb(107, 114, 128);
        font-size: 10px;
        line-height: 1.3;
        font-weight: 500;
        word-break: break-all;
    }

    .tool-call-apply-patch-header-meta {
        display: inline-flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.5rem;
        flex-wrap: wrap;
        text-align: right;
        margin-left: auto;
    }

    .tool-call-apply-patch-status-text {
        display: inline-block;
        font-size: 10px;
        line-height: 1.3;
        font-weight: 500;
        color: rgb(102, 96, 89);
    }

    .tool-call-apply-patch-status--running {
        color: rgb(92, 104, 119);
    }

    .tool-call-apply-patch-status--completed {
        color: rgb(102, 96, 89);
    }

    .tool-call-apply-patch-status--cancelled {
        color: rgb(128, 122, 115);
    }

    .tool-call-apply-patch-status--error,
    .tool-call-apply-patch-status--rejected {
        color: rgb(126, 99, 72);
    }

    .tool-call-apply-patch-duration {
        font-size: 10px;
        line-height: 1.3;
        color: rgb(128, 121, 113);
    }

    .tool-call-apply-patch-files {
        display: flex;
        flex-wrap: wrap;
        gap: 0.45rem;
        margin-top: 0.72rem;
    }

    .tool-call-apply-patch-file {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        max-width: 100%;
        padding: 0.32rem 0.55rem;
        border-radius: 999px;
        border: 1px solid rgba(229, 231, 235, 0.95);
        background: rgba(249, 250, 251, 0.9);
        color: rgb(90, 86, 81);
        font-size: 11px;
        line-height: 1.3;
        cursor: pointer;
        transition:
            border-color 0.16s ease,
            background-color 0.16s ease,
            color 0.16s ease;
    }

    .tool-call-apply-patch-file:hover,
    .tool-call-apply-patch-file--active {
        border-color: rgba(196, 181, 253, 0.9);
        background: rgba(243, 244, 246, 0.98);
        color: rgb(48, 44, 40);
    }

    .tool-call-apply-patch-file-operation {
        flex-shrink: 0;
        color: rgb(118, 92, 64);
        font-weight: 600;
    }

    .tool-call-apply-patch-file-path {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .tool-call-apply-patch-file-stats {
        flex-shrink: 0;
        color: rgb(107, 114, 128);
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0;
    }

    .tool-call-apply-patch-preview,
    .tool-call-apply-patch-output-block {
        margin-top: 0.72rem;
    }

    .tool-call-apply-patch-preview-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.65rem;
        margin-bottom: 0.55rem;
    }

    .tool-call-apply-patch-preview-path {
        display: block;
        min-width: 0;
        font-size: 11px;
        line-height: 1.45;
        color: rgb(90, 86, 81);
        word-break: break-word;
    }

    .tool-call-apply-patch-preview-stats {
        flex-shrink: 0;
        color: rgb(107, 114, 128);
        font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace;
        font-size: 10px;
        font-weight: 600;
        line-height: 1.35;
    }

    .tool-call-apply-patch-preview-diff {
        border-radius: 0.68rem;
        border: 1px solid rgba(229, 231, 235, 0.95);
        background: rgba(249, 250, 251, 0.85);
        padding: 0.65rem 0.72rem;
    }

    .tool-call-apply-patch-preview-diff-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.45rem;
        margin-bottom: 0.5rem;
        font-family: var(--font-serif), serif;
        font-size: 12px;
        line-height: 1.35;
        font-weight: 600;
        color: rgb(54, 47, 42);
    }

    .tool-call-apply-patch-preview-note {
        flex-shrink: 0;
        color: rgb(128, 121, 113);
        font-size: 10px;
        font-weight: 500;
    }

    .tool-call-apply-patch-preview-code,
    .tool-call-apply-patch-output {
        margin: 0;
        padding: 0;
        max-height: 16rem;
        overflow: auto;
        font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace;
        font-size: 11px;
        line-height: 1.58;
        color: rgb(96, 92, 87);
        white-space: pre-wrap;
        word-break: break-word;
    }

    .tool-call-apply-patch-diff-row {
        display: grid;
        grid-template-columns: 1.25rem 2.15rem 2.15rem minmax(0, 1fr);
        min-width: 0;
        margin: 0 -0.28rem;
        padding: 0 0.28rem;
        border-radius: 0.24rem;
        color: rgb(96, 92, 87);
    }

    .tool-call-apply-patch-diff-row--remove {
        background: rgba(254, 226, 226, 0.72);
        color: rgb(127, 29, 29);
    }

    .tool-call-apply-patch-diff-row--add {
        background: rgba(220, 252, 231, 0.74);
        color: rgb(20, 83, 45);
    }

    .tool-call-apply-patch-diff-prefix {
        padding-right: 0.45rem;
        color: currentColor;
        opacity: 0.78;
        text-align: right;
        user-select: none;
    }

    .tool-call-apply-patch-diff-line-number {
        color: rgb(156, 163, 175);
        font-variant-numeric: tabular-nums;
        text-align: right;
        user-select: none;
    }

    .tool-call-apply-patch-diff-text {
        min-width: 0;
        white-space: pre-wrap;
        word-break: break-word;
    }

    .tool-call-apply-patch-diff-inline-change {
        border-radius: 0.18rem;
        padding: 0 0.08rem;
    }

    .tool-call-apply-patch-diff-row--remove .tool-call-apply-patch-diff-inline-change {
        background: rgba(248, 113, 113, 0.24);
    }

    .tool-call-apply-patch-diff-row--add .tool-call-apply-patch-diff-inline-change {
        background: rgba(34, 197, 94, 0.24);
    }

    .tool-call-apply-patch-preview-code--empty,
    .tool-call-apply-patch-preview-empty {
        color: rgb(157, 149, 140);
    }

    .tool-call-apply-patch-preview-empty {
        padding: 0.72rem 0;
        font-size: 12px;
        line-height: 1.5;
    }

    .tool-call-slide-enter-active,
    .tool-call-slide-leave-active {
        transition:
            opacity 0.2s ease,
            transform 0.2s ease;
    }

    .tool-call-slide-enter-from,
    .tool-call-slide-leave-to {
        opacity: 0;
        transform: translateY(-3px);
    }
</style>
