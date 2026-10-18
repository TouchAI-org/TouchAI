import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ToolLogContent from '@/components/ToolLogContent.vue';
import { parseBashLogOutput } from '@/components/toolLogDisplay';
import { setLocale } from '@/i18n';
import { clipboardService } from '@/services/ClipboardService';

vi.mock('@/services/ClipboardService', () => ({
    clipboardService: { writeText: vi.fn(async () => undefined) },
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        template: '<span data-testid="app-icon" />',
    },
}));

const bashInput = JSON.stringify({
    command: 'Get-ChildItem -Force',
    workingDirectory: 'C:/requested',
    reason: 'Inspect files',
});
const bashOutput =
    'Shell: powershell\nWorking directory: D:/actual\nExit code: 0\nDuration: 42ms\n\nfile content';

describe('tool log content', () => {
    beforeEach(() => {
        setLocale('zh-CN');
        vi.mocked(clipboardService.writeText).mockClear();
    });

    it('places the actual working directory above the command and removes it from the result', async () => {
        const wrapper = mount(ToolLogContent, {
            props: { input: bashInput, output: bashOutput, isBash: true },
        });

        const inputSection = wrapper.get('[data-testid="tool-log-input-section"]');
        const outputSection = wrapper.get('[data-testid="tool-log-output-section"]');
        expect(inputSection.text()).toContain('工作目录');
        expect(inputSection.get('[data-testid="tool-log-working-directory"]').text()).toBe(
            'D:/actual'
        );
        expect(inputSection.get('pre').text()).toBe('Get-ChildItem -Force');
        expect(outputSection.text()).toContain('退出码 0');
        expect(outputSection.get('pre').text()).toBe('file content');
        expect(outputSection.text()).not.toContain('Working directory:');

        await wrapper.get('button[aria-pressed="false"]').trigger('click');
        expect(inputSection.get('pre').text()).toContain('"reason": "Inspect files"');
        await wrapper.get('button[aria-label="复制输入参数"]').trigger('click');
        expect(clipboardService.writeText).toHaveBeenCalledWith(inputSection.get('pre').text());
        await wrapper.get('button[aria-label="复制输出结果"]').trigger('click');
        expect(clipboardService.writeText).toHaveBeenLastCalledWith('file content');
    });

    it('preserves other tools and unrecognized Bash output verbatim', () => {
        const plain = mount(ToolLogContent, {
            props: { input: '{"name":"test"}', output: '{"ok":true}' },
        });
        expect(plain.find('[data-testid="tool-log-working-directory"]').exists()).toBe(false);
        expect(plain.get('[data-testid="tool-log-output-section"] pre').text()).toContain(
            '"ok": true'
        );

        const legacyOutput = 'Shell: powershell\n\nordinary output';
        const legacy = mount(ToolLogContent, {
            props: { input: bashInput, output: legacyOutput, isBash: true },
        });
        expect(legacy.get('[data-testid="tool-log-output-section"] pre').text()).toBe(legacyOutput);
        expect(legacy.get('[data-testid="tool-log-working-directory"]').text()).toBe(
            'C:/requested'
        );
        expect(parseBashLogOutput(legacyOutput)).toBeNull();
    });

    it('keeps errors visible in a separate section when execution fails before output', () => {
        const wrapper = mount(ToolLogContent, {
            props: { input: bashInput, error: 'Permission denied', isBash: true },
        });

        expect(wrapper.find('[data-testid="tool-log-output-section"]').exists()).toBe(false);
        expect(wrapper.get('[data-testid="tool-log-error-label"]').text()).toBe('错误');
        expect(wrapper.text()).toContain('Permission denied');
    });

    it('does not repeat the same error when the output already includes it', () => {
        const wrapper = mount(ToolLogContent, {
            props: {
                input: '{}',
                output: 'Permission denied',
                error: 'Permission denied',
                isError: true,
            },
        });

        expect(wrapper.get('[data-testid="tool-log-output-section"] pre').text()).toBe(
            'Permission denied'
        );
        expect(wrapper.find('[data-testid="tool-log-error-label"]').exists()).toBe(false);
    });

    it('does not duplicate a Bash error that is part of the formatted result', () => {
        const wrapper = mount(ToolLogContent, {
            props: {
                input: bashInput,
                output: bashOutput.replace('file content', 'Permission denied'),
                error: 'Permission denied',
                isError: true,
                isBash: true,
            },
        });

        expect(wrapper.get('[data-testid="tool-log-output-section"] pre').text()).toBe(
            'Permission denied'
        );
        expect(wrapper.find('[data-testid="tool-log-error-label"]').exists()).toBe(false);
    });

    it('recognizes a compressed Bash result while preserving its output', () => {
        const output = bashOutput.replace('\n\n', '\nCompressed: true\n\n');
        expect(parseBashLogOutput(output)).toMatchObject({
            workingDirectory: 'D:/actual',
            exitCode: '0',
            output: 'file content',
        });
    });
});
