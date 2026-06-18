export const createHomepageDemoInstanceSelector = (id: string) =>
    `touchai-component-demo[data-demo-id="${id}"]`;

const normalizeHomepageDemoSelector = (selector: string, instanceSelector: string) => {
    const trimmed = selector.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('@')) return trimmed;
    if (trimmed.startsWith('from') || trimmed.startsWith('to') || /^\d+%$/.test(trimmed))
        return trimmed;

    const scoped = trimmed
        .replace(/:root/g, instanceSelector)
        .replace(/\bhtml\s*,\s*body\b/g, instanceSelector)
        .replace(/\bbody((?:\.[\w-]+)+)/g, (_match, classes) => `${instanceSelector}${classes}`)
        .replace(/\bbody\b/g, instanceSelector)
        .replace(/\bhtml\b/g, instanceSelector);

    if (scoped.startsWith(instanceSelector)) {
        return scoped;
    }

    return `${instanceSelector} ${scoped}`;
};

const scopeHomepageDemoSelectorList = (selectorText: string, instanceSelector: string) =>
    selectorText
        .split(',')
        .map((selector) => normalizeHomepageDemoSelector(selector, instanceSelector))
        .filter(Boolean)
        .join(', ');

export const scopeHomepageDemoCss = (css: string, instanceSelector: string) => {
    let index = 0;

    const consumeBlock = (): string => {
        let output = '';
        let selectorBuffer = '';

        while (index < css.length) {
            const char = css[index];

            if (char === '"' || char === "'") {
                const quote = char;
                selectorBuffer += char;
                index += 1;
                while (index < css.length) {
                    const innerChar = css[index];
                    selectorBuffer += innerChar;
                    index += 1;
                    if (innerChar === '\\') {
                        if (index < css.length) {
                            selectorBuffer += css[index];
                            index += 1;
                        }
                        continue;
                    }
                    if (innerChar === quote) break;
                }
                continue;
            }

            if (char === '/' && css[index + 1] === '*') {
                const end = css.indexOf('*/', index + 2);
                const comment = end === -1 ? css.slice(index) : css.slice(index, end + 2);
                selectorBuffer += comment;
                index = end === -1 ? css.length : end + 2;
                continue;
            }

            if (char === '{') {
                const selector = selectorBuffer.trim();
                selectorBuffer = '';
                index += 1;

                if (
                    selector.startsWith('@keyframes') ||
                    selector.startsWith('@-webkit-keyframes')
                ) {
                    const keyframeBodyStart = index;
                    let depth = 1;
                    while (index < css.length && depth > 0) {
                        if (css[index] === '{') depth += 1;
                        if (css[index] === '}') depth -= 1;
                        index += 1;
                    }
                    output += `${selector}{${css.slice(keyframeBodyStart, index - 1)}}`;
                    continue;
                }

                if (selector.startsWith('@')) {
                    const inner = consumeBlock();
                    output += `${selector}{${inner}}`;
                    continue;
                }

                const bodyStart = index;
                let depth = 1;
                while (index < css.length && depth > 0) {
                    if (css[index] === '{') depth += 1;
                    if (css[index] === '}') depth -= 1;
                    index += 1;
                }
                const body = css.slice(bodyStart, index - 1);
                output += `${scopeHomepageDemoSelectorList(selector, instanceSelector)}{${body}}`;
                continue;
            }

            if (char === '}') {
                index += 1;
                output += selectorBuffer;
                return output;
            }

            selectorBuffer += char;
            index += 1;
        }

        output += selectorBuffer;
        return output;
    };

    return consumeBlock();
};

export const createHomepageDemoHostCss = (instanceSelector: string) => `
${instanceSelector} {
    display: block;
    width: 100%;
    height: 100%;
    overflow: hidden;
    border-radius: inherit;
    isolation: isolate;
    background: var(--page-bg, transparent);
    color-scheme: light;
}

${instanceSelector}.component-frame {
    width: min(60vw, 680px, 100%) !important;
    max-width: min(680px, 100%);
    justify-self: center;
    overflow: visible !important;
}

${instanceSelector}.component-frame .stage {
    width: 100% !important;
    max-width: 100% !important;
}

${instanceSelector}.feature-component-frame,
${instanceSelector}.feature-work-frame,
${instanceSelector}.feature-reminder-frame {
    display: flex;
    align-items: stretch;
    justify-content: center;
    width: 760px !important;
    height: 657px !important;
    min-height: 657px !important;
    max-height: 657px !important;
    overflow: visible !important;
    background: transparent !important;
}

${instanceSelector}.feature-component-frame .stage,
${instanceSelector}.feature-work-frame .stage,
${instanceSelector}.feature-reminder-frame .stage {
    width: 100% !important;
    min-height: 100% !important;
    height: 100% !important;
    padding: 0 !important;
    justify-content: flex-start !important;
    align-items: center !important;
}

${instanceSelector}.component-frame .chat-panel,
${instanceSelector}.feature-component-frame .chat-panel,
${instanceSelector}.feature-work-frame .chat-panel,
${instanceSelector}.feature-reminder-frame .chat-panel {
    margin: 0 auto !important;
    box-shadow:
        0 34px 90px rgba(107, 114, 128, 0.22),
        0 12px 34px rgba(107, 114, 128, 0.12),
        0 0 48px rgba(107, 114, 128, 0.14) !important;
}

${instanceSelector}.is-scroll-driven .chat-panel {
    will-change: auto !important;
}

${instanceSelector}.component-frame .chat-panel {
    width: 100% !important;
    max-width: 100% !important;
}

${instanceSelector}.component-frame.is-idle .chat-panel {
    border-radius: 8px !important;
    overflow: hidden !important;
    background: var(--panel, #fff) !important;
}

${instanceSelector}.component-frame .conversation-content {
    flex: 1 1 auto !important;
    min-height: 0 !important;
    overflow-y: auto !important;
    padding-bottom: 18px !important;
    overscroll-behavior: contain !important;
    scrollbar-width: none !important;
    -webkit-overflow-scrolling: touch !important;
}

${instanceSelector}.component-frame .conversation-content,
${instanceSelector}.feature-component-frame .conversation-content,
${instanceSelector}.feature-work-frame .conversation-content,
${instanceSelector}.feature-reminder-frame .conversation-content {
    min-height: 0 !important;
    overflow-y: auto !important;
    overscroll-behavior: contain !important;
    scrollbar-width: none !important;
    -webkit-overflow-scrolling: touch !important;
}

${instanceSelector}.component-frame .conversation-content::-webkit-scrollbar,
${instanceSelector}.feature-component-frame .conversation-content::-webkit-scrollbar,
${instanceSelector}.feature-work-frame .conversation-content::-webkit-scrollbar,
${instanceSelector}.feature-reminder-frame .conversation-content::-webkit-scrollbar {
    display: none;
}

${instanceSelector}.component-frame.is-answering .chat-panel,
${instanceSelector}.component-frame.is-complete .chat-panel,
${instanceSelector}.feature-component-frame.is-answering .chat-panel,
${instanceSelector}.feature-component-frame.is-complete .chat-panel,
${instanceSelector}.feature-work-frame.is-answering .chat-panel,
${instanceSelector}.feature-work-frame.is-complete .chat-panel,
${instanceSelector}.feature-reminder-frame.is-answering .chat-panel,
${instanceSelector}.feature-reminder-frame.is-complete .chat-panel {
    display: flex !important;
    flex-direction: column !important;
    max-width: 100% !important;
}

${instanceSelector}.feature-component-frame.is-answering .stage,
${instanceSelector}.feature-component-frame.is-complete .stage,
${instanceSelector}.feature-work-frame.is-answering .stage,
${instanceSelector}.feature-work-frame.is-complete .stage,
${instanceSelector}.feature-reminder-frame.is-answering .stage,
${instanceSelector}.feature-reminder-frame.is-complete .stage {
    justify-content: flex-start !important;
}

${instanceSelector}.feature-component-frame.is-complete .chat-panel,
${instanceSelector}.feature-work-frame.is-complete .chat-panel,
${instanceSelector}.feature-reminder-frame.is-complete .chat-panel,
${instanceSelector}.feature-component-frame.is-scroll-driven.is-complete .chat-panel,
${instanceSelector}.feature-work-frame.is-scroll-driven.is-complete .chat-panel,
${instanceSelector}.feature-reminder-frame.is-scroll-driven.is-complete .chat-panel {
    min-height: 0 !important;
    height: auto !important;
}

${instanceSelector}.component-frame.is-answering .conversation-content,
${instanceSelector}.component-frame.is-complete .conversation-content,
${instanceSelector}.feature-component-frame.is-answering .conversation-content,
${instanceSelector}.feature-component-frame.is-complete .conversation-content,
${instanceSelector}.feature-work-frame.is-answering .conversation-content,
${instanceSelector}.feature-work-frame.is-complete .conversation-content,
${instanceSelector}.feature-reminder-frame.is-answering .conversation-content,
${instanceSelector}.feature-reminder-frame.is-complete .conversation-content {
    flex: 1 1 auto !important;
    min-height: 0 !important;
    overflow-y: auto !important;
    padding-bottom: 20px !important;
    overscroll-behavior: contain !important;
    -webkit-overflow-scrolling: touch !important;
}

${instanceSelector}.component-frame.is-answering .composer,
${instanceSelector}.component-frame.is-complete .composer,
${instanceSelector}.feature-component-frame.is-answering .composer,
${instanceSelector}.feature-component-frame.is-complete .composer,
${instanceSelector}.feature-work-frame.is-answering .composer,
${instanceSelector}.feature-work-frame.is-complete .composer,
${instanceSelector}.feature-reminder-frame.is-answering .composer,
${instanceSelector}.feature-reminder-frame.is-complete .composer {
    margin-top: auto !important;
}

@media (max-width: 900px) {
    ${instanceSelector}.component-frame {
        width: min(60vw, 520px, 100%) !important;
        height: auto !important;
        min-height: 0 !important;
        aspect-ratio: 760 / 657 !important;
        max-height: min(62vh, 657px) !important;
    }

    ${instanceSelector}.component-frame .stage {
        height: 100% !important;
        min-height: 0 !important;
    }
}

@media (max-height: 780px) {
    ${instanceSelector}.component-frame {
        width: min(52vw, 560px, 100%) !important;
        max-width: min(560px, 100%) !important;
        height: auto !important;
        min-height: 0 !important;
        aspect-ratio: 760 / 657 !important;
        max-height: min(60vh, 520px) !important;
        overflow: hidden !important;
    }

    ${instanceSelector}.component-frame .stage {
        min-height: 0 !important;
        height: 100% !important;
        padding: 0 !important;
        align-items: center !important;
        justify-content: center !important;
    }

    ${instanceSelector}.component-frame.is-answering .chat-panel,
    ${instanceSelector}.component-frame.is-complete .chat-panel,
    ${instanceSelector}.component-frame.is-scroll-driven.is-answering .chat-panel,
    ${instanceSelector}.component-frame.is-scroll-driven.is-complete .chat-panel {
        display: flex !important;
        flex-direction: column !important;
        max-width: 100% !important;
    }
}

@media (max-width: 560px) {
    ${instanceSelector}.component-frame {
        width: min(calc(100vw - 56px), 360px, 100%) !important;
        max-width: min(calc(100vw - 56px), 360px, 100%) !important;
        height: auto !important;
        min-height: 0 !important;
        aspect-ratio: 760 / 657 !important;
        max-height: min(58vh, 420px) !important;
        overflow: visible !important;
    }

    ${instanceSelector}.component-frame .stage {
        min-height: 0 !important;
        height: 100% !important;
        padding: 0 !important;
        align-items: center !important;
        justify-content: center !important;
    }
}
`;
