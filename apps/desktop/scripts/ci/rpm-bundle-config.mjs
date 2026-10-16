import { pathToFileURL } from 'node:url';

const SEMVER_PATTERN =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Build the Tauri `--config` override used for the Linux RPM bundle.
 *
 * RPM's version and release fields cannot contain "-" because it separates the
 * version from the release, so a SemVer prerelease cannot be used as the RPM
 * version. The prerelease is moved into the RPM release field instead, which is
 * how RPM models pre-releases: 1.2.3-beta.1 becomes version 1.2.3 with release
 * 0.beta.1, so it still sorts before the 1.2.3-1 stable package.
 */
export function rpmBundleConfig(version) {
    const normalized = typeof version === 'string' ? version.trim() : '';
    const match = normalized.match(SEMVER_PATTERN);
    if (!match) {
        throw new Error(`Release version ${version ?? ''} is not a valid semantic version.`);
    }

    const config = { version: `${match[1]}.${match[2]}.${match[3]}` };
    if (match[4]) {
        config.bundle = {
            linux: {
                rpm: {
                    release: `0.${match[4].replace(/-/g, '~')}`,
                },
            },
        };
    }

    return config;
}

async function main() {
    const version = process.argv[2];
    if (!version) {
        throw new Error('Usage: node scripts/ci/rpm-bundle-config.mjs <version>');
    }

    process.stdout.write(`${JSON.stringify(rpmBundleConfig(version))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message ?? error);
        process.exit(1);
    });
}
