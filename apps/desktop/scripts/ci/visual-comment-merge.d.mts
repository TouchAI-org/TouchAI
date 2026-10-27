export const COMMENT_MARKER: string;

export function mergeSection(
    existingBody: string | null | undefined,
    layer: string,
    section: string
): string;

export function layersIn(body: string | null | undefined): string[];

export function lostLayers(before: string[], after: string[], written: string): string[];
