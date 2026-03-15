/**
 * 搜索标签插件系统入口。
 * 副作用导入确保 model 和 attachment 标签在编辑器创建前完成注册。
 * useSearchLogic.ts 在文件顶部 `import './tags'` 触发此模块执行。
 */
import './model';
import './attachment';

export { createSearchTagNode } from './factory';
export {
    getAllSearchTags,
    getSearchTagNodes,
    isRegisteredTagNode,
    registerSearchTag,
} from './registry';
export { type SearchTagPlugin } from './types';
