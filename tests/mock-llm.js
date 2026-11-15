'use strict';
/* 模拟 OpenAI 兼容服务，仅用于本地测试：node tests/mock-llm.js */
const http = require('http');

const PORT = Number(process.env.MOCK_PORT) || 8899;
let lastRequest = null;

http.createServer((req, res) => {
  // 测试用：查看上一次请求是否带了图片
  if (req.method === 'GET' && req.url.startsWith('/_last')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(lastRequest || {}));
  }

  if (req.method !== 'POST' || !req.url.includes('/v1/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not found' }));
  }

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (process.env.MOCK_DEBUG) console.log('[mock-debug] body:', body.slice(0, 600));
    let prompt = '';
    let userContent = null;
    let model = '';
    let thinking = null;
    let parsed = {};
    try {
      parsed = JSON.parse(body);
      model = parsed.model;
      thinking = parsed.thinking || null;
      userContent = parsed.messages[parsed.messages.length - 1].content;
      prompt = parsed.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    } catch (_) {}

    // 模拟「不支持 thinking 参数」的接口，用于验证自动降级
    if (model === 'no-thinking-support' && thinking) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: thinking', type: 'invalid_request_error' } }));
    }

    const isArray = Array.isArray(userContent);
    const imageCount = isArray ? userContent.filter((p) => p.type === 'image_url').length : 0;
    lastRequest = {
      model,
      thinking,
      contentTypeIsArray: isArray,
      imageCount,
      parts: isArray ? userContent.map((p) => p.type) : ['text'],
    };

    if (imageCount > 0) {
      // 模拟视觉模型：图片题返回固定答案，便于验证链路
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'mock',
        object: 'chat.completion',
        model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '{"answer":"C","explanation":"模拟视觉模型解析：图中内容为选项 C"}' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      }));
    }

    const isMulti = /题型：多选题/.test(prompt);
    const content = isMulti
      ? '```json\n{"answer":"A#D","explanation":"模拟多选解析"}\n```'
      : '{"answer":"B","explanation":"模拟单选解析"}';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock',
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock LLM listening on http://127.0.0.1:${PORT}/v1/chat/completions`);
});
