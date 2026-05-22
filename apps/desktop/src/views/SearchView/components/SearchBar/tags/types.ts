/**
 * 搜索标签插件契约。
 * 每种标签类型（模型、附件等）实现此接口后注册到全局注册表，
 * 由 NodeSync 插件和键盘导航统一调度，无需硬编码标签类型判断。
 */

import type { Node as TiptapNode } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';

export interface SearchTagPlugin {
    /** Tiptap 节点名称（唯一标识） */
    name: string;
    /** 标签类别标识，用于 DOM data 属性 */
    kind: string;
    /** Tiptap Node 扩展实例（含 addNodeView） */
    node: TiptapNode;
    /** 从 ProseMirror 节点提取唯一 ID（用于 NodeSync 差异检测），非本类型返回 null */
    collectNodeId(pmNode: PmNode): string | null;
}
