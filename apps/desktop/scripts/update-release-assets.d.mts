export const DOWNLOAD_EXTENSIONS: string[];

export type ProductRepositoryConfig = {
    repository?: {
        url?: string;
    };
};

export function assertNonEmptyString(value: unknown, label: string): void;

export function relativeUpdatePath(baseUrl: string, label?: string): string;

export function githubRepositoryFromProduct(
    product: ProductRepositoryConfig,
    options?: {
        label?: string;
        invalidHostMessage?: string;
    }
): string;

export function isDownloadAssetName(fileName: string): boolean;

export function versionFromAssetName(fileName: string): string | null;

export function deriveReleaseTagFromAssetName(fileName: string): string | null;

export function channelFromVersion(version: string | null | undefined): string | null;

export function channelFromTag(tagName: string | null | undefined): string | null;

export function channelFromAssetName(fileName: string): string | null;
