export const MAX_SUPPLIER_CONTACT_MESSAGE_LENGTH = 500;
export const SUPPLIER_CONTACT_MESSAGE_FORMAT = 'base_with_offer_link_v1';
const OFFER_ID = /^\d{6,32}$/;
const OFFER_LINK_LABEL = '\n\n对应产品链接：';
const MANAGED_OFFER_LINK_LINE = /^(?:商品链接|对应产品链接)[\t ]*[：:][\t ]*https:\/\/detail\.1688\.com\/offer\/\d{6,32}\.html$/u;
export class SupplierContactMessageError extends Error {
    code = 'PROCUREMENT_CONTACT_MESSAGE_INVALID';
}
export function canonical1688OfferUrl(offerIdValue) {
    const offerId = String(offerIdValue ?? '').trim();
    if (!OFFER_ID.test(offerId)) {
        throw new SupplierContactMessageError('无法生成对应产品链接：1688 商品编号无效。');
    }
    return `https://detail.1688.com/offer/${offerId}.html`;
}
export function maxSupplierContactBodyLength(offerId) {
    const suffix = `${OFFER_LINK_LABEL}${canonical1688OfferUrl(offerId)}`;
    return MAX_SUPPLIER_CONTACT_MESSAGE_LENGTH - Array.from(suffix).length;
}
export function stripManagedOfferLinkLines(value) {
    return String(value ?? '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .filter((line) => !MANAGED_OFFER_LINK_LINE.test(line.trim()))
        .join('\n')
        .trim();
}
export function composeSupplierContactMessage(publicBodyValue, offerId) {
    const publicBody = stripManagedOfferLinkLines(publicBodyValue);
    const maximumBodyLength = maxSupplierContactBodyLength(offerId);
    const bodyLength = Array.from(publicBody).length;
    if (bodyLength < 1) {
        throw new SupplierContactMessageError('厂家询问公共正文不能为空。');
    }
    if (bodyLength > maximumBodyLength) {
        throw new SupplierContactMessageError(`厂家询问公共正文过长：系统发送时还会追加对应产品链接，本商品最多可填写 ${maximumBodyLength} 个字符。`);
    }
    return `${publicBody}${OFFER_LINK_LABEL}${canonical1688OfferUrl(offerId)}`;
}
//# sourceMappingURL=contact-message.js.map