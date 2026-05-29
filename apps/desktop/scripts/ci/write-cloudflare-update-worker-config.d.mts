export type ProductConfig = {
    repository?: {
        url?: string;
    };
    services?: {
        updates?: {
            baseUrl?: string;
            deployment?: {
                provider?: string;
                workerName?: string;
                bucketName?: string;
                routePattern?: string;
                zoneName?: string;
                compatibilityDate?: string;
            };
        };
    };
};

export function buildCloudflareUpdateWorkerConfig(
    product: ProductConfig,
    options: {
        workerScriptPath: string;
    }
): string;

export function writeCloudflareUpdateWorkerConfig(
    projectRoot: string,
    outputPath: string
): Promise<void>;
