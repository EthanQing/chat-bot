import { estimateTokens } from './utils.js';
import { resolveCharacterPlaceholders } from './character-card.js';

export function normalizeWorldBook(input, source = '') {
  const root = input?.data && typeof input.data === 'object' ? input.data : input;
  const rawEntries = extractRawEntries(root);
  if (!rawEntries.length) throw new Error('未找到世界书 entries。');
  const entries = rawEntries
    .map((entry, index) => normalizeWorldBookEntry(entry, index))
    .filter((entry) => entry.content.trim());
  if (!entries.length) throw new Error('世界书没有可用条目内容。');
  return {
    source,
    name: root?.name || root?.title || input?.name || source || '未命名世界书',
    description: root?.description || root?.comment || '',
    scan_depth: clampInt(root?.scan_depth ?? root?.scanDepth ?? root?.extensions?.scan_depth, 4, 1, 40),
    token_budget: clampInt(root?.token_budget ?? root?.tokenBudget ?? root?.extensions?.token_budget, 1200, 64, 100000),
    recursive_scanning: Boolean(root?.recursive_scanning ?? root?.recursiveScanning ?? root?.extensions?.recursive_scanning),
    extensions: root?.extensions && typeof root.extensions === 'object' ? root.extensions : {},
    entries,
    raw: input,
  };
}

function extractRawEntries(root) {
  if (Array.isArray(root)) return root;
  if (!root || typeof root !== 'object') return [];
  if (Array.isArray(root.entries)) return root.entries;
  if (root.entries && typeof root.entries === 'object') return Object.values(root.entries);
  if (Array.isArray(root.world_info?.entries)) return root.world_info.entries;
  if (root.world_info?.entries && typeof root.world_info.entries === 'object') return Object.values(root.world_info.entries);
  if (Array.isArray(root.lorebook?.entries)) return root.lorebook.entries;
  if (root.lorebook?.entries && typeof root.lorebook.entries === 'object') return Object.values(root.lorebook.entries);
  if (Array.isArray(root.character_book?.entries)) return root.character_book.entries;
  if (root.character_book?.entries && typeof root.character_book.entries === 'object') return Object.values(root.character_book.entries);
  return [];
}

function normalizeWorldBookEntry(entry = {}, index) {
  const extensions = entry.extensions && typeof entry.extensions === 'object' ? entry.extensions : {};
  const keys = normalizeKeys(entry.keys ?? entry.key ?? entry.keyword ?? entry.keywords ?? entry.primary_keys);
  const secondaryKeys = normalizeKeys(entry.secondary_keys ?? entry.keysecondary ?? entry.secondaryKeys ?? entry.secondary);
  const content = String(entry.content ?? entry.entry ?? entry.text ?? entry.value ?? '').trim();
  const position = normalizePosition(entry.position ?? extensions.position ?? extensions.insertion_position ?? 'before_char');
  return {
    id: String(entry.uid ?? entry.id ?? index),
    name: String(entry.name ?? entry.comment ?? entry.title ?? `条目 ${index + 1}`),
    comment: String(entry.comment ?? ''),
    enabled: !(entry.disable === true || entry.disabled === true || entry.enabled === false),
    keys,
    secondary_keys: secondaryKeys,
    secondaryKeys,
    content,
    constant: Boolean(entry.constant ?? entry.alwaysActive ?? entry.always_active ?? extensions.constant),
    selective: Boolean(entry.selective ?? extensions.selective),
    insertion_order: Number(entry.insertion_order ?? entry.insertionOrder ?? entry.order ?? 100),
    order: Number(entry.insertion_order ?? entry.insertionOrder ?? entry.order ?? 100),
    position,
    depth: clampInt(entry.depth ?? extensions.depth, 4, 0, 100),
    priority: Number(entry.priority ?? extensions.priority ?? entry.order ?? 100),
    case_sensitive: Boolean(entry.case_sensitive ?? entry.caseSensitive ?? extensions.case_sensitive),
    caseSensitive: Boolean(entry.case_sensitive ?? entry.caseSensitive ?? extensions.case_sensitive),
    matchWholeWords: Boolean(entry.match_whole_words ?? entry.matchWholeWords ?? extensions.match_whole_words),
    extensions,
  };
}

function normalizePosition(position) {
  const raw = String(position ?? '').toLowerCase();
  if (raw === 'before' || raw === 'before_char' || raw === 'before_character') return 'before_char';
  if (raw === 'after' || raw === 'after_char' || raw === 'after_character') return 'after_char';
  if (raw === 'depth' || raw === 'at_depth' || raw === 'chat') return 'at_depth';
  return raw || 'before_char';
}

function normalizeKeys(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

export function getTriggeredWorldBookEntries(worldBook, text, {
  maxEntries = 12,
  tokenBudget = worldBook?.token_budget || 1200,
  recursive = Boolean(worldBook?.recursive_scanning),
  maxRecursion = 3,
} = {}) {
  if (!worldBook?.entries?.length) return [];
  const entries = worldBook.entries.filter((entry) => entry.enabled);
  let scanText = String(text || '');
  const active = new Map();

  const runScan = () => {
    let added = false;
    for (const entry of entries) {
      if (active.has(entry.id)) continue;
      if (!entryTriggered(entry, scanText)) continue;
      active.set(entry.id, entry);
      added = true;
    }
    return added;
  };

  runScan();
  if (recursive) {
    for (let depth = 0; depth < maxRecursion; depth += 1) {
      const before = active.size;
      scanText = `${scanText}\n\n${[...active.values()].map((entry) => entry.content).join('\n\n')}`;
      if (!runScan() || active.size === before) break;
    }
  }

  const sorted = [...active.values()].sort(compareInsertionOrder).slice(0, clampInt(maxEntries, 12, 1, 100));
  return enforceTokenBudget(sorted, tokenBudget);
}

function entryTriggered(entry, scanText) {
  if (entry.constant) return true;
  if (entry.selective) {
    return entry.keys.some((key) => keyMatches(scanText, key, entry))
      && entry.secondaryKeys.some((key) => keyMatches(scanText, key, entry));
  }
  return entry.keys.some((key) => keyMatches(scanText, key, entry));
}

function keyMatches(haystack, key, entry) {
  const needle = String(key || '');
  if (!needle) return false;
  const original = String(haystack || '');
  const source = entry.caseSensitive ? original : original.toLowerCase();
  const target = entry.caseSensitive ? needle : needle.toLowerCase();
  if (!entry.matchWholeWords) return source.includes(target);
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = entry.caseSensitive ? 'u' : 'iu';
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, flags).test(original);
}

function compareInsertionOrder(a, b) {
  return (a.insertion_order - b.insertion_order)
    || (b.priority - a.priority)
    || String(a.name).localeCompare(String(b.name));
}

function enforceTokenBudget(entries, tokenBudget) {
  const budget = clampInt(tokenBudget, 1200, 64, 100000);
  let kept = [...entries];
  const totalTokens = () => kept.reduce((sum, entry) => sum + estimateTokens(entry.content || ''), 0);
  while (kept.length > 1 && totalTokens() > budget) {
    let dropIndex = 0;
    for (let i = 1; i < kept.length; i += 1) {
      if ((kept[i].priority ?? 100) < (kept[dropIndex].priority ?? 100)) dropIndex = i;
      else if ((kept[i].priority ?? 100) === (kept[dropIndex].priority ?? 100) && estimateTokens(kept[i].content) > estimateTokens(kept[dropIndex].content)) dropIndex = i;
    }
    kept.splice(dropIndex, 1);
  }
  return kept;
}

export function worldBookEntriesToPrompt(entries, { charName = '角色', userName = '用户' } = {}) {
  if (!entries?.length) return '';
  const groups = groupEntriesByPosition(entries);
  return Object.entries(groups)
    .filter(([, items]) => items.length)
    .map(([position, items]) => {
      const label = {
        before_char: '角色卡之前',
        after_char: '角色卡之后',
        at_depth: '对话深度注入',
      }[position] || position;
      return `【${label}】\n${items.map((entry) => {
        const content = resolveCharacterPlaceholders(entry.content, charName, userName).trim();
        return `【${entry.name}】\n${content}`;
      }).join('\n\n')}`;
    }).join('\n\n');
}

export function summarizeWorldBook(worldBook) {
  const entries = worldBook?.entries || [];
  const enabled = entries.filter((entry) => entry.enabled);
  const constantCount = enabled.filter((entry) => entry.constant).length;
  const totalChars = enabled.reduce((sum, entry) => sum + String(entry.content || '').length, 0);
  const tokens = enabled.reduce((sum, entry) => sum + estimateTokens(entry.content || ''), 0);
  const keyPreview = enabled.slice(0, 10).map((entry) => `${entry.name}: ${(entry.keys || []).slice(0, 4).join(' / ') || (entry.constant ? '常驻' : '无关键词')}`);
  return {
    total: entries.length,
    enabled: enabled.length,
    constantCount,
    totalChars,
    tokens,
    keyPreview,
  };
}

function groupEntriesByPosition(entries) {
  return entries.reduce((groups, entry) => {
    const key = normalizePosition(entry.position);
    (groups[key] ||= []).push(entry);
    return groups;
  }, { before_char: [], after_char: [], at_depth: [] });
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
