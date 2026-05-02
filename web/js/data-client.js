import { DEFAULT_SETTINGS, DEFAULT_SYSTEM_PROMPT } from './config.js';
import { nowISO, uid, structuredCloneSafe } from './utils.js';

const RESOURCE_KINDS = ['jailbreakPreset', 'characterCard', 'worldBook', 'regexScript', 'reasoningTemplate'];

const GLOBAL_SETTING_PATHS = {
  'api.apiKey': ['apiKey'],
  'api.baseUrl': ['baseUrl'],
  'api.betaBaseUrl': ['betaBaseUrl'],
  'api.useProxy': ['useProxy'],
  'model.name': ['model'],
  'model.temperature': ['temperature'],
  'model.topP': ['topP'],
  'model.maxTokens': ['maxTokens'],
  'model.responseLength': ['responseLength'],
  'model.customLength': ['customLength'],
  'model.presencePenalty': ['presencePenalty'],
  'model.frequencyPenalty': ['frequencyPenalty'],
  'model.stop': ['stop'],
  'thinking.enabled': ['thinking'],
  'thinking.reasoningEffort': ['reasoningEffort'],
  'output.jsonMode': ['jsonMode'],
  'output.prefixEnabled': ['prefixEnabled'],
  'output.assistantPrefix': ['assistantPrefix'],
  'tools.enabled': ['toolsEnabled'],
  'tools.json': ['toolsJson'],
  'formatting.chatDisplayMode': ['formatting', 'chatDisplayMode'],
  'formatting.showTags': ['formatting', 'showTagsInResponses'],
  'formatting.autoFixMarkdown': ['formatting', 'autoFixMarkdown'],
  'formatting.showReasoningBlocks': ['formatting', 'showReasoningBlocks'],
  'formatting.allowScopedRegex': ['formatting', 'allowScopedRegex'],
  'ui.theme': ['theme'],
  'ui.fontScale': ['fontScale'],
  'ui.timestamps': ['showTimestamps'],
  'ui.lineNumbers': ['lineNumbers'],
  characterBookDecisions: ['characterBookDecisions'],
};

const SESSION_SETTING_PATHS = {
  systemPrompt: ['systemPrompt'],
  'jailbreak.enabled': ['jailbreakEnabled'],
  'jailbreak.prompt': ['jailbreakPrompt'],
  'jailbreak.source': ['jailbreakSource'],
  'jailbreak.importMeta': ['jailbreakImportMeta'],
  'jailbreak.importKind': ['jailbreakImportKind'],
  'jailbreak.parsed': ['jailbreakParsed'],
  'jailbreak.messages': ['jailbreakMessages'],
  'jailbreak.layout': ['jailbreakLayout'],
  'jailbreak.settings': ['jailbreakSettings'],
  'jailbreak.presetId': ['jailbreakPresetId'],
  'jailbreak.postHistoryInstructions': ['jailbreakPostHistoryInstructions'],
  'persona.userName': ['userName'],
  'persona.userPersona': ['userPersona'],
  'rp.enabled': ['rpMode'],
  'rp.perspective': ['rpPerspective'],
  'rp.suggestions': ['rpSuggestions'],
  'rp.memory': ['rpMemory'],
  'background.enabled': ['backgroundEnabled'],
  'background.text': ['background'],
  'character.enabled': ['characterCardEnabled'],
  'character.cardId': ['characterCardId'],
  'character.card': ['characterCard'],
  'character.greetingIndex': ['greetingIndex'],
  'character.bookHandling': ['characterBookHandling'],
  'worldBook.enabled': ['worldBookEnabled'],
  'worldBook.book': ['worldBook'],
  'worldBook.scanDepth': ['worldBookScanDepth'],
  'worldBook.maxEntries': ['worldBookMaxEntries'],
  'worldBook.tokenBudget': ['worldBookTokenBudget'],
  'worldBook.recursive': ['worldBookRecursive'],
  'worldBook.activeIds': ['activeWorldBookIds'],
  'session.stats': ['stats'],
};

const RESOURCE_TO_STATE = {
  jailbreakPreset: ['jailbreakPresets'],
  characterCard: ['characterCards'],
  worldBook: ['worldBooks'],
  regexScript: ['settings', 'formatting', 'regexScripts'],
  reasoningTemplate: ['settings', 'formatting', 'reasoningTemplates'],
};

function getPath(object, path, fallback = undefined) {
  let cursor = object;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || !(key in cursor)) return fallback;
    cursor = cursor[key];
  }
  return cursor;
}

function hasPath(object, path) {
  let cursor = object;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || !(key in cursor)) return false;
    cursor = cursor[key];
  }
  return true;
}

function setPath(object, path, value) {
  let cursor = object;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[path[path.length - 1]] = value;
}

function deletePath(object, path) {
  let cursor = object;
  for (let index = 0; index < path.length - 1; index += 1) {
    cursor = cursor?.[path[index]];
    if (!cursor || typeof cursor !== 'object') return;
  }
  delete cursor[path[path.length - 1]];
}

function deepEqual(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function clone(value) {
  return structuredCloneSafe(value ?? null);
}

function defaultSessionFromMeta(meta = {}) {
  const now = nowISO();
  return {
    id: meta.id || uid('session'),
    title: meta.title || '新会话',
    pinned: Boolean(meta.pinned),
    createdAt: meta.createdAt || meta.created_at || now,
    updatedAt: meta.updatedAt || meta.updated_at || meta.createdAt || now,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    jailbreakEnabled: false,
    jailbreakPrompt: '',
    jailbreakSource: '',
    jailbreakImportMeta: null,
    jailbreakImportKind: '',
    jailbreakParsed: false,
    jailbreakMessages: [],
    jailbreakLayout: [],
    jailbreakSettings: {},
    jailbreakPresetId: '',
    jailbreakPostHistoryInstructions: '',
    userName: '',
    userPersona: '',
    rpMode: false,
    rpPerspective: 'second',
    rpSuggestions: true,
    rpMemory: '',
    background: '',
    backgroundEnabled: true,
    characterCardEnabled: true,
    characterCard: null,
    characterCardId: '',
    greetingIndex: 0,
    characterBookHandling: null,
    worldBookEnabled: false,
    worldBook: null,
    worldBookScanDepth: 4,
    worldBookMaxEntries: 12,
    worldBookTokenBudget: 1200,
    worldBookRecursive: false,
    activeWorldBookIds: [],
    messages: [],
    stats: {},
    messageCount: Number.isFinite(meta.messageCount) ? meta.messageCount : 0,
  };
}

function appSettingsFromFlat(flat = {}, resources = {}) {
  const settings = clone(DEFAULT_SETTINGS);
  for (const [key, path] of Object.entries(GLOBAL_SETTING_PATHS)) {
    if (key === 'characterBookDecisions') continue;
    if (Object.prototype.hasOwnProperty.call(flat, key)) setPath(settings, path, clone(flat[key]));
  }
  settings.formatting ||= {};
  if (Array.isArray(resources.reasoningTemplate)) settings.formatting.reasoningTemplates = clone(resources.reasoningTemplate);
  if (Array.isArray(resources.regexScript)) settings.formatting.regexScripts = clone(resources.regexScript);
  return settings;
}

function flatSettingsFromAppState(snapshot = {}) {
  const result = {};
  const settings = snapshot.settings || {};
  for (const [key, path] of Object.entries(GLOBAL_SETTING_PATHS)) {
    if (key === 'characterBookDecisions') {
      if (snapshot.characterBookDecisions && typeof snapshot.characterBookDecisions === 'object') result[key] = clone(snapshot.characterBookDecisions);
      continue;
    }
    if (hasPath(settings, path)) result[key] = clone(getPath(settings, path));
  }
  if (snapshot.activeSessionId) result.activeSessionId = snapshot.activeSessionId;
  return result;
}

function sessionFromConversation(conversation = {}) {
  const session = defaultSessionFromMeta(conversation);
  session.messages = Array.isArray(conversation.messages) ? clone(conversation.messages) : [];
  session.messageCount = session.messages.length;
  const settings = conversation.settings || {};
  for (const [key, path] of Object.entries(SESSION_SETTING_PATHS)) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) setPath(session, path, clone(settings[key]));
  }
  return session;
}

function conversationSettingsFromSession(session = {}) {
  const result = {};
  for (const [key, path] of Object.entries(SESSION_SETTING_PATHS)) {
    if (hasPath(session, path)) result[key] = clone(getPath(session, path));
  }
  return result;
}

function resourcesFromSnapshot(snapshot = {}) {
  return {
    jailbreakPreset: clone(snapshot.jailbreakPresets || []),
    characterCard: clone(snapshot.characterCards || []),
    worldBook: clone(snapshot.worldBooks || []),
    regexScript: clone(snapshot.settings?.formatting?.regexScripts || []),
    reasoningTemplate: clone(snapshot.settings?.formatting?.reasoningTemplates || []),
  };
}

function stateFromBootstrap(bootstrap = {}) {
  const resources = bootstrap.resources || {};
  const state = {
    sessions: Array.isArray(bootstrap.conversations) ? bootstrap.conversations.map(defaultSessionFromMeta) : [],
    activeSessionId: bootstrap.activeSessionId || null,
    settings: appSettingsFromFlat(bootstrap.settings || {}, resources),
    jailbreakPresets: clone(resources.jailbreakPreset || []),
    characterCards: clone(resources.characterCard || []),
    worldBooks: clone(resources.worldBook || []),
    characterBookDecisions: clone((bootstrap.settings || {}).characterBookDecisions || {}),
  };
  if (!state.activeSessionId && state.sessions.length) state.activeSessionId = state.sessions[0].id;
  return state;
}

function stateFromLegacySnapshot(snapshot = {}) {
  const data = snapshot.data && typeof snapshot.data === 'object' ? snapshot.data : snapshot;
  return {
    sessions: clone(data.sessions || []),
    activeSessionId: data.activeSessionId || data.sessions?.[0]?.id || null,
    settings: clone(data.settings || DEFAULT_SETTINGS),
    jailbreakPresets: clone(data.jailbreakPresets || []),
    characterCards: clone(data.characterCards || []),
    worldBooks: clone(data.worldBooks || []),
    characterBookDecisions: clone(data.characterBookDecisions || {}),
  };
}

function mergeSession(snapshot, session) {
  const next = clone(snapshot || {});
  next.sessions = Array.isArray(next.sessions) ? next.sessions : [];
  const index = next.sessions.findIndex((item) => item.id === session.id);
  if (index >= 0) next.sessions[index] = { ...next.sessions[index], ...session };
  else next.sessions.unshift(session);
  if (!next.activeSessionId) next.activeSessionId = session.id;
  return next;
}

function diffSettingOps(prev = {}, next = {}) {
  const prevFlat = flatSettingsFromAppState(prev);
  const nextFlat = flatSettingsFromAppState(next);
  const items = [];
  const deleteKeys = [];
  for (const key of new Set([...Object.keys(prevFlat), ...Object.keys(nextFlat)])) {
    if (!(key in nextFlat)) deleteKeys.push(key);
    else if (!deepEqual(prevFlat[key], nextFlat[key])) items.push({ key, value: nextFlat[key], valueType: inferValueType(nextFlat[key]) });
  }
  return (items.length || deleteKeys.length) ? [{ op: 'settings.batchSet', payload: { items, deleteKeys } }] : [];
}

function diffResourceOps(prev = {}, next = {}) {
  const prevResources = resourcesFromSnapshot(prev);
  const nextResources = resourcesFromSnapshot(next);
  const ops = [];
  for (const kind of RESOURCE_KINDS) {
    if (!deepEqual(prevResources[kind] || [], nextResources[kind] || [])) {
      ops.push({ op: 'resources.replaceKind', payload: { kind, resources: clone(nextResources[kind] || []) } });
    }
  }
  return ops;
}

function conversationMeta(session = {}, index = 0) {
  return {
    id: session.id,
    title: session.title || '新会话',
    pinned: Boolean(session.pinned),
    position: index,
    createdAt: session.createdAt || nowISO(),
    updatedAt: session.updatedAt || session.createdAt || nowISO(),
  };
}

function diffConversationOps(prev = {}, next = {}, loadedConversationIds = new Set()) {
  const ops = [];
  const prevSessions = new Map((prev.sessions || []).filter(Boolean).map((session) => [session.id, session]));
  const nextSessions = new Map((next.sessions || []).filter(Boolean).map((session) => [session.id, session]));

  for (const [id] of prevSessions) {
    if (!nextSessions.has(id)) ops.push({ op: 'conversation.delete', payload: { conversationId: id } });
  }

  (next.sessions || []).forEach((session, index) => {
    if (!session?.id) return;
    const previous = prevSessions.get(session.id);
    const settings = conversationSettingsFromSession(session);
    const messages = Array.isArray(session.messages) ? clone(session.messages) : [];
    if (!previous) {
      ops.push({
        op: 'conversation.create',
        payload: {
          conversation: {
            ...conversationMeta(session, index),
            settings,
            messages,
          },
        },
      });
      return;
    }

    const metaPatch = {};
    const nextMeta = conversationMeta(session, index);
    const prevMeta = conversationMeta(previous, index);
    for (const key of ['title', 'pinned', 'createdAt', 'updatedAt', 'position']) {
      if (!deepEqual(prevMeta[key], nextMeta[key])) metaPatch[key] = nextMeta[key];
    }
    if (Object.keys(metaPatch).length) ops.push({ op: 'conversation.update', payload: { conversationId: session.id, patch: metaPatch } });

    const prevSettings = conversationSettingsFromSession(previous);
    const items = [];
    const deleteKeys = [];
    for (const key of new Set([...Object.keys(prevSettings), ...Object.keys(settings)])) {
      if (!(key in settings)) deleteKeys.push(key);
      else if (!deepEqual(prevSettings[key], settings[key])) items.push({ key, value: settings[key], valueType: inferValueType(settings[key]) });
    }
    if (items.length || deleteKeys.length) {
      ops.push({ op: 'conversationSettings.batchSet', payload: { conversationId: session.id, items, deleteKeys } });
    }

    if (loadedConversationIds.has(session.id) && !deepEqual(previous.messages || [], messages)) {
      const appendOps = diffMessageAppendOps(session.id, previous.messages || [], messages);
      if (appendOps) ops.push(...appendOps);
      else ops.push({ op: 'messages.replaceForConversation', payload: { conversationId: session.id, messages } });
    }
  });
  return ops;
}


function diffMessageAppendOps(conversationId, previousMessages = [], nextMessages = []) {
  if (!Array.isArray(previousMessages) || !Array.isArray(nextMessages)) return null;
  if (nextMessages.length < previousMessages.length) return null;
  for (let index = 0; index < previousMessages.length; index += 1) {
    if (!deepEqual(previousMessages[index], nextMessages[index])) return null;
  }
  return nextMessages.slice(previousMessages.length).map((message) => ({
    op: 'message.append',
    payload: { conversationId, message: clone(message) },
  }));
}

function inferValueType(value) {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) return 'array';
  if (value && typeof value === 'object') return 'object';
  return 'null';
}

class DataClient {
  constructor() {
    this.ws = null;
    this.revision = null;
    this.bootstrap = null;
    this.lastSnapshot = null;
    this.loadedConversationIds = new Set();
    this.pending = new Map();
    this.queue = [];
    this.remoteHandlers = new Set();
    this.statusHandlers = new Set();
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    this.reconnectTimer = 0;
    this.reconnectDelay = 800;
    this.closedExplicitly = false;
    this.status = 'offline';
    this.statusMessage = 'SQLite 数据通道尚未连接';
  }

  async loadInitialState() {
    await this.ensureConnected();
    this.lastSnapshot = stateFromBootstrap(this.bootstrap || {});
    const activeId = this.lastSnapshot.activeSessionId;
    if (activeId) {
      try {
        await this.loadConversation(activeId);
      } catch (error) {
        console.warn('Failed to load active conversation', error);
      }
    }
    return clone(this.lastSnapshot);
  }

  async ensureConnected() {
    if (this.bootstrap && this.ws?.readyState === WebSocket.OPEN) return this.bootstrap;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });
    this.openSocket();
    return this.connectPromise;
  }

  openSocket() {
    clearTimeout(this.reconnectTimer);
    if (this.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;
    this.setStatus(this.bootstrap ? 'reconnecting' : 'connecting', this.bootstrap ? '正在重新连接 SQLite 数据通道…' : '正在连接 SQLite 数据通道…');
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.setStatus('connecting', 'WebSocket 已连接，正在获取启动数据…');
    });
    ws.addEventListener('message', (event) => this.handleMessage(event));
    ws.addEventListener('close', () => this.handleClose());
    ws.addEventListener('error', () => {
      this.setStatus('offline', 'WebSocket 连接失败，稍后自动重试。');
    });
  }

  handleMessage(event) {
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    if (message.type === 'bootstrap') {
      this.bootstrap = message;
      this.revision = Number.isFinite(message.revision) ? message.revision : this.revision;
      this.reconnectDelay = 800;
      this.setStatus('connected', `SQLite 已连接 · 修订 ${this.revision ?? 0}`);
      if (this.connectResolve) this.connectResolve(message);
      this.connectPromise = null;
      this.connectResolve = null;
      this.connectReject = null;
      if (!this.lastSnapshot) this.lastSnapshot = stateFromBootstrap(message);
      this.flushQueue();
      return;
    }
    if (message.type === 'ack') {
      if (Number.isFinite(message.revision)) this.revision = message.revision;
      const pending = this.pending.get(message.requestId);
      if (pending) {
        this.pending.delete(message.requestId);
        pending.resolve(message);
      }
      this.setStatus('connected', `SQLite 已保存 · 修订 ${this.revision ?? 0}`);
      return;
    }
    if (message.type === 'conversation.snapshot') {
      if (Number.isFinite(message.revision)) this.revision = message.revision;
      const session = sessionFromConversation(message.conversation || {});
      this.loadedConversationIds.add(session.id);
      this.lastSnapshot = mergeSession(this.lastSnapshot || stateFromBootstrap(this.bootstrap || {}), session);
      const pending = this.pending.get(message.requestId);
      if (pending) {
        this.pending.delete(message.requestId);
        pending.resolve({ ...message, session });
      }
      return;
    }
    if (message.type === 'event') {
      if (Number.isFinite(message.revision)) this.revision = message.revision;
      this.applyEvent(message.op, message.payload || {});
      this.setStatus('connected', `收到其它页面更新 · 修订 ${this.revision ?? 0}`);
      for (const handler of this.remoteHandlers) handler(clone(this.lastSnapshot), message);
      return;
    }
    if (message.type === 'error') {
      const pending = this.pending.get(message.requestId);
      const error = new Error(message.error || 'WebSocket operation failed');
      error.reload = Boolean(message.reload);
      if (pending) {
        this.pending.delete(message.requestId);
        pending.reject(error);
      } else {
        console.warn('WebSocket error', message.error);
      }
    }
  }

  handleClose() {
    for (const item of Array.from(this.pending.values()).reverse()) this.queue.unshift(item);
    this.pending.clear();
    this.ws = null;
    this.bootstrap = null;
    if (this.connectReject) this.connectReject(new Error('WebSocket closed before bootstrap'));
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    if (this.closedExplicitly) return;
    this.setStatus('offline', 'SQLite 数据通道已断开，将自动重连。');
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.8, 15_000);
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }

  setStatus(status, message) {
    this.status = status;
    this.statusMessage = message;
    for (const handler of this.statusHandlers) handler({ status, message, revision: this.revision });
  }

  isReady() {
    return this.ws?.readyState === WebSocket.OPEN && this.bootstrap;
  }

  flushQueue() {
    if (!this.isReady()) return;
    while (this.queue.length) this.sendQueuedItem(this.queue.shift());
  }

  sendQueuedItem(item) {
    if (!this.isReady()) {
      this.queue.unshift(item);
      this.openSocket();
      return;
    }
    this.pending.set(item.envelope.requestId, item);
    try {
      this.ws.send(JSON.stringify(item.envelope));
    } catch (error) {
      this.pending.delete(item.envelope.requestId);
      this.queue.unshift(item);
      this.handleClose();
    }
  }

  request(message) {
    return new Promise((resolve, reject) => {
      const envelope = { requestId: uid('req'), ...message };
      const item = { envelope, resolve, reject };
      if (this.isReady()) this.sendQueuedItem(item);
      else {
        this.queue.push(item);
        this.ensureConnected().catch(() => {});
      }
    });
  }

  async sendOperation(op, payload = {}) {
    const response = await this.request({ type: 'op', baseRevision: this.revision, op, payload });
    if (Number.isFinite(response.revision)) this.revision = response.revision;
    return response;
  }

  async sendOperations(ops = []) {
    for (const item of ops) await this.sendOperation(item.op, item.payload || {});
  }

  async loadConversation(conversationId) {
    if (!conversationId) throw new Error('Conversation id is required');
    await this.ensureConnected();
    const response = await this.request({ type: 'conversation.load', conversationId });
    return clone(response.session);
  }

  async saveSnapshot(snapshot, { force = false } = {}) {
    await this.ensureConnected();
    const current = clone(snapshot || {});
    if (force) {
      await this.sendOperation('backup.replaceAll', { state: current });
      this.lastSnapshot = clone(current);
      this.loadedConversationIds = new Set((current.sessions || []).map((session) => session.id).filter(Boolean));
      return;
    }
    const previous = this.lastSnapshot || { sessions: [] };
    const ops = [
      ...diffSettingOps(previous, current),
      ...diffResourceOps(previous, current),
      ...diffConversationOps(previous, current, this.loadedConversationIds),
    ];
    if (!ops.length) return;
    await this.sendOperations(ops);
    this.lastSnapshot = clone(current);
    for (const session of current.sessions || []) {
      if (!this.loadedConversationIds.has(session.id) && !previous.sessions?.some((item) => item.id === session.id)) {
        this.loadedConversationIds.add(session.id);
      }
    }
  }

  replaceAll(snapshot) {
    return this.saveSnapshot(snapshot, { force: true });
  }

  onRemoteSnapshot(handler) {
    this.remoteHandlers.add(handler);
    return () => this.remoteHandlers.delete(handler);
  }

  onStatus(handler) {
    this.statusHandlers.add(handler);
    handler({ status: this.status, message: this.statusMessage, revision: this.revision });
    return () => this.statusHandlers.delete(handler);
  }

  applyEvent(op, payload = {}) {
    let snapshot = this.lastSnapshot || stateFromBootstrap(this.bootstrap || {});
    if (op === 'backup.replaceAll') {
      this.lastSnapshot = stateFromLegacySnapshot(payload.state || payload.data || payload);
      this.loadedConversationIds = new Set((this.lastSnapshot.sessions || []).map((session) => session.id).filter(Boolean));
      return;
    }
    snapshot = clone(snapshot);

    if (op === 'setting.set') applyFlatSetting(snapshot, payload.key, payload.value);
    else if (op === 'setting.delete') applyFlatSettingDelete(snapshot, payload.key);
    else if (op === 'settings.batchSet') {
      for (const item of payload.items || []) applyFlatSetting(snapshot, item.key, item.value);
      for (const key of payload.deleteKeys || payload.deletes || []) applyFlatSettingDelete(snapshot, key);
    }
    else if (op === 'conversation.create') {
      const conversation = payload.conversation || payload;
      const session = sessionFromConversation(conversation);
      snapshot = mergeSession(snapshot, session);
      if (Array.isArray(conversation.messages)) this.loadedConversationIds.add(session.id);
    }
    else if (op === 'conversation.update') {
      const session = findSession(snapshot, payload.conversationId || payload.id);
      if (session) Object.assign(session, normalizeConversationPatch(payload.patch || payload));
    }
    else if (op === 'conversation.delete') {
      const id = payload.conversationId || payload.id;
      snapshot.sessions = (snapshot.sessions || []).filter((session) => session.id !== id);
      this.loadedConversationIds.delete(id);
      if (snapshot.activeSessionId === id) snapshot.activeSessionId = snapshot.sessions[0]?.id || null;
    }
    else if (op === 'conversationSetting.set') {
      const session = findSession(snapshot, payload.conversationId);
      if (session) applySessionSetting(session, payload.key, payload.value);
    }
    else if (op === 'conversationSetting.delete') {
      const session = findSession(snapshot, payload.conversationId);
      if (session) deleteSessionSetting(session, payload.key);
    }
    else if (op === 'conversationSettings.batchSet') {
      const session = findSession(snapshot, payload.conversationId);
      if (session) {
        for (const item of payload.items || []) applySessionSetting(session, item.key, item.value);
        for (const key of payload.deleteKeys || payload.deletes || []) deleteSessionSetting(session, key);
      }
    }
    else if (op === 'messages.replaceForConversation') {
      const session = findSession(snapshot, payload.conversationId);
      if (session && this.loadedConversationIds.has(session.id)) session.messages = clone(payload.messages || []);
      if (session) session.messageCount = Array.isArray(payload.messages) ? payload.messages.length : session.messageCount;
    }
    else if (op === 'messages.clearForConversation') {
      const session = findSession(snapshot, payload.conversationId);
      if (session && this.loadedConversationIds.has(session.id)) session.messages = [];
      if (session) session.messageCount = 0;
    }
    else if (op === 'message.append') {
      const session = findSession(snapshot, payload.conversationId);
      if (session && this.loadedConversationIds.has(session.id)) session.messages.push(clone(payload.message));
      if (session) session.messageCount = (session.messageCount || session.messages?.length || 0) + 1;
    }
    else if (op === 'message.update') {
      const session = findSession(snapshot, payload.conversationId);
      const message = session?.messages?.find((item) => item.id === payload.messageId || item.id === payload.id);
      if (message) Object.assign(message, clone(payload.patch || {}), clone(payload.patch?.payload || {}));
    }
    else if (op === 'message.delete') {
      const session = findSession(snapshot, payload.conversationId);
      if (session && this.loadedConversationIds.has(session.id)) session.messages = session.messages.filter((item) => item.id !== (payload.messageId || payload.id));
      if (session) session.messageCount = Math.max(0, (session.messageCount || session.messages?.length || 1) - 1);
    }
    else if (op === 'resource.upsert') applyResourceUpsert(snapshot, payload);
    else if (op === 'resource.delete') applyResourceDelete(snapshot, payload.kind, payload.id);
    else if (op === 'resources.replaceKind') setResourceKind(snapshot, payload.kind, payload.resources || []);

    this.lastSnapshot = snapshot;
  }
}

function applyFlatSetting(snapshot, key, value) {
  if (!key) return;
  if (key === 'activeSessionId') {
    snapshot.activeSessionId = value || snapshot.activeSessionId;
    return;
  }
  if (key === 'characterBookDecisions') {
    snapshot.characterBookDecisions = clone(value || {});
    return;
  }
  const path = GLOBAL_SETTING_PATHS[key];
  if (path) setPath(snapshot.settings ||= {}, path, clone(value));
}

function applyFlatSettingDelete(snapshot, key) {
  if (key === 'activeSessionId') return;
  if (key === 'characterBookDecisions') {
    snapshot.characterBookDecisions = {};
    return;
  }
  const path = GLOBAL_SETTING_PATHS[key];
  if (path) deletePath(snapshot.settings ||= {}, path);
}

function applySessionSetting(session, key, value) {
  const path = SESSION_SETTING_PATHS[key];
  if (path) setPath(session, path, clone(value));
}

function deleteSessionSetting(session, key) {
  const path = SESSION_SETTING_PATHS[key];
  if (path) deletePath(session, path);
}

function findSession(snapshot, id) {
  return (snapshot.sessions || []).find((session) => session.id === id);
}

function normalizeConversationPatch(patch = {}) {
  const result = {};
  if ('title' in patch) result.title = patch.title;
  if ('pinned' in patch) result.pinned = Boolean(patch.pinned);
  if ('createdAt' in patch) result.createdAt = patch.createdAt;
  if ('updatedAt' in patch) result.updatedAt = patch.updatedAt;
  return result;
}

function setResourceKind(snapshot, kind, resources) {
  const path = RESOURCE_TO_STATE[kind];
  if (!path) return;
  setPath(snapshot, path, clone(resources || []));
}

function applyResourceUpsert(snapshot, payload = {}) {
  const kind = payload.kind;
  const resource = clone(payload.payload || payload);
  resource.id ||= payload.id;
  resource.name ||= payload.name || '';
  const path = RESOURCE_TO_STATE[kind];
  if (!path || !resource.id) return;
  const list = getPath(snapshot, path, []);
  const next = Array.isArray(list) ? clone(list) : [];
  const index = next.findIndex((item) => item.id === resource.id);
  if (index >= 0) next[index] = resource;
  else next.push(resource);
  setPath(snapshot, path, next);
}

function applyResourceDelete(snapshot, kind, id) {
  const path = RESOURCE_TO_STATE[kind];
  if (!path) return;
  const list = getPath(snapshot, path, []);
  setPath(snapshot, path, (Array.isArray(list) ? list : []).filter((item) => item.id !== id));
}

export const dataClient = new DataClient();

export async function loadInitialPersistedState() {
  return dataClient.loadInitialState();
}

export async function saveSnapshotToServer(snapshot, options = {}) {
  return dataClient.saveSnapshot(snapshot, options);
}

export async function replaceAllServerState(snapshot) {
  return dataClient.replaceAll(snapshot);
}

export async function loadConversationFromServer(conversationId) {
  return dataClient.loadConversation(conversationId);
}

export function getServerRevision() {
  return dataClient.revision;
}

export function onRemoteSnapshot(handler) {
  return dataClient.onRemoteSnapshot(handler);
}

export function onConnectionStatus(handler) {
  return dataClient.onStatus(handler);
}
