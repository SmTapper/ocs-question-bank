'use strict';
/* 冒烟测试：node tests/smoke.js */

const BASE = process.env.BASE || 'http://127.0.0.1:7788';

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

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + JSON.stringify(extra) : ''}`); }
}

(async () => {
  console.log('\n【1】添加题目');
  await call('/api/questions', {
    question: '下列哪一项不是操作系统的功能？',
    options: ['A. 进程管理', 'B. 内存管理', 'C. 文字处理', 'D. 文件管理'],
    answer: 'C',
    type: 'single',
  });
  await call('/api/questions', {
    question: '计算机网络中 OSI 参考模型共有几层？',
    options: ['A. 5层', 'B. 6层', 'C. 7层', 'D. 8层'],
    answer: 'C',
    type: 'single',
  });
  await call('/api/questions', {
    question: '下列属于操作系统的是（多选）',
    options: ['A. Windows', 'B. Linux', 'C. Word', 'D. macOS'],
    answer: 'A#B#D',
    type: 'multiple',
  });
  const stats = await call('/api/stats');
  check('题库共 3 题', stats.data.total === 3, stats.data);

  console.log('\n【2】精确命中');
  const r1 = await call('/api/search', {
    title: '下列哪一项不是操作系统的功能？',
    options: 'A. 进程管理\nB. 内存管理\nC. 文字处理\nD. 文件管理',
    type: 'single',
  });
  check('返回 code=1', r1.code === 1, r1);
  check('返回答案文本「文字处理」', r1.answer === '文字处理', r1);
  check('来源 local', r1.source === 'local', r1);
  check('包含题干回显', !!r1.question, r1);

  console.log('\n【3】脏数据命中（空格/标点/题号/题型前缀）');
  const r2 = await call('/api/search', {
    title: '【单选题】1. 下列哪一项 不是操作系统的功能？',
    options: '',
    type: 'single',
  });
  check('仍能命中', r2.code === 1 && r2.answer === '文字处理', r2);

  console.log('\n【4】选项顺序打乱后仍返回正确答案文本');
  const r3 = await call('/api/search', {
    title: '下列哪一项不是操作系统的功能？',
    options: 'A. 文字处理\nB. 内存管理\nC. 进程管理\nD. 文件管理',
    type: 'single',
  });
  check('答案仍是「文字处理」（不随顺序变）', r3.code === 1 && r3.answer === '文字处理', r3);

  console.log('\n【5】多选题');
  const r4 = await call('/api/search', {
    title: '下列属于操作系统的是（多选）',
    options: 'A. macOS\nB. Linux\nC. Word\nD. Windows',
    type: 'multiple',
  });
  check('多选返回文本且用 # 连接', r4.code === 1 && r4.answer === 'Windows#Linux#macOS', r4);

  console.log('\n【6】相似题模糊命中');
  const r5 = await call('/api/search', {
    title: '计算机网络中OSI参考模型一共有几层',
    options: '',
    type: 'single',
  });
  check('相似度命中', r5.code === 1 && r5.answer === '7层', r5);

  console.log('\n【7】未收录且未配模型');
  const r6 = await call('/api/search', {
    title: '这道题题库里绝对没有收录过关于量子纠缠的奇怪问题？',
    options: '',
    type: 'single',
  });
  check('返回 code=0', r6.code === 0, r6);
  check('有失败原因', !!r6.msg, r6);

  console.log('\n【8】GET 方式调用（兼容）');
  const qs = new URLSearchParams({ title: '下列哪一项不是操作系统的功能？' });
  const r7 = await (await fetch(`${BASE}/api/search?${qs}`)).json();
  check('GET 可用', r7.code === 1, r7);

  console.log('\n【9】批量导入 + 导出');
  const imp = await call('/api/import', {
    items: [
      { question: 'HTTP 默认端口是？', answer: '80', type: 'completion' },
      { question: 'Linux 中查看进程的命令是？', answer: 'ps', type: 'completion' },
    ],
  });
  check('导入 2 条', imp.ok && imp.data.added === 2, imp);
  const exp = await (await fetch(BASE + '/api/export?format=json')).json();
  check('导出包含 5 条', exp.items.length === 5, exp.items.length);

  console.log('\n【10】删题 / 更新');
  const list = await call('/api/questions?pageSize=50');
  const target = list.data.items.find((x) => x.question.includes('HTTP'));
  const upd = await call('/api/questions/' + target.id, { answer: '80/tcp' }, 'PUT');
  check('更新成功', upd.ok && upd.data.answer === '80/tcp', upd);
  const del = await call('/api/questions/' + target.id, null, 'DELETE');
  check('删除成功', del.ok === true, del);

  console.log('\n【11】OCS 配置生成');
  const ocs = await call('/api/ocs-config');
  let cfgArr = null;
  try { cfgArr = JSON.parse(ocs.data.text); } catch (_) {}
  check('配置是合法 JSON 数组', Array.isArray(cfgArr) && cfgArr.length === 1, ocs.data.text);
  check('url 指向 /api/search', cfgArr && cfgArr[0].url.includes('/api/search'), cfgArr && cfgArr[0]);
  check('handler 可被 Function 构造', (() => {
    try { new Function(cfgArr[0].handler); return true; } catch (_) { return false; }
  })(), cfgArr && cfgArr[0].handler);
  check('handler 能正确解析返回', (() => {
    try {
      const fn = new Function(cfgArr[0].handler)();
      const r = fn({ code: 1, question: 'q', answer: 'A', source: 'local' });
      return Array.isArray(r) && r[0] === 'q' && r[1] === 'A';
    } catch (e) { return false; }
  })(), 'handler 解析失败');

  console.log('\n【12】日志');
  const logs = await call('/api/logs?limit=5');
  check('有日志记录', logs.ok && logs.data.length > 0, logs.data && logs.data.length);

  console.log('\n【13】判断题：答案必须转成语义词，OCS 不认字母');
  // 题库存的是字母 B，选项是「对/错」
  await call('/api/questions', {
    question: '压力越大说明心理素质越差。（判断题1）',
    options: ['A. 对', 'B. 错'],
    answer: 'B',
    type: 'judgement',
  });
  const j1 = await call('/api/search', { title: '压力越大说明心理素质越差。（判断题1）', options: 'A. 对\nB. 错', type: 'judgement' });
  check('字母 B -> 「错」', j1.code === 1 && j1.answer === '错', j1);

  // 选项是「正确/错误」
  await call('/api/questions', {
    question: '心理健康与身体健康无关。（判断题2）',
    options: ['A. 正确', 'B. 错误'],
    answer: 'B',
    type: 'judgement',
  });
  const j2 = await call('/api/search', { title: '心理健康与身体健康无关。（判断题2）', options: 'A. 正确\nB. 错误', type: 'judgement' });
  check('选项为正确/错误时 -> 「错」', j2.code === 1 && j2.answer === '错', j2);

  // 答案为字母 A
  await call('/api/questions', {
    question: '适度压力有助于提高效率。（判断题3）',
    options: ['A. 对', 'B. 错'],
    answer: 'A',
    type: 'judgement',
  });
  const j3 = await call('/api/search', { title: '适度压力有助于提高效率。（判断题3）', options: 'A. 对\nB. 错', type: 'judgement' });
  check('字母 A -> 「对」', j3.code === 1 && j3.answer === '对', j3);

  // 「不正确」不能被「正确」误伤
  await call('/api/questions', {
    question: '情绪管理就是不表达负面情绪。（判断题4）',
    options: [],
    answer: '不正确',
    type: 'judgement',
  });
  const j4 = await call('/api/search', { title: '情绪管理就是不表达负面情绪。（判断题4）', options: '', type: 'judgement' });
  check('「不正确」判定为「错」', j4.code === 1 && j4.answer === '错', j4);

  // 无选项 + 只给字母，按 A=对/B=错 兜底
  await call('/api/questions', {
    question: '心理咨询等同于聊天。（判断题5）',
    options: [],
    answer: 'B',
    type: 'judgement',
  });
  const j5 = await call('/api/search', { title: '心理咨询等同于聊天。（判断题5）', options: '', type: 'judgement' });
  check('无选项时字母 B 兜底为「错」', j5.code === 1 && j5.answer === '错', j5);

  // 题型写 judge 也要生效
  const j6 = await call('/api/search', { title: '适度压力有助于提高效率。（判断题3）', options: 'A. 对\nB. 错', type: 'judge' });
  check('type=judge 同样转换', j6.code === 1 && j6.answer === '对', j6);

  console.log('\n【14】题库记录答案文本，不依赖选项顺序');
  const list14 = await call('/api/questions?pageSize=100');
  const it14 = list14.data.items.find((x) => x.question.includes('操作系统的功能'));
  check('条目存了 answerText', !!it14 && it14.answerText === '文字处理', it14);
  check('同时保留原始字母便于查看', !!it14 && it14.answer === 'C', it14);

  await call('/api/questions', {
    question: '测试直接填文本答案的题',
    options: ['A. 苹果', 'B. 香蕉'],
    answer: '香蕉',
    type: 'single',
  });
  const r14 = await call('/api/search', { title: '测试直接填文本答案的题', options: 'A. 香蕉\nB. 苹果', type: 'single' });
  check('文本答案在换序后仍然正确', r14.code === 1 && r14.answer === '香蕉', r14);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
