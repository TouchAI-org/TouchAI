// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { parseToolArguments } from '../../utils/toolSchema';
import { FILE_SEARCH_TOOL_NAME, fileSearchArgsSchema } from './constants';

export interface FileSearchQueryContext {
    query: string;
    limit: number;
    includeShortcutFiles: boolean;
    everythingQuery: string;
}

function quoteSearchValue(value: string): string {
    const escaped = value.replace(/"/g, '\\"');
    if (!/[\s|<>!;]/.test(escaped)) {
        return escaped;
    }

    return `"${escaped}"`;
}

function buildToggleClause(enabledName: string, disabledName: string, value?: boolean): string[] {
    if (value === undefined) {
        return [];
    }

    return [`${value ? enabledName : disabledName}:`];
}

function buildExpressionClause(prefix: string, value: string | undefined): string[] {
    return value ? [`${prefix}:${value}`] : [];
}

function buildQuotedClause(prefix: string, value: string | undefined): string[] {
    return value ? [`${prefix}:${quoteSearchValue(value)}`] : [];
}

function buildDelimitedClause(prefix: string, value: string | undefined): string[] {
    return value ? [`${prefix}:${value}`] : [];
}

function formatResultItem(
    item: {
        name: string;
        path: string;
    },
    index: number
): string {
    return `${index + 1}. ${item.name}\n   路径: ${item.path}`;
}

export function formatFileSearchResult(
    query: string,
    everythingQuery: string,
    limit: number,
    items: {
        name: string;
        path: string;
    }[]
): string {
    const header = [
        '本机文件搜索',
        `原始查询: ${query}`,
        `Everything 查询: ${everythingQuery}`,
        `返回: ${items.length} / ${limit}`,
    ];

    if (items.length === 0) {
        return [...header, '', '未找到匹配的文件。'].join('\n');
    }

    return [...header, '', ...items.map(formatResultItem)].join('\n');
}

/**
 * 将结构化参数折叠为 Everything 单条查询字符串。
 *
 * @param args 工具参数。
 * @returns Everything 可执行查询及其关键上下文。
 */
export function buildEverythingQuery(args: Record<string, unknown>): FileSearchQueryContext {
    const parsed = parseToolArguments(FILE_SEARCH_TOOL_NAME, fileSearchArgsSchema, args);
    const { query, limit, includeShortcutFiles } = parsed;

    const clauses: string[] = [query];

    if (parsed.exactPhrase) {
        clauses.push(quoteSearchValue(parsed.exactPhrase));
    }

    if (parsed.orTerms.length > 0) {
        clauses.push(`<${parsed.orTerms.map((item) => quoteSearchValue(item)).join('|')}>`);
    }

    for (const item of parsed.excludeTerms) {
        clauses.push(`!${quoteSearchValue(item)}`);
    }

    clauses.push(...buildToggleClause('case', 'nocase', parsed.caseSensitive));
    clauses.push(...buildToggleClause('path', 'nopath', parsed.matchPath));
    clauses.push(...buildToggleClause('regex', 'noregex', parsed.regex));
    clauses.push(...buildToggleClause('wfn', 'nowfn', parsed.wholeFilename));
    clauses.push(...buildToggleClause('ww', 'noww', parsed.wholeWord));
    clauses.push(...buildToggleClause('diacritics', 'nodiacritics', parsed.matchDiacritics));
    clauses.push(...buildToggleClause('wildcards', 'nowildcards', parsed.wildcards));

    if (parsed.asciiMode) {
        clauses.push(`${parsed.asciiMode}:`);
    }

    for (const item of parsed.searchCategories) {
        clauses.push(`${item}:`);
    }

    clauses.push(...buildDelimitedClause('ext', parsed.extensionList));
    clauses.push(...buildQuotedClause('type', parsed.type));
    clauses.push(...buildDelimitedClause('attrib', parsed.attributes));
    clauses.push(...buildQuotedClause('parent', parsed.parentPath));
    clauses.push(...buildQuotedClause('nosubfolders', parsed.noSubfoldersPath));
    clauses.push(...buildQuotedClause('shell', parsed.shellFolder));
    clauses.push(
        ...buildExpressionClause(
            'root',
            parsed.rootOnly === undefined ? undefined : parsed.rootOnly ? 'true' : 'false'
        )
    );
    clauses.push(...buildExpressionClause('size', parsed.sizeExpression));
    clauses.push(...buildExpressionClause('dm', parsed.dateModifiedExpression));
    clauses.push(...buildExpressionClause('dc', parsed.dateCreatedExpression));
    clauses.push(...buildExpressionClause('da', parsed.dateAccessedExpression));
    clauses.push(...buildExpressionClause('dr', parsed.dateRunExpression));
    clauses.push(...buildExpressionClause('rc', parsed.recentChangeExpression));
    clauses.push(...buildExpressionClause('depth', parsed.depthExpression));
    clauses.push(...buildExpressionClause('len', parsed.lengthExpression));
    clauses.push(...buildExpressionClause('run_count', parsed.runCountExpression));
    clauses.push(...buildQuotedClause('startwith', parsed.startWith));
    clauses.push(...buildQuotedClause('endwith', parsed.endWith));
    clauses.push(...buildExpressionClause('width', parsed.widthExpression));
    clauses.push(...buildExpressionClause('height', parsed.heightExpression));
    clauses.push(...buildExpressionClause('dimension', parsed.dimension));
    clauses.push(...buildExpressionClause('orientation', parsed.orientation));
    clauses.push(...buildExpressionClause('bitdepth', parsed.bitDepthExpression));
    clauses.push(...buildQuotedClause('title', parsed.title));
    clauses.push(...buildQuotedClause('artist', parsed.artist));
    clauses.push(...buildQuotedClause('album', parsed.album));
    clauses.push(...buildQuotedClause('comment', parsed.comment));
    clauses.push(...buildQuotedClause('genre', parsed.genre));
    clauses.push(...buildExpressionClause('track', parsed.trackExpression));
    clauses.push(...buildExpressionClause('year', parsed.yearExpression));
    clauses.push(...buildDelimitedClause('filelist', parsed.fileList));
    clauses.push(...buildQuotedClause('filelistfilename', parsed.fileListFilename));
    clauses.push(...buildDelimitedClause('frn', parsed.frnList));
    clauses.push(
        ...buildExpressionClause(
            'fsi',
            parsed.fileSystemIndex === undefined ? undefined : String(parsed.fileSystemIndex)
        )
    );

    if (parsed.duplicateMode) {
        const duplicateFunction =
            parsed.duplicateMode === 'date_accessed'
                ? 'dadup'
                : parsed.duplicateMode === 'date_created'
                  ? 'dcdupe'
                  : parsed.duplicateMode === 'date_modified'
                    ? 'dmdupe'
                    : parsed.duplicateMode === 'attributes'
                      ? 'attribdupe'
                      : parsed.duplicateMode === 'namepart'
                        ? 'namepartdupe'
                        : parsed.duplicateMode === 'size'
                          ? 'sizedupe'
                          : 'dupe';
        clauses.push(`${duplicateFunction}:`);
    }

    // content: 系列过滤通常最慢，放到后面可减少误用时的干扰。
    if (parsed.contentEncoding) {
        clauses.push(`${parsed.contentEncoding}:`);
    }
    clauses.push(...buildQuotedClause('content', parsed.contentText));

    clauses.push(...parsed.extraClauses);

    return {
        query,
        limit,
        includeShortcutFiles,
        everythingQuery: clauses.join(' '),
    };
}
