import { CliError } from '../io/errors.js';
import { clickStable, findClickable, locatorCandidateToDebugString, } from './locator.js';
export async function clickImageUploadButton(page) {
    await clickStable(page, [
        { kind: 'role', role: 'button', name: /上传图片|图片上传|选择图片/ },
        { kind: 'css', selector: '.image-upload-button-container' },
        { kind: 'css', selector: '[class*="image-upload"]' },
    ], {
        description: 'image search upload button',
        timeoutMs: 8000,
    });
}
export async function clickImageSearchButton(page, { shouldClick } = {}) {
    const description = 'image search submit button';
    const candidates = [
        {
            kind: 'css',
            selector: '[data-testid="image-search-submit"], [data-action="image-search"]',
        },
        { kind: 'role', role: 'button', name: /^搜索图片$/ },
        { kind: 'css', selector: 'button:has-text("搜索图片")' },
        { kind: 'text', text: /^搜索图片$/ },
        {
            kind: 'css',
            selector: '[data-tracker="imgSearch"] button:has-text("搜索")',
        },
        {
            kind: 'css',
            selector: '[class*="image-search" i] button:has-text("搜索")',
        },
        {
            kind: 'css',
            selector: '[class*="imageSearch"] button:has-text("搜索")',
        },
    ];
    const button = await findClickable(page, candidates, {
        description,
        timeoutMs: 20000,
    });
    // Recheck immediately before the single click: an upload may have started
    // automatically while the legacy submit control was being located.
    if (shouldClick && !(await shouldClick())) return false;
    try {
        // A completed click must not fail while the result page is loading;
        // the caller already waits for the correlated image-search result.
        await button.click({ timeout: 5000, noWaitAfter: true });
        return true;
    }
    catch (error) {
        throw new CliError(14, 'STABLE_LOCATOR_BLOCKED', `Located ${description}, but it was not clickable: ${error.message}`, {
            category: 'locator',
            locatorDescription: description,
            locatorStrategies: candidates.map(locatorCandidateToDebugString),
            currentUrl: page.url(),
            retryable: true,
        });
    }
}
//# sourceMappingURL=image-search-locators.js.map
