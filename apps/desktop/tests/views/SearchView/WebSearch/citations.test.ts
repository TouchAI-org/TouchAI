import { describe, expect, it } from 'vitest';

import {
    normalizeCitationUrl,
    normalizeWrappedCitations,
} from '@/views/SearchView/components/WebSearch/citations';

const CITATION_URL = 'https://k.sina.com.cn/article_7857201856.html?from=tech';
const OTHER_URL = 'https://docs.example.com/guide';

/** 本次搜索来源里只认这一个 URL（与 AssistantMessage 的 citationIndex 同语义）。 */
const index = new Set([normalizeCitationUrl(CITATION_URL)]);
const isCitationUrl = (url: string) => index.has(url);

describe('user reads a citation next to punctuation', () => {
    it('user drops half-width parentheses that wrap the citation after a period', () => {
        // 模型实际输出：`领投。([新浪科技](url))`
        const content = `蓝驰创投等领投。([新浪科技](${CITATION_URL}))`;

        expect(normalizeWrappedCitations(content, isCitationUrl)).toBe(
            `蓝驰创投等领投。[新浪科技](${CITATION_URL})`
        );
    });

    it('user drops full-width parentheses and moves the punctuation before the link', () => {
        const content = `华为宣布量产（[新浪科技](${CITATION_URL})）。`;

        expect(normalizeWrappedCitations(content, isCitationUrl)).toBe(
            `华为宣布量产。[新浪科技](${CITATION_URL})`
        );
    });

    it('user drops parentheses with no surrounding punctuation', () => {
        const content = `消息属实([新浪科技](${CITATION_URL}))`;

        expect(normalizeWrappedCitations(content, isCitationUrl)).toBe(
            `消息属实[新浪科技](${CITATION_URL})`
        );
    });

    it('user leaves parentheses around non-search links untouched', () => {
        const content = `参见（[官方文档](${OTHER_URL})）。`;

        expect(normalizeWrappedCitations(content, isCitationUrl)).toBe(content);
    });

    it('user gets the content unchanged when no wrapped citation is present', () => {
        const content = `普通段落，没有任何引用（括号也只是括注）。`;

        expect(normalizeWrappedCitations(content, isCitationUrl)).toBe(content);
    });
});
