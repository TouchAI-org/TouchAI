import { mount } from '@vue/test-utils';
import { type ParsedNode, parseMarkdownToStructure } from 'markstream-vue';
import { describe, expect, it, vi } from 'vitest';

vi.mock('markstream-vue', async (importOriginal) => {
    const original = await importOriginal<typeof import('markstream-vue')>();
    return {
        ...original,
        parseMarkdownToStructure: vi.fn(original.parseMarkdownToStructure),
        default: { name: 'MarkdownRender', props: ['nodes'], template: '<div />' },
    };
});
vi.mock('@services/NotificationService', () => ({ notify: vi.fn() }));
vi.mock('@/services/ClipboardService', () => ({ clipboardService: { writeText: vi.fn() } }));

import MarkdownContent from '@components/MarkdownContent.vue';

const mathSource =
    '用两个 `$$` 包裹：\n\n' +
    String.raw`**示例1：高斯积分**

$$
\int_{-\infty}^{+\infty} e^{-x^2}\,dx=\sqrt{\pi}
$$

**示例2：欧拉恒等式**

$$
e^{i\pi}+1=0
$$

**示例3：泰勒展开**

$$
f(x)=\sum_{n=0}^{\infty} x^n
$$

**示例4：矩阵**

$$
\begin{pmatrix}a&b\\c&d\end{pmatrix}
$$
`;

function mathBlocks(nodes: ParsedNode[]) {
    return nodes.filter(
        (node): node is Extract<ParsedNode, { type: 'math_block' }> => node.type === 'math_block'
    );
}

describe('MarkdownContent with the real streaming parser', () => {
    it.each([
        ['ordinary prose', 'auto'],
        ['Inline math $x^2$', 'auto'],
        ['```sh\necho $HOME\n```', 'auto'],
        ['$$\nx^2\n$$', false],
        ['\\[\nx^2\n\\]', false],
    ] as const)('selects the parser strategy for %s', (content, streamParse) => {
        vi.mocked(parseMarkdownToStructure).mockClear();
        const wrapper = mount(MarkdownContent, { props: { content, final: false } });
        try {
            expect(parseMarkdownToStructure).toHaveBeenLastCalledWith(content, expect.anything(), {
                final: false,
                streamParse,
            });
        } finally {
            wrapper.unmount();
        }
    });

    it('keeps headings out of math blocks across split closing delimiters', async () => {
        const wrapper = mount(MarkdownContent, { props: { content: '', final: false } });
        const renderer = wrapper.findComponent({ name: 'MarkdownRender' });
        try {
            for (const end of [1, 5, 16, 46, 73, 115, 180, mathSource.length]) {
                await wrapper.setProps({ content: mathSource.slice(0, end) });
                const blocks = mathBlocks(renderer.props('nodes'));
                for (const block of blocks) {
                    expect(block.content, `chunk ending at ${end}`).not.toContain('**示例');
                }
            }
            const streamingBlocks = mathBlocks(renderer.props('nodes'));
            expect(streamingBlocks).toHaveLength(4);
            expect(streamingBlocks.every((node) => !node.loading)).toBe(true);
            await wrapper.setProps({ final: true });
            expect(mathBlocks(renderer.props('nodes'))).toEqual(streamingBlocks);
        } finally {
            wrapper.unmount();
        }
    });

    it('keeps math boundaries stable for character-sized and varied chunks', async () => {
        const wrapper = mount(MarkdownContent, { props: { content: '', final: false } });
        const renderer = wrapper.findComponent({ name: 'MarkdownRender' });
        try {
            for (let seed = 0; seed < 20; seed += 1) {
                await wrapper.setProps({ content: '' });
                let state = seed;
                for (let end = 1; end <= mathSource.length; ) {
                    await wrapper.setProps({ content: mathSource.slice(0, end) });
                    for (const block of mathBlocks(renderer.props('nodes'))) {
                        expect(block.content, `seed ${seed}, chunk ${end}`).not.toContain(
                            '**\u793a\u4f8b'
                        );
                    }
                    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
                    end += seed === 0 ? 1 : 1 + (state % 70);
                }
            }
        } finally {
            wrapper.unmount();
        }
    });

    it('preserves bracket math, inline math, shell variables, and fenced code', async () => {
        const content =
            'Inline math $x^2$, path $HOME/project.\n\n\\[\n\\frac{1}{2}\n\\]\n\n## After math\n\n' +
            '```sh\necho $HOME\n```';
        const wrapper = mount(MarkdownContent, { props: { content, final: false } });
        const renderer = wrapper.findComponent({ name: 'MarkdownRender' });
        try {
            const nodes: ParsedNode[] = renderer.props('nodes');
            expect(mathBlocks(nodes)).toHaveLength(1);
            expect(mathBlocks(nodes)[0]).toMatchObject({ content: '\\frac{1}{2}', loading: false });
            expect(JSON.stringify(nodes)).toContain('math_inline');
            expect(JSON.stringify(nodes)).toContain('$HOME/project');
            expect(nodes.find((node) => node.type === 'code_block')).toMatchObject({
                code: 'echo $HOME\n',
                loading: false,
            });
        } finally {
            wrapper.unmount();
        }
    });

    it('keeps incomplete formulas loading and completes them without waiting for final', async () => {
        const wrapper = mount(MarkdownContent, {
            props: { content: '$$\n\\frac{1}', final: false },
        });
        const renderer = wrapper.findComponent({ name: 'MarkdownRender' });
        try {
            expect(mathBlocks(renderer.props('nodes'))[0]).toMatchObject({ loading: true });
            await wrapper.setProps({ content: '$$\n\\frac{1}{2}\n$$\n\n## After math\n\nText' });
            expect(mathBlocks(renderer.props('nodes'))).toHaveLength(1);
            expect(mathBlocks(renderer.props('nodes'))[0]).toMatchObject({
                content: '\\frac{1}{2}',
                loading: false,
            });
            expect(
                renderer.props('nodes').some((node: ParsedNode) => node.type === 'heading')
            ).toBe(true);
        } finally {
            wrapper.unmount();
        }
    });

    it('preserves streaming code and source newlines after a math block', async () => {
        const prefix = '$$\nx^2\n$$\n\n';
        const code = 'const value = "' + 'x'.repeat(300) + '";\n\nconsole.log(value);';
        const wrapper = mount(MarkdownContent, {
            props: { content: prefix + '```js\n' + code, final: false },
        });
        const renderer = wrapper.findComponent({ name: 'MarkdownRender' });
        try {
            expect(
                renderer.props('nodes').find((node: ParsedNode) => node.type === 'code_block')
            ).toMatchObject({ code, loading: true });
            await wrapper.setProps({
                content: prefix + '```js\n' + code + '\n```\n\nDone',
                final: true,
            });
            expect(
                renderer.props('nodes').find((node: ParsedNode) => node.type === 'code_block')
            ).toMatchObject({ code: code + '\n', loading: false });
        } finally {
            wrapper.unmount();
        }
    });
});
