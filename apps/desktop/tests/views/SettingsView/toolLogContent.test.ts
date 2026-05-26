import { mount } from '@vue/test-utils';

import ToolLogContent from '@/components/ToolLogContent.vue';

describe('ToolLogContent', () => {
    it('renders formatted input and output blocks for settings logs', () => {
        const wrapper = mount(ToolLogContent, {
            props: {
                input: '{"command":"Get-Content -Raw README.md","workingDirectory":"D:\\\\Project\\\\TouchAI"}',
                output: 'Exit code: 0\nDuration: 5095ms\n\n# TouchAI',
            },
        });

        const blocks = wrapper.findAll('[data-testid="tool-log-code-block"]');

        expect(blocks).toHaveLength(2);
        expect(wrapper.get('[data-testid="tool-log-input-label"]').text()).toBe('输入参数');
        expect(wrapper.get('[data-testid="tool-log-output-label"]').text()).toBe('结果');
        expect(blocks[0]?.text()).toContain('"command": "Get-Content -Raw README.md"');
        expect(blocks[0]?.text()).toContain('"workingDirectory": "D:\\\\Project\\\\TouchAI"');
        expect(blocks[1]?.text()).toContain('Exit code: 0');
        expect(blocks[1]?.text()).toContain('# TouchAI');
    });
});
