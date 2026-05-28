// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const glimmPath = path.resolve(pkgDir, 'node_modules/glimm/dist/index.js');

// https://astro.build/config
export default defineConfig({
	site: 'https://touch-ai.org/',
	vite: {
		resolve: {
			alias: {
				'glimm': glimmPath,
			},
		},
		optimizeDeps: {
			include: ['glimm'],
		},
	},
	integrations: [
		starlight({
			title: 'TouchAI',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/TouchAI-org/TouchAI' }],
			sidebar: [
				{
					label: 'Guides',
					items: [
						// Each item here is one entry in the navigation menu.
						{ label: 'Example Guide', slug: 'guides/example' },
					],
				},
				{
					label: 'Reference',
					items: [{ autogenerate: { directory: 'reference' } }],
				},
			],
		}),
	],
});
