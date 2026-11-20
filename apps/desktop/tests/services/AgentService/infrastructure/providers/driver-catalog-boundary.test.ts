import { describe, expect, it, vi } from 'vitest';

const { throwAdapterLeak } = vi.hoisted(() => ({
    throwAdapterLeak: (name: string): never => {
        throw new Error(`adapter module leaked into settings bundle: ${name}`);
    },
}));

/**
 * 设置页展示 provider 信息、元数据模块获取 fetch 时都不需要任何厂商适配器。
 * 这里把所有 adapter 模块替换为一导入即抛错，用来守住"展示代码不拉全部 driver"的边界。
 */
vi.mock('@touchai/models/providers/openai', () => throwAdapterLeak('openai'));
vi.mock('@touchai/models/providers/openai-compatible', () => throwAdapterLeak('openai-compatible'));
vi.mock('@touchai/models/providers/anthropic', () => throwAdapterLeak('anthropic'));
vi.mock('@touchai/models/providers/anthropic-compatible', () =>
    throwAdapterLeak('anthropic-compatible')
);
vi.mock('@touchai/models/providers/google', () => throwAdapterLeak('google'));
vi.mock('@touchai/models/providers/deepseek', () => throwAdapterLeak('deepseek'));
vi.mock('@touchai/models/providers/xai', () => throwAdapterLeak('xai'));
vi.mock('@touchai/models/providers/moonshot', () => throwAdapterLeak('moonshot'));
vi.mock('@touchai/models/providers/alibaba', () => throwAdapterLeak('alibaba'));
vi.mock('@touchai/models/providers/minimax', () => throwAdapterLeak('minimax'));
vi.mock('@touchai/models/providers/zhipu', () => throwAdapterLeak('zhipu'));
vi.mock('@touchai/models/providers/mimo', () => throwAdapterLeak('mimo'));

describe('provider adapter import boundary', () => {
    it('loads the settings provider UI without importing any vendor adapter', async () => {
        await expect(
            import('@/views/SettingsView/components/AiServices/index.vue')
        ).resolves.toBeTruthy();
    }, 120_000);

    it('loads the model metadata module without importing any vendor adapter', async () => {
        await expect(import('@/modules/models')).resolves.toBeTruthy();
    });
});
