export const STORAGE_KEY = 'deepseek.streaming.chatbot.v1';
export const SAVE_DELAY = 250;
export const STREAM_RENDER_INTERVAL = 80;
export const CONTEXT_LIMIT = 1_000_000;
export const MAX_TOOL_LOOPS = 6;

export const DEFAULT_SYSTEM_PROMPT = '你是一个专业、准确、友善的 AI 助手。请使用清晰结构和简洁语言回答。';

export const PROMPT_TEMPLATES = [
  { name: '通用助手', prompt: DEFAULT_SYSTEM_PROMPT, tags: ['general'] },
  { name: '代码专家', prompt: '你是资深全栈工程师。回答代码问题时请给出可运行方案、关键边界条件、复杂度与测试建议。', tags: ['code'] },
  { name: '翻译助手', prompt: '你是专业译者。请忠实、流畅、自然地翻译文本，并在必要时解释关键术语。', tags: ['translation'] },
  { name: '文案写作', prompt: '你是品牌文案专家。请根据目标受众、渠道和语气生成有吸引力且不夸张的文案。', tags: ['writing'] },
  { name: '数据分析', prompt: '你是数据分析师。请先澄清指标口径，再用结构化步骤完成分析，并给出可执行建议。', tags: ['data'] },
  { name: '自定义…', prompt: '', tags: ['custom'] },
];

export const BUILTIN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'calculator',
      description: 'Evaluate a simple arithmetic expression. Supports +, -, *, /, %, ** and parentheses.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Arithmetic expression, e.g. (12 + 3) * 4 / 5' },
        },
        required: ['expression'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get the current local time for a timezone label. This is implemented in the browser.',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'IANA timezone such as Asia/Shanghai or America/New_York' },
        },
        required: ['timezone'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'weather',
      description: 'Mock weather lookup. Returns a local simulated weather report.',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City or place name' },
          date: { type: 'string', description: 'Date or natural-language date, e.g. today' },
        },
        required: ['location', 'date'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Mock web search. Returns simulated search snippets without external network access.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'integer', description: 'Number of results to return' },
        },
        required: ['query', 'limit'],
        additionalProperties: false,
      },
    },
  },
];

export const DEFAULT_SETTINGS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  betaBaseUrl: 'https://api.deepseek.com/beta',
  useProxy: true,
  model: 'deepseek-v4-flash',
  temperature: 1.0,
  topP: 1.0,
  maxTokens: 4096,
  responseLength: 'auto',
  customLength: '',
  presencePenalty: 0,
  frequencyPenalty: 0,
  stop: '',
  thinking: false,
  reasoningEffort: 'high',
  jsonMode: false,
  prefixEnabled: false,
  assistantPrefix: '',
  fimEnabled: false,
  toolsEnabled: false,
  toolsJson: JSON.stringify(BUILTIN_TOOLS, null, 2),
  theme: 'system',
  fontScale: 1,
  showTimestamps: true,
  lineNumbers: false,
  formatting: {
    chatDisplayMode: 'default',
    showTagsInResponses: false,
    autoFixMarkdown: true,
    showReasoningBlocks: true,
    allowScopedRegex: false,
    reasoningTemplates: [
      { id: 'think-tags', name: 'Think 标签', regex: { open: '<think\\b[^>]*>', close: '</think>' }, enabled: true },
      { id: 'thinking-tags', name: 'Thinking 标签', regex: { open: '<thinking\\b[^>]*>', close: '</thinking>' }, enabled: true },
      { id: 'analysis-tags', name: 'Analysis 标签', regex: { open: '<analysis\\b[^>]*>', close: '</analysis>' }, enabled: true },
      { id: 'reasoning-tags', name: 'Reasoning 标签', regex: { open: '<reasoning\\b[^>]*>', close: '</reasoning>' }, enabled: true },
    ],
    regexScripts: [],
  },
};

export const MODEL_NOTES = {
  'deepseek-v4-flash': '快速、高性价比；适合日常问答、轻量 Agent 和高频调用。支持 1M 上下文、思考/非思考、JSON、Tool Calls、Prefix/FIM。',
  'deepseek-v4-pro': '更强推理能力；适合复杂推理、长上下文分析和高质量代码任务。支持 1M 上下文、思考/非思考、JSON、Tool Calls、Prefix/FIM。',
};
