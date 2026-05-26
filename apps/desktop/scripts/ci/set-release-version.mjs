import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEMVER_PATTERN =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function assertVersion(version) {
    if (!SEMVER_PATTERN.test(version)) {
        throw new Error(`Release version ${version} is not a valid semantic version.`);
    }
}

async function updateJsonVersion(path, version) {
    const value = JSON.parse(await readFile(path, 'utf8'));
    value.version = version;
    await writeFile(path, `${JSON.stringify(value, null, 4)}\n`, 'utf8');
}

function updatePackageTomlVersion(toml, version) {
    let inPackageSection = false;
    let updated = false;

    const lines = toml.split(/\r?\n/).map((line) => {
        if (/^\s*\[package\]\s*$/.test(line)) {
            inPackageSection = true;
            return line;
        }

        if (inPackageSection && /^\s*\[/.test(line)) {
            inPackageSection = false;
        }

        if (inPackageSection && /^\s*version\s*=\s*"[^"]*"\s*$/.test(line)) {
            updated = true;
            return line.replace(/"[^"]*"/, `"${version}"`);
        }

        return line;
    });

    if (!updated) {
        throw new Error('src-tauri/Cargo.toml [package] version is missing.');
    }

    return lines.join('\n');
}

function updateWorkspaceLockVersion(lockFile, version) {
    let inTouchAiPackage = false;
    let updated = false;

    const lines = lockFile.split(/\r?\n/).map((line) => {
        if (/^\s*\[\[package\]\]\s*$/.test(line)) {
            inTouchAiPackage = false;
            return line;
        }

        if (/^\s*name\s*=\s*"touchai"\s*$/.test(line)) {
            inTouchAiPackage = true;
            return line;
        }

        if (inTouchAiPackage && /^\s*version\s*=\s*"[^"]*"\s*$/.test(line)) {
            updated = true;
            inTouchAiPackage = false;
            return line.replace(/"[^"]*"/, `"${version}"`);
        }

        return line;
    });

    return updated ? lines.join('\n') : lockFile;
}

export async function setReleaseVersion(projectRoot, version) {
    assertVersion(version);

    await updateJsonVersion(join(projectRoot, 'package.json'), version);
    await updateJsonVersion(join(projectRoot, 'src-tauri', 'tauri.conf.json'), version);

    const cargoTomlPath = join(projectRoot, 'src-tauri', 'Cargo.toml');
    const cargoToml = await readFile(cargoTomlPath, 'utf8');
    await writeFile(cargoTomlPath, updatePackageTomlVersion(cargoToml, version), 'utf8');

    const cargoLockPath = join(projectRoot, 'src-tauri', 'Cargo.lock');
    try {
        const cargoLock = await readFile(cargoLockPath, 'utf8');
        await writeFile(cargoLockPath, updateWorkspaceLockVersion(cargoLock, version), 'utf8');
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }
}

async function main() {
    const version = process.argv[2];
    if (!version) {
        throw new Error('Usage: node scripts/ci/set-release-version.mjs <version>');
    }

    await setReleaseVersion(process.cwd(), version);
    console.log(`Release version set to ${version}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message ?? error);
        process.exit(1);
    });
}
