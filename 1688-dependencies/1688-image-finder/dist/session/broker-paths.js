import path from 'node:path';
import { localDirectory } from '../util/local-path.js';

// The bridge and CLI exchange only per-launch signals in this one configured
// directory. A matching suffix elsewhere on disk is not sufficient.
export function brokerSignalPath(value, extension, { env = process.env, platform = process.platform, fsImpl } = {}) {
    if (!['ready', 'cancel'].includes(extension)) throw new Error('Unsupported login signal.');
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const options = { platform, ...(fsImpl ? { fsImpl } : {}) };
    const dataRoot = localDirectory(env.BB1688_DATA_ROOT || paths.join(
        env.SCOUT_1688_PROJECT_ROOT || 'D:\\deliverables\\1688-procurement-assistant-2.3.0',
        'data', 'sourcing-console'), 'BB1688_DATA_ROOT', options);
    const resolved = localDirectory(value, 'Login signal', { ...options, allowFile: true });
    const expectedParent = paths.join(dataRoot, 'runtime-cache', 'login-handshakes');
    const normalize = value => platform === 'win32' ? value.toLowerCase() : value;
    if (normalize(paths.dirname(resolved)) !== normalize(expectedParent)
        || !new RegExp(`^launch-\\d+-[a-f0-9-]{36}\\.${extension}$`, 'i').test(paths.basename(resolved))) {
        throw new Error('Login signal is outside the configured handshake directory.');
    }
    return resolved;
}
