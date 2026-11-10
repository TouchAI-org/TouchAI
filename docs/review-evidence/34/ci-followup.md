# Skills CI follow-up

## Managed-directory link fixture

The Linux Rust coverage run on `a1ff8180` passed 778 tests and failed while creating
the first link in the managed-directory protection test. Joining an empty path to
the application root retained a trailing separator; POSIX `symlink` rejected the
link name before the installation code or security assertions ran.

The root case now uses the root path directly. The same five redirect locations,
exact rejection assertion and outside-file preservation assertions remain. No
production path validation or filesystem permissions change.

Failing evidence: [Rust Checks](https://github.com/TouchAI-org/TouchAI/actions/runs/42869557771/job/130016903751).
Linux execution and coverage must pass on the corrected commit; Windows compilation
alone does not establish that result.

## Intentional visual baseline changes

Only two snapshots are updated, using the unmodified actual PNGs captured by the
CI workflows that compare them. Each expected/actual pair was inspected before
accepting the baseline. No tolerance or screenshot assertion was relaxed.

- `primitives-badge--tones-and-sizes.png`: adds the new source badge row. Existing
  variants retain their appearance. The first attempt and retry produced identical
  PNG hashes (`734c7be8aa47246adddf0b942bee554e21a893fd37e552993aed40721ce95c7b`).
  [Pinned component renderer](https://github.com/TouchAI-org/TouchAI/actions/runs/42869557758/job/130016954307).
- `settings-built-in-tools.png`: the registered `ActivateSkill` tool is now the first
  alphabetically ordered entry. It shifts the existing tool rows while the call-log
  panel retains its layout. [Windows application capture](https://github.com/TouchAI-org/TouchAI/actions/runs/42869557786/job/130016902663).

The stale search-border assertion reported in the same desktop run belongs to the
window-frame layer (#782). Its updated assertion was moved there from #784, keeping
the test with the presentation it verifies.
