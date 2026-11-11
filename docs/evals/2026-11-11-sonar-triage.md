# Pelorus Sonar triage — 2026-11-11

Baseline/source: `2a6db803fd612976abbed5e8d7807ffb535f45e6` on a clean cloud main.
Origin is `https://github.com/TelemetryWorks/pelorus.git`. No AGENTS.md or
contributor guide exists in this checkout; README, development/typecheck guidance,
manifests and Linux CI were inspected. Existing branches/work/evidence are kept.

Public issue inventory: 31 unresolved findings, exactly 1 bug, 7 vulnerabilities,
23 code smells. Main analysis `06d10d9b-7d0f-4df9-afc6-2100111ff3b5` at
2026-11-11T05:56:09Z reports this exact revision. Inventory was fetched via
`api/issues/search?componentKeys=TelemetryWorks_pelorus-&resolved=false&ps=100`;
this is source-rule triage, not a dependency vulnerability scan or penetration test.

## Prioritized bounded plan before source changes

1. **Basemap diagnostics, separate PR.** `S9383` flags the unhandled renderer
   loader promise. A rejected loader reaches an unhandled promise rejection.
   Ordinary fetch/JSON rejections are already contained by `Promise.allSettled`
   in the actual BaseMap loader; they currently disappear without diagnostics.
   Reproduce both paths with actual source and bounded rejected-promise fixtures;
   add an explicit renderer rejection handler and log rejected assets. Preserve
   successful/partial loading, flags, constructor API, rendering and no-retry behavior.
2. **Developer script security, separate PR.** Two `S6505` sites call `npx esbuild`:
   a missing local binary can reach package-manager download/lifecycle fallback
   instead of failing. Reproduce with package-manager sentinels and missing local
   dependencies; use only the existing locked executable and preserve all build/watch
   arguments. Five `S6506` sites use `curl -sL`: the initial URL is fixed HTTPS,
   but redirect protocols are not restricted and HTTP error status is not fatal.
   Reproduce HTTP errors/downgrades with bounded fixtures; require HTTPS initially
   and on redirects plus HTTP failure exit. No invented checksum or package added.
3. **Defer all 23 smells.** These include constructor-lifecycle refactoring,
   complexity, buffer signatures, readonly members and expression style. They are
   not automatically security bugs. Broad changes would touch the previously
   reviewed history/render contracts. Any incidental line movement is not a
   deliberate smell sweep; no issue is dismissed or suppressed.

## Exact inventory and disposition

| Key | Type / severity | Rule | Source at baseline | Disposition / reachability |
|---|---|---|---|---|
| `AaHGAPkIOB7cC4l45FHF` | CODE_SMELL / CRITICAL | `typescript:S3776` | `client/src/main.ts:349` | Deferred smell; no standalone behavior defect established in this triage |
| `AaHGAPjsOB7cC4l45FG8` | CODE_SMELL / CRITICAL | `typescript:S3776` | `client/src/protocol.ts:52` | Deferred smell; no standalone behavior defect established in this triage |
| `AaHGAPj7OB7cC4l45FG-` | CODE_SMELL / CRITICAL | `typescript:S3776` | `client/src/buffer.ts:86` | Deferred smell; no standalone behavior defect established in this triage |
| `AaHGAPj7OB7cC4l45FG_` | CODE_SMELL / MINOR | `typescript:S7773` | `client/src/buffer.ts:126` | Deferred smell; no standalone behavior defect established in this triage |
| `AaHGAPj7OB7cC4l45FHA` | CODE_SMELL / MAJOR | `typescript:S4043` | `client/src/buffer.ts:155` | Deferred smell; no standalone behavior defect established in this triage |
| `AaHGAPj7OB7cC4l45FHB` | CODE_SMELL / MINOR | `typescript:S7770` | `client/src/buffer.ts:174` | Deferred smell; no standalone behavior defect established in this triage |
| `AaHGAPkIOB7cC4l45FHC` | CODE_SMELL / MINOR | `typescript:S6582` | `client/src/main.ts:135` | Deferred smell; no standalone behavior defect established in this triage |
| `AaHGAPkIOB7cC4l45FHE` | CODE_SMELL / MINOR | `typescript:S6582` | `client/src/main.ts:306` | Deferred smell; no standalone behavior defect established in this triage |
| `AaHGAPkIOB7cC4l45FHD` | CODE_SMELL / MINOR | `typescript:S6582` | `client/src/main.ts:179` | Deferred smell; no standalone behavior defect established in this triage |
| `AaHGAPkXOB7cC4l45FHG` | CODE_SMELL / MAJOR | `typescript:S2933` | `client/src/timeslider.ts:23` | Deferred smell; no standalone behavior defect established in this triage |
| `AaHGAPkXOB7cC4l45FHH` | CODE_SMELL / MINOR | `typescript:S7773` | `client/src/timeslider.ts:169` | Deferred smell; no standalone behavior defect established in this triage |
| `AaHGAPkiOB7cC4l45FHJ` | BUG / MAJOR | `typescript:S9383` | `client/src/map.ts:92` | PR: catch/log rejected loader; contained fetch failures need explicit diagnostics |
| `AZ1Y6se75zDvPrra3AX2` | CODE_SMELL / MINOR | `typescript:S7773` | `client/src/timeslider.ts:98` | Deferred smell; no standalone behavior defect established in this triage |
| `AZ1WzW_M8MsCUjGK7Hyt` | CODE_SMELL / CRITICAL | `typescript:S7059` | `client/src/map.ts:92` | Deferred smell; no standalone behavior defect established in this triage |
| `AZ1WzW_b8MsCUjGK7Hyu` | CODE_SMELL / MAJOR | `shell:S7688` | `scripts/dev.sh:9` | Deferred smell; no standalone behavior defect established in this triage |
| `AaHGAPkiOB7cC4l45FHI` | CODE_SMELL / MAJOR | `typescript:S2933` | `client/src/map.ts:50` | Deferred smell; no standalone behavior defect established in this triage |
| `AaHGAPmCOB7cC4l45FHL` | VULNERABILITY / MAJOR | `shell:S6506` | `scripts/download-geodata.sh:18` | PR: HTTP/downgrade permitted by curl defaults; upstream redirect/error prerequisite |
| `AaHGAPmCOB7cC4l45FHM` | VULNERABILITY / MAJOR | `shell:S6506` | `scripts/download-geodata.sh:23` | PR: HTTP/downgrade permitted by curl defaults; upstream redirect/error prerequisite |
| `AaHGAPmCOB7cC4l45FHN` | VULNERABILITY / MAJOR | `shell:S6506` | `scripts/download-geodata.sh:28` | PR: HTTP/downgrade permitted by curl defaults; upstream redirect/error prerequisite |
| `AaHGAPmCOB7cC4l45FHO` | VULNERABILITY / MAJOR | `shell:S6506` | `scripts/download-geodata.sh:33` | PR: HTTP/downgrade permitted by curl defaults; upstream redirect/error prerequisite |
| `AaHGAPmCOB7cC4l45FHP` | VULNERABILITY / MAJOR | `shell:S6506` | `scripts/download-geodata.sh:39` | PR: HTTP/downgrade permitted by curl defaults; upstream redirect/error prerequisite |
| `AaHGAPj7OB7cC4l45FG9` | CODE_SMELL / MAJOR | `typescript:S2933` | `client/src/buffer.ts:19` | Deferred smell; no standalone behavior defect established in this triage |
| `AZ1Ww5zrKQyapgKNLkIn` | CODE_SMELL / MAJOR | `typescript:S107` | `client/src/buffer.ts:86` | Deferred smell; no standalone behavior defect established in this triage |
| `AZ1Ww5zrKQyapgKNLkIo` | CODE_SMELL / MAJOR | `typescript:S107` | `client/src/buffer.ts:199` | Deferred smell; no standalone behavior defect established in this triage |
| `AZ1WqXhND2y9bmQTHuPs` | CODE_SMELL / MAJOR | `typescript:S3358` | `client/src/main.ts:196` | Deferred smell; no standalone behavior defect established in this triage |
| `AZ1WqXhND2y9bmQTHuPt` | CODE_SMELL / MAJOR | `typescript:S3358` | `client/src/main.ts:197` | Deferred smell; no standalone behavior defect established in this triage |
| `AZ1WqXhND2y9bmQTHuPu` | CODE_SMELL / MAJOR | `typescript:S3358` | `client/src/main.ts:198` | Deferred smell; no standalone behavior defect established in this triage |
| `AZ1WqXhND2y9bmQTHuPv` | CODE_SMELL / MAJOR | `typescript:S7762` | `client/src/main.ts:203` | Deferred smell; no standalone behavior defect established in this triage |
| `AZ1WqXhND2y9bmQTHuPx` | CODE_SMELL / MAJOR | `typescript:S2301` | `client/src/main.ts:231` | Deferred smell; no standalone behavior defect established in this triage |
| `AaHGAPksOB7cC4l45FHK` | VULNERABILITY / MAJOR | `shell:S6505` | `scripts/dev.sh:17` | PR: reachable package-manager fallback if local esbuild is missing |
| `AaHGAPmGOB7cC4l45FHQ` | VULNERABILITY / MAJOR | `shell:S6505` | `scripts/watch.sh:16` | PR: reachable package-manager fallback if local esbuild is missing |

## Reproductions recorded before fixes

The two focused tests in `client/test/basemap.test.mjs` fail on the baseline:

- Actual loader with four rejected fetches: all four failures are contained and
  the existing empty-map/loaded behavior completes, but **0 diagnostics instead of
  4** are emitted. This is not an unhandled rejection from ordinary fetch failure.
- Actual renderer with its loader boundary returning a rejected promise: the
  isolated child observes `unhandledRejection: ["loader fixture"]` instead of none,
  and no explicit renderer failure log. This tests the loader promise contract;
  the ordinary network path is tested separately above.

No real browser/GPU behavior or retry capability is inferred from these fixtures.

## NONE gate and credential path — public/read-only findings

Public GET evidence at the same main revision:

- `qualitygates/project_status`: `status: NONE`, no conditions or periods.
- `qualitygates/get_by_project?organization=telemetryworks&project=TelemetryWorks_pelorus-`:
  default **Sonar way**, ID **9**, already selected. NONE does **not** establish
  that the project has no selected gate.
- Gate 9 has six new-code conditions: security/reliability/maintainability ratings,
  coverage, duplicated lines and security hotspots. It is built-in; no edits made.
- Public main measures return `ncloc: 3563`, `lines: 4304`, but none of the requested
  new-code ratings, `new_lines` or `alert_status`. Together with the missing period,
  this supports investigating new-code evaluation/baseline, not changing thresholds.
- The latest analysis revision is exactly main `2a6db80`. Its GitHub check is from
  app `sonarqubecloud`, conclusion **neutral**; Linux CI is independently successful.
  The repo workflow contains no Sonar scanner or SONAR_TOKEN reference. Public
  evidence is consistent with automatic GitHub-app analysis, not a broken CI token.
- `api/new_code_periods/show` returns an unsupported-route 404 here. No private API,
  token, environment value, secret inventory or credential validity was probed.

Proposed setup/proof sequence, **not executed**:

1. Root authorizes an administrator to inspect this project's main New Code
   definition and automatic-analysis binding in the UI. Record the existing state
   and identify why new-code measures/period are absent. The public evidence cannot
   establish that configuration's exact cause or available private controls.
2. Keep gate 9 and its thresholds. Sonar's public documentation identifies a
   missing New Code definition as a cause of a non-computed gate. This project has
   three analyses, so the one-analysis explanation does not fit the public record.
   If the UI confirms an unset/unusable definition, propose `Number of days: 30`
   (a documented supported mode), recording the actual prior value and obtaining
   explicit root approval before saving. Do not create a release/tag, invent a
   version, weaken thresholds or switch scanner modes as a workaround.
3. For the current automatic-app path, verify the GitHub app's project binding and
   normal push/PR analysis after approval; do not introduce SONAR_TOKEN into CI.
   If root instead requests authenticated API administration, obtain a scoped
   Sonar user credential through an approved secret channel with only the project's
   required admin rights. An analysis-only token is not assumed to grant settings
   rights. Request permission to test read-only identity/access before any write;
   never expose credential values in chat, Git, logs or command arguments.
4. Proof after an approved change: record exact revision/analysis, selected gate ID,
   evaluated main conditions and a concrete OK/ERROR result rather than NONE;
   observe the ordinary automatic GitHub check at that revision and a normal PR's
   new-code conditions. Preserve Linux typecheck/real-server zero-skip evidence.
   Do not trigger manual analyses or change SaaS settings during this source round.

All 31 findings above remain untouched in Sonar's issue state. Source fixes can
resolve findings only through existing automatic analysis; no dismissal, marking,
profile/gate/credential/settings writes or additional SaaS setup was performed.


Primary documentation consulted (read-only):

- [SonarQube Cloud quality gates and non-computed status](https://docs.sonarsource.com/sonarqube-cloud/standards/quality-gates)
- [Supported New Code definitions](https://docs.sonarsource.com/sonarqube-cloud/standards/about-new-code)
- [Project permission meanings](https://docs.sonarsource.com/sonarqube-cloud/managing-your-projects/administering-your-projects/setting-permissions)
- [curl protocol, redirect and HTTP-failure options](https://curl.se/docs/manpage.html)
