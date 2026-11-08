import { describe, expect, it } from 'vitest';

import { parseVisualReplySegments } from '@/services/VisualReplyService/protocol';

describe('when a conversation reply mixes prose and visual content', () => {
    it('user sees fenced OpenUI and Artifact blocks separated from Markdown', () => {
        const segments = parseVisualReplySegments(
            'Traffic is up.\n```openui-lang\nroot = Root([])\n```\n```touchai-artifact\n<svg/>\n```'
        );

        expect(segments).toEqual([
            { id: 'markdown-0', type: 'markdown', content: 'Traffic is up.\n' },
            { id: 'openui-15', type: 'openui', content: 'root = Root([])' },
            { id: 'markdown-49', type: 'markdown', content: '\n' },
            { id: 'artifact-50', type: 'artifact', content: '<svg/>' },
        ]);
    });

    it('user sees an unfinished visual block while the reply is streaming', () => {
        expect(parseVisualReplySegments('```openui-lang\nroot = Root([])')).toEqual([
            { id: 'openui-0', type: 'openui', content: 'root = Root([])' },
        ]);
    });

    it('user keeps ordinary fenced code in Markdown', () => {
        expect(parseVisualReplySegments('```html\n<p>code sample</p>\n```')).toEqual([
            { id: 'markdown-0', type: 'markdown', content: '```html\n<p>code sample</p>\n```' },
        ]);
    });
});
