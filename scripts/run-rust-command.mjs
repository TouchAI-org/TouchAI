import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

function resolveWorkspaceRoot(cwd) {
    const parent = path.dirname(cwd);

    if (path.basename(parent) === '.worktrees') {
        return path.dirname(parent);
    }

    return cwd;
}

function main() {
    const mode = process.argv[2];

    if (mode !== 'check' && mode !== 'test') {
        console.error('Usage: node scripts/run-rust-command.mjs <check|test>');
        process.exit(1);
    }

    const cwd = process.cwd();
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const targetDir = path.join(workspaceRoot, 'rust-target', mode);
    const tempDir = path.join(workspaceRoot, 'rust-temp', mode);

    mkdirSync(targetDir, { recursive: true });
    mkdirSync(tempDir, { recursive: true });

    const result = spawnSync(
        'cargo',
        [
            mode,
            '--manifest-path',
            'src-tauri/Cargo.toml',
            '--all-targets',
            '--target-dir',
            targetDir,
        ],
        {
            cwd,
            env: {
                ...process.env,
                CARGO_TARGET_DIR: targetDir,
                TEMP: tempDir,
                TMP: tempDir,
            },
            shell: true,
            stdio: 'inherit',
        }
    );

    if (typeof result.status === 'number') {
        process.exit(result.status);
    }

    process.exit(1);
}

main();
