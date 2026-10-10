import { parseMtopJsonp } from './mtop.js';
export const SEARCH_MTOP_API = 'mtop.relationrecommend.wirelessrecommend.recommend';
export const SEARCH_APP_ID = '32517';
function bool(s) {
    return s === 'true';
}
function parseCountText(text) {
    if (typeof text === 'number')
        return Number.isFinite(text) ? text : null;
    if (!text)
        return null;
    const compact = text.replace(/,/g, '').replace(/\s+/g, '');
    const match = compact.match(/(\d+(?:\.\d+)?)(万|w|W|亿|k|K)?/);
    if (!match?.[1])
        return null;
    const value = Number(match[1]);
    if (!Number.isFinite(value))
        return null;
    const unit = match[2] ?? '';
    const multiplier = unit === '亿'
        ? 100000000
        : unit === '万' || unit === 'w' || unit === 'W'
            ? 10000
            : unit === 'k' || unit === 'K'
                ? 1000
                : 1;
    return Math.round(value * multiplier);
}
function parsePercentText(text) {
    if (!text)
        return null;
    const match = text.match(/(\d+(?:\.\d+)?)\s*%/);
    if (!match?.[1])
        return null;
    const n = Number(match[1]);
    return Number.isFinite(n) ? n : null;
}
function textList(items) {
    return (items ?? [])
        .map((t) => t?.text?.trim() ?? '')
        .filter((s) => !!s);
}
export function mapOffer(item) {
    const d = item.data;
    const offerId = normalizeOfferId(d?.offerId);
    if (!d || !offerId)
        return null;
    const title = (d.title ?? '').replace(/<\/?font[^>]*>/g, '').trim();
    const priceRaw = d.priceInfo?.price;
    const price = priceRaw ? parseFloat(priceRaw) : null;
    const yearsRaw = d.shop?.tpYear;
    const years = yearsRaw ? parseInt(yearsRaw, 10) : null;
    const tags = (d.tags ?? [])
        .map((t) => t?.text?.trim() ?? '')
        .filter((s) => !!s);
    const serviceTags = textList(d.serviceTags);
    const productBadges = textList(d.productBadges);
    const orderCountText = d.orderCountText ??
        (typeof d.orderCount === 'string' ? d.orderCount : undefined) ??
        d.bookedCount ??
        null;
    const repurchaseRateText = d.repurchaseRateText ?? d.repurchaseRate ?? null;
    return {
        offerId,
        title,
        price: {
            text: priceRaw ? `¥${priceRaw}` : '',
            min: price,
            max: price,
        },
        supplier: {
            name: d.shop?.text ?? null,
            loginId: d.loginId ?? null,
            memberId: d.memberId ?? null,
            shopUrl: d.shopAddition?.shopLinkUrl ?? d.winPortUrl ?? null,
            years,
        },
        location: {
            province: d.province ?? null,
            city: d.city ?? null,
        },
        bizType: d.bizType ?? null,
        verified: {
            factory: bool(d.factoryInspection),
            business: bool(d.businessInspection),
            superFactory: bool(d.superFactory),
        },
        tags,
        ...(serviceTags.length ? { serviceTags } : {}),
        ...(productBadges.length ? { productBadges } : {}),
        demand: {
            orderCountText,
            orderCount: typeof d.orderCount === 'number'
                ? d.orderCount
                : parseCountText(orderCountText),
            repurchaseRateText,
            repurchaseRate: parsePercentText(repurchaseRateText),
        },
        isP4P: bool(d.isP4P),
        turnover: d.bookedCount ?? null,
        url: `https://detail.1688.com/offer/${offerId}.html`,
        image: d.offerPicUrl ?? null,
    };
}
function normalizeOfferId(value) {
    if (typeof value === 'string') {
        const normalized = value.trim();
        return normalized || null;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
        return String(value);
    }
    return null;
}
export function readSearchMtopRequestMeta(url, postData) {
    if (!url.toLowerCase().includes(SEARCH_MTOP_API))
        return null;
    try {
        const requestUrl = new URL(url);
        const dataParam = new URLSearchParams(requestUrl.search).get('data') ??
            readPostDataParam(postData);
        if (!dataParam)
            return null;
        const dataObj = JSON.parse(dataParam);
        const params = (typeof dataObj.params === 'string'
            ? JSON.parse(dataObj.params || '{}')
            : dataObj.params ?? {});
        const beginPage = params.beginPage === undefined ? undefined : Number(params.beginPage);
        const pageSize = params.pageSize === undefined ? undefined : Number(params.pageSize);
        return {
            appId: dataObj.appId === undefined ? undefined : String(dataObj.appId),
            method: params.method,
            beginPage,
            pageSize,
            sortType: params.sortType,
            imageId: params.imageId === undefined ? undefined : String(params.imageId),
            imageIdList: params.imageIdList === undefined ? undefined : String(params.imageIdList),
            pageId: params.pageId,
            searchScene: params.searchScene,
            appName: params.appName,
            tab: params.tab,
        };
    }
    catch {
        return null;
    }
}
function readPostDataParam(postData) {
    const value = postData?.trim();
    if (!value)
        return '';
    if (value.startsWith('{'))
        return value;
    return new URLSearchParams(value).get('data') ?? '';
}
export function parseOfferItemsFromMtopText(text) {
    const json = parseMtopJsonp(text);
    const items = json?.data?.data?.OFFER?.items ?? [];
    return items.map(mapOffer).filter((o) => o !== null);
}
export function readSearchMtopRiskControl(text) {
    let root;
    try {
        root = parseMtopJsonp(text);
    }
    catch {
        return null;
    }
    const ret = Array.isArray(root?.ret)
        ? root.ret
        : typeof root?.ret === 'string'
            ? [root.ret]
            : [];
    for (const value of ret) {
        if (typeof value !== 'string')
            continue;
        const decoded = decodeMtopRet(value);
        if (!isRiskControlRet(decoded))
            continue;
        return { code: safeMtopRetCode(decoded) };
    }
    return null;
}
export function isSearchServiceFallbackMtopText(text) {
    const root = parseMtopJsonp(text);
    const pending = [root];
    let inspected = 0;
    while (pending.length > 0 && inspected < 100_000) {
        const value = pending.pop();
        inspected++;
        if (typeof value === 'string') {
            if (containsSearchServiceFailure(value))
                return true;
        }
        else if (Array.isArray(value)) {
            pending.push(...value);
        }
        else if (value && typeof value === 'object') {
            pending.push(...Object.values(value));
        }
    }
    return false;
}
function containsSearchServiceFailure(value) {
    let decoded = value;
    for (let i = 0; i < 3; i++) {
        if (/service_fail#/i.test(decoded))
            return true;
        if (!decoded.includes('%'))
            break;
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded)
                break;
            decoded = next;
        }
        catch {
            break;
        }
    }
    return /service_fail#/i.test(decoded);
}
function decodeMtopRet(value) {
    let decoded = value;
    for (let i = 0; i < 2 && decoded.includes('%'); i++) {
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded)
                break;
            decoded = next;
        }
        catch {
            break;
        }
    }
    return decoded;
}
function isRiskControlRet(value) {
    return (/FAIL_SYS_USER_VALIDATE/i.test(value) ||
        /CAPTCHA/i.test(value) ||
        /RGV(?:\d+)?(?:[_-][A-Z0-9]+)*/i.test(value) ||
        /(?:风控|风险控制|人机(?:校验|验证)|滑块|验证码|安全验证|需要验证|请(?:先|完成)?验证)/i.test(value));
}
function safeMtopRetCode(value) {
    const prefix = value.split('::', 1)[0]?.trim() ?? '';
    const normalized = prefix.replace(/[^A-Z0-9_-]/gi, '').slice(0, 80);
    return normalized || 'MTOP_USER_VALIDATE';
}
//# sourceMappingURL=search-mtop.js.map