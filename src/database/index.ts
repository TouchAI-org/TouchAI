// Copyright (c) 2025. 千诚. Licensed under GPL v3

import Database from '@tauri-apps/plugin-sql';
import type { Kysely } from 'kysely';
import { Kysely as KyselyInstance } from 'kysely';

import { createTauriSqlDialect } from './dialect';
import { MigrationManager } from './migrations';
import type { Database as DatabaseSchema, DatabaseOptions } from './schema';

/**
 * 数据库管理类
 * 提供数据库连接、Kysely 实例管理
 */
class DatabaseManager {
    private tauriDb: Database | null = null;
    private kyselyDb: Kysely<DatabaseSchema> | null = null;
    private dbPath: string = 'sqlite://../data/touchai.db';
    private migrationManager: MigrationManager | null = null;
    private initialized: boolean = false;
    private initPromise: Promise<void> | null = null;

    /**
     * 初始化数据库连接和迁移
     * @param options 数据库配置选项
     */
    async init(options?: DatabaseOptions): Promise<void> {
        // 如果已经在初始化中，返回现有的 Promise
        if (this.initPromise) {
            return this.initPromise;
        }

        // 如果已经初始化完成，直接返回
        if (this.initialized) {
            console.warn('Database already initialized');
            return;
        }

        // 创建初始化 Promise
        this.initPromise = (async () => {
            try {
                this.dbPath = options?.path || this.dbPath;
                this.tauriDb = await Database.load(this.dbPath);
                console.log(`Database initialized: ${this.dbPath}`);

                // 创建 Kysely 实例
                this.kyselyDb = new KyselyInstance<DatabaseSchema>({
                    dialect: createTauriSqlDialect(this.tauriDb),
                });

                // 创建迁移管理器并运行迁移
                this.migrationManager = new MigrationManager(this.tauriDb);
                await this.migrationManager.runMigrations();

                this.initialized = true;
            } catch (error) {
                console.error('Failed to initialize database:', error);
                this.initPromise = null; // 重置以允许重试
                throw error;
            }
        })();

        return this.initPromise;
    }

    /**
     * 获取 Kysely 数据库实例
     * 自动等待初始化完成
     * @returns Kysely 实例
     */
    async getKysely(): Promise<Kysely<DatabaseSchema>> {
        // 如果正在初始化，等待完成
        if (this.initPromise) {
            await this.initPromise;
        }

        // 如果未初始化，自动初始化
        if (!this.initialized) {
            await this.init();
        }

        if (!this.kyselyDb) {
            throw new Error('Database initialization failed');
        }

        return this.kyselyDb;
    }

    /**
     * 获取 Kysely 数据库实例（同步版本，仅用于已确保初始化的场景）
     * @returns Kysely 实例
     * @throws 如果数据库未初始化
     * @deprecated 推荐使用异步的 getKysely() 方法
     */
    getKyselySync(): Kysely<DatabaseSchema> {
        if (!this.kyselyDb) {
            throw new Error('Database not initialized. Call init() first or use getKysely().');
        }
        return this.kyselyDb;
    }

    /**
     * 获取原始 Tauri 数据库实例（用于迁移等特殊场景）
     * @returns Tauri Database 实例
     * @throws 如果数据库未初始化
     */
    getTauriDb(): Database {
        if (!this.tauriDb) {
            throw new Error('Database not initialized. Call init() first.');
        }
        return this.tauriDb;
    }

    /**
     * 检查数据库是否已初始化
     */
    isInitialized(): boolean {
        return this.initialized;
    }

    /**
     * 关闭数据库连接
     */
    async close(): Promise<void> {
        if (this.kyselyDb) {
            await this.kyselyDb.destroy();
            this.kyselyDb = null;
        }
        if (this.tauriDb) {
            await this.tauriDb.close();
            this.tauriDb = null;
        }
        this.initialized = false;
    }

    /**
     * 获取数据库路径
     */
    getPath(): string {
        return this.dbPath;
    }
}

// 导出单例实例
export const db = new DatabaseManager();

// 导出类型
export type { DatabaseOptions, Database as DatabaseSchema } from './schema';
