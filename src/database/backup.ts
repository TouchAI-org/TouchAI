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

interface MappingValidationRow {
    source_id: number;
}

interface AmbiguousMappingRow extends MappingValidationRow {
    match_count: number;
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
     * - chat_only: 仅导入对话数据（会话、消息、轮次与尝试记录）
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
                try {
                    await migrate(sourceBackupDb);
                } finally {
                    await sourceBackupDb.close();
                }
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
            'attachments',
            'message_attachments',
            'session_turns',
            'session_turn_attempts',
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
     * 校验临时映射候选表是否完整且一对一。
     */
    private async assertCompleteUniqueMapping(
        currentDb: Database,
        options: {
            sourceTable: string;
            sourceIdColumn: string;
            candidateTable: string;
            candidateSourceColumn: string;
            entityLabel: string;
        }
    ): Promise<void> {
        const missing = await currentDb.select<Array<MappingValidationRow>>(
            `
                SELECT source.${options.sourceIdColumn} AS source_id
                FROM ${options.sourceTable} AS source
                LEFT JOIN ${options.candidateTable} AS candidate
                    ON candidate.${options.candidateSourceColumn} = source.${options.sourceIdColumn}
                WHERE candidate.${options.candidateSourceColumn} IS NULL
                LIMIT 1
            `
        );

        if (missing.length > 0) {
            throw new Error(
                `${options.entityLabel}映射失败，源记录 ${missing[0]!.source_id} 未找到目标记录`
            );
        }

        const ambiguous = await currentDb.select<Array<AmbiguousMappingRow>>(
            `
                SELECT
                    candidate.${options.candidateSourceColumn} AS source_id,
                    COUNT(*) AS match_count
                FROM ${options.candidateTable} AS candidate
                GROUP BY candidate.${options.candidateSourceColumn}
                HAVING COUNT(*) > 1
                LIMIT 1
            `
        );

        if (ambiguous.length > 0) {
            throw new Error(
                `${options.entityLabel}映射不唯一，源记录 ${ambiguous[0]!.source_id} 匹配到 ${ambiguous[0]!.match_count} 条目标记录`
            );
        }
    }

    /**
     * 建立源会话到目标会话的临时映射表。
     */
    private async rebuildTempSessionMap(currentDb: Database): Promise<void> {
        await currentDb.execute(`
            DROP TABLE IF EXISTS temp_session_map;
            CREATE TEMP TABLE temp_session_map (
                source_session_id INTEGER PRIMARY KEY,
                target_session_id INTEGER NOT NULL
            );

            INSERT INTO temp_session_map (source_session_id, target_session_id)
            SELECT
                source_sessions.id,
                target_sessions.id
            FROM imported.sessions AS source_sessions
            INNER JOIN main.sessions AS target_sessions
                ON target_sessions.session_id = source_sessions.session_id;
        `);
    }

    /**
     * 建立源消息到目标消息的临时映射表，并校验唯一性。
     */
    private async rebuildTempMessageMap(currentDb: Database): Promise<void> {
        await currentDb.execute(`
            DROP TABLE IF EXISTS temp_message_candidates;
            CREATE TEMP TABLE temp_message_candidates (
                source_message_id INTEGER NOT NULL,
                target_message_id INTEGER NOT NULL
            );

            INSERT INTO temp_message_candidates (source_message_id, target_message_id)
            SELECT
                source_messages.source_message_id,
                target_messages.target_message_id
            FROM temp_ranked_source_messages AS source_messages
            INNER JOIN temp_ranked_target_messages AS target_messages
                ON target_messages.target_session_id = source_messages.target_session_id
               AND target_messages.role = source_messages.role
               AND target_messages.content = source_messages.content
               AND target_messages.created_at = source_messages.created_at
               AND target_messages.occurrence_index = source_messages.occurrence_index;
        `);

        await this.assertCompleteUniqueMapping(currentDb, {
            sourceTable: 'temp_ranked_source_messages',
            sourceIdColumn: 'source_message_id',
            candidateTable: 'temp_message_candidates',
            candidateSourceColumn: 'source_message_id',
            entityLabel: '消息',
        });

        await currentDb.execute(`
            DROP TABLE IF EXISTS temp_message_map;
            CREATE TEMP TABLE temp_message_map (
                source_message_id INTEGER PRIMARY KEY,
                target_message_id INTEGER NOT NULL
            );

            INSERT INTO temp_message_map (source_message_id, target_message_id)
            SELECT
                source_message_id,
                MIN(target_message_id) AS target_message_id
            FROM temp_message_candidates
            GROUP BY source_message_id;

            DROP TABLE temp_message_candidates;
        `);
    }

    /**
     * 为导入消息建立稳定的组内顺序，解决重复消息的对齐问题。
     */
    private async rebuildTempRankedSourceMessages(currentDb: Database): Promise<void> {
        await currentDb.execute(`
            DROP TABLE IF EXISTS temp_ranked_source_messages;
            CREATE TEMP TABLE temp_ranked_source_messages AS
            WITH source_messages_with_target_session AS (
                SELECT
                    source_messages.id AS source_message_id,
                    session_map.target_session_id,
                    source_messages.role,
                    source_messages.content,
                    source_messages.created_at,
                    source_messages.updated_at
                FROM imported.messages AS source_messages
                INNER JOIN temp_session_map AS session_map
                    ON session_map.source_session_id = source_messages.session_id
            )
            SELECT
                source_message_id,
                target_session_id,
                role,
                content,
                created_at,
                updated_at,
                ROW_NUMBER() OVER (
                    PARTITION BY target_session_id, role, content, created_at
                    ORDER BY source_message_id
                ) AS occurrence_index
            FROM source_messages_with_target_session;
        `);
    }

    /**
     * 为目标库中待对齐的消息建立稳定的组内顺序。
     */
    private async rebuildTempRankedTargetMessages(currentDb: Database): Promise<void> {
        await currentDb.execute(`
            DROP TABLE IF EXISTS temp_ranked_target_messages;
            CREATE TEMP TABLE temp_ranked_target_messages AS
            WITH target_messages_in_scope AS (
                SELECT
                    target_messages.id AS target_message_id,
                    target_messages.session_id AS target_session_id,
                    target_messages.role,
                    target_messages.content,
                    target_messages.created_at
                FROM main.messages AS target_messages
                WHERE target_messages.session_id IN (
                    SELECT target_session_id
                    FROM temp_session_map
                )
            )
            SELECT
                target_message_id,
                target_session_id,
                role,
                content,
                created_at,
                ROW_NUMBER() OVER (
                    PARTITION BY target_session_id, role, content, created_at
                    ORDER BY target_message_id
                ) AS occurrence_index
            FROM target_messages_in_scope;
        `);
    }

    /**
     * 按重复消息的组内序号补齐缺失消息，并建立稳定映射。
     */
    private async syncMessages(currentDb: Database): Promise<void> {
        await this.rebuildTempRankedSourceMessages(currentDb);
        await this.rebuildTempRankedTargetMessages(currentDb);

        await currentDb.execute(`
            INSERT INTO main.messages (
                session_id,
                role,
                content,
                created_at,
                updated_at
            )
            SELECT
                source_messages.target_session_id,
                source_messages.role,
                source_messages.content,
                source_messages.created_at,
                source_messages.updated_at
            FROM temp_ranked_source_messages AS source_messages
            LEFT JOIN temp_ranked_target_messages AS target_messages
                ON target_messages.target_session_id = source_messages.target_session_id
               AND target_messages.role = source_messages.role
               AND target_messages.content = source_messages.content
               AND target_messages.created_at = source_messages.created_at
               AND target_messages.occurrence_index = source_messages.occurrence_index
            WHERE target_messages.target_message_id IS NULL;
        `);

        await this.rebuildTempRankedTargetMessages(currentDb);
        await this.rebuildTempMessageMap(currentDb);
    }

    /**
     * 建立已解析轮次的临时数据。
     */
    private async rebuildTempResolvedTurns(currentDb: Database): Promise<void> {
        await currentDb.execute(`
            DROP TABLE IF EXISTS temp_resolved_turns;
            CREATE TEMP TABLE temp_resolved_turns (
                source_turn_id INTEGER PRIMARY KEY,
                target_session_id INTEGER NOT NULL,
                target_model_id INTEGER NOT NULL,
                target_prompt_message_id INTEGER,
                target_response_message_id INTEGER,
                status TEXT NOT NULL,
                error_message TEXT,
                tokens_used INTEGER,
                duration_ms INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            INSERT INTO temp_resolved_turns (
                source_turn_id,
                target_session_id,
                target_model_id,
                target_prompt_message_id,
                target_response_message_id,
                status,
                error_message,
                tokens_used,
                duration_ms,
                created_at,
                updated_at
            )
            SELECT
                source_turns.id,
                session_map.target_session_id,
                target_models.id,
                prompt_message_map.target_message_id,
                response_message_map.target_message_id,
                source_turns.status,
                source_turns.error_message,
                source_turns.tokens_used,
                source_turns.duration_ms,
                source_turns.created_at,
                source_turns.updated_at
            FROM imported.session_turns AS source_turns
            INNER JOIN temp_session_map AS session_map
                ON session_map.source_session_id = source_turns.session_id
            INNER JOIN imported.models AS source_models
                ON source_models.id = source_turns.model_id
            INNER JOIN imported.providers AS source_providers
                ON source_providers.id = source_models.provider_id
            INNER JOIN main.providers AS target_providers
                ON target_providers.name = source_providers.name
               AND target_providers.driver = source_providers.driver
            INNER JOIN main.models AS target_models
                ON target_models.provider_id = target_providers.id
               AND target_models.model_id = source_models.model_id
            LEFT JOIN temp_message_map AS prompt_message_map
                ON prompt_message_map.source_message_id = source_turns.prompt_message_id
            LEFT JOIN temp_message_map AS response_message_map
                ON response_message_map.source_message_id = source_turns.response_message_id;
        `);
    }

    /**
     * 同步轮次数据，并建立源轮次到目标轮次的临时映射表。
     */
    private async syncSessionTurns(currentDb: Database): Promise<void> {
        await currentDb.execute(`
            INSERT INTO main.session_turns (
                session_id,
                model_id,
                prompt_message_id,
                response_message_id,
                status,
                error_message,
                tokens_used,
                duration_ms,
                created_at,
                updated_at
            )
            SELECT
                resolved_turns.target_session_id,
                resolved_turns.target_model_id,
                resolved_turns.target_prompt_message_id,
                resolved_turns.target_response_message_id,
                resolved_turns.status,
                resolved_turns.error_message,
                resolved_turns.tokens_used,
                resolved_turns.duration_ms,
                resolved_turns.created_at,
                resolved_turns.updated_at
            FROM temp_resolved_turns AS resolved_turns
            WHERE NOT EXISTS (
                SELECT 1
                FROM main.session_turns AS existing_turns
                WHERE existing_turns.session_id = resolved_turns.target_session_id
                  AND existing_turns.model_id = resolved_turns.target_model_id
                  AND existing_turns.prompt_message_id IS resolved_turns.target_prompt_message_id
                  AND existing_turns.created_at = resolved_turns.created_at
            );

            DROP TABLE IF EXISTS temp_turn_candidates;
            CREATE TEMP TABLE temp_turn_candidates (
                source_turn_id INTEGER NOT NULL,
                target_turn_id INTEGER NOT NULL
            );

            INSERT INTO temp_turn_candidates (source_turn_id, target_turn_id)
            SELECT
                resolved_turns.source_turn_id,
                target_turns.id
            FROM temp_resolved_turns AS resolved_turns
            INNER JOIN main.session_turns AS target_turns
                ON target_turns.session_id = resolved_turns.target_session_id
               AND target_turns.model_id = resolved_turns.target_model_id
               AND target_turns.prompt_message_id IS resolved_turns.target_prompt_message_id
               AND target_turns.created_at = resolved_turns.created_at;
        `);

        await this.assertCompleteUniqueMapping(currentDb, {
            sourceTable: 'temp_resolved_turns',
            sourceIdColumn: 'source_turn_id',
            candidateTable: 'temp_turn_candidates',
            candidateSourceColumn: 'source_turn_id',
            entityLabel: '会话轮次',
        });

        await currentDb.execute(`
            DROP TABLE IF EXISTS temp_turn_map;
            CREATE TEMP TABLE temp_turn_map (
                source_turn_id INTEGER PRIMARY KEY,
                target_turn_id INTEGER NOT NULL
            );

            INSERT INTO temp_turn_map (source_turn_id, target_turn_id)
            SELECT
                source_turn_id,
                MIN(target_turn_id) AS target_turn_id
            FROM temp_turn_candidates
            GROUP BY source_turn_id;

            DROP TABLE temp_turn_candidates;

            -- 优化：使用单次 JOIN，避免多个相关子查询
            UPDATE main.session_turns
            SET
                (response_message_id, status, error_message, tokens_used, duration_ms, updated_at) = (
                    SELECT
                        resolved_turns.target_response_message_id,
                        resolved_turns.status,
                        resolved_turns.error_message,
                        resolved_turns.tokens_used,
                        resolved_turns.duration_ms,
                        resolved_turns.updated_at
                    FROM temp_turn_map AS turn_map
                    INNER JOIN temp_resolved_turns AS resolved_turns
                        ON resolved_turns.source_turn_id = turn_map.source_turn_id
                    WHERE turn_map.target_turn_id = main.session_turns.id
                )
            WHERE id IN (SELECT target_turn_id FROM temp_turn_map);
        `);
    }

    /**
     * 合并附件缓存及消息附件关联。
     */
    private async mergeAttachmentData(currentDb: Database): Promise<void> {
        await currentDb.execute(`
            INSERT INTO main.attachments (
                hash, type, original_name, mime_type, size, created_at
            )
            SELECT
                source_attachments.hash,
                source_attachments.type,
                source_attachments.original_name,
                source_attachments.mime_type,
                source_attachments.size,
                source_attachments.created_at
            FROM imported.attachments AS source_attachments
            WHERE NOT EXISTS (
                SELECT 1
                FROM main.attachments AS existing_attachments
                WHERE existing_attachments.hash = source_attachments.hash
            )
        `);

        await currentDb.execute(`
            INSERT INTO main.message_attachments (
                message_id, attachment_id, sort_order, created_at
            )
            SELECT
                message_map.target_message_id,
                target_attachments.id,
                source_message_attachments.sort_order,
                source_message_attachments.created_at
            FROM imported.message_attachments AS source_message_attachments
            INNER JOIN temp_message_map AS message_map
                ON message_map.source_message_id = source_message_attachments.message_id
            INNER JOIN imported.attachments AS source_attachments
                ON source_attachments.id = source_message_attachments.attachment_id
            INNER JOIN main.attachments AS target_attachments
                ON target_attachments.hash = source_attachments.hash
            WHERE NOT EXISTS (
                SELECT 1
                FROM main.message_attachments AS existing_message_attachments
                WHERE existing_message_attachments.message_id = message_map.target_message_id
                  AND existing_message_attachments.attachment_id = target_attachments.id
                  AND existing_message_attachments.sort_order = source_message_attachments.sort_order
            )
        `);
    }

    /**
     * 差量导入对话数据（会话、消息、轮次与尝试记录）
     * 这是两种导入模式的公共部分
     */
    private async mergeChatData(currentDb: Database): Promise<void> {
        // 合并会话
        await currentDb.execute(`
            INSERT INTO main.sessions (
                session_id, title, model, provider_id, last_message_preview, last_message_at,
                message_count, pinned_at, archived_at, created_at, updated_at
            )
            SELECT
                source_sessions.session_id,
                source_sessions.title,
                source_sessions.model,
                target_session_providers.id,
                source_sessions.last_message_preview,
                source_sessions.last_message_at,
                source_sessions.message_count,
                source_sessions.pinned_at,
                source_sessions.archived_at,
                source_sessions.created_at,
                source_sessions.updated_at
            FROM imported.sessions AS source_sessions
            LEFT JOIN imported.providers AS source_session_providers
                ON source_session_providers.id = source_sessions.provider_id
            LEFT JOIN main.providers AS target_session_providers
                ON target_session_providers.name = source_session_providers.name
               AND target_session_providers.driver = source_session_providers.driver
            WHERE true
            ON CONFLICT(session_id) DO UPDATE SET
                title = excluded.title,
                model = excluded.model,
                provider_id = excluded.provider_id,
                last_message_preview = excluded.last_message_preview,
                last_message_at = excluded.last_message_at,
                message_count = excluded.message_count,
                pinned_at = excluded.pinned_at,
                archived_at = excluded.archived_at,
                updated_at = excluded.updated_at
        `);

        await this.rebuildTempSessionMap(currentDb);

        await this.syncMessages(currentDb);
        await this.mergeAttachmentData(currentDb);
        await this.rebuildTempResolvedTurns(currentDb);
        await this.syncSessionTurns(currentDb);

        // 合并会话轮次尝试记录
        await currentDb.execute(`
            INSERT INTO main.session_turn_attempts (
                turn_id, attempt_index, max_retries, status, error_message, duration_ms,
                started_at, finished_at, created_at, updated_at
            )
            SELECT
                turn_map.target_turn_id,
                source_attempts.attempt_index,
                source_attempts.max_retries,
                source_attempts.status,
                source_attempts.error_message,
                source_attempts.duration_ms,
                source_attempts.started_at,
                source_attempts.finished_at,
                source_attempts.created_at,
                source_attempts.updated_at
            FROM imported.session_turn_attempts AS source_attempts
            INNER JOIN temp_turn_map AS turn_map
                ON turn_map.source_turn_id = source_attempts.turn_id
            WHERE NOT EXISTS (
                SELECT 1
                FROM main.session_turn_attempts AS existing_attempts
                WHERE existing_attempts.turn_id = turn_map.target_turn_id
                  AND existing_attempts.attempt_index = source_attempts.attempt_index
            )
        `);
    }

    /**
     * 仅导入对话数据（会话、消息、轮次与尝试记录）
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

                INSERT INTO main.providers (
                    id, name, driver, api_endpoint, api_key, config_json, logo,
                    enabled, is_builtin, created_at, updated_at
                )
                SELECT
                    id, name, driver, api_endpoint, api_key, config_json, logo,
                    enabled, is_builtin, created_at, updated_at
                FROM imported.providers
                WHERE true
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    driver = excluded.driver,
                    api_endpoint = excluded.api_endpoint,
                    api_key = excluded.api_key,
                    config_json = excluded.config_json,
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
                WHERE name IN (
                    'providers',
                    'models',
                    'sessions',
                    'messages',
                    'attachments',
                    'message_attachments',
                    'session_turns',
                    'session_turn_attempts',
                    'settings',
                    'statistics',
                    'llm_metadata'
                );

                INSERT INTO main.sqlite_sequence (name, seq) SELECT 'providers', COALESCE(MAX(id), 0) FROM main.providers;
                INSERT INTO main.sqlite_sequence (name, seq) SELECT 'models', COALESCE(MAX(id), 0) FROM main.models;
                INSERT INTO main.sqlite_sequence (name, seq) SELECT 'sessions', COALESCE(MAX(id), 0) FROM main.sessions;
                INSERT INTO main.sqlite_sequence (name, seq) SELECT 'messages', COALESCE(MAX(id), 0) FROM main.messages;
                INSERT INTO main.sqlite_sequence (name, seq) SELECT 'attachments', COALESCE(MAX(id), 0) FROM main.attachments;
                INSERT INTO main.sqlite_sequence (name, seq) SELECT 'message_attachments', COALESCE(MAX(id), 0) FROM main.message_attachments;
                INSERT INTO main.sqlite_sequence (name, seq) SELECT 'session_turns', COALESCE(MAX(id), 0) FROM main.session_turns;
                INSERT INTO main.sqlite_sequence (name, seq) SELECT 'session_turn_attempts', COALESCE(MAX(id), 0) FROM main.session_turn_attempts;
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
