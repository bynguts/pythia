// Carries browser state saved before the JWIS -> Pythia rebrand (jwis_* keys)
// over to the pythia_* keys the app now reads. Imported first by main.jsx so it
// runs before any module touches localStorage.
//
// A key the new build has not written yet is simply moved. If both exist — an
// old tab kept writing after the upgrade — the offline outboxes are merged so a
// queued field confirmation or driver submission is never dropped; for every
// other key the pythia_ value wins.
const LEGACY_PREFIX = "jwis_";
const PREFIX = "pythia_";

// Queue identity, matching each outbox's own enqueue dedup.
const OUTBOX_IDENTITY = {
  pythia_field_outbox: (item) => `${item.dispatchId}|${item.status}`,
  pythia_driver_outbox: (item) => item.fingerprint || item.op_id,
};

function parseList(raw) {
  try {
    const items = JSON.parse(raw);
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function mergeOutbox(currentRaw, legacyRaw, identity) {
  const merged = parseList(currentRaw);
  const seen = new Set(merged.map(identity));
  for (const item of parseList(legacyRaw)) {
    if (!seen.has(identity(item))) {
      merged.push(item);
      seen.add(identity(item));
    }
  }
  return JSON.stringify(merged);
}

export function migrateLegacyStorage(storage = globalThis.localStorage) {
  if (!storage) return 0;
  let moved = 0;
  try {
    const legacyKeys = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && key.startsWith(LEGACY_PREFIX)) legacyKeys.push(key);
    }
    for (const legacyKey of legacyKeys) {
      const key = PREFIX + legacyKey.slice(LEGACY_PREFIX.length);
      const legacyValue = storage.getItem(legacyKey);
      const current = storage.getItem(key);
      if (current === null) {
        storage.setItem(key, legacyValue);
      } else if (OUTBOX_IDENTITY[key]) {
        storage.setItem(key, mergeOutbox(current, legacyValue, OUTBOX_IDENTITY[key]));
      }
      storage.removeItem(legacyKey);
      moved += 1;
    }
  } catch {
    // Storage disabled or full: the app still runs, just without old state.
  }
  return moved;
}

migrateLegacyStorage();
