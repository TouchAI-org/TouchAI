// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';
import Database from '@tauri-apps/plugin-sql';

import type { DrizzleDb } from './driver';
import { createDrizzleDb } from './driver';
import { migrate } from './migrator';
import type { DatabaseOptions, SqlValue } from './schema';
import { seed } from './seed';

/**
 * 数据库管理类
 */
class DatabaseManager {
    private tauriDb: Database | null = null;
    private drizzleDb: DrizzleDb | null = null;
    private initialized: boolean = false;
    private initPromise: Promise<void> | null = null;

    /**
     * 初始化数据库连接和迁移
     * @param options 数据库配置选项
     */
    async init(options?: DatabaseOptions): Promise<void> {
        // 防止并发初始化：如果已经在初始化中，返回现有的 Promise
        if (this.initPromise) {
            return this.initPromise;
        }

        // 防止重复初始化
        if (this.initialized) {
            console.warn('Database already initialized');
            return;
        }

        // 创建初始化 Promise
        this.initPromise = (async () => {
            try {
                const dbPath =
                    options?.path || `sqlite://${await native.database.getDatabasePath()}`;
                this.tauriDb = await Database.load(dbPath);
                const version: { 'sqlite_version()': string }[] =
                    await this.tauriDb.select('SELECT sqlite_version()');
                console.log(
                    `Database initialized. Sqlite Version: ${version[0]?.['sqlite_version()'] ?? 'Unknown'}, Path: ${dbPath}`
                );

                // 运行迁移（创建/更新表结构）
                await migrate(this.tauriDb);

                // 运行种子数据（插入默认配置）
                await seed(this.tauriDb);

                // 创建 Drizzle 实例
                this.drizzleDb = createDrizzleDb(this.tauriDb);

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
     * 获取 Drizzle 数据库实例
     * 自动等待初始化完成，未初始化时自动触发初始化
     * @returns Drizzle 实例
     */
    async getDb(): Promise<DrizzleDb> {
        // 如果正在初始化，等待完成
        if (this.initPromise) {
            await this.initPromise;
        }

        // 如果未初始化，自动初始化
        if (!this.initialized) {
            await this.init();
        }

        if (!this.drizzleDb) {
            throw new Error('Database initialization failed');
        }

        return this.drizzleDb;
    }

    /**
     * 执行原始 SQL 查询，返回对象数组
     *
     * 适用场景：
     * - 复杂的多表 JOIN 查询
     * - 带子查询的复杂 SQL
     * - Drizzle ORM 难以表达的查询
     *
     * 注意：绕过 Drizzle 的类型安全，需自行确保类型正确
     */
    async rawQuery<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
        await this.ensureInitialized();
        return this.tauriDb!.select<T>(sql, params) as Promise<T[]>;
    }

    async reset(closeAll = false): Promise<void> {
        if (this.tauriDb) {
            await this.tauriDb.close(closeAll ? undefined : this.tauriDb.path);
        }

        this.tauriDb = null;
        this.drizzleDb = null;
        this.initialized = false;
        this.initPromise = null;
    }

    private async ensureInitialized(): Promise<void> {
        if (this.initPromise) {
            await this.initPromise;
        }
        if (!this.initialized) {
            await this.init();
        }
    }
}

// 导出单例实例
export const db = new DatabaseManager();

// 导出类型
export type { DrizzleDb } from './driver';
export type { DatabaseOptions } from './schema';
