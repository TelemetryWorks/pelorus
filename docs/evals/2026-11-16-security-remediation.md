# Dependabot security remediation — 2026-11-16

Base: `2be7c48` (merged supply-chain rollout). GitHub's open Dependabot alert
API returned exactly nine alerts before changes. No alert dismissal or settings
write is part of this PR; GitHub must evaluate the merged lockfiles before
closing alerts on the default branch.

## Alert-to-remediation inventory

| Alert | Package / advisory | Vulnerable lock version | First patched version | This PR |
| --- | --- | --- | --- | --- |
| [1](https://github.com/TelemetryWorks/pelorus/security/dependabot/1) | rand / [GHSA-cq8v-f236-94qc](https://github.com/advisories/GHSA-cq8v-f236-94qc) | 0.9.2 | 0.9.3 | Locked at **0.9.3**, through tungstenite |
| [2](https://github.com/TelemetryWorks/pelorus/security/dependabot/2) | rand / GHSA-cq8v-f236-94qc | 0.8.5 | 0.8.6 | Locked at **0.8.6**, direct server dependency |
| [3](https://github.com/TelemetryWorks/pelorus/security/dependabot/3) | protocol-buffers-schema / [GHSA-j452-xhg8-qg39](https://github.com/advisories/GHSA-j452-xhg8-qg39) | 3.6.0 | 3.6.1 | Removed with unused umbrella; no installed/locked copy remains |
| [4](https://github.com/TelemetryWorks/pelorus/security/dependabot/4) | fast-xml-parser / [GHSA-gh4j-gqv2-49f6](https://github.com/advisories/GHSA-gh4j-gqv2-49f6) | 4.5.6 | 5.7.0 | Removed with unused umbrella; no installed/locked copy remains |
| [5](https://github.com/TelemetryWorks/pelorus/security/dependabot/5) | esbuild / [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) | 0.28.0 | 0.28.1 | Locked at **0.28.1**, including platform packages; manifest floor `^0.28.1` |
| [6](https://github.com/TelemetryWorks/pelorus/security/dependabot/6) | fflate / [GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98) | 0.7.4 | 0.7.5 on this line | Removed with unused umbrella; no installed/locked copy remains |
| [7](https://github.com/TelemetryWorks/pelorus/security/dependabot/7) | image-size / [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) | 0.7.5 | 2.0.3 | Removed with unused umbrella; no installed/locked copy remains |
| [8](https://github.com/TelemetryWorks/pelorus/security/dependabot/8) | moment / [GHSA-4p3w-j4w9-5jqw](https://github.com/advisories/GHSA-4p3w-j4w9-5jqw) | 2.30.1 | 2.31.0 | Removed with unused umbrella; no installed/locked copy remains |
| [9](https://github.com/TelemetryWorks/pelorus/security/dependabot/9) | fast-xml-parser / [GHSA-474x-hrwr-fgx4](https://github.com/advisories/GHSA-474x-hrwr-fgx4) | 4.5.6 | 5.12.0 | Removed with unused umbrella; no installed/locked copy remains |

The first-patched column records upstream advisory requirements; it does **not**
claim that removed packages were upgraded to those versions. Two targeted Cargo
updates change only rand's versions/checksums and its two dependency references.
The 0.8.6 backport exists, so the direct dependency stays on the current 0.8 line
without a source/API migration. Arrow 54 and tower-http 0.6 remain untouched.

## Why remove the unused umbrella

Pelorus already imports `@deck.gl/core`, `@deck.gl/layers` and
`@deck.gl/extensions` directly. No source imports the separate `deck.gl`
umbrella. Its unused aggregation, Carto, mesh, geospatial and other adapters
introduced all six runtime npm alert records above.

In particular, `texture-compressor@1.0.2` calls image-size with a filesystem path,
while image-size 2's default function takes bytes. Blindly overriding image-size
to 2.0.3 would leave that consumer incompatible. Updated loader parents also
require a newer loader core, conflicting with the retained Deck package peers.
An exploratory resolver attempt failed; no force/legacy-peer-deps bypass was used
and none of that attempted graph was retained.

Removing the unused umbrella eliminates 296 lock records, adds no packages and
leaves **every retained runtime npm lock record exactly unchanged**. Only the
root record and esbuild's development-tool/platform records change among retained
records. The granular Deck packages stay at 9.2.11 and luma.gl stays at 9.2.6.
There are no overrides, vendor runtime patches, application changes or added
runtime packages. The hash-guarded luma declaration repair is unchanged.

## Executed compatibility and security checks

On the aarch64 cloud host, with at most two heavy workers:

- Installed the original lockfile using `npm ci --ignore-scripts` and captured
  its normal browser bundle. After pruning, built the same source with the
  original esbuild 0.28.0 binary: byte-for-byte identical JavaScript, SHA-256
  `93353f5d54bf870f07aa4042d1b492af9829be13a7b47d8106656aabe8bcccf7`.
  This checks that removal does not change the shipped module graph/output.
- Fresh `npm ci --ignore-scripts` with the new lock succeeds. The patched
  esbuild 0.28.1 changes only its two generated module-initialization helpers
  relative to the baseline bundle; the source map also changes accordingly.
  Final JavaScript SHA-256:
  `ddcf38ea21227cea81dc41c4a904de7642ba176381c1203c448066c2f0e5a31e`.
  This is not a claim of byte identity across compiler versions.
- `npm audit --json` reports **zero vulnerabilities**. Explicit lock inspection
  finds no image-size, fast-xml-parser, fflate, moment or protocol-buffers-schema
  record at any nesting depth, and verifies both patched rand versions against
  the GitHub advisory. This is not a cargo-audit execution claim.
- Explicit type preparation passes twice (repair, then idempotence); strict
  TypeScript passes with the existing guards and full declaration checking.
- Rust fmt, Clippy with warnings denied, all **21 Rust tests**, and locked build
  pass. The unchanged client CI harness passes all **52 Node tests**, **zero
  skips**, including both actual Rust-server integrations. esbuild build, Bash
  syntax and `git diff --check` pass. Existing tests remain unchanged.
- Workflow files, local esbuild invocation, HTTPS-only geodata downloads,
  declaration-preparation script, source and tests are unchanged. No browser,
  GPU, Windows exploit reproduction or performance validation is claimed.

## Owner Dependabot policy

Owner policy dated **2026-11-16**: review security fixes individually; review
small patch/minor/action updates per repository in one batch; plan majors
deliberately and review them individually. Each ecosystem entry now ignores
`version-update:semver-major` for `*`, with a dated policy comment. This controls
version-update PRs; security updates remain enabled. Weekly scheduling, five-PR
limits, existing minor/patch groups and `chore(deps)` prefixes are preserved.
No existing Dependabot PR is merged, closed or otherwise changed here.
