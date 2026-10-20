import fs from 'node:fs';
import path from 'node:path';

// Runtime directories must be local, dedicated directories. Supporting a new
// installation drive must not weaken the existing reparse-point boundary.
export function localDirectory(value, label, { platform = process.platform, fsImpl = fs, allowFile = false } = {}) {
    if (typeof value !== 'string' || !value.trim() || /[\0-\x1f]/.test(value)) {
        throw new Error(`${label} must be a non-empty local absolute directory.`);
    }
    const raw = value.trim();
    const paths = platform === 'win32' ? path.win32 : path.posix;
    if (/^[\\/]{2}/.test(raw) || !paths.isAbsolute(raw)
        || (platform === 'win32' && !/^[a-z]:[\\/]/i.test(raw))) {
        throw new Error(`${label} must be a local absolute path, not a UNC or device path.`);
    }
    if (raw.split(/[\\/]+/).includes('..')) {
        throw new Error(`${label} must not contain parent traversal.`);
    }
    const resolved = paths.resolve(raw);
    const parsed = paths.parse(resolved);
    if (resolved.toLowerCase() === parsed.root.toLowerCase()) {
        throw new Error(`${label} must be a dedicated directory, not a drive root.`);
    }
    const segments = resolved.slice(parsed.root.length).split(paths.sep).filter(Boolean);
    if (platform === 'win32' && segments.some((part) => /[<>:"|?*]|[ .]$/.test(part)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
        throw new Error(`${label} contains an unsafe Windows path component.`);
    }
    const normalize = (candidate) => {
        const normalized = paths.resolve(candidate).replace(/[\\/]+$/, '');
        return platform === 'win32' ? normalized.toLowerCase() : normalized;
    };
    let current = parsed.root;
    for (const component of ['', ...segments]) {
        if (component) current = paths.join(current, component);
        let stat;
        try { stat = fsImpl.lstatSync(current); }
        catch (error) {
            if (error.code === 'ENOENT') break;
            throw error;
        }
        if (stat.isSymbolicLink() || normalize(fsImpl.realpathSync.native(current)) !== normalize(current)) {
            throw new Error(`${label} must not traverse a reparse point or symbolic link.`);
        }
        if (!stat.isDirectory() && (!allowFile || normalize(current) !== normalize(resolved))) {
            throw new Error(`${label} must resolve through directories.`);
        }
    }
    return resolved;
}
