import { describe, expect, it } from 'vitest';

import {
    createArtifactSrcdoc,
    isVisualReplyBridgeMessage,
    sanitizeArtifactHtml,
} from '@/services/VisualReplyService/iframe';

describe('when a generated visual artifact is rendered', () => {
    it('user sees free-form SVG and a sandboxed inline algorithm script', () => {
        const srcdoc = createArtifactSrcdoc(
            '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg><script>document.body.dataset.algorithm="ready"</script>',
            'fixture-nonce'
        );

        expect(srcdoc).toContain('<svg viewBox="0 0 20 20">');
        expect(srcdoc).toContain('document.body.dataset.algorithm="ready"');
        expect(srcdoc).toContain("script-src 'unsafe-inline'");
        expect(srcdoc).toContain("connect-src 'none'");
        expect(srcdoc).not.toContain('allow-same-origin');
    });

    it('user sees safe inline Artifact styles applied in the sandbox', () => {
        const html = sanitizeArtifactHtml(
            '<style>.algorithm { display: grid; gap: 8px; }</style><style>@import "https://example.com/theme.css"; .remote { color: red; }</style><div class="algorithm">Step</div>'
        );

        expect(html).toContain('<style>');
        expect(html).toContain('.algorithm { display: grid; gap: 8px; }');
        expect(html).not.toContain('@import');
        expect(html).not.toContain('https://example.com/theme.css');
        expect(html).toContain('<div class="algorithm">Step</div>');
    });

    it('user cannot load a remote script or keep active event and resource URLs', () => {
        const html = sanitizeArtifactHtml(
            '<script src="https://example.com/app.js"></script><button onclick="alert(1)">Run</button><img src="javascript:alert(2)"><a href="https://example.com">Outside</a>'
        );

        expect(html).not.toContain('<script');
        expect(html).not.toContain('onclick');
        expect(html).not.toContain('javascript:');
        expect(html).not.toContain('href="https://example.com"');
        expect(html).toContain('<button>Run</button>');
    });

    it('user cannot inject a parent document script through the bridge nonce', () => {
        expect(() =>
            createArtifactSrcdoc('<p>safe</p>', '</script><script>alert(1)</script>')
        ).toThrow('Artifact nonce must use a bounded alphanumeric format.');
    });

    it('user receives a visible failure when an artifact exceeds the size limit', () => {
        expect(() => sanitizeArtifactHtml('x'.repeat(150_001))).toThrow(
            'Artifact exceeds 150000 characters.'
        );
    });

    it('user cannot use a malformed bridge message', () => {
        expect(
            isVisualReplyBridgeMessage({
                channel: 'touchai-visual-reply',
                nonce: 'fixture',
                type: 'ready',
                value: true,
            })
        ).toBe(true);
        expect(
            isVisualReplyBridgeMessage({
                channel: 'touchai-visual-reply',
                nonce: 'fixture',
                type: 'resize',
                value: 'large',
            })
        ).toBe(false);
        expect(
            isVisualReplyBridgeMessage({ channel: 'other', nonce: 'fixture', type: 'resize' })
        ).toBe(false);
        expect(isVisualReplyBridgeMessage(null)).toBe(false);
    });
});
