/**
 * Merges one layer's report section into the single pull-request comment.
 *
 * Both visual layers post to one comment, because two comments said the same thing
 * twice and neither said what the other found. The comment is owned by the automation
 * and only the region between a layer's markers is rewritten, so a layer that did not
 * run this time keeps the report it last posted instead of losing it to whoever wrote
 * last.
 *
 * The merge is a pure string function rather than part of the posting script: it is the
 * part that can silently destroy a report, so it is the part that is tested directly.
 */

export const COMMENT_MARKER = '<!-- visual-report -->';

const LAYER_MARKER_PREFIX = '<!-- visual-report:';

const startMarker = (layer) => `<!-- visual-report:${layer}:start -->`;
const endMarker = (layer) => `<!-- visual-report:${layer}:end -->`;

/**
 * The layers that currently have a block in a comment body.
 *
 * Used after writing to check that nothing was lost. The two layers are written by two
 * separate workflows that are not serialised against each other, so each write is a
 * read-modify-write over shared state: if the other layer wrote between this run's read
 * and its write, the write silently reverts it. That is the one failure a correct merge
 * function cannot prevent on its own, so it is detected here and retried by the caller.
 */
export const layersIn = (body) => [
    ...new Set(
        [
            ...String(body ?? '').matchAll(
                /<!--\s*visual-report:([a-z0-9][a-z0-9-]*):start\s*-->/g
            ),
        ].map((match) => match[1])
    ),
];

/**
 * The layers that were in the comment before a write and are gone after it.
 *
 * `written` is the layer this run just wrote, which must also be present afterwards —
 * a PATCH that lost its own block is just as broken as one that lost the other layer's.
 */
export const lostLayers = (before, after, written) => {
    const present = new Set(after);

    return [...before, written].filter((layer) => !present.has(layer));
};

/**
 * A layer name is embedded in a marker, so it is restricted to what cannot close one.
 * `LAYER` comes from the workflow, and a value containing `-->` would end the marker
 * early and turn the rest of it into comment text.
 */
const assertLayer = (layer) => {
    if (typeof layer !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(layer)) {
        throw new Error(`invalid visual layer name: ${JSON.stringify(layer)}`);
    }
};

/**
 * Removes every marker sequence from the section body.
 *
 * The body is built from test titles and file names, which a pull request author
 * controls. A title carrying an end marker would close this layer's block and leave the
 * rest of the section outside it, where the next merge would treat it as someone else's
 * text — or overwrite it while looking for its own block.
 */
const withoutMarkers = (section) =>
    String(section ?? '').replace(/<!--\s*visual-report[\s\S]*?-->/g, '');

const trim = (text) => String(text ?? '').replace(/\s+$/, '');

const renderBlock = (layer, section) => {
    const body = withoutMarkers(section).replace(/^\n+/, '').replace(/\s+$/, '');

    return `${startMarker(layer)}\n\n${body}\n\n${endMarker(layer)}`;
};

/**
 * Rebuilds the comment from its pieces, so the layout does not depend on how the
 * previous body happened to be spaced. Pieces are joined with one blank line and the
 * result ends with exactly one newline.
 */
const assemble = (pieces) => `${pieces.filter((piece) => piece !== '').join('\n\n')}\n`;

/**
 * Rewrites the calling layer's block in `existingBody` and leaves every other byte of
 * the comment alone.
 *
 * `existingBody` is what the pull request currently has, which may be null (no comment
 * yet), a comment without the marker, a comment with the other layer's block, or a
 * comment whose block for this layer was truncated. Each case has one answer, and none
 * of them drops another layer's complete block.
 */
export const mergeSection = (existingBody, layer, section) => {
    assertLayer(layer);

    const block = renderBlock(layer, section);
    let body = String(existingBody ?? '');

    if (!body.includes(COMMENT_MARKER)) {
        // No marker at all: there is no comment this automation owns, so the marker goes
        // in front of the new block. A body that has layer markers but lost the header is
        // still ours, and its blocks are kept.
        if (!body.includes(LAYER_MARKER_PREFIX)) {
            return assemble([COMMENT_MARKER, block]);
        }

        body = `${COMMENT_MARKER}\n\n${body}`;
    }

    const start = startMarker(layer);
    const end = endMarker(layer);
    const startIndex = body.indexOf(start);
    const endIndex = startIndex === -1 ? -1 : body.indexOf(end, startIndex + start.length);

    if (startIndex !== -1 && endIndex !== -1) {
        const before = trim(body.slice(0, startIndex));
        const after = body.slice(endIndex + end.length).replace(/^\n+/, '');

        return assemble([before, block, after]);
    }

    if (startIndex !== -1) {
        // A block that was never closed. It is replaced from its own marker up to the
        // next block's marker, so a complete block that follows — the other layer's,
        // written by a run that got further than this one — survives.
        const nextStart = body
            .slice(startIndex + start.length)
            .search(/<!--\s*visual-report:[^>]*:start\s*-->/);
        const cut = nextStart === -1 ? body.length : startIndex + start.length + nextStart;

        return assemble([
            trim(body.slice(0, startIndex)),
            block,
            body.slice(cut).replace(/^\n+/, ''),
        ]);
    }

    // The comment exists but has nothing for this layer yet: the layer ran for the first
    // time, or its block was removed. Appending keeps the other layer's report intact and
    // in place.
    return assemble([trim(body), block]);
};
