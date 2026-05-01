// Message parsing intentionally follows SillyTavern's separation model:
// - visible reply text stays in `content`
// - model/parsed reasoning may be used transiently while streaming/parsing, but
//   normal chat saves should not mirror it back into every message
// - model-side bookkeeping/status blocks are stripped from the visible reply
// - raw API text is never rewritten
//
// Keep these parsers conservative. If a role card / jailbreak asks for a custom
// format, broad regexes can easily eat the actual story. Only explicit wrappers
// are removed from the visible bubble by default.

export function ensureAssistantExtra(message) {
  if (!message || message.role !== 'assistant') return message;
  if (!message.extra || typeof message.extra !== 'object') message.extra = {};

  // Backward compatibility: older saves used top-level fields only.
  if (!message.reasoning_content && message.extra.reasoning) {
    message.reasoning_content = message.extra.reasoning;
  }
  delete message.card_state;
  delete message.extra.role_state;
  if (!message.raw_content && message.extra.raw_content) {
    message.raw_content = message.extra.raw_content;
  }
  if (!message.raw_reasoning_content && message.extra.raw_reasoning_content) {
    message.raw_reasoning_content = message.extra.raw_reasoning_content;
  }

  syncAssistantExtraAliases(message);
  return message;
}

export function syncAssistantExtraAliases(message) {
  if (!message || message.role !== 'assistant') return message;
  if (!message.extra || typeof message.extra !== 'object') message.extra = {};

  if (message.reasoning_content) {
    message.extra.reasoning = message.reasoning_content;
    message.extra.reasoning_type = message.extra.reasoning_type || 'model-or-parsed';
  } else {
    delete message.extra.reasoning;
    delete message.extra.reasoning_type;
    delete message.extra.reasoning_duration;
  }
  delete message.card_state;
  delete message.extra.role_state;
  delete message.extra.raw_content;
  delete message.extra.raw_reasoning_content;
  delete message.extra.raw_content_before_parse;
  delete message.extra.raw_reasoning_before_parse;
  return message;
}

export function normalizeAssistantView(view) {
  if (view.role !== 'assistant') return view;
  let normalized = {
    ...view,
    extra: { ...(view.extra || {}) },
    reasoning_content: view.reasoning_content || view.extra?.reasoning || '',
    card_state: '',
    raw_content: view.raw_content || view.extra?.raw_content || '',
    raw_reasoning_content: view.raw_reasoning_content || view.extra?.raw_reasoning_content || '',
    raw_content_before_parse: view.raw_content_before_parse || view.extra?.raw_content_before_parse || '',
    raw_reasoning_before_parse: view.raw_reasoning_before_parse || view.extra?.raw_reasoning_before_parse || '',
  };

  const leak = extractFinalAnswerFromReasoning(normalized.reasoning_content || '', normalized.content || '');
  if (leak.changed) {
    normalized = {
      ...normalized,
      reasoning_content: leak.reasoning,
      content: mergeLeakedContent(leak.content, normalized.content || ''),
    };
  }

  const extracted = extractVisibleThinkingBlocks(normalized.content || '');
  if (extracted.changed) {
    const split = splitLeakedAnswerFromExtractedThinking(extracted.thinking, extracted.content);
    normalized = {
      ...normalized,
      content: mergeLeakedContent(split.content, extracted.content),
      reasoning_content: [normalized.reasoning_content, split.reasoning].filter(Boolean).join('\n\n'),
    };
  }

  const postExtractLeak = extractFinalAnswerFromReasoning(normalized.reasoning_content || '', normalized.content || '');
  if (postExtractLeak.changed) {
    normalized = {
      ...normalized,
      reasoning_content: postExtractLeak.reasoning,
      content: mergeLeakedContent(postExtractLeak.content, normalized.content || ''),
    };
  }

  const redundantStructured = stripRedundantStructuredReplyBlocks(normalized.content || '');
  if (redundantStructured.changed) {
    normalized = {
      ...normalized,
      content: redundantStructured.content,
    };
  }

  const suggestionsExtracted = extractSuggestionsBlocks(normalized.content || '');
  if (suggestionsExtracted.changed) {
    normalized = {
      ...normalized,
      content: suggestionsExtracted.content,
      suggestions: mergeSuggestions(normalized.suggestions, suggestionsExtracted.suggestions),
    };
  }

  const stateExtracted = extractRoleCardMetadataBlocks(normalized.content || '');
  if (stateExtracted.changed) {
    normalized = {
      ...normalized,
      content: stateExtracted.content,
      card_state: '',
    };
  }

  normalized.extra = {
    ...normalized.extra,
    reasoning: normalized.reasoning_content || '',
  };
  delete normalized.extra.role_state;
  return normalized;
}

export function foldVisibleThinkingIntoAssistant(message) {
  if (!message || message.role !== 'assistant') return;
  ensureAssistantExtra(message);

  const leak = extractFinalAnswerFromReasoning(message.reasoning_content || '', message.content || '');
  if (leak.changed) {
    message.reasoning_content = leak.reasoning;
    message.content = mergeLeakedContent(leak.content, message.content || '');
  }

  const extracted = extractVisibleThinkingBlocks(message.content || '');
  if (extracted.changed) {
    const split = splitLeakedAnswerFromExtractedThinking(extracted.thinking, extracted.content);
    message.content = mergeLeakedContent(split.content, extracted.content);
    message.reasoning_content = [message.reasoning_content, split.reasoning].filter(Boolean).join('\n\n');
  }

  const postExtractLeak = extractFinalAnswerFromReasoning(message.reasoning_content || '', message.content || '');
  if (postExtractLeak.changed) {
    message.reasoning_content = postExtractLeak.reasoning;
    message.content = mergeLeakedContent(postExtractLeak.content, message.content || '');
  }

  const redundantStructured = stripRedundantStructuredReplyBlocks(message.content || '');
  if (redundantStructured.changed) {
    message.content = redundantStructured.content;
  }

  foldSuggestionsIntoAssistant(message);
  stripRoleCardMetadataFromAssistant(message);
  syncAssistantExtraAliases(message);
}

function splitLeakedAnswerFromExtractedThinking(thinkingText, visibleContent = '') {
  const thinking = String(thinkingText || '');
  if (!thinking.trim()) return { reasoning: '', content: '' };
  const leak = extractFinalAnswerFromReasoning(thinking, visibleContent, {
    // If a model wrote an opening <thinking> tag into the visible content and
    // forgot to close it, the real answer can begin immediately after a "正文"
    // marker. In that malformed-wrapper case we should not require the marker
    // to appear late in the text.
    allowEarlyBoundary: !String(visibleContent || '').trim(),
  });
  if (!leak.changed) return { reasoning: thinking, content: '' };
  return {
    reasoning: leak.reasoning,
    content: leak.content,
  };
}

export function extractFinalAnswerFromReasoning(reasoningContent, visibleContent = '', options = {}) {
  const reasoning = String(reasoningContent || '');
  if (!reasoning.trim()) return { changed: false, reasoning, content: '' };
  const hasVisibleContent = Boolean(String(visibleContent || '').trim());
  const allowEarlyBoundary = Boolean(options?.allowEarlyBoundary);

  const candidates = collectFinalAnswerCandidates(reasoning, { relaxed: !hasVisibleContent });
  for (const candidate of candidates) {
    const { answer, cutIndex, explicit } = candidate;
    if (!explicit && !allowEarlyBoundary && cutIndex < reasoning.length * (hasVisibleContent ? 0.35 : 0.15)) continue;
    if (!looksLikeVisibleAnswer(answer)) continue;
    if (visibleContent && visibleContent.includes(answer.slice(0, Math.min(answer.length, 80)))) {
      return { changed: false, reasoning, content: '' };
    }

    const keptReasoning = cutIndex >= 0
      ? reasoning.slice(0, cutIndex).replace(/<\/?(thinking|think|analysis|reasoning)\b[^>]*>/gi, '').trim()
      : reasoning;

    return {
      changed: true,
      reasoning: keptReasoning,
      content: cleanLeakedAnswer(answer),
    };
  }
  return { changed: false, reasoning, content: '' };
}

function collectFinalAnswerCandidates(reasoning, { relaxed = false } = {}) {
  const candidates = [];
  const add = (cutIndex, answer, explicit = false) => {
    const clean = cleanLeakedAnswer(answer);
    if (clean.trim()) candidates.push({ cutIndex, answer: clean, explicit });
  };
  const source = String(reasoning || '');

  for (const match of source.matchAll(/<\/(?:thinking|think|analysis|reasoning)>/gi)) {
    add(match.index ?? 0, source.slice((match.index ?? 0) + match[0].length), true);
  }

  for (const match of source.matchAll(/(?:^|\n)(\s*)<content\b[^>]*>/gi)) {
    const start = match.index ?? 0;
    const answerStart = start + match[0].length;
    add(start, source.slice(answerStart), true);
  }

  for (const match of source.matchAll(/(?:^|\n)(\s*)<(?:final|answer|response|output|正文|回复正文)\b[^>]*>/gi)) {
    const start = match.index ?? 0;
    const answerStart = start + match[0].length;
    add(start, source.slice(answerStart), true);
  }

  for (const match of source.matchAll(/(?:^|\n)(\s*)<scene\b[^>]*>/gi)) {
    const start = match.index ?? 0;
    // Only use <scene> as a recovery marker if there is no later <content>.
    const rest = source.slice(start);
    if (/(?:^|\n)\s*<content\b[^>]*>/i.test(rest)) continue;
    add(start, rest, true);
  }

  const headingPattern = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:【\s*)?(正文|最终回答|最终回复|回复正文|正式回复|正式输出|content|final answer|final response)(?:\s*】)?\s*[:：]?\s*(?:\n|$)/gi;
  for (const match of source.matchAll(headingPattern)) {
    const start = match.index ?? 0;
    add(start, source.slice(start + match[0].length), false);
  }

  const phrasePattern = /(?:^|\n)\s*(?:现在|下面|以下)?(?:开始|输出|给出|进入|撰写)?\s*(?:最终|正式)?(?:正文|回答|回复|内容)\s*(?:如下)?\s*[:：]\s*/gi;
  for (const match of source.matchAll(phrasePattern)) {
    const start = match.index ?? 0;
    add(start, source.slice(start + match[0].length), false);
  }

  if (relaxed) {
    const narrative = recoverTrailingNarrative(source);
    if (narrative) add(narrative.cutIndex, narrative.answer, false);
  }

  // Prefer the latest plausible boundary. This avoids extracting prompt
  // templates mentioned earlier in the model's chain-of-thought.
  return candidates.sort((a, b) => b.cutIndex - a.cutIndex);
}

function recoverTrailingNarrative(source) {
  const text = String(source || '');
  const lines = text.split(/\r?\n/);
  const offsets = [];
  let runningIndex = 0;
  for (const line of lines) {
    offsets.push(runningIndex);
    runningIndex += line.length + 1;
  }
  const narrativeLine = /[“”「」「」『』]|[\u4e00-\u9fff].*[。！？!?]$|<\/?(scene|content|role_state|suggestions)\b/i;
  const metaLine = /(phase\s*\d+|information organization|plot thread|story settings|knowledge categorization|challenges?|solutions?|refinement|preparing to write|思考|分析|要求|规则|准则|提示词|必须|需要|判断|规划|伏笔|总结|优化|创作指导|上下文|instruction|context|challenge|solution)/i;
  const structuralMetaLine = /^\s*(?:[-*+]\s*)?(?:\*\*)?(?:phase\s*\d+|context|plot thread|story settings|knowledge categorization|challenges?|solutions?|refinement|requirements?|rules?)\b/i;
  const isMeta = (line) => {
    const value = line.trim();
    if (!value) return false;
    if (structuralMetaLine.test(value)) return true;
    if (/^<kbd\b/i.test(value)) return true;
    if (/^#{1,6}\s*(?:phase|context|思考|分析|规划|要求|规则)/i.test(value)) return true;
    if (/^\s*(?:[-*+]\s*)?(?:我们|我|本轮|此次|需要|必须|确定|分析|思考|判断|结合|保证|避免|严格|输出前)/.test(value) && metaLine.test(value)) return true;
    return false;
  };
  const isNarrative = (line) => {
    const value = line.trim();
    if (!value || isMeta(value)) return false;
    if (/^\s*(?:[-*+]\s*)?(?:\d+[.)、]\s*)?(?:短期伏笔|长期伏笔|行动选项|实时总结|大纲|逻辑判断)/.test(value)) return false;
    return narrativeLine.test(value);
  };

  let lastNarrative = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isNarrative(lines[index])) {
      lastNarrative = index;
      break;
    }
  }
  if (lastNarrative < 0) return null;

  let start = lastNarrative;
  for (let index = lastNarrative - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) {
      start = index;
      continue;
    }
    if (isMeta(line)) {
      start = index + 1;
      break;
    }
    // Keep normal story paragraphs, dialogue, XML-ish scene/content/status tags
    // and short markdown headings that are part of the visible answer.
    if (
      isNarrative(line) ||
      /^<\/?(scene|content|role_state|suggestions)\b/i.test(line) ||
      /^#{1,6}\s*(正文|场景|回复|content)/i.test(line) ||
      /^[>]*\s*[“”「」『』]/.test(line) ||
      line.length <= 80
    ) {
      start = index;
      continue;
    }
    start = index + 1;
    break;
  }

  while (start < lines.length && !lines[start].trim()) start += 1;
  const charIndex = offsets[start] ?? 0;
  if (start < 0 || charIndex < text.length * 0.45) return null;
  const answer = lines.slice(start).join('\n').trim();
  const narrativeCount = lines.slice(start).filter(isNarrative).length;
  if (answer.length < 120 || narrativeCount < 2) return null;
  return { cutIndex: charIndex, answer };
}

function looksLikeVisibleAnswer(text) {
  const value = String(text || '').trim();
  if (value.length < 20) return false;
  if (/^(phase\s*\d+|information organization|context|plot thread|challenges|solutions|refinement)\b/i.test(value)) return false;
  if (/^(我们需要|我需要|现在需要|<kbd>|[*#\s-]*(?:Phase|Context|Challenges|Solutions)\b)/i.test(value)) return false;
  if (/^(内的正文|为固定占位符|输出模板|格式示例|规则如下|具体如下)/.test(value)) return false;
  return /[\u4e00-\u9fff]|[.!?。！？]/.test(value);
}

function cleanLeakedAnswer(text) {
  let value = String(text || '')
    .replace(/^#{1,6}\s*(正文|最终回答|最终回复|回复正文|正式回复|正式输出|content|final answer|final response)\s*[:：]?\s*/i, '')
    .replace(/^<(content|final|answer|response|output|正文|回复正文)\b[^>]*>/i, '')
    .replace(/<\/(content|final|answer|response|output|正文|回复正文)>\s*$/i, '')
    .trim();
  value = value
    .replace(/^\s*<\/(?:thinking|think|analysis|reasoning)>\s*/i, '')
    .replace(/^\s*#{1,6}\s*(正文|最终回答|最终回复|回复正文|正式回复|正式输出|content|final answer|final response)\s*[:：]?\s*/i, '')
    .replace(/^\s*<(?:content|final|answer|response|output|正文|回复正文)\b[^>]*>\s*/i, '')
    .replace(/\s*<\/(?:content|final|answer|response|output|正文|回复正文)>\s*/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return value;
}

function mergeLeakedContent(leaked, existing) {
  const a = String(leaked || '').trim();
  const b = String(existing || '').trim();
  if (!a) return b;
  if (!b) return a;
  if (b.includes(a) || a.includes(b)) return a.length >= b.length ? a : b;
  return `${a}\n\n${b}`.trim();
}

export function stripRoleCardMetadataFromAssistant(message) {
  if (!message || message.role !== 'assistant') return;
  ensureAssistantExtra(message);
  const extracted = extractRoleCardMetadataBlocks(message.content || '');
  if (!extracted.changed) {
    syncAssistantExtraAliases(message);
    return;
  }
  message.content = extracted.content;
  delete message.card_state;
  syncAssistantExtraAliases(message);
}

export function foldSuggestionsIntoAssistant(message) {
  if (!message || message.role !== 'assistant') return;
  const extracted = extractSuggestionsBlocks(message.content || '');
  if (!extracted.changed) return;
  message.content = extracted.content;
  message.suggestions = mergeSuggestions(message.suggestions, extracted.suggestions);
}

export function extractVisibleThinkingBlocks(content) {
  let text = String(content || '');
  const parts = [];
  let changed = false;

  text = text.replace(/<(thinking|think)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, inner) => {
    changed = true;
    if (String(inner).trim()) parts.push(String(inner).trim());
    return '\n';
  });

  // Streaming / malformed case: the opening tag is present but the closing tag
  // has not arrived. Hide it from the bubble and show it in the reasoning panel.
  text = text.replace(/<(thinking|think)\b[^>]*>([\s\S]*)$/i, (_match, _tag, inner) => {
    changed = true;
    if (String(inner).trim()) parts.push(String(inner).trim());
    return '\n';
  });

  text = text.replace(/<\/(thinking|think)>/gi, () => {
    changed = true;
    return '';
  });

  return {
    changed,
    thinking: parts.join('\n\n').trim(),
    content: text.replace(/\n{3,}/g, '\n\n').trimStart(),
  };
}

export function stripRedundantStructuredReplyBlocks(content) {
  let text = String(content || '');
  let changed = false;

  const replaceBlockWithInner = (pattern) => {
    text = text.replace(pattern, (_match, inner) => {
      changed = true;
      return `\n${String(inner || '').trim()}\n`;
    });
  };

  // Keep useful scene/content text, but never show the XML wrapper tags.
  replaceBlockWithInner(/<scene\b[^>]*>([\s\S]*?)<\/scene>/gi);
  replaceBlockWithInner(/<content\b[^>]*>([\s\S]*?)<\/content>/gi);
  text = text
    .replace(/<\/?(?:scene|content)\b[^>]*>/gi, () => {
      changed = true;
      return '\n';
    });

  // Non-standard "thinking" wrappers often appear as invalid XML-ish tags,
  // e.g. <intermittent thinking>...</intermittent thinking>. Treat them as
  // hidden planning notes, not user-visible content.
  text = text.replace(/<intermittent\s+thinking\b[^>]*>[\s\S]*?<\/intermittent\s+thinking>/gi, () => {
    changed = true;
    return '\n';
  });
  text = text.replace(/<intermittent\s+thinking\b[^>]*>[\s\S]*$/i, () => {
    changed = true;
    return '\n';
  });

  text = text.replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, (match) => {
    const summary = (match.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1] || '')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (isRedundantDetailsSummary(summary) || /<\/?(?:foreshadowings|outlines|logic-optimization|logic_optimization|summary)\b/i.test(match)) {
      changed = true;
      return '\n';
    }
    return match;
  });

  // Remove model-side bookkeeping that this app no longer needs to render:
  // live summaries, foreshadowing trackers, outline guesses and logic audits.
  text = removeNamedBlocks(text, [
    'logic-optimization',
    'logic_optimization',
    'logicOptimization',
    'intermittent',
    'intermittent_thinking',
    'intermittent-thinking',
    'po',
    'plot_outline',
    'plot-outline',
    'plot',
    'foreshadowings',
    'outlines',
    'outline',
    'summary',
    'role_state',
    'status',
    'character_state',
    'card_state',
    '实时总结',
    '当前伏笔',
    '大纲推测',
    '逻辑优化',
    '间断思考',
    '剧情模块',
    '推进模块',
    '插入模块',
    '角色状态',
    '状态栏',
    '元数据',
  ], () => { changed = true; });

  text = text.replace(/<details\b[^>]*>\s*<\/details>/gi, () => {
    changed = true;
    return '\n';
  });

  // Remove round counters such as <c>当前输出内容第1次</c>.
  text = text.replace(/<c\b[^>]*>\s*(?:当前)?输出内容第?\d+次\s*<\/c>/gi, () => {
    changed = true;
    return '\n';
  });

  // Logic audits are often hidden in HTML comments; after escaping tags they
  // would become visible, so discard comment blocks that clearly are audits.
  text = text.replace(/<!--([\s\S]*?)-->/g, (match, inner) => {
    if (/(逻辑判断|变量\/数据|下一次输出必须参考|现在，逻辑判断结束|OOC问题|世界观错误|间断思考|剧情模块|推进模块|插入模块|输出模块|禁库词汇|重复句式)/.test(inner)) {
      changed = true;
      return '\n';
    }
    return match;
  });

  text = text
    .replace(/\n[ \t]+\n/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { changed, content: text };
}

function removeNamedBlocks(source, names, onChange) {
  let text = String(source || '');
  for (const name of names) {
    const escaped = escapeRegex(name);
    const pattern = new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*?<\\/${escaped}>`, 'gi');
    text = text.replace(pattern, () => {
      onChange?.();
      return '\n';
    });
    const openPattern = new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*$`, 'i');
    text = text.replace(openPattern, () => {
      onChange?.();
      return '\n';
    });
  }
  return text;
}

function isRedundantDetailsSummary(summary) {
  const value = String(summary || '').replace(/\s+/g, '');
  if (!value) return false;
  return /(实时总结|当前总结|剧情总结|当前伏笔|伏笔|大纲推测|大纲规划|大纲|逻辑优化|逻辑判断|间断思考|剧情模块|推进模块|插入模块|输出审查|自检|状态追踪|变量追踪|角色状态|元数据|状态栏|role_state|card_state|character_state|status|intermittent|plot|outline)/i.test(value);
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractRoleCardMetadataBlocks(content) {
  let text = String(content || '');
  const parts = [];
  let changed = false;

  const tagPattern = /<(role_state|status|character_state|card_state|角色状态|状态栏|元数据)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  text = text.replace(tagPattern, (_match, tag, inner) => {
    changed = true;
    if (String(inner).trim()) parts.push(formatMetadataBlock(tag, inner));
    return '\n';
  });

  const openTagPattern = /<(role_state|status|character_state|card_state|角色状态|状态栏|元数据)\b[^>]*>([\s\S]*)$/i;
  text = text.replace(openTagPattern, (_match, tag, inner) => {
    changed = true;
    if (String(inner).trim()) parts.push(formatMetadataBlock(tag, inner));
    return '\n';
  });

  const detailsPattern = /<details\b[^>]*>\s*<summary>\s*(role_state|status|character_state|card_state|角色状态(?:\s*[\/／]\s*元数据)?|状态栏|元数据)\s*<\/summary>([\s\S]*?)<\/details>/gi;
  text = text.replace(detailsPattern, (_match, tag, inner) => {
    changed = true;
    const clean = String(inner || '').replace(/<\/?pre\b[^>]*>/gi, '').trim();
    if (clean) parts.push(formatMetadataBlock(tag, clean));
    return '\n';
  });

  return {
    changed,
    metadata: parts.join('\n\n').trim(),
    content: text.replace(/\n{3,}/g, '\n\n').trimEnd(),
  };
}

function normalizeStateLabel(label) {
  const value = String(label || '').toLowerCase();
  if (value === 'status' || value === '状态栏') return 'status';
  if (value === 'character_state' || value === 'card_state' || value === '角色状态' || value === '元数据') return 'role_state';
  return value || 'role_state';
}

function formatMetadataBlock(tag, inner) {
  const clean = String(inner || '').trim();
  const label = normalizeStateLabel(tag);
  return label === 'role_state' ? clean : `${label}:\n${clean}`;
}

function mergeMetadata(existing, incoming) {
  const a = String(existing || '').trim();
  const b = String(incoming || '').trim();
  if (!a) return b;
  if (!b) return a;
  if (a.includes(b)) return a;
  if (b.includes(a)) return b;
  return `${a}\n\n${b}`.trim();
}

export function extractSuggestionsBlocks(content) {
  let text = String(content || '');
  const found = [];
  let changed = false;

  text = text.replace(/<suggestions\b[^>]*>([\s\S]*?)<\/suggestions>/gi, (_match, inner) => {
    const suggestions = parseSuggestionLines(inner);
    if (!suggestions.length) return _match;
    changed = true;
    found.push(...suggestions);
    return '\n';
  });

  // Backward-compatible but conservative plain-text fallback: only strip a
  // trailing block that clearly consists of short numbered/bulleted options.
  text = text.replace(/(?:^|\n)\s*(?:行动选项|下一步行动|建议行动|选项)\s*[:：]\s*([\s\S]*?)$/i, (match, inner, offset, whole) => {
    if (offset < whole.length * 0.55) return match;
    const suggestions = parseSuggestionLines(inner);
    if (suggestions.length < 2) return match;
    changed = true;
    found.push(...suggestions);
    return '\n';
  });

  return {
    changed,
    suggestions: found,
    content: text.replace(/\n{3,}/g, '\n\n').trimEnd(),
  };
}

export function parseSuggestionLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^[-*•]\s*/, '').replace(/^\d+[.)、]\s*/, '').trim())
    .filter((line) => line.length >= 2 && line.length <= 160)
    .slice(0, 6);
}

export function mergeSuggestions(existing, incoming) {
  const result = [];
  for (const item of [...(existing || []), ...(incoming || [])]) {
    const clean = String(item || '').trim();
    if (clean && !result.includes(clean)) result.push(clean);
  }
  return result.slice(0, 6);
}
