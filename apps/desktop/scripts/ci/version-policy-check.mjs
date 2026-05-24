import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function readJson(path) {
    return JSON.parse(await readFile(path, 'utf8'));
}

function readNonEmptyString(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }

    return value;
}

async function readCargoPackageVersion(path) {
    const cargoToml = await readFile(path, 'utf8');
    let inPackageSection = false;

    for (const line of cargoToml.split(/\r?\n/)) {
        if (/^\s*\[package\]\s*$/.test(line)) {
            inPackageSection = true;
            continue;
        }

        if (inPackageSection && /^\s*\[/.test(line)) {
            break;
        }

        if (inPackageSection) {
            const version = line.match(/^\s*version\s*=\s*"([^"]+)"/)?.[1];
            if (version) {
                return version;
            }
        }
    }

    return null;
}

function validateSemver(version, label) {
    return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
        ? null
        : `${label} version ${version} is not a valid Velopack-compatible semantic version.`;
}

export async function validateVersionPolicy(projectRoot, options = {}) {
    const skipTag = options.skipTag ?? false;
    const errors = [];

    const packageJson = await readJson(join(projectRoot, 'package.json'));
    const productConfig = await readJson(join(projectRoot, 'product.json'));
    const tauriConfig = await readJson(join(projectRoot, 'src-tauri', 'tauri.conf.json'));
    const expectedIdentifier =
        options.expectedIdentifier ??
        readNonEmptyString(productConfig.identifier, 'product.json identifier');
    const packageVersion = packageJson.version;
    const cargoVersion = await readCargoPackageVersion(
        join(projectRoot, 'src-tauri', 'Cargo.toml')
    );
    const tauriVersion = tauriConfig.version;
    const identifier = tauriConfig.identifier;

    for (const [label, version] of [
        ['package.json', packageVersion],
        ['src-tauri/Cargo.toml', cargoVersion],
        ['src-tauri/tauri.conf.json', tauriVersion],
    ]) {
        if (!version) {
            errors.push(`${label} version is missing.`);
            continue;
        }

        const semverError = validateSemver(version, label);
        if (semverError) {
            errors.push(semverError);
        }
    }

    if (cargoVersion && packageVersion && cargoVersion !== packageVersion) {
        errors.push(
            `src-tauri/Cargo.toml version ${cargoVersion} does not match package.json version ${packageVersion}.`
        );
    }

    if (tauriVersion && packageVersion && tauriVersion !== packageVersion) {
        errors.push(
            `src-tauri/tauri.conf.json version ${tauriVersion} does not match package.json version ${packageVersion}.`
        );
    }

    if (identifier !== expectedIdentifier) {
        errors.push(
            `src-tauri/tauri.conf.json identifier ${identifier} does not match ${expectedIdentifier}.`
        );
    }

    const tagName =
        skipTag || options.tagName === null
            ? null
            : (options.tagName ??
              (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null));
    if (tagName && packageVersion) {
        const expectedTag = `v${packageVersion}`;
        if (tagName !== expectedTag) {
            errors.push(`Release tag ${tagName} does not match expected tag ${expectedTag}.`);
        }
    }

    return errors;
}

async function main() {
    const projectRoot = process.cwd();
    const errors = await validateVersionPolicy(projectRoot, {
        skipTag: process.argv.includes('--skip-tag'),
    });

    if (errors.length > 0) {
        for (const error of errors) {
            console.error(error);
        }
        process.exit(1);
    }

    console.log('Version policy checks passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
