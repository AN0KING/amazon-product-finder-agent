import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { launchEdgeContext, withSession } from '../session/context.js';
import { parseIdentity } from '../auth/cookies.js';
import { verifyOnline } from '../auth/verify.js';
import { readState, writeState } from '../session/state.js';
import { emit, info, isJson } from '../io/output.js';
import { confirm } from '../io/prompt.js';
import { CliError } from '../io/errors.js';
import { nowIso } from '../util/time.js';
import { defaultProfileName, loginQrFile, ensureRoot } from '../session/paths.js';
import { brokerSignalPath } from '../session/broker-paths.js';
import { sleep, withTimeout } from '../session/wait.js';
import { probeDefaultEdgeIdentityCookie } from '../session/cookie-store.js';
import { ensureNativeVisibleEdgeWindow, withManualVisibleEdge, withNativeVisibleEdge, } from '../session/native-edge.js';
import { detectPageState } from '../session/page-state.js';
import { captureFailureArtifact } from '../session/artifacts.js';
import { startManagedImageSearchEvidence } from '../session/image-search-verification-evidence.js';
import { matchesImageOfferRequest, readImageResultId, readVerifiedImageUpload, resolveImageSearchUploadInput, submitImageSearchOnce, } from './image-search.js';
const LOGIN_URL = 'https://login.1688.com/member/signin.htm?tbpm=1';
export const LOGIN_WARMUP_URL = 'https://www.1688.com/';
export const IMAGE_SEARCH_VERIFICATION_URL = 'https://s.1688.com/youyuan/index.htm';
const COOKIE_FRESHNESS_SECONDS = 5 * 60;
const COOKIE_PERSISTENCE_SECONDS = 8 * 60 * 60;
const LOGIN_ONLINE_PROBE_INTERVAL_MS = 5_000;
const IMAGE_SEARCH_VERIFICATION_POLL_MS = 500;
const IMAGE_SEARCH_VERIFICATION_NORMAL_SAMPLES = 6;
const IMAGE_SEARCH_UPLOAD_READY_TIMEOUT_MS = 15_000;
const IMAGE_SEARCH_RESULT_TIMEOUT_MS = 60_000;
const IMAGE_SEARCH_VERIFICATION_STAGES = new Set([
    'waiting_upload_page', 'upload_control_ready', 'image_selected_waiting_result',
    'waiting_manual_verification', 'verified_result',
]);
export async function run(opts) {
    const purpose = resolveLoginPurpose(opts.purpose);
    const profile = defaultProfileName(opts.profile);
    if (purpose !== 'login' && profile !== 'default') {
        throw new CliError(2, 'LOGIN_PURPOSE_PROFILE_INVALID', '1688 verification must use the default dedicated 1688 profile.');
    }
    const timeoutMs = Math.max(30, parseInt(opts.timeout ?? '300', 10)) * 1000;
    const openBrowser = opts.openBrowser === true || purpose !== 'login';
    const headed = opts.headed === true || openBrowser;
    const brokerMode = Boolean(process.env.BB1688_LOGIN_ATTEMPT
        && process.env.BB1688_LOGIN_TOKEN);
    const brokerControl = brokerMode ? requireBrokerLoginControl() : null;
    const freshLogin = brokerMode && purpose === 'login' && process.env.BB1688_FRESH_LOGIN === '1';
    const managedImageSearchUpload = purpose === 'image_search' && brokerMode
        ? await readBrokerManagedImageSearchUpload()
        : null;
    const supplierStrengthVerification = purpose === 'supplier_strength'
        ? readBrokerSupplierStrengthVerification()
        : null;
    // A state file is not proof of a live session. Verify the persisted profile
    // online before deciding that login is done.
    const existing = openBrowser || brokerMode ? null : await peekVerifiedIdentity(profile);
    if (existing) {
        const verifiedAt = nowIso();
        const previous = await readState(profile).catch(() => ({ version: 1 }));
        await writeState({
            ...previous,
            version: 1,
            memberId: existing.memberId,
            nick: existing.nick ?? undefined,
            loggedInAt: previous.loggedInAt ?? verifiedAt,
            lastVerifiedAt: verifiedAt,
        }, profile);
        const name = existing.nick ?? existing.memberId;
        emit({
            human: () => info(`Already logged in as ${name} (memberId: ${existing.memberId}).`),
            data: {
                ok: true,
                alreadyLoggedIn: true,
                memberId: existing.memberId,
                nick: existing.nick,
            },
        });
        return;
    }
    let reopenedIdentity;
    if (openBrowser
        && (purpose === 'supplier_strength'
            || (purpose === 'image_search' && !managedImageSearchUpload))) {
        const expectedIdentity = await requireBoundPersistentIdentity(profile);
        reopenedIdentity = await withManualVisibleEdge({
            profile,
            launchUrl: purpose === 'supplier_strength'
                ? supplierStrengthOfferUrl(supplierStrengthVerification.offerId)
                : IMAGE_SEARCH_VERIFICATION_URL,
        }, async (session) => {
            if (brokerControl)
                await throwIfBrokerLoginCanceled(brokerControl);
            await writeBrokerEdgeReadySignal();
            info(purpose === 'supplier_strength'
                ? 'Opening the affected 1688 product page in a normal Microsoft Edge window...'
                : 'Opening the 1688 image-search verification page in a normal Microsoft Edge window...');
            info('Complete the CAPTCHA manually. If verification fails, click the orange retry box to regenerate it.');
            info('After verification succeeds, close only this dedicated Edge window.');
            const waitForClose = () => session.waitForClose(timeoutMs);
            if (brokerControl) {
                await runWithBrokerLoginCancellation(brokerControl, waitForClose);
            }
            else {
                await waitForClose();
            }
            printInteractive('Verification window closed. Checking the saved session...');
        }, () => verifyPersistedProfileIdentityWhileLocked(profile, expectedIdentity));
    }
    else if (openBrowser) {
        reopenedIdentity = await withNativeVisibleEdge({
            profile,
            launchUrl: purpose === 'image_search'
                ? IMAGE_SEARCH_VERIFICATION_URL
                : LOGIN_URL,
        }, async (ctx) => {
            if (brokerControl)
                await throwIfBrokerLoginCanceled(brokerControl);
            await writeBrokerEdgeReadySignal();
            const complete = () => completeLoginInContext(ctx, {
                timeoutMs,
                headed: true,
                openBrowser: true,
                brokerMode,
                reuseExistingPage: true,
                freshLogin,
                purpose,
                managedImageSearchUpload,
                supplierStrengthVerification,
            });
            return brokerControl
                ? runWithBrokerLoginCancellation(brokerControl, complete)
                : complete();
        }, (identity) => purpose === 'image_search' && managedImageSearchUpload
            ? verifyPersistedProfileIdentityWhileLocked(profile, identity)
            : verifyPersistedProfileWhileLocked(profile, identity));
    }
    else {
        const identity = await withSession({ headless: !headed, profile }, async (ctx) => {
            if (brokerControl)
                await throwIfBrokerLoginCanceled(brokerControl);
            if (brokerControl)
                await writeBrokerEdgeReadySignal();
            const complete = () => completeLoginInContext(ctx, {
                timeoutMs,
                headed,
                openBrowser: false,
                brokerMode,
                reuseExistingPage: false,
                freshLogin,
                purpose,
                managedImageSearchUpload,
                supplierStrengthVerification,
            });
            return brokerControl
                ? runWithBrokerLoginCancellation(brokerControl, complete)
                : complete();
        });
        // Prove that the cookie database, not merely the first in-memory context,
        // owns the verified session before publishing a ready state.
        reopenedIdentity = await withSession({ headless: true, profile }, (ctx) => verifyPersistedContext(ctx, identity));
    }
    await writeState({
        version: 1,
        memberId: reopenedIdentity.memberId,
        nick: reopenedIdentity.nick ?? undefined,
        loggedInAt: nowIso(),
        lastVerifiedAt: nowIso(),
    }, profile);
    const name = reopenedIdentity.nick ?? reopenedIdentity.memberId;
    emit({
        human: () => process.stdout.write(`Logged in as ${name} (memberId: ${reopenedIdentity.memberId})\n`),
        data: {
            ok: true,
            memberId: reopenedIdentity.memberId,
            nick: reopenedIdentity.nick,
        },
    });
}
async function completeLoginInContext(ctx, options) {
    const reusablePages = ctx.pages().filter((candidate) => !candidate.isClosed());
    const page = options.reuseExistingPage
        ? reusablePages[reusablePages.length - 1]
            ?? await ctx.newPage()
        : await ctx.newPage();
    if (options.headed) {
        await page.bringToFront();
        if (options.purpose === 'image_search') {
            info('Opening the 1688 image-search verification page in Microsoft Edge...');
            info('Complete the verification shown by 1688, then keep the window open.');
        }
        else {
            info('Opening 1688 login page in a browser window...');
            info('Scan the QR code with your 1688 or Taobao app.');
        }
    }
    else {
        printInteractive('Generating QR code...');
        attachQrRenderer(page);
    }
    if (options.purpose === 'image_search') {
        const verified = options.managedImageSearchUpload
            ? await completeManagedImageSearchVerification(ctx, page, options.timeoutMs, options.managedImageSearchUpload)
            : await waitForImageSearchVerification(ctx, page, options.timeoutMs);
        printInteractive('Confirmed. Finalizing session...');
        return persistOfficialSessionCookies(ctx).then((persisted) => {
            assertSameIdentity(verified, persisted);
            return persisted;
        });
    }
    // Only an explicit account-switch request clears this dedicated browser's
    // cookies. Verification windows must preserve their bound identity.
    if (options.freshLogin === true) await ctx.clearCookies();
    const initialCookies = await ctx.cookies();
    const visibleIdentity = options.openBrowser && !options.freshLogin
        ? await verifiedIdentityFromContext(ctx, initialCookies)
        : null;
    if (visibleIdentity) {
        await page.goto(LOGIN_WARMUP_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 60_000,
        });
        info(`Current account: ${visibleIdentity.nick ?? visibleIdentity.memberId} `
            + `(memberId: ${visibleIdentity.memberId}).`);
        if (!options.brokerMode) {
            info('Keep this Edge window open while confirming the account in this command window.');
            if (!(await confirm('Keep the account currently shown in Edge?'))) {
                throw new CliError(130, 'CANCELED', 'Login account confirmation was canceled.');
            }
        }
    }
    else {
        await page.goto(LOGIN_URL, {
            waitUntil: 'commit',
            timeout: 60_000,
        });
        await waitForLogin(ctx, page, options.timeoutMs, options.headed, initialCookies, options.openBrowser);
    }
    printInteractive('Confirmed. Finalizing session...');
    try {
        await page.goto(LOGIN_WARMUP_URL, {
            waitUntil: 'commit',
            timeout: 10_000,
        });
    }
    catch {
        /* ignore warmup failure */
    }
    const firstIdentity = await persistOfficialSessionCookies(ctx);
    if (visibleIdentity)
        assertSameIdentity(visibleIdentity, firstIdentity);
    else
        await requireOnlineIdentity(ctx, firstIdentity);
    return persistOfficialSessionCookies(ctx);
}
async function readBrokerManagedImageSearchUpload() {
    const rawPath = process.env.BB1688_IMAGE_SEARCH_PATH?.trim() ?? '';
    const rawMime = process.env.BB1688_IMAGE_SEARCH_MIME?.trim() ?? '';
    const rawSha256 = process.env.BB1688_IMAGE_SEARCH_SHA256?.trim() ?? '';
    const supplied = [rawPath, rawMime, rawSha256].map((value) => value.length > 0);
    if (supplied.every((value) => !value))
        return null;
    if (!supplied.every(Boolean)) {
        throw new CliError(2, 'IMAGE_SEARCH_VERIFICATION_INPUT_INVALID', 'Managed image-search verification requires path, MIME type, and SHA256 together.');
    }
    return readVerifiedImageUpload({
        imagePath: path.resolve(rawPath),
        expectedMimeType: rawMime,
        expectedSha256: rawSha256,
    });
}
async function completeManagedImageSearchVerification(ctx, page, timeoutMs, upload) {
    try {
        return await runManagedImageSearchVerification(ctx, page, timeoutMs, upload);
    }
    catch (error) {
        // Capture while the native context still owns the failing page. Keep
        // broker image data and identity out of command metadata, and preserve
        // the original public message and already-sanitized diagnostic fields.
        const artifact = await captureFailureArtifact(ctx, {
            cmd: 'image-search-verification', args: {},
        }, error).catch(() => null);
        const failure = error instanceof CliError
            ? error
            : new CliError(1, 'INTERNAL', error instanceof Error ? error.message : String(error));
        if (typeof artifact?.artifactDir === 'string' && artifact.artifactDir) {
            failure.withDetails({ artifactDir: artifact.artifactDir });
        }
        throw failure;
    }
}
async function runManagedImageSearchVerification(ctx, page, timeoutMs, upload) {
    const deadline = Date.now() + timeoutMs;
    // Preserve a failed navigation as a network diagnostic instead of
    // silently navigating again and eventually reporting a missing upload UI.
    if (/^(?:chrome|edge)-error:/i.test(page.url())) {
        const state = await detectPageState(page);
        throwForImageSearchTerminalState(state.kind, state.errorCode);
    }
    // The native visible launcher already navigated to image search. Preserve
    // that page, including any challenge the user is completing manually.
    if (!isTrustedImageSearchBusinessUrl(page.url()) && !isImageSearchRiskUrl(page.url())) {
        await page.goto(IMAGE_SEARCH_VERIFICATION_URL, {
            waitUntil: 'domcontentloaded',
            timeout: Math.min(timeoutMs, 15_000),
        });
    }
    logImageSearchVerificationStage('waiting_upload_page');
    await waitForManagedImageSearchUploadPage(page, deadline);
    const previousUrl = page.url();
    const previousImageId = safeReadImageResultId(previousUrl);
    const expectedIdentity = requireUniqueOfficialIdentity(await ctx.cookies());
    const evidence = startManagedImageSearchEvidence(page, { previousImageId, matchesImageOfferRequest });
    try {
        logImageSearchVerificationStage('upload_control_ready');
        await submitImageSearchOnce(page, upload);
        logImageSearchVerificationStage('image_selected_waiting_result');
        let consecutiveNormalSamples = 0;
        let observedImageId = null;
        let ordinaryResultSince = Date.now();
        let waitingOnManualVerification = false;
        let waitingForResponseChallenge = false;
        while (Date.now() < deadline) {
            await sleep(IMAGE_SEARCH_VERIFICATION_POLL_MS);
            if (page.isClosed()) {
                throw new CliError(130, 'CANCELED', 'Image-search verification was canceled.');
            }
            const state = await detectPageState(page);
            throwForImageSearchTerminalState(state.kind, state.errorCode);
            const imageId = state.kind === 'normal_1688_page'
                ? safeReadImageResultId(state.url)
                : null;
            const failure = evidence.failure(imageId);
            const visibleChallenge = state.kind === 'risk_challenge' || isImageSearchRiskUrl(state.url);
            if (visibleChallenge || failure === 'RISK_CONTROL') {
                if (!waitingOnManualVerification) logImageSearchVerificationStage('waiting_manual_verification');
                // MTOP can report a challenge before its UI is mounted. Keep
                // this same window open for the user's existing manual budget.
                waitingForResponseChallenge = !visibleChallenge;
                // Every observed challenge invalidates earlier/in-flight results.
                // Only requests started after the last blocked sample may prove it.
                evidence.reset();
                waitingOnManualVerification = true;
                ordinaryResultSince = null;
                consecutiveNormalSamples = 0;
                observedImageId = null;
                continue;
            }
            if (failure) {
                const exitCode = failure === 'NOT_LOGGED_IN' ? 3 : 9;
                throw new CliError(exitCode, failure, '1688 did not allow this image search. Complete login or wait for the access limit before retrying.');
            }
            if (waitingForResponseChallenge && !evidence.forImage(imageId)) continue;
            waitingForResponseChallenge = false;
            if (waitingOnManualVerification) logImageSearchVerificationStage('image_selected_waiting_result');
            waitingOnManualVerification = false;
            ordinaryResultSince ??= Date.now();
            const isNewResult = imageId !== null
                && state.url !== previousUrl
                && imageId !== previousImageId;
            if (isNewResult) {
                if (imageId !== observedImageId) {
                    observedImageId = imageId;
                    consecutiveNormalSamples = 0;
                }
                consecutiveNormalSamples += 1;
                if (consecutiveNormalSamples >= IMAGE_SEARCH_VERIFICATION_NORMAL_SAMPLES
                    && evidence.forImage(imageId)) {
                    const identity = await verifiedImageSearchIdentity(ctx, expectedIdentity);
                    logImageSearchVerificationStage('verified_result');
                    return identity;
                }
            }
            else {
                observedImageId = null;
                consecutiveNormalSamples = 0;
            }
            if (Date.now() - ordinaryResultSince >= IMAGE_SEARCH_RESULT_TIMEOUT_MS) {
                throw imageSearchResultTimeout(state.url, previousUrl, previousImageId);
            }
        }
        if (!waitingOnManualVerification) throw imageSearchResultTimeout(page.url(), previousUrl, previousImageId);
        throw imageSearchVerificationTimeout();
    }
    finally { evidence.dispose(); }
}
function imageSearchResultTimeout(currentUrl, previousUrl, previousImageId) {
    const imageId = safeReadImageResultId(currentUrl);
    let hasImageId = false;
    try { hasImageId = Boolean(new URL(currentUrl).searchParams.get('imageId')); } catch { /* Unknown URL. */ }
    return new CliError(13, 'IMAGE_SEARCH_RESULT_TIMEOUT', '已选择任务图片，但未能确认本次图片搜索结果；系统没有再次提交图片。', {
        currentUrl: sanitizedImageSearchPageUrl(currentUrl),
        hasImageId,
        hasNewImageId: imageId !== null && imageId !== previousImageId && currentUrl !== previousUrl,
    });
}
function logImageSearchVerificationStage(stage) {
    if (!IMAGE_SEARCH_VERIFICATION_STAGES.has(stage)) return;
    const message = `[image-search-verification] ${stage}`;
    if (isJson()) process.stderr.write(`${message}\n`);
    else info(message);
}
async function waitForManagedImageSearchUploadPage(page, deadline) {
    let ordinaryPageSince = null;
    let lastInspection = null;
    let waitingOnManualVerification = false;
    while (Date.now() < deadline) {
        await sleep(IMAGE_SEARCH_VERIFICATION_POLL_MS);
        if (page.isClosed()) {
            throw new CliError(130, 'CANCELED', 'Image-search verification was canceled.');
        }
        const state = await detectPageState(page);
        throwForImageSearchTerminalState(state.kind, state.errorCode);
        if (state.kind === 'risk_challenge' || isImageSearchRiskUrl(state.url)) {
            if (!waitingOnManualVerification) logImageSearchVerificationStage('waiting_manual_verification');
            waitingOnManualVerification = true;
            ordinaryPageSince = null;
            lastInspection = null;
            continue;
        }
        if (waitingOnManualVerification) logImageSearchVerificationStage('waiting_upload_page');
        waitingOnManualVerification = false;
        ordinaryPageSince ??= Date.now();
        lastInspection = await inspectImageSearchUploadPage(page);
        if (state.kind === 'normal_1688_page' && lastInspection.ready) return;
        if (Date.now() - ordinaryPageSince >= IMAGE_SEARCH_UPLOAD_READY_TIMEOUT_MS) {
            throw imageSearchUploadPageError(lastInspection);
        }
    }
    if (lastInspection) throw imageSearchUploadPageError(lastInspection);
    throw imageSearchVerificationTimeout();
}
function imageSearchUploadPageError(inspection) {
    const details = {
        currentUrl: inspection.currentUrl,
        recognized: inspection.recognized,
        hasUploadControl: inspection.hasUploadControl,
    };
    return inspection.recognized
        ? new CliError(14, 'IMAGE_SEARCH_UPLOAD_CONTROL_MISSING', '1688 图片搜索页面已打开，但未找到可用的图片上传控件；尚未提交图片。', details)
        : new CliError(14, 'IMAGE_SEARCH_UPLOAD_PAGE_UNSUPPORTED', '当前页面未识别为受支持的 1688 图片搜索应用；尚未提交图片。', details);
}
function sanitizedImageSearchPageUrl(value) {
    try {
        const url = new URL(value);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
    }
    catch {
        return null;
    }
}
function isTrustedImageSearchBusinessUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:'
            && ['s.1688.com', 'air.1688.com', 'www.1688.com'].includes(url.hostname);
    }
    catch {
        return false;
    }
}
async function inspectImageSearchUploadPage(page) {
    const currentUrl = sanitizedImageSearchPageUrl(page.url());
    if (!isTrustedImageSearchBusinessUrl(page.url())) return { currentUrl, recognized: false, hasUploadControl: false, ready: false };
    const snapshot = await withTimeout(page.evaluate(() => {
        const buttonReady = [...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], .image-upload-button-container, [class*="image-upload"]')].some(button => {
            if (button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
            const label = String(button.innerText || button.value || button.getAttribute('aria-label') || '').trim();
            if (!/上传图片|图片上传|选择图片/.test(label)) return false;
            const bounds = button.getBoundingClientRect();
            const style = getComputedStyle(button);
            return bounds.width > 0 && bounds.height > 0
                && style.visibility !== 'hidden' && style.display !== 'none';
        });
        return {
            hasApplicationMarker: Boolean(document.querySelector('link[href*="/1688-search/pc-image-search/"]')),
            hasUploadButton: buttonReady,
        };
    }), {
        timeoutMs: 1500,
        fallback: null,
    }).catch(() => null);
    if (!snapshot) return { currentUrl, recognized: isImageSearchUploadPageUrl(page.url()), hasUploadControl: false, ready: false };
    const uploadInput = await withTimeout(resolveImageSearchUploadInput(page), { timeoutMs: 1500, fallback: null });
    const recognized = isImageSearchUploadPageUrl(page.url()) || snapshot.hasApplicationMarker;
    const hasUploadControl = Boolean(uploadInput) || snapshot.hasUploadButton;
    return { currentUrl, recognized, hasUploadControl, ready: recognized && hasUploadControl };
}
function throwForImageSearchTerminalState(kind, browserError) {
    if (kind === 'network_error') {
        const errorCode = /^ERR_[A-Z0-9_]{1,80}$/.test(browserError ?? '') ? browserError : null;
        const reason = errorCode ? `（${errorCode}）` : '';
        throw new CliError(14, 'IMAGE_SEARCH_NETWORK_ERROR', `1688 / 淘宝页面连接失败${reason}。请检查网络或代理；不能据此判断需要换号。图片验证未完成，队列保持暂停。`, {
            browserError: errorCode,
        });
    }
    if (kind === 'not_logged_in') {
        throw new CliError(3, 'NOT_LOGGED_IN', 'The dedicated 1688 session is not signed in. Complete login first.');
    }
    if (kind === 'rate_limited') {
        throw new CliError(9, 'RATE_LIMITED', '1688 is limiting image-search access. Wait before trying again.');
    }
}
function isImageSearchUploadPageUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:')
            return false;
        return (url.hostname === 's.1688.com'
            && (/^\/+youyuan\/index\.htm$/i.test(url.pathname)
                || url.pathname === '/selloffer/offer_search.htm')) || (url.hostname === 'air.1688.com'
            && /^\/kapp\/1688-search\/pc-image-search\/?$/i.test(url.pathname));
    }
    catch {
        return false;
    }
}
function safeReadImageResultId(value) {
    try {
        return readImageResultId(new URL(value));
    }
    catch {
        return null;
    }
}
async function verifiedImageSearchIdentity(ctx, expected) {
    const identity = requireUniqueOfficialIdentity(await ctx.cookies());
    if (!identity) {
        throw new CliError(3, 'NOT_LOGGED_IN', 'The dedicated 1688 session is not signed in. Complete login first.');
    }
    assertSameIdentity(expected, identity);
    return identity;
}
function imageSearchVerificationTimeout() {
    return new CliError(4, 'RISK_CONTROL', '1688 image-search verification did not reach a verified image result in time.');
}
async function waitForImageSearchVerification(ctx, page, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let consecutiveNormalSamples = 0;
    await page.waitForLoadState('domcontentloaded', {
        timeout: Math.min(timeoutMs, 15_000),
    }).catch(() => undefined);
    while (Date.now() < deadline) {
        await sleep(IMAGE_SEARCH_VERIFICATION_POLL_MS);
        if (page.isClosed()) {
            throw new CliError(130, 'CANCELED', 'Image-search verification was canceled.');
        }
        const state = await detectPageState(page);
        if (isImageSearchRiskUrl(state.url) || state.kind === 'risk_challenge') {
            consecutiveNormalSamples = 0;
        }
        else if (state.kind === 'not_logged_in') {
            throw new CliError(3, 'NOT_LOGGED_IN', 'The dedicated 1688 session is not signed in. Complete login first.');
        }
        else if (state.kind === 'rate_limited') {
            throw new CliError(9, 'RATE_LIMITED', '1688 is limiting image-search access. Wait before trying again.');
        }
        else if (state.kind === 'normal_1688_page'
            && isImageSearchBusinessUrl(state.url)) {
            consecutiveNormalSamples += 1;
            if (consecutiveNormalSamples
                >= IMAGE_SEARCH_VERIFICATION_NORMAL_SAMPLES) {
                const identity = parseIdentity(await ctx.cookies());
                if (!identity) {
                    throw new CliError(3, 'NOT_LOGGED_IN', 'The dedicated 1688 session is not signed in. Complete login first.');
                }
                await requireOnlineIdentity(ctx, identity);
                return identity;
            }
        }
        else {
            consecutiveNormalSamples = 0;
        }
    }
    throw new CliError(4, 'RISK_CONTROL', '1688 image-search verification was not completed in time.');
}
function readBrokerSupplierStrengthVerification() {
    const offerId = process.env.BB1688_SUPPLIER_STRENGTH_OFFER_ID?.trim() ?? '';
    if (!/^\d{6,32}$/.test(offerId)) {
        throw new CliError(2, 'SUPPLIER_STRENGTH_VERIFICATION_INPUT_INVALID', 'Supplier-strength verification requires a 6 to 32 digit offerId.');
    }
    return { offerId };
}
function supplierStrengthOfferUrl(offerId) {
    return `https://detail.1688.com/offer/${offerId}.html`;
}
function isImageSearchRiskUrl(value) {
    return /(?:\/_____tmd_____\/punish|\/punish(?:[/?#]|$)|x5secdata=|nocaptcha|captcha)/i
        .test(value);
}
function isImageSearchBusinessUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:')
            return false;
        if (url.hostname === 's.1688.com'
            && /^\/+youyuan\/index\.htm$/i.test(url.pathname)) {
            return true;
        }
        if (url.hostname === 's.1688.com'
            && url.pathname === '/selloffer/offer_search.htm') {
            return /^\d+$/.test(url.searchParams.get('imageId') ?? '');
        }
        return url.hostname === 'air.1688.com'
            && /^\/kapp\/1688-search\/pc-image-search\/?$/i.test(url.pathname)
            && url.searchParams.get('tab') === 'imageSearch';
    }
    catch {
        return false;
    }
}
function resolveLoginPurpose(explicit) {
    const value = explicit ?? process.env.BB1688_LOGIN_PURPOSE ?? 'login';
    if (value === 'login'
        || value === 'image_search'
        || value === 'supplier_strength')
        return value;
    throw new CliError(2, 'LOGIN_PURPOSE_INVALID', 'Login purpose must be login, image_search, or supplier_strength.');
}
async function verifyPersistedContext(ctx, expected) {
    const persisted = requireUniqueOfficialIdentity(await ctx.cookies());
    assertSameIdentity(expected, persisted);
    await requireOnlineIdentity(ctx, persisted);
    const refreshed = await persistOfficialSessionCookies(ctx);
    assertSameIdentity(expected, refreshed);
    return refreshed;
}
async function verifyPersistedProfileWhileLocked(profile, expected) {
    const ctx = await launchEdgeContext(profile, true);
    try {
        return await verifyPersistedContext(ctx, expected);
    }
    finally {
        await ctx.close().catch(() => undefined);
    }
}
async function peekVerifiedIdentity(profile) {
    try {
        return await withSession({ headless: true, profile }, async (ctx) => {
            const identity = parseIdentity(await ctx.cookies());
            if (!identity || !(await verifyOnline(ctx)))
                return null;
            return identity;
        });
    }
    catch {
        return null;
    }
}
async function requireBoundPersistentIdentity(profile) {
    const state = await readState(profile).catch(() => ({ version: 1 }));
    const memberId = typeof state.memberId === 'string' ? state.memberId.trim() : '';
    if (!memberId) {
        throw new CliError(3, 'NOT_LOGGED_IN', 'The dedicated 1688 session has no previously confirmed account. Complete login first.');
    }
    const cookieProbe = probeDefaultEdgeIdentityCookie();
    if (cookieProbe === 'absent') {
        throw new CliError(3, 'NOT_LOGGED_IN', 'The persistent 1688 identity cookie is missing. Complete login first.');
    }
    if (cookieProbe === 'unknown') {
        throw new CliError(8, 'LOGIN_COOKIE_STORE_UNSAFE', 'The persistent 1688 cookie store could not be verified safely.');
    }
    return withSession({ headless: true, profile }, async (ctx) => {
        return requireBoundPersistentIdentityInContext(ctx, memberId);
    });
}
async function verifyPersistedProfileIdentityWhileLocked(profile, expected) {
    const ctx = await launchEdgeContext(profile, true);
    try {
        return await requireBoundPersistentIdentityInContext(ctx, expected.memberId);
    }
    finally {
        await ctx.close().catch(() => undefined);
    }
}
async function requireBoundPersistentIdentityInContext(ctx, expectedMemberId) {
    const cookies = await ctx.cookies();
    const identity = requireUniqueOfficialIdentity(cookies);
    const officialIdentityCookies = cookies.filter((cookie) => cookie.name === 'unb' && isOfficialCookie(cookie));
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (officialIdentityCookies.some((cookie) => !Number.isFinite(cookie.expires) || cookie.expires <= nowSeconds)) {
        throw new CliError(8, 'LOGIN_COOKIE_NOT_PERSISTED', 'The 1688 identity cookie is not persistent.');
    }
    assertSameIdentity({ memberId: expectedMemberId, nick: null }, identity);
    return identity;
}
async function verifiedIdentityFromContext(ctx, cookies) {
    const identity = parseIdentity(cookies ?? await ctx.cookies());
    if (!identity || !(await verifyOnline(ctx)))
        return null;
    return identity;
}
export async function persistOfficialSessionCookies(ctx, nowSeconds = Math.floor(Date.now() / 1000)) {
    const before = await ctx.cookies();
    const identityBefore = requireUniqueOfficialIdentity(before);
    const freshUntil = nowSeconds + COOKIE_FRESHNESS_SECONDS;
    const persistentUntil = nowSeconds + COOKIE_PERSISTENCE_SECONDS;
    const expiring = before.filter((cookie) => isOfficialCookie(cookie) &&
        (!Number.isFinite(cookie.expires) || cookie.expires <= freshUntil));
    if (expiring.length > 0) {
        await ctx.addCookies(expiring.map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            expires: persistentUntil,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: cookie.sameSite,
            ...(cookie.partitionKey
                ? { partitionKey: cookie.partitionKey }
                : {}),
        })));
    }
    const after = await ctx.cookies();
    const identityAfter = requireUniqueOfficialIdentity(after);
    if (identityAfter.memberId !== identityBefore.memberId ||
        identityAfter.nick !== identityBefore.nick) {
        throw new CliError(8, 'LOGIN_IDENTITY_CHANGED', 'Official identity changed while persisting the login session.');
    }
    const officialUnb = after.filter((cookie) => cookie.name === 'unb' && isOfficialCookie(cookie));
    if (officialUnb.length === 0 ||
        officialUnb.some((cookie) => !Number.isFinite(cookie.expires) || cookie.expires <= freshUntil)) {
        throw new CliError(8, 'LOGIN_COOKIE_NOT_PERSISTED', 'Login identity cookie did not remain persistent after verification.');
    }
    return identityAfter;
}
function requireUniqueOfficialIdentity(cookies) {
    const official = cookies.filter(isOfficialCookie);
    const unb = official.filter((cookie) => cookie.name === 'unb');
    if (unb.length === 0 || unb.some((cookie) => cookie.value.length === 0)) {
        throw new CliError(8, 'LOGIN_INCOMPLETE', 'Login flow finished but official identity cookies are missing. Try --headed.');
    }
    const unbValues = new Set(unb.map((cookie) => cookie.value));
    if (unbValues.size !== 1) {
        throw new CliError(8, 'LOGIN_COOKIE_CONFLICT', 'Conflicting official identity cookies were detected. Login was rejected.');
    }
    const normalized = official.map((cookie) => ({
        ...cookie,
        domain: cookie.domain.startsWith('.')
            ? cookie.domain
            : `.${cookie.domain}`,
    }));
    const parsed = parseIdentity(normalized);
    return {
        memberId: [...unbValues][0],
        nick: parsed?.nick ?? null,
    };
}
async function requireOnlineIdentity(ctx, expected) {
    const current = requireUniqueOfficialIdentity(await ctx.cookies());
    assertSameIdentity(expected, current);
    if (!(await verifyOnline(ctx))) {
        throw new CliError(8, 'LOGIN_ONLINE_VERIFICATION_FAILED', '1688 did not confirm the signed-in session online.');
    }
}
function assertSameIdentity(expected, actual) {
    if (expected.memberId !== actual.memberId) {
        throw new CliError(8, 'LOGIN_IDENTITY_CHANGED', 'The 1688 account changed during login verification.');
    }
}
function isOfficialCookie(cookie) {
    const domain = cookie.domain.toLowerCase().replace(/^\./, '');
    return (domain === '1688.com' ||
        domain.endsWith('.1688.com') ||
        domain === 'taobao.com' ||
        domain.endsWith('.taobao.com'));
}
async function waitForLogin(ctx, page, timeoutMs, headed, initialCookies, requireNativeWindow) {
    const deadline = Date.now() + timeoutMs;
    let observedCookieSignal = loginCookieSignal(initialCookies);
    let observedPageUrl = page.url();
    let nextOnlineProbeAt = 0;
    let nextWindowProbeAt = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (page.isClosed()) {
            throw new CliError(130, 'CANCELED', headed
                ? 'Login canceled (browser closed).'
                : 'Login canceled.');
        }
        let cookies;
        try {
            cookies = await ctx.cookies();
        }
        catch {
            throw new CliError(130, 'CANCELED', 'Login canceled.');
        }
        const cookieSignal = loginCookieSignal(cookies);
        const pageUrl = page.url();
        const hasIdentityCookie = cookies.some((cookie) => cookie.name === 'unb'
            && cookie.domain.toLowerCase().endsWith('.1688.com'));
        const now = Date.now();
        if (requireNativeWindow && now >= nextWindowProbeAt) {
            await ensureNativeVisibleEdgeWindow(ctx);
            nextWindowProbeAt = now + 5_000;
        }
        if (hasIdentityCookie
            && (cookieSignal !== observedCookieSignal
                || pageUrl !== observedPageUrl
                || now >= nextOnlineProbeAt)) {
            observedCookieSignal = cookieSignal;
            observedPageUrl = pageUrl;
            nextOnlineProbeAt = now + LOGIN_ONLINE_PROBE_INTERVAL_MS;
            if (await verifyOnline(ctx))
                return;
        }
        else if (!hasIdentityCookie) {
            observedCookieSignal = cookieSignal;
            observedPageUrl = pageUrl;
        }
        await sleep(1000);
    }
    throw new CliError(7, 'LOGIN_TIMEOUT', `Login timed out after ${Math.round(timeoutMs / 1000)}s. ` +
        `If the QR never appeared, try \`1688 login --headed\`.`);
}
function loginCookieSignal(cookies) {
    return JSON.stringify(cookies
        .filter(isOfficialCookie)
        .map((cookie) => ({
        name: cookie.name,
        domain: cookie.domain.toLowerCase(),
        path: cookie.path,
        value: cookie.value,
        expires: cookie.expires,
    }))
        .sort((left, right) => `${left.domain}\u0000${left.name}\u0000${left.path}`.localeCompare(`${right.domain}\u0000${right.name}\u0000${right.path}`, 'en-US')));
}
function requireBrokerLoginControl() {
    const cancelPath = process.env.BB1688_LOGIN_CANCEL;
    const token = process.env.BB1688_LOGIN_TOKEN;
    let resolved;
    try { resolved = brokerSignalPath(cancelPath, 'cancel'); }
    catch { throw new CliError(6, 'LOGIN_CANCEL_SIGNAL_INVALID', 'The verified login cancellation signal is invalid.'); }
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
        throw new CliError(6, 'LOGIN_CANCEL_SIGNAL_INVALID', 'The verified login cancellation signal is invalid.');
    }
    return { cancelPath: resolved, token };
}
async function runWithBrokerLoginCancellation(control, operation) {
    const controller = new AbortController();
    try {
        return await Promise.race([
            operation(),
            waitForBrokerLoginCancellation(control, controller.signal),
        ]);
    }
    finally {
        controller.abort();
    }
}
async function waitForBrokerLoginCancellation(control, signal) {
    while (!signal.aborted) {
        await throwIfBrokerLoginCanceled(control);
        await sleep(100);
    }
    return new Promise(() => undefined);
}
async function throwIfBrokerLoginCanceled(control) {
    const handle = await fs.open(control.cancelPath, 'r').catch((cause) => {
        if (cause.code === 'ENOENT')
            return null;
        throw cause;
    });
    if (!handle)
        return;
    try {
        const [opened, current] = await Promise.all([
            handle.stat(),
            fs.lstat(control.cancelPath).catch((cause) => {
                if (cause.code === 'ENOENT')
                    return null;
                throw cause;
            }),
        ]);
        if (!current
            || !opened.isFile()
            || !current.isFile()
            || current.isSymbolicLink()
            || opened.size < 1
            || opened.size > 128
            || current.dev !== opened.dev
            || current.ino !== opened.ino) {
            throw new CliError(6, 'LOGIN_CANCEL_SIGNAL_INVALID', 'The verified login cancellation signal is unsafe.');
        }
        const content = await handle.readFile('ascii');
        const actual = Buffer.from(content, 'ascii');
        const expected = Buffer.from(control.token, 'ascii');
        if (actual.length !== expected.length
            || !crypto.timingSafeEqual(actual, expected)) {
            throw new CliError(6, 'LOGIN_CANCEL_SIGNAL_INVALID', 'The verified login cancellation signal does not match this login.');
        }
    }
    finally {
        await handle.close();
    }
    throw new CliError(130, 'CANCELED', 'The previous dedicated Edge login was closed before restarting the console.');
}
async function writeBrokerEdgeReadySignal() {
    const readyPath = process.env.BB1688_LOGIN_READY;
    if (!readyPath)
        return;
    const token = process.env.BB1688_LOGIN_TOKEN;
    let resolved;
    try { resolved = brokerSignalPath(readyPath, 'ready'); }
    catch { throw new CliError(6, 'LOGIN_READY_SIGNAL_INVALID', 'The verified Edge-ready signal path is invalid.'); }
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
        throw new CliError(6, 'LOGIN_READY_SIGNAL_INVALID', 'The verified Edge-ready signal path is invalid.');
    }
    try {
        await fs.writeFile(resolved, token, { flag: 'wx', encoding: 'ascii' });
    }
    catch (cause) {
        const error = new CliError(6, 'LOGIN_READY_SIGNAL_FAILED', 'The verified Edge-ready signal could not be written.');
        error.cause = cause;
        throw error;
    }
}
// ── QR rendering ──────────────────────────────────────────────────────────
function attachQrRenderer(page) {
    let lastContent;
    page.on('response', async (resp) => {
        const url = resp.url();
        if (!/qrcode\/generate/i.test(url))
            return;
        let json;
        try {
            json = await resp.json();
        }
        catch {
            try {
                const txt = await resp.text();
                json = JSON.parse(txt);
            }
            catch {
                return;
            }
        }
        const content = findValue(json, 'codeContent');
        if (!content || content === lastContent)
            return;
        const refreshing = lastContent !== undefined;
        lastContent = content;
        await renderQrToTerminal(content, refreshing);
    });
}
async function renderQrToTerminal(content, refreshing) {
    const out = process.stderr;
    out.write('\n');
    if (refreshing) {
        out.write('QR refreshed — scan the new code:\n\n');
    }
    else {
        out.write('Scan with your 1688 or Taobao app:\n\n');
    }
    // ASCII render only works in a real terminal. Agents (Codex / Claude
    // Code) usually run the CLI without a TTY for stderr, so the ASCII art
    // would not display correctly. Always also save a PNG copy that the
    // agent can surface to the user as an image attachment.
    if (out.isTTY) {
        try {
            const ascii = await QRCode.toString(content, {
                type: 'terminal',
                small: true,
            });
            out.write(ascii);
        }
        catch (e) {
            out.write(`(QR render failed: ${e.message})\n`);
        }
    }
    try {
        await ensureRoot();
        const pngPath = loginQrFile();
        await QRCode.toFile(pngPath, content, { width: 400, margin: 2 });
        if (!out.isTTY) {
            out.write(`(non-TTY — agent: show the PNG below to the user; user: open it on a screen the phone can see, then scan with the 1688 app)\n`);
        }
        out.write(`QR saved as PNG: ${pngPath}\n`);
    }
    catch (e) {
        out.write(`(QR PNG save failed: ${e.message})\n`);
    }
    out.write('\nWaiting for scan + confirmation...\n');
}
function printInteractive(msg) {
    // Always write to stderr — keeps stdout JSON clean for pipes/agents.
    if (!isJson()) {
        process.stderr.write(`→ ${msg}\n`);
    }
}
function findValue(obj, key) {
    if (!obj || typeof obj !== 'object')
        return undefined;
    const o = obj;
    if (typeof o[key] === 'string')
        return o[key];
    for (const v of Object.values(o)) {
        const r = findValue(v, key);
        if (r)
            return r;
    }
    return undefined;
}
//# sourceMappingURL=login.js.map
