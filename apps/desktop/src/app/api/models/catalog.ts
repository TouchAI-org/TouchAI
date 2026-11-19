import {
    getProviderApiTargets,
    getProviderDriverDefinition as readDriverDefinition,
    getProviderDriverDefinitions as readDriverDefinitions,
    parseProviderConfigJson,
    type ProviderDriverDefinition,
} from '@touchai/models/catalog';
import type { ProviderDriver } from '@touchai/models/contracts';

import { tt } from '@/i18n';

export {
    isProviderDriver,
    parseModelModalities,
    parseProviderDriver,
} from '@touchai/models/catalog';
export type { ProviderApiTargets, ProviderDriver } from '@touchai/models/contracts';

function localizeDriver(definition: ProviderDriverDefinition): ProviderDriverDefinition {
    return { ...definition, label: tt(definition.label) };
}

export function getProviderDriverDefinition(driver: ProviderDriver): ProviderDriverDefinition {
    return localizeDriver(readDriverDefinition(driver));
}

export function getProviderDriverDefinitions(): ProviderDriverDefinition[] {
    return readDriverDefinitions().map(localizeDriver);
}

export const providerDriverDefinitions: ProviderDriverDefinition[] = new Proxy([], {
    get(_target, property) {
        const definitions = getProviderDriverDefinitions();
        const value = Reflect.get(definitions, property);
        return typeof value === 'function' ? value.bind(definitions) : value;
    },
    has(_target, property) {
        return property in getProviderDriverDefinitions();
    },
});

/** Preview shares the driver's neutral URL policy without creating a connection. */
export function previewProviderEndpoints(
    driver: ProviderDriver,
    endpoint: string,
    configJson?: string | null
) {
    return getProviderApiTargets(
        driver,
        endpoint,
        parseProviderConfigJson(configJson).reasoning?.format
    );
}
