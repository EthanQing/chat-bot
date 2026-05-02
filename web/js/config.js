export const STORAGE_KEY = 'deepseek.streaming.chatbot.v1';
export const SAVE_DELAY = 250;
export const STREAM_RENDER_INTERVAL = 80;
export const CONTEXT_LIMIT = 1_000_000;
export const MAX_TOOL_LOOPS = 6;

export const DEFAULT_SYSTEM_PROMPT = '你是一个专业、准确、友善的 AI 助手。请使用清晰结构和简洁语言回答。';

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
  'deepseek-v4-flash': '快速、高性价比；适合日常问答、轻量 Agent 和高频调用。支持 1M 上下文、思考/非思考、JSON、Tool Calls、Prefix。',
  'deepseek-v4-pro': '更强推理能力；适合复杂推理、长上下文分析和高质量代码任务。支持 1M 上下文、思考/非思考、JSON、Tool Calls、Prefix。',
};
