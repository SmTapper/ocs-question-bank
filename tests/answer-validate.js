'use strict';
/**
 * 答案合法性防线测试
 * 复现真实故障：多行 C 代码选项被按换行拆成 15 项 → 模型选出第 13 项「M」
 * → 旧版本无校验，直接返回并自动入库，后续查询永久命中错答案。
 */
const BASE = process.env.BASE || 'http://127.0.0.1:7788';
const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:8899';
const matcher = require('../src/matcher');

async function call(path, body, method) {
  const res = await fetch(BASE + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

let pass = 0;
let fail = 0;
const check = (n, c, e) => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${e ? '  → ' + JSON.stringify(e).slice(0, 300) : ''}`); }
};

(async () => {
  console.log('\n【1】matcher.isValidAnswer 规则校验');
  const fifteen = Array.from({ length: 15 }, (_, i) => '代码片段' + i);
  const four = ['A 内容', 'B 内容', 'C 内容', 'D 内容'];

  check('M + 15 选项 → 拒绝', matcher.isValidAnswer('M', { type: 'single', options: fifteen }, {}) === false);
  check('M + 无选项 → 拒绝', matcher.isValidAnswer('M', { type: 'single', options: [] }, {}) === false);
  check('E + 4 选项 → 拒绝', matcher.isValidAnswer('E', { type: 'single', options: four }, {}) === false);
  check('A + 4 选项 → 放行', matcher.isValidAnswer('A', { type: 'single', options: four }, {}) === true);
  check('A#C + 4 选项 → 放行', matcher.isValidAnswer('A#C', { type: 'multiple', options: four }, {}) === true);
  check('A#E + 4 选项 → 拒绝', matcher.isValidAnswer('A#E', { type: 'multiple', options: four }, {}) === false);
  check('文本答案 → 放行', matcher.isValidAnswer('int f(int x,int y)', { type: 'single', options: fifteen }, {}) === true);
  check('填空单字母 A → 放行', matcher.isValidAnswer('A', { type: 'completion', options: [] }, {}) === true);
  check('空答案 → 拒绝', matcher.isValidAnswer('', { type: 'single', options: four }, {}) === false);

  console.log('\n【2】集成：模型返回越界字母时拦截且不入库');
  await call('/api/config', {
    llm: {
      enabled: true,
      apiKey: 'sk-test',
      baseURL: MOCK,
      model: 'mock',
      platforms: [],
    },
    storage: { autoSaveAI: true },
  });

  const title = '越界答案测试：以下正确的函数定义形式是( )';
  const options = Array.from({ length: 15 }, (_, i) => '代码片段 ' + i);
  const r = await call('/api/search', { title, options, type: 'single' });
  check('未把 M 返回给用户', !(r.code === 1 && String(r.answer).trim() === 'M'), r);
  check('判定为未命中', r.code === 0, r);

  const bank = await call('/api/questions?pageSize=500');
  const polluted = (bank.data && bank.data.items || [])
    .filter((x) => String(x.question || '').includes('越界答案测试'));
  check('未写入题库（无二次污染）', polluted.length === 0, polluted);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常:', e.message);
  process.exit(1);
});
