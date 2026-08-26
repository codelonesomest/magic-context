# OMP migration guard

## Incident

OMP internal workers such as `__omp_worker_tiny_inference` run before the normal command graph, do not load extensions, and never open Magic Context's shared SQLite database. They must not block a Magic Context schema migration.

## Rule

Process discovery may treat a Pi/OMP process as a migration holder only when it can load Magic Context. Exclude command lines containing `__omp_worker_*`; continue to block real Pi/OMP harnesses and Task children.

Real OMP main sessions are valid blockers when they predate the installed bundle or hold `context.db`/WAL/SHM. Diagnose them as `OMP`, not `Pi`; do not weaken the guard to fix a display-label bug.

## Regression seam

Keep both checks:

- `packages/plugin/src/shared/rpc-utils.test.ts`: internal workers are absent from `discoverLivePiProcessIds()`.
- `packages/plugin/src/features/magic-context/storage-db.test.ts`: a pending default shared DB migrates when only an internal worker is live.
- `packages/plugin/src/features/magic-context/storage-db.test.ts`: a real OMP main process blocks migration and is reported as `OMP`.

## Operational recovery

For a migration refusal, inspect the named PIDs before asking users to restart sessions. Internal OMP workers are a classifier bug; a real harness that may use the old build must still be restarted before migration.
