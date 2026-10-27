import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const { throwSnapshotLeak } = vi.hoisted(() => ({
    throwSnapshotLeak: (): never => {
        throw new Error('snapshot.json must only load from the seed entry');
    },
}));

/**
 * 内置快照有 1.6MB，只服务于「空库兜底种子」。
 * 普通 sync / refresh / 设置页展示导入轻入口时不应连带解析整份快照。
 */
vi.mock('@/services/AgentService/infrastructure/modelMetadata/snapshot.json', () =>
    throwSnapshotLeak()
);

describe('model metadata entry boundary', () => {
    it('loads the light entry without touching snapshot.json', async () => {
        const mod = await import('@/services/AgentService/infrastructure/modelMetadata/index');

        expect(mod.buildMetadataList).toBeTypeOf('function');
        expect(mod.syncAllModelsMetadata).toBeTypeOf('function');
        expect(mod.refreshModelMetadataIfStale).toBeTypeOf('function');
        expect('seedModelMetadataFromSnapshot' in mod).toBe(false);
        // 全量并发跑时会与其它用例竞争 CPU；显式放宽超时，避免把加载耗时当成真实回归。
    }, 30_000);

    it('loads the sync entry without touching snapshot.json', async () => {
        await expect(
            import('@/services/AgentService/infrastructure/modelMetadata/sync')
        ).resolves.toBeTruthy();
    });

    it('keeps the seeding function in the dedicated seed entry', () => {
        const seedSource = readFileSync(
            resolve(
                process.cwd(),
                'src/services/AgentService/infrastructure/modelMetadata/seed.ts'
            ),
            'utf8'
        );

        expect(seedSource).toContain('export async function seedModelMetadataFromSnapshot');
        expect(seedSource).toContain('snapshot.json');
    });
});
