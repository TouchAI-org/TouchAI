import type { ModelsHost } from './contracts/host';
import type { AiProvider, AiProviderConfig, ProviderDriver } from './contracts/model';

export interface ProviderRegistration {
    driver: ProviderDriver;
    create(config: AiProviderConfig, host: ModelsHost): AiProvider;
}

export interface Models {
    createConnection(options: {
        driver: ProviderDriver;
        config: AiProviderConfig;
        host: ModelsHost;
    }): AiProvider;
}

/** Drivers are fixed at creation; user connection instances never share driver state. */
export function createModels(options: { providers: readonly ProviderRegistration[] }): Models {
    const providers = new Map<ProviderDriver, ProviderRegistration['create']>();
    for (const provider of options.providers) {
        if (providers.has(provider.driver))
            throw new Error(`Duplicate provider driver: ${provider.driver}`);
        providers.set(provider.driver, provider.create);
    }
    return Object.freeze({
        createConnection({ driver, config, host }: Parameters<Models['createConnection']>[0]) {
            const create = providers.get(driver);
            if (!create) throw new Error(`Provider driver is not registered: ${driver}`);
            return create(
                structuredClone(config),
                Object.freeze({
                    fetch: host.fetch,
                    remoteRefs: Object.freeze({
                        read: host.remoteRefs.read.bind(host.remoteRefs),
                        touch: host.remoteRefs.touch.bind(host.remoteRefs),
                        write: host.remoteRefs.write.bind(host.remoteRefs),
                    }),
                    diagnostics: host.diagnostics?.bind(host),
                })
            );
        },
    });
}
