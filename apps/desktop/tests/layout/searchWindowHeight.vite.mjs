import { createDesktopVitePlugins } from '../../vite.shared-plugins.mjs';

export function createSearchWindowHeightPlugins(probePlugin, desktopRoot) {
    return [probePlugin, ...createDesktopVitePlugins(desktopRoot)];
}
