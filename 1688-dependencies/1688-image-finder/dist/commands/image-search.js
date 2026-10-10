import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { dispatch } from '../session/dispatch.js';
import { emit, info } from '../io/output.js';
import { CliError } from '../io/errors.js';
import { withRecovery } from '../session/recovery.js';
import { clickImageSearchButton, clickImageUploadButton, } from '../session/image-search-locators.js';
import { captureSearchOffersForAction } from '../session/search-capture.js';
import { SEARCH_APP_ID, readSearchMtopRequestMeta, } from '../session/search-mtop.js';
import { detectProcurementImageType } from '../procurement/store.js';
const UPLOAD_PAGE = 'https://s.1688.com/youyuan/index.htm';
export const CURRENT_IMAGE_SEARCH_OFFER_METHODS = [
    'getImageSearchPreResult',
    'imageOfferSearchService',
];
export async function execute(ctx, args) {
    await reportProgress(args, { phase: 'validating_image' });
    const upload = await readVerifiedImageUpload(args);
    const pageHolder = { current: null };
    try {
        return await withRecovery(ctx, { cmd: 'image-search', args }, async () => {
            const previousPage = pageHolder.current;
            if (previousPage && !previousPage.isClosed()) {
                await previousPage.close().catch(() => { });
            }
            const page = await ctx.newPage();
            pageHolder.current = page;
            return executeImageSearch(page, args, upload);
        // The companion queue owns all retry timing and request spacing. A
        // retry here would start a second upload/search inside the same slot.
        }, { headed: args.headed === true, maxRetries: 0 });
    }
    finally {
        const page = pageHolder.current;
        if (page && !page.isClosed())
            await page.close().catch(() => { });
    }
}
export async function readVerifiedImageUpload(args) {
    let image;
    try {
        image = await fs.readFile(args.imagePath);
    }
    catch {
        throw new CliError(2, 'BAD_INPUT', `Cannot read image: ${args.imagePath}`);
    }
    const detected = detectProcurementImageType(image);
    if (!detected) {
        throw new CliError(2, 'BAD_INPUT', 'The selected file is not a supported product image.');
    }
    if (args.expectedMimeType !== undefined && args.expectedMimeType !== detected.mimeType) {
        throw new CliError(2, 'MANAGED_IMAGE_CHANGED', 'The managed product image type changed after manual confirmation.');
    }
    const sha256 = crypto.createHash('sha256').update(image).digest('hex');
    if (args.expectedSha256 !== undefined) {
        const expected = args.expectedSha256.toLocaleLowerCase('en-US');
        if (!/^[a-f0-9]{64}$/.test(expected) || !constantTimeHexEqual(sha256, expected)) {
            throw new CliError(2, 'MANAGED_IMAGE_CHANGED', 'The managed product image changed after manual confirmation.');
        }
    }
    return {
        name: path.basename(args.imagePath),
        mimeType: detected.mimeType,
        buffer: image,
        sha256,
    };
}
async function executeImageSearch(page, args, upload) {
    info('Uploading image to 1688...');
    await reportProgress(args, { phase: 'uploading_image' });
    const { imageId, offers } = await uploadAndCaptureOffers(page, args, upload);
    await reportProgress(args, {
        phase: 'saving_candidates',
        candidatesFound: Math.min(offers.length, args.max),
    });
    return {
        imageId,
        total: offers.length,
        offers: offers.slice(0, args.max),
    };
}
async function uploadAndCaptureOffers(page, args, upload) {
    await page.goto(UPLOAD_PAGE, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
    });
    await waitPastImageSearchRiskControl(page, args.headed === true);
    if (/login\.1688\.com|login\.taobao\.com/.test(page.url())) {
        throw new CliError(3, 'NOT_LOGGED_IN', 'Session expired. Run `1688 login`.');
    }
    const previousUrl = page.url();
    const captureResult = await captureSearchOffersForAction({
        page,
        requireImageId: () => readImageResultId(new URL(page.url())) ?? undefined,
        targetPage: () => 1,
        acceptMeta: (meta) => matchesImageOfferRequest(meta, new URL(page.url())),
        keep: 'largest',
    }, async () => {
        // File-input changes can submit automatically. Capture the first
        // response before uploading and never click again once it has started.
        await reportProgress(args, { phase: 'searching_offers' });
        await submitImageSearchOnce(page, upload);
        await waitForImageResultOrRiskControl(page, previousUrl, 20000, args.headed === true);
        const imageId = readImageResultId(new URL(page.url()));
        if (!imageId) {
            throw new CliError(13, 'UPLOAD_FAILED', '1688 未打开本次上传图片的结果页，请重新登录后再试。');
        }
        info(`Image uploaded (imageId=${imageId}). Fetching results...`);
        return imageId;
    }, {
        timeoutMs: 15000,
        isClosed: () => page.isClosed(),
        isBlocked: async () => (await detectImageSearchRiskControl(page)).blocked,
    });
    const imageId = captureResult.actionResult;
    if (captureResult.status === 'browser_closed') {
        throw new CliError(130, 'CANCELED', 'Browser closed.');
    }
    if (captureResult.status === 'blocked') {
        const detection = captureResult.diagnostics.riskControlCount > 0
            ? {
                blocked: true,
                source: 'mtop',
                challengeUrl: sanitizeImageSearchChallengeUrl(page.url()),
            }
            : await detectImageSearchRiskControl(page);
        throw imageSearchRiskControlError(false, detection, {
            mtopRetCode: captureResult.diagnostics.lastRiskControlCode,
            mtopResponseUrl: captureResult.diagnostics.lastRiskControlUrl,
        });
    }
    if (readImageResultId(new URL(page.url())) !== imageId) {
        throw new CliError(13, 'IMAGE_RESULT_UNCORRELATED', '1688 已离开本次图片结果页，系统未保存任何候选商品。');
    }
    if (captureResult.status === 'fallback') {
        throw new CliError(13, 'IMAGE_SEARCH_FALLBACK', '1688 以图搜款未识别该图片并返回了普通推荐，系统已拦截且未保存错误候选。请重试或换用主体清晰、背景简洁的商品图。', {
            category: 'image_search_fallback',
            currentUrl: page.url(),
            matchedResponses: captureResult.diagnostics.matchedCount,
            fallbackResponses: captureResult.diagnostics.fallbackCount,
            retryable: true,
        });
    }
    if (captureResult.status !== 'captured') {
        throw new CliError(13, 'IMAGE_RESULT_UNCORRELATED', '未收到与本次上传图片一致的 1688 搜索结果，系统未保存任何候选商品。', {
            category: 'site_changed',
            currentUrl: page.url(),
            matchedResponses: captureResult.diagnostics.matchedCount,
            retryable: true,
        });
    }
    return { imageId, offers: captureResult.offers };
}

export async function submitImageSearchOnce(page, upload) {
    const previousUrl = page.url();
    const previousImageId = readImageResultId(new URL(previousUrl));
    let requestStarted = false;
    const observeRequest = (request) => {
        // Selecting a file can upload it or trigger unrelated background
        // traffic while the visible panel still requires "搜索图片". Only an
        // actual image-result request proves that search has already started.
        const value = request.url?.();
        if (!value) return;
        let url;
        try { url = new URL(value); } catch { return; }
        if (url.protocol !== 'https:' || !/(^|\.)1688\.com$/i.test(url.hostname)) return;
        const resultId = readImageResultId(url);
        const meta = readSearchMtopRequestMeta(value, request.postData?.());
        const requestedImageId = meta?.appId === SEARCH_APP_ID
            && ['getOfferList', ...CURRENT_IMAGE_SEARCH_OFFER_METHODS].includes(meta.method)
            ? meta.imageId : null;
        if ((resultId && resultId !== previousImageId)
            || (requestedImageId && /^\d+$/.test(requestedImageId) && requestedImageId !== previousImageId)) requestStarted = true;
    };
    const started = () => {
        const imageId = readImageResultId(new URL(page.url()));
        return requestStarted || (imageId !== null && imageId !== previousImageId && page.url() !== previousUrl);
    };
    page.on('request', observeRequest);
    try {
        const selected = await setVerifiedImageUpload(page, upload);
        const hasHeaderPanel = selected?.kind === 'header_image_search';
        const deadline = Date.now() + (hasHeaderPanel ? 8000 : 1500);
        while (Date.now() < deadline) {
            if (page.isClosed()) throw new CliError(130, 'CANCELED', 'Browser closed.');
            if (started() || (await detectImageSearchRiskControl(page)).blocked) return;
            if (hasHeaderPanel && await hasPendingHeaderImageSearchSubmit(page, selected)) {
                const button = page.locator('#pc-home2024-search-tab .search-image-upload-container .copy-image-container .search-btn');
                // Check the exact uploaded preview and the search state again
                // immediately before the sole explicit submit for this panel.
                if (started() || (await detectImageSearchRiskControl(page)).blocked) return;
                if (await hasPendingHeaderImageSearchSubmit(page, selected) && !started()
                    && !(await detectImageSearchRiskControl(page)).blocked && !started()) {
                    // Result URL and offer capture own the navigation wait.
                    await button.click({ timeout: 5000, noWaitAfter: true });
                    return;
                }
            }
            await delay(150);
        }
        // Elapsed time alone never authorizes another submission. Only a
        // selected local file in an explicit native multipart submit form is
        // evidence that the older UI is waiting for a submit-button click.
        const pendingSubmit = !hasHeaderPanel && await hasPendingImageSearchSubmit(page);
        if (started() || (await detectImageSearchRiskControl(page)).blocked) return;
        if (!pendingSubmit) {
            throw new CliError(13, 'IMAGE_SUBMISSION_UNCONFIRMED', '未确认图片是否已开始搜索，已停止重复提交。请等待页面结果后再决定是否重试。', {
                category: 'image_submission_unconfirmed', retryable: false,
            });
        }
        await clickImageSearchButton(page, {
            shouldClick: async () => {
                const pending = await hasPendingImageSearchSubmit(page);
                return pending && !started() && !(await detectImageSearchRiskControl(page)).blocked && !started();
            },
        });
    }
    finally {
        page.off('request', observeRequest);
    }
}

async function hasPendingHeaderImageSearchSubmit(page, selected) {
    return page.evaluate(({ expectedPreviewSrc }) => {
        const visible = element => {
            if (!element) return false;
            const bounds = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return bounds.width > 0 && bounds.height > 0
                && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const panels = document.querySelectorAll('#pc-home2024-search-tab .search-image-upload-container .copy-image-container');
        if (panels.length !== 1) return false;
        const panel = panels[0];
        const preview = panel.querySelector('.copy-image img');
        const desc = panel.querySelector('.desc');
        const buttons = panel.querySelectorAll('.search-btn');
        const button = buttons.length === 1 ? buttons[0] : null;
        return visible(panel) && visible(preview) && preview.complete && preview.naturalWidth > 0
            && preview.getAttribute('src') === expectedPreviewSrc
            && /^已上传\s*1\s*张图片$/.test(desc?.textContent?.trim() ?? '')
            && visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true'
            && button.textContent?.trim() === '搜索图片';
    }, { expectedPreviewSrc: selected.expectedPreviewSrc });
}

export async function hasPendingImageSearchSubmit(page) {
    return page.evaluate(() => [...document.querySelectorAll('input[type="file"]')].some(input => {
        const form = input.form;
        if (input.disabled || input.files?.length !== 1 || !form
            || String(form.method).toLowerCase() !== 'post'
            || String(form.enctype).toLowerCase() !== 'multipart/form-data') return false;
        let action;
        try { action = new URL(form.action, location.href); } catch { return false; }
        if (action.protocol !== 'https:' || !/(^|\.)1688\.com$/i.test(action.hostname)) return false;
        return [...form.elements].some(button => {
            if (!['BUTTON', 'INPUT'].includes(button.tagName) || button.type !== 'submit' || button.disabled) return false;
            const label = String(button.innerText || button.value || button.getAttribute('aria-label') || '').trim();
            if (!/^搜索图片$/.test(label)) return false;
            const bounds = button.getBoundingClientRect();
            return bounds.width > 0 && bounds.height > 0 && getComputedStyle(button).visibility !== 'hidden';
        });
    }));
}
export function readImageResultId(url) {
    if (url.protocol !== 'https:') {
        return null;
    }
    const isLegacyResult = url.hostname === 's.1688.com' &&
        url.pathname === '/selloffer/offer_search.htm';
    const isCurrentResult = url.hostname === 'air.1688.com' &&
        /^\/kapp\/1688-search\/pc-image-search\/?$/.test(url.pathname) &&
        (url.searchParams.get('tab') === null
            || url.searchParams.get('tab') === 'imageSearch');
    if (!isLegacyResult && !isCurrentResult) {
        return null;
    }
    const imageId = url.searchParams.get('imageId');
    if (!imageId || !/^\d+$/.test(imageId))
        return null;
    const imageIdList = url.searchParams.get('imageIdList');
    if (isCurrentResult && imageIdList !== null && imageIdList !== imageId) {
        return null;
    }
    return imageId;
}
export function matchesImageOfferRequest(meta, resultUrl) {
    const imageId = readImageResultId(resultUrl);
    if (meta.appId !== SEARCH_APP_ID ||
        !imageId ||
        meta.imageId !== imageId ||
        (meta.beginPage ?? 1) !== 1) {
        return false;
    }
    if (resultUrl.hostname === 's.1688.com') {
        return meta.method === 'getOfferList';
    }
    return (CURRENT_IMAGE_SEARCH_OFFER_METHODS.some((method) => method === meta.method) &&
        meta.pageSize === 60 &&
        meta.imageIdList === imageId &&
        meta.searchScene === 'pcImageSearch' &&
        meta.appName === 'pctusou' &&
        meta.tab === 'imageSearch');
}
async function waitPastImageSearchRiskControl(page, headed) {
    let detection = await detectImageSearchRiskControl(page);
    if (!detection.blocked)
        return;
    if (!headed)
        throw imageSearchRiskControlError(false, detection);
    info('1688 verification page detected. Complete the slider in the Edge window.');
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
        if (page.isClosed()) {
            throw new CliError(130, 'CANCELED', 'Browser closed.');
        }
        await delay(300);
        detection = await detectImageSearchRiskControl(page);
        if (!detection.blocked)
            return;
    }
    throw imageSearchRiskControlError(true, detection);
}
async function waitForImageResultOrRiskControl(page, previousUrl, timeoutMs, headed) {
    let deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (page.isClosed()) {
            throw new CliError(130, 'CANCELED', 'Browser closed.');
        }
        const detection = await detectImageSearchRiskControl(page);
        if (detection.blocked) {
            if (!headed)
                throw imageSearchRiskControlError(false, detection);
            await waitPastImageSearchRiskControl(page, true);
            deadline = Date.now() + timeoutMs;
            continue;
        }
        const currentUrl = page.url();
        if (currentUrl !== previousUrl &&
            readImageResultId(new URL(currentUrl)) !== null) {
            return;
        }
        await delay(200);
    }
    throw new CliError(13, 'UPLOAD_FAILED', '1688 未在预期时间内打开本次上传图片的结果页。', {
        category: 'site_changed',
        currentUrl: page.url(),
        retryable: true,
    });
}
export async function detectImageSearchRiskControl(page) {
    const url = page.url();
    if (isImageSearchRiskControlUrl(url)) {
        return {
            blocked: true,
            source: 'url',
            challengeUrl: sanitizeImageSearchChallengeUrl(url),
        };
    }
    const snapshot = await page
        .evaluate(() => {
        const selectors = [
            '#nocaptcha',
            '.nc-container',
            '.nc_wrapper',
            '[id*="captcha"]',
            '[class*="captcha"]',
            'iframe[src*="punish"]',
            'iframe[src*="captcha"]',
            'iframe[src*="x5sec"]',
        ];
        const challengeElement = selectors.some((selector) => {
            const element = document.querySelector(selector);
            if (!(element instanceof HTMLElement))
                return element !== null;
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                Number(style.opacity || '1') > 0 &&
                rect.width > 0 &&
                rect.height > 0);
        });
        return {
            url: location.href,
            title: document.title ?? '',
            text: (document.body?.innerText ?? '').slice(0, 12000),
            challengeElement,
        };
    })
        .catch(() => ({ url }));
    return classifyImageSearchRiskControl(snapshot);
}
export function classifyImageSearchRiskControl(snapshot) {
    if (isImageSearchRiskControlUrl(snapshot.url)) {
        return {
            blocked: true,
            source: 'url',
            challengeUrl: sanitizeImageSearchChallengeUrl(snapshot.url),
        };
    }
    const visibleText = `${snapshot.title ?? ''}\n${snapshot.text ?? ''}`;
    const riskText = /(?:请完成(?:安全|滑块|人机)?验证|请按住滑块|拖动.*滑块|滑块验证|验证码拦截|访问验证|人机验证|检测到.*异常.*验证|完成验证后)/i;
    if (snapshot.challengeElement === true || riskText.test(visibleText)) {
        return {
            blocked: true,
            source: 'dom',
            challengeUrl: sanitizeImageSearchChallengeUrl(snapshot.url),
        };
    }
    return { blocked: false };
}
export function isImageSearchRiskControlUrl(url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        const officialHost = host === '1688.com' ||
            host.endsWith('.1688.com') ||
            host === 'taobao.com' ||
            host.endsWith('.taobao.com');
        if (!officialHost)
            return false;
        return (host.startsWith('punish.') ||
            /\/(?:punish|captcha|nocaptcha)(?:\/|$)/i.test(parsed.pathname) ||
            parsed.searchParams.has('x5secdata'));
    }
    catch {
        return false;
    }
}
export function sanitizeImageSearchChallengeUrl(url) {
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
function imageSearchRiskControlError(triedHeaded, detection, extra = {}) {
    return new CliError(4, 'RISK_CONTROL', triedHeaded
        ? '1688 人工验证未在 3 分钟内完成，系统未保存任何候选商品。'
        : '1688 要求先完成人工滑块验证。请在专用 Edge 中完成验证后重试，系统未保存任何候选商品。', {
        category: 'risk',
        currentUrl: detection.challengeUrl,
        challengeUrl: detection.challengeUrl,
        challengeSource: detection.source,
        retryable: false,
        ...extra,
    });
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export async function setVerifiedImageUpload(page, upload) {
    const filePayload = {
        name: upload.name,
        mimeType: upload.mimeType,
        buffer: upload.buffer,
    };
    const selection = await resolveImageSearchUploadSelection(page);
    const input = selection?.input;
    if (input) {
        await input.setInputFiles(filePayload);
        return selection.kind === 'header_image_search'
            ? { kind: selection.kind, expectedPreviewSrc: `data:${upload.mimeType};base64,${upload.buffer.toString('base64')}` }
            : { kind: selection.kind };
    }
    const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 8000 }),
        clickImageUploadButton(page),
    ]);
    await chooser.setFiles(filePayload);
}
export async function resolveImageSearchUploadInput(page) {
    return (await resolveImageSearchUploadSelection(page))?.input ?? null;
}
async function resolveImageSearchUploadSelection(page) {
    // The recorded current page has one extension-accepting input in this
    // header component, followed by an explicit React search-preview panel.
    const candidates = [
        { selector: '#pc-home2024-search-tab .search-image-upload-container input#img-search-upload[type="file"]', kind: 'header_image_search' },
        { selector: 'input[type="file"][accept*="image" i], input[type="file"][accept*=".jpg" i], input[type="file"][accept*=".jpeg" i], input[type="file"][accept*=".png" i], input[type="file"][accept*=".webp" i], input[type="file"][accept*=".bmp" i]', kind: 'image_input' },
        { selector: 'input[type="file"]', kind: 'file_input' },
    ];
    for (const candidate of candidates) {
        const input = page.locator(candidate.selector);
        const count = await input.count();
        if (count > 1) {
            throw new CliError(14, 'IMAGE_UPLOAD_CONTROL_AMBIGUOUS', '发现多个图片上传控件，无法确认本次搜图使用的控件；尚未提交图片。', { category: 'locator', retryable: false });
        }
        if (count === 1) return await input.isDisabled() ? null : { input, kind: candidate.kind };
    }
    return null;
}
export async function run(opts) {
    if (!opts.imagePath) {
        throw new CliError(2, 'BAD_INPUT', 'Local image path required.');
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(opts.imagePath)) {
        throw new CliError(2, 'BAD_INPUT', 'Remote image URLs are disabled. Use a verified local image file.');
    }
    const max = Math.max(1, parseInt(opts.max ?? '20', 10));
    const data = await dispatch('image-search', { imagePath: path.resolve(opts.imagePath), max, headed: opts.headed }, { headed: opts.headed, profile: opts.profile });
    emit({
        human: () => printResults(data),
        data,
    });
}
async function reportProgress(args, progress) {
    if (!args.onProgress)
        return;
    await Promise.resolve(args.onProgress(progress)).catch(() => undefined);
}
function constantTimeHexEqual(actual, expected) {
    const left = Buffer.from(actual, 'hex');
    const right = Buffer.from(expected, 'hex');
    return left.byteLength === right.byteLength && crypto.timingSafeEqual(left, right);
}
function printResults(r) {
    if (r.offers.length === 0) {
        process.stdout.write(`No offers found (imageId=${r.imageId}).\n`);
        return;
    }
    process.stdout.write(`Image search (imageId=${r.imageId}):\n\n`);
    const w = String(r.offers.length).length;
    r.offers.forEach((o, i) => {
        const idx = String(i + 1).padStart(w, ' ');
        const price = o.price.text || '(n/a)';
        process.stdout.write(`${idx}. ${o.title}\n`);
        const pad = ' '.repeat(w + 2);
        process.stdout.write(`${pad}${price}`);
        if (o.turnover)
            process.stdout.write(`  ·  ${o.turnover}`);
        process.stdout.write('\n');
        const supplierBits = [
            o.supplier.name,
            o.supplier.years ? `${o.supplier.years}年` : null,
        ]
            .filter(Boolean)
            .join(' · ');
        if (supplierBits)
            process.stdout.write(`${pad}${supplierBits}\n`);
        process.stdout.write(`${pad}${o.url}\n`);
        if (i < r.offers.length - 1)
            process.stdout.write('\n');
    });
}
//# sourceMappingURL=image-search.js.map
