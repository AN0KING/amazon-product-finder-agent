import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { composeSupplierContactMessage, stripManagedOfferLinkLines, SUPPLIER_CONTACT_MESSAGE_FORMAT, } from './contact-message.js';
import { PROCUREMENT_CONTACT_ATTEMPT_STATUSES, PROCUREMENT_SEARCH_PROGRESS_PHASES, PROCUREMENT_SUPPLIER_REPLY_ANALYSIS_FIELDS, PROCUREMENT_TASK_IMAGE_SOURCES, PROCUREMENT_TASK_STATUSES, } from './types.js';
export const MAX_PROCUREMENT_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_PROCUREMENT_IMPORT_BATCH_ITEMS = 200;
const STATE_VERSION = 1;
const WINDOWS_DRIVE_ROOT = 'd:\\';
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARACTER_RUNS = /[\u0000-\u001f\u007f-\u009f]+/g;
const CONTACT_MESSAGE_CONTROL_CHARACTERS = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DELETED_IMAGE_TOMBSTONE = /^\.([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.deleted$/i;
const SUPPLIER_LOGIN_ID = /^[\p{L}\p{N}._@-]{1,128}$/u;
const SUPPLIER_MEMBER_ID = /^\d{5,30}$/;
const CONTACT_HISTORY_TIMESTAMP_TOLERANCE_MS = 1_000;
const SUPPLIER_REPLY_FIELDS = [
    'quotedPrice',
    'minimumOrderQuantity',
    'sampleTerms',
    'leadTime',
    'packaging',
    'taxAndInvoice',
    'quoteValidity',
    'factoryStatus',
    'contactInformation',
    'notes',
];
const rootLockTails = new Map();
export class ProcurementStoreError extends Error {
    code;
    details;
    constructor(code, message, details = {}) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'ProcurementStoreError';
    }
}
export function createProcurementStore(input) {
    const options = typeof input === 'string' ? { rootDir: input } : input;
    const rootDir = normalizeRoot(options.rootDir);
    const rootKey = canonicalWindowsPath(rootDir);
    const statePath = managedPath(rootDir, 'state.json');
    const imagesDir = managedPath(rootDir, 'images');
    const now = () => normalizeNow(options.now?.() ?? new Date());
    const nextTaskId = () => {
        const value = options.idFactory?.()
            ?? `task_${Date.now()}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
        assertEntityId(value, 'task');
        return value;
    };
    const locked = (operation) => withRootLock(rootKey, operation);
    async function listTasks() {
        return locked(async () => snapshots((await readState(rootDir, statePath)).tasks));
    }
    async function getTask(taskId) {
        assertEntityId(taskId, 'task');
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = state.tasks.find((item) => item.id === taskId);
            return task ? snapshot(task, state.tasks) : null;
        });
    }
    async function createTask(input) {
        if (!isRecord(input) || !(input.image instanceof Uint8Array)) {
            throw storeError('PROCUREMENT_INPUT_INVALID', 'A product image and metadata are required.');
        }
        const title = requiredText(input.title, 'title', 200);
        const originalFileName = validateFileName(input.fileName);
        const image = Buffer.from(input.image);
        const imageKind = validateImage(image, input.mimeType);
        return locked(async () => {
            await ensureManagedDirectories(rootDir, imagesDir);
            const state = await readState(rootDir, statePath);
            const id = nextTaskId();
            if (state.tasks.some((task) => task.id === id)) {
                throw storeError('PROCUREMENT_TASK_CONFLICT', `Task ${id} already exists.`, { taskId: id });
            }
            const relativeImagePath = `images/${id}.${imageKind.extension}`;
            const absoluteImagePath = managedImagePath(rootDir, imagesDir, relativeImagePath);
            const imageSha256 = crypto.createHash('sha256').update(image).digest('hex');
            const timestamp = now();
            await writeFileAtomically(rootDir, absoluteImagePath, image);
            const task = {
                id,
                title,
                originalFileName,
                imagePath: relativeImagePath,
                imageMimeType: imageKind.mimeType,
                imageSize: image.byteLength,
                imageSha256,
                status: 'pending_review',
                candidates: [],
                createdAt: timestamp,
                updatedAt: timestamp,
            };
            state.tasks.push(task);
            try {
                await writeState(rootDir, statePath, state);
            }
            catch (error) {
                await fs.rm(absoluteImagePath, { force: true }).catch(() => undefined);
                throw error;
            }
            return snapshot(task, state.tasks);
        });
    }
    async function createTasksFromImport(input) {
        const normalized = normalizeImportBatch(input);
        return commitImportBatch(normalized);
    }
    async function createAndQueueTasksFromImport(input) {
        const normalized = normalizeQueuedImportBatch(input);
        return commitImportBatch(normalized.batch, normalized.confirmations);
    }
    async function commitImportBatch(normalized, confirmations) {
        return locked(async () => {
            await ensureManagedDirectories(rootDir, imagesDir);
            const state = await readState(rootDir, statePath);
            const existingTasks = state.tasks.filter((task) => task.importBatchId === normalized.batchId);
            if (existingTasks.length > 0) {
                assertSameImportBatch(existingTasks, normalized.items, normalized.batchId);
                if (confirmations) {
                    assertSameQueuedImportBatch(existingTasks, confirmations, normalized.batchId);
                }
                return {
                    batchId: normalized.batchId,
                    tasks: existingTasks.map((task) => snapshot(task, state.tasks)),
                    created: false,
                };
            }
            const knownIds = new Set(state.tasks.map((task) => task.id));
            const timestamp = now();
            const staged = [];
            for (const item of normalized.items) {
                const id = nextTaskId();
                if (knownIds.has(id)) {
                    throw storeError('PROCUREMENT_TASK_CONFLICT', `Task ${id} already exists.`, {
                        taskId: id,
                    });
                }
                knownIds.add(id);
                const relativeImagePath = `images/${id}.${item.imageKind.extension}`;
                const confirmation = confirmations?.[staged.length];
                const queueSequence = confirmation ? state.nextQueueSequence++ : undefined;
                staged.push({
                    absoluteImagePath: managedImagePath(rootDir, imagesDir, relativeImagePath),
                    task: {
                        id,
                        title: item.title,
                        originalFileName: item.originalFileName,
                        importBatchId: normalized.batchId,
                        ...(item.importRowNumber === undefined
                            ? {}
                            : { importRowNumber: item.importRowNumber }),
                        ...(item.sourceProductId ? { sourceProductId: item.sourceProductId } : {}),
                        ...(item.amazonUrl ? { amazonUrl: item.amazonUrl } : {}),
                        ...(item.sourceImageUrl ? { sourceImageUrl: item.sourceImageUrl } : {}),
                        imagePath: relativeImagePath,
                        imageMimeType: item.imageKind.mimeType,
                        imageSize: item.image.byteLength,
                        imageSha256: item.imageSha256,
                        imageSource: item.imageSource,
                        status: confirmation ? 'queued' : 'pending_review',
                        ...(confirmation
                            ? {
                                confirmation: { ...confirmation, confirmedAt: timestamp },
                                queueSequence,
                                queuedAt: timestamp,
                                searchProgress: {
                                    phase: 'queued',
                                    startedAt: timestamp,
                                    updatedAt: timestamp,
                                },
                            }
                            : {}),
                        candidates: [],
                        createdAt: timestamp,
                        updatedAt: timestamp,
                    },
                });
            }
            const writtenPaths = [];
            try {
                for (let index = 0; index < staged.length; index += 1) {
                    const entry = staged[index];
                    await writeFileAtomically(rootDir, entry.absoluteImagePath, normalized.items[index].image);
                    writtenPaths.push(entry.absoluteImagePath);
                }
                state.tasks.push(...staged.map((entry) => entry.task));
                await writeState(rootDir, statePath, state);
            }
            catch (error) {
                const rollback = await Promise.allSettled(writtenPaths.map((imagePath) => fs.rm(imagePath, { force: true })));
                const rollbackFailures = rollback.filter((result) => result.status === 'rejected');
                if (rollbackFailures.length > 0) {
                    throw storeError('PROCUREMENT_IMPORT_ROLLBACK_FAILED', `Import batch ${normalized.batchId} failed and some staged images could not be removed.`, {
                        batchId: normalized.batchId,
                        rollbackFailureCount: rollbackFailures.length,
                        cause: error instanceof Error ? error.message : String(error),
                    });
                }
                throw error;
            }
            return {
                batchId: normalized.batchId,
                tasks: staged.map((entry) => snapshot(entry.task, state.tasks)),
                created: true,
            };
        });
    }
    async function deleteTask(taskId, input) {
        assertEntityId(taskId, 'task');
        if (!isRecord(input) || !isIsoTimestamp(input.expectedUpdatedAt)) {
            throw storeError('PROCUREMENT_TASK_DELETE_INVALID', 'A canonical expectedUpdatedAt timestamp is required to delete a task.', { taskId });
        }
        const expectedUpdatedAt = input.expectedUpdatedAt;
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const taskIndex = state.tasks.findIndex((item) => item.id === taskId);
            const task = taskIndex < 0 ? requireTask(state, taskId) : state.tasks[taskIndex];
            if (task.updatedAt !== expectedUpdatedAt) {
                throw storeError('PROCUREMENT_TASK_DELETE_REVISION_CONFLICT', `Task ${task.id} changed after the delete confirmation was shown.`, { taskId: task.id, expectedUpdatedAt, currentUpdatedAt: task.updatedAt });
            }
            if (task.status === 'running') {
                throw stateConflict(task, 'delete');
            }
            if (task.candidates.some((candidate) => {
                const legacyMessages = candidate.messages;
                return candidate.contactAttempt?.status === 'prepared'
                    || candidate.contactAttempt?.status === 'message_click_started'
                    || candidate.contactAttempt?.status === 'delivery_unknown'
                    || candidate.contactAttempt?.status === 'sent'
                    || candidate.supplierReply !== undefined
                    || candidate.supplierReplyCapture !== undefined
                    || (Array.isArray(legacyMessages) && legacyMessages.length > 0);
            })) {
                throw storeError('PROCUREMENT_TASK_STATE_CONFLICT', `Cannot delete task ${task.id} because it contains active or verified supplier contact evidence.`, { taskId: task.id, status: task.status, operation: 'supplier_contact_evidence' });
            }
            const imagePath = managedImagePath(rootDir, imagesDir, task.imagePath);
            const tombstonePath = managedPath(rootDir, 'images', `.${task.id}.${crypto.randomUUID()}.deleted`);
            await assertNoReparsePath(imagePath);
            let imageMoved = false;
            try {
                const imageStat = await fs.lstat(imagePath);
                if (!imageStat.isFile() || imageStat.isSymbolicLink()) {
                    throw storeError('PROCUREMENT_IMAGE_INVALID', `Image for task ${taskId} is invalid.`, { taskId });
                }
                await fs.rename(imagePath, tombstonePath);
                imageMoved = true;
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
            state.tasks.splice(taskIndex, 1);
            try {
                await writeState(rootDir, statePath, state);
            }
            catch (error) {
                if (imageMoved) {
                    await fs.rename(tombstonePath, imagePath).catch((rollbackError) => {
                        throw storeError('PROCUREMENT_DELETE_ROLLBACK_FAILED', `Task ${taskId} could not be deleted and its image rollback failed.`, {
                            taskId,
                            cause: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                        });
                    });
                }
                throw error;
            }
            if (imageMoved)
                await fs.rm(tombstonePath, { force: true }).catch(() => undefined);
            return snapshot(task, state.tasks);
        });
    }
    async function confirmAndQueue(taskId, input) {
        assertEntityId(taskId, 'task');
        const normalized = normalizeConfirmation(input);
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = requireTask(state, taskId);
            if (task.confirmation) {
                if (sameConfirmation(task.confirmation, normalized)) {
                    return snapshot(task, state.tasks);
                }
                throw storeError('PROCUREMENT_CONFIRMATION_CONFLICT', 'This task was already confirmed with different parameters or account.', { taskId });
            }
            if (task.status !== 'pending_review') {
                throw stateConflict(task, 'confirm and queue');
            }
            const timestamp = now();
            task.confirmation = { ...normalized, confirmedAt: timestamp };
            task.status = 'queued';
            task.queueSequence = state.nextQueueSequence++;
            task.queuedAt = timestamp;
            task.searchProgress = {
                phase: 'queued',
                startedAt: timestamp,
                updatedAt: timestamp,
            };
            task.updatedAt = timestamp;
            await writeState(rootDir, statePath, state);
            return snapshot(task, state.tasks);
        });
    }
    async function confirmAndQueueMany(input) {
        const normalized = normalizeBatchConfirmations(input);
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const tasks = normalized.map((item) => requireTask(state, item.taskId));
            for (const task of tasks) {
                if (task.confirmation || task.status !== 'pending_review') {
                    throw stateConflict(task, 'confirm and queue in a batch');
                }
            }
            const timestamp = now();
            for (let index = 0; index < tasks.length; index += 1) {
                const task = tasks[index];
                const confirmation = normalized[index].confirmation;
                task.confirmation = { ...confirmation, confirmedAt: timestamp };
                task.status = 'queued';
                task.queueSequence = state.nextQueueSequence++;
                task.queuedAt = timestamp;
                task.searchProgress = {
                    phase: 'queued',
                    startedAt: timestamp,
                    updatedAt: timestamp,
                };
                task.updatedAt = timestamp;
            }
            await writeState(rootDir, statePath, state);
            return tasks.map((task) => snapshot(task, state.tasks));
        });
    }
    async function claimNext() {
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = state.tasks
                .filter((item) => item.status === 'queued')
                .sort(compareQueueOrder)[0];
            if (!task)
                return null;
            if (!task.confirmation) {
                throw storeError('PROCUREMENT_STATE_INVALID', `Queued task ${task.id} has no confirmation.`, { taskId: task.id });
            }
            const timestamp = now();
            task.status = 'running';
            task.claimedAt = timestamp;
            task.searchProgress = {
                phase: 'validating_image',
                startedAt: task.searchProgress?.startedAt ?? timestamp,
                updatedAt: timestamp,
            };
            task.updatedAt = timestamp;
            await writeState(rootDir, statePath, state);
            return snapshot(task, state.tasks);
        });
    }
    async function blockTaskForRisk(taskId, failureInput) {
        assertEntityId(taskId, 'task');
        const normalized = normalizeFailure(failureInput);
        const failure = {
            code: 'RISK_VERIFICATION_REQUIRED',
            message: normalized.message,
        };
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = requireTask(state, taskId);
            if (task.status === 'risk_blocked' && sameFailure(task.failure, failure)) {
                return snapshot(task, state.tasks);
            }
            if (task.status !== 'running')
                throw stateConflict(task, 'block for risk verification');
            const timestamp = now();
            task.status = 'risk_blocked';
            task.failure = failure;
            task.failedAt = timestamp;
            task.searchProgress = {
                phase: 'risk_blocked',
                ...(task.searchProgress?.candidatesFound === undefined
                    ? {}
                    : { candidatesFound: task.searchProgress.candidatesFound }),
                startedAt: task.searchProgress?.startedAt ?? task.claimedAt ?? timestamp,
                updatedAt: timestamp,
            };
            task.updatedAt = timestamp;
            await writeState(rootDir, statePath, state);
            return snapshot(task, state.tasks);
        });
    }
    async function retrySearch(taskId, input) {
        assertEntityId(taskId, 'task');
        if (!isRecord(input) || !isIsoTimestamp(input.expectedUpdatedAt)) {
            throw storeError('PROCUREMENT_SEARCH_RETRY_INVALID', 'A canonical expectedUpdatedAt timestamp and verified account are required.', { taskId });
        }
        const expectedUpdatedAt = input.expectedUpdatedAt;
        const confirmedMemberId = normalizeMemberId(input.confirmedMemberId);
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = requireTask(state, taskId);
            if (task.updatedAt !== expectedUpdatedAt) {
                throw storeError('PROCUREMENT_SEARCH_RETRY_REVISION_CONFLICT', `Task ${task.id} changed after the retry confirmation was shown.`, { taskId: task.id, expectedUpdatedAt, currentUpdatedAt: task.updatedAt });
            }
            if (!task.confirmation) {
                throw storeError('PROCUREMENT_STATE_INVALID', `Task ${task.id} cannot retry without a confirmed procurement request.`, { taskId: task.id });
            }
            if (task.confirmation.confirmedMemberId !== confirmedMemberId) {
                throw storeError('ACCOUNT_BINDING_CHANGED', 'The current 1688 account differs from the account that confirmed this product.', { taskId: task.id });
            }
            const retryableRisk = task.status === 'risk_blocked'
                || (task.status === 'failed'
                    && task.failure?.code === 'RISK_VERIFICATION_REQUIRED');
            if (!retryableRisk)
                throw stateConflict(task, 'retry image search');
            const timestamp = now();
            task.status = 'queued';
            task.queueSequence = state.nextQueueSequence++;
            task.queuedAt = timestamp;
            delete task.claimedAt;
            delete task.failure;
            delete task.failedAt;
            task.searchProgress = {
                phase: 'queued',
                startedAt: timestamp,
                updatedAt: timestamp,
            };
            task.updatedAt = timestamp;
            await writeState(rootDir, statePath, state);
            return snapshot(task, state.tasks);
        });
    }
    async function recordSearchProgress(taskId, input) {
        assertEntityId(taskId, 'task');
        const normalized = normalizeSearchProgressInput(input);
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = requireTask(state, taskId);
            if (task.status !== 'running')
                throw stateConflict(task, 'record search progress');
            if (task.searchProgress?.phase === normalized.phase
                && task.searchProgress.candidatesFound === normalized.candidatesFound) {
                return snapshot(task, state.tasks);
            }
            const timestamp = now();
            task.searchProgress = withoutUndefined({
                phase: normalized.phase,
                candidatesFound: normalized.candidatesFound,
                startedAt: task.searchProgress?.startedAt ?? task.claimedAt ?? timestamp,
                updatedAt: timestamp,
            });
            task.updatedAt = timestamp;
            await writeState(rootDir, statePath, state);
            return snapshot(task, state.tasks);
        });
    }
    async function completeSearch(taskId, offers) {
        assertEntityId(taskId, 'task');
        if (!Array.isArray(offers)) {
            throw storeError('PROCUREMENT_OFFER_INVALID', 'Offers must be an array.');
        }
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = requireTask(state, taskId);
            if (task.status !== 'running')
                throw stateConflict(task, 'complete search');
            const timestamp = now();
            const seenOfferIds = new Set();
            const seenFactories = new Set();
            const candidates = [];
            for (const source of offers) {
                const offer = normalizeOffer(source);
                const offerKey = offer.offerId.toLocaleLowerCase('en-US');
                const factoryKey = offer.factoryName
                    ? offer.factoryName.normalize('NFKC').toLocaleLowerCase('zh-CN')
                    : undefined;
                if (seenOfferIds.has(offerKey) || (factoryKey && seenFactories.has(factoryKey)))
                    continue;
                seenOfferIds.add(offerKey);
                if (factoryKey)
                    seenFactories.add(factoryKey);
                candidates.push({
                    id: candidateId(taskId, offer.offerId, factoryKey),
                    ...offer,
                    reviewStatus: 'pending',
                    createdAt: timestamp,
                    updatedAt: timestamp,
                });
            }
            task.candidates = candidates;
            task.status = 'review_candidates';
            task.searchProgress = {
                phase: 'awaiting_review',
                candidatesFound: candidates.length,
                startedAt: task.searchProgress?.startedAt ?? task.claimedAt ?? timestamp,
                updatedAt: timestamp,
            };
            task.updatedAt = timestamp;
            await writeState(rootDir, statePath, state);
            return snapshot(task, state.tasks);
        });
    }
    async function recordCandidateStrength(taskId, candidateIdValue, input) {
        assertEntityId(taskId, 'task');
        assertEntityId(candidateIdValue, 'candidate');
        const normalized = normalizeCandidateStrengthInput(input);
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = requireTask(state, taskId);
            if (task.status !== 'review_candidates' && task.status !== 'completed') {
                throw stateConflict(task, 'record candidate strength');
            }
            const candidate = requireCandidate(task, candidateIdValue);
            const timestamp = now();
            if (normalized.failure) {
                candidate.supplierStrengthFailure = normalized.failure;
            }
            else {
                setOptionalCandidateMetric(candidate, 'supplierYears', normalized.supplierYears);
                setOptionalCandidateMetric(candidate, 'supplierRepeatRate', normalized.supplierRepeatRate);
                setOptionalCandidateMetric(candidate, 'supplierServiceScore', normalized.supplierServiceScore);
                setOptionalCandidateMetric(candidate, 'supplierServiceScoreCount', normalized.supplierServiceScoreCount);
                delete candidate.supplierStrengthFailure;
            }
            candidate.supplierStrengthCheckedAt = timestamp;
            candidate.updatedAt = timestamp;
            task.updatedAt = timestamp;
            await writeState(rootDir, statePath, state);
            return snapshot(task, state.tasks);
        });
    }
    async function failTask(taskId, failureInput) {
        assertEntityId(taskId, 'task');
        const failure = normalizeFailure(failureInput);
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = requireTask(state, taskId);
            if (task.status === 'failed' && sameFailure(task.failure, failure)) {
                return snapshot(task, state.tasks);
            }
            if (task.status !== 'queued' && task.status !== 'running') {
                throw stateConflict(task, 'fail');
            }
            const timestamp = now();
            task.status = 'failed';
            task.failure = failure;
            task.failedAt = timestamp;
            task.searchProgress = {
                phase: 'failed',
                ...(task.searchProgress?.candidatesFound === undefined
                    ? {}
                    : { candidatesFound: task.searchProgress.candidatesFound }),
                startedAt: task.searchProgress?.startedAt ?? task.queuedAt ?? timestamp,
                updatedAt: timestamp,
            };
            task.updatedAt = timestamp;
            await writeState(rootDir, statePath, state);
            return snapshot(task, state.tasks);
        });
    }
    async function reviewCandidate(taskId, candidateIdValue, decision) {
        assertEntityId(taskId, 'task');
        assertEntityId(candidateIdValue, 'candidate');
        if (decision !== 'approved' && decision !== 'rejected') {
            throw storeError('PROCUREMENT_REVIEW_INVALID', 'Candidate decision must be approved or rejected.');
        }
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = requireTask(state, taskId);
            if (task.status !== 'review_candidates' && task.status !== 'completed') {
                throw stateConflict(task, 'review candidate');
            }
            const candidate = task.candidates.find((item) => item.id === candidateIdValue);
            if (!candidate) {
                throw storeError('PROCUREMENT_CANDIDATE_NOT_FOUND', `Candidate ${candidateIdValue} was not found.`, { taskId, candidateId: candidateIdValue });
            }
            if (candidate.reviewStatus === decision)
                return snapshot(task, state.tasks);
            if (candidate.contactAttempt && candidate.contactAttempt.status !== 'failed') {
                throw storeError('PROCUREMENT_CANDIDATE_REVIEW_LOCKED', 'A supplier review decision cannot change after contact has started.', {
                    taskId,
                    candidateId: candidateIdValue,
                    contactStatus: candidate.contactAttempt.status,
                });
            }
            if (decision === 'approved'
                && task.sharedContactDraft
                && (!candidate.contactAttempt || candidate.contactAttempt.status === 'failed')) {
                composeSupplierContactMessage(task.sharedContactDraft.message, candidate.offerId);
            }
            const timestamp = now();
            candidate.reviewStatus = decision;
            candidate.reviewedAt = timestamp;
            if (decision === 'approved'
                && task.sharedContactDraft
                && (!candidate.contactAttempt || candidate.contactAttempt.status === 'failed')) {
                applySharedContactDraftToCandidate(candidate, task.sharedContactDraft, timestamp);
            }
            candidate.updatedAt = timestamp;
            const locallyComplete = task.candidates.every((item) => item.reviewStatus !== 'pending');
            task.status = locallyComplete ? 'completed' : 'review_candidates';
            task.completedAt = locallyComplete ? timestamp : undefined;
            task.searchProgress = {
                phase: locallyComplete ? 'completed' : 'awaiting_review',
                candidatesFound: task.candidates.length,
                startedAt: task.searchProgress?.startedAt ?? task.queuedAt ?? timestamp,
                updatedAt: timestamp,
            };
            task.updatedAt = timestamp;
            await writeState(rootDir, statePath, state);
            return snapshot(task, state.tasks);
        });
    }
    async function saveContactDraft(taskId, candidateIdValue, input) {
        assertEntityId(taskId, 'task');
        assertEntityId(candidateIdValue, 'candidate');
        const message = normalizeNewContactMessage(input?.message);
        const expectedRevision = normalizeContactRevision(input?.expectedRevision);
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = requireTask(state, taskId);
            assertContactableTask(task);
            if (task.sharedContactDraft) {
                throw storeError('PROCUREMENT_CONTACT_SHARED_DRAFT_REQUIRED', 'This task uses one shared supplier contact message. Edit the shared draft instead.', { taskId });
            }
            const candidate = requireCandidate(task, candidateIdValue);
            if (candidate.reviewStatus === 'rejected') {
                throw storeError('PROCUREMENT_CONTACT_CANDIDATE_REJECTED', 'A rejected supplier cannot receive a contact draft.', { taskId, candidateId: candidateIdValue });
            }
            const attempt = candidate.contactAttempt;
            if (attempt && attempt.status !== 'failed') {
                throw contactAttemptConflict(taskId, candidateIdValue, attempt.status);
            }
            const currentRevision = candidate.contactDraft?.revision ?? 0;
            if (expectedRevision !== currentRevision) {
                throw storeError('PROCUREMENT_CONTACT_DRAFT_CONFLICT', 'The contact draft changed in another view. Reload before saving.', { taskId, candidateId: candidateIdValue, expectedRevision, currentRevision });
            }
            composeSupplierContactMessage(message, candidate.offerId);
            const timestamp = now();
            candidate.contactDraft = {
                message,
                revision: currentRevision + 1,
                updatedAt: timestamp,
            };
            candidate.updatedAt = timestamp;
            task.updatedAt = timestamp;
            await writeState(rootDir, statePath, state);
            return snapshot(task, state.tasks);
        });
    }
    async function saveSharedContactDraft(taskId, input) {
        assertEntityId(taskId, 'task');
        const message = normalizeNewContactMessage(input?.message);
        const expectedRevision = normalizeContactRevision(input?.expectedRevision);
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = requireTask(state, taskId);
            assertContactableTask(task);
            const currentRevision = task.sharedContactDraft?.revision ?? 0;
            if (expectedRevision !== currentRevision) {
                throw storeError('PROCUREMENT_CONTACT_DRAFT_CONFLICT', 'The shared contact draft changed in another view. Reload before saving.', { taskId, expectedRevision, currentRevision });
            }
            for (const candidate of task.candidates) {
                composeSupplierContactMessage(message, candidate.offerId);
            }
            const synchronizedCandidates = task.candidates.filter((candidate) => {
                const attempt = candidate.contactAttempt;
                return candidate.reviewStatus === 'approved'
                    && (!attempt || attempt.status === 'failed');
            });
            if (task.sharedContactDraft?.message === message) {
                return snapshot(task, state.tasks);
            }
            const timestamp = now();
            task.sharedContactDraft = {
                message,
                revision: currentRevision + 1,
                updatedAt: timestamp,
            };
            for (const candidate of synchronizedCandidates) {
                applySharedContactDraftToCandidate(candidate, task.sharedContactDraft, timestamp);
            }
            task.updatedAt = timestamp;
            await writeState(rootDir, statePath, state);
            return snapshot(task, state.tasks);
        });
    }
    async function saveSupplierReply(taskId, candidateIdValue, input) {
        assertEntityId(taskId, 'task');
        assertEntityId(candidateIdValue, 'candidate');
        const reply = normalizeSupplierReplyInput(input);
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = requireTask(state, taskId);
            assertContactableTask(task);
            const candidate = requireCandidate(task, candidateIdValue);
            if (candidate.reviewStatus !== 'approved') {
                throw storeError('PROCUREMENT_CONTACT_APPROVAL_REQUIRED', 'Approve this supplier before recording its reply.', { taskId, candidateId: candidateIdValue });
            }
            assertVerifiedContactEvidence(taskId, candidate);
            if (!task.confirmation
                || task.confirmation.confirmedMemberId !== reply.confirmedMemberId) {
                throw storeError('ACCOUNT_BINDING_CHANGED', 'The current 1688 account differs from the account that confirmed this product.', { taskId });
            }
            const currentRevision = candidate.supplierReply?.revision ?? 0;
            if (reply.expectedRevision !== currentRevision) {
                throw storeError('PROCUREMENT_SUPPLIER_REPLY_REVISION_CONFLICT', 'The supplier reply record changed in another view. Reload before saving.', {
                    taskId,
                    candidateId: candidateIdValue,
                    expectedRevision: reply.expectedRevision,
                    currentRevision,
                });
            }
            if (currentRevision >= Number.MAX_SAFE_INTEGER) {
                throw storeError('PROCUREMENT_SUPPLIER_REPLY_REVISION_CONFLICT', 'The supplier reply record cannot accept another revision.', { taskId, candidateId: candidateIdValue, currentRevision });
            }
            const captureRevision = candidate.supplierReplyCapture?.revision;
            if ((captureRevision !== undefined && reply.expectedCaptureRevision !== captureRevision)
                || (captureRevision === undefined && reply.expectedCaptureRevision !== undefined
                    && reply.expectedCaptureRevision !== 0)) {
                throw storeError('PROCUREMENT_SUPPLIER_REPLY_CAPTURE_CONFLICT', '厂家回复已更新，请刷新并核对最新回复后重新确认。', {
                    taskId,
                    candidateId: candidateIdValue,
                    expectedCaptureRevision: reply.expectedCaptureRevision,
                    currentCaptureRevision: captureRevision ?? 0,
                });
            }
            const timestamp = now();
            const previous = candidate.supplierReply;
            const { confirmed: _confirmed, confirmedMemberId, expectedRevision: _expectedRevision, expectedCaptureRevision: _expectedCaptureRevision, ...fields } = reply;
            candidate.supplierReply = {
                ...fields,
                source: 'manual_1688_chat_attestation',
                revision: currentRevision + 1,
                ...(captureRevision === undefined ? {} : { captureRevision }),
                recordedAt: previous?.recordedAt ?? timestamp,
                attestedAt: timestamp,
                attestedMemberId: confirmedMemberId,
                updatedAt: timestamp,
            };
            candidate.updatedAt = timestamp;
            task.updatedAt = timestamp;
            await writeState(rootDir, statePath, state);
            return snapshot(task, state.tasks);
        });
    }
    async function recordSupplierReplyCapture(taskId, candidateIdValue, input) {
        assertEntityId(taskId, 'task');
        assertEntityId(candidateIdValue, 'candidate');
        const capture = normalizeSupplierReplyCaptureInput(input);
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = requireTask(state, taskId);
            assertContactableTask(task);
            const candidate = requireCandidate(task, candidateIdValue);
            if (candidate.reviewStatus !== 'approved') {
                throw storeError('PROCUREMENT_CONTACT_APPROVAL_REQUIRED', 'Approve this supplier before synchronizing its reply.', { taskId, candidateId: candidateIdValue });
            }
            assertVerifiedContactEvidence(taskId, candidate);
            if (!task.confirmation
                || task.confirmation.confirmedMemberId !== capture.confirmedMemberId) {
                throw storeError('ACCOUNT_BINDING_CHANGED', 'The current 1688 account differs from the account that confirmed this product.', { taskId });
            }
            const currentRevision = candidate.supplierReplyCapture?.revision ?? 0;
            if (capture.expectedRevision !== currentRevision) {
                throw storeError('PROCUREMENT_SUPPLIER_REPLY_CAPTURE_CONFLICT', 'The synchronized supplier reply changed in another view. Reload before retrying.', {
                    taskId,
                    candidateId: candidateIdValue,
                    expectedRevision: capture.expectedRevision,
                    currentRevision,
                });
            }
            const timestamp = now();
            const previous = candidate.supplierReplyCapture;
            const merged = mergeSupplierReplyCapture(previous, capture);
            if (previous
                && JSON.stringify(previous.messages) === JSON.stringify(merged.messages)
                && JSON.stringify(previous.analysis) === JSON.stringify(merged.analysis)) {
                return snapshot(task, state.tasks);
            }
            candidate.supplierReplyCapture = {
                source: 'automatic_1688_chat_capture',
                messages: merged.messages,
                analysis: merged.analysis,
                revision: currentRevision + 1,
                firstCapturedAt: previous?.firstCapturedAt ?? timestamp,
                lastSyncedAt: timestamp,
                updatedAt: timestamp,
            };
            candidate.updatedAt = timestamp;
            task.updatedAt = timestamp;
            await writeState(rootDir, statePath, state);
            return snapshot(task, state.tasks);
        });
    }
    async function prepareContactSend(taskId, candidateIdValue, input) {
        assertEntityId(taskId, 'task');
        assertEntityId(candidateIdValue, 'candidate');
        const attemptId = normalizeAttemptId(input?.attemptId);
        const expectedRevision = normalizeContactRevision(input?.expectedRevision);
        const confirmedMemberId = normalizeMemberId(input?.confirmedMemberId);
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = requireTask(state, taskId);
            assertContactableTask(task);
            if (!task.confirmation || task.confirmation.confirmedMemberId !== confirmedMemberId) {
                throw storeError('ACCOUNT_BINDING_CHANGED', 'The current 1688 account differs from the account that confirmed this product.', { taskId });
            }
            const candidate = requireCandidate(task, candidateIdValue);
            if (candidate.reviewStatus !== 'approved') {
                throw storeError('PROCUREMENT_CONTACT_APPROVAL_REQUIRED', 'Approve this supplier before contacting it.', { taskId, candidateId: candidateIdValue });
            }
            const draft = candidate.contactDraft;
            if (!draft) {
                throw storeError('PROCUREMENT_CONTACT_DRAFT_REQUIRED', 'Save an editable contact draft before sending.', { taskId, candidateId: candidateIdValue });
            }
            if (draft.revision !== expectedRevision) {
                throw storeError('PROCUREMENT_CONTACT_DRAFT_CONFLICT', 'The saved contact draft no longer matches the confirmed preview.', { taskId, candidateId: candidateIdValue, expectedRevision, currentRevision: draft.revision });
            }
            const suppliedLoginId = input.supplierLoginId === undefined
                ? undefined
                : normalizeSupplierLoginId(input.supplierLoginId);
            const suppliedMemberId = input.supplierMemberId === undefined
                ? undefined
                : normalizeSupplierMemberId(input.supplierMemberId);
            if ((suppliedLoginId === undefined) !== (suppliedMemberId === undefined)) {
                throw storeError('PROCUREMENT_CONTACT_SUPPLIER_INVALID', 'Supplier login ID and member ID must be resolved together.');
            }
            if (suppliedLoginId
                && candidate.supplierLoginId
                && suppliedLoginId !== candidate.supplierLoginId) {
                throw storeError('PROCUREMENT_CONTACT_SUPPLIER_CHANGED', 'The supplier login ID changed after candidate review.');
            }
            if (suppliedMemberId
                && candidate.supplierMemberId
                && suppliedMemberId !== candidate.supplierMemberId) {
                throw storeError('PROCUREMENT_CONTACT_SUPPLIER_CHANGED', 'The supplier member ID changed after candidate review.');
            }
            if (suppliedLoginId && suppliedMemberId) {
                candidate.supplierLoginId = suppliedLoginId;
                candidate.supplierMemberId = suppliedMemberId;
            }
            if (candidate.contactAttempt && candidate.contactAttempt.status !== 'failed') {
                throw contactAttemptConflict(taskId, candidateIdValue, candidate.contactAttempt.status);
            }
            if (!candidate.supplierMemberId) {
                throw storeError('PROCUREMENT_CONTACT_SUPPLIER_INVALID', 'A stable 1688 supplier member ID is required before contacting this supplier.', { taskId, candidateId: candidateIdValue });
            }
            if (!candidate.supplierLoginId) {
                throw storeError('PROCUREMENT_CONTACT_SUPPLIER_INVALID', 'A verified 1688 supplier login ID is required before contacting this supplier.', { taskId, candidateId: candidateIdValue });
            }
            assertNoSiblingContactEvidence(task, candidate, candidate.supplierLoginId);
            const finalMessage = composeSupplierContactMessage(draft.message, candidate.offerId);
            const timestamp = now();
            candidate.contactAttempt = {
                id: attemptId,
                status: 'prepared',
                draftRevision: draft.revision,
                messageSha256: contactMessageSha256(finalMessage),
                messageFormat: SUPPLIER_CONTACT_MESSAGE_FORMAT,
                confirmedMemberId,
                supplierMemberId: candidate.supplierMemberId,
                preparedAt: timestamp,
                ...(candidate.supplierLoginId ? { supplierLoginId: candidate.supplierLoginId } : {}),
            };
            candidate.updatedAt = timestamp;
            task.updatedAt = timestamp;
            await writeState(rootDir, statePath, state);
            return snapshot(task, state.tasks);
        });
    }
    async function resolveContactSupplier(taskId, candidateIdValue, input) {
        assertEntityId(taskId, 'task');
        assertEntityId(candidateIdValue, 'candidate');
        const expectedRevision = normalizeContactRevision(input?.expectedRevision);
        const confirmedMemberId = normalizeMemberId(input?.confirmedMemberId);
        const supplierLoginId = normalizeSupplierLoginId(input?.supplierLoginId);
        const supplierMemberId = normalizeSupplierMemberId(input?.supplierMemberId);
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = requireTask(state, taskId);
            assertContactableTask(task);
            if (!task.confirmation || task.confirmation.confirmedMemberId !== confirmedMemberId) {
                throw storeError('ACCOUNT_BINDING_CHANGED', 'The current 1688 account differs from the account that confirmed this product.', { taskId });
            }
            const candidate = requireCandidate(task, candidateIdValue);
            if (candidate.reviewStatus !== 'approved') {
                throw storeError('PROCUREMENT_CONTACT_APPROVAL_REQUIRED', 'Approve this supplier before contacting it.', { taskId, candidateId: candidateIdValue });
            }
            const draft = candidate.contactDraft;
            if (!draft) {
                throw storeError('PROCUREMENT_CONTACT_DRAFT_REQUIRED', 'Save an editable contact draft before resolving the supplier identity.', { taskId, candidateId: candidateIdValue });
            }
            if (draft.revision !== expectedRevision) {
                throw storeError('PROCUREMENT_CONTACT_DRAFT_CONFLICT', 'The saved contact draft no longer matches the confirmed preview.', { taskId, candidateId: candidateIdValue, expectedRevision, currentRevision: draft.revision });
            }
            if (candidate.contactAttempt && candidate.contactAttempt.status !== 'failed') {
                throw contactAttemptConflict(taskId, candidateIdValue, candidate.contactAttempt.status);
            }
            if ((candidate.supplierLoginId && candidate.supplierLoginId !== supplierLoginId)
                || (candidate.supplierMemberId && candidate.supplierMemberId !== supplierMemberId)) {
                throw storeError('PROCUREMENT_CONTACT_SUPPLIER_CHANGED', 'The supplier identity changed after candidate review.');
            }
            candidate.supplierLoginId = supplierLoginId;
            candidate.supplierMemberId = supplierMemberId;
            assertNoSiblingContactEvidence(task, candidate, supplierLoginId);
            const timestamp = now();
            candidate.updatedAt = timestamp;
            task.updatedAt = timestamp;
            await writeState(rootDir, statePath, state);
            return snapshot(task, state.tasks);
        });
    }
    async function recordContactProgress(taskId, candidateIdValue, input) {
        assertEntityId(taskId, 'task');
        assertEntityId(candidateIdValue, 'candidate');
        const attemptId = normalizeAttemptId(input?.attemptId);
        const event = input?.event;
        if (event !== 'message_click_started') {
            throw storeError('PROCUREMENT_CONTACT_PROGRESS_INVALID', 'Contact progress event is invalid.');
        }
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = requireTask(state, taskId);
            const candidate = requireCandidate(task, candidateIdValue);
            const attempt = requireContactAttempt(candidate, attemptId, taskId);
            const timestamp = now();
            if (attempt.status !== 'prepared' || !attempt.supplierLoginId) {
                throw contactTransitionConflict(attempt, event);
            }
            attempt.status = 'message_click_started';
            attempt.messageClickStartedAt = timestamp;
            candidate.updatedAt = timestamp;
            task.updatedAt = timestamp;
            await writeState(rootDir, statePath, state);
            return snapshot(task, state.tasks);
        });
    }
    async function completeContactSend(taskId, candidateIdValue, input) {
        assertEntityId(taskId, 'task');
        assertEntityId(candidateIdValue, 'candidate');
        const attemptId = normalizeAttemptId(input?.attemptId);
        const sentTo = requiredText(input?.sentTo, 'sentTo', 300);
        const sentAt = normalizeNow(requiredText(input?.sentAt, 'sentAt', 64));
        const conversationId = requiredText(input?.conversationId, 'conversationId', 512);
        const messageId = requiredText(input?.messageId, 'messageId', 256);
        if (!isVerifiedContactReceiptSource(input?.receiptSource)) {
            throw storeError('PROCUREMENT_CONTACT_RECEIPT_INVALID', 'A verified 1688 WebSocket receipt or matching message-history record is required before marking contact sent.');
        }
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = requireTask(state, taskId);
            const candidate = requireCandidate(task, candidateIdValue);
            const attempt = requireContactAttempt(candidate, attemptId, taskId);
            const draft = candidate.contactDraft;
            if (!draft
                || draft.revision !== attempt.draftRevision
                || contactMessageSha256(contactMessageForAttempt(candidate, draft, attempt))
                    !== attempt.messageSha256) {
                throw storeError('PROCUREMENT_CONTACT_DRAFT_CONFLICT', 'The current contact draft does not exactly match the message that was sent.', { taskId, candidateId: candidateIdValue });
            }
            if (attempt.status === 'sent')
                return snapshot(task, state.tasks);
            if (attempt.status !== 'message_click_started') {
                throw contactTransitionConflict(attempt, 'sent');
            }
            attempt.status = 'sent';
            attempt.sentAt = sentAt;
            attempt.sentTo = sentTo;
            attempt.conversationId = conversationId;
            attempt.messageId = messageId;
            attempt.receiptSource = input.receiptSource;
            candidate.updatedAt = sentAt;
            task.updatedAt = sentAt;
            await writeState(rootDir, statePath, state);
            return snapshot(task, state.tasks);
        });
    }
    async function reconcileContactSend(taskId, candidateIdValue, input) {
        assertEntityId(taskId, 'task');
        assertEntityId(candidateIdValue, 'candidate');
        const attemptId = normalizeAttemptId(input?.attemptId);
        const expectedRevision = normalizeContactRevision(input?.expectedRevision);
        const confirmedMemberId = normalizeMemberId(input?.confirmedMemberId);
        const supplierLoginId = normalizeSupplierLoginId(input?.supplierLoginId);
        const supplierMemberId = normalizeSupplierMemberId(input?.supplierMemberId);
        const sentAt = normalizeNow(requiredText(input?.sentAt, 'sentAt', 64));
        const conversationId = requiredText(input?.conversationId, 'conversationId', 512);
        const messageId = requiredText(input?.messageId, 'messageId', 256);
        if (input?.receiptSource !== '1688_ws_history') {
            throw storeError('PROCUREMENT_CONTACT_RECEIPT_INVALID', 'Verified 1688 WebSocket history is required to reconcile an unknown delivery.');
        }
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = requireTask(state, taskId);
            assertContactableTask(task);
            const candidate = requireCandidate(task, candidateIdValue);
            const attempt = requireContactAttempt(candidate, attemptId, taskId);
            const draft = candidate.contactDraft;
            if (candidate.reviewStatus !== 'approved'
                || !task.confirmation
                || task.confirmation.confirmedMemberId !== confirmedMemberId
                || attempt.confirmedMemberId !== confirmedMemberId) {
                throw storeError('ACCOUNT_BINDING_CHANGED', 'The current 1688 account differs from the account bound to this contact attempt.', { taskId, candidateId: candidateIdValue });
            }
            if (!draft
                || draft.revision !== expectedRevision
                || attempt.draftRevision !== expectedRevision
                || contactMessageSha256(contactMessageForAttempt(candidate, draft, attempt))
                    !== attempt.messageSha256) {
                throw storeError('PROCUREMENT_CONTACT_DRAFT_CONFLICT', 'The current contact draft does not exactly match the message that was sent.', { taskId, candidateId: candidateIdValue, expectedRevision });
            }
            if (candidate.supplierLoginId !== supplierLoginId
                || candidate.supplierMemberId !== supplierMemberId
                || attempt.supplierLoginId !== supplierLoginId
                || attempt.supplierMemberId !== supplierMemberId) {
                throw storeError('PROCUREMENT_CONTACT_SUPPLIER_CHANGED', 'The supplier identity differs from the contact attempt binding.', { taskId, candidateId: candidateIdValue });
            }
            if (attempt.status === 'sent') {
                if (attempt.receiptSource === '1688_ws_history'
                    && attempt.sentAt === sentAt
                    && attempt.sentTo === supplierLoginId
                    && attempt.conversationId === conversationId
                    && attempt.messageId === messageId) {
                    return snapshot(task, state.tasks);
                }
                throw contactTransitionConflict(attempt, 'reconciled_sent');
            }
            if (attempt.status !== 'delivery_unknown' || !isIsoTimestamp(attempt.messageClickStartedAt)) {
                throw contactTransitionConflict(attempt, 'reconciled_sent');
            }
            const clickTime = new Date(attempt.messageClickStartedAt).getTime();
            const historyTime = new Date(sentAt).getTime();
            if (historyTime + CONTACT_HISTORY_TIMESTAMP_TOLERANCE_MS < clickTime) {
                throw storeError('PROCUREMENT_CONTACT_HISTORY_TIME_INVALID', 'The matching 1688 history message predates the recorded send click.', { taskId, candidateId: candidateIdValue });
            }
            attempt.status = 'sent';
            attempt.sentAt = sentAt;
            attempt.sentTo = supplierLoginId;
            attempt.conversationId = conversationId;
            attempt.messageId = messageId;
            attempt.receiptSource = '1688_ws_history';
            delete attempt.errorCode;
            delete attempt.errorMessage;
            delete attempt.failedAt;
            const timestamp = now();
            candidate.updatedAt = timestamp;
            task.updatedAt = timestamp;
            await writeState(rootDir, statePath, state);
            return snapshot(task, state.tasks);
        });
    }
    async function failContactSend(taskId, candidateIdValue, input) {
        assertEntityId(taskId, 'task');
        assertEntityId(candidateIdValue, 'candidate');
        const attemptId = normalizeAttemptId(input?.attemptId);
        const code = requiredText(input?.code, 'contact error code', 128);
        const message = requiredText(input?.message, 'contact error message', 400);
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = requireTask(state, taskId);
            const candidate = requireCandidate(task, candidateIdValue);
            const attempt = requireContactAttempt(candidate, attemptId, taskId);
            if (attempt.status === 'sent') {
                throw storeError('PROCUREMENT_CONTACT_ALREADY_SENT', 'This supplier was already contacted.');
            }
            const clicked = attempt.status === 'message_click_started';
            const deliveryUnknown = attempt.status === 'delivery_unknown'
                || input.deliveryUnknown === true
                || clicked;
            const timestamp = now();
            attempt.status = deliveryUnknown ? 'delivery_unknown' : 'failed';
            attempt.errorCode = code;
            attempt.errorMessage = message;
            attempt.failedAt = timestamp;
            candidate.updatedAt = timestamp;
            task.updatedAt = timestamp;
            await writeState(rootDir, statePath, state);
            return snapshot(task, state.tasks);
        });
    }
    async function getImage(taskId) {
        assertEntityId(taskId, 'task');
        return locked(async () => {
            const state = await readState(rootDir, statePath);
            const task = state.tasks.find((item) => item.id === taskId);
            if (!task)
                return null;
            const imagePath = managedImagePath(rootDir, imagesDir, task.imagePath);
            await assertNoReparsePath(imagePath);
            const stat = await fs.stat(imagePath).catch((error) => {
                if (error.code === 'ENOENT') {
                    throw storeError('PROCUREMENT_IMAGE_MISSING', `Image for task ${taskId} is missing.`, {
                        taskId,
                    });
                }
                throw error;
            });
            if (!stat.isFile() || stat.size !== task.imageSize || stat.size > MAX_PROCUREMENT_IMAGE_BYTES) {
                throw storeError('PROCUREMENT_IMAGE_INVALID', `Image for task ${taskId} is invalid.`, {
                    taskId,
                });
            }
            const image = await fs.readFile(imagePath);
            validateImage(image, task.imageMimeType);
            const digest = crypto.createHash('sha256').update(image).digest('hex');
            if (digest !== task.imageSha256) {
                throw storeError('PROCUREMENT_IMAGE_CHANGED', `Image for task ${taskId} has changed.`, {
                    taskId,
                });
            }
            return {
                path: imagePath,
                mimeType: task.imageMimeType,
                size: stat.size,
                sha256: task.imageSha256,
            };
        });
    }
    return {
        rootDir,
        createTask,
        createTasksFromImport,
        createAndQueueTasksFromImport,
        deleteTask,
        confirmAndQueue,
        confirmAndQueueMany,
        claimNext,
        blockTaskForRisk,
        retrySearch,
        recordSearchProgress,
        completeSearch,
        recordCandidateStrength,
        failTask,
        reviewCandidate,
        saveContactDraft,
        saveSharedContactDraft,
        saveSupplierReply,
        recordSupplierReplyCapture,
        resolveContactSupplier,
        prepareContactSend,
        recordContactProgress,
        completeContactSend,
        reconcileContactSend,
        failContactSend,
        listTasks,
        getTask,
        getImage,
    };
}
function normalizeRoot(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw storeError('PROCUREMENT_ROOT_REQUIRED', 'A procurement data root is required.');
    }
    const raw = value.trim();
    if (!path.win32.isAbsolute(raw)) {
        throw storeError('PROCUREMENT_ROOT_ABSOLUTE_REQUIRED', 'The procurement data root must be absolute.');
    }
    if (raw.split(/[\\/]+/).includes('..')) {
        throw storeError('PROCUREMENT_PATH_ESCAPE', 'The procurement data root cannot contain traversal.');
    }
    const resolved = path.win32.resolve(raw);
    if (path.win32.parse(resolved).root.toLocaleLowerCase('en-US') !== WINDOWS_DRIVE_ROOT) {
        throw storeError('PROCUREMENT_ROOT_DRIVE_REQUIRED', 'The procurement data root must be on D:.');
    }
    if (canonicalWindowsPath(resolved) === WINDOWS_DRIVE_ROOT) {
        throw storeError('PROCUREMENT_ROOT_TOO_BROAD', 'The procurement data root cannot be the D: root.');
    }
    return resolved.replace(/[\\/]+$/, '');
}
function managedPath(rootDir, ...parts) {
    for (const part of parts) {
        if (typeof part !== 'string' || part.includes('\0') || path.win32.isAbsolute(part)) {
            throw storeError('PROCUREMENT_PATH_ESCAPE', 'Managed paths must be relative to the data root.');
        }
    }
    const candidate = path.win32.resolve(rootDir, ...parts);
    assertWithin(rootDir, candidate);
    return candidate;
}
function managedImagePath(rootDir, imagesDir, relativePath) {
    const imagePath = managedPath(rootDir, relativePath);
    assertWithin(imagesDir, imagePath);
    return imagePath;
}
function assertWithin(parent, candidate) {
    const relative = path.win32.relative(parent, candidate);
    if (relative === '' || (!relative.startsWith('..\\') && relative !== '..' && !path.win32.isAbsolute(relative))) {
        return;
    }
    throw storeError('PROCUREMENT_PATH_ESCAPE', 'A managed path escaped the procurement data root.');
}
async function ensureManagedDirectories(rootDir, imagesDir) {
    await assertNoReparsePath(rootDir);
    await fs.mkdir(rootDir, { recursive: true });
    await assertNoReparsePath(rootDir);
    await fs.mkdir(imagesDir, { recursive: true });
    await assertNoReparsePath(imagesDir);
}
async function assertNoReparsePath(target) {
    const absolute = path.win32.resolve(target);
    const parsed = path.win32.parse(absolute);
    const components = absolute.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
    let current = parsed.root;
    for (const component of components) {
        current = path.win32.join(current, component);
        try {
            const stat = await fs.lstat(current);
            if (stat.isSymbolicLink()) {
                throw storeError('PROCUREMENT_REPARSE_POINT', 'Reparse points are not allowed in procurement paths.', {
                    path: current,
                });
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    try {
        const real = await fs.realpath(absolute);
        if (canonicalWindowsPath(real) !== canonicalWindowsPath(absolute)) {
            throw storeError('PROCUREMENT_REPARSE_POINT', 'Reparse points are not allowed in procurement paths.', {
                path: absolute,
            });
        }
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
async function reconcileDeletedImageTombstones(rootDir, state) {
    const imagesDir = managedPath(rootDir, 'images');
    await assertNoReparsePath(imagesDir);
    let entries;
    try {
        entries = await fs.readdir(imagesDir, { withFileTypes: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    const tombstonesByTask = new Map();
    for (const entry of entries) {
        const match = entry.isFile() ? entry.name.match(DELETED_IMAGE_TOMBSTONE) : null;
        const taskId = match?.[1];
        if (!taskId)
            continue;
        const paths = tombstonesByTask.get(taskId) ?? [];
        paths.push(managedPath(rootDir, 'images', entry.name));
        tombstonesByTask.set(taskId, paths);
    }
    for (const [taskId, tombstones] of tombstonesByTask) {
        const task = state.tasks.find((item) => item.id === taskId);
        if (!task) {
            for (const tombstone of tombstones) {
                await fs.rm(tombstone, { force: true }).catch(() => undefined);
            }
            continue;
        }
        const imagePath = managedImagePath(rootDir, imagesDir, task.imagePath);
        let imageExists = false;
        try {
            const imageStat = await fs.lstat(imagePath);
            if (!imageStat.isFile() || imageStat.isSymbolicLink()) {
                throw storeError('PROCUREMENT_IMAGE_INVALID', `Image for task ${taskId} is invalid during delete recovery.`, { taskId });
            }
            imageExists = true;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
        if (imageExists) {
            for (const tombstone of tombstones) {
                await fs.rm(tombstone, { force: true }).catch(() => undefined);
            }
            continue;
        }
        if (tombstones.length !== 1) {
            throw storeError('PROCUREMENT_DELETE_RECOVERY_CONFLICT', `Task ${taskId} has ambiguous deleted-image recovery files.`, { taskId, tombstoneCount: tombstones.length });
        }
        await fs.rename(tombstones[0], imagePath);
    }
}
async function readState(rootDir, statePath) {
    await assertNoReparsePath(rootDir);
    try {
        const rootStat = await fs.stat(rootDir);
        if (!rootStat.isDirectory()) {
            throw storeError('PROCUREMENT_ROOT_INVALID', 'The procurement data root is not a directory.');
        }
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return emptyState();
        throw error;
    }
    await assertNoReparsePath(statePath);
    let text;
    try {
        text = await fs.readFile(statePath, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            const state = emptyState();
            await reconcileDeletedImageTombstones(rootDir, state);
            return state;
        }
        throw error;
    }
    try {
        const parsed = JSON.parse(text);
        const state = validateState(parsed, rootDir);
        await reconcileDeletedImageTombstones(rootDir, state);
        return state;
    }
    catch (error) {
        if (error instanceof ProcurementStoreError)
            throw error;
        throw storeError('PROCUREMENT_STATE_INVALID', 'The procurement state file is invalid.', {
            cause: error instanceof Error ? error.message : String(error),
        });
    }
}
async function writeState(rootDir, statePath, state) {
    await ensureManagedDirectories(rootDir, managedPath(rootDir, 'images'));
    const data = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await writeFileAtomically(rootDir, statePath, data, true);
}
async function writeFileAtomically(rootDir, targetPath, data, replace = false) {
    assertWithin(rootDir, targetPath);
    await assertNoReparsePath(path.win32.dirname(targetPath));
    await assertNoReparsePath(targetPath);
    if (!replace) {
        try {
            await fs.lstat(targetPath);
            throw storeError('PROCUREMENT_FILE_CONFLICT', 'A managed file already exists.', {
                path: targetPath,
            });
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    const tempPath = managedPath(rootDir, `.${path.win32.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
        handle = await fs.open(tempPath, 'wx', 0o600);
        await handle.writeFile(data);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await assertNoReparsePath(targetPath);
        await fs.rename(tempPath, targetPath);
        await syncDirectory(path.win32.dirname(targetPath));
    }
    catch (error) {
        await handle?.close().catch(() => undefined);
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
    }
}
async function syncDirectory(directory) {
    let handle;
    try {
        handle = await fs.open(directory, 'r');
        await handle.sync();
    }
    catch (error) {
        const code = error.code;
        if (!['EACCES', 'EISDIR', 'EINVAL', 'EPERM'].includes(code ?? ''))
            throw error;
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
function emptyState() {
    return { version: STATE_VERSION, nextQueueSequence: 1, tasks: [] };
}
function validateState(value, rootDir) {
    if (!isRecord(value) || value.version !== STATE_VERSION || !Array.isArray(value.tasks)) {
        throw storeError('PROCUREMENT_STATE_INVALID', 'The procurement state file has an unsupported shape.');
    }
    const tasks = value.tasks;
    const seenIds = new Set();
    const seenImportRows = new Set();
    let maximumSequence = 0;
    for (const task of tasks) {
        if (!isRecord(task) || typeof task.id !== 'string' || !ENTITY_ID.test(task.id)) {
            throw storeError('PROCUREMENT_STATE_INVALID', 'The procurement state contains an invalid task ID.');
        }
        if (seenIds.has(task.id)) {
            throw storeError('PROCUREMENT_STATE_INVALID', 'The procurement state contains duplicate task IDs.');
        }
        seenIds.add(task.id);
        if (!PROCUREMENT_TASK_STATUSES.includes(task.status)) {
            throw storeError('PROCUREMENT_STATE_INVALID', `Task ${task.id} has an invalid status.`);
        }
        if (!Array.isArray(task.candidates) || typeof task.imagePath !== 'string') {
            throw storeError('PROCUREMENT_STATE_INVALID', `Task ${task.id} is incomplete.`);
        }
        if (task.imageSource !== undefined
            && !PROCUREMENT_TASK_IMAGE_SOURCES.includes(task.imageSource)) {
            throw storeError('PROCUREMENT_STATE_INVALID', `Task ${task.id} has an invalid image source.`);
        }
        if (task.importBatchId !== undefined
            && (typeof task.importBatchId !== 'string' || !ENTITY_ID.test(task.importBatchId))) {
            throw storeError('PROCUREMENT_STATE_INVALID', `Task ${task.id} has an invalid import batch ID.`);
        }
        if (task.importRowNumber !== undefined) {
            if (task.importBatchId === undefined
                || !Number.isInteger(task.importRowNumber)
                || task.importRowNumber < 1
                || task.importRowNumber > 1_048_576) {
                throw storeError('PROCUREMENT_STATE_INVALID', `Task ${task.id} has an invalid import row.`);
            }
            const importRowKey = `${task.importBatchId}\0${task.importRowNumber}`;
            if (seenImportRows.has(importRowKey)) {
                throw storeError('PROCUREMENT_STATE_INVALID', `Import batch ${task.importBatchId} contains duplicate worksheet rows.`);
            }
            seenImportRows.add(importRowKey);
        }
        validatePersistedImportSource(task);
        if (task.searchProgress !== undefined) {
            const progress = task.searchProgress;
            if (!isRecord(progress)
                || typeof progress.phase !== 'string'
                || !PROCUREMENT_SEARCH_PROGRESS_PHASES.includes(progress.phase)
                || !isIsoTimestamp(progress.startedAt)
                || !isIsoTimestamp(progress.updatedAt)
                || (progress.candidatesFound !== undefined
                    && (!Number.isInteger(progress.candidatesFound) || progress.candidatesFound < 0))) {
                throw storeError('PROCUREMENT_STATE_INVALID', `Task ${task.id} has invalid search progress.`);
            }
        }
        const sharedDraft = task.sharedContactDraft;
        if (sharedDraft !== undefined) {
            if (!isRecord(sharedDraft)
                || !Number.isInteger(sharedDraft.revision)
                || sharedDraft.revision < 1
                || normalizeContactMessage(sharedDraft.message) !== sharedDraft.message
                || !isIsoTimestamp(sharedDraft.updatedAt)) {
                throw storeError('PROCUREMENT_STATE_INVALID', `Task ${task.id} has an invalid shared contact draft.`);
            }
        }
        const seenCandidateIds = new Set();
        for (const candidate of task.candidates) {
            validatePersistedCandidate(task.id, candidate, seenCandidateIds);
            const attempt = candidate.contactAttempt;
            if (sharedDraft
                && candidate.reviewStatus === 'approved'
                && (!attempt || attempt.status === 'failed')
                && candidate.contactDraft?.message !== sharedDraft.message) {
                throw storeError('PROCUREMENT_STATE_INVALID', `Candidate ${candidate.id} does not match task ${task.id}'s shared contact draft.`);
            }
        }
        validatePersistedContactUniqueness(task.id, task.candidates);
        managedImagePath(rootDir, managedPath(rootDir, 'images'), task.imagePath);
        if (task.queueSequence !== undefined) {
            if (!Number.isInteger(task.queueSequence) || task.queueSequence < 1) {
                throw storeError('PROCUREMENT_STATE_INVALID', `Task ${task.id} has an invalid queue sequence.`);
            }
            maximumSequence = Math.max(maximumSequence, task.queueSequence);
        }
    }
    const suppliedNext = value.nextQueueSequence;
    const nextQueueSequence = typeof suppliedNext === 'number' && Number.isInteger(suppliedNext)
        ? Math.max(suppliedNext, maximumSequence + 1, 1)
        : maximumSequence + 1;
    return { version: STATE_VERSION, nextQueueSequence, tasks: structuredClone(tasks) };
}
function validatePersistedCandidate(taskId, value, seenIds) {
    if (!isRecord(value) || typeof value.id !== 'string' || !ENTITY_ID.test(value.id)) {
        throw storeError('PROCUREMENT_STATE_INVALID', `Task ${taskId} has an invalid candidate.`);
    }
    if (seenIds.has(value.id)) {
        throw storeError('PROCUREMENT_STATE_INVALID', `Task ${taskId} has duplicate candidate IDs.`);
    }
    seenIds.add(value.id);
    if (!['pending', 'approved', 'rejected'].includes(value.reviewStatus)) {
        throw storeError('PROCUREMENT_STATE_INVALID', `Candidate ${value.id} has an invalid review status.`);
    }
    if (value.supplierLoginId !== undefined
        && (typeof value.supplierLoginId !== 'string'
            || value.supplierLoginId.normalize('NFC') !== value.supplierLoginId
            || !SUPPLIER_LOGIN_ID.test(value.supplierLoginId))) {
        throw storeError('PROCUREMENT_STATE_INVALID', 'Candidate has an invalid supplier identity.');
    }
    if (value.supplierMemberId !== undefined && !isSupplierMemberId(value.supplierMemberId)) {
        throw storeError('PROCUREMENT_STATE_INVALID', 'Candidate has an invalid supplier member ID.');
    }
    validatePersistedCandidateStrength(value);
    const draft = value.contactDraft;
    if (draft !== undefined) {
        if (!isRecord(draft)
            || !Number.isInteger(draft.revision)
            || draft.revision < 1
            || normalizeContactMessage(draft.message) !== draft.message
            || !isIsoTimestamp(draft.updatedAt)) {
            throw storeError('PROCUREMENT_STATE_INVALID', `Candidate ${value.id} has an invalid contact draft.`);
        }
    }
    const attempt = value.contactAttempt;
    const supplierReply = value.supplierReply;
    const supplierReplyCapture = value.supplierReplyCapture;
    if (attempt === undefined) {
        if (supplierReply !== undefined || supplierReplyCapture !== undefined) {
            throw storeError('PROCUREMENT_STATE_INVALID', `Candidate ${value.id} has a supplier reply without verified contact evidence.`);
        }
        return;
    }
    if (!isRecord(attempt)
        || typeof attempt.id !== 'string'
        || !ENTITY_ID.test(attempt.id)
        || !PROCUREMENT_CONTACT_ATTEMPT_STATUSES.includes(attempt.status)
        || !Number.isInteger(attempt.draftRevision)
        || attempt.draftRevision < 1
        || typeof attempt.messageSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(attempt.messageSha256)
        || (attempt.messageFormat !== undefined
            && attempt.messageFormat !== SUPPLIER_CONTACT_MESSAGE_FORMAT)
        || !/^[A-Za-z0-9]{1,128}$/.test(attempt.confirmedMemberId)
        || !isSupplierMemberId(attempt.supplierMemberId)
        || !isIsoTimestamp(attempt.preparedAt)) {
        throw storeError('PROCUREMENT_STATE_INVALID', `Candidate ${value.id} has invalid contact evidence.`);
    }
    if (attempt.supplierLoginId !== undefined && !SUPPLIER_LOGIN_ID.test(attempt.supplierLoginId)) {
        throw storeError('PROCUREMENT_STATE_INVALID', `Candidate ${value.id} has an invalid supplier identity.`);
    }
    if (attempt.supplierMemberId !== value.supplierMemberId) {
        throw storeError('PROCUREMENT_STATE_INVALID', `Candidate ${value.id} has mismatched supplier member evidence.`);
    }
    if (attempt.status !== 'failed'
        && (!draft
            || draft.revision !== attempt.draftRevision
            || !persistedContactMessageMatchesAttempt(value, draft, attempt))) {
        throw storeError('PROCUREMENT_STATE_INVALID', `Candidate ${value.id} has mismatched contact evidence.`);
    }
    if (attempt.status === 'sent'
        && (!isIsoTimestamp(attempt.sentAt)
            || !attempt.sentTo
            || typeof attempt.conversationId !== 'string'
            || attempt.conversationId.length < 1
            || attempt.conversationId.length > 512
            || typeof attempt.messageId !== 'string'
            || attempt.messageId.length < 1
            || attempt.messageId.length > 256
            || !isVerifiedContactReceiptSource(attempt.receiptSource)
            || (attempt.receiptSource === '1688_ws_history'
                && (!isIsoTimestamp(attempt.messageClickStartedAt)
                    || new Date(attempt.sentAt).getTime() + CONTACT_HISTORY_TIMESTAMP_TOLERANCE_MS
                        < new Date(attempt.messageClickStartedAt).getTime()))
            || attempt.errorCode !== undefined
            || attempt.errorMessage !== undefined
            || attempt.failedAt !== undefined)) {
        throw storeError('PROCUREMENT_STATE_INVALID', `Candidate ${value.id} lacks sent evidence.`);
    }
    if ((attempt.status === 'failed' || attempt.status === 'delivery_unknown')
        && (!attempt.errorCode || !attempt.errorMessage || !isIsoTimestamp(attempt.failedAt))) {
        throw storeError('PROCUREMENT_STATE_INVALID', `Candidate ${value.id} lacks failure evidence.`);
    }
    if (supplierReply !== undefined) {
        if (value.reviewStatus !== 'approved') {
            throw storeError('PROCUREMENT_STATE_INVALID', `Candidate ${value.id} has a supplier reply without an approved review.`);
        }
        validatePersistedSupplierReply(value.id, supplierReply, attempt);
    }
    if (supplierReplyCapture !== undefined) {
        if (value.reviewStatus !== 'approved') {
            throw storeError('PROCUREMENT_STATE_INVALID', `Candidate ${value.id} has a synchronized reply without an approved review.`);
        }
        validatePersistedSupplierReplyCapture(value.id, supplierReplyCapture, attempt);
    }
    if (isRecord(supplierReply)
        && supplierReply.captureRevision !== undefined
        && (!isRecord(supplierReplyCapture)
            || Number(supplierReply.captureRevision) > Number(supplierReplyCapture.revision))) {
        throw storeError('PROCUREMENT_STATE_INVALID', `Candidate ${value.id} has a supplier confirmation without its captured reply revision.`);
    }
}
function validatePersistedCandidateStrength(value) {
    const invalid = (message) => storeError('PROCUREMENT_STATE_INVALID', `Candidate ${String(value.id)} has invalid supplier strength evidence: ${message}`);
    if (!isOptionalMetric(value.productRepurchaseRate, 0, 100)) {
        throw invalid('productRepurchaseRate must be from 0 to 100.');
    }
    if (!isOptionalMetric(value.supplierRepeatRate, 0, 100)) {
        throw invalid('supplierRepeatRate must be from 0 to 100.');
    }
    if (!isOptionalMetric(value.supplierServiceScore, 0, 5)) {
        throw invalid('supplierServiceScore must be from 0 to 5.');
    }
    if (!isOptionalInteger(value.supplierServiceScoreCount, 0, 4)) {
        throw invalid('supplierServiceScoreCount must be an integer from 0 to 4.');
    }
    assertServiceScorePair(value.supplierServiceScore, value.supplierServiceScoreCount, invalid);
    const failure = value.supplierStrengthFailure;
    if (failure !== undefined) {
        if (!isRecord(failure)
            || Object.keys(failure).some((key) => key !== 'code' && key !== 'message')) {
            throw invalid('supplierStrengthFailure is invalid.');
        }
        try {
            const normalized = normalizeFailure(failure);
            if (!sameFailure(failure, normalized)) {
                throw invalid('supplierStrengthFailure is not normalized.');
            }
        }
        catch (error) {
            if (error instanceof ProcurementStoreError && error.code === 'PROCUREMENT_STATE_INVALID') {
                throw error;
            }
            throw invalid('supplierStrengthFailure is invalid.');
        }
    }
    const hasSupplierStrengthEvidence = value.supplierRepeatRate !== undefined
        || value.supplierServiceScoreCount !== undefined
        || failure !== undefined;
    if (hasSupplierStrengthEvidence !== (value.supplierStrengthCheckedAt !== undefined)) {
        throw invalid('supplierStrengthCheckedAt must accompany exact supplier evidence.');
    }
    if (value.supplierStrengthCheckedAt !== undefined
        && !isIsoTimestamp(value.supplierStrengthCheckedAt)) {
        throw invalid('supplierStrengthCheckedAt must be a canonical timestamp.');
    }
}
function validatePersistedSupplierReply(candidateIdValue, value, attempt) {
    if (!isRecord(value)
        || value.source !== 'manual_1688_chat_attestation'
        || !Number.isSafeInteger(value.revision)
        || Number(value.revision) < 1
        || (value.captureRevision !== undefined
            && (!Number.isSafeInteger(value.captureRevision) || Number(value.captureRevision) < 1))
        || !isIsoTimestamp(value.recordedAt)
        || !isIsoTimestamp(value.attestedAt)
        || typeof value.attestedMemberId !== 'string'
        || !/^[A-Za-z0-9]{1,128}$/.test(value.attestedMemberId)
        || value.attestedMemberId !== attempt.confirmedMemberId
        || !isIsoTimestamp(value.updatedAt)
        || attempt.status !== 'sent'
        || !isVerifiedContactReceiptSource(attempt.receiptSource)
        || !attempt.messageId) {
        throw storeError('PROCUREMENT_STATE_INVALID', `Candidate ${candidateIdValue} has an invalid supplier reply record.`);
    }
    const sentTime = new Date(attempt.sentAt).getTime();
    const recordedTime = new Date(value.recordedAt).getTime();
    const attestedTime = new Date(value.attestedAt).getTime();
    const updatedTime = new Date(value.updatedAt).getTime();
    if (sentTime > recordedTime
        || recordedTime > attestedTime
        || attestedTime > updatedTime) {
        throw storeError('PROCUREMENT_STATE_INVALID', `Candidate ${candidateIdValue} has an invalid supplier reply timeline.`);
    }
    try {
        const normalized = normalizeSupplierReplyInput({
            quotedPrice: value.quotedPrice,
            minimumOrderQuantity: value.minimumOrderQuantity,
            sampleTerms: value.sampleTerms,
            leadTime: value.leadTime,
            packaging: value.packaging,
            taxAndInvoice: value.taxAndInvoice,
            quoteValidity: value.quoteValidity,
            factoryStatus: value.factoryStatus,
            contactInformation: value.contactInformation,
            notes: value.notes,
            confirmed: true,
            confirmedMemberId: value.attestedMemberId,
            expectedRevision: Number(value.revision) - 1,
        });
        for (const field of SUPPLIER_REPLY_FIELDS) {
            if (normalized[field] !== value[field]) {
                throw new Error(`Supplier reply field ${field} is not normalized.`);
            }
        }
    }
    catch {
        throw storeError('PROCUREMENT_STATE_INVALID', `Candidate ${candidateIdValue} has an invalid supplier reply record.`);
    }
}
function validatePersistedSupplierReplyCapture(candidateIdValue, value, attempt) {
    if (!isRecord(value)
        || value.source !== 'automatic_1688_chat_capture'
        || !Number.isSafeInteger(value.revision)
        || Number(value.revision) < 1
        || !Array.isArray(value.messages)
        || !isRecord(value.analysis)
        || !isIsoTimestamp(value.firstCapturedAt)
        || !isIsoTimestamp(value.lastSyncedAt)
        || !isIsoTimestamp(value.updatedAt)
        || attempt.status !== 'sent'
        || !isVerifiedContactReceiptSource(attempt.receiptSource)
        || !attempt.messageId) {
        throw storeError('PROCUREMENT_STATE_INVALID', `Candidate ${candidateIdValue} has an invalid synchronized supplier reply.`);
    }
    const sentTime = new Date(attempt.sentAt).getTime();
    const firstCapturedTime = new Date(value.firstCapturedAt).getTime();
    const lastSyncedTime = new Date(value.lastSyncedAt).getTime();
    const updatedTime = new Date(value.updatedAt).getTime();
    if (sentTime > firstCapturedTime
        || firstCapturedTime > lastSyncedTime
        || lastSyncedTime > updatedTime) {
        throw storeError('PROCUREMENT_STATE_INVALID', `Candidate ${candidateIdValue} has an invalid synchronized reply timeline.`);
    }
    try {
        normalizeSupplierReplyCaptureInput({
            messages: value.messages,
            analysis: value.analysis,
            confirmedMemberId: attempt.confirmedMemberId,
            expectedRevision: Number(value.revision) - 1,
        });
    }
    catch {
        throw storeError('PROCUREMENT_STATE_INVALID', `Candidate ${candidateIdValue} has an invalid synchronized supplier reply.`);
    }
}
function validatePersistedContactUniqueness(taskId, candidates) {
    const seenSupplierMembers = new Set();
    for (const candidate of candidates) {
        const attempt = candidate.contactAttempt;
        if (!attempt || attempt.status === 'failed')
            continue;
        if (seenSupplierMembers.has(attempt.supplierMemberId)) {
            throw storeError('PROCUREMENT_STATE_INVALID', `Task ${taskId} contains duplicate supplier contact evidence.`);
        }
        seenSupplierMembers.add(attempt.supplierMemberId);
    }
}
function isIsoTimestamp(value) {
    if (typeof value !== 'string')
        return false;
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
function normalizeImportSource(item, itemIndex) {
    let sourceProductId;
    if (item.sourceProductId !== undefined) {
        if (typeof item.sourceProductId !== 'string') {
            throw storeError('PROCUREMENT_IMPORT_SOURCE_INVALID', 'sourceProductId must be a 10-character ASIN.', { itemIndex });
        }
        sourceProductId = item.sourceProductId.normalize('NFKC').trim().toLocaleUpperCase('en-US');
        if (!/^[A-Z0-9]{10}$/.test(sourceProductId)) {
            throw storeError('PROCUREMENT_IMPORT_SOURCE_INVALID', 'sourceProductId must be a 10-character ASIN.', { itemIndex });
        }
    }
    let amazonUrl;
    if (item.amazonUrl !== undefined) {
        if (typeof item.amazonUrl !== 'string') {
            throw storeError('PROCUREMENT_IMPORT_SOURCE_INVALID', 'amazonUrl must be a trusted Amazon AU product URL.', { itemIndex });
        }
        const normalized = normalizeStoredAmazonUrl(item.amazonUrl);
        if (!normalized) {
            throw storeError('PROCUREMENT_IMPORT_SOURCE_INVALID', 'amazonUrl must use https://www.amazon.com.au/dp/<ASIN>.', { itemIndex });
        }
        if (sourceProductId && sourceProductId !== normalized.sourceProductId) {
            throw storeError('PROCUREMENT_IMPORT_SOURCE_INVALID', 'amazonUrl ASIN does not match sourceProductId.', { itemIndex });
        }
        sourceProductId = normalized.sourceProductId;
        amazonUrl = normalized.amazonUrl;
    }
    let sourceImageUrl;
    if (item.sourceImageUrl !== undefined) {
        if (typeof item.sourceImageUrl !== 'string') {
            throw storeError('PROCUREMENT_IMPORT_SOURCE_INVALID', 'sourceImageUrl must be a trusted Amazon image URL.', { itemIndex });
        }
        sourceImageUrl = normalizeStoredAmazonImageUrl(item.sourceImageUrl);
        if (!sourceImageUrl) {
            throw storeError('PROCUREMENT_IMPORT_SOURCE_INVALID', 'sourceImageUrl must use https://m.media-amazon.com/images/I/.', { itemIndex });
        }
    }
    return {
        ...(sourceProductId ? { sourceProductId } : {}),
        ...(amazonUrl ? { amazonUrl } : {}),
        ...(sourceImageUrl ? { sourceImageUrl } : {}),
    };
}
function normalizeStoredAmazonUrl(raw) {
    let parsed;
    try {
        parsed = new URL(raw.trim());
    }
    catch {
        return undefined;
    }
    const hostname = parsed.hostname.toLocaleLowerCase('en-US');
    const match = /^\/dp\/([a-z0-9]{10})\/?$/i.exec(parsed.pathname);
    if (parsed.protocol !== 'https:'
        || (hostname !== 'amazon.com.au' && hostname !== 'www.amazon.com.au')
        || parsed.username
        || parsed.password
        || parsed.port
        || parsed.search
        || parsed.hash
        || !match?.[1])
        return undefined;
    const sourceProductId = match[1].toLocaleUpperCase('en-US');
    return {
        sourceProductId,
        amazonUrl: `https://www.amazon.com.au/dp/${sourceProductId}`,
    };
}
function normalizeStoredAmazonImageUrl(raw) {
    const input = raw.trim();
    if (!input || input.length > 2_048)
        return undefined;
    let parsed;
    try {
        parsed = new URL(input);
    }
    catch {
        return undefined;
    }
    if (parsed.protocol !== 'https:'
        || parsed.hostname.toLocaleLowerCase('en-US') !== 'm.media-amazon.com'
        || parsed.username
        || parsed.password
        || parsed.port
        || parsed.search
        || parsed.hash
        || !parsed.pathname.startsWith('/images/I/')
        || parsed.pathname.length <= '/images/I/'.length)
        return undefined;
    return `https://m.media-amazon.com${parsed.pathname}`;
}
function validatePersistedImportSource(task) {
    if (task.sourceProductId !== undefined
        && (typeof task.sourceProductId !== 'string' || !/^[A-Z0-9]{10}$/.test(task.sourceProductId))) {
        throw storeError('PROCUREMENT_STATE_INVALID', `Task ${task.id} has an invalid source product ID.`);
    }
    if (task.amazonUrl !== undefined) {
        const normalized = typeof task.amazonUrl === 'string'
            ? normalizeStoredAmazonUrl(task.amazonUrl)
            : undefined;
        if (!normalized
            || normalized.amazonUrl !== task.amazonUrl
            || normalized.sourceProductId !== task.sourceProductId) {
            throw storeError('PROCUREMENT_STATE_INVALID', `Task ${task.id} has an invalid Amazon AU source URL.`);
        }
    }
    if (task.sourceImageUrl !== undefined
        && (typeof task.sourceImageUrl !== 'string'
            || normalizeStoredAmazonImageUrl(task.sourceImageUrl) !== task.sourceImageUrl)) {
        throw storeError('PROCUREMENT_STATE_INVALID', `Task ${task.id} has an invalid Amazon image source URL.`);
    }
}
function normalizeImportBatch(input) {
    if (!isRecord(input) || typeof input.batchId !== 'string' || !ENTITY_ID.test(input.batchId)) {
        throw storeError('PROCUREMENT_IMPORT_BATCH_INVALID', 'batchId must contain 1 to 128 letters, digits, underscores, or hyphens.');
    }
    if (!Array.isArray(input.items)
        || input.items.length < 1
        || input.items.length > MAX_PROCUREMENT_IMPORT_BATCH_ITEMS) {
        throw storeError('PROCUREMENT_IMPORT_BATCH_INVALID', `An import batch must contain 1 to ${MAX_PROCUREMENT_IMPORT_BATCH_ITEMS} items.`, { itemCount: Array.isArray(input.items) ? input.items.length : undefined });
    }
    const seenRows = new Set();
    const items = input.items.map((item, index) => {
        if (!isRecord(item) || !(item.image instanceof Uint8Array)) {
            throw storeError('PROCUREMENT_IMPORT_BATCH_INVALID', 'Every import item requires a product image and metadata.', { itemIndex: index });
        }
        const importRowNumber = item.importRowNumber;
        if (importRowNumber !== undefined
            && (!Number.isInteger(importRowNumber) || importRowNumber < 1 || importRowNumber > 1_048_576)) {
            throw storeError('PROCUREMENT_IMPORT_BATCH_INVALID', 'importRowNumber must be an Excel row number from 1 to 1048576.', { itemIndex: index, importRowNumber });
        }
        if (importRowNumber !== undefined) {
            if (seenRows.has(importRowNumber)) {
                throw storeError('PROCUREMENT_IMPORT_BATCH_INVALID', 'An import batch cannot contain the same worksheet row twice.', { itemIndex: index, importRowNumber });
            }
            seenRows.add(importRowNumber);
        }
        const image = Buffer.from(item.image);
        const imageKind = validateImage(image, item.mimeType);
        const source = normalizeImportSource(item, index);
        const imageSource = item.imageSource === undefined
            ? 'attachment'
            : PROCUREMENT_TASK_IMAGE_SOURCES.includes(item.imageSource)
                ? item.imageSource
                : undefined;
        if (!imageSource) {
            throw storeError('PROCUREMENT_IMPORT_BATCH_INVALID', 'imageSource is invalid.', { itemIndex: index });
        }
        return {
            title: requiredText(item.title, 'title', 200),
            originalFileName: validateFileName(item.fileName),
            image,
            imageKind,
            imageSha256: crypto.createHash('sha256').update(image).digest('hex'),
            imageSource,
            ...(importRowNumber === undefined ? {} : { importRowNumber }),
            ...source,
        };
    });
    return { batchId: input.batchId, items };
}
function normalizeQueuedImportBatch(input) {
    const batch = normalizeImportBatch(input);
    const confirmations = input.items.map((item) => normalizeConfirmation(item.confirmation));
    assertSameConfirmationMember(confirmations);
    return { batch, confirmations };
}
function normalizeBatchConfirmations(input) {
    if (!isRecord(input)
        || !Array.isArray(input.items)
        || input.items.length < 1
        || input.items.length > MAX_PROCUREMENT_IMPORT_BATCH_ITEMS) {
        throw storeError('PROCUREMENT_CONFIRMATION_BATCH_INVALID', `A confirmation batch must contain 1 to ${MAX_PROCUREMENT_IMPORT_BATCH_ITEMS} items.`, { itemCount: isRecord(input) && Array.isArray(input.items) ? input.items.length : undefined });
    }
    const seenTaskIds = new Set();
    const normalized = input.items.map((item, index) => {
        if (!isRecord(item)) {
            throw storeError('PROCUREMENT_CONFIRMATION_BATCH_INVALID', 'Every confirmation batch item requires a taskId and confirmation.', { itemIndex: index });
        }
        assertEntityId(item.taskId, 'task');
        if (seenTaskIds.has(item.taskId)) {
            throw storeError('PROCUREMENT_CONFIRMATION_BATCH_INVALID', 'A confirmation batch cannot contain the same task twice.', { itemIndex: index, taskId: item.taskId });
        }
        seenTaskIds.add(item.taskId);
        return { taskId: item.taskId, confirmation: normalizeConfirmation(item.confirmation) };
    });
    assertSameConfirmationMember(normalized.map((item) => item.confirmation));
    return normalized;
}
function assertSameConfirmationMember(confirmations) {
    const confirmedMemberId = confirmations[0].confirmedMemberId;
    if (confirmations.some((item) => item.confirmedMemberId !== confirmedMemberId)) {
        throw storeError('PROCUREMENT_CONFIRMATION_ACCOUNT_MISMATCH', 'Every task in a batch must be confirmed by the same logged-in 1688 account.');
    }
}
function assertSameImportBatch(existingTasks, requestedItems, batchId) {
    const matches = existingTasks.length === requestedItems.length
        && existingTasks.every((task, index) => {
            const item = requestedItems[index];
            return task.title === item.title
                && task.originalFileName === item.originalFileName
                && task.importRowNumber === item.importRowNumber
                && task.sourceProductId === item.sourceProductId
                && task.amazonUrl === item.amazonUrl
                && task.sourceImageUrl === item.sourceImageUrl
                && task.imageMimeType === item.imageKind.mimeType
                && task.imageSize === item.image.byteLength
                && task.imageSource === item.imageSource
                && task.imageSha256 === item.imageSha256;
        });
    if (!matches) {
        throw storeError('PROCUREMENT_IMPORT_BATCH_CONFLICT', `Import batch ${batchId} was already committed with different items.`, { batchId });
    }
}
function assertSameQueuedImportBatch(existingTasks, requestedConfirmations, batchId) {
    const matches = existingTasks.length === requestedConfirmations.length
        && existingTasks.every((task, index) => (task.confirmation !== undefined
            && task.queueSequence !== undefined
            && sameConfirmation(task.confirmation, requestedConfirmations[index])));
    if (!matches) {
        throw storeError('PROCUREMENT_IMPORT_BATCH_CONFLICT', `Import batch ${batchId} was already committed with different confirmation parameters.`, { batchId });
    }
}
function normalizeConfirmation(input) {
    if (!isRecord(input)) {
        throw confirmationInvalid('Confirmation parameters are required.');
    }
    if (typeof input.sellingPrice !== 'number' || !Number.isFinite(input.sellingPrice) || input.sellingPrice <= 0) {
        throw confirmationInvalid('sellingPrice must be a finite number greater than zero.');
    }
    const sellingPriceCurrency = typeof input.sellingPriceCurrency === 'string'
        ? input.sellingPriceCurrency.trim().toLocaleUpperCase('en-US')
        : '';
    if (!/^[A-Z]{3}$/.test(sellingPriceCurrency)) {
        throw confirmationInvalid('sellingPriceCurrency must contain exactly three letters.');
    }
    if (!Number.isInteger(input.targetQuantity)
        || input.targetQuantity < 1
        || input.targetQuantity > 1_000_000) {
        throw confirmationInvalid('targetQuantity must be an integer from 1 to 1000000.');
    }
    const rawDestination = typeof input.destination === 'string' ? input.destination : '';
    const destination = rawDestination.trim();
    if ([...destination].length < 1
        || [...destination].length > 80
        || destination.startsWith('--')
        || CONTROL_CHARACTERS.test(rawDestination)) {
        throw confirmationInvalid('destination must be 1 to 80 characters without controls or a leading --.');
    }
    const confirmedMemberId = typeof input.confirmedMemberId === 'string'
        ? input.confirmedMemberId.trim()
        : '';
    if (!/^[A-Za-z0-9]{1,128}$/.test(confirmedMemberId)) {
        throw confirmationInvalid('confirmedMemberId must contain 1 to 128 letters or digits.');
    }
    return {
        sellingPrice: input.sellingPrice,
        sellingPriceCurrency,
        targetQuantity: input.targetQuantity,
        destination,
        confirmedMemberId,
    };
}
function sameConfirmation(current, requested) {
    return current.sellingPrice === requested.sellingPrice
        && current.sellingPriceCurrency === requested.sellingPriceCurrency
        && current.targetQuantity === requested.targetQuantity
        && current.destination === requested.destination
        && current.confirmedMemberId === requested.confirmedMemberId;
}
function normalizeSearchProgressInput(input) {
    if (!isRecord(input)
        || typeof input.phase !== 'string'
        || !PROCUREMENT_SEARCH_PROGRESS_PHASES.includes(input.phase)) {
        throw storeError('PROCUREMENT_PROGRESS_INVALID', 'Search progress phase is invalid.');
    }
    if (input.candidatesFound !== undefined
        && (!Number.isInteger(input.candidatesFound) || input.candidatesFound < 0)) {
        throw storeError('PROCUREMENT_PROGRESS_INVALID', 'Search progress candidate count must be a non-negative integer.');
    }
    return withoutUndefined({
        phase: input.phase,
        candidatesFound: input.candidatesFound,
    });
}
function normalizeOffer(source) {
    if (!isRecord(source))
        throw offerInvalid('Each offer must be an object.');
    const offerId = requiredOfferText(source.offerId, 'offerId', 128);
    const factoryName = optionalOfferText(source.factoryName ?? source.manufacturer ?? source.shopName ?? source.supplierName, 'factoryName', 300);
    const offerUrl = optionalUrl(source.offerUrl, 'offerUrl');
    const imageUrl = optionalUrl(source.imageUrl, 'imageUrl');
    const title = optionalOfferText(source.title, 'title', 500);
    const supplierLoginId = source.supplierLoginId === undefined
        ? undefined
        : normalizeSupplierLoginId(source.supplierLoginId);
    const supplierMemberId = source.supplierMemberId === undefined
        ? undefined
        : normalizeSupplierMemberId(source.supplierMemberId);
    const location = optionalOfferText(source.location, 'location', 200);
    const priceText = optionalOfferText(source.priceText, 'priceText', 100);
    const supplierShopUrl = optionalUrl(source.supplierShopUrl, 'supplierShopUrl');
    const turnover = optionalOfferText(source.turnover, 'turnover', 200);
    const productRepurchaseRate = optionalOfferMetric(source.productRepurchaseRate, 'productRepurchaseRate', 0, 100);
    const supplierRepeatRate = optionalOfferMetric(source.supplierRepeatRate, 'supplierRepeatRate', 0, 100);
    const supplierServiceScore = optionalOfferMetric(source.supplierServiceScore, 'supplierServiceScore', 0, 5);
    const supplierServiceScoreCount = optionalOfferInteger(source.supplierServiceScoreCount, 'supplierServiceScoreCount', 0, 4);
    assertServiceScorePair(supplierServiceScore, supplierServiceScoreCount, (message) => offerInvalid(message));
    const supplierStrengthCheckedAt = source.supplierStrengthCheckedAt === undefined
        ? undefined
        : optionalOfferIsoTimestamp(source.supplierStrengthCheckedAt, 'supplierStrengthCheckedAt');
    const supplierStrengthFailure = source.supplierStrengthFailure === undefined
        ? undefined
        : normalizeOfferFailure(source.supplierStrengthFailure);
    const hasSupplierStrengthEvidence = supplierRepeatRate !== undefined
        || supplierServiceScoreCount !== undefined
        || supplierStrengthFailure !== undefined;
    if (hasSupplierStrengthEvidence !== (supplierStrengthCheckedAt !== undefined)) {
        throw offerInvalid('supplierStrengthCheckedAt is required exactly when supplier strength evidence is present.');
    }
    let price;
    if (source.price !== undefined) {
        if (typeof source.price !== 'number' || !Number.isFinite(source.price) || source.price < 0) {
            throw offerInvalid('Offer price must be a finite non-negative number.');
        }
        price = source.price;
    }
    let currency;
    if (source.currency !== undefined) {
        currency = requiredOfferText(source.currency, 'currency', 3).toLocaleUpperCase('en-US');
        if (!/^[A-Z]{3}$/.test(currency))
            throw offerInvalid('Offer currency must contain three letters.');
    }
    let minOrderQuantity;
    if (source.minOrderQuantity !== undefined) {
        if (!Number.isInteger(source.minOrderQuantity) || source.minOrderQuantity < 1) {
            throw offerInvalid('minOrderQuantity must be a positive integer.');
        }
        minOrderQuantity = source.minOrderQuantity;
    }
    let supplierYears;
    if (source.supplierYears !== undefined) {
        if (!Number.isInteger(source.supplierYears) || source.supplierYears < 0) {
            throw offerInvalid('supplierYears must be a non-negative integer.');
        }
        supplierYears = source.supplierYears;
    }
    const verifiedFactory = optionalBoolean(source.verifiedFactory, 'verifiedFactory');
    const verifiedBusiness = optionalBoolean(source.verifiedBusiness, 'verifiedBusiness');
    const verifiedSuperFactory = optionalBoolean(source.verifiedSuperFactory, 'verifiedSuperFactory');
    return withoutUndefined({
        offerId,
        offerUrl,
        title,
        factoryName,
        supplierLoginId,
        supplierMemberId,
        imageUrl,
        price,
        priceText,
        currency,
        minOrderQuantity,
        location,
        supplierYears,
        productRepurchaseRate,
        supplierRepeatRate,
        supplierServiceScore,
        supplierServiceScoreCount,
        supplierStrengthCheckedAt,
        supplierStrengthFailure,
        supplierShopUrl,
        verifiedFactory,
        verifiedBusiness,
        verifiedSuperFactory,
        turnover,
    });
}
function normalizeFailure(input) {
    const source = typeof input === 'string' ? { message: input } : input;
    if (!isRecord(source)) {
        throw storeError('PROCUREMENT_FAILURE_INVALID', 'A failure message is required.');
    }
    const message = typeof source.message === 'string'
        ? source.message.replace(CONTROL_CHARACTER_RUNS, ' ').trim().slice(0, 4_000)
        : '';
    if (!message)
        throw storeError('PROCUREMENT_FAILURE_INVALID', 'A failure message is required.');
    const code = source.code === undefined
        ? undefined
        : requiredText(source.code, 'failure.code', 128);
    return code ? { code, message } : { message };
}
function normalizeCandidateStrengthInput(input) {
    if (!isRecord(input))
        throw candidateStrengthInvalid('A supplier strength result is required.');
    const allowed = new Set([
        'supplierYears',
        'supplierRepeatRate',
        'supplierServiceScore',
        'supplierServiceScoreCount',
        'failure',
    ]);
    const unknown = Object.keys(input).find((key) => !allowed.has(key));
    if (unknown)
        throw candidateStrengthInvalid(`Unknown supplier strength field: ${unknown}.`);
    const supplierRepeatRate = optionalStrengthMetric(input.supplierRepeatRate, 'supplierRepeatRate', 0, 100);
    const supplierYears = optionalStrengthInteger(input.supplierYears, 'supplierYears', 0, 100);
    const supplierServiceScore = optionalStrengthMetric(input.supplierServiceScore, 'supplierServiceScore', 0, 5);
    const supplierServiceScoreCount = optionalStrengthInteger(input.supplierServiceScoreCount, 'supplierServiceScoreCount', 0, 4);
    assertServiceScorePair(supplierServiceScore, supplierServiceScoreCount, candidateStrengthInvalid);
    if (input.failure !== undefined) {
        if (supplierRepeatRate !== undefined
            || supplierYears !== undefined
            || supplierServiceScore !== undefined
            || supplierServiceScoreCount !== undefined) {
            throw candidateStrengthInvalid('A failed strength check cannot include replacement metrics.');
        }
        if (!isRecord(input.failure)
            || Object.keys(input.failure).some((key) => key !== 'code' && key !== 'message')) {
            throw candidateStrengthInvalid('Supplier strength failure evidence is invalid.');
        }
        try {
            return { failure: normalizeFailure(input.failure) };
        }
        catch {
            throw candidateStrengthInvalid('Supplier strength failure evidence is invalid.');
        }
    }
    if (supplierRepeatRate === undefined
        && supplierYears === undefined
        && supplierServiceScore === undefined
        && supplierServiceScoreCount === undefined) {
        throw candidateStrengthInvalid('A successful strength check must include an observed metric or a zero service count.');
    }
    return withoutUndefined({
        supplierYears,
        supplierRepeatRate,
        supplierServiceScore,
        supplierServiceScoreCount,
    });
}
function optionalStrengthMetric(value, field, minimum, maximum) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number'
        || !Number.isFinite(value)
        || value < minimum
        || value > maximum) {
        throw candidateStrengthInvalid(`${field} must be a finite number from ${minimum} to ${maximum}.`);
    }
    return value;
}
function optionalStrengthInteger(value, field, minimum, maximum) {
    const normalized = optionalStrengthMetric(value, field, minimum, maximum);
    if (normalized !== undefined && !Number.isInteger(normalized)) {
        throw candidateStrengthInvalid(`${field} must be an integer from ${minimum} to ${maximum}.`);
    }
    return normalized;
}
function assertServiceScorePair(score, count, errorFactory) {
    if (score === undefined && (count === undefined || count === 0))
        return;
    if (typeof score !== 'number'
        || typeof count !== 'number'
        || !Number.isInteger(count)
        || count < 1
        || count > 4) {
        throw errorFactory('supplierServiceScore requires supplierServiceScoreCount from 1 to 4; count 0 requires no score.');
    }
}
function isOptionalMetric(value, minimum, maximum) {
    return value === undefined
        || (typeof value === 'number'
            && Number.isFinite(value)
            && value >= minimum
            && value <= maximum);
}
function isOptionalInteger(value, minimum, maximum) {
    return isOptionalMetric(value, minimum, maximum)
        && (value === undefined || Number.isInteger(value));
}
function setOptionalCandidateMetric(candidate, key, value) {
    if (value === undefined)
        delete candidate[key];
    else
        candidate[key] = value;
}
function sameFailure(current, requested) {
    return current?.message === requested.message && current.code === requested.code;
}
function validateImage(image, suppliedMimeType) {
    if (image.byteLength > MAX_PROCUREMENT_IMAGE_BYTES) {
        throw storeError('PROCUREMENT_IMAGE_TOO_LARGE', `Images cannot exceed ${MAX_PROCUREMENT_IMAGE_BYTES} bytes.`);
    }
    const detected = detectImageKind(image);
    if (!detected) {
        throw storeError('PROCUREMENT_IMAGE_TYPE_UNSUPPORTED', 'Only PNG, JPEG, GIF, BMP, and WebP image signatures are accepted.');
    }
    const normalizedMimeType = suppliedMimeType?.trim().toLocaleLowerCase('en-US') === 'image/jpg'
        ? 'image/jpeg'
        : suppliedMimeType?.trim().toLocaleLowerCase('en-US');
    if (normalizedMimeType !== detected.mimeType) {
        throw storeError('PROCUREMENT_IMAGE_MIME_MISMATCH', 'The supplied image MIME type does not match its signature.', { detectedMimeType: detected.mimeType });
    }
    return detected;
}
export function detectProcurementImageType(image) {
    return detectImageKind(Buffer.from(image));
}
function detectImageKind(image) {
    if (startsWithBytes(image, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        return { extension: 'png', mimeType: 'image/png' };
    }
    if (startsWithBytes(image, [0xff, 0xd8, 0xff])) {
        return { extension: 'jpg', mimeType: 'image/jpeg' };
    }
    if (image.subarray(0, 6).toString('ascii') === 'GIF87a'
        || image.subarray(0, 6).toString('ascii') === 'GIF89a') {
        return { extension: 'gif', mimeType: 'image/gif' };
    }
    if (image.subarray(0, 2).toString('ascii') === 'BM') {
        return { extension: 'bmp', mimeType: 'image/bmp' };
    }
    if (image.byteLength >= 12
        && image.subarray(0, 4).toString('ascii') === 'RIFF'
        && image.subarray(8, 12).toString('ascii') === 'WEBP') {
        return { extension: 'webp', mimeType: 'image/webp' };
    }
    return null;
}
function startsWithBytes(buffer, signature) {
    return buffer.byteLength >= signature.length
        && signature.every((byte, index) => buffer[index] === byte);
}
function validateFileName(value) {
    const fileName = requiredText(value, 'fileName', 255);
    if (fileName === '.'
        || fileName === '..'
        || path.win32.basename(fileName) !== fileName
        || path.posix.basename(fileName) !== fileName) {
        throw storeError('PROCUREMENT_FILE_NAME_INVALID', 'fileName must be a plain file name.');
    }
    return fileName;
}
function requiredText(value, field, maximumLength) {
    const result = typeof value === 'string' ? value.trim() : '';
    if (!result || [...result].length > maximumLength || CONTROL_CHARACTERS.test(result)) {
        throw storeError('PROCUREMENT_INPUT_INVALID', `${field} is invalid.`, { field });
    }
    return result;
}
function requiredOfferText(value, field, maximumLength) {
    try {
        return requiredText(value, field, maximumLength);
    }
    catch {
        throw offerInvalid(`${field} is invalid.`);
    }
}
function optionalOfferText(value, field, maximumLength) {
    if (value === undefined || value === null || value === '')
        return undefined;
    return requiredOfferText(value, field, maximumLength);
}
function optionalUrl(value, field) {
    const text = optionalOfferText(value, field, 2_048);
    if (!text)
        return undefined;
    try {
        const url = new URL(text);
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
            throw new Error('protocol');
        return url.toString();
    }
    catch {
        throw offerInvalid(`${field} must be an HTTP(S) URL.`);
    }
}
function optionalBoolean(value, field) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'boolean')
        throw offerInvalid(`${field} must be a boolean.`);
    return value;
}
function optionalOfferMetric(value, field, minimum, maximum) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'number'
        || !Number.isFinite(value)
        || value < minimum
        || value > maximum) {
        throw offerInvalid(`${field} must be a finite number from ${minimum} to ${maximum}.`);
    }
    return value;
}
function optionalOfferInteger(value, field, minimum, maximum) {
    const normalized = optionalOfferMetric(value, field, minimum, maximum);
    if (normalized !== undefined && !Number.isInteger(normalized)) {
        throw offerInvalid(`${field} must be an integer from ${minimum} to ${maximum}.`);
    }
    return normalized;
}
function optionalOfferIsoTimestamp(value, field) {
    if (!isIsoTimestamp(value))
        throw offerInvalid(`${field} must be a canonical timestamp.`);
    return value;
}
function normalizeOfferFailure(value) {
    if (!isRecord(value)
        || Object.keys(value).some((key) => key !== 'code' && key !== 'message')) {
        throw offerInvalid('supplierStrengthFailure is invalid.');
    }
    try {
        return normalizeFailure(value);
    }
    catch {
        throw offerInvalid('supplierStrengthFailure is invalid.');
    }
}
function requireTask(state, taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) {
        throw storeError('PROCUREMENT_TASK_NOT_FOUND', `Task ${taskId} was not found.`, { taskId });
    }
    return task;
}
function requireCandidate(task, candidateIdValue) {
    const candidate = task.candidates.find((item) => item.id === candidateIdValue);
    if (!candidate) {
        throw storeError('PROCUREMENT_CANDIDATE_NOT_FOUND', `Candidate ${candidateIdValue} was not found.`, { taskId: task.id, candidateId: candidateIdValue });
    }
    return candidate;
}
function assertContactableTask(task) {
    if (task.status !== 'review_candidates' && task.status !== 'completed') {
        throw stateConflict(task, 'edit or send a supplier contact');
    }
}
function applySharedContactDraftToCandidate(candidate, sharedDraft, timestamp) {
    if (!sharedDraft || candidate.contactDraft?.message === sharedDraft.message)
        return;
    candidate.contactDraft = {
        message: sharedDraft.message,
        revision: (candidate.contactDraft?.revision ?? 0) + 1,
        updatedAt: timestamp,
    };
    candidate.updatedAt = timestamp;
}
function normalizeContactMessage(value) {
    const raw = typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : '';
    const message = raw.trim();
    if ([...message].length < 1
        || [...message].length > 500
        || CONTACT_MESSAGE_CONTROL_CHARACTERS.test(message)) {
        throw storeError('PROCUREMENT_CONTACT_MESSAGE_INVALID', 'The supplier contact message must contain 1 to 500 characters.');
    }
    return message;
}
function normalizeNewContactMessage(value) {
    const raw = typeof value === 'string' ? value : '';
    return normalizeContactMessage(stripManagedOfferLinkLines(raw));
}
function contactMessageSha256(message) {
    return crypto.createHash('sha256').update(message, 'utf8').digest('hex');
}
function contactMessageForAttempt(candidate, draft, attempt) {
    return attempt.messageFormat === SUPPLIER_CONTACT_MESSAGE_FORMAT
        ? composeSupplierContactMessage(draft.message, candidate.offerId)
        : draft.message;
}
function persistedContactMessageMatchesAttempt(candidate, draft, attempt) {
    try {
        return contactMessageSha256(contactMessageForAttempt(candidate, draft, attempt))
            === attempt.messageSha256;
    }
    catch {
        return false;
    }
}
function normalizeContactRevision(value) {
    if (!Number.isInteger(value) || Number(value) < 0) {
        throw storeError('PROCUREMENT_CONTACT_REVISION_INVALID', 'The contact draft revision must be a non-negative integer.');
    }
    return Number(value);
}
function normalizeSupplierReplyInput(input) {
    if (!isRecord(input)) {
        throw storeError('PROCUREMENT_SUPPLIER_REPLY_INVALID', 'A supplier reply record is required.');
    }
    if (input.confirmed !== true) {
        throw storeError('PROCUREMENT_SUPPLIER_REPLY_ATTESTATION_REQUIRED', 'Explicit confirmation of the manually checked 1688 conversation is required.');
    }
    const confirmedMemberId = normalizeMemberId(input.confirmedMemberId);
    const expectedRevision = normalizeSupplierReplyRevision(input.expectedRevision);
    const expectedCaptureRevision = input.expectedCaptureRevision === undefined
        ? undefined
        : normalizeSupplierReplyRevision(input.expectedCaptureRevision);
    const normalized = withoutUndefined({
        quotedPrice: normalizeSupplierReplyField(input.quotedPrice, 'quotedPrice', 500, true),
        minimumOrderQuantity: normalizeSupplierReplyField(input.minimumOrderQuantity, 'minimumOrderQuantity', 200),
        sampleTerms: normalizeSupplierReplyField(input.sampleTerms, 'sampleTerms', 300),
        leadTime: normalizeSupplierReplyField(input.leadTime, 'leadTime', 300),
        packaging: normalizeSupplierReplyField(input.packaging, 'packaging', 500),
        taxAndInvoice: normalizeSupplierReplyField(input.taxAndInvoice, 'taxAndInvoice', 300),
        quoteValidity: normalizeSupplierReplyField(input.quoteValidity, 'quoteValidity', 200),
        factoryStatus: normalizeSupplierReplyField(input.factoryStatus, 'factoryStatus', 500, true),
        contactInformation: normalizeSupplierReplyField(input.contactInformation, 'contactInformation', 500, true),
        notes: normalizeSupplierReplyField(input.notes, 'notes', 2_000, true),
        confirmed: true,
        confirmedMemberId,
        expectedRevision,
        expectedCaptureRevision,
    });
    if (!SUPPLIER_REPLY_FIELDS.some((field) => normalized[field] !== undefined)) {
        throw storeError('PROCUREMENT_SUPPLIER_REPLY_INVALID', 'Record at least one supplier-confirmed detail.');
    }
    return normalized;
}
function normalizeSupplierReplyCaptureInput(input) {
    if (!isRecord(input) || !Array.isArray(input.messages) || !isRecord(input.analysis)) {
        throw storeError('PROCUREMENT_SUPPLIER_REPLY_CAPTURE_INVALID', 'A synchronized supplier reply record is required.');
    }
    if (input.messages.length > 100) {
        throw storeError('PROCUREMENT_SUPPLIER_REPLY_CAPTURE_INVALID', 'A synchronized supplier reply can contain at most 100 messages.');
    }
    const messages = input.messages.map((message) => normalizeSupplierChatMessage(message));
    const analysis = normalizeSupplierReplyAnalysis(input.analysis);
    if (analysis.reliability === 'verified'
        && !messages.some((message) => typeof message.messageId === 'string')) {
        throw storeError('PROCUREMENT_SUPPLIER_REPLY_CAPTURE_INVALID', 'Verified supplier reply analysis requires a WebSocket message ID.');
    }
    return {
        messages,
        analysis,
        confirmedMemberId: normalizeMemberId(input.confirmedMemberId),
        expectedRevision: normalizeSupplierReplyRevision(input.expectedRevision),
    };
}
function mergeSupplierReplyCapture(previous, current) {
    // An empty first poll contains no inherited evidence. A later verified seller
    // reply must be evaluated on its own evidence rather than permanently inherit
    // the empty poll's needs_review status.
    if (!previous || previous.messages.length === 0) {
        return { messages: current.messages, analysis: current.analysis };
    }
    if (current.messages.length === 0 && previous.messages.length > 0) {
        return { messages: previous.messages, analysis: previous.analysis };
    }
    const messagesByKey = new Map(previous.messages.map((message) => [supplierReplyMessageKey(message), message]));
    for (const message of current.messages) {
        messagesByKey.set(supplierReplyMessageKey(message), message);
    }
    const messages = [...messagesByKey.values()].slice(-100);
    const analysis = {
        usefulInformation: [...new Set([
                ...previous.analysis.usefulInformation,
                ...current.analysis.usefulInformation,
            ])].slice(0, 30),
        unclassifiedInformation: [...new Set([
                ...previous.analysis.unclassifiedInformation,
                ...current.analysis.unclassifiedInformation,
            ])].slice(0, 30),
        missingFields: [],
        evidenceSource: previous.analysis.evidenceSource === '1688_ws_history'
            && current.analysis.evidenceSource === '1688_ws_history'
            ? '1688_ws_history'
            : '1688_dom_snapshot',
        reliability: previous.analysis.reliability === 'verified'
            && current.analysis.reliability === 'verified'
            ? 'verified'
            : 'needs_review',
    };
    for (const field of PROCUREMENT_SUPPLIER_REPLY_ANALYSIS_FIELDS) {
        const value = current.analysis[field] ?? previous.analysis[field];
        if (value !== undefined)
            analysis[field] = value;
    }
    analysis.missingFields = PROCUREMENT_SUPPLIER_REPLY_ANALYSIS_FIELDS.filter((field) => analysis[field] === undefined);
    return { messages, analysis };
}
function supplierReplyMessageKey(message) {
    return message.messageId
        ? `id:${message.messageId}`
        : `content:${message.sentAt ?? ''}\u0000${message.sender ?? ''}\u0000${message.content}`;
}
function normalizeSupplierChatMessage(input) {
    if (!isRecord(input)) {
        throw storeError('PROCUREMENT_SUPPLIER_REPLY_CAPTURE_INVALID', 'Supplier reply message is invalid.');
    }
    const content = normalizeCapturedText(input.content, 2_000, true);
    const messageId = input.messageId === undefined
        ? undefined
        : normalizeCapturedText(input.messageId, 256, false);
    const sender = input.sender === undefined
        ? undefined
        : normalizeCapturedText(input.sender, 200, false);
    const sentAt = input.sentAt === undefined ? undefined : input.sentAt;
    if (sentAt !== undefined && !isIsoTimestamp(sentAt)) {
        throw storeError('PROCUREMENT_SUPPLIER_REPLY_CAPTURE_INVALID', 'Supplier reply time is invalid.');
    }
    if (!['text', 'offerCard', 'image', 'other'].includes(String(input.kind))) {
        throw storeError('PROCUREMENT_SUPPLIER_REPLY_CAPTURE_INVALID', 'Supplier reply kind is invalid.');
    }
    return withoutUndefined({
        messageId,
        sender,
        sentAt,
        content,
        kind: input.kind,
    });
}
function normalizeSupplierReplyAnalysis(input) {
    if (!isRecord(input)
        || !Array.isArray(input.usefulInformation)
        || !Array.isArray(input.unclassifiedInformation)
        || !Array.isArray(input.missingFields)
        || !['1688_ws_history', '1688_dom_snapshot'].includes(String(input.evidenceSource))
        || !['verified', 'needs_review'].includes(String(input.reliability))
        || (input.evidenceSource === '1688_dom_snapshot' && input.reliability !== 'needs_review')) {
        throw storeError('PROCUREMENT_SUPPLIER_REPLY_CAPTURE_INVALID', 'Supplier reply analysis is invalid.');
    }
    const usefulInformation = normalizeCapturedTextList(input.usefulInformation, 30, 500);
    const unclassifiedInformation = normalizeCapturedTextList(input.unclassifiedInformation, 30, 500);
    const missingFields = input.missingFields.map((field) => String(field));
    if (new Set(missingFields).size !== missingFields.length
        || missingFields.some((field) => !PROCUREMENT_SUPPLIER_REPLY_ANALYSIS_FIELDS.includes(field))) {
        throw storeError('PROCUREMENT_SUPPLIER_REPLY_CAPTURE_INVALID', 'Supplier reply gaps are invalid.');
    }
    const output = {
        usefulInformation,
        unclassifiedInformation,
        missingFields: missingFields,
        evidenceSource: input.evidenceSource,
        reliability: input.reliability,
    };
    for (const field of PROCUREMENT_SUPPLIER_REPLY_ANALYSIS_FIELDS) {
        const value = input[field];
        if (value !== undefined)
            output[field] = normalizeCapturedText(value, 500, true);
    }
    return output;
}
function normalizeCapturedTextList(value, maximumItems, maximumLength) {
    if (value.length > maximumItems) {
        throw storeError('PROCUREMENT_SUPPLIER_REPLY_CAPTURE_INVALID', 'Supplier reply analysis is too large.');
    }
    return [...new Set(value.map((item) => normalizeCapturedText(item, maximumLength, true)))];
}
function normalizeCapturedText(value, maximumLength, multiline) {
    if (typeof value !== 'string') {
        throw storeError('PROCUREMENT_SUPPLIER_REPLY_CAPTURE_INVALID', 'Supplier reply text is invalid.');
    }
    const text = value.replace(/\r\n?/g, '\n').trim().normalize('NFC');
    const invalidControls = multiline
        ? CONTACT_MESSAGE_CONTROL_CHARACTERS.test(text)
        : CONTROL_CHARACTERS.test(text);
    if (!text || [...text].length > maximumLength || invalidControls) {
        throw storeError('PROCUREMENT_SUPPLIER_REPLY_CAPTURE_INVALID', 'Supplier reply text is invalid.');
    }
    return text;
}
function normalizeSupplierReplyRevision(value) {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw storeError('PROCUREMENT_SUPPLIER_REPLY_REVISION_INVALID', 'The supplier reply revision must be a non-negative integer.');
    }
    return Number(value);
}
function normalizeSupplierReplyField(value, field, maximumLength, multiline = false) {
    if (value === undefined || value === null || value === '')
        return undefined;
    if (typeof value !== 'string') {
        throw storeError('PROCUREMENT_SUPPLIER_REPLY_INVALID', `${field} must be text.`);
    }
    const text = value.replace(/\r\n?/g, '\n').trim().normalize('NFC');
    const invalidControls = multiline
        ? CONTACT_MESSAGE_CONTROL_CHARACTERS.test(text)
        : CONTROL_CHARACTERS.test(text);
    if (!text || [...text].length > maximumLength || invalidControls) {
        throw storeError('PROCUREMENT_SUPPLIER_REPLY_INVALID', `${field} is invalid.`);
    }
    return text;
}
function normalizeMemberId(value) {
    const memberId = typeof value === 'string' ? value.trim() : '';
    if (!/^[A-Za-z0-9]{1,128}$/.test(memberId)) {
        throw storeError('PROCUREMENT_CONTACT_ACCOUNT_INVALID', 'The verified account is invalid.');
    }
    return memberId;
}
function normalizeAttemptId(value) {
    if (typeof value !== 'string' || !ENTITY_ID.test(value)) {
        throw storeError('PROCUREMENT_CONTACT_ATTEMPT_INVALID', 'The contact attempt ID is invalid.');
    }
    return value;
}
function normalizeSupplierLoginId(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    const loginId = raw.normalize('NFC');
    if (raw !== loginId || !SUPPLIER_LOGIN_ID.test(loginId)) {
        throw storeError('PROCUREMENT_CONTACT_SUPPLIER_INVALID', 'The resolved 1688 supplier identity is invalid.');
    }
    return loginId;
}
function normalizeSupplierMemberId(value) {
    const memberId = typeof value === 'string' ? value : '';
    if (!isSupplierMemberId(memberId)) {
        throw storeError('PROCUREMENT_CONTACT_SUPPLIER_INVALID', 'The stable 1688 supplier member ID must contain 5 to 30 digits.');
    }
    return memberId;
}
function isSupplierMemberId(value) {
    return typeof value === 'string' && SUPPLIER_MEMBER_ID.test(value);
}
function requireContactAttempt(candidate, attemptId, taskId) {
    const attempt = candidate.contactAttempt;
    if (!attempt || attempt.id !== attemptId) {
        throw storeError('PROCUREMENT_CONTACT_ATTEMPT_CONFLICT', 'The contact attempt is missing or was replaced.', { taskId, candidateId: candidate.id, attemptId });
    }
    return attempt;
}
function assertVerifiedContactEvidence(taskId, candidate) {
    const attempt = candidate.contactAttempt;
    const draft = candidate.contactDraft;
    if (!attempt
        || attempt.status !== 'sent'
        || !isVerifiedContactReceiptSource(attempt.receiptSource)
        || !attempt.messageId
        || !draft
        || draft.revision !== attempt.draftRevision) {
        throw storeError('PROCUREMENT_CONTACT_VERIFICATION_REQUIRED', 'A verified 1688 delivery receipt is required before recording supplier details.', { taskId, candidateId: candidate.id });
    }
}
function isVerifiedContactReceiptSource(value) {
    return value === '1688_ws_ack' || value === '1688_ws_history';
}
function contactAttemptConflict(taskId, candidateIdValue, status) {
    if (status === 'sent') {
        return storeError('PROCUREMENT_CONTACT_ALREADY_SENT', 'This supplier was already contacted for this product.', { taskId, candidateId: candidateIdValue, status });
    }
    return storeError('PROCUREMENT_CONTACT_RECONCILIATION_REQUIRED', 'A previous contact attempt is unresolved. Check the 1688 conversation before any retry.', { taskId, candidateId: candidateIdValue, status });
}
function contactTransitionConflict(attempt, event) {
    return storeError('PROCUREMENT_CONTACT_ATTEMPT_CONFLICT', `Cannot record ${event} while the contact attempt is ${attempt.status}.`, { attemptId: attempt.id, status: attempt.status, event });
}
function assertNoSiblingContactEvidence(task, candidate, supplierLoginId) {
    const loginKey = supplierLoginId?.toLocaleLowerCase('en-US');
    const sibling = task.candidates.find((item) => (item.id !== candidate.id
        && item.contactAttempt
        && item.contactAttempt.status !== 'failed'
        && (item.supplierMemberId && candidate.supplierMemberId
            ? item.supplierMemberId === candidate.supplierMemberId
            : Boolean(loginKey && item.supplierLoginId?.toLocaleLowerCase('en-US') === loginKey))));
    if (!sibling?.contactAttempt)
        return;
    throw contactAttemptConflict(task.id, sibling.id, sibling.contactAttempt.status);
}
function snapshots(tasks) {
    const positions = queuePositions(tasks);
    return tasks.map((task) => ({ ...structuredClone(task), queuePosition: positions.get(task.id) ?? null }));
}
function snapshot(task, allTasks) {
    return {
        ...structuredClone(task),
        queuePosition: queuePositions(allTasks).get(task.id) ?? null,
    };
}
function queuePositions(tasks) {
    const positions = new Map();
    tasks
        .filter((task) => task.status === 'queued')
        .sort(compareQueueOrder)
        .forEach((task, index) => positions.set(task.id, index + 1));
    return positions;
}
function compareQueueOrder(left, right) {
    return (left.queueSequence ?? Number.MAX_SAFE_INTEGER)
        - (right.queueSequence ?? Number.MAX_SAFE_INTEGER);
}
function candidateId(taskId, offerId, factoryKey) {
    const hash = crypto
        .createHash('sha256')
        .update(`${taskId}\0${offerId}\0${factoryKey ?? ''}`)
        .digest('hex')
        .slice(0, 24);
    return `candidate_${hash}`;
}
async function withRootLock(key, operation) {
    const previous = rootLockTails.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    rootLockTails.set(key, tail);
    await previous;
    try {
        return await operation();
    }
    finally {
        release();
        if (rootLockTails.get(key) === tail)
            rootLockTails.delete(key);
    }
}
function assertEntityId(value, kind) {
    if (typeof value !== 'string' || !ENTITY_ID.test(value)) {
        throw storeError('PROCUREMENT_IDENTIFIER_INVALID', `The ${kind} ID is invalid.`, { kind });
    }
}
function normalizeNow(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw storeError('PROCUREMENT_CLOCK_INVALID', 'The procurement clock returned an invalid time.');
    }
    return date.toISOString();
}
function canonicalWindowsPath(value) {
    const normalized = value.replace(/^\\\\\?\\/, '').replaceAll('/', '\\');
    if (/^[A-Za-z]:\\$/.test(normalized))
        return normalized.toLocaleLowerCase('en-US');
    return normalized.replace(/\\+$/, '').toLocaleLowerCase('en-US');
}
function stateConflict(task, operation) {
    return storeError('PROCUREMENT_TASK_STATE_CONFLICT', `Cannot ${operation} task ${task.id} while it is ${task.status}.`, { taskId: task.id, status: task.status });
}
function confirmationInvalid(message) {
    return storeError('PROCUREMENT_CONFIRMATION_INVALID', message);
}
function offerInvalid(message) {
    return storeError('PROCUREMENT_OFFER_INVALID', message);
}
function candidateStrengthInvalid(message) {
    return storeError('PROCUREMENT_SUPPLIER_STRENGTH_INVALID', message);
}
function storeError(code, message, details = {}) {
    return new ProcurementStoreError(code, message, details);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function withoutUndefined(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
//# sourceMappingURL=store.js.map