// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AiToolDefinition } from '@/services/AiService/types';

import {
    arrayFromScalarSchema,
    integerInRangeSchema,
    nonEmptyTrimmedStringSchema,
    optionalIntegerInRangeSchema,
    optionalTrimmedStringSchema,
    z,
} from '../../utils/toolSchema';

export const SEARCH_CATEGORIES = ['audio', 'zip', 'doc', 'exe', 'pic', 'video'] as const;
export const ASCII_MODES = ['ascii', 'utf8', 'noascii'] as const;
export const CONTENT_ENCODINGS = ['ansi', 'utf8', 'utf16', 'utf16be'] as const;
export const ORIENTATIONS = ['landscape', 'portrait'] as const;
export const DUPLICATE_MODES = [
    'name',
    'namepart',
    'attributes',
    'date_accessed',
    'date_created',
    'date_modified',
    'size',
] as const;
export const FILE_SEARCH_TOOL_NAME = 'FileSearch';

export const fileSearchArgsSchema = z.object({
    query: nonEmptyTrimmedStringSchema,
    limit: integerInRangeSchema(1, 100),
    includeShortcutFiles: z.boolean(),
    exactPhrase: optionalTrimmedStringSchema,
    extensionList: optionalTrimmedStringSchema,
    type: optionalTrimmedStringSchema,
    attributes: optionalTrimmedStringSchema,
    parentPath: optionalTrimmedStringSchema,
    noSubfoldersPath: optionalTrimmedStringSchema,
    shellFolder: optionalTrimmedStringSchema,
    sizeExpression: optionalTrimmedStringSchema,
    dateModifiedExpression: optionalTrimmedStringSchema,
    dateCreatedExpression: optionalTrimmedStringSchema,
    dateAccessedExpression: optionalTrimmedStringSchema,
    dateRunExpression: optionalTrimmedStringSchema,
    recentChangeExpression: optionalTrimmedStringSchema,
    depthExpression: optionalTrimmedStringSchema,
    lengthExpression: optionalTrimmedStringSchema,
    runCountExpression: optionalTrimmedStringSchema,
    startWith: optionalTrimmedStringSchema,
    endWith: optionalTrimmedStringSchema,
    contentText: optionalTrimmedStringSchema,
    widthExpression: optionalTrimmedStringSchema,
    heightExpression: optionalTrimmedStringSchema,
    dimension: optionalTrimmedStringSchema,
    bitDepthExpression: optionalTrimmedStringSchema,
    title: optionalTrimmedStringSchema,
    artist: optionalTrimmedStringSchema,
    album: optionalTrimmedStringSchema,
    comment: optionalTrimmedStringSchema,
    genre: optionalTrimmedStringSchema,
    trackExpression: optionalTrimmedStringSchema,
    yearExpression: optionalTrimmedStringSchema,
    fileList: optionalTrimmedStringSchema,
    fileListFilename: optionalTrimmedStringSchema,
    frnList: optionalTrimmedStringSchema,
    fileSystemIndex: optionalIntegerInRangeSchema(0, Number.MAX_SAFE_INTEGER),
    rootOnly: z.boolean().optional(),
    caseSensitive: z.boolean().optional(),
    matchPath: z.boolean().optional(),
    regex: z.boolean().optional(),
    wholeFilename: z.boolean().optional(),
    wholeWord: z.boolean().optional(),
    matchDiacritics: z.boolean().optional(),
    wildcards: z.boolean().optional(),
    asciiMode: z.enum(ASCII_MODES).optional(),
    contentEncoding: z.enum(CONTENT_ENCODINGS).optional(),
    orientation: z.enum(ORIENTATIONS).optional(),
    duplicateMode: z.enum(DUPLICATE_MODES).optional(),
    searchCategories: arrayFromScalarSchema(z.enum(SEARCH_CATEGORIES)),
    orTerms: arrayFromScalarSchema(nonEmptyTrimmedStringSchema),
    excludeTerms: arrayFromScalarSchema(nonEmptyTrimmedStringSchema),
    extraClauses: arrayFromScalarSchema(nonEmptyTrimmedStringSchema),
});

/**
 * 暴露给模型的 FileSearch 工具说明。
 */
export const FILE_SEARCH_TOOL_DESCRIPTION = '搜索本机文件';

function withExamples(description: string, ...examples: string[]): string {
    return `${description} Examples: ${examples.join(' | ')}.`;
}

/**
 * 暴露给模型的 FileSearch 工具输入 schema。
 */
export const FILE_SEARCH_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        query: {
            type: 'string',
            description: withExamples(
                'Required base Everything query text. Use "*" when you only want structured filters.',
                '"report"',
                '"*"'
            ),
        },
        limit: {
            type: 'integer',
            description: withExamples('Required result count, from 1 to 100.', '20', '50'),
        },
        includeShortcutFiles: {
            type: 'boolean',
            description: withExamples(
                'Required. Whether .lnk shortcut files should be included.',
                'false',
                'true'
            ),
        },
        exactPhrase: {
            type: 'string',
            description: withExamples(
                'Optional exact phrase to append as a quoted search term.',
                '"annual report"',
                '"error log"'
            ),
        },
        orTerms: {
            type: 'array',
            items: { type: 'string' },
            description: withExamples(
                'Optional terms joined as an Everything OR group like <a|b|c>.',
                '["invoice","receipt"]',
                '["png","jpg","webp"]'
            ),
        },
        excludeTerms: {
            type: 'array',
            items: { type: 'string' },
            description: withExamples(
                'Optional terms to exclude with the Everything ! operator.',
                '["node_modules",".git"]',
                '["draft","backup"]'
            ),
        },
        caseSensitive: {
            type: 'boolean',
            description: withExamples('Optional case:/nocase: toggle.', 'true', 'false'),
        },
        matchPath: {
            type: 'boolean',
            description: withExamples('Optional path:/nopath: toggle.', 'true', 'false'),
        },
        regex: {
            type: 'boolean',
            description: withExamples('Optional regex:/noregex: toggle.', 'true', 'false'),
        },
        wholeFilename: {
            type: 'boolean',
            description: withExamples('Optional wfn:/nowfn: toggle.', 'true', 'false'),
        },
        wholeWord: {
            type: 'boolean',
            description: withExamples('Optional ww:/noww: toggle.', 'true', 'false'),
        },
        matchDiacritics: {
            type: 'boolean',
            description: withExamples(
                'Optional diacritics:/nodiacritics: toggle.',
                'true',
                'false'
            ),
        },
        wildcards: {
            type: 'boolean',
            description: withExamples('Optional wildcards:/nowildcards: toggle.', 'true', 'false'),
        },
        asciiMode: {
            type: 'string',
            enum: [...ASCII_MODES],
            description: withExamples(
                'Optional Everything text mode: ascii, utf8 or noascii.',
                '"ascii"',
                '"utf8"'
            ),
        },
        searchCategories: {
            type: 'array',
            items: { type: 'string', enum: [...SEARCH_CATEGORIES] },
            description: withExamples(
                'Optional Everything category macros such as audio:, zip:, doc:, exe:, pic:, video:.',
                '["doc"]',
                '["pic","video"]'
            ),
        },
        extensionList: {
            type: 'string',
            description: withExamples(
                'Optional ext: filter payload.',
                '"ts;tsx;vue"',
                '"pdf;docx"'
            ),
        },
        type: {
            type: 'string',
            description: withExamples(
                'Optional type: filter payload, using the Windows file type string.',
                '"Text Document"',
                '"PNG File"'
            ),
        },
        attributes: {
            type: 'string',
            description: withExamples('Optional attrib: filter payload.', '"H"', '"!H"'),
        },
        parentPath: {
            type: 'string',
            description: withExamples(
                'Optional parent: path filter.',
                '"D:\\\\Project\\\\TouchAI\\\\src"',
                '"C:\\\\Users\\\\me\\\\Downloads"'
            ),
        },
        noSubfoldersPath: {
            type: 'string',
            description: withExamples(
                'Optional nosubfolders: path filter.',
                '"D:\\\\Project\\\\TouchAI\\\\docs"',
                '"C:\\\\Temp"'
            ),
        },
        shellFolder: {
            type: 'string',
            description: withExamples('Optional shell: folder filter.', '"downloads"', '"desktop"'),
        },
        rootOnly: {
            type: 'boolean',
            description: withExamples('Optional root: true/false filter.', 'true', 'false'),
        },
        sizeExpression: {
            type: 'string',
            description: withExamples('Optional size: expression.', '">1mb"', '"64kb..10mb"'),
        },
        dateModifiedExpression: {
            type: 'string',
            description: withExamples(
                'Optional dm: expression.',
                '"today"',
                '"2024-01-01..2024-12-31"'
            ),
        },
        dateCreatedExpression: {
            type: 'string',
            description: withExamples(
                'Optional dc: expression.',
                '"yesterday"',
                '"2025-01-01..2025-03-01"'
            ),
        },
        dateAccessedExpression: {
            type: 'string',
            description: withExamples('Optional da: expression.', '"lastweek"', '">=2025-01-01"'),
        },
        dateRunExpression: {
            type: 'string',
            description: withExamples('Optional dr: expression.', '"today"', '"thismonth"'),
        },
        recentChangeExpression: {
            type: 'string',
            description: withExamples('Optional rc: expression.', '"today"', '"3days"'),
        },
        depthExpression: {
            type: 'string',
            description: withExamples('Optional depth: expression.', '"1"', '"2..4"'),
        },
        lengthExpression: {
            type: 'string',
            description: withExamples('Optional len: expression.', '">=10"', '"5..20"'),
        },
        runCountExpression: {
            type: 'string',
            description: withExamples('Optional run_count: expression.', '">=3"', '"1..10"'),
        },
        startWith: {
            type: 'string',
            description: withExamples('Optional startwith: filter.', '"IMG_"', '"report_"'),
        },
        endWith: {
            type: 'string',
            description: withExamples('Optional endwith: filter.', '"_final"', '"-backup"'),
        },
        contentText: {
            type: 'string',
            description: withExamples(
                'Optional content: text search payload.',
                '"TODO"',
                '"confidential"'
            ),
        },
        contentEncoding: {
            type: 'string',
            enum: [...CONTENT_ENCODINGS],
            description: withExamples(
                'Optional content text encoding hint: ansi, utf8, utf16 or utf16be.',
                '"utf8"',
                '"utf16"'
            ),
        },
        widthExpression: {
            type: 'string',
            description: withExamples('Optional width: expression.', '">=1920"', '"800..2560"'),
        },
        heightExpression: {
            type: 'string',
            description: withExamples('Optional height: expression.', '">=1080"', '"600..1440"'),
        },
        dimension: {
            type: 'string',
            description: withExamples('Optional dimension: payload.', '"1920x1080"', '"1080x1920"'),
        },
        orientation: {
            type: 'string',
            enum: [...ORIENTATIONS],
            description: withExamples(
                'Optional orientation: filter for landscape or portrait.',
                '"landscape"',
                '"portrait"'
            ),
        },
        bitDepthExpression: {
            type: 'string',
            description: withExamples('Optional bitdepth: expression.', '"32"', '">=24"'),
        },
        title: {
            type: 'string',
            description: withExamples(
                'Optional title: metadata filter.',
                '"Interstellar"',
                '"Project Plan"'
            ),
        },
        artist: {
            type: 'string',
            description: withExamples(
                'Optional artist: metadata filter.',
                '"Taylor Swift"',
                '"Hans Zimmer"'
            ),
        },
        album: {
            type: 'string',
            description: withExamples(
                'Optional album: metadata filter.',
                '"1989"',
                '"Inception OST"'
            ),
        },
        comment: {
            type: 'string',
            description: withExamples(
                'Optional comment: metadata filter.',
                '"reviewed"',
                '"approved"'
            ),
        },
        genre: {
            type: 'string',
            description: withExamples('Optional genre: metadata filter.', '"Rock"', '"Classical"'),
        },
        trackExpression: {
            type: 'string',
            description: withExamples('Optional track: expression.', '"1"', '"1..5"'),
        },
        yearExpression: {
            type: 'string',
            description: withExamples('Optional year: expression.', '"2024"', '"2018..2020"'),
        },
        duplicateMode: {
            type: 'string',
            enum: [...DUPLICATE_MODES],
            description: withExamples(
                'Optional duplicate search macro: name, namepart, attributes, date_accessed, date_created, date_modified or size.',
                '"name"',
                '"size"'
            ),
        },
        fileList: {
            type: 'string',
            description: withExamples(
                'Optional filelist: payload, using Everything syntax.',
                '"D:\\\\a.txt|D:\\\\b.txt"',
                '"C:\\\\1.png|C:\\\\2.png"'
            ),
        },
        fileListFilename: {
            type: 'string',
            description: withExamples(
                'Optional filelistfilename: filter.',
                '"selected-files.txt"',
                '"batch-input.txt"'
            ),
        },
        frnList: {
            type: 'string',
            description: withExamples(
                'Optional frn: payload, using Everything syntax.',
                '"12345|67890"',
                '"998877"'
            ),
        },
        fileSystemIndex: {
            type: 'integer',
            description: withExamples('Optional fsi: file system index value.', '0', '1'),
        },
        extraClauses: {
            type: 'array',
            items: { type: 'string' },
            description: withExamples(
                'Optional raw Everything clauses for advanced syntax not already covered above.',
                '["sort:size-desc"]',
                '["!empty:","highlight:off"]'
            ),
        },
    },
    required: ['query', 'limit', 'includeShortcutFiles'],
};
