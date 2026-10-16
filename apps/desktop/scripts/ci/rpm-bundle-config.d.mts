export type RpmBundleConfig = {
    version: string;
    bundle?: {
        linux: {
            rpm: {
                release: string;
            };
        };
    };
};

export function rpmBundleConfig(version: string): RpmBundleConfig;
