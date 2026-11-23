'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const url = require('url');

const config = require('./src/config');
const store = require('./src/store');
const matcher = require('./src/matcher');
const llm = require('./src/llm');
const providers = require('./src/providers');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ---------------- 工具 ---------------- */

function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      const ct = String(req.headers['content-type'] || '');
      try {
        if (ct.includes('application/x-www-form-urlencoded')) {
          return resolve(Object.fromEntries(new URLSearchParams(raw)));
        }
        return resolve(JSON.parse(raw));
      } catch (_) {
        // OCS 某些情况会发非严格 JSON，尝试表单
        try { return resolve(Object.fromEntries(new URLSearchParams(raw))); } catch (e) { resolve({ _raw: raw }); }
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = decodeURIComponent(rel);
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    // 页面、样式、脚本走协商缓存，改完刷新就能生效；图片字体等才长缓存
    const dynamic = ['.html', '.css', '.js'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': dynamic ? 'no-cache' : 'public, max-age=86400',
    });
    res.end(buf);
  });
}

/* ---------------- 答题流水线 ---------------- */

const inFlight = new Map(); // norm -> Promise
let activeLLM = 0;
const llmQueue = [];

function llmSlot() {
  const c = config.get().llm;
  const max = Math.max(1, Number(c.concurrency) || 2);
  if (activeLLM < max) {
    activeLLM++;
    return Promise.resolve(() => { activeLLM--; drainQueue(); });
  }
  return new Promise((resolve) => llmQueue.push(resolve));
}

function drainQueue() {
  while (llmQueue.length && activeLLM < Math.max(1, Number(config.get().llm.concurrency) || 2)) {
    const next = llmQueue.shift();
    activeLLM++;
    next(() => { activeLLM--; drainQueue(); });
  }
}

/** 解析 OCS 传来的图片数组：data URL 列表，最多 6 张 */
function parseImages(raw) {
  if (!raw) return [];
  let arr = raw;
  if (typeof arr === 'string') {
    const s = arr.trim();
    if (!s) return [];
    if (s.startsWith('[')) {
      try { arr = JSON.parse(s); } catch (_) { arr = null; }
    }
    if (!Array.isArray(arr)) {
      // 兼容被转成逗号拼接字符串的情况
      arr = s.split(/,(?=data:image)/);
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => typeof x === 'string' && x.trim().length > 20)
    .map((x) => x.trim())
    .slice(0, 6);
}

function normalizeInput(body) {
  const title = body.title ?? body.question ?? body.q ?? body.topic ?? '';
  const rawOptions = body.options ?? body.option ?? body.choices ?? '';
  const type = body.type ?? body.questionType ?? '';
  const images = parseImages(body.images ?? body.image);
  const suggestionTitle = String(body.suggestion_title ?? body.suggestionTitle ?? '').trim();
  const suggestionOptions = String(body.suggestion_options ?? body.suggestionOptions ?? '').trim();
  return {
    title: String(title).trim(),
    options: matcher.mergeCodeOptions(matcher.parseOptions(rawOptions)),
    rawOptions,
    type: String(type || '').trim(),
    images,
    suggestionTitle,
    suggestionOptions,
    // 用于建索引/给模型看的题干：优先用去掉图片地址的版本，图片 URL 变化时索引才稳定
    indexText: suggestionTitle || String(title).trim(),
  };
}

/** 输出前把字母答案转成选项文本，避免 OCS 选项顺序变化导致错位 */
function formatOut(ans, q, cfg) {
  const preferText = !cfg.answer || cfg.answer.preferText !== false;
  if (!preferText) return ans;
  const sep = (cfg.answer && cfg.answer.multipleSeparator) || '#';
  const text = matcher.answerToText(ans, q.options, sep);
  // 选项被拆碎时，字母→文本会得到 "{" 这类碎片，此时保留字母更安全
  if (text && !matcher.isFragmentOption(text)) return text;
  return ans;
}

async function solve(q, opts = {}) {
  const cfg = config.get();
  const started = Date.now();
  const chain = [];
  const result = {
    code: 0,
    question: q.title,
    answer: '',
    source: '',
    matchType: '',
    score: 0,
    analysis: '',
    imageCount: q.images.length,
    ms: 0,
  };

  // 1) 本地题库（答案需通过合法性校验，防止历史脏数据继续污染输出）
  const local = store.resolve(q.indexText, q.options, cfg, q.images);
  const localAns = local
    ? matcher.normalizeAnswer(local.answer, q.type || local.entry.type, q.options, cfg)
    : '';
  if (local && matcher.isValidAnswer(localAns, q, cfg)) {
    chain.push({ step: 'local', ok: true, ms: Date.now() - started, matchType: local.matchType, score: local.score });
    result.code = 1;
    result.answer = localAns;
    result.source = 'local';
    result.matchType = local.matchType;
    result.score = local.score;
    result.analysis = local.explanation || '';
    result.ms = Date.now() - started;
    store.logQuery({ q: q.title, type: q.type, answer: result.answer, source: 'local', matchType: local.matchType, score: local.score, ms: result.ms });
    return { result, chain };
  }
  chain.push({
    step: 'local', ok: false, ms: Date.now() - started,
    ...(local ? { skipped: true, reason: '题库答案无效，已跳过' } : {}),
  });

  // 2) 外部题库源
  if ((cfg.providers || []).some((p) => p.enabled)) {
    const t0 = Date.now();
    const pr = await providers.queryProviders(cfg.providers, q);
    const pAns = pr.answer ? matcher.normalizeAnswer(pr.answer, q.type, q.options, cfg) : '';
    const pOk = !!pr.answer && matcher.isValidAnswer(pAns, q, cfg);
    const pErrors = [...(pr.errors || [])];
    if (pr.answer && !pOk) pErrors.push('外部源答案不在有效范围，已跳过');
    chain.push({ step: 'providers', ok: pOk, ms: Date.now() - t0, errors: pErrors });
    if (pOk) {
      result.code = 1;
      result.answer = formatOut(pAns, q, cfg);
      result.source = `provider:${pr.providerName}`;
      result.matchType = 'provider';
      result.score = 1;
      result.analysis = pr.explanation || '';
      result.ms = Date.now() - started;
      if (cfg.storage.autoSaveProvider) {
        store.add({
          question: q.title,
          indexText: q.indexText,
          options: q.options,
          type: q.type,
          answer: pAns,
          explanation: pr.explanation,
          source: `provider:${pr.providerName}`,
          images: q.images,
        });
      }
      store.logQuery({ q: q.title, type: q.type, answer: result.answer, source: result.source, ms: result.ms });
      return { result, chain };
    }
  }

  // 3) 大模型
  if (cfg.llm && cfg.llm.enabled && cfg.llm.apiKey && !opts.noLLM) {
    const t0 = Date.now();
    const release = await llmSlot();
    try {
      const ai = await llm.askLLM({
        title: q.indexText,
        options: q.suggestionOptions ? matcher.parseOptions(q.suggestionOptions) : q.options,
        type: q.type,
        images: q.images,
      }, cfg.llm);
      chain.push({ step: 'llm', ok: true, ms: Date.now() - t0, model: ai.model, images: q.images.length });
      const ans = matcher.normalizeAnswer(ai.answer, q.type, q.options, cfg);
      if (!ans) throw new Error('模型未给出有效答案');
      // 关键防线：越界字母等异常答案一律不返回、不入库，避免污染题库
      if (!matcher.isValidAnswer(ans, q, cfg)) {
        throw new Error(`模型答案「${ans}」不在有效范围，已拦截且不入库`);
      }
      result.code = 1;
      result.answer = formatOut(ans, q, cfg);
      result.source = 'ai';
      result.matchType = 'llm';
      result.analysis = ai.explanation || '';
      result.ms = Date.now() - started;
      if (cfg.storage.autoSaveAI) {
        store.add({
          question: q.title,
          indexText: q.indexText,
          options: q.options,
          type: q.type,
          answer: ans,
          explanation: ai.explanation,
          source: 'ai',
          images: q.images,
        });
      }
      store.logQuery({
        q: q.title, type: q.type, answer: ans, source: 'ai',
        model: ai.model, img: q.images.length || 0, ms: result.ms,
      });
      return { result, chain };
    } catch (e) {
      chain.push({ step: 'llm', ok: false, ms: Date.now() - t0, error: e.message });
      result.msg = '大模型调用失败：' + e.message;
      store.logQuery({ q: q.title, type: q.type, answer: '', source: 'ai', error: e.message, ms: Date.now() - started });
    } finally {
      release();
    }
  } else {
    chain.push({ step: 'llm', ok: false, skipped: true, reason: !cfg.llm?.enabled ? '未启用' : (!cfg.llm?.apiKey ? '未配置 API Key' : '已禁用') });
  }

  result.ms = Date.now() - started;
  if (!result.msg) {
    const imgTip = q.images.length ? '（图片题需要配置支持视觉的大模型）' : '';
    if (!cfg.llm || !cfg.llm.enabled) result.msg = '题库未收录该题，且大模型未启用' + imgTip;
    else if (!cfg.llm.apiKey) result.msg = '题库未收录该题，且未配置模型 API Key' + imgTip;
    else result.msg = '未找到答案';
  }
  store.logQuery({ q: q.title, type: q.type, answer: '', source: 'none', msg: result.msg, img: q.images.length || 0, ms: result.ms });
  return { result, chain };
}

async function searchWithCache(q, opts = {}) {
  const key = store.normalize(q.title) + '|' + (q.options || []).join('|');
  if (!opts.noCache && inFlight.has(key)) return inFlight.get(key);
  const p = solve(q, opts).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/* ---------------- 路由 ---------------- */

function ocsConfigText(port) {
  const host = `127.0.0.1:${port}`;
  const cfg = [
    {
      name: 'OCS 本地题库+AI',
      homepage: `http://${host}`,
      url: `http://${host}/api/search`,
      method: 'post',
      type: 'GM_xmlhttpRequest',
      contentType: 'json',
      headers: { 'Content-Type': 'application/json' },
      data: {
        v: '2',
        title: '${title}',
        options: '${options}',
        type: '${type}',
        // 图片题：必须用字段解析器返回数组，直接写 "${images}" 会被 OCS 转成逗号拼接字符串
        images: { handler: 'return (env) => env.images' },
        suggestion_title: '${suggestion_title}',
        suggestion_options: '${suggestion_options}',
      },
      handler:
        'return (res) => res && res.code === 1 ? [res.question, String(res.answer), ' +
        '{ source: res.source, matchType: res.matchType, score: res.score, analysis: res.analysis, images: res.imageCount || 0 }] : [res && res.msg ? String(res.msg).slice(0, 80) : undefined, undefined]',
    },
  ];
  return JSON.stringify(cfg, null, 2);
}

async function handleAPI(req, res, pathname, query) {
  const cfg = config.get();
  const method = req.method.toUpperCase();

  // ===== OCS 入口 =====
  if (pathname === '/api/search' || pathname === '/search') {
    const body = method === 'GET' ? query : await readBody(req);
    const q = normalizeInput(body);
    if (!q.title) return sendJSON(res, { code: 0, msg: '缺少题目参数 title' }, 400);
    try {
      const { result } = await searchWithCache(q);
      return sendJSON(res, result);
    } catch (e) {
      console.error('[search] 失败', e);
      return sendJSON(res, { code: 0, msg: '服务端异常：' + e.message, question: q.title });
    }
  }

  // ===== 统计 =====
  if (pathname === '/api/stats') {
    return sendJSON(res, { ok: true, data: { ...store.stats(), llm: { enabled: cfg.llm.enabled, hasKey: !!cfg.llm.apiKey, model: cfg.llm.model } } });
  }

  // ===== 题库 CRUD =====
  if (pathname === '/api/questions' && method === 'GET') {
    const data = store.list({
      page: Number(query.page) || 1,
      pageSize: Math.min(200, Number(query.pageSize) || 20),
      keyword: query.keyword || '',
      source: query.source || '',
      sort: query.sort || 'updatedAt',
    });
    return sendJSON(res, { ok: true, data });
  }

  if (pathname === '/api/questions' && method === 'POST') {
    const b = await readBody(req);
    if (!b.question || b.answer == null || b.answer === '') {
      return sendJSON(res, { ok: false, error: '题目和答案不能为空' }, 400);
    }
    const entry = store.add({
      question: b.question, options: b.options, type: b.type,
      answer: b.answer, explanation: b.explanation, source: 'manual', subject: b.subject,
    });
    return sendJSON(res, { ok: true, data: entry });
  }

  if (pathname === '/api/questions' && method === 'DELETE') {
    const n = store.clearAll();
    return sendJSON(res, { ok: true, data: { removed: n } });
  }

  const idMatch = pathname.match(/^\/api\/questions\/([\w-]+)$/);
  if (idMatch) {
    const id = idMatch[1];
    if (method === 'GET') {
      const entry = store.getById(id);
      if (!entry) return sendJSON(res, { ok: false, error: '未找到该题目' }, 404);
      return sendJSON(res, { ok: true, data: entry });
    }
    if (method === 'PUT') {
      const b = await readBody(req);
      const entry = store.update(id, b);
      if (!entry) return sendJSON(res, { ok: false, error: '未找到该题目' }, 404);
      return sendJSON(res, { ok: true, data: entry });
    }
    if (method === 'DELETE') {
      const ok = store.remove(id);
      return sendJSON(res, ok ? { ok: true } : { ok: false, error: '未找到该题目' }, ok ? 200 : 404);
    }
  }

  // ===== 导入导出 =====
  if (pathname === '/api/import' && method === 'POST') {
    const b = await readBody(req);
    const items = Array.isArray(b) ? b : b.items || [];
    if (!items.length) return sendJSON(res, { ok: false, error: '没有可导入的数据' }, 400);
    const r = store.importMany(items);
    return sendJSON(res, { ok: true, data: r });
  }

  if (pathname === '/api/export' && method === 'GET') {
    const all = store.exportAll();
    const format = query.format || 'json';
    if (format === 'csv') {
      const esc = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
      const rows = [['题目', '答案', '题型', '选项', '来源', '解析'].join(',')];
      for (const it of all) {
        rows.push([
          esc(it.question), esc(it.answer), esc(it.type || ''),
          esc((it.options || []).join(' | ')), esc(it.source || ''), esc(it.explanation || ''),
        ].join(','));
      }
      const csv = '\ufeff' + rows.join('\r\n');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="questions-${Date.now()}.csv"`,
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(csv);
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="questions-${Date.now()}.json"`,
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify({ version: 1, items: all }, null, 2));
  }

  // ===== 配置 =====
  if (pathname === '/api/config' && method === 'GET') {
    return sendJSON(res, { ok: true, data: config.publicConfig() });
  }

  if (pathname === '/api/config' && method === 'POST') {
    const b = await readBody(req);
    const current = JSON.parse(JSON.stringify(config.get()));
    const next = { ...current };
    if (b.server) next.server = { ...current.server, ...b.server };
    if (b.match) next.match = { ...current.match, ...b.match };
    if (b.storage) next.storage = { ...current.storage, ...b.storage };
    if (b.answer) next.answer = { ...current.answer, ...b.answer };
    if (b.providers) next.providers = b.providers;
    if (b.llm) {
      next.llm = { ...current.llm, ...b.llm };
    }
    const saved = config.save(next);
    return sendJSON(res, { ok: true, data: config.publicConfig() });
  }

  if (pathname === '/api/config/test-llm' && method === 'POST') {
    const b = await readBody(req);
    const current = config.get();
    const testCfg = {
      ...current.llm,
      ...(b || {}),
      enabled: true,
    };
    // 指定平台时用该平台的地址和密钥（文本/图片可能来自不同平台）
    if (b && b.platformId) {
      const pl = (current.llm.platforms || []).find((p) => p.id === b.platformId);
      if (pl) {
        if (pl.baseURL) testCfg.baseURL = pl.baseURL;
        if (pl.apiKey) testCfg.apiKey = pl.apiKey;
      }
    }
    if (!testCfg.apiKey) testCfg.apiKey = current.llm.apiKey;
    delete testCfg.platformId;
    try {
      const r = await llm.testConnection(testCfg, { images: parseImages(b && b.images) });
      return sendJSON(res, { ok: true, data: r });
    } catch (e) {
      return sendJSON(res, { ok: false, error: e.message });
    }
  }

  // 拉取某个平台可用的模型列表
  if (pathname === '/api/config/fetch-models' && method === 'POST') {
    const b = await readBody(req);
    const current = config.get();
    let baseURL = b.baseURL || '';
    let apiKey = b.apiKey || '';
    if (b.platformId) {
      const p = (current.llm.platforms || []).find((x) => x.id === b.platformId);
      if (p) {
        if (!baseURL) baseURL = p.baseURL || '';
        if (!apiKey) apiKey = p.apiKey || '';
      }
    }
    if (!apiKey) apiKey = current.llm.apiKey || '';
    try {
      const r = await llm.fetchModels({ baseURL, apiKey, timeout: Number(b.timeout) || 15000 });
      return sendJSON(res, { ok: true, data: r });
    } catch (e) {
      return sendJSON(res, { ok: false, error: e.message });
    }
  }

  if (pathname === '/api/config/test-provider' && method === 'POST') {
    const b = await readBody(req);
    const p = b.provider || b;
    const q = {
      title: b.title || '中华人民共和国成立于哪一年？',
      options: matcher.parseOptions(b.options || ['A. 1949年', 'B. 1945年', 'C. 1919年', 'D. 1978年']),
      type: b.type || 'single',
      images: parseImages(b.images),
    };
    const t0 = Date.now();
    try {
      const r = await providers.queryProvider({ ...p, enabled: true }, q);
      return sendJSON(res, { ok: true, data: { ...r, ms: Date.now() - t0 } });
    } catch (e) {
      return sendJSON(res, { ok: false, error: e.message, ms: Date.now() - t0 });
    }
  }

  // ===== 调试：链路测试 =====
  if (pathname === '/api/test' && method === 'POST') {
    const b = await readBody(req);
    const q = normalizeInput(b);
    if (!q.title) return sendJSON(res, { ok: false, error: '请输入题干' }, 400);
    const t0 = Date.now();
    const { result, chain } = await searchWithCache(q, { noCache: true, noLLM: !!b.noLLM });
    return sendJSON(res, { ok: result.code === 1, data: { result, chain, totalMs: Date.now() - t0 } });
  }

  // ===== 日志 =====
  if (pathname === '/api/logs') {
    return sendJSON(res, { ok: true, data: store.readLogs(Math.min(500, Number(query.limit) || 80)) });
  }

  // ===== OCS 配置文本 =====
  if (pathname === '/api/ocs-config') {
    const port = Number(query.port) || cfg.server.port;
    return sendJSON(res, { ok: true, data: { text: ocsConfigText(port) } });
  }

  // 修改服务端口：写配置 + 同步启动脚本 + 在同一进程内重新监听
  if (pathname === '/api/config/port' && method === 'POST') {
    const b = await readBody(req);
    const newPort = Number(b.port);
    if (!Number.isInteger(newPort) || newPort < 1024 || newPort > 65535) {
      return sendJSON(res, { ok: false, error: '端口需为 1024–65535 之间的整数' }, 400);
    }
    const cur = config.get();
    const host = process.env.HOST || cur.server.host || '127.0.0.1';
    const oldPort = currentPort || Number(process.env.PORT) || cur.server.port || 7788;
    if (newPort === oldPort) {
      return sendJSON(res, { ok: false, error: `当前已经是端口 ${oldPort}` }, 400);
    }

    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(newPort, host);
    });
    if (!free) {
      return sendJSON(res, { ok: false, error: `端口 ${newPort} 已被占用，请换一个` }, 400);
    }

    const next = JSON.parse(JSON.stringify(cur));
    next.server.port = newPort;
    config.save(next);

    const bat = syncStartScript(oldPort, newPort);

    // 响应先发出，再切换监听，避免当前请求自己卡住 close()
    setTimeout(() => rebindPort(newPort, oldPort), 350);
    return sendJSON(res, { ok: true, data: { port: newPort, batUpdated: bat } });
  }

  return sendJSON(res, { ok: false, error: '接口不存在: ' + pathname }, 404);
}

/* ---------------- 启动 ---------------- */

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  // OCS 5.x 会用 HEAD 探活，回 200 表示题库可用
  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }

  if (pathname.startsWith('/api/')) {
    try {
      await handleAPI(req, res, pathname, parsed.query);
    } catch (e) {
      console.error('[api]', pathname, e);
      if (!res.headersSent) sendJSON(res, { ok: false, error: e.message }, 500);
    }
    return;
  }

  serveStatic(req, res, pathname);
});

/* ---------------- 端口切换 ---------------- */

let currentPort = 0;

/** 同步启动脚本里写死的端口（按字节替换，不破坏 bat 的 GBK 中文） */
function syncStartScript(oldPort, newPort) {
  try {
    const batPath = path.join(config.ROOT, '启动服务.bat');
    if (!fs.existsSync(batPath)) return false;
    const raw = fs.readFileSync(batPath).toString('latin1');
    if (!raw.includes(String(oldPort))) return false;
    fs.writeFileSync(batPath, Buffer.from(raw.split(String(oldPort)).join(String(newPort)), 'latin1'));
    return true;
  } catch (e) {
    console.error('[port] 更新启动脚本失败:', e.message);
    return false;
  }
}

/** 在现有进程内改监听端口；失败自动回退到原端口 */
async function rebindPort(newPort, oldPort) {
  const host = process.env.HOST || config.get().server.host || '127.0.0.1';
  try {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve, reject) => {
      const onErr = (e) => reject(e);
      server.once('error', onErr);
      server.listen(newPort, host, () => { server.removeListener('error', onErr); resolve(); });
    });
    currentPort = newPort;
    console.log(`\n  [端口] 服务已切换到 ${newPort}，管理后台：http://127.0.0.1:${newPort}\n`);
  } catch (e) {
    console.error('[port] 切换失败，回退到', oldPort, e.message);
    try {
      await new Promise((resolve) => server.listen(oldPort, host, () => resolve()));
      currentPort = oldPort;
      const back = JSON.parse(JSON.stringify(config.get()));
      back.server.port = oldPort;
      config.save(back);
      syncStartScript(newPort, oldPort);
    } catch (_) { /* 忽略二次失败 */ }
  }
}

function start() {
  const cfg = config.get();
  const port = Number(process.env.PORT) || cfg.server.port || 7788;
  const host = process.env.HOST || cfg.server.host || '127.0.0.1';
  currentPort = port;

  store.stats(); // 触发加载
  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║        OCS 本地 AI 题库 · 服务已启动          ║');
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');
    console.log(`  管理后台：  http://${shown}:${port}`);
    console.log(`  OCS 接口：  http://${shown}:${port}/api/search`);
    console.log(`  题库条数：  ${store.stats().total}`);
    console.log(`  模型状态：  ${cfg.llm.apiKey ? `已配置 (${cfg.llm.model})` : '未配置 API Key'}`);
    console.log('');
    console.log('  关闭此窗口即停止服务');
    console.log('');

    // 由启动器拉起时自动打开管理后台
    if (process.env.OPEN_BROWSER === '1') {
      const target = `http://${shown}:${port}`;
      setTimeout(() => {
        const cmd = process.platform === 'win32'
          ? `start "" "${target}"`
          : process.platform === 'darwin' ? `open "${target}"` : `xdg-open "${target}"`;
        try { require('child_process').exec(cmd); } catch (_) { /* 忽略 */ }
      }, 500);
    }
    console.log('  按 Ctrl+C 停止服务');
    console.log('');
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n  [错误] 端口 ${port} 已被占用。\n  请关闭占用该端口的程序，或用 PORT=7789 npm start 换端口。\n`);
    } else {
      console.error('[server] 启动失败：', e);
    }
    process.exit(1);
  });
}

function shutdown() {
  try { store.flush(); } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 出错时不让进程静默退出：记录下来并继续服务，避免启动窗口莫名消失
function logCrash(kind, e) {
  const msg = `[${new Date().toISOString()}] ${kind}: ${e && e.stack ? e.stack : e}\n`;
  try {
    if (!fs.existsSync(config.DATA_DIR)) fs.mkdirSync(config.DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(config.DATA_DIR, 'crash.log'), msg, 'utf8');
  } catch (_) { /* 日志都写不了就算了 */ }
  console.error('\n  [服务异常] ' + (e && e.message ? e.message : e));
  console.error('  详细信息已写入 data/crash.log，服务会继续运行\n');
}

process.on('uncaughtException', (e) => logCrash('uncaughtException', e));
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e));

if (require.main === module) start();

module.exports = { start, server };
