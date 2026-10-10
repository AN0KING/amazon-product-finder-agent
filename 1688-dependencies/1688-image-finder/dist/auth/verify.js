import { detectPageState } from '../session/page-state.js';
import { parseIdentity } from './cookies.js';
export const ONLINE_VERIFICATION_URL = 'https://work.1688.com/';
const WORKSPACE_HOST = 'work.1688.com';
const LOGIN_HOST_RE = /^(?:login\.(?:1688|taobao)\.com|passport\.1688\.com)$/i;
const WRONG_PAGE_HOST_RE = /^wrongpage\.1688\.com$/i;
const RISK_URL_RE = /(?:punish\.1688\.com|x5secdata=|nocaptcha|captcha)/i;
export async function verifyOnline(ctx) {
    return (await verifyOnlineStatus(ctx)).ok;
}
export async function verifyOnlineStatus(ctx) {
    const page = await ctx.newPage();
    try {
        const resp = await page.goto(ONLINE_VERIFICATION_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 15000,
        });
        const finalUrl = page.url();
        const state = await detectPageState(page);
        if (RISK_URL_RE.test(finalUrl) || state.kind === 'risk_challenge') {
            return failed('risk_control');
        }
        if (resp?.status() === 429 || state.kind === 'rate_limited') {
            return failed('rate_limited');
        }
        if (isLoginUrl(finalUrl) || state.kind === 'not_logged_in') {
            return failed('login_required');
        }
        if (!resp || resp.status() < 200 || resp.status() >= 300) {
            return failed('verification_failed');
        }
        if (!parseIdentity(await ctx.cookies())) {
            return failed('login_required');
        }
        if (isProtectedWorkspaceUrl(finalUrl) &&
            state.kind === 'normal_1688_page') {
            return { ok: true, reason: 'ready' };
        }
        return failed('verification_failed');
    }
    catch {
        return failed('verification_failed');
    }
    finally {
        await page.close().catch(() => { });
    }
}
function failed(reason) {
    return { ok: false, reason };
}
function isLoginUrl(value) {
    try {
        return LOGIN_HOST_RE.test(new URL(value).hostname);
    }
    catch {
        return false;
    }
}
function isProtectedWorkspaceUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return false;
    }
    const host = url.hostname.toLowerCase();
    if (LOGIN_HOST_RE.test(host))
        return false;
    if (WRONG_PAGE_HOST_RE.test(host))
        return false;
    if (RISK_URL_RE.test(value))
        return false;
    return url.protocol === 'https:' && host === WORKSPACE_HOST;
}
//# sourceMappingURL=verify.js.map