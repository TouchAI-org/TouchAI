# Homepage Demo Architecture

The homepage demo layer now has an explicit module boundary:

- `src/data/homepage-demo-scenarios.ts` is the typed scenario registry for locale-specific demo sources and labels.
- `src/components/homepage-demo/host-css.ts` is the shared host/scope CSS source of truth used by both the Astro host and the browser runtime.
- `src/components/ComponentDemo.astro` is the compatibility host that still loads legacy standalone HTML demo documents.
- `src/scripts/component-demo-runtime.ts` mounts, reloads, and message-bridges those legacy demo documents in the browser.

Those standalone HTML files under `public/*/touchai-components.html` are now treated as legacy migration sources. Future refactors should migrate one scenario at a time into reusable render/runtime modules while keeping this host boundary stable.
