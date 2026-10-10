export async function sleep(ms) {
    if (ms <= 0)
        return;
    await new Promise((resolve) => setTimeout(resolve, ms));
}
export async function withTimeout(promise, opts) {
    let timer = null;
    try {
        return await Promise.race([
            promise,
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(opts.fallback), opts.timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
export async function waitWithDeadline(poll, opts) {
    const deadline = Date.now() + opts.timeoutMs;
    const intervalMs = opts.intervalMs ?? 250;
    let attempt = 0;
    while (true) {
        const now = Date.now();
        const remainingMs = Math.max(0, deadline - now);
        if (remainingMs <= 0)
            return opts.onTimeout();
        const result = await poll({ attempt, deadline, now, remainingMs });
        if (result !== null && result !== undefined)
            return result;
        attempt++;
        await sleep(Math.min(intervalMs, remainingMs));
    }
}
export async function waitUntil(predicate, opts) {
    return waitWithDeadline(async () => ((await predicate()) ? true : null), {
        ...opts,
        onTimeout: () => false,
    });
}
export async function waitForTruthy(probe, opts) {
    return waitWithDeadline(async () => {
        const value = await probe();
        return value || null;
    }, {
        ...opts,
        onTimeout: () => null,
    });
}
//# sourceMappingURL=wait.js.map