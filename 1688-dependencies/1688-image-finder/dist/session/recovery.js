import { CliError } from '../io/errors.js';
import { info } from '../io/output.js';
import { captureFailureArtifact, redactChallengeUrl, } from './artifacts.js';
import { detectPageState } from './page-state.js';
import { sleep } from './wait.js';
const MAX_TRACE_ITEMS = 80;
const STRONG_RISK_CONTROL_URL_RE = /(?:_____tmd_____|sufei-punish|\/sd\/punish\/|punishpage|punish\.1688\.com)/i;
function traceHasRiskControlRequest(trace) {
    return [
        ...trace.network.recent,
        ...trace.network.failed,
        ...trace.network.httpErrors,
    ].some((entry) => (typeof entry.url === 'string' && STRONG_RISK_CONTROL_URL_RE.test(entry.url)));
}
function pickPage(ctx) {
    const pages = ctx.pages().filter((p) => !p.isClosed());
    return pages.at(-1) ?? null;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function errorCode(error) {
    if (error instanceof CliError)
        return error.code;
    const maybe = error;
    return typeof maybe?.code === 'string' ? maybe.code : undefined;
}
function pushBounded(arr, item) {
    arr.push(item);
    if (arr.length > MAX_TRACE_ITEMS)
        arr.shift();
}
function requestResourceType(req) {
    try {
        return req.resourceType();
    }
    catch {
        return 'unknown';
    }
}
function requestMethod(req) {
    try {
        return req.method();
    }
    catch {
        return 'GET';
    }
}
function requestUrl(req) {
    try {
        return redactChallengeUrl(req.url());
    }
    catch {
        return '';
    }
}
function consoleLocation(msg) {
    try {
        return msg.location();
    }
    catch {
        return undefined;
    }
}
function attachTrace(ctx) {
    const trace = {
        console: [],
        pageErrors: [],
        recent: [],
        failed: [],
        httpErrors: [],
        detach: () => { },
    };
    const pages = new Set();
    const detachPage = new Map();
    const attachPage = (page) => {
        if (pages.has(page))
            return;
        pages.add(page);
        const onConsole = (msg) => {
            if (!['error', 'warning'].includes(msg.type()))
                return;
            pushBounded(trace.console, {
                at: new Date().toISOString(),
                type: msg.type(),
                text: msg.text(),
                location: consoleLocation(msg),
            });
        };
        const onPageError = (err) => {
            pushBounded(trace.pageErrors, {
                at: new Date().toISOString(),
                message: err.message,
                stack: err.stack,
            });
        };
        const onRequest = (req) => {
            pushBounded(trace.recent, {
                at: new Date().toISOString(),
                method: requestMethod(req),
                url: requestUrl(req),
                resourceType: requestResourceType(req),
            });
        };
        const onRequestFailed = (req) => {
            pushBounded(trace.failed, {
                at: new Date().toISOString(),
                method: requestMethod(req),
                url: requestUrl(req),
                resourceType: requestResourceType(req),
                failure: req.failure()?.errorText,
            });
        };
        const onResponse = (resp) => {
            const status = resp.status();
            if (status < 400)
                return;
            const req = resp.request();
            pushBounded(trace.httpErrors, {
                at: new Date().toISOString(),
                status,
                method: requestMethod(req),
                url: redactChallengeUrl(resp.url()),
                resourceType: requestResourceType(req),
            });
        };
        page.on('console', onConsole);
        page.on('pageerror', onPageError);
        page.on('request', onRequest);
        page.on('requestfailed', onRequestFailed);
        page.on('response', onResponse);
        detachPage.set(page, () => {
            page.off('console', onConsole);
            page.off('pageerror', onPageError);
            page.off('request', onRequest);
            page.off('requestfailed', onRequestFailed);
            page.off('response', onResponse);
        });
    };
    for (const page of ctx.pages())
        attachPage(page);
    ctx.on('page', attachPage);
    trace.detach = () => {
        ctx.off('page', attachPage);
        for (const detach of detachPage.values())
            detach();
        detachPage.clear();
    };
    return trace;
}
function snapshotTrace(trace) {
    return {
        console: [...trace.console],
        pageErrors: [...trace.pageErrors],
        network: {
            recent: [...trace.recent],
            failed: [...trace.failed],
            httpErrors: [...trace.httpErrors],
        },
    };
}
export function classifyRecoveryFailure(signals) {
    const { message, code, pageState, trace } = signals;
    const msg = `${code ?? ''}\n${message}`;
    if (pageState?.kind === 'not_logged_in' || code === 'NOT_LOGGED_IN') {
        return 'not_logged_in';
    }
    if (pageState?.kind === 'risk_challenge' || code === 'RISK_CONTROL') {
        return 'risk_challenge';
    }
    // Some 1688 shop pages keep their public URL and render an empty body while
    // loading the Aliyun challenge as subresources. In that case the network
    // trace is the only reliable signal that this is not a supplier mismatch.
    if (traceHasRiskControlRequest(trace))
        return 'risk_challenge';
    if (pageState?.kind === 'rate_limited')
        return 'rate_limited';
    if (/Target page, context or browser has been closed|Browser closed|Target closed|Context closed|page crash/i.test(msg)) {
        return 'browser_context_broken';
    }
    if (/ECONNRESET|ENOTFOUND|ERR_(?:TIMED_OUT|CONNECTION|INTERNET|NETWORK|NAME)|net::|NETWORK_ERROR/i.test(msg)) {
        return 'network_error';
    }
    if (/429|403|访问频繁|请求频繁|操作频繁|稍后再试|系统繁忙/i.test(msg)) {
        return 'rate_limited';
    }
    if (/Timeout .*navigation|Navigation timeout|waiting for .*navigation|waitForLoadState/i.test(msg)) {
        return 'navigation_timeout';
    }
    if (/not visible|not enabled|does not receive pointer events|intercepts pointer events|element is outside|Element is not attached/i.test(msg)) {
        return 'element_blocked';
    }
    if (/locator|selector|waiting for .*visible|No .* found|not found|Could not (?:find|locate).*element|element.*missing/i.test(msg)) {
        return 'element_missing';
    }
    if (trace.network.httpErrors.some((r) => r.status === 429))
        return 'rate_limited';
    if (trace.network.failed.length >= 3 || trace.network.httpErrors.length >= 5) {
        return 'network_error';
    }
    if (pageState?.kind === 'normal_1688_page' && /NO_RESULTS|UPLOAD_FAILED|parse|structure|expected/i.test(msg)) {
        return 'site_changed';
    }
    return 'unknown';
}
export function recoveryDecisionFor(kind, headed) {
    switch (kind) {
        case 'not_logged_in':
            return {
                failureKind: kind,
                action: 'pause_for_manual_login',
                retryable: false,
                maxRetries: 0,
                cooldownMs: 0,
                exitCode: 3,
                code: 'NOT_LOGGED_IN',
                message: 'Session expired. Run `1688 login`.',
                recoverHint: 'Session expired. Run `1688 login` and retry.',
            };
        case 'risk_challenge':
            return {
                failureKind: kind,
                action: 'pause_for_manual_challenge',
                retryable: false,
                maxRetries: 0,
                cooldownMs: headed ? 0 : 5 * 60_000,
                exitCode: 4,
                code: 'RISK_CONTROL',
                message: headed
                    ? 'Slider verification not solved in time. Try again with `--headed`.'
                    : 'Aliyun risk control triggered. Run once with `--headed` to solve it manually.',
                recoverHint: '1688 is showing a verification challenge. Retry once with `--headed` and complete the manual check.',
            };
        case 'rate_limited':
            return {
                failureKind: kind,
                action: 'backoff',
                retryable: true,
                maxRetries: 1,
                cooldownMs: 60_000 + Math.floor(Math.random() * 30_000),
                exitCode: 9,
                code: 'RATE_LIMITED',
                message: '1688 is rate-limiting this session. Wait a few minutes, then retry at a slower pace.',
                recoverHint: '1688 is rate-limiting this session. Wait a few minutes, then retry at a slower pace.',
            };
        case 'element_missing':
            return {
                failureKind: kind,
                action: 'retry_after_resnapshot',
                retryable: true,
                maxRetries: 1,
                cooldownMs: 1000,
                exitCode: 1,
                code: 'ELEMENT_MISSING',
                message: 'Expected page element was not found.',
            };
        case 'element_blocked':
            return {
                failureKind: kind,
                action: 'dismiss_overlay_and_retry',
                retryable: true,
                maxRetries: 1,
                cooldownMs: 1000,
                exitCode: 1,
                code: 'ELEMENT_BLOCKED',
                message: 'Expected page element was present but not clickable.',
            };
        case 'navigation_timeout':
            return {
                failureKind: kind,
                action: 'wait_for_business_signal',
                retryable: true,
                maxRetries: 1,
                cooldownMs: 1500,
                exitCode: 9,
                code: 'NAVIGATION_TIMEOUT',
                message: 'Page navigation timed out before the expected business signal appeared.',
            };
        case 'page_unstable':
            return {
                failureKind: kind,
                action: 'stabilize_and_retry',
                retryable: true,
                maxRetries: 1,
                cooldownMs: 1500,
                exitCode: 1,
                code: 'PAGE_UNSTABLE',
                message: 'The page did not become stable enough to operate safely.',
            };
        case 'browser_context_broken':
            return {
                failureKind: kind,
                action: 'recreate_context',
                retryable: true,
                maxRetries: 1,
                cooldownMs: 0,
                exitCode: 130,
                code: 'BROWSER_CONTEXT_BROKEN',
                message: 'Browser context closed or crashed during the operation.',
            };
        case 'network_error':
            return {
                failureKind: kind,
                action: 'retry_after_network_backoff',
                retryable: true,
                maxRetries: 1,
                cooldownMs: 3000,
                exitCode: 9,
                code: 'NETWORK_ERROR',
                message: 'Network error while operating 1688.',
            };
        case 'site_changed':
            return {
                failureKind: kind,
                action: 'fail_with_artifacts',
                retryable: false,
                maxRetries: 0,
                cooldownMs: 0,
                exitCode: 1,
                code: 'SITE_CHANGED',
                message: '1688 page structure may have changed. Inspect the saved artifacts and update the command.',
            };
        case 'unknown':
            return {
                failureKind: kind,
                action: 'retry_once_then_fail',
                retryable: true,
                maxRetries: 1,
                cooldownMs: 1000,
                exitCode: 1,
                code: 'UNKNOWN_RECOVERY_FAILURE',
                message: '1688 operation failed for an unknown reason.',
            };
    }
}
async function runRecoveryAction(decision, page) {
    switch (decision.action) {
        case 'dismiss_overlay_and_retry':
            if (page && !page.isClosed()) {
                await page.keyboard.press('Escape').catch(() => { });
                await sleep(decision.cooldownMs);
            }
            return;
        case 'backoff':
            info(`1688 rate limit detected; backing off for ${Math.round(decision.cooldownMs / 1000)}s before one retry...`);
            await sleep(decision.cooldownMs);
            return;
        case 'retry_after_network_backoff':
        case 'retry_after_resnapshot':
        case 'wait_for_business_signal':
        case 'stabilize_and_retry':
        case 'retry_once_then_fail':
            await sleep(decision.cooldownMs);
            return;
        default:
            return;
    }
}
function recoveryDetails(decision, artifactDetails, baseDetails = {}) {
    const baseFailureKind = typeof baseDetails.failureKind === 'string'
        ? baseDetails.failureKind
        : undefined;
    const baseRecoveryAction = typeof baseDetails.recoveryAction === 'string'
        ? baseDetails.recoveryAction
        : undefined;
    return {
        ...artifactDetails,
        category: baseDetails.category ?? artifactDetails.category ?? decision.failureKind,
        failureKind: baseFailureKind ?? decision.failureKind,
        recoveryAction: baseRecoveryAction ?? decision.action,
        recoverHint: baseDetails.recoverHint ?? artifactDetails.recoverHint ?? decision.recoverHint,
        retryable: baseDetails.retryable ?? false,
    };
}
export function shouldPreserveCliError(error, decision) {
    if (['not_logged_in', 'risk_challenge', 'rate_limited'].includes(decision.failureKind)
        && error.code !== decision.code) {
        return false;
    }
    return error.exitCode !== 1 || error.code === 'SIMILAR_UNAVAILABLE';
}
export async function withRecovery(ctx, meta, operation, options = {}) {
    let lastError = null;
    const configuredRetries = options.maxRetries ?? 1;
    for (let attempt = 0; attempt <= configuredRetries; attempt++) {
        const trace = attachTrace(ctx);
        try {
            return await operation(attempt);
        }
        catch (error) {
            lastError = error;
            trace.detach();
            const currentPage = pickPage(ctx);
            const pageState = currentPage
                ? await detectPageState(currentPage).catch(() => null)
                : null;
            const signals = {
                message: errorMessage(error),
                code: errorCode(error),
                pageState,
                trace: snapshotTrace(trace),
            };
            const failureKind = classifyRecoveryFailure(signals);
            const decision = recoveryDecisionFor(failureKind, options.headed === true);
            const allowedRetries = Math.min(configuredRetries, decision.maxRetries);
            const willRetry = decision.retryable && attempt < allowedRetries;
            const artifactDetails = await captureFailureArtifact(ctx, meta, error, {
                pageState,
                trace: signals.trace,
                recovery: {
                    attempt,
                    willRetry,
                    failureKind: decision.failureKind,
                    action: decision.action,
                    retryable: decision.retryable,
                    maxRetries: allowedRetries,
                    cooldownMs: decision.cooldownMs,
                },
            }).catch(() => ({}));
            if (!willRetry) {
                if (error instanceof CliError && shouldPreserveCliError(error, decision)) {
                    throw error.withDetails(recoveryDetails(decision, artifactDetails, error.details));
                }
                throw new CliError(decision.exitCode, decision.code, decision.message, recoveryDetails(decision, artifactDetails));
            }
            await runRecoveryAction(decision, currentPage);
            await options.beforeRetry?.({
                ctx,
                page: currentPage,
                attempt,
                meta,
                pageState,
                failureKind,
                decision,
            });
        }
        finally {
            trace.detach();
        }
    }
    const message = errorMessage(lastError);
    throw new CliError(1, 'RECOVERY_EXHAUSTED', message);
}
//# sourceMappingURL=recovery.js.map