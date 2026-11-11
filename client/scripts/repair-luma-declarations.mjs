// Declaration-only corrections for the locked luma.gl 9.2.6 packages. Keep full
// library checking enabled. Hash guards fail closed when upstream files change.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const repairs = [
  {
    manifest: '../node_modules/@luma.gl/core/package.json',
    file: '../node_modules/@luma.gl/core/dist/adapter/resources/render-pipeline.d.ts',
    before: '20ff7645609753f0817edda2ac7ba64684720e4de006c3a2fc6dcefec210cbd8',
    after: '0b60dcd6b8192687a3b277bec46047c1a196d9c02fe0d3821d9a5b83260115dd',
    replacements: [["'@luma.gl/core/shadertypes/textures/texture-formats'", "'../../shadertypes/textures/texture-formats.js'"]],
  },
  {
    manifest: '../node_modules/@luma.gl/engine/package.json',
    file: '../node_modules/@luma.gl/engine/dist/shader-inputs.d.ts',
    before: '93000365d5a29fc4016e289acde3e40043d9dbd8db1ababd06dd6d9452a0bdd5',
    after: 'f61b91c574f302abcc266d77636d44777e391d72e8e3236e6202e269bc0fd235',
    replacements: [
      ['ShaderModule<ShaderPropsT[P]>', 'ShaderModule<NonNullable<ShaderPropsT[P]>>'],
      ['ShaderModule<ShaderPropsT[P], any>', 'ShaderModule<NonNullable<ShaderPropsT[P]>, any>'],
    ],
  },
];
const hash = text => createHash('sha256').update(text).digest('hex');
const targets = repairs.map(repair => {
  const path = new URL(repair.file, import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL(repair.manifest, import.meta.url), 'utf8'));
  if (manifest.version !== '9.2.6') throw new Error(`Unexpected luma.gl version: ${manifest.version}`);
  const original = readFileSync(path, 'utf8');
  const digest = hash(original);
  const state = digest === repair.before ? 'original' : digest === repair.after ? 'prepared' : null;
  if (!state) throw new Error(`Unexpected declaration contents: ${path.pathname}`);
  let fixed = original;
  if (state === 'original') {
    for (const [from, to] of repair.replacements) fixed = fixed.replace(from, to);
  }
  if (hash(fixed) !== repair.after) throw new Error(`Declaration repair did not match: ${path.pathname}`);
  return { path, fixed, state, after: repair.after };
});
if (new Set(targets.map(target => target.state)).size !== 1) {
  throw new Error('Mixed declaration state; run clean npm ci before explicit type preparation');
}
// All versions, input hashes, state consistency and output hashes passed before
// either write. There are only these two fixed .d.ts targets, with no network.
if (targets[0].state === 'original') {
  for (const target of targets) writeFileSync(target.path, target.fixed);
}
for (const target of targets) {
  if (hash(readFileSync(target.path, 'utf8')) !== target.after) {
    throw new Error(`Prepared declaration hash mismatch: ${target.path.pathname}`);
  }
}
console.log('Verified luma.gl 9.2.6 declarations: both targets prepared; full strict checking remains enabled.');
