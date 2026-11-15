'use strict';

/**
 * 外部题库源适配：按用户配置的 URL / 模板 / 解析路径去查询第三方题库
 */

const { parseOptions } = require('./matcher');

function fillTemplate(value, ctx) {
  if (typeof value === 'string') {
    // 整个字符串就是一个占位符时保留原始类型（数组/对象直接用，不转字符串）
    const whole = /^\$\{(\w+)\}$/.exec(value);
    if (whole && ctx[whole[1]] !== undefined && typeof ctx[whole[1]] === 'object') {
      return ctx[whole[1]];
    }
    return value.replace(/\$\{(\w+)\}/g, (_, k) => (ctx[k] == null ? '' : String(ctx[k])));
  }
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = fillTemplate(value[k], ctx);
    return out;
  }
  return value;
}

function getByPath(obj, pathStr) {
  if (!pathStr) return undefined;
  const parts = String(pathStr).split('.').filter((p) => p !== '');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(p)) cur = cur[Number(p)];
    else cur = cur[p];
  }
  return cur;
}

async function queryProvider(provider, { title, options, type, images }) {
  if (!provider || !provider.enabled) return null;
  const imgs = Array.isArray(images) ? images.filter(Boolean) : [];
  const ctx = {
    title,
    question: title,
    options: Array.isArray(options) ? options.join('\n') : (options || ''),
    optionsJson: JSON.stringify(options || []),
    type: type || '',
    images: imgs,
    imagesJson: JSON.stringify(imgs),
    imageCount: imgs.length,
  };

  const method = (provider.method || 'post').toUpperCase();
  let url = fillTemplate(provider.url, ctx);
  const headers = fillTemplate(provider.headers || {}, ctx);
  const bodyData = fillTemplate(provider.dataTemplate || {}, ctx);

  // 没有图片时不发送空的 images 字段，避免部分题库判为无效请求
  if (Array.isArray(bodyData.images) && bodyData.images.length === 0) delete bodyData.images;

  const timeout = Math.max(2000, Number(provider.timeout) || 10000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const init = { method, headers: { ...headers }, signal: controller.signal };

    if (method === 'GET') {
      const u = new URL(url);
      for (const [k, v] of Object.entries(bodyData)) {
        if (v == null || v === '') continue;
        u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      url = u.toString();
    } else {
      const ct = provider.contentType === 'form'
        ? 'application/x-www-form-urlencoded'
        : 'application/json';
      init.headers['Content-Type'] = ct;
      if (ct === 'application/x-www-form-urlencoded') {
        const sp = new URLSearchParams();
        for (const [k, v] of Object.entries(bodyData)) {
          sp.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        }
        init.body = sp.toString();
      } else {
        init.body = JSON.stringify(bodyData);
      }
    }

    const res = await fetch(url, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    let data = text;
    try { data = JSON.parse(text); } catch (_) { /* 保留文本 */ }

    // 成功判定
    if (provider.successPath) {
      const val = getByPath(data, provider.successPath);
      const expect = provider.successValue;
      if (expect !== undefined && expect !== '' && String(val) !== String(expect)) {
        return null;
      }
    }

    let rawAnswer = getByPath(data, provider.answerPath || 'data.answer');
    if (rawAnswer == null) return null;
    if (Array.isArray(rawAnswer)) {
      rawAnswer = rawAnswer.join(provider.separator || '#');
    }
    rawAnswer = String(rawAnswer).trim();
    if (!rawAnswer) return null;

    let question = getByPath(data, provider.questionPath || 'data.question') || title;
    let explanation = getByPath(data, provider.explanationPath || '') || '';

    // 有些题库答案里带 "答案是：A"
    const m = rawAnswer.match(/^(?:答案|正确答案)\s*[:：]?\s*(.+)$/);
    if (m) rawAnswer = m[1].trim();
    rawAnswer = rawAnswer.replace(/^[A-H]\s*[.、．)）]\s*/g, (s) => s[0]);

    return { answer: rawAnswer, question: String(question), explanation: String(explanation || '') };
  } finally {
    clearTimeout(timer);
  }
}

/** 依次尝试多个题库源，返回第一个有答案的 */
async function queryProviders(providers, q) {
  const list = (providers || []).filter((p) => p && p.enabled);
  const errors = [];
  for (const p of list) {
    try {
      const r = await queryProvider(p, q);
      if (r && r.answer) return { ...r, providerName: p.name };
    } catch (e) {
      errors.push(`${p.name}: ${e.message}`);
    }
  }
  return { answer: null, errors };
}

module.exports = { queryProvider, queryProviders, getByPath, fillTemplate };
