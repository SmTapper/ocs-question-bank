'use strict';
/**
 * 测试入口：在隔离环境里跑全部测试
 * - 使用临时数据目录（OCS_DATA_DIR），不会读写你的真实题库 / API Key
 * - 使用独立端口 7799，不影响正在运行的服务
 *
 * 用法：node tests/run-all.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT) || 7799;
const MOCK_PORT = Number(process.env.TEST_MOCK_PORT) || 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-bank-test-'));
const children = [];

function startProc(name, args, env) {
  const p = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => process.stdout.write(`  [${name}] ` + d.toString().split('\n').filter(Boolean).join('\n  [' + name + '] ') + '\n'));
  p.stderr.on('data', (d) => process.stderr.write(`  [${name}!] ` + d.toString()));
  children.push(p);
  return p;
}

async function waitReady(url, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch (_) { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function runTest(file, extraEnv = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join('tests', file)], {
      cwd: ROOT,
      env: { ...process.env, BASE, MOCK_URL: MOCK, ...extraEnv },
      stdio: 'inherit',
    });
    p.on('exit', (code) => resolve(code));
  });
}

function cleanup() {
  for (const c of children) {
    try { c.kill(); } catch (_) {}
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

(async () => {
  console.log(`\n隔离测试环境`);
  console.log(`  数据目录: ${tmpDir}`);
  console.log(`  服务端口: ${PORT}   模型模拟端口: ${MOCK_PORT}\n`);

  startProc('server', ['server.js'], { PORT: String(PORT), OCS_DATA_DIR: tmpDir, HOST: '127.0.0.1' });
  startProc('mock', ['tests/mock-llm.js'], { MOCK_PORT: String(MOCK_PORT) });

  const okServer = await waitReady(`${BASE}/api/stats`);
  const okMock = await waitReady(`${MOCK}/_last`);
  if (!okServer) {
    console.error('\n服务未能启动，测试中止。');
    cleanup();
    process.exit(1);
  }
  console.log(`服务就绪${okMock ? '，模型模拟服务就绪' : '（模型模拟服务未就绪）'}\n`);

  const results = [];
  for (const f of ['smoke.js', 'ai-test.js', 'image-test.js', 'answer-validate.js']) {
    const code = await runTest(f);
    results.push({ f, code });
  }

  console.log('\n════════ 汇总 ════════');
  for (const r of results) {
    console.log(`  ${r.code === 0 ? '通过' : '失败'}  ${r.f}`);
  }
  const failed = results.filter((r) => r.code !== 0).length;
  console.log(`\n${failed === 0 ? '全部测试通过' : failed + ' 个测试文件失败'}\n`);

  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})();

process.on('SIGINT', () => { cleanup(); process.exit(1); });
process.on('SIGTERM', () => { cleanup(); process.exit(1); });
