# Repository Guidance

## OMP fork release policy

When the user says "release" in this repository, do not run or wait for CI and do not publish any package to npm/public registries.

Release means only:

1. run the relevant local verification for the change;
2. commit and push the release branch if needed;
3. create or update the Git tag;
4. create the GitHub Release for that tag with curated release details.

The GitHub Actions release workflow must not be triggered by tag pushes on this OMP fork. If a tag push accidentally starts a publish workflow, cancel it before it reaches any public publish step.

## Agent routing

- Project-facing architecture, specifications, and operational documentation: `docs/`.
- Durable agent-only incident notes and guardrails: `.agents/notes/`.
- Reusable agent implementation/reference guidance: `.agents/docs/`.
- Keep this file short; link to the routed file instead of duplicating detail.

## OMP maintenance

- `master` is the OMP fork release branch; do not recreate `omp-compat`.
- Upstream upgrades merge the official release tag into `master`, preserving OMP changes and publishing an `-omp.N` fork version.
- Before changing migration process detection, read `.agents/notes/omp-migration-guard.md`; `__omp_worker_*` processes are not Magic Context database holders.
