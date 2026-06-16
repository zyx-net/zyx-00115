let currentUser = null;
let coursesCache = [];
let classesCache = [];
let equipmentCache = [];
let selectedSettlementIds = new Set();

const STATUS_MAP = {
  pending: '待审批', approved: '已审批', collected: '已领用',
  partially_returned: '部分归还', returned: '已归还', cancelled: '已取消'
};
const STATUS_CLASS = {
  pending: 'status-pending', approved: 'status-approved', collected: 'status-collected',
  partially_returned: 'status-partial', returned: 'status-returned', cancelled: 'status-cancelled'
};
const LOSS_STATUS_MAP = { pending: '待审批', approved: '已审批', rejected: '已驳回' };
const LOSS_STATUS_CLASS = { pending: 'status-pending', approved: 'status-approved', rejected: 'status-rejected' };
const ROLE_MAP = { admin: '管理员', teacher: '教师', lab_manager: '实验员' };

async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include' };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

function toast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => { t.classList.add('toast-fade'); setTimeout(() => t.remove(), 400); }, 3000);
}

function showModal(title, bodyHtml) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  document.getElementById('modal-overlay').style.display = 'flex';
}

function closeModal() {
  document.getElementById('modal-overlay').style.display = 'none';
}

function switchPage(pageName) {
  document.querySelectorAll('.content-page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  const page = document.getElementById('page-' + pageName);
  if (page) page.classList.add('active');
  const link = document.querySelector(`.nav-link[data-page="${pageName}"]`);
  if (link) link.classList.add('active');
  loadPage(pageName);
}

async function loadPage(name) {
  try {
    if (name === 'dashboard') await loadDashboard();
    else if (name === 'equipment') await loadEquipment();
    else if (name === 'reservations') await loadReservations();
    else if (name === 'loss-reports') await loadLossReports();
    else if (name === 'settlements') await loadSettlements();
    else if (name === 'logs') await loadLogs();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function loadDashboard() {
  const d = await api('GET', '/api/dashboard');
  const sg = document.getElementById('dashboard-stats');
  sg.innerHTML = `
    <div class="stat-card"><div class="stat-value">${d.equipment.length}</div><div class="stat-label">器材种类</div></div>
    <div class="stat-card"><div class="stat-value">${d.equipment.reduce((s,e) => s+e.total_qty, 0)}</div><div class="stat-label">库存总量</div></div>
    <div class="stat-card"><div class="stat-value">${d.pending_returns}</div><div class="stat-label">待归还</div></div>
    <div class="stat-card"><div class="stat-value">${d.current_week}</div><div class="stat-label">当前周</div></div>
  `;
  const eq = document.getElementById('dashboard-equipment');
  eq.innerHTML = '<h3>器材库存概览</h3>' + renderEqTable(d.equipment);
  const pd = document.getElementById('dashboard-pending');
  if (d.latest_settlement) {
    pd.innerHTML = `<h3>最近结转</h3><p>周次: ${d.latest_settlement.week_key} | 时间: ${new Date(d.latest_settlement.settled_at).toLocaleString()}</p>`;
  } else {
    pd.innerHTML = '<h3>最近结转</h3><p>暂无结转记录</p>';
  }
}

async function loadEquipment() {
  const list = await api('GET', '/api/equipment');
  equipmentCache = list;
  document.getElementById('equipment-table').innerHTML = renderEqTable(list);
}

function renderEqTable(list) {
  let h = '<table class="data-table"><thead><tr><th>ID</th><th>名称</th><th>总量</th><th>可用</th><th>锁定</th></tr></thead><tbody>';
  list.forEach(e => {
    const remaining = e.available_qty;
    const warn = remaining <= 0 ? ' class="text-danger"' : (remaining <= 2 ? ' class="text-warning"' : '');
    h += `<tr${warn}><td>${e.id}</td><td>${e.name}</td><td>${e.total_qty}</td><td>${e.available_qty}</td><td>${e.locked_qty}</td></tr>`;
  });
  h += '</tbody></table>';
  return h;
}

async function loadReservations() {
  const [reservations, courses, classes, equipment] = await Promise.all([
    api('GET', '/api/reservations'),
    api('GET', '/api/courses'),
    api('GET', '/api/classes'),
    api('GET', '/api/equipment')
  ]);
  coursesCache = courses;
  classesCache = classes;
  equipmentCache = equipment;

  const ab = document.getElementById('reservation-actions');
  if (['teacher','admin'].includes(currentUser.role)) {
    ab.innerHTML = '<button class="btn btn-primary" onclick="showReserveModal()">+ 新建预约</button>';
  } else {
    ab.innerHTML = '';
  }

  let h = '<table class="data-table"><thead><tr><th>ID</th><th>课程</th><th>班级</th><th>器材</th><th>数量</th><th>周次</th><th>状态</th><th>操作</th></tr></thead><tbody>';
  reservations.forEach(r => {
    h += `<tr><td>${r.id}</td><td>${r.course_name}</td><td>${r.class_name}</td><td>${r.equipment_name}</td><td>${r.qty}</td><td>${r.week_key}</td>`;
    h += `<td><span class="status-badge ${STATUS_CLASS[r.status]}">${STATUS_MAP[r.status]}</span></td>`;
    h += '<td class="action-cell">';
    if (r.status === 'pending' && ['admin','lab_manager'].includes(currentUser.role)) {
      h += `<button class="btn btn-sm btn-success" onclick="approveReservation(${r.id})">审批</button>`;
    }
    if (r.status === 'approved' && ['teacher','admin'].includes(currentUser.role)) {
      h += `<button class="btn btn-sm btn-info" onclick="collectReservation(${r.id})">领用</button>`;
    }
    if (['collected','partially_returned'].includes(r.status) && ['teacher','admin'].includes(currentUser.role)) {
      h += `<button class="btn btn-sm btn-warning" onclick="showReturnModal(${r.id}, ${r.qty})">归还</button>`;
    }
    h += '</td></tr>';
  });
  h += '</tbody></table>';
  document.getElementById('reservation-table').innerHTML = h;
}

async function showReserveModal() {
  const myCourses = currentUser.role === 'admin' ? coursesCache : coursesCache.filter(c => c.teacher_id === currentUser.id);
  const myClasses = classesCache.filter(cl => myCourses.some(c => c.id === cl.course_id));
  let h = '<form id="reserve-form">';
  h += '<div class="form-group"><label>课程</label><select name="course_id" id="res-course" required>';
  myCourses.forEach(c => { h += `<option value="${c.id}">${c.name}</option>`; });
  h += '</select></div>';
  h += '<div class="form-group"><label>班级</label><select name="class_id" id="res-class" required>';
  myClasses.forEach(cl => { h += `<option value="${cl.id}">${cl.name}</option>`; });
  h += '</select></div>';
  h += '<div class="form-group"><label>器材</label><select name="equipment_id" required>';
  equipmentCache.forEach(e => { h += `<option value="${e.id}">${e.name} (可用:${e.available_qty})</option>`; });
  h += '</select></div>';
  h += '<div class="form-group"><label>数量</label><input type="number" name="qty" min="1" required></div>';
  h += '<div class="form-group"><label>周次</label><input type="text" name="week_key" placeholder="如 2026-W24" required></div>';
  h += '<button type="submit" class="btn btn-primary btn-block">提交预约</button></form>';
  showModal('新建器材预约', h);
  document.getElementById('reserve-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('POST', '/api/reservations', Object.fromEntries(fd));
      closeModal();
      toast('预约创建成功');
      loadReservations();
    } catch (err) { toast(err.message, 'error'); }
  };
}

async function approveReservation(id) {
  try {
    await api('PUT', `/api/reservations/${id}/approve`);
    toast('预约已审批');
    loadReservations();
  } catch (err) { toast(err.message, 'error'); }
}

async function collectReservation(id) {
  try {
    await api('PUT', `/api/reservations/${id}/collect`);
    toast('器材已领用');
    loadReservations();
  } catch (err) { toast(err.message, 'error'); }
}

function showReturnModal(id, totalQty) {
  let h = `<form id="return-form"><div class="form-group"><label>归还数量 (预约量: ${totalQty})</label><input type="number" name="return_qty" min="1" max="${totalQty}" value="${totalQty}" required></div><button type="submit" class="btn btn-primary btn-block">确认归还</button></form>`;
  showModal('归还器材', h);
  document.getElementById('return-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const res = await api('PUT', `/api/reservations/${id}/return`, { return_qty: parseInt(fd.get('return_qty')) });
      closeModal();
      toast(`归还成功，状态: ${STATUS_MAP[res.status]}`);
      loadReservations();
    } catch (err) { toast(err.message, 'error'); }
  };
}

async function loadLossReports() {
  const reports = await api('GET', '/api/loss-reports');
  const ab = document.getElementById('loss-actions');
  if (['teacher','admin'].includes(currentUser.role)) {
    ab.innerHTML = '<button class="btn btn-primary" onclick="showLossModal()">+ 申报损耗</button>';
  } else {
    ab.innerHTML = '';
  }

  let h = '<table class="data-table"><thead><tr><th>ID</th><th>关联预约</th><th>器材</th><th>损耗数量</th><th>申报人</th><th>原因</th><th>状态</th><th>审批人</th><th>操作</th></tr></thead><tbody>';
  reports.forEach(r => {
    h += `<tr><td>${r.id}</td><td>${r.reservation_id}</td><td>${r.equipment_name}</td><td>${r.qty}</td><td>${r.reporter_name}</td><td>${r.reason}</td>`;
    h += `<td><span class="status-badge ${LOSS_STATUS_CLASS[r.status]}">${LOSS_STATUS_MAP[r.status]}</span></td>`;
    h += `<td>${r.approver_name || '-'}</td>`;
    h += '<td class="action-cell">';
    if (r.status === 'pending' && ['admin','lab_manager'].includes(currentUser.role)) {
      h += `<button class="btn btn-sm btn-success" onclick="approveLoss(${r.id})">通过</button>`;
      h += `<button class="btn btn-sm btn-danger" onclick="rejectLoss(${r.id})">驳回</button>`;
    }
    h += '</td></tr>';
  });
  h += '</tbody></table>';
  document.getElementById('loss-table').innerHTML = h;
}

async function showLossModal() {
  const reservations = await api('GET', '/api/reservations');
  const active = reservations.filter(r => ['collected','partially_returned'].includes(r.status));
  if (active.length === 0) { toast('没有可申报损耗的领用记录', 'warn'); return; }

  let h = '<form id="loss-form"><div class="form-group"><label>关联预约</label><select name="reservation_id" required>';
  active.forEach(r => { h += `<option value="${r.id}">预约#${r.id} - ${r.equipment_name} (${r.qty}个, ${STATUS_MAP[r.status]})</option>`; });
  h += '</select></div>';
  h += '<div class="form-group"><label>损耗数量</label><input type="number" name="qty" min="1" required></div>';
  h += '<div class="form-group"><label>损耗原因</label><textarea name="reason" rows="3" required></textarea></div>';
  h += '<button type="submit" class="btn btn-primary btn-block">提交损耗申报</button></form>';
  showModal('申报器材损耗', h);
  document.getElementById('loss-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('POST', '/api/loss-reports', Object.fromEntries(fd));
      closeModal();
      toast('损耗申报已提交');
      loadLossReports();
    } catch (err) { toast(err.message, 'error'); }
  };
}

async function approveLoss(id) {
  try {
    await api('PUT', `/api/loss-reports/${id}/approve`);
    toast('损耗已审批通过');
    loadLossReports();
  } catch (err) { toast(err.message, 'error'); }
}

async function rejectLoss(id) {
  try {
    await api('PUT', `/api/loss-reports/${id}/reject`);
    toast('损耗已驳回');
    loadLossReports();
  } catch (err) { toast(err.message, 'error'); }
}

async function loadSettlements() {
  const settlements = await api('GET', '/api/settlements');
  const ab = document.getElementById('settlement-actions');

  selectedSettlementIds.forEach(id => {
    if (!settlements.some(s => s.id === id)) selectedSettlementIds.delete(id);
  });

  if (['admin','lab_manager'].includes(currentUser.role)) {
    const compareDisabled = selectedSettlementIds.size !== 2;
    ab.innerHTML = `
      <button class="btn btn-primary" onclick="showSettlementModal()">+ 执行周结转</button>
      <button class="btn btn-secondary" onclick="showImportModal()" style="margin-left:8px">📤 导入结转 JSON</button>
      <button class="btn btn-danger" onclick="showRevokeLatestModal()" style="margin-left:8px">↩️ 撤销最近结转</button>
      <button class="btn btn-info" onclick="doCompare()" style="margin-left:8px" ${compareDisabled ? 'disabled' : ''}>
        🔍 差异对比 (${selectedSettlementIds.size}/2)
      </button>
      <button class="btn btn-success" onclick="exportDiffCsv()" style="margin-left:8px" ${compareDisabled ? 'disabled' : ''}>
        📊 导出对比 CSV
      </button>
      ${selectedSettlementIds.size > 0 ? `<button class="btn btn-sm" style="margin-left:8px;background:#eee;color:#555" onclick="clearSettlementSelection()">取消选择</button>` : ''}
    `;
  } else if (selectedSettlementIds.size === 2) {
    ab.innerHTML = `
      <button class="btn btn-info" onclick="doCompare()">🔍 差异对比 (已选 2 条)</button>
      <button class="btn btn-sm" style="margin-left:8px;background:#eee;color:#555" onclick="clearSettlementSelection()">取消选择</button>
    `;
  } else {
    ab.innerHTML = selectedSettlementIds.size > 0
      ? `<button class="btn btn-sm" style="background:#eee;color:#555" onclick="clearSettlementSelection()">取消选择 (${selectedSettlementIds.size})</button>`
      : '';
  }

  if (settlements.length > 0) {
    const hint = document.createElement('div');
  }

  let h = '';
  if (settlements.length === 0) {
    h = '<div class="empty-state">暂无结转记录</div>';
  } else {
    if (settlements.length >= 2) {
      h += '<div style="background:#e8f4fd;padding:10px 14px;border-radius:6px;margin-bottom:16px;border:1px solid #b6d8ef;color:#1a5276">💡 提示：勾选结转记录卡片左上角的复选框（选 2 条），即可启用"差异对比"和"导出 CSV"功能。</div>';
    }
    settlements.forEach(s => {
      const isSelected = selectedSettlementIds.has(s.id);
      const selectedStyle = isSelected ? ' border:2px solid #3498db;box-shadow:0 0 0 3px rgba(52,152,219,0.2);' : '';
      const sourceBadge = s.source === 'imported'
        ? ' <span class="source-badge source-imported">📁 导入视图</span>'
        : (s.is_latest_settled ? ' <span class="source-badge source-latest">⭐ 最新结转</span>' : '');
      h += `<div class="settlement-card" style="position:relative;${selectedStyle}">`;
      h += `<label style="position:absolute;top:10px;left:12px;z-index:2;cursor:pointer;display:flex;align-items:center;gap:4px">
        <input type="checkbox" data-id="${s.id}" ${isSelected ? 'checked' : ''} onchange="toggleSettlementSelection(${s.id})">
        <span style="font-size:13px;color:#555">选择对比</span>
      </label>`;
      h += `<div class="settlement-header" style="padding-left:140px"><h3>周次: ${s.week_key}${sourceBadge}</h3><span class="settlement-time">${new Date(s.settled_at).toLocaleString()}</span></div>`;
      h += '<div class="settlement-body">';

      if (s.notes && s.notes.length > 0) {
        h += '<h4>📝 结转说明留痕</h4>';
        h += '<div style="background:#fef9e7;border:1px solid #f7dc6f;border-radius:6px;padding:10px 12px;margin-bottom:12px">';
        s.notes.forEach(note => {
          h += `<div style="padding:6px 0;border-bottom:1px dashed #f0c911;${s.notes.indexOf(note) === s.notes.length - 1 ? 'border-bottom:none' : ''}">
            <div style="font-size:13px;color:#8e6f00;margin-bottom:4px">
              <strong>${note.created_by_name || '未知'}</strong> · ${new Date(note.created_at).toLocaleString()}
              ${note.created_at !== note.updated_at ? ` (修改于 ${new Date(note.updated_at).toLocaleString()})` : ''}
            </div>
            <div style="white-space:pre-wrap;color:#333;line-height:1.6">${escapeHtml(note.content)}</div>
            ${['admin','lab_manager'].includes(currentUser.role) ? `
              <div style="margin-top:6px;display:flex;gap:6px">
                <button class="btn btn-xs" style="background:#eaf2f8;color:#2e86c1" onclick="showEditNoteModal(${note.id}, ${JSON.stringify(escapeHtml(note.content)).replace(/"/g, '&quot;')})">✏️ 修改</button>
                <button class="btn btn-xs" style="background:#fadbd8;color:#c0392b" onclick="deleteNote(${note.id})">🗑️ 删除</button>
              </div>` : ''}
          </div>`;
        });
        h += '</div>';
      }
      if (['admin','lab_manager'].includes(currentUser.role)) {
        h += `<button class="btn btn-xs" style="background:#fcf3cf;color:#7d6608;margin-bottom:12px" onclick="showAddNoteModal(${s.id}, '${s.week_key}')">➕ 添加结转说明</button>`;
      }

      h += '<h4>器材快照</h4><table class="data-table compact"><thead><tr><th>器材</th><th>总量</th><th>可用</th><th>锁定</th></tr></thead><tbody>';
      s.totals.equipment_snapshot.forEach(eq => {
        h += `<tr><td>${eq.name}</td><td>${eq.total}</td><td>${eq.available}</td><td>${eq.locked}</td></tr>`;
      });
      h += '</tbody></table>';
      h += `<h4>预约汇总: 共 ${s.totals.reservation_summary.total} 条</h4>`;
      const byStatus = s.totals.reservation_summary.by_status || {};
      h += '<div class="status-summary">';
      Object.entries(byStatus).forEach(([k, v]) => {
        h += `<span class="status-badge ${STATUS_CLASS[k] || ''}">${STATUS_MAP[k] || k}: ${v}</span> `;
      });
      h += '</div>';
      h += `<h4>损耗汇总: ${s.totals.loss_summary.total_reports} 条，共 ${s.totals.loss_summary.total_qty} 件</h4>`;
      if (s.totals.pending_returns && s.totals.pending_returns.length > 0) {
        h += '<h4>待归还</h4><table class="data-table compact"><thead><tr><th>器材</th><th>数量</th><th>状态</th></tr></thead><tbody>';
        s.totals.pending_returns.forEach(pr => {
          h += `<tr><td>${pr.equipment_name}</td><td>${pr.qty}</td><td>${STATUS_MAP[pr.status]}</td></tr>`;
        });
        h += '</tbody></table>';
      }
      h += '<div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">';
      const exportSrc = s.source === 'imported' ? '?source=imported' : '';
      h += `<a href="/api/export/${s.week_key}${exportSrc}" class="btn btn-sm btn-info" target="_blank">📥 导出结转数据</a>`;
      if (s.source === 'settled' && s.is_latest_settled && ['admin','lab_manager'].includes(currentUser.role)) {
        h += `<button class="btn btn-sm btn-danger" onclick="showRevokeModal('${s.week_key}')">↩️ 撤销此结转</button>`;
      }
      if (s.source === 'imported' && ['admin','lab_manager'].includes(currentUser.role)) {
        h += `<button class="btn btn-sm btn-warning" onclick="removeImported('${s.week_key}')">🗑️ 移除导入</button>`;
      }
      h += '</div>';
      h += '</div></div>';
    });
  }
  document.getElementById('settlement-list').innerHTML = h;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, s => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[s]);
}

function toggleSettlementSelection(id) {
  if (selectedSettlementIds.has(id)) {
    selectedSettlementIds.delete(id);
  } else {
    if (selectedSettlementIds.size >= 2) {
      toast('最多只能选择 2 条记录进行对比', 'warn');
      loadSettlements();
      return;
    }
    selectedSettlementIds.add(id);
  }
  loadSettlements();
}

function clearSettlementSelection() {
  selectedSettlementIds.clear();
  loadSettlements();
}

async function doCompare() {
  const ids = Array.from(selectedSettlementIds);
  if (ids.length !== 2) { toast('请先选择 2 条结转记录', 'warn'); return; }
  try {
    const result = await api('POST', '/api/settlements/compare', {
      settlement_a_id: ids[0],
      settlement_b_id: ids[1]
    });
    showCompareModal(result);
  } catch (e) { toast(e.message, 'error'); }
}

async function exportDiffCsv() {
  const ids = Array.from(selectedSettlementIds);
  if (ids.length !== 2) { toast('请先选择 2 条结转记录', 'warn'); return; }
  try {
    const res = await fetch('/api/settlements/compare/export-csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        settlement_a_id: ids[0],
        settlement_b_id: ids[1]
      })
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || '导出失败');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const disposition = res.headers.get('Content-Disposition');
    a.download = disposition && disposition.includes('filename=')
      ? disposition.split('filename=')[1].replace(/"/g, '')
      : `settlement-diff-${ids[0]}_vs_${ids[1]}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('对比 CSV 导出成功');
  } catch (e) { toast(e.message, 'error'); }
}

function showCompareModal(result) {
  const { settlement_a, settlement_b, diff } = result;
  let h = '';
  h += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
    <div style="background:#fdfefe;padding:10px;border-radius:6px;border:1px solid #d5dbdb">
      <strong>A</strong> · ${settlement_a.week_key}
      <div style="font-size:12px;color:#666">${settlement_a.source === 'imported' ? '导入视图' : (settlement_a.is_latest_settled ? '⭐ 最新结转' : '正式结转')} · ${new Date(settlement_a.settled_at).toLocaleString()}</div>
    </div>
    <div style="background:#fdfefe;padding:10px;border-radius:6px;border:1px solid #d5dbdb">
      <strong>B</strong> · ${settlement_b.week_key}
      <div style="font-size:12px;color:#666">${settlement_b.source === 'imported' ? '导入视图' : '正式结转'} · ${new Date(settlement_b.settled_at).toLocaleString()}</div>
    </div>
  </div>`;

  const badge = (color, text) => `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:${color};color:#fff;margin-right:4px">${text}</span>`;
  const renderFieldDiff = (from, to) => {
    if (typeof from === 'number' && typeof to === 'number') {
      const d = to - from;
      const arrow = d > 0 ? '↑' : (d < 0 ? '↓' : '=');
      const cls = d > 0 ? '#27ae60' : (d < 0 ? '#e74c3c' : '#7f8c8d');
      return `<span style="color:#7f8c8d">${from}</span> → <strong style="color:#2c3e50">${to}</strong> <span style="color:${cls};font-weight:bold">${arrow}${d !== 0 ? ' ' + (d > 0 ? '+' : '') + d : ''}</span>`;
    }
    const statusMap = { pending:'待审批', approved:'已审批', collected:'已领用', partially_returned:'部分归还', returned:'已归还', cancelled:'已取消' };
    const mapS = s => statusMap[s] || s;
    return `<span style="color:#7f8c8d">${mapS(from)}</span> → <strong style="color:#2980b9">${mapS(to)}</strong>`;
  };

  h += '<h3 style="margin-top:0">📦 器材快照差异</h3>';
  const eq = diff.equipment_snapshot;
  if (eq.added.length === 0 && eq.removed.length === 0 && eq.changed.length === 0) {
    h += '<p style="color:#27ae60">✅ 器材快照无差异</p>';
  } else {
    h += '<table class="data-table compact" style="width:100%"><thead><tr><th>变化</th><th>器材</th><th>字段</th><th>变化详情 (A → B)</th></tr></thead><tbody>';
    eq.added.forEach(e => {
      h += `<tr><td>${badge('#27ae60','新增')}</td><td>${e.name}</td><td>全部</td><td>总量:${e.total} / 可用:${e.available} / 锁定:${e.locked}</td></tr>`;
    });
    eq.removed.forEach(e => {
      h += `<tr><td>${badge('#e74c3c','减少')}</td><td>${e.name}</td><td>全部</td><td>总量:${e.total} / 可用:${e.available} / 锁定:${e.locked} (B 中消失)</td></tr>`;
    });
    eq.changed.forEach(e => {
      const fieldLabel = { total:'总量', available:'可用', locked:'锁定' };
      Object.entries(e.changes).forEach(([f, ch]) => {
        h += `<tr><td>${badge('#f39c12','变化')}</td><td>${e.name}</td><td>${fieldLabel[f] || f}</td><td>${renderFieldDiff(ch.from, ch.to)}</td></tr>`;
      });
    });
    h += '</tbody></table>';
  }

  h += '<h3 style="margin-top:20px">📅 预约汇总差异</h3>';
  const rs = diff.reservation_summary;
  h += `<p>预约总数变化: <strong style="color:${rs.total_diff > 0 ? '#27ae60' : (rs.total_diff < 0 ? '#e74c3c' : '#7f8c8d')}">${rs.total_diff > 0 ? '+' : ''}${rs.total_diff} 条</strong></p>`;
  if (rs.added.length === 0 && rs.removed.length === 0 && rs.changed.length === 0) {
    h += '<p style="color:#27ae60">✅ 各状态预约条数无差异</p>';
  } else {
    h += '<table class="data-table compact" style="width:100%"><thead><tr><th>变化</th><th>状态</th><th>变化详情 (A → B)</th></tr></thead><tbody>';
    rs.added.forEach(s => h += `<tr><td>${badge('#27ae60','新增')}</td><td>${STATUS_MAP[s.status] || s.status}</td><td>0 → ${s.count} (+${s.count})</td></tr>`);
    rs.removed.forEach(s => h += `<tr><td>${badge('#e74c3c','减少')}</td><td>${STATUS_MAP[s.status] || s.status}</td><td>${s.count} → 0 (-${s.count})</td></tr>`);
    rs.changed.forEach(s => h += `<tr><td>${badge('#f39c12','变化')}</td><td>${STATUS_MAP[s.status] || s.status}</td><td>${renderFieldDiff(s.from, s.to)}</td></tr>`);
    h += '</tbody></table>';
  }

  h += '<h3 style="margin-top:20px">💥 损耗汇总差异</h3>';
  const ls = diff.loss_summary;
  h += '<table class="data-table compact" style="width:100%"><thead><tr><th>指标</th><th>A</th><th>B</th><th>差异</th></tr></thead><tbody>';
  h += `<tr><td>损耗申报数</td><td>${ls.a_reports}</td><td>${ls.b_reports}</td><td style="color:${ls.reports_diff > 0 ? '#27ae60' : (ls.reports_diff < 0 ? '#e74c3c' : '#7f8c8d')}"><strong>${ls.reports_diff > 0 ? '+' : ''}${ls.reports_diff} 条</strong></td></tr>`;
  h += `<tr><td>损耗件数</td><td>${ls.a_qty}</td><td>${ls.b_qty}</td><td style="color:${ls.qty_diff > 0 ? '#27ae60' : (ls.qty_diff < 0 ? '#e74c3c' : '#7f8c8d')}"><strong>${ls.qty_diff > 0 ? '+' : ''}${ls.qty_diff} 件</strong></td></tr>`;
  h += '</tbody></table>';

  h += '<h3 style="margin-top:20px">📤 待归还差异</h3>';
  const pr = diff.pending_returns;
  if (pr.added.length === 0 && pr.removed.length === 0 && pr.changed.length === 0) {
    h += '<p style="color:#27ae60">✅ 待归还无差异</p>';
  } else {
    h += '<table class="data-table compact" style="width:100%"><thead><tr><th>变化</th><th>器材</th><th>字段</th><th>变化详情 (A → B)</th></tr></thead><tbody>';
    pr.added.forEach(p => {
      h += `<tr><td>${badge('#27ae60','新增')}</td><td>${p.equipment_name}</td><td>数量</td><td>0 → ${p.qty} (+${p.qty})</td></tr>`;
      h += `<tr><td>${badge('#27ae60','新增')}</td><td>${p.equipment_name}</td><td>状态</td><td>无 → ${STATUS_MAP[p.status] || p.status}</td></tr>`;
    });
    pr.removed.forEach(p => {
      h += `<tr><td>${badge('#e74c3c','减少')}</td><td>${p.equipment_name}</td><td>数量</td><td>${p.qty} → 0 (-${p.qty})</td></tr>`;
      h += `<tr><td>${badge('#e74c3c','减少')}</td><td>${p.equipment_name}</td><td>状态</td><td>${STATUS_MAP[p.status] || p.status} → 无 (B 中无此待归还)</td></tr>`;
    });
    pr.changed.forEach(p => {
      Object.entries(p.changes).forEach(([f, ch]) => {
        const label = f === 'qty' ? '数量' : '状态';
        h += `<tr><td>${badge(f === 'status' ? '#8e44ad' : '#f39c12', f === 'status' ? '状态变化' : '变化')}</td><td>${p.equipment_name}</td><td>${label}</td><td>${renderFieldDiff(ch.from, ch.to)}</td></tr>`;
      });
    });
    h += '</tbody></table>';
  }

  if (['admin','lab_manager'].includes(currentUser.role)) {
    h += `<div style="margin-top:18px;text-align:right">
      <button class="btn btn-success" onclick="exportDiffCsv();closeModal()">📊 导出此对比为 CSV</button>
    </div>`;
  }

  showModal(`差异对比 · ${settlement_a.week_key} ↔ ${settlement_b.week_key}`, h);
}

function showAddNoteModal(settlementId, weekKey) {
  let html = `<form id="note-form">
    <div class="form-group">
      <label>为 <strong>${weekKey}</strong> 结转添加说明</label>
      <textarea id="note-content" rows="5" required style="width:100%;padding:8px;resize:vertical;font-family:inherit" placeholder="请输入对账说明、异常原因、后续处理计划等留痕信息..."></textarea>
    </div>
    <p class="form-hint" style="color:#666">⚠️ 说明将公开给所有登录用户查看，并记录操作日志。</p>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button type="submit" class="btn btn-primary" style="flex:1">💾 保存说明</button>
      <button type="button" class="btn" style="flex:1;background:#eee;color:#555" onclick="closeModal()">取消</button>
    </div>
  </form>`;
  showModal(`添加结转说明 · ${weekKey}`, html);
  document.getElementById('note-form').onsubmit = async (e) => {
    e.preventDefault();
    const content = document.getElementById('note-content').value;
    try {
      await api('POST', `/api/settlements/${settlementId}/notes`, { content });
      closeModal();
      toast('说明已添加');
      loadSettlements();
    } catch (err) { toast(err.message, 'error'); }
  };
}

function showEditNoteModal(noteId, oldContent) {
  const decoded = oldContent.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
  let html = `<form id="edit-note-form">
    <div class="form-group">
      <label>修改结转说明</label>
      <textarea id="edit-note-content" rows="5" required style="width:100%;padding:8px;resize:vertical;font-family:inherit"></textarea>
    </div>
    <p class="form-hint" style="color:#666">💡 修改记录会反映在更新时间上，所有用户可查。</p>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button type="submit" class="btn btn-primary" style="flex:1">💾 保存修改</button>
      <button type="button" class="btn" style="flex:1;background:#eee;color:#555" onclick="closeModal()">取消</button>
    </div>
  </form>`;
  showModal('修改结转说明', html);
  document.getElementById('edit-note-content').value = decoded;
  document.getElementById('edit-note-form').onsubmit = async (e) => {
    e.preventDefault();
    const content = document.getElementById('edit-note-content').value;
    try {
      await api('PUT', `/api/settlements/notes/${noteId}`, { content });
      closeModal();
      toast('说明已更新');
      loadSettlements();
    } catch (err) { toast(err.message, 'error'); }
  };
}

async function deleteNote(noteId) {
  if (!confirm('确认删除此结转说明？删除后无法恢复。')) return;
  try {
    await api('DELETE', `/api/settlements/notes/${noteId}`);
    toast('说明已删除');
    loadSettlements();
  } catch (err) { toast(err.message, 'error'); }
}

window.idsForCompare = [];

async function showRevokeLatestModal() {
  try {
    const info = await api('GET', '/api/settlements/latest-info');
    if (!info.has_latest) {
      toast('当前没有可撤销的结转记录', 'warn');
      return;
    }
    showRevokeModal(info.week_key);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function showRevokeModal(weekKey) {
  let h = `<p>确认要撤销 <strong>${weekKey}</strong> 周的结转吗？</p>`;
  h += '<ul class="form-hint" style="padding-left:20px;margin:8px 0">';
  h += '<li>撤销后该周的器材快照、预约汇总、损耗汇总、待归还列表将不再出现在结转视图中</li>';
  h += '<li>仅允许撤销最新周次的结转</li>';
  h += '<li>撤销后可以重新对该周执行结转</li>';
  h += '<li>操作日志会保留完整记录</li>';
  h += '</ul>';
  h += `<p class="form-hint" style="color:#e74c3c">⚠️ 此操作不可重复回滚，请确认无误后再继续。</p>`;
  h += `<div style="margin-top:16px;display:flex;gap:8px">`;
  h += `<button id="revoke-confirm-btn" class="btn btn-danger" style="flex:1">确认撤销 ${weekKey}</button>`;
  h += `<button id="revoke-cancel-btn" class="btn" style="flex:1;background:#eee;color:#555">取消</button>`;
  h += `</div>`;
  showModal('撤销周结转', h);
  document.getElementById('revoke-cancel-btn').onclick = closeModal;
  document.getElementById('revoke-confirm-btn').onclick = async () => {
    const btn = document.getElementById('revoke-confirm-btn');
    btn.disabled = true;
    btn.textContent = '撤销中...';
    try {
      const r = await api('DELETE', `/api/settlements/${weekKey}/revoke`);
      closeModal();
      toast(r.message || `${weekKey} 结转已撤销`);
      loadSettlements();
      if (typeof loadDashboard === 'function') loadDashboard();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = `确认撤销 ${weekKey}`;
      toast(e.message, 'error');
    }
  };
}

function showImportModal() {
  let h = '<div class="form-group"><label>选择结转 JSON 文件</label>';
  h += '<input type="file" id="import-file" accept=".json,application/json" required>';
  h += '<p class="form-hint">请选择之前通过"导出结转数据"下载的 JSON 文件。</p>';
  h += '<p class="form-hint" style="color:#17a2b8">💡 导入的结转仅作为视图展示，不会影响或覆盖当前业务数据。</p>';
  h += '<p class="form-hint" style="color:#e74c3c">⚠️ 如果该周已存在正式结转记录，导入将被拒绝。</p>';
  h += '</div>';
  h += `<div style="margin-top:16px;display:flex;gap:8px">`;
  h += `<button id="import-confirm-btn" class="btn btn-primary" style="flex:1">开始导入</button>`;
  h += `<button id="import-cancel-btn" class="btn" style="flex:1;background:#eee;color:#555">取消</button>`;
  h += `</div>`;
  showModal('导入结转 JSON', h);
  document.getElementById('import-cancel-btn').onclick = closeModal;
  document.getElementById('import-confirm-btn').onclick = async () => {
    const fileInput = document.getElementById('import-file');
    const file = fileInput.files[0];
    if (!file) { toast('请先选择文件', 'warn'); return; }
    const btn = document.getElementById('import-confirm-btn');
    btn.disabled = true;
    btn.textContent = '导入中...';
    try {
      const text = await file.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error('JSON 解析失败，请确认文件格式正确');
      }
      const r = await api('POST', '/api/settlements/import', data);
      closeModal();
      toast(`导入成功：${r.week_key}`);
      loadSettlements();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '开始导入';
      toast(e.message, 'error');
    }
  };
}

async function removeImported(weekKey) {
  if (!confirm(`确认移除导入的 ${weekKey} 结转视图吗？`)) return;
  try {
    await api('DELETE', `/api/settlements/${weekKey}/remove-import`);
    toast(`已移除导入的 ${weekKey} 结转视图`);
    loadSettlements();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function showSettlementModal() {
  const d = await api('GET', '/api/dashboard');
  let h = `<form id="settlement-form"><div class="form-group"><label>结转周次</label><input type="text" name="week_key" value="${d.current_week}" required></div>`;
  h += '<p class="form-hint">确认后将生成本周结转快照，不可重复执行。</p>';
  h += '<button type="submit" class="btn btn-primary btn-block">确认结转</button></form>';
  showModal('执行周结转', h);
  document.getElementById('settlement-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('POST', '/api/settlements/weekly', { week_key: fd.get('week_key') });
      closeModal();
      toast('周结转执行成功');
      loadSettlements();
    } catch (err) { toast(err.message, 'error'); }
  };
}

async function loadLogs() {
  const logs = await api('GET', '/api/logs');
  let h = '<table class="data-table"><thead><tr><th>时间</th><th>操作</th><th>用户</th><th>详情</th></tr></thead><tbody>';
  logs.forEach(l => {
    const details = typeof l.details === 'object' ? JSON.stringify(l.details, null, 2) : (l.details || '');
    h += `<tr><td class="log-time">${new Date(l.created_at).toLocaleString()}</td><td>${l.action}</td><td>${l.user_name || '-'}</td><td class="log-details"><pre>${details}</pre></td></tr>`;
  });
  h += '</tbody></table>';
  document.getElementById('logs-table').innerHTML = h;
}

document.getElementById('login-form').onsubmit = async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value;
  const password = document.getElementById('login-password').value;
  try {
    const res = await api('POST', '/api/login', { username, password });
    currentUser = res.user;
    document.getElementById('login-error').textContent = '';
    showMainPage();
  } catch (err) {
    document.getElementById('login-error').textContent = err.message;
  }
};

document.getElementById('btn-logout').onclick = async () => {
  await api('POST', '/api/logout');
  currentUser = null;
  showLoginPage();
};

document.getElementById('btn-reset').onclick = async () => {
  if (!confirm('确认重置所有数据？此操作不可撤销。')) return;
  try {
    await api('POST', '/api/reset');
    currentUser = null;
    showLoginPage();
    toast('数据已重置');
  } catch (err) { toast(err.message, 'error'); }
};

document.querySelectorAll('.nav-link').forEach(link => {
  link.onclick = (e) => { e.preventDefault(); switchPage(link.dataset.page); };
});

document.getElementById('login-username').onchange = function() {
  const pwMap = { admin: 'admin123', zhangsan: '123456', lisi: '123456', wangwu: '123456' };
  document.getElementById('login-password').value = pwMap[this.value] || '';
};

function showLoginPage() {
  document.getElementById('login-page').classList.add('active');
  document.getElementById('main-page').classList.remove('active');
}

function showMainPage() {
  document.getElementById('login-page').classList.remove('active');
  document.getElementById('main-page').classList.add('active');
  document.getElementById('user-info').innerHTML = `${currentUser.name} <span class="role-badge">${ROLE_MAP[currentUser.role]}</span>`;
  switchPage('dashboard');
}

document.getElementById('modal-overlay').onclick = (e) => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
};

(async () => {
  try {
    const res = await api('GET', '/api/me');
    currentUser = res.user;
    showMainPage();
  } catch (e) {
    showLoginPage();
  }
})();
