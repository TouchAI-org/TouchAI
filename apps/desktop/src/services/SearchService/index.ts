import { SearchActionDispatcher } from './actions';
import { SearchProviderRegistry } from './registry';

export { SearchActionDispatcher } from './actions';
export type * from './contracts';
export { SearchProviderRegistry, SearchSession } from './registry';

/** One trusted host registry per renderer; each surface creates an independent session. */
export const searchProviders = new SearchProviderRegistry();
export const searchActions = new SearchActionDispatcher();
