let currentPage = 0;
const PAGE_SIZE = 20;
let currentForm = 's26';

document.addEventListener('DOMContentLoaded', async () => {
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('txnDate').value = today;
  loadConfig();
  loadAccounts();
  loadCodes();
  loadTransactions();
  setupAll();
  populateServiceYearSelect();
  populateYearMonthSelects();
  showSection('menu');
  renderMonthGrid();
  renderCodes();
  renderS26Landing(new Date().getFullYear(), new Date().getMonth() + 1);
  checkSyncStatus();
  setupSyncButton();
  await checkAuth();
});

function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show ' + type;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 2800);
}

async function api(url, opts = {}) {
  const headers = {};
  if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
  const res = await fetch(url, { headers, ...opts });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error de servidor');
  return data;
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function showSection(id) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if (id === 'cuentas') loadTransactions();
  if (id === 'menu') { loadAccounts(); renderS26Landing(s26Year, s26Month); }
  if (id === 'informe') document.getElementById('reportBtn').click();
  if (id === 'admin') { if (authUser?.role === 'admin') adminLoadUsers(); else toast('Acceso denegado', 'error'); }
}

// === CONFIG ===
async function loadConfig() {
  try {
    const cfg = await api('/api/config');
    if (cfg.congregacion) document.getElementById('cfgCong').value = cfg.congregacion;
    if (cfg.ciudad) document.getElementById('cfgCity').value = cfg.ciudad;
    if (cfg.provincia) document.getElementById('cfgProv').value = cfg.provincia;
    if (cfg.ai_api_key) document.getElementById('cfgAiKey').value = cfg.ai_api_key;
    // Actualizar encabezado del landing S-26
    document.getElementById('landingCong').textContent = cfg.congregacion || '—';
    document.getElementById('landingCity').textContent = cfg.ciudad || '—';
    document.getElementById('landingProv').textContent = cfg.provincia || '—';
  } catch (_) {}
}

// === S-26 LANDING TABLE (con edición y borrado por línea) ===
let s26Year = new Date().getFullYear();
let s26Month = new Date().getMonth() + 1;
let s26EditingId = null;
let s26TxnCache = {};

const MONTH_NAMES = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function s26EditorRow(t) {
  const codeOpts = codesCache.map(c =>
    `<option value="${c.code}"${c.code === t.code ? ' selected' : ''}>${c.code} — ${escHtml(c.description)}</option>`).join('');
  const accOpts = Object.entries(ACCOUNT_LABELS).map(([id, lb]) =>
    `<option value="${id}"${id === t.account ? ' selected' : ''}>${lb}</option>`).join('');
  const typeOpts = [['income', 'Entrada'], ['expense', 'Salida'], ['transfer', 'Traspaso (depósito)']]
    .map(([v, lb]) => `<option value="${v}"${v === t.type ? ' selected' : ''}>${lb}</option>`).join('');
  return `<tr class="s26-edit-row">
    <td colspan="11">
      <div style="display:flex;gap:.35rem;flex-wrap:wrap;align-items:center;padding:.25rem 0">
        <input type="date" id="s26e-date" value="${t.date}" style="width:130px">
        <input type="text" id="s26e-desc" value="${escAttr(t.description)}" placeholder="Descripción" style="flex:1;min-width:160px">
        <select id="s26e-code" style="width:200px">${codeOpts}</select>
        <select id="s26e-type" style="width:150px">${typeOpts}</select>
        <select id="s26e-account" style="width:160px">${accOpts}</select>
        <input type="number" id="s26e-amount" step="0.01" min="0.01" value="${t.amount}" style="width:100px;text-align:right">
        <button type="button" class="s26-act-btn" title="Guardar" onclick="s26Save(${t.id})">💾</button>
        <button type="button" class="s26-act-btn" title="Cancelar" onclick="s26CancelEdit()">↩️</button>
      </div>
    </td>
  </tr>`;
}

async function renderS26Landing(year, month) {
  s26Year = year; s26Month = month;
  const body = document.getElementById('s26Body');
  const foot = document.getElementById('s26Foot');
  const mLabel = `${MONTH_NAMES[month]} de ${year}`;
  document.getElementById('landingMonthYear').textContent = mLabel;
  body.innerHTML = `<tr><td colspan="11" class="s26-loading">Cargando ${mLabel}…</td></tr>`;
  foot.innerHTML = '';
  try {
    if (!codesCache.length) { try { codesCache = await api('/api/codes'); } catch (_) {} }
    const data = await api(`/api/s26-data?year=${year}&month=${String(month).padStart(2,'0')}`);
    const { saldoInicial, transactions, hasOverride } = data;
    const fmt = v => v != null ? '$' + Math.abs(v).toFixed(2) : '';
    let saldo = saldoInicial;
    const totals = { recIn:0, recOut:0, prinIn:0, prinOut:0, secIn:0, secOut:0 };
    const rows = [];
    s26TxnCache = {};

    // Fila de saldo inicial
    const isEditingSaldo = window._editingSaldoInicial === `${year}-${month}`;
    if (isEditingSaldo) {
      rows.push(`<tr class="s26-row-init s26-edit-row">
        <td colspan="3"><strong>${MONTH_NAMES[month].toUpperCase()} — SALDO INICIAL</strong></td>
        <td></td><td></td><td></td><td></td><td></td><td></td>
        <td class="s26-amt s26-saldo-cell">
          <input type="number" id="s26e-saldo" step="0.01" value="${saldoInicial}" style="width:100px;text-align:right;font-weight:700">
        </td>
        <td class="s26-acts">
          <button type="button" class="s26-act-btn" title="Guardar saldo inicial" onclick="s26SaveSaldoInicial(${year},${month})">💾</button>
          <button type="button" class="s26-act-btn" title="Cancelar" onclick="s26CancelSaldoInicial()">↩️</button>
          ${data.hasOverride ? `<button type="button" class="s26-act-btn" title="Restaurar cálculo automático" onclick="s26ClearSaldoInicial(${year},${month})">🔄</button>` : ''}
        </td>
      </tr>`);
    } else {
      rows.push(`<tr class="s26-row-init">
        <td colspan="3"><strong>${MONTH_NAMES[month].toUpperCase()} — SALDO INICIAL</strong></td>
        <td></td><td></td><td></td><td></td><td></td><td></td>
        <td class="s26-amt s26-saldo-cell"><strong>${fmt(saldoInicial)}</strong></td>
        <td class="s26-acts">
          <button type="button" class="s26-act-btn" title="Ajustar saldo inicial" onclick="s26EditSaldoInicial(${year},${month})">✏️</button>
          ${data.hasOverride ? '<span style="font-size:.6rem;color:var(--accent)">⚑</span>' : ''}
        </td>
      </tr>`);
    }

    for (const t of transactions) {
      s26TxnCache[t.id] = t;
      let recIn='', recOut='', prinIn='', prinOut='', secIn='', secOut='';
      const amt = fmt(t.amount);
      if (t.type === 'income') {
        if (t.account==='caja')      { recIn=amt;   totals.recIn+=t.amount;   saldo+=t.amount; }
        else if (t.account==='corriente') { prinIn=amt;  totals.prinIn+=t.amount;  saldo+=t.amount; }
        else if (t.account==='sucursal')  { secIn=amt;   totals.secIn+=t.amount;   saldo+=t.amount; }
      } else if (t.type === 'expense') {
        if (t.account==='caja')      { recOut=amt;  totals.recOut+=t.amount;  saldo-=t.amount; }
        else if (t.account==='corriente') { prinOut=amt; totals.prinOut+=t.amount; saldo-=t.amount; }
        else if (t.account==='sucursal')  { secOut=amt;  totals.secOut+=t.amount;  saldo-=t.amount; }
      } else if (t.type === 'transfer') {
        const from = t.from_account || t.account;
        const to   = t.to_account;
        if (from==='caja')       { recOut=amt;  totals.recOut+=t.amount; }
        else if (from==='corriente') { prinOut=amt; totals.prinOut+=t.amount; }
        else if (from==='sucursal')  { secOut=amt;  totals.secOut+=t.amount; }
        if (to==='caja')         { recIn=amt;   totals.recIn+=t.amount; }
        else if (to==='corriente')   { prinIn=amt;  totals.prinIn+=t.amount; }
        else if (to==='sucursal')    { secIn=amt;   totals.secIn+=t.amount; }
      }

      if (t.id === s26EditingId) {
        rows.push(s26EditorRow(t));
        continue;
      }

      const day = t.date.slice(8).replace(/^0/, '');
      rows.push(`<tr class="s26-row">
        <td class="s26-day">${day}</td>
        <td class="s26-col-desc">${escHtml(t.description)}</td>
        <td class="s26-col-ct"><strong>${t.code}</strong></td>
        <td class="s26-amt">${recIn}</td><td class="s26-amt s26-out">${recOut}</td>
        <td class="s26-amt">${prinIn}</td><td class="s26-amt s26-out">${prinOut}</td>
        <td class="s26-amt">${secIn}</td><td class="s26-amt s26-out">${secOut}</td>
        <td class="s26-amt s26-saldo-cell">${fmt(saldo)}</td>
        <td class="s26-acts">
          <button type="button" class="s26-act-btn" title="Editar" onclick="s26Edit(${t.id})">✏️</button>
          <button type="button" class="s26-act-btn" title="Eliminar" onclick="s26Del(${t.id})">🗑️</button>
        </td>
      </tr>`);
    }

    body.innerHTML = rows.join('') || `<tr><td colspan="11" class="s26-loading">Sin transacciones en ${mLabel}</td></tr>`;
    foot.innerHTML = `<tr class="s26-totals">
      <td colspan="3">TOTALES DE TODAS LAS COLUMNAS ▶</td>
      <td class="s26-amt">${fmt(totals.recIn)}</td><td class="s26-amt s26-out">${fmt(totals.recOut)}</td>
      <td class="s26-amt">${fmt(totals.prinIn)}</td><td class="s26-amt s26-out">${fmt(totals.prinOut)}</td>
      <td class="s26-amt">${fmt(totals.secIn)}</td><td class="s26-amt s26-out">${fmt(totals.secOut)}</td>
      <td class="s26-amt s26-saldo-cell"><strong>${fmt(saldo)}</strong></td>
      <td></td>
    </tr>`;
  } catch (err) {
    body.innerHTML = `<tr><td colspan="11" class="s26-loading" style="color:var(--danger)">Error: ${escHtml(err.message)}</td></tr>`;
  }
}

function s26Edit(id) { s26EditingId = id; renderS26Landing(s26Year, s26Month); }
function s26CancelEdit() { s26EditingId = null; renderS26Landing(s26Year, s26Month); }

async function s26Save(id) {
  const body = {
    date: document.getElementById('s26e-date').value,
    description: document.getElementById('s26e-desc').value,
    code: document.getElementById('s26e-code').value,
    type: document.getElementById('s26e-type').value,
    account: document.getElementById('s26e-account').value,
    amount: parseFloat(document.getElementById('s26e-amount').value)
  };
  if (!body.date || !body.description || !body.code || isNaN(body.amount) || body.amount <= 0) {
    toast('Complete todos los campos correctamente', 'error');
    return;
  }
  try {
    await api(`/api/transactions/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    s26EditingId = null;
    toast('Transacción actualizada');
    renderS26Landing(s26Year, s26Month);
    loadAccounts();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function s26Del(id) {
  const t = s26TxnCache[id];
  if (!confirm(`¿Eliminar "${t ? t.description : 'esta transacción'}"${t ? ' por $' + t.amount.toFixed(2) : ''}?`)) return;
  try {
    await api(`/api/transactions/${id}`, { method: 'DELETE' });
    toast('Transacción eliminada');
    renderS26Landing(s26Year, s26Month);
    loadAccounts();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// === OCR MODAL ===
function openOcrModal() {
  const m = document.getElementById('ocrModal');
  // Resetear estado anterior al abrir
  document.getElementById('ocrResult').style.display = 'none';
  document.getElementById('ocrLoading').style.display = 'none';
  m.showModal();
}
function closeOcrModal() { document.getElementById('ocrModal').close(); }

// Cerrar modal con Escape (ya es comportamiento nativo de <dialog>)
document.getElementById('ocrModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeOcrModal();
});

// === ASISTENTE IA ===
let aiHistory = [];

function toggleAiChat() {
  const p = document.getElementById('aiChat');
  const open = p.classList.toggle('open');
  document.getElementById('aiFab').classList.toggle('hidden', open);
  if (open) document.getElementById('aiChatInput').focus();
}

// Markdown mínimo y seguro: escapa HTML y luego aplica **negritas** y viñetas
function aiToHtml(t) {
  let h = escHtml(t);
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/^\s*[*-]\s+(.+)$/gm, '<span class="ai-li">• $1</span>');
  return h.replace(/\n/g, '<br>');
}

function aiBubble(role, html) {
  const msgs = document.getElementById('aiChatMsgs');
  const div = document.createElement('div');
  div.className = 'ai-msg ' + role;
  div.innerHTML = html;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function aiAsk(q) { sendAiQuestion(q); }

async function sendAiQuestion(q) {
  q = q.trim();
  if (!q) return;
  aiBubble('user', escHtml(q));
  const typing = aiBubble('ai typing', '<span class="ai-dot"></span><span class="ai-dot"></span><span class="ai-dot"></span>');
  const history = aiHistory.slice();
  aiHistory.push({ role: 'user', text: q });
  try {
    const r = await api('/api/ai-chat', { method: 'POST', body: JSON.stringify({ question: q, history }) });
    typing.remove();
    aiBubble('ai', aiToHtml(r.answer));
    aiHistory.push({ role: 'ai', text: r.answer });
  } catch (err) {
    typing.remove();
    if (err.message === 'no_key') {
      aiBubble('ai', '🔑 Para activar el asistente necesito la clave API <strong>gratuita</strong> de Google AI Studio (la misma que usa el OCR). Créela en <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a> y péguela en el campo "Clave API de IA" del encabezado.');
    } else {
      aiBubble('ai', '⚠️ ' + escHtml(err.message));
    }
  }
}

document.getElementById('aiChatForm').addEventListener('submit', e => {
  e.preventDefault();
  const input = document.getElementById('aiChatInput');
  const q = input.value;
  input.value = '';
  sendAiQuestion(q);
});
document.getElementById('cfgSave').addEventListener('click', async () => {
  const aiKey = document.getElementById('cfgAiKey').value.trim();
  if (aiKey && !isGoogleApiKey(aiKey)) {
    toast('La clave de IA no parece válida: debe empezar con "AIza" (cree una en aistudio.google.com/apikey)', 'error');
    return;
  }
  await api('/api/config', {
    method: 'POST',
    body: JSON.stringify({
      congregacion: document.getElementById('cfgCong').value,
      ciudad: document.getElementById('cfgCity').value,
      provincia: document.getElementById('cfgProv').value,
      ai_api_key: document.getElementById('cfgAiKey').value
    })
  });
  toast('Configuración guardada');
});

// === SERVICE YEAR ===
function getServiceYears() {
  const y = new Date().getFullYear();
  const years = [];
  for (let i = -1; i <= 2; i++) {
    const start = y + i;
    years.push(`${start}/${start + 1}`);
  }
  return years;
}
function getCurrentSY() {
  const d = new Date();
  const m = d.getMonth() + 1;
  const y = d.getFullYear();
  return m >= 9 ? `${y}/${y + 1}` : `${y - 1}/${y}`;
}
function populateServiceYearSelect() {
  const yrs = getServiceYears();
  for (const sel of ['sySelect', 'chartSySelect']) {
    const el = document.getElementById(sel);
    el.innerHTML = yrs.map(sy => `<option value="${sy}"${sy === getCurrentSY() ? ' selected' : ''}>${sy}</option>`).join('');
  }
}

// === MONTH GRID ===
function renderMonthGrid() {
  const grid = document.getElementById('monthGrid');
  const months = [
    { n: '09', name: 'Septiembre' }, { n: '10', name: 'Octubre' }, { n: '11', name: 'Noviembre' }, { n: '12', name: 'Diciembre' },
    { n: '01', name: 'Enero' }, { n: '02', name: 'Febrero' }, { n: '03', name: 'Marzo' }, { n: '04', name: 'Abril' },
    { n: '05', name: 'Mayo' }, { n: '06', name: 'Junio' }, { n: '07', name: 'Julio' }, { n: '08', name: 'Agosto' }
  ];
  const sy = document.getElementById('sySelect').value;
  grid.innerHTML = months.map(m => {
    let y = sy.split('/')[0];
    if (['01','02','03','04','05','06','07','08'].includes(m.n)) y = sy.split('/')[1];
    const ym = `${y}-${m.n}`;
    return `<div class="month-btn" onclick="goToMonth('${y}','${m.n}')">
      <span style="font-size:1.1rem">${m.name}</span>
      <span class="month-name">${ym}</span>
    </div>`;
  }).join('');
}

document.getElementById('sySelect').addEventListener('change', renderMonthGrid);

function goToMonth(year, month) {
  // Desde el landing: muestra el S-26 del mes seleccionado
  renderS26Landing(parseInt(year), parseInt(month));
}

// === ACCOUNTS ===
// Contador animado: los saldos "cuentan" hasta su valor con easing suave.
function animateBalance(el, value) {
  const start = el._val ?? 0;
  if (Math.abs(start - value) < 0.005) { el.textContent = '$' + value.toFixed(2); el._val = value; return; }
  const dur = 700, t0 = performance.now();
  el._val = value;
  function step(t) {
    const p = Math.min((t - t0) / dur, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = '$' + (start + (value - start) * eased).toFixed(2);
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

async function loadAccounts() {
  const data = await api('/api/accounts');
  for (const acc of data) {
    const el = document.getElementById('balance-' + acc.id);
    if (el) animateBalance(el, acc.balance);
  }
  const total = data.reduce((s, a) => s + a.balance, 0);
  animateBalance(document.getElementById('balance-total'), total);
}

// === CODES ===
async function loadCodes() {
  const data = await api('/api/codes');
  codesCache = data;
  const sel = document.getElementById('txnCode');
  sel.innerHTML = '<option value="">Seleccione CT</option>';
  for (const c of data) sel.innerHTML += `<option value="${c.code}">${c.code} — ${c.description}</option>`;
}

let editingCode = null;

function codeCatSelect(id, selected) {
  const cats = [['income', 'Entrada'], ['expense', 'Salida'], ['transfer', 'Transferencia']];
  return `<select id="${id}">${cats.map(([v, l]) =>
    `<option value="${v}"${v === selected ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
}

async function renderCodes() {
  const data = await api('/api/codes');
  const catLabels = { income: 'Entrada', expense: 'Salida', transfer: 'Transferencia' };
  const rows = data.map(c => {
    if (c.code === editingCode) {
      return `<tr>
        <td><input id="ecCode" value="${escAttr(c.code)}" maxlength="6" style="width:5rem;text-transform:uppercase"></td>
        <td><input id="ecDesc" value="${escAttr(c.description)}"></td>
        <td>${codeCatSelect('ecCat', c.category)}</td>
        <td class="txn-actions">
          <button type="button" title="Guardar" onclick="saveCode('${escAttr(c.code)}')">💾</button>
          <button type="button" title="Cancelar" onclick="cancelEditCode()">✖️</button>
        </td>
      </tr>`;
    }
    return `<tr>
      <td><strong>${c.code}</strong></td>
      <td>${escHtml(c.description)}</td>
      <td>${catLabels[c.category] || c.category}</td>
      <td class="txn-actions">
        <button type="button" title="Editar" onclick="startEditCode('${escAttr(c.code)}')">✏️</button>
        <button type="button" title="Eliminar" onclick="deleteCode('${escAttr(c.code)}')">🗑️</button>
      </td>
    </tr>`;
  }).join('');

  document.getElementById('codesTable').innerHTML = `
    <table>
      <thead><tr><th>Código CT</th><th>Descripción</th><th>Categoría</th><th></th></tr></thead>
      <tbody>${rows}
        <tr>
          <td><input id="ncCode" placeholder="CT" maxlength="6" style="width:5rem;text-transform:uppercase"></td>
          <td><input id="ncDesc" placeholder="Descripción del nuevo código"></td>
          <td>${codeCatSelect('ncCat', 'income')}</td>
          <td class="txn-actions"><button type="button" class="btn btn-primary" onclick="addCode()">+ Agregar</button></td>
        </tr>
      </tbody>
    </table>`;
}

function startEditCode(code) { editingCode = code; renderCodes(); }
function cancelEditCode() { editingCode = null; renderCodes(); }

async function addCode() {
  const body = {
    code: document.getElementById('ncCode').value,
    description: document.getElementById('ncDesc').value,
    category: document.getElementById('ncCat').value,
  };
  try {
    await api('/api/codes', { method: 'POST', body: JSON.stringify(body) });
    toast('Código agregado');
    await loadCodes();
    renderCodes();
  } catch (e) { toast(e.message, 'error'); }
}

async function saveCode(orig) {
  const body = {
    code: document.getElementById('ecCode').value,
    description: document.getElementById('ecDesc').value,
    category: document.getElementById('ecCat').value,
  };
  try {
    await api('/api/codes/' + encodeURIComponent(orig), { method: 'PUT', body: JSON.stringify(body) });
    toast('Código actualizado');
    editingCode = null;
    await loadCodes();
    renderCodes();
    loadTransactions();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteCode(code) {
  if (!confirm(`¿Eliminar el código ${code}? Solo es posible si ninguna transacción lo usa.`)) return;
  try {
    await api('/api/codes/' + encodeURIComponent(code), { method: 'DELETE' });
    toast('Código eliminado');
    await loadCodes();
    renderCodes();
  } catch (e) { toast(e.message, 'error'); }
}

// === TRANSACTIONS (con edición en línea) ===
let editingTxnId = null;
let txnCache = {};
let codesCache = [];

const ACCOUNT_LABELS = { caja: 'Recibido', corriente: 'Cta. Principal (Caja)', sucursal: 'Cta. Secundaria' };

function escAttr(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function loadTransactions() {
  const params = new URLSearchParams({ limit: PAGE_SIZE, offset: currentPage * PAGE_SIZE });
  const fa = document.getElementById('filterAccount').value;
  const ft = document.getElementById('filterType').value;
  const fc = document.getElementById('filterCode').value.toUpperCase().trim();
  if (fa) params.set('account', fa);
  if (ft) params.set('type', ft);
  if (fc) params.set('code', fc);

  if (!codesCache.length) { try { codesCache = await api('/api/codes'); } catch (_) {} }

  const data = await api('/api/transactions?' + params.toString());
  const tbody = document.getElementById('txnTableBody');
  txnCache = {};
  if (!data.transactions.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#999;padding:1.5rem">No hay transacciones registradas</td></tr>';
  } else {
    const typeLabels = { income: 'Entrada', expense: 'Salida', transfer: 'Traspaso', transfer_in: 'Traspaso (recibido)' };
    tbody.innerHTML = data.transactions.map(t => {
      txnCache[t.id] = t;
      if (t.id === editingTxnId) return renderTxnEditRow(t);
      const isPlus = t.type === 'income' || t.type === 'transfer_in';
      return `<tr>
        <td>${t.date}</td>
        <td>${ACCOUNT_LABELS[t.account] || t.account}</td>
        <td><strong>${t.code}</strong></td>
        <td>${escHtml(t.description)}</td>
        <td class="${isPlus ? 'type-income' : 'type-expense'}">${typeLabels[t.type] || t.type}</td>
        <td style="color:var(--income);font-weight:600">${isPlus ? '$' + t.amount.toFixed(2) : ''}</td>
        <td style="color:var(--expense);font-weight:600">${!isPlus ? '$' + t.amount.toFixed(2) : ''}</td>
        <td class="txn-actions">
          <button type="button" title="Editar" onclick="startEditTxn(${t.id})">✏️</button>
          <button type="button" title="Eliminar" onclick="deleteTxn(${t.id})">🗑️</button>
        </td>
      </tr>`;
    }).join('');
  }

  const totalPages = Math.ceil(data.total / PAGE_SIZE);
  const pag = document.getElementById('pagination');
  pag.innerHTML = '';
  for (let i = 0; i < totalPages; i++) {
    const btn = document.createElement('button');
    btn.className = 'page-btn' + (i === currentPage ? ' active' : '');
    btn.textContent = i + 1;
    btn.onclick = () => { currentPage = i; loadTransactions(); };
    pag.appendChild(btn);
  }
}

function renderTxnEditRow(t) {
  const codeOpts = codesCache.map(c => `<option value="${c.code}"${c.code === t.code ? ' selected' : ''}>${c.code} — ${escHtml(c.description)}</option>`).join('');
  const accOpts = Object.entries(ACCOUNT_LABELS).map(([id, lb]) => `<option value="${id}"${id === t.account ? ' selected' : ''}>${lb}</option>`).join('');
  const typeOpts = [['income', 'Entrada'], ['expense', 'Salida'], ['transfer', 'Traspaso'], ['transfer_in', 'Traspaso (recibido)']]
    .map(([v, lb]) => `<option value="${v}"${v === t.type ? ' selected' : ''}>${lb}</option>`).join('');
  return `<tr class="txn-edit-row">
    <td><input type="date" id="et-date" value="${t.date}"></td>
    <td><select id="et-account">${accOpts}</select></td>
    <td><select id="et-code">${codeOpts}</select></td>
    <td><input type="text" id="et-desc" value="${escAttr(t.description)}"></td>
    <td><select id="et-type">${typeOpts}</select></td>
    <td colspan="2"><input type="number" id="et-amount" step="0.01" min="0.01" value="${t.amount}" style="text-align:right"></td>
    <td class="txn-actions">
      <button type="button" title="Guardar" onclick="saveTxn(${t.id})">💾</button>
      <button type="button" title="Cancelar" onclick="cancelEditTxn()">↩️</button>
    </td>
  </tr>`;
}

function startEditTxn(id) { editingTxnId = id; loadTransactions(); }
function cancelEditTxn() { editingTxnId = null; loadTransactions(); }

async function saveTxn(id) {
  const body = {
    date: document.getElementById('et-date').value,
    account: document.getElementById('et-account').value,
    code: document.getElementById('et-code').value,
    description: document.getElementById('et-desc').value,
    type: document.getElementById('et-type').value,
    amount: parseFloat(document.getElementById('et-amount').value)
  };
  if (!body.date || !body.description || !body.code || isNaN(body.amount) || body.amount <= 0) {
    toast('Complete todos los campos correctamente', 'error');
    return;
  }
  try {
    await api(`/api/transactions/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    editingTxnId = null;
    toast('Transacción actualizada');
    loadTransactions();
    loadAccounts();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteTxn(id) {
  const t = txnCache[id];
  if (!confirm(`¿Eliminar la transacción "${t ? t.description : id}"?`)) return;
  try {
    await api(`/api/transactions/${id}`, { method: 'DELETE' });
    toast('Transacción eliminada');
    loadTransactions();
    loadAccounts();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// === FORM ===
function setupForm() {
  const typeSel = document.getElementById('txnType');
  const accountSel = document.getElementById('txnAccount');
  const toGroup = document.getElementById('toAccountGroup');
  const toSel = document.getElementById('txnToAccount');

  typeSel.addEventListener('change', () => {
    toGroup.style.display = typeSel.value === 'transfer' ? 'block' : 'none';
    // Donaciones entran a Recibido; los gastos salen de la Caja de dinero;
    // un depósito (traspaso) va de Recibido → Caja de dinero.
    if (typeSel.value === 'income') accountSel.value = 'caja';
    if (typeSel.value === 'expense') accountSel.value = 'corriente';
    if (typeSel.value === 'transfer') {
      accountSel.value = 'caja';
      toSel.value = 'corriente';
    }
  });
  accountSel.addEventListener('change', () => {
    if (typeSel.value === 'transfer') toSel.value = accountSel.value === 'corriente' ? 'caja' : 'corriente';
  });

  document.getElementById('txnForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = {
      date: document.getElementById('txnDate').value,
      type: typeSel.value,
      account: accountSel.value,
      code: document.getElementById('txnCode').value,
      description: document.getElementById('txnDescription').value,
      amount: parseFloat(document.getElementById('txnAmount').value),
    };
    if (!data.code) { toast('Seleccione un código CT', 'error'); return; }
    if (data.type === 'transfer') {
      data.from_account = accountSel.value;
      data.to_account = toSel.value;
    }
    try {
      await api('/api/transactions', { method: 'POST', body: JSON.stringify(data) });
      toast('Asiento registrado correctamente');
      document.getElementById('txnForm').reset();
      document.getElementById('txnDate').value = new Date().toISOString().slice(0, 10);
      loadAccounts();
      loadTransactions();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// === OCR: CAPTURA AUTOMÁTICA MULTILÍNEA EDITABLE ===
// Cada línea del recibo se muestra como una fila editable (fecha,
// descripción, código CT, tipo, cuenta y monto) para validarla antes
// de registrarla. La suma se compara contra el TOTAL leído del recibo.
let ocrLines = [];
let ocrTotal = null;
let ocrVerified = false;
let ocrCodesCache = [];

const ACCOUNT_OPTS = [
  { id: 'caja', label: 'Recibido (Donaciones)' },
  { id: 'corriente', label: 'Cta. Principal (Caja)' },
  { id: 'sucursal', label: 'Cta. Secundaria' },
];

// Donaciones (entradas) → Recibido; pagos (salidas) → Caja de dinero
function defaultAccountFor(type) {
  return type === 'expense' ? 'corriente' : 'caja';
}

// Las claves de Google AI Studio empiezan con "AIza"
function isGoogleApiKey(k) { return /^AIza[0-9A-Za-z_\-]{20,}$/.test(k); }

// === POPUP DE ADVERTENCIA: IA de recibos no disponible ===
// Flag: hubo clave funcionando alguna vez en este navegador. Distingue
// "nunca configuró clave" (solo hint amarillo) de "la clave desapareció" (popup).
const HAD_AI_KEY_FLAG = 'cuentas-had-ai-key';

// Mapa causa → explicación + pasos de solución
const AI_WARN_CONTENT = {
  invalid_key: {
    cause: 'La clave API de Google fue rechazada (clave inválida o revocada).',
    steps: [
      'Entre a aistudio.google.com/apikey con su cuenta de Google.',
      'Use "Crear clave de API" y copie la clave completa (empieza con "AIza").',
      'Péguela en Configuración → "Clave API de IA" y guarde.',
      'Vuelva a subir el recibo.'
    ]
  },
  forbidden: {
    cause: 'Google rechazó la clave por permisos (403): la API no está habilitada o la clave tiene restricciones.',
    steps: [
      'En Google Cloud Console, habilite la "Generative Language API" para el proyecto de la clave.',
      'En las restricciones de la clave elija "None" — las restricciones por sitio web bloquean el uso desde el servidor.',
      'Si no puede cambiarla, cree una clave nueva en aistudio.google.com/apikey.'
    ]
  },
  quota: {
    cause: 'Se agotó la cuota gratuita de la clave (límite por minuto o por día).',
    steps: [
      'Espere 1-2 minutos y pulse "Probar clave de nuevo".',
      'Si sigue fallando, la cuota diaria se agotó: espere al día siguiente.',
      'Alternativa: cree una clave en otro proyecto de Google y péguela en Configuración.'
    ]
  },
  model_missing: {
    cause: 'Ningún modelo de IA está disponible para esta clave.',
    steps: [
      'El sistema ya intentó modelos alternos sin éxito.',
      'Cree una clave nueva en aistudio.google.com/apikey y péguela en Configuración.'
    ]
  },
  overloaded: {
    cause: 'El servicio de IA de Google está sobrecargado en este momento (error temporal).',
    steps: [
      'Reintente en unos minutos con "Probar clave de nuevo".',
      'Mientras tanto, use el resultado del OCR local y verifique los montos a mano.'
    ]
  },
  network: {
    cause: 'No se pudo conectar con el servicio de IA de Google.',
    steps: [
      'Verifique la conexión a internet.',
      'Reintente en unos minutos con "Probar clave de nuevo".'
    ]
  },
  key_lost: {
    cause: 'La clave de IA que estaba configurada ya no está guardada (se perdió al reiniciar el servidor en la nube).',
    steps: [
      'Vuelva a pegar su clave en Configuración → "Clave API de IA" y guarde.',
      'Para que no vuelva a perderse, configure la clave como variable de entorno GEMINI_API_KEY en Vercel.'
    ]
  }
};

function showAiWarning(code) {
  const content = AI_WARN_CONTENT[code] || AI_WARN_CONTENT.network;
  document.getElementById('aiWarnCause').textContent = content.cause;
  document.getElementById('aiWarnSteps').innerHTML = content.steps.map(s => `<li>${s}</li>`).join('');
  const retryRes = document.getElementById('aiWarnRetryResult');
  retryRes.style.display = 'none';
  retryRes.className = 'ai-warn-retry';
  const m = document.getElementById('aiWarnModal');
  if (!m.open) m.showModal();
}

function closeAiWarn() { document.getElementById('aiWarnModal').close(); }

function setupAiWarnModal() {
  const m = document.getElementById('aiWarnModal');
  m.addEventListener('click', e => { if (e.target === m) closeAiWarn(); });

  document.getElementById('aiWarnRetryBtn').addEventListener('click', async () => {
    const out = document.getElementById('aiWarnRetryResult');
    out.style.display = 'block';
    out.className = 'ai-warn-retry';
    out.textContent = 'Probando clave…';
    try {
      const st = await api('/api/ai-status');
      if (st.ok) {
        out.className = 'ai-warn-retry ok';
        out.textContent = '✅ La IA responde correctamente. Vuelva a subir el recibo.';
        localStorage.setItem(HAD_AI_KEY_FLAG, '1');
        setTimeout(closeAiWarn, 1800);
      } else {
        const c = AI_WARN_CONTENT[st.code] || AI_WARN_CONTENT.network;
        out.className = 'ai-warn-retry fail';
        out.textContent = '✗ Sigue fallando: ' + c.cause;
      }
    } catch (e) {
      out.className = 'ai-warn-retry fail';
      out.textContent = '✗ No se pudo contactar al servidor: ' + e.message;
    }
  });

  document.getElementById('aiWarnConfigBtn').addEventListener('click', () => {
    closeAiWarn();
    closeOcrModal();
    const input = document.getElementById('cfgAiKey');
    input.focus();
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

function setupUpload() {
  const area = document.getElementById('uploadArea');
  const input = document.getElementById('receiptInput');
  const btn = document.getElementById('uploadBtn');
  area.addEventListener('click', (e) => { if (e.target === btn) return; input.click(); });
  btn.addEventListener('click', (e) => { e.stopPropagation(); input.click(); });
  area.addEventListener('dragover', e => { e.preventDefault(); area.classList.add('dragover'); });
  area.addEventListener('dragleave', () => area.classList.remove('dragover'));
  area.addEventListener('drop', e => {
    e.preventDefault();
    area.classList.remove('dragover');
    if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; processFile(e.dataTransfer.files[0]); }
  });
  input.addEventListener('change', () => { if (input.files[0]) processFile(input.files[0]); });

  document.getElementById('ocrAddLineBtn').addEventListener('click', () => {
    ocrLines.push({
      date: new Date().toISOString().slice(0, 10),
      description: '', code: '', type: 'income',
      account: 'caja', amount: null, verified: false
    });
    renderOcrLines();
  });
  document.getElementById('autoRegisterBtn').addEventListener('click', registerOcrLines);

  document.getElementById('ocrAiKeySave').addEventListener('click', async () => {
    const key = document.getElementById('ocrAiKeyInput').value.trim();
    if (!key) { toast('Pegue la clave API primero', 'error'); return; }
    if (!isGoogleApiKey(key)) {
      toast('Esa no es una clave API de Google: debe empezar con "AIza". En aistudio.google.com/apikey use "Crear clave de API" y copie la clave.', 'error');
      return;
    }
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ ai_api_key: key }) });
      document.getElementById('cfgAiKey').value = key;
      document.getElementById('ocrAiHint').style.display = 'none';
      localStorage.setItem(HAD_AI_KEY_FLAG, '1');
      toast('✅ Clave guardada. Vuelva a subir el recibo para usar la IA.');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

async function processFile(file) {
  if (!file.type.startsWith('image/')) { toast('Solo imágenes', 'error'); return; }
  document.getElementById('ocrLoading').style.display = 'block';
  document.getElementById('ocrResult').style.display = 'none';
  const fd = new FormData();
  fd.append('receipt', file);
  try {
    const [data, codes] = await Promise.all([
      fetch('/api/upload-receipt', { method: 'POST', body: fd, headers: authToken ? { 'Authorization': 'Bearer ' + authToken } : {} }).then(r => r.json()),
      api('/api/codes')
    ]);
    ocrCodesCache = codes;
    document.getElementById('ocrLoading').style.display = 'none';
    document.getElementById('ocrText').textContent = data.text || '(Sin texto)';

    const sug = data.suggested || {};
    ocrTotal = (typeof sug.total === 'number') ? sug.total : null;
    ocrVerified = !!sug.verified;
    const today = new Date().toISOString().slice(0, 10);
    const txns = (sug.allTransactions && sug.allTransactions.length)
      ? sug.allTransactions
      : [{ date: sug.date, description: sug.description, code: sug.code, type: sug.type, amount: sug.amount }];
    ocrLines = txns.map(t => ({
      date: t.date || sug.date || today,
      description: t.description || '',
      code: t.code || '',
      type: t.type || 'income',
      account: defaultAccountFor(t.type || 'income'),
      amount: (typeof t.amount === 'number' && !isNaN(t.amount)) ? t.amount : null,
      verified: !!t.verified
    }));
    document.getElementById('ocrAiHint').style.display = data.engine === 'ia' ? 'none' : 'block';

    // Tabla de decisión del popup de IA (war-game Move 4):
    //   hasKey && !ok            → la clave falló: popup con la causa clasificada
    //   !hasKey && hubo clave    → la clave desapareció: popup 'key_lost'
    //   !hasKey && nunca hubo    → solo el hint amarillo (sin popup)
    const ai = data.aiStatus || null;
    if (ai) {
      if (ai.ok) {
        localStorage.setItem(HAD_AI_KEY_FLAG, '1');
      } else if (ai.hasKey) {
        showAiWarning(ai.code || 'network');
      } else if (localStorage.getItem(HAD_AI_KEY_FLAG) === '1') {
        showAiWarning('key_lost');
      }
    }
    const engineLabel = data.engine === 'ia'
      ? '<span style="background:#eaf2f8;color:#1a5276;padding:.1rem .4rem;border-radius:4px;font-size:.65rem;font-weight:700">🤖 Interpretado con IA</span> '
      : '<span style="background:#f4f6f7;color:#566573;padding:.1rem .4rem;border-radius:4px;font-size:.65rem;font-weight:700">OCR local</span> ';
    document.getElementById('ocrVerifyBadge').innerHTML = engineLabel + (ocrVerified
      ? '<span style="background:#eafaf1;color:#27ae60;padding:.1rem .4rem;border-radius:4px;font-size:.65rem;font-weight:700">✓ Montos validados con el TOTAL</span>'
      : '<span style="background:#fef9e7;color:#b9770e;padding:.1rem .4rem;border-radius:4px;font-size:.65rem;font-weight:700">⚠ Verifique los montos</span>');
    renderOcrLines();
    document.getElementById('ocrResult').style.display = 'block';
  } catch (err) {
    document.getElementById('ocrLoading').style.display = 'none';
    toast('Error OCR: ' + err.message, 'error');
  }
}

function renderOcrLines() {
  const tbody = document.getElementById('ocrLinesBody');
  const codeOpts = sel => '<option value="">CT</option>' + ocrCodesCache.map(c =>
    `<option value="${c.code}"${c.code === sel ? ' selected' : ''} title="${escAttr(c.description)}">${c.code}</option>`).join('');
  const accOpts = sel => ACCOUNT_OPTS.map(a =>
    `<option value="${a.id}"${a.id === sel ? ' selected' : ''}>${a.label}</option>`).join('');
  tbody.innerHTML = ocrLines.map((l, i) => `
    <tr class="${l.verified ? 'ocr-ok' : 'ocr-check'}">
      <td><input type="date" value="${escAttr(l.date)}" data-i="${i}" data-f="date"></td>
      <td><input type="text" value="${escAttr(l.description)}" placeholder="Descripción" data-i="${i}" data-f="description"></td>
      <td><select data-i="${i}" data-f="code">${codeOpts(l.code)}</select></td>
      <td><select data-i="${i}" data-f="type">
        <option value="income"${l.type === 'income' ? ' selected' : ''}>Entrada</option>
        <option value="expense"${l.type === 'expense' ? ' selected' : ''}>Salida</option>
        <option value="transfer"${l.type === 'transfer' ? ' selected' : ''}>Traspaso</option>
      </select></td>
      <td><select data-i="${i}" data-f="account">${accOpts(l.account)}</select></td>
      <td><input type="number" step="0.01" min="0" value="${l.amount ?? ''}" class="${l.amount == null ? 'ocr-missing' : ''}" data-i="${i}" data-f="amount"></td>
      <td><button type="button" class="ocr-del" data-i="${i}" title="Eliminar línea">✕</button></td>
    </tr>`).join('');
  tbody.querySelectorAll('input,select').forEach(el => {
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', onOcrLineChange);
  });
  tbody.querySelectorAll('.ocr-del').forEach(b => b.addEventListener('click', e => {
    ocrLines.splice(parseInt(e.currentTarget.dataset.i), 1);
    renderOcrLines();
  }));
  updateOcrSum();
  renderOcrPreview();
}

function onOcrLineChange(e) {
  const i = parseInt(e.target.dataset.i);
  const f = e.target.dataset.f;
  let v = e.target.value;
  if (f === 'amount') {
    v = v === '' ? null : parseFloat(v);
    if (v !== null && isNaN(v)) v = null;
    ocrLines[i].verified = false;
    e.target.classList.toggle('ocr-missing', v === null);
    const tr = e.target.closest('tr');
    if (tr) tr.className = 'ocr-check';
  }
  ocrLines[i][f] = v;
  if (f === 'type') {
    ocrLines[i].account = defaultAccountFor(v);
    renderOcrLines();
    return;
  }
  updateOcrSum();
  renderOcrPreview();
}

function updateOcrSum() {
  const el = document.getElementById('ocrSumCheck');
  const sum = ocrLines.reduce((s, l) => s + (l.amount || 0), 0);
  if (ocrTotal == null) {
    el.innerHTML = `<span>Suma: $${sum.toFixed(2)} (sin TOTAL legible en el recibo)</span>`;
  } else if (Math.abs(sum - ocrTotal) < 0.01) {
    el.innerHTML = `<span class="ocr-sum-ok">✓ Suma $${sum.toFixed(2)} = TOTAL del recibo $${ocrTotal.toFixed(2)}</span>`;
  } else {
    el.innerHTML = `<span class="ocr-sum-bad">⚠ Suma $${sum.toFixed(2)} ≠ TOTAL del recibo $${ocrTotal.toFixed(2)}</span>`;
  }
}

function renderOcrPreview() {
  const el = document.getElementById('ocrFormPreview');
  if (!ocrLines.length) {
    el.innerHTML = '<p style="color:var(--text-light);font-size:.7rem">Sin líneas de captura</p>';
    return;
  }
  const accCol = { caja: 'rec', corriente: 'prin', sucursal: 'sec' };
  const rows = ocrLines.map(l => {
    const amt = l.amount != null ? '$' + (+l.amount).toFixed(2) : '<em style="color:#e74c3c">?</em>';
    const cells = { rec: ['', ''], prin: ['', ''], sec: ['', ''] };
    if (l.type === 'transfer') {
      const from = accCol[l.account] || 'rec';
      const to = accCol[l.account === 'caja' ? 'corriente' : 'caja'];
      cells[from][1] = amt;
      cells[to][0] = amt;
    } else {
      cells[accCol[l.account] || 'rec'][l.type === 'income' ? 0 : 1] = amt;
    }
    return `<tr class="preview-row-new">
      <td>${escAttr(l.date)}</td><td><strong>${escAttr(l.code)}</strong></td><td>${escAttr(l.description)}</td>
      <td class="amt">${cells.rec[0]}</td><td class="amt">${cells.rec[1]}</td>
      <td class="amt">${cells.prin[0]}</td><td class="amt">${cells.prin[1]}</td>
      <td class="amt">${cells.sec[0]}</td><td class="amt">${cells.sec[1]}</td>
    </tr>`;
  }).join('');
  el.innerHTML = `
    <table>
      <thead>
        <tr><th rowspan="2">Fecha</th><th rowspan="2">CT</th><th rowspan="2">Descripción</th>
          <th colspan="2">RECIBIDO</th><th colspan="2">CTA. PRINCIPAL</th><th colspan="2">CTA. SECUNDARIA</th></tr>
        <tr><th class="amt">Ent.</th><th class="amt">Sal.</th><th class="amt">Ent.</th><th class="amt">Sal.</th><th class="amt">Ent.</th><th class="amt">Sal.</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:.35rem;font-size:.6rem;color:var(--text-light)">↑ Así quedará en la Hoja de Cuentas S-26.</p>`;
}

async function registerOcrLines() {
  if (!ocrLines.length) { toast('No hay líneas para registrar', 'error'); return; }
  for (let i = 0; i < ocrLines.length; i++) {
    const l = ocrLines[i];
    if (!l.date) { toast(`Línea ${i + 1}: falta la fecha`, 'error'); return; }
    if (!l.description) { toast(`Línea ${i + 1}: falta la descripción`, 'error'); return; }
    if (!l.code) { toast(`Línea ${i + 1}: seleccione el código CT`, 'error'); return; }
    if (l.amount == null || isNaN(l.amount) || l.amount <= 0) { toast(`Línea ${i + 1}: monto inválido`, 'error'); return; }
  }
  if (ocrTotal != null) {
    const sum = ocrLines.reduce((s, l) => s + (l.amount || 0), 0);
    if (Math.abs(sum - ocrTotal) >= 0.01 &&
      !confirm(`La suma de las líneas ($${sum.toFixed(2)}) no coincide con el TOTAL del recibo ($${ocrTotal.toFixed(2)}). ¿Registrar de todos modos?`)) return;
  }
  try {
    for (const l of ocrLines) {
      const body = {
        date: l.date, description: l.description, code: l.code,
        amount: l.amount, type: l.type, account: l.account
      };
      if (l.type === 'transfer') {
        body.from_account = l.account;
        body.to_account = l.account === 'caja' ? 'corriente' : 'caja';
      }
      await api('/api/transactions', { method: 'POST', body: JSON.stringify(body) });
    }
    toast(`✅ ${ocrLines.length} transacción(es) registrada(s)`);
    loadAccounts();
    loadTransactions();
    document.getElementById('ocrResult').style.display = 'none';
    closeOcrModal();
    renderS26Landing(s26Year, s26Month);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// === FILTERS ===
function setupFilters() {
  document.getElementById('filterBtn').addEventListener('click', () => { currentPage = 0; loadTransactions(); });
  document.getElementById('clearFilterBtn').addEventListener('click', () => {
    document.getElementById('filterAccount').value = '';
    document.getElementById('filterType').value = '';
    document.getElementById('filterCode').value = '';
    currentPage = 0;
    loadTransactions();
  });
}

// === MONTHLY REPORT S-30-S ===
function populateYearMonthSelects() {
  const y = new Date().getFullYear();
  for (const selId of ['reportYear', 'analYear', 'formYear']) {
    const el = document.getElementById(selId);
    el.innerHTML = '';
    for (let i = y; i >= y - 3; i--) {
      el.innerHTML += `<option value="${i}">${i}</option>`;
    }
  }
  const m = String(new Date().getMonth() + 1).padStart(2, '0');
  document.getElementById('reportMonth').value = m;
  document.getElementById('analMonth').value = m;
  document.getElementById('formMonth').value = m;
}

document.getElementById('reportBtn').addEventListener('click', async () => {
  const year = document.getElementById('reportYear').value;
  const month = document.getElementById('reportMonth').value;
  if (!year || !month) { toast('Seleccione año y mes', 'error'); return; }
  try {
    const data = await api(`/api/monthly-report?year=${year}&month=${month}`);
    renderMonthlyReport(data);
  } catch (err) {
    toast(err.message, 'error');
  }
});

function renderMonthlyReport(data) {
  const el = document.getElementById('reportResults');
  const monthNames = { '01':'Enero','02':'Febrero','03':'Marzo','04':'Abril','05':'Mayo','06':'Junio','07':'Julio','08':'Agosto','09':'Septiembre','10':'Octubre','11':'Noviembre','12':'Diciembre' };
  const accLabels = { caja: 'Recibido', corriente: 'Cta. Principal (Caja)', sucursal: 'Cta. Secundaria' };
  const s = data.s30 || {};

  let extraRows = '';
  if (data.reconcileDetails && data.reconcileDetails.length) {
    extraRows = `<div class="report-table" style="margin-top:.5rem">
      <h4 style="color:var(--expense)">Cuentas con error de conciliación:</h4>
      <table><thead><tr><th>Cuenta</th><th>Esperado</th><th>Actual</th><th>Diferencia</th></tr></thead>
        <tbody>${data.reconcileDetails.map(d => `<tr><td>${accLabels[d.account] || d.account}</td><td>$${d.expected.toFixed(2)}</td><td style="color:var(--expense)">$${d.actual.toFixed(2)}</td><td style="color:var(--expense);font-weight:600">$${d.diff.toFixed(2)}</td></tr>`).join('')}</tbody>
      </table>
    </div>`;
  }

  el.innerHTML = `
    <div style="text-align:center;margin-bottom:1rem">
      <h3>INFORME MENSUAL DE LAS CUENTAS DE LA CONGREGACIÓN — S-30-S</h3>
      <p style="color:var(--text-light)">${monthNames[data.month] || data.month} ${data.year}</p>
    </div>

    <div class="reconcile-banner ${data.reconciled ? 'success' : 'error'}">
      ${data.reconciled_msg}
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin:1rem 0">
      <div style="background:var(--bg);border-radius:8px;padding:1rem">
        <h4 style="font-size:.75rem;color:var(--text-light);margin-bottom:.5rem">PÁGINA 1 — INFORME FINANCIERO</h4>
        <table style="font-size:.8rem">
          <tr><td><strong>(a)</strong> Fondos a comienzo de mes</td><td style="text-align:right;font-weight:600">$${(s.a_funds_start || 0).toFixed(2)}</td></tr>
          <tr><td><strong>(b)</strong> Total recibido</td><td style="text-align:right;color:var(--income);font-weight:600">$${(s.b_received || 0).toFixed(2)}</td></tr>
          <tr><td><strong>(c)</strong> Total de gastos</td><td style="text-align:right;color:var(--expense);font-weight:600">$${(s.c_expenses || 0).toFixed(2)}</td></tr>
          <tr><td><strong>(d)</strong> Sobrante (Déficit) [(b)-(c)]</td><td style="text-align:right;font-weight:700">$${(s.d_surplus || 0).toFixed(2)}</td></tr>
          <tr><td><strong>(e)</strong> Fondos a fin de mes [(a)+(d)]</td><td style="text-align:right;font-weight:700;border-top:2px solid var(--text)">$${(s.e_funds_end || 0).toFixed(2)}</td></tr>
          <tr><td><strong>(f)</strong> Fondos reservados</td><td style="text-align:right">$${(s.f_reserved || 0).toFixed(2)}</td></tr>
          <tr><td><strong>(g)</strong> Fondos disponibles [(e)-(f)]</td><td style="text-align:right;font-weight:700">$${(s.g_available || 0).toFixed(2)}</td></tr>
        </table>
      </div>
      <div style="background:var(--bg);border-radius:8px;padding:1rem">
        <h4 style="font-size:.75rem;color:var(--text-light);margin-bottom:.5rem">PÁGINA 2 — CONCILIACIÓN</h4>
        <table style="font-size:.8rem">
          <tr><td><strong>(h)</strong> Total fondos a comienzo de mes</td><td style="text-align:right;font-weight:600">$${(s.h_funds_start_conciliation || 0).toFixed(2)}</td></tr>
          <tr><td><strong>(i)</strong> Recibido</td><td style="text-align:right;color:var(--income);font-weight:600">$${(s.i_received || 0).toFixed(2)}</td></tr>
          <tr><td><strong>(j)</strong> Desembolsos</td><td style="text-align:right;color:var(--expense);font-weight:600">$${(s.j_disbursed || 0).toFixed(2)}</td></tr>
          <tr><td><strong>(k)</strong> Total fondos a fin de mes [(h)+(i)-(j)]</td><td style="text-align:right;font-weight:700;border-top:2px solid var(--text)">$${(s.k_funds_end || 0).toFixed(2)}</td></tr>
        </table>
      </div>
    </div>

    <div class="report-table">
      <h4>Detalle por Cuenta</h4>
      <table>
        <thead><tr><th>Cuenta</th><th>Saldo Anterior</th><th>Ingresos</th><th>Egresos</th><th>Saldo Actual</th><th>Verif</th></tr></thead>
        <tbody>${data.accounts.map(a => {
          const expected = (data.prevBalances[a.id] || 0) + a.income - a.expense;
          const ok = Math.abs(expected - a.balance) < 0.01;
          return `<tr>
            <td><strong>${accLabels[a.id] || a.id}</strong></td>
            <td>$${(data.prevBalances[a.id] || 0).toFixed(2)}</td>
            <td style="color:var(--income)">$${a.income.toFixed(2)}</td>
            <td style="color:var(--expense)">$${a.expense.toFixed(2)}</td>
            <td><strong>$${a.balance.toFixed(2)}</strong></td>
            <td>${ok ? '✅' : '❌'}</td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    </div>

    ${extraRows}

    <div class="report-table" style="margin-top:1rem">
      <h4>Resumen por Código CT</h4>
      <table>
        <thead><tr><th>Código</th><th>Tipo</th><th>Cantidad</th><th>Total</th></tr></thead>
        <tbody>${(data.byCode || []).map(r => `
          <tr><td><strong>${r.code}</strong></td><td>${r.type === 'income' ? 'Entrada' : r.type === 'expense' ? 'Salida' : 'Transferencia'}</td><td>${r.count}</td><td>$${r.total.toFixed(2)}</td></tr>
        `).join('') || '<tr><td colspan="4" style="text-align:center">Sin movimientos</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

// === FORMULARIOS: S-26, S-30, S-25c ===
function showForm(form) {
  currentForm = form;
  document.querySelectorAll('.form-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.form-tab[data-form="${form}"]`).classList.add('active');
  document.getElementById('formMonth').style.display = form === 's25c' ? 'none' : 'inline-block';
  document.getElementById('formQuarter').style.display = form === 's25c' ? 'inline-block' : 'none';
  if (form === 's25c') {
    // Preseleccionar el trimestre que cubre los últimos tres meses completos
    const now = new Date();
    let m = now.getMonth() + 1, y = now.getFullYear();
    m -= 1; if (m === 0) { m = 12; y -= 1; }
    const q = (m >= 9 && m <= 11) ? 1 : (m === 12 || m <= 2) ? 2 : (m <= 5) ? 3 : 4;
    const baseYear = (q === 2 && m <= 2) ? y - 1 : y;
    document.getElementById('formQuarter').value = String(q);
    document.getElementById('formYear').value = String(baseYear);
  }
}

document.getElementById('formGenerateBtn').addEventListener('click', async () => {
  const year = document.getElementById('formYear').value;
  if (!year) { toast('Seleccione año', 'error'); return; }
  try {
    let data;
    if (currentForm === 's26') {
      const month = document.getElementById('formMonth').value;
      data = await api(`/api/forms/s26?year=${year}&month=${month}`);
      renderS26Form(data);
    } else if (currentForm === 's30') {
      const month = document.getElementById('formMonth').value;
      // Abrir el formulario OFICIAL S-30-S (PDF de la carpeta) ya llenado
      window.open(`/api/forms/s30/pdf?year=${year}&month=${month}&token=${authToken}`, '_blank');
      data = await api(`/api/forms/s30?year=${year}&month=${month}`);
      renderS30Form(data);
    } else if (currentForm === 's25c') {
      const quarter = document.getElementById('formQuarter').value;
      data = await api(`/api/forms/s25c?year=${year}&quarter=${quarter}`);
      renderS25cForm(data);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

// --- S-26-S FORM RENDER (official JW format S-26-S 9/25) ---
function renderS26Form(data) {
  const el = document.getElementById('formPrintArea');
  const cfg = data.config || {};
  const cong = cfg.congregacion || '';
  const ciudad = cfg.ciudad || '';
  const prov = cfg.provincia || '';

  const prev = { caja: data.prevBalances?.caja || 0, corriente: data.prevBalances?.corriente || 0, sucursal: data.prevBalances?.sucursal || 0 };
  const colTotals = { caja: { ent: 0, sal: 0 }, corriente: { ent: 0, sal: 0 }, sucursal: { ent: 0, sal: 0 } };

  let txnRows = '';
  let txnRowCount = 0;
  if (data.transactions && data.transactions.length) {
    data.transactions.forEach(t => {
      // Los traspasos (depósitos a la caja de dinero) van en UNA sola
      // línea: SALIDA en la cuenta de origen y ENTRADA en la de destino.
      // La fila 'transfer_in' de la base ya queda representada ahí.
      if (t.type === 'transfer_in') return;

      const cells = { caja: ['', ''], corriente: ['', ''], sucursal: ['', ''] };
      const amt = '$' + t.amount.toFixed(2);

      if (t.type === 'transfer') {
        const from = t.from_account || t.account;
        const to = t.to_account || 'corriente';
        if (cells[from]) { cells[from][1] = amt; colTotals[from].sal += t.amount; }
        if (cells[to]) { cells[to][0] = amt; colTotals[to].ent += t.amount; }
      } else {
        const isPlus = t.type === 'income';
        const acc = cells[t.account] ? t.account : 'caja';
        cells[acc][isPlus ? 0 : 1] = amt;
        colTotals[acc][isPlus ? 'ent' : 'sal'] += t.amount;
      }

      txnRows += `<tr><td>${t.date}</td><td>${escHtml(t.description)}</td><td>${t.code}</td><td class="amt">${cells.caja[0]}</td><td class="amt">${cells.caja[1]}</td><td class="amt">${cells.corriente[0]}</td><td class="amt">${cells.corriente[1]}</td><td class="amt">${cells.sucursal[0]}</td><td class="amt">${cells.sucursal[1]}</td></tr>`;
      txnRowCount++;
    });
  }

  const tc = colTotals;
  const tRecEnt = tc.caja.ent, tRecSal = tc.caja.sal;
  const tPrinEnt = tc.corriente.ent, tPrinSal = tc.corriente.sal;
  const tSecEnt = tc.sucursal.ent, tSecSal = tc.sucursal.sal;
  const endB = data.endBalances || {};
  const endCaja = endB.caja !== undefined ? endB.caja : prev.caja + tRecEnt - tRecSal;
  const endCorriente = endB.corriente !== undefined ? endB.corriente : prev.corriente + tPrinEnt - tPrinSal;
  const endSucursal = endB.sucursal !== undefined ? endB.sucursal : prev.sucursal + tSecEnt - tSecSal;
  const endTotal = endCaja + endCorriente + endSucursal;

  const e = (x) => '$' + x.toFixed(2);
  const fl = '______________';
  const MN_LONG = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const lastDay = new Date(parseInt(data.year), parseInt(data.month), 0).getDate();
  const monthEndLabel = `${lastDay} de ${MN_LONG[parseInt(data.month)]} de ${data.year}`;
  const todayLabel = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });

  // La página 1 del S-26 oficial siempre se llena con filas en blanco
  // después de las transacciones, hasta completar la hoja (el formulario
  // oficial S-26-S tiene 46 renglones en la página 1).
  const PAGE_ROWS = 50;
  const fillerCount = Math.max(0, PAGE_ROWS - txnRowCount);
  const emptyRows = Array(fillerCount).fill('').map(() => '<tr><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>').join('');

  el.innerHTML = `
    <div class="form-s26">
      <!-- ===== PAGE 1 ===== -->
      <div class="s26-page1">
        <h1 class="s26-title">HOJA DE CUENTAS</h1>
        <div class="s26-header-fields">
          <span class="s26-field"><span class="s26-field-label">${escHtml(cong)}</span><span class="s26-field-line"></span><span class="s26-field-sub">(Congregación o evento)</span></span>
          <span class="s26-field"><span class="s26-field-label">${escHtml(ciudad)}</span><span class="s26-field-line"></span><span class="s26-field-sub">(Ciudad)</span></span>
          <span class="s26-field"><span class="s26-field-label">${escHtml(prov)}</span><span class="s26-field-line"></span><span class="s26-field-sub">(Provincia o estado)</span></span>
          <span class="s26-field"><span class="s26-field-label">${data.month ? ['', 'Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'][parseInt(data.month)] + ' ' + data.year : ''}</span><span class="s26-field-line"></span><span class="s26-field-sub">(Para congregación: mes y año;<br>para evento: fecha[s])</span></span>
        </div>
        <table class="s26-table">
          <thead>
            <tr>
              <th class="col-fecha">FECHA</th>
              <th class="col-desc">DESCRIPCIÓN DE LA TRANSACCIÓN</th>
              <th class="col-ct">CT</th>
              <th colspan="2" class="col-rec">RECIBIDO</th>
              <th colspan="2" class="col-prin">CUENTA PRINCIPAL</th>
              <th colspan="2" class="col-sec">CUENTA SECUNDARIA</th>
            </tr>
            <tr>
              <th></th><th></th><th></th>
              <th class="col-sub">ENTRADA</th><th class="col-sub">SALIDA</th>
              <th class="col-sub">ENTRADA</th><th class="col-sub">SALIDA</th>
              <th class="col-sub">ENTRADA</th><th class="col-sub">SALIDA</th>
            </tr>
          </thead>
          <tbody>
            ${txnRows}${emptyRows}
            <tr class="s26-total-row">
              <td colspan="3" class="s26-total-label">TOTALES DE TODAS LAS COLUMNAS ➤</td>
              <td class="amt">${e(tRecEnt)}</td>
              <td class="amt">${e(tRecSal)}</td>
              <td class="amt">${e(tPrinEnt)}</td>
              <td class="amt">${e(tPrinSal)}</td>
              <td class="amt">${e(tSecEnt)}</td>
              <td class="amt">${e(tSecSal)}</td>
            </tr>
          </tbody>
        </table>
        <div class="s26-footer-mark">S-26-S 9/25</div>
      </div>

      <!-- ===== PAGE 2 ===== -->
      <div class="s26-page2 page-break">
        <div class="s26-p2-header">
          <span class="s26-p2-title">HOJA DE CUENTAS</span>
          <span class="s26-p2-pg">Página 2</span>
        </div>

        <!-- CONCILIACIÓN DE LA CUENTA PRINCIPAL (full width, two columns inside) -->
        <div class="s26-recon-full">
          <div class="s26-recon-full-title">CONCILIACIÓN DE LA CUENTA PRINCIPAL</div>
          <div class="s26-recon-full-date">Fecha en la que se completó: ${todayLabel}</div>
          <div class="s26-recon-full-grid">
            <!-- Cuenta Bancaria -->
            <div class="s26-recon-col">
              <div class="s26-recon-col-title">Cuenta Bancaria</div>
              <div class="s26-recon-col-sub">(Utilizar SOLO si se usa una cuenta bancaria<br>o de una entidad similar como cuenta principal).</div>
              <div class="s26-recon-lines">
                <div class="rl"><span class="rl-n">1.</span><span class="rl-t">Saldo final del extracto bancario:</span><span class="rl-v">${fl}</span></div>
                <div class="rl"><span class="rl-n">2.</span><span class="rl-t">Depósitos registrados en la <em>Hoja de cuentas</em> que no aparezcan en el extracto:</span><span class="rl-v">${fl}<sup>+</sup></span></div>
                <div class="rl"><span class="rl-n">3.</span><span class="rl-t">Comisiones bancarias sin registrar en la <em>Hoja de cuentas</em>:</span><span class="rl-v">${fl}<sup>+</sup></span></div>
                <div class="rl rl-bold"><span class="rl-n">4.</span><span class="rl-t">Total de las líneas 1 a 3:</span><span class="rl-v">${fl}</span></div>
              </div>
              <div class="s26-recon-lines" style="margin-top:2px">
                <div class="rl"><span class="rl-n">5.</span><span class="rl-t">Cheques o transferencias electrónicas registradas en la <em>Hoja de cuentas</em> que el banco todavía no haya pagado:</span></div>
              </div>
              <table class="s26-recon-subtbl">
                <thead><tr><th>Cheque o núm. de confirmación</th><th>Cantidad</th></tr></thead>
                <tbody>
                  <tr><td></td><td></td></tr>
                  <tr><td></td><td></td></tr>
                  <tr><td></td><td></td></tr>
                  <tr><td></td><td></td></tr>
                  <tr><td></td><td></td></tr>
                  <tr><td></td><td></td></tr>
                </tbody>
              </table>
              <div class="s26-recon-lines">
                <div class="rl"><span class="rl-n">6.</span><span class="rl-t">Total de los cheques o transferencias electrónicas que el banco todavía no haya pagado (sume las cantidades de la línea 5):</span><span class="rl-v">${fl}<sup>−</sup></span></div>
                <div class="rl"><span class="rl-n">7.</span><span class="rl-t">Intereses bancarios sin registrar en la <em>Hoja de cuentas</em>:</span><span class="rl-v">${fl}<sup>−</sup></span></div>
                <div class="rl"><span class="rl-n">8.</span><span class="rl-t">Donaciones electrónicas sin registrar en la <em>Hoja de cuentas</em>:</span><span class="rl-v">${fl}<sup>−</sup></span></div>
                <div class="rl rl-bold"><span class="rl-n">9.</span><span class="rl-t">Saldo bancario conciliado (reste a la línea 4 las líneas 6 a 8):</span><span class="rl-v"><strong>${fl}</strong></span></div>
              </div>
              <div class="s26-recon-note">(La cantidad de la línea 9 debe coincidir con la cantidad de "Cuenta<br>principal/Saldo final" del recuadro "Resumen de la hoja de cuentas").</div>
            </div>
            <!-- Caja de dinero en efectivo -->
            <div class="s26-recon-col">
              <div class="s26-recon-col-title">Caja de dinero en efectivo</div>
              <div class="s26-recon-col-sub">(Utilizar SOLO si se usa una caja de dinero en efectivo<br>como cuenta principal).</div>
              <div class="s26-recon-lines">
                <div class="rl"><span class="rl-n">1.</span><span class="rl-t">Dinero en efectivo en la caja:</span><span class="rl-v">${e(endCorriente)}</span></div>
                <div class="rl"><span class="rl-n">2.</span><span class="rl-t">Pagos realizados sin registrar en la <em>Hoja de cuentas</em>:</span><span class="rl-v">${fl}<sup>+</sup></span></div>
                <div class="rl"><span class="rl-n">3.</span><span class="rl-t">Adelantos de efectivo sin liquidar:</span><span class="rl-v">${fl}<sup>+</sup></span></div>
                <div class="rl rl-bold"><span class="rl-n">4.</span><span class="rl-t">Saldo de la caja de efectivo conciliado (total de las líneas 1 a 3):</span><span class="rl-v"><strong>${e(endCorriente)}</strong></span></div>
              </div>
              <div class="s26-recon-note">(La cantidad de la línea 4 debe coincidir con la cantidad de "Cuenta<br>principal/Saldo final" del recuadro "Resumen de la hoja de cuentas").</div>
            </div>
          </div>
        </div>

        <!-- BOTTOM: RESUMEN (left) + CONCILIACIÓN CTA SECUNDARIA (right) -->
        <div class="s26-bottom-grid">
          <!-- RESUMEN -->
          <div class="s26-summary-box">
            <div class="s26-summary-title">RESUMEN DE LA HOJA DE CUENTAS</div>
            <div class="s26-summary-date">Para el mes que termina el: ${monthEndLabel}</div>
            <div class="s26-summary-body">
              <div class="s26-sum-section">
                <div class="s26-sum-label">RECIBIDO:</div>
                <div class="s26-sum-row"><span>Saldo anterior</span><span class="s26-sum-blank">${e(prev.caja)}</span></div>
                <div class="s26-sum-row"><span class="s26-sum-indent">ENTRADA</span><span class="s26-sum-blank">${e(tRecEnt)}<sup>+</sup></span></div>
                <div class="s26-sum-row"><span class="s26-sum-indent">SALIDA</span><span class="s26-sum-blank">${e(tRecSal)}<sup>−</sup></span></div>
                <div class="s26-sum-row"><span>Saldo final</span><span class="s26-sum-blank">${e(endCaja)}</span></div>
              </div>
              <div class="s26-sum-section">
                <div class="s26-sum-label">CUENTA PRINCIPAL:</div>
                <div class="s26-sum-row"><span>Saldo anterior</span><span class="s26-sum-blank">${e(prev.corriente)}</span></div>
                <div class="s26-sum-row"><span class="s26-sum-indent">ENTRADA</span><span class="s26-sum-blank">${e(tPrinEnt)}<sup>+</sup></span></div>
                <div class="s26-sum-row"><span class="s26-sum-indent">SALIDA</span><span class="s26-sum-blank">${e(tPrinSal)}<sup>−</sup></span></div>
                <div class="s26-sum-row"><span>Saldo final</span><span class="s26-sum-blank">${e(endCorriente)}</span></div>
              </div>
              <div class="s26-sum-section">
                <div class="s26-sum-label">CUENTA SECUNDARIA:</div>
                <div class="s26-sum-row"><span>Saldo anterior</span><span class="s26-sum-blank">${e(prev.sucursal)}</span></div>
                <div class="s26-sum-row"><span class="s26-sum-indent">ENTRADA</span><span class="s26-sum-blank">${e(tSecEnt)}<sup>+</sup></span></div>
                <div class="s26-sum-row"><span class="s26-sum-indent">SALIDA</span><span class="s26-sum-blank">${e(tSecSal)}<sup>−</sup></span></div>
                <div class="s26-sum-row"><span>Saldo final</span><span class="s26-sum-blank">${e(endSucursal)}</span></div>
              </div>
              <div class="s26-sum-total">TOTAL DE FONDOS<br>AL FINAL DEL MES<span class="s26-sum-blank">${e(endTotal)}</span></div>
            </div>
          </div>
          <!-- CONCILIACIÓN CTA SECUNDARIA -->
          <div class="s26-recon-sec-box">
            <div class="s26-recon-full-title">CONCILIACIÓN DE LA CUENTA SECUNDARIA</div>
            <div class="s26-recon-full-date">Fecha en la que se completó: ${todayLabel}</div>
            <div class="s26-recon-lines">
              <div class="rl"><span class="rl-n">1.</span><span class="rl-t">Saldo del extracto:</span><span class="rl-v">${endSucursal ? e(endSucursal) : fl}</span></div>
              <div class="rl"><span class="rl-n">2.</span><span class="rl-t">Depósitos registrados en la <em>Hoja de cuentas</em> que no aparezcan en el extracto:</span><span class="rl-v">${fl}<sup>+</sup></span></div>
              <div class="rl"><span class="rl-n">3.</span><span class="rl-t">Cargos sin registrar en la <em>Hoja de cuentas</em>:</span><span class="rl-v">${fl}<sup>+</sup></span></div>
              <div class="rl rl-bold"><span class="rl-n">4.</span><span class="rl-t">Total de las filas 1 a 3:</span><span class="rl-v">${endSucursal ? e(endSucursal) : fl}</span></div>
            </div>
            <div class="s26-recon-lines" style="margin-top:2px">
              <div class="rl"><span class="rl-n">5.</span><span class="rl-t">Retiradas que no figuren en el extracto:</span></div>
            </div>
            <table class="s26-recon-subtbl">
              <thead><tr><th>Descripción</th><th>Cantidad</th></tr></thead>
              <tbody>
                <tr><td></td><td></td></tr>
                <tr><td></td><td></td></tr>
                <tr><td></td><td></td></tr>
              </tbody>
            </table>
            <div class="s26-recon-lines">
              <div class="rl"><span class="rl-n">6.</span><span class="rl-t">Total de las retiradas que no aparecen en el extracto (sume las cantidades de la línea 5):</span><span class="rl-v">${fl}<sup>−</sup></span></div>
              <div class="rl"><span class="rl-n">7.</span><span class="rl-t">Intereses sin registrar en la <em>Hoja de cuentas</em>:</span><span class="rl-v">${fl}<sup>−</sup></span></div>
              <div class="rl rl-bold"><span class="rl-n">8.</span><span class="rl-t">Saldo conciliado (reste a la línea 4 las líneas 6 y 7):</span><span class="rl-v"><strong>${endSucursal ? e(endSucursal) : fl}</strong></span></div>
            </div>
            <div class="s26-recon-note">(La cantidad de la línea 8 debe coincidir con la cantidad<br>de "Cuenta secundaria/Saldo final" del recuadro "Resumen<br>de la hoja de cuentas").</div>
          </div>
        </div>
        <div class="s26-footer-mark">S-26-S 9/25</div>
      </div>
    </div>
  `;
}

// --- S-30-S FORM RENDER ---
function renderS30Form(data) {
  const el = document.getElementById('formPrintArea');
  const monthNames = { '01':'Enero','02':'Febrero','03':'Marzo','04':'Abril','05':'Mayo','06':'Junio','07':'Julio','08':'Agosto','09':'Septiembre','10':'Octubre','11':'Noviembre','12':'Diciembre' };
  const mName = monthNames[data.month] || data.month;
  const cfg = data.config || {};
  const cong = cfg.congregacion || '____________________';
  const ciudad = cfg.ciudad || '';
  const prov = cfg.provincia || '';
  const loc = [ciudad, prov].filter(Boolean).join(', ');

  // Build income detail rows
  const incomeRows = (data.b_detail || []).map(r => `<tr><td>${r.code}</td><td>$${r.total.toFixed(2)}</td></tr>`).join('');
  const expenseRows = (data.c_detail || []).map(r => `<tr><td>${r.code}</td><td>$${r.total.toFixed(2)}</td></tr>`).join('');

  // Account breakdown
  const accLabels = { caja: 'Recibido', corriente: 'Cta. Principal (Caja)', sucursal: 'Cta. Secundaria' };
  const accRows = (data.accounts || []).map(a => `<tr><td>${accLabels[a.id] || a.id}</td><td>$${(a.prev || 0).toFixed(2)}</td><td>$${a.income.toFixed(2)}</td><td>$${a.expense.toFixed(2)}</td><td>$${a.balance.toFixed(2)}</td></tr>`).join('');

  el.innerHTML = `
    <div class="form-s30">
      <div class="form-header">
        <h1>INFORME MENSUAL DE LAS CUENTAS DE LA CONGREGACIÓN</h1>
        <h2>S-30-S</h2>
        <div class="sub">TESTIGOS DE JEHOVÁ — Congregación ${escHtml(cong)} ${loc ? '— ' + escHtml(loc) : ''}</div>
      </div>
      <div class="form-id">
        <span><strong>Mes:</strong> ${mName} ${data.year}</span>
        <span><strong>Año de Servicio:</strong> ${data.ym >= data.year + '-09' ? `${data.year}/${parseInt(data.year)+1}` : `${parseInt(data.year)-1}/${data.year}`}</span>
      </div>

      <!-- PAGE 1: INFORME FINANCIERO -->
      <div class="page-label">PÁGINA 1 — INFORME FINANCIERO</div>

      <div class="section-block">
        <div class="block-title">(a) FONDOS A COMIENZO DE MES</div>
        <table><tbody><tr><td>Fondos en todas las cuentas al inicio del mes</td><td>$${(data.a || 0).toFixed(2)}</td></tr></tbody></table>
      </div>

      <div class="section-block">
        <div class="block-title">(b) RECIBIDO POR LA CONGREGACIÓN</div>
        <table>
          <tbody>
            ${incomeRows || '<tr><td>Sin ingresos</td><td>$0.00</td></tr>'}
            <tr class="total-line"><td>TOTAL RECIBIDO</td><td>$${(data.b || 0).toFixed(2)}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="section-block">
        <div class="block-title">(c) GASTOS DE LA CONGREGACIÓN</div>
        <table>
          <tbody>
            ${expenseRows || '<tr><td>Sin gastos</td><td>$0.00</td></tr>'}
            <tr class="total-line"><td>TOTAL DE GASTOS</td><td>$${(data.c || 0).toFixed(2)}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="section-block">
        <div class="block-title">(d) SOBRANTE / DÉFICIT [(b) − (c)]</div>
        <table><tbody><tr><td>Sobrante (déficit) del mes</td><td style="color:${data.d < 0 ? '#e74c3c' : '#000'}">$${(data.d || 0).toFixed(2)}</td></tr></tbody></table>
      </div>

      <div class="section-block">
        <div class="block-title">(e) FONDOS A FIN DE MES [(a) + (d)]</div>
        <table><tbody><tr class="total-line"><td>Total fondos al cierre del mes</td><td>$${(data.e || 0).toFixed(2)}</td></tr></tbody></table>
      </div>

      <div class="section-block">
        <div class="block-title">(f) FONDOS RESERVADOS PARA PROPÓSITOS ESPECIALES</div>
        <table>
          <tbody>
            <tr><td>Contribuciones para Salones del Reino (DK)</td><td>$${(data.box_kingdom || 0).toFixed(2)}</td></tr>
            <tr><td>Otras reservas</td><td>$0.00</td></tr>
            <tr class="total-line"><td>TOTAL RESERVADO</td><td>$${(data.f || 0).toFixed(2)}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="section-block">
        <div class="block-title">(g) FONDOS DISPONIBLES [(e) − (f)]</div>
        <table><tbody><tr class="total-line"><td>Fondos disponibles para la obra</td><td>$${(data.g || 0).toFixed(2)}</td></tr></tbody></table>
      </div>

      <!-- PAGE 2: CONCILIACIÓN -->
      <div class="page-break">
        <div class="page-label">PÁGINA 2 — CONCILIACIÓN</div>

        <div class="section-block">
          <div class="block-title">(h) TOTAL DE FONDOS A COMIENZO DE MES</div>
          <table><tbody><tr><td>Mismo que (a)</td><td>$${(data.h || 0).toFixed(2)}</td></tr></tbody></table>
        </div>

        <div class="section-block">
          <div class="block-title">(i) RECIBIDO</div>
          <table><tbody><tr><td>Total de ingresos del mes</td><td>$${(data.i || 0).toFixed(2)}</td></tr></tbody></table>
        </div>

        <div class="section-block">
          <div class="block-title">(j) DESEMBOLSOS</div>
          <table><tbody><tr><td>Total de gastos del mes</td><td>$${(data.j || 0).toFixed(2)}</td></tr></tbody></table>
        </div>

        <div class="section-block">
          <div class="block-title">(k) TOTAL DE FONDOS A FIN DE MES [(h)+(i)−(j)]</div>
          <table><tbody><tr class="total-line"><td>Debe coincidir con (e)</td><td>$${(data.k || 0).toFixed(2)}</td></tr></tbody></table>
        </div>

        <div class="contribution-boxes">
          <h4>Detalle de Cajas de Contribuciones</h4>
          <table style="border:1px solid #999;width:100%;border-collapse:collapse;font-size:9pt">
            <tr><td style="padding:4px 8px;border:1px solid #999"><strong>Obra Mundial (DO)</strong></td><td style="padding:4px 8px;border:1px solid #999;text-align:right;font-weight:600">$${(data.box_worldwide || 0).toFixed(2)}</td></tr>
            <tr><td style="padding:4px 8px;border:1px solid #999"><strong>Salones del Reino (DK)</strong></td><td style="padding:4px 8px;border:1px solid #999;text-align:right;font-weight:600">$${(data.box_kingdom || 0).toFixed(2)}</td></tr>
          </table>
        </div>

        <div class="section-block" style="margin-top:.75rem">
          <div class="block-title">MOVIMIENTOS POR CUENTA</div>
          <table>
            <thead><tr><th>Cuenta</th><th>Saldo Anterior</th><th>Ingresos</th><th>Egresos</th><th>Saldo Actual</th></tr></thead>
            <tbody>
              ${accRows || '<tr><td colspan="5">Sin cuentas</td></tr>'}
            </tbody>
          </table>
        </div>

        <div class="form-footer">
          <span><strong>Preparado por:</strong> ________________________</span>
          <span><strong>Fecha:</strong> ___/___/${data.year}</span>
        </div>
      </div>
    </div>
  `;
}

// --- S-25c-S AUDIT FORM RENDER (official format S-25c-S 2/26) ---
function renderS25cForm(data) {
  const el = document.getElementById('formPrintArea');
  const cfg = data.config || {};
  const cong = cfg.congregacion || '';
  const ciudad = cfg.ciudad || '';
  const prov = cfg.provincia || '';

  const monthNames = { '01':'Enero','02':'Febrero','03':'Marzo','04':'Abril','05':'Mayo','06':'Junio','07':'Julio','08':'Agosto','09':'Septiembre','10':'Octubre','11':'Noviembre','12':'Diciembre' };
  const months = (data.months || []);
  const mLabels = months.map(m => { const p = m.split('-'); return monthNames[p[1]] + ' ' + p[0]; });

  const fl = '______________';
  const td = 'border:1px solid #999;padding:2px 8px';
  const dataRows = (data.monthData || []).map((m, i) => `
    <tr><td style="${td}">${mLabels[i] || m.ym}</td><td style="${td};text-align:right">$${(m.income || 0).toFixed(2)}</td><td style="${td};text-align:right">$${(m.expense || 0).toFixed(2)}</td></tr>`).join('');

  // Calcular totales de OM (obra mundial) para el trimestre
  const omTotals = (data.monthData || []).map(m => {
    const omIncome = (m.incomeByCode || []).filter(r => r.code === 'OM' || r.code === 'DO').reduce((s, r) => s + r.total, 0);
    const omExpense = (m.expenseByCode || []).filter(r => r.code === 'SOM' || r.code === 'RE' || r.code === 'ROM').reduce((s, r) => s + r.total, 0);
    return { ym: m.ym, omIncome, omExpense };
  });
  const omIncomeTotal = omTotals.reduce((s, o) => s + o.omIncome, 0);
  const omExpenseTotal = omTotals.reduce((s, o) => s + o.omExpense, 0);

  const annex = `
        <div class="s25c-section">
          <div class="s25c-section-title">Datos del sistema para la auditoría</div>
          <table style="border-collapse:collapse;font-size:9pt;margin:.3rem 0">
            <thead><tr><th style="${td}">Mes</th><th style="${td}">Recibido (Entrada)</th><th style="${td}">Desembolsos</th><th style="${td}">Donaciones OM</th><th style="${td}">Remesas OM</th></tr></thead>
            <tbody>${data.monthData.map((m, i) => {
              const omInc = (m.incomeByCode || []).filter(r => r.code === 'OM' || r.code === 'DO').reduce((s, r) => s + r.total, 0);
              const omExp = (m.expenseByCode || []).filter(r => r.code === 'SOM' || r.code === 'RE' || r.code === 'ROM').reduce((s, r) => s + r.total, 0);
              return `<tr><td style="${td}">${mLabels[i] || m.ym}</td><td style="${td};text-align:right">$${(m.income || 0).toFixed(2)}</td><td style="${td};text-align:right">$${(m.expense || 0).toFixed(2)}</td><td style="${td};text-align:right">$${omInc.toFixed(2)}</td><td style="${td};text-align:right">$${omExp.toFixed(2)}</td></tr>`;
            }).join('')}</tbody>
            <tfoot><tr><td style="${td}"><strong>Total del trimestre</strong></td><td style="${td};text-align:right"><strong>$${(data.totalIncome || 0).toFixed(2)}</strong></td><td style="${td};text-align:right"><strong>$${(data.totalExpense || 0).toFixed(2)}</strong></td><td style="${td};text-align:right"><strong>$${omIncomeTotal.toFixed(2)}</strong></td><td style="${td};text-align:right"><strong>$${omExpenseTotal.toFixed(2)}</strong></td></tr></tfoot>
          </table>
          <div style="font-size:8pt">Fondos al inicio del trimestre: <strong>$${(data.fundsAtStart || 0).toFixed(2)}</strong> · Fondos al final del trimestre: <strong>$${(data.fundsAtEnd || 0).toFixed(2)}</strong> <em>(los depósitos a la caja de efectivo no se cuentan como ingreso ni gasto)</em>
          ${Math.abs(data.fundsAtEnd - (data.fundsAtStart + data.totalIncome - data.totalExpense)) < 0.011
            ? '<br><strong style="color:#27ae60">✓ CONCILIACIÓN VERIFICADA: Fondos finales = Fondos iniciales + Ingresos − Gastos</strong>'
            : '<br><strong style="color:#e74c3c">⚠ REVISE: Los fondos finales no cuadran con la fórmula</strong>'}
          </div>
        </div>`;

  // Preparar respuestas auto-calculadas para preguntas del S-25c
  const incomeByMonthStr = (data.monthData || []).map((m, i) =>
    `${mLabels[i] || m.ym}: <strong>$${(m.income || 0).toFixed(2)}</strong>`
  ).join(' · ');

  const ln = () => '_________________________________________________________________________';

  el.innerHTML = `
    <div class="form-s25c">
      <!-- PAGE 1 -->
      <div class="s25c-page1">
        <h1 class="s25c-title">INFORME SOBRE LA AUDITORÍA DE LAS CUENTAS<br>DE LA CONGREGACIÓN</h1>
        <div class="s25c-intro">(Utilice este formulario si la sucursal ha indicado a su congregación que use una caja de dinero en efectivo como
medio principal para gestionar sus fondos. Si la congregación utiliza una cuenta con un banco o una entidad simi-
lar como medio principal para gestionar sus fondos, utilice la versión para cuenta bancaria del <em>Informe sobre la
auditoría de las cuentas de la congregación</em> [S-25b]).</div>

        <div class="s25c-id"><strong>Nombre de la congregación:</strong> <u>&nbsp;${escHtml(cong) || fl + fl}&nbsp;</u></div>
        <div class="s25c-id"><strong>Trimestre auditado:</strong> <u>&nbsp;${mLabels[0] || fl}&nbsp;</u> hasta <u>&nbsp;${mLabels[mLabels.length - 1] || fl}&nbsp;</u>
          <span class="s25c-id-sub">(Mes/Año)</span>
          <span class="s25c-id-sub">(Mes/Año)</span>
          <span><u>&nbsp;${new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' })}&nbsp;</u></span>
          <span class="s25c-id-sub">(Fecha de la auditoría)</span>
        </div>

        <div class="s25c-instructions">Para comenzar la auditoría trimestral, el siervo de cuentas debe suministrar el archivo actual de las cuentas de
la congregación y el archivo de aprobaciones vigentes. El secretario debe suministrar las copias de todas las
donaciones anotadas en los formularios <em>Registro de transacción</em> (S-24) de los meses auditados. Si es posible,
antes de realizarse la auditoría, el siervo de cuentas debe depositar en la caja de dinero en efectivo todas las
donaciones recibidas. El auditor deberá disponer de las <em>Instrucciones para la contabilidad de la
congregación</em> (S-27c) para poder remitirse a ellas. Las discrepancias que se detecten durante la auditoría
deben explicarse en detalle en las secciones de "Comentarios" del informe. El auditor repasará el informe
completado con el secretario y el siervo de cuentas.</div>

        <div class="s25c-section">
          <div class="s25c-section-title">Verificación de las donaciones</div>
          <div class="s25c-q">1. Sume, por mes, las copias de los formularios <em>Registro de transacción</em> (S-24) de las donaciones que le haya
entregado el secretario. Compare el total de cada mes con el total de la columna "Recibido/Entrada" de la
<em>Hoja de cuentas</em> (S-26) del mes correspondiente.<br>
<strong>Datos del sistema para comparar:</strong> ${incomeByMonthStr}<br>
<em>(Compare estas cifras con la suma de los formularios S-24 del secretario. Anote cualquier diferencia abajo.)</em><br>
¿Coinciden los totales? ${fl}</div>
          <div class="s25c-q">2. ¿Se registran todas las donaciones en la <em>Hoja de cuentas</em>? ${fl}</div>
          <div class="s25c-q">3. Para los tres meses, compare cada <em>Registro de transacción</em> de las donaciones con la descripción y el
código de la transacción registrados en la <em>Hoja de cuentas</em>. ¿Se anotan correctamente los códigos de las
entradas? ${fl}</div>
          <div class="s25c-q">4. Compare las fechas y las cantidades de los depósitos en la caja de efectivo de cada <em>Registro de transacción</em>
(S-24) con las fechas de los depósitos y las cantidades en la <em>Hoja de cuentas</em>. ¿Se hacen los depósitos
semanalmente? ${fl}</div>
        </div>
        <div class="s25c-comments"><strong>Comentarios:</strong><br>${ln()}<br>${ln()}<br>${ln()}</div>

        <div class="s25c-section">
          <div class="s25c-section-title">Verificación de los desembolsos</div>
          <div class="s25c-q">1.&nbsp; a. ¿Hay una factura, resolución u otro documento justificativo para todos los pagos anotados en la <em>Hoja
de cuentas</em> (S-26)? ${fl}<br>
<span class="s25c-note">(Marque en la <em>Hoja de cuentas</em> y especifique en "Comentarios" todos los
pagos que no estén respaldados mediante documentos justificativos).</span><br>
&nbsp;&nbsp;&nbsp;b. ¿Aprueba (poniendo sus iniciales) el coordinador del cuerpo de ancianos, u otro anciano asignado en
su ausencia, todas las facturas, los recibos de compra o los formularios <em>Registro de transacción</em> (S-24)?
${fl}<br>
&nbsp;&nbsp;&nbsp;c. ¿Aprueba la congregación mediante resolución los desembolsos de gastos no habituales que superen el
límite aprobado por transacción? ${fl} <span class="s25c-note">(Indique "n/a" si la pregunta no aplica).</span></div>
          <div class="s25c-q">2. ¿Se envían a la sucursal todas las donaciones recogidas para la obra mundial según se indica en el Apéndice
B de las <em>Instrucciones para la contabilidad de la congregación</em> (S-27c)?<br>
<strong>Donaciones OM recibidas: $${omIncomeTotal.toFixed(2)} · Remesas enviadas: $${omExpenseTotal.toFixed(2)}</strong><br>
${fl}</div>
          <div class="s25c-q">3. ¿Se envían a la sucursal las cantidades totales de las donaciones mensuales aprobadas por resolución?
<strong>Total de donaciones OM registradas en el trimestre: $${omIncomeTotal.toFixed(2)}</strong><br>
${fl}<br>
<span class="s25c-note">(Indique "n/a" si las donaciones aprobadas por resolución se han reducido para sufragar los gastos
pendientes [incluidos los costos por proyectos de renovación, mantenimiento o reparación de un Salón del
Reino aprobados por el capacitador de mantenimiento]?</span></div>
          <div class="s25c-q">4. ¿Se abonan lo antes posible todos los cargos de la sucursal? ${fl}<br>
<span class="s25c-note">(Vea el último extracto enviado por la
sucursal. Indique "n/a" si no ha habido cargos).</span></div>
          <div class="s25c-q">5. Compare el <em>Registro de traspaso de fondos</em> (TO-62) de cada mes con el acuse de recibo de donación enviado
por la sucursal.<br>
<strong>Donaciones para obra mundial (OM/DO) registradas:</strong> $${omIncomeTotal.toFixed(2)}<br>
<strong>Remesas a la sucursal (SOM/RE/ROM) registradas:</strong> $${omExpenseTotal.toFixed(2)}<br>
<em>(Compare estas cantidades con los TO-62 y acuses de recibo de la sucursal.)</em><br>
¿Coinciden las cantidades? ${fl}</div>
          <div class="s25c-q">6. ¿Se envían a la sucursal, en concepto de donación para la obra mundial, los fondos que superan el saldo
máximo de la congregación durante varios meses? ${fl} <span class="s25c-note">(Indique "n/a" si la pregunta no aplica).</span></div>
        </div>
        <div class="s25c-comments"><strong>Comentarios:</strong><br>${ln()}<br>${ln()}<br>${ln()}</div>

        ${annex}
        <div class="s25c-footer-page">S-25c-S&nbsp;&nbsp;2/26</div>
      </div>

      <!-- PAGE 2 -->
      <div class="s25c-page2 page-break">
        <div class="s25c-section">
          <div class="s25c-section-title">Verificación de la cuenta principal</div>
          <div class="s25c-q">1. En la página 2 de la <em>Hoja de cuentas</em> (S-26) de cada mes, ¿coincide el saldo de la caja de efectivo conciliado
de la línea 4 del recuadro "Conciliación de la cuenta principal" con la cantidad de "Cuenta principal/Saldo
final" del recuadro "Resumen de la hoja de cuentas"?<br>
<strong>Verificación del sistema:</strong> Fondos al final del trimestre = <strong>$${(data.fundsAtEnd || 0).toFixed(2)}</strong><br>
<em>(El sistema verifica automáticamente que Fondos finales = Fondos iniciales + Ingresos − Gastos. Las cuentas concilian si el saldo del sistema coincide con el conteo físico de la caja.)</em><br>
${fl}</div>
          <div class="s25c-q">2. ¿Hay un <em>Registro de transacción</em> (S-24) de pago debidamente cumplimentado por cada pago registrado en la
<em>Hoja de cuentas</em>? ${fl}</div>
          <div class="s25c-q">3. ¿Han aprobado el coordinador del cuerpo de ancianos y el secretario los ajustes necesarios para resolver
discrepancias? ${fl} <span class="s25c-note">(Indique "n/a" si la pregunta no aplica).</span></div>
        </div>
        <div class="s25c-comments"><strong>Comentarios:</strong><br>${ln()}<br>${ln()}<br>${ln()}</div>

        <div class="s25c-section">
          <div class="s25c-section-title">Verificación de la cuenta secundaria</div>
          <div class="s25c-section-sub">(Complete esta sección solo si la congregación tiene otra cuenta).</div>
          <div class="s25c-q">1. En la página 2 de la <em>Hoja de cuentas</em> (S-26) de cada mes, ¿coincide el saldo conciliado de la línea 8 de
la "Conciliación de la cuenta secundaria" con la cantidad "Cuenta secundaria/Saldo final" del recuadro
"Resumen de la hoja de cuentas"?<br>
<strong>Fondos al final del trimestre: $${(data.fundsAtEnd || 0).toFixed(2)}</strong><br>
${fl}</div>
          <div class="s25c-q">2. ¿Se aprueban adecuadamente los traspasos de la cuenta secundaria? ${fl}</div>
          <div class="s25c-q">3. ¿Han aprobado el coordinador del cuerpo de ancianos y el secretario los ajustes necesarios para resolver
discrepancias? ${fl} <span class="s25c-note">(Indique "n/a" si la pregunta no aplica).</span></div>
        </div>
        <div class="s25c-comments"><strong>Comentarios:</strong><br>${ln()}<br>${ln()}<br>${ln()}</div>

        <div class="s25c-section">
          <div class="s25c-section-title">Repaso de los procedimientos generales</div>
          <div class="s25c-q">1. ¿Se están siguiendo las instrucciones para la contabilidad de la congregación? ${fl}</div>
          <div class="s25c-q">2. ¿Son exactos los registros? ¿Están ordenados? ${fl}</div>
          <div class="s25c-q">3. ¿Están al día los registros? ${fl}</div>
          <div class="s25c-q">4. ¿Son exactos los informes mensuales de las cuentas de la congregación? (Compruebe un mes). ${fl}</div>
          <div class="s25c-q">5. ¿Hay en el archivo de aprobaciones vigentes una anotación con el saldo máximo aprobado? ${fl}</div>
        </div>
        <div class="s25c-comments"><strong>Comentarios:</strong><br>${ln()}<br>${ln()}<br>${ln()}<br>${ln()}<br>${ln()}</div>

        <div class="s25c-sigs">
          <div class="s25c-sig"><strong>Auditoría realizada por:</strong> ${fl}${fl}${fl}</div>
          <div class="s25c-sig"><strong>Revisada por:</strong> ${fl}${fl}${fl}<br><span class="s25c-sig-sub">(Secretario)</span></div>
        </div>
        <div class="s25c-footer-page">S-25c-S&nbsp;&nbsp;2/26&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;2</div>
      </div>
    </div>
  `;
}

// === CHART ===
document.getElementById('chartBtn').addEventListener('click', async () => {
  const sy = document.getElementById('chartSySelect').value;
  if (!sy) return;
  const data = await api(`/api/service-year-summary?sy=${encodeURIComponent(sy)}`);
  renderChart(data);
});
document.getElementById('chartBtn').click();

function renderChart(data) {
  const canvas = document.getElementById('ieChart');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = 350 * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width, H = 350;
  ctx.clearRect(0, 0, W, H);

  const months = data.months;
  const margin = { top: 25, bottom: 45, left: 55, right: 20 };
  const chartW = W - margin.left - margin.right;
  const chartH = H - margin.top - margin.bottom;

  let maxVal = 0;
  for (const m of months) {
    if (m.income > maxVal) maxVal = m.income;
    if (m.expense > maxVal) maxVal = m.expense;
  }
  maxVal = Math.ceil(maxVal * 1.15) || 100;

  const barW = Math.min(chartW / months.length * 0.35, 20);
  const gap = chartW / months.length;

  ctx.font = '11px sans-serif';
  ctx.fillStyle = '#7f8c8d';

  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const val = (maxVal / steps) * i;
    const y = margin.top + chartH - (val / maxVal) * chartH;
    ctx.fillStyle = '#d5d8dc';
    ctx.fillRect(margin.left, y, chartW, 1);
    ctx.fillStyle = '#7f8c8d';
    ctx.textAlign = 'right';
    ctx.fillText('$' + val.toFixed(0), margin.left - 5, y + 4);
  }
  ctx.fillStyle = '#2c3e50';
  ctx.textAlign = 'center';
  months.forEach((m, i) => {
    const x = margin.left + i * gap + gap / 2;
    ctx.fillText(m.month, x, H - margin.bottom + 18);
  });

  months.forEach((m, i) => {
    const cx = margin.left + i * gap + gap / 2;
    const incH = (m.income / maxVal) * chartH;
    const expH = (m.expense / maxVal) * chartH;

    ctx.fillStyle = '#27ae60';
    ctx.fillRect(cx - barW, margin.top + chartH - incH, barW, incH);

    ctx.fillStyle = '#e74c3c';
    ctx.fillRect(cx, margin.top + chartH - expH, barW, expH);
  });

  ctx.fillStyle = '#27ae60';
  ctx.fillRect(margin.left, 8, 12, 12);
  ctx.fillStyle = '#2c3e50';
  ctx.textAlign = 'left';
  ctx.fillText('Ingresos', margin.left + 16, 18);

  ctx.fillStyle = '#e74c3c';
  ctx.fillRect(margin.left + 90, 8, 12, 12);
  ctx.fillStyle = '#2c3e50';
  ctx.fillText('Egresos', margin.left + 106, 18);

  ctx.fillStyle = '#7f8c8d';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Año de Servicio ' + data.service_year, W / 2, H - 4);

  document.getElementById('chartTable').innerHTML = `
    <div class="report-table">
      <table>
        <thead><tr><th>Mes</th><th>Ingresos</th><th>Egresos</th><th>Diferencia</th></tr></thead>
        <tbody>${months.map(m => {
          const diff = m.income - m.expense;
          return `<tr><td><strong>${m.month}</strong> <small>${m.ym}</small></td>
            <td style="color:var(--income)">$${m.income.toFixed(2)}</td>
            <td style="color:var(--expense)">$${m.expense.toFixed(2)}</td>
            <td style="color:${diff >= 0 ? 'var(--income)' : 'var(--expense)'};font-weight:600">$${diff.toFixed(2)}</td></tr>`;
        }).join('')}
        </tbody>
      </table>
    </div>
  `;

  const onResize = () => {
    const r = canvas.getBoundingClientRect();
    canvas.width = r.width * dpr;
    canvas.height = 350 * dpr;
    ctx.scale(dpr, dpr);
    renderChart(data);
  };
  window.removeEventListener('resize', onResize);
  window.addEventListener('resize', onResize);
}

// === ANALYSIS ===
document.getElementById('analBtn').addEventListener('click', async () => {
  const year = document.getElementById('analYear').value;
  const month = document.getElementById('analMonth').value;
  if (!year || !month) { toast('Seleccione año y mes', 'error'); return; }
  try {
    const data = await api(`/api/reconcile?year=${year}&month=${month}`);
    renderAnalysis(data);
  } catch (err) {
    toast(err.message, 'error');
  }
});

function renderAnalysis(data) {
  const msg = document.getElementById('analMsg');
  const details = document.getElementById('analDetails');
  const monthNames = { '01':'Enero','02':'Febrero','03':'Marzo','04':'Abril','05':'Mayo','06':'Junio','07':'Julio','08':'Agosto','09':'Septiembre','10':'Octubre','11':'Noviembre','12':'Diciembre' };
  const accLabels = { caja: 'Recibido', corriente: 'Cuenta Principal (Caja)', sucursal: 'Cuenta Secundaria' };

  if (data.reconciled) {
    msg.className = 'anal-msg success';
    msg.innerHTML = `✅ ${monthNames[data.month]} ${data.year} — SALDOS CONCILIADOS / LA CONTABILIDAD CERRÓ EXCELENTE`;
    details.innerHTML = `<div class="report-grid">
      <div class="report-card income-card"><h4>Ingresos</h4><div class="value" style="color:var(--income)">$${data.income.toFixed(2)}</div></div>
      <div class="report-card expense-card"><h4>Egresos</h4><div class="value" style="color:var(--expense)">$${data.expense.toFixed(2)}</div></div>
      <div class="report-card diff-card"><h4>Diferencia</h4><div class="value">$${data.difference.toFixed(2)}</div></div>
    </div>
    <p style="color:var(--success);font-weight:600;text-align:center">✔ Todas las cuentas concilian correctamente.</p>`;
  } else {
    msg.className = 'anal-msg error';
    msg.innerHTML = `❌ ${monthNames[data.month]} ${data.year} — ERROR DE CONCILIACIÓN. Revise los asientos contables.`;
    let detHtml = `<div class="report-grid">
      <div class="report-card income-card"><h4>Ingresos</h4><div class="value" style="color:var(--income)">$${data.income.toFixed(2)}</div></div>
      <div class="report-card expense-card"><h4>Egresos</h4><div class="value" style="color:var(--expense)">$${data.expense.toFixed(2)}</div></div>
      <div class="report-card diff-card"><h4>Diferencia</h4><div class="value">$${data.difference.toFixed(2)}</div></div>
    </div>`;
    if (data.details && data.details.length) {
      detHtml += `<div class="report-table"><h4>Cuentas con error:</h4><table><thead><tr><th>Cuenta</th><th>Saldo Anterior</th><th>Esperado</th><th>Actual</th></tr></thead><tbody>`;
      for (const d of data.details) {
        detHtml += `<tr><td>${accLabels[d.account] || d.account}</td><td>$${d.prevBal.toFixed(2)}</td><td>$${d.expected.toFixed(2)}</td><td style="color:var(--expense);font-weight:600">$${d.actual.toFixed(2)}</td></tr>`;
      }
      detHtml += `</tbody></table></div>`;
    } else {
      detHtml += `<p style="color:var(--expense);font-weight:600">⚠ Los totales de ingresos y egresos no coinciden. Revise que cada transferencia tenga su contraparte.</p>`;
    }
    details.innerHTML = detHtml;
  }
}

// === SALDO INICIAL EDITING ===
function s26EditSaldoInicial(year, month) {
  window._editingSaldoInicial = `${year}-${month}`;
  renderS26Landing(year, month);
}
function s26CancelSaldoInicial() {
  window._editingSaldoInicial = null;
  renderS26Landing(s26Year, s26Month);
}
async function s26SaveSaldoInicial(year, month) {
  const val = document.getElementById('s26e-saldo')?.value;
  if (val === undefined) return;
  const amount = parseFloat(val);
  if (isNaN(amount) || amount < 0) { toast('Ingrese un saldo inicial válido', 'error'); return; }
  try {
    await api('/api/saldo-inicial', {
      method: 'POST',
      body: JSON.stringify({ year, month: String(month).padStart(2,'0'), amount })
    });
    window._editingSaldoInicial = null;
    toast('Saldo inicial actualizado');
    renderS26Landing(year, month);
  } catch (err) {
    toast(err.message, 'error');
  }
}
async function s26ClearSaldoInicial(year, month) {
  if (!confirm('¿Restaurar el saldo inicial calculado automáticamente?')) return;
  try {
    await api('/api/saldo-inicial', {
      method: 'POST',
      body: JSON.stringify({ year, month: String(month).padStart(2,'0'), amount: null })
    });
    window._editingSaldoInicial = null;
    toast('Saldo inicial restaurado al cálculo automático');
    renderS26Landing(year, month);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// === CIERRE DE FIN DE MES ===
async function doCierreMes() {
  // Paso 1: Seleccionar mes
  const ySel = s26Year;
  const mSel = s26Month;
  const ym = await new Promise(resolve => {
    const div = document.createElement('div');
    div.className = 'modal-dialog';
    div.innerHTML = `<div class="modal-dialog-box">
      <h4>📆 Seleccionar mes de cierre</h4>
      <p>Elija el año y mes para generar/corregir el cierre:</p>
      <div style="display:flex;gap:.5rem;margin-bottom:.5rem">
        <div class="form-group" style="flex:1"><label>Año</label>
          <select id="cierreYear">${[ySel-1, ySel, ySel+1].map(y => `<option value="${y}"${y===ySel?' selected':''}>${y}</option>`).join('')}</select>
        </div>
        <div class="form-group" style="flex:1"><label>Mes</label>
          <select id="cierreMonth">${['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'].map((n,i) => `<option value="${i+1}"${i+1===mSel?' selected':''}>${n}</option>`).join('')}</select>
        </div>
      </div>
      <div class="modal-dialog-acts">
        <button class="btn btn-secondary" id="ymCancel">Cancelar</button>
        <button class="btn btn-primary" id="ymOk">Continuar</button>
      </div>
    </div>`;
    document.body.appendChild(div);
    div.querySelector('#ymOk').onclick = () => {
      const y = parseInt(div.querySelector('#cierreYear').value);
      const m = parseInt(div.querySelector('#cierreMonth').value);
      div.remove();
      resolve({ y, m });
    };
    div.querySelector('#ymCancel').onclick = () => { div.remove(); resolve(null); };
  });
  if (!ym) return;
  const { y, m } = ym;

  const monthName = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'][m-1];
  const lastDay = new Date(y, m, 0).getDate();
  const dateStr = `${y}-${String(m).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

  // Paso 2: Obtener publisher count
  let pubs = null;
  try { const cfg = await api('/api/config'); if (cfg.publishers) pubs = parseInt(cfg.publishers); } catch (_) {}
  pubs = await new Promise(resolve => {
    const div = document.createElement('div');
    div.className = 'modal-dialog';
    div.innerHTML = `<div class="modal-dialog-box">
      <h4>📆 Publicadores del mes</h4>
      <p>Ingrese el número de publicadores para ${monthName} ${y}:</p>
      <div class="form-group"><input type="number" id="pubsInput" value="${pubs || 70}" min="1" style="font-size:1.1rem;text-align:center;font-weight:700"></div>
      <div style="display:flex;gap:.35rem;margin-top:.5rem">
        <label style="font-size:.72rem;display:flex;align-items:center;gap:.3rem;color:var(--text-light)">
          <input type="checkbox" id="savePubsCheck" checked> Guardar para próximo mes
        </label>
      </div>
      <div class="modal-dialog-acts" style="margin-top:.75rem">
        <button class="btn btn-secondary" id="pubsCancel">Cancelar</button>
        <button class="btn btn-primary" id="pubsOk">Continuar</button>
      </div>
    </div>`;
    document.body.appendChild(div);
    const input = div.querySelector('#pubsInput'); input.focus(); input.select();
    div.querySelector('#pubsOk').onclick = () => {
      const val = parseInt(input.value);
      if (!val || val < 1) return;
      if (div.querySelector('#savePubsCheck').checked)
        api('/api/config', { method: 'POST', body: JSON.stringify({ publishers: String(val) }) }).catch(() => {});
      div.remove(); resolve(val);
    };
    div.querySelector('#pubsCancel').onclick = () => { div.remove(); resolve(null); };
    input.onkeydown = e => { if (e.key === 'Enter') div.querySelector('#pubsOk').click(); };
  });
  if (!pubs) return;

  // Paso 3: Previsualización
  const data = await api(`/api/s26-data?year=${y}&month=${String(m).padStart(2,'0')}`);
  const omSum = data.transactions.filter(t => t.code === 'OM' && t.type === 'income').reduce((s,t) => s + t.amount, 0);
  const cSum = data.transactions.filter(t => t.code === 'C' && t.type === 'income').reduce((s,t) => s + t.amount, 0);
  const items = [
    { label: 'OM → RE (envío a Betel)', value: omSum },
    { label: `30 × ${pubs} pubs. (ROM)`, value: 30 * pubs },
    { label: `10% de donaciones C (ROM)`, value: Math.round(cSum * 0.1) },
    { label: `Mantenimiento (${monthName} ${y})`, value: 1250 },
  ];
  const total = items.reduce((s,i) => s + i.value, 0);

  // Detectar si hay cierre previo (para cambiar copy)
  const existing = await api(`/api/transactions?limit=1&startDate=${dateStr}&endDate=${dateStr}&code=GM`);
  const isCorrection = existing.transactions && existing.transactions.length > 0;
  const title = isCorrection ? '🔄 Corregir cierre' : '📆 Nuevo cierre';
  const verb = isCorrection ? 'se corregirán' : 'se generarán';

  const confirmed = total === 1250 && omSum === 0 && cSum === 0
    ? confirm(`📆 Cierre de ${monthName} ${y}\n\nEste mes no tiene ingresos con código OM ni C.\nSolo se ${verb} el gasto de Mantenimiento por $1,250.00.\n\n¿Continuar?`)
    : await new Promise(resolve => {
        const div = document.createElement('div');
        div.className = 'cierre-modal';
        div.innerHTML = `<div class="cierre-modal-box">
          <h3>${title} — ${monthName} ${y}</h3>
          <p>${isCorrection ? 'Las donaciones cambiaron. Los montos se recalcularán y corregirán:' : `${verb} los siguientes gastos el ${dateStr}:`}</p>
          <div class="cierre-modal-summary">
            ${items.map(it => `<div class="item"><span class="label">${it.label}</span><span class="value">$${it.value.toFixed(2)}</span></div>`).join('')}
            <div class="item" style="font-weight:700;border-top:2px solid var(--primary);padding-top:.4rem;margin-top:.2rem">
              <span class="label">TOTAL GASTOS</span><span class="value">$${total.toFixed(2)}</span>
            </div>
          </div>
          <div class="cierre-modal-acts">
            <button class="btn btn-secondary" id="cierreCancel">Cancelar</button>
            <button class="btn btn-cierre" id="cierreOk">${isCorrection ? '🔄 Corregir' : '✅ Confirmar y Ejecutar'}</button>
          </div>
        </div>`;
        document.body.appendChild(div);
        div.querySelector('#cierreOk').onclick = () => { div.remove(); resolve(true); };
        div.querySelector('#cierreCancel').onclick = () => { div.remove(); resolve(false); };
      });
  if (!confirmed) return;

  try {
    await api('/api/cierre-mes', {
      method: 'POST',
      body: JSON.stringify({ year: y, month: String(m).padStart(2,'0'), publishers: pubs })
    });
    toast(isCorrection ? '✅ Cierre corregido exitosamente' : '✅ Cierre de mes generado correctamente');
    renderS26Landing(y, m);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// === SYNC STATUS ===
async function checkSyncStatus() {
  try {
    const status = await api('/api/sync-status');
    updateSyncUI(status);
  } catch (_) {
    updateSyncUI({ dirty: false, vercel: false });
  }
}

async function forceSync() {
  const btn = document.getElementById('syncBtn');
  const icon = document.getElementById('syncIcon');
  const label = document.getElementById('syncLabel');
  btn.classList.add('syncing');
  icon.textContent = '⏳';
  label.textContent = 'Sincronizando…';
  try {
    const result = await api('/api/sync-now', { method: 'POST' });
    updateSyncUI({ dirty: false, lastSync: result.syncedAt });
    toast('Datos sincronizados con la nube');
  } catch (err) {
    toast('Error de sincronización: ' + err.message, 'error');
    updateSyncUI({ dirty: true });
  } finally {
    btn.classList.remove('syncing');
  }
}

function updateSyncUI(status) {
  const btn = document.getElementById('syncBtn');
  const icon = document.getElementById('syncIcon');
  const label = document.getElementById('syncLabel');
  if (status.dirty) {
    btn.className = 'sync-btn error';
    icon.textContent = '⚠️';
    label.textContent = 'Sin sincronizar';
  } else {
    btn.className = 'sync-btn ok';
    icon.textContent = '☁️';
    const last = status.lastSync ? new Date(status.lastSync).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '';
    label.textContent = last ? `Sincronizado ${last}` : 'Sincronizado';
  }
}

function setupSyncButton() {
  document.getElementById('syncBtn').addEventListener('click', forceSync);
}

// === AUTH ===
let authToken = localStorage.getItem('authToken') || null;
let authUser = null;

async function checkAuth() {
  if (!authToken) {
    updateAuthUI();
    blockApp();
    return;
  }
  try {
    const data = await api('/api/auth/verify', { headers: { 'Authorization': 'Bearer ' + authToken } });
    if (data.authenticated) {
      authUser = { username: data.username, role: data.role };
      updateAuthUI();
    } else {
      authToken = null;
      localStorage.removeItem('authToken');
      authUser = null;
      updateAuthUI();
      blockApp();
    }
  } catch (_) {
    authUser = null;
    updateAuthUI();
  }
}

function blockApp() {
  const overlay = document.getElementById('loginOverlay');
  if (overlay) overlay.style.display = 'flex';
  document.getElementById('loginModal').showModal();
}

function unblockApp() {
  const overlay = document.getElementById('loginOverlay');
  if (overlay) overlay.style.display = 'none';
}

function updateAuthUI() {
  const loginBtn = document.getElementById('loginBtn');
  const userBadge = document.getElementById('userBadge');
  const adminCard = document.getElementById('adminMenuCard');
  if (authUser) {
    loginBtn.textContent = '🔒 Cerrar Sesión';
    loginBtn.onclick = doLogout;
    userBadge.style.display = 'inline';
    userBadge.textContent = authUser.username;
    adminCard.style.display = authUser.role === 'admin' ? 'inline-block' : 'none';
  } else {
    loginBtn.textContent = '🔐 Iniciar Sesión';
    loginBtn.onclick = showLogin;
    userBadge.style.display = 'none';
    adminCard.style.display = 'none';
  }
}

function showLogin() {
  document.getElementById('loginUsername').value = '';
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginError').style.display = 'none';
  document.getElementById('loginOverlay').style.display = 'flex';
  setTimeout(() => document.getElementById('loginUsername').focus(), 100);
}

function closeLogin() {
  document.getElementById('loginOverlay').style.display = 'none';
}

// Permitir Enter en inputs del login
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.getElementById('loginOverlay').style.display === 'flex') {
    doLogin();
  }
});

async function doLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  if (!username || !password) { errEl.textContent = 'Complete todos los campos'; errEl.style.display = 'block'; return; }
  try {
    document.getElementById('loginSubmitBtn').disabled = true;
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    authToken = data.token;
    localStorage.setItem('authToken', authToken);
    authUser = { username: data.username, role: data.role };
    closeLogin();
    unblockApp();
    updateAuthUI();
    // Recargar datos ahora que hay sesión
    await Promise.all([
      loadConfig(),
      loadAccounts(),
      loadCodes(),
      loadTransactions(),
    ]);
    populateServiceYearSelect();
    renderS26Landing(s26Year, s26Month);
    renderCodes();
    toast('Bienvenido, ' + authUser.username);
  } catch (err) {
    errEl.textContent = err.message === 'Usuario o contraseña incorrectos' ? err.message : 'Error de conexión';
    errEl.style.display = 'block';
  } finally {
    document.getElementById('loginSubmitBtn').disabled = false;
  }
}

async function doLogout() {
  try { await api('/api/auth/logout', { headers: { 'Authorization': 'Bearer ' + authToken } }); } catch (_) {}
  authToken = null;
  localStorage.removeItem('authToken');
  authUser = null;
  updateAuthUI();
  blockApp();
  toast('Sesión cerrada');
}

// === ADMIN: USER MANAGEMENT ===
async function adminLoadUsers() {
  try {
    const data = await api('/api/users', { headers: { 'Authorization': 'Bearer ' + authToken } });
    const tbody = document.getElementById('adminUsersBody');
    tbody.innerHTML = data.users.map(u => `
      <tr>
        <td>${u.id}</td>
        <td><strong>${escHtml(u.username)}</strong></td>
        <td>${u.role === 'admin' ? 'Administrador' : 'Usuario'}</td>
        <td>${u.created_at || '-'}</td>
        <td>
          <button class="btn btn-xs btn-secondary" onclick="adminShowReset('${escHtml(u.username)}')">🔑 Reset</button>
          ${u.role !== 'admin' || data.users.filter(x => x.role === 'admin').length > 1 ? `<button class="btn btn-xs" style="background:var(--expense);color:#fff" onclick="adminDeleteUser(${u.id},'${escHtml(u.username)}')">🗑 Eliminar</button>` : ''}
        </td>
      </tr>
    `).join('');
  } catch (err) { toast('Error al cargar usuarios: ' + err.message, 'error'); }
}

async function adminAddUser() {
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newPassword').value;
  const role = document.getElementById('newRole').value;
  if (!username || !password) { toast('Complete todos los campos', 'error'); return; }
  if (password.length < 4) { toast('La contraseña debe tener al menos 4 caracteres', 'error'); return; }
  try {
    await api('/api/users', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role })
    });
    document.getElementById('newUsername').value = '';
    document.getElementById('newPassword').value = '';
    toast('Usuario ' + username + ' creado');
    adminLoadUsers();
  } catch (err) { toast(err.message, 'error'); }
}

function adminShowReset(username) {
  document.getElementById('resetUsername').value = username;
  document.getElementById('resetPassword').value = '';
  document.getElementById('adminResetSection').style.display = 'block';
}

function adminCancelReset() {
  document.getElementById('adminResetSection').style.display = 'none';
}

async function adminResetPassword() {
  const username = document.getElementById('resetUsername').value;
  const newPassword = document.getElementById('resetPassword').value;
  if (!newPassword || newPassword.length < 4) { toast('La contraseña debe tener al menos 4 caracteres', 'error'); return; }
  try {
    await api('/api/users/reset-password', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, newPassword })
    });
    toast('Contraseña restablecida para ' + username);
    adminCancelReset();
  } catch (err) { toast(err.message, 'error'); }
}

async function adminDeleteUser(id, username) {
  if (!confirm('¿Eliminar al usuario "' + username + '"?')) return;
  try {
    await api('/api/users/' + id, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + authToken }
    });
    toast('Usuario ' + username + ' eliminado');
    adminLoadUsers();
  } catch (err) { toast(err.message, 'error'); }
}

// === SETUP ALL ===
function setupAll() {
  setupForm();
  setupUpload();
  setupAiWarnModal();
  setupFilters();
}
