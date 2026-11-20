export function parseArgs(argv) {
    const values = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[index + 1];
        if (next && !next.startsWith('--')) {
            values[key] = next;
            index += 1;
        } else {
            values[key] = 'true';
        }
    }
    return values;
}

export function numberArg(args, name, fallback) {
    const value = Number(args[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function nonNegativeNumberArg(args, name, fallback) {
    const value = Number(args[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}
