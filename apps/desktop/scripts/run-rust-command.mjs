import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

function resolveRepoRoot(cwd) {
    return path.resolve(cwd, '..', '..');
}

function resolveRustArtifactsRoot(repoRoot) {
    const configuredRoot = process.env.TOUCHAI_RUST_ARTIFACTS_ROOT?.trim();

    if (!configuredRoot) {
        return repoRoot;
    }

    return path.resolve(configuredRoot);
}

function main() {
    const mode = process.argv[2];

    if (mode !== 'check' && mode !== 'test') {
        console.error('Usage: node scripts/run-rust-command.mjs <check|test>');
        process.exit(1);
    }

    const cwd = process.cwd();
    const repoRoot = resolveRepoRoot(cwd);
    const artifactsRoot = resolveRustArtifactsRoot(repoRoot);
    // CI 环境统一 target 目录，避免 check 和 test 重复编译
    const sharedDir = process.env.CI ? 'ci-check' : mode;
    const targetDir = path.join(artifactsRoot, 'rust-target', sharedDir);
    const tempDir = path.join(artifactsRoot, 'rust-temp', sharedDir);

    mkdirSync(targetDir, { recursive: true });
    mkdirSync(tempDir, { recursive: true });

    const cargoArgs = [
        mode,
        '--manifest-path',
        'src-tauri/Cargo.toml',
        '--all-targets',
        '--target-dir',
        targetDir,
    ];

    // CI 环境使用 ci-check profile（debug=1, codegen-units=256），加速编译并保留调试信息
    if (process.env.CI) {
        cargoArgs.push('--profile', 'ci-check');
    }

    const result = spawnSync('cargo', cargoArgs, {
        cwd,
        env: {
            ...process.env,
            CARGO_TARGET_DIR: targetDir,
            TEMP: tempDir,
            TMP: tempDir,
        },
        shell: true,
        stdio: 'inherit',
    });

    if (typeof result.status === 'number') {
        process.exit(result.status);
    }

    process.exit(1);
}

main();
