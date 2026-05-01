import { sleep } from './utils.js';

export async function fetchDeepSeekRequest({ endpoint, body, baseUrl, signal, settings, onRetry }) {
  const targetUrl = `${String(baseUrl || '').replace(/\/$/, '')}${endpoint}`;
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    try {
      const browserApiKey = String(settings.apiKey || '').trim();
      const proxyHeaders = {
        'Content-Type': 'application/json',
        'x-target-url': targetUrl,
      };
      if (browserApiKey) proxyHeaders['x-api-key'] = browserApiKey;
      const response = await fetch(settings.useProxy ? '/proxy/deepseek' : targetUrl, {
        method: 'POST',
        headers: settings.useProxy ? proxyHeaders : {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${browserApiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (response.ok) return response;
      const text = await response.text();
      const error = new Error(text || response.statusText);
      error.status = response.status;
      error.body = text;
      if (![429, 500, 503].includes(response.status) || attempt === 3) throw error;
      lastError = error;
      onRetry?.(`${response.status}：请求将自动重试（${attempt + 1}/3）…`);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      lastError = error;
      if (attempt === 3) throw error;
      if (!/fetch|network|timeout|Failed/i.test(String(error.message))) throw error;
    }
  }
  throw lastError;
}

export async function streamChatResponse(response, assistant, { onDelta } = {}) {
  if (!response.body) throw new Error('浏览器不支持 ReadableStream，无法流式读取响应。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason = null;
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\n\n|\r\n\r\n/);
    buffer = events.pop() || '';
    for (const event of events) {
      for (const line of event.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') return { finishReason, usage };
        const chunk = JSON.parse(data);
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || choice.message || {};
        if (typeof delta.reasoning_content === 'string') {
          assistant.reasoning_content += delta.reasoning_content;
        }
        if (typeof delta.content === 'string') {
          assistant.content += delta.content;
        }
        if (delta.tool_calls) mergeToolCallDeltas(assistant, delta.tool_calls);
        assistant.usage = usage || assistant.usage;
        onDelta?.(assistant, { usage, chunk });
      }
    }
  }
  return { finishReason, usage };
}

export function mergeToolCallDeltas(assistant, deltas) {
  assistant.toolCalls ||= [];
  for (const delta of deltas) {
    const index = delta.index ?? assistant.toolCalls.length;
    const existing = assistant.toolCalls[index] ||= { id: '', type: 'function', function: { name: '', arguments: '' }, status: 'pending' };
    if (delta.id) existing.id = delta.id;
    if (delta.type) existing.type = delta.type;
    if (delta.function) {
      existing.function ||= { name: '', arguments: '' };
      if (typeof delta.function.name === 'string') existing.function.name += delta.function.name;
      if (typeof delta.function.arguments === 'string') existing.function.arguments += delta.function.arguments;
    }
  }
}
