// Long-lived shared BrowserContext for the daemon. Operations are serialized
// (one Playwright op at a time) so we look like a single, deliberate user
// rather than concurrent requests.
import fs from 'node:fs/promises';
import { defaultProfileName, profilePath } from './paths.js';
import { acquireLock } from './lock.js';
import { CliError } from '../io/errors.js';
import { launchEdgeContext } from './context.js';
import { enrichErrorWithArtifact, } from './artifacts.js';
import { detectPageState } from './page-state.js';
let sharedCtx = null;
let lockRelease = null;
let opChain = Promise.resolve();
let sharedProfile = null;
let sharedSuspension = null;
let sharedSuspensionSequence = 0;
export async function getSharedContext(profile) {
    assertSharedAvailable();
    const profileName = defaultProfileName(profile);
    if (sharedCtx) {
        if (sharedProfile !== profileName) {
            throw new CliError(5, 'DAEMON_PROFILE_MISMATCH', `Daemon shared context is bound to profile "${sharedProfile}", not "${profileName}".`);
        }
        if (sharedCtx.browser()?.isConnected() !== false)
            return sharedCtx;
        await closeSharedContextNow();
    }
    lockRelease = await acquireLock(profileName);
    try {
        const dir = profilePath(profileName);
        await fs.mkdir(dir, { recursive: true });
        const verifiedDir = profilePath(profileName);
        sharedCtx = await launchEdgeContext(profileName, true);
        sharedProfile = profileName;
        await sharedCtx.addInitScript(() => {
            try {
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['zh-CN', 'zh', 'en'],
                });
            }
            catch {
                /* ignore */
            }
        });
        return sharedCtx;
    }
    catch (error) {
        await closeSharedContextNow();
        throw error;
    }
}
export async function runOnSharedCtx(fn, meta, profile) {
    assertSharedAvailable();
    const operation = opChain.catch(() => undefined).then(async () => {
        assertSharedAvailable();
        try {
            const ctx = await getSharedContext(profile);
            return await fn(ctx);
        }
        catch (e) {
            const ctx = sharedCtx;
            if (ctx && meta) {
                throw await enrichErrorWithArtifact(ctx, meta, e);
            }
            throw e;
        }
    });
    opChain = operation.then(() => undefined, () => undefined);
    return operation;
}
export async function getSharedContextStatus() {
    if (!sharedCtx) {
        return {
            profile: sharedProfile,
            browserAlive: false,
            pageCount: 0,
            currentUrl: null,
            pageState: null,
            loggedIn: null,
        };
    }
    const pages = sharedCtx.pages().filter((p) => !p.isClosed());
    const page = pages.at(-1) ?? null;
    const pageState = page ? await detectPageState(page).catch(() => null) : null;
    return {
        profile: sharedProfile,
        browserAlive: true,
        pageCount: pages.length,
        currentUrl: page?.url() ?? null,
        pageState,
        loggedIn: pageState
            ? pageState.kind === 'normal_1688_page'
                ? true
                : pageState.kind === 'not_logged_in'
                    ? false
                    : null
            : null,
    };
}
export async function releaseSharedContext() {
    const operation = opChain.catch(() => undefined).then(closeSharedContextNow);
    opChain = operation.then(() => undefined, () => undefined);
    await operation;
}
export async function suspendSharedContext(reason) {
    const suspension = beginSharedContextSuspension(reason);
    await suspension.drained;
    return suspension.token;
}
export function beginSharedContextSuspension(reason) {
    if (sharedSuspension?.reason === 'shutdown' && reason !== 'shutdown') {
        assertSharedAvailable();
    }
    const token = ++sharedSuspensionSequence;
    sharedSuspension = { reason, token };
    const drained = (async () => {
        try {
            await withTimeout(releaseSharedContext(), 90_000, 'Timed out waiting for the active 1688 operation to finish.');
        }
        catch (cause) {
            const error = new CliError(5, 'SESSION_DRAIN_TIMEOUT', 'Timed out waiting for the active 1688 operation to finish. The shared session remains suspended.', { retryable: false });
            error.cause = cause;
            throw error;
        }
    })();
    return { reason, token, drained };
}
export function resumeSharedContext(token) {
    if (sharedSuspension?.token !== token)
        return false;
    sharedSuspension = null;
    return true;
}
export function getSharedContextSuspension() {
    return sharedSuspension ? { ...sharedSuspension } : null;
}
async function closeSharedContextNow() {
    const context = sharedCtx;
    const release = lockRelease;
    if (context) {
        try {
            await withTimeout(context.close(), 15_000, 'Shared Edge did not close in time.');
        }
        catch (error) {
            if (context.browser()?.isConnected() !== false)
                throw error;
        }
    }
    if (release)
        await release();
    if (sharedCtx === context)
        sharedCtx = null;
    if (lockRelease === release)
        lockRelease = null;
    sharedProfile = null;
}
function assertSharedAvailable() {
    if (!sharedSuspension)
        return;
    throw new CliError(5, 'SESSION_SUSPENDED', `The shared 1688 session is paused for ${sharedSuspension.reason}.`);
}
async function withTimeout(operation, timeoutMs, message) {
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeoutMs);
                timer.unref();
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
//# sourceMappingURL=shared.js.map