#!/usr/bin/env node
/**
 * Bundle manifest gate: the invariants a DSH bundle must satisfy to install and
 * load, checked without a Harness. Run by CI and by `npm run check`.
 *
 *   node scripts/check-manifest.mjs
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];

/** Record one failed invariant. */
function fail(message) {
  failures.push(message);
  console.error(`✗ ${message}`);
}

/** Record one satisfied invariant. */
function pass(message) {
  console.log(`✓ ${message}`);
}

/** Read a file relative to the package root. */
function read(relative) {
  return readFileSync(join(root, relative), 'utf8');
}

/** Read a file and report a missing one once. */
function readIfPresent(relative) {
  try {
    return read(relative);
  } catch {
    fail(`${relative} is missing`);
    return undefined;
  }
}

const pkg = JSON.parse(read('package.json'));

// 1. Identity
if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(pkg.name ?? '')) {
  fail(`package name must be a valid npm name, got ${JSON.stringify(pkg.name)}`);
} else {
  pass(`name ${pkg.name}`);
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? '')) {
  fail(`version must be exact SemVer, got ${JSON.stringify(pkg.version)}`);
} else {
  pass(`version ${pkg.version}`);
}
if (typeof pkg.description !== 'string' || pkg.description.trim() === '') fail('description is required');
if (pkg.license !== 'MIT') fail(`license should stay MIT, got ${JSON.stringify(pkg.license)}`);

// 2. Bundle manifest: without dsh.bundle a package is not installable at all.
if (typeof pkg.dsh?.bundle?.patch !== 'string') {
  fail('dsh.bundle.patch is required');
} else {
  pass(`bundle patch ${pkg.dsh.bundle.patch}`);
  if (!readIfPresent(pkg.dsh.bundle.patch)) fail('bundle patch file is unreadable');
}

// 3. Client half: platform and exports the Web loader resolves.
if (pkg.dsh?.client?.platform !== 'web') fail('dsh.client.platform must be "web"');
else pass('client platform web');
for (const entry of ['.', './client', './locale/*.json', './icon']) {
  if (typeof pkg.exports?.[entry] !== 'string') fail(`exports["${entry}"] is required`);
}
if (!failures.some((message) => message.startsWith('exports['))) pass('exports . / ./client / ./locale / ./icon');

// 4. Published files: everything the runtime needs must survive `npm pack`.
for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale/*.json']) {
  if (!Array.isArray(pkg.files) || !pkg.files.includes(required)) fail(`files must include ${required}`);
}
if (!failures.some((message) => message.startsWith('files must include'))) pass('files cover the runtime');

// 5. The patch row must mount this exact package name.
const patch = readIfPresent('cordis.patch.yml');
if (patch !== undefined) {
  const name = pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`name:\\s*['"]?${name}['"]?\\s*$`, 'm').test(patch)) {
    fail(`cordis.patch.yml does not mount ${pkg.name}`);
  } else {
    pass('cordis.patch.yml mounts this package');
  }
}

// 6. Host half exports the functions the Loader calls.
const host = readIfPresent('index.js');
if (host !== undefined) {
  if (!/export function apply\b/.test(host)) fail('index.js must export apply(ctx)');
  if (!/export const inject\s*=/.test(host)) fail('index.js must export inject');
  if (/export default\b/.test(host)) fail('index.js must not mix export default with apply()');
  if (!failures.some((message) => message.includes('index.js'))) pass('host exports apply + inject');
}

// 7. Client module id must equal the package name, or the loader never pairs them.
const client = readIfPresent('client.js');
if (client !== undefined) {
  const id = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)?.[1];
  if (id !== pkg.name) fail(`client module id ${JSON.stringify(id)} must equal the package name`);
  else pass(`client module id ${id}`);
}

// 8. Locales carry the Plugin Manager title and description.
for (const locale of ['en', 'zh']) {
  const file = `locale/${locale}.json`;
  const text = readIfPresent(file);
  if (text === undefined) continue;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`${file} is not valid JSON`);
    continue;
  }
  if (typeof parsed?.meta?.title !== 'string' || parsed.meta.title.trim() === '') fail(`${file} needs meta.title`);
  if (typeof parsed?.meta?.description !== 'string' || parsed.meta.description.trim() === '') fail(`${file} needs meta.description`);
  if (!failures.some((message) => message.startsWith(file))) pass(`${file} metadata`);
}

// 9. Icon: a real SVG inside the size limit the Plugin Manager accepts.
const icon = readIfPresent('icon.svg');
if (icon !== undefined) {
  if (!icon.trimStart().startsWith('<svg')) fail('icon.svg is not an SVG document');
  else if (statSync(join(root, 'icon.svg')).size > 256 * 1024) fail('icon.svg exceeds 256 KiB');
  else pass('icon valid and within size limit');
}

if (failures.length > 0) {
  console.error(`\n${failures.length} manifest check(s) failed`);
  process.exit(1);
}
console.log('\nmanifest ok');
