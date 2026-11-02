#!/usr/bin/env node

import { readdir } from 'node:fs/promises';

const [directory, rawCount, ...extraArguments] = process.argv.slice(2);
const count = Number(rawCount);

if (
    extraArguments.length > 0 ||
    !directory ||
    !Number.isSafeInteger(count) ||
    count <= 0 ||
    String(count) !== rawCount
) {
    console.error(
        'Usage: node .github/scripts/assert-frontend-shards.mjs <directory> <positive integer shard count>'
    );
    process.exit(1);
}

const expected = Array.from(
    { length: count },
    (_, index) => `blob-${index + 1}-${count}.json`
).sort();

let entries;

try {
    entries = await readdir(directory, { withFileTypes: true });
} catch (error) {
    console.error(`Frontend shard report directory is not readable: ${directory}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}

const actual = entries.map((entry) => entry.name).sort();
const invalidEntries = entries.filter((entry) => !entry.isFile());

if (
    invalidEntries.length > 0 ||
    actual.length !== expected.length ||
    actual.some((filename, index) => filename !== expected[index])
) {
    console.error(`Frontend shard report directory is incomplete: ${directory}`);

    for (const entry of invalidEntries) {
        console.error(`Invalid entry (not a regular file): ${entry.name}`);
    }

    console.error(`Expected files: ${expected.join(', ')}`);
    console.error(`Actual entries: ${actual.length > 0 ? actual.join(', ') : '<none>'}`);
    process.exit(1);
}

console.log(`Verified ${count} frontend shard report files in ${directory}.`);
