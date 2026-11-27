// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { log } from '@/app/api/diagnostics';
import { SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS } from '@/app/api/tools/widgets';
import { notify } from '@/app/api/windows/notifications';
import { t } from '@/i18n';
import {
    formatResultExportFilename,
    prepareResultExport,
    ResultExportError,
    type ResultExportMessage,
    type ResultExportResourceFetcher,
    type ResultExportTheme,
    type ResultExportWarning,
} from '@/modules/result-export/public';
import { save } from '@/platform/files/dialogs';
import { createTauriFetch } from '@/platform/http';
import { resultExport } from '@/platform/native/resultExport';

export interface ResultExportPresentation {
    theme: ResultExportTheme;
    themeFallbacks: ResultExportTheme;
    baseStyles: string;
}

export interface SaveAssistantResultOptions {
    message: ResultExportMessage;
    presentation: ResultExportPresentation;
    labels: {
        dialogTitle: string;
        filterName: string;
    };
    now: Date;
    fetchResource?: ResultExportResourceFetcher;
}

export type SaveAssistantResultResult =
    | { status: 'cancelled' }
    | { status: 'saved'; warnings: ResultExportWarning[] };

function ensureHtmlExtension(destination: string): string {
    return destination.toLowerCase().endsWith('.html') ? destination : `${destination}.html`;
}

function exportError(code: 'dialog-failed' | 'write-failed', message: string): ResultExportError {
    return new ResultExportError(code, message);
}

export async function saveAssistantResultToFile({
    message,
    presentation,
    labels,
    now,
    fetchResource,
}: SaveAssistantResultOptions): Promise<SaveAssistantResultResult> {
    const document = await prepareResultExport({
        message,
        presentation: {
            ...presentation,
            allowedResourceHosts: SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS,
        },
        fetchResource,
    });

    const destination = await (async () => {
        try {
            return await save({
                title: labels.dialogTitle,
                defaultPath: formatResultExportFilename(now),
                filters: [{ name: labels.filterName, extensions: ['html'] }],
            });
        } catch (error) {
            throw exportError(
                'dialog-failed',
                error instanceof Error ? error.message : 'Could not open the save dialog.'
            );
        }
    })();
    if (!destination) return { status: 'cancelled' };

    try {
        await resultExport.writeHtml(ensureHtmlExtension(destination), document.html);
    } catch (error) {
        throw exportError(
            'write-failed',
            error instanceof Error ? error.message : 'Could not write the result file.'
        );
    }

    return { status: 'saved', warnings: document.warnings };
}

function notifyError(error: unknown): void {
    if (error instanceof ResultExportError) {
        const body =
            error.code === 'sensitive-content'
                ? t('assistant.resultExport.sensitiveBlocked')
                : error.code === 'result-too-large'
                  ? t('assistant.resultExport.tooLarge')
                  : t('assistant.resultExport.failed');
        notify({ title: 'TouchAI', body });
        return;
    }

    log.error('[resultExport] Failed to export result:', error);
    notify({ title: 'TouchAI', body: t('assistant.resultExport.failed') });
}

export async function exportAssistantResult(
    message: ResultExportMessage,
    presentation: ResultExportPresentation
): Promise<void> {
    try {
        const result = await saveAssistantResultToFile({
            message,
            presentation,
            labels: {
                dialogTitle: t('assistant.resultExport.dialogTitle'),
                filterName: t('assistant.resultExport.dialogFilter'),
            },
            now: new Date(),
            fetchResource: createTauriFetch(),
        });
        if (result.status === 'cancelled') return;

        const hasOnlineWarning = result.warnings.includes('online-resources');
        const hasLargeWarning = result.warnings.includes('large-file');
        const body =
            hasOnlineWarning && hasLargeWarning
                ? t('assistant.resultExport.savedLargeWithOnlineResources')
                : hasOnlineWarning
                  ? t('assistant.resultExport.savedWithOnlineResources')
                  : hasLargeWarning
                    ? t('assistant.resultExport.savedLarge')
                    : t('assistant.resultExport.saved');
        notify({ title: 'TouchAI', body });
    } catch (error) {
        notifyError(error);
    }
}
