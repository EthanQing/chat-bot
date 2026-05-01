import { replaceMacros } from './message-formatting.js';

export async function parseCharacterCardFile(file) {
  const lowerName = String(file?.name || '').toLowerCase();
  if (lowerName.endsWith('.charx')) return parseCharxFile(file);

  if (/\.png$/i.test(file.name) || file.type === 'image/png') {
    const metadata = extractPngTextMetadata(await file.arrayBuffer());
    const key = pickPngCharacterChunkKey(metadata);
    if (!key) throw new Error('PNG 中未找到 ccv3/chara 角色卡元数据。');
    const data = parseCharacterPayload(metadata[key]);
    const card = normalizeCharacterCard(data, file.name);
    card.pngMetadataKey = key;
    card.rawPayload = JSON.stringify(data, null, 2);
    return card;
  }

  const text = await file.text();
  const data = parseCharacterPayload(text);
  const card = normalizeCharacterCard(data, file.name);
  card.rawPayload = looksLikeJsonText(text) ? text.trim() : JSON.stringify(data, null, 2);
  return card;
}

async function parseCharxFile(file) {
  if (!globalThis.JSZip) {
    throw new Error('当前页面未加载 JSZip，无法解析 CHARX。请刷新页面后重试。');
  }
  const zip = await globalThis.JSZip.loadAsync(await file.arrayBuffer());
  const cardFile = zip.file(/^card\.json$/i)[0] || zip.file(/(^|\/)card\.json$/i)[0];
  if (!cardFile) throw new Error('CHARX 中未找到 card.json。');
  const raw = await cardFile.async('text');
  const data = parseCharacterPayload(raw);
  const card = normalizeCharacterCard(data, file.name);
  card.rawPayload = JSON.stringify(data, null, 2);
  card.charx = {
    files: Object.keys(zip.files).filter((name) => !zip.files[name].dir),
    assets: Object.keys(zip.files)
      .filter((name) => !zip.files[name].dir && !/(^|\/)card\.json$/i.test(name))
      .map((path) => ({ path, name: path.split('/').pop() || path })),
  };
  return card;
}

function pickPngCharacterChunkKey(metadata = {}) {
  const keys = Object.keys(metadata);
  // SillyTavern reads V3 first when both are present, then falls back to V2.
  return keys.find((key) => key.toLowerCase() === 'ccv3')
    || keys.find((key) => key.toLowerCase() === 'chara')
    || keys.find((key) => ['character', 'card'].includes(key.toLowerCase()))
    || '';
}

export function parseCharacterPayload(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw || '').trim();
  if (!text) throw new Error('角色卡内容为空。');
  try { return JSON.parse(text); } catch (_) {}
  try {
    const binary = atob(text);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder('utf-8').decode(bytes));
  } catch (_) {
    throw new Error('无法解析角色卡 JSON 或 base64 JSON。');
  }
}

export function normalizeCharacterCard(input, source = '') {
  const spec = String(input?.spec || input?.spec_version || '').toLowerCase();
  const data = input?.data && typeof input.data === 'object' ? input.data : input;
  if (!data || typeof data !== 'object') throw new Error('角色卡 JSON 结构无效。');

  const specVersion = detectSpecVersion(input, data);
  const multilingualNotes = data.creator_notes_multilingual || input.creator_notes_multilingual || null;
  const card = {
    id: makeCharacterId(input, source),
    source,
    spec: input.spec || input.spec_version || '',
    spec_version: specVersion,
    name: str(data.name || input.name),
    description: str(data.description),
    personality: str(data.personality),
    scenario: str(data.scenario),
    first_mes: str(data.first_mes || data.first_message || data.greeting),
    mes_example: str(data.mes_example || data.example_dialogue),
    creator_notes: normalizeCreatorNotes(data.creator_notes || data.creatorcomment || multilingualNotes),
    creator_notes_multilingual: multilingualNotes && typeof multilingualNotes === 'object' ? multilingualNotes : null,
    system_prompt: str(data.system_prompt || input.system_prompt),
    post_history_instructions: str(data.post_history_instructions || input.post_history_instructions),
    alternate_greetings: Array.isArray(data.alternate_greetings) ? data.alternate_greetings.map(str).filter(Boolean) : [],
    group_only_greetings: Array.isArray(data.group_only_greetings) ? data.group_only_greetings.map(str).filter(Boolean) : [],
    character_book: data.character_book || input.character_book || null,
    tags: Array.isArray(data.tags) ? data.tags.map(str).filter(Boolean) : [],
    creator: str(data.creator || input.creator),
    character_version: str(data.character_version || data.version || input.character_version),
    assets: Array.isArray(data.assets) ? data.assets : (Array.isArray(input.assets) ? input.assets : []),
    extensions: data.extensions && typeof data.extensions === 'object' ? data.extensions : {},
    rawPayload: '',
    raw: input,
  };

  if (!card.name && !card.description && !card.scenario && !card.first_mes) {
    throw new Error('未识别到 name/description/scenario/first_mes 等角色卡字段。');
  }
  card.name ||= '未命名角色';
  card.fields = buildCharacterFields(card);
  card.tokenStats = estimateCharacterFieldTokens(card);
  card.spec = card.spec || (spec || `chara_card_${specVersion}`);
  return card;
}

function detectSpecVersion(input = {}, data = {}) {
  const spec = String(input.spec || input.spec_version || data.spec || '').toLowerCase();
  if (spec.includes('v3') || spec.includes('ccv3') || spec.includes('chara_card_v3')) return 'v3';
  if (spec.includes('v2') || spec.includes('chara_card_v2')) return 'v2';
  if (Array.isArray(data.assets) || data.creator_notes_multilingual || data.group_only_greetings) return 'v3';
  if (input.data || data.character_book || data.alternate_greetings || data.system_prompt || data.post_history_instructions) return 'v2';
  return 'v1';
}

function normalizeCreatorNotes(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return str(value.zh || value['zh-CN'] || value.en || Object.values(value).find(Boolean));
  }
  return str(value);
}

export function buildCharacterFields(card = {}) {
  const field = (name, value, inPrompt) => ({
    field_name: name,
    field_value: str(value),
    in_prompt: Boolean(inPrompt),
  });
  return [
    field('description', card.description, true),
    field('personality', card.personality, true),
    field('scenario', card.scenario, true),
    field('mes_example', card.mes_example, true),
    field('system_prompt', card.system_prompt, true),
    field('post_history_instructions', card.post_history_instructions, true),
    field('first_mes', card.first_mes, false),
    field('creator_notes', card.creator_notes, false),
    field('tags', Array.isArray(card.tags) ? card.tags.join(', ') : '', false),
    field('creator', card.creator, false),
    field('character_version', card.character_version, false),
  ];
}

export function estimateCharacterFieldTokens(card = {}) {
  const result = {};
  for (const field of buildCharacterFields(card)) {
    result[field.field_name] = estimateTextTokens(field.field_value);
  }
  result.alternate_greetings = (card.alternate_greetings || []).reduce((sum, item) => sum + estimateTextTokens(item), 0);
  result.prompt_total = ['description', 'personality', 'scenario', 'mes_example', 'system_prompt', 'post_history_instructions']
    .reduce((sum, key) => sum + (result[key] || 0), 0);
  result.total = Object.values(result).reduce((sum, value) => sum + (Number(value) || 0), 0);
  return result;
}

export function characterCardToPrompt(card, {
  userName = '',
  includeExamples = true,
  exampleBudgetTokens = 1200,
  includeFirstMessage = false,
} = {}) {
  if (!card) return '';
  const charName = card.name || '角色';
  const sections = [`【角色卡：${charName}】`];
  const add = (label, value) => {
    const text = resolveCharacterPlaceholders(value || '', charName, userName).trim();
    if (text) sections.push(`${label}：\n${text}`);
  };
  add('角色描述', card.description);
  add('性格摘要', card.personality);
  add('当前场景', card.scenario);
  if (includeFirstMessage) add('开场白（只用于本次新会话开局）', card.first_mes);
  if (includeExamples) {
    const examples = selectExampleDialogueBlocks(card.mes_example, exampleBudgetTokens);
    if (examples) add('示例对话（空间不足时已自动裁剪）', examples);
  }
  return sections.join('\n\n');
}

export function selectExampleDialogueBlocks(text, tokenBudget = 1200) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const blocks = raw
    .split(/(?=<START>)/i)
    .map((block) => block.trim())
    .filter(Boolean);
  if (!blocks.length) return estimateTextTokens(raw) <= tokenBudget ? raw : '';
  const kept = [];
  let total = 0;
  // Keep later examples first; older examples are dropped first when budget is tight.
  for (const block of [...blocks].reverse()) {
    const tokens = estimateTextTokens(block);
    if (kept.length && total + tokens > tokenBudget) continue;
    if (!kept.length && tokens > tokenBudget) continue;
    kept.unshift(block);
    total += tokens;
  }
  return kept.join('\n\n');
}

export function getCharacterGreeting(card, index = 0) {
  const greetings = getCharacterGreetings(card);
  const safeIndex = Math.max(0, Math.min(Number(index) || 0, greetings.length - 1));
  return greetings[safeIndex] || '';
}

export function getCharacterGreetings(card = {}) {
  return [card.first_mes, ...(Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [])]
    .map(str)
    .filter(Boolean);
}

export function applyCharacterFieldEdit(card, key, value) {
  if (!card || typeof card !== 'object') return card;
  if (key === 'name') card.name = str(value) || '未命名角色';
  else if (key === 'alternate_greetings') {
    card.alternate_greetings = String(value || '').split(/\n-{3,}\n|\n\n+/).map((item) => item.trim()).filter(Boolean);
  } else if (key in card) {
    card[key] = str(value);
  }
  card.fields = buildCharacterFields(card);
  card.tokenStats = estimateCharacterFieldTokens(card);
  return card;
}

function looksLikeJsonText(text) {
  const trimmed = String(text || '').trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

export function resolveCharacterPlaceholders(text, charName, userName = '') {
  return replaceMacros(String(text || ''), {
    charName: charName || '角色',
    userName: userName || '用户',
    now: new Date(),
  });
}

export function extractPngTextMetadata(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) throw new Error('不是有效 PNG 文件。');
  const metadata = {};
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = asciiFromBytes(bytes.slice(offset + 4, offset + 8));
    const data = bytes.slice(offset + 8, offset + 8 + length);
    if (type === 'tEXt') {
      const zero = data.indexOf(0);
      if (zero > 0) {
        const key = asciiFromBytes(data.slice(0, zero));
        const value = asciiFromBytes(data.slice(zero + 1));
        metadata[key] = value;
      }
    } else if (type === 'iTXt') {
      const parsed = parseITXtChunk(data);
      if (parsed) metadata[parsed.key] = parsed.value;
    }
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return metadata;
}

export function parseITXtChunk(data) {
  let cursor = 0;
  const readNullTerminated = () => {
    const start = cursor;
    while (cursor < data.length && data[cursor] !== 0) cursor += 1;
    const part = data.slice(start, cursor);
    cursor += 1;
    return part;
  };
  const key = asciiFromBytes(readNullTerminated());
  const compressionFlag = data[cursor++];
  cursor += 1; // compression method
  readNullTerminated(); // language tag
  readNullTerminated(); // translated keyword
  if (compressionFlag) return null;
  return { key, value: new TextDecoder('utf-8').decode(data.slice(cursor)) };
}

export function readUint32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

export function asciiFromBytes(bytes) {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
}

function makeCharacterId(input, source) {
  const data = input?.data && typeof input.data === 'object' ? input.data : input || {};
  const seed = [source, data.name, data.description, data.creator, data.character_version].map(str).join('\u0001');
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `char_${(hash >>> 0).toString(36)}`;
}

function estimateTextTokens(text) {
  return Math.ceil([...String(text || '')].reduce((sum, ch) => sum + (/[^\x00-\xff]/.test(ch) ? 1.2 : 0.25), 0));
}

function str(value) {
  return value === undefined || value === null ? '' : String(value);
}
