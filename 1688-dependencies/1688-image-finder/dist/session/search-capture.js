import { SEARCH_APP_ID, isSearchServiceFallbackMtopText, parseOfferItemsFromMtopText, readSearchMtopRiskControl, readSearchMtopRequestMeta, } from './search-mtop.js';
export async function captureSearchOffersForAction(opts, action, waitOptions) {
    const capture = startSearchOfferCapture(opts);
    return capture.waitForAction(action, waitOptions);
}
export function startSearchOfferCapture(opts) {
    const maxDiagnosticsEntries = 5;
    const startedAt = new Date().toISOString();
    let endedAt;
    let disposed = false;
    let pageClosed = false;
    let finalStatus;
    let timedOut = false;
    let offers = [];
    let seenCount = 0;
    let matchedCount = 0;
    let parsedCount = 0;
    let fallbackCount = 0;
    let riskControlCount = 0;
    let lastSeenUrl;
    let lastMatchedUrl;
    let lastParsedUrl;
    let lastFallbackUrl;
    let lastRiskControlUrl;
    let lastRiskControlCode;
    let lastError;
    const failures = [];
    const pendingResponseReads = new Set();
    const signalWaiters = new Set();
    let generation = 0;
    let signalVersion = 0;
    const notify = () => {
        signalVersion++;
        for (const wake of [...signalWaiters])
            wake();
    };
    const waitForSignal = (observedVersion, timeoutMs) => {
        if (signalVersion !== observedVersion || timeoutMs <= 0) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            let timer;
            const finish = () => {
                if (timer)
                    clearTimeout(timer);
                signalWaiters.delete(finish);
                resolve();
            };
            signalWaiters.add(finish);
            timer = setTimeout(finish, timeoutMs);
            // Covers a response that completed between the caller's status check and
            // this waiter being registered.
            if (signalVersion !== observedVersion)
                finish();
        });
    };
    const errorInfo = (error) => {
        if (error instanceof Error) {
            return { name: error.name, message: error.message };
        }
        return { message: String(error) };
    };
    const recordFailure = (url, error) => {
        const info = errorInfo(error);
        lastError = info;
        failures.push({
            at: new Date().toISOString(),
            url,
            ...info,
        });
        if (failures.length > maxDiagnosticsEntries)
            failures.shift();
    };
    const diagnostics = () => ({
        startedAt,
        endedAt,
        disposed,
        finalStatus,
        timedOut,
        seenCount,
        matchedCount,
        parsedCount,
        fallbackCount,
        riskControlCount,
        failureCount: failures.length,
        lastSeenUrl,
        lastMatchedUrl,
        lastParsedUrl,
        lastFallbackUrl,
        lastRiskControlUrl,
        lastRiskControlCode,
        lastError,
        failures: [...failures],
    });
    const reset = () => {
        generation++;
        pendingResponseReads.clear();
        endedAt = undefined;
        finalStatus = undefined;
        timedOut = false;
        offers = [];
        seenCount = 0;
        matchedCount = 0;
        parsedCount = 0;
        fallbackCount = 0;
        riskControlCount = 0;
        lastSeenUrl = undefined;
        lastMatchedUrl = undefined;
        lastParsedUrl = undefined;
        lastFallbackUrl = undefined;
        lastRiskControlUrl = undefined;
        lastRiskControlCode = undefined;
        lastError = undefined;
        failures.length = 0;
        notify();
    };
    const onResponse = async (resp) => {
        if (disposed)
            return;
        const responseGeneration = generation;
        const url = resp.url();
        const diagnosticUrl = sanitizeSearchCaptureUrl(url);
        seenCount++;
        lastSeenUrl = diagnosticUrl;
        try {
            const request = typeof resp.request === 'function' ? resp.request() : undefined;
            const meta = readSearchMtopRequestMeta(url, request?.postData());
            if (meta) {
                if (meta.appId !== SEARCH_APP_ID)
                    return;
                if (opts.requireMethod && meta.method !== opts.requireMethod)
                    return;
                if (opts.requireSortType && meta.sortType !== opts.requireSortType)
                    return;
                if (opts.requireImageId !== undefined) {
                    const requiredImageId = typeof opts.requireImageId === 'function'
                        ? opts.requireImageId()
                        : opts.requireImageId;
                    if (!requiredImageId || meta.imageId !== requiredImageId)
                        return;
                }
                const targetPage = opts.targetPage?.();
                if (targetPage !== undefined && (meta.beginPage ?? 1) !== targetPage)
                    return;
                if (opts.acceptMeta && !opts.acceptMeta(meta))
                    return;
            }
            else if (!opts.allowUnscopedWirelessRecommend ||
                !/mtop\.relationrecommend\.wirelessrecommend\.recommend/i.test(url)) {
                return;
            }
            matchedCount++;
            lastMatchedUrl = diagnosticUrl;
            const pendingToken = Symbol('search-response');
            pendingResponseReads.add(pendingToken);
            try {
                const text = await resp.text();
                if (disposed || generation !== responseGeneration)
                    return;
                const riskControl = readSearchMtopRiskControl(text);
                if (riskControl) {
                    riskControlCount++;
                    lastRiskControlUrl = diagnosticUrl;
                    lastRiskControlCode = riskControl.code;
                    return;
                }
                if (isSearchServiceFallbackMtopText(text)) {
                    fallbackCount++;
                    lastFallbackUrl = diagnosticUrl;
                    return;
                }
                const parsed = parseOfferItemsFromMtopText(text);
                if (parsed.length === 0)
                    return;
                if (opts.keep === 'largest') {
                    if (parsed.length > offers.length)
                        offers = parsed;
                }
                else {
                    offers = parsed;
                }
                parsedCount++;
                lastParsedUrl = diagnosticUrl;
            }
            finally {
                pendingResponseReads.delete(pendingToken);
                if (!disposed && generation === responseGeneration)
                    notify();
            }
        }
        catch (error) {
            if (!disposed && generation === responseGeneration) {
                recordFailure(diagnosticUrl, error);
            }
        }
    };
    const onClose = () => {
        pageClosed = true;
        finalStatus ??= 'browser_closed';
        endedAt ??= new Date().toISOString();
        notify();
    };
    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
        generation++;
        pendingResponseReads.clear();
        endedAt ??= new Date().toISOString();
        opts.page.off('response', onResponse);
        opts.page.off('close', onClose);
        notify();
    };
    const wait = async (optsWait) => {
        const deadline = Date.now() + optsWait.timeoutMs;
        const intervalMs = optsWait.intervalMs ?? 300;
        let observedVersion = signalVersion;
        let result;
        while (true) {
            const remainingMs = Math.max(0, deadline - Date.now());
            if (pageClosed || optsWait.isClosed?.()) {
                result = 'browser_closed';
                break;
            }
            if (riskControlCount > 0 && pendingResponseReads.size === 0) {
                result = 'blocked';
                break;
            }
            if (remainingMs <= 0) {
                result = offers.length > 0 ? 'captured' : 'timeout';
                break;
            }
            if (offers.length > 0 &&
                (opts.keep !== 'largest' || pendingResponseReads.size === 0)) {
                result = 'captured';
                break;
            }
            if (fallbackCount > 0 && pendingResponseReads.size === 0) {
                result = 'fallback';
                break;
            }
            if (await optsWait.isBlocked?.()) {
                result = 'blocked';
                break;
            }
            if (disposed) {
                result = 'stream_closed';
                break;
            }
            await waitForSignal(observedVersion, Math.min(intervalMs, Math.max(0, deadline - Date.now())));
            observedVersion = signalVersion;
        }
        finalStatus = result;
        timedOut = result === 'timeout';
        endedAt ??= new Date().toISOString();
        return { status: result, offers, diagnostics: diagnostics() };
    };
    const waitForAction = async (action, optsWait) => {
        try {
            const actionResult = await action();
            const result = await wait(optsWait);
            return {
                actionResult,
                status: result.status,
                offers: result.offers,
                diagnostics: result.diagnostics,
            };
        }
        finally {
            dispose();
        }
    };
    opts.page.on('response', onResponse);
    opts.page.on('close', onClose);
    return {
        reset,
        wait,
        waitForAction,
        dispose,
        diagnostics,
        offers: () => offers,
    };
}
export function sanitizeSearchCaptureUrl(url) {
    if (!isChallengeUrl(url))
        return url;
    try {
        const parsed = new URL(url);
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    }
    catch {
        return url.split(/[?#]/, 1)[0] ?? '';
    }
}
function isChallengeUrl(url) {
    return /(?:\/punish(?:\/|\?|$)|punish\.1688\.com|x5secdata(?:=|%3D)|captcha|nocaptcha)/i.test(url);
}
//# sourceMappingURL=search-capture.js.map