import {
  loadInitialPersistedState,
  saveSnapshotToServer,
  replaceAllServerState,
  loadConversationFromServer,
  getServerRevision,
  onRemoteSnapshot,
  onConnectionStatus,
} from './data-client.js';

let lastServerUpdatedAt = null;

export async function loadPersistedState() {
  const data = await loadInitialPersistedState();
  lastServerUpdatedAt = new Date().toISOString();
  return {
    data,
    backend: 'sqlite-websocket',
    updatedAt: lastServerUpdatedAt,
    revision: getServerRevision(),
  };
}

export async function savePersistedState(_legacyStorageKey, data, options = {}) {
  await saveSnapshotToServer(data, options);
  lastServerUpdatedAt = new Date().toISOString();
  return 'sqlite-websocket';
}

export async function replaceAllPersistedState(data) {
  await replaceAllServerState(data);
  lastServerUpdatedAt = new Date().toISOString();
  return 'sqlite-websocket';
}

export async function loadConversationPersistedState(conversationId) {
  return loadConversationFromServer(conversationId);
}

export function onRemoteStateChange(handler) {
  return onRemoteSnapshot(handler);
}

export function onDataConnectionStatusChange(handler) {
  return onConnectionStatus(handler);
}

// Browser-side business data persistence has intentionally been removed.
// These legacy exports remain as no-op compatibility shims while app.js is
// incrementally moving from snapshot saves to operation-level writes.
export async function saveLocalPersistedStateOnly() {
  return 'sqlite-websocket';
}

export async function peekServerStateMeta() {
  return {
    exists: true,
    updatedAt: lastServerUpdatedAt,
    revision: getServerRevision(),
    bytes: 0,
    backend: 'sqlite-websocket',
  };
}

export async function peekServerPersistedState() {
  const loaded = await loadPersistedState();
  return {
    data: loaded.data,
    updatedAt: loaded.updatedAt,
    revision: loaded.revision,
    backend: 'sqlite-websocket',
  };
}

export function getLastServerUpdatedAt() {
  return lastServerUpdatedAt;
}

export function markServerStateApplied(updatedAt) {
  lastServerUpdatedAt = updatedAt || lastServerUpdatedAt;
}

export function getLastServerRevision() {
  return getServerRevision();
}

export function markServerRevisionApplied() {
  // Revision is owned by the WebSocket data client.
}

export function loadLegacyLocalStorage() {
  return null;
}
