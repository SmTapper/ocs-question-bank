'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// 数据目录：默认项目下的 data/；测试时用 OCS_DATA_DIR 指向临时目录，避免污染真实题库和密钥
const DATA_DIR = process.env.OCS_DATA_DIR
  ? path.resolve(process.env.OCS_DATA_DIR)
  : path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULT_CONFIG = {
  server: {
    port: 7788,
    // 只监听本机；如需手机/其他设备访问，改成 0.0.0.0
    host: '127.0.0.1',
  },
  // 匹配策略
  match: {
    enableFuzzy: true,      // 是否开启相似度匹配
    threshold: 0.88,        // 相似度阈值 0~1
    minLengthRatio: 0.6,    // 题干长度差异容忍度
  },
  // 大模型配置（OpenAI 兼容接口）
  llm: {
    enabled: true,
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    // 图片题使用的模型；留空则沿用文本模型
    visionModel: '',
    visionBaseURL: '',
    visionApiKey: '',
    // 深度思考：默认关闭。开启后可指定推理强度 low / high / max
    thinking: {
      enabled: false,
      effort: 'high',
    },
    temperature: 0.1,
    maxTokens: 1024,
    timeout: 45000,
    concurrency: 2,
    // 多平台管理（仅用于界面选择，选中后会写入上面的运行时字段）
    platforms: [],
    systemPrompt:
      '你是一个严谨的网课答题助手。请根据题干和选项判断正确答案。\n' +
      '只输出一个 JSON 对象，不要输出任何其他内容，格式为：\n' +
      '{"answer":"A","explanation":"简要解析"}\n' +
      '规则：\n' +
      '1. 单选/判断/填空：answer 为选项字母（如 "A"）或填空的答案文本。\n' +
      '2. 多选题：answer 为多个选项字母，用英文井号 # 连接，例如 "A#C"。\n' +
      '3. 判断题：answer 只返回「对」或「错」，不要返回选项字母。\n' +
      '4. 拿不准也要给出最可能的答案，不要回答"无法确定"。\n' +
      '5. explanation 控制在 60 字以内。',
  },
  // 答案格式
  answer: {
    multipleSeparator: '#', // 多选题答案分隔符，OCS 默认识别 #
    judgeTrue: '对',
    judgeFalse: '错',
    // 返回答案文本而不是选项字母，题库换选项顺序也不会答错
    preferText: true,
  },
  // 命中后是否回写
  storage: {
    autoSaveAI: true,        // AI 答出的题自动存入本地题库
    autoSaveProvider: true,  // 第三方题库答出的题自动存入本地题库
  },
  // 外部题库源
  providers: [],
};

function deepMerge(base, extra) {
  if (Array.isArray(base)) return Array.isArray(extra) ? extra : base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    if (extra && typeof extra === 'object') {
      for (const k of Object.keys(extra)) {
        out[k] = k in base ? deepMerge(base[k], extra[k]) : extra[k];
      }
    }
    return out;
  }
  return extra === undefined ? base : extra;
}

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

const PLATFORM_HINTS = [
  [/deepseek/i, 'DeepSeek'],
  [/dashscope|aliyun|qwen/i, '阿里云百炼'],
  [/bigmodel|zhipu|glm/i, '智谱'],
  [/moonshot|kimi/i, 'Kimi'],
  [/siliconflow/i, '硅基流动'],
  [/openrouter/i, 'OpenRouter'],
  [/openai\.com/i, 'OpenAI'],
  [/ollama/i, 'Ollama'],
  [/localhost|127\.0\.0\.1/i, '本地模型'],
];

function guessPlatformName(baseURL) {
  const u = String(baseURL || '');
  for (const [re, name] of PLATFORM_HINTS) if (re.test(u)) return name;
  try { return new URL(u).hostname || '自定义平台'; } catch (_) { return '自定义平台'; }
}

function buildPlatformFromLegacy(llm) {
  const models = [];
  if (llm.model) models.push({ id: llm.model, name: llm.model, type: 'text', enabled: true });
  if (llm.visionModel && llm.visionModel !== llm.model) {
    models.push({ id: llm.visionModel, name: llm.visionModel, type: 'vision', enabled: true });
  }
  return {
    id: 'p_default',
    name: guessPlatformName(llm.baseURL),
    baseURL: llm.baseURL || '',
    apiKey: llm.apiKey || '',
    enabled: true,
    models,
  };
}

/** 老配置迁移：disableThinking -> thinking，补齐平台列表 */
function migrate(c) {
  const llm = c.llm;
  if (!llm || typeof llm !== 'object') return c;

  if (!llm.thinking || typeof llm.thinking !== 'object') {
    llm.thinking = { enabled: llm.disableThinking === false, effort: 'high' };
  }
  if (typeof llm.thinking.enabled !== 'boolean') llm.thinking.enabled = false;
  if (!llm.thinking.effort) llm.thinking.effort = 'high';
  delete llm.disableThinking;

  if (typeof llm.visionBaseURL !== 'string') llm.visionBaseURL = '';
  if (typeof llm.visionApiKey !== 'string') llm.visionApiKey = '';

  if (!Array.isArray(llm.platforms)) llm.platforms = [];
  if (!llm.platforms.length) llm.platforms = [buildPlatformFromLegacy(llm)];
  return c;
}

function maskKey(k) {
  if (!k) return '';
  return k.length <= 8 ? '****' : k.slice(0, 4) + '****' + k.slice(-4);
}

/** 保存前把空密钥还原成原值，避免前端脱敏提交时把 key 抹掉；__CLEAR__ 表示主动清空 */
function mergeSecrets(next) {
  const cur = get();
  const out = JSON.parse(JSON.stringify(next || {}));
  if (!out.llm) return out;

  const keepOrClear = (v, old) => {
    if (v === '__CLEAR__') return '';
    if (!v || v === '__KEEP__') return old || '';
    return v;
  };

  out.llm.apiKey = keepOrClear(out.llm.apiKey, cur.llm.apiKey);
  out.llm.visionApiKey = keepOrClear(out.llm.visionApiKey, cur.llm.visionApiKey);

  const oldMap = new Map((cur.llm.platforms || []).map((p) => [p.id, p]));
  out.llm.platforms = (out.llm.platforms || []).map((p) => {
    const old = oldMap.get(p.id);
    return { ...p, apiKey: keepOrClear(p.apiKey, old ? old.apiKey : '') };
  });
  return out;
}

/** 按选中的平台补齐运行时地址和密钥（前端不接触明文 key） */
function fillRuntimeFromPlatforms(c) {
  const llm = c.llm;
  if (!llm) return;
  const platforms = llm.platforms || [];
  const pick = (pid) => platforms.find((p) => p.id === pid);

  if (llm.textPlatformId) {
    const p = pick(llm.textPlatformId);
    if (p) {
      if (p.baseURL) llm.baseURL = p.baseURL;
      if (p.apiKey) llm.apiKey = p.apiKey;
    }
  }
  if (llm.visionPlatformId) {
    const p = pick(llm.visionPlatformId);
    if (p) {
      if (p.baseURL) llm.visionBaseURL = p.baseURL;
      if (p.apiKey) llm.visionApiKey = p.apiKey;
    }
  }
}

let cache = null;

function load() {
  if (cache) return cache;
  ensureDirs();
  let raw = {};
  const exists = fs.existsSync(CONFIG_FILE);
  if (exists) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
      console.error('[config] 配置文件解析失败，已使用默认配置：', e.message);
      raw = {};
    }
  }
  cache = migrate(deepMerge(DEFAULT_CONFIG, raw));
  // 首次启动生成配置文件，方便用户直接手动编辑（改端口、局域网访问等）
  // 老配置迁移后也写回一次，保证磁盘结构和新版一致
  try {
    const nextText = JSON.stringify(cache, null, 2);
    const curText = exists ? fs.readFileSync(CONFIG_FILE, 'utf8') : '';
    if (nextText !== curText) fs.writeFileSync(CONFIG_FILE, nextText, 'utf8');
  } catch (_) { /* ignore */ }
  return cache;
}

function save(next) {
  ensureDirs();
  const merged = mergeSecrets(next || {});
  fillRuntimeFromPlatforms(merged);
  cache = migrate(deepMerge(DEFAULT_CONFIG, merged));
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return cache;
}

function get() {
  return load();
}

// 返回给前端的版本：隐藏完整 key，只给掩码
function publicConfig() {
  const c = JSON.parse(JSON.stringify(get()));
  const llm = c.llm;
  if (llm) {
    llm.hasApiKey = !!llm.apiKey;
    llm.apiKeyMasked = maskKey(llm.apiKey);
    llm.apiKey = '';
    llm.hasVisionApiKey = !!llm.visionApiKey;
    llm.visionApiKey = '';
    llm.platforms = (llm.platforms || []).map((p) => ({
      ...p,
      hasKey: !!p.apiKey,
      apiKeyMasked: maskKey(p.apiKey),
      apiKey: '',
    }));
  }
  return c;
}

module.exports = {
  ROOT, DATA_DIR, CONFIG_FILE, DEFAULT_CONFIG,
  get, save, load, publicConfig, ensureDirs, guessPlatformName, maskKey,
};
