export const DOWNLOAD_EXTENSIONS = [
    '.msi',
    '.dmg',
    '.deb',
    '.rpm',
    '.appimage',
    '.appimage.tar.gz',
    '.app.tar.gz',
    '-full.nupkg',
    '-delta.nupkg',
];

const VERSIONED_ASSET_PATTERN =
    /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)-(?:windows|macos|linux)(?:[.-])/i;

export function assertNonEmptyString(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
}

export function relativeUpdatePath(baseUrl, label = 'services.updates.baseUrl') {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:') {
        throw new Error(`${label} must use https.`);
    }

    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    assertNonEmptyString(path, `${label} path`);
    return path;
}

export function githubRepositoryFromProduct(product, options = {}) {
    const label = options.label ?? 'repository.url';
    const invalidHostMessage = options.invalidHostMessage ?? `${label} must use github.com.`;
    assertNonEmptyString(product?.repository?.url, label);

    const url = new URL(product.repository.url);
    if (url.hostname !== 'github.com') {
        throw new Error(invalidHostMessage);
    }

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 2) {
        throw new Error(`${label} must be a GitHub owner/repository URL.`);
    }

    const [owner, repositoryName] = segments;
    const repository = repositoryName.replace(/\.git$/iu, '');
    assertNonEmptyString(owner, 'repository owner');
    assertNonEmptyString(repository, 'repository name');
    return `${owner}/${repository}`;
}

export function isDownloadAssetName(fileName) {
    const lowerName = String(fileName ?? '').toLowerCase();
    return DOWNLOAD_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
}

export function versionFromAssetName(fileName) {
    return String(fileName ?? '').match(VERSIONED_ASSET_PATTERN)?.[1] ?? null;
}

export function deriveReleaseTagFromAssetName(fileName) {
    const version = versionFromAssetName(fileName);
    if (!version || !isDownloadAssetName(fileName)) {
        return null;
    }

    return `v${version}`;
}

export function channelFromVersion(version) {
    if (!version) {
        return null;
    }
    if (/-nightly(?:[.-]|$)/i.test(version)) {
        return 'nightly';
    }
    if (/-beta(?:[.-]|$)/i.test(version)) {
        return 'beta';
    }
    if (/^\d+\.\d+\.\d+$/u.test(version)) {
        return 'stable';
    }
    return null;
}

export function channelFromTag(tagName) {
    const version = String(tagName ?? '').replace(/^v/u, '');
    return channelFromVersion(version);
}

export function channelFromAssetName(fileName) {
    return channelFromVersion(versionFromAssetName(fileName));
}
