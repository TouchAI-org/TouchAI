import { describe, expect, it } from 'vitest';

import {
    COMMENT_MARKER,
    layersIn,
    lostLayers,
    mergeSection,
} from '../../scripts/ci/visual-comment-merge.mjs';

/**
 * One comment holds both layers, written by two workflows that finish at different
 * times. The merge is the only thing standing between "the app report is on the pull
 * request" and "whichever workflow ran last erased the other", so it is tested on its
 * own rather than through the posting script.
 */
const startOf = (layer: string) => `<!-- visual-report:${layer}:start -->`;
const endOf = (layer: string) => `<!-- visual-report:${layer}:end -->`;

const blockOf = (body: string, layer: string): string => {
    const start = body.indexOf(startOf(layer));
    const end = body.indexOf(endOf(layer));

    if (start === -1 || end === -1) {
        return '';
    }

    return body.slice(start, end + endOf(layer).length);
};

const componentsSection = '### Components\n\nEvery component baseline matched.';
const e2eSection = '### App window\n\n2 baselines differ from the committed images.';

describe('user reads one comment that holds both visual layers', () => {
    it('user still sees the components report after the app layer writes its own', () => {
        const afterComponents = mergeSection(null, 'components', componentsSection);
        const afterE2e = mergeSection(afterComponents, 'e2e', e2eSection);

        // The other layer's block has to survive byte for byte, not merely in spirit:
        // a re-rendered block would drift on every alternating run and show up as a
        // change in the comment's history.
        expect(blockOf(afterE2e, 'components')).toBe(blockOf(afterComponents, 'components'));
        expect(blockOf(afterE2e, 'components')).toContain('Every component baseline matched');
        expect(blockOf(afterE2e, 'e2e')).toContain('2 baselines differ');

        // And the reverse order produces the same comment, so the two workflows can
        // finish in either order.
        const reverse = mergeSection(
            mergeSection(null, 'e2e', e2eSection),
            'components',
            componentsSection
        );

        expect(blockOf(reverse, 'e2e')).toBe(blockOf(afterE2e, 'e2e'));
        expect(blockOf(reverse, 'components')).toBe(blockOf(afterE2e, 'components'));
    });

    it('user still sees the app report after the components layer rewrites its own', () => {
        const both = mergeSection(
            mergeSection(null, 'components', componentsSection),
            'e2e',
            e2eSection
        );
        const rewritten = mergeSection(both, 'components', '### Components\n\n1 baseline differs.');

        expect(blockOf(rewritten, 'e2e')).toBe(blockOf(both, 'e2e'));
        expect(blockOf(rewritten, 'components')).toContain('1 baseline differs');
        expect(blockOf(rewritten, 'components')).not.toContain('Every component baseline matched');
    });

    it('user sees the new layer appended when the comment exists without it', () => {
        // The marker is there but nothing has written this layer yet, which is what the
        // first run of the app workflow against an existing component comment looks like.
        const existing = `${COMMENT_MARKER}\n\n${startOf('components')}\n\n${componentsSection}\n\n${endOf('components')}\n`;
        const merged = mergeSection(existing, 'e2e', e2eSection);

        expect(blockOf(merged, 'components')).toContain('Every component baseline matched');
        expect(blockOf(merged, 'e2e')).toContain('2 baselines differ');
        // The marker is not duplicated: two comments would each be found by the next run
        // and only one of them would ever be updated.
        expect(merged.split(COMMENT_MARKER)).toHaveLength(2);
    });

    it('user sees a complete comment when there was none before', () => {
        const merged = mergeSection('', 'components', componentsSection);

        expect(merged.startsWith(COMMENT_MARKER)).toBe(true);
        expect(merged.endsWith('\n')).toBe(true);
        expect(blockOf(merged, 'components')).toContain('Every component baseline matched');
        // Deterministic: the same inputs produce the same comment, so a re-run does not
        // register as an edit.
        expect(mergeSection('', 'components', componentsSection)).toBe(merged);
    });

    it('user never has a report closed early by a hostile section', () => {
        // A snapshot name reaches the section body from a test file, which a pull
        // request author controls. A name carrying an end marker would close the block
        // and leave the rest of the section outside it, where the next merge would
        // overwrite it as if it belonged to the other layer.
        const hostile = [
            '### App window',
            '',
            `2 baselines differ. ${endOf('e2e')}`,
            '',
            'Injected prose that pretends to be the other layer.',
            '',
            `${startOf('components')}`,
        ].join('\n');

        const merged = mergeSection(null, 'e2e', hostile);

        expect(merged.split(endOf('e2e'))).toHaveLength(2);
        expect(merged.split(startOf('components'))).toHaveLength(1);
        // The prose survives as text inside the block rather than as structure outside
        // it, so it cannot be mistaken for another layer's report.
        expect(blockOf(merged, 'e2e')).toContain('Injected prose');
        expect(merged.endsWith(`${endOf('e2e')}\n`)).toBe(true);
    });

    it('user never sees a layer name that cannot be addressed', () => {
        // The layer name becomes part of a marker, so a value that can close the comment
        // would make its own block unreachable on the next run.
        expect(() => mergeSection('', 'e2e --> <!-- x', e2eSection)).toThrow(
            /invalid visual layer/
        );
        expect(() => mergeSection('', '', e2eSection)).toThrow(/invalid visual layer/);
    });
});

/**
 * The two workflows are independent, so each write is a read-modify-write over a comment
 * the other one also writes. A correct merge function is not enough: if the other layer
 * lands between this run's read and its write, the merge was computed from a stale body
 * and the write reverts the other layer. These are the checks that catch it afterwards.
 */
describe('user is never shown a report that lost a layer', () => {
    it('user sees the layers a comment actually holds', () => {
        const body = mergeSection(
            mergeSection(null, 'components', componentsSection),
            'e2e',
            e2eSection
        );

        expect(layersIn(body).sort()).toEqual(['components', 'e2e']);
        expect(layersIn(COMMENT_MARKER)).toEqual([]);
        expect(layersIn('')).toEqual([]);
    });

    it('user is told which layer a stale write destroyed', () => {
        const both = mergeSection(
            mergeSection(null, 'components', componentsSection),
            'e2e',
            e2eSection
        );
        // What a stale write looks like: the components block is gone and only e2e remains.
        const afterStaleWrite = mergeSection(null, 'e2e', e2eSection);

        expect(lostLayers(layersIn(both), layersIn(afterStaleWrite), 'e2e')).toEqual([
            'components',
        ]);
    });

    it('user sees no loss reported when the write kept everything', () => {
        const before = layersIn(mergeSection(null, 'components', componentsSection));
        const after = layersIn(
            mergeSection(mergeSection(null, 'components', componentsSection), 'e2e', e2eSection)
        );

        expect(lostLayers(before, after, 'e2e')).toEqual([]);
    });

    it('user sees a write that lost its own block treated as a loss', () => {
        // A PATCH that dropped the very layer it was writing is just as broken as one
        // that dropped the other layer, and the before-state would not reveal it.
        expect(lostLayers([], [], 'components')).toEqual(['components']);
    });
});
