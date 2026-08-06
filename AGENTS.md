# Repository Guidance

## OMP fork release policy

When the user says "release" in this repository, do not run or wait for CI and do not publish any package to npm/public registries.

Release means only:

1. run the relevant local verification for the change;
2. commit and push the release branch if needed;
3. create or update the Git tag;
4. create the GitHub Release for that tag with curated release details.

The GitHub Actions release workflow must not be triggered by tag pushes on this OMP fork. If a tag push accidentally starts a publish workflow, cancel it before it reaches any public publish step.
