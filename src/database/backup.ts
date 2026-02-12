// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { native } from '@services/NativeService';
import { dirname, join, tempDir } from '@tauri-apps/api/path';
import { open, save } from '@tauri-apps/plugin-dialog';
import { copyFile, mkdir, remove } from '@tauri-apps/plugin-fs';
import Database from '@tauri-apps/plugin-sql';

import { db } from './index';
import { migrate } from './migrator';

export type ImportMode = 'chat_only' | 'full';

export enum DatabaseVersionStatus {
    Compatible = 'compatible',
    NeedsMigration = 'needs_migration',
    TooNew = 'too_new',
}

export interface ImportResult {
    sourcePath: string;
    importMode: ImportMode;
    currentBackupPath: string;
    sourceBackupPath: string | null;
    migratedSource: boolean;
}

export interface ProgressCallback {
    (message: string, progress: number): void;
}

interface TouchAiMeta {
    key: string;
    value: string;
}

/**
 * 数据库备份服务
 */
class DatabaseBackupService {
    /**
     * 获取当前数据库文件路径
     */
    private async getDatabasePath(): Promise<string> {
        return await native.database.getDatabasePath();
    }

    /**
     * 导出数据库备份
     */
    async exportDatabase(onProgress?: ProgressCallback): Promise<string> {
        const exportPath = await save({
            defaultPath: this.buildBackupFileName(),
            filters: [
                {
                    name: '数据库备份文件',
                    extensions: ['db'],
                },
            ],
            title: '导出设置备份',
        });

        if (!exportPath) {
            throw new Error('已取消导出');
        }

        if (onProgress) onProgress('正在复制数据库文件...', 50);

        // 刷新 WAL 日志到主数据库文件，确保备份包含所有最新写入
        await db.rawQuery('PRAGMA wal_checkpoint(TRUNCATE)');

        const currentDbPath = await this.getDatabasePath();
        await copyFile(currentDbPath, exportPath);

        if (onProgress) onProgress('导出完成', 100);

        return exportPath;
    }

    /**
     * 导入数据库备份
     * @param mode 导入模式
     * - chat_only: 仅导入对话数据（会话、消息、AI请求记录）
     * - full: 覆盖设置，差量导入对话数据
     * @param onProgress 进度回调
     */
    async importDatabase(mode: ImportMode, onProgress?: ProgressCallback): Promise<ImportResult> {
        const sourcePath = await open({
            filters: [
                {
                    name: '数据库备份文件',
                    extensions: ['db'],
                },
            ],
            title: '导入设置备份',
            multiple: false,
            directory: false,
        });

        if (!sourcePath) {
            return {
                sourcePath: '',
                importMode: mode,
                currentBackupPath: '',
                sourceBackupPath: null,
                migratedSource: false,
            };
        }

        if (onProgress) onProgress('正在验证备份文件...', 10);
        await this.validateTouchAiDatabase(sourcePath);

        if (onProgress) onProgress('正在备份当前数据库...', 20);
        const currentDbPath = await this.getDatabasePath();
        const currentBackupPath = await this.createTempBackup(
            currentDbPath,
            'touchai-current-before-import'
        );

        let sourceBackupPath: string | null = null;
        let migratedSource = false;

        let sourceDb: Database | null = null;
        try {
            if (onProgress) onProgress('正在加载导入数据库...', 30);
            sourceDb = await Database.load(`sqlite://${sourcePath}`);
            const versionStatus = await this.checkDatabaseVersion(sourceDb);

            if (versionStatus === DatabaseVersionStatus.TooNew) {
                throw new Error(
                    '导入的数据库版本较新，当前应用无法兼容。请升级 TouchAI 到最新版本后重试。'
                );
            }

            if (versionStatus === DatabaseVersionStatus.NeedsMigration) {
                if (onProgress) onProgress('检测到旧版本数据库，正在升级旧数据...', 40);
                sourceBackupPath = await this.createTempBackup(
                    sourcePath,
                    'touchai-import-source-backup'
                );

                const sourceBackupDb = await Database.load(`sqlite://${sourceBackupPath}`);
                await migrate(sourceBackupDb);
                await sourceBackupDb.close();
                migratedSource = true;

                if (onProgress) onProgress('正在合并数据...', 60);
                await this.mergeDatabase(currentDbPath, sourceBackupPath, mode, onProgress);
            } else {
                if (onProgress) onProgress('正在合并数据...', 60);
                await this.mergeDatabase(currentDbPath, sourcePath, mode, onProgress);
            }

            if (onProgress) onProgress('导入完成', 100);

            // 清理临时备份文件
            await this.cleanupTempFile(currentBackupPath);
            if (sourceBackupPath) {
                await this.cleanupTempFile(sourceBackupPath);
            }

            return {
                sourcePath,
                importMode: mode,
                currentBackupPath,
                sourceBackupPath,
                migratedSource,
            };
        } catch (error) {
            if (onProgress) onProgress('导入失败，正在回滚...', 90);
            await copyFile(currentBackupPath, currentDbPath);

            // 回滚后清理临时备份文件
            await this.cleanupTempFile(currentBackupPath);
            if (sourceBackupPath) {
                await this.cleanupTempFile(sourceBackupPath);
            }

            throw new Error(
                `导入失败，已恢复当前数据库: ${error instanceof Error ? error.message : String(error)}`
            );
        } finally {
            if (sourceDb) {
                await sourceDb.close();
                sourceDb = null;
            }
        }
    }

    /**
     * 创建临时备份文件
     */
    private async createTempBackup(sourcePath: string, prefix: string): Promise<string> {
        const timestamp = Math.floor(Date.now() / 1000);
        const backupFileName = `${prefix}-${timestamp}.db`;
        const tempDirPath = await tempDir();
        const backupPath = await join(tempDirPath, 'touchai-backups', backupFileName);

        // 确保目标目录存在
        const backupDir = await dirname(backupPath);
        await mkdir(backupDir, { recursive: true });

        await copyFile(sourcePath, backupPath);

        return backupPath;
    }

    /**
     * 验证是否为有效的 TouchAI 数据库
     */
    private async validateTouchAiDatabase(path: string): Promise<void> {
        const testDb = await Database.load(`sqlite://${path}`);

        try {
            const tables = await testDb.select<Array<{ name: string }>>(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='touchai_meta'"
            );

            if (tables.length === 0) {
                throw new Error('该文件不是 TouchAI 数据库');
            }

            const meta = await testDb.select<Array<TouchAiMeta>>(
                "SELECT value FROM touchai_meta WHERE key='app_id'"
            );

            if (meta.length === 0 || meta[0]?.value !== 'touchai') {
                throw new Error('该文件不是 TouchAI 数据库');
            }
        } finally {
            await testDb.close();
        }
    }

    /**
     * 检查数据库版本状态
     */
    private async checkDatabaseVersion(sourceDb: Database): Promise<DatabaseVersionStatus> {
        const journalFiles = import.meta.glob<{
            version: string;
            dialect: string;
            entries: Array<{ idx: number; tag: string }>;
        }>('/drizzle/meta/_journal.json', {
            eager: true,
            import: 'default',
        });
        const journal = Object.values(journalFiles)[0];
        if (!journal || journal.entries.length === 0) {
            return DatabaseVersionStatus.Compatible;
        }

        const latestVersion = Math.max(...journal.entries.map((e) => e.idx));

        const tables = await sourceDb.select<Array<{ name: string }>>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'"
        );

        if (tables.length === 0) {
            return DatabaseVersionStatus.NeedsMigration;
        }

        const applied = await sourceDb.select<Array<{ hash: string }>>(
            'SELECT hash FROM migrations'
        );
        const appliedHashes = new Set(applied.map((r) => r.hash));
        const knownHashes = new Set(journal.entries.map((e) => e.tag));

        if (applied.some((migration) => !knownHashes.has(migration.hash))) {
            return DatabaseVersionStatus.TooNew;
        }

        const sourceVersion = Math.max(
            -1,
            ...journal.entries.filter((e) => appliedHashes.has(e.tag)).map((e) => e.idx)
        );

        if (sourceVersion > latestVersion) {
            return DatabaseVersionStatus.TooNew;
        }

        if (sourceVersion < latestVersion) {
            return DatabaseVersionStatus.NeedsMigration;
        }

        return DatabaseVersionStatus.Compatible;
    }

    /**
     * 合并数据库
     */
    private async mergeDatabase(
        currentDbPath: string,
        sourceDbPath: string,
        mode: ImportMode,
        onProgress?: ProgressCallback
    ): Promise<void> {
        const currentDb = await Database.load(`sqlite://${currentDbPath}`);

        try {
            const escapedPath = sourceDbPath.replace(/'/g, "''");
            await currentDb.execute(`ATTACH DATABASE '${escapedPath}' AS imported`);
            await this.ensureRequiredTables(currentDb);

            if (mode === 'chat_only') {
                await this.mergeChatDataOnly(currentDb, onProgress);
            } else {
                await this.mergeFullData(currentDb, onProgress);
            }

            await currentDb.execute('DETACH DATABASE imported');
        } finally {
            await currentDb.close();
        }
    }

    /**
     * 确保导入数据库包含必需的表
     */
    private async ensureRequiredTables(currentDb: Database): Promise<void> {
        const requiredTables = [
            'providers',
            'models',
            'sessions',
            'messages',
            'ai_requests',
            'llm_metadata',
            'settings',
            'statistics',
            'touchai_meta',
        ];

        for (const table of requiredTables) {
            const result = await currentDb.select<Array<{ name: string }>>(
                "SELECT name FROM imported.sqlite_master WHERE type='table' AND name=?",
                [table]
            );

            if (result.length === 0) {
                throw new Error(`导入数据库缺少必需数据表: ${table}`);
            }
        }
    }

    /**
     * 差量导入对话数据（会话、消息、AI请求记录）
     * 这是两种导入模式的公共部分
     */
    private async mergeChatData(currentDb: Database): Promise<void> {
        // 合并会话
        await currentDb.execute(`
            INSERT INTO main.sessions (session_id, title, model, created_at, updated_at)
            SELECT session_id, title, model, created_at, updated_at
            FROM imported.sessions
            WHERE true
            ON CONFLICT(session_id) DO UPDATE SET
                title = excluded.title,
                model = excluded.model,
                updated_at = excluded.updated_at
        `);

        // 合并消息
        await currentDb.execute(`
            INSERT INTO main.messages (session_id, role, content, created_at, updated_at)
            SELECT target_sessions.id,
                   source_messages.role,
                   source_messages.content,
                   source_messages.created_at,
                   source_messages.updated_at
            FROM imported.messages AS source_messages
            INNER JOIN imported.sessions AS source_sessions
                ON source_sessions.id = source_messages.session_id
            INNER JOIN main.sessions AS target_sessions
                ON target_sessions.session_id = source_sessions.session_id
            WHERE NOT EXISTS (
                SELECT 1
                FROM main.messages AS existing_messages
                WHERE existing_messages.session_id = target_sessions.id
                  AND existing_messages.role = source_messages.role
                  AND existing_messages.content = source_messages.content
                  AND existing_messages.created_at = source_messages.created_at
            )
        `);

        // 合并 AI 请求记录
        await currentDb.execute(`
            INSERT INTO main.ai_requests (
                session_id, model_id, prompt_message_id, response_message_id, status, error_message,
                tokens_used, duration_ms, created_at, updated_at
            )
            SELECT
                target_sessions.id,
                target_models.id,
                (
                    SELECT target_prompt.id
                    FROM imported.messages AS source_prompt
                    INNER JOIN imported.sessions AS source_prompt_session
                        ON source_prompt_session.id = source_prompt.session_id
                    INNER JOIN main.sessions AS target_prompt_session
                        ON target_prompt_session.session_id = source_prompt_session.session_id
                    INNER JOIN main.messages AS target_prompt
                        ON target_prompt.session_id = target_prompt_session.id
                       AND target_prompt.role = source_prompt.role
                       AND target_prompt.content = source_prompt.content
                       AND target_prompt.created_at = source_prompt.created_at
                    WHERE source_prompt.id = source_requests.prompt_message_id
                    LIMIT 1
                ) AS prompt_message_id,
                (
                    SELECT target_response.id
                    FROM imported.messages AS source_response
                    INNER JOIN imported.sessions AS source_response_session
                        ON source_response_session.id = source_response.session_id
                    INNER JOIN main.sessions AS target_response_session
                        ON target_response_session.session_id = source_response_session.session_id
                    INNER JOIN main.messages AS target_response
                        ON target_response.session_id = target_response_session.id
                       AND target_response.role = source_response.role
                       AND target_response.content = source_response.content
                       AND target_response.created_at = source_response.created_at
                    WHERE source_response.id = source_requests.response_message_id
                    LIMIT 1
                ) AS response_message_id,
                source_requests.status,
                source_requests.error_message,
                source_requests.tokens_used,
                source_requests.duration_ms,
                source_requests.created_at,
                source_requests.updated_at
            FROM imported.ai_requests AS source_requests
            INNER JOIN imported.sessions AS source_sessions
                ON source_sessions.id = source_requests.session_id
            INNER JOIN main.sessions AS target_sessions
                ON target_sessions.session_id = source_sessions.session_id
            INNER JOIN imported.models AS source_models
                ON source_models.id = source_requests.model_id
            INNER JOIN imported.providers AS source_providers
                ON source_providers.id = source_models.provider_id
            INNER JOIN main.providers AS target_providers
                ON target_providers.name = source_providers.name
               AND target_providers.type = source_providers.type
            INNER JOIN main.models AS target_models
                ON target_models.provider_id = target_providers.id
               AND target_models.model_id = source_models.model_id
            WHERE NOT EXISTS (
                SELECT 1
                FROM main.ai_requests AS existing_requests
                WHERE existing_requests.session_id = target_sessions.id
                  AND existing_requests.model_id = target_models.id
                  AND existing_requests.prompt_message_id = (
                      SELECT target_prompt.id
                      FROM imported.messages AS source_prompt
                      INNER JOIN imported.sessions AS source_prompt_session
                          ON source_prompt_session.id = source_prompt.session_id
                      INNER JOIN main.sessions AS target_prompt_session
                          ON target_prompt_session.session_id = source_prompt_session.session_id
                      INNER JOIN main.messages AS target_prompt
                          ON target_prompt.session_id = target_prompt_session.id
                         AND target_prompt.role = source_prompt.role
                         AND target_prompt.content = source_prompt.content
                         AND target_prompt.created_at = source_prompt.created_at
                      WHERE source_prompt.id = source_requests.prompt_message_id
                      LIMIT 1
                  )
                  AND existing_requests.created_at = source_requests.created_at
            )
        `);
    }

    /**
     * 仅导入对话数据（会话、消息、AI请求记录）
     */
    private async mergeChatDataOnly(
        currentDb: Database,
        onProgress?: ProgressCallback
    ): Promise<void> {
        if (onProgress) onProgress('正在合并对话数据...', 70);
        await currentDb.execute('BEGIN');

        try {
            await this.mergeChatData(currentDb);
            await currentDb.execute('COMMIT');
        } catch (error) {
            await currentDb.execute('ROLLBACK');
            throw error;
        }
    }

    /**
     * 全量导入：覆盖设置，差量导入对话数据
     */
    private async mergeFullData(currentDb: Database, onProgress?: ProgressCallback): Promise<void> {
        if (onProgress) onProgress('正在覆盖设置数据...', 60);
        await currentDb.execute('BEGIN');

        try {
            // 1. 覆盖设置相关表
            await currentDb.execute(`
                DELETE FROM main.settings;
                DELETE FROM main.statistics;
                DELETE FROM main.llm_metadata;

                INSERT INTO main.providers (id, name, type, api_endpoint, api_key, logo, enabled, is_builtin, created_at, updated_at)
                SELECT id, name, type, api_endpoint, api_key, logo, enabled, is_builtin, created_at, updated_at
                FROM imported.providers
                WHERE true
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    type = excluded.type,
                    api_endpoint = excluded.api_endpoint,
                    api_key = excluded.api_key,
                    logo = excluded.logo,
                    enabled = excluded.enabled,
                    is_builtin = excluded.is_builtin,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at;

                INSERT INTO main.models (
                    id, provider_id, name, model_id, is_default, last_used_at,
                    attachment, modalities, open_weights, reasoning, release_date,
                    temperature, tool_call, knowledge, context_limit, output_limit,
                    is_custom_metadata, created_at, updated_at
                )
                SELECT
                    id, provider_id, name, model_id, is_default, last_used_at,
                    attachment, modalities, open_weights, reasoning, release_date,
                    temperature, tool_call, knowledge, context_limit, output_limit,
                    is_custom_metadata, created_at, updated_at
                FROM imported.models
                WHERE true
                ON CONFLICT(id) DO UPDATE SET
                    provider_id = excluded.provider_id,
                    name = excluded.name,
                    model_id = excluded.model_id,
                    is_default = excluded.is_default,
                    last_used_at = excluded.last_used_at,
                    attachment = excluded.attachment,
                    modalities = excluded.modalities,
                    open_weights = excluded.open_weights,
                    reasoning = excluded.reasoning,
                    release_date = excluded.release_date,
                    temperature = excluded.temperature,
                    tool_call = excluded.tool_call,
                    knowledge = excluded.knowledge,
                    context_limit = excluded.context_limit,
                    output_limit = excluded.output_limit,
                    is_custom_metadata = excluded.is_custom_metadata,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at;

                INSERT INTO main.settings (id, key, value, created_at, updated_at)
                SELECT id, key, value, created_at, updated_at
                FROM imported.settings;

                INSERT INTO main.statistics (id, key, value, created_at, updated_at)
                SELECT id, key, value, created_at, updated_at
                FROM imported.statistics;

                INSERT INTO main.llm_metadata (
                    id, model_id, name, attachment, modalities, open_weights, reasoning,
                    release_date, temperature, tool_call, knowledge, [limit], created_at, updated_at
                )
                SELECT
                    id, model_id, name, attachment, modalities, open_weights, reasoning,
                    release_date, temperature, tool_call, knowledge, [limit], created_at, updated_at
                FROM imported.llm_metadata;
            `);

            // 2. 差量导入对话数据
            if (onProgress) onProgress('正在合并对话数据...', 80);
            await this.mergeChatData(currentDb);

            // 3. 重置自增序列
            await currentDb.execute(`
                DELETE FROM main.sqlite_sequence
                WHERE name IN ('providers', 'models', 'sessions', 'messages', 'ai_requests', 'settings', 'statistics', 'llm_metadata');

                INSERT INTO main.sqlite_sequence (name, seq) SELECT 'providers', COALESCE(MAX(id), 0) FROM main.providers;
                INSERT INTO main.sqlite_sequence (name, seq) SELECT 'models', COALESCE(MAX(id), 0) FROM main.models;
                INSERT INTO main.sqlite_sequence (name, seq) SELECT 'sessions', COALESCE(MAX(id), 0) FROM main.sessions;
                INSERT INTO main.sqlite_sequence (name, seq) SELECT 'messages', COALESCE(MAX(id), 0) FROM main.messages;
                INSERT INTO main.sqlite_sequence (name, seq) SELECT 'ai_requests', COALESCE(MAX(id), 0) FROM main.ai_requests;
                INSERT INTO main.sqlite_sequence (name, seq) SELECT 'settings', COALESCE(MAX(id), 0) FROM main.settings;
                INSERT INTO main.sqlite_sequence (name, seq) SELECT 'statistics', COALESCE(MAX(id), 0) FROM main.statistics;
                INSERT INTO main.sqlite_sequence (name, seq) SELECT 'llm_metadata', COALESCE(MAX(id), 0) FROM main.llm_metadata;
            `);

            await currentDb.execute('COMMIT');
        } catch (error) {
            await currentDb.execute('ROLLBACK');
            throw error;
        }
    }

    /**
     * 清理临时备份文件
     */
    private async cleanupTempFile(filePath: string): Promise<void> {
        try {
            await remove(filePath);
        } catch {
            // 清理失败不影响主流程
        }
    }

    /**
     * 生成备份文件名
     */
    private buildBackupFileName(): string {
        const timestamp = Math.floor(Date.now() / 1000);
        return `touchai-backup-${timestamp}.db`;
    }
}

export const databaseBackup = new DatabaseBackupService();
