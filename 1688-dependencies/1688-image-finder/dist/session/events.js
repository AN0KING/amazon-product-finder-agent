import fs from 'node:fs/promises';
import path from 'node:path';
import { eventsFile } from './paths.js';
const SENSITIVE_KEY_RE = /cookie|token|password|passwd|secret|authorization|headers|body|message/i;
export function sanitizeForEvent(value) {
    if (value === null || value === undefined)
        return value;
    if (typeof value !== 'object')
        return value;
    if (Array.isArray(value))
        return value.map(sanitizeForEvent);
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
        if (SENSITIVE_KEY_RE.test(key)) {
            out[key] = '[redacted]';
        }
        else {
            out[key] = sanitizeForEvent(raw);
        }
    }
    return out;
}
export function eventFromError(input) {
    const err = input.error;
    const details = err?.details;
    return {
        ts: new Date().toISOString(),
        requestId: input.requestId,
        cmd: input.cmd,
        phase: 'error',
        status: 'error',
        durationMs: Date.now() - input.startedAt,
        profile: input.profile,
        artifactDir: details?.artifactDir,
        errorCode: err?.code,
        pageState: details?.pageState,
        verification: verificationFromDetails(details),
        retryable: details?.retryable,
    };
}
export function startEvent(input) {
    return {
        ts: new Date().toISOString(),
        requestId: input.requestId,
        cmd: input.cmd,
        phase: 'start',
        status: 'running',
        profile: input.profile,
    };
}
export function endEvent(input) {
    return {
        ts: new Date().toISOString(),
        requestId: input.requestId,
        cmd: input.cmd,
        phase: 'end',
        status: 'ok',
        durationMs: Date.now() - input.startedAt,
        profile: input.profile,
    };
}
export async function appendEvent(event) {
    const file = eventsFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(sanitizeForEvent(event)) + '\n');
}
export async function appendEventBestEffort(event) {
    await appendEvent(event).catch(() => { });
}
export async function readRecentEvents(limit = 100) {
    const events = await readAllEvents();
    return events.slice(-Math.max(1, limit));
}
export async function readAllEvents() {
    const file = eventsFile();
    let text = '';
    try {
        text = await fs.readFile(file, 'utf8');
    }
    catch {
        return [];
    }
    const events = [];
    for (const line of text.split('\n').filter(Boolean)) {
        try {
            events.push(JSON.parse(line));
        }
        catch {
            /* skip malformed historical line */
        }
    }
    return events;
}
export function summarizeEvents(events) {
    const byRequest = new Map();
    for (const event of events) {
        const list = byRequest.get(event.requestId) ?? [];
        list.push(event);
        byRequest.set(event.requestId, list);
    }
    return [...byRequest.entries()].map(([requestId, list]) => {
        const sorted = [...list].sort((a, b) => a.ts.localeCompare(b.ts));
        const first = sorted[0];
        const last = sorted.at(-1);
        return {
            requestId,
            cmd: last.cmd || first.cmd,
            status: last.status,
            startedAt: sorted.find((e) => e.phase === 'start')?.ts ?? first.ts,
            endedAt: last.phase === 'start' ? undefined : last.ts,
            durationMs: last.durationMs,
            profile: last.profile ?? first.profile,
            artifactDir: last.artifactDir,
            errorCode: last.errorCode,
            pageState: last.pageState,
            verification: last.verification,
            warnings: last.warnings,
            events: sorted,
        };
    });
}
export async function readRecentEventSummaries(limit = 20) {
    const summaries = summarizeEvents(await readAllEvents());
    return summaries.slice(-Math.max(1, limit));
}
function verificationFromDetails(details) {
    if (!details)
        return undefined;
    if (details.pageState === 'not_logged_in') {
        return {
            state: 'login_required',
            currentUrl: details.currentUrl,
        };
    }
    if (details.category === 'risk_control' || details.pageState === 'rate_limited') {
        return {
            state: 'risk_control',
            reason: details.pageState,
            currentUrl: details.currentUrl,
        };
    }
    if (details.currentUrl || details.pageState) {
        return {
            state: 'unknown',
            reason: details.pageState,
            currentUrl: details.currentUrl,
        };
    }
    return undefined;
}
//# sourceMappingURL=events.js.map