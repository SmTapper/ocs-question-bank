'use strict';
/* 图片题 / 公式题链路测试（需先启动 tests/mock-llm.js）：node tests/image-test.js */
const BASE = process.env.BASE || 'http://127.0.0.1:7788';
const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:8899';

// 两张不同的最小 PNG（1x1），用来验证图片指纹区分
const PNG_BLUE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_RED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADklEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function call(path, body, method) {
  const res = await fetch(BASE + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

let pass = 0, fail = 0;
const check = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 300) : ''}`); }
};

(async () => {
  console.log('\n【0】清理上次图片题测试数据');
  const all = await call('/api/questions?pageSize=200');
  let removed = 0;
  for (const it of all.data.items) {
    if (/图片题测试/.test(it.question)) { await call('/api/questions/' + it.id, null, 'DELETE'); removed++; }
  }
  console.log(`  已清理 ${removed} 条`);

  console.log('\n【1】未配模型时，图片题应给出明确提示');
  const noKey = await call('/api/test', {
    title: '图片题测试：根据图示选择正确答案',
    images: [PNG_BLUE],
    type: 'single',
  });
  check('未命中', noKey.data.result.code === 0, noKey.data.result);
  check('提示是图片题需要视觉模型', /图片题/.test(noKey.data.result.msg || ''), noKey.data.result.msg);

  console.log('\n【2】配置视觉模型');
  const save = await call('/api/config', {
    llm: {
      enabled: true,
      baseURL: MOCK,
      apiKey: 'test-key',
      model: 'mock-text-model',
      visionModel: 'mock-vision-model',
      timeout: 15000,
    },
    storage: { autoSaveAI: true },
  });
  check('保存成功', save.ok, save);

  console.log('\n【3】图片题走多模态调用');
  const r = await call('/api/test', {
    title: '图片题测试：根据图示选择正确答案',
    options: 'A. 甲\nB. 乙\nC. 丙\nD. 丁',
    images: [PNG_BLUE],
    type: 'single',
  });
  check('返回成功', r.data.result.code === 1, r.data.result);
  check('答案为「丙」（来自模拟视觉模型）', r.data.result.answer === '丙', r.data.result);
  check('标记图片数', r.data.result.imageCount === 1, r.data.result);

  const last = await (await fetch(MOCK + '/_last')).json();
  check('请求走了多模态 content 数组', last.contentTypeIsArray === true, last);
  check('请求中带 1 张图片', last.imageCount === 1, last);
  check('使用了视觉模型', last.model === 'mock-vision-model', last);

  console.log('\n【4】同图同题应命中本地题库（不再调用模型）');
  const again = await call('/api/search', {
    title: '图片题测试：根据图示选择正确答案',
    options: 'A. 甲\nB. 乙\nC. 丙\nD. 丁',
    images: [PNG_BLUE],
    type: 'single',
  });
  check('命中本地', again.code === 1 && again.source === 'local', again);
  check('答案仍为「丙」', again.answer === '丙', again);

  console.log('\n【5】换一张图，同题干不应误命中');
  const diff = await call('/api/test', {
    title: '图片题测试：根据图示选择正确答案',
    options: 'A. 甲\nB. 乙\nC. 丙\nD. 丁',
    images: [PNG_RED],
    type: 'single',
  });
  check('未错误命中本地题库', diff.data.result.source === 'ai', diff.data.result);

  console.log('\n【6】纯文字题仍走原模型');
  const text = await call('/api/test', {
    title: '这是纯文字题测试，没有图片',
    options: 'A. 是\nB. 否',
    type: 'single',
  });
  const last2 = await (await fetch(MOCK + '/_last')).json();
  check('使用主模型', last2.model === 'mock-text-model', last2);
  check('不带图片', last2.imageCount === 0, last2);

  console.log('\n【7】OCS 配置包含图片题字段');
  const ocs = await call('/api/ocs-config');
  const cfg = JSON.parse(ocs.data.text)[0];
  check('含 v 字段', cfg.data.v === '2', cfg.data.v);
  check('images 使用字段解析器', typeof cfg.data.images === 'object' && !!cfg.data.images.handler, cfg.data.images);
  check('含 suggestion_title', cfg.data.suggestion_title === '${suggestion_title}', cfg.data.suggestion_title);
  check('含 suggestion_options', cfg.data.suggestion_options === '${suggestion_options}', cfg.data.suggestion_options);
  check('handler 可执行', (() => { try { new Function(cfg.handler); return true; } catch (_) { return false; } })());
  check('handler 能取到答案', (() => {
    const fn = new Function(cfg.handler)();
    const out = fn({ code: 1, question: 'q', answer: 'A', imageCount: 2 });
    return out[0] === 'q' && out[1] === 'A' && out[2].images === 2;
  })(), 'handler 结果异常');
  check('handler 失败时返回提示', (() => {
    const fn = new Function(cfg.handler)();
    const out = fn({ code: 0, msg: '题库未收录该题，且大模型未启用' });
    return out[0].includes('题库未收录') && out[1] === undefined;
  })(), '失败分支异常');

  console.log('\n【8】images 被逗号拼接成字符串时也能解析');
  const joined = await call('/api/test', {
    title: '图片题测试：逗号拼接兼容',
    images: PNG_BLUE + ',' + PNG_RED,
    type: 'single',
  });
  check('解析出 2 张图', joined.data.result.imageCount === 2, joined.data.result);

  console.log('\n【9】清理');
  const clean = await call('/api/config', { llm: { apiKey: '__CLEAR__', visionModel: '' } });
  check('已清除测试配置', clean.ok && clean.data.llm.hasApiKey === false, clean.data && clean.data.llm);
  const all2 = await call('/api/questions?pageSize=200');
  for (const it of all2.data.items) {
    if (/图片题测试/.test(it.question)) await call('/api/questions/' + it.id, null, 'DELETE');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
