import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function ensureDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true });
}

export function assertManagedPath(candidate, parent) {
    const resolvedCandidate = path.resolve(candidate);
    const resolvedParent = `${path.resolve(parent)}${path.sep}`;
    if (!resolvedCandidate.startsWith(resolvedParent)) {
        throw new Error(`Refusing to remove unmanaged path: ${resolvedCandidate}`);
    }
}

export function removeManagedDirectory(directory, parent) {
    assertManagedPath(directory, parent);
    fs.rmSync(directory, { recursive: true, force: true });
}

export function appendLog(file, text) {
    ensureDirectory(path.dirname(file));
    fs.appendFileSync(file, text);
}

export function nowIso() {
    return new Date().toISOString();
}

export function writeJson(file, value) {
    ensureDirectory(path.dirname(file));
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function sha256File(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function sha256Text(value) {
    return createHash('sha256').update(value).digest('hex');
}

export function readJsonLines(file) {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const records = [];
    for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        try {
            records.push(JSON.parse(line));
        } catch (error) {
            throw new Error(
                `Invalid JSONL at ${file}:${index + 1}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
                { cause: error }
            );
        }
    }
    return records;
}

export function readJsonFile(file) {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function copyIfExists(source, destination) {
    if (!fs.existsSync(source)) return;
    fs.cpSync(source, destination, { recursive: true, force: true });
}
