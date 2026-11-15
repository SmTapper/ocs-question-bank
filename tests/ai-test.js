'use strict';
/* 大模型链路测试（需先启动 tests/mock-llm.js）：node tests/ai-test.js */
const BASE = process.env.BASE || 'http://127.0.0.1:7788';
const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:8899';

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
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + JSON.stringify(e).slice(0, 300) : ''}`); }
};

(async () => {
  console.log('\n【0】清理上次测试数据');
  const all = await call('/api/questions?pageSize=200');
  let removed = 0;
  for (const it of all.data.items) {
    if (/AI测试/.test(it.question)) {
      await call('/api/questions/' + it.id, null, 'DELETE');
      removed++;
    }
  }
  console.log(`  已清理 ${removed} 条`);

  console.log('\n【1】写入模型配置（故意不带 /v1，测试自动补全）');
  const save = await call('/api/config', {
    llm: {
      enabled: true,
      baseURL: MOCK,
      apiKey: 'test-key',
      model: 'mock-model',
      timeout: 15000,
    },
    storage: { autoSaveAI: true },
  });
  check('配置保存成功', save.ok && save.data.llm.hasApiKey, save.ok ? save.data.llm : save);
  check('Key 已脱敏', save.ok && !('apiKey' in save.data.llm ? save.data.llm.apiKey : false), save.data && save.data.llm);

  console.log('\n【2】测试连接');
  const t = await call('/api/config/test-llm', {});
  check('连接正常', t.ok === true, t);
  check('自动补全到 /v1/chat/completions', t.ok && /\/v1\/chat\/completions$/.test(t.data.endpoint), t.data);
  check('能解析出答案', t.ok && !!t.data.answer, t.data);

  console.log('\n【3】AI 兜底：题库未收录的题');
  const r = await call('/api/test', {
    title: '光合作用主要发生在植物细胞的哪个结构中？（AI测试题）',
    options: 'A. 线粒体\nB. 叶绿体\nC. 细胞核\nD. 液泡',
    type: 'single',
  });
  check('返回成功', r.ok === true, r);
  check('来源为 ai', r.data && r.data.result.source === 'ai', r.data && r.data.result);
  check('答案为「叶绿体」', r.data && r.data.result.answer === '叶绿体', r.data && r.data.result);
  check('带回解析', r.data && !!r.data.result.analysis, r.data && r.data.result);
  check('链路记录完整', r.data && r.data.chain.length >= 2
    && r.data.chain.some((c) => c.step === 'local')
    && r.data.chain.some((c) => c.step === 'llm'), r.data && r.data.chain);

  console.log('\n【4】AI 答案自动入库');
  const again = await call('/api/test', {
    title: '光合作用主要发生在植物细胞的哪个结构中？（AI测试题）',
    options: '',
    type: 'single',
  });
  check('第二次直接命中本地题库', again.data && again.data.result.source === 'local', again.data && again.data.result);

  console.log('\n【5】多选题 AI 作答');
  const m = await call('/api/test', {
    title: '下列哪些属于编程语言？（多选题，AI测试）',
    options: 'A. Python\nB. HTML\nC. Java\nD. SQL',
    type: 'multiple',
  });
  check('多选返回文本并用 # 连接', m.data && m.data.result.answer === 'Python#SQL', m.data && m.data.result);

  console.log('\n【6】不调用大模型开关');
  const noLLM = await call('/api/test', {
    title: '这道全新的题目绝对没有收录（关闭AI测试）',
    options: '',
    type: 'single',
    noLLM: true,
  });
  check('未命中且未调用模型', noLLM.data && noLLM.data.result.code === 0, noLLM.data);

  console.log('\n【7】思考模式：默认应发送 thinking=disabled');
  const r7 = await call('/api/test', { title: '思考模式检测题', options: 'A. 是\nB. 否', type: 'single' });
  check('调用成功', r7.data && r7.data.result.code === 1, r7.data && r7.data.result);
  const t1 = await (await fetch(MOCK + '/_last')).json();
  check('请求体带 thinking.disabled', t1.thinking && t1.thinking.type === 'disabled', t1);

  console.log('\n【7b】接口不认识 thinking 参数时应自动降级');
  await call('/api/config', { llm: { model: 'no-thinking-support' } });
  const degrade = await call('/api/test', { title: '降级测试题', options: 'A. 是\nB. 否', type: 'single' });
  check('降级后仍能作答', degrade.data && degrade.data.result.code === 1, degrade.data && degrade.data.result);
  await call('/api/config', { llm: { model: 'mock-model' } });

  console.log('\n【8】清理测试配置');
  const clean = await call('/api/config', { llm: { apiKey: '__CLEAR__', enabled: true } });
  check('已清除测试 Key', clean.ok && clean.data.llm.hasApiKey === false, clean.data && clean.data.llm);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
