import fs from 'node:fs/promises';
import path from 'node:path';
import { CliError } from '../io/errors.js';
import { detectPageState, recoverHintForPageState, } from './page-state.js';
import { runsDir } from './paths.js';
const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/gi;
export function redactChallengeUrl(value) {
    if (!/punish|x5secdata|captcha/i.test(value))
        return value;
    try {
        const parsed = new URL(value);
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    }
    catch {
        return value.replace(/[?#].*$/, '');
    }
}
function redactChallengeUrlsInText(value) {
    return value.replace(URL_IN_TEXT, (url) => redactChallengeUrl(url));
}
function redactArtifactValue(value) {
    if (typeof value === 'string')
        return redactChallengeUrlsInText(value);
    if (Array.isArray(value))
        return value.map(redactArtifactValue);
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactArtifactValue(entry)]));
}
function errorShape(e) {
    if (e instanceof CliError) {
        return {
            code: e.code,
            message: redactChallengeUrlsInText(e.message),
            stack: e.stack ? redactChallengeUrlsInText(e.stack) : undefined,
            details: redactArtifactValue(e.details),
        };
    }
    if (e instanceof Error) {
        return {
            message: redactChallengeUrlsInText(e.message),
            stack: e.stack ? redactChallengeUrlsInText(e.stack) : undefined,
        };
    }
    return { message: redactChallengeUrlsInText(String(e)) };
}
function safeName(input) {
    return input.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'command';
}
function pickPage(ctx) {
    const pages = ctx.pages().filter((p) => !p.isClosed());
    return pages.at(-1) ?? null;
}
function requestId(meta) {
    return (meta.requestId ??
        `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeName(meta.cmd)}`);
}
function categoryForPageState(kind) {
    switch (kind) {
        case 'not_logged_in':
            return 'auth';
        case 'risk_challenge':
            return 'risk';
        case 'rate_limited':
            return 'rate_limit';
        case 'unknown':
            return 'unknown_page_state';
        default:
            return undefined;
    }
}
function stringField(obj, key) {
    const v = obj?.[key];
    return typeof v === 'string' ? v : undefined;
}
function boolField(obj, key) {
    const v = obj?.[key];
    return typeof v === 'boolean' ? v : undefined;
}
function traceSummary(trace) {
    if (!trace)
        return undefined;
    return {
        console: trace.console.length,
        pageErrors: trace.pageErrors.length,
        recentRequests: trace.network.recent.length,
        failedRequests: trace.network.failed.length,
        httpErrors: trace.network.httpErrors.length,
    };
}
async function writeJson(file, value) {
    await fs.writeFile(file, JSON.stringify(value, null, 2));
}
function errorText(shape) {
    const lines = [];
    if (shape.code)
        lines.push(`code: ${shape.code}`);
    lines.push(`message: ${shape.message}`);
    if (shape.stack)
        lines.push(`stack:\n${shape.stack}`);
    return lines.join('\n\n');
}
export async function captureFailureArtifact(ctx, meta, error, options = {}) {
    const id = requestId(meta);
    const dir = path.join(runsDir(), id);
    await fs.mkdir(dir, { recursive: true });
    const page = pickPage(ctx);
    const pageState = options.pageState !== undefined
        ? options.pageState
        : page
            ? await detectPageState(page).catch(() => null)
            : null;
    const safePageState = pageState
        ? { ...pageState, url: redactChallengeUrl(pageState.url) }
        : null;
    const recovery = options.recovery;
    const details = {
        artifactDir: dir,
    };
    if (safePageState) {
        details.currentUrl = safePageState.url;
        details.pageState = safePageState.kind;
        details.category = categoryForPageState(safePageState.kind);
        details.recoverHint = recoverHintForPageState(safePageState.kind);
        details.retryable =
            safePageState.kind === 'rate_limited' || safePageState.kind === 'unknown';
        await writeJson(path.join(dir, 'page-state.json'), safePageState).catch(() => { });
    }
    if (recovery) {
        const failureKind = stringField(recovery, 'failureKind');
        const action = stringField(recovery, 'action');
        const retryable = boolField(recovery, 'retryable');
        if (failureKind)
            details.failureKind = failureKind;
        if (action)
            details.recoveryAction = action;
        if (retryable !== undefined)
            details.retryable = retryable;
        await writeJson(path.join(dir, 'recovery.json'), recovery).catch(() => { });
    }
    if (options.trace) {
        if (options.trace.console.length > 0 || options.trace.pageErrors.length > 0) {
            await writeJson(path.join(dir, 'console.json'), {
                console: options.trace.console,
                pageErrors: options.trace.pageErrors,
            }).catch(() => { });
        }
        if (options.trace.network.recent.length > 0 ||
            options.trace.network.failed.length > 0 ||
            options.trace.network.httpErrors.length > 0) {
            await writeJson(path.join(dir, 'network.json'), redactArtifactValue(options.trace.network)).catch(() => { });
        }
    }
    if (page && !page.isClosed()) {
        await page
            .screenshot({ path: path.join(dir, 'screenshot.png'), fullPage: true })
            .catch(() => { });
        const html = safePageState?.kind === 'risk_challenge'
            ? ''
            : await page.content().catch(() => '');
        if (html)
            await fs.writeFile(path.join(dir, 'page.html'), html);
    }
    const shaped = errorShape(error);
    const responseCapture = shaped.details?.responseCapture;
    if (responseCapture) {
        await writeJson(path.join(dir, 'response-capture.json'), redactArtifactValue(responseCapture)).catch(() => { });
    }
    await fs.writeFile(path.join(dir, 'error.txt'), errorText(shaped)).catch(() => { });
    await writeJson(path.join(dir, 'meta.json'), {
        requestId: id,
        at: new Date().toISOString(),
        command: meta.cmd,
        args: redactArtifactValue(meta.args),
        error: shaped,
        pageState: safePageState,
        recovery: redactArtifactValue(recovery),
        traceSummary: traceSummary(options.trace),
    });
    return details;
}
export async function enrichErrorWithArtifact(ctx, meta, error) {
    if (error instanceof CliError && error.details.artifactDir) {
        return error;
    }
    const details = await captureFailureArtifact(ctx, meta, error).catch(() => ({}));
    if (error instanceof CliError) {
        return error.withDetails(details);
    }
    const message = error instanceof Error ? error.message : String(error);
    return new CliError(1, 'INTERNAL', message, details);
}
//# sourceMappingURL=artifacts.js.map