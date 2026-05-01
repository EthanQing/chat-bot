export const REGEX_PLACEMENTS = {
  USER_INPUT: 'USER_INPUT',
  AI_OUTPUT: 'AI_OUTPUT',
  SLASH_COMMAND: 'SLASH_COMMAND',
  WORLD_INFO: 'WORLD_INFO',
  REASONING: 'REASONING',
};

export const DEFAULT_REASONING_TEMPLATES = [
  { id: 'think-tags', name: 'Think 标签', regex: { open: '<think\\b[^>]*>', close: '</think>' }, enabled: true },
  { id: 'thinking-tags', name: 'Thinking 标签', regex: { open: '<thinking\\b[^>]*>', close: '</thinking>' }, enabled: true },
  { id: 'analysis-tags', name: 'Analysis 标签', regex: { open: '<analysis\\b[^>]*>', close: '</analysis>' }, enabled: true },
  { id: 'reasoning-tags', name: 'Reasoning 标签', regex: { open: '<reasoning\\b[^>]*>', close: '</reasoning>' }, enabled: true },
];

export const DEFAULT_FORMATTING_SETTINGS = {
  chatDisplayMode: 'default',
  showTagsInResponses: false,
  autoFixMarkdown: true,
  showReasoningBlocks: true,
  allowScopedRegex: false,
  reasoningTemplates: DEFAULT_REASONING_TEMPLATES,
  regexScripts: [],
};

const CUSTOM_BLOCK_TAGS = [
  'custom-style',
  'now_plot',
  'world_situation',
  'status',
  'suggestions',
  'scene',
  'content',
  'ooc',
  'metadata',
  'thinking',
  'think',
  'analysis',
  'reasoning',
  'details',
  'summary',
];

const REGEX_CACHE_LIMIT = 1000;
const regexCache = new Map();
let showdownConverter = null;

export function normalizeFormattingSettings(settings = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  return {
    ...DEFAULT_FORMATTING_SETTINGS,
    ...source,
    chatDisplayMode: ['default', 'bubbles', 'document'].includes(source.chatDisplayMode) ? source.chatDisplayMode : 'default',
    reasoningTemplates: normalizeReasoningTemplates(source.reasoningTemplates),
    regexScripts: normalizeRegexScripts(source.regexScripts),
  };
}

export function normalizeReasoningTemplates(templates = DEFAULT_REASONING_TEMPLATES) {
  const input = Array.isArray(templates) ? templates : DEFAULT_REASONING_TEMPLATES;
  return input.map((template, index) => normalizeReasoningTemplate(template, index));
}

export function normalizeReasoningTemplate(template = {}, index = 0) {
  const regex = template.regex && typeof template.regex === 'object' ? template.regex : {};
  return {
    id: template.id || `reasoning_${index}_${hashText(`${template.name || ''}${regex.open || ''}${regex.close || ''}`)}`,
    name: template.name || `Reasoning 模板 ${index + 1}`,
    regex: {
      open: String(regex.open || template.open || '<think\\b[^>]*>'),
      close: String(regex.close || template.close || '</think>'),
    },
    enabled: template.enabled !== false,
  };
}

export function normalizeRegexScripts(scripts = []) {
  if (!Array.isArray(scripts)) return [];
  return scripts.map((script, index) => normalizeRegexScript(script, index));
}

export function normalizeRegexScript(script = {}, index = 0) {
  const placement = Array.isArray(script.placement)
    ? script.placement
    : Array.isArray(script.placements)
      ? script.placements
      : typeof script.placement === 'string'
        ? script.placement.split(',')
        : [REGEX_PLACEMENTS.AI_OUTPUT];
  return {
    id: script.id || `regex_${index}_${hashText(`${script.scriptName || script.name || ''}${script.findRegex || script.find || ''}`)}`,
    scriptName: script.scriptName || script.name || `Regex 脚本 ${index + 1}`,
    findRegex: String(script.findRegex ?? script.find ?? ''),
    replaceString: String(script.replaceString ?? script.replace ?? ''),
    trimStrings: normalizeStringList(script.trimStrings),
    placement: placement.map((item) => String(item || '').trim()).filter(Boolean),
    disabled: Boolean(script.disabled),
    minDepth: numberOrBlank(script.minDepth),
    maxDepth: numberOrBlank(script.maxDepth),
    substituteRegex: ['none', 'raw', 'escaped'].includes(script.substituteRegex) ? script.substituteRegex : 'none',
    runOnEdit: script.runOnEdit !== false,
    markdownOnly: Boolean(script.markdownOnly),
    promptOnly: Boolean(script.promptOnly),
    scope: script.scope || 'global',
  };
}

export function formatMessageForDisplay(rawText, context = {}, settings = {}, options = {}) {
  const formatting = normalizeFormattingSettings(settings);
  const placement = options.placement || REGEX_PLACEMENTS.AI_OUTPUT;
  const depth = Number.isFinite(options.depth) ? options.depth : 0;
  let content = String(rawText || '');
  let reasoning = String(options.existingReasoning || '');
  let reasoningSignature = String(options.reasoningSignature || '');

  if (options.extractReasoning !== false && placement === REGEX_PLACEMENTS.AI_OUTPUT) {
    const extracted = extractReasoningByTemplates(content, formatting.reasoningTemplates, {
      streaming: Boolean(options.streaming),
    });
    if (extracted.changed) {
      content = extracted.content;
      reasoning = [reasoning, extracted.reasoning].filter(Boolean).join('\n\n');
      reasoningSignature ||= extracted.reasoning_signature || '';
    }
  }

  content = applyRegexScripts(content, formatting.regexScripts, {
    placement,
    mode: 'display',
    context,
    depth,
  });
  reasoning = applyRegexScripts(reasoning, formatting.regexScripts, {
    placement: REGEX_PLACEMENTS.REASONING,
    mode: 'display',
    context,
    depth,
  });

  content = replaceMacros(content, context);
  reasoning = replaceMacros(reasoning, context);

  if (formatting.autoFixMarkdown && options.streaming) {
    content = autoFixMarkdown(content);
  }

  return { content, reasoning, reasoning_signature: reasoningSignature };
}

export function formatMessageForPrompt(rawText, context = {}, settings = {}, options = {}) {
  const formatting = normalizeFormattingSettings(settings);
  const placement = options.placement || REGEX_PLACEMENTS.USER_INPUT;
  const depth = Number.isFinite(options.depth) ? options.depth : 0;
  let content = String(rawText || '');
  content = applyRegexScripts(content, formatting.regexScripts, {
    placement,
    mode: 'prompt',
    context,
    depth,
  });
  return replaceMacros(content, context);
}

export function applyPersistentRegexScripts(rawText, context = {}, settings = {}, options = {}) {
  const formatting = normalizeFormattingSettings(settings);
  return applyRegexScripts(rawText, formatting.regexScripts, {
    placement: options.placement || REGEX_PLACEMENTS.AI_OUTPUT,
    mode: 'persistent',
    context,
    depth: Number.isFinite(options.depth) ? options.depth : 0,
    runOnEdit: Boolean(options.runOnEdit),
  });
}

export function extractReasoningByTemplates(rawText, templates = DEFAULT_REASONING_TEMPLATES, options = {}) {
  let content = String(rawText || '');
  const reasoningParts = [];
  let changed = false;

  for (const template of normalizeReasoningTemplates(templates)) {
    if (!template.enabled || !template.regex.open || !template.regex.close) continue;
    let guard = 0;
    while (guard < 20) {
      guard += 1;
      const openRe = compileLooseRegex(template.regex.open, 'i');
      if (!openRe) break;
      const openMatch = openRe.exec(content);
      if (!openMatch) break;
      const openStart = openMatch.index ?? 0;
      const openEnd = openStart + openMatch[0].length;
      const rest = content.slice(openEnd);
      const closeRe = compileLooseRegex(template.regex.close, 'i');
      if (!closeRe) break;
      const closeMatch = closeRe.exec(rest);
      if (!closeMatch) {
        if (!options.streaming) break;
        const thought = rest.trim();
        if (thought) reasoningParts.push(thought);
        content = content.slice(0, openStart).trimEnd();
        changed = true;
        break;
      }
      const closeStart = openEnd + (closeMatch.index ?? 0);
      const closeEnd = closeStart + closeMatch[0].length;
      const thought = content.slice(openEnd, closeStart).trim();
      if (thought) reasoningParts.push(thought);
      content = `${content.slice(0, openStart)}${content.slice(closeEnd)}`;
      changed = true;
    }
  }

  return {
    changed,
    content: content.trim(),
    reasoning: reasoningParts.join('\n\n').trim(),
    reasoning_signature: '',
  };
}

export function applyRegexScripts(rawText, scripts = [], options = {}) {
  const mode = options.mode || 'display';
  let text = String(rawText || '');
  const placement = options.placement || REGEX_PLACEMENTS.AI_OUTPUT;
  const depth = Number.isFinite(options.depth) ? options.depth : 0;

  for (const script of normalizeRegexScripts(scripts)) {
    if (!shouldRunRegexScript(script, { placement, mode, depth, runOnEdit: options.runOnEdit })) continue;
    for (const trim of script.trimStrings) {
      if (trim) text = text.split(trim).join('');
    }
    if (!script.findRegex) continue;
    const pattern = script.substituteRegex === 'none'
      ? script.findRegex
      : replaceMacros(script.findRegex, options.context || {}, { regexEscape: script.substituteRegex === 'escaped' });
    const regex = getCachedRegex(pattern);
    if (!regex) continue;
    const replacement = replaceMacros(script.replaceString, options.context || {});
    try {
      text = text.replace(regex, replacement);
    } catch (error) {
      console.warn(`Regex script failed: ${script.scriptName}`, error);
    }
  }
  return text;
}

function shouldRunRegexScript(script, { placement, mode, depth, runOnEdit }) {
  if (script.disabled) return false;
  if (runOnEdit && !script.runOnEdit) return false;
  if (script.placement.length && !script.placement.includes(placement)) return false;
  if (script.minDepth !== '' && depth < script.minDepth) return false;
  if (script.maxDepth !== '' && depth > script.maxDepth) return false;
  if (mode === 'display') return script.markdownOnly || (script.markdownOnly && script.promptOnly);
  if (mode === 'prompt') return script.promptOnly || (script.markdownOnly && script.promptOnly);
  if (mode === 'persistent') return !script.markdownOnly && !script.promptOnly;
  return false;
}

export function replaceMacros(rawText, context = {}, options = {}) {
  const text = String(rawText || '');
  return text.replace(/\{\{([^{}]+)\}\}/g, (match, inner) => {
    const value = resolveMacro(inner.trim(), context);
    const resolved = value === null || value === undefined ? match : String(value);
    return options.regexEscape ? escapeRegex(resolved) : resolved;
  });
}

function resolveMacro(inner, context) {
  const key = String(inner || '').trim();
  const lower = key.toLowerCase();
  if (key.startsWith('//')) return '';
  if (lower === 'char') return context.charName ?? context.char ?? '角色';
  if (lower === 'user') return context.userName ?? context.user ?? '你';
  if (lower === 'time') return formatMacroTime(context.now || new Date());
  if (lower === 'date') return formatMacroDate(context.now || new Date());
  if (lower === 'idle_duration') return context.idleDuration || '';
  if (lower === 'input') return context.input || '';
  if (lower === 'lastmessage') return context.lastMessage || '';
  if (lower === 'lastexpression') return context.lastExpression || '';
  if (lower === 'mesid') return context.mesId || '';
  if (lower.startsWith('random::')) {
    const choices = inner.slice('random::'.length).split('::').filter(Boolean);
    if (!choices.length) return '';
    return choices[Math.floor(Math.random() * choices.length)];
  }
  if (lower.startsWith('roll:')) return rollDice(key.slice('roll:'.length));
  return null;
}

export function autoFixMarkdown(rawText) {
  let text = String(rawText || '');
  if (!text) return text;
  if (countUnescaped(text, '```') % 2 === 1) {
    text += '\n```';
    return text;
  }
  if (countInlineBackticks(text) % 2 === 1) text += '`';
  if (countUnescaped(text, '**') % 2 === 1) text += '**';
  const withoutBold = text.replace(/\*\*/g, '');
  if (countUnescaped(withoutBold, '*') % 2 === 1) text += '*';
  if (countUnescaped(text, '~~') % 2 === 1) text += '~~';
  return text;
}

export function renderMarkdownToHtml(rawText, options = {}) {
  const source = options.showTagsInResponses ? String(rawText || '') : escapeAngleBrackets(rawText || '');
  let html = '';
  if (window.showdown) {
    if (!showdownConverter) {
      showdownConverter = new window.showdown.Converter({
        emoji: true,
        literalMidWordUnderscores: true,
        parseImgDimensions: true,
        tables: true,
        underline: true,
        simpleLineBreaks: true,
        strikethrough: true,
        disableForced4SpacesIndentedSublists: true,
        openLinksInNewWindow: true,
      });
    }
    html = showdownConverter.makeHtml(source);
  } else if (window.marked) {
    html = window.marked.parse(source, {
      gfm: true,
      breaks: true,
      mangle: false,
      headerIds: false,
    });
  } else {
    html = `<p>${source.replace(/\n/g, '<br>')}</p>`;
  }
  return postProcessCustomTagBreaks(html);
}

function escapeAngleBrackets(value) {
  return String(value || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function sanitizeFormattedHtml(html, options = {}) {
  if (!window.DOMPurify) return html;
  const addTags = options.showTagsInResponses ? CUSTOM_BLOCK_TAGS : ['details', 'summary'];
  return window.DOMPurify.sanitize(html, {
    ADD_TAGS: addTags,
    ADD_ATTR: ['target', 'rel', 'class', 'style', 'open', 'title', 'width', 'height', 'align'],
  });
}

export function highlightDialogueQuotesInElement(root) {
  if (!root || !document.createTreeWalker) return;
  const quotePattern = /("[^"\n]{1,800}"|“[^”\n]{1,800}”|«[^»\n]{1,800}»|「[^」\n]{1,800}」|『[^』\n]{1,800}』|＂[^＂\n]{1,800}＂)/g;
  const excluded = new Set(['CODE', 'PRE', 'KBD', 'SAMP', 'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'A']);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue || '';
      if (!value || !quotePattern.test(value)) return NodeFilter.FILTER_REJECT;
      quotePattern.lastIndex = 0;
      let parent = node.parentElement;
      while (parent) {
        if (excluded.has(parent.tagName) || parent.classList?.contains('dialogue')) return NodeFilter.FILTER_REJECT;
        parent = parent.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) wrapDialogueQuotes(node, quotePattern);
}

function wrapDialogueQuotes(textNode, quotePattern) {
  const text = textNode.nodeValue || '';
  const fragment = document.createDocumentFragment();
  let last = 0;
  quotePattern.lastIndex = 0;
  for (const match of text.matchAll(quotePattern)) {
    const index = match.index ?? 0;
    if (index > last) fragment.appendChild(document.createTextNode(text.slice(last, index)));
    const span = document.createElement('span');
    span.className = 'dialogue';
    span.textContent = match[0];
    fragment.appendChild(span);
    last = index + match[0].length;
  }
  if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)));
  textNode.replaceWith(fragment);
}

function getCachedRegex(pattern) {
  const parsed = parseRegexLiteral(pattern);
  if (!parsed.source) return null;
  const flags = parsed.flags.includes('g') ? parsed.flags : `${parsed.flags}g`;
  const key = `${parsed.source}\u0001${flags}`;
  if (regexCache.has(key)) {
    const cached = regexCache.get(key);
    regexCache.delete(key);
    regexCache.set(key, cached);
    cached.lastIndex = 0;
    return cached;
  }
  try {
    const regex = new RegExp(parsed.source, flags);
    regexCache.set(key, regex);
    if (regexCache.size > REGEX_CACHE_LIMIT) regexCache.delete(regexCache.keys().next().value);
    return regex;
  } catch (error) {
    console.warn('Invalid regex script pattern', pattern, error);
    return null;
  }
}

function compileLooseRegex(pattern, defaultFlags = '') {
  const parsed = parseRegexLiteral(pattern);
  if (!parsed.source) return null;
  const flags = mergeFlags(parsed.flags || defaultFlags, defaultFlags);
  try {
    return new RegExp(parsed.source, flags.replace('g', ''));
  } catch (_) {
    return null;
  }
}

function parseRegexLiteral(pattern) {
  const raw = String(pattern || '');
  const literal = raw.match(/^\/([\s\S]*)\/([a-z]*)$/i);
  if (literal) return { source: literal[1], flags: sanitizeFlags(literal[2]) };
  return { source: raw, flags: 'gm' };
}

function sanitizeFlags(flags) {
  return [...new Set(String(flags || '').replace(/[^dgimsuvy]/g, '').split(''))].join('');
}

function mergeFlags(a, b) {
  return sanitizeFlags(`${a || ''}${b || ''}`);
}

function postProcessCustomTagBreaks(html) {
  let result = String(html || '');
  for (const tag of CUSTOM_BLOCK_TAGS) {
    const openOrClose = new RegExp(`(<\\/?${tag}\\b[^>]*>)\\s*<br\\s*\\/?>`, 'gi');
    const beforeClose = new RegExp(`<br\\s*\\/?>\\s*(<\\/${tag}>)`, 'gi');
    let previous = '';
    let guard = 0;
    while (previous !== result && guard < 10) {
      previous = result;
      result = result.replace(openOrClose, '$1').replace(beforeClose, '$1');
      guard += 1;
    }
  }
  return result;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '')).filter(Boolean);
  if (typeof value === 'string') return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function numberOrBlank(value) {
  if (value === '' || value === null || value === undefined) return '';
  const number = Number(value);
  return Number.isFinite(number) ? number : '';
}

function countUnescaped(text, token) {
  let count = 0;
  for (let index = 0; index < text.length;) {
    const found = text.indexOf(token, index);
    if (found < 0) break;
    if (!isEscaped(text, found)) count += 1;
    index = found + token.length;
  }
  return count;
}

function countInlineBackticks(text) {
  const withoutFences = String(text || '').replace(/```[\s\S]*?```/g, '');
  return countUnescaped(withoutFences, '`');
}

function isEscaped(text, index) {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function rollDice(spec) {
  const match = String(spec || '').trim().match(/^(\d{1,3})d(\d{1,5})$/i);
  if (!match) return '';
  const count = Math.min(100, Number.parseInt(match[1], 10));
  const sides = Math.max(1, Math.min(100000, Number.parseInt(match[2], 10)));
  let sum = 0;
  for (let i = 0; i < count; i += 1) sum += 1 + Math.floor(Math.random() * sides);
  return String(sum);
}

function formatMacroTime(value) {
  try {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (_) {
    return '';
  }
}

function formatMacroDate(value) {
  try {
    return new Date(value).toLocaleDateString();
  } catch (_) {
    return '';
  }
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hashText(text) {
  let hash = 2166136261;
  for (let index = 0; index < String(text || '').length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
