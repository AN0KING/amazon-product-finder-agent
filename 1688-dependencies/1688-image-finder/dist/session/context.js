import fs from 'node:fs/promises';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { edgeCacheDir, profilePath } from './paths.js';
import { acquireLock } from './lock.js';
import { markDefaultEdgeProfileHeadless } from './native-edge.js';
import { CliError } from '../io/errors.js';
import { enrichErrorWithArtifact, } from './artifacts.js';
// Apply stealth evasions once at module load.
// Disable a couple of evasions that can cause issues with newer Chromium.
const stealthPlugin = stealth();
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
stealthPlugin.enabledEvasions.delete('media.codecs');
chromium.use(stealthPlugin);
const LAUNCH_OPTS = {
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
};
export async function withSession(opts, fn, meta) {
    const release = await acquireLock(opts.profile);
    const dir = profilePath(opts.profile);
    await fs.mkdir(dir, { recursive: true });
    const verifiedDir = profilePath(opts.profile);
    let ctx = null;
    try {
        ctx = await launchEdgeContext(opts.profile, opts.headless);
        // Stealth plugin defaults navigator.languages to en-US — override back to
        // Chinese so we look like a real CN user.
        await ctx.addInitScript(() => {
            try {
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['zh-CN', 'zh', 'en'],
                });
            }
            catch {
                /* ignore */
            }
        });
        return await fn(ctx);
    }
    catch (e) {
        if (ctx && meta) {
            throw await enrichErrorWithArtifact(ctx, meta, e);
        }
        throw e;
    }
    finally {
        if (ctx)
            await ctx.close().catch(() => { });
        await release().catch(() => { });
    }
}
export async function launchEdgeContext(profile, headless) {
    const dir = profilePath(profile);
    await fs.mkdir(dir, { recursive: true });
    const verifiedDir = profilePath(profile);
    const cacheMode = headless ? 'headless' : 'visible';
    const cacheDir = edgeCacheDir(cacheMode);
    await fs.mkdir(cacheDir, { recursive: true });
    const verifiedCacheDir = edgeCacheDir(cacheMode);
    try {
        const context = (await chromium.launchPersistentContext(verifiedDir, {
            ...LAUNCH_OPTS,
            headless,
            channel: 'msedge',
            args: [
                // 1688/淘宝均为国内站点：必须绕过系统代理（Clash）直连。
                // 经境外节点访问会触发阿里风控，滑块验证将永远返回 error:1y4QGu。
                '--no-proxy-server',
                `--disk-cache-dir=${verifiedCacheDir}`,
                '--disable-breakpad',
                '--disable-crash-reporter',
                '--disable-background-mode',
                '--no-first-run',
                '--no-default-browser-check',
                ...(headless
                    ? []
                    : [
                        '--new-window',
                        '--start-maximized',
                        '--window-position=48,48',
                        '--window-size=1280,840',
                        '--disable-features=msEdgeStartupBoost',
                    ]),
            ],
        }));
        if (headless) {
            try {
                await markDefaultEdgeProfileHeadless(profile);
            }
            catch (cause) {
                await context.close().catch(() => undefined);
                throw new CliError(6, 'EDGE_PROFILE_MODE_MARKER_FAILED', 'The Edge profile mode could not be recorded safely.', {
                    category: 'edge_profile_mode_marker_failed',
                    cause: cause instanceof Error ? cause.message : String(cause),
                    retryable: false,
                });
            }
        }
        return context;
    }
    catch (e) {
        const msg = e.message ?? '';
        if (/Executable doesn't exist|distribution ['"]?msedge['"]? is not found|msedge.*not found/i.test(msg)) {
            throw new CliError(6, 'EDGE_MISSING', 'Microsoft Edge is required for the 1688 session. Chrome and bundled Chromium fallback are disabled.');
        }
        throw e;
    }
}
//# sourceMappingURL=context.js.map