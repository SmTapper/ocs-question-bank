'use strict';

/* ---------------- 基础工具 ---------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'show ' + type;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = ''; }, 2600);
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function api(path, opts = {}) {
  const init = { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } };
  if (init.body && typeof init.body !== 'string') init.body = JSON.stringify(init.body);
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }));
  if (!res.ok && data.ok === undefined) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------------- 弹窗 ---------------- */

let modalOkHandler = null;

function openModal({ title, body, okText = '确定', cancelText = '取消', onOk, width }) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  $('#modalOk').textContent = okText;
  $('#modalCancel').textContent = cancelText;
  if (width) $('#modalBox').style.maxWidth = width;
  modalOkHandler = onOk;
  $('#modalMask').classList.add('show');
}

function closeModal() {
  $('#modalMask').classList.remove('show');
  modalOkHandler = null;
  $('#modalBox').style.maxWidth = '';
}

$('#modalClose').onclick = closeModal;
$('#modalCancel').onclick = closeModal;
$('#modalMask').onclick = (e) => { if (e.target.id === 'modalMask') closeModal(); };
$('#modalOk').onclick = async () => {
  if (!modalOkHandler) return closeModal();
  const btn = $('#modalOk');
  btn.disabled = true;
  try {
    const keep = await modalOkHandler();
    if (keep !== false) closeModal();
  } catch (e) {
    toast(e.message || '操作失败', 'err');
  } finally {
    btn.disabled = false;
  }
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#modalMask').classList.contains('show')) closeModal();
});

/* ---------------- 视图切换 ---------------- */

const VIEW_META = {
  overview: ['概览', '本地题库优先，未命中自动交给大模型'],
  bank: ['题库管理', ''],
  providers: ['外部题库源', '按顺序查询第三方题库接口'],
  model: ['模型配置', '自定义任意 OpenAI 兼容接口'],
  test: ['在线测试', '模拟 OCS 请求，验证整条链路'],
  logs: ['查询日志', ''],
  ocs: ['接入 OCS', '把配置粘到 OCS 题库设置里即可'],
};

let currentView = 'overview';

function setView(name) {
  currentView = name;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  const [title, sub] = VIEW_META[name] || ['', ''];
  $('#pageTitle').textContent = title;
  $('#pageSub').textContent = sub;
  location.hash = name;

  if (name === 'overview') loadOverview();
  if (name === 'bank') loadBank();
  if (name === 'providers') loadProviders();
  if (name === 'model') loadModelPage();
  if (name === 'logs') loadLogs();
  if (name === 'ocs') loadOCS();
}

$$('.nav-item').forEach((n) => { n.onclick = () => setView(n.dataset.view); });
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) setView(g.dataset.goto);
});

/* ---------------- 概览 ---------------- */

const SOURCE_LABEL = {
  manual: '手动添加', import: '批量导入', ai: 'AI 作答',
};

function sourceLabel(src) {
  if (!src) return '-';
  if (SOURCE_LABEL[src]) return SOURCE_LABEL[src];
  if (src.startsWith('provider:')) return '外部题库';
  return src;
}

function sourceBadge(src) {
  if (!src) return '<span class="badge badge-src">未知</span>';
  if (src === 'local') return '<span class="badge badge-blue badge-src">本地题库</span>';
  if (src === 'ai') return '<span class="badge badge-purple badge-src">AI作答</span>';
  if (src.startsWith('provider:')) return `<span class="badge badge-amber badge-src">${esc(src.slice(9))}</span>`;
  if (src === 'none') return '<span class="badge badge-red badge-src">未命中</span>';
  return `<span class="badge badge-src">${esc(src)}</span>`;
}

/** 来源配色：本地题库蓝、AI 紫、外部源琥珀 */
function sourceColor(k) {
  if (k === 'ai') return '#a78bfa';
  if (k === 'local') return '#4d7cfe';
  return '#e8a33d';
}

/** 画来源占比饼图（纯 SVG，无依赖） */
function renderSourcePie(entries, labelFor) {
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (!total) return '';
  const size = 132;
  const r = 54;
  const cx = size / 2;
  const cy = size / 2;
  let a0 = -Math.PI / 2; // 从 12 点开始

  const arcs = entries.map(([k, v]) => {
    const color = sourceColor(k);
    const sweep = (v / total) * Math.PI * 2;
    if (v === 0) return '';
    if (sweep >= Math.PI * 2 - 1e-6) {
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`;
    }
    const x1 = cx + r * Math.cos(a0);
    const y1 = cy + r * Math.sin(a0);
    const a1 = a0 + sweep;
    const x2 = cx + r * Math.cos(a1);
    const y2 = cy + r * Math.sin(a1);
    const large = sweep > Math.PI ? 1 : 0;
    const d = `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
    a0 = a1;
    return `<path d="${d}" fill="${color}" stroke="#0f141d" stroke-width="2"/>`;
  }).join('');

  const legend = entries.map(([k, v]) => {
    const pct = Math.round((v / total) * 100);
    const dim = v === 0 ? ' style="opacity:.45"' : '';
    return `<div class="pie-legend-item"${dim}>
      <span class="pie-dot" style="background:${sourceColor(k)}"></span>
      <span class="pie-name">${esc(labelFor(k))}</span>
      <span class="pie-pct">${pct}%</span>
    </div>`;
  }).join('');

  return `<div class="pie-wrap">
    <svg class="pie" viewBox="0 0 ${size} ${size}" aria-hidden="true">${arcs}</svg>
    <div class="pie-legend">${legend}</div>
  </div>`;
}

async function loadOverview() {
  try {
    const [statsRes, logsRes] = await Promise.all([api('/api/stats'), api('/api/logs?limit=200')]);
    $('#statusDot').className = 'dot';
    $('#statusText').textContent = '服务运行中';

    if (statsRes.ok) {
      const s = statsRes.data;
      $('#statTotal').textContent = s.total;
      const ai = s.bySource.ai || 0;
      $('#statAI').textContent = ai;
      $('#statAI').parentElement.querySelector('.stat-foot').textContent =
        s.total ? `占题库 ${Math.round((ai / s.total) * 100)}%` : '由大模型生成并沉淀';

      const m = s.llm;
      $('#statModel').textContent = m.hasKey ? (m.enabled ? '已就绪' : '已配置未启用') : '未配置';
      $('#statModel').style.color = m.hasKey && m.enabled ? '#5fd99a' : '#efbc70';
      $('#statModelFoot').textContent = m.hasKey ? m.model : '去「模型配置」填写 API Key';

      // 来源分布：手动添加/批量导入合并为「本地题库」，AI 统一叫「AI作答」
      const dist = $('#sourceDist');
      const DIST_LABEL = { local: '本地题库', ai: 'AI作答' };
      const labelFor = (k) => DIST_LABEL[k] || (k.startsWith('provider:') ? '题库源 · ' + k.slice(9) : k);
      const merged = { local: 0, ai: 0 };
      for (const [k, v] of Object.entries(s.bySource)) {
        const key = (k === 'manual' || k === 'import') ? 'local' : k;
        merged[key] = (merged[key] || 0) + v;
      }
      const entries = Object.entries(merged).sort((a, b) => b[1] - a[1]);
      if (!s.total) {
        dist.innerHTML = '<div class="empty">暂无数据</div>';
        $('#sourcePie').innerHTML = '';
      } else {
        const max = Math.max(1, ...entries.map((e) => e[1]));
        dist.innerHTML = entries.map(([k, v]) => {
          const pct = Math.round((v / max) * 100);
          return `<div>
            <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:5px">
              <span style="color:var(--text-dim)">${esc(labelFor(k))}</span>
              <span style="color:var(--muted)">${v} 题</span>
            </div>
            <div style="height:6px;background:var(--panel-3);border-radius:4px;overflow:hidden">
              <div style="height:100%;width:${pct}%;background:${sourceColor(k)};border-radius:4px;transition:width .4s"></div>
            </div>
          </div>`;
        }).join('');
        $('#sourcePie').innerHTML = renderSourcePie(entries, labelFor);
      }
    }

    if (logsRes.ok) {
      const logs = logsRes.data;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const todayLogs = logs.filter((l) => l.t >= today.getTime());
      $('#statToday').textContent = todayLogs.length;
      const hit = todayLogs.filter((l) => l.answer).length;
      $('#statTodayFoot').textContent = todayLogs.length ? `命中 ${hit} 次 · 未命中 ${todayLogs.length - hit} 次` : '今天还没有查询';

      const body = $('#recentBody');
      if (!logs.length) body.innerHTML = '<tr><td colspan="3" class="empty">暂无记录</td></tr>';
      else {
        body.innerHTML = logs.slice(0, 8).map((l) => `<tr>
          <td class="td-q" style="max-width:260px">${esc((l.q || '').slice(0, 50))}${(l.q || '').length > 50 ? '…' : ''}</td>
          <td>${sourceBadge(l.answer ? l.source : 'none')}</td>
          <td style="color:var(--muted)">${l.ms ? l.ms + 'ms' : '-'}</td>
        </tr>`).join('');
      }
    }
  } catch (e) {
    $('#statusDot').className = 'dot off';
    $('#statusText').textContent = '服务连接失败';
    toast('无法连接服务：' + e.message, 'err');
  }
}

/* ---------------- 题库管理 ---------------- */

const bankState = { page: 1, pageSize: 20, keyword: '', source: '', total: 0 };

const TYPE_LABELS = { single: '单选', multiple: '多选', judge: '判断', judgement: '判断', completion: '填空' };

function typeLabel(t) {
  const k = String(t || '').toLowerCase();
  return TYPE_LABELS[k] || t || '-';
}

/** 选项列：每行一个，最多 4 行，超出折叠 */
function renderOptionLines(opts) {
  if (!Array.isArray(opts) || !opts.length) return '<span class="opt-none">—</span>';
  const shown = opts.slice(0, 4);
  const rest = opts.length - shown.length;
  const html = shown.map((o) => `<div class="opt-line" title="${esc(o)}">${esc(o)}</div>`).join('');
  return html + (rest > 0 ? `<div class="opt-more">还有 ${rest} 项</div>` : '');
}

async function loadBank() {
  const body = $('#bankBody');
  body.innerHTML = '<tr><td colspan="8" class="empty">加载中…</td></tr>';
  try {
    const q = new URLSearchParams({
      page: bankState.page, pageSize: bankState.pageSize,
      keyword: bankState.keyword, source: bankState.source,
    });
    const r = await api('/api/questions?' + q.toString());
    if (!r.ok) throw new Error(r.error);
    const { items, total } = r.data;
    bankState.total = total;

    if (!items.length) {
      body.innerHTML = `<tr><td colspan="8" class="empty">${bankState.keyword ? '没有匹配的题目' : '题库还是空的，点右上角「添加题目」或「导入题库」'}</td></tr>`;
    } else {
      body.innerHTML = items.map((it) => `<tr>
        <td class="td-q" title="${esc(it.question)}">
          <div class="q-text">${esc(it.question)}</div>
          ${it.imageCount ? `<span class="badge badge-amber">${it.imageCount} 图</span>` : ''}
        </td>
        <td class="td-opts">${renderOptionLines(it.options)}</td>
        <td class="td-ans">${esc(it.answerText || it.answer)}${it.answerText && it.answerText !== it.answer ? `<div class="ans-sub">${esc(it.answer)}</div>` : ''}</td>
        <td><span class="badge">${esc(typeLabel(it.type))}</span></td>
        <td><span class="badge ${it.source === 'ai' ? 'badge-purple' : it.source === 'manual' ? 'badge-blue' : it.source === 'import' ? 'badge-green' : 'badge-amber'}">${esc(sourceLabel(it.source))}</span></td>
        <td class="td-num">${it.hits || 0}</td>
        <td class="td-time">${fmtTime(it.updatedAt)}</td>
        <td class="td-ops">
          <div class="ops-col">
            <button class="btn btn-sm" data-edit="${it.id}">编辑</button>
            <button class="btn btn-sm btn-danger" data-del="${it.id}">删除</button>
          </div>
        </td>
      </tr>`).join('');
    }

    const pages = Math.max(1, Math.ceil(total / bankState.pageSize));
    $('#bankInfo').textContent = `共 ${total} 题 · 第 ${bankState.page}/${pages} 页`;
    $('#btnPrev').disabled = bankState.page <= 1;
    $('#btnNext').disabled = bankState.page >= pages;
    $('#pageSub').textContent = `共 ${total} 题`;
  } catch (e) {
    body.innerHTML = `<tr><td colspan="8" class="empty">加载失败：${esc(e.message)}</td></tr>`;
  }
}

$('#bankBody').addEventListener('click', async (e) => {
  const editId = e.target.dataset.edit;
  const delId = e.target.dataset.del;
  if (editId) {
    const r = await api('/api/questions/' + editId);
    if (r.ok) openQuestionModal(r.data);
    else toast(r.error || '加载题目失败', 'err');
  }
  if (delId) {
    if (!confirm('确定删除这道题？')) return;
    const r = await api('/api/questions/' + delId, { method: 'DELETE' });
    if (r.ok) { toast('已删除', 'ok'); loadBank(); } else toast(r.error || '删除失败', 'err');
  }
});

function openQuestionModal(item) {
  const isEdit = !!item;
  openModal({
    title: isEdit ? '编辑题目' : '添加题目',
    body: `
      <div class="field">
        <label>题干 <span style="color:var(--red)">*</span></label>
        <textarea class="textarea" id="fQ" rows="3" placeholder="完整题干，不含选项">${esc(item ? item.question : '')}</textarea>
      </div>
      <div class="row" style="align-items:flex-start">
        <div class="field">
          <label>答案 <span style="color:var(--red)">*</span></label>
          <input class="input" id="fA" placeholder="选项文本，如：文字处理" value="${esc(item ? (item.answerText || item.answer) : '')}">
        </div>
        <div class="field" style="flex:0 0 150px">
          <label>题型</label>
          <select class="select" id="fT">
            ${['single', 'multiple', 'judge', 'completion'].map((t) =>
              `<option value="${t}" ${item && item.type === t ? 'selected' : ''}>${TYPE_LABELS[t]}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="hint" style="margin:5px 0 13px">填选项文本最稳（换顺序也不会错）；也可填字母 <code>A</code>，会按下方选项自动转成文本。多选用 <code>#</code> 连接。</div>
      <div class="field">
        <label>选项（可选，每行一个）</label>
        <textarea class="textarea" id="fO" rows="4" placeholder="A. 选项一&#10;B. 选项二">${esc(item && item.options ? item.options.join('\n') : '')}</textarea>
        <div class="hint">填入选项后，若 OCS 传来的选项顺序不同，系统会自动把答案字母映射过去</div>
      </div>
      <div class="field">
        <label>解析（可选）</label>
        <input class="input" id="fE" placeholder="简单说明，会随答案一起返回" value="${esc(item ? item.explanation || '' : '')}">
      </div>
    `,
    okText: isEdit ? '保存' : '添加',
    onOk: async () => {
      const body = {
        question: $('#fQ').value.trim(),
        answer: $('#fA').value.trim(),
        type: $('#fT').value,
        options: $('#fO').value.split('\n').map((s) => s.trim()).filter(Boolean),
        explanation: $('#fE').value.trim(),
      };
      if (!body.question) { toast('请填写题干', 'err'); return false; }
      if (!body.answer) { toast('请填写答案', 'err'); return false; }
      const r = isEdit
        ? await api('/api/questions/' + item.id, { method: 'PUT', body })
        : await api('/api/questions', { method: 'POST', body });
      if (!r.ok) { toast(r.error || '保存失败', 'err'); return false; }
      toast(isEdit ? '已保存' : '已添加', 'ok');
      loadBank();
    },
  });
}

$('#btnQuickAdd').onclick = () => openQuestionModal(null);

$('#btnBankSearch').onclick = () => {
  bankState.keyword = $('#bankSearch').value.trim();
  bankState.source = $('#bankSource').value;
  bankState.page = 1;
  loadBank();
};
$('#bankSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnBankSearch').click(); });
$('#bankSource').onchange = () => $('#btnBankSearch').click();
$('#btnPrev').onclick = () => { if (bankState.page > 1) { bankState.page--; loadBank(); } };
$('#btnNext').onclick = () => { bankState.page++; loadBank(); };

$('#btnClear').onclick = () => {
  if (!confirm('确定清空整个题库？此操作不可恢复，建议先导出备份。')) return;
  openModal({
    title: '再次确认',
    body: `<p style="margin:0;font-size:13px;color:var(--text-dim)">将删除全部 <b>${bankState.total}</b> 道题目。请输入 <code>DELETE</code> 确认。</p>
      <input class="input" id="clearConfirm" style="margin-top:12px" placeholder="DELETE">`,
    okText: '确认清空',
    onOk: async () => {
      if ($('#clearConfirm').value.trim() !== 'DELETE') { toast('输入不匹配', 'err'); return false; }
      const r = await api('/api/questions', { method: 'DELETE' });
      if (r.ok) { toast(`已清空 ${r.data.removed} 题`, 'ok'); bankState.page = 1; loadBank(); }
      else toast(r.error || '清空失败', 'err');
    },
  });
};

/* ---------------- 导入 / 导出 ---------------- */

function parseImport(text) {
  const t = String(text || '').trim();
  if (!t) return [];

  // 1) JSON
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const data = JSON.parse(t);
      const arr = Array.isArray(data) ? data : data.items || data.data || [];
      return arr.map(normalizeImportItem).filter((x) => x && x.question && x.answer);
    } catch (_) { /* 继续尝试其他格式 */ }
  }

  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];

  // 2) CSV（有表头）
  const first = lines[0].toLowerCase();
  if ((first.includes('question') || first.includes('题目')) && (first.includes('answer') || first.includes('答案'))) {
    return parseCSV(lines);
  }

  // 3) 分隔符行格式
  const sepRe = /\s*(?:====|----|\|\|\||\t|\|)\s*/;
  if (lines.some((l) => sepRe.test(l))) {
    const out = [];
    for (const line of lines) {
      const parts = line.split(sepRe);
      if (parts.length >= 2) {
        const question = parts[0].trim();
        const answer = parts[1].trim();
        if (question && answer) out.push({ question, answer, options: [], type: guessType(answer, []) });
      }
    }
    if (out.length) return out;
  }

  // 4) 块格式：题干 / A. xx / B. xx / 答案：A
  const out = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    const ansMatch = line.match(/^(?:答案|正确答案|参考答案)\s*[:：]\s*(.+)$/);
    if (ansMatch && cur) {
      cur.answer = ansMatch[1].trim();
      out.push(cur);
      cur = null;
      continue;
    }
    if (/^[A-Ha-h]\s*[.、．)）:：]/.test(line)) {
      if (cur) cur.options.push(line);
      continue;
    }
    if (cur && cur.answer) { out.push(cur); cur = null; }
    if (cur && !cur.options.length && line.length < 200) cur.question = cur.question + line;
    else {
      if (!cur) cur = { question: line, options: [], answer: '' };
    }
  }
  if (cur && cur.answer) out.push(cur);

  return out.filter((x) => x.question && x.answer).map((x) => ({
    ...x,
    type: guessType(x.answer, x.options),
  }));
}

function parseCSV(lines) {
  const parseLine = (line) => {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
      } else if (c === ',' && !q) { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const header = parseLine(lines[0]).map((h) => h.toLowerCase());
  const idx = (names, def) => {
    for (const n of names) { const i = header.findIndex((h) => h.includes(n)); if (i >= 0) return i; }
    return def;
  };
  const qi = idx(['question', '题目', '题干'], 0);
  const ai = idx(['answer', '答案'], 1);
  const oi = idx(['option', '选项'], -1);
  const ti = idx(['type', '题型'], -1);

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    if (!cols.length) continue;
    const question = cols[qi];
    const answer = cols[ai];
    if (!question || !answer) continue;
    const options = oi >= 0 && cols[oi] ? cols[oi].split(/\s*\|\s*/).filter(Boolean) : [];
    out.push({
      question,
      answer,
      options,
      type: (ti >= 0 && cols[ti]) || guessType(answer, options),
    });
  }
  return out;
}

function guessType(answer, options) {
  const a = String(answer || '');
  if (/[#＃]/.test(a)) return 'multiple';
  if (Array.isArray(options) && options.length === 2 && /对|错|正确|错误/.test(options.join(''))) return 'judge';
  if (/^(对|错|正确|错误|true|false|√|×)$/i.test(a)) return 'judge';
  if (/^[A-H]$/i.test(a)) return 'single';
  return 'completion';
}

function normalizeImportItem(it) {
  if (!it || typeof it !== 'object') return null;
  const question = it.question || it.题目 || it.题干 || it.title || it.q || '';
  let answer = it.answer ?? it.答案 ?? it.correct ?? it.a ?? '';
  if (Array.isArray(answer)) answer = answer.join('#');
  const options = it.options || it.选项 || it.choices || [];
  return {
    question: String(question).trim(),
    answer: String(answer).trim(),
    options: Array.isArray(options) ? options : String(options).split('\n').filter(Boolean),
    type: it.type || it.题型 || guessType(String(answer), options),
    explanation: it.explanation || it.解析 || '',
  };
}

$('#btnImport').onclick = () => {
  openModal({
    title: '导入题库',
    width: '760px',
    body: `
      <div class="hint" style="margin-top:0;margin-bottom:10px;line-height:1.8">
        支持：<br>
        · <b>JSON</b>：<code>[{"question":"题干","answer":"A","options":["A. xx"]}]</code><br>
        · <b>CSV</b>：带表头 <code>题目,答案</code>（或 question,answer）<br>
        · <b>分隔符</b>：每行 <code>题干====答案</code>（也支持 <code>----</code> <code>|||</code> <code>Tab</code>）<br>
        · <b>题目块</b>：题干一行，选项若干行，最后 <code>答案：A</code>
      </div>
      <div class="row" style="margin-bottom:10px">
        <input type="file" id="importFile" accept=".json,.csv,.txt" style="font-size:12px;color:var(--text-dim)">
      </div>
      <textarea class="textarea" id="importText" rows="12" placeholder="在这里粘贴题库内容…" style="font-family:ui-monospace,Consolas,monospace;font-size:12px"></textarea>
      <div class="hint" id="importPreview"></div>
    `,
    okText: '导入',
    onOk: async () => {
      const items = parseImport($('#importText').value);
      if (!items.length) { toast('没有解析出有效题目，检查格式', 'err'); return false; }
      const r = await api('/api/import', { method: 'POST', body: { items } });
      if (!r.ok) { toast(r.error || '导入失败', 'err'); return false; }
      toast(`导入完成：新增 ${r.data.added}，更新 ${r.data.updated}`, 'ok');
      bankState.page = 1;
      loadBank();
    },
  });

  setTimeout(() => {
    const ta = $('#importText');
    const prev = $('#importPreview');
    const upd = () => {
      const items = parseImport(ta.value);
      prev.textContent = ta.value.trim() ? `已识别 ${items.length} 道题目` : '';
      prev.style.color = items.length ? '#5fd99a' : 'var(--amber)';
    };
    ta.addEventListener('input', upd);
    $('#importFile').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { ta.value = reader.result; upd(); };
      reader.readAsText(f, 'utf-8');
    });
  }, 30);
};

$('#btnExport').onclick = () => {
  openModal({
    title: '导出题库',
    body: `<p style="font-size:13px;color:var(--text-dim);margin-top:0">选择导出格式，文件会直接下载。</p>
      <div class="row" style="margin-top:14px">
        <button class="btn" id="expJson" style="height:64px;flex:1;flex-direction:column;gap:2px">
          <b>JSON</b><span style="font-size:11px;color:var(--muted)">完整字段，适合备份与再导入</span>
        </button>
        <button class="btn" id="expCsv" style="height:64px;flex:1;flex-direction:column;gap:2px">
          <b>CSV</b><span style="font-size:11px;color:var(--muted)">可用 Excel 打开编辑</span>
        </button>
      </div>`,
    okText: '关闭',
    onOk: () => true,
  });
  setTimeout(() => {
    $('#expJson').onclick = () => { location.href = '/api/export?format=json'; };
    $('#expCsv').onclick = () => { location.href = '/api/export?format=csv'; };
  }, 20);
};

/* ---------------- 外部题库源 ---------------- */

let providersCache = [];

async function loadProviders() {
  const r = await api('/api/config');
  if (!r.ok) return;
  providersCache = r.data.providers || [];
  const box = $('#providerList');
  if (!providersCache.length) {
    box.innerHTML = '<div class="empty">还没有配置外部题库源<br><span style="font-size:12px">不配也能用：本地题库 + 大模型就够了</span></div>';
    return;
  }
  box.innerHTML = providersCache.map((p, i) => `
    <div class="mini-item">
      <div style="min-width:0;flex:1">
        <div class="name">${esc(p.name)} ${p.enabled ? '<span class="badge badge-green">启用</span>' : '<span class="badge">停用</span>'}</div>
        <div class="url mono">${esc(p.method || 'post').toUpperCase()} ${esc(p.url)}</div>
      </div>
      <div class="acts">
        <button class="btn btn-sm" data-ptest="${i}">测试</button>
        <button class="btn btn-sm" data-pedit="${i}">编辑</button>
        <button class="btn btn-sm btn-danger" data-pdel="${i}">删除</button>
      </div>
    </div>`).join('');
}

$('#providerList').addEventListener('click', async (e) => {
  const t = e.target;
  if (t.dataset.ptest !== undefined) {
    const p = providersCache[Number(t.dataset.ptest)];
    t.disabled = true; t.textContent = '测试中…';
    try {
      const r = await api('/api/config/test-provider', { method: 'POST', body: { provider: p } });
      if (r.ok && r.data && r.data.answer) toast(`命中：${r.data.answer}（${r.data.ms}ms）`, 'ok');
      else toast('未返回答案：' + (r.error || '题库可能没收录该测试题'), 'err');
    } catch (err) { toast(err.message, 'err'); }
    t.disabled = false; t.textContent = '测试';
  }
  if (t.dataset.pedit !== undefined) openProviderModal(providersCache[Number(t.dataset.pedit)], Number(t.dataset.pedit));
  if (t.dataset.pdel !== undefined) {
    const i = Number(t.dataset.pdel);
    if (!confirm(`删除题库源「${providersCache[i].name}」？`)) return;
    providersCache.splice(i, 1);
    const r = await api('/api/config', { method: 'POST', body: { providers: providersCache } });
    if (r.ok) { toast('已删除', 'ok'); loadProviders(); } else toast(r.error, 'err');
  }
});

function openProviderModal(p, index) {
  const isEdit = index !== undefined && index >= 0;
  const d = p || {
    name: '', url: '', method: 'post', contentType: 'json', enabled: true,
    headers: { 'Content-Type': 'application/json' },
    dataTemplate: { question: '${title}', options: '${options}', type: '${type}' },
    answerPath: 'data.answer', questionPath: 'data.question', timeout: 10000,
  };
  openModal({
    title: isEdit ? '编辑题库源' : '添加题库源',
    width: '700px',
    body: `
      <div class="row">
        <div class="field">
          <label>名称</label>
          <input class="input" id="pName" value="${esc(d.name)}" placeholder="例如：某题库">
        </div>
        <div class="field" style="flex:0 0 130px">
          <label>请求方式</label>
          <select class="select" id="pMethod">
            <option value="post" ${d.method === 'post' ? 'selected' : ''}>POST</option>
            <option value="get" ${d.method === 'get' ? 'selected' : ''}>GET</option>
          </select>
        </div>
        <div class="field" style="flex:0 0 120px">
          <label>状态</label>
          <select class="select" id="pEnabled">
            <option value="1" ${d.enabled ? 'selected' : ''}>启用</option>
            <option value="0" ${!d.enabled ? 'selected' : ''}>停用</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label>接口地址</label>
        <input class="input" id="pUrl" value="${esc(d.url)}" placeholder="https://api.example.com/search">
        <div class="hint">可在 URL 里用占位符，如 <code>?q=\${title}</code></div>
      </div>
      <div class="field">
        <label>请求参数模板（JSON）</label>
        <textarea class="textarea" id="pData" rows="5" style="font-family:ui-monospace,Consolas,monospace;font-size:12px">${esc(JSON.stringify(d.dataTemplate || {}, null, 2))}</textarea>
        <div class="hint">占位符：<code>\${title}</code> 题干 · <code>\${options}</code> 选项文本 · <code>\${type}</code> 题型 · <code>\${images}</code> 图片数组（整个值写 <code>"\${images}"</code> 会原样传数组）。GET 会拼到查询串，POST 会作为请求体。</div>
      </div>
      <div class="row" style="align-items:flex-start">
        <div class="field">
          <label>答案字段路径</label>
          <input class="input" id="pAnswerPath" value="${esc(d.answerPath || 'data.answer')}" placeholder="data.answer">
          <div class="hint">用点号表示层级，如 <code>data.answer</code> 或 <code>result.0.ans</code></div>
        </div>
        <div class="field">
          <label>题干字段路径（可选）</label>
          <input class="input" id="pQuestionPath" value="${esc(d.questionPath || '')}" placeholder="data.question">
        </div>
      </div>
      <div class="row" style="align-items:flex-start">
        <div class="field">
          <label>成功判断路径（可选）</label>
          <input class="input" id="pSuccessPath" value="${esc(d.successPath || '')}" placeholder="code">
          <div class="hint">配合右侧期望值，不匹配视为未命中</div>
        </div>
        <div class="field" style="flex:0 0 130px">
          <label>期望值</label>
          <input class="input" id="pSuccessValue" value="${esc(d.successValue ?? '')}" placeholder="1">
        </div>
        <div class="field" style="flex:0 0 110px">
          <label>超时(ms)</label>
          <input class="input" id="pTimeout" type="number" value="${d.timeout || 10000}">
        </div>
      </div>
      <div class="field">
        <label>请求头（JSON，可选）</label>
        <textarea class="textarea" id="pHeaders" rows="3" style="font-family:ui-monospace,Consolas,monospace;font-size:12px">${esc(JSON.stringify(d.headers || {}, null, 2))}</textarea>
      </div>
    `,
    okText: '保存',
    onOk: async () => {
      let dataTemplate, headers;
      try { dataTemplate = JSON.parse($('#pData').value || '{}'); } catch (_) { toast('请求参数模板不是合法 JSON', 'err'); return false; }
      try { headers = JSON.parse($('#pHeaders').value || '{}'); } catch (_) { toast('请求头不是合法 JSON', 'err'); return false; }
      const name = $('#pName').value.trim();
      const url = $('#pUrl').value.trim();
      if (!name) { toast('请填写名称', 'err'); return false; }
      if (!url) { toast('请填写接口地址', 'err'); return false; }
      const item = {
        ...d,
        name, url,
        method: $('#pMethod').value,
        enabled: $('#pEnabled').value === '1',
        dataTemplate,
        headers,
        answerPath: $('#pAnswerPath').value.trim() || 'data.answer',
        questionPath: $('#pQuestionPath').value.trim(),
        successPath: $('#pSuccessPath').value.trim(),
        successValue: $('#pSuccessValue').value.trim(),
        timeout: Number($('#pTimeout').value) || 10000,
      };
      if (isEdit) providersCache[index] = item;
      else providersCache.push(item);
      const r = await api('/api/config', { method: 'POST', body: { providers: providersCache } });
      if (!r.ok) { toast(r.error || '保存失败', 'err'); return false; }
      toast('已保存', 'ok');
      loadProviders();
    },
  });
}

$('#btnAddProvider').onclick = () => openProviderModal(null);

/** 把 OCS 分享格式的题库配置映射成本项目的外部题库源 */
function importSharedProvider() {
  openModal({
    title: '导入题库分享配置',
    width: '680px',
    body: `<div class="field">
        <label>粘贴分享内容</label>
        <textarea class="textarea" id="ipJson" rows="11"
          placeholder='[{"name":"ZE题库","url":"https://api.example.com/query","method":"post","data":{"v":"2","title":"\${title}"},"headers":{...}}]'></textarea>
        <div class="hint">
          支持 OCS 的分享格式（单个对象或数组）。会自动映射名称、接口地址、请求方式、请求头和参数模板，
          并尝试从 handler 推断答案路径；含 JS 表达式的字段（如 images、handler）会被忽略。
        </div>
      </div>`,
    okText: '解析并填入',
    onOk: () => {
      const raw = ($('#ipJson').value || '').trim();
      if (!raw) { toast('请先粘贴分享内容', 'err'); return false; }
      let list;
      try { list = JSON.parse(raw); } catch (e) { toast('不是合法的 JSON：' + e.message, 'err'); return false; }
      const item = Array.isArray(list) ? list[0] : list;
      if (!item || !item.url) { toast('内容里没有找到 url 字段', 'err'); return false; }

      const src = item.data && typeof item.data === 'object' ? item.data : (item.body || {});
      const dataTemplate = {};
      for (const [k, v] of Object.entries(src)) {
        if (v && typeof v === 'object') {
          // images 这类 handler 字段转成数组占位符，图片题才能真正把图传过去
          if (k === 'images') dataTemplate[k] = '${images}';
          continue;
        }
        dataTemplate[k] = v;
      }

      // 从 handler 里的 res.data.xxx 推断答案字段：优先 data，其次 answer/result
      const fields = [...String(item.handler || '').matchAll(/res\??\.data\??\.([a-zA-Z_]\w*)/g)].map((m) => m[1]);
      let answerPath = 'data.data';
      if (fields.includes('data')) answerPath = 'data.data';
      else if (fields.includes('answer')) answerPath = 'data.answer';
      else if (fields.includes('result')) answerPath = 'data.result';
      else if (fields.length > 1) answerPath = 'data.' + fields[1];

      const mapped = {
        name: item.name || '导入的题库',
        url: item.url,
        method: String(item.method || 'post').toLowerCase() === 'get' ? 'get' : 'post',
        contentType: 'json',
        enabled: true,
        headers: item.headers && typeof item.headers === 'object'
          ? item.headers
          : { 'Content-Type': 'application/json' },
        dataTemplate,
        answerPath,
        questionPath: '',
        timeout: 10000,
      };

      setTimeout(() => {
        openProviderModal(mapped, -1);
        toast('已解析，请确认「答案路径」后保存', 'ok');
      }, 80);
      return true;
    },
  });
}
$('#btnImportProvider').onclick = importSharedProvider;

/* ---------------- 模型配置（多平台） ---------------- */

const PLATFORM_PRESETS = [
  { name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', models: ['deepseek-flash', 'deepseek-v4-pro'] },
  { name: '阿里云百炼', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus'] },
  { name: '智谱', baseURL: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4v-plus'] },
  { name: 'Kimi', baseURL: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k'] },
  { name: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1', models: ['Qwen/Qwen2.5-7B-Instruct'] },
  { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o'] },
  { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', models: [] },
  { name: '本地 Ollama', baseURL: 'http://127.0.0.1:11434/v1', models: ['qwen2.5:7b'] },
];

const mpState = { cfg: null, sel: '', filter: '' };

/* 常用厂商图标：全部使用官方 logo，单色渲染（20 项，5 列正好四行） */
const ICONS = {
  deepseek: { label: 'DeepSeek', brand: 'deepseek' },
  gemini: { label: 'Gemini', brand: 'googlegemini' },
  grok: { label: 'Grok / xAI', brand: 'grok' },
  claude: { label: 'Claude', brand: 'claude' },
  openai: { label: 'OpenAI / GPT', brand: 'openai' },
  kimi: { label: 'Kimi', brand: 'kimi', scale: 0.88 },
  glm: { label: '智谱 GLM', brand: 'glm' },
  qwen: { label: '通义千问', brand: 'qwen' },
  siliconflow: { label: '硅基流动', brand: 'siliconflow' },
  openrouter: { label: 'OpenRouter', brand: 'openrouter' },
  ollama: { label: 'Ollama', brand: 'ollama' },
  longcat: { label: 'LongCat', brand: 'longcat' },
  mimo: { label: '小米 MiMo', brand: 'xiaomi' },
  hunyuan: { label: '腾讯混元', brand: 'hunyuan' },
  doubao: { label: '豆包', brand: 'doubao' },
  ernie: { label: '文心一言', brand: 'baidu' },
  meta: { label: 'Meta', brand: 'meta' },
  mistral: { label: 'Mistral', brand: 'mistralai' },
  perplexity: { label: 'Perplexity', brand: 'perplexity' },
};

/* 平台名 / 地址 -> 图标 key */
const ICON_MATCHERS = [
  [/deepseek/i, 'deepseek'],
  [/gemini|generativelanguage|makersuite/i, 'gemini'],
  [/grok|xai|x\.ai/i, 'grok'],
  [/claude|anthropic/i, 'claude'],
  [/openai|gpt|chatgpt/i, 'openai'],
  [/kimi|moonshot/i, 'kimi'],
  [/glm|zhipu|bigmodel|智谱/i, 'glm'],
  [/qwen|通义|dashscope|aliyun|百炼|alibaba/i, 'qwen'],
  [/siliconflow|硅基流动/i, 'siliconflow'],
  [/openrouter/i, 'openrouter'],
  [/ollama/i, 'ollama'],
  [/longcat|龙猫/i, 'longcat'],
  [/mimo|xiaomi|小米/i, 'mimo'],
  [/hunyuan|混元|tencent/i, 'hunyuan'],
  [/doubao|豆包|volc/i, 'doubao'],
  [/ernie|wenxin|文心|baidu/i, 'ernie'],
  [/meta|llama/i, 'meta'],
  [/mistral/i, 'mistral'],
  [/perplexity/i, 'perplexity'],
];

function matchIcon(name, baseURL) {
  const s = `${name || ''} ${baseURL || ''}`;
  for (const [re, key] of ICON_MATCHERS) if (re.test(s)) return key;
  return '';
}

/* 少数品牌用更易识别的颜色覆盖官方单色 */
const BRAND_COLOR_OVERRIDE = {
  anthropic: '#D97757',
  openrouter: '#6366F1',
};

function iconSvg(key, size) {
  const ic = ICONS[key];
  if (!ic) return '';
  const s = size || 18;

  // 官方图标：单色渲染，颜色继承父元素
  const brand = ic.brand && window.BRAND_ICONS && window.BRAND_ICONS[ic.brand];
  if (brand && brand.p && brand.p.length) {
    const vb = brand.vb || '0 0 24 24';
    const paths = brand.p.map((d) => `<path d="${d}"/>`).join('');
    const sc = ic.scale || 1;
    const style = sc !== 1 ? ` style="transform:scale(${sc})"` : '';
    return `<span class="mp-ico" style="width:${s}px;height:${s}px" aria-hidden="true">` +
      `<svg viewBox="${vb}" width="${s}" height="${s}" fill="currentColor"${style}>${paths}</svg></span>`;
  }

  // 没有官方图标的：灰底字母，与未匹配时的样式一致
  return `<span class="mp-ico fallback" style="width:${s}px;height:${s}px;font-size:${Math.round(s * 0.5)}px" aria-hidden="true">${esc(ic.glyph || '?')}</span>`;
}

/** 平台头像：优先用手选图标，其次自动匹配，都没有则用灰底首字母 */
function platformAvatar(p, size) {
  const s = size || 20;
  const key = p.icon || matchIcon(p.name, p.baseURL);
  if (key && ICONS[key]) return iconSvg(key, s);
  const ch = (p.name || '').trim().slice(0, 1).toUpperCase() || '?';
  return `<span class="mp-ico fallback" style="width:${s}px;height:${s}px;font-size:${Math.round(s * 0.5)}px" aria-hidden="true">${esc(ch)}</span>`;
}

/* ---------- 图标选择器：点击图标弹出面板 ---------- */

let iconPickerEl = null;

function closeIconPicker() {
  if (iconPickerEl) {
    iconPickerEl.remove();
    iconPickerEl = null;
  }
}

/**
 * 打开图标选择面板
 * @param {HTMLElement} anchor 触发按钮
 * @param {string} current 当前图标 key（空字符串表示自动匹配）
 * @param {(icon:string)=>void} onPick 选中回调
 */
function openIconPicker(anchor, current, onPick) {
  closeIconPicker();
  const rect = anchor.getBoundingClientRect();
  const width = 318;
  const left = Math.max(10, Math.min(rect.left, window.innerWidth - width - 10));
  const pop = document.createElement('div');
  pop.className = 'icon-pop';
  pop.style.left = left + 'px';
  pop.style.top = (rect.bottom + 8) + 'px';
  pop.style.width = width + 'px';
  pop.innerHTML = `
    <div class="icon-pop-head">
      <span>选择平台图标</span>
      <span class="icon-pop-tip">不选则按名称自动匹配</span>
    </div>
    <div class="icon-grid">
      <div class="icon-cell ${current ? '' : 'active'}" data-icon="">
        <span class="icon-auto">自动</span>
      </div>
      ${Object.entries(ICONS).map(([k, v]) => `<div class="icon-cell ${current === k ? 'active' : ''}" data-icon="${k}" title="${esc(v.label)}">${iconSvg(k, 22)}</div>`).join('')}
    </div>
  `;
  document.body.appendChild(pop);
  iconPickerEl = pop;

  pop.addEventListener('click', (e) => {
    const cell = e.target.closest('.icon-cell');
    if (!cell) return;
    onPick(cell.dataset.icon);
    closeIconPicker();
  });

  setTimeout(() => {
    const onDocDown = (ev) => {
      if (!iconPickerEl) return;
      if (iconPickerEl.contains(ev.target) || anchor.contains(ev.target)) return;
      closeIconPicker();
      document.removeEventListener('mousedown', onDocDown);
    };
    document.addEventListener('mousedown', onDocDown);
  }, 0);
}

function platformColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 58%, 50%)`;
}

function guessModelType(id) {
  return /(^|[-_/])(vl|vision|4v|4\.1v|omni|multimodal)/i.test(id) ? 'vision' : 'text';
}

async function loadModelPage() {
  const r = await api('/api/config');
  if (!r.ok) return toast(r.error || '读取配置失败', 'err');
  mpState.cfg = r.data.llm;
  mpState.cfg.__saveAI = !!(r.data.storage && r.data.storage.autoSaveAI);
  mpState.cfg.__saveProvider = !!(r.data.storage && r.data.storage.autoSaveProvider);
  mpState.cfg.__fuzzy = !(r.data.match && r.data.match.enableFuzzy === false);
  mpState.cfg.__threshold = (r.data.match && r.data.match.threshold) || 0.88;
  const list = mpState.cfg.platforms || [];
  if (!mpState.sel || (mpState.sel !== '__global__' && !list.some((p) => p.id === mpState.sel))) {
    mpState.sel = list.length ? list[0].id : '__global__';
  }
  renderPlatforms();
  renderMpMain();
}

function activeModelIds() {
  const c = mpState.cfg || {};
  return [c.model, c.visionModel].filter(Boolean);
}

function modelOptions(cfg, selPid, selMid) {
  let html = '';
  for (const pl of cfg.platforms || []) {
    const models = (pl.models || []).filter((m) => m.enabled !== false);
    if (!models.length) continue;
    html += '<optgroup label="' + esc(pl.name || pl.id) + '">';
    for (const m of models) {
      const val = pl.id + '::' + m.id;
      const sel = (pl.id === selPid && m.id === selMid) ? ' selected' : '';
      html += '<option value="' + esc(val) + '"' + sel + '>' + esc(m.name || m.id) + '</option>';
    }
    html += '</optgroup>';
  }
  return html || '<option value="">暂无模型</option>';
}

function platformName(id) {
  const p = (mpState.cfg.platforms || []).find((x) => x.id === id);
  return p ? (p.name || p.id) : String(id || '');
}

function renderPlatforms() {
  const list = mpState.cfg.platforms || [];
  const act = activeModelIds();
  const box = $('#platformList');
  if (!list.length) {
    box.innerHTML = '<div class="mp-empty" style="padding:26px 8px">还没有平台<br><span style="font-size:11.5px">点右上角 + 添加</span></div>';
  } else {
    box.innerHTML = list.map((p) => {
      const used = (p.models || []).filter((m) => act.includes(m.id)).length;
      return `<div class="mp-plat ${mpState.sel === p.id ? 'active' : ''}" data-pid="${esc(p.id)}">
        ${platformAvatar(p, 20)}
        <div class="mp-plat-name">${esc(p.name || '未命名')}</div>
        ${used ? `<span class="mp-plat-count">${used} 个在用</span>` : ''}
      </div>`;
    }).join('');
  }
  $('#btnGlobalSettings').classList.toggle('active', mpState.sel === '__global__');
}

function renderMpMain() {
  if (mpState.sel === '__global__') return renderGlobalSettings();
  const p = (mpState.cfg.platforms || []).find((x) => x.id === mpState.sel);
  if (!p) return renderGlobalSettings();
  renderPlatformDetail(p);
}

function modelRow(m, c) {
  const isText = m.id === c.model;
  const isVision = m.id === c.visionModel;
  const showId = (m.name && m.name !== m.id) ? m.id : '';
  return `<div class="mp-model ${isText || isVision ? 'active' : ''}" data-mid="${esc(m.id)}">
    <span class="dot"></span>
    <span class="nm">${esc(m.name || m.id)}</span>
    ${showId ? `<span class="mono-id">${esc(showId)}</span>` : ''}
    <span class="mp-marks">
      ${isText ? '<span class="mp-tag current">文本</span>' : ''}
      ${isVision ? '<span class="mp-tag vision">图片</span>' : ''}
    </span>
  </div>`;
}

function renderPlatformDetail(p) {
  const c = mpState.cfg;
  const models = (p.models || []).filter((m) => !mpState.filter || m.id.toLowerCase().includes(mpState.filter.toLowerCase()));
  const rows = models.length
    ? models.map((m) => modelRow(m, c)).join('')
    : `<div class="mp-empty">${(p.models || []).length ? '没有匹配的模型' : '还没有模型<br>点右上角「从接口获取模型列表」，或手动添加'}</div>`;

  $('#mpMain').innerHTML = `
    <div class="mp-head">
      <button class="icon-btn" id="pIconBtn" title="点击选择图标">${platformAvatar(p, 24)}</button>
      <div class="mp-title">${esc(p.name || '未命名平台')}</div>
      <label class="switch" style="margin-left:auto">
        <input type="checkbox" id="pEnabled" ${p.enabled ? 'checked' : ''}>
        <span class="track"></span><span>启用</span>
      </label>
      <button class="btn btn-sm btn-danger" id="btnDelPlatform">删除</button>
    </div>

    <div class="mp-section">
      <div class="mp-section-title"><span>API 配置</span></div>
      <div class="field">
        <label>API Key</label>
        <input class="input" id="pKey" type="password"
          placeholder="${p.hasKey ? '已保存 ' + esc(p.apiKeyMasked) + '，留空则不修改' : '请输入 API Key'}">
      </div>
      <div class="field">
        <label>接口地址（Base URL）</label>
        <input class="input" id="pBase" value="${esc(p.baseURL || '')}" placeholder="https://api.deepseek.com/v1">
        <div class="hint">填到 /v1 即可，程序会自动补 /chat/completions</div>
      </div>
    </div>

    <div class="mp-section">
      <div class="mp-section-title">
        <span>模型管理</span>
        <button class="btn btn-sm" id="btnFetchModels">从接口获取模型列表</button>
      </div>
      ${(p.models || []).length > 8 ? '<div class="mp-search"><input class="input" id="mpFilter" placeholder="筛选模型…" value="' + esc(mpState.filter) + '"></div>' : ''}
      <div id="modelRows">${rows}</div>
      <div style="margin-top:10px">
        <button class="btn btn-sm" id="btnAddModel">＋ 手动添加模型</button>
      </div>
      <div class="hint" style="margin-top:10px">
        点模型行设为「文本模型」；图片模型可在下方「当前使用」里单独指定，留空则与文本模型相同。
      </div>
    </div>

    <div class="mp-section">
      <div class="mp-section-title"><span>当前使用</span></div>
      <div class="row" style="align-items:flex-start">
        <div class="field">
          <label>文本模型</label>
          <select class="select" id="selTextModel">${modelOptions(c, c.textPlatformId, c.model)}</select>
          <div class="model-test-result" id="testTextResult"></div>
        </div>
        <div class="field">
          <label>图片模型</label>
          <select class="select" id="selVisionModel">
            <option value="">同文本模型</option>
            ${modelOptions(c, c.visionPlatformId, c.visionModel)}
          </select>
          <div class="model-test-result" id="testImageResult"></div>
        </div>
      </div>
    </div>

    <div style="margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-primary" id="btnSaveMp">保存配置</button>
      <button class="btn" id="btnTestMp">测试当前模型</button>
    </div>
  `;

  bindPlatformEvents(p);
}

function bindPlatformEvents(p) {
  $('#pBase').oninput = (e) => { p.baseURL = e.target.value.trim(); };
  $('#pKey').oninput = (e) => { p.apiKey = e.target.value.trim(); };
  $('#pIconBtn').onclick = (e) => {
    e.stopPropagation();
    openIconPicker(e.currentTarget, p.icon || '', (icon) => {
      p.icon = icon;
      renderPlatforms();
      renderMpMain();
    });
  };
  $('#pEnabled').onchange = (e) => { p.enabled = e.target.checked; renderPlatforms(); };

  const filterEl = $('#mpFilter');
  if (filterEl) filterEl.oninput = (e) => {
    mpState.filter = e.target.value;
    const c = mpState.cfg;
    const models = (p.models || []).filter((m) => !mpState.filter || m.id.toLowerCase().includes(mpState.filter.toLowerCase()));
    $('#modelRows').innerHTML = models.length
      ? models.map((m) => modelRow(m, c)).join('')
      : '<div class="mp-empty">没有匹配的模型</div>';
  };

  $('#modelRows').onclick = (e) => {
    const row = e.target.closest('[data-mid]');
    if (!row) return;
    const m = (p.models || []).find((x) => x.id === row.dataset.mid);
    if (!m) return;
    const c = mpState.cfg;
    c.model = m.id;
    c.textPlatformId = p.id;
    c.baseURL = p.baseURL || '';
    renderPlatforms();
    renderPlatformDetail(p);
    toast(`文本模型已设为「${m.id}」`, 'ok');
  };

  $('#selTextModel').onchange = (e) => {
    const v = e.target.value || '';
    const i = v.indexOf('::');
    if (i < 0) return;
    const pid = v.slice(0, i);
    const mid = v.slice(i + 2);
    const pl = (mpState.cfg.platforms || []).find((x) => x.id === pid);
    const c = mpState.cfg;
    c.model = mid;
    c.textPlatformId = pid;
    c.baseURL = pl ? (pl.baseURL || '') : '';
    renderPlatforms();
    renderPlatformDetail(p);
    toast(`文本模型已设为「${mid}」`, 'ok');
  };

  $('#selVisionModel').onchange = (e) => {
    const v = e.target.value || '';
    const c = mpState.cfg;
    if (!v) {
      c.visionModel = '';
      c.visionPlatformId = '';
      c.visionBaseURL = '';
      c.visionApiKey = '';
    } else {
      const i = v.indexOf('::');
      const pid = v.slice(0, i);
      const mid = v.slice(i + 2);
      const pl = (mpState.cfg.platforms || []).find((x) => x.id === pid);
      c.visionModel = mid;
      c.visionPlatformId = pid;
      c.visionBaseURL = pl ? (pl.baseURL || '') : '';
    }
    renderPlatforms();
    renderPlatformDetail(p);
    toast(v ? `图片模型已设为「${c.visionModel}」` : '图片题将使用文本模型', 'ok');
  };

  $('#btnFetchModels').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '获取中…';
    try {
      const r = await api('/api/config/fetch-models', {
        method: 'POST',
        body: { platformId: p.id, baseURL: p.baseURL, apiKey: p.apiKey },
      });
      if (!r.ok) throw new Error(r.error || '获取失败');
      const map = new Map((p.models || []).map((m) => [m.id, m]));
      let added = 0;
      for (const m of r.data.models) {
        if (!map.has(m.id)) {
          map.set(m.id, { id: m.id, name: m.id, type: guessModelType(m.id), enabled: true });
          added++;
        }
      }
      p.models = [...map.values()];
      toast(`获取成功：共 ${r.data.models.length} 个模型，新增 ${added} 个`, 'ok');
      renderPlatformDetail(p);
    } catch (err) {
      toast('获取失败：' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };

  $('#btnAddModel').onclick = () => {
    openModal({
      title: '手动添加模型',
      body: `<div class="field"><label>模型 ID</label>
          <input class="input" id="nmId" placeholder="例如 deepseek-flash">
        </div>
        <div class="field"><label>显示名称（可选）</label>
          <input class="input" id="nmName" placeholder="留空则用 ID">
        </div>
        <div class="hint">添加后在列表里点一下即可设为当前模型</div>`,
      okText: '添加',
      onOk: () => {
        const id = $('#nmId').value.trim();
        if (!id) { toast('请填写模型 ID', 'err'); return false; }
        if ((p.models || []).some((m) => m.id === id)) { toast('该模型已存在', 'err'); return false; }
        p.models = p.models || [];
        p.models.push({ id, name: $('#nmName').value.trim() || id, type: 'text', enabled: true });
        renderPlatformDetail(p);
      },
    });
  };

  $('#btnDelPlatform').onclick = () => {
    if (!confirm(`删除平台「${p.name}」？其下模型配置会一并移除。`)) return;
    mpState.cfg.platforms = (mpState.cfg.platforms || []).filter((x) => x.id !== p.id);
    mpState.sel = mpState.cfg.platforms.length ? mpState.cfg.platforms[0].id : '__global__';
    renderPlatforms();
    renderMpMain();
  };

  $('#btnSaveMp').onclick = saveMpConfig;
  $('#btnTestMp').onclick = testCurrentModel;
}

function renderGlobalSettings() {
  const c = mpState.cfg;
  const t = c.thinking || { enabled: false, effort: 'high' };
  $('#mpMain').innerHTML = `
    <div class="mp-head">
      <div class="mp-title">通用设置</div>
      <span class="sub">对所有模型生效</span>
    </div>

    <div class="mp-section">
      <div class="mp-section-title"><span>深度思考</span></div>
      <div class="row" style="gap:16px;align-items:flex-start">
        <label class="switch">
          <input type="checkbox" id="gThink" ${t.enabled ? 'checked' : ''}>
          <span class="track"></span><span>启用深度思考</span>
        </label>
        <div class="field" style="flex:0 0 220px;margin:0" id="gEffortWrap">
          <label>推理强度</label>
          <select class="select" id="gEffort" ${t.enabled ? '' : 'disabled'}>
            <option value="low" ${t.effort === 'low' ? 'selected' : ''}>low · 快</option>
            <option value="high" ${t.effort === 'high' ? 'selected' : ''}>high · 均衡（默认）</option>
            <option value="max" ${t.effort === 'max' ? 'selected' : ''}>max · 最强</option>
          </select>
        </div>
      </div>
      <div class="hint">
        默认关闭。开启后模型会先输出思维链再作答，准确率略高但更慢、更费钱（思维链按输出计费）。
        若接口不支持该参数，程序会自动去掉重试。
      </div>
    </div>

    <div class="mp-section">
      <div class="mp-section-title"><span>生成参数</span></div>
      <div class="row">
        <div class="field">
          <label>温度（0~1，越低越稳定）</label>
          <input class="input" id="gTemp" type="number" step="0.1" min="0" max="1" value="${c.temperature ?? 0.1}">
        </div>
        <div class="field">
          <label>最大输出 token</label>
          <input class="input" id="gMaxTokens" type="number" step="128" min="128" value="${c.maxTokens || 1024}">
        </div>
      </div>
      <div class="row" style="margin-top:13px">
        <div class="field">
          <label>超时（毫秒）</label>
          <input class="input" id="gTimeout" type="number" step="1000" min="5000" value="${c.timeout || 45000}">
        </div>
        <div class="field">
          <label>并发数</label>
          <input class="input" id="gConc" type="number" step="1" min="1" max="10" value="${c.concurrency || 2}">
        </div>
      </div>
    </div>

    <div class="mp-section">
      <div class="mp-section-title"><span>系统提示词</span></div>
      <textarea class="textarea" id="gPrompt" rows="9">${esc(c.systemPrompt || '')}</textarea>
      <div class="hint">一般不用改。稳定不变的提示词能命中接口缓存，输入成本只有 1/50。</div>
    </div>

    <div class="mp-section">
      <div class="mp-section-title"><span>答案沉淀与匹配</span></div>
      <div class="row" style="gap:26px;margin-bottom:14px">
        <label class="switch"><input type="checkbox" id="gSaveAI" ${c.__saveAI ? 'checked' : ''}><span class="track"></span><span>AI 答出的题自动入库</span></label>
        <label class="switch"><input type="checkbox" id="gFuzzy"><span class="track"></span><span>相似题模糊匹配</span></label>
      </div>
      <div class="field" style="max-width:240px">
        <label>相似度阈值</label>
        <input class="input" id="gThreshold" type="number" step="0.01" min="0.5" max="1" value="0.88">
      </div>
    </div>

    <div style="margin-top:22px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-primary" id="btnSaveMp">保存配置</button>
      <button class="btn" id="btnTestMp">测试当前模型</button>
      <span id="mpTestResult" style="font-size:12.5px"></span>
    </div>
  `;

  // 深度思考开关联动
  $('#gThink').onchange = (e) => {
    c.thinking = c.thinking || {};
    c.thinking.enabled = e.target.checked;
    $('#gEffort').disabled = !e.target.checked;
  };
  $('#gEffort').onchange = (e) => { c.thinking = c.thinking || {}; c.thinking.effort = e.target.value; };
  $('#gTemp').oninput = (e) => { c.temperature = Number(e.target.value); };
  $('#gMaxTokens').oninput = (e) => { c.maxTokens = Number(e.target.value); };
  $('#gTimeout').oninput = (e) => { c.timeout = Number(e.target.value); };
  $('#gConc').oninput = (e) => { c.concurrency = Number(e.target.value); };
  $('#gPrompt').oninput = (e) => { c.systemPrompt = e.target.value; };
  $('#gThreshold').oninput = (e) => { c.__threshold = Number(e.target.value); };
  $('#gSaveAI').onchange = (e) => { c.__saveAI = e.target.checked; };
  $('#gFuzzy').checked = c.__fuzzy !== false;
  $('#gFuzzy').onchange = (e) => { c.__fuzzy = e.target.checked; };

  $('#btnSaveMp').onclick = saveMpConfig;
  $('#btnTestMp').onclick = testCurrentModel;
}

/* 保存：把平台里的明文 key 和通用设置一起提交 */
async function saveMpConfig() {
  const c = mpState.cfg;
  const llm = JSON.parse(JSON.stringify(c));
  delete llm.apiKeyMasked;
  delete llm.hasApiKey;
  delete llm.hasVisionApiKey;
  delete llm.__saveAI;
  delete llm.__fuzzy;
  delete llm.__threshold;
  llm.platforms = (c.platforms || []).map((p) => {
    const { apiKeyMasked, hasKey, ...rest } = p;
    return rest;
  });

  const body = {
    llm,
    match: { threshold: c.__threshold, enableFuzzy: c.__fuzzy },
    storage: { autoSaveAI: c.__saveAI, autoSaveProvider: c.__saveProvider },
  };

  const r = await api('/api/config', { method: 'POST', body });
  if (!r.ok) return toast(r.error || '保存失败', 'err');
  toast('配置已保存', 'ok');
  await loadModelPage();
}

/** 生成一张带文字的测试图，用来验证模型能否读图 */
function makeVisionTestImage() {
  const c = document.createElement('canvas');
  c.width = 120;
  c.height = 120;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e34d4d';
  ctx.fillRect(0, 0, 120, 120);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 56px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('OK', 60, 62);
  return c.toDataURL('image/png');
}

async function testCurrentModel() {
  const btn = $('#btnTestMp');
  const textEl = $('#testTextResult');
  const imgEl = $('#testImageResult');
  const fallback = $('#mpTestResult');
  const c = mpState.cfg;

  const paint = (el, html) => { if (el) el.innerHTML = html; };
  btn.disabled = true;
  paint(textEl, '<span style="color:var(--muted)">测试中…</span>');
  paint(imgEl, '<span style="color:var(--muted)">测试中…</span>');
  paint(fallback, '<span style="color:var(--muted)">测试中…</span>');

  const sameModel = !c.visionModel;
  const jobs = [
    {
      key: 'text',
      label: '文本',
      el: textEl,
      body: { baseURL: c.baseURL, model: c.model, platformId: c.textPlatformId, thinking: c.thinking },
    },
    {
      key: 'image',
      label: sameModel ? '图片（同文本模型）' : '图片',
      el: imgEl,
      body: {
        baseURL: c.visionBaseURL || c.baseURL,
        model: c.visionModel || c.model,
        platformId: c.visionPlatformId || c.textPlatformId,
        thinking: c.thinking,
        images: [makeVisionTestImage()],
      },
    },
  ];

  const results = await Promise.all(jobs.map(async (j) => {
    const t0 = Date.now();
    try {
      const r = await api('/api/config/test-llm', { method: 'POST', body: j.body });
      const ms = (r.data && r.data.ms) || (Date.now() - t0);
      return { ...j, ok: !!r.ok, data: r.data, error: r.error, ms };
    } catch (e) {
      return { ...j, ok: false, error: e.message, ms: Date.now() - t0 };
    }
  }));

  // 通过=绿色，错误=红色；结果已在对应模型下方，无需再写「文本/图片」
  const fmt = (r) => {
    const color = r.ok ? '#5fd99a' : '#ff8e91';
    const state = r.ok ? '通过' : '错误';
    return `<span style="color:${color}">${state} · ${r.ms}ms</span>`;
  };

  results.forEach((r) => { if (r.el) r.el.innerHTML = fmt(r); });

  // 通用设置页没有分开的展示位，聚合显示在按钮旁
  if (fallback && !textEl && !imgEl) {
    fallback.innerHTML = results.map((r) => `<div style="line-height:1.7">${r.label}：${fmt(r)}</div>`).join('');
  } else if (fallback) {
    fallback.innerHTML = '';
  }

  btn.disabled = false;
}

function openAddPlatform() {
  const opts = PLATFORM_PRESETS.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
  let apIcon = '';
  const refreshIcon = () => {
    const btn = $('#apIconBtn');
    if (btn) btn.innerHTML = platformAvatar({ name: $('#apName').value, baseURL: $('#apBase').value, icon: apIcon }, 22);
  };
  openModal({
    title: '添加 AI 平台',
    width: '620px',
    body: `
      <div class="field">
        <label>快速选择</label>
        <select class="select" id="apPreset"><option value="">自定义</option>${opts}</select>
      </div>
      <div class="field">
        <label>平台名称</label>
        <div class="name-row">
          <button class="icon-btn" id="apIconBtn" type="button" title="点击选择图标">${platformAvatar({}, 22)}</button>
          <input class="input" id="apName" placeholder="例如：DeepSeek">
        </div>
        <div class="hint">图标默认按名称自动匹配，识别不出来用首字母；点左侧图标可手动指定</div>
      </div>
      <div class="field">
        <label>接口地址（Base URL）</label>
        <input class="input" id="apBase" placeholder="https://api.deepseek.com/v1">
      </div>
      <div class="field">
        <label>API Key</label>
        <input class="input" id="apKey" type="password" placeholder="sk-...">
        <div class="hint">添加后可在右侧「从接口获取模型列表」自动拉取模型</div>
      </div>
    `,
    okText: '添加',
    onOk: async () => {
      const name = $('#apName').value.trim();
      const baseURL = $('#apBase').value.trim();
      if (!name) { toast('请填写平台名称', 'err'); return false; }
      if (!baseURL) { toast('请填写接口地址', 'err'); return false; }
      const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const apiKey = $('#apKey').value.trim();
      const presetIdx = $('#apPreset').value;
      const preset = presetIdx === '' ? null : PLATFORM_PRESETS[Number(presetIdx)];
      const models = (preset ? preset.models : []).map((m) => ({ id: m, name: m, type: guessModelType(m), enabled: true }));
      const icon = apIcon;

      mpState.cfg.platforms = mpState.cfg.platforms || [];
      mpState.cfg.platforms.push({ id, name, baseURL, apiKey, enabled: true, icon, models });
      mpState.sel = id;

      const r = await api('/api/config', { method: 'POST', body: { llm: prepLlmForSave() } });
      if (!r.ok) { toast(r.error || '保存失败', 'err'); return false; }
      await loadModelPage();
      toast('平台已添加，可点「从接口获取模型列表」', 'ok');
    },
  });

  setTimeout(() => {
    $('#apIconBtn').onclick = (e) => {
      e.stopPropagation();
      openIconPicker(e.currentTarget, apIcon, (icon) => {
        apIcon = icon;
        refreshIcon();
      });
    };
    $('#apName').oninput = refreshIcon;
    $('#apBase').oninput = refreshIcon;
    $('#apPreset').onchange = (e) => {
      const p = PLATFORM_PRESETS[Number(e.target.value)];
      if (!p) return;
      $('#apName').value = p.name;
      $('#apBase').value = p.baseURL;
      apIcon = '';
      refreshIcon();
      $('#apKey').focus();
    };
  }, 20);
}

function prepLlmForSave() {
  const llm = JSON.parse(JSON.stringify(mpState.cfg));
  delete llm.apiKeyMasked;
  delete llm.hasApiKey;
  delete llm.hasVisionApiKey;
  delete llm.__saveAI;
  delete llm.__fuzzy;
  delete llm.__threshold;
  llm.platforms = (mpState.cfg.platforms || []).map((p) => {
    const { apiKeyMasked, hasKey, ...rest } = p;
    return rest;
  });
  return llm;
}

$('#btnAddPlatform').onclick = openAddPlatform;
$('#btnGlobalSettings').onclick = () => { mpState.sel = '__global__'; renderPlatforms(); renderMpMain(); };
$('#platformList').onclick = (e) => {
  const item = e.target.closest('[data-pid]');
  if (!item) return;
  mpState.sel = item.dataset.pid;
  mpState.filter = '';
  renderPlatforms();
  renderMpMain();
};

/* ---------------- 在线测试 ---------------- */

let testImages = [];

function updateImageInfo() {
  const el = $('#testImageInfo');
  if (!testImages.length) {
    el.textContent = '选了图片会走视觉模型，题干里的图片位置用 [图片N] 表示';
    el.style.color = '';
    if ($('#testImageName')) $('#testImageName').textContent = '未选择文件';
  } else {
    const kb = Math.round(testImages.reduce((s, x) => s + x.length * 0.75, 0) / 1024);
    el.textContent = `已选择 ${testImages.length} 张图片（约 ${kb} KB），将以 base64 发送给视觉模型`;
    el.style.color = '#5fd99a';
    if ($('#testImageName')) $('#testImageName').textContent = `${testImages.length} 张图片`;
  }
}

$('#testImageFile').onchange = async (e) => {
  const files = Array.from(e.target.files || []).slice(0, 6);
  testImages = await Promise.all(files.map((f) => new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => res(null);
    r.readAsDataURL(f);
  })));
  testImages = testImages.filter(Boolean);
  updateImageInfo();
};

$('#btnClearImages').onclick = () => {
  testImages = [];
  $('#testImageFile').value = '';
  updateImageInfo();
};

$('#btnRunTest').onclick = async () => {
  const title = $('#testTitle').value.trim();
  if (!title) return toast('请输入题干', 'err');
  const btn = $('#btnRunTest');
  btn.disabled = true;
  btn.textContent = '查询中…';
  try {
    const r = await api('/api/test', {
      method: 'POST',
      body: {
        title,
        options: $('#testOptions').value,
        type: $('#testType').value,
        noLLM: !$('#testUseLLM').checked,
        images: testImages,
      },
    });
    if (!r.ok && !r.data) throw new Error(r.error || '查询失败');
    const { result, chain, totalMs } = r.data;
    $('#testResult').classList.remove('hidden');

    const stepName = { local: '本地题库', providers: '外部题库源', llm: '大模型' };
    $('#testPipeline').innerHTML = chain.map((c, i) => {
      const ok = c.ok ? 'ok' : (c.skipped ? 'skip' : 'fail');
      let desc = '';
      if (c.step === 'local') desc = c.ok ? `命中（${c.matchType === 'exact' ? '完全一致' : '相似度 ' + c.score}）` : '未收录';
      if (c.step === 'providers') desc = c.ok ? '命中' : (c.errors && c.errors.length ? c.errors.join('；') : '未命中');
      if (c.step === 'llm') desc = c.ok
        ? `作答成功（${c.model}${c.images ? ' · ' + c.images + ' 张图' : ''}）`
        : (c.skipped ? '已跳过：' + (c.reason || '') : (c.error || '失败'));
      return `<div class="pipe-step ${ok}">
        <span class="idx">${i + 1}</span>
        <span style="font-weight:500">${stepName[c.step] || c.step}</span>
        <span style="color:var(--muted);font-size:12px">${esc(desc)}</span>
        <span class="meta">${c.ms}ms</span>
      </div>`;
    }).join('');

    const box = $('#testAnswerBox');
    if (result.code === 1) {
      box.classList.remove('err');
      $('#testAnswer').textContent = result.answer;
      $('#testAnswerSub').innerHTML = [
        `来源：${esc(result.source)}${result.matchType ? ' · ' + esc(result.matchType) : ''}`,
        result.analysis ? `解析：${esc(result.analysis)}` : '',
        `总耗时：${totalMs}ms`,
      ].filter(Boolean).join('<br>');
    } else {
      box.classList.add('err');
      $('#testAnswer').textContent = result.msg || '未找到答案';
      $('#testAnswerSub').textContent = `总耗时：${totalMs}ms`;
    }
  } catch (e) {
    toast(e.message, 'err');
  }
  btn.disabled = false;
  btn.textContent = '开始查询';
};

/* ---------------- 日志 ---------------- */

async function loadLogs() {
  const r = await api('/api/logs?limit=200');
  const body = $('#logBody');
  if (!r.ok) { body.innerHTML = '<tr><td colspan="5" class="empty">加载失败</td></tr>'; return; }
  if (!r.data.length) { body.innerHTML = '<tr><td colspan="5" class="empty">还没有查询记录</td></tr>'; return; }
  body.innerHTML = r.data.map((l) => `<tr>
    <td style="color:var(--muted);font-size:12px">${fmtTime(l.t)}</td>
    <td class="td-q">${esc(l.q || '')}</td>
    <td class="td-ans">${esc(l.answer || '-')}</td>
    <td>${sourceBadge(l.answer ? l.source : 'none')}</td>
    <td style="color:var(--muted)">${l.ms ? l.ms + 'ms' : '-'}</td>
  </tr>`).join('');
}
$('#btnReloadLogs').onclick = loadLogs;

/* ---------------- OCS 接入 ---------------- */

let ocsText = '';

async function loadOCS() {
  const r = await api('/api/ocs-config');
  if (!r.ok) return;
  ocsText = r.data.text;
  $('#ocsCode').textContent = ocsText;
  const m = ocsText.match(/127\.0\.0\.1:(\d+)/);
  const port = m ? m[1] : '7788';
  $('#portBadge').textContent = '端口 ' + port;
  $('#apiUrl').textContent = `http://127.0.0.1:${port}/api/search`;
}

/** 服务重启到新端口后，轮询新地址并自动跳转 */
function waitForNewPort(p) {
  const host = location.hostname || '127.0.0.1';
  const target = `http://${host}:${p}`;
  (async () => {
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const resp = await fetch(`${target}/api/config`, { cache: 'no-store' });
        if (resp.ok) { location.href = `${target}/#ocs`; return; }
      } catch (_) { /* 服务还没起来 */ }
    }
    toast(`切换超时，请手动打开 ${target}`, 'err');
  })();
}

/** 修改端口弹窗 */
function openPortDialog() {
  const cur = Number((($('#portBadge') || {}).textContent || '').match(/\d+/)?.[0]) || 7788;
  openModal({
    title: '修改服务端口',
    width: '500px',
    body: `
      <div class="field">
        <label>新端口</label>
        <input class="input" id="fPort" type="number" min="1024" max="65535" value="${cur}" placeholder="例如 8080">
        <div class="hint">可用范围 <b>1024–65535</b>。建议选 7788–7999、8000–9000 之间未被占用的端口；端口冲突会直接提示。</div>
      </div>
      <div class="hint" style="line-height:1.9;margin-top:0">
        保存后会依次完成：<br>
        • 服务在新端口重新启动，页面自动跳转<br>
        • 下方「题库配置 JSON」的接口地址同步更新<br>
        • 「启动服务.bat」同步更新，下次双击仍用新端口<br>
        <b>改完后记得去 OCS 重新复制粘贴一次题库配置</b>
      </div>
    `,
    okText: '保存并重启',
    onOk: async () => {
      const p = Number($('#fPort').value);
      if (!Number.isInteger(p) || p < 1024 || p > 65535) {
        toast('端口需为 1024–65535 之间的整数', 'err');
        return false;
      }
      if (p === cur) { toast('新端口与当前相同', 'err'); return false; }
      let r;
      try {
        r = await api('/api/config/port', { method: 'POST', body: { port: p } });
      } catch (e) {
        toast(e.message, 'err');
        return false;
      }
      if (!r.ok) { toast(r.error || '修改失败', 'err'); return false; }
      closeModal();
      toast(`正在切换到端口 ${p}…`, 'ok');
      waitForNewPort(p);
      return false;
    },
  });
}

$('#portBadge').onclick = openPortDialog;

$('#btnCopyOCS').onclick = async () => {
  try {
    await navigator.clipboard.writeText(ocsText);
    toast('已复制，去 OCS 题库配置里粘贴', 'ok');
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = ocsText;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('已复制', 'ok');
  }
};

/* ---------------- 启动 ---------------- */

$('#btnRefresh').onclick = () => {
  if (currentView === 'bank') loadBank();
  else if (currentView === 'logs') loadLogs();
  else if (currentView === 'providers') loadProviders();
  else if (currentView === 'model') loadModelPage();
  else if (currentView === 'ocs') loadOCS();
  else loadOverview();
  toast('已刷新');
};

(async function init() {
  const hash = (location.hash || '').replace('#', '');
  // 支持 ?tab=global 直达模型配置的通用设置
  const params = new URLSearchParams(location.search);
  if (params.get('tab') === 'global') mpState.sel = '__global__';
  setView(VIEW_META[hash] ? hash : 'overview');
  loadOCS();
})();
