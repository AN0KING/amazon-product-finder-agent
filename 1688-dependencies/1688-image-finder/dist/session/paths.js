import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
const FIXED_WINDOWS_HOME = 'D:\\deliverables\\1688-image-finder\\data\\1688-session';
export function root() {
    if (process.platform !== 'win32') {
        return process.env.BB1688_HOME ?? path.join(os.homedir(), '.1688');
    }
    const configured = process.env.BB1688_HOME?.trim();
    if (!configured) {
        throw new Error('BB1688_HOME is required on Windows and must be an absolute path on the D: drive.');
    }
    if (/^[\\/]{2}/.test(configured)) {
        throw new Error('BB1688_HOME must not be a UNC or device path.');
    }
    if (!path.win32.isAbsolute(configured)) {
        throw new Error('BB1688_HOME must be an absolute Windows path.');
    }
    const resolved = path.win32.resolve(configured);
    assertWindowsDDrive(resolved, 'BB1688_HOME');
    if (process.env.NODE_ENV !== 'test'
        && resolved.toLowerCase() !== path.win32.resolve(FIXED_WINDOWS_HOME).toLowerCase()) {
        throw new Error(`BB1688_HOME must be the dedicated session path: ${FIXED_WINDOWS_HOME}`);
    }
    assertNoReparseAncestors(resolved, 'BB1688_HOME');
    return resolved;
}
function runtimePath(...parts) {
    const base = root();
    const candidate = path.resolve(base, ...parts);
    const relative = path.relative(base, candidate);
    if (relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)) {
        throw new Error('Runtime path escapes BB1688_HOME.');
    }
    if (process.platform === 'win32') {
        assertWindowsDDrive(candidate, 'Runtime path');
        assertNoReparseAncestors(candidate, 'Runtime path');
    }
    return candidate;
}
function assertWindowsDDrive(candidate, label) {
    const drive = path.win32.parse(candidate).root.toUpperCase();
    if (drive !== 'D:\\') {
        throw new Error(`${label} must resolve to the D: drive.`);
    }
}
function assertNoReparseAncestors(candidate, label) {
    const resolved = path.win32.resolve(candidate);
    const parsed = path.win32.parse(resolved);
    let current = parsed.root;
    const segments = resolved
        .slice(parsed.root.length)
        .split(path.win32.sep)
        .filter(Boolean);
    assertExistingPathIsDirect(current, label);
    for (const segment of segments) {
        current = path.win32.join(current, segment);
        const stat = lstatIfExists(current);
        if (!stat)
            break;
        assertExistingPathIsDirect(current, label, stat);
    }
}
function lstatIfExists(candidate) {
    try {
        return fs.lstatSync(candidate);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
function assertExistingPathIsDirect(candidate, label, stat = fs.lstatSync(candidate)) {
    if (stat.isSymbolicLink()) {
        throw new Error(`${label} must not traverse a reparse point.`);
    }
    const real = fs.realpathSync.native(candidate);
    if (normalizeWindowsPath(real) !== normalizeWindowsPath(candidate)) {
        throw new Error(`${label} must not traverse a reparse point.`);
    }
}
function normalizeWindowsPath(candidate) {
    return path.win32.resolve(candidate).replace(/[\\/]+$/, '').toLowerCase();
}
export function profilesDir() {
    return runtimePath('profiles');
}
export function defaultProfileName(profile) {
    const name = profile?.trim();
    return name ? name : 'default';
}
export function profileRuntimeDir(profile) {
    const name = defaultProfileName(profile);
    return name === 'default' ? root() : profilePath(name);
}
export function stateFile(profile) {
    return runtimePath(...runtimeRelativeParts(profileRuntimeDir(profile)), 'state.json');
}
export function lockFile(profile) {
    return runtimePath(...runtimeRelativeParts(profileRuntimeDir(profile)), '.lock');
}
export function socketPath(profile) {
    return socketPathForPlatform(process.platform, root(), profile);
}
export function socketPathForPlatform(platform, rootPath, profile) {
    const name = defaultProfileName(profile);
    // Windows: Node's net.listen()/createConnection() can't bind a Unix-style
    // filesystem path on win32 (EACCES). Use a named pipe instead. Include a
    // stable root hash so different users and BB1688_HOME values do not collide,
    // and include the profile hash so profiles under one root can run together.
    if (platform === 'win32') {
        const base = `\\\\.\\pipe\\1688-cli-daemon-${rootHash(rootPath)}`;
        return name === 'default' ? base : `${base}-${profileHash(name)}`;
    }
    const dir = name === 'default' ? rootPath : path.join(rootPath, 'profiles', name);
    return path.join(dir, 'daemon.sock');
}
export function rootHash(rootPath) {
    return crypto
        .createHash('sha1')
        .update(path.resolve(rootPath).toLowerCase())
        .digest('hex')
        .slice(0, 12);
}
export function profileHash(profile) {
    return crypto
        .createHash('sha1')
        .update(defaultProfileName(profile).toLowerCase())
        .digest('hex')
        .slice(0, 12);
}
export function pidFile(profile) {
    return runtimePath(...runtimeRelativeParts(profileRuntimeDir(profile)), 'daemon.pid');
}
export function daemonVersionFile(profile) {
    return runtimePath(...runtimeRelativeParts(profileRuntimeDir(profile)), 'daemon.version');
}
export function daemonLogFile(profile) {
    return runtimePath(...runtimeRelativeParts(profileRuntimeDir(profile)), 'daemon.log');
}
export function runsDir() {
    return runtimePath('runs');
}
export function eventsFile() {
    return runtimePath('events.jsonl');
}
export function configFile() {
    return runtimePath('config.json');
}
export function loginQrFile() {
    return runtimePath('login-qr.png');
}
export function edgeCacheDir(mode = 'headless') {
    return runtimePath('runtime-cache', 'edge-cache', mode);
}
export function profilePath(name = 'default') {
    return runtimePath('profiles', defaultProfileName(name));
}
export async function ensureRoot() {
    const dir = root();
    await fsp.mkdir(dir, { recursive: true });
    if (process.platform === 'win32') {
        assertNoReparseAncestors(dir, 'BB1688_HOME');
    }
}
export async function ensureProfileRuntimeDir(profile) {
    const dir = profileRuntimeDir(profile);
    await fsp.mkdir(dir, { recursive: true });
    if (process.platform === 'win32') {
        assertNoReparseAncestors(dir, 'Profile runtime path');
    }
}
function runtimeRelativeParts(candidate) {
    const relative = path.relative(root(), candidate);
    return relative ? relative.split(path.sep) : [];
}
//# sourceMappingURL=paths.js.map