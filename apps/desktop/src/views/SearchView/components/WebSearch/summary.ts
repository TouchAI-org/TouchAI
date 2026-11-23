import { SEARCH_PROVIDER_METADATA } from '@/app/api/tools/catalog';

/** Only application-generated search engine suffixes are presentation metadata. */
export function formatSearchSummary(
    summary: string,
    engine?: string | null,
    separateLabel = false
): string {
    const engines = engine
        ? [engine]
        : Object.values(SEARCH_PROVIDER_METADATA).map((provider) => provider.sourceName);
    for (const name of engines) {
        const suffix = [` (${name})`, ` · ${name}`].find((value) => summary.endsWith(value));
        if (!suffix) continue;
        const query = summary.slice(0, -suffix.length).trimEnd();
        return separateLabel ? query : `${query} (${name})`;
    }
    return summary;
}
