import { structuredCloneSafe } from './utils.js';

const ASSISTANT_RUNTIME_KEYS = new Set(['id', 'role', 'versions', 'activeVersion', 'editing', 'expanded', 'isStreaming', 'startedAt']);

export function mergePersistedStates(baseState, localState, remoteState) {
  const base = normalizeState(baseState);
  const local = normalizeState(localState);
  const remote = normalizeState(remoteState);
  const sessions = mergeEntitiesById(base.sessions, local.sessions, remote.sessions, mergeSession);

  return {
    sessions: sortSessionsForStorage(sessions),
    activeSessionId: chooseActiveSessionId(base.activeSessionId, local.activeSessionId, remote.activeSessionId, sessions),
    settings: mergePlainObject(base.settings, local.settings, remote.settings),
    promptLibrary: mergeEntitiesById(base.promptLibrary, local.promptLibrary, remote.promptLibrary, mergePlainObject),
    jailbreakPresets: mergeEntitiesById(base.jailbreakPresets, local.jailbreakPresets, remote.jailbreakPresets, mergePlainObject),
    characterCards: mergeEntitiesById(base.characterCards, local.characterCards, remote.characterCards, mergePlainObject),
    worldBooks: mergeEntitiesById(base.worldBooks, local.worldBooks, remote.worldBooks, mergePlainObject),
    characterBookDecisions: mergePlainObject(base.characterBookDecisions, local.characterBookDecisions, remote.characterBookDecisions),
  };
}

function normalizeState(value) {
  const state = value && typeof value === 'object' ? value : {};
  return {
    sessions: Array.isArray(state.sessions) ? state.sessions : [],
    activeSessionId: state.activeSessionId || null,
    settings: state.settings && typeof state.settings === 'object' ? state.settings : {},
    promptLibrary: Array.isArray(state.promptLibrary) ? state.promptLibrary : [],
    jailbreakPresets: Array.isArray(state.jailbreakPresets) ? state.jailbreakPresets : [],
    characterCards: Array.isArray(state.characterCards) ? state.characterCards : [],
    worldBooks: Array.isArray(state.worldBooks) ? state.worldBooks : [],
    characterBookDecisions: state.characterBookDecisions && typeof state.characterBookDecisions === 'object' ? state.characterBookDecisions : {},
  };
}

function mergeEntitiesById(baseItems = [], localItems = [], remoteItems = [], mergeExisting = mergePlainObject) {
  const baseMap = mapById(baseItems);
  const localMap = mapById(localItems);
  const remoteMap = mapById(remoteItems);
  const ids = new Set([...baseMap.keys(), ...remoteMap.keys(), ...localMap.keys()]);
  const merged = [];

  for (const id of ids) {
    const item = mergeEntity(baseMap.get(id), localMap.get(id), remoteMap.get(id), mergeExisting);
    if (item) merged.push(item);
  }
  return merged;
}

function mapById(items) {
  const map = new Map();
  for (const item of items || []) {
    if (!item || typeof item !== 'object') continue;
    const id = item.id || fallbackIdentity(item);
    if (!id || map.has(id)) continue;
    map.set(id, item);
  }
  return map;
}

function fallbackIdentity(item) {
  return [item.role || item.name || 'item', item.createdAt || '', item.title || '', item.content || item.prompt || ''].join('\u0001');
}

function mergeEntity(base, local, remote, mergeExisting) {
  if (!base) {
    if (!local && !remote) return null;
    if (!local) return clone(remote);
    if (!remote) return clone(local);
    if (sameValue(local, remote)) return clone(local);
    return mergeExisting(null, local, remote);
  }

  if (!local && !remote) return null;
  if (!local) {
    // Local deletion wins only when the remote side did not change the entity.
    return sameValue(remote, base) ? null : clone(remote);
  }
  if (!remote) {
    // Remote deletion wins only when the local side did not change the entity.
    return sameValue(local, base) ? null : clone(local);
  }

  const localChanged = !sameValue(local, base);
  const remoteChanged = !sameValue(remote, base);
  const sessionMerge = mergeExisting === mergeSession;
  if (sessionMerge && (localChanged || remoteChanged)) {
    return mergeExisting(base, local, remote);
  }
  const assistantMessageMerge = mergeExisting === mergeMessage && (local?.role || remote?.role || base?.role) === 'assistant';
  if (assistantMessageMerge && (localChanged || remoteChanged)) {
    return mergeExisting(base, local, remote);
  }
  if (localChanged && remoteChanged) {
    if (sameValue(local, remote)) return clone(local);
    return mergeExisting(base, local, remote);
  }
  if (localChanged) return clone(local);
  if (remoteChanged) return clone(remote);
  return clone(remote);
}

function mergeSession(base = {}, local = {}, remote = {}) {
  const merged = mergePlainObjectWithoutKeys(base, local, remote, new Set(['messages', 'updatedAt']));
  merged.id = local?.id || remote?.id || base?.id || merged.id;
  merged.createdAt = earliestTimestamp(local?.createdAt, remote?.createdAt, base?.createdAt) || merged.createdAt;
  merged.messages = mergeMessages(base?.messages, local?.messages, remote?.messages);
  merged.updatedAt = latestTimestamp(local?.updatedAt, remote?.updatedAt, base?.updatedAt) || merged.updatedAt;
  return merged;
}

function mergeMessages(baseMessages = [], localMessages = [], remoteMessages = []) {
  const baseMap = mapById(baseMessages);
  const localMap = mapById(localMessages);
  const remoteMap = mapById(remoteMessages);
  const ids = new Set([...baseMap.keys(), ...remoteMap.keys(), ...localMap.keys()]);
  const mergedById = new Map();

  for (const id of ids) {
    const message = mergeEntity(baseMap.get(id), localMap.get(id), remoteMap.get(id), mergeMessage);
    if (message) mergedById.set(id, message);
  }

  const result = [];
  const used = new Set();
  for (const message of baseMessages || []) {
    const id = message?.id || fallbackIdentity(message || {});
    if (!mergedById.has(id)) continue;
    result.push(mergedById.get(id));
    used.add(id);
  }

  const additions = [...mergedById.entries()]
    .filter(([id]) => !used.has(id))
    .map(([id, message]) => ({
      id,
      message,
      order: Math.min(sourceIndex(localMessages, id), sourceIndex(remoteMessages, id)),
      time: timestampMs(message?.createdAt),
    }))
    .sort((a, b) => compareNullableNumbers(a.time, b.time) || compareNullableNumbers(a.order, b.order) || String(a.id).localeCompare(String(b.id)));

  result.push(...additions.map((entry) => entry.message));
  return result;
}

function mergeMessage(base = {}, local = {}, remote = {}) {
  const role = local?.role || remote?.role || base?.role;
  if (role !== 'assistant') return mergePlainObject(base, local, remote);

  const chosen = chooseAssistantMessageValue(base, local, remote);
  const merged = clone(chosen);
  merged.id = local?.id || remote?.id || base?.id || merged.id;
  merged.role = 'assistant';

  const snapshots = dedupeAssistantSnapshots([
    ...assistantSnapshotsFromMessage(base),
    ...assistantSnapshotsFromMessage(remote),
    ...assistantSnapshotsFromMessage(local),
  ]);
  const activeSnapshot = assistantSnapshotFromMessage(chosen);
  const activeKey = assistantSnapshotKey(activeSnapshot);
  if (activeKey && !snapshots.some((snapshot) => assistantSnapshotKey(snapshot) === activeKey)) {
    snapshots.push(activeSnapshot);
  }

  if (snapshots.length > 1) {
    merged.versions = snapshots;
    const activeIndex = snapshots.findIndex((snapshot) => assistantSnapshotKey(snapshot) === activeKey);
    merged.activeVersion = activeIndex >= 0 ? activeIndex : snapshots.length - 1;
  } else {
    merged.versions = [];
    merged.activeVersion = 0;
  }
  delete merged.editing;
  delete merged.expanded;
  delete merged.startedAt;
  merged.isStreaming = false;
  return merged;
}

function chooseAssistantMessageValue(base = {}, local = {}, remote = {}) {
  const chosen = chooseThreeWayValue(base, local, remote);
  return preferNonTruncatedAssistant(chosen, [local, remote, base]);
}

function preferNonTruncatedAssistant(chosen = {}, candidates = []) {
  const chosenText = assistantMessageText(chosen);
  let best = chosen;
  let bestText = chosenText;
  for (const candidate of candidates) {
    const candidateText = assistantMessageText(candidate);
    if (!candidateText || candidateText.length <= bestText.length + 80) continue;
    if (looksLikeTruncatedAssistant(bestText, candidateText)) {
      best = candidate;
      bestText = candidateText;
    }
  }
  return best;
}

function assistantMessageText(message = {}) {
  if (!message || typeof message !== 'object') return '';
  const active = Array.isArray(message.versions) && message.versions.length
    ? message.versions[message.activeVersion || 0] || message.versions.at(-1)
    : null;
  return String(active?.content || message.content || '');
}

function looksLikeTruncatedAssistant(shortText, longText) {
  const short = String(shortText || '').trim();
  const long = String(longText || '').trim();
  if (!short || !long || long.length <= short.length + 80) return false;
  if (long.startsWith(short)) return true;
  const prefix = commonPrefixLength(short, long);
  return prefix >= Math.min(short.length * 0.92, short.length - 20);
}

function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) index += 1;
  return index;
}

function mergePlainObject(base = {}, local = {}, remote = {}) {
  return mergePlainObjectWithoutKeys(base, local, remote);
}

function mergePlainObjectWithoutKeys(base = {}, local = {}, remote = {}, skipKeys = new Set()) {
  const merged = {};
  const keys = new Set([
    ...Object.keys(base || {}),
    ...Object.keys(remote || {}),
    ...Object.keys(local || {}),
  ]);
  for (const key of keys) {
    if (skipKeys.has(key)) continue;
    const value = chooseThreeWayValue(base?.[key], local?.[key], remote?.[key]);
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function chooseThreeWayValue(base, local, remote) {
  const hasLocal = local !== undefined;
  const hasRemote = remote !== undefined;
  if (!hasLocal && !hasRemote) return clone(base);
  if (!hasLocal) return clone(remote);
  if (!hasRemote) return clone(local);

  const localChanged = !sameValue(local, base);
  const remoteChanged = !sameValue(remote, base);
  if (localChanged && !remoteChanged) return clone(local);
  if (!localChanged && remoteChanged) return clone(remote);
  if (!localChanged && !remoteChanged) return clone(remote);
  if (sameValue(local, remote)) return clone(local);

  // Same-field edits are real conflicts. Prefer the current device for that
  // field, while entity/message merge keeps the other side's additions.
  return clone(local);
}

function assistantSnapshotsFromMessage(message) {
  if (!message || typeof message !== 'object') return [];
  const snapshots = [];
  if (Array.isArray(message.versions)) {
    for (const version of message.versions) snapshots.push(normalizeAssistantSnapshot(version));
  }
  snapshots.push(assistantSnapshotFromMessage(message));
  return snapshots.filter((snapshot) => assistantSnapshotKey(snapshot));
}

function assistantSnapshotFromMessage(message = {}) {
  const snapshot = {};
  for (const [key, value] of Object.entries(message || {})) {
    if (ASSISTANT_RUNTIME_KEYS.has(key)) continue;
    snapshot[key] = clone(value);
  }
  return normalizeAssistantSnapshot(snapshot);
}

function normalizeAssistantSnapshot(snapshot = {}) {
  const copy = clone(snapshot || {});
  delete copy.role;
  delete copy.id;
  delete copy.editing;
  delete copy.expanded;
  delete copy.isStreaming;
  delete copy.startedAt;
  copy.extra = copy.extra && typeof copy.extra === 'object' ? copy.extra : {};
  copy.reasoning_content ??= copy.extra.reasoning || '';
  delete copy.card_state;
  delete copy.extra.role_state;
  copy.suggestions = Array.isArray(copy.suggestions) ? copy.suggestions.filter(Boolean).slice(0, 6) : [];
  copy.toolCalls = Array.isArray(copy.toolCalls) ? copy.toolCalls : [];
  copy.content ??= '';
  copy.error ??= '';
  return copy;
}

function dedupeAssistantSnapshots(snapshots) {
  const seen = new Set();
  const result = [];
  for (const snapshot of snapshots) {
    const key = assistantSnapshotKey(snapshot);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(snapshot);
  }
  return result;
}

function assistantSnapshotKey(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const content = String(snapshot.content || '').trim();
  const suggestions = Array.isArray(snapshot.suggestions) ? snapshot.suggestions : [];
  const toolCalls = Array.isArray(snapshot.toolCalls) ? snapshot.toolCalls : [];
  const finishReason = String(snapshot.finishReason || '');
  const error = String(snapshot.error || '');
  if (!content && !suggestions.length && !toolCalls.length && !finishReason && !error && !snapshot.emptyReasoningOnly) return '';
  return [
    content,
    JSON.stringify(suggestions),
    JSON.stringify(toolCalls),
    finishReason,
    error,
  ].join('\u0001');
}

function chooseActiveSessionId(baseId, localId, remoteId, sessions) {
  const ids = new Set((sessions || []).map((session) => session.id).filter(Boolean));
  const chosen = chooseThreeWayValue(baseId || null, localId || null, remoteId || null);
  if (ids.has(chosen)) return chosen;
  if (ids.has(localId)) return localId;
  if (ids.has(remoteId)) return remoteId;
  if (ids.has(baseId)) return baseId;
  return sessions?.[0]?.id || null;
}

function sortSessionsForStorage(sessions) {
  return [...(sessions || [])].sort((a, b) => {
    const pinned = Number(Boolean(b?.pinned)) - Number(Boolean(a?.pinned));
    if (pinned) return pinned;
    return compareTimestampsDesc(a?.updatedAt, b?.updatedAt)
      || compareTimestampsDesc(a?.createdAt, b?.createdAt)
      || String(a?.id || '').localeCompare(String(b?.id || ''));
  });
}

function sourceIndex(messages = [], id) {
  const index = (messages || []).findIndex((message) => (message?.id || fallbackIdentity(message || {})) === id);
  return index < 0 ? Number.POSITIVE_INFINITY : index;
}

function latestTimestamp(...values) {
  return chooseTimestamp(values, (candidate, best) => candidate > best);
}

function earliestTimestamp(...values) {
  return chooseTimestamp(values, (candidate, best) => candidate < best);
}

function chooseTimestamp(values, isBetter) {
  let bestValue = '';
  let bestTime = null;
  for (const value of values) {
    if (!value) continue;
    const time = timestampMs(value);
    if (!Number.isFinite(time)) {
      if (!bestValue) bestValue = value;
      continue;
    }
    if (bestTime === null || isBetter(time, bestTime)) {
      bestTime = time;
      bestValue = value;
    }
  }
  return bestValue;
}

function timestampMs(value) {
  if (!value) return Number.NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.NaN;
}

function compareTimestampsDesc(left, right) {
  const leftTime = timestampMs(left);
  const rightTime = timestampMs(right);
  const leftFinite = Number.isFinite(leftTime);
  const rightFinite = Number.isFinite(rightTime);
  if (leftFinite && rightFinite && leftTime !== rightTime) return rightTime - leftTime;
  if (leftFinite && !rightFinite) return -1;
  if (!leftFinite && rightFinite) return 1;
  return 0;
}

function compareNullableNumbers(a, b) {
  const aFinite = Number.isFinite(a);
  const bFinite = Number.isFinite(b);
  if (aFinite && bFinite && a !== b) return a - b;
  if (aFinite && !bFinite) return -1;
  if (!aFinite && bFinite) return 1;
  return 0;
}

function sameValue(a, b) {
  return fingerprint(a) === fingerprint(b);
}

function fingerprint(value) {
  if (value === undefined) return '__undefined__';
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function clone(value) {
  if (value === undefined) return undefined;
  return structuredCloneSafe(value);
}
