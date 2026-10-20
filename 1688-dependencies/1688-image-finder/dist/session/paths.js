import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { localDirectory } from '../util/local-path.js';
export function root() {
    const configured = process.env.BB1688_HOME?.trim();
    if (process.platform === 'win32' && !configured) {
        throw new Error('BB1688_HOME is required on Windows and must name a dedicated local directory.');
    }
    return localDirectory(configured || path.join(os.homedir(), '.1688'), 'BB1688_HOME');
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
        assertNoReparseAncestors(candidate, 'Runtime path');
    }
    return candidate;
}
function assertNoReparseAncestors(candidate, label) {
    localDirectory(candidate, label, { allowFile: true });
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