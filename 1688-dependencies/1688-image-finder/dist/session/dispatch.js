// Routes a command either through the selected profile daemon (fast) or inline
// (slow but self-contained). Headed mode stays inline.
import crypto from 'node:crypto';
import { withSession } from './context.js';
import { runOnSharedCtx } from './shared.js';
import { defaultProfileName } from './paths.js';
import { appendEventBestEffort, endEvent, eventFromError, startEvent, } from './events.js';
// Lazy-imported registry of command executors. Each entry must export `execute`.
// login/logout are deliberately omitted — they have interactive flows (QR render,
// stdin confirmation) that don't transit cleanly through a socket; they stay inline.
const REGISTRY = {
    'image-search': () => import('../commands/image-search.js').then((m) => m.execute),
};
export async function loadExecutor(name) {
    const loader = REGISTRY[name];
    if (!loader)
        throw new Error(`Unknown command: ${name}`);
    return (await loader());
}
export async function dispatch(name, args, opts = {}) {
    const profile = defaultProfileName(opts.profile);
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    await appendEventBestEffort(startEvent({ requestId, cmd: name, profile }));
    const finishOk = async () => {
        await appendEventBestEffort(endEvent({ requestId, cmd: name, startedAt, profile }));
    };
    const finishError = async (error) => {
        await appendEventBestEffort(eventFromError({ requestId, cmd: name, startedAt, profile, error }));
    };
    try {
        const fn = await loadExecutor(name);
        const operation = (ctx) => fn(ctx, args);
        const meta = { requestId, cmd: name, args };
        const data = opts.shared && !opts.headed && !opts.noDaemon
            ? await runOnSharedCtx(operation, meta, profile)
            : await withSession({ headless: !opts.headed, profile }, operation, meta);
        await finishOk();
        return data;
    }
    catch (error) {
        await finishError(error);
        throw error;
    }
}
//# sourceMappingURL=dispatch.js.map