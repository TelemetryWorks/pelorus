# Supply-chain rollout — 2026-11-16

Scope: Pelorus workflows/docs and the assigned Dependabot configuration under
the owner's 2026-11-15 security program. Base main:
`8d39c71d02b03b3ebf2fde7142a2d71350524a8a`.
No application, manifest, lockfile, release, package publishing, credential,
repository setting or Sonar setting changes.

## Reviewed templates and preserved behavior

Scorecard and zizmor workflows are copied byte for byte from the
[reviewed irig106-types pilot at 2899b30](https://github.com/TelemetryWorks/irig106-types/tree/2899b30e338358eb2a52d12e036ff979bc25bcf5/.github/workflows).
The [jseries rollout evidence](https://github.com/TelemetryWorks/jseries/blob/210a34bbd7b019d3ea0b7ff49542fbf498d30113/docs/evals/2026-11-15-supply-chain-rollout.md)
supplies the rollout boundaries and validation precedent.

- Scorecard runs on main pushes and weekly, never PRs. Workflow permissions
  default to `contents: read`; only its analysis job grants
  `security-events: write` for SARIF and `id-token: write` for Scorecard results.
  Security-result publication is part of the exact pilot, not package publication.
  The artifact is retained for five days; the README badge targets Pelorus.
- zizmor 1.32.0 audits the entire workflow directory on workflow-changing PRs
  to main. Default regular persona and online audits are retained; failing audit
  mode (`advanced-security: false`) requires no new SARIF permissions.
- All three workflows default to `contents: read`; every checkout disables
  credential persistence. Every direct action reference has a verified full SHA
  and matching version comment. No `pull_request_target` event is present.
- The original Linux CI file is **byte-for-byte unchanged**. Its commands,
  triggers, permissions, timeouts, two-worker bounds, Rust 1.99.1, Node 24.22.1,
  21 Rust tests, strict TypeScript, real-server zero-skip Node gate, explicit
  hash-guarded luma.gl preparation and locked esbuild bundle remain intact.
  Developer scripts, including HTTPS-only downloads, are unchanged. No browser,
  GPU, performance or Windows validation is implied by these security checks.
- Dependabot covers GitHub Actions at `/`, the Cargo workspace at `/` (including
  its `server` member), and npm at `/client` with its existing package-lock.
  Each ecosystem runs weekly, limits open PRs to five, groups minor/patch updates
  and uses `chore(deps)` commit prefixes. Major updates remain outside those
  groups. No dependency or lock record changes in this rollout.

## Direct actions and upstream verification

Upstream GitHub tag APIs resolved each version to its commit, peeling annotated
tags where necessary. The pinned Scorecard and zizmor action input contracts
were inspected at those exact commits.

| Repository | Version comment | Verified commit |
| --- | --- | --- |
| actions/checkout | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| actions/setup-node | v7.1.0 | `949feb2413d6458794dcd2491c4babbbce0c15c1` |
| ossf/scorecard-action | v2.5.0 | `fa7117db83c52d787ae5a89f350999701505d78e` |
| actions/upload-artifact | v7.0.2 | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` |
| github/codeql-action/upload-sarif | v4.39.3 | `33d7b85da1a04171e211befe2c739303b9a4c066` |
| zizmorcore/zizmor-action | v0.8.1 | `45d7276c9ca790aabd705e31ca99c6185c3e76dd` |

## Executed validation and limits

Executed on the restored aarch64 cloud host:

- actionlint 1.7.12 passes all three workflows. Optional shellcheck/pyflakes
  integrations were disabled because those tools are not installed.
- zizmor 1.32.0 offline regular-persona audit of all three workflows passes with
  zero reportable findings, including with `--no-ignores --no-config`.
  Its one omitted concurrency advisory belongs to the built-in pedantic persona;
  no repository ignores, severity filters, inline suppressions or persona changes
  were added. The hosted workflow retains online audits.
- A separate strict-collection Dependabot audit parses the configuration but
  reports three `dependabot-cooldown` advisories, one per ecosystem. The reviewed
  pilot has no cooldown; this rollout retains that policy without suppressions.
  This supplemental audit is not claimed clean. The assigned zizmor workflow
  audits workflows, exactly as in the pilot.
- Verified both template files' exact bytes, all direct SHA/version pairs,
  workflow permission defaults, checkout inputs, absence of PR-target events,
  original CI byte identity, Dependabot paths/policy, unchanged application and
  manifest/lock files, and `git diff --check`.

These are executed static checks, not a local application build/test claim.
Runtime dependencies and native build caches were not restored on this machine
and were not provisioned for this workflows/docs change. Ordinary hosted PR CI
must evaluate the exact review head. Scorecard runs only after merge or on its
schedule: its first score, OIDC issuance, SARIF upload and badge value are not
validated by the PR. No manual run, merge or settings write is performed here.

## Registry name boundary

The owner supplied a registry-name collision: the crates.io name
[`pelorus`](https://crates.io/crates/pelorus) belongs to the unrelated
[`dvicente/pelorus`](https://github.com/dvicente/pelorus) project. It is not a
TelemetryWorks package or publishing target. This rollout does not publish or
reserve names. If this project later plans to publish, first review package
identity and choose/verify an available intended name under a separate release
assignment; do not assume the repository name grants ownership of that crate.
The current workspace member is named `server`, and the npm client is private;
neither manifest is changed here.
