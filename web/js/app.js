import {
  STORAGE_KEY,
  SAVE_DELAY,
  STREAM_RENDER_INTERVAL,
  CONTEXT_LIMIT,
  MAX_TOOL_LOOPS,
  DEFAULT_SYSTEM_PROMPT,
  PROMPT_TEMPLATES,
  DEFAULT_SETTINGS,
  MODEL_NOTES,
} from './config.js';
import {
  nowISO,
  uid,
  clamp,
  escapeHtml,
  estimateTokens,
  structuredCloneSafe,
  tryParseJson,
  formatMaybeJson,
  formatTime,
  safeFileName,
  dateSlug,
} from './utils.js';
import {
  normalizeAssistantView,
  foldVisibleThinkingIntoAssistant,
  foldSuggestionsIntoAssistant,
  ensureAssistantExtra,
  syncAssistantExtraAliases,
} from './message-parsers.js';
import {
  parseCharacterCardFile,
  normalizeCharacterCard,
  characterCardToPrompt,
  getCharacterGreeting,
  getCharacterGreetings,
  applyCharacterFieldEdit,
  resolveCharacterPlaceholders,
} from './character-card.js';
import {
  extractSystemPromptFromJson,
  normalizePromptLibraryImport,
  parseExternalPresetText,
  isSillyTavernDynamicMarker,
  resolveSillyTavernRuntimeMacros,
} from './prompt-import.js';
import {
  fetchDeepSeekRequest,
  streamChatResponse,
} from './deepseek-api.js';
import {
  executeTool,
  parseToolArguments,
  validateToolDefinition,
  validateStrictSchema,
} from './tool-runtime.js';
import {
  loadPersistedState,
  savePersistedState,
  replaceAllPersistedState,
  loadConversationPersistedState,
  onRemoteStateChange,
  onDataConnectionStatusChange,
  getLastServerRevision,
} from './storage.js';
import {
  normalizeWorldBook,
  getTriggeredWorldBookEntries,
  worldBookEntriesToPrompt,
  summarizeWorldBook,
} from './world-book.js';
import {
  REGEX_PLACEMENTS,
  normalizeFormattingSettings,
  normalizeRegexScript,
  normalizeReasoningTemplate,
  formatMessageForDisplay,
  formatMessageForPrompt,
  applyPersistentRegexScripts,
  renderMarkdownToHtml,
  sanitizeFormattedHtml,
  highlightDialogueQuotesInElement,
  applyRegexScripts,
  replaceMacros,
} from './message-formatting.js';

  const state = {
    sessions: [],
    activeSessionId: null,
    settings: { ...DEFAULT_SETTINGS },
    promptLibrary: [],
    jailbreakPresets: [],
    characterCards: [],
    worldBooks: [],
    characterBookDecisions: {},
    ui: {
      sidebarCollapsed: false,
      settingsOpen: false,
      batchMode: false,
      selectedSessions: new Set(),
      stickyScroll: true,
      search: '',
      userProfileOpen: false,
      userProfileDirty: false,
      characterManagerOpen: false,
      characterManagerSearch: '',
      characterManagerSort: 'updated_desc',
      characterManagerVisibleCount: 48,
      editingCharacterCardId: '',
      characterPanelOpen: false,
      settingsPage: 'model',
      openSessionMenuId: null,
      selectedReasoningTemplateId: '',
      selectedRegexScriptId: '',
    },
  };

  const els = {};
  let saveTimer = 0;
  let renderTimer = 0;
  let abortController = null;
  let generating = false;
  let activeStreamingMessageId = null;
  let userScrolledAway = false;
  let storageBackend = 'memory';
  let hasUnsavedChanges = false;
  let lastPersistedSnapshot = null;
  let saveInFlight = false;
  let stateChangeSeq = 0;
  let serverApiKeyConfigured = false;

  const $ = (id) => document.getElementById(id);

  document.addEventListener('DOMContentLoaded', () => {
    init().catch((error) => {
      console.error('Failed to initialize app', error);
      toast('应用初始化失败，请刷新页面重试。', 'error');
    });
  });

  async function init() {
    bindElements();
    configureLibraries();
    onDataConnectionStatusChange(({ status, message, revision }) => {
      updateSharedSyncStatus(status === 'connected' ? 'ok' : status, message || 'SQLite 数据通道状态未知', revision);
    });
    onRemoteStateChange((nextState) => {
      if (generating) {
        toast('收到其它页面更新，将在当前生成结束后继续使用最新数据。');
        return;
      }
      applyPersistedState(nextState, { preserveActiveSession: true });
      ensureSession();
      syncSettingsToInputs();
      renderAll();
    });
    await loadServerRuntimeConfig();
    await loadState();
    state.settings = normalizeAppSettings(state.settings);
    applyServerApiKeyMode();
    ensureSession();
    lastPersistedSnapshot = buildPersistedStateSnapshot();
    if (hasUnsavedChanges) persistSoon();
    applyResponsiveUiDefaults();
    applyTheme();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
      if (state.settings.theme === 'system') {
        applyTheme();
        renderMessages();
      }
    });
    bindEvents();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') persistNow();
    });
    window.addEventListener('resize', applyResponsiveUiDefaults);
    window.addEventListener('online', () => updateSharedSyncStatus('pending', '网络已恢复，正在重连 SQLite 数据通道…'));
    window.addEventListener('offline', () => updateSharedSyncStatus('offline', '网络已断开，已加载的数据会保留。'));
    window.addEventListener('beforeunload', () => {
      persistNow();
    });
    syncSettingsToInputs();
    renderAll();
    autoResizeInput();
  }

  function bindElements() {
    for (const id of [
      'app', 'sidebar', 'collapseSidebarBtn', 'openSidebarBtn', 'newSessionBtn', 'sessionSearch', 'batchModeBtn', 'selectAllBtn', 'deleteSelectedBtn',
      'sessionList', 'exportAllBtn', 'importAllInput', 'chatMain', 'activeTitle', 'sessionStats', 'modelSelect', 'thinkingQuickBtn', 'jsonQuickBtn',
      'userProfileBtn', 'characterManagerBtn', 'themeToggleBtn', 'settingsBtn', 'messages', 'emptyState', 'starterGrid', 'backLatestBtn', 'composer', 'messageInput', 'sendBtn', 'charCounter',
      'hintText', 'prefixBox', 'assistantPrefix', 'openFimBtn', 'promptLibraryBtn', 'settingsDrawer', 'settingsPagesNav', 'settingsPageHint', 'closeSettingsBtn', 'apiKeyInput', 'baseUrlInput',
      'betaBaseUrlInput', 'useProxyInput', 'modelSettingSelect', 'modelNote', 'temperatureInput', 'temperatureValue', 'topPInput', 'topPValue',
      'maxTokensInput', 'responseLengthInput', 'customLengthInput', 'customLengthLabel', 'presencePenaltyInput', 'frequencyPenaltyInput', 'stopInput', 'thinkingInput', 'reasoningEffortInput', 'jsonModeInput',
      'prefixEnabledInput', 'fimEnabledInput', 'chatDisplayModeInput', 'showTagsInput', 'autoFixMarkdownInput', 'showReasoningBlocksInput', 'allowScopedRegexInput',
      'reasoningTemplateSelect', 'reasoningTemplateEnabledInput', 'reasoningTemplateNameInput', 'reasoningTemplateOpenInput', 'reasoningTemplateCloseInput', 'newReasoningTemplateBtn', 'saveReasoningTemplateBtn', 'deleteReasoningTemplateBtn',
      'regexScriptSelect', 'regexScriptNameInput', 'regexFindInput', 'regexReplaceInput', 'regexTrimInput', 'regexPlacementUserInput', 'regexPlacementAiInput', 'regexPlacementWorldInput', 'regexPlacementReasoningInput', 'regexMarkdownOnlyInput', 'regexPromptOnlyInput', 'regexDisabledInput', 'regexRunOnEditInput', 'regexSubstituteInput', 'regexMinDepthInput', 'regexMaxDepthInput', 'newRegexScriptBtn', 'copyRegexScriptBtn', 'saveRegexScriptBtn', 'deleteRegexScriptBtn', 'moveRegexUpBtn', 'moveRegexDownBtn', 'exportRegexScriptsBtn', 'importRegexScriptsInput', 'regexTestPlacementInput', 'regexTestModeInput', 'regexTestInput', 'regexTestResult',
      'systemPromptInput', 'promptTemplates', 'savePromptBtn', 'exportPromptBtn', 'importPromptInput',
      'promptLibrary', 'jailbreakLibrarySearch', 'jailbreakLibrarySelect', 'jailbreakPresetNameInput', 'jailbreakPresetDescriptionInput', 'jailbreakPresetTagsInput', 'jailbreakPostHistoryInput', 'applyJailbreakPresetBtn', 'saveJailbreakPresetBtn', 'newJailbreakPresetBtn', 'copyJailbreakPresetBtn', 'setDefaultJailbreakBtn', 'deleteJailbreakPresetBtn', 'exportJailbreakPresetBtn', 'jailbreakLibraryImportInput',
      'jailbreakEnabledInput', 'jailbreakImportInput', 'clearJailbreakBtn', 'jailbreakSummary', 'jailbreakPromptInput',
      'characterLibrarySearch', 'characterLibrarySelect', 'applyCharacterCardBtn', 'saveCharacterCardBtn', 'syncCharacterCardBtn', 'deleteCharacterCardBtn', 'exportCharacterCardBtn', 'userNameInput', 'userPersonaInput', 'rpModeInput', 'rpPerspectiveInput', 'rpSuggestionsInput', 'rpMemoryInput', 'backgroundEnabledInput', 'backgroundInput', 'characterEnabledInput', 'characterCardInput', 'startCharacterChatBtn', 'insertGreetingBtn', 'clearCharacterBtn',
      'userProfileBackdrop', 'userProfileDrawer', 'userProfileHint', 'closeUserProfileBtn', 'userProfileNameInput', 'userProfilePronounsInput', 'userProfileAgeInput', 'userProfileOccupationInput', 'userProfilePersonaInput', 'userProfileBackgroundInput', 'userProfileGoalsInput', 'userProfileLanguageInput', 'userProfileToneInput', 'userProfileBoundariesInput', 'userProfileCustomFieldsInput', 'userProfileSaveState', 'resetUserProfileBtn', 'saveUserProfileBtn',
      'characterManagerBackdrop', 'characterManagerDrawer', 'characterManagerHint', 'closeCharacterManagerBtn', 'characterManagerSearch', 'characterManagerSort', 'characterManagerImportInput', 'exportCharacterLibraryBtn', 'newCharacterCardBtn', 'characterManagerEditor', 'characterManagerEditorTitle', 'characterManagerNameInput', 'characterManagerTagsInput', 'characterManagerCreatorInput', 'characterManagerDescriptionInput', 'characterManagerPersonalityInput', 'characterManagerScenarioInput', 'characterManagerFirstMesInput', 'saveCharacterManagerEditorBtn', 'cancelCharacterManagerEditorBtn', 'characterManagerList',
      'characterCardSummary', 'characterGreetingSelect', 'characterNameInput', 'characterDescriptionInput', 'characterPersonalityInput', 'characterScenarioInput', 'characterFirstMesInput', 'characterMesExampleInput', 'characterSystemPromptInput', 'characterPostHistoryInput', 'characterCreatorNotesInput', 'characterCardPreview', 'characterBackgroundDetails', 'toolsEnabledInput', 'toolsJsonInput', 'formatToolsBtn', 'themeInput', 'fontScaleInput', 'fontScaleValue', 'timestampsInput',
      'worldBookLibrarySearch', 'worldBookLibrarySelect', 'activeWorldBookSelect', 'applyWorldBookFromLibraryBtn', 'saveWorldBookBtn', 'newWorldBookBtn', 'deleteWorldBookBtn', 'exportWorldBookBtn', 'worldBookEnabledInput', 'worldBookImportInput', 'clearWorldBookBtn', 'worldBookScanDepthInput', 'worldBookMaxEntriesInput', 'worldBookTokenBudgetInput', 'worldBookRecursiveInput', 'worldBookSummary', 'worldBookEditor', 'applyWorldBookEditBtn', 'worldBookActivePreview', 'worldBookTestInput', 'worldBookTestResult',
      'lineNumbersInput', 'tokenPanel', 'syncStatus', 'clearHistoryBtn', 'truncateHistoryBtn', 'exportJsonBtn', 'exportMarkdownBtn', 'exportTxtBtn', 'fimPanel',
      'closeFimBtn', 'fimPrefix', 'fimResult', 'fimSuffix', 'runFimBtn', 'copyFimBtn', 'shortcutDialog', 'toastStack',
    ]) {
      els[id] = $(id);
    }
  }

  function configureLibraries() {
    if (window.marked) {
      window.marked.setOptions({
        gfm: true,
        breaks: true,
        mangle: false,
        headerIds: false,
      });
    }
    if (window.mermaid) {
      try {
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: getEffectiveTheme() === 'dark' ? 'dark' : 'neutral',
        });
      } catch (_) {
        // Mermaid is optional; rendering gracefully degrades.
      }
    }
  }

  async function loadState() {
    try {
      const loaded = await loadPersistedState(STORAGE_KEY);
      const { data: parsed, backend } = loaded;
      storageBackend = backend || 'sqlite-websocket';
      if (!parsed) return;
      applyPersistedState(parsed);
      lastPersistedSnapshot = buildPersistedStateSnapshot();
      updateSharedSyncStatus('ok', `SQLite 已加载${Number.isFinite(loaded?.revision) ? ` · 修订 ${loaded.revision}` : ''}`);
    } catch (error) {
      console.warn('Failed to load state', error);
      updateSharedSyncStatus('error', `SQLite 数据读取失败：${error.message}`);
      toast('服务端 SQLite 数据读取失败，已使用空白状态。', 'error');
    }
  }

  async function loadServerRuntimeConfig() {
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      if (!response.ok) return;
      const config = await response.json();
      serverApiKeyConfigured = Boolean(config?.serverApiKeyConfigured);
    } catch (_) {
      serverApiKeyConfigured = false;
    }
  }

  function applyServerApiKeyMode() {
    if (!serverApiKeyConfigured) return false;
    const changed = Boolean(state.settings.apiKey) || state.settings.useProxy !== true;
    state.settings.apiKey = '';
    state.settings.useProxy = true;
    if (changed) hasUnsavedChanges = true;
    return changed;
  }

  function hasUsableApiKey() {
    if (serverApiKeyConfigured && state.settings.useProxy) return true;
    return Boolean(String(state.settings.apiKey || '').trim());
  }

  function applyPersistedState(parsed, { preserveActiveSession = false } = {}) {
    const previousActiveSessionId = state.activeSessionId;
    state.sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    state.activeSessionId = parsed.activeSessionId || null;
    state.settings = normalizeAppSettings(parsed.settings || {});
    state.promptLibrary = Array.isArray(parsed.promptLibrary) ? parsed.promptLibrary : [];
    state.jailbreakPresets = Array.isArray(parsed.jailbreakPresets) ? parsed.jailbreakPresets.map(migrateJailbreakPreset) : [];
    state.characterCards = Array.isArray(parsed.characterCards) ? parsed.characterCards.map(migrateLibraryCharacterCard) : [];
    state.worldBooks = Array.isArray(parsed.worldBooks) ? parsed.worldBooks.map((book) => prepareWorldBookForLibrary(book, { source: book.source || 'imported', boundCharacterId: book.bound_character_id || '' })) : [];
    state.characterBookDecisions = parsed.characterBookDecisions && typeof parsed.characterBookDecisions === 'object' ? parsed.characterBookDecisions : {};
    applyServerApiKeyMode();
    for (const session of state.sessions) migrateSession(session);
    bootstrapLibrariesFromSessions();
    if (preserveActiveSession && state.sessions.some((session) => session.id === previousActiveSessionId)) {
      state.activeSessionId = previousActiveSessionId;
    }
  }

  function normalizeAppSettings(settings = {}) {
    return {
      ...DEFAULT_SETTINGS,
      ...(settings || {}),
      formatting: normalizeFormattingSettings({
        ...(DEFAULT_SETTINGS.formatting || {}),
        ...((settings || {}).formatting || {}),
      }),
    };
  }

  function migrateJailbreakPreset(preset = {}) {
    const now = nowISO();
    preset.id ||= uid('jb');
    preset.name ||= preset.title || preset.source || '未命名破限';
    preset.description ||= '';
    preset.system_prompt ??= preset.prompt ?? preset.jailbreakPrompt ?? '';
    preset.post_history_instructions ??= '';
    preset.tags = Array.isArray(preset.tags) ? preset.tags : [];
    preset.created_at ||= preset.createdAt || now;
    preset.updated_at ||= preset.updatedAt || preset.created_at;
    preset.is_default = Boolean(preset.is_default);
    preset.layout = Array.isArray(preset.layout) ? preset.layout : [];
    preset.messages = Array.isArray(preset.messages) ? preset.messages : [];
    preset.settings ||= {};
    preset.import_meta ??= preset.importMeta || null;
    preset.import_kind ||= preset.importKind || '';
    return preset;
  }

  function migrateLibraryCharacterCard(card = {}) {
    const now = nowISO();
    card.id ||= uid('char');
    card.name ||= '未命名角色';
    card.spec_version ||= card.specVersion || 'v1';
    card.source_format ||= inferCharacterSourceFormat(card.source || '');
    card.created_at ||= card.createdAt || now;
    card.updated_at ||= card.updatedAt || card.created_at;
    card.tags = Array.isArray(card.tags) ? card.tags : [];
    card.alternate_greetings = Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [];
    card.conversation_count = countCharacterConversations(card.id);
    card.raw_json ||= card.rawPayload || (card.raw ? JSON.stringify(card.raw, null, 2) : '');
    return card;
  }

  function bootstrapLibrariesFromSessions() {
    let changed = false;
    for (const session of state.sessions) {
      if (session.characterCard) {
        const id = session.characterCardId || session.characterCard.library_id || session.characterCard.id;
        if (!state.characterCards.some((card) => card.id === id)) {
          const card = prepareCharacterForLibrary({ ...session.characterCard, id: id || uid('char') });
          state.characterCards.push(card);
          session.characterCardId = card.id;
          session.characterCard.library_id = card.id;
          changed = true;
        }
      }
      if (session.worldBook?.entries?.length) {
        const id = session.worldBook.id;
        if (!state.worldBooks.some((book) => book.id === id)) {
          const book = prepareWorldBookForLibrary({ ...session.worldBook, id: id || uid('wb') }, { source: session.worldBook.source || 'imported' });
          state.worldBooks.push(book);
          session.worldBook = structuredCloneSafe(book);
          session.activeWorldBookIds = [...new Set([...(session.activeWorldBookIds || []), book.id])];
          changed = true;
        }
      }
      if (String(session.jailbreakPrompt || '').trim()) {
        let existing = session.jailbreakPresetId ? state.jailbreakPresets.find((preset) => preset.id === session.jailbreakPresetId) : null;
        existing ||= state.jailbreakPresets.find((preset) => preset.system_prompt === session.jailbreakPrompt && preset.name === (session.jailbreakSource || '会话破限'));
        if (existing) {
          session.jailbreakPresetId = existing.id;
        } else {
          const preset = migrateJailbreakPreset({
            id: session.jailbreakPresetId || uid('jb'),
          name: session.jailbreakSource || '会话破限',
          system_prompt: session.jailbreakPrompt,
          post_history_instructions: session.jailbreakPostHistoryInstructions || '',
          layout: session.jailbreakLayout || [],
          messages: session.jailbreakMessages || [],
          settings: session.jailbreakSettings || {},
          created_at: session.createdAt || nowISO(),
          updated_at: session.updatedAt || nowISO(),
          });
          state.jailbreakPresets.push(preset);
          session.jailbreakPresetId = preset.id;
          changed = true;
        }
      }
    }
    if (changed) hasUnsavedChanges = true;
  }

  function migrateSession(session) {
    session.id ||= uid('session');
    session.title ||= '新会话';
    session.createdAt ||= nowISO();
    session.updatedAt ||= session.createdAt;
    session.systemPrompt ??= DEFAULT_SYSTEM_PROMPT;
    session.jailbreakEnabled = Boolean(session.jailbreakEnabled);
    session.jailbreakPrompt ??= '';
    session.jailbreakSource ??= '';
    session.jailbreakImportMeta ??= null;
    session.jailbreakImportKind ??= '';
    session.jailbreakParsed = Boolean(session.jailbreakParsed);
    session.jailbreakMessages = Array.isArray(session.jailbreakMessages) ? session.jailbreakMessages : [];
    session.jailbreakLayout = Array.isArray(session.jailbreakLayout) ? session.jailbreakLayout : [];
    session.jailbreakSettings = session.jailbreakSettings && typeof session.jailbreakSettings === 'object' ? session.jailbreakSettings : {};
    session.jailbreakPresetId ||= '';
    session.jailbreakPostHistoryInstructions ??= '';
    migrateRawJailbreakPreset(session);
    session.userName ??= '';
    session.userPersona ??= '';
    ensureUserProfile(session);
    session.rpMode = Boolean(session.rpMode);
    session.rpPerspective ||= 'second';
    session.rpSuggestions = session.rpSuggestions !== false;
    session.rpMemory ??= '';
    session.background ??= '';
    session.backgroundEnabled = session.backgroundEnabled !== false;
    session.characterCardEnabled = session.characterCardEnabled !== false;
    session.characterCard ||= null;
    if (session.characterCard && !session.characterCard.rawPayload) {
      session.characterCard.rawPayload = JSON.stringify(session.characterCard.raw || session.characterCard, null, 2);
    }
    if (session.characterCard) {
      session.characterCard.alternate_greetings = Array.isArray(session.characterCard.alternate_greetings) ? session.characterCard.alternate_greetings : [];
      session.characterCard.fields = Array.isArray(session.characterCard.fields) ? session.characterCard.fields : [];
    }
    session.greetingIndex = Number.isInteger(session.greetingIndex) ? session.greetingIndex : 0;
    session.characterBookHandling ||= null;
    session.characterCardId ||= session.characterCard?.library_id || session.characterCard?.id || '';
    session.worldBookEnabled = Boolean(session.worldBookEnabled);
    session.worldBook ||= null;
    session.worldBookScanDepth = clamp(Number.parseInt(session.worldBookScanDepth || session.worldBook?.scan_depth || 4, 10), 1, 40);
    session.worldBookMaxEntries = clamp(Number.parseInt(session.worldBookMaxEntries || 12, 10), 1, 50);
    session.worldBookTokenBudget = clamp(Number.parseInt(session.worldBookTokenBudget || session.worldBook?.token_budget || 1200, 10), 64, 100000);
    session.worldBookRecursive = Boolean(session.worldBookRecursive ?? session.worldBook?.recursive_scanning);
    session.activeWorldBookIds = Array.isArray(session.activeWorldBookIds) ? session.activeWorldBookIds : [];
    session.pinned = Boolean(session.pinned);
    session.messages = Array.isArray(session.messages) ? session.messages : [];
    session.stats ||= {};
    session.messages = session.messages
      .map((message) => {
        migrateMessage(message);
        return compactMessageForRuntime(message);
      })
      .filter(Boolean);
  }

  function migrateRawJailbreakPreset(session) {
    const raw = String(session.jailbreakPrompt || '').trim();
    if (!raw || session.jailbreakParsed) return;
    if (!/^[\[{]/.test(raw)) return;
    try {
      const imported = parseExternalPresetText(raw, { sourceName: session.jailbreakSource || '外部预设' });
      if (!imported.parsed || !imported.prompt.trim()) return;
      session.jailbreakPrompt = imported.prompt;
      session.jailbreakImportMeta = imported.meta || null;
      session.jailbreakImportKind = imported.kind || '';
      session.jailbreakParsed = true;
      session.jailbreakMessages = Array.isArray(imported.messages) ? imported.messages : [];
      session.jailbreakLayout = Array.isArray(imported.layout) ? imported.layout : [];
      session.jailbreakSettings = imported.settings || {};
      hasUnsavedChanges = true;
    } catch (error) {
      console.warn('Failed to migrate raw jailbreak preset', error);
    }
  }

  function migrateMessage(message) {
    message.id ||= uid('msg');
    message.role ||= 'user';
    message.content ??= '';
    if (message.role === 'assistant') {
      if (!message.extra || typeof message.extra !== 'object') message.extra = {};
    }
    message.createdAt ||= nowISO();
    if (message.reasoningContent && !message.reasoning_content) message.reasoning_content = message.reasoningContent;
    message.reasoning_content ??= '';
    message.toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    message.versions = Array.isArray(message.versions) ? message.versions : [];
    message.activeVersion = Number.isInteger(message.activeVersion) ? message.activeVersion : Math.max(0, message.versions.length - 1);
    if (message.role === 'assistant') {
      message.suggestions = Array.isArray(message.suggestions) ? message.suggestions : [];
      delete message.card_state;
      if (message.extra && typeof message.extra === 'object') delete message.extra.role_state;
      ensureAssistantExtra(message);
      for (const version of message.versions) {
        version.role = 'assistant';
        delete version.card_state;
        if (version.extra && typeof version.extra === 'object') delete version.extra.role_state;
        ensureAssistantExtra(version);
        delete version.role;
      }
    }
  }

  function compactMessageForRuntime(message) {
    if (!message || typeof message !== 'object') return null;
    if (message.role !== 'assistant') {
      delete message.isStreaming;
      delete message.startedAt;
      return message;
    }
    const compacted = compactAssistantMessage(message);
    if (!compacted) {
      hasUnsavedChanges = true;
      return null;
    }
    const beforeSize = safeJsonLength(message);
    Object.keys(message).forEach((key) => delete message[key]);
    Object.assign(message, compacted);
    if (safeJsonLength(message) < beforeSize) hasUnsavedChanges = true;
    return message;
  }

  function compactAssistantMessage(message) {
    const versionEntries = Array.isArray(message.versions)
      ? message.versions.map((version, index) => ({ snapshot: compactAssistantSnapshot(version), oldIndex: index }))
      : [];
    let meaningfulVersions = dedupeAssistantVersions(versionEntries.filter((entry) => isMeaningfulAssistantSnapshot(entry.snapshot)));
    if (meaningfulVersions.some((entry) => String(entry.snapshot.content || '').trim())) {
      meaningfulVersions = meaningfulVersions.filter((entry) => String(entry.snapshot.content || '').trim() || entry.snapshot.toolCalls?.length || entry.snapshot.error);
    }
    const currentSnapshot = compactAssistantSnapshot(message);
    const currentMeaningful = isMeaningfulAssistantSnapshot(currentSnapshot);

    const hasContentVersion = meaningfulVersions.some((entry) => String(entry.snapshot.content || '').trim());
    let activeEntry = meaningfulVersions.find((entry) => entry.oldIndex === message.activeVersion);
    if (activeEntry && hasContentVersion && !String(activeEntry.snapshot.content || '').trim()) {
      activeEntry = null;
    }
    if (!activeEntry && currentMeaningful && (!hasContentVersion || String(currentSnapshot.content || '').trim())) {
      activeEntry = { snapshot: currentSnapshot, oldIndex: -1 };
      if (!meaningfulVersions.some((entry) => assistantSnapshotKey(entry.snapshot) === assistantSnapshotKey(currentSnapshot))) {
        meaningfulVersions.push(activeEntry);
      }
    }
    if (!activeEntry) {
      activeEntry = [...meaningfulVersions].reverse().find((entry) => String(entry.snapshot.content || '').trim()) || meaningfulVersions.at(-1);
    }
    if (!activeEntry) return null;

    const activeSnapshot = activeEntry.snapshot;
    const compactVersions = meaningfulVersions.map((entry) => entry.snapshot);
    const activeVersion = Math.max(0, compactVersions.findIndex((snapshot) => assistantSnapshotKey(snapshot) === assistantSnapshotKey(activeSnapshot)));

    const result = {
      id: message.id || uid('msg'),
      role: 'assistant',
      ...activeSnapshot,
      isStreaming: false,
    };
    if (compactVersions.length > 1) {
      result.versions = compactVersions;
      result.activeVersion = activeVersion < 0 ? 0 : activeVersion;
    } else {
      result.versions = [];
      result.activeVersion = 0;
    }
    return result;
  }

  function compactAssistantSnapshot(source = {}) {
    const toolCalls = Array.isArray(source.toolCalls) ? structuredCloneSafe(source.toolCalls) : [];
    const reasoning = String(source.reasoning_content || source.extra?.reasoning || '');
    const content = String(source.content || '');
    const extra = {};
    if (reasoning) extra.reasoning = reasoning;
    if (source.extra?.raw_text && source.extra.raw_text !== content) extra.raw_text = source.extra.raw_text;

    const snapshot = {
      content,
      extra,
      reasoning_content: reasoning,
      suggestions: Array.isArray(source.suggestions) ? structuredCloneSafe(source.suggestions).filter(Boolean).slice(0, 6) : [],
      characterName: source.characterName || '',
      toolCalls,
      usage: structuredCloneSafe(source.usage || null),
      createdAt: source.createdAt || nowISO(),
      durationMs: Number(source.durationMs || 0),
      finishReason: source.finishReason || null,
      model: source.model || state.settings.model,
      error: source.error || '',
    };
    if (source.prefix) snapshot.prefix = true;
    if (source.emptyReasoningOnly || (!content.trim() && String(source.reasoning_content || source.extra?.reasoning || '').trim())) {
      snapshot.emptyReasoningOnly = true;
    }
    snapshot.role = 'assistant';
    syncAssistantExtraAliases(snapshot);
    delete snapshot.role;
    return snapshot;
  }

  function isMeaningfulAssistantSnapshot(snapshot) {
    return Boolean(
      String(snapshot?.content || '').trim()
      || snapshot?.toolCalls?.length
      || snapshot?.emptyReasoningOnly
      || snapshot?.error
    );
  }

  function dedupeAssistantVersions(entries) {
    const seen = new Set();
    const result = [];
    for (const entry of entries) {
      const key = assistantSnapshotKey(entry.snapshot);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(entry);
    }
    return result;
  }

  function assistantSnapshotKey(snapshot) {
    return [
      String(snapshot?.content || '').trim(),
      JSON.stringify(snapshot?.suggestions || []),
      String(snapshot?.finishReason || ''),
      String(snapshot?.error || ''),
    ].join('\u0001');
  }

  function safeJsonLength(value) {
    try {
      return JSON.stringify(value).length;
    } catch (_) {
      return 0;
    }
  }

  function buildPersistedStateSnapshot() {
    const settings = structuredCloneSafe(state.settings);
    if (serverApiKeyConfigured) {
      settings.apiKey = '';
      settings.useProxy = true;
    }
    return {
      sessions: state.sessions.map((session) => compactSessionForStorage(session)),
      activeSessionId: state.activeSessionId,
      settings,
      promptLibrary: structuredCloneSafe(state.promptLibrary),
      jailbreakPresets: structuredCloneSafe(state.jailbreakPresets),
      characterCards: structuredCloneSafe(state.characterCards),
      worldBooks: structuredCloneSafe(state.worldBooks),
      characterBookDecisions: structuredCloneSafe(state.characterBookDecisions),
    };
  }

  function compactSessionForStorage(session) {
    const copy = structuredCloneSafe(session || {});
    copy.messages = Array.isArray(copy.messages)
      ? copy.messages.map((message) => (message?.role === 'assistant' ? compactAssistantMessage(message) : compactPlainMessage(message))).filter(Boolean)
      : [];
    return copy;
  }

  function compactPlainMessage(message) {
    if (!message || typeof message !== 'object') return null;
    const copy = structuredCloneSafe(message);
    delete copy.isStreaming;
    delete copy.startedAt;
    if (copy.role !== 'tool') {
      delete copy.toolCalls;
      delete copy.reasoning_content;
      delete copy.card_state;
      delete copy.versions;
      delete copy.activeVersion;
      delete copy.extra;
    }
    return copy;
  }

  function restoreLocalActiveSession() {
    // Active session is now persisted in SQLite as global_settings.activeSessionId.
  }

  function rememberLocalActiveSession() {
    // No browser storage is used for user-visible state. The next persist writes
    // activeSessionId to SQLite through the WebSocket data client.
  }

  function persistSoon() {
    hasUnsavedChanges = true;
    stateChangeSeq += 1;
    // Do not write partial streaming assistant messages. The final assistant
    // message is saved once generation finishes.
    if (generating) {
      clearTimeout(saveTimer);
      saveTimer = 0;
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, SAVE_DELAY);
  }

  async function persistNow({ force = false, showSuccess = false } = {}) {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (generating && !force) {
      hasUnsavedChanges = true;
      return;
    }
    if (saveInFlight && !force) {
      hasUnsavedChanges = true;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persistNow, SAVE_DELAY);
      return;
    }
    if (!hasUnsavedChanges && !force) return;
    const serializable = buildPersistedStateSnapshot();
    const snapshotSeq = stateChangeSeq;
    saveInFlight = true;
    try {
      await commitPersistedSnapshot(serializable, { force, snapshotSeq });
      if (showSuccess) toast(force ? '已用当前备份重建 SQLite 数据。' : '已保存到 SQLite。', 'success');
    } catch (error) {
      console.warn('Failed to save state', error);
      updateSharedSyncStatus('error', `SQLite 保存失败：${error.message}`);
      toast(`SQLite 保存失败：${error.message}`, 'error');
    } finally {
      saveInFlight = false;
      if (hasUnsavedChanges && !generating && !saveTimer) {
        saveTimer = setTimeout(persistNow, SAVE_DELAY);
      }
    }
  }

  async function commitPersistedSnapshot(snapshot, { force = false, snapshotSeq = stateChangeSeq } = {}) {
    storageBackend = await savePersistedState(STORAGE_KEY, snapshot, { force });
    lastPersistedSnapshot = structuredCloneSafe(snapshot);
    if (force || snapshotSeq >= stateChangeSeq) {
      hasUnsavedChanges = false;
    } else {
      hasUnsavedChanges = true;
    }
    updateSharedSyncStatus('ok', `SQLite 已保存${Number.isFinite(getLastServerRevision()) ? ` · 修订 ${getLastServerRevision()}` : ''}`);
    renderStats();
  }

  function updateSharedSyncStatus(status, message, explicitRevision = undefined) {
    if (!els.syncStatus) return;
    const revision = Number.isFinite(explicitRevision) ? explicitRevision : getLastServerRevision();
    const revisionText = Number.isFinite(revision) && !String(message || '').includes('修订') ? ` · 修订 ${revision}` : '';
    els.syncStatus.className = `sync-status sync-status--${status || 'idle'}`;
    els.syncStatus.textContent = `${message || 'SQLite 数据通道待连接'}${revisionText}`;
    els.syncStatus.dataset.status = status || 'idle';
  }

  function ensureSession() {
    if (!state.sessions.length) {
      const session = createSession('新会话');
      state.sessions.unshift(session);
      state.activeSessionId = session.id;
    }
    if (!state.sessions.some((session) => session.id === state.activeSessionId)) {
      state.activeSessionId = state.sessions[0].id;
    }
    rememberLocalActiveSession();
  }

  function createSession(title = '新会话') {
    const session = {
      id: uid('session'),
      title,
      pinned: false,
      createdAt: nowISO(),
      updatedAt: nowISO(),
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
      userProfile: defaultUserProfile(),
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
    };
    applyDefaultJailbreakToSession(session);
    return session;
  }

  function activeSession() {
    return state.sessions.find((session) => session.id === state.activeSessionId) || state.sessions[0];
  }

  function touchSession(session = activeSession()) {
    if (!session) return;
    session.updatedAt = nowISO();
  }

  function defaultUserProfile() {
    return {
      pronouns: '',
      age: '',
      occupation: '',
      background: '',
      goals: '',
      language: '',
      tone: '',
      boundaries: '',
      customFields: '',
    };
  }

  function ensureUserProfile(session = activeSession()) {
    if (!session) return defaultUserProfile();
    session.userProfile = {
      ...defaultUserProfile(),
      ...(session.userProfile && typeof session.userProfile === 'object' ? session.userProfile : {}),
    };
    return session.userProfile;
  }

  function renderResourceLibraries() {
    renderJailbreakLibrary();
    renderCharacterLibrary();
    renderWorldBookLibrary();
  }

  function filteredLibraryItems(items, query, fields) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => fields.some((field) => {
      const value = field.split('.').reduce((obj, key) => obj?.[key], item);
      return Array.isArray(value)
        ? value.join(' ').toLowerCase().includes(q)
        : String(value || '').toLowerCase().includes(q);
    }));
  }

  function selectedOptionValue(select) {
    return String(select?.value || '');
  }

  function countJailbreakReferences(id) {
    return state.sessions.filter((session) => session.jailbreakPresetId === id).length;
  }

  function countCharacterConversations(id) {
    return state.sessions.filter((session) => session.characterCardId === id || session.characterCard?.library_id === id).length;
  }

  function countWorldBookReferences(id) {
    return state.sessions.filter((session) => session.worldBook?.id === id || session.activeWorldBookIds?.includes(id)).length;
  }

  function inferCharacterSourceFormat(source = '') {
    const lower = String(source || '').toLowerCase();
    if (lower.endsWith('.png')) return 'png';
    if (lower.endsWith('.charx')) return 'charx';
    return 'json';
  }

  function applyDefaultJailbreakToSession(session) {
    const preset = state.jailbreakPresets.find((item) => item.is_default);
    if (preset) applyJailbreakPresetToSession(session, preset);
  }

  function renderJailbreakLibrary() {
    if (!els.jailbreakLibrarySelect) return;
    const selected = selectedOptionValue(els.jailbreakLibrarySelect) || activeSession()?.jailbreakPresetId || '';
    const items = filteredLibraryItems(state.jailbreakPresets, els.jailbreakLibrarySearch?.value, ['name', 'description', 'tags'])
      .sort((a, b) => Number(b.is_default) - Number(a.is_default) || new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
    els.jailbreakLibrarySelect.innerHTML = '<option value="">未选择破限库预设</option>' + items.map((preset) => {
      const refs = countJailbreakReferences(preset.id);
      const label = `${preset.is_default ? '★ ' : ''}${preset.name} · 引用 ${refs}`;
      return `<option value="${preset.id}">${escapeHtml(label)}</option>`;
    }).join('');
    if (state.jailbreakPresets.some((preset) => preset.id === selected)) els.jailbreakLibrarySelect.value = selected;
    syncJailbreakLibraryEditor();
  }

  function onJailbreakLibrarySelect() {
    syncJailbreakLibraryEditor();
  }

  function syncJailbreakLibraryEditor() {
    const preset = state.jailbreakPresets.find((item) => item.id === selectedOptionValue(els.jailbreakLibrarySelect));
    if (!preset) return;
    els.jailbreakPresetNameInput.value = preset.name || '';
    els.jailbreakPresetDescriptionInput.value = preset.description || '';
    els.jailbreakPresetTagsInput.value = (preset.tags || []).join(', ');
    if (document.activeElement !== els.jailbreakPromptInput) els.jailbreakPromptInput.value = preset.system_prompt || '';
    if (document.activeElement !== els.jailbreakPostHistoryInput) els.jailbreakPostHistoryInput.value = preset.post_history_instructions || '';
  }

  function presetFromJailbreakEditor(base = {}) {
    const now = nowISO();
    return migrateJailbreakPreset({
      ...structuredCloneSafe(base || {}),
      id: base.id || uid('jb'),
      name: els.jailbreakPresetNameInput.value.trim() || base.name || '未命名破限',
      description: els.jailbreakPresetDescriptionInput.value.trim(),
      tags: els.jailbreakPresetTagsInput.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
      system_prompt: els.jailbreakPromptInput.value,
      post_history_instructions: els.jailbreakPostHistoryInput.value,
      created_at: base.created_at || now,
      updated_at: now,
      is_default: Boolean(base.is_default),
    });
  }

  function applyJailbreakPresetToSession(session, preset) {
    if (!session || !preset) return;
    session.jailbreakPresetId = preset.id || '';
    session.jailbreakEnabled = true;
    session.jailbreakPrompt = preset.system_prompt || '';
    session.jailbreakSource = preset.name || '破限库';
    session.jailbreakImportMeta = preset.import_meta || null;
    session.jailbreakImportKind = preset.import_kind || 'library';
    session.jailbreakParsed = Boolean(preset.layout?.length || preset.messages?.length);
    session.jailbreakMessages = structuredCloneSafe(preset.messages || []);
    session.jailbreakLayout = structuredCloneSafe(preset.layout || []);
    session.jailbreakSettings = structuredCloneSafe(preset.settings || {});
    session.jailbreakPostHistoryInstructions = preset.post_history_instructions || '';
  }

  function applySelectedJailbreakPreset() {
    const preset = state.jailbreakPresets.find((item) => item.id === selectedOptionValue(els.jailbreakLibrarySelect));
    if (!preset) return toast('请先选择破限库预设。', 'error');
    const session = activeSession();
    applyJailbreakPresetToSession(session, preset);
    touchSession(session);
    persistSoon();
    renderJailbreakPanel();
    renderJailbreakLibrary();
    toast(`已应用破限：${preset.name}`, 'success');
  }

  function saveCurrentJailbreakPresetToLibrary() {
    const existing = state.jailbreakPresets.find((item) => item.id === selectedOptionValue(els.jailbreakLibrarySelect));
    const preset = presetFromJailbreakEditor(existing || {});
    const index = state.jailbreakPresets.findIndex((item) => item.id === preset.id);
    if (index >= 0) state.jailbreakPresets[index] = preset;
    else state.jailbreakPresets.push(preset);
    activeSession().jailbreakPresetId = preset.id;
    persistSoon();
    renderJailbreakLibrary();
    els.jailbreakLibrarySelect.value = preset.id;
    toast('破限预设已保存到资源库。', 'success');
  }

  function newBlankJailbreakPreset() {
    const preset = migrateJailbreakPreset({ id: uid('jb'), name: '新破限预设', system_prompt: '', created_at: nowISO(), updated_at: nowISO() });
    state.jailbreakPresets.push(preset);
    persistSoon();
    renderJailbreakLibrary();
    els.jailbreakLibrarySelect.value = preset.id;
    syncJailbreakLibraryEditor();
  }

  function copySelectedJailbreakPreset() {
    const preset = state.jailbreakPresets.find((item) => item.id === selectedOptionValue(els.jailbreakLibrarySelect));
    if (!preset) return toast('请先选择破限预设。', 'error');
    const copy = migrateJailbreakPreset({ ...structuredCloneSafe(preset), id: uid('jb'), name: `${preset.name} 副本`, is_default: false, created_at: nowISO(), updated_at: nowISO() });
    state.jailbreakPresets.push(copy);
    persistSoon();
    renderJailbreakLibrary();
    els.jailbreakLibrarySelect.value = copy.id;
    syncJailbreakLibraryEditor();
  }

  function setSelectedJailbreakDefault() {
    const id = selectedOptionValue(els.jailbreakLibrarySelect);
    if (!id) return toast('请先选择破限预设。', 'error');
    for (const preset of state.jailbreakPresets) preset.is_default = preset.id === id;
    persistSoon();
    renderJailbreakLibrary();
    els.jailbreakLibrarySelect.value = id;
    toast('已设为新建对话默认破限。', 'success');
  }

  function deleteSelectedJailbreakPreset() {
    const id = selectedOptionValue(els.jailbreakLibrarySelect);
    const preset = state.jailbreakPresets.find((item) => item.id === id);
    if (!preset) return toast('请先选择破限预设。', 'error');
    const refs = countJailbreakReferences(id);
    if (!confirm(`确定删除破限「${preset.name}」吗？当前有 ${refs} 个对话正在使用。已有对话会保留快照文本。`)) return;
    state.jailbreakPresets = state.jailbreakPresets.filter((item) => item.id !== id);
    persistSoon();
    renderJailbreakLibrary();
  }

  function exportSelectedJailbreakPreset() {
    const preset = state.jailbreakPresets.find((item) => item.id === selectedOptionValue(els.jailbreakLibrarySelect));
    if (!preset) return toast('请先选择破限预设。', 'error');
    download(`${safeFileName(preset.name)}.jailbreak.json`, JSON.stringify(preset, null, 2), 'application/json');
  }

  async function importJailbreakLibraryJson(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const items = Array.isArray(data) ? data : Array.isArray(data.jailbreakPresets) ? data.jailbreakPresets : [data];
      for (const item of items) {
        const preset = migrateJailbreakPreset({ ...item, id: item.id || uid('jb'), created_at: item.created_at || nowISO(), updated_at: nowISO() });
        const index = state.jailbreakPresets.findIndex((old) => old.id === preset.id);
        if (index >= 0) state.jailbreakPresets[index] = preset;
        else state.jailbreakPresets.push(preset);
      }
      persistSoon();
      renderJailbreakLibrary();
      toast(`已导入 ${items.length} 个破限预设。`, 'success');
    } catch (error) {
      toast(`破限库导入失败：${error.message}`, 'error');
    }
  }

  function prepareCharacterForLibrary(card, { sourceFormat = null } = {}) {
    const now = nowISO();
    const copy = structuredCloneSafe(card || {});
    copy.id ||= uid('char');
    copy.library_id = copy.id;
    copy.source_format ||= sourceFormat || inferCharacterSourceFormat(copy.source || '');
    copy.raw_json ||= copy.rawPayload || (copy.raw ? JSON.stringify(copy.raw, null, 2) : JSON.stringify(copy, null, 2));
    copy.created_at ||= now;
    copy.updated_at = now;
    copy.conversation_count = countCharacterConversations(copy.id);
    return migrateLibraryCharacterCard(copy);
  }

  function renderCharacterLibrary() {
    if (!els.characterLibrarySelect) return;
    const selected = selectedOptionValue(els.characterLibrarySelect) || activeSession()?.characterCardId || '';
    const items = filteredLibraryItems(state.characterCards, els.characterLibrarySearch?.value, ['name', 'tags', 'creator'])
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN'));
    els.characterLibrarySelect.innerHTML = '<option value="">未选择角色卡</option>' + items.map((card) => {
      const refs = countCharacterConversations(card.id);
      return `<option value="${card.id}">${escapeHtml(`${card.name} · ${card.spec_version || 'v?'} · 对话 ${refs}`)}</option>`;
    }).join('');
    if (state.characterCards.some((card) => card.id === selected)) els.characterLibrarySelect.value = selected;
    renderCharacterLibrarySelectionMeta();
    if (state.ui.characterManagerOpen) renderCharacterManager();
  }

  function renderCharacterLibrarySelectionMeta() {
    // Keep the active session editor as the detailed preview. The select option
    // already shows the lightweight library metadata.
  }

  function applyCharacterCardToSession(session, card) {
    if (!session || !card) return;
    const snapshot = structuredCloneSafe(card);
    snapshot.library_id = card.id;
    session.characterCard = snapshot;
    session.characterCardId = card.id;
    session.characterCardEnabled = true;
    session.greetingIndex = 0;
    const boundIds = state.worldBooks
      .filter((book) => book.source === 'character_embedded' && book.bound_character_id === card.id)
      .map((book) => book.id);
    session.activeWorldBookIds = [...new Set([...(session.activeWorldBookIds || []), ...boundIds])];
    if (boundIds.length) session.worldBookEnabled = true;
  }

  function applySelectedCharacterCard() {
    const card = state.characterCards.find((item) => item.id === selectedOptionValue(els.characterLibrarySelect));
    if (!card) return toast('请先选择角色卡。', 'error');
    const session = activeSession();
    applyCharacterCardToSession(session, card);
    touchSession(session);
    persistSoon();
    renderCharacterPanel();
    renderWorldBookLibrary();
    toast(`已应用角色快照：${card.name}`, 'success');
  }

  function saveCurrentCharacterCardToLibrary() {
    const session = activeSession();
    if (!session?.characterCard) return toast('当前对话没有角色卡。', 'error');
    const existingId = selectedOptionValue(els.characterLibrarySelect) || session.characterCardId || session.characterCard.library_id || session.characterCard.id;
    const card = prepareCharacterForLibrary({ ...session.characterCard, id: existingId || session.characterCard.id || uid('char') });
    const index = state.characterCards.findIndex((item) => item.id === card.id);
    if (index >= 0) state.characterCards[index] = card;
    else state.characterCards.push(card);
    session.characterCardId = card.id;
    session.characterCard.library_id = card.id;
    persistSoon();
    renderCharacterLibrary();
    els.characterLibrarySelect.value = card.id;
    toast('角色卡已保存到资源库。', 'success');
  }

  function syncCurrentCharacterFromLibrary() {
    const session = activeSession();
    const id = session?.characterCardId || selectedOptionValue(els.characterLibrarySelect);
    const card = state.characterCards.find((item) => item.id === id);
    if (!card) return toast('未找到库内角色卡。', 'error');
    if (!confirm('同步库内最新版会覆盖当前对话的角色卡快照，但不会删除聊天记录。继续？')) return;
    applyCharacterCardToSession(session, card);
    touchSession(session);
    persistSoon();
    renderCharacterPanel();
    toast('当前对话角色快照已同步为库内最新版。', 'success');
  }

  function deleteSelectedCharacterCard() {
    deleteCharacterCardById(selectedOptionValue(els.characterLibrarySelect));
  }

  function exportSelectedCharacterCard() {
    exportCharacterCardById(selectedOptionValue(els.characterLibrarySelect));
  }

  function getCharacterManagerItems() {
    const query = state.ui.characterManagerSearch || '';
    const items = filteredLibraryItems(state.characterCards, query, ['name', 'description', 'personality', 'scenario', 'tags', 'creator'])
      .map((card) => ({ ...card, conversation_count: countCharacterConversations(card.id) }));
    const byTime = (key) => (a, b) => new Date(b[key] || 0) - new Date(a[key] || 0) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN');
    const sort = state.ui.characterManagerSort || 'updated_desc';
    if (sort === 'created_desc') return items.sort(byTime('created_at'));
    if (sort === 'name_asc') return items.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN'));
    return items.sort(byTime('updated_at'));
  }

  function renderCharacterManager() {
    if (!els.characterManagerList) return;
    if (document.activeElement !== els.characterManagerSearch) {
      els.characterManagerSearch.value = state.ui.characterManagerSearch || '';
    }
    els.characterManagerSort.value = state.ui.characterManagerSort || 'updated_desc';
    const total = state.characterCards.length;
    const items = getCharacterManagerItems();
    const visibleCount = clamp(Number(state.ui.characterManagerVisibleCount || 48), 12, Math.max(items.length, 48));
    const visible = items.slice(0, visibleCount);
    if (els.characterManagerHint) {
      els.characterManagerHint.textContent = total
        ? `${total} 张角色卡 · 当前显示 ${visible.length}/${items.length}`
        : '集中管理角色卡资源库';
    }
    renderCharacterManagerEditor();
    if (!total) {
      els.characterManagerList.innerHTML = `
        <div class="character-manager-empty">
          <div class="empty-state__orb">♟</div>
          <strong>还没有角色卡</strong>
          <p>点击“新建角色卡”手动创建，或上传 JSON / PNG / CHARX 角色卡文件。</p>
          <button class="primary small" data-character-action="new">创建第一个</button>
        </div>`;
      return;
    }
    if (!items.length) {
      els.characterManagerList.innerHTML = `
        <div class="character-manager-empty compact">
          <strong>没有匹配结果</strong>
          <p>换个关键词，或清空搜索条件查看全部角色卡。</p>
        </div>`;
      return;
    }
    const cardsHtml = visible.map(characterManagerCardHtml).join('');
    const moreHtml = visible.length < items.length
      ? `<button class="ghost character-manager-load" data-character-action="load-more">加载更多（剩余 ${items.length - visible.length}）</button>`
      : '';
    els.characterManagerList.innerHTML = `${cardsHtml}${moreHtml}`;
  }

  function characterManagerCardHtml(card) {
    const description = String(card.description || card.personality || card.scenario || '暂无描述').replace(/\s+/g, ' ').trim();
    const tags = Array.isArray(card.tags) ? card.tags.slice(0, 3) : [];
    const updated = formatTime(card.updated_at || card.updatedAt || card.created_at || card.createdAt);
    const created = formatTime(card.created_at || card.createdAt);
    const conversations = countCharacterConversations(card.id);
    const greetings = getCharacterGreetings(card).length;
    return `
      <article class="character-manager-card" data-character-id="${escapeHtml(card.id)}">
        <div class="character-card-avatar" aria-hidden="true">${escapeHtml(characterInitials(card))}</div>
        <div class="character-card-main">
          <div class="character-card-title">
            <strong>${escapeHtml(card.name || '未命名角色')}</strong>
            <span>${escapeHtml(card.spec_version || card.source_format || 'card')}</span>
          </div>
          <p>${escapeHtml(description.slice(0, 180))}</p>
          <div class="character-card-meta">
            ${updated ? `<span>更新 ${escapeHtml(updated)}</span>` : ''}
            ${created ? `<span>创建 ${escapeHtml(created)}</span>` : ''}
            <span>${conversations} 对话</span>
            <span>${greetings} 开场白</span>
          </div>
          ${tags.length ? `<div class="character-card-tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
          <div class="character-card-actions">
            <button class="primary small" data-character-action="start" data-character-id="${escapeHtml(card.id)}">开始对话</button>
            <button class="ghost small" data-character-action="edit" data-character-id="${escapeHtml(card.id)}">编辑</button>
            <button class="ghost small" data-character-action="export" data-character-id="${escapeHtml(card.id)}">导出</button>
            <button class="danger small" data-character-action="delete" data-character-id="${escapeHtml(card.id)}">删除</button>
          </div>
        </div>
      </article>`;
  }

  function characterInitials(card = {}) {
    return String(card.name || '角色').trim().slice(0, 2) || '角';
  }

  function onCharacterManagerListClick(event) {
    const button = event.target.closest('[data-character-action]');
    if (!button) return;
    const action = button.dataset.characterAction;
    const id = button.dataset.characterId || button.closest('[data-character-id]')?.dataset.characterId || '';
    if (action === 'new') return newCharacterCardFromManager();
    if (action === 'load-more') {
      state.ui.characterManagerVisibleCount = Number(state.ui.characterManagerVisibleCount || 48) + 48;
      renderCharacterManager();
      return;
    }
    if (action === 'start') return startCharacterChatFromLibrary(id);
    if (action === 'edit') return editCharacterCardFromManager(id);
    if (action === 'export') return exportCharacterCardById(id);
    if (action === 'delete') return deleteCharacterCardById(id);
  }

  function newCharacterCardFromManager() {
    state.ui.editingCharacterCardId = '__new__';
    renderCharacterManager();
    setTimeout(() => els.characterManagerNameInput?.focus({ preventScroll: true }), 40);
  }

  function editCharacterCardFromManager(id) {
    if (!state.characterCards.some((card) => card.id === id)) return toast('未找到角色卡。', 'error');
    state.ui.editingCharacterCardId = id;
    renderCharacterManager();
    setTimeout(() => els.characterManagerNameInput?.focus({ preventScroll: true }), 40);
  }

  function closeCharacterManagerEditor() {
    state.ui.editingCharacterCardId = '';
    renderCharacterManager();
  }

  function renderCharacterManagerEditor() {
    if (!els.characterManagerEditor) return;
    const id = state.ui.editingCharacterCardId || '';
    const isNew = id === '__new__';
    const card = isNew ? null : state.characterCards.find((item) => item.id === id);
    els.characterManagerEditor.classList.toggle('hidden', !isNew && !card);
    if (!isNew && !card) return;
    els.characterManagerEditorTitle.textContent = isNew ? '新建角色卡' : `编辑：${card.name || '未命名角色'}`;
    els.characterManagerNameInput.value = card?.name || '';
    els.characterManagerTagsInput.value = Array.isArray(card?.tags) ? card.tags.join(', ') : '';
    els.characterManagerCreatorInput.value = card?.creator || '';
    els.characterManagerDescriptionInput.value = card?.description || '';
    els.characterManagerPersonalityInput.value = card?.personality || '';
    els.characterManagerScenarioInput.value = card?.scenario || '';
    els.characterManagerFirstMesInput.value = card?.first_mes || '';
  }

  function collectCharacterManagerEditorCard() {
    const id = state.ui.editingCharacterCardId;
    const existing = id && id !== '__new__' ? state.characterCards.find((card) => card.id === id) : null;
    const name = String(els.characterManagerNameInput.value || '').trim();
    if (!name) throw new Error('角色名称不能为空。');
    const card = {
      ...(existing ? structuredCloneSafe(existing) : {
        id: uid('char'),
        spec: 'chara_card_v2',
        spec_version: 'v2',
        source: '手动创建',
        source_format: 'manual',
        alternate_greetings: [],
      }),
      name,
      tags: String(els.characterManagerTagsInput.value || '').split(',').map((item) => item.trim()).filter(Boolean),
      creator: els.characterManagerCreatorInput.value || '',
      description: els.characterManagerDescriptionInput.value || '',
      personality: els.characterManagerPersonalityInput.value || '',
      scenario: els.characterManagerScenarioInput.value || '',
      first_mes: els.characterManagerFirstMesInput.value || '',
      updated_at: nowISO(),
    };
    delete card.raw;
    delete card.rawPayload;
    delete card.pngMetadataKey;
    applyCharacterFieldEdit(card, 'name', card.name);
    for (const key of ['description', 'personality', 'scenario', 'first_mes']) {
      applyCharacterFieldEdit(card, key, card[key]);
    }
    card.raw_json = JSON.stringify(characterCardExportPayload(card), null, 2);
    return prepareCharacterForLibrary(card, { sourceFormat: card.source_format || 'manual' });
  }

  function saveCharacterManagerEditor() {
    try {
      const card = collectCharacterManagerEditorCard();
      const index = state.characterCards.findIndex((item) => item.id === card.id);
      if (index >= 0) state.characterCards[index] = card;
      else state.characterCards.unshift(card);
      state.ui.editingCharacterCardId = '';
      persistSoon();
      renderCharacterLibrary();
      renderCharacterManager();
      toast(`角色卡「${card.name}」已保存。`, 'success');
    } catch (error) {
      toast(error.message || '角色卡保存失败。', 'error');
    }
  }

  function characterCardExportPayload(card = {}) {
    const copy = structuredCloneSafe(card);
    delete copy.raw;
    delete copy.rawPayload;
    delete copy.raw_json;
    delete copy.pngMetadataKey;
    return copy;
  }

  function exportCharacterCardById(id) {
    const card = state.characterCards.find((item) => item.id === id);
    if (!card) return toast('请先选择角色卡。', 'error');
    download(`${safeFileName(card.name)}.character.json`, JSON.stringify(characterCardExportPayload(card), null, 2), 'application/json');
  }

  function exportCharacterLibrary() {
    if (!state.characterCards.length) return toast('角色卡库为空，暂无可导出的内容。');
    download(`character-library-${dateSlug()}.json`, JSON.stringify({
      exportedAt: nowISO(),
      characterCards: state.characterCards.map(characterCardExportPayload),
    }, null, 2), 'application/json');
  }

  function deleteCharacterCardById(id) {
    const card = state.characterCards.find((item) => item.id === id);
    if (!card) return toast('请先选择角色卡。', 'error');
    const refs = countCharacterConversations(id);
    if (!confirm(`确定删除角色卡「${card.name}」吗？已有对话会保留角色快照。`)) return;
    const removeConversations = refs && confirm(`角色「${card.name}」下有 ${refs} 条对话。是否一并删除这些对话？`);
    state.characterCards = state.characterCards.filter((item) => item.id !== id);
    if (removeConversations) {
      state.sessions = state.sessions.filter((session) => session.characterCardId !== id && session.characterCard?.library_id !== id);
      ensureSession();
    }
    if (state.ui.editingCharacterCardId === id) state.ui.editingCharacterCardId = '';
    persistSoon();
    renderCharacterLibrary();
    renderCharacterManager();
    renderSessions();
    renderCharacterPanel();
    renderStats();
    toast(`角色卡「${card.name}」已删除。`, 'success');
  }

  function startCharacterChatFromLibrary(id) {
    const card = state.characterCards.find((item) => item.id === id);
    if (!card) return toast('未找到角色卡。', 'error');
    startCharacterChatWithCard(card, { sourceSession: activeSession(), closeManager: true, requireGreeting: false });
  }

  function prepareWorldBookForLibrary(book, { source = 'imported', boundCharacterId = '' } = {}) {
    const now = nowISO();
    const copy = structuredCloneSafe(book || {});
    copy.id ||= uid('wb');
    copy.source ||= source;
    copy.bound_character_id ||= boundCharacterId;
    copy.tags = Array.isArray(copy.tags) ? copy.tags : [];
    copy.created_at ||= now;
    copy.updated_at = now;
    return copy;
  }

  function renderWorldBookLibrary() {
    if (!els.worldBookLibrarySelect) return;
    const session = activeSession();
    const selected = selectedOptionValue(els.worldBookLibrarySelect) || session?.worldBook?.id || '';
    const items = filteredLibraryItems(state.worldBooks, els.worldBookLibrarySearch?.value, ['name', 'description', 'tags', 'source'])
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN'));
    els.worldBookLibrarySelect.innerHTML = '<option value="">未选择世界书</option>' + items.map((book) => {
      const source = book.source === 'character_embedded' ? '角色绑定' : book.source === 'user_created' ? '自建' : '导入';
      return `<option value="${book.id}">${escapeHtml(`${book.name} · ${book.entries?.length || 0} 条 · ${source}`)}</option>`;
    }).join('');
    if (state.worldBooks.some((book) => book.id === selected)) els.worldBookLibrarySelect.value = selected;
    renderActiveWorldBookSelect();
  }

  function renderActiveWorldBookSelect() {
    if (!els.activeWorldBookSelect) return;
    const session = activeSession();
    const activeIds = new Set(session?.activeWorldBookIds || []);
    const currentCharacterId = session?.characterCardId || session?.characterCard?.library_id || '';
    els.activeWorldBookSelect.innerHTML = state.worldBooks.map((book) => {
      const bound = book.source === 'character_embedded' && book.bound_character_id === currentCharacterId;
      const selected = activeIds.has(book.id) || bound;
      const label = `${bound ? '🔒 ' : ''}${book.name} · ${book.entries?.length || 0} 条`;
      return `<option value="${book.id}" ${selected ? 'selected' : ''} ${bound ? 'disabled' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
  }

  function updateActiveWorldBookSelection() {
    const session = activeSession();
    const selected = [...els.activeWorldBookSelect.selectedOptions].map((option) => option.value);
    const currentCharacterId = session?.characterCardId || session?.characterCard?.library_id || '';
    const bound = state.worldBooks
      .filter((book) => book.source === 'character_embedded' && book.bound_character_id === currentCharacterId)
      .map((book) => book.id);
    session.activeWorldBookIds = [...new Set([...selected, ...bound])];
    session.worldBookEnabled = session.activeWorldBookIds.length > 0 || Boolean(session.worldBook);
    touchSession(session);
    persistSoon();
    renderWorldBookPanel();
  }

  function applySelectedWorldBookForEditing() {
    const book = state.worldBooks.find((item) => item.id === selectedOptionValue(els.worldBookLibrarySelect));
    if (!book) return;
    const session = activeSession();
    session.worldBook = structuredCloneSafe(book);
    session.worldBookEnabled = true;
    session.worldBookScanDepth = book.scan_depth || 4;
    session.worldBookTokenBudget = book.token_budget || 1200;
    session.worldBookRecursive = Boolean(book.recursive_scanning);
    if (!session.activeWorldBookIds.includes(book.id)) session.activeWorldBookIds.push(book.id);
    renderWorldBookPanel();
  }

  function applySelectedWorldBookFromLibrary() {
    applySelectedWorldBookForEditing();
    touchSession();
    persistSoon();
    renderWorldBookLibrary();
    toast('已将世界书加入当前对话激活列表。', 'success');
  }

  function saveCurrentWorldBookToLibrary() {
    const session = activeSession();
    if (!session?.worldBook) return toast('当前没有世界书可保存。', 'error');
    const existing = state.worldBooks.find((item) => item.id === (selectedOptionValue(els.worldBookLibrarySelect) || session.worldBook.id));
    const book = prepareWorldBookForLibrary({
      ...session.worldBook,
      id: existing?.id || session.worldBook.id || uid('wb'),
      scan_depth: session.worldBookScanDepth,
      token_budget: session.worldBookTokenBudget,
      recursive_scanning: session.worldBookRecursive,
    }, { source: existing?.source || session.worldBook.source || 'user_created', boundCharacterId: existing?.bound_character_id || session.worldBook.bound_character_id || '' });
    const index = state.worldBooks.findIndex((item) => item.id === book.id);
    if (index >= 0) state.worldBooks[index] = book;
    else state.worldBooks.push(book);
    session.worldBook = structuredCloneSafe(book);
    if (!session.activeWorldBookIds.includes(book.id)) session.activeWorldBookIds.push(book.id);
    persistSoon();
    renderWorldBookLibrary();
    els.worldBookLibrarySelect.value = book.id;
    toast('世界书已保存到资源库。', 'success');
  }

  function newBlankWorldBook() {
    const book = prepareWorldBookForLibrary({
      name: '新世界书',
      description: '',
      scan_depth: 4,
      token_budget: 1200,
      recursive_scanning: false,
      entries: [{
        id: uid('wbe'),
        name: '新条目',
        keys: ['关键词'],
        secondaryKeys: [],
        secondary_keys: [],
        content: '这里填写命中后注入的世界观/人物/地点资料。',
        enabled: true,
        insertion_order: 100,
        order: 100,
        case_sensitive: false,
        caseSensitive: false,
        selective: false,
        constant: false,
        position: 'before_char',
        depth: 4,
        priority: 100,
        comment: '',
        extensions: {},
      }],
    }, { source: 'user_created' });
    state.worldBooks.push(book);
    persistSoon();
    renderWorldBookLibrary();
    els.worldBookLibrarySelect.value = book.id;
    applySelectedWorldBookForEditing();
  }

  function deleteSelectedWorldBook() {
    const id = selectedOptionValue(els.worldBookLibrarySelect);
    const book = state.worldBooks.find((item) => item.id === id);
    if (!book) return toast('请先选择世界书。', 'error');
    const refs = countWorldBookReferences(id);
    if (!confirm(`确定删除世界书「${book.name}」吗？当前有 ${refs} 个对话正在使用。已有对话会保留已复制的世界书快照。`)) return;
    state.worldBooks = state.worldBooks.filter((item) => item.id !== id);
    for (const session of state.sessions) {
      session.activeWorldBookIds = (session.activeWorldBookIds || []).filter((item) => item !== id);
    }
    persistSoon();
    renderWorldBookLibrary();
    renderWorldBookPanel();
  }

  function exportSelectedWorldBook() {
    const book = state.worldBooks.find((item) => item.id === selectedOptionValue(els.worldBookLibrarySelect));
    if (!book) return toast('请先选择世界书。', 'error');
    download(`${safeFileName(book.name)}.worldbook.json`, JSON.stringify(book, null, 2), 'application/json');
  }

  function bindEvents() {
    els.newSessionBtn.addEventListener('click', () => newSession());
    els.collapseSidebarBtn.addEventListener('click', () => toggleSidebar());
    els.openSidebarBtn.addEventListener('click', () => toggleSidebar(false));
    els.userProfileBtn.addEventListener('click', () => toggleUserProfile(true));
    els.closeUserProfileBtn.addEventListener('click', () => toggleUserProfile(false));
    els.userProfileBackdrop.addEventListener('click', () => toggleUserProfile(false));
    els.characterManagerBtn.addEventListener('click', () => toggleCharacterManager(true));
    els.closeCharacterManagerBtn.addEventListener('click', () => toggleCharacterManager(false));
    els.characterManagerBackdrop.addEventListener('click', () => toggleCharacterManager(false));
    els.settingsBtn.addEventListener('click', () => toggleSettings(true));
    els.closeSettingsBtn.addEventListener('click', () => toggleSettings(false));
    els.themeToggleBtn.addEventListener('click', cycleTheme);
    els.settingsPagesNav.addEventListener('click', (event) => {
      const button = event.target.closest('[data-settings-page]');
      if (!button) return;
      setSettingsPage(button.dataset.settingsPage);
    });

    els.sessionSearch.addEventListener('input', () => {
      state.ui.search = els.sessionSearch.value.trim();
      renderSessions();
    });
    els.batchModeBtn.addEventListener('click', toggleBatchMode);
    els.selectAllBtn.addEventListener('click', selectAllVisibleSessions);
    els.deleteSelectedBtn.addEventListener('click', deleteSelectedSessions);
    els.sessionList.addEventListener('click', onSessionListClick);
    els.sessionList.addEventListener('keydown', onSessionListKeydown);
    document.addEventListener('click', (event) => {
      if (!state.ui.openSessionMenuId || event.target.closest('.session-menu-wrap')) return;
      state.ui.openSessionMenuId = null;
      renderSessions();
    });
    document.addEventListener('click', (event) => {
      if (window.innerWidth > 820 || state.ui.sidebarCollapsed) return;
      if (event.target.closest('#sidebar') || event.target.closest('#openSidebarBtn')) return;
      toggleSidebar(true);
    });

    els.exportAllBtn.addEventListener('click', exportAllData);
    els.importAllInput.addEventListener('change', importAllData);

    els.modelSelect.addEventListener('change', () => updateSetting('model', els.modelSelect.value));
    els.modelSettingSelect.addEventListener('change', () => updateSetting('model', els.modelSettingSelect.value));
    els.thinkingQuickBtn.addEventListener('click', () => updateSetting('thinking', !state.settings.thinking));
    els.jsonQuickBtn.addEventListener('click', () => updateSetting('jsonMode', !state.settings.jsonMode));

    els.messageInput.addEventListener('input', () => {
      autoResizeInput();
      updateComposerState();
    });
    els.messageInput.addEventListener('keydown', onComposerKeydown);
    els.sendBtn.addEventListener('click', () => {
      if (generating) stopGeneration();
      else submitMessage();
    });
    els.assistantPrefix.addEventListener('input', () => updateSetting('assistantPrefix', els.assistantPrefix.value));
    els.starterGrid.addEventListener('click', (event) => {
      const button = event.target.closest('[data-starter]');
      if (!button) return;
      els.messageInput.value = button.dataset.starter;
      autoResizeInput();
      updateComposerState();
      els.messageInput.focus();
    });

    els.messages.addEventListener('scroll', onMessagesScroll, { passive: true });
    els.messages.addEventListener('click', onMessagesClick);
    els.backLatestBtn.addEventListener('click', () => scrollToBottom(true));

    bindSettingsEvents();
    bindUserProfileEvents();
    bindFimEvents();
    bindKeyboardShortcuts();
  }

  function bindUserProfileEvents() {
    const inputs = [
      'userProfileNameInput', 'userProfilePronounsInput', 'userProfileAgeInput', 'userProfileOccupationInput',
      'userProfilePersonaInput', 'userProfileBackgroundInput', 'userProfileGoalsInput',
      'userProfileLanguageInput', 'userProfileToneInput', 'userProfileBoundariesInput', 'userProfileCustomFieldsInput',
    ];
    for (const key of inputs) {
      els[key]?.addEventListener('input', () => saveUserProfileFromDrawer({ toastOnSave: false }));
      els[key]?.addEventListener('blur', () => {
        if (state.ui.userProfileDirty) saveUserProfileFromDrawer({ toastOnSave: true, auto: true });
      });
    }
    els.saveUserProfileBtn?.addEventListener('click', () => saveUserProfileFromDrawer({ toastOnSave: true }));
    els.resetUserProfileBtn?.addEventListener('click', resetUserProfileDrawer);
  }

  function bindSettingsEvents() {
    bindResourceLibraryEvents();

    const inputBindings = [
      ['apiKeyInput', 'apiKey', 'value'],
      ['baseUrlInput', 'baseUrl', 'value'],
      ['betaBaseUrlInput', 'betaBaseUrl', 'value'],
      ['useProxyInput', 'useProxy', 'checked'],
      ['temperatureInput', 'temperature', 'number'],
      ['topPInput', 'topP', 'number'],
      ['maxTokensInput', 'maxTokens', 'integer'],
      ['responseLengthInput', 'responseLength', 'value'],
      ['customLengthInput', 'customLength', 'value'],
      ['presencePenaltyInput', 'presencePenalty', 'number'],
      ['frequencyPenaltyInput', 'frequencyPenalty', 'number'],
      ['stopInput', 'stop', 'value'],
      ['thinkingInput', 'thinking', 'checked'],
      ['reasoningEffortInput', 'reasoningEffort', 'value'],
      ['jsonModeInput', 'jsonMode', 'checked'],
      ['prefixEnabledInput', 'prefixEnabled', 'checked'],
      ['fimEnabledInput', 'fimEnabled', 'checked'],
      ['toolsEnabledInput', 'toolsEnabled', 'checked'],
      ['toolsJsonInput', 'toolsJson', 'value'],
      ['themeInput', 'theme', 'value'],
      ['fontScaleInput', 'fontScale', 'number'],
      ['timestampsInput', 'showTimestamps', 'checked'],
      ['lineNumbersInput', 'lineNumbers', 'checked'],
    ];

    for (const [elementKey, settingKey, mode] of inputBindings) {
      els[elementKey].addEventListener('input', () => {
        let value;
        if (mode === 'checked') value = els[elementKey].checked;
        else if (mode === 'number') value = Number(els[elementKey].value);
        else if (mode === 'integer') value = Number.parseInt(els[elementKey].value, 10);
        else value = els[elementKey].value;
        updateSetting(settingKey, value);
      });
      els[elementKey].addEventListener('change', () => {
        if (elementKey === 'toolsJsonInput') validateToolsJson({ silent: true });
      });
    }

    bindFormattingEvents();

    els.systemPromptInput.addEventListener('input', () => {
      const session = activeSession();
      session.systemPrompt = els.systemPromptInput.value;
      touchSession(session);
      persistSoon();
      renderStats();
    });

    els.promptTemplates.addEventListener('click', (event) => {
      const button = event.target.closest('[data-template]');
      if (!button) return;
      const template = PROMPT_TEMPLATES[Number(button.dataset.template)];
      if (!template) return;
      if (template.name === '自定义…') {
        els.systemPromptInput.focus();
        return;
      }
      activeSession().systemPrompt = template.prompt;
      els.systemPromptInput.value = template.prompt;
      touchSession();
      persistSoon();
      toast(`已应用 Prompt：${template.name}`, 'success');
    });

    els.savePromptBtn.addEventListener('click', savePromptToLibrary);
    els.exportPromptBtn.addEventListener('click', exportPrompts);
    els.importPromptInput.addEventListener('change', importPrompts);
    els.promptLibrary.addEventListener('click', onPromptLibraryClick);
    els.jailbreakEnabledInput.addEventListener('change', () => {
      const session = activeSession();
      session.jailbreakEnabled = els.jailbreakEnabledInput.checked;
      touchSession(session);
      persistSoon();
      renderJailbreakPanel();
      renderStats();
    });
    els.jailbreakPromptInput.addEventListener('input', () => {
      const session = activeSession();
      session.jailbreakPrompt = els.jailbreakPromptInput.value;
      session.jailbreakPresetId = '';
      session.jailbreakMessages = [];
      session.jailbreakLayout = [];
      session.jailbreakSettings = {};
      session.jailbreakParsed = false;
      session.jailbreakImportKind = session.jailbreakPrompt.trim() ? 'manual-text' : '';
      session.jailbreakImportMeta = null;
      if (session.jailbreakPrompt.trim() && !session.jailbreakEnabled) {
        session.jailbreakEnabled = true;
        els.jailbreakEnabledInput.checked = true;
      }
      touchSession(session);
      persistSoon();
      renderJailbreakPanel({ keepText: true });
      renderStats();
    });
    els.jailbreakPostHistoryInput.addEventListener('input', () => {
      const session = activeSession();
      session.jailbreakPostHistoryInstructions = els.jailbreakPostHistoryInput.value;
      touchSession(session);
      persistSoon();
    });
    els.jailbreakImportInput.addEventListener('change', importJailbreakPreset);
    els.clearJailbreakBtn.addEventListener('click', clearJailbreakPreset);
    els.userNameInput.addEventListener('input', () => {
      const session = activeSession();
      session.userName = els.userNameInput.value;
      touchSession(session);
      persistSoon();
      renderUserProfileDrawer();
      renderCharacterPanel();
      renderStats();
    });
    els.userPersonaInput.addEventListener('input', () => {
      const session = activeSession();
      session.userPersona = els.userPersonaInput.value;
      touchSession(session);
      persistSoon();
      renderUserProfileDrawer();
      renderCharacterPanel();
      renderStats();
    });
    els.rpModeInput.addEventListener('change', () => {
      const session = activeSession();
      session.rpMode = els.rpModeInput.checked;
      touchSession(session);
      persistSoon();
      renderCharacterPanel();
      renderStats();
    });
    els.rpPerspectiveInput.addEventListener('change', () => {
      const session = activeSession();
      session.rpPerspective = els.rpPerspectiveInput.value;
      touchSession(session);
      persistSoon();
      renderStats();
    });
    els.rpSuggestionsInput.addEventListener('change', () => {
      const session = activeSession();
      session.rpSuggestions = els.rpSuggestionsInput.checked;
      touchSession(session);
      persistSoon();
      renderStats();
    });
    els.rpMemoryInput.addEventListener('input', () => {
      const session = activeSession();
      session.rpMemory = els.rpMemoryInput.value;
      touchSession(session);
      persistSoon();
      renderStats();
    });
    els.backgroundEnabledInput.addEventListener('change', () => {
      const session = activeSession();
      session.backgroundEnabled = els.backgroundEnabledInput.checked;
      touchSession(session);
      persistSoon();
      renderStats();
    });
    els.backgroundInput.addEventListener('input', () => {
      const session = activeSession();
      session.background = els.backgroundInput.value;
      touchSession(session);
      persistSoon();
      renderCharacterPanel();
      renderStats();
    });
    els.characterEnabledInput.addEventListener('change', () => {
      const session = activeSession();
      session.characterCardEnabled = els.characterEnabledInput.checked;
      touchSession(session);
      persistSoon();
      renderCharacterPanel();
      renderStats();
    });
    els.characterCardInput.addEventListener('change', importCharacterCard);
    els.characterGreetingSelect.addEventListener('change', () => {
      const session = activeSession();
      session.greetingIndex = Number.parseInt(els.characterGreetingSelect.value || '0', 10) || 0;
      touchSession(session);
      persistSoon();
    });
    bindCharacterFieldEditor('characterNameInput', 'name');
    bindCharacterFieldEditor('characterDescriptionInput', 'description');
    bindCharacterFieldEditor('characterPersonalityInput', 'personality');
    bindCharacterFieldEditor('characterScenarioInput', 'scenario');
    bindCharacterFieldEditor('characterFirstMesInput', 'first_mes');
    bindCharacterFieldEditor('characterMesExampleInput', 'mes_example');
    bindCharacterFieldEditor('characterSystemPromptInput', 'system_prompt');
    bindCharacterFieldEditor('characterPostHistoryInput', 'post_history_instructions');
    bindCharacterFieldEditor('characterCreatorNotesInput', 'creator_notes');
    els.startCharacterChatBtn.addEventListener('click', () => startCharacterChat({ reset: true }));
    els.insertGreetingBtn.addEventListener('click', () => insertCharacterGreeting({ append: true }));
    els.clearCharacterBtn.addEventListener('click', clearCharacterCard);
    els.worldBookEnabledInput.addEventListener('change', () => {
      const session = activeSession();
      session.worldBookEnabled = els.worldBookEnabledInput.checked;
      touchSession(session);
      persistSoon();
      renderWorldBookPanel();
      renderStats();
    });
    els.worldBookImportInput.addEventListener('change', importWorldBook);
    els.clearWorldBookBtn.addEventListener('click', clearWorldBook);
    const updateWorldBookNumber = (key, element, min, max) => {
      const session = activeSession();
      session[key] = clamp(Number.parseInt(element.value || min, 10), min, max);
      element.value = session[key];
      if (session.worldBook && key === 'worldBookScanDepth') session.worldBook.scan_depth = session[key];
      if (session.worldBook && key === 'worldBookTokenBudget') session.worldBook.token_budget = session[key];
      touchSession(session);
      persistSoon();
      renderWorldBookPanel();
      renderStats();
    };
    els.worldBookScanDepthInput.addEventListener('input', () => updateWorldBookNumber('worldBookScanDepth', els.worldBookScanDepthInput, 1, 40));
    els.worldBookMaxEntriesInput.addEventListener('input', () => updateWorldBookNumber('worldBookMaxEntries', els.worldBookMaxEntriesInput, 1, 50));
    els.worldBookTokenBudgetInput.addEventListener('input', () => updateWorldBookNumber('worldBookTokenBudget', els.worldBookTokenBudgetInput, 64, 100000));
    els.worldBookRecursiveInput.addEventListener('change', () => {
      const session = activeSession();
      session.worldBookRecursive = els.worldBookRecursiveInput.checked;
      if (session.worldBook) session.worldBook.recursive_scanning = session.worldBookRecursive;
      touchSession(session);
      persistSoon();
      renderWorldBookPanel();
    });
    els.applyWorldBookEditBtn.addEventListener('click', applyWorldBookEditor);
    els.worldBookTestInput.addEventListener('input', renderWorldBookTest);
    els.formatToolsBtn.addEventListener('click', () => validateToolsJson({ silent: false, format: true }));
    els.clearHistoryBtn.addEventListener('click', clearCurrentHistory);
    els.truncateHistoryBtn.addEventListener('click', truncateCurrentHistory);
    els.exportJsonBtn.addEventListener('click', () => exportCurrentSession('json'));
    els.exportMarkdownBtn.addEventListener('click', () => exportCurrentSession('md'));
    els.exportTxtBtn.addEventListener('click', () => exportCurrentSession('txt'));
  }

  function bindResourceLibraryEvents() {
    els.jailbreakLibrarySearch.addEventListener('input', renderJailbreakLibrary);
    els.jailbreakLibrarySelect.addEventListener('change', onJailbreakLibrarySelect);
    els.applyJailbreakPresetBtn.addEventListener('click', applySelectedJailbreakPreset);
    els.saveJailbreakPresetBtn.addEventListener('click', saveCurrentJailbreakPresetToLibrary);
    els.newJailbreakPresetBtn.addEventListener('click', newBlankJailbreakPreset);
    els.copyJailbreakPresetBtn.addEventListener('click', copySelectedJailbreakPreset);
    els.setDefaultJailbreakBtn.addEventListener('click', setSelectedJailbreakDefault);
    els.deleteJailbreakPresetBtn.addEventListener('click', deleteSelectedJailbreakPreset);
    els.exportJailbreakPresetBtn.addEventListener('click', exportSelectedJailbreakPreset);
    els.jailbreakLibraryImportInput.addEventListener('change', importJailbreakLibraryJson);

    els.characterLibrarySearch.addEventListener('input', renderCharacterLibrary);
    els.characterLibrarySelect.addEventListener('change', renderCharacterLibrarySelectionMeta);
    els.applyCharacterCardBtn.addEventListener('click', applySelectedCharacterCard);
    els.saveCharacterCardBtn.addEventListener('click', saveCurrentCharacterCardToLibrary);
    els.syncCharacterCardBtn.addEventListener('click', syncCurrentCharacterFromLibrary);
    els.deleteCharacterCardBtn.addEventListener('click', deleteSelectedCharacterCard);
    els.exportCharacterCardBtn.addEventListener('click', exportSelectedCharacterCard);
    els.characterManagerSearch.addEventListener('input', () => {
      state.ui.characterManagerSearch = els.characterManagerSearch.value;
      state.ui.characterManagerVisibleCount = 48;
      renderCharacterManager();
    });
    els.characterManagerSort.addEventListener('change', () => {
      state.ui.characterManagerSort = els.characterManagerSort.value;
      state.ui.characterManagerVisibleCount = 48;
      renderCharacterManager();
    });
    els.characterManagerImportInput.addEventListener('change', importCharacterCardToManager);
    els.exportCharacterLibraryBtn.addEventListener('click', exportCharacterLibrary);
    els.newCharacterCardBtn.addEventListener('click', newCharacterCardFromManager);
    els.cancelCharacterManagerEditorBtn.addEventListener('click', closeCharacterManagerEditor);
    els.saveCharacterManagerEditorBtn.addEventListener('click', saveCharacterManagerEditor);
    els.characterManagerList.addEventListener('click', onCharacterManagerListClick);

    els.worldBookLibrarySearch.addEventListener('input', renderWorldBookLibrary);
    els.worldBookLibrarySelect.addEventListener('change', applySelectedWorldBookForEditing);
    els.activeWorldBookSelect.addEventListener('change', updateActiveWorldBookSelection);
    els.applyWorldBookFromLibraryBtn.addEventListener('click', applySelectedWorldBookFromLibrary);
    els.saveWorldBookBtn.addEventListener('click', saveCurrentWorldBookToLibrary);
    els.newWorldBookBtn.addEventListener('click', newBlankWorldBook);
    els.deleteWorldBookBtn.addEventListener('click', deleteSelectedWorldBook);
    els.exportWorldBookBtn.addEventListener('click', exportSelectedWorldBook);
  }

  function bindFormattingEvents() {
    const simpleToggles = [
      ['chatDisplayModeInput', 'chatDisplayMode', 'value'],
      ['showTagsInput', 'showTagsInResponses', 'checked'],
      ['autoFixMarkdownInput', 'autoFixMarkdown', 'checked'],
      ['showReasoningBlocksInput', 'showReasoningBlocks', 'checked'],
      ['allowScopedRegexInput', 'allowScopedRegex', 'checked'],
    ];
    for (const [elementKey, settingKey, mode] of simpleToggles) {
      if (!els[elementKey]) continue;
      els[elementKey].addEventListener('input', () => {
        updateFormattingSetting(settingKey, mode === 'checked' ? els[elementKey].checked : els[elementKey].value);
      });
    }

    els.reasoningTemplateSelect?.addEventListener('change', () => {
      state.ui.selectedReasoningTemplateId = els.reasoningTemplateSelect.value;
      renderReasoningTemplateEditor();
    });
    els.newReasoningTemplateBtn?.addEventListener('click', newReasoningTemplate);
    els.saveReasoningTemplateBtn?.addEventListener('click', saveReasoningTemplate);
    els.deleteReasoningTemplateBtn?.addEventListener('click', deleteReasoningTemplate);

    els.regexScriptSelect?.addEventListener('change', () => {
      state.ui.selectedRegexScriptId = els.regexScriptSelect.value;
      renderRegexScriptEditor();
      renderRegexTest();
    });
    els.newRegexScriptBtn?.addEventListener('click', newRegexScript);
    els.copyRegexScriptBtn?.addEventListener('click', copyRegexScript);
    els.saveRegexScriptBtn?.addEventListener('click', saveRegexScript);
    els.deleteRegexScriptBtn?.addEventListener('click', deleteRegexScript);
    els.moveRegexUpBtn?.addEventListener('click', () => moveRegexScript(-1));
    els.moveRegexDownBtn?.addEventListener('click', () => moveRegexScript(1));
    els.exportRegexScriptsBtn?.addEventListener('click', exportRegexScripts);
    els.importRegexScriptsInput?.addEventListener('change', importRegexScripts);

    for (const key of [
      'regexScriptNameInput', 'regexFindInput', 'regexReplaceInput', 'regexTrimInput',
      'regexPlacementUserInput', 'regexPlacementAiInput', 'regexPlacementWorldInput', 'regexPlacementReasoningInput',
      'regexMarkdownOnlyInput', 'regexPromptOnlyInput', 'regexDisabledInput', 'regexRunOnEditInput',
      'regexSubstituteInput', 'regexMinDepthInput', 'regexMaxDepthInput',
      'regexTestPlacementInput', 'regexTestModeInput', 'regexTestInput',
    ]) {
      els[key]?.addEventListener('input', renderRegexTest);
      els[key]?.addEventListener('change', renderRegexTest);
    }
  }

  function renderFormattingPanel() {
    renderReasoningTemplateList();
    renderRegexScriptList();
    renderRegexTest();
  }

  function renderReasoningTemplateList() {
    if (!els.reasoningTemplateSelect) return;
    const formatting = normalizeFormattingSettings(state.settings.formatting || {});
    if (!formatting.reasoningTemplates.length) {
      formatting.reasoningTemplates = [];
    }
    if (!state.ui.selectedReasoningTemplateId || !formatting.reasoningTemplates.some((tpl) => tpl.id === state.ui.selectedReasoningTemplateId)) {
      state.ui.selectedReasoningTemplateId = formatting.reasoningTemplates[0]?.id || '';
    }
    els.reasoningTemplateSelect.innerHTML = formatting.reasoningTemplates.length
      ? formatting.reasoningTemplates.map((tpl) => `<option value="${escapeHtml(tpl.id)}">${tpl.enabled ? '●' : '○'} ${escapeHtml(tpl.name)}</option>`).join('')
      : '<option value="">暂无模板</option>';
    els.reasoningTemplateSelect.value = state.ui.selectedReasoningTemplateId;
    renderReasoningTemplateEditor();
  }

  function renderReasoningTemplateEditor() {
    const formatting = normalizeFormattingSettings(state.settings.formatting || {});
    const tpl = formatting.reasoningTemplates.find((item) => item.id === state.ui.selectedReasoningTemplateId) || formatting.reasoningTemplates[0] || null;
    if (els.reasoningTemplateEnabledInput) els.reasoningTemplateEnabledInput.checked = tpl?.enabled !== false;
    if (els.reasoningTemplateNameInput) els.reasoningTemplateNameInput.value = tpl?.name || '';
    if (els.reasoningTemplateOpenInput) els.reasoningTemplateOpenInput.value = tpl?.regex?.open || '';
    if (els.reasoningTemplateCloseInput) els.reasoningTemplateCloseInput.value = tpl?.regex?.close || '';
  }

  function newReasoningTemplate() {
    const formatting = normalizeFormattingSettings(state.settings.formatting || {});
    const tpl = normalizeReasoningTemplate({
      id: uid('rt'),
      name: '自定义 Reasoning',
      regex: { open: '<think\\b[^>]*>', close: '</think>' },
      enabled: true,
    });
    formatting.reasoningTemplates.push(tpl);
    state.settings.formatting = formatting;
    state.ui.selectedReasoningTemplateId = tpl.id;
    persistSoon();
    renderFormattingPanel();
  }

  function saveReasoningTemplate() {
    const formatting = normalizeFormattingSettings(state.settings.formatting || {});
    const tpl = normalizeReasoningTemplate({
      id: state.ui.selectedReasoningTemplateId || uid('rt'),
      name: els.reasoningTemplateNameInput?.value || '未命名模板',
      regex: {
        open: els.reasoningTemplateOpenInput?.value || '',
        close: els.reasoningTemplateCloseInput?.value || '',
      },
      enabled: els.reasoningTemplateEnabledInput?.checked !== false,
    });
    const index = formatting.reasoningTemplates.findIndex((item) => item.id === tpl.id);
    if (index >= 0) formatting.reasoningTemplates[index] = tpl;
    else formatting.reasoningTemplates.push(tpl);
    state.settings.formatting = normalizeFormattingSettings(formatting);
    state.ui.selectedReasoningTemplateId = tpl.id;
    persistSoon();
    renderFormattingPanel();
    renderMessages();
    toast('Reasoning 模板已保存。', 'success');
  }

  function deleteReasoningTemplate() {
    const formatting = normalizeFormattingSettings(state.settings.formatting || {});
    const id = state.ui.selectedReasoningTemplateId;
    if (!id) return;
    if (!confirm('确定删除这个 Reasoning 模板吗？')) return;
    formatting.reasoningTemplates = formatting.reasoningTemplates.filter((tpl) => tpl.id !== id);
    state.ui.selectedReasoningTemplateId = formatting.reasoningTemplates[0]?.id || '';
    state.settings.formatting = normalizeFormattingSettings(formatting);
    persistSoon();
    renderFormattingPanel();
    renderMessages();
  }

  function renderRegexScriptList() {
    if (!els.regexScriptSelect) return;
    const formatting = normalizeFormattingSettings(state.settings.formatting || {});
    if (!state.ui.selectedRegexScriptId || !formatting.regexScripts.some((script) => script.id === state.ui.selectedRegexScriptId)) {
      state.ui.selectedRegexScriptId = formatting.regexScripts[0]?.id || '';
    }
    els.regexScriptSelect.innerHTML = formatting.regexScripts.length
      ? formatting.regexScripts.map((script, index) => {
        const scope = script.markdownOnly && script.promptOnly ? '双侧临时' : script.markdownOnly ? '仅显示' : script.promptOnly ? '仅Prompt' : '持久化';
        return `<option value="${escapeHtml(script.id)}">${index + 1}. ${script.disabled ? '○' : '●'} ${escapeHtml(script.scriptName)} · ${scope}</option>`;
      }).join('')
      : '<option value="">暂无脚本</option>';
    els.regexScriptSelect.value = state.ui.selectedRegexScriptId;
    renderRegexScriptEditor();
  }

  function currentRegexScript() {
    const formatting = normalizeFormattingSettings(state.settings.formatting || {});
    return formatting.regexScripts.find((script) => script.id === state.ui.selectedRegexScriptId) || formatting.regexScripts[0] || null;
  }

  function renderRegexScriptEditor() {
    const script = currentRegexScript();
    const placements = new Set(script?.placement || [REGEX_PLACEMENTS.AI_OUTPUT]);
    if (els.regexScriptNameInput) els.regexScriptNameInput.value = script?.scriptName || '';
    if (els.regexFindInput) els.regexFindInput.value = script?.findRegex || '';
    if (els.regexReplaceInput) els.regexReplaceInput.value = script?.replaceString || '';
    if (els.regexTrimInput) els.regexTrimInput.value = (script?.trimStrings || []).join('\n');
    if (els.regexPlacementUserInput) els.regexPlacementUserInput.checked = placements.has(REGEX_PLACEMENTS.USER_INPUT);
    if (els.regexPlacementAiInput) els.regexPlacementAiInput.checked = placements.has(REGEX_PLACEMENTS.AI_OUTPUT);
    if (els.regexPlacementWorldInput) els.regexPlacementWorldInput.checked = placements.has(REGEX_PLACEMENTS.WORLD_INFO);
    if (els.regexPlacementReasoningInput) els.regexPlacementReasoningInput.checked = placements.has(REGEX_PLACEMENTS.REASONING);
    if (els.regexMarkdownOnlyInput) els.regexMarkdownOnlyInput.checked = Boolean(script?.markdownOnly);
    if (els.regexPromptOnlyInput) els.regexPromptOnlyInput.checked = Boolean(script?.promptOnly);
    if (els.regexDisabledInput) els.regexDisabledInput.checked = Boolean(script?.disabled);
    if (els.regexRunOnEditInput) els.regexRunOnEditInput.checked = script?.runOnEdit !== false;
    if (els.regexSubstituteInput) els.regexSubstituteInput.value = script?.substituteRegex || 'none';
    if (els.regexMinDepthInput) els.regexMinDepthInput.value = script?.minDepth ?? '';
    if (els.regexMaxDepthInput) els.regexMaxDepthInput.value = script?.maxDepth ?? '';
  }

  function collectRegexScriptFromEditor({ id = state.ui.selectedRegexScriptId || uid('rx') } = {}) {
    const placement = [];
    if (els.regexPlacementUserInput?.checked) placement.push(REGEX_PLACEMENTS.USER_INPUT);
    if (els.regexPlacementAiInput?.checked) placement.push(REGEX_PLACEMENTS.AI_OUTPUT);
    if (els.regexPlacementWorldInput?.checked) placement.push(REGEX_PLACEMENTS.WORLD_INFO);
    if (els.regexPlacementReasoningInput?.checked) placement.push(REGEX_PLACEMENTS.REASONING);
    return normalizeRegexScript({
      id,
      scriptName: els.regexScriptNameInput?.value || '未命名 Regex',
      findRegex: els.regexFindInput?.value || '',
      replaceString: els.regexReplaceInput?.value || '',
      trimStrings: String(els.regexTrimInput?.value || '').split(/\r?\n/).filter(Boolean),
      placement: placement.length ? placement : [REGEX_PLACEMENTS.AI_OUTPUT],
      markdownOnly: Boolean(els.regexMarkdownOnlyInput?.checked),
      promptOnly: Boolean(els.regexPromptOnlyInput?.checked),
      disabled: Boolean(els.regexDisabledInput?.checked),
      runOnEdit: els.regexRunOnEditInput?.checked !== false,
      substituteRegex: els.regexSubstituteInput?.value || 'none',
      minDepth: els.regexMinDepthInput?.value || '',
      maxDepth: els.regexMaxDepthInput?.value || '',
    });
  }

  function newRegexScript() {
    const formatting = normalizeFormattingSettings(state.settings.formatting || {});
    const script = normalizeRegexScript({
      id: uid('rx'),
      scriptName: '新 Regex 脚本',
      findRegex: '',
      replaceString: '',
      placement: [REGEX_PLACEMENTS.AI_OUTPUT],
      markdownOnly: true,
      promptOnly: false,
    });
    formatting.regexScripts.push(script);
    state.settings.formatting = formatting;
    state.ui.selectedRegexScriptId = script.id;
    persistSoon();
    renderFormattingPanel();
  }

  function copyRegexScript() {
    const current = currentRegexScript();
    if (!current) return newRegexScript();
    const formatting = normalizeFormattingSettings(state.settings.formatting || {});
    const copy = normalizeRegexScript({ ...current, id: uid('rx'), scriptName: `${current.scriptName} 副本` });
    formatting.regexScripts.push(copy);
    state.settings.formatting = formatting;
    state.ui.selectedRegexScriptId = copy.id;
    persistSoon();
    renderFormattingPanel();
  }

  function saveRegexScript() {
    const formatting = normalizeFormattingSettings(state.settings.formatting || {});
    const script = collectRegexScriptFromEditor();
    const index = formatting.regexScripts.findIndex((item) => item.id === script.id);
    if (index >= 0) formatting.regexScripts[index] = script;
    else formatting.regexScripts.push(script);
    state.settings.formatting = normalizeFormattingSettings(formatting);
    state.ui.selectedRegexScriptId = script.id;
    persistSoon();
    renderFormattingPanel();
    renderMessages();
    toast('Regex 脚本已保存。', 'success');
  }

  function deleteRegexScript() {
    const formatting = normalizeFormattingSettings(state.settings.formatting || {});
    const id = state.ui.selectedRegexScriptId;
    if (!id) return;
    if (!confirm('确定删除这个 Regex 脚本吗？')) return;
    formatting.regexScripts = formatting.regexScripts.filter((script) => script.id !== id);
    state.ui.selectedRegexScriptId = formatting.regexScripts[0]?.id || '';
    state.settings.formatting = normalizeFormattingSettings(formatting);
    persistSoon();
    renderFormattingPanel();
    renderMessages();
  }

  function moveRegexScript(delta) {
    const formatting = normalizeFormattingSettings(state.settings.formatting || {});
    const index = formatting.regexScripts.findIndex((script) => script.id === state.ui.selectedRegexScriptId);
    if (index < 0) return;
    const next = clamp(index + delta, 0, formatting.regexScripts.length - 1);
    if (next === index) return;
    const [script] = formatting.regexScripts.splice(index, 1);
    formatting.regexScripts.splice(next, 0, script);
    state.settings.formatting = normalizeFormattingSettings(formatting);
    persistSoon();
    renderFormattingPanel();
    renderMessages();
  }

  function exportRegexScripts() {
    const formatting = normalizeFormattingSettings(state.settings.formatting || {});
    download(`regex-scripts-${dateSlug()}.json`, JSON.stringify(formatting.regexScripts, null, 2), 'application/json');
  }

  async function importRegexScripts(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const scripts = Array.isArray(data) ? data : Array.isArray(data.regexScripts) ? data.regexScripts : [];
      if (!scripts.length) throw new Error('文件中没有 regexScripts 数组。');
      const formatting = normalizeFormattingSettings(state.settings.formatting || {});
      formatting.regexScripts.push(...scripts.map((script, index) => normalizeRegexScript({ ...script, id: script.id || uid(`rx${index}`) })));
      state.settings.formatting = normalizeFormattingSettings(formatting);
      state.ui.selectedRegexScriptId = formatting.regexScripts.at(-1)?.id || '';
      persistSoon();
      renderFormattingPanel();
      renderMessages();
      toast(`已导入 ${scripts.length} 条 Regex 脚本。`, 'success');
    } catch (error) {
      toast(`Regex 导入失败：${error.message}`, 'error');
    }
  }

  function renderRegexTest() {
    if (!els.regexTestResult) return;
    const testText = String(els.regexTestInput?.value || '');
    const script = collectRegexScriptFromEditor({ id: 'test_regex' });
    const formatting = normalizeFormattingSettings({
      ...state.settings.formatting,
      regexScripts: [script],
    });
    try {
      const result = applyRegexScripts(testText, formatting.regexScripts, {
        placement: els.regexTestPlacementInput?.value || REGEX_PLACEMENTS.AI_OUTPUT,
        mode: els.regexTestModeInput?.value || 'display',
        context: getFormattingContext({ input: testText }),
        depth: 0,
      });
      els.regexTestResult.value = replaceMacros(result, getFormattingContext({ input: testText }));
    } catch (error) {
      els.regexTestResult.value = `正则执行失败：${error.message}`;
    }
  }

  function bindCharacterFieldEditor(elementKey, fieldKey) {
    const element = els[elementKey];
    if (!element) return;
    element.addEventListener('input', () => {
      const session = activeSession();
      if (!session?.characterCard) return;
      applyCharacterFieldEdit(session.characterCard, fieldKey, element.value);
      touchSession(session);
      persistSoon();
      renderCharacterPanel({ keepFields: true });
      renderStats();
    });
  }

  function bindFimEvents() {
    els.openFimBtn.addEventListener('click', () => {
      updateSetting('fimEnabled', true);
      els.fimPanel.classList.remove('hidden');
    });
    els.closeFimBtn.addEventListener('click', () => {
      updateSetting('fimEnabled', false);
      els.fimPanel.classList.add('hidden');
    });
    els.runFimBtn.addEventListener('click', runFimCompletion);
    els.copyFimBtn.addEventListener('click', () => copyText(els.fimResult.value, '已复制 FIM 补全结果'));
  }

  function bindKeyboardShortcuts() {
    window.addEventListener('keydown', (event) => {
      const mod = event.ctrlKey || event.metaKey;
      if (event.key === 'Escape') {
        if (state.ui.userProfileOpen) toggleUserProfile(false);
        if (state.ui.characterManagerOpen) toggleCharacterManager(false);
        toggleSettings(false);
        if (els.shortcutDialog.open) els.shortcutDialog.close();
        return;
      }
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === 'n') {
        event.preventDefault();
        newSession();
      } else if (key === 's' && event.shiftKey) {
        event.preventDefault();
        toggleSidebar();
      } else if (key === 'k') {
        event.preventDefault();
        toggleSidebar(false);
        els.sessionSearch.focus();
        els.sessionSearch.select();
      } else if (event.key === '.') {
        event.preventDefault();
        if (generating) stopGeneration();
      } else if (key === 'c' && event.shiftKey) {
        event.preventDefault();
        copyLastAssistant();
      } else if (event.key === '/') {
        event.preventDefault();
        els.shortcutDialog.showModal();
      }
    });
  }

  function syncSettingsToInputs() {
    const s = state.settings;
    els.apiKeyInput.value = s.apiKey;
    els.apiKeyInput.disabled = serverApiKeyConfigured;
    els.apiKeyInput.placeholder = serverApiKeyConfigured ? '已使用服务器环境变量 DEEPSEEK_API_KEY' : 'sk-…';
    els.baseUrlInput.value = s.baseUrl;
    els.betaBaseUrlInput.value = s.betaBaseUrl;
    els.useProxyInput.checked = s.useProxy;
    els.useProxyInput.disabled = serverApiKeyConfigured;
    els.modelSelect.value = s.model;
    els.modelSettingSelect.value = s.model;
    els.temperatureInput.value = s.temperature;
    els.temperatureValue.textContent = Number(s.temperature).toFixed(1);
    els.topPInput.value = s.topP;
    els.topPValue.textContent = Number(s.topP).toFixed(2);
    els.maxTokensInput.value = s.maxTokens;
    els.responseLengthInput.value = s.responseLength;
    els.customLengthInput.value = s.customLength;
    els.customLengthLabel.classList.toggle('hidden', s.responseLength !== 'custom');
    els.presencePenaltyInput.value = s.presencePenalty;
    els.frequencyPenaltyInput.value = s.frequencyPenalty;
    els.stopInput.value = s.stop;
    els.thinkingInput.checked = s.thinking;
    els.reasoningEffortInput.value = s.reasoningEffort;
    els.jsonModeInput.checked = s.jsonMode;
    els.prefixEnabledInput.checked = s.prefixEnabled;
    els.assistantPrefix.value = s.assistantPrefix;
    els.fimEnabledInput.checked = s.fimEnabled;
    els.toolsEnabledInput.checked = s.toolsEnabled;
    els.toolsJsonInput.value = s.toolsJson;
    els.themeInput.value = s.theme;
    els.fontScaleInput.value = s.fontScale;
    els.fontScaleValue.textContent = `${Math.round(Number(s.fontScale) * 100)}%`;
    els.timestampsInput.checked = s.showTimestamps;
    els.lineNumbersInput.checked = s.lineNumbers;
    const formatting = getFormattingSettings();
    if (els.chatDisplayModeInput) els.chatDisplayModeInput.value = formatting.chatDisplayMode;
    if (els.showTagsInput) els.showTagsInput.checked = Boolean(formatting.showTagsInResponses);
    if (els.autoFixMarkdownInput) els.autoFixMarkdownInput.checked = Boolean(formatting.autoFixMarkdown);
    if (els.showReasoningBlocksInput) els.showReasoningBlocksInput.checked = Boolean(formatting.showReasoningBlocks);
    if (els.allowScopedRegexInput) els.allowScopedRegexInput.checked = Boolean(formatting.allowScopedRegex);
    els.modelNote.textContent = MODEL_NOTES[s.model] || '';
    els.thinkingQuickBtn.setAttribute('aria-pressed', String(s.thinking));
    els.thinkingQuickBtn.textContent = `思考：${s.thinking ? '开' : '关'}`;
    els.jsonQuickBtn.setAttribute('aria-pressed', String(s.jsonMode));
    els.jsonQuickBtn.textContent = `JSON：${s.jsonMode ? '开' : '关'}`;
    els.prefixBox.classList.toggle('hidden', !s.prefixEnabled);
    els.fimPanel.classList.toggle('hidden', !s.fimEnabled);
    document.documentElement.style.setProperty('--font-scale', String(s.fontScale));
    applyChatDisplayMode();
    renderFormattingPanel();
    renderUserProfileDrawer();
    renderJailbreakPanel();
    renderWorldBookPanel();
  }

  function updateSetting(key, value) {
    if (serverApiKeyConfigured && key === 'apiKey') {
      state.settings.apiKey = '';
      syncSettingsToInputs();
      return;
    }
    if (serverApiKeyConfigured && key === 'useProxy') {
      state.settings.useProxy = true;
      syncSettingsToInputs();
      toast('服务器已配置 DEEPSEEK_API_KEY，已固定使用服务端代理。');
      return;
    }
    if (key === 'temperature') value = clamp(Number(value), 0, 2);
    if (key === 'topP') value = clamp(Number(value), 0, 1);
    if (key === 'maxTokens') value = clamp(Number.parseInt(value || 1, 10), 1, 32768);
    if (key === 'fontScale') value = clamp(Number(value), 0.88, 1.22);
    state.settings[key] = value;
    if (key === 'model') {
      els.modelSelect.value = value;
      els.modelSettingSelect.value = value;
    }
    if (key === 'thinking' && value && state.settings.fimEnabled) {
      state.settings.fimEnabled = false;
      toast('Thinking Mode 下 FIM 不可用，已关闭 FIM 面板。');
    }
    if (key === 'responseLength') {
      els.customLengthLabel?.classList.toggle('hidden', value !== 'custom');
    }
    if (key === 'theme') applyTheme();
    if (key === 'fontScale') document.documentElement.style.setProperty('--font-scale', String(value));
    syncSettingsToInputs();
    persistSoon();
    if (['jsonMode', 'lineNumbers', 'showTimestamps'].includes(key)) renderMessages();
  }

  function getFormattingSettings(session = activeSession()) {
    const base = normalizeFormattingSettings(state.settings.formatting || {});
    return {
      ...base,
      regexScripts: getRuntimeRegexScripts(session, base),
    };
  }

  function getRuntimeRegexScripts(session = activeSession(), baseFormatting = normalizeFormattingSettings(state.settings.formatting || {})) {
    const scripts = [...(baseFormatting.regexScripts || [])];
    const presetScripts = session?.jailbreakSettings?.regexScripts || session?.jailbreakSettings?.regex_scripts || [];
    if (Array.isArray(presetScripts)) {
      scripts.push(...presetScripts.map((script, index) => ({ ...script, scope: 'preset', id: script.id || `preset_regex_${index}` })));
    }
    const scopedScripts = session?.characterCard?.extensions?.regex_scripts || session?.characterCard?.extensions?.regexScripts || [];
    if (baseFormatting.allowScopedRegex && Array.isArray(scopedScripts)) {
      scripts.push(...scopedScripts.map((script, index) => ({ ...script, scope: 'scoped', id: script.id || `scoped_regex_${index}` })));
    }
    return scripts.map((script, index) => normalizeRegexScript(script, index));
  }

  function updateFormattingSetting(key, value) {
    const formatting = normalizeFormattingSettings(state.settings.formatting || {});
    formatting[key] = value;
    state.settings.formatting = normalizeFormattingSettings(formatting);
    if (key === 'chatDisplayMode') applyChatDisplayMode();
    syncSettingsToInputs();
    persistSoon();
    if (['chatDisplayMode', 'showTagsInResponses', 'autoFixMarkdown', 'showReasoningBlocks', 'allowScopedRegex'].includes(key)) renderMessages();
  }

  function applyChatDisplayMode() {
    if (!els.app) return;
    const mode = getFormattingSettings().chatDisplayMode || 'default';
    els.app.classList.toggle('chat-display-default', mode === 'default');
    els.app.classList.toggle('chat-display-bubbles', mode === 'bubbles');
    els.app.classList.toggle('chat-display-document', mode === 'document');
  }

  function getEffectiveTheme() {
    const theme = state.settings?.theme || DEFAULT_SETTINGS.theme;
    if (theme === 'system') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    return theme;
  }

  function applyTheme() {
    const effective = getEffectiveTheme();
    document.documentElement.dataset.theme = effective;
    if (window.mermaid) {
      try { window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: effective === 'dark' ? 'dark' : 'neutral' }); } catch (_) {}
    }
  }

  function cycleTheme() {
    const order = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(state.settings.theme) + 1) % order.length];
    updateSetting('theme', next);
    toast(`主题：${next === 'system' ? '跟随系统' : next === 'dark' ? '深色' : '浅色'}`);
  }

  function renderAll() {
    syncUiChrome();
    renderSessions();
    renderPromptTemplates();
    renderPromptLibrary();
    renderResourceLibraries();
    renderUserProfileDrawer();
    renderCharacterManager();
    renderMessages();
    renderStats();
    updateComposerState();
  }

  function syncUiChrome() {
    els.app.classList.toggle('sidebar-collapsed', state.ui.sidebarCollapsed);
    els.app.classList.toggle('settings-open', state.ui.settingsOpen);
    els.app.classList.toggle('user-profile-open', state.ui.userProfileOpen);
    els.app.classList.toggle('character-manager-open', state.ui.characterManagerOpen);
    els.settingsDrawer.setAttribute('aria-hidden', String(!state.ui.settingsOpen));
    els.userProfileDrawer?.setAttribute('aria-hidden', String(!state.ui.userProfileOpen));
    els.characterManagerDrawer?.setAttribute('aria-hidden', String(!state.ui.characterManagerOpen));
    els.openSidebarBtn.title = state.ui.sidebarCollapsed ? '打开会话侧边栏' : '会话侧边栏已打开';
    els.openSidebarBtn.setAttribute('aria-expanded', String(!state.ui.sidebarCollapsed));
    els.userProfileBtn?.setAttribute('aria-expanded', String(state.ui.userProfileOpen));
    els.characterManagerBtn?.setAttribute('aria-expanded', String(state.ui.characterManagerOpen));
    applyChatDisplayMode();
    renderSettingsPage();
    updatePersonaTopButton();
  }

  function applyResponsiveUiDefaults() {
    if (window.innerWidth <= 820) {
      if (!state.ui.mobileInitialized) {
        state.ui.sidebarCollapsed = true;
        state.ui.mobileInitialized = true;
      }
    } else {
      state.ui.mobileInitialized = false;
    }
    syncUiChrome();
  }

  function toggleSidebar(forceCollapsed) {
    state.ui.sidebarCollapsed = typeof forceCollapsed === 'boolean' ? forceCollapsed : !state.ui.sidebarCollapsed;
    if (state.ui.sidebarCollapsed) state.ui.openSessionMenuId = null;
    syncUiChrome();
  }

  function toggleSettings(open, page = state.ui.settingsPage || 'model') {
    state.ui.settingsOpen = Boolean(open);
    if (state.ui.settingsOpen) {
      state.ui.userProfileOpen = false;
      state.ui.characterManagerOpen = false;
      state.ui.editingCharacterCardId = '';
    }
    if (state.ui.settingsOpen && window.innerWidth <= 820) state.ui.sidebarCollapsed = true;
    if (state.ui.settingsOpen) setSettingsPage(page, { silentChrome: true });
    if (!state.ui.settingsOpen) state.ui.characterPanelOpen = false;
    syncUiChrome();
  }

  function toggleCharacterManager(open) {
    state.ui.characterManagerOpen = Boolean(open);
    if (state.ui.characterManagerOpen) {
      state.ui.settingsOpen = false;
      state.ui.userProfileOpen = false;
      state.ui.characterPanelOpen = false;
      state.ui.openSessionMenuId = null;
      if (window.innerWidth <= 820) state.ui.sidebarCollapsed = true;
      renderCharacterManager();
      setTimeout(() => els.characterManagerSearch?.focus({ preventScroll: true }), 80);
    } else {
      state.ui.editingCharacterCardId = '';
    }
    syncUiChrome();
  }

  function toggleUserProfile(open) {
    state.ui.userProfileOpen = Boolean(open);
    if (state.ui.userProfileOpen) {
      state.ui.settingsOpen = false;
      state.ui.characterManagerOpen = false;
      state.ui.editingCharacterCardId = '';
      state.ui.characterPanelOpen = false;
      if (window.innerWidth <= 820) state.ui.sidebarCollapsed = true;
      renderUserProfileDrawer();
      setTimeout(() => els.userProfileNameInput?.focus({ preventScroll: true }), 80);
    }
    syncUiChrome();
  }

  function setSettingsPage(page, { silentChrome = false } = {}) {
    if (page === 'character') page = 'model';
    state.ui.settingsPage = page || 'model';
    state.ui.characterPanelOpen = state.ui.settingsPage === 'character';
    renderSettingsPage();
    if (!silentChrome) updatePersonaTopButton();
  }

  function renderSettingsPage() {
    if (!els.settingsDrawer) return;
    const page = state.ui.settingsPage || 'model';
    for (const details of els.settingsDrawer.querySelectorAll('.settings-scroll > details[data-settings-page]')) {
      const active = details.dataset.settingsPage === page;
      details.classList.toggle('active-page', active);
      details.open = true;
    }
    for (const button of els.settingsPagesNav?.querySelectorAll('[data-settings-page]') || []) {
      button.classList.toggle('active', button.dataset.settingsPage === page);
    }
    const labels = {
      api: 'API Key、Base URL 与本地代理',
      model: '模型、采样参数和目标回复长度',
      output: 'Thinking、JSON、Prefix/FIM 与消息渲染管线',
      prompt: 'System Prompt 与 Prompt 库',
      preset: '外部破限词/预设，独立于 System Prompt',
      worldbook: '世界书关键词触发和条目注入',
      tools: '函数调用和工具定义',
      ui: '主题、字体和显示偏好',
      data: '上下文统计、本地存储与导入导出',
    };
    if (els.settingsPageHint) els.settingsPageHint.textContent = labels[page] || '每类设置独立页面';
  }

  function toggleCharacterSettingsPanel() {
    if (state.ui.settingsOpen && state.ui.characterPanelOpen) {
      toggleSettings(false);
      return;
    }
    state.ui.settingsOpen = true;
    state.ui.userProfileOpen = false;
    state.ui.characterManagerOpen = false;
    state.ui.editingCharacterCardId = '';
    setSettingsPage('character', { silentChrome: true });
    syncUiChrome();
    setTimeout(() => {
      els.userNameInput?.focus({ preventScroll: true });
    }, 80);
  }

  function updatePersonaTopButton() {
    const session = activeSession();
    const profile = ensureUserProfile(session);
    const hasIdentity = Boolean(String(session?.userName || session?.userPersona || Object.values(profile).join(' ')).trim());
    els.userProfileBtn?.classList.toggle('active', state.ui.userProfileOpen || hasIdentity);
    els.userProfileBtn?.setAttribute('title', hasIdentity ? '用户角色设定：已填写' : '用户角色设定');
  }

  function renderUserProfileDrawer() {
    if (!els.userProfileDrawer) return;
    const session = activeSession();
    if (!session) return;
    const profile = ensureUserProfile(session);
    const set = (key, value = '') => {
      if (els[key] && document.activeElement !== els[key]) els[key].value = value || '';
    };
    set('userProfileNameInput', session.userName);
    set('userProfilePersonaInput', session.userPersona);
    set('userProfilePronounsInput', profile.pronouns);
    set('userProfileAgeInput', profile.age);
    set('userProfileOccupationInput', profile.occupation);
    set('userProfileBackgroundInput', profile.background);
    set('userProfileGoalsInput', profile.goals);
    set('userProfileLanguageInput', profile.language);
    set('userProfileToneInput', profile.tone);
    set('userProfileBoundariesInput', profile.boundaries);
    set('userProfileCustomFieldsInput', profile.customFields);
    updateUserProfileSaveState();
  }

  function saveUserProfileFromDrawer({ toastOnSave = false, auto = false } = {}) {
    const session = activeSession();
    if (!session || !els.userProfileDrawer) return;
    const profile = ensureUserProfile(session);
    session.userName = els.userProfileNameInput?.value || '';
    session.userPersona = els.userProfilePersonaInput?.value || '';
    profile.pronouns = els.userProfilePronounsInput?.value || '';
    profile.age = els.userProfileAgeInput?.value || '';
    profile.occupation = els.userProfileOccupationInput?.value || '';
    profile.background = els.userProfileBackgroundInput?.value || '';
    profile.goals = els.userProfileGoalsInput?.value || '';
    profile.language = els.userProfileLanguageInput?.value || '';
    profile.tone = els.userProfileToneInput?.value || '';
    profile.boundaries = els.userProfileBoundariesInput?.value || '';
    profile.customFields = els.userProfileCustomFieldsInput?.value || '';
    touchSession(session);
    state.ui.userProfileDirty = !toastOnSave;
    persistSoon();
    syncUserProfileMirrorInputs();
    updatePersonaTopButton();
    renderStats();
    updateUserProfileSaveState(auto ? '自动保存完成' : toastOnSave ? '已保存' : '正在自动保存…');
    if (toastOnSave) toast(auto ? '用户设定已自动保存。' : '用户设定已保存。', 'success');
  }

  function syncUserProfileMirrorInputs() {
    const session = activeSession();
    if (!session) return;
    if (els.userNameInput && document.activeElement !== els.userNameInput) els.userNameInput.value = session.userName || '';
    if (els.userPersonaInput && document.activeElement !== els.userPersonaInput) els.userPersonaInput.value = session.userPersona || '';
  }

  function updateUserProfileSaveState(text = '') {
    if (!els.userProfileSaveState) return;
    els.userProfileSaveState.textContent = text || (state.ui.userProfileDirty ? '有未提示的自动保存' : '自动保存已启用');
  }

  function resetUserProfileDrawer() {
    if (!confirm('确定清空当前会话的用户角色设定吗？')) return;
    const session = activeSession();
    if (!session) return;
    session.userName = '';
    session.userPersona = '';
    session.userProfile = defaultUserProfile();
    touchSession(session);
    state.ui.userProfileDirty = false;
    persistSoon();
    renderUserProfileDrawer();
    syncUserProfileMirrorInputs();
    updatePersonaTopButton();
    renderStats();
    toast('用户设定已清空。', 'success');
  }

  function newSession() {
    if (generating) stopGeneration();
    const previous = activeSession();
    const session = createSession('新会话');
    if (previous) {
      session.userName = previous.userName || '';
      session.userPersona = previous.userPersona || '';
      session.userProfile = structuredCloneSafe(ensureUserProfile(previous));
    }
    state.sessions.unshift(session);
    state.activeSessionId = session.id;
    rememberLocalActiveSession();
    state.ui.selectedSessions.clear();
    els.messageInput.value = '';
    syncSettingsToInputs();
    persistSoon();
    renderAll();
    setTimeout(() => els.messageInput.focus(), 0);
  }

  function renderSessions() {
    const search = (state.ui.search || '').toLowerCase();
    const sessions = state.sessions
      .filter((session) => !search || session.title.toLowerCase().includes(search) || session.messages.some((msg) => String(msg.content || '').toLowerCase().includes(search)))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.updatedAt) - new Date(a.updatedAt));

    const groups = groupSessions(sessions);
    const html = Object.entries(groups).map(([group, items]) => {
      if (!items.length) return '';
      return `<div class="session-group-title">${group}</div>${items.map(sessionToHtml).join('')}`;
    }).join('') || '<p class="muted" style="padding: 12px;">未找到匹配会话</p>';

    els.sessionList.innerHTML = html;
    els.selectAllBtn.classList.toggle('hidden', !state.ui.batchMode);
    els.deleteSelectedBtn.classList.toggle('hidden', !state.ui.batchMode);
    els.batchModeBtn.textContent = state.ui.batchMode ? '取消多选' : '多选';
    if (state.ui.batchMode) state.ui.openSessionMenuId = null;
  }

  function groupSessions(sessions) {
    const groups = { 置顶: [], 今天: [], 昨天: [], 近7天: [], 更早: [] };
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    const startYesterday = new Date(startToday);
    startYesterday.setDate(startYesterday.getDate() - 1);
    const start7 = new Date(startToday);
    start7.setDate(start7.getDate() - 7);

    for (const session of sessions) {
      if (session.pinned) {
        groups['置顶'].push(session);
        continue;
      }
      const updated = new Date(session.updatedAt);
      if (updated >= startToday) groups['今天'].push(session);
      else if (updated >= startYesterday) groups['昨天'].push(session);
      else if (updated >= start7) groups['近7天'].push(session);
      else groups['更早'].push(session);
    }
    if (!groups['置顶'].length) delete groups['置顶'];
    return groups;
  }

  function sessionToHtml(session) {
    const active = session.id === state.activeSessionId;
    const selected = state.ui.selectedSessions.has(session.id);
    const menuOpen = state.ui.openSessionMenuId === session.id;
    const preview = session.messages.findLast?.((m) => m.role === 'user')?.content || session.messages.at(-1)?.content || '暂无消息';
    return `
      <div class="session-item ${active ? 'active' : ''} ${session.pinned ? 'pinned' : ''}" data-session-id="${session.id}" title="${escapeHtml(session.title)}" role="listitem" tabindex="0" aria-current="${active ? 'page' : 'false'}">
        ${state.ui.batchMode ? `<input type="checkbox" data-action="select" ${selected ? 'checked' : ''} aria-label="选择会话" />` : `<span class="pin" aria-hidden="true">${session.pinned ? '◆' : '◇'}</span>`}
        <span class="session-main"><span class="session-title">${escapeHtml(session.title)}</span><span class="session-preview">${escapeHtml(preview).slice(0, 120)}</span></span>
        ${state.ui.batchMode ? '' : `
          <span class="session-menu-wrap">
            <button class="session-more" type="button" data-action="more" aria-label="会话更多操作" aria-haspopup="menu" aria-expanded="${menuOpen ? 'true' : 'false'}">⋯</button>
            <span class="session-menu ${menuOpen ? 'open' : ''}" role="menu">
              <button type="button" data-action="pin" role="menuitem">${session.pinned ? '取消置顶' : '置顶会话'}</button>
              <button type="button" data-action="rename" role="menuitem">重命名</button>
              <button type="button" data-action="delete" role="menuitem" class="danger-text">删除</button>
            </span>
          </span>`}
      </div>`;
  }

  function onSessionListClick(event) {
    const item = event.target.closest('.session-item');
    if (!item) return;
    const id = item.dataset.sessionId;
    const session = state.sessions.find((s) => s.id === id);
    if (!session) return;
    const actionEl = event.target.closest('[data-action]');
    const action = actionEl?.dataset.action;

    if (action === 'select') {
      event.stopPropagation();
      if (actionEl.checked) state.ui.selectedSessions.add(id);
      else state.ui.selectedSessions.delete(id);
      renderSessions();
      return;
    }
    if (action === 'more') {
      event.stopPropagation();
      state.ui.openSessionMenuId = state.ui.openSessionMenuId === id ? null : id;
      renderSessions();
      return;
    }
    if (action === 'pin') {
      event.stopPropagation();
      session.pinned = !session.pinned;
      state.ui.openSessionMenuId = null;
      touchSession(session);
      persistSoon();
      renderSessions();
      return;
    }
    if (action === 'rename') {
      event.stopPropagation();
      state.ui.openSessionMenuId = null;
      renderSessions();
      const next = prompt('输入新的会话标题', session.title);
      if (next && next.trim()) {
        session.title = next.trim();
        touchSession(session);
        persistSoon();
        renderAll();
      }
      return;
    }
    if (action === 'delete') {
      event.stopPropagation();
      state.ui.openSessionMenuId = null;
      renderSessions();
      deleteSession(id);
      return;
    }
    if (state.ui.batchMode) {
      if (state.ui.selectedSessions.has(id)) state.ui.selectedSessions.delete(id);
      else state.ui.selectedSessions.add(id);
      renderSessions();
      return;
    }
    state.ui.openSessionMenuId = null;
    switchSession(id);
  }

  function onSessionListKeydown(event) {
    if (event.target.closest('button,input')) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const item = event.target.closest('.session-item');
    if (!item) return;
    event.preventDefault();
    if (state.ui.batchMode) {
      if (state.ui.selectedSessions.has(item.dataset.sessionId)) state.ui.selectedSessions.delete(item.dataset.sessionId);
      else state.ui.selectedSessions.add(item.dataset.sessionId);
      renderSessions();
      return;
    }
    switchSession(item.dataset.sessionId);
  }

  async function switchSession(id) {
    if (generating) stopGeneration();
    state.activeSessionId = id;
    rememberLocalActiveSession();
    state.ui.sidebarCollapsed = window.innerWidth <= 820;
    const session = state.sessions.find((item) => item.id === id);
    const needsLoad = session && (!Array.isArray(session.messages) || (session.messages.length === 0 && Number(session.messageCount || 0) > 0));
    if (needsLoad) {
      updateSharedSyncStatus('syncing', '正在加载会话消息…');
      try {
        const loaded = await loadConversationPersistedState(id);
        const index = state.sessions.findIndex((item) => item.id === id);
        if (index >= 0) {
          state.sessions[index] = { ...state.sessions[index], ...loaded };
          migrateSession(state.sessions[index]);
        }
      } catch (error) {
        console.warn('Failed to load conversation', error);
        toast(`会话加载失败：${error.message}`, 'error');
      }
    }
    persistSoon();
    syncSettingsToInputs();
    renderAll();
  }

  function deleteSession(id) {
    const session = state.sessions.find((s) => s.id === id);
    if (!session) return;
    if (!confirm(`确定删除会话「${session.title}」吗？`)) return;
    state.sessions = state.sessions.filter((s) => s.id !== id);
    if (!state.sessions.length) state.sessions.push(createSession('新会话'));
    if (state.activeSessionId === id) state.activeSessionId = state.sessions[0].id;
    rememberLocalActiveSession();
    state.ui.selectedSessions.delete(id);
    persistSoon();
    renderAll();
  }

  function toggleBatchMode() {
    state.ui.batchMode = !state.ui.batchMode;
    state.ui.selectedSessions.clear();
    state.ui.openSessionMenuId = null;
    renderSessions();
  }

  function selectAllVisibleSessions() {
    const ids = [...els.sessionList.querySelectorAll('.session-item')].map((item) => item.dataset.sessionId);
    const allSelected = ids.every((id) => state.ui.selectedSessions.has(id));
    for (const id of ids) {
      if (allSelected) state.ui.selectedSessions.delete(id);
      else state.ui.selectedSessions.add(id);
    }
    renderSessions();
  }

  function deleteSelectedSessions() {
    const count = state.ui.selectedSessions.size;
    if (!count) return;
    if (!confirm(`确定删除选中的 ${count} 个会话吗？`)) return;
    state.sessions = state.sessions.filter((session) => !state.ui.selectedSessions.has(session.id));
    if (!state.sessions.length) state.sessions.push(createSession('新会话'));
    if (!state.sessions.some((session) => session.id === state.activeSessionId)) state.activeSessionId = state.sessions[0].id;
    rememberLocalActiveSession();
    state.ui.selectedSessions.clear();
    state.ui.batchMode = false;
    persistSoon();
    renderAll();
  }

  function renderMessages(options = {}) {
    const session = activeSession();
    if (!session) return;
    const streamingRender = Boolean(options.streaming && activeStreamingMessageId);
    els.messages.classList.toggle('streaming-render', streamingRender);
    els.activeTitle.textContent = session.title;
    els.systemPromptInput.value = session.systemPrompt || '';
    els.userNameInput.value = session.userName || '';
    els.userPersonaInput.value = session.userPersona || '';
    els.rpModeInput.checked = Boolean(session.rpMode);
    els.rpPerspectiveInput.value = session.rpPerspective || 'second';
    els.rpSuggestionsInput.checked = session.rpSuggestions !== false;
    els.rpMemoryInput.value = session.rpMemory || '';
    els.backgroundInput.value = session.background || '';
    els.backgroundEnabledInput.checked = session.backgroundEnabled !== false;
    els.characterEnabledInput.checked = session.characterCardEnabled !== false;
    renderCharacterPanel();
    renderWorldBookPanel();

    const shouldStick = isNearBottom() && !userScrolledAway;
    els.emptyState.classList.toggle('hidden', session.messages.length > 0);

    const messages = getWindowedMessages(session.messages);
    const fragment = document.createDocumentFragment();
    if (messages.omitted > 0) {
      const note = document.createElement('div');
      note.className = 'message assistant';
      note.innerHTML = `<div class="avatar">…</div><div class="bubble-wrap"><div class="bubble"><div class="message-body muted">为提升性能，当前仅渲染最近 ${messages.items.length} 条消息；前 ${messages.omitted} 条仍保存在会话和导出中。</div></div></div>`;
      fragment.appendChild(note);
    }
    for (const message of messages.items) fragment.appendChild(createMessageElement(message));

    els.messages.innerHTML = '';
    els.messages.appendChild(fragment);
    enhanceRenderedContent(els.messages, { streaming: streamingRender });
    renderStats();
    if (shouldStick || activeStreamingMessageId) scrollToBottom(false);
    updateBackLatestButton();
  }

  function scheduleRenderMessages() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = 0;
      requestAnimationFrame(() => renderMessages({ streaming: true }));
    }, STREAM_RENDER_INTERVAL);
  }

  function getWindowedMessages(messages) {
    const limit = 180;
    if (messages.length <= limit) return { items: messages, omitted: 0 };
    return { items: messages.slice(-limit), omitted: messages.length - limit };
  }

  function createMessageElement(message) {
    const view = getMessageView(message);
    const display = getDisplayMessageParts(message, view);
    const wrapper = document.createElement('article');
    wrapper.className = `message ${view.role}`;
    wrapper.dataset.messageId = message.id;

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = getAvatarText(view);
    wrapper.appendChild(avatar);

    const bubbleWrap = document.createElement('div');
    bubbleWrap.className = 'bubble-wrap';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    bubble.appendChild(createMessageMeta(message, view));

    if (display.reasoning && view.role === 'assistant' && getFormattingSettings().showReasoningBlocks) {
      bubble.appendChild(createReasoningPanel(display.reasoning, { streaming: view.isStreaming }));
    } else if (shouldShowThinkingIndicator(view)) {
      bubble.appendChild(createThinkingPanel(view));
    }
    if (view.role === 'assistant' && view.toolCalls?.length) {
      bubble.appendChild(createToolCallsPanel(view.toolCalls));
    }

    const body = document.createElement('div');
    body.className = 'message-body';
    const shouldCollapse = shouldCollapseMessage(display.content || '');
    if (shouldCollapse && !message.expanded) body.classList.add('collapsed');

    if (message.editing && view.role === 'user') {
      body.appendChild(createEditBox(message));
    } else if (view.role === 'tool') {
      body.innerHTML = `<pre class="json-tree">${escapeHtml(formatMaybeJson(view.content))}</pre>`;
    } else if (view.role === 'assistant' && !view.isStreaming && !String(display.content || '').trim() && (view.emptyReasoningOnly || String(display.reasoning || view.reasoning_content || '').trim())) {
      body.classList.add('empty-assistant-body');
      body.textContent = getMissingAssistantContentHint(view);
    } else {
      renderMarkdownInto(body, display.content || '', {
        jsonPreferred: view.role === 'assistant' && state.settings.jsonMode && !view.isStreaming,
        streaming: Boolean(view.isStreaming),
      });
    }
    bubble.appendChild(body);

    if (view.role === 'assistant' && view.suggestions?.length) {
      bubble.appendChild(createSuggestionsPanel(message.id, view.suggestions));
    }

    if (shouldCollapse) {
      const expand = document.createElement('button');
      expand.className = 'expand-btn';
      expand.dataset.action = 'expand';
      expand.dataset.id = message.id;
      expand.textContent = message.expanded ? '收起长消息' : '展开全文';
      bubble.appendChild(expand);
    }

    if (view.usage || estimateTokens(view.content) > 0) {
      bubble.appendChild(createUsageDetails(view));
    }

    bubbleWrap.appendChild(bubble);
    wrapper.appendChild(bubbleWrap);
    return wrapper;
  }

  function shouldShowThinkingIndicator(view) {
    if (view.role !== 'assistant' || !view.isStreaming) return false;
    // While DeepSeek is still producing reasoning_content and no user-visible
    // answer has arrived yet, show only a compact status. Never render the
    // reasoning text itself in the UI.
    return !String(view.content || '').trim();
  }

  function getDisplayMessageParts(message, view = getMessageView(message)) {
    const placement = getRegexPlacementForRole(view.role);
    if (!placement) return { content: view.content || '', reasoning: view.reasoning_content || view.extra?.reasoning || '' };
    return formatMessageForDisplay(view.content || '', getFormattingContext({ message, view }), getFormattingSettings(), {
      placement,
      streaming: Boolean(view.isStreaming),
      depth: getMessageDepth(message),
      existingReasoning: view.reasoning_content || view.extra?.reasoning || '',
      reasoningSignature: view.extra?.reasoning_signature || '',
    });
  }

  function getRegexPlacementForRole(role) {
    if (role === 'user') return REGEX_PLACEMENTS.USER_INPUT;
    if (role === 'assistant') return REGEX_PLACEMENTS.AI_OUTPUT;
    return '';
  }

  function getMissingAssistantContentHint(view) {
    if (view.finishReason === 'length') {
      return '（本次 API 在输出正文前就达到 max_tokens 上限，只收到了内部思考内容。可以提高 max_tokens、降低思考等级或重新生成。）';
    }
    return '（本次 API 只返回了内部思考内容，未返回可显示的正文。可以尝试重新生成。）';
  }

  function createMessageMeta(message, view) {
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const left = document.createElement('span');
    const roleLabel = getRoleLabel(view);
    const time = state.settings.showTimestamps ? ` · ${formatTime(view.createdAt || message.createdAt)}` : '';
    left.innerHTML = `${roleLabel}${time}${versionNavHtml(message)}`;
    const actions = document.createElement('span');
    actions.className = 'message-actions';
    actions.innerHTML = messageActionsHtml(view.role, message.id);
    meta.append(left, actions);
    return meta;
  }

  function getRoleLabel(view) {
    if (view.role === 'user') return escapeHtml(getSessionUserName() || '你');
    if (view.role === 'tool') return `工具：${escapeHtml(view.name || '')}`;
    const session = activeSession();
    const characterName = view.characterName || (session?.characterCardEnabled !== false ? session?.characterCard?.name : '');
    if (characterName) return escapeHtml(characterName);
    return escapeHtml(view.model || state.settings.model || 'DeepSeek');
  }

  function getAvatarText(view) {
    if (view.role === 'user') return (getSessionUserName() || '你').slice(0, 2);
    if (view.role === 'tool') return '⌘';
    const session = activeSession();
    const characterName = view.characterName || (session?.characterCardEnabled !== false ? session?.characterCard?.name : '');
    return (characterName || 'AI').slice(0, 2);
  }

  function messageActionsHtml(role, id) {
    const base = `<button data-action="copy" data-id="${id}">复制</button><button data-action="delete" data-id="${id}">删除</button>`;
    if (role === 'user') return `<button data-action="edit" data-id="${id}">编辑后重发</button>${base}`;
    if (role === 'assistant') return `<button data-action="regenerate" data-id="${id}">重新生成</button>${base}`;
    return base;
  }

  function versionNavHtml(message) {
    if (message.role !== 'assistant' || !message.versions?.length) return '';
    const index = message.activeVersion || 0;
    const total = message.versions.length;
    if (total <= 1) return '';
    return `<span class="version-nav"><button data-action="version-prev" data-id="${message.id}" title="上一个版本">‹</button><span>${index + 1}/${total}</span><button data-action="version-next" data-id="${message.id}" title="下一个版本">›</button></span>`;
  }

  function createThinkingPanel(view) {
    const panel = document.createElement('div');
    panel.className = 'thinking-panel thinking-panel--indicator';
    panel.setAttribute('aria-live', 'polite');
    panel.innerHTML = '<span class="spinner"></span><span>正在思考中…</span>';
    return panel;
  }

  function createReasoningPanel(reasoning, { streaming = false } = {}) {
    const details = document.createElement('details');
    details.className = `thinking-panel reasoning-panel${streaming ? ' reasoning-panel--streaming' : ''}`;
    details.open = Boolean(streaming);
    const summary = document.createElement('summary');
    summary.innerHTML = `${streaming ? '<span class="spinner"></span>' : '<span class="reasoning-dot"></span>'}<span>${streaming ? 'Reasoning 实时解析' : 'Reasoning / 思维块'}</span>`;
    const pre = document.createElement('pre');
    pre.textContent = reasoning || '';
    details.append(summary, pre);
    return details;
  }

  function createToolCallsPanel(toolCalls) {
    const container = document.createElement('div');
    container.className = 'tool-calls';
    container.innerHTML = toolCalls.map((call, index) => {
      const status = call.status || 'pending';
      const name = call.function?.name || call.name || `tool_${index + 1}`;
      const args = call.function?.arguments || call.arguments || '';
      return `<details class="tool-card" ${status === 'executing' || status === 'failed' ? 'open' : ''}>
        <summary><span>正在调用工具：<strong>${escapeHtml(name)}</strong></span><span class="status-pill ${status}">${toolStatusLabel(status)}</span></summary>
        <pre>输入参数:\n${escapeHtml(formatMaybeJson(args))}\n\n结果:\n${escapeHtml(formatMaybeJson(call.result || '等待执行…'))}</pre>
      </details>`;
    }).join('');
    return container;
  }

  function createSuggestionsPanel(messageId, suggestions) {
    const panel = document.createElement('div');
    panel.className = 'suggestions-panel';
    panel.innerHTML = `<div class="suggestions-title">下一步行动</div>${suggestions.map((suggestion, index) => `
      <button type="button" data-action="choose-suggestion" data-id="${messageId}" data-suggestion-index="${index}">
        ${escapeHtml(suggestion)}
      </button>`).join('')}`;
    return panel;
  }

  function toolStatusLabel(status) {
    return { pending: '等待中', executing: '执行中', succeeded: '成功', failed: '失败' }[status] || status;
  }

  function createEditBox(message) {
    const box = document.createElement('div');
    box.className = 'edit-box';
    box.innerHTML = `<textarea rows="5">${escapeHtml(message.content || '')}</textarea><div class="panel-actions"><button class="primary small" data-action="save-edit" data-id="${message.id}">确认重发</button><button class="ghost small" data-action="cancel-edit" data-id="${message.id}">取消</button></div>`;
    return box;
  }

  function createUsageDetails(view) {
    const usage = view.usage || {};
    const prompt = usage.prompt_tokens ?? (view.role === 'user' ? estimateTokens(view.content || '') : 0);
    const completion = usage.completion_tokens ?? (view.role === 'assistant' ? estimateTokens(view.content || '') : 0);
    const hit = usage.prompt_cache_hit_tokens ?? 0;
    const miss = usage.prompt_cache_miss_tokens ?? 0;

    const parts = [];
    if (view.role === 'user') {
      parts.push(`约 ${formatCount(prompt)} tokens`);
    } else {
      if (prompt) parts.push(`输入 ${formatCount(prompt)}`);
      parts.push(`输出 ${formatCount(completion)}`);
      if (hit || miss) parts.push(`缓存 ${formatCount(hit)}/${formatCount(miss)} 命中/未命中`);
    }

    const line = document.createElement('div');
    line.className = 'usage-line';
    line.textContent = parts.join(' · ');
    return line;
  }

  function formatCount(value) {
    return Number(value || 0).toLocaleString();
  }

  function shouldCollapseMessage(content) {
    return false;
  }

  function getMessageView(message) {
    let view = message;
    if (message.role === 'assistant' && message.versions?.length) {
      const version = message.versions[message.activeVersion || 0] || message.versions.at(-1);
      view = { ...message, ...version, role: 'assistant' };
    }
    return normalizeAssistantView(view);
  }

  function syncActiveVersion(message) {
    if (message.role !== 'assistant' || !message.versions?.length) return;
    const index = message.activeVersion || 0;
    message.versions[index] = snapshotAssistant(message);
  }

  function snapshotAssistant(message) {
    ensureAssistantExtra(message);
    return compactAssistantSnapshot({
      content: message.content || '',
      extra: structuredCloneSafe(message.extra || {}),
      reasoning_content: message.reasoning_content || '',
      suggestions: structuredCloneSafe(message.suggestions || []),
      characterName: message.characterName || '',
      toolCalls: structuredCloneSafe(message.toolCalls || []),
      usage: structuredCloneSafe(message.usage || null),
      createdAt: message.createdAt || nowISO(),
      durationMs: message.durationMs || 0,
      finishReason: message.finishReason || null,
      model: message.model || state.settings.model,
      error: message.error || '',
      emptyReasoningOnly: Boolean(message.emptyReasoningOnly),
    });
  }

  function renderMarkdownInto(container, content, { jsonPreferred = false, streaming = false } = {}) {
    const raw = String(content || '');
    if (jsonPreferred && raw.trim()) {
      const jsonNode = renderJsonOutput(raw);
      if (jsonNode) {
        container.innerHTML = '';
        container.appendChild(jsonNode);
        return;
      }
    }

    const formatting = getFormattingSettings();
    let html = renderMarkdownToHtml(raw, {
      showTagsInResponses: formatting.showTagsInResponses,
    });
    html = sanitizeFormattedHtml(html, {
      showTagsInResponses: formatting.showTagsInResponses,
    });
    container.innerHTML = `<div class="markdown">${html}</div>`;
    highlightDialogueQuotesInElement(container.querySelector('.markdown'));

    for (const link of container.querySelectorAll('a[href]')) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    if (streaming) {
      const cursor = document.createElement('span');
      cursor.className = 'cursor';
      cursor.textContent = '▌';
      container.querySelector('.markdown')?.appendChild(cursor);
    }
  }

  function renderJsonOutput(raw) {
    const text = raw.replace(/<span class="cursor">▌<\/span>$/, '').trim();
    if (!text || !/^[\[{]/.test(text)) return null;
    const wrapper = document.createElement('div');
    try {
      const parsed = JSON.parse(text);
      wrapper.className = 'json-tree';
      wrapper.innerHTML = `<button class="ghost small json-copy" type="button">复制格式化 JSON</button>${jsonTreeHtml(parsed)}`;
      wrapper.querySelector('.json-copy').addEventListener('click', () => copyText(JSON.stringify(parsed, null, 2), '已复制格式化 JSON'));
    } catch (error) {
      wrapper.className = 'json-tree json-error';
      wrapper.textContent = `JSON 尚不合法或已被截断：${error.message}\n\n${text}`;
    }
    return wrapper;
  }

  function jsonTreeHtml(value, key = 'root') {
    if (value === null || typeof value !== 'object') return `<span>${escapeHtml(JSON.stringify(value))}</span>`;
    const isArray = Array.isArray(value);
    const entries = Object.entries(value);
    return `<details open><summary>${escapeHtml(key)} ${isArray ? `[${entries.length}]` : `{${entries.length}}`}</summary><div class="json-children">${entries.map(([k, v]) => `<div><span class="json-key">${escapeHtml(k)}: </span>${jsonTreeHtml(v, k)}</div>`).join('')}</div></details>`;
  }

  function enhanceRenderedContent(root, { streaming = false } = {}) {
    if (streaming) return;
    enhanceCodeBlocks(root);
    renderMath(root);
    renderMermaid(root);
  }

  function enhanceCodeBlocks(root) {
    const codeBlocks = root.querySelectorAll('.markdown pre > code');
    for (const code of codeBlocks) {
      const pre = code.parentElement;
      if (!pre || pre.closest('.code-shell')) continue;
      const className = [...code.classList].find((cls) => cls.startsWith('language-')) || '';
      const language = className.replace('language-', '') || 'text';
      if (language.toLowerCase() === 'mermaid') continue;
      try {
        if (window.hljs && language !== 'text') window.hljs.highlightElement(code);
      } catch (_) {}
      if (state.settings.lineNumbers) addLineNumbers(code);
      const shell = document.createElement('div');
      shell.className = 'code-shell';
      const lineCount = code.textContent.split('\n').length;
      if (lineCount > 80) shell.classList.add('code-collapsed');
      const toolbar = document.createElement('div');
      toolbar.className = 'code-toolbar';
      toolbar.innerHTML = `<span>${escapeHtml(language)}</span><span><button type="button" data-code-copy>复制</button>${lineCount > 80 ? '<button type="button" data-code-toggle>展开</button>' : ''}</span>`;
      pre.replaceWith(shell);
      shell.append(toolbar, pre);
      toolbar.querySelector('[data-code-copy]').addEventListener('click', (event) => {
        copyText(code.textContent, '代码已复制 ✓');
        event.currentTarget.textContent = '已复制 ✓';
        setTimeout(() => { event.currentTarget.textContent = '复制'; }, 1200);
      });
      toolbar.querySelector('[data-code-toggle]')?.addEventListener('click', (event) => {
        shell.classList.toggle('code-collapsed');
        event.currentTarget.textContent = shell.classList.contains('code-collapsed') ? '展开' : '折叠';
      });
    }
  }

  function addLineNumbers(code) {
    if (code.classList.contains('code-lines')) return;
    const lines = code.innerHTML.split('\n');
    code.innerHTML = lines.map((line) => `<span class="line">${line || ' '}</span>`).join('\n');
    code.classList.add('code-lines');
  }

  function renderMath(root) {
    if (!window.renderMathInElement) return;
    try {
      window.renderMathInElement(root, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false },
          { left: '\\[', right: '\\]', display: true },
        ],
        throwOnError: false,
      });
    } catch (_) {}
  }

  function renderMermaid(root) {
    const mermaidCodes = root.querySelectorAll('.markdown pre > code.language-mermaid');
    if (!mermaidCodes.length) return;
    for (const code of mermaidCodes) {
      const source = code.textContent;
      const pre = code.parentElement;
      const wrap = document.createElement('div');
      wrap.className = 'mermaid-wrap';
      const inner = document.createElement('div');
      inner.className = 'mermaid';
      inner.textContent = source;
      wrap.appendChild(inner);
      wrap.addEventListener('click', () => openMermaidPreview(wrap.innerHTML));
      pre.replaceWith(wrap);
    }
    if (window.mermaid) {
      try { window.mermaid.run({ nodes: root.querySelectorAll('.mermaid') }); } catch (error) { console.warn('Mermaid render failed', error); }
    }
  }

  function openMermaidPreview(html) {
    const win = window.open('', '_blank', 'noopener,noreferrer,width=1100,height=800');
    if (!win) return;
    win.document.write(`<!doctype html><title>Mermaid 预览</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f7f4;">${html}</body>`);
    win.document.close();
  }

  function onMessagesClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const id = target.dataset.id;
    const session = activeSession();
    const message = session.messages.find((msg) => msg.id === id);
    if (!message) return;

    if (action === 'copy') copyMessage(message);
    else if (action === 'delete') deleteMessage(message);
    else if (action === 'regenerate') regenerateMessage(message);
    else if (action === 'edit') {
      message.editing = true;
      renderMessages();
      setTimeout(() => els.messages.querySelector(`[data-message-id="${id}"] textarea`)?.focus(), 0);
    } else if (action === 'cancel-edit') {
      message.editing = false;
      renderMessages();
    } else if (action === 'save-edit') {
      const textarea = target.closest('.bubble')?.querySelector('textarea');
      saveEditedMessage(message, textarea?.value || '');
    } else if (action === 'expand') {
      message.expanded = !message.expanded;
      renderMessages();
    } else if (action === 'version-prev' || action === 'version-next') {
      switchVersion(message, action === 'version-prev' ? -1 : 1);
    } else if (action === 'choose-suggestion') {
      const view = getMessageView(message);
      const suggestion = view.suggestions?.[Number(target.dataset.suggestionIndex)];
      if (suggestion) submitMessage(suggestion);
    }
  }

  function copyMessage(message) {
    const view = getMessageView(message);
    copyText(view.content || '', '消息已复制');
  }

  function deleteMessage(message) {
    if (!confirm('确定删除这条消息吗？')) return;
    const session = activeSession();
    session.messages = session.messages.filter((msg) => msg.id !== message.id);
    touchSession(session);
    persistSoon();
    renderAll();
  }

  async function regenerateMessage(message) {
    if (generating || message.role !== 'assistant') return;
    const session = activeSession();
    const assistantIndex = session.messages.findIndex((msg) => msg.id === message.id);
    if (assistantIndex < 0) return;
    if (assistantIndex < session.messages.length - 1 && !confirm('重新生成中间回复会删除其后的对话，是否继续？')) return;
    session.messages = session.messages.slice(0, assistantIndex + 1);
    prepareAssistantNewVersion(message);
    await generateAssistant(message.id);
  }

  function prepareAssistantNewVersion(message, initialContent = '') {
    if (!message.versions?.length) {
      message.versions = [snapshotAssistant(message)];
    } else {
      syncActiveVersion(message);
    }
    message.content = initialContent;
    message.reasoning_content = '';
    message.suggestions = [];
    message.extra = {};
    message.toolCalls = [];
    message.usage = null;
    message.error = '';
    message.finishReason = null;
    message.emptyReasoningOnly = false;
    message.createdAt = nowISO();
    message.durationMs = 0;
    message.model = state.settings.model;
    message.versions.push(snapshotAssistant(message));
    message.activeVersion = message.versions.length - 1;
    renderMessages();
  }

  function switchVersion(message, delta) {
    if (!message.versions?.length) return;
    syncActiveVersion(message);
    const total = message.versions.length;
    message.activeVersion = (message.activeVersion + delta + total) % total;
    const version = message.versions[message.activeVersion];
    Object.assign(message, structuredCloneSafe(version), { role: 'assistant', id: message.id, versions: message.versions, activeVersion: message.activeVersion });
    persistSoon();
    renderMessages();
  }

  async function saveEditedMessage(message, text) {
    let content = text.trim();
    if (!content) return toast('消息不能为空', 'error');
    const session = activeSession();
    const index = session.messages.findIndex((msg) => msg.id === message.id);
    if (index < 0) return;
    content = applyPersistentFormatting(content, REGEX_PLACEMENTS.USER_INPUT, { message, view: message, session, runOnEdit: true });
    message.content = content;
    message.editing = false;
    session.messages = session.messages.slice(0, index + 1);
    autoTitleFromFirstUser(session);
    touchSession(session);
    const assistant = createAssistantMessage();
    session.messages.push(assistant);
    persistSoon();
    await persistNow();
    renderAll();
    await generateAssistant(assistant.id);
  }

  function onComposerKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!generating && els.messageInput.value.trim()) submitMessage();
    }
  }

  function autoResizeInput() {
    const input = els.messageInput;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  }

  function updateComposerState() {
    const chars = [...els.messageInput.value].length;
    const tokens = estimateTokens(els.messageInput.value);
    els.charCounter.textContent = `${chars} 字 · 约 ${tokens} tokens`;
    els.sendBtn.disabled = !generating && !els.messageInput.value.trim();
    els.sendBtn.textContent = generating ? '停止' : '发送';
    els.sendBtn.classList.toggle('stop', generating);
  }

  async function submitMessage(text = els.messageInput.value) {
    if (generating) return stopGeneration();
    let content = String(text || '').trim();
    if (!content) return;
    if (!hasUsableApiKey()) {
      toggleSettings(true);
      if (!serverApiKeyConfigured) els.apiKeyInput.focus();
      toast(serverApiKeyConfigured ? '服务器 API Key 未生效，请检查服务端环境变量和代理配置。' : '请先在设置中填写 DeepSeek API Key。', 'error');
      return;
    }
    if (state.settings.toolsEnabled && !validateToolsJson({ silent: false })) return;

    const session = activeSession();
    content = applyPersistentFormatting(content, REGEX_PLACEMENTS.USER_INPUT, {
      session,
      depth: 0,
      input: content,
    });
    const userMessage = {
      id: uid('msg'),
      role: 'user',
      content,
      createdAt: nowISO(),
      usage: { prompt_tokens: estimateTokens(content) },
    };
    session.messages.push(userMessage);
    if (session.messages.filter((msg) => msg.role === 'user').length === 1) autoTitleFromFirstUser(session);

    const initial = state.settings.prefixEnabled ? state.settings.assistantPrefix || '' : '';
    const assistant = createAssistantMessage(initial);
    if (state.settings.prefixEnabled) assistant.prefix = true;
    session.messages.push(assistant);
    touchSession(session);

    els.messageInput.value = '';
    autoResizeInput();
    updateComposerState();
    persistSoon();
    await persistNow();
    renderAll();
    await generateAssistant(assistant.id);
  }

  function createAssistantMessage(content = '') {
    const session = activeSession();
    const characterName = session?.characterCardEnabled !== false ? session?.characterCard?.name || '' : '';
    return {
      id: uid('msg'),
      role: 'assistant',
      content,
      extra: {},
      reasoning_content: '',
      toolCalls: [],
      createdAt: nowISO(),
      model: state.settings.model,
      characterName,
      usage: null,
      durationMs: 0,
    };
  }

  function autoTitleFromFirstUser(session) {
    const firstUser = session.messages.find((msg) => msg.role === 'user');
    if (!firstUser) return;
    const title = firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 36);
    if (title) session.title = title + (firstUser.content.length > 36 ? '…' : '');
  }

  async function generateAssistant(assistantId) {
    const session = activeSession();
    let assistant = session.messages.find((msg) => msg.id === assistantId);
    if (!assistant) return;

    generating = true;
    activeStreamingMessageId = assistant.id;
    abortController = new AbortController();
    updateComposerState();

    let loops = 0;
    try {
      while (assistant && loops < MAX_TOOL_LOOPS) {
        assistant.isStreaming = true;
        assistant.startedAt = Date.now();
        assistant.model = state.settings.model;
        assistant.error = '';
        scheduleRenderMessages();

        const { body, useBeta } = buildChatRequestBody(session, assistant.id);
        const response = await fetchDeepSeek('/chat/completions', body, useBeta ? state.settings.betaBaseUrl : state.settings.baseUrl, abortController.signal);
        const result = await streamChatResponse(response, assistant, {
          onDelta: () => {
            syncAssistantExtraAliases(assistant);
            syncActiveVersion(assistant);
            persistSoon();
            scheduleRenderMessages();
          },
        });
        captureAssistantRawBeforeParse(assistant);
        foldVisibleThinkingIntoAssistant(assistant);
        foldSuggestionsIntoAssistant(assistant);
        finalizeAssistantForStorage(assistant);
        assistant.isStreaming = false;
        assistant.durationMs = Date.now() - assistant.startedAt;
        assistant.finishReason = result.finishReason;
        assistant.usage = result.usage || assistant.usage;
        finalizeAssistantForStorage(assistant);
        syncAssistantExtraAliases(assistant);
        syncActiveVersion(assistant);
        persistSoon();
        renderMessages();

        if (result.finishReason === 'tool_calls' && assistant.toolCalls?.length) {
          const toolMessages = await executeToolCalls(assistant);
          session.messages.push(...toolMessages);
          const nextAssistant = createAssistantMessage();
          session.messages.push(nextAssistant);
          assistant = nextAssistant;
          activeStreamingMessageId = assistant.id;
          loops += 1;
          continue;
        }
        break;
      }
      if (loops >= MAX_TOOL_LOOPS) toast('工具调用轮次已达到上限，已停止继续调用。', 'error');
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      assistant = session.messages.find((msg) => msg.id === activeStreamingMessageId) || assistant;
      if (assistant) {
        captureAssistantRawBeforeParse(assistant);
        foldVisibleThinkingIntoAssistant(assistant);
        finalizeAssistantForStorage(assistant);
        assistant.isStreaming = false;
        assistant.durationMs = assistant.startedAt ? Date.now() - assistant.startedAt : assistant.durationMs;
        assistant.error = aborted ? '用户已停止生成。' : friendlyError(error);
        if (!aborted) assistant.content += `\n\n> ${assistant.error}`;
        syncAssistantExtraAliases(assistant);
        syncActiveVersion(assistant);
      }
      if (!aborted) toast(friendlyError(error), 'error');
      else toast('已停止生成，保留当前已生成内容。');
    } finally {
      generating = false;
      activeStreamingMessageId = null;
      abortController = null;
      for (const msg of session.messages) msg.isStreaming = false;
      touchSession(session);
      persistSoon();
      if (activeSession().id === session.id) renderAll();
      else renderSessions();
    }
  }

  function stopGeneration() {
    if (abortController) abortController.abort();
  }

  function captureAssistantRawBeforeParse(assistant) {
    if (!assistant || assistant.role !== 'assistant') return;
    if (String(assistant.content || '').trim()) assistant.raw_text = assistant.content;
    syncAssistantExtraAliases(assistant);
  }

  function finalizeAssistantForStorage(assistant) {
    if (!assistant || assistant.role !== 'assistant') return assistant;
    if (!assistant.extra || typeof assistant.extra !== 'object') assistant.extra = {};
    if (!assistant.extra.regex_persisted_at && String(assistant.content || '').trim()) {
      assistant.content = applyPersistentFormatting(assistant.content || '', REGEX_PLACEMENTS.AI_OUTPUT, {
        message: assistant,
        view: assistant,
      });
      assistant.extra.regex_persisted_at = nowISO();
    }
    if (!String(assistant.content || '').trim() && String(assistant.reasoning_content || '').trim()) {
      assistant.emptyReasoningOnly = true;
    }
    if (assistant.reasoning_content) assistant.extra.reasoning = assistant.reasoning_content;
    if (assistant.raw_text && assistant.raw_text !== assistant.content) {
      assistant.extra.raw_text = assistant.raw_text;
    }
    delete assistant.raw_text;
    delete assistant.raw_content;
    delete assistant.raw_reasoning_content;
    delete assistant.raw_content_before_parse;
    delete assistant.raw_reasoning_before_parse;
    syncAssistantExtraAliases(assistant);
    return assistant;
  }

  function buildChatRequestBody(session, assistantId) {
    const assistantIndex = session.messages.findIndex((msg) => msg.id === assistantId);
    const currentAssistant = session.messages[assistantIndex];
    const messages = [];
    const system = buildSystemPrompt(getEffectiveSystemPrompt(session), session);
    if (system) messages.push({ role: 'system', content: system });
    const sceneContext = buildSceneContextMessage(session, assistantIndex);
    const jailbreakMessages = buildJailbreakPromptMessages(session, {
      assistantIndex,
      sceneContext,
    });
    if (jailbreakMessages.length) {
      messages.push(...jailbreakMessages);
    } else if (sceneContext) {
      messages.push({ role: 'user', content: sceneContext });
    }

    const staticPromptText = [
      system,
      ...jailbreakMessages.map((message) => message.content || ''),
      jailbreakMessages.length ? '' : sceneContext,
    ].join('\n');
    const historyForApi = trimHistoryForContext(staticPromptText, session.messages.slice(0, assistantIndex));
    for (const historyMessage of historyForApi) {
      const item = toApiMessage(historyMessage);
      if (item) messages.push(item);
    }

    const worldBookAtDepth = buildWorldBookAtDepthPrompt(session, assistantIndex);
    if (worldBookAtDepth) messages.push({ role: 'system', content: worldBookAtDepth });

    const jailbreakPostHistory = buildJailbreakPostHistoryInstructions(session);
    if (jailbreakPostHistory) messages.push({ role: 'system', content: jailbreakPostHistory });

    const postHistoryInstructions = buildCharacterPostHistoryInstructions(session);
    if (postHistoryInstructions) messages.push({ role: 'system', content: postHistoryInstructions });

    const finalContract = buildFinalResponseContract(session, assistantIndex);
    const finalReminder = buildFinalResponseUserReminder(session, assistantIndex);
    if (finalContract && !currentAssistant?.prefix) {
      messages.push({ role: 'system', content: finalContract });
      if (finalReminder) messages.push({ role: 'user', content: finalReminder });
    }

    let useBeta = false;
    if (currentAssistant?.prefix) {
      if (finalContract) messages.push({ role: 'system', content: finalContract });
      if (finalReminder) messages.push({ role: 'user', content: finalReminder });
      messages.push({ role: 'assistant', content: currentAssistant.content || state.settings.assistantPrefix || '', prefix: true });
      useBeta = true;
    }

    const body = {
      model: state.settings.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: resolveRequestMaxTokens(session, assistantIndex),
      thinking: { type: state.settings.thinking ? 'enabled' : 'disabled' },
    };

    if (state.settings.thinking) {
      body.reasoning_effort = state.settings.reasoningEffort || 'high';
    } else {
      body.temperature = state.settings.temperature;
      body.top_p = state.settings.topP;
      body.presence_penalty = state.settings.presencePenalty;
      body.frequency_penalty = state.settings.frequencyPenalty;
    }

    const stop = parseStop(state.settings.stop);
    if (stop.length) body.stop = stop;
    if (state.settings.jsonMode) body.response_format = { type: 'json_object' };

    if (state.settings.toolsEnabled) {
      const tools = parseToolsJson();
      if (tools.length) {
        body.tools = tools;
        body.tool_choice = 'auto';
        if (tools.some((tool) => tool.function?.strict === true)) useBeta = true;
      }
    }
    return { body, useBeta };
  }

  function getEffectiveSystemPrompt(session = activeSession()) {
    const cardPrompt = session?.characterCardEnabled !== false ? String(session?.characterCard?.system_prompt || '').trim() : '';
    return cardPrompt || String(session?.systemPrompt || '');
  }

  function buildCharacterPostHistoryInstructions(session = activeSession()) {
    if (session?.characterCardEnabled === false || !session?.characterCard) return '';
    const text = String(session.characterCard.post_history_instructions || '').trim();
    if (!text) return '';
    return [
      '【角色卡 Post-history Instructions / UJB】',
      resolveCharacterPlaceholders(text, session.characterCard.name || '角色', getSessionUserName(session)),
    ].join('\n');
  }

  function buildJailbreakPostHistoryInstructions(session = activeSession()) {
    if (!session?.jailbreakEnabled) return '';
    const text = String(session.jailbreakPostHistoryInstructions || '').trim();
    if (!text) return '';
    return [
      '【破限库 Post-history Instructions / UJB】',
      resolveCharacterPlaceholders(text, session.characterCard?.name || '角色', getSessionUserName(session)),
    ].join('\n');
  }

  function trimHistoryForContext(systemPrompt, history) {
    const estimated = estimateTokens(systemPrompt) + history.reduce((sum, msg) => {
      const view = getMessageView(msg);
      return sum + estimateTokens(view.content || '');
    }, 0);
    if (estimated < CONTEXT_LIMIT * 0.9) return history;

    // Stateless chat APIs require sending history every time. When a conversation
    // gets close to the advertised 1M context window, keep the system prompt and
    // a recent window. Tool messages are preserved if they fall in that window.
    const trimmed = history.slice(-48);
    if (!state.ui.contextTrimToastShown) {
      state.ui.contextTrimToastShown = true;
      toast('上下文接近 1M 限制，本次请求已自动仅携带最近历史。');
    }
    return trimmed;
  }

  function buildSystemPrompt(prompt, session = activeSession()) {
    let system = prompt.trim();
    if (state.settings.jsonMode) {
      const instruction = '请以合法 JSON 对象输出，不要输出 Markdown 代码围栏或额外解释。';
      system = system ? `${system}\n\n${instruction}` : instruction;
    } else {
      const instruction = [
        '【最终输出约束】',
        '最终回复只能包含玩家可见的自然语言正文；不要用 <scene>、<content>、<details>、<summary>、<foreshadowings>、<outlines>、<logic-optimization>、<intermittent thinking>、<po> 等标签包裹正文。',
        '除非用户本轮明确要求 JSON/结构化字段，否则不要输出 JSON，也不要输出实时总结、当前伏笔、伏笔列表、大纲推测、大纲规划、剧情模块、推进模块、插入模块、间断思考、逻辑优化/逻辑判断、自检报告、变量追踪、角色状态/元数据、状态栏、下一次输出指导、end_output 等幕后模板字段。',
        '严禁在最终正文中输出 <thinking>、</thinking>、<think>、</think>、<intermittent thinking>、</intermittent thinking> 标签或任何显式思维链/创作指导。',
        '如需思考，请只在内部进行；如果 API 返回了 reasoning_content，前端只会显示“正在思考中”的状态，不会展示 reasoning_content 原文。最终 content 只输出直接给用户看的自然语言回答。',
        buildLengthInstruction(session),
      ].join('\n');
      system = system ? `${system}\n\n${instruction}` : instruction;
    }
    return replaceMacros(system, getFormattingContext({ session }));
  }

  const LENGTH_PRESETS = {
    short: { label: '约 100-300 字', minChars: 100, maxChars: 300, paragraphs: '1-3 个自然段' },
    medium: { label: '约 500-900 字', minChars: 500, maxChars: 900, paragraphs: '4-7 个自然段' },
    long: { label: '约 1200-2000 字', minChars: 1200, maxChars: 2000, paragraphs: '8-14 个自然段' },
    very_long: { label: '约 2500-4000 字', minChars: 2500, maxChars: 4000, paragraphs: '12-24 个自然段' },
    rp_auto: { label: '默认 800-1500 字', minChars: 800, maxChars: 1500, paragraphs: '6-10 个自然段' },
    card_auto: { label: '默认 500-1000 字', minChars: 500, maxChars: 1000, paragraphs: '4-8 个自然段' },
  };

  function buildLengthInstruction(session = activeSession()) {
    const policy = getConfiguredLengthPolicy(session);
    if (!policy) return '';
    return [
      `【目标正文字数】${policy.label}。`,
      '统计范围只包括正文，不包括 <suggestions>、Markdown 标记、标题、状态栏或内部思考。',
      policy.paragraphs ? `建议段落：${policy.paragraphs}。` : '',
      'max_tokens 只是生成上限，不代表目标长度；未达到下限前不要结束正文，不要用状态栏、总结或行动选项代替正文。',
      '本应用设置的目标正文字数优先于外部预设/破限词、角色卡、世界书或导入模板里的普通篇幅建议、模板字数上限和旧的输出长度设置。',
      '如果用户当前消息提出了更具体的字数或段落要求，以用户当前消息为准。',
    ].filter(Boolean).join('\n');
  }

  function buildFinalResponseContract(session = activeSession(), assistantIndex = session?.messages?.length || 0) {
    if (state.settings.jsonMode) return '';
    const policy = getEffectiveLengthPolicy(session, assistantIndex);
    const lines = [
      '【本轮最终回复硬性约束】',
      '这是生成前的最后约束，优先级高于角色卡、世界书、外部预设/破限词里的普通篇幅建议、模板字数上限或旧的输出长度设置。',
      '直接输出正文，不要解释你将遵守哪些规则。',
      '禁止输出 <scene>/<content>/<details>/<summary>/<foreshadowings>/<outlines>/<logic-optimization>/<intermittent thinking>/<po> 等包装或幕后规划块；禁止输出“实时总结 / 当前伏笔 / 大纲推测 / 剧情模块 / 间断思考 / 逻辑判断 / 下一次输出指导”等用户不可见的创作过程。',
    ];
    if (policy) {
      lines.push(
        `本轮正文字数要求：${policy.label}。`,
        '这里的“字数”只统计玩家可读正文；不统计 <suggestions>、状态栏、标题、Markdown 标记或内部思考。',
      );
      if (policy.minChars) lines.push(`正文低于约 ${policy.minChars} 字时禁止收尾；必须继续扩写场景、动作、感官、心理、对话或可互动推进。`);
      if (policy.maxChars) lines.push(`不要明显超过约 ${policy.maxChars} 字，除非玩家本轮明确要求更长。`);
      if (policy.paragraphs) lines.push(`建议结构：${policy.paragraphs}，不要只写一两段短回复。`);
      lines.push('若上文导入预设里存在更短的字数范围或更低的上限，不采用那个更短限制；以本条“本轮正文字数要求”为准。');
    }
    lines.push('若需要行动选项，必须放在完整正文之后；空间不足时优先保证正文长度。不要输出状态栏或角色状态元数据。');
    if (state.settings.thinking) {
      lines.push('已开启 Thinking Mode：内部思考必须尽量简短，优先把输出预算留给最终正文，避免只思考不输出正文。');
    }
    return lines.join('\n');
  }

  function buildFinalResponseUserReminder(session = activeSession(), assistantIndex = session?.messages?.length || 0) {
    if (state.settings.jsonMode) return '';
    const policy = getEffectiveLengthPolicy(session, assistantIndex);
    if (!policy) return '';
    const lines = [
      '【应用自动篇幅校验 / 不要回复本条】',
      '请直接回答或续写上一条玩家输入；本条只用于覆盖篇幅设置，不是新的剧情、对话或用户动作。',
      '最终可见回复只写正文，不要追加实时总结、伏笔、大纲、剧情模块、间断思考、逻辑审查或任何 XML/HTML 包装标签。',
      `本轮正文目标：${policy.label}。`,
      '如果上文、角色卡、世界书或导入预设包含更短的篇幅范围、模板字数上限、摘要式输出要求，以本条目标正文字数为准。',
    ];
    if (policy.minChars) lines.push(`正文未达到约 ${policy.minChars} 字前，不要进入结尾、状态栏、行动选项、总结或停止生成。`);
    if (policy.maxChars) lines.push(`达到下限后可以自然收束，但尽量不超过约 ${policy.maxChars} 字，除非上一条玩家输入明确要求更长。`);
    if (policy.paragraphs) lines.push(`建议结构：${policy.paragraphs}。`);
    if (state.settings.thinking) lines.push('内部思考保持简短，把输出预算优先用于最终正文。');
    return lines.join('\n');
  }

  function getConfiguredLengthPolicy(session = activeSession()) {
    const value = state.settings.responseLength || 'auto';
    const custom = String(state.settings.customLength || '').trim();
    if (value === 'custom' && custom) {
      const parsed = parseLengthNumbers(custom);
      return {
        source: 'custom',
        label: custom,
        minChars: parsed.minChars,
        maxChars: parsed.maxChars,
        paragraphs: parsed.paragraphs || '',
      };
    }
    if (value === 'auto' && session?.rpMode) return { source: 'rp_auto', ...LENGTH_PRESETS.rp_auto };
    if (value === 'auto' && session?.characterCardEnabled !== false && session?.characterCard) return { source: 'card_auto', ...LENGTH_PRESETS.card_auto };
    if (LENGTH_PRESETS[value]) return { source: value, ...LENGTH_PRESETS[value] };
    return null;
  }

  function getEffectiveLengthPolicy(session = activeSession(), assistantIndex = session?.messages?.length || 0) {
    const latestUser = getLatestUserMessageBefore(session, assistantIndex);
    const explicit = extractExplicitLengthPolicy(latestUser?.content || '');
    return explicit || getConfiguredLengthPolicy(session);
  }

  function getLatestUserMessageBefore(session, assistantIndex) {
    const end = Math.max(0, Math.min(Number(assistantIndex) || 0, session?.messages?.length || 0));
    for (let index = end - 1; index >= 0; index -= 1) {
      const message = session.messages[index];
      if (message?.role === 'user' && String(message.content || '').trim()) return message;
    }
    return null;
  }

  function extractExplicitLengthPolicy(text) {
    const raw = String(text || '');
    if (!/\d/.test(raw) || !/(字|字符|汉字|词|段|自然段|篇幅|长度|不少于|至少|不低于|不超过|最多|以内|以上|以下)/.test(raw)) return null;
    const parsed = parseLengthNumbers(raw);
    if (!parsed.minChars && !parsed.maxChars && !parsed.paragraphs) return null;
    const snippet = raw
      .split(/\r?\n|[。！？!?]/)
      .map((part) => part.trim())
      .find((part) => /\d/.test(part) && /(字|字符|汉字|词|段|自然段|篇幅|长度|不少于|至少|不低于|不超过|最多|以内|以上|以下)/.test(part))
      || raw.trim().slice(0, 80);
    return {
      source: 'user',
      label: `按玩家本轮要求：${snippet}`,
      minChars: parsed.minChars,
      maxChars: parsed.maxChars,
      paragraphs: parsed.paragraphs || '',
    };
  }

  function parseLengthNumbers(text) {
    const value = String(text || '').replace(/[,，]/g, '');
    const result = { minChars: 0, maxChars: 0, paragraphs: '' };
    const range = value.match(/(\d{2,5})\s*(?:字|汉字|字符)?\s*(?:以上|起)?\s*(?:到|至|-|—|~|～|－)\s*(\d{2,5})\s*(?:字|汉字|字符)?\s*(?:以下|以内)?/);
    const between = value.match(/(\d{2,5})\s*(?:字|汉字|字符)?\s*以上\s*(\d{2,5})\s*(?:字|汉字|字符)?\s*以下/);
    const minOnly = value.match(/(?:不少于|至少|不低于|大于|超过|多于)\s*(\d{2,5})\s*(?:字|汉字|字符)/);
    const maxOnly = value.match(/(?:不超过|最多|至多|少于|小于|低于)\s*(\d{2,5})\s*(?:字|汉字|字符)|(\d{2,5})\s*(?:字|汉字|字符)\s*(?:以内|以下)/);
    const exact = value.match(/(?:约|大约|左右)?\s*(\d{2,5})\s*(?:字|汉字|字符)(?!\s*(?:以上|以下|以内))/);
    const paragraphs = value.match(/(\d{1,2})\s*(?:-|—|~|～|到|至)\s*(\d{1,2})\s*(?:个)?(?:自然段|段)|(?:不少于|至少)\s*(\d{1,2})\s*(?:个)?(?:自然段|段)/);

    const pair = between || range;
    if (pair) {
      const a = Number.parseInt(pair[1], 10);
      const b = Number.parseInt(pair[2], 10);
      result.minChars = Math.min(a, b);
      result.maxChars = Math.max(a, b);
    } else if (minOnly) {
      result.minChars = Number.parseInt(minOnly[1], 10);
    } else if (maxOnly) {
      result.maxChars = Number.parseInt(maxOnly[1] || maxOnly[2], 10);
    } else if (exact) {
      const target = Number.parseInt(exact[1], 10);
      result.minChars = Math.max(1, Math.round(target * 0.9));
      result.maxChars = Math.round(target * 1.15);
    }

    if (paragraphs) {
      result.paragraphs = paragraphs[3]
        ? `至少 ${paragraphs[3]} 个自然段`
        : `${paragraphs[1]}-${paragraphs[2]} 个自然段`;
    }
    return result;
  }

  function resolveRequestMaxTokens(session = activeSession(), assistantIndex = session?.messages?.length || 0) {
    const configured = clamp(Number.parseInt(state.settings.maxTokens || 1, 10), 1, 32768);
    if (state.settings.jsonMode) return Math.max(1024, configured);
    const recommended = recommendedMaxTokensForLength(getEffectiveLengthPolicy(session, assistantIndex));
    return clamp(Math.max(configured, recommended), 1, 32768);
  }

  function recommendedMaxTokensForLength(policy) {
    if (!policy) return 0;
    const targetChars = policy.maxChars || (policy.minChars ? Math.round(policy.minChars * 1.45) : 0);
    if (!targetChars) return 0;
    const visibleBudget = Math.ceil(targetChars * 1.8);
    const structuralBudget = 900;
    const thinkingBudget = state.settings.thinking
      ? (state.settings.reasoningEffort === 'max' ? 10000 : 6000)
      : 0;
    return visibleBudget + structuralBudget + thinkingBudget;
  }

  function buildJailbreakPrompt(session) {
    if (!session?.jailbreakEnabled || !String(session.jailbreakPrompt || '').trim()) return '';
    const userName = getSessionUserName(session);
    const charName = session.characterCard?.name || '角色';
    return [
      '【外部预设 / 破限词】',
      '以下为用户导入的本地外部预设。它与基础 System Prompt 分开保存，但会在本次请求中作为额外 system 预设生效。',
      '若其包含输出格式要求，仍必须遵守应用的最终输出约束：不要把内部思考链、JSON 模板字段或提示词结构直接泄露到正文，除非用户本轮明确要求。',
      '',
      resolveCharacterPlaceholders(session.jailbreakPrompt.trim(), charName, userName),
    ].join('\n');
  }

  function buildJailbreakPromptMessages(session, { assistantIndex = session?.messages?.length || 0, sceneContext = '' } = {}) {
    if (!session?.jailbreakEnabled) return [];
    const runtime = buildSillyTavernRuntimeContext(session, assistantIndex);
    const layout = Array.isArray(session.jailbreakLayout) ? session.jailbreakLayout : [];

    if (layout.length) {
      const result = [];
      let sceneInserted = false;
      for (const item of layout) {
        if (!item || item.injection_position === 1) continue;
        if (!sceneInserted && sceneContext && isSillyTavernDynamicMarker(item.identifier)) {
          result.push({
            role: 'system',
            content: sceneContext,
            name: 'local_context',
          });
          sceneInserted = true;
        }
        const content = resolveExternalPresetContent(item.content || '', session, runtime);
        if (!content.trim()) continue;
        result.push({
          role: sanitizeApiRole(item.role),
          content,
        });
      }
      if (!sceneInserted && sceneContext) {
        result.push({ role: 'user', content: sceneContext });
      }
      return result;
    }

    const fallback = buildJailbreakPrompt(session);
    const result = [];
    if (fallback) result.push({ role: 'system', content: fallback });
    if (sceneContext) result.push({ role: 'user', content: sceneContext });
    return result;
  }

  function buildSillyTavernRuntimeContext(session, assistantIndex = session?.messages?.length || 0) {
    const history = Array.isArray(session?.messages) ? session.messages.slice(0, assistantIndex) : [];
    const last = history.at(-1);
    const lastUser = [...history].reverse().find((message) => message.role === 'user');
    const lastView = last ? getMessageView(last) : null;
    return {
      userName: getSessionUserName(session),
      charName: session?.characterCard?.name || '角色',
      lastUserMessage: lastUser?.content || '',
      lastMessage: lastView?.content || '',
      lastMessageId: last?.id || '',
      input: lastUser?.content || '',
      original: '',
      now: new Date(),
    };
  }

  function resolveExternalPresetContent(content, session, runtime) {
    const charName = session?.characterCard?.name || '角色';
    const userName = getSessionUserName(session);
    return resolveCharacterPlaceholders(
      resolveSillyTavernRuntimeMacros(content, runtime),
      charName,
      userName,
    ).trim();
  }

  function sanitizeApiRole(role) {
    return ['system', 'user', 'assistant', 'tool'].includes(role) ? role : 'system';
  }

  function buildSceneContextMessage(session, assistantIndex = session.messages.length) {
    const parts = [];
    const userName = getSessionUserName(session);
    const userProfilePrompt = buildUserProfilePrompt(session);
    if (userProfilePrompt) parts.push(userProfilePrompt);
    if (session.rpMode) {
      parts.push(buildRoleplayInstruction(session));
    }
    if (String(session.rpMemory || '').trim()) {
      parts.push(`【剧情记忆 / 作者注释】\n${resolveCharacterPlaceholders(session.rpMemory.trim(), session.characterCard?.name || '角色', userName)}`);
    }
    if (session.backgroundEnabled !== false && String(session.background || '').trim()) {
      parts.push(`【预设背景】\n${resolveCharacterPlaceholders(session.background.trim(), session.characterCard?.name || '角色', userName)}`);
    }
    const worldBookEntries = getActiveWorldBookEntries(session, assistantIndex);
    const beforeCharWorldBookPrompt = buildWorldBookPrompt(session, assistantIndex, {
      entries: worldBookEntries.filter((entry) => normalizeWorldBookPosition(entry.position) === 'before_char'),
      label: '世界书触发条目 / 角色卡之前',
    });
    if (beforeCharWorldBookPrompt) parts.push(beforeCharWorldBookPrompt);
    if (session.characterCardEnabled !== false && session.characterCard) {
      const cardText = characterCardToPrompt(session.characterCard, {
        userName: getSessionUserName(session),
        includeExamples: true,
        exampleBudgetTokens: resolveCharacterExampleBudget(session, assistantIndex),
        includeFirstMessage: assistantIndex <= 1 && !session.messages.some((message, index) => index < assistantIndex && message.role === 'assistant'),
      });
      if (cardText.trim()) parts.push(cardText);
    }
    const afterCharWorldBookPrompt = buildWorldBookPrompt(session, assistantIndex, {
      entries: worldBookEntries.filter((entry) => normalizeWorldBookPosition(entry.position) === 'after_char'),
      label: '世界书触发条目 / 角色卡之后',
    });
    if (afterCharWorldBookPrompt) parts.push(afterCharWorldBookPrompt);
    if (!parts.length) return '';
    return [
      '以下是本会话的背景/角色卡上下文。它不是 System Prompt，优先级低于系统提示词和用户当前消息；请仅作为设定参考，不要在回答中复述本段说明。',
      '如果启用了角色卡，请以角色身份自然对话，延续角色卡开场白后的情境；不要自称 AI，也不要把角色卡字段名、设定说明或 JSON 原样输出给用户。',
      '如果启用了世界书，请把触发条目当作当前场景可用的世界观/人物/地点资料；不要向用户说明“触发了世界书”。',
      '最终回答只输出玩家可见正文；不要追加角色状态、元数据、状态栏、实时总结、伏笔或大纲规划。',
      buildLengthInstruction(session),
      '',
      parts.join('\n\n'),
    ].join('\n');
  }

  function buildUserProfilePrompt(session = activeSession()) {
    if (!session) return '';
    const userName = getSessionUserName(session);
    const profile = ensureUserProfile(session);
    const charName = session.characterCard?.name || '角色';
    const resolve = (value) => resolveCharacterPlaceholders(value, charName, userName).trim();
    const lines = [
      userName ? `用户名字/称呼：${userName}` : '',
      profile.pronouns ? `代称/称谓偏好：${resolve(profile.pronouns)}` : '',
      profile.age ? `年龄/阶段：${resolve(profile.age)}` : '',
      profile.occupation ? `职业/身份：${resolve(profile.occupation)}` : '',
      String(session.userPersona || '').trim() ? `身份描述：\n${resolve(session.userPersona)}` : '',
      profile.background ? `背景经历：\n${resolve(profile.background)}` : '',
      profile.goals ? `当前目标/动机：\n${resolve(profile.goals)}` : '',
      profile.language ? `偏好语言：${resolve(profile.language)}` : '',
      profile.tone ? `回复风格偏好：\n${resolve(profile.tone)}` : '',
      profile.boundaries ? `边界/避雷：\n${resolve(profile.boundaries)}` : '',
      profile.customFields ? `自定义信息：\n${resolve(profile.customFields)}` : '',
    ].filter(Boolean);
    if (!lines.length) return '';
    lines.push('称呼用户时优先使用上述名字/称呼和代称；不要把用户称为“用户”。');
    return ['【用户身份与对话偏好】', ...lines].join('\n');
  }

  function buildWorldBookPrompt(session, assistantIndex = session.messages.length, { entries = null, label = '世界书触发条目' } = {}) {
    entries ||= getActiveWorldBookEntries(session, assistantIndex).filter((entry) => normalizeWorldBookPosition(entry.position) !== 'at_depth');
    if (!entries.length) return '';
    const content = applyPromptFormatting(worldBookEntriesToPrompt(entries, {
      charName: session.characterCard?.name || '角色',
      userName: getSessionUserName(session),
    }), REGEX_PLACEMENTS.WORLD_INFO, { session, depth: 0 });
    return [
      `【${label}】`,
      content,
    ].join('\n');
  }

  function buildWorldBookAtDepthPrompt(session, assistantIndex = session.messages.length) {
    const entries = getActiveWorldBookEntries(session, assistantIndex)
      .filter((entry) => normalizeWorldBookPosition(entry.position) === 'at_depth');
    if (!entries.length) return '';
    const content = applyPromptFormatting(worldBookEntriesToPrompt(entries, {
      charName: session.characterCard?.name || '角色',
      userName: getSessionUserName(session),
    }), REGEX_PLACEMENTS.WORLD_INFO, { session, depth: 0 });
    return [
      '【世界书触发条目 / 对话深度注入】',
      content,
    ].join('\n');
  }

  function normalizeWorldBookPosition(position) {
    const raw = String(position || '').toLowerCase();
    if (raw === 'after' || raw === 'after_char' || raw === 'after_character') return 'after_char';
    if (raw === 'depth' || raw === 'at_depth' || raw === 'chat') return 'at_depth';
    return 'before_char';
  }

  function getActiveWorldBookEntries(session = activeSession(), assistantIndex = session?.messages?.length || 0) {
    const runtimeBook = buildRuntimeWorldBook(session);
    if (!session?.worldBookEnabled || !runtimeBook?.entries?.length) return [];
    const scanText = getWorldBookScanText(session, assistantIndex);
    return getTriggeredWorldBookEntries(runtimeBook, scanText, {
      maxEntries: clamp(Number.parseInt(session.worldBookMaxEntries || 12, 10), 1, 50),
      tokenBudget: clamp(Number.parseInt(session.worldBookTokenBudget || runtimeBook?.token_budget || 1200, 10), 64, 100000),
      recursive: Boolean(session.worldBookRecursive ?? runtimeBook?.recursive_scanning),
    });
  }

  function buildRuntimeWorldBook(session = activeSession()) {
    if (!session) return null;
    const currentCharacterId = session.characterCardId || session.characterCard?.library_id || '';
    const ids = new Set(session.activeWorldBookIds || []);
    for (const book of state.worldBooks) {
      if (book.source === 'character_embedded' && book.bound_character_id === currentCharacterId) ids.add(book.id);
    }
    const books = [...ids].map((id) => state.worldBooks.find((book) => book.id === id)).filter(Boolean);
    if (session.worldBook?.entries?.length && !books.some((book) => book.id === session.worldBook.id)) books.unshift(session.worldBook);
    if (!books.length) return null;
    const entries = books.flatMap((book, bookIndex) => (book.entries || []).map((entry) => ({
      ...entry,
      priority: Number(entry.priority ?? 100) + (book.source === 'character_embedded' ? 1000 : 0) - bookIndex,
      sourceBookId: book.id,
      sourceBookName: book.name,
    })));
    return {
      name: books.map((book) => book.name).join(' + '),
      scan_depth: session.worldBookScanDepth || Math.max(...books.map((book) => Number(book.scan_depth || 4))),
      token_budget: session.worldBookTokenBudget || Math.max(...books.map((book) => Number(book.token_budget || 1200))),
      recursive_scanning: Boolean(session.worldBookRecursive || books.some((book) => book.recursive_scanning)),
      entries,
    };
  }

  function resolveCharacterExampleBudget(session, assistantIndex) {
    const staticText = [
      session.systemPrompt || '',
      session.jailbreakPrompt || '',
      session.background || '',
      session.rpMemory || '',
    ].join('\n');
    const recent = session.messages.slice(Math.max(0, assistantIndex - 24), assistantIndex)
      .map((message) => getMessageView(message).content || '')
      .join('\n');
    const used = estimateTokens(staticText) + estimateTokens(recent);
    const remaining = Math.max(0, CONTEXT_LIMIT - used);
    return clamp(Math.min(2400, Math.floor(remaining * 0.03)), 0, 2400);
  }

  function getWorldBookScanText(session, assistantIndex = session.messages.length) {
    const depth = clamp(Number.parseInt(session.worldBookScanDepth || 8, 10), 1, 40);
    const end = Math.max(0, Math.min(assistantIndex, session.messages.length));
    const recent = session.messages.slice(Math.max(0, end - depth), end)
      .map((message) => {
        const view = getMessageView(message);
        return `${getRoleLabelForScan(view)}: ${view.content || ''}`;
      })
      .join('\n\n');
    const userName = getSessionUserName(session);
    const profile = ensureUserProfile(session);
    return [
      session.userPersona ? `用户身份：${resolveCharacterPlaceholders(session.userPersona, session.characterCard?.name || '角色', userName)}` : '',
      profile.background ? `用户背景：${resolveCharacterPlaceholders(profile.background, session.characterCard?.name || '角色', userName)}` : '',
      profile.goals ? `用户目标：${resolveCharacterPlaceholders(profile.goals, session.characterCard?.name || '角色', userName)}` : '',
      profile.customFields ? `用户自定义信息：${resolveCharacterPlaceholders(profile.customFields, session.characterCard?.name || '角色', userName)}` : '',
      session.backgroundEnabled !== false ? session.background || '' : '',
      session.characterCardEnabled !== false && session.characterCard ? [session.characterCard.name, session.characterCard.description, session.characterCard.scenario].filter(Boolean).join('\n') : '',
      recent,
    ].filter(Boolean).join('\n\n');
  }

  function getRoleLabelForScan(view) {
    if (view.role === 'user') return getSessionUserName() || '玩家';
    if (view.role === 'assistant') return view.characterName || activeSession()?.characterCard?.name || '角色';
    return view.role || 'message';
  }

  function buildRoleplayInstruction(session) {
    const perspective = {
      second: '第二人称“你”称呼玩家',
      third: '第三人称叙事',
      first: '第一人称叙事',
    }[session.rpPerspective || 'second'] || '第二人称“你”称呼玩家';
    const lines = [
      '【互动角色扮演模式】',
      `叙事视角：${perspective}。`,
      '运行方式：这是一个互动式角色扮演游戏。你负责扮演角色卡中的角色、NPC 和环境，只描写玩家能感知到的场景、动作、表情、对话与后果。',
      '不要替玩家做重大决定；不要代替玩家说出台词或完成行动。每轮根据玩家输入推进剧情，并在结尾停在可互动的位置。',
      '保持角色人设、世界观、时间、地点和关系连续；不要越回越短，除非玩家明确要求略写或快速跳过。',
      '不要输出角色状态、状态栏、元数据、实时总结、伏笔列表、大纲推测或逻辑审查；这些幕后内容不会显示给玩家。',
    ];
    if (session.rpSuggestions !== false) {
      lines.push('每次回复末尾必须追加一个 <suggestions> 块，给出 3 个短行动选项，每行一个。选项要能被玩家直接点击发送；不要在正文中解释这些选项。格式：<suggestions>\\n1. ...\\n2. ...\\n3. ...\\n</suggestions>');
    }
    return lines.join('\n');
  }

  function getSessionUserName(session = activeSession()) {
    return String(session?.userName || '').trim();
  }

  function getFormattingContext({ session = activeSession(), message = null, view = null, input = '' } = {}) {
    const history = Array.isArray(session?.messages) ? session.messages : [];
    const last = history.at(-1);
    const lastView = last ? getMessageView(last) : null;
    const currentView = view || message || {};
    return {
      charName: currentView.characterName || session?.characterCard?.name || '角色',
      userName: getSessionUserName(session) || '你',
      input: input || els.messageInput?.value || '',
      lastMessage: lastView?.content || '',
      mesId: message?.id || currentView.id || '',
      now: new Date(),
    };
  }

  function getMessageDepth(message, session = activeSession()) {
    if (!message || !session?.messages?.length) return 0;
    const index = session.messages.findIndex((item) => item.id === message.id);
    if (index < 0) return 0;
    return Math.max(0, session.messages.length - 1 - index);
  }

  function applyPromptFormatting(text, placement, { message = null, view = null, session = activeSession(), depth = null, input = '' } = {}) {
    return formatMessageForPrompt(text, getFormattingContext({ session, message, view, input }), getFormattingSettings(session), {
      placement,
      depth: depth ?? getMessageDepth(message, session),
    });
  }

  function applyPersistentFormatting(text, placement, { message = null, view = null, session = activeSession(), depth = null, input = '', runOnEdit = false } = {}) {
    return applyPersistentRegexScripts(text, getFormattingContext({ session, message, view, input: input || text }), getFormattingSettings(session), {
      placement,
      depth: depth ?? getMessageDepth(message, session),
      runOnEdit,
    });
  }

  function toApiMessage(message) {
    const view = getMessageView(message);
    if (view.role === 'user') return { role: 'user', content: applyPromptFormatting(view.content || '', REGEX_PLACEMENTS.USER_INPUT, { message, view, input: view.content || '' }) };
    if (view.role === 'tool') return { role: 'tool', content: view.content || '', tool_call_id: view.tool_call_id || view.toolCallId || '' };
    if (view.role === 'assistant') {
      // Send only the visible assistant text. Local status/metadata panels were
      // removed, and any legacy status tags are stripped during parsing.
      if (!String(view.content || '').trim() && !view.toolCalls?.length) return null;
      const api = { role: 'assistant', content: applyPromptFormatting(view.content || '', REGEX_PLACEMENTS.AI_OUTPUT, { message, view, input: view.content || '' }) };
      if (view.toolCalls?.length) {
        api.tool_calls = view.toolCalls.map((call) => ({
          id: call.id,
          type: call.type || 'function',
          function: {
            name: call.function?.name || call.name || '',
            arguments: call.function?.arguments || call.arguments || '{}',
          },
        }));
        if (state.settings.thinking && view.reasoning_content) api.reasoning_content = view.reasoning_content;
      }
      return api;
    }
    return null;
  }

  function parseStop(value) {
    return String(value || '').split(',').map((item) => item.trim()).filter(Boolean).slice(0, 16);
  }

  function parseToolsJson() {
    try {
      const parsed = JSON.parse(state.settings.toolsJson || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }


  function fetchDeepSeek(endpoint, body, baseUrl, signal) {
    return fetchDeepSeekRequest({
      endpoint,
      body,
      baseUrl,
      signal,
      settings: state.settings,
      onRetry: (message) => toast(message),
    });
  }

  async function executeToolCalls(assistant) {
    const toolMessages = [];
    for (const call of assistant.toolCalls) {
      call.status = 'executing';
      scheduleRenderMessages();
      let result;
      try {
        const name = call.function?.name || call.name;
        const args = parseToolArguments(call.function?.arguments || call.arguments || '{}');
        call.parsedArguments = args;
        result = await executeTool(name, args);
        call.status = 'succeeded';
        call.result = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      } catch (error) {
        call.status = 'failed';
        call.result = friendlyError(error);
      }
      toolMessages.push({
        id: uid('msg'),
        role: 'tool',
        name: call.function?.name || call.name || 'tool',
        content: call.result,
        tool_call_id: call.id,
        createdAt: nowISO(),
      });
      syncActiveVersion(assistant);
      persistSoon();
      renderMessages();
    }
    return toolMessages;
  }

  function validateToolsJson({ silent = false, format = false } = {}) {
    try {
      const parsed = JSON.parse(els.toolsJsonInput.value || '[]');
      if (!Array.isArray(parsed)) throw new Error('Tools JSON 必须是数组。');
      for (const tool of parsed) validateToolDefinition(tool);
      if (parsed.some((tool) => tool.function?.strict === true) && !parsed.every((tool) => tool.function?.strict === true)) {
        throw new Error('启用 strict 模式时，当前请求内所有 function tool 都应设置 strict:true。');
      }
      state.settings.toolsJson = JSON.stringify(parsed, null, 2);
      if (format) els.toolsJsonInput.value = state.settings.toolsJson;
      persistSoon();
      if (!silent) toast('工具定义校验通过。', 'success');
      return true;
    } catch (error) {
      if (!silent) toast(`工具定义无效：${error.message}`, 'error');
      return false;
    }
  }

  async function runFimCompletion() {
    if (state.settings.thinking) return toast('FIM 仅在非思考模式下可用，请先关闭 Thinking Mode。', 'error');
    if (!hasUsableApiKey()) return toast(serverApiKeyConfigured ? '服务器 API Key 未生效，请检查服务端环境变量和代理配置。' : '请先填写 API Key。', 'error');
    const prompt = els.fimPrefix.value;
    const suffix = els.fimSuffix.value;
    if (!prompt.trim() && !suffix.trim()) return toast('请至少输入 Prefix 或 Suffix。', 'error');
    els.fimResult.value = '';
    els.runFimBtn.disabled = true;
    const controller = new AbortController();
    try {
      const body = {
        model: state.settings.model,
        prompt,
        suffix,
        max_tokens: Math.min(state.settings.maxTokens, 4096),
        stream: true,
        temperature: state.settings.temperature,
        top_p: state.settings.topP,
      };
      const response = await fetchDeepSeek('/completions', body, state.settings.betaBaseUrl, controller.signal);
      await streamFimResponse(response, (text) => { els.fimResult.value += text; });
      toast('FIM 补全完成。', 'success');
    } catch (error) {
      toast(friendlyError(error), 'error');
    } finally {
      els.runFimBtn.disabled = false;
    }
  }

  async function streamFimResponse(response, onText) {
    if (!response.body) {
      const data = await response.json();
      onText(data.choices?.[0]?.text || '');
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\n\n|\r\n\r\n/);
      buffer = events.pop() || '';
      for (const event of events) {
        for (const line of event.split(/\r?\n/)) {
          const data = line.trim().startsWith('data:') ? line.trim().slice(5).trim() : '';
          if (!data || data === '[DONE]') continue;
          const chunk = JSON.parse(data);
          const text = chunk.choices?.[0]?.text ?? chunk.choices?.[0]?.delta?.content ?? '';
          if (text) onText(text);
        }
      }
    }
  }

  function onMessagesScroll() {
    userScrolledAway = !isNearBottom();
    updateBackLatestButton();
  }

  function isNearBottom() {
    const distance = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight;
    return distance < 120;
  }

  function scrollToBottom(smooth = false) {
    userScrolledAway = false;
    els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    updateBackLatestButton();
  }

  function updateBackLatestButton() {
    els.backLatestBtn.classList.toggle('hidden', isNearBottom());
  }

  function renderStats() {
    const session = activeSession();
    const summary = summarizeSession(session);
    els.sessionStats.textContent = `${session.messages.length} 消息 · 约 ${summary.estimatedTokens.toLocaleString()} tokens`;
    const cacheTotal = summary.cacheHit + summary.cacheMiss;
    const cacheRatio = cacheTotal ? Math.round((summary.cacheHit / cacheTotal) * 100) : 0;
    const warning = summary.estimatedTokens > CONTEXT_LIMIT * 0.85 ? '<p class="error-inline">上下文接近 1M 限制，建议截断历史。</p>' : '';
    els.tokenPanel.innerHTML = `${warning}
      <div>估算上下文：${summary.estimatedTokens.toLocaleString()} / ${CONTEXT_LIMIT.toLocaleString()}</div>
      <div>输入 tokens：${summary.prompt.toLocaleString()} · 输出 tokens：${summary.completion.toLocaleString()}</div>
      <div>缓存命中：${summary.cacheHit.toLocaleString()} · 未命中：${summary.cacheMiss.toLocaleString()} · 命中率：${cacheRatio}%</div>
      <div>数据源：${storageBackendLabel(storageBackend)}${Number.isFinite(getLastServerRevision()) ? ` · 修订 ${getLastServerRevision()}` : ''}</div>
      <div class="muted">提示：保持 System Prompt 稳定有助于提高上下文缓存命中率。</div>`;
  }

  function storageBackendLabel(backend) {
    return {
      'sqlite-websocket': '服务端 SQLite（WebSocket 实时同步）',
      memory: '内存（SQLite 尚未连接）',
    }[backend] || backend;
  }

  function summarizeSession(session) {
    const summary = {
      estimatedTokens: estimateTokens(getEffectiveSystemPrompt(session)) + estimateTokens(buildCharacterPostHistoryInstructions(session)) + estimateTokens(buildJailbreakPrompt(session)) + estimateTokens(buildSceneContextMessage(session)),
      prompt: 0,
      completion: 0,
      cacheHit: 0,
      cacheMiss: 0,
      reasoning: 0,
    };
    for (const message of session.messages) {
      const view = getMessageView(message);
      summary.estimatedTokens += estimateTokens(view.content || '');
      const usage = view.usage || {};
      summary.prompt += usage.prompt_tokens || 0;
      summary.completion += usage.completion_tokens || 0;
      summary.cacheHit += usage.prompt_cache_hit_tokens || 0;
      summary.cacheMiss += usage.prompt_cache_miss_tokens || 0;
      summary.reasoning += usage.completion_tokens_details?.reasoning_tokens || 0;
    }
    return summary;
  }

  function renderPromptTemplates() {
    els.promptTemplates.innerHTML = PROMPT_TEMPLATES.map((tpl, index) => `<button type="button" data-template="${index}">${escapeHtml(tpl.name)}</button>`).join('');
  }

  function renderPromptLibrary() {
    if (!state.promptLibrary.length) {
      els.promptLibrary.innerHTML = '<p class="muted">Prompt 库为空，可将当前 System Prompt 保存为模板。</p>';
      return;
    }
    els.promptLibrary.innerHTML = state.promptLibrary.map((prompt) => `<div class="prompt-item" data-prompt-id="${prompt.id}"><div><strong>${escapeHtml(prompt.name)}</strong><br><small>${escapeHtml((prompt.tags || []).join(', '))}</small></div><div><button data-action="use-prompt">使用</button><button data-action="delete-prompt">删除</button></div></div>`).join('');
  }

  function savePromptToLibrary() {
    const content = activeSession().systemPrompt || '';
    if (!content.trim()) return toast('当前 System Prompt 为空。', 'error');
    const name = prompt('模板名称', `Prompt ${state.promptLibrary.length + 1}`);
    if (!name) return;
    const tags = prompt('标签（逗号分隔，可选）', '') || '';
    state.promptLibrary.push({ id: uid('prompt'), name: name.trim(), prompt: content, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), createdAt: nowISO() });
    persistSoon();
    renderPromptLibrary();
    toast('Prompt 已保存。', 'success');
  }

  function onPromptLibraryClick(event) {
    const item = event.target.closest('.prompt-item');
    if (!item) return;
    const promptItem = state.promptLibrary.find((p) => p.id === item.dataset.promptId);
    if (!promptItem) return;
    const action = event.target.dataset.action;
    if (action === 'use-prompt') {
      activeSession().systemPrompt = promptItem.prompt;
      els.systemPromptInput.value = promptItem.prompt;
      touchSession();
      persistSoon();
      toast(`已应用 Prompt：${promptItem.name}`, 'success');
    } else if (action === 'delete-prompt') {
      state.promptLibrary = state.promptLibrary.filter((p) => p.id !== promptItem.id);
      persistSoon();
      renderPromptLibrary();
    }
  }

  async function importJailbreakPreset(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const raw = (await file.text()).trim();
      if (!raw) throw new Error('文件内容为空。');
      const imported = parseExternalPresetText(raw, { sourceName: file.name });
      const session = activeSession();
      session.jailbreakPrompt = imported.prompt;
      session.jailbreakSource = file.name;
      session.jailbreakImportMeta = imported.meta || null;
      session.jailbreakImportKind = imported.kind || '';
      session.jailbreakParsed = Boolean(imported.parsed);
      session.jailbreakMessages = Array.isArray(imported.messages) ? imported.messages : [];
      session.jailbreakLayout = Array.isArray(imported.layout) ? imported.layout : [];
      session.jailbreakSettings = imported.settings || {};
      session.jailbreakEnabled = true;
      const preset = migrateJailbreakPreset({
        id: uid('jb'),
        name: file.name.replace(/\.[^.]+$/, '') || '导入破限',
        description: imported.parsed ? '从外部预设解析导入' : '从文本文件导入',
        system_prompt: imported.prompt,
        post_history_instructions: '',
        layout: session.jailbreakLayout,
        messages: session.jailbreakMessages,
        settings: session.jailbreakSettings,
        import_meta: imported.meta || null,
        import_kind: imported.kind || '',
        tags: imported.parsed ? ['imported', 'sillytavern'] : ['imported'],
        created_at: nowISO(),
        updated_at: nowISO(),
      });
      state.jailbreakPresets.push(preset);
      session.jailbreakPresetId = preset.id;
      const appliedSettings = applyImportedPresetGenerationSettings(imported.settings || {});
      touchSession(session);
      persistSoon();
      if (appliedSettings.length) syncSettingsToInputs();
      renderJailbreakPanel();
      renderJailbreakLibrary();
      renderStats();
      const originalTokens = estimateTokens(raw);
      const parsedTokens = estimateTokens(session.jailbreakPrompt);
      const saved = originalTokens > parsedTokens ? `，节省约 ${(originalTokens - parsedTokens).toLocaleString()} tokens` : '';
      const settingsNote = appliedSettings.length ? `，并按酒馆预设同步参数：${appliedSettings.join('、')}` : '';
      toast(`${imported.parsed ? '已按酒馆方式解析导入' : '已按文本导入'}外部预设：${file.name}（${originalTokens.toLocaleString()} → ${parsedTokens.toLocaleString()} tokens${saved}${settingsNote}），不会覆盖 System Prompt。`, 'success');
    } catch (error) {
      toast(`外部预设导入失败：${error.message}`, 'error');
    }
  }

  function applyImportedPresetGenerationSettings(settings = {}) {
    const changed = [];
    const setNumber = (key, label, min, max) => {
      if (settings[key] === undefined || settings[key] === null || settings[key] === '') return;
      const value = Number(settings[key]);
      if (!Number.isFinite(value)) return;
      state.settings[key] = clamp(value, min, max);
      changed.push(label);
    };
    setNumber('temperature', 'temperature', 0, 2);
    setNumber('topP', 'top_p', 0, 1);
    setNumber('presencePenalty', 'presence_penalty', -2, 2);
    setNumber('frequencyPenalty', 'frequency_penalty', -2, 2);
    if (settings.maxTokens !== undefined && settings.maxTokens !== null && settings.maxTokens !== '') {
      const value = Number.parseInt(settings.maxTokens, 10);
      if (Number.isFinite(value)) {
        state.settings.maxTokens = clamp(value, 1, 32768);
        changed.push('max_tokens');
      }
    }
    if (['high', 'max'].includes(settings.reasoningEffort)) {
      state.settings.reasoningEffort = settings.reasoningEffort;
      changed.push('reasoning_effort');
    }
    return changed;
  }

  function clearJailbreakPreset() {
    const session = activeSession();
    if (!session?.jailbreakPrompt && !session?.jailbreakSource) return;
    if (!confirm('确定清除当前会话的外部预设/破限词吗？System Prompt 不会受影响。')) return;
    session.jailbreakEnabled = false;
    session.jailbreakPrompt = '';
    session.jailbreakSource = '';
    session.jailbreakImportMeta = null;
    session.jailbreakImportKind = '';
    session.jailbreakParsed = false;
    session.jailbreakMessages = [];
    session.jailbreakLayout = [];
    session.jailbreakSettings = {};
    touchSession(session);
    persistSoon();
    renderJailbreakPanel();
    renderStats();
  }

  function renderJailbreakPanel({ keepText = false } = {}) {
    const session = activeSession();
    if (!session || !els.jailbreakSummary) return;
    els.jailbreakEnabledInput.checked = Boolean(session.jailbreakEnabled);
    if (!keepText) els.jailbreakPromptInput.value = session.jailbreakPrompt || '';
    if (document.activeElement !== els.jailbreakPostHistoryInput) els.jailbreakPostHistoryInput.value = session.jailbreakPostHistoryInstructions || '';
    const tokens = estimateTokens(session.jailbreakPrompt || '');
    els.clearJailbreakBtn.disabled = !String(session.jailbreakPrompt || '').trim() && !session.jailbreakSource;
    if (!String(session.jailbreakPrompt || '').trim()) {
      els.jailbreakSummary.textContent = '尚未导入外部预设。';
      return;
    }
    els.jailbreakSummary.innerHTML = [
      session.jailbreakEnabled ? '已启用' : '已导入但未启用',
      session.jailbreakSource ? `来源：${escapeHtml(session.jailbreakSource)}` : '手动编辑',
      session.jailbreakPresetId ? `库 ID：${escapeHtml(session.jailbreakPresetId)}` : '',
      session.jailbreakParsed ? '酒馆式 prompt_order 已解析' : '文本/原始模式',
      session.jailbreakPostHistoryInstructions ? `UJB 约 ${estimateTokens(session.jailbreakPostHistoryInstructions).toLocaleString()} tokens` : '',
      session.jailbreakImportMeta?.includedPrompts ? `启用片段 ${Number(session.jailbreakImportMeta.includedPrompts).toLocaleString()} 个` : '',
      Array.isArray(session.jailbreakMessages) && session.jailbreakMessages.length ? `发送消息 ${session.jailbreakMessages.length.toLocaleString()} 条` : '',
      session.jailbreakImportMeta?.skippedPrompts ? `跳过 ${Number(session.jailbreakImportMeta.skippedPrompts).toLocaleString()} 个无效/JSON锁定片段` : '',
      `约 ${tokens.toLocaleString()} tokens`,
    ].filter(Boolean).join(' · ');
  }

  async function importWorldBook(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const session = activeSession();
      const book = prepareWorldBookForLibrary(normalizeWorldBook(data, file.name), { source: 'imported' });
      session.worldBook = structuredCloneSafe(book);
      session.worldBookEnabled = true;
      session.worldBookScanDepth = session.worldBook.scan_depth || session.worldBookScanDepth || 4;
      session.worldBookTokenBudget = session.worldBook.token_budget || session.worldBookTokenBudget || 1200;
      session.worldBookRecursive = Boolean(session.worldBook.recursive_scanning);
      if (!state.worldBooks.some((item) => item.id === book.id || (item.name === book.name && item.source === book.source))) state.worldBooks.push(book);
      if (!session.activeWorldBookIds.includes(book.id)) session.activeWorldBookIds.push(book.id);
      touchSession(session);
      persistSoon();
      renderWorldBookLibrary();
      renderWorldBookPanel();
      renderStats();
      toast(`已导入世界书：${session.worldBook.name}（${session.worldBook.entries.length} 条）。`, 'success');
    } catch (error) {
      toast(`世界书导入失败：${error.message}`, 'error');
    }
  }

  function clearWorldBook() {
    const session = activeSession();
    if (!session?.worldBook) return;
    if (!confirm('确定清除当前会话的世界书吗？角色卡和背景不会受影响。')) return;
    session.worldBook = null;
    session.worldBookEnabled = false;
    session.activeWorldBookIds = [];
    touchSession(session);
    persistSoon();
    renderWorldBookPanel();
    renderStats();
  }

  function renderWorldBookPanel() {
    const session = activeSession();
    if (!session || !els.worldBookSummary) return;
    els.worldBookEnabledInput.checked = Boolean(session.worldBookEnabled);
    els.worldBookScanDepthInput.value = session.worldBookScanDepth || 8;
    els.worldBookMaxEntriesInput.value = session.worldBookMaxEntries || 12;
    els.worldBookTokenBudgetInput.value = session.worldBookTokenBudget || session.worldBook?.token_budget || 1200;
    els.worldBookRecursiveInput.checked = Boolean(session.worldBookRecursive ?? session.worldBook?.recursive_scanning);
    const runtimeBook = buildRuntimeWorldBook(session);
    els.clearWorldBookBtn.disabled = !runtimeBook;
    if (!runtimeBook) {
      els.worldBookSummary.textContent = '尚未导入世界书。';
      els.worldBookEditor.value = '';
      els.worldBookActivePreview.value = '';
      els.worldBookTestResult.value = '';
      return;
    }
    const active = getActiveWorldBookEntries(session);
    const total = runtimeBook.entries?.length || 0;
    const enabledCount = runtimeBook.entries?.filter((entry) => entry.enabled).length || 0;
    const summary = summarizeWorldBook(runtimeBook);
    els.worldBookSummary.innerHTML = [
      `<strong>${escapeHtml(runtimeBook.name || '未命名世界书')}</strong>`,
      session.worldBookEnabled ? '已启用' : '已导入但未启用',
      `${new Set([...(session.activeWorldBookIds || []), session.worldBook?.id].filter(Boolean)).size} 本激活`,
      `${enabledCount}/${total} 条可用`,
      `预算 ${Number(session.worldBookTokenBudget || runtimeBook.token_budget || 1200).toLocaleString()} tokens`,
      session.worldBookRecursive ? '递归扫描' : '',
      summary.constantCount ? `常驻 ${summary.constantCount} 条` : '',
      `当前触发 ${active.length} 条`,
    ].filter(Boolean).join(' · ');
    if (document.activeElement !== els.worldBookEditor) {
      const editableBook = session.worldBook || state.worldBooks.find((book) => (session.activeWorldBookIds || []).includes(book.id)) || runtimeBook;
      els.worldBookEditor.value = JSON.stringify({
        name: editableBook.name,
        description: editableBook.description,
        scan_depth: session.worldBookScanDepth,
        token_budget: session.worldBookTokenBudget,
        recursive_scanning: session.worldBookRecursive,
        entries: editableBook.entries,
      }, null, 2);
    }
    els.worldBookActivePreview.value = active.length
      ? applyPromptFormatting(worldBookEntriesToPrompt(active, { charName: session.characterCard?.name || '角色', userName: getSessionUserName(session) }), REGEX_PLACEMENTS.WORLD_INFO, { session })
      : '最近对话尚未触发任何关键词；constant/always active 条目会始终触发。';
    renderWorldBookTest();
  }

  function applyWorldBookEditor() {
    const session = activeSession();
    if (!session?.worldBook) return toast('尚未导入世界书。', 'error');
    try {
      const data = JSON.parse(els.worldBookEditor.value || '{}');
      const next = normalizeWorldBook(data, session.worldBook.source || session.worldBook.name || '手动编辑');
      session.worldBook = next;
      session.worldBookEnabled = true;
      session.worldBookScanDepth = next.scan_depth || session.worldBookScanDepth || 4;
      session.worldBookTokenBudget = next.token_budget || session.worldBookTokenBudget || 1200;
      session.worldBookRecursive = Boolean(next.recursive_scanning);
      touchSession(session);
      persistSoon();
      renderWorldBookPanel();
      toast('世界书编辑已应用。', 'success');
    } catch (error) {
      toast(`世界书 JSON 无效：${error.message}`, 'error');
    }
  }

  function renderWorldBookTest() {
    const session = activeSession();
    if (!els.worldBookTestResult) return;
    const text = String(els.worldBookTestInput?.value || '').trim();
    const runtimeBook = buildRuntimeWorldBook(session);
    if (!runtimeBook?.entries?.length || !text) {
      els.worldBookTestResult.value = '';
      return;
    }
    const entries = getTriggeredWorldBookEntries(runtimeBook, text, {
      maxEntries: clamp(Number.parseInt(session.worldBookMaxEntries || 12, 10), 1, 50),
      tokenBudget: clamp(Number.parseInt(session.worldBookTokenBudget || 1200, 10), 64, 100000),
      recursive: Boolean(session.worldBookRecursive),
    });
    els.worldBookTestResult.value = entries.length
      ? applyPromptFormatting(worldBookEntriesToPrompt(entries, { charName: session.characterCard?.name || '角色', userName: getSessionUserName(session) }), REGEX_PLACEMENTS.WORLD_INFO, { session })
      : '未触发任何条目。';
  }

  function renderCharacterPanel({ keepFields = false } = {}) {
    const session = activeSession();
    if (!session || !els.characterCardSummary) return;
    const card = session.characterCard;
    els.userNameInput.value = session.userName || '';
    els.userPersonaInput.value = session.userPersona || '';
    els.rpModeInput.checked = Boolean(session.rpMode);
    els.rpPerspectiveInput.value = session.rpPerspective || 'second';
    els.rpSuggestionsInput.checked = session.rpSuggestions !== false;
    els.rpMemoryInput.value = session.rpMemory || '';
    els.backgroundInput.value = session.background || '';
    els.backgroundEnabledInput.checked = session.backgroundEnabled !== false;
    els.characterEnabledInput.checked = session.characterCardEnabled !== false;
    els.startCharacterChatBtn.disabled = !getCharacterGreetings(card || {}).length;
    els.insertGreetingBtn.disabled = !getCharacterGreetings(card || {}).length;
    els.clearCharacterBtn.disabled = !card;
    if (!card) {
      els.characterCardSummary.textContent = '尚未导入角色卡。';
      els.characterCardPreview.value = '';
      renderGreetingOptions(null);
      syncCharacterFieldInputs(null, { keepFields });
      updatePersonaTopButton();
      return;
    }
    renderGreetingOptions(card);
    syncCharacterFieldInputs(card, { keepFields });
    const promptText = characterCardToPrompt(card, {
      userName: getSessionUserName(session),
      includeExamples: true,
      exampleBudgetTokens: 1200,
    });
    const stats = card.tokenStats || {};
    els.characterCardSummary.innerHTML = [
      `<strong>${escapeHtml(card.name || '未命名角色')}</strong>`,
      card.spec_version ? `规格 ${escapeHtml(card.spec_version)}` : '',
      card.source ? `来源：${escapeHtml(card.source)}` : '',
      Array.isArray(card.tags) && card.tags.length ? `标签：${escapeHtml(card.tags.join(', '))}` : '',
      card.creator ? `作者：${escapeHtml(card.creator)}` : '',
      card.character_version ? `版本：${escapeHtml(card.character_version)}` : '',
      `入 prompt 约 ${estimateTokens(promptText).toLocaleString()} tokens`,
      stats.total ? `字段总计约 ${Number(stats.total).toLocaleString()} tokens` : '',
      card.character_book?.entries?.length ? `内嵌世界书 ${card.character_book.entries.length} 条` : '',
    ].filter(Boolean).join(' · ');
    els.characterCardPreview.value = promptText;
    updatePersonaTopButton();
  }

  function renderGreetingOptions(card) {
    if (!els.characterGreetingSelect) return;
    const session = activeSession();
    const greetings = getCharacterGreetings(card || {});
    if (!greetings.length) {
      els.characterGreetingSelect.innerHTML = '<option value="0">无可用开场白</option>';
      els.characterGreetingSelect.disabled = true;
      return;
    }
    els.characterGreetingSelect.disabled = false;
    const current = Math.max(0, Math.min(Number(session.greetingIndex || 0), greetings.length - 1));
    session.greetingIndex = current;
    els.characterGreetingSelect.innerHTML = greetings.map((greeting, index) => {
      const label = index === 0 ? '主开场白' : `备选开场白 ${index}`;
      return `<option value="${index}">${label} · ${escapeHtml(greeting.replace(/\s+/g, ' ').slice(0, 42))}</option>`;
    }).join('');
    els.characterGreetingSelect.value = String(current);
  }

  function syncCharacterFieldInputs(card, { keepFields = false } = {}) {
    if (keepFields) return;
    const set = (key, value = '') => {
      if (els[key]) els[key].value = value || '';
    };
    set('characterNameInput', card?.name);
    set('characterDescriptionInput', card?.description);
    set('characterPersonalityInput', card?.personality);
    set('characterScenarioInput', card?.scenario);
    set('characterFirstMesInput', card?.first_mes);
    set('characterMesExampleInput', card?.mes_example);
    set('characterSystemPromptInput', card?.system_prompt);
    set('characterPostHistoryInput', card?.post_history_instructions);
    set('characterCreatorNotesInput', card?.creator_notes);
  }

  async function importCharacterCard(event) {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    await importCharacterFiles(files, { applySingleToSession: true, confirmSingle: true });
  }

  async function importCharacterCardToManager(event) {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    await importCharacterFiles(files, { applySingleToSession: false, confirmSingle: false });
  }

  async function importCharacterFiles(files, { applySingleToSession = false, confirmSingle = false } = {}) {
    if (!files.length) return;
    try {
      const session = activeSession();
      const parsedCards = [];
      for (const file of files) {
        const cards = await parseCharacterCardsFromFile(file);
        parsedCards.push(...cards.map((card) => ({ card, file })));
      }
      if (!parsedCards.length) throw new Error('未识别到可导入的角色卡。');
      if (confirmSingle && parsedCards.length === 1) {
        const parsed = parsedCards[0].card;
        if (!confirm([
          `确认导入角色卡：${parsed.name || '未命名角色'}？`,
          `规格：${parsed.spec_version || '未知'}；标签：${(parsed.tags || []).join(', ') || '无'}`,
          `字段估算：约 ${Number(parsed.tokenStats?.total || estimateTokens(characterCardToPrompt(parsed))).toLocaleString()} tokens`,
          `描述摘要：${String(parsed.description || '').replace(/\s+/g, ' ').slice(0, 120) || '无'}`,
          parsed.character_book?.entries?.length ? `包含内嵌世界书：${parsed.character_book.entries.length} 条` : '',
        ].filter(Boolean).join('\n'))) return;
      }

      let lastCard = null;
      for (const { card: parsed, file } of parsedCards) {
        const card = prepareCharacterForLibrary(parsed, { sourceFormat: parsed.source_format || inferCharacterSourceFormat(file?.name || parsed.source || '') });
        const index = state.characterCards.findIndex((item) => item.id === card.id);
        if (index >= 0) state.characterCards[index] = card;
        else state.characterCards.push(card);
        lastCard = card;
        if (applySingleToSession && parsedCards.length === 1) {
          applyCharacterCardToSession(session, card);
          await handleEmbeddedCharacterBook(session, session.characterCard);
        } else if (card.character_book) {
          await handleEmbeddedCharacterBook({ ...session, characterCard: card, characterCardId: card.id }, card);
        }
      }

      if (applySingleToSession && parsedCards.length === 1) touchSession(session);
      persistSoon();
      renderCharacterLibrary();
      renderCharacterManager();
      renderWorldBookLibrary();
      renderCharacterPanel();
      renderStats();
      if (applySingleToSession && parsedCards.length === 1 && !session.messages.length && getCharacterGreetings(session.characterCard).length) {
        insertCharacterGreeting({ append: true, silent: true });
        toast(`已导入角色卡：${session.characterCard.name || '未命名角色'}，已入库并自动插入开场白。`, 'success');
      } else {
        toast(`已导入 ${parsedCards.length} 张角色卡到角色库${lastCard ? `，最后一张：${lastCard.name}` : ''}。`, 'success');
      }
    } catch (error) {
      toast(`角色卡导入失败：${error.message}`, 'error');
    }
  }

  async function parseCharacterCardsFromFile(file) {
    const lowerName = String(file?.name || '').toLowerCase();
    if ((lowerName.endsWith('.json') || file?.type === 'application/json') && file?.text) {
      const text = await file.text();
      try {
        const data = JSON.parse(text);
        const items = Array.isArray(data?.characterCards) ? data.characterCards : Array.isArray(data) ? data : null;
        if (items) {
          return items.map((item, index) => normalizeImportedCharacterCard(item, `${file.name}#${index + 1}`));
        }
      } catch (_) {
        // Fall through to the standard parser, which also supports base64 JSON.
      }
    }
    return [await parseCharacterCardFile(file)];
  }

  function normalizeImportedCharacterCard(item, source = '') {
    if (item?.data && typeof item.data === 'object') return normalizeCharacterCard(item, source);
    if (item?.name || item?.description || item?.scenario || item?.first_mes) return item;
    return normalizeCharacterCard(item, source);
  }

  async function handleEmbeddedCharacterBook(session, card) {
    if (!card?.character_book) return;
    const decisionKey = characterBookDecisionKey(card);
    const previous = state.characterBookDecisions?.[decisionKey] || session.characterBookHandling;
    let book = (() => {
      try { return normalizeWorldBook(card.character_book, `${card.name || '角色'} 内嵌世界书`); } catch (_) { return null; }
    })();
    if (!book) return;
    book = prepareWorldBookForLibrary(book, {
      source: 'character_embedded',
      boundCharacterId: card.library_id || card.id || session.characterCardId || '',
    });
    const applyDecision = (action) => {
      session.characterBookHandling = { key: decisionKey, action, updatedAt: nowISO() };
      state.characterBookDecisions[decisionKey] = session.characterBookHandling;
      if (action === 'bind' || action === 'global') {
        session.worldBook = book;
        session.worldBookEnabled = true;
        session.worldBookScanDepth = book.scan_depth || 4;
        session.worldBookTokenBudget = book.token_budget || 1200;
        session.worldBookRecursive = Boolean(book.recursive_scanning);
        session.activeWorldBookIds = [...new Set([...(session.activeWorldBookIds || []), book.id])];
      }
      if ((action === 'bind' || action === 'global') && !state.worldBooks.some((item) => item.id === book.id || (item.name === book.name && item.bound_character_id === book.bound_character_id))) {
        state.worldBooks.push(structuredCloneSafe({
          ...book,
          source: action === 'global' ? 'imported' : 'character_embedded',
        }));
      }
    };
    if (previous?.action) {
      applyDecision(previous.action);
      return;
    }
    const summary = summarizeWorldBook(book);
    const choice = prompt([
      `检测到角色卡内嵌世界书：${book.name}`,
      `条目：${summary.enabled}/${summary.total}；常驻：${summary.constantCount}；约 ${summary.tokens.toLocaleString()} tokens`,
      `关键词预览：${summary.keyPreview.slice(0, 8).join('；') || '无'}`,
      '',
      '请选择处理方式：',
      '1 = 启用并绑定到该角色',
      '2 = 导入为独立世界书（同时在当前会话启用）',
      '3 = 忽略',
    ].join('\n'), '1');
    const action = String(choice || '1').trim() === '2' ? 'global' : String(choice || '1').trim() === '3' ? 'ignore' : 'bind';
    applyDecision(action);
  }

  function characterBookDecisionKey(card) {
    const raw = JSON.stringify(card.character_book || {});
    let hash = 2166136261;
    const seed = `${card.id || ''}\u0001${card.name || ''}\u0001${raw.length}\u0001${raw.slice(0, 4096)}`;
    for (let i = 0; i < seed.length; i += 1) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `book_${(hash >>> 0).toString(36)}`;
  }

  function startCharacterChat({ reset = true } = {}) {
    const session = activeSession();
    if (!session.characterCard) {
      const selected = state.characterCards.find((item) => item.id === selectedOptionValue(els.characterLibrarySelect));
      if (selected) applyCharacterCardToSession(session, selected);
    }
    const card = session.characterCard;
    if (!getCharacterGreetings(card || {}).length) return toast('请先导入带开场白的角色卡。', 'error');
    const greetingIndex = Number.parseInt(els.characterGreetingSelect?.value || session.greetingIndex || '0', 10) || 0;
    startCharacterChatWithCard(card, { sourceSession: session, greetingIndex, requireGreeting: true });
  }

  function startCharacterChatWithCard(card, {
    sourceSession = activeSession(),
    greetingIndex = 0,
    requireGreeting = false,
    closeManager = false,
  } = {}) {
    if (!card) return toast('请先选择角色卡。', 'error');
    const greetings = getCharacterGreetings(card || {});
    if (requireGreeting && !greetings.length) return toast('请先导入带开场白的角色卡。', 'error');
    if (generating) stopGeneration();
    const next = createSession(`${card.name || '角色'} · 新对话`);
    copyCharacterSessionSettings(sourceSession || activeSession(), next);
    applyCharacterCardToSession(next, card);
    next.greetingIndex = greetingIndex;
    next.messages = [];
    state.sessions.unshift(next);
    state.activeSessionId = next.id;
    rememberLocalActiveSession();
    if (closeManager) {
      state.ui.characterManagerOpen = false;
      state.ui.editingCharacterCardId = '';
    }
    if (greetings.length) insertCharacterGreeting({ append: true, silent: true, greetingIndex });
    persistSoon();
    syncSettingsToInputs();
    renderAll();
    toast(`已新建与 ${card.name || '角色'} 的独立对话${greetings.length ? '，并插入开场白' : ''}。`, 'success');
  }

  function copyCharacterSessionSettings(from, to) {
    for (const key of [
      'systemPrompt', 'jailbreakEnabled', 'jailbreakPrompt', 'jailbreakSource', 'jailbreakImportMeta', 'jailbreakImportKind', 'jailbreakParsed', 'jailbreakMessages', 'jailbreakLayout', 'jailbreakSettings', 'jailbreakPresetId', 'jailbreakPostHistoryInstructions',
      'userName', 'userPersona', 'userProfile', 'rpMode', 'rpPerspective', 'rpSuggestions', 'rpMemory', 'background', 'backgroundEnabled',
      'characterCardEnabled', 'characterCard', 'characterBookHandling', 'worldBookEnabled', 'worldBook', 'worldBookScanDepth', 'worldBookMaxEntries', 'worldBookTokenBudget', 'worldBookRecursive',
    ]) {
      to[key] = structuredCloneSafe(from[key]);
    }
  }

  function insertCharacterGreeting({ append = true, silent = false, greetingIndex = null } = {}) {
    const session = activeSession();
    const card = session.characterCard;
    if (!getCharacterGreetings(card || {}).length) return toast('当前角色卡没有开场白。');
    const index = greetingIndex === null ? Number.parseInt(els.characterGreetingSelect?.value || session.greetingIndex || '0', 10) || 0 : greetingIndex;
    session.greetingIndex = index;
    const content = resolveCharacterPlaceholders(getCharacterGreeting(card, index), card.name, getSessionUserName(session)).trim();
    const message = {
      id: uid('msg'),
      role: 'assistant',
      content,
      extra: {},
      reasoning_content: '',
      toolCalls: [],
      createdAt: nowISO(),
      model: 'character-card',
      characterName: card.name || '',
      usage: { completion_tokens: estimateTokens(content) },
    };
    if (append) session.messages.push(message);
    touchSession(session);
    persistSoon();
    renderAll();
    if (!silent) toast('已插入角色卡开场白。', 'success');
  }

  function clearCharacterCard() {
    const session = activeSession();
    if (!session.characterCard) return;
    if (!confirm('确定清除当前会话的角色卡吗？背景设定不会被清除。')) return;
    session.characterCard = null;
    touchSession(session);
    persistSoon();
    renderCharacterPanel();
    renderStats();
  }

  function clearCurrentHistory() {
    if (!confirm('确定清空当前会话的所有消息吗？')) return;
    const session = activeSession();
    session.messages = [];
    touchSession(session);
    persistSoon();
    renderAll();
  }

  function truncateCurrentHistory() {
    const session = activeSession();
    const keep = 12;
    if (session.messages.length <= keep) return toast('当前消息数量不需要截断。');
    session.messages = session.messages.slice(-keep);
    touchSession(session);
    persistSoon();
    renderAll();
    toast('已保留最近 6 轮左右对话。', 'success');
  }

  function exportAllData() {
    download(`deepseek-chat-backup-${dateSlug()}.json`, JSON.stringify({
      sessions: state.sessions.map((session) => compactSessionForStorage(session)),
      settings: { ...state.settings, apiKey: '' },
      promptLibrary: state.promptLibrary,
      jailbreakPresets: state.jailbreakPresets,
      characterCards: state.characterCards,
      worldBooks: state.worldBooks,
      characterBookDecisions: state.characterBookDecisions,
    }, null, 2), 'application/json');
  }

  async function importAllData(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.sessions)) throw new Error('备份文件缺少 sessions 数组。');
      state.sessions = data.sessions;
      for (const session of state.sessions) migrateSession(session);
      state.promptLibrary = Array.isArray(data.promptLibrary) ? data.promptLibrary : state.promptLibrary;
      state.jailbreakPresets = Array.isArray(data.jailbreakPresets) ? data.jailbreakPresets.map(migrateJailbreakPreset) : state.jailbreakPresets;
      state.characterCards = Array.isArray(data.characterCards) ? data.characterCards.map(migrateLibraryCharacterCard) : state.characterCards;
      state.worldBooks = Array.isArray(data.worldBooks) ? data.worldBooks : state.worldBooks;
      state.characterBookDecisions = data.characterBookDecisions && typeof data.characterBookDecisions === 'object' ? data.characterBookDecisions : state.characterBookDecisions;
      if (data.settings) state.settings = normalizeAppSettings({ ...state.settings, ...data.settings, apiKey: state.settings.apiKey || data.settings.apiKey || '' });
      applyServerApiKeyMode();
      state.activeSessionId = state.sessions[0]?.id || null;
      ensureSession();
      await replaceAllPersistedState(buildPersistedStateSnapshot());
      storageBackend = 'sqlite-websocket';
      hasUnsavedChanges = false;
      lastPersistedSnapshot = buildPersistedStateSnapshot();
      syncSettingsToInputs();
      renderAll();
      updateSharedSyncStatus('ok', `备份已导入 SQLite${Number.isFinite(getLastServerRevision()) ? ` · 修订 ${getLastServerRevision()}` : ''}`);
      toast('备份导入成功。', 'success');
    } catch (error) {
      toast(`导入失败：${error.message}`, 'error');
    }
  }

  function exportCurrentSession(type) {
    const session = activeSession();
    if (type === 'json') return download(`${safeFileName(session.title)}.json`, JSON.stringify(compactSessionForStorage(session), null, 2), 'application/json');
    if (type === 'md') return download(`${safeFileName(session.title)}.md`, sessionToMarkdown(session), 'text/markdown');
    return download(`${safeFileName(session.title)}.txt`, sessionToText(session), 'text/plain');
  }

  function sessionToMarkdown(session) {
    const lines = [`# ${session.title}`, '', `> 导出时间：${new Date().toLocaleString()}`, '', `## System Prompt`, '', getEffectiveSystemPrompt(session) || '', ''];
    if (session.jailbreakPrompt) lines.push('## 外部预设 / 破限词', '', `> ${session.jailbreakEnabled ? '已启用' : '未启用'}${session.jailbreakSource ? ` · 来源：${session.jailbreakSource}` : ''}`, '', session.jailbreakPrompt, '');
    const userProfilePrompt = buildUserProfilePrompt(session);
    if (userProfilePrompt) lines.push('## 我的身份', '', userProfilePrompt, '');
    if (session.background) lines.push('## 预设背景', '', session.background, '');
    if (session.worldBook) {
      lines.push('## 世界书', '', `> ${session.worldBookEnabled ? '已启用' : '未启用'} · ${session.worldBook.entries?.length || 0} 条${session.worldBook.source ? ` · 来源：${session.worldBook.source}` : ''}`, '');
      const active = getActiveWorldBookEntries(session);
      if (active.length) lines.push('### 当前触发条目', '', worldBookEntriesToPrompt(active), '');
    }
    if (session.characterCard) lines.push('## 角色卡', '', characterCardToPrompt(session.characterCard, { userName: getSessionUserName(session) }), '');
    for (const message of session.messages) {
      const view = getMessageView(message);
      lines.push(`## ${view.role}`, '', view.content || '', '');
    }
    return lines.join('\n');
  }

  function sessionToText(session) {
    return session.messages.map((message) => {
      const view = getMessageView(message);
      return `[${view.role}] ${formatTime(view.createdAt || message.createdAt)}\n${view.content || ''}`;
    }).join('\n\n---\n\n');
  }

  function exportPrompts() {
    download(`prompt-library-${dateSlug()}.json`, JSON.stringify(state.promptLibrary, null, 2), 'application/json');
  }

  async function importPrompts(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const raw = await file.text();
      const data = JSON.parse(raw);
      const extracted = extractSystemPromptFromJson(data);
      if (extracted?.prompt?.trim()) {
        const session = activeSession();
        session.systemPrompt = extracted.prompt.trim();
        touchSession(session);
        els.systemPromptInput.value = session.systemPrompt;
        persistSoon();
        renderStats();
        toast(`已从 ${file.name} 导入 System Prompt：约 ${estimateTokens(session.systemPrompt).toLocaleString()} tokens。`, 'success');
        return;
      }

      const prompts = normalizePromptLibraryImport(data, { uid, nowISO });
      if (!prompts.length) throw new Error('无法识别此 JSON。请使用字符串、{systemPrompt/content/prompt}、OpenAI messages、SillyTavern prompts/prompt_order，或 Prompt 模板数组。');
      state.promptLibrary.push(...prompts);
      persistSoon();
      renderPromptLibrary();
      toast(`已导入 ${prompts.length} 个 Prompt 模板。`, 'success');
    } catch (error) {
      toast(`Prompt 导入失败：${error.message}`, 'error');
    }
  }

  function copyLastAssistant() {
    const message = [...activeSession().messages].reverse().find((msg) => msg.role === 'assistant');
    if (!message) return toast('暂无助手回复可复制。');
    copyMessage(message);
  }

  async function copyText(text, message = '已复制') {
    try {
      await navigator.clipboard.writeText(String(text || ''));
      toast(message, 'success');
    } catch (_) {
      const textarea = document.createElement('textarea');
      textarea.value = String(text || '');
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
      toast(message, 'success');
    }
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function toast(message, type = 'info') {
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    els.toastStack.appendChild(node);
    setTimeout(() => node.remove(), type === 'error' ? 6200 : 2800);
  }

  function friendlyError(error) {
    if (!error) return '未知错误';
    if (error.name === 'AbortError') return '请求已停止。';
    const status = error.status;
    const body = tryParseJson(error.body || error.message);
    const detail = body?.error?.message || body?.message || error.message || '';
    const map = {
      400: '请求参数错误。请检查模型、thinking/reasoning_content、tools 或 JSON 设置。',
      401: 'API Key 无效或未授权。',
      402: '账户余额不足，请充值后重试。',
      429: '请求过于频繁，已达到速率限制。',
      500: 'DeepSeek 服务端异常。',
      503: 'DeepSeek 服务暂不可用。',
    };
    return `${status ? `${status} ${map[status] || '请求失败'}` : '网络或请求失败'}${detail ? `\n${detail}` : ''}`;
  }
