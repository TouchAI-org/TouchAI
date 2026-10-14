import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (path: string) => {
    const file = resolve(__dirname, '../../src', path);
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

describe('shared motion contract', () => {
    it('installs the semantic tokens once', () => {
        expect(read('styles/tailwind.css')).toContain("@import './motion.css'");
        const css = read('styles/motion.css');
        for (const token of [
            '--duration-quick: 150ms',
            '--duration-fast: 250ms',
            '--ease-smooth-out:',
            '--scale-large: 0.96',
        ]) {
            expect(css).toContain(token);
        }
    });
    it('supports reduced motion, including looping status animations', () => {
        const css = read('styles/motion.css');
        expect(css).toContain('@media (prefers-reduced-motion: reduce)');
        expect(css).toContain('animation-iteration-count: 1 !important');
        expect(css).toContain('scroll-behavior: auto !important');
    });
    it('gives overlays and content distinct animation identities for presence cleanup', () => {
        for (const file of [
            'ui/dialog/DialogContent.vue',
            'ui/alert-dialog/AlertDialogContent.vue',
        ]) {
            expect(read('components/' + file)).toContain('t-overlay');
            expect(read('components/' + file)).toContain('t-modal');
            expect(read('components/' + file)).not.toContain('animate-in');
        }
        for (const file of [
            'ui/select/SelectContent.vue',
            'ui/dropdown-menu/DropdownMenuContent.vue',
        ]) {
            expect(read('components/' + file)).toContain('t-dropdown');
        }
    });
    it('uses state-specific enter and exit animations without transition-all', () => {
        const css = read('styles/motion.css');
        expect(css).toContain('t-modal-in');
        expect(css).toContain('t-modal-out');
        expect(css).toContain('t-dropdown-in');
        expect(css).toContain('t-dropdown-out');
        expect(css).not.toMatch(/transition\s*:\s*all/);
        expect(css).not.toContain('will-change:');
    });
});
