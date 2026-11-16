# Strict frontend typecheck

The current lockfile uses Deck 9.4.1, luma.gl 9.4.2 and TypeScript 7.0.2.
Run the compiler directly against the unmodified installed declarations:

```bash
cd client
npm ci --ignore-scripts
npm run typecheck
```

The project keeps strict/noEmit ES2022 ESM, bundler resolution, DOM libraries,
unused checks and full dependency declaration checking over `src/**/*.ts`.
There is no `skipLibCheck`, ambient module shim, ignored project diagnostic or
local declaration repair. esbuild remains the locked local browser bundler.
The `.mjs` tests execute separately and are not typechecked by this configuration.

## Retirement of the 9.2.6 repair

Dependabot [PR #18](https://github.com/TelemetryWorks/pelorus/pull/18), exact head
`43bad5d53543819027d385939fe0615f12b57a7b`, updates the three granular Deck
packages from 9.2.11 to 9.4.1 and esbuild from 0.28.1 to 0.28.2. The resulting
luma.gl version is 9.4.2. Its failed CI reports
`Error: Unexpected luma.gl version: 9.4.2` from the deliberately narrow old guard.
This is a guard failure, not evidence that 9.4.2 needs its declarations patched.

Before retiring the workaround, the original problem was reproduced on main
`cc76a39` with a clean original-lock installation and TypeScript 7.0.2. Without
preparation, all three original vendor diagnostics recur:

```text
node_modules/@luma.gl/core/dist/adapter/resources/render-pipeline.d.ts(6,68): error TS2307: Cannot find module '@luma.gl/core/shadertypes/textures/texture-formats' or its corresponding type declarations.
node_modules/@luma.gl/engine/dist/shader-inputs.d.ts(20,49): error TS2344: Type 'ShaderPropsT[P]' does not satisfy the constraint 'Record<string, any>'.
node_modules/@luma.gl/engine/dist/shader-inputs.d.ts(32,50): error TS2344: Type 'ShaderPropsT[P]' does not satisfy the constraint 'Record<string, any>'.
```

Running the existing 9.2.6 preparation makes that same strict check pass. Then,
with PR #18's exact manifest/lockfile and a fresh `npm ci --ignore-scripts`, the
old guard rejects 9.4.2 as expected, but **direct `npm run typecheck` passes**
without preparing or changing any installed declarations.

The upstream 9.4.2 packages identify source commit
`94e95a6ab4e5981d4d15e54cca540febd13f2775`:

- [RenderPipeline source](https://github.com/visgl/luma.gl/blob/94e95a6ab4e5981d4d15e54cca540febd13f2775/modules/core/src/adapter/resources/render-pipeline.ts)
  uses a relative texture-type import. The published declaration imports
  `../../shadertypes/texture-types/texture-formats.js`, resolving the old TS2307.
- [ShaderInputs source](https://github.com/visgl/luma.gl/blob/94e95a6ab4e5981d4d15e54cca540febd13f2775/modules/engine/src/shader-inputs.ts)
  defines `ShaderInputsModule` descriptors and uses them for registered modules
  and constructor inputs. The two invalid indexed generic applications from
  9.2.6 are gone; typed `setProps` remains checked.

Both installed target declarations were compared byte-for-byte against fresh
9.4.2 npm tarballs. Their raw SHA-256 values are evidence, not new repair guards:

| Published declaration | SHA-256 |
| --- | --- |
| core/dist/adapter/resources/render-pipeline.d.ts | `de053ea17c3b41828a9ab8e0bf505a0508c609c0fd384602929ddf21748eb454` |
| engine/dist/shader-inputs.d.ts | `bb24ada9dbacd741a5560ead3dab13d34a764df5f5a5c9fce8de076a235d49f2` |

The obsolete repair script, `typeprep` command, CI preparation step and active
setup instructions are removed together. The old precise repair, compiler
comparison, hash guards and identity evidence remain in the
[historical 9.2.6 record](evals/2026-11-11-luma-926-declaration-repair.md).
No guard is widened to accept unknown versions or contents.

## Negative typing controls

With unmodified 9.4.2 declarations, a temporary frontend source file was checked
and then removed. All three expected mistakes fail:

- `ShaderInputs<{demo?: {value: number}}>.setProps` with a string value: TS2322.
- The unsupported Deck `parameters.depthTest` key: TS2353.
- A project string assigned to a number: TS2322.

These controls establish that a clean positive check was not obtained by
weakening project or dependency typing. They do not establish browser/GPU
correctness or performance. The source, existing 21 Rust/52 Node tests, test
harness, local esbuild invocation and HTTPS-only downloads remain unchanged.

The full local gate on aarch64 passes with a fresh install and at most two heavy
workers: direct strict typecheck, Rust fmt/Clippy with warnings denied, all 21
locked Rust tests, locked build, all 52 Node tests with zero skips and both
actual-server integrations, and esbuild build. actionlint 1.7.12 and zizmor
1.32.0's offline regular-persona workflow audit also pass. After these checks,
both installed declarations still match the unmodified 9.4.2 tarball bytes.

## Dependency boundaries

The dependency lockfile is copied exactly from PR #18. The only additional
manifest change is removal of the obsolete `typeprep` script. The `deck.gl`
umbrella stays absent; npm audit reports zero vulnerabilities. No additional
project dependency, override, runtime source patch, release or settings change
is introduced. Rust dependencies and the separately planned Arrow/tower-http
major upgrades are outside this change.

Future updates must pass the same direct strict check and unchanged real-server
zero-skip gate. A new declaration defect requires new evidence and review;
retiring this workaround is not permission to bypass compiler failures.
