'use strict';

/**
 * OpenAI 兼容接口调用（DeepSeek / 通义 / 智谱 / Moonshot / Ollama / OneAPI ...）
 */

function buildEndpoint(baseURL) {
  let u = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('未配置模型接口地址');
  if (/\/chat\/completions$/i.test(u)) return u;
  if (/\/completions$/i.test(u)) return u;
  return u + '/chat/completions';
}

function fallbackEndpoint(baseURL) {
  let u = String(baseURL || '').trim().replace(/\/+$/, '');
  if (/\/v\d+$/i.test(u)) return null;
  if (/\/chat\/completions$/i.test(u)) return null;
  return u + '/v1/chat/completions';
}

function extractJSON(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch (_) { /* fallthrough */ }
  }
  try { return JSON.parse(s); } catch (_) { return null; }
}

function buildUserPrompt({ title, options, type, images }) {
  const typeMap = {
    single: '单选题',
    multiple: '多选题',
    judge: '判断题',
    judgement: '判断题',
    completion: '填空题',
    undetermined: '未知题型',
  };
  const t = typeMap[String(type || '').toLowerCase()] || type || '未知题型';
  const lines = [`题型：${t}`, `题干：${title}`];
  const opts = Array.isArray(options) ? options : [];
  if (opts.length) {
    lines.push('选项：');
    opts.forEach((o, i) => lines.push(`${String.fromCharCode(65 + i)}. ${o}`));
    // 代码类题目常把多行选项按行拆开，导致编号远超 A~H；提醒模型按真实选项作答
    if (opts.length > 8) {
      lines.push('注意：以上条目可能因换行被拆分，请结合题干辨认真实选项；答案只用 A~H 内的字母，或给出选项文本。');
    }
  } else {
    lines.push('选项：无（请直接给出答案内容）');
  }
  const hasImages = Array.isArray(images) && images.length > 0;
  if (hasImages) {
    lines.push(`说明：题干与选项中的 [图片N] 分别对应下方第 N 张图片（共 ${images.length} 张），请结合图片内容作答。`);
  }
  lines.push('请作答，只返回 JSON。');
  return lines.join('\n');
}

/** 构造多模态 content：文本 + 图片 */
function buildContent(text, images) {
  if (!Array.isArray(images) || !images.length) return text;
  const parts = [{ type: 'text', text }];
  for (const img of images) {
    if (!img) continue;
    const u = String(img).trim();
    if (!u.startsWith('data:image') && !/^https?:\/\//i.test(u)) continue;
    parts.push({ type: 'image_url', image_url: { url: u } });
  }
  return parts.length > 1 ? parts : text;
}

/** 深度思考参数：关闭时显式禁用，开启时附带推理强度；null 表示完全不带该参数 */
function thinkingPayload(t) {
  if (t === null) return {};
  if (!t || !t.enabled) return { thinking: { type: 'disabled' } };
  const effort = ['low', 'high', 'max'].includes(t.effort) ? t.effort : 'high';
  return { thinking: { type: 'enabled' }, reasoning_effort: effort };
}

/** 根据是否带图选择运行时配置：图片题走视觉模型，未单独配置则回退文本模型 */
function pickRuntime(cfg, images) {
  const hasImages = Array.isArray(images) && images.length > 0;
  if (hasImages && cfg.visionModel) {
    return {
      ...cfg,
      baseURL: cfg.visionBaseURL || cfg.baseURL,
      apiKey: cfg.visionApiKey || cfg.apiKey,
      model: cfg.visionModel,
      isVision: true,
    };
  }
  return { ...cfg, isVision: false };
}

async function rawRequest(endpoint, rt, messages, timeout, model, thinking) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rt.apiKey}`,
      },
      body: JSON.stringify({
        model: model || rt.model,
        messages,
        temperature: typeof rt.temperature === 'number' ? rt.temperature : 0.1,
        max_tokens: rt.maxTokens || 1024,
        stream: false,
        ...thinkingPayload(thinking),
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`模型接口返回 ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    let data;
    try { data = JSON.parse(text); } catch (_) {
      throw new Error('模型接口返回的不是 JSON：' + text.slice(0, 200));
    }
    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
    return { content, usage: data?.usage, raw: data, endpoint };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带降级的请求：
 * 1. 先按配置请求（带 thinking 参数，开启或关闭）
 * 2. 接口不认识 thinking 参数 → 去掉该参数重试
 * 3. 地址可能缺 /v1 → 换地址重试
 * 鉴权/余额类错误直接抛出，不做无谓重试
 */
async function requestWithFallback(rt, messages, model, timeout) {
  const thinking = rt.thinking || { enabled: false, effort: 'high' };
  const primary = buildEndpoint(rt.baseURL);
  const fb = fallbackEndpoint(rt.baseURL);

  async function attempt(endpoint) {
    try {
      return await rawRequest(endpoint, rt, messages, timeout, model, thinking);
    } catch (e) {
      // 有的接口不认 thinking / reasoning_effort，去掉参数再来一次
      if (e.status === 400) {
        return await rawRequest(endpoint, rt, messages, timeout, model, null);
      }
      throw e;
    }
  }

  try {
    return await attempt(primary);
  } catch (e) {
    if (e.status === 401 || e.status === 402 || e.status === 403) throw e;
    // 地址可能缺 /v1，换地址重试（仍保留思考模式设定）
    if (fb && fb !== primary && (e.status === 404 || e.status === 400)) {
      return await attempt(fb);
    }
    throw e;
  }
}

function decorateImageError(e, hasImages, model, cfg) {
  if (!hasImages) return e;
  const tip = `这是图片题，但当前模型「${model}」可能不支持图片输入。请在「模型配置」里点选一个支持视觉的模型（如 qwen-vl-plus / glm-4v / gpt-4o）。原始错误：${e.message}`;
  const err = new Error(tip);
  err.status = e.status;
  return err;
}

async function askLLM({ title, options, type, images }, cfg) {
  if (!cfg || !cfg.enabled) throw new Error('大模型未启用');
  const rt = pickRuntime(cfg, images);
  const hasImages = Array.isArray(images) && images.length > 0;

  if (!rt.baseURL) throw new Error('未配置模型接口地址');
  if (!rt.model) throw new Error('未配置模型名称');
  if (!rt.apiKey) throw new Error('未配置 API Key');

  const model = rt.model;
  const timeout = Math.max(5000, Number(rt.timeout) || 45000);
  const prompt = buildUserPrompt({ title, options, type, images });
  const messages = [
    { role: 'system', content: rt.systemPrompt || '你是答题助手，只输出 JSON。' },
    { role: 'user', content: buildContent(prompt, images) },
  ];

  let result;
  try {
    result = await requestWithFallback(rt, messages, model, timeout);
  } catch (e) {
    throw decorateImageError(e, hasImages, model, cfg);
  }
  const endpoint = result.endpoint;

  const content = String(result.content || '').trim();
  const parsed = extractJSON(content) || {};
  let answer = parsed.answer ?? parsed.答案 ?? parsed.result ?? parsed.Answer;
  let explanation = parsed.explanation ?? parsed.解析 ?? parsed.analysis ?? '';

  if (answer == null) {
    // 模型没按 JSON 输出，退化为提取字母
    const m = content.match(/\b([A-H](?:\s*[#、,，]\s*[A-H])*)\b/);
    if (m) answer = m[1].replace(/\s/g, '').replace(/[,，、]/g, '#');
    else answer = content.slice(0, 100);
  }

  return {
    answer,
    explanation: String(explanation || '').slice(0, 500),
    endpoint,
    model,
    hasImages,
    thinking: rt.thinking || { enabled: false, effort: 'high' },
    usage: result.usage,
    rawContent: content.slice(0, 1000),
  };
}

/** 拉取平台可用的模型列表（OpenAI 兼容 GET /models） */
async function fetchModels({ baseURL, apiKey, timeout }) {
  if (!baseURL) throw new Error('请先填写接口地址');
  if (!apiKey) throw new Error('请先填写 API Key');

  const base = String(baseURL).trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  const candidates = [base + '/models'];
  if (!/\/v\d+$/i.test(base)) candidates.push(base + '/v1/models');

  let lastErr;
  for (const url of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(timeout) || 15000));
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        lastErr = new Error(`接口返回 ${res.status}：${text.slice(0, 200)}`);
        continue;
      }
      let data;
      try { data = JSON.parse(text); } catch (_) { throw new Error('接口返回的不是 JSON'); }
      const list = Array.isArray(data) ? data : (data.data || data.models || []);
      const models = list
        .map((m) => (typeof m === 'string' ? { id: m } : { id: m.id || m.name, ownedBy: m.owned_by || '' }))
        .filter((m) => m.id);
      if (!models.length) { lastErr = new Error('接口没有返回任何模型'); continue; }
      return { models, endpoint: url };
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('获取模型列表失败');
}

async function testConnection(cfg, opts = {}) {
  const started = Date.now();
  const images = Array.isArray(opts.images) ? opts.images.filter(Boolean) : [];
  const q = images.length
    ? { title: '请用一句话说出图片里的文字内容', options: [], type: 'completion', images }
    : { title: '中国的首都是哪里？', options: ['A. 北京', 'B. 上海', 'C. 广州', 'D. 深圳'], type: 'single' };
  const r = await askLLM(q, { ...cfg, enabled: true });
  return {
    ok: true,
    ms: Date.now() - started,
    answer: r.answer,
    model: r.model,
    endpoint: r.endpoint,
    thinking: r.thinking,
    hasImages: images.length > 0,
  };
}

module.exports = { askLLM, testConnection, fetchModels, buildEndpoint, buildUserPrompt };
