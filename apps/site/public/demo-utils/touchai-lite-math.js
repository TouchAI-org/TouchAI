(function () {
    const getRenderer = () => window.TouchAILiteRenderer;

    function escapeHtml(value) {
        const renderer = getRenderer();
        if (renderer?.escapeHtml) {
            return renderer.escapeHtml(value);
        }

        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/`/g, '&#96;');
    }

    function normalizeFormula(source) {
        return String(source)
            .replace(/\\left/g, '')
            .replace(/\\right/g, '')
            .replace(/\\,/g, ' ')
            .replace(/\\:/g, ' ')
            .replace(/\\;/g, ' ')
            .replace(/\\quad/g, '  ')
            .replace(/\\qquad/g, '    ')
            .replace(/\\!/g, '');
    }

    function renderFormula(source, displayMode) {
        if (window.katex && typeof window.katex.renderToString === 'function') {
            try {
                return window.katex.renderToString(String(source), {
                    displayMode,
                    throwOnError: false,
                    strict: 'ignore',
                    trust: false,
                });
            } catch {
                // Fall back to the lightweight renderer below.
            }
        }

        const input = normalizeFormula(source);
        let index = 0;

        const commandMap = {
            theta: 'θ',
            cos: 'cos',
            sin: 'sin',
            max: 'max',
            min: 'min',
            in: '∈',
            Rightarrow: '⇒',
            to: '→',
            cdot: '·',
        };

        const readCommandName = () => {
            index += 1;
            let name = '';
            while (index < input.length && /[A-Za-z]/.test(input[index])) {
                name += input[index];
                index += 1;
            }

            if (!name && index < input.length) {
                name = input[index];
                index += 1;
            }

            return name;
        };

        const readRawGroup = () => {
            if (input[index] !== '{') {
                const start = index;
                index += 1;
                return input.slice(start, index);
            }

            index += 1;
            let depth = 1;
            let value = '';

            while (index < input.length && depth > 0) {
                const char = input[index];
                index += 1;

                if (char === '{') {
                    depth += 1;
                    value += char;
                    continue;
                }

                if (char === '}') {
                    depth -= 1;
                    if (depth > 0) value += char;
                    continue;
                }

                value += char;
            }

            return value;
        };

        const readArgument = () => {
            while (input[index] === ' ') index += 1;

            if (index >= input.length) return '';

            if (input[index] === '{') {
                const raw = readRawGroup();
                return renderFormula(raw, false);
            }

            if (input[index] === '\\') {
                const command = readCommandName();
                if (command === 'text') {
                    return `<span class="op">${escapeHtml(readRawGroup())}</span>`;
                }
                if (command === 'frac') {
                    const num = readArgument();
                    const den = readArgument();
                    return `<span class="frac"><span class="num">${num}</span><span class="den">${den}</span></span>`;
                }
                if (command === 'sqrt') {
                    const radicand = readArgument();
                    return `<span class="root"><span class="radicand">${radicand}</span></span>`;
                }
                if (command === 'boxed') {
                    return `<span class="boxed-formula">${readArgument()}</span>`;
                }

                const mapped = commandMap[command] ?? command;
                return `<span class="${/^[A-Za-z]+$/.test(mapped) ? 'op' : 'punct'}">${escapeHtml(mapped)}</span>`;
            }

            const char = input[index];
            index += 1;
            return escapeHtml(char);
        };

        const parse = (stopChar) => {
            let html = '';

            while (index < input.length) {
                const char = input[index];

                if (stopChar && char === stopChar) {
                    index += 1;
                    break;
                }

                if (char === '{') {
                    index += 1;
                    html += parse('}');
                    continue;
                }

                if (char === '^' || char === '_') {
                    index += 1;
                    const tag = char === '^' ? 'sup' : 'sub';
                    html += `<${tag}>${readArgument()}</${tag}>`;
                    continue;
                }

                if (char === '\\') {
                    const command = readCommandName();

                    if (command === 'frac') {
                        const num = readArgument();
                        const den = readArgument();
                        html += `<span class="frac"><span class="num">${num}</span><span class="den">${den}</span></span>`;
                        continue;
                    }

                    if (command === 'sqrt') {
                        const radicand = readArgument();
                        html += `<span class="root"><span class="radicand">${radicand}</span></span>`;
                        continue;
                    }

                    if (command === 'boxed') {
                        html += `<span class="boxed-formula">${readArgument()}</span>`;
                        continue;
                    }

                    if (command === 'text') {
                        html += `<span class="op">${escapeHtml(readRawGroup())}</span>`;
                        continue;
                    }

                    if (
                        command === ',' ||
                        command === ':' ||
                        command === ';' ||
                        command === 'quad' ||
                        command === 'qquad'
                    ) {
                        html += ' ';
                        continue;
                    }

                    const mapped = commandMap[command] ?? command;
                    const className = /^[A-Za-z]+$/.test(mapped) ? 'op' : 'punct';
                    html += `<span class="${className}">${escapeHtml(mapped)}</span>`;
                    continue;
                }

                html += escapeHtml(char);
                index += 1;
            }

            return html;
        };

        const inner = parse();
        const className = displayMode ? 'formula-module' : 'formula-module inline-formula';

        return `<span class="${className}">${inner}</span>`;
    }

    function renderMarkdownWithMath(markdown) {
        const mathTokens = [];
        const protectedMarkdown = String(markdown)
            .replace(/\$\$([\s\S]+?)\$\$/g, (_, formula) => {
                const token = `@@MATH_BLOCK_${mathTokens.length}@@`;
                mathTokens.push({ token, formula: formula.trim(), display: true });
                return `\n\n${token}\n\n`;
            })
            .replace(/\$([^$\n]+?)\$/g, (_, formula) => {
                const token = `@@MATH_INLINE_${mathTokens.length}@@`;
                mathTokens.push({ token, formula: formula.trim(), display: false });
                return token;
            });

        const renderer = getRenderer();
        let html = renderer
            ? renderer.renderMarkdownContent(protectedMarkdown)
            : escapeHtml(protectedMarkdown);

        mathTokens.forEach(({ token, formula, display }) => {
            const rendered = renderFormula(formula, display);
            const replacement = display
                ? `<div class="math-block"><span class="math-display-frame">${rendered}</span></div>`
                : `<span class="katex-formula">${rendered}</span>`;
            html = html
                .replace(new RegExp(`<p class="paragraph-node">${token}</p>`, 'g'), replacement)
                .replace(new RegExp(token, 'g'), replacement);
        });

        return html;
    }

    window.TouchAILiteMathRenderer = {
        renderFormula,
        renderMarkdownWithMath,
    };
})();
