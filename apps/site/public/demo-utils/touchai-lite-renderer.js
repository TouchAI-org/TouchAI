(function () {
    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function stripImageMarkdown(value) {
        return String(value)
            .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
            .replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    }

    function renderInline(source) {
        const segments = stripImageMarkdown(source).split(/(`[^`]+`)/g);

        return segments
            .map((segment) => {
                if (!segment) return '';
                if (segment.startsWith('`') && segment.endsWith('`')) {
                    return `<span class="kbd">${escapeHtml(segment.slice(1, -1))}</span>`;
                }

                return escapeHtml(segment).replace(
                    /\*\*([^*]+)\*\*/g,
                    '<strong>$1</strong>'
                );
            })
            .join('');
    }

    function renderMarkdownContent(markdown) {
        const lines = String(markdown).split(/\r?\n/);
        const html = [];
        let paragraphLines = [];
        let listItems = [];

        const flushParagraph = () => {
            if (!paragraphLines.length) return;
            html.push(
                `<p class="paragraph-node">${paragraphLines.map(renderInline).join('<br>')}</p>`
            );
            paragraphLines = [];
        };

        const flushList = () => {
            if (!listItems.length) return;
            html.push(
                `<ul>${listItems
                    .map((item) => `<li>${renderInline(item)}</li>`)
                    .join('')}</ul>`
            );
            listItems = [];
        };

        lines.forEach((line) => {
            const trimmed = stripImageMarkdown(line).trim();

            if (!trimmed) {
                flushParagraph();
                flushList();
                return;
            }

            if (trimmed === '---') {
                flushParagraph();
                flushList();
                html.push(`<p class="response-divider" aria-hidden="true"></p>`);
                return;
            }

            if (trimmed.startsWith('## ')) {
                flushParagraph();
                flushList();
                html.push(`<h2>${renderInline(trimmed.slice(3))}</h2>`);
                return;
            }

            if (trimmed.startsWith('- ')) {
                flushParagraph();
                listItems.push(trimmed.slice(2));
                return;
            }

            flushList();
            paragraphLines.push(trimmed);
        });

        flushParagraph();
        flushList();

        return html.join('\n');
    }

    window.TouchAILiteRenderer = {
        escapeHtml,
        renderInline,
        renderMarkdownContent,
    };
})();
