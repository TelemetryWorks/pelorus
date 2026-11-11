# Strict frontend typecheck and locked declaration corrections

`npm run typecheck` uses exactly TypeScript 7.0.2, with strict/noEmit ES2022 ESM,
bundler resolution, DOM libraries and unused checks over `src/**/*.ts`. It checks
library declarations too: no `skipLibCheck`, ambient `any` module stubs or ignored
project diagnostics. esbuild remains the bundler. Tests remain Node standard tests.

## Baseline evidence

Base `efb59e62dc0a2511dbae5d4bdc273646b7317d7d`, original locked libraries,
new strict tsconfig, before source fixes: nine diagnostics. Both TypeScript 7.0.2
and an isolated 5.9.3 compiler reproduce the same nine errors. The comparison
compiler was installed under `/tmp`, not added to the project dependency graph.

```text
client/node_modules/@luma.gl/core/dist/adapter/resources/render-pipeline.d.ts(6,68): error TS2307: Cannot find module '@luma.gl/core/shadertypes/textures/texture-formats' or its corresponding type declarations.
client/node_modules/@luma.gl/engine/dist/shader-inputs.d.ts(20,49): error TS2344: Type 'ShaderPropsT[P]' does not satisfy the constraint 'Record<string, any>'.
  Type 'ShaderPropsT[keyof ShaderPropsT]' is not assignable to type 'Record<string, any>'.
    Type 'ShaderPropsT[string] | ShaderPropsT[number] | ShaderPropsT[symbol]' is not assignable to type 'Record<string, any>'.
      Type 'ShaderPropsT[string]' is not assignable to type 'Record<string, any>'.
        Type 'Record<string, unknown> | undefined' is not assignable to type 'Record<string, any>'.
          Type 'undefined' is not assignable to type 'Record<string, any>'.
client/node_modules/@luma.gl/engine/dist/shader-inputs.d.ts(32,50): error TS2344: Type 'ShaderPropsT[P]' does not satisfy the constraint 'Record<string, any>'.
  Type 'ShaderPropsT[keyof ShaderPropsT]' is not assignable to type 'Record<string, any>'.
    Type 'ShaderPropsT[string] | ShaderPropsT[number] | ShaderPropsT[symbol]' is not assignable to type 'Record<string, any>'.
      Type 'ShaderPropsT[string]' is not assignable to type 'Record<string, any>'.
        Type 'Record<string, unknown> | undefined' is not assignable to type 'Record<string, any>'.
          Type 'undefined' is not assignable to type 'Record<string, any>'.
client/src/main.ts(21,3): error TS1484: 'MetaResponse' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled.
client/src/main.ts(209,10): error TS6133: 'formatBytes' is declared but its value is never read.
client/src/map.ts(79,5): error TS2322: Type 'Deck<MapView>' is not assignable to type 'Deck<null>'.
  Type 'MapView' is not assignable to type 'null'.
client/src/map.ts(80,7): error TS2741: Property 'align' is missing in type 'HTMLElement' but required in type 'HTMLDivElement'.
client/src/map.ts(91,9): error TS2353: Object literal may only specify known properties, and 'depthTest' does not exist in type 'Parameters'.
client/src/map.ts(226,31): error TS6133: 'isDark' is declared but its value is never read.
```

Project corrections use the actual public API: `Deck<MapView>`, a div container,
typed GeoJSON/layer results, a type-only metadata import, removal of unused code,
and removal of the unsupported legacy `depthTest: false` configuration block.
The locked Deck/luma draw path ignores that old key. Removing it leaves the
existing runtime defaults in effect; this tooling task does not introduce new
depth comparison or depth-write settings. No browser/GPU claim is made.

The `querySelector<HTMLDivElement>` type argument is unchecked. Its contract is
tied to the tag-qualified `div#map-container` selector and the fixed
`<div id="map-container">` in `client/dist/index.html`; it is not presented as
runtime validation. The `.mjs` tests are executed by Node, not typechecked by this
`src/**/*.ts` configuration. TypeScript 7's optional `@typescript` platform packages
are transitive development-tool records, not added product runtime dependencies.

## Exact upstream declaration corrections

Both packages are already locked at 9.2.6, published from upstream commit
`9c7a3adc09c7b23800df3f916762445ebc1fa924`.

```diff
# @luma.gl/core/dist/adapter/resources/render-pipeline.d.ts
- from '@luma.gl/core/shadertypes/textures/texture-formats'
+ from '../../shadertypes/textures/texture-formats.js'

# @luma.gl/engine/dist/shader-inputs.d.ts
- ShaderModule<ShaderPropsT[P]>
+ ShaderModule<NonNullable<ShaderPropsT[P]>>
- ShaderModule<ShaderPropsT[P], any>
+ ShaderModule<NonNullable<ShaderPropsT[P]>, any>
```

SHA-256 guards (full installed declaration file bytes):

| File | Original | Corrected |
|---|---|---|
| core/dist/adapter/resources/render-pipeline.d.ts | `20ff7645609753f0817edda2ac7ba64684720e4de006c3a2fc6dcefec210cbd8` | `0b60dcd6b8192687a3b277bec46047c1a196d9c02fe0d3821d9a5b83260115dd` |
| engine/dist/shader-inputs.d.ts | `93000365d5a29fc4016e289acde3e40043d9dbd8db1ababd06dd6d9452a0bdd5` | `f61b91c574f302abcc266d77636d44777e391d72e8e3236e6202e269bc0fd235` |

The first correction resolves the same exported texture type aliases from their
existing file. The package exports only its root, so the original bare internal
subpath is not resolvable under bundler exports rules. This type-only import has
no emitted runtime import. See the [pinned texture source](https://github.com/visgl/luma.gl/blob/9c7a3adc09c7b23800df3f916762445ebc1fa924/modules/core/src/shadertypes/textures/texture-formats.ts).

The engine's `ShaderPropsT` is a partial property map. Its indexed value can
therefore be `undefined`, while the referenced `ShaderModule` generic requires a
record. `NonNullable` removes only that optional-map `undefined`; it introduces
no permissive replacement type and leaves the existing second generic argument
unchanged. The [pinned ShaderInputs source](https://github.com/visgl/luma.gl/blob/9c7a3adc09c7b23800df3f916762445ebc1fa924/modules/engine/src/shader-inputs.ts)
contains typing suppressions at these exact declarations. Its implementation
uses module descriptors and substitutes an empty object for absent props before
calling the uniform handler. Thus the correction matches that record-valued API.

An accurate ambient alias could resolve the first type-only import, but it does
not correct the other two invalid generic applications in the original class.
Interface augmentation cannot replace an existing property with a different type,
or remove an invalid original constructor declaration while full declaration
checking remains enabled. See [TypeScript merging rules](https://www.typescriptlang.org/docs/handbook/declaration-merging.html).

A compiler change to tested 5.9.3 does not resolve these errors; the invalid bare
subpath is also a package-exports problem. This is evidence for the two tested
compilers, not a claim about every compiler version. Upgrading/downgrading the
runtime libraries would change the explicitly frozen runtime graph.

## Repair scope and maintenance

The explicit development command `npm run typeprep` runs
`scripts/repair-luma-declarations.mjs`; `npm run typecheck` only runs the compiler.
There is no npm lifecycle hook or network access. Both fixed packages must be
9.2.6 and both fixed target files must have their original hashes, or both must
have their approved-after hashes. Mixed, unknown or wrong-version states fail
before any writes. All calculated output hashes are checked before writing, and
both actual output hashes are verified afterward. Both-after preparation performs
no writes. It changes no `.js`, runtime source, package manifest or lock record.
`npm ci` restores original declarations; repeated explicit preparation is idempotent.

Any future runtime dependency update must review these corrections and their
hashes against upstream. Do not simply update hashes to accept unknown contents,
or disable checks to make an upgrade pass. No patch/declaration package is added.
The TypeScript/compiler platform packages are development-only additions; every
pre-existing lockfile package record must remain byte-for-byte equivalent as JSON.

## Executed compatibility and identity evidence

On Linux aarch64, with TypeScript 7.0.2 / Node 24.22.1:

- Both original files prepare successfully to the exact approved-after hashes.
- Both prepared files are a no-op, including unchanged modification times.
- Drift in either file, wrong package version in either package, and each mixed
  original/prepared state reject with neither target nor manifest changed.
- An unimported nested frontend source file fails for both an obsolete Deck API
  (`TS2353`) and a wrong project assignment (`TS2322`). The prepared optional
  `ShaderInputs` props API still rejects a string for a numeric value (`TS2322`).
- All 378 existing lockfile package records match base as complete JSON records,
  including resolutions, dependency edges, versions, integrities and flags. The
  21 added records are only development TypeScript 7.0.2 plus its platform tools.
- Across the two affected luma packages, all 554 non-target files match before/after
  preparation, including all 114 JavaScript files. This is a check of preparation
  itself, not a claim that project source fixes have no emitted-byte difference.
- Bundling the same corrected project sources immediately before/after explicit
  declaration preparation produces identical JS and source-map hashes.

Exact preparation-only identity report (sorted relative-path/hash manifest
serialization uses Python `json.dumps(..., sort_keys=True)`):

```json
{
  "beforeBundle": {
    "app.js": "45badd983f0953b7f9175eb2ea6e913cec43788639be3cf2f755be66ae8b45d7",
    "app.js.map": "21d591df3e78c557ac14a4a23a18884a85c2ebf426736f01668f53ad5657f3e2"
  },
  "preparation": "both original -> approved hashes; both approved -> unchanged bytes and mtimes",
  "drift-core": "rejected without changing either target or either manifest",
  "drift-engine": "rejected without changing either target or either manifest",
  "wrong-version-core": "rejected without changing either target or either manifest",
  "wrong-version-engine": "rejected without changing either target or either manifest",
  "mixed-core-before": "rejected without changing either target or either manifest",
  "mixed-engine-before": "rejected without changing either target or either manifest",
  "negativeTypecheck": "unimported nested src file rejected: TS2353 (obsolete Deck API) and TS2322 (string assigned to number)",
  "vendorFilesUnchangedExceptTwoDeclarations": 554,
  "vendorJavaScriptFilesUnchanged": 114,
  "vendorJavaScriptManifestSHA256": "4776da11619a2810dfb7638411ac2d5a3cf406c20b1829b22194383cca1bc14c",
  "unchangedExistingLockPackageRecords": 378,
  "addedDevOnlyRecords": 21,
  "runtimeLockRecordManifestSHA256": "b6181b8bbaf0c3f4b8bc20a718c60f072ff268d8c38b5c07356b564cb1406ce7",
  "negativeShaderInputsAPI": "ShaderInputs<{demo?:{value:number}}> rejects props.value=\"wrong\" with TS2322",
  "afterBundle": {
    "app.js": "45badd983f0953b7f9175eb2ea6e913cec43788639be3cf2f755be66ae8b45d7",
    "app.js.map": "21d591df3e78c557ac14a4a23a18884a85c2ebf426736f01668f53ad5657f3e2"
  }
}
```
