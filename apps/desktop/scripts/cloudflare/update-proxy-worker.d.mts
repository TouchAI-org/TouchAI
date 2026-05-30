export type UpdateProxyWorkerEnvironment = {
    UPDATE_BASE_PATH?: string;
    GITHUB_REPOSITORY?: string;
    UPDATE_FEED_CACHE_SECONDS?: string;
    UPDATE_ASSET_CACHE_SECONDS?: string;
    UPDATE_BUCKET?: {
        get?: (key: string, options?: { range?: Headers }) => Promise<unknown>;
        head?: (key: string) => Promise<unknown>;
    };
};

export type UpdateProxyWorkerContext = {
    waitUntil?: (promise: Promise<unknown>) => void;
};

export function deriveReleaseTagFromAssetName(fileName: string): string | null;

export function handleUpdateProxyRequest(
    request: Request,
    env: UpdateProxyWorkerEnvironment,
    context: UpdateProxyWorkerContext
): Promise<Response>;

declare const worker: {
    fetch: typeof handleUpdateProxyRequest;
};

export default worker;
