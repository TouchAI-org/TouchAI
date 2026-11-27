const BLOCKED_HOST_SUFFIXES = [
    '.localhost',
    '.local',
    '.localdomain',
    '.internal',
    '.home',
    '.lan',
];
const BLOCKED_HOSTS = new Set([
    'instance-data',
    'metadata',
    'metadata.google.internal',
    'metadata.azure.internal',
    'metadata.tencentyun.com',
]);

export type PublicUrlIssue = 'credentials' | 'host' | 'scheme';

export interface PublicUrlPolicy {
    allowLoopback: boolean;
    requireHttpsOutsideLoopback: boolean;
}

function stripIpv6Brackets(hostname: string): string {
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function normalizeHostname(hostname: string): string {
    return stripIpv6Brackets(hostname).replace(/\.+$/, '').toLowerCase();
}

function ipv4FromMappedIpv6(hostname: string): string | null {
    const normalized = normalizeHostname(hostname);
    const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized);
    if (dotted?.[1]) return dotted[1];
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
    if (!hex?.[1] || !hex[2]) return null;
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join('.');
}

function ipv4Octets(hostname: string): number[] | null {
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return null;
    const octets = hostname.split('.').map(Number);
    return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
        ? octets
        : null;
}

export function isLoopbackHostname(hostname: string): boolean {
    const normalized = normalizeHostname(hostname);
    if (normalized === 'localhost' || normalized === '::1') return true;
    const octets = ipv4Octets(normalized);
    return octets?.[0] === 127;
}

function isPrivateOrReservedIpv4(hostname: string): boolean {
    const octets = ipv4Octets(hostname);
    if (!octets) return false;
    const [first = -1, second = -1, third = -1] = octets;
    return (
        first === 0 ||
        first === 10 ||
        first === 127 ||
        (first === 100 && second >= 64 && second <= 127) ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 0 && third === 0) ||
        (first === 192 && second === 0 && third === 2) ||
        (first === 192 && second === 168) ||
        (first === 198 && (second === 18 || second === 19)) ||
        (first === 198 && second === 51 && third === 100) ||
        (first === 203 && second === 0 && third === 113) ||
        first >= 224
    );
}

function isPrivateOrReservedIpv6(hostname: string): boolean {
    const normalized = normalizeHostname(hostname);
    const mapped = ipv4FromMappedIpv6(normalized);
    if (mapped) return isPrivateOrReservedIpv4(mapped);
    return (
        normalized === '::' ||
        normalized === '::1' ||
        normalized.startsWith('fc') ||
        normalized.startsWith('fd') ||
        normalized.startsWith('fe8') ||
        normalized.startsWith('fe9') ||
        normalized.startsWith('fea') ||
        normalized.startsWith('feb') ||
        normalized.startsWith('fec') ||
        normalized.startsWith('fed') ||
        normalized.startsWith('fee') ||
        normalized.startsWith('fef') ||
        normalized.startsWith('ff') ||
        normalized.startsWith('2001:db8')
    );
}

/**
 * Shared public-URL boundary for tools that fetch user-supplied origins.
 * It intentionally checks the literal host only; redirect handling remains
 * the caller's responsibility.
 */
export function inspectPublicUrl(url: URL, policy: PublicUrlPolicy): PublicUrlIssue | null {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'scheme';
    if (url.username || url.password) return 'credentials';

    const hostname = normalizeHostname(url.hostname);
    if (!hostname) return 'host';
    if (isLoopbackHostname(hostname)) return policy.allowLoopback ? null : 'host';
    if (policy.requireHttpsOutsideLoopback && url.protocol !== 'https:') return 'scheme';

    if (
        BLOCKED_HOSTS.has(hostname) ||
        BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
        (!hostname.includes('.') && !hostname.includes(':')) ||
        isPrivateOrReservedIpv4(hostname) ||
        (hostname.includes(':') && isPrivateOrReservedIpv6(hostname))
    ) {
        return 'host';
    }
    return null;
}
