/**
 * 搜索标签全局注册表。
 * 各标签模块通过副作用导入在启动时注册自身，
 * 编辑器初始化和 NodeSync 插件通过注册表查询已注册的标签类型。
 *
 * 注册表内容在启动后即为只读，通过 cachedPlugins 避免热路径上重复创建数组。
 */

import type { Node as TiptapNode } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';

import type { SearchTagPlugin } from './types';

const plugins = new Map<string, SearchTagPlugin>();
/** 缓存 plugins.values() 的数组快照，在 NodeSync 每次 appendTransaction 时复用。 */
let cachedPlugins: SearchTagPlugin[] | null = null;

/** 注册一个标签插件到全局注册表，使其可被编辑器识别和处理。 */
export function registerSearchTag(plugin: SearchTagPlugin): void {
    plugins.set(plugin.name, plugin);
    cachedPlugins = null;
}

/**
 * 获取所有已注册标签插件。
 * 结果被缓存，仅在 registerSearchTag 调用后失效重建。
 */
export function getAllSearchTags(): SearchTagPlugin[] {
    return (cachedPlugins ??= Array.from(plugins.values()));
}

/** 提取所有已注册标签的 Tiptap Node 扩展，用于编辑器 extensions 配置。 */
export function getSearchTagNodes(): TiptapNode[] {
    return Array.from(plugins.values()).map((p) => p.node);
}

/** 按 Tiptap 节点名称查询标签插件，用于 NodeSync 差异检测。 */
export function getSearchTag(name: string): SearchTagPlugin | undefined {
    return plugins.get(name);
}

/** 判断给定 ProseMirror 节点是否为已注册的标签类型。 */
export function isRegisteredTagNode(node: PmNode | null | undefined): boolean {
    if (!node) return false;
    return plugins.has(node.type.name);
}
