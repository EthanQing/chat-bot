const DB_NAME = 'deepseek-streaming-chatbot-db';
const DB_VERSION = 1;
const STORE_NAME = 'kv';
const APP_STATE_KEY = 'app-state';
const META_SUFFIX = '.storage-meta';
const LOCAL_STORAGE_SOFT_LIMIT = 4_500_000;

let dbPromise = null;
let lastServerUpdatedAt = null;
let lastServerRevision = null;

export async function loadPersistedState(legacyStorageKey) {
  const local = await loadLocalPersistedState(legacyStorageKey);
  const server = await loadServerState().catch(() => null);
  if (server?.exists) {
    if (local.data && shouldPreferLocalOverServer(local.data, server.data)) {
      const saved = await saveServerState(local.data).catch(() => null);
      if (saved?.updatedAt) lastServerUpdatedAt = saved.updatedAt;
      if (Number.isFinite(saved?.revision)) lastServerRevision = saved.revision;
      return { data: local.data, backend: 'server-migrated-from-local' };
    }
    if (server.data) {
      lastServerUpdatedAt = server.updatedAt || null;
      lastServerRevision = Number.isFinite(server.revision) ? server.revision : 0;
      await saveLocalPersistedState(legacyStorageKey, server.data, 'server-file').catch(() => null);
      return { data: server.data, backend: 'server-file', updatedAt: server.updatedAt || null, revision: lastServerRevision };
    }
  }
  if (local.data) {
    const saved = await saveServerState(local.data).catch(() => null);
    if (saved?.ok) {
      lastServerUpdatedAt = saved.updatedAt || null;
      lastServerRevision = Number.isFinite(saved.revision) ? saved.revision : null;
      await saveLocalPersistedState(legacyStorageKey, local.data, 'server-file').catch(() => null);
      return { data: local.data, backend: 'server-migrated-from-local', updatedAt: saved.updatedAt || null, revision: lastServerRevision };
    }
    return local;
  }
  return { data: null, backend: server ? 'server-file' : local.backend };
}

export async function savePersistedState(legacyStorageKey, data, { force = false } = {}) {
  const saved = await saveServerState(data, { force }).catch((error) => {
    if (error?.conflict) throw error;
    return null;
  });
  if (saved?.ok) {
    lastServerUpdatedAt = saved.updatedAt || null;
    lastServerRevision = Number.isFinite(saved.revision) ? saved.revision : lastServerRevision;
    await saveLocalPersistedState(legacyStorageKey, data, 'server-file').catch(() => null);
    return 'server-file';
  }
  return saveLocalPersistedState(legacyStorageKey, data);
}

export async function peekServerPersistedState() {
  const server = await loadServerState();
  if (!server?.exists || !server.data) return { data: null, updatedAt: server?.updatedAt || null, backend: 'server-file' };
  return { data: server.data, updatedAt: server.updatedAt || null, revision: Number.isFinite(server.revision) ? server.revision : 0, backend: 'server-file' };
}

export function getLastServerUpdatedAt() {
  return lastServerUpdatedAt;
}

export function markServerStateApplied(updatedAt) {
  lastServerUpdatedAt = updatedAt || lastServerUpdatedAt;
}

export function getLastServerRevision() {
  return lastServerRevision;
}

export function markServerRevisionApplied(revision) {
  if (Number.isFinite(revision)) lastServerRevision = revision;
}

async function loadLocalPersistedState(legacyStorageKey) {
  const db = await openDatabase().catch(() => null);
  if (db) {
    const idbData = await idbGet(db, APP_STATE_KEY).catch(() => null);
    if (idbData?.data) return { data: idbData.data, backend: 'indexeddb' };
  }

  const legacyData = loadLegacyLocalStorage(legacyStorageKey);
  if (legacyData && db) {
    await idbSet(db, APP_STATE_KEY, { data: legacyData, updatedAt: new Date().toISOString() }).catch(() => null);
    writeStorageMeta(legacyStorageKey, 'migrated-to-indexeddb');
    return { data: legacyData, backend: 'localStorage-migrated' };
  }
  if (legacyData) return { data: legacyData, backend: 'localStorage' };
  return { data: null, backend: db ? 'indexeddb' : 'memory' };
}

async function saveLocalPersistedState(legacyStorageKey, data, backendLabel = null) {
  const payload = { data, updatedAt: new Date().toISOString() };
  const db = await openDatabase().catch(() => null);
  if (db) {
    await idbSet(db, APP_STATE_KEY, payload);
    writeLocalStorageShadow(legacyStorageKey, data, backendLabel || 'indexeddb');
    return backendLabel || 'indexeddb';
  }

  localStorage.setItem(legacyStorageKey, JSON.stringify(data));
  writeStorageMeta(legacyStorageKey, backendLabel || 'localStorage');
  return backendLabel || 'localStorage';
}

export function loadLegacyLocalStorage(legacyStorageKey) {
  try {
    const raw = localStorage.getItem(legacyStorageKey);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function openDatabase() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB is not available'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
  });
  return dbPromise;
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result?.value || null);
    request.onerror = () => reject(request.error);
  });
}

function idbSet(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

function writeLocalStorageShadow(legacyStorageKey, data, backend) {
  try {
    const json = JSON.stringify(data);
    if (json.length <= LOCAL_STORAGE_SOFT_LIMIT) {
      localStorage.setItem(legacyStorageKey, json);
    }
    writeStorageMeta(legacyStorageKey, backend, json.length);
  } catch (_) {
    writeStorageMeta(legacyStorageKey, backend);
  }
}

function writeStorageMeta(legacyStorageKey, backend, size = undefined) {
  try {
    localStorage.setItem(`${legacyStorageKey}${META_SUFFIX}`, JSON.stringify({
      backend,
      size,
      updatedAt: new Date().toISOString(),
    }));
  } catch (_) {
    // Ignore metadata failures; IndexedDB remains the source of truth.
  }
}

async function loadServerState() {
  const response = await fetch('/api/state', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error(`Server state load failed: HTTP ${response.status}`);
  return response.json();
}

async function saveServerState(data, { force = false } = {}) {
  const response = await fetch('/api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ data, baseRevision: lastServerRevision, force }),
    credentials: 'same-origin',
  });
  if (!response.ok) {
    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    const error = new Error(payload?.error || `Server state save failed: HTTP ${response.status}`);
    if (response.status === 409 && payload?.conflict) {
      error.conflict = true;
      error.remote = payload.current || null;
    }
    throw error;
  }
  return response.json();
}

function shouldPreferLocalOverServer(localData, serverData) {
  const localScore = stateRichnessScore(localData);
  const serverScore = stateRichnessScore(serverData);
  if (localScore <= serverScore) return false;
  // Protect the common migration case: a phone opens the app first and creates
  // a nearly empty server state, while the desktop browser still has the real
  // IndexedDB history. Once the server has meaningful content, keep it as the
  // shared source of truth and use last-write-wins on future saves.
  return serverScore <= 20;
}

function stateRichnessScore(data) {
  if (!data || typeof data !== 'object') return 0;
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const messages = sessions.reduce((sum, session) => sum + (Array.isArray(session.messages) ? session.messages.length : 0), 0);
  const configuredSessions = sessions.reduce((sum, session) => {
    return sum + Number(Boolean(
      session.characterCard ||
      session.worldBook ||
      String(session.jailbreakPrompt || '').trim() ||
      String(session.background || '').trim() ||
      String(session.userPersona || '').trim(),
    ));
  }, 0);
  const promptLibrary = Array.isArray(data.promptLibrary) ? data.promptLibrary.length : 0;
  const hasApiKey = Boolean(String(data.settings?.apiKey || '').trim());
  return sessions.length + messages * 10 + configuredSessions * 30 + promptLibrary * 3 + Number(hasApiKey) * 30;
}
