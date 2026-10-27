// DriverOutbox: durable offline submission queue for the Driver PWA (#45).
//
// Every driver mutation (pre-trip inspection, stop completion, receipt,
// instruction confirmation) that fails to reach the backend is queued with a
// stable operation ID and replayed in order when connectivity returns.
//
// Storage (R3: a 16 h shift offline): the queue index lives in localStorage;
// photo data URLs move to IndexedDB, so a long offline shift cannot exhaust
// localStorage's ~5 M-character quota. Without IndexedDB the photos stay
// inline, and a full localStorage throws OutboxStorageFullError: the caller
// tells the driver and keeps the form, nothing is dropped silently.
//
// Replay (audit gap 9): a stop completion repeated on the server returns 200
// and a pre-trip has no "already done" conflict, so a 409 (or 400/404/422)
// there is a real rejection (cancelled SPJ, wrong stop order, bad
// coordinates). Rejections move to a "needs action" list with the server's
// reason and are never counted as synced. Only a receipt 409 still means
// "already recorded" (the server answers a same-operation replay itself).
import { apiFetch, FIELD_TOKEN_KEY } from "../../shared/api/client.js";
import { apiErrorText, responseError } from "../../shared/api/errorText.js";

const KEY = "pythia_driver_outbox";
const REJECTED_KEY = "pythia_driver_outbox_rejected";
const LAST_SYNC_KEY = "pythia_driver_last_sync";
export const OUTBOX_CHANGED_EVENT = "pythia-driver-outbox-changed";

const CONFLICT_MEANS_DONE = ["/receipt"];
const REJECTION_STATUSES = new Set([400, 404, 409, 422]);

export class OutboxStorageFullError extends Error {
  constructor() {
    super("outbox_storage_full");
    this.name = "OutboxStorageFullError";
    this.code = "storage_full";
  }
}

function notifyChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(OUTBOX_CHANGED_EVENT));
}

function readList(key) {
  try {
    const raw = localStorage.getItem(key);
    const items = raw ? JSON.parse(raw) : [];
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function isQuotaError(error) {
  return (
    error?.name === "QuotaExceededError" ||
    error?.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    error?.code === 22 ||
    error?.code === 1014
  );
}

function writeList(key, items) {
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch (error) {
    if (isQuotaError(error)) throw new OutboxStorageFullError();
    throw error;
  }
}

export function readDriverOutbox() {
  return readList(KEY);
}

export function readRejectedOperations() {
  return readList(REJECTED_KEY);
}

export function dismissRejectedOperation(opId) {
  try {
    writeList(
      REJECTED_KEY,
      readRejectedOperations().filter((item) => item.op_id !== opId),
    );
  } catch {
    // Removing entries cannot exceed the quota; storage blocked: nothing to do.
  }
  notifyChanged();
}

export function readLastSync() {
  try {
    return localStorage.getItem(LAST_SYNC_KEY);
  } catch {
    return null;
  }
}

// Stamp a live (non-cached) server round trip.
export function markDriverSynced(at = new Date()) {
  try {
    localStorage.setItem(LAST_SYNC_KEY, at.toISOString());
  } catch {
    // Best effort: the timestamp is informational.
  }
}

// cyrb53: a short, stable identity for (path, data); the old fingerprint was
// the whole JSON body, which stored every photo twice.
export function fingerprintOf(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// ── IndexedDB photo store ─────────────────────────────────────────────────────

const DB_NAME = "pythia-driver-outbox";
const STORE = "photos";
let dbPromise = null;

function openDb() {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("no indexeddb"));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("indexeddb blocked"));
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

async function idb(mode, run) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = run(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("aborted"));
  });
}

// Every image data URL goes to IndexedDB whatever its size: a size cut-off let
// small (shrunk or low-light) photos stay inline in the localStorage index.
function isPhotoString(value) {
  return typeof value === "string" && value.startsWith("data:image/");
}

// Replace photo strings with {"$photo": key}; returns [stripped, photos].
export function extractPhotos(data, opId) {
  const photos = [];
  const walk = (value) => {
    if (isPhotoString(value)) {
      const key = `${opId}#${photos.length}`;
      photos.push([key, value]);
      return { $photo: key };
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return [walk(data), photos];
}

export function photoKeysOf(data) {
  const keys = [];
  const walk = (value) => {
    if (value && typeof value === "object") {
      if (typeof value.$photo === "string") keys.push(value.$photo);
      else Object.values(value).forEach(walk);
    }
  };
  walk(data);
  return keys;
}

async function storePhotos(photos) {
  await idb("readwrite", (store) => photos.forEach(([key, value]) => store.put(value, key)));
}

async function deletePhotos(keys) {
  if (keys.length === 0) return;
  try {
    await idb("readwrite", (store) => keys.forEach((key) => store.delete(key)));
  } catch {
    // An orphaned photo only wastes space; never block the queue on it.
  }
}

async function hydrate(data) {
  const keys = photoKeysOf(data);
  if (keys.length === 0) return data;
  const values = new Map();
  await idb("readonly", (store) => {
    keys.forEach((key) => {
      const request = store.get(key);
      request.onsuccess = () => values.set(key, request.result);
    });
  });
  const walk = (value) => {
    if (value && typeof value === "object" && typeof value.$photo === "string") {
      const photo = values.get(value.$photo);
      if (typeof photo !== "string") throw new Error("photo_missing");
      return photo;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk(data);
}

function newOperationId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Queue one durable mutation. `path` is the API path (e.g. "/spj/<id>/stops/0/complete"),
// `data` the JSON body, `label` a short human identifier used by the UI.
// Re-enqueueing the same (path, data) pair replaces the pending entry instead
// of duplicating it. Throws OutboxStorageFullError when the phone is out of
// storage; the queue is left unchanged then.
export async function enqueueDriverOperation({ path, data, label }) {
  const items = readDriverOutbox();
  const fingerprint = fingerprintOf(JSON.stringify({ path, data }));
  const existing = items.findIndex((item) => item.fingerprint === fingerprint);
  const opId = existing >= 0 ? items[existing].op_id : newOperationId();
  if (existing >= 0) await deletePhotos(photoKeysOf(items[existing].data));

  let stored = data;
  let photoKeys = [];
  const [stripped, photos] = extractPhotos(data, opId);
  if (photos.length > 0) {
    try {
      await storePhotos(photos);
      stored = stripped;
      photoKeys = photos.map(([key]) => key);
    } catch {
      stored = data; // No IndexedDB (private mode, old WebView): keep inline.
    }
  }
  const entry = {
    op_id: opId,
    path,
    data: stored,
    label: label || path,
    fingerprint,
    queued_at: existing >= 0 ? items[existing].queued_at : new Date().toISOString(),
    attempts: existing >= 0 ? items[existing].attempts : 0,
  };
  if (existing >= 0) items[existing] = entry;
  else items.push(entry);
  try {
    writeList(KEY, items);
  } catch (error) {
    await deletePhotos(photoKeys);
    throw error;
  }
  notifyChanged();
  return items.length;
}

// The retired /field app queued instruction confirmations under its own key.
// They move into this outbox once, with their operation ids, so nothing a
// driver queued before the merge is lost; the old key goes only when all moved.
const LEGACY_FIELD_KEY = "pythia_field_outbox";

export async function adoptFieldOutbox() {
  const legacy = readList(LEGACY_FIELD_KEY);
  if (legacy.length === 0) return 0;
  let moved = 0;
  try {
    for (const entry of legacy) {
      if (typeof entry?.dispatchId !== "string" || typeof entry?.status !== "string") continue;
      await enqueueDriverOperation({
        path: `/dispatch/${encodeURIComponent(entry.dispatchId)}/confirm`,
        data: {
          status: entry.status,
          note: typeof entry.note === "string" ? entry.note : "",
          ...(typeof entry.operation_id === "string" ? { operation_id: entry.operation_id } : {}),
        },
        label: entry.dispatchId,
      });
      moved += 1;
    }
    localStorage.removeItem(LEGACY_FIELD_KEY);
  } catch {
    // Storage full or blocked: the old queue stays and is retried next start.
  }
  return moved;
}

// Stops the outbox will mark completed once it syncs: "<spj_id>:<index>".
export function queuedStopKeys(items = readDriverOutbox()) {
  const keys = new Set();
  for (const item of items) {
    const match = /^\/spj\/([^/]+)\/stops\/(\d+)\/complete$/.exec(item.path || "");
    if (match) keys.add(`${match[1]}:${Number(match[2])}`);
  }
  return keys;
}

// #45: single-flight — concurrent flush attempts would replay the same
// entry against each other.
let flushInFlight = false;

export async function flushDriverOutbox() {
  if (flushInFlight) {
    return { flushed: 0, remaining: readDriverOutbox().length, rejected: [], unauthorized: false };
  }
  flushInFlight = true;
  try {
    return await doFlushDriverOutbox();
  } finally {
    flushInFlight = false;
  }
}

async function readDetail(res) {
  const body = await res.json().catch(() => ({}));
  const lang = document.documentElement.lang === "id" ? "id" : "en";
  if (Array.isArray(body?.detail)) {
    return lang === "en" ? body.detail.map((d) => d?.msg || "").join("; ") : "";
  }
  return apiErrorText(lang, responseError(res.status, body), "");
}

async function doFlushDriverOutbox() {
  const items = readDriverOutbox();
  if (items.length === 0) return { flushed: 0, remaining: 0, rejected: [], unauthorized: false };
  const processed = new Set();
  const attempted = new Set();
  const rejected = [];
  let flushed = 0;
  let unauthorized = false;
  // Strict FIFO: stop N+1 must never reach the server before stop N, so the
  // first entry that cannot be delivered now halts the replay.
  for (const item of items) {
    let data;
    try {
      data = await hydrate(item.data);
    } catch {
      rejected.push({
        op_id: item.op_id,
        label: item.label,
        path: item.path,
        status: 0,
        reason: "photo_missing",
        detail: "",
        at: new Date().toISOString(),
      });
      processed.add(item.op_id);
      continue;
    }
    let res;
    try {
      res = await apiFetch(item.path, {
        method: "POST",
        headers: { "X-Operation-Id": item.op_id },
        body: data,
        tokenKey: FIELD_TOKEN_KEY,
      });
    } catch {
      attempted.add(item.op_id); // Network still down: keep it, retry later.
      break;
    }
    const done = res.ok || (res.status === 409 && CONFLICT_MEANS_DONE.some((p) => item.path.includes(p)));
    if (done) {
      flushed += 1;
      processed.add(item.op_id);
      markDriverSynced();
      continue;
    }
    if (res.status === 401) {
      unauthorized = true; // Session gone: keep everything for after sign-in.
      break;
    }
    if (REJECTION_STATUSES.has(res.status)) {
      rejected.push({
        op_id: item.op_id,
        label: item.label,
        path: item.path,
        status: res.status,
        reason: "server",
        detail: await readDetail(res),
        at: new Date().toISOString(),
      });
      processed.add(item.op_id);
      markDriverSynced();
      continue;
    }
    attempted.add(item.op_id); // 5xx / 403 / 429: retry later, in order.
    break;
  }

  // Re-read: entries queued while this flush ran must survive it.
  const current = readDriverOutbox();
  const remaining = current
    .filter((item) => !processed.has(item.op_id))
    .map((item) => (attempted.has(item.op_id) ? { ...item, attempts: (item.attempts || 0) + 1 } : item));
  const gone = current.filter((item) => processed.has(item.op_id));
  try {
    writeList(KEY, remaining);
    if (rejected.length > 0) writeList(REJECTED_KEY, [...readRejectedOperations(), ...rejected]);
  } catch {
    // Shrinking the queue cannot exceed the quota; a blocked storage keeps
    // the old queue, and the replay stays idempotent.
  }
  await deletePhotos(gone.flatMap((item) => photoKeysOf(item.data)));
  if (processed.size > 0 || attempted.size > 0) notifyChanged();
  return { flushed, remaining: remaining.length, rejected, unauthorized };
}
