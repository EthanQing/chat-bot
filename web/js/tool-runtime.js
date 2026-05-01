const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function parseToolArguments(value) {
  if (!value) return {};
  try { return JSON.parse(value); } catch (error) { throw new Error(`工具参数不是合法 JSON：${error.message}`); }
}

export async function executeTool(name, args) {
  if (name === 'calculator') {
    const expression = String(args.expression || '');
    if (!/^[\d\s+\-*/().,%]+$/.test(expression) || /[^*]\*{3,}|[a-z_$]/i.test(expression)) throw new Error('表达式包含不支持的字符。');
    const value = Function(`"use strict"; return (${expression});`)();
    if (!Number.isFinite(value)) throw new Error('计算结果不是有限数字。');
    return { expression, result: value };
  }
  if (name === 'get_current_time') {
    const timezone = args.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
    const date = new Date();
    return {
      timezone,
      iso: date.toISOString(),
      local: new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full', timeStyle: 'long', timeZone: timezone }).format(date),
    };
  }
  if (name === 'weather') {
    return {
      location: args.location || '未知地点',
      date: args.date || 'today',
      summary: '多云，微风（模拟数据）',
      temperature: '18~25°C',
      note: '这是前端内置 mock 工具，并未访问真实天气服务。',
    };
  }
  if (name === 'web_search') {
    const query = args.query || '';
    const limit = clamp(Number(args.limit || 3), 1, 8);
    return {
      query,
      results: Array.from({ length: limit }, (_, index) => ({
        title: `模拟搜索结果 ${index + 1}: ${query}`,
        url: `https://example.com/search/${index + 1}`,
        snippet: '这是内置模拟网页搜索结果；如需真实搜索，可在 executeTool 中接入你的搜索 API。',
      })),
    };
  }
  return {
    warning: `工具 ${name} 已由模型请求，但前端没有对应执行器。`,
    arguments: args,
    how_to_fix: '在 web/js/tool-runtime.js 的 executeTool(name, args) 中添加该工具的实现。',
  };
}

export function validateToolDefinition(tool) {
  if (tool.type !== 'function') throw new Error('tool.type 目前只支持 function。');
  const fn = tool.function;
  if (!fn || !/^[a-zA-Z0-9_-]{1,64}$/.test(fn.name || '')) throw new Error('function.name 只能包含字母、数字、下划线或短横线，最长 64。');
  if (fn.strict === true) validateStrictSchema(fn.parameters || { type: 'object', properties: {}, required: [], additionalProperties: false }, fn.name);
}

export function validateStrictSchema(schema, path) {
  const allowed = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array']);
  if (Array.isArray(schema.enum)) return;
  if (schema.anyOf) {
    for (const [index, child] of schema.anyOf.entries()) validateStrictSchema(child, `${path}.anyOf[${index}]`);
    return;
  }
  if (!allowed.has(schema.type)) throw new Error(`${path}: strict 模式不支持类型 ${schema.type}`);
  if (schema.type === 'object') {
    const properties = schema.properties || {};
    const required = schema.required || [];
    if (schema.additionalProperties !== false) throw new Error(`${path}: object 必须设置 additionalProperties:false`);
    for (const key of Object.keys(properties)) {
      if (!required.includes(key)) throw new Error(`${path}: strict 模式下所有属性都必须在 required 中。缺少 ${key}`);
      validateStrictSchema(properties[key], `${path}.${key}`);
    }
  }
  if (schema.type === 'array' && schema.items) validateStrictSchema(schema.items, `${path}[]`);
}
