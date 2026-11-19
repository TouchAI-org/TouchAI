/** Match native Windows paths without collapsing distinct POSIX paths. */
export function normalizeSkillPath(path: string): string {
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/g, '');
    return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
        ? normalized.toLowerCase()
        : normalized;
}
