export function parseIdentity(cookies) {
    const officialCookies = cookies.filter((cookie) => isOfficialDomain(cookie.domain));
    const memberIds = new Set(officialCookies
        .filter((cookie) => cookie.name === 'unb')
        .map((cookie) => cookie.value.trim())
        .filter(Boolean));
    if (memberIds.size !== 1)
        return null;
    const memberId = [...memberIds][0];
    const trackraw = officialCookies.find((cookie) => cookie.name === 'tracknick' && cookie.value)?.value;
    const nick = trackraw ? decodeTracknick(trackraw) : null;
    return { memberId, nick };
}
function isOfficialDomain(value) {
    const domain = value.toLowerCase().replace(/^\./, '');
    return domain === '1688.com'
        || domain.endsWith('.1688.com')
        || domain === 'taobao.com'
        || domain.endsWith('.taobao.com');
}
export function decodeTracknick(raw) {
    let s = raw;
    try {
        s = decodeURIComponent(s);
    }
    catch {
        // malformed percent encoding — leave as-is
    }
    // Handle literal \uXXXX escapes that sometimes survive in cookie values
    s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    return s;
}
//# sourceMappingURL=cookies.js.map