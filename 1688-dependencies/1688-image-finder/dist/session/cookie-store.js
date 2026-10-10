import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { profilePath } from './paths.js';
const require = createRequire(import.meta.url);
const COOKIE_RELATIVE_PARTS = ['Default', 'Network', 'Cookies'];
const MAX_COOKIE_STORE_BYTES = 512 * 1024 * 1024;
/**
 * Checks for local identity evidence without starting Edge or decrypting cookies.
 * An unreadable or structurally unsafe store is deliberately reported as unknown.
 */
export function probeDefaultEdgeIdentityCookie() {
    try {
        const defaultProfile = profilePath('default');
        const cookieStore = resolveDirectCookieStore(defaultProfile);
        if (cookieStore === null)
            return 'absent';
        const stat = fs.lstatSync(cookieStore);
        if (!stat.isFile()
            || stat.isSymbolicLink()
            || stat.size < 1
            || stat.size > MAX_COOKIE_STORE_BYTES) {
            return 'unknown';
        }
        const { DatabaseSync } = require('node:sqlite');
        const database = new DatabaseSync(cookieStore, { readOnly: true });
        try {
            const found = database.prepare(`
        SELECT 1 AS found
        FROM cookies
        WHERE name = 'unb'
          AND (
            lower(host_key) = '1688.com'
            OR lower(host_key) LIKE '%.1688.com'
            OR lower(host_key) = 'taobao.com'
            OR lower(host_key) LIKE '%.taobao.com'
          )
          AND (length(value) > 0 OR length(encrypted_value) > 0)
        LIMIT 1
      `).get();
            return found ? 'present' : 'absent';
        }
        finally {
            database.close();
        }
    }
    catch {
        return 'unknown';
    }
}
function resolveDirectCookieStore(defaultProfile) {
    const resolvedProfile = path.resolve(defaultProfile);
    let current = resolvedProfile;
    const profileStat = lstatIfExists(current);
    if (!profileStat)
        return null;
    if (!isDirectDirectory(current, profileStat)) {
        throw new Error('Default Edge profile must be a direct directory.');
    }
    for (const part of COOKIE_RELATIVE_PARTS) {
        current = path.resolve(current, part);
        if (!isWithin(resolvedProfile, current)) {
            throw new Error('Edge cookie-store path escapes the default profile.');
        }
        const stat = lstatIfExists(current);
        if (!stat)
            return null;
        if (part === 'Cookies') {
            if (!isDirectPath(current, stat)) {
                throw new Error('Edge cookie store must be a direct file.');
            }
        }
        else if (!isDirectDirectory(current, stat)) {
            throw new Error('Edge cookie-store path must use direct directories.');
        }
    }
    return current;
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
function isDirectDirectory(candidate, stat) {
    return stat.isDirectory() && isDirectPath(candidate, stat);
}
function isDirectPath(candidate, stat) {
    if (stat.isSymbolicLink())
        return false;
    return normalizePath(fs.realpathSync.native(candidate)) === normalizePath(candidate);
}
function isWithin(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}
function normalizePath(candidate) {
    const resolved = path.resolve(candidate).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
//# sourceMappingURL=cookie-store.js.map