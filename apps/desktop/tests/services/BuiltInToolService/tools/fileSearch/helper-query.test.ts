import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import {
    buildEverythingQuery,
    formatFileSearchResult,
} from '@/services/BuiltInToolService/tools/fileSearch/helper';

/**
 * FileSearch turns the model's structured arguments into one Everything query string. Everything
 * has its own query language, so what the user gets depends on that string being assembled
 * correctly: a filter that is dropped silently returns the wrong files, and an unquoted value
 * with a space splits into two terms.
 *
 * The public contract is the query the user's machine will actually run.
 */

function query(args: Record<string, unknown>): string {
    return buildEverythingQuery({
        query: '*',
        limit: 20,
        includeShortcutFiles: false,
        ...args,
    }).everythingQuery;
}

describe('user searches for files by name', () => {
    it('user gets a plain name searched as written without quoting', () => {
        expect(query({ query: 'report' })).toBe('report');
    });

    it('user gets a base query passed through as the Everything expression it is', () => {
        // The base query is Everything syntax the model wrote, not a literal filename.
        expect(query({ query: 'annual report' })).toBe('annual report');
        expect(query({ query: 'ext:pdf report' })).toBe('ext:pdf report');
    });

    it('user gets a name with spaces quoted when it was given as a structured filter', () => {
        // Without quotes Everything would treat the structured value as two separate words.
        expect(query({ exactPhrase: 'annual report' })).toBe('* "annual report"');
    });

    it('user gets a structured value containing Everything operator characters quoted', () => {
        for (const value of ['a|b', 'a<b', 'a>b', 'a!b', 'a;b', 'a"b']) {
            expect(query({ exactPhrase: value }), value).toBe(`* "${value.replace(/"/g, '\\"')}"`);
        }
    });

    it('user gets a wildcard-only search passed straight through', () => {
        expect(query({ query: '*' })).toBe('*');
    });

    it('user gets an exact phrase added as a quoted term', () => {
        expect(query({ exactPhrase: 'quarterly earnings' })).toBe('* "quarterly earnings"');
    });

    it('user gets alternative words searched as an any-of group', () => {
        expect(query({ orTerms: ['invoice', 'receipt'] })).toBe('* <invoice|receipt>');
    });

    it('user gets an alternative word containing a space quoted inside the group', () => {
        expect(query({ orTerms: ['final invoice', 'receipt'] })).toBe(
            '* <"final invoice"|receipt>'
        );
    });

    it('user gets excluded words removed from the results', () => {
        expect(query({ excludeTerms: ['draft', 'temp'] })).toBe('* !draft !temp');
    });

    it('user gets an excluded word containing a space quoted', () => {
        expect(query({ excludeTerms: ['old draft'] })).toBe('* !"old draft"');
    });
});

describe('user narrows a search with switches', () => {
    it('user gets match-case switched on', () => {
        expect(query({ caseSensitive: true })).toBe('* case:');
    });

    it('user gets match-case switched off explicitly', () => {
        expect(query({ caseSensitive: false })).toBe('* nocase:');
    });

    it('user gets no case switch at all when they did not choose', () => {
        expect(query({})).not.toContain('case:');
    });

    it('user gets the path, regex and whole-name switches applied', () => {
        const result = query({
            matchPath: true,
            regex: true,
            wholeFilename: true,
            wholeWord: true,
            matchDiacritics: false,
            wildcards: true,
        });

        expect(result).toContain('path:');
        expect(result).toContain('regex:');
        expect(result).toContain('wfn:');
        expect(result).toContain('ww:');
        expect(result).toContain('nodiacritics:');
        expect(result).toContain('wildcards:');
    });

    it('user gets the switched-off form when a switch was turned off', () => {
        const result = query({ matchPath: false, regex: false });

        expect(result).toContain('nopath:');
        expect(result).toContain('noregex:');
    });

    it('user gets the chosen character encoding applied', () => {
        expect(query({ asciiMode: 'utf8' })).toBe('* utf8:');
    });

    it('user gets the chosen file category applied', () => {
        expect(query({ searchCategories: ['doc', 'pic'] })).toBe('* doc: pic:');
    });
});

describe('user narrows a search by file properties', () => {
    it('user gets an extension filter added', () => {
        expect(query({ extensionList: 'pdf;docx' })).toBe('* ext:pdf;docx');
    });

    it('user gets a file type filter quoted when it has spaces', () => {
        expect(query({ type: 'compressed archive' })).toBe('* type:"compressed archive"');
    });

    it('user gets a folder filter quoted so a path with spaces stays whole', () => {
        expect(query({ parentPath: 'D:\\Project Files\\TouchAI' })).toBe(
            String.raw`* parent:"D:\\Project Files\\TouchAI"`
        );
    });

    it('user gets a folder exclusion quoted when its path has spaces', () => {
        expect(query({ noSubfoldersPath: 'D:\\Project Files\\node_modules' })).toBe(
            String.raw`* nosubfolders:"D:\\Project Files\\node_modules"`
        );
    });

    it('user gets a shell folder filter applied', () => {
        expect(query({ shellFolder: 'downloads' })).toBe('* shell:downloads');
    });

    it('user gets a search restricted to the top level', () => {
        expect(query({ rootOnly: true })).toBe('* root:true');
    });

    it('user gets a search explicitly including subfolders', () => {
        expect(query({ rootOnly: false })).toBe('* root:false');
    });

    it('user gets no root filter when they did not choose', () => {
        expect(query({})).not.toContain('root:');
    });

    it('user gets a size filter applied', () => {
        expect(query({ sizeExpression: '>1mb' })).toBe('* size:>1mb');
    });

    it('user gets the date filters applied', () => {
        const result = query({
            dateModifiedExpression: 'lastweek',
            dateCreatedExpression: 'thismonth',
            dateAccessedExpression: 'today',
            dateRunExpression: 'yesterday',
            recentChangeExpression: 'last2hours',
        });

        expect(result).toContain('dm:lastweek');
        expect(result).toContain('dc:thismonth');
        expect(result).toContain('da:today');
        expect(result).toContain('dr:yesterday');
        expect(result).toContain('rc:last2hours');
    });

    it('user gets a folder depth filter applied', () => {
        expect(query({ depthExpression: '3' })).toBe('* depth:3');
    });

    it('user gets a filename length filter applied', () => {
        expect(query({ lengthExpression: '>50' })).toBe('* len:>50');
    });

    it('user gets a run-count filter applied', () => {
        expect(query({ runCountExpression: '>10' })).toBe('* run_count:>10');
    });

    it('user gets a name-prefix filter quoted when needed', () => {
        expect(query({ startWith: 'annual report' })).toBe('* startwith:"annual report"');
    });

    it('user gets a name-suffix filter applied', () => {
        expect(query({ endWith: '.bak' })).toBe('* endwith:.bak');
    });
});

describe('user narrows a search by picture properties', () => {
    it('user gets the picture dimension filters applied', () => {
        const result = query({
            widthExpression: '>1920',
            heightExpression: '>1080',
            dimension: '1920x1080',
            bitDepthExpression: '32',
            orientation: 'landscape',
        });

        expect(result).toContain('width:>1920');
        expect(result).toContain('height:>1080');
        expect(result).toContain('dimension:1920x1080');
        expect(result).toContain('bitdepth:32');
        expect(result).toContain('orientation:landscape');
    });
});

describe('user narrows a search by music tags', () => {
    it('user gets the music tag filters applied', () => {
        const result = query({
            title: 'Blue in Green',
            artist: 'Miles Davis',
            album: 'Kind of Blue',
            comment: 'remastered',
            genre: 'jazz',
            trackExpression: '3',
            yearExpression: '1959',
        });

        expect(result).toContain('title:"Blue in Green"');
        expect(result).toContain('artist:"Miles Davis"');
        expect(result).toContain('album:"Kind of Blue"');
        expect(result).toContain('comment:remastered');
        expect(result).toContain('genre:jazz');
        expect(result).toContain('track:3');
        expect(result).toContain('year:1959');
    });
});

describe('user narrows a search by a file list', () => {
    it('user gets a file list filter added', () => {
        expect(query({ fileList: 'a.txt;b.txt' })).toBe('* filelist:a.txt;b.txt');
    });

    it('user gets a file-list filename filter applied', () => {
        expect(query({ fileListFilename: 'notes.txt' })).toBe('* filelistfilename:notes.txt');
    });

    it('user gets a file reference number filter added', () => {
        expect(query({ frnList: '12345;67890' })).toBe('* frn:12345;67890');
    });

    it('user gets a volume index filter applied', () => {
        expect(query({ fileSystemIndex: 2 })).toBe('* fsi:2');
    });

    it('user gets a volume index of zero still applied', () => {
        // Zero is a real volume index, so it must not be treated as "not set".
        expect(query({ fileSystemIndex: 0 })).toBe('* fsi:0');
    });
});

describe('user searches for duplicate files', () => {
    it('user gets the plain duplicate search when no comparison was chosen', () => {
        expect(query({ duplicateMode: 'name' })).toBe('* dupe:');
    });

    it('user gets the comparison chosen for duplicates', () => {
        expect(query({ duplicateMode: 'size' })).toContain('sizedupe:');
        expect(query({ duplicateMode: 'namepart' })).toContain('namepartdupe:');
        expect(query({ duplicateMode: 'attributes' })).toContain('attribdupe:');
        expect(query({ duplicateMode: 'date_accessed' })).toContain('dadup:');
        expect(query({ duplicateMode: 'date_created' })).toContain('dcdupe:');
        expect(query({ duplicateMode: 'date_modified' })).toContain('dmdupe:');
    });

    it('user gets no duplicate filter when they did not ask for one', () => {
        expect(query({})).not.toContain('dupe:');
    });
});

describe('user searches inside file contents', () => {
    it('user gets the content encoding applied before the text', () => {
        const result = query({ contentEncoding: 'utf16', contentText: 'invoice' });

        // The encoding switch has to come before the text, or Everything reads the wrong bytes.
        expect(result.indexOf('utf16:')).toBeLessThan(result.indexOf('content:invoice'));
    });

    it('user gets the content text quoted when it contains spaces', () => {
        expect(query({ contentText: 'annual report' })).toBe('* content:"annual report"');
    });

    it('user gets extra clauses passed through unchanged', () => {
        expect(query({ extraClauses: ['childcount:>3', 'empty:'] })).toBe('* childcount:>3 empty:');
    });
});

describe('user gets their search settings reported back', () => {
    it('user gets the query, the result limit and the shortcut setting returned', () => {
        expect(
            buildEverythingQuery({
                query: 'report',
                limit: 50,
                includeShortcutFiles: true,
            })
        ).toEqual({
            query: 'report',
            limit: 50,
            includeShortcutFiles: true,
            everythingQuery: 'report',
        });
    });

    it('user gets the raw query kept even though the assembled expression quotes its filters', () => {
        const context = buildEverythingQuery({
            query: 'report',
            limit: 10,
            includeShortcutFiles: false,
            exactPhrase: 'annual report',
        });

        expect(context.query).toBe('report');
        expect(context.everythingQuery).toBe('report "annual report"');
    });

    it('user is told what was wrong with their search instead of getting a broken query', () => {
        expect(() =>
            buildEverythingQuery({ query: '  ', limit: 10, includeShortcutFiles: false })
        ).toThrow();
        expect(() =>
            buildEverythingQuery({ query: '*', limit: 0, includeShortcutFiles: false })
        ).toThrow();
        expect(() =>
            buildEverythingQuery({ query: '*', limit: 500, includeShortcutFiles: false })
        ).toThrow();
    });
});

describe('user reads a file search result', () => {
    it('user sees the search they ran and how many results came back', () => {
        setLocale('en-US');

        const result = formatFileSearchResult('report', '"report"', 20, [
            { name: 'annual-report.pdf', path: 'D:\\Docs\\annual-report.pdf' },
        ]);

        expect(result).toContain('Local file search');
        expect(result).toContain('Original query: report');
        expect(result).toContain('Everything query: "report"');
        expect(result).toContain('Returned: 1 / 20');
    });

    it('user sees each result numbered with its full path', () => {
        setLocale('en-US');

        const result = formatFileSearchResult('report', '"report"', 20, [
            { name: 'first.pdf', path: 'D:\\Docs\\first.pdf' },
            { name: 'second.pdf', path: 'D:\\Docs\\second.pdf' },
        ]);

        expect(result).toContain('1. first.pdf');
        expect(result).toContain('Path: D:\\Docs\\first.pdf');
        expect(result).toContain('2. second.pdf');
        expect(result).toContain('Path: D:\\Docs\\second.pdf');
    });

    it('user is told no files matched rather than getting an empty answer', () => {
        setLocale('en-US');

        const result = formatFileSearchResult('nothing', '"nothing"', 20, []);

        expect(result).toContain('Returned: 0 / 20');
        expect(result).toContain('No matching files found.');
    });

    it('user reads the search result in their own language', () => {
        setLocale('zh-CN');

        const result = formatFileSearchResult('报告', '报告', 20, []);

        expect(result).toContain('本机文件搜索');
        expect(result).toContain('未找到匹配的文件。');

        setLocale('en-US');
    });
});
