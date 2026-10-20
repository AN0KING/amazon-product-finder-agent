import { parseMtopJsonp } from './mtop.js';
import { isSearchServiceFallbackMtopText, parseOfferItemsFromMtopText, readSearchMtopRequestMeta, readSearchMtopRiskControl, } from './search-mtop.js';

// A managed verification proves this upload can search, independently of the
// account workspace. Never reuse old responses or infer success from a URL.
export function startManagedImageSearchEvidence(page, { previousImageId, matchesImageOfferRequest }) {
    let requests = new WeakMap();
    let generation = 0;
    let disposed = false;
    const results = new Map();
    const failures = new Map();
    const requestImageId = (request) => {
        try {
            const url = new URL(request.url());
            if (url.protocol !== 'https:' || !/(^|\.)1688\.com$/i.test(url.hostname)) return null;
            const meta = readSearchMtopRequestMeta(url.href, request.postData?.());
            if (!meta || !/^\d+$/.test(meta.imageId ?? '') || meta.imageId === previousImageId) return null;
            const resultUrl = new URL(meta.method === 'getOfferList'
                ? `https://s.1688.com/selloffer/offer_search.htm?imageId=${meta.imageId}`
                : `https://air.1688.com/kapp/1688-search/pc-image-search?imageId=${meta.imageId}&imageIdList=${meta.imageId}&tab=imageSearch`);
            return matchesImageOfferRequest(meta, resultUrl) ? meta.imageId : null;
        }
        catch { return null; }
    };
    const onRequest = request => {
        const imageId = requestImageId(request);
        if (imageId) requests.set(request, { imageId, generation });
    };
    const onResponse = async response => {
        const observed = requests.get(response.request?.());
        if (disposed || !observed || observed.generation !== generation) return;
        const imageId = observed.imageId;
        try {
            const responseUrl = new URL(response.url());
            if (responseUrl.protocol !== 'https:' || !/(^|\.)1688\.com$/i.test(responseUrl.hostname)) return;
            const status = response.status();
            if (status === 429) { failures.set(imageId, 'RATE_LIMITED'); return; }
            if (status === 401) { failures.set(imageId, 'NOT_LOGGED_IN'); return; }
            if (status === 403) { failures.set(imageId, 'RISK_CONTROL'); return; }
            if (status < 200 || status >= 300) return;
            const text = await response.text();
            if (disposed || observed.generation !== generation) return;
            const risk = readSearchMtopRiskControl(text);
            if (risk) { failures.set(imageId, 'RISK_CONTROL'); return; }
            if (isSearchServiceFallbackMtopText(text)) return;
            const root = parseMtopJsonp(text);
            const ret = Array.isArray(root?.ret) ? root.ret : [root?.ret];
            // MTOP refreshes expired/missing request tokens transparently. A
            // failed token exchange is neither search proof nor logout proof.
            if (ret.some(value => /(?:SESSION_EXPIRED|SESSION_INVALID|NOT_LOGIN|LOGIN_REQUIRED)/i.test(String(value)))) {
                failures.set(imageId, 'NOT_LOGGED_IN'); return;
            }
            if (ret.some(value => /(?:TRAFFIC_LIMIT|RATE_LIMIT|FREQUENCY_LIMIT)/i.test(String(value)))) {
                failures.set(imageId, 'RATE_LIMITED'); return;
            }
            if (ret.length === 0 || !ret.every(value => typeof value === 'string' && /^SUCCESS(?:::|$)/.test(value))) return;
            const offers = parseOfferItemsFromMtopText(text);
            if (offers.length > 0 && !failures.has(imageId)) results.set(imageId, { imageId, offerCount: offers.length });
        }
        catch { /* An unreadable response is not proof of a usable search. */ }
    };
    const reset = () => {
        generation++;
        requests = new WeakMap();
        results.clear();
        failures.clear();
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        reset();
        page.off('request', onRequest);
        page.off('response', onResponse);
        page.off('close', dispose);
    };
    page.on('request', onRequest);
    page.on('response', onResponse);
    page.on('close', dispose);
    return { forImage: imageId => results.get(imageId), failure: imageId => failures.get(imageId), reset, dispose };
}
