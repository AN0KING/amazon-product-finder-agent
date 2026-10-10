import fs from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { defaultProfileName, ensureProfileRuntimeDir, lockFile, } from './paths.js';
import { CliError } from '../io/errors.js';
export async function acquireLock(profile) {
    const profileName = defaultProfileName(profile);
    await ensureProfileRuntimeDir(profileName);
    const target = lockFile(profileName);
    // proper-lockfile requires the target file to exist
    await fs.writeFile(target, '', { flag: 'a' });
    // proper-lockfile heartbeats the owner. A dead owner becomes reclaimable
    // after 30 seconds; a live non-daemon command must never be mistaken for a
    // stale lock merely because it has no daemon.pid file.
    const lockOpts = { retries: 0, stale: 30_000, update: 10_000 };
    try {
        return await lockfile.lock(target, lockOpts);
    }
    catch (e) {
        if (e.code !== 'ELOCKED')
            throw e;
        throw new CliError(5, 'LOCK_BUSY', `Another 1688 command is running for profile "${profileName}". Close it and retry.`);
    }
}
//# sourceMappingURL=lock.js.map