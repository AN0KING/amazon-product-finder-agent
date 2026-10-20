import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Native Node filesystem calls support deep Windows dependency paths without
// requiring changes to the machine's PowerShell or long-path registry policy.
const [mode, packageArgument, installationArgument, stageArgument] = process.argv.slice(2);
const fail = message => { throw new Error(message); };
function inside(root, value) {
  const resolved = path.resolve(value);
  const relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('Unsafe path outside installation root.');
  return resolved;
}
async function inspectAncestors(file, cache = new Set()) {
  let cursor = path.resolve(file);
  while (true) {
    if (cache.has(cursor)) return;
    try {
      const info = await fs.lstat(cursor);
      if (info.isSymbolicLink()) fail('Installation paths must not contain reparse points.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    cache.add(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
function targetFor(root, stage, name) {
  if (name === 'Install.cmd') return null;
  if (name.startsWith('application/')) return inside(root, path.join(stage, name.slice(12)));
  if (name.startsWith('windows/')) return inside(root, path.join(root, 'control/scripts', name.slice(8)));
  return inside(root, path.join(root, name));
}
async function main() {
  if (!['validate','copy'].includes(mode) || !packageArgument || !installationArgument || !stageArgument) fail('Invalid installation payload arguments.');
  const sourceRoot = path.resolve(packageArgument);
  const installRoot = path.resolve(installationArgument);
  const stageRoot = inside(installRoot, stageArgument);
  const manifest = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package-manifest.json'), 'utf8'));
  if (manifest.product !== 'scout-amazon-agent-windows' || !Array.isArray(manifest.files) || !manifest.files.length) fail('Invalid package identity.');
  const seen = new Set(), sourceCache = new Set(), targetCache = new Set(), validated = [];
  for (const entry of manifest.files) {
    const name = entry?.path;
    if (typeof name !== 'string' || !/^(?:(application|runtime|windows|interfaces|docs)\/|Install\.cmd$|README[^/]*$)/.test(name) || /(^|\/)\.\.?(\/|$)|[\\:]/.test(name) || name.endsWith('/') || !/^[a-f0-9]{64}$/i.test(entry.sha256 || '')) fail('Invalid package file path or checksum.');
    if (seen.has(name.toLowerCase())) fail('Duplicate package file path.');
    seen.add(name.toLowerCase());
    const source = inside(sourceRoot, path.join(sourceRoot, name));
    const target = targetFor(installRoot, stageRoot, name);
    await inspectAncestors(source, sourceCache);
    if (!(await fs.lstat(source)).isFile()) fail(`Package file missing: ${name}`);
    const digest = crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex');
    if (digest !== entry.sha256.toLowerCase()) fail(`Package file checksum failed: ${name}`);
    if (target) await inspectAncestors(target, targetCache);
    validated.push({ source, target, digest });
  }
  if (mode === 'validate') return;
  // No payload write happens until every source and destination passes validation.
  for (const file of validated) {
    if (!file.target) continue;
    await inspectAncestors(file.target);
    await fs.mkdir(path.dirname(file.target), { recursive: true });
    await inspectAncestors(file.target);
    await fs.copyFile(file.source, file.target);
  }
}
main().catch(error => {
  process.stderr.write(`${error?.message || 'Installation payload failed.'}\n`);
  process.exitCode = 1;
});
