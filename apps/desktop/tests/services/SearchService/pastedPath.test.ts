import { describe, expect, it, vi } from 'vitest';

import {
    normalizePastedPath,
    resolvePastedPathAttachment,
} from '@/services/SearchService/pastedPath';

describe('given a user pastes a local path', () => {
    it('user gets an image attachment when the pasted path is an existing image', async () => {
        const pathStat = vi.fn().mockResolvedValue({ isFile: true, isDirectory: false });

        const result = await resolvePastedPathAttachment(
            String.raw`"D:\Pictures\shot.PNG"`,
            pathStat
        );

        expect(pathStat).toHaveBeenCalledWith(String.raw`D:\Pictures\shot.PNG`);
        expect(result).toEqual({ type: 'image', path: String.raw`D:\Pictures\shot.PNG` });
    });

    it('user gets a file attachment when the pasted path is an existing document', async () => {
        const pathStat = vi.fn().mockResolvedValue({ isFile: true, isDirectory: false });

        const result = await resolvePastedPathAttachment(String.raw`D:\docs\report.pdf`, pathStat);

        expect(result).toEqual({ type: 'file', path: String.raw`D:\docs\report.pdf` });
    });

    it('user keeps plain text when the path does not exist', async () => {
        const pathStat = vi.fn().mockRejectedValue(new Error('not found'));

        await expect(
            resolvePastedPathAttachment(String.raw`D:\docs\missing.pdf`, pathStat)
        ).resolves.toBeNull();
    });

    it('user gets a folder reference when the pasted value is a directory', async () => {
        const pathStat = vi.fn().mockResolvedValue({ isFile: false, isDirectory: true });

        await expect(resolvePastedPathAttachment(String.raw`D:\docs`, pathStat)).resolves.toEqual({
            type: 'file',
            path: String.raw`D:\docs`,
        });
    });

    it('user keeps plain text when the pasted value contains more than one line', async () => {
        const pathStat = vi.fn();

        await expect(
            resolvePastedPathAttachment(
                `${String.raw`D:\one.txt`}\n${String.raw`D:\two.txt`}`,
                pathStat
            )
        ).resolves.toBeNull();
        expect(pathStat).not.toHaveBeenCalled();
    });

    it('user can paste a path wrapped in single quotes', async () => {
        const pathStat = vi.fn().mockResolvedValue({ isFile: true, isDirectory: false });

        await expect(
            resolvePastedPathAttachment(String.raw`'D:\docs\notes.md'`, pathStat)
        ).resolves.toEqual({ type: 'file', path: String.raw`D:\docs\notes.md` });
    });

    it('user keeps plain text when a file URL is malformed', async () => {
        const pathStat = vi.fn();

        await expect(resolvePastedPathAttachment('file:///%E0%A4%A', pathStat)).resolves.toBeNull();
        expect(pathStat).not.toHaveBeenCalled();
    });

    it('user gets a POSIX image path without Windows-specific rewriting', async () => {
        const pathStat = vi.fn().mockResolvedValue({ isFile: true, isDirectory: false });

        await expect(
            resolvePastedPathAttachment('/Users/me/Pictures/shot.png', pathStat)
        ).resolves.toEqual({ type: 'image', path: '/Users/me/Pictures/shot.png' });
    });

    it('user gets a file URL normalized into a Windows path', () => {
        expect(normalizePastedPath('file:///C:/Users/me/My%20File.txt')).toBe(
            String.raw`C:\Users\me\My File.txt`
        );
    });

    it('user gets surrounding whitespace trimmed before the existence check', async () => {
        const pathStat = vi.fn().mockResolvedValue({ isFile: true, isDirectory: false });

        const result = await resolvePastedPathAttachment(String.raw`  C:\a.txt  `, pathStat);

        expect(result?.path).toBe(String.raw`C:\a.txt`);
    });
});
