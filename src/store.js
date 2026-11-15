'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');
const { normalize, similarity, parseOptions, remapByOptionText, answerToText } = require('./matcher');

const DB_FILE = path.join(DATA_DIR, 'questions.json');
const LOG_FILE = path.join(DATA_DIR, 'query.log.jsonl');

/** 内存索引：norm -> entry */
let index = new Map();
let loaded = false;
let saveTimer = null;
let dirty = false;

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * 图片指纹：题目/选项里的图片内容不变时，哈希稳定，
 * 用于让「同一道图片题」能命中同一道题，而不会和纯文字题混淆。
 */
function imageHash(images) {
  if (!Array.isArray(images) || !images.length) return '';
  const h = crypto.createHash('sha256');
  for (const img of images) h.update(String(img || ''));
  return h.digest('hex').slice(0, 16);
}

/** 索引键：题干文本 + 图片指纹（有图才加后缀） */
function buildNorm(text, imgHash) {
  const base = normalize(text);
  if (!base) return '';
  return imgHash ? base + '\u0001img:' + imgHash : base;
}

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (loaded) return;
  loaded = true;
  if (!fs.existsSync(DB_FILE)) {
    index = new Map();
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.items || [];
    index = new Map();
    for (const it of list) {
      if (!it || !it.question) continue;
      const norm = it.norm || buildNorm(it.question, it.imageHash || '');
      it.norm = norm;
      it.id = it.id || uid();
      // 老数据补齐「答案文本」，避免依赖选项顺序
      if (it.answerText === undefined) {
        it.answerText = answerToText(it.answer, it.options, '#');
        dirty = true;
      }
      if (!index.has(norm)) index.set(norm, it);
    }
    console.log(`[store] 已加载题库 ${index.size} 条`);
    if (dirty) persist();
  } catch (e) {
    console.error('[store] 题库文件损坏，已备份并重新开始：', e.message);
    try { fs.renameSync(DB_FILE, DB_FILE + '.broken-' + Date.now()); } catch (_) {}
    index = new Map();
  }
}

function persistNow() {
  if (!dirty) return;
  const arr = [...index.values()];
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: Date.now(), items: arr }, null, 0), 'utf8');
  fs.renameSync(tmp, DB_FILE);
  dirty = false;
}

function persist() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { persistNow(); } catch (e) { console.error('[store] 保存失败', e.message); }
  }, 400);
}

function add({ question, indexText, options, type, answer, explanation, source, subject, images }) {
  ensure();
  if (!question || answer == null || answer === '') return null;
  const imgHash = imageHash(images);
  const norm = buildNorm(indexText || question, imgHash);
  if (!norm) return null;
  const now = Date.now();
  const optsArr = options ? parseOptions(options) : [];
  const text = answerToText(String(answer), optsArr, '#');
  const exist = index.get(norm);
  if (exist) {
    exist.answer = String(answer);
    exist.answerText = text;
    if (options) exist.options = optsArr;
    if (type) exist.type = type;
    if (explanation) exist.explanation = explanation;
    if (source) exist.source = source;
    exist.updatedAt = now;
    persist();
    return exist;
  }
  const entry = {
    id: uid(),
    question: String(question).trim(),
    norm,
    options: optsArr,
    type: type || '',
    answer: String(answer),
    answerText: text,
    explanation: explanation || '',
    source: source || 'manual',
    subject: subject || '',
    imageHash: imgHash,
    imageCount: Array.isArray(images) ? images.length : 0,
    hits: 0,
    createdAt: now,
    updatedAt: now,
  };
  index.set(norm, entry);
  persist();
  return entry;
}

function update(id, patch) {
  ensure();
  for (const [norm, it] of index) {
    if (it.id === id) {
      const newQuestion = patch.question != null ? String(patch.question).trim() : it.question;
      const newNorm = normalize(newQuestion);
      if (newNorm && newNorm !== norm) {
        index.delete(norm);
        it.norm = newNorm;
        index.set(newNorm, it);
      }
      it.question = newQuestion;
      if (patch.answer != null) it.answer = String(patch.answer);
      if (patch.options != null) it.options = parseOptions(patch.options);
      if (patch.type != null) it.type = patch.type;
      if (patch.explanation != null) it.explanation = patch.explanation;
      if (patch.subject != null) it.subject = patch.subject;
      if (patch.source != null) it.source = patch.source;
      // 答案或选项变了，重算答案文本
      if (patch.answer != null || patch.options != null) {
        it.answerText = answerToText(it.answer, it.options, '#');
      }
      it.updatedAt = Date.now();
      persist();
      return it;
    }
  }
  return null;
}

function remove(id) {
  ensure();
  for (const [norm, it] of index) {
    if (it.id === id) {
      index.delete(norm);
      persist();
      return true;
    }
  }
  return false;
}

function clearAll() {
  ensure();
  const n = index.size;
  index = new Map();
  persist();
  return n;
}

function getById(id) {
  ensure();
  for (const it of index.values()) if (it.id === id) return it;
  return null;
}

/**
 * 查题：精确 -> 模糊
 * 返回 { entry, score, type: 'exact'|'fuzzy' } 或 null
 */
function lookup(question, options, cfg, images) {
  ensure();
  const imgHash = imageHash(images);
  const norm = buildNorm(question, imgHash);
  if (!norm) return null;

  const exact = index.get(norm);
  if (exact) {
    exact.hits = (exact.hits || 0) + 1;
    exact.lastHitAt = Date.now();
    persist();
    return { entry: exact, score: 1, matchType: 'exact' };
  }

  // 图片题只认「同图 + 同题干」，不做模糊匹配，否则容易张冠李戴
  if (imgHash) return null;

  const m = (cfg && cfg.match) || {};
  if (m.enableFuzzy === false) return null;

  const threshold = Number(m.threshold) || 0.88;
  const minRatio = Number(m.minLengthRatio) || 0.6;
  let best = null;
  let bestScore = 0;

  for (const it of index.values()) {
    if (!it.norm) continue;
    const lenRatio = Math.min(it.norm.length, norm.length) / Math.max(it.norm.length, norm.length);
    if (lenRatio < minRatio) continue;
    const sc = similarity(norm, it.norm);
    if (sc > bestScore) { bestScore = sc; best = it; }
  }

  if (best && bestScore >= threshold) {
    best.hits = (best.hits || 0) + 1;
    best.lastHitAt = Date.now();
    persist();
    return { entry: best, score: Number(bestScore.toFixed(4)), matchType: 'fuzzy' };
  }
  return null;
}

function search(keyword, limit = 50) {
  ensure();
  const kw = normalize(keyword || '');
  const out = [];
  for (const it of index.values()) {
    if (!kw || it.norm.includes(kw)) out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

function list({ page = 1, pageSize = 20, keyword = '', source = '', sort = 'updatedAt' } = {}) {
  ensure();
  const kw = normalize(keyword || '');
  let arr = [];
  for (const it of index.values()) {
    if (kw && !it.norm.includes(kw) && !String(it.answer).toLowerCase().includes(kw)) continue;
    if (source && it.source !== source) continue;
    arr.push(it);
  }
  arr.sort((a, b) => (b[sort] || 0) - (a[sort] || 0));
  const total = arr.length;
  const start = (Math.max(1, page) - 1) * pageSize;
  return { total, page, pageSize, items: arr.slice(start, start + pageSize) };
}

function stats() {
  ensure();
  const bySource = {};
  const byType = {};
  let withOption = 0;
  let withImage = 0;
  for (const it of index.values()) {
    const s = it.source || 'unknown';
    bySource[s] = (bySource[s] || 0) + 1;
    const t = it.type || '未标注';
    byType[t] = (byType[t] || 0) + 1;
    if (it.options && it.options.length) withOption++;
    if (it.imageCount) withImage++;
  }
  return { total: index.size, withOption, withImage, bySource, byType };
}

function exportAll() {
  ensure();
  return [...index.values()];
}

function importMany(items) {
  ensure();
  let added = 0;
  let updated = 0;
  for (const it of items || []) {
    if (!it || !it.question || it.answer == null || it.answer === '') continue;
    const before = index.get(normalize(it.question));
    const r = add({
      question: it.question,
      options: it.options,
      type: it.type,
      answer: it.answer,
      explanation: it.explanation,
      source: it.source || 'import',
      subject: it.subject,
    });
    if (!r) continue;
    if (before) updated++; else added++;
  }
  persistNow();
  return { added, updated, total: index.size };
}

/**
 * 求解：本地命中后返回答案
 * 优先返回「选项文本」，这样 OCS 换选项顺序也不会错
 */
function resolve(question, options, cfg, images) {
  const hit = lookup(question, options, cfg, images);
  if (!hit) return null;
  const entry = hit.entry;
  const preferText = !cfg || !cfg.answer || cfg.answer.preferText !== false;

  let answer;
  if (preferText && entry.answerText) {
    answer = entry.answerText;
  } else if (options && entry.options && entry.options.length) {
    // 退回字母方案：按选项文本把字母重新映射到当前选项
    answer = remapByOptionText(entry.answer, entry.options, options);
  } else {
    answer = entry.answer;
  }
  return { ...hit, answer, explanation: entry.explanation || '', answerText: entry.answerText || '' };
}

/* ---------------- 查询日志 ---------------- */

function logQuery(rec) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ t: Date.now(), ...rec }) + '\n', 'utf8');
  } catch (_) { /* ignore */ }
}

function readLogs(limit = 100) {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n');
    return lines.slice(-limit).reverse().map((l) => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  persistNow();
}

module.exports = {
  add, update, remove, clearAll, getById, lookup, resolve, search, list, stats,
  exportAll, importMany, logQuery, readLogs, flush, normalize,
};
