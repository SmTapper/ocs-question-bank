'use strict';

/**
 * 题干归一化与相似度匹配
 */

const FULL2HALF = (() => {
  const map = {};
  for (let i = 0xff01; i <= 0xff5e; i++) map[String.fromCharCode(i)] = String.fromCharCode(i - 0xfee0);
  map['\u3000'] = ' ';
  return map;
})();

const PUNCT_RE = /[\s，。？！；：、""''「」『』（）《》【】〈〉…—～·,.\?!;:"'`()<>\[\]{}|\\\/\-_=+*&^%$#@!~]/g;

// 题干常见噪声前缀，如 【单选题】、1.、（1）、第1题
const NOISE_PREFIX = [
  /^\s*[【\[（(]?\s*(单选题?|多选题?|判断题?|填空题?|简答题?|论述题?|不定项选择题?)\s*[】\]）)]?\s*/i,
  /^\s*第?\s*\d+\s*[题、.,．)\]）]\s*/,
  /^\s*[（(]\s*\d+\s*[）)]\s*/,
  /^\s*[A-Za-z]\s*[.、．)]\s*/,
];

function normalize(text) {
  let s = String(text == null ? '' : text);
  s = s.normalize('NFKC');
  s = s.replace(/[\uff01-\uff5e]/g, (c) => FULL2HALF[c] || c);
  s = s.replace(/\s+/g, '');
  s = s.replace(PUNCT_RE, '');
  s = s.toLowerCase();
  for (const re of NOISE_PREFIX) s = s.replace(re, '');
  return s;
}

/** 字符 bigram 集合 */
function bigrams(s) {
  const out = new Map();
  if (!s) return out;
  if (s.length === 1) {
    out.set(s, 1);
    return out;
  }
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

/** Dice 系数 */
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [g, n] of ga) {
    total += n;
    const m = gb.get(g);
    if (m) inter += Math.min(n, m);
  }
  for (const [, n] of gb) total += n;
  if (total === 0) return 0;
  return (2 * inter) / total;
}

/**
 * 解析选项：支持数组、换行文本、"A. xx B. yy" 单行
 */
function parseOptions(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.map((x) => String(x).trim()).filter(Boolean);
  let s = String(input).trim();
  if (!s) return [];
  // 已经是 JSON 数组字符串
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean);
    } catch (_) { /* ignore */ }
  }
  let parts = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (parts.length <= 1) {
    // 单行用 "A." "B、" 切分
    const split = s.split(/\s*(?=(?:^|\s)[A-Ha-h]\s*[.、．)）:：])/).map((x) => x.trim()).filter(Boolean);
    if (split.length > 1) parts = split;
  }
  return parts;
}

const OPTION_PREFIX = /^\s*([A-Ha-h])\s*[.、．)）:：]\s*/;

function optionLetter(opt) {
  const m = String(opt).match(OPTION_PREFIX);
  return m ? m[1].toUpperCase() : null;
}

function optionText(opt) {
  return String(opt).replace(OPTION_PREFIX, '').trim();
}

/** 判断题语义词表（先判「错」再判「对」，避免"不正确"被"正确"误伤） */
const JUDGE_FALSE_WORDS = ['错误', '错的', '不正确', '不正确的', '不对', '不是', '不是的', '错', '否', '非', '×', 'x', 'false', 'f', 'no', '0'];
const JUDGE_TRUE_WORDS = ['正确', '正确的', '对的', '是的', '确定', '对', '是', '√', 'true', 't', 'yes', '1'];

function judgeValue(text) {
  const s = String(text || '').replace(/[\s。.!！,，、:：;；"'“”]/g, '').toLowerCase();
  if (!s) return null;
  if (JUDGE_FALSE_WORDS.includes(s)) return false;
  if (JUDGE_TRUE_WORDS.includes(s)) return true;
  // 选项里常见「该说法正确」这类长句，退化为关键词判断
  if (/不正确|不对|不是|错误|错的/.test(s)) return false;
  if (/正确|对的|是的|^对$|^是$/.test(s)) return true;
  return null;
}

/**
 * 把答案转成「选项文本」形式，避免依赖选项顺序
 * - "C" + ["A. 甲","B. 乙","C. 丙"]  ->  "丙"
 * - "A#C"                            ->  "甲#丙"
 * - 已经是文本的答案原样保留（去选项前缀）
 * 无选项或字母越界时返回空串
 */
function answerToText(answer, options, sep) {
  const d = sep || '#';
  const opts = Array.isArray(options) ? options : parseOptions(options);
  if (!opts.length) return '';
  const parts = String(answer == null ? '' : answer).split(/[#＃]/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  const out = [];
  for (const p of parts) {
    if (/^[A-Ha-h]$/.test(p)) {
      const idx = p.toUpperCase().charCodeAt(0) - 65;
      const opt = opts[idx];
      if (opt == null) return '';
      const txt = optionText(opt);
      if (!txt) return '';
      out.push(txt);
    } else {
      out.push(optionText(p));
    }
  }
  return out.join(d);
}

/**
 * 把答案统一成 OCS 可识别的字符串
 * - 数组 -> 用分隔符连接
 * - 判断题 -> 必须转成「对/错」这类语义词，OCS 不认选项字母
 * - 判断题 true/false 映射
 */
function normalizeAnswer(answer, type, options, cfg) {
  const sep = (cfg && cfg.answer && cfg.answer.multipleSeparator) || '#';
  const judgeTrue = (cfg && cfg.answer && cfg.answer.judgeTrue) || '对';
  const judgeFalse = (cfg && cfg.answer && cfg.answer.judgeFalse) || '错';

  if (answer == null) return '';
  let arr = [];

  if (Array.isArray(answer)) arr = answer.map((x) => String(x).trim()).filter(Boolean);
  else {
    let s = String(answer).trim();
    if (!s) return '';
    // JSON 数组字符串
    if (s.startsWith('[')) {
      try {
        const a = JSON.parse(s);
        if (Array.isArray(a)) arr = a.map((x) => String(x).trim()).filter(Boolean);
      } catch (_) { /* ignore */ }
    }
    if (!arr.length) {
      if (/[#＃;；|,]/.test(s)) {
        arr = s.split(/[#＃;；|,]/).map((x) => x.trim()).filter(Boolean);
      } else {
        // 连续字母 "AC" -> A, C（仅当选项数足够且都是合法字母时）
        const compact = s.replace(/\s/g, '');
        if (/^[A-Ha-h]{2,}$/.test(compact) && options && options.length >= compact.length) {
          arr = compact.split('').map((c) => c.toUpperCase());
        } else {
          arr = [s];
        }
      }
    }
  }

  // 判断题：OCS 用「对/正确/是」与「错/错误/否」两组词做语义匹配，不认选项字母
  const t = String(type || '').toLowerCase();
  const looksJudge = /^(true|false|对|错|正确|错误|是|否|t|f|√|×)$/i.test(arr[0] || '');
  if (t.includes('judge') || t.includes('判断') || looksJudge) {
    let v = String(arr[0] || '').trim();
    // 模型给的是选项字母时，先换成对应的选项文本再判语义
    if (/^[A-Ha-h]$/.test(v) && Array.isArray(options) && options.length > 1) {
      const idx = v.toUpperCase().charCodeAt(0) - 65;
      const opt = options[idx];
      if (opt != null) v = optionText(opt);
    }
    let val = judgeValue(v);
    // 没有选项、又只给了字母：按常见约定 A=对 / B=错 兜底
    if (val === null && /^[A-Ha-h]$/.test(v)) val = v.toUpperCase() === 'A';
    if (val === true) arr = [judgeTrue];
    else if (val === false) arr = [judgeFalse];
  }

  // 去重保序
  const seen = new Set();
  const uniq = [];
  for (const x of arr) {
    const k = x.toUpperCase();
    if (!seen.has(k)) { seen.add(k); uniq.push(x); }
  }
  return uniq.join(sep);
}

/**
 * 选项重排映射：题库里记录的选项顺序和当前题目选项顺序可能不同，
 * 需要把题库答案的字母映射到当前题目的字母。
 */
function remapByOptionText(answer, storedOptions, currentOptions) {
  if (!storedOptions || !currentOptions) return answer;
  const so = parseOptions(storedOptions);
  const co = parseOptions(currentOptions);
  if (so.length < 2 || co.length < 2) return answer;
  const letters = String(answer).split(/[#＃]/).map((x) => x.trim().toUpperCase());
  if (!letters.every((l) => /^[A-H]$/.test(l))) return answer;

  const mapped = [];
  for (const L of letters) {
    const idx = L.charCodeAt(0) - 65;
    const text = so[idx];
    if (text == null) return answer;
    const plain = optionText(text);
    const norm = normalize(plain);
    let found = -1;
    for (let i = 0; i < co.length; i++) {
      if (normalize(optionText(co[i])) === norm) { found = i; break; }
    }
    if (found < 0) {
      // 退化为相似度
      let best = -1; let bestScore = 0.85;
      for (let i = 0; i < co.length; i++) {
        const sc = similarity(norm, normalize(optionText(co[i])));
        if (sc > bestScore) { bestScore = sc; best = i; }
      }
      found = best;
    }
    if (found < 0) return answer; // 无法映射，保留原答案
    mapped.push(String.fromCharCode(65 + found));
  }
  return mapped.length ? mapped.join((answer.match(/[#＃]/) || ['#'])[0]) : answer;
}

module.exports = {
  normalize, similarity, parseOptions,
  optionLetter, optionText, normalizeAnswer, remapByOptionText, answerToText,
};
