export function extractSystemPromptFromJson(data, options = {}) {
  if (typeof data === 'string') return { prompt: data };
  if (!data || typeof data !== 'object') return null;

  if (Array.isArray(data.messages)) {
    const systemMessages = data.messages
      .filter((message) => message?.role === 'system' && typeof message.content === 'string')
      .map((message) => message.content.trim())
      .filter(Boolean);
    if (systemMessages.length) return { prompt: systemMessages.join('\n\n') };
  }

  for (const key of ['systemPrompt', 'system_prompt', 'system', 'instructions', 'prompt', 'content']) {
    if (typeof data[key] === 'string' && data[key].trim()) return { prompt: data[key] };
  }

  if (Array.isArray(data.prompts)) {
    const compiled = compilePromptPreset(data, options);
    if (compiled.prompt.trim()) return { prompt: compiled.prompt, meta: compiled.meta };
  }
  return null;
}

export function parseExternalPresetText(raw, { sourceName = '' } = {}) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('文件内容为空。');

  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return {
      prompt: text,
      parsed: false,
      kind: 'text',
      meta: {
        sourceName,
        originalChars: text.length,
        compiledChars: text.length,
        includedPrompts: 0,
        skippedPrompts: 0,
      },
    };
  }

  if (Array.isArray(data?.prompts)) {
    const compiled = compileSillyTavernPreset(data, {
      generationType: 'normal',
      skipMode: 'none',
    });
    if (compiled.prompt.trim()) {
      return {
        prompt: compiled.prompt,
        messages: compiled.messages,
        layout: compiled.layout,
        settings: compiled.settings,
        parsed: true,
        kind: 'sillytavern-preset',
        meta: {
          ...compiled.meta,
          sourceName,
          originalChars: text.length,
          compiledChars: compiled.prompt.length,
        },
      };
    }
  }

  const extracted = extractSystemPromptFromJson(data, {
    mode: 'jailbreak',
    includeAssistant: true,
    skipMode: 'json-only',
    preserveOutputTemplate: true,
  });
  if (extracted?.prompt?.trim()) {
    return {
      prompt: extracted.prompt.trim(),
      parsed: true,
      kind: Array.isArray(data?.messages) ? 'openai-messages' : 'json-prompt',
      meta: {
        ...(extracted.meta || {}),
        sourceName,
        originalChars: text.length,
        compiledChars: extracted.prompt.trim().length,
      },
    };
  }

  return {
    prompt: text,
    parsed: false,
    kind: 'json-raw-fallback',
    meta: {
      sourceName,
      originalChars: text.length,
      compiledChars: text.length,
      includedPrompts: 0,
      skippedPrompts: 0,
    },
  };
}

export function normalizePromptLibraryImport(data, { uid, nowISO } = {}) {
  const source = Array.isArray(data) ? data : (Array.isArray(data?.promptLibrary) ? data.promptLibrary : []);
  return source
    .map((p) => {
      const promptText = typeof p === 'string' ? p : (p.prompt || p.systemPrompt || p.system_prompt || p.content || '');
      if (!String(promptText).trim()) return null;
      return {
        id: p.id || uid?.('prompt') || `prompt_${Date.now()}`,
        name: p.name || p.title || 'Imported Prompt',
        prompt: String(promptText),
        tags: Array.isArray(p.tags) ? p.tags : [],
        createdAt: p.createdAt || nowISO?.() || new Date().toISOString(),
      };
    })
    .filter(Boolean);
}

export function compilePromptPreset(preset, options = {}) {
  const compiled = compileSillyTavernPreset(preset, {
    generationType: options.generationType || 'normal',
    includeAssistant: options.includeAssistant,
    flattenOnly: true,
    skipMode: options.skipMode,
    preserveOutputTemplate: options.preserveOutputTemplate,
  });
  return { prompt: compiled.prompt, meta: compiled.meta };
}

export function compileSillyTavernPreset(preset, options = {}) {
  const {
    includeAssistant = true,
    flattenOnly = false,
    skipMode = 'system',
    preserveOutputTemplate = false,
    generationType = 'normal',
  } = options;
  const promptMap = new Map();
  for (const prompt of preset.prompts || []) {
    if (prompt && typeof prompt === 'object' && prompt.identifier) promptMap.set(prompt.identifier, prompt);
  }

  const orderList = getSillyTavernPromptOrder(preset);
  const ordered = [];
  for (const orderItem of orderList) {
    const prompt = promptMap.get(orderItem.identifier);
    if (!prompt) continue;
    ordered.push({
      prompt,
      enabled: orderItem.enabled === true && shouldTriggerPrompt(prompt, generationType),
    });
  }

  // A raw prompt list without prompt_order is not an OpenAI preset export, but
  // this fallback keeps the System Prompt importer useful for simple arrays.
  if (!ordered.length) {
    for (const prompt of preset.prompts || []) {
      if (!prompt?.identifier) continue;
      ordered.push({
        prompt,
        enabled: prompt.enabled === true || prompt.enabled === undefined,
      });
    }
  }

  const enabledPrompts = ordered
    .filter(({ prompt, enabled }) => enabled && prompt && promptHasUsableContentOrMarker(prompt) && !shouldSkipImportedPromptChunk(prompt, { skipMode, preserveOutputTemplate }))
    .map(({ prompt }) => prompt);

  const skippedPrompts = ordered
    .filter(({ prompt, enabled }) => enabled && prompt && promptHasUsableContentOrMarker(prompt) && shouldSkipImportedPromptChunk(prompt, { skipMode, preserveOutputTemplate }))
    .map(({ prompt }) => prompt);

  const variables = new Map();
  const preparedPrompts = [];
  for (const prompt of enabledPrompts) {
    if (!includeAssistant && prompt.role === 'assistant' && prompt.system_prompt !== true) continue;
    let content = stripPromptComments(prompt.content || '');
    content = applyVariableMacros(content, variables);
    content = normalizeSillyTavernMacros(content).trim();
    preparedPrompts.push({
      identifier: prompt.identifier,
      name: prompt.name || prompt.identifier || '',
      role: sanitizePromptRole(prompt.role),
      content,
      system_prompt: prompt.system_prompt === true,
      marker: prompt.marker === true,
      injection_position: prompt.injection_position ?? 0,
      injection_depth: prompt.injection_depth ?? 4,
      injection_order: prompt.injection_order ?? 100,
    });
  }

  const layout = flattenOnly
    ? preparedPrompts.filter((prompt) => prompt.content)
    : buildSillyTavernChatCompletionLayout(preparedPrompts);
  const messages = layout
    .filter((prompt) => prompt.content && prompt.injection_position !== 1)
    .map((prompt) => ({
      role: sanitizePromptRole(prompt.role),
      content: prompt.content,
      identifier: prompt.identifier,
      name: prompt.name,
    }));
  const prompt = messages
    .map((message) => message.content)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    prompt,
    messages,
    layout,
    settings: extractSillyTavernGenerationSettings(preset),
    meta: {
      includedPrompts: enabledPrompts.length,
      skippedPrompts: skippedPrompts.length,
      outputParts: messages.length,
      variableCount: variables.size,
      includedPromptNames: enabledPrompts.map((prompt) => prompt.name || prompt.identifier || '').filter(Boolean),
      skippedPromptNames: skippedPrompts.map((prompt) => prompt.name || prompt.identifier || '').filter(Boolean),
    },
  };
}

export function getSillyTavernPromptOrder(preset) {
  const promptOrder = preset?.prompt_order;
  if (Array.isArray(promptOrder?.order)) return promptOrder.order;
  if (Array.isArray(promptOrder?.[0]?.order)) return promptOrder[0].order;
  if (Array.isArray(promptOrder) && promptOrder.every((entry) => entry && typeof entry.identifier === 'string')) return promptOrder;
  return [];
}

function shouldTriggerPrompt(prompt, generationType) {
  if (!Array.isArray(prompt?.injection_trigger)) return true;
  if (!prompt.injection_trigger.length) return true;
  return prompt.injection_trigger.includes(String(generationType || 'normal').toLowerCase().trim());
}

function promptHasUsableContentOrMarker(prompt) {
  return typeof prompt?.content === 'string' || prompt?.marker === true || isSillyTavernDynamicMarker(prompt?.identifier);
}

function applyVariableMacros(text, variables, depth = 0) {
  if (!text || depth > 8) return text || '';
  let next = String(text).replace(/\{\{(setvar|addvar)::([^:}]+)::([\s\S]*?)\}\}/g, (_match, op, rawName, rawValue) => {
    const name = String(rawName || '').trim();
    if (!name) return '';
    const value = String(rawValue || '');
    if (op.toLowerCase() === 'setvar') variables.set(name, value);
    else variables.set(name, `${variables.get(name) || ''}${value}`);
    return '';
  });
  next = next
    .replace(/\{\{getvar::([^}]+)\}\}/gi, (_match, rawName) => variables.get(String(rawName || '').trim()) || '')
    .replace(/\{\{var::([^}]+)\}\}/gi, (_match, rawName) => variables.get(String(rawName || '').trim()) || '');
  return next === text ? next : applyVariableMacros(next, variables, depth + 1);
}

function buildSillyTavernChatCompletionLayout(preparedPrompts) {
  const slots = [];
  const used = new Set();
  const byId = (identifier) => preparedPrompts.find((prompt) => prompt.identifier === identifier);
  const addById = (identifier) => {
    const prompt = byId(identifier);
    if (!prompt || prompt.injection_position === 1) return;
    const index = preparedPrompts.findIndex((item) => item.identifier === identifier);
    if (index < 0) return;
    slots[index] = prompt;
    used.add(identifier);
  };

  // Mirrors SillyTavern's populateChatCompletion() order: marker prompts keep
  // their prompt_order indices, custom non-system_prompt prompts are placed at
  // their own indices, then empty slots are skipped when flattened.
  for (const identifier of [
    'worldInfoBefore',
    'main',
    'worldInfoAfter',
    'charDescription',
    'charPersonality',
    'scenario',
    'personaDescription',
    'nsfw',
    'jailbreak',
  ]) {
    addById(identifier);
  }

  const userRelativePrompts = preparedPrompts
    .filter((prompt) => prompt.system_prompt === false && prompt.injection_position !== 1)
    .map((prompt) => prompt.identifier);
  for (const identifier of userRelativePrompts) addById(identifier);

  addById('enhanceDefinitions');

  return slots.filter(Boolean).filter((prompt) => prompt.content || isSillyTavernDynamicMarker(prompt.identifier));
}

export function isSillyTavernDynamicMarker(identifier) {
  return [
    'worldInfoBefore',
    'worldInfoAfter',
    'charDescription',
    'charPersonality',
    'scenario',
    'personaDescription',
  ].includes(identifier);
}

function sanitizePromptRole(role) {
  return ['system', 'user', 'assistant', 'tool'].includes(role) ? role : 'system';
}

function extractSillyTavernGenerationSettings(preset) {
  const result = {};
  const map = {
    temperature: 'temperature',
    top_p: 'topP',
    presence_penalty: 'presencePenalty',
    frequency_penalty: 'frequencyPenalty',
    openai_max_tokens: 'maxTokens',
    reasoning_effort: 'reasoningEffort',
  };
  for (const [source, target] of Object.entries(map)) {
    if (preset[source] !== undefined && preset[source] !== null && preset[source] !== '') result[target] = preset[source];
  }
  return result;
}

export function stripPromptComments(text) {
  return String(text || '').replace(/\{\{\/\/[\s\S]*?\}\}/g, '');
}

export function normalizeSillyTavernMacros(text) {
  return String(text || '')
    .replace(/\{\{trim\}\}/g, '')
    .replace(/\{\{newline\}\}/g, '\n')
    .replace(/\{\{random::([^}]+)\}\}/gi, (_match, choices) => String(choices || '').split('::')[0] || '')
    .replace(/\n{3,}/g, '\n\n');
}

export function resolveSillyTavernRuntimeMacros(text, context = {}) {
  const now = context.now instanceof Date ? context.now : new Date();
  const lastUserMessage = String(context.lastUserMessage || '');
  const lastMessage = String(context.lastMessage || lastUserMessage || '');
  return String(text || '')
    .replace(/\{\{user\}\}/gi, context.userName || '用户')
    .replace(/\{\{char\}\}/gi, context.charName || '角色')
    .replace(/\{\{lastUserMessage\}\}/gi, lastUserMessage)
    .replace(/\{\{lastMessage\}\}/gi, lastMessage)
    .replace(/\{\{lastMessageId\}\}/gi, String(context.lastMessageId ?? ''))
    .replace(/\{\{original\}\}/gi, context.original || '')
    .replace(/\{\{input\}\}/gi, context.input || lastUserMessage)
    .replace(/\{\{date\}\}/gi, now.toLocaleDateString())
    .replace(/\{\{time\}\}/gi, now.toLocaleTimeString())
    .replace(/\{\{isotime\}\}/gi, now.toISOString())
    .replace(/\{\{weekday\}\}/gi, now.toLocaleDateString(undefined, { weekday: 'long' }))
    .replace(/\{\{newline\}\}/g, '\n')
    .replace(/\{\{trim\}\}/g, '')
    .replace(/\{\{random::([^}]+)\}\}/gi, (_match, choices) => String(choices || '').split('::')[0] || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function shouldSkipImportedPromptChunk(prompt, { skipMode = 'system', preserveOutputTemplate = false } = {}) {
  const name = String(prompt.name || '');
  const id = String(prompt.identifier || '');
  const content = String(prompt.content || '');
  const haystack = `${id}\n${name}\n${content}`;
  const jsonSkips = [
    'rii-prompt',
    '防掉格式',
    'The output format must strictly adhere to the JSON standard',
    'Field order is strictly locked',
    '必须以合法JSON',
    '"end_output"',
  ];
  if (jsonSkips.some((needle) => haystack.includes(needle))) return true;
  if (skipMode === 'none' || skipMode === 'json-only') return false;

  const hardSkips = [
    '<output-template>',
    '输出模板',
    '输出实时总结',
    '行动选项',
    '当前伏笔',
    '大纲规划',
    '思考方式要求',
    '思维链要求',
    '创作指导（<thinking>',
    '用<thinking>包裹思考内容',
  ];
  const effectiveSkips = preserveOutputTemplate
    ? hardSkips.filter((needle) => !['<output-template>', '输出模板'].includes(needle))
    : hardSkips;
  return effectiveSkips.some((needle) => haystack.includes(needle));
}
