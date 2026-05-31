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
				glimm: glimmPath,
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
					label: '入门',
					items: [
						{ label: '安装', slug: 'getting-started/installation' },
						{ label: '快速开始', slug: 'getting-started/quickstart' },
						{ label: '快捷键', slug: 'getting-started/shortcuts' },
					],
				},
				{
					label: '功能',
					items: [
						{ label: '内置工具', slug: 'features/built-in-tools' },
						{ label: '文件搜索', slug: 'features/file-search' },
						{ label: '代码与命令', slug: 'features/code-and-command' },
						{ label: '模型升级', slug: 'features/upgrade-model' },
					],
				},
				{
					label: 'MCP 扩展',
					items: [
						{ label: 'MCP 扩展', slug: 'extensions/mcp-tools' },
						{ label: '热门服务', slug: 'extensions/mcp-popular-scenarios' },
						{ label: '添加服务', slug: 'extensions/mcp-add-service' },
					],
				},
				{
					label: '展示',
					items: [
						{ label: '概览', slug: 'display/visual-rendering' },
						{ label: '代码展示', slug: 'display/code-display' },
						{ label: '图表结构', slug: 'display/diagrams' },
					],
				},
				{
					label: '设置',
					items: [
						{ label: '模型配置', slug: 'settings/model-configuration' },
						{ label: '配置供应商', slug: 'settings/api-keys' },
						{ label: '常用设置', slug: 'settings/customization' },

					],
				},
				{
					label: '关于',
					items: [
						{ label: '公告', slug: 'about/announcement' },
						{ label: '更新日志', slug: 'about/changelog' },
						{ label: '支持与反馈', slug: 'about/support' },
					],
				},
			],
		}),
	],
});
