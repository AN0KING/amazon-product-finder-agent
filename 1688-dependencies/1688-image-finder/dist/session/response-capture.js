import { withTimeout } from './wait.js';
export function startResponseCapture(opts) {
    const maxDiagnosticsEntries = opts.maxDiagnosticsEntries ?? 5;
    const startedAt = new Date().toISOString();
    let endedAt;
    let disposed = false;
    let settled = false;
    let timedOut = false;
    let seenCount = 0;
    let matchedCount = 0;
    let parsedCount = 0;
    let emptyResultCount = 0;
    let lastSeenUrl;
    let lastMatchedUrl;
    let lastParsedUrl;
    const failures = [];
    const emptyResults = [];
    let waitPromise = null;
    let resolveCaptured;
    const captured = new Promise((resolve) => {
        resolveCaptured = resolve;
    });
    const remember = (entries, entry) => {
        entries.push(entry);
        if (entries.length > maxDiagnosticsEntries)
            entries.shift();
    };
    const errorInfo = (error) => {
        if (error instanceof Error) {
            return { name: error.name, message: error.message };
        }
        return { message: String(error) };
    };
    const recordFailure = (phase, url, error) => {
        const info = errorInfo(error);
        remember(failures, {
            at: new Date().toISOString(),
            phase,
            url,
            ...info,
        });
    };
    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
        endedAt ??= new Date().toISOString();
        opts.page.off('response', onResponse);
    };
    const matches = (response) => {
        if (opts.matcher instanceof RegExp)
            return opts.matcher.test(response.url());
        return opts.matcher(response);
    };
    const onResponse = async (response) => {
        if (disposed || settled)
            return;
        const url = response.url();
        seenCount++;
        lastSeenUrl = url;
        let matched = false;
        try {
            matched = matches(response);
        }
        catch (e) {
            recordFailure('match', url, e);
            return;
        }
        if (!matched)
            return;
        matchedCount++;
        lastMatchedUrl = url;
        try {
            const value = await opts.parse(response);
            if (!value) {
                emptyResultCount++;
                remember(emptyResults, { at: new Date().toISOString(), url });
                return;
            }
            if (settled || disposed)
                return;
            parsedCount++;
            lastParsedUrl = url;
            settled = true;
            endedAt = new Date().toISOString();
            resolveCaptured(value);
        }
        catch (e) {
            recordFailure('parse', url, e);
        }
    };
    const diagnostics = () => ({
        timeoutMs: opts.timeoutMs,
        startedAt,
        endedAt,
        disposed,
        settled,
        timedOut,
        seenCount,
        matchedCount,
        parsedCount,
        emptyResultCount,
        failureCount: failures.length,
        lastSeenUrl,
        lastMatchedUrl,
        lastParsedUrl,
        failures: [...failures],
        emptyResults: [...emptyResults],
    });
    opts.page.on('response', onResponse);
    return {
        wait() {
            waitPromise ??= withTimeout(captured, {
                timeoutMs: opts.timeoutMs,
                fallback: null,
            })
                .then((value) => {
                if (value === null && !settled) {
                    timedOut = true;
                    endedAt = new Date().toISOString();
                }
                return value;
            })
                .finally(dispose);
            return waitPromise;
        },
        async waitForAction(action) {
            try {
                const actionResult = await action();
                const response = await this.wait();
                return {
                    actionResult,
                    response,
                    diagnostics: diagnostics(),
                };
            }
            finally {
                dispose();
            }
        },
        dispose,
        diagnostics,
    };
}
//# sourceMappingURL=response-capture.js.map