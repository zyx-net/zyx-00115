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
const REPAIR_STATUS_MAP = {
  pending: '待审核', reviewing: '审核中', deactivated: '已停用',
  repairing: '维修中', replacing: '换件中', returned: '已回库',
  scrapped: '已报废', cancelled: '已取消', revoked: '已撤销'
};
const REPAIR_STATUS_CLASS = {
  pending: 'status-pending', reviewing: 'status-partial', deactivated: 'status-rejected',
  repairing: 'status-approved', replacing: 'status-approved', returned: 'status-returned',
  scrapped: 'status-cancelled', cancelled: 'status-cancelled', revoked: 'status-cancelled'
};
const REPAIR_DECISION_MAP = {
  deactivate: '立即停用', repair: '安排维修', replace: '安排换件',
  scrap: '报废', cancel: '取消', pending: '待决定'
};
const REPAIR_SCHEDULE_STATUS_MAP = {
  scheduled: '已排期',
  picked_up: '已取件',
  repairing: '维修中',
  returned: '已归还',
  cancelled: '已取消'
};
const REPAIR_SCHEDULE_STATUS_CLASS = {
  scheduled: 'status-pending',
  picked_up: 'status-partial',
  repairing: 'status-approved',
  returned: 'status-returned',
  cancelled: 'status-cancelled'
};

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
    if ((name === 'export-history' || name === 'ledger') && !['admin','lab_manager'].includes(currentUser.role)) {
      toast('无权访问此页面', 'error');
      switchPage('dashboard');
      return;
    }
    if (name === 'dashboard') await loadDashboard();
    else if (name === 'equipment') await loadEquipment();
    else if (name === 'reservations') await loadReservations();
    else if (name === 'loss-reports') await loadLossReports();
    else if (name === 'settlements') await loadSettlements();
    else if (name === 'makeup-center') await loadMakeupCenter();
    else if (name === 'inventory-center') await loadInventoryCenter();
    else if (name === 'repair-center') await loadRepairCenter();
    else if (name === 'export-history') await loadExportHistory();
    else if (name === 'ledger') await loadLedger();
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
      <button class="btn btn-outline" onclick="switchPage('export-history')" style="margin-left:8px;background:#fff;border:1px solid #3498db;color:#3498db">
        📤 导出历史
      </button>
      <button class="btn btn-outline" onclick="switchPage('ledger')" style="margin-left:8px;background:#fff;border:1px solid #9b59b6;color:#9b59b6">
        📒 复盘台账
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

async function loadExportHistory() {
  const list = await api('GET', '/api/settlements/exports');
  const ab = document.getElementById('export-history-actions');
  ab.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <span style="color:#666">仅显示有效导出记录（未失效的结转相关导出）</span>
      <button class="btn btn-info" onclick="switchPage('ledger')" style="margin-left:auto">📒 进入复盘台账</button>
    </div>
  `;
  
  if (list.length === 0) {
    document.getElementById('export-history-list').innerHTML = '<div class="empty-state">暂无导出历史</div>';
    return;
  }
  
  let h = '<table class="data-table"><thead><tr><th>来源周次</th><th>类型</th><th>文件名</th><th>行数</th><th>操作人</th><th>导出时间</th><th>操作</th></tr></thead><tbody>';
  list.forEach(item => {
    const weekDisplay = item.week_key_b ? `${item.week_key_a} ↔ ${item.week_key_b}` : item.week_key_a;
    const typeLabel = item.type === 'single' ? '单周 JSON' : '对比 CSV';
    h += `<tr>
      <td>${weekDisplay}</td>
      <td>${typeLabel}</td>
      <td><code style="font-size:12px">${escapeHtml(item.filename)}</code></td>
      <td>${item.row_count}</td>
      <td>${escapeHtml(item.created_by_name || '-')}</td>
      <td class="log-time">${new Date(item.created_at).toLocaleString()}</td>
      <td>
        <button class="btn btn-xs btn-info" onclick="showLedgerDetail(${item.id})">查看详情</button>
      </td>
    </tr>`;
  });
  h += '</tbody></table>';
  document.getElementById('export-history-list').innerHTML = h;
}

let ledgerFilters = {
  week_key_start: '',
  week_key_end: '',
  export_type: '',
  operator: '',
  invalid: ''
};

async function loadLedger() {
  const params = new URLSearchParams();
  if (ledgerFilters.week_key_start) params.append('week_key_start', ledgerFilters.week_key_start);
  if (ledgerFilters.week_key_end) params.append('week_key_end', ledgerFilters.week_key_end);
  if (ledgerFilters.export_type) params.append('export_type', ledgerFilters.export_type);
  if (ledgerFilters.operator) params.append('operator', ledgerFilters.operator);
  if (ledgerFilters.invalid !== '') params.append('invalid', ledgerFilters.invalid === 'true');
  
  const queryStr = params.toString();
  const data = await api('GET', `/api/settlements/ledger${queryStr ? '?' + queryStr : ''}`);
  const { list, summary } = data;
  
  const fb = document.getElementById('ledger-filters');
  fb.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <input type="text" id="f-week-start" placeholder="起始周次 (如 2026-W20)" 
             value="${ledgerFilters.week_key_start}" style="width:140px;padding:6px 8px;border:1px solid #ddd;border-radius:4px">
      <span>~</span>
      <input type="text" id="f-week-end" placeholder="结束周次 (如 2026-W30)" 
             value="${ledgerFilters.week_key_end}" style="width:140px;padding:6px 8px;border:1px solid #ddd;border-radius:4px">
      <select id="f-type" style="padding:6px 8px;border:1px solid #ddd;border-radius:4px">
        <option value="">全部类型</option>
        <option value="single" ${ledgerFilters.export_type === 'single' ? 'selected' : ''}>单周 JSON</option>
        <option value="comparison" ${ledgerFilters.export_type === 'comparison' ? 'selected' : ''}>对比 CSV</option>
      </select>
      <input type="text" id="f-operator" placeholder="操作人 (用户名或姓名)" 
             value="${ledgerFilters.operator}" style="width:140px;padding:6px 8px;border:1px solid #ddd;border-radius:4px">
      <select id="f-invalid" style="padding:6px 8px;border:1px solid #ddd;border-radius:4px">
        <option value="">全部状态</option>
        <option value="false" ${ledgerFilters.invalid === 'false' ? 'selected' : ''}>有效</option>
        <option value="true" ${ledgerFilters.invalid === 'true' ? 'selected' : ''}>已失效</option>
      </select>
      <button class="btn btn-primary" onclick="applyLedgerFilters()">🔍 筛选</button>
      <button class="btn" style="background:#eee;color:#555" onclick="resetLedgerFilters()">重置</button>
      <button class="btn btn-success" onclick="exportLedgerCsv()" style="margin-left:auto">📊 导出台账 CSV</button>
    </div>
  `;
  
  const sb = document.getElementById('ledger-summary');
  sb.innerHTML = `
    <div class="stat-card"><div class="stat-value">${summary.total_count}</div><div class="stat-label">总记录数</div></div>
    <div class="stat-card"><div class="stat-value">${summary.valid_count}</div><div class="stat-label">有效记录</div></div>
    <div class="stat-card"><div class="stat-value">${summary.invalid_count}</div><div class="stat-label">已失效</div></div>
    <div class="stat-card"><div class="stat-value">${summary.single_count}</div><div class="stat-label">单周 JSON</div></div>
    <div class="stat-card"><div class="stat-value">${summary.comparison_count}</div><div class="stat-label">对比 CSV</div></div>
    <div class="stat-card"><div class="stat-value">${summary.total_rows || 0}</div><div class="stat-label">总导出行数</div></div>
  `;
  
  if (list.length === 0) {
    document.getElementById('ledger-list').innerHTML = '<div class="empty-state">暂无台账记录</div>';
    return;
  }
  
  let h = '<table class="data-table"><thead><tr><th>来源周次</th><th>类型</th><th>文件名</th><th>行数</th><th>关联说明</th><th>状态</th><th>操作人</th><th>导出时间</th><th>操作</th></tr></thead><tbody>';
  list.forEach(item => {
    const weekDisplay = item.week_key_b ? `${item.week_key_a} ↔ ${item.week_key_b}` : item.week_key_a;
    const typeLabel = item.type === 'single' ? '单周 JSON' : '对比 CSV';
    const statusBadge = item.invalid 
      ? '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:#fadbd8;color:#c0392b">已失效</span>'
      : '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:#d5f5e3;color:#1e8449">有效</span>';
    const stats = item.last_cleaned_stats || {};
    let cleanedInfo = '';
    if (item.invalid && stats.cleaned_exports_total) {
      cleanedInfo = `<br><span style="font-size:11px;color:#999">清理: ${stats.cleaned_notes || 0}说明 / ${stats.cleaned_exports_total}导出</span>`;
    }
    h += `<tr style="${item.invalid ? 'opacity:0.6' : ''}">
      <td>${weekDisplay}</td>
      <td>${typeLabel}</td>
      <td><code style="font-size:12px">${escapeHtml(item.filename)}</code></td>
      <td>${item.row_count}</td>
      <td>${item.related_note_count || 0} 条${cleanedInfo}</td>
      <td>${statusBadge}</td>
      <td>${escapeHtml(item.created_by_user_name || item.created_by_username || '-')}</td>
      <td class="log-time">${new Date(item.created_at).toLocaleString()}</td>
      <td>
        <button class="btn btn-xs btn-info" onclick="showLedgerDetail(${item.id})">详情</button>
      </td>
    </tr>`;
  });
  h += '</tbody></table>';
  document.getElementById('ledger-list').innerHTML = h;
}

function applyLedgerFilters() {
  ledgerFilters.week_key_start = document.getElementById('f-week-start').value.trim();
  ledgerFilters.week_key_end = document.getElementById('f-week-end').value.trim();
  ledgerFilters.export_type = document.getElementById('f-type').value;
  ledgerFilters.operator = document.getElementById('f-operator').value.trim();
  ledgerFilters.invalid = document.getElementById('f-invalid').value;
  loadLedger();
}

function resetLedgerFilters() {
  ledgerFilters = {
    week_key_start: '',
    week_key_end: '',
    export_type: '',
    operator: '',
    invalid: ''
  };
  loadLedger();
}

async function exportLedgerCsv() {
  const params = new URLSearchParams();
  if (ledgerFilters.week_key_start) params.append('week_key_start', ledgerFilters.week_key_start);
  if (ledgerFilters.week_key_end) params.append('week_key_end', ledgerFilters.week_key_end);
  if (ledgerFilters.export_type) params.append('export_type', ledgerFilters.export_type);
  if (ledgerFilters.operator) params.append('operator', ledgerFilters.operator);
  if (ledgerFilters.invalid !== '') params.append('invalid', ledgerFilters.invalid === 'true');
  
  const queryStr = params.toString();
  try {
    const res = await fetch(`/api/settlements/ledger/export/csv${queryStr ? '?' + queryStr : ''}`, {
      credentials: 'include'
    });
    if (!res.ok) throw new Error('导出失败');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const disposition = res.headers.get('Content-Disposition');
    a.download = disposition && disposition.includes('filename=')
      ? disposition.split('filename=')[1].replace(/"/g, '')
      : `settlement-ledger-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('台账 CSV 导出成功');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function showLedgerDetail(id) {
  const detail = await api('GET', `/api/settlements/ledger/${id}`);
  const weekDisplay = detail.week_key_b ? `${detail.week_key_a} ↔ ${detail.week_key_b}` : detail.week_key_a;
  const typeLabel = detail.type === 'single' ? '单周 JSON' : '对比 CSV';
  const statusBadge = detail.invalid 
    ? '<span style="display:inline-block;padding:4px 12px;border-radius:12px;font-size:12px;background:#fadbd8;color:#c0392b">已失效</span>'
    : '<span style="display:inline-block;padding:4px 12px;border-radius:12px;font-size:12px;background:#d5f5e3;color:#1e8449">有效</span>';
  
  let h = '';
  h += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
    <div style="background:#f8f9fa;padding:12px;border-radius:6px;border:1px solid #e9ecef">
      <div style="font-size:12px;color:#666;margin-bottom:4px">导出类型</div>
      <div style="font-weight:bold">${typeLabel} ${statusBadge}</div>
    </div>
    <div style="background:#f8f9fa;padding:12px;border-radius:6px;border:1px solid #e9ecef">
      <div style="font-size:12px;color:#666;margin-bottom:4px">来源周次</div>
      <div style="font-weight:bold">${weekDisplay}</div>
    </div>
  </div>`;
  
  h += '<table class="data-table compact" style="margin-bottom:16px"><tbody>';
  h += `<tr><th style="width:120px">文件名称</th><td><code>${escapeHtml(detail.filename)}</code></td></tr>`;
  h += `<tr><th>导出行数</th><td>${detail.row_count}</td></tr>`;
  h += `<tr><th>文件格式</th><td>${detail.export_format || '-'}</td></tr>`;
  h += `<tr><th>关联说明</th><td>${detail.related_note_count || 0} 条</td></tr>`;
  h += `<tr><th>操作人</th><td>${escapeHtml(detail.created_by_user_name || detail.created_by_username || '-')} (ID: ${detail.created_by})</td></tr>`;
  h += `<tr><th>导出时间</th><td>${new Date(detail.created_at).toLocaleString()}</td></tr>`;
  if (detail.comparison_id) {
    h += `<tr><th>关联对比</th><td>对比记录 #${detail.comparison_id}</td></tr>`;
    if (detail.comparison_diff_summary) {
      const diff = detail.comparison_diff_summary;
      h += `<tr><th>对比差异</th><td>器材快照: ${diff.equipment_diff || 0}项 | 预约汇总: ${diff.reservation_diff || 0}项 | 损耗汇总: ${diff.loss_diff || 0}项 | 待归还: ${diff.pending_return_diff || 0}项</td></tr>`;
    }
  }
  h += '</tbody></table>';
  
  if (detail.invalid) {
    h += '<div style="background:#fdf2f2;border:1px solid #f5c6c6;border-radius:6px;padding:12px;margin-bottom:16px">';
    h += '<h4 style="margin-top:0;margin-bottom:8px;color:#c0392b">失效信息</h4>';
    h += `<p><strong>失效原因:</strong> ${escapeHtml(detail.invalidated_reason || '-')}</p>`;
    h += `<p><strong>失效操作人:</strong> ${escapeHtml(detail.invalidated_by_user_name || detail.invalidated_by_username || '-')}</p>`;
    h += `<p><strong>失效时间:</strong> ${detail.invalidated_at ? new Date(detail.invalidated_at).toLocaleString() : '-'}</p>`;
    if (detail.last_cleaned_stats) {
      const stats = detail.last_cleaned_stats;
      h += '<p><strong>清理统计:</strong></p>';
      h += '<ul style="margin:0;padding-left:20px">';
      h += `<li>清理说明数: ${stats.cleaned_notes || 0}</li>`;
      h += `<li>清理对比数: ${stats.cleaned_comparisons || 0}</li>`;
      h += `<li>清理单周导出数: ${stats.cleaned_exports_single || 0}</li>`;
      h += `<li>清理对比导出数: ${stats.cleaned_exports_comparison || 0}</li>`;
      h += `<li>清理总导出数: ${stats.cleaned_exports_total || 0}</li>`;
      h += '</ul>';
    }
    h += '</div>';
  }
  
  showModal(`台账详情 #${detail.id}`, h);
}

const INV_STATUS_MAP = {
  draft: '草稿', locked: '已锁定', counting: '盘点中',
  diff_confirmed: '差异已确认', correcting: '纠偏中', completed: '已完成', cancelled: '已取消'
};
const INV_STATUS_CLASS = {
  draft: 'status-pending', locked: 'status-approved', counting: 'status-collected',
  diff_confirmed: 'status-partial', correcting: 'status-pending', completed: 'status-returned', cancelled: 'status-cancelled'
};
const INV_ITEM_STATUS_MAP = {
  pending: '待盘点', counted: '已盘点', diff_confirmed: '差异已确认',
  corrected: '已纠偏', conflict_blocked: '冲突拦截'
};
const INV_ITEM_STATUS_CLASS = {
  pending: 'status-pending', counted: 'status-approved', diff_confirmed: 'status-partial',
  corrected: 'status-returned', conflict_blocked: 'status-rejected'
};

async function loadInventoryCenter() {
  const isAdmin = ['admin', 'lab_manager'].includes(currentUser.role);
  const ab = document.getElementById('inventory-actions');
  if (isAdmin) {
    ab.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="showCreateInventoryBatchModal()">➕ 发起盘点批次</button>
        <select id="inv-filter-status" style="padding:6px 8px;border:1px solid #ddd;border-radius:4px" onchange="loadInventoryList()">
          <option value="">全部状态</option>
          ${Object.entries(INV_STATUS_MAP).map(([k,v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
        <input type="text" id="inv-filter-semester" placeholder="学期 (如 2025-2026-2)" style="padding:6px 8px;border:1px solid #ddd;border-radius:4px;width:160px" onchange="loadInventoryList()">
        <button class="btn" style="background:#eee;color:#555" onclick="document.getElementById('inv-filter-status').value='';document.getElementById('inv-filter-semester').value='';loadInventoryList()">重置</button>
      </div>
    `;
  } else {
    ab.innerHTML = '<p style="color:#666">您可查看与您课程相关的盘点结果，但不能修改数据。</p>';
  }
  await loadInventoryList();
}

async function loadInventoryList() {
  const isAdmin = ['admin', 'lab_manager'].includes(currentUser.role);
  const params = new URLSearchParams();
  const status = document.getElementById('inv-filter-status')?.value;
  const semester = document.getElementById('inv-filter-semester')?.value;
  if (status) params.append('status', status);
  if (semester) params.append('semester', semester);
  const q = params.toString();

  if (!isAdmin) {
    try {
      const items = await api('GET', '/api/inventory/teacher-items');
      if (items.length === 0) {
        document.getElementById('inventory-list').innerHTML = '<div class="empty-state">暂无与您课程相关的盘点结果</div>';
        return;
      }
      let h = '<table class="data-table"><thead><tr><th>批次号</th><th>学期</th><th>器材</th><th>账面数量</th><th>实盘数量</th><th>差异</th><th>状态</th></tr></thead><tbody>';
      items.forEach(i => {
        h += `<tr>
          <td>${escapeHtml(i.batch_no)}</td>
          <td>${escapeHtml(i.semester)}</td>
          <td>${escapeHtml(i.equipment_name)}</td>
          <td>${i.book_qty}</td>
          <td>${i.actual_qty != null ? i.actual_qty : '-'}</td>
          <td style="color:${i.diff_qty > 0 ? '#27ae60' : (i.diff_qty < 0 ? '#e74c3c' : '#7f8c8d')}">${i.diff_qty != null ? (i.diff_qty > 0 ? '+' : '') + i.diff_qty : '-'}</td>
          <td><span class="status-badge ${INV_ITEM_STATUS_CLASS[i.status] || ''}">${INV_ITEM_STATUS_MAP[i.status] || i.status}</span></td>
        </tr>`;
      });
      h += '</tbody></table>';
      document.getElementById('inventory-list').innerHTML = h;
    } catch (e) { toast(e.message, 'error'); }
    return;
  }

  try {
    const list = await api('GET', `/api/inventory/batches${q ? '?' + q : ''}`);
    if (list.length === 0) {
      document.getElementById('inventory-list').innerHTML = '<div class="empty-state">暂无盘点批次</div>';
      return;
    }
    let h = '<table class="data-table"><thead><tr><th>批次号</th><th>学期</th><th>实验室</th><th>状态</th><th>创建人</th><th>创建时间</th><th>操作</th></tr></thead><tbody>';
    list.forEach(b => {
      h += `<tr>
        <td><a href="#" onclick="showInventoryBatchDetail(${b.id});return false">${escapeHtml(b.batch_no)}</a></td>
        <td>${escapeHtml(b.semester)}</td>
        <td>${escapeHtml(b.lab_name || '-')}</td>
        <td><span class="status-badge ${INV_STATUS_CLASS[b.status] || ''}">${INV_STATUS_MAP[b.status] || b.status}</span></td>
        <td>${escapeHtml(b.created_by_name || '-')}</td>
        <td class="log-time">${new Date(b.created_at).toLocaleString()}</td>
        <td class="action-cell">
          <button class="btn btn-xs btn-info" onclick="showInventoryBatchDetail(${b.id})">详情</button>
        </td>
      </tr>`;
    });
    h += '</tbody></table>';
    document.getElementById('inventory-list').innerHTML = h;
  } catch (e) { toast(e.message, 'error'); }
}

function showCreateInventoryBatchModal() {
  let h = `<form id="inv-create-form">
    <div class="form-group"><label>学期 *</label><input type="text" id="inv-semester" value="2025-2026-2" required placeholder="如 2025-2026-2"></div>
    <div class="form-group"><label>实验室（可选）</label><input type="text" id="inv-lab-name" placeholder="如 物理实验室A101"></div>
    <p class="form-hint">发起后将自动创建盘点批次并包含当前所有器材。需锁定后才能录入实盘数量。</p>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button type="submit" class="btn btn-primary" style="flex:1">创建批次</button>
      <button type="button" class="btn" style="flex:1;background:#eee;color:#555" onclick="closeModal()">取消</button>
    </div>
  </form>`;
  showModal('发起盘点批次', h);
  document.getElementById('inv-create-form').onsubmit = async (e) => {
    e.preventDefault();
    const semester = document.getElementById('inv-semester').value.trim();
    const labName = document.getElementById('inv-lab-name').value.trim();
    try {
      const batch = await api('POST', '/api/inventory/batches', { semester, lab_name: labName || null });
      closeModal();
      toast(`盘点批次 ${batch.batch_no} 已创建`);
      loadInventoryCenter();
    } catch (err) { toast(err.message, 'error'); }
  };
}

async function showInventoryBatchDetail(batchId) {
  try {
    const batch = await api('GET', `/api/inventory/batches/${batchId}`);
    const isAdmin = ['admin', 'lab_manager'].includes(currentUser.role);
    const isReadonly = !isAdmin;

    let h = '';
    h += `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px">
      <div style="background:#f8f9fa;padding:12px;border-radius:6px;border:1px solid #e9ecef">
        <div style="font-size:12px;color:#666;margin-bottom:4px">批次号 / 学期</div>
        <div style="font-weight:bold">${escapeHtml(batch.batch_no)} / ${escapeHtml(batch.semester)}</div>
      </div>
      <div style="background:#f8f9fa;padding:12px;border-radius:6px;border:1px solid #e9ecef">
        <div style="font-size:12px;color:#666;margin-bottom:4px">实验室 / 状态</div>
        <div style="font-weight:bold">${escapeHtml(batch.lab_name || '全部')} <span class="status-badge ${INV_STATUS_CLASS[batch.status] || ''}">${INV_STATUS_MAP[batch.status] || batch.status}</span></div>
      </div>
      <div style="background:#f8f9fa;padding:12px;border-radius:6px;border:1px solid #e9ecef">
        <div style="font-size:12px;color:#666;margin-bottom:4px">创建人 / 时间</div>
        <div style="font-weight:bold">${escapeHtml(batch.created_by_name || '-')} · ${new Date(batch.created_at).toLocaleString()}</div>
      </div>
    </div>`;

    if (batch.items && batch.items.length > 0) {
      h += '<table class="data-table compact"><thead><tr><th>器材</th><th>账面</th><th>实盘</th><th>已预约未领</th><th>待归还</th><th>已审批损耗</th><th>差异</th><th>状态</th>';
      if (isAdmin) h += '<th>操作</th>';
      h += '</tr></thead><tbody>';
      batch.items.forEach(item => {
        const diffColor = item.diff_qty > 0 ? '#27ae60' : (item.diff_qty < 0 ? '#e74c3c' : '#7f8c8d');
        const diffText = item.diff_qty != null ? (item.diff_qty > 0 ? '+' : '') + item.diff_qty : '-';
        h += `<tr style="${item.status === 'conflict_blocked' ? 'background:#fef9e7' : ''}">
          <td>${escapeHtml(item.equipment_name)}</td>
          <td>${item.book_qty}</td>
          <td>${item.actual_qty != null ? item.actual_qty : '-'}</td>
          <td>${item.pending_reserve_qty}</td>
          <td>${item.pending_return_qty}</td>
          <td>${item.approved_loss_qty}</td>
          <td style="color:${diffColor};font-weight:bold">${diffText}</td>
          <td><span class="status-badge ${INV_ITEM_STATUS_CLASS[item.status] || ''}">${INV_ITEM_STATUS_MAP[item.status] || item.status}</span></td>`;
        if (isAdmin) {
          h += '<td class="action-cell">';
          if (['locked', 'counting'].includes(batch.status) && item.actual_qty == null) {
            h += `<button class="btn btn-xs btn-info" onclick="showRecordItemModal(${batchId}, ${item.id}, '${escapeHtml(item.equipment_name)}', ${item.book_qty})">录入</button>`;
          }
          if (item.status === 'conflict_blocked') {
            const ci = item.conflict_info ? JSON.parse(item.conflict_info) : null;
            h += `<span style="color:#e74c3c;font-size:12px" title="${ci ? ci.reason : '冲突'}">⚠️冲突</span>`;
          }
          if (['diff_confirmed', 'correcting'].includes(batch.status) && item.diff_qty !== 0 && item.status !== 'corrected' && item.status !== 'conflict_blocked') {
            h += `<button class="btn btn-xs btn-success" onclick="doCorrectItem(${batchId}, ${item.id})">纠偏</button>`;
          }
          if (['diff_confirmed', 'correcting'].includes(batch.status) && item.status === 'conflict_blocked') {
            h += `<button class="btn btn-xs btn-warning" onclick="doResolveConflict(${batchId}, ${item.id})">解决冲突</button>`;
          }
          h += '</td>';
        }
      });
      h += '</tbody></table>';
    }

    if (isAdmin) {
      h += '<div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">';
      if (batch.status === 'draft') {
        h += `<button class="btn btn-primary" onclick="doLockBatch(${batchId})">🔒 锁定盘点范围</button>`;
        h += `<button class="btn btn-danger" onclick="doCancelBatch(${batchId})">取消批次</button>`;
      }
      if (['locked', 'counting'].includes(batch.status)) {
        const allRecorded = batch.items.every(i => i.actual_qty != null);
        if (allRecorded) {
          h += `<button class="btn btn-warning" onclick="doCalculateDiff(${batchId})">📊 计算差异</button>`;
        } else {
          h += `<span style="color:#999;padding:6px 12px">请先录入所有器材的实盘数量</span>`;
        }
        h += `<button class="btn btn-danger" onclick="doCancelBatch(${batchId})">取消批次</button>`;
      }
      if (batch.status === 'counting') {
        h += `<button class="btn btn-warning" onclick="doCalculateDiff(${batchId})">📊 计算差异</button>`;
      }
      if (batch.status === 'diff_confirmed') {
        const hasConflicts = batch.items.some(i => i.status === 'conflict_blocked');
        if (hasConflicts) {
          h += `<span style="color:#e74c3c;padding:6px 12px">⚠️ 存在冲突项，请先解决冲突再批量纠偏</span>`;
        } else {
          h += `<button class="btn btn-success" onclick="doCorrectAll(${batchId})">✅ 批量纠偏</button>`;
        }
      }
      if (batch.status === 'correcting') {
        const remaining = batch.items.filter(i => i.diff_qty !== 0 && i.status !== 'corrected' && i.status !== 'conflict_blocked');
        if (remaining.length > 0) {
          h += `<button class="btn btn-success" onclick="doCorrectAll(${batchId})">✅ 继续批量纠偏</button>`;
        }
      }
      h += `<a href="/api/inventory/batches/${batchId}/export-csv" class="btn btn-info" target="_blank">📥 导出CSV</a>`;
      h += `<button class="btn btn-secondary" onclick="closeModal()">关闭</button>`;
      h += '</div>';
    }

    showModal(`盘点批次 · ${batch.batch_no}`, h);
  } catch (e) { toast(e.message, 'error'); }
}

function showRecordItemModal(batchId, itemId, eqName, bookQty) {
  let h = `<form id="inv-record-form">
    <div class="form-group"><label>器材: <strong>${eqName}</strong> (账面: ${bookQty})</label></div>
    <div class="form-group"><label>实盘数量 *</label><input type="number" id="inv-actual-qty" min="0" value="${bookQty}" required></div>
    <div class="form-group"><label>缺失原因</label><input type="text" id="inv-missing-reason" placeholder="如有差异请说明原因"></div>
    <div class="form-group"><label>备注</label><input type="text" id="inv-notes" placeholder="其他备注"></div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button type="submit" class="btn btn-primary" style="flex:1">确认录入</button>
      <button type="button" class="btn" style="flex:1;background:#eee;color:#555" onclick="closeModal()">取消</button>
    </div>
  </form>`;
  showModal('录入实盘数量', h);
  document.getElementById('inv-record-form').onsubmit = async (e) => {
    e.preventDefault();
    const actualQty = parseInt(document.getElementById('inv-actual-qty').value);
    const missingReason = document.getElementById('inv-missing-reason').value.trim();
    const notes = document.getElementById('inv-notes').value.trim();
    try {
      await api('PUT', `/api/inventory/batches/${batchId}/record`, {
        item_id: itemId, actual_qty: actualQty, missing_reason: missingReason || null, notes: notes || null
      });
      closeModal();
      toast('实盘数据已录入');
      showInventoryBatchDetail(batchId);
    } catch (err) { toast(err.message, 'error'); }
  };
}

async function doLockBatch(batchId) {
  if (!confirm('确认锁定盘点范围？锁定后批次将进入盘点状态。')) return;
  try {
    await api('PUT', `/api/inventory/batches/${batchId}/lock`);
    toast('盘点范围已锁定');
    showInventoryBatchDetail(batchId);
  } catch (e) { toast(e.message, 'error'); }
}

async function doCalculateDiff(batchId) {
  try {
    const result = await api('POST', `/api/inventory/batches/${batchId}/calculate-diff`);
    if (result.conflicts && result.conflicts.length > 0) {
      toast(`差异计算完成，发现 ${result.conflicts.length} 项冲突需要处理`, 'warn');
    } else {
      toast(`差异计算完成，共 ${result.diff_items} 项有差异`);
    }
    showInventoryBatchDetail(batchId);
  } catch (e) { toast(e.message, 'error'); }
}

async function doConfirmDiff(batchId) {
  if (!confirm('确认差异？确认后将进入纠偏阶段。')) return;
  try {
    await api('PUT', `/api/inventory/batches/${batchId}/confirm-diff`);
    toast('差异已确认');
    showInventoryBatchDetail(batchId);
  } catch (e) { toast(e.message, 'error'); }
}

async function doCorrectItem(batchId, itemId) {
  if (!confirm('确认对该器材执行库存纠偏？')) return;
  try {
    const r = await api('PUT', `/api/inventory/batches/${batchId}/correct-item/${itemId}`);
    toast(`纠偏完成: ${r.old_total} → ${r.new_total} (差异 ${r.diff_qty > 0 ? '+' : ''}${r.diff_qty})`);
    showInventoryBatchDetail(batchId);
  } catch (e) { toast(e.message, 'error'); }
}

async function doResolveConflict(batchId, itemId) {
  if (!confirm('确认解决冲突并执行纠偏？仅当流转中的器材已归还/领用后才可执行。')) return;
  try {
    const r = await api('PUT', `/api/inventory/batches/${batchId}/resolve-conflict/${itemId}`);
    toast(`冲突已解决并纠偏: ${r.old_total} → ${r.new_total}`);
    showInventoryBatchDetail(batchId);
  } catch (e) { toast(e.message, 'error'); }
}

async function doCorrectAll(batchId) {
  if (!confirm('确认批量纠偏所有有差异且无冲突的器材？此操作将直接修改库存数量。')) return;
  try {
    const r = await api('PUT', `/api/inventory/batches/${batchId}/correct-all`);
    toast(`批量纠偏完成: 成功 ${r.corrected} 项, 失败 ${r.failed} 项`);
    showInventoryBatchDetail(batchId);
  } catch (e) { toast(e.message, 'error'); }
}

async function doCancelBatch(batchId) {
  if (!confirm('确认取消此盘点批次？')) return;
  try {
    await api('PUT', `/api/inventory/batches/${batchId}/cancel`);
    toast('批次已取消');
    closeModal();
    loadInventoryCenter();
  } catch (e) { toast(e.message, 'error'); }
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
  
  if (['admin','lab_manager'].includes(currentUser.role)) {
    document.querySelectorAll('.nav-admin-only').forEach(el => {
      el.style.display = 'block';
    });
  } else {
    document.querySelectorAll('.nav-admin-only').forEach(el => {
      el.style.display = 'none';
    });
  }
  
  switchPage('dashboard');
}

document.getElementById('modal-overlay').onclick = (e) => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
};

const MAKEUP_STATUS_MAP = {
  pending: '待审批', resubmitted: '重新提交待审', approved: '审批通过',
  rejected: '已驳回', cancelled: '已取消', revoked: '已撤销', completed: '已完成'
};
const MAKEUP_STATUS_CLASS = {
  pending: 'status-pending', resubmitted: 'status-pending', approved: 'status-approved',
  rejected: 'status-rejected', cancelled: 'status-cancelled', revoked: 'status-rejected', completed: 'status-collected'
};
const MAKEUP_TYPE_MAP = { makeup: '补课', swap_class: '换班', reschedule: '调时间' };

let currentMakeupTab = 'list';
let makeupFilters = { status: '', type: '', teacher_id: '', course_id: '', class_id: '', request_no: '', date_start: '', date_end: '' };
let makeupLogFilters = { action: '', user_id: '', keyword: '', date_start: '', date_end: '' };
let makeupCache = { courses: [], classes: [], classrooms: [], students: [] };

function switchMakeupTab(tab) {
  currentMakeupTab = tab;
  document.querySelectorAll('.makeup-tab').forEach(b => b.classList.toggle('active', b.dataset.mtab === tab));
  document.querySelectorAll('.makeup-tab-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById('makeup-tab-' + tab);
  if (panel) panel.classList.add('active');
  loadMakeupTab(tab);
}

async function loadMakeupCenter() {
  document.querySelectorAll('.makeup-tab').forEach(btn => {
    btn.onclick = () => switchMakeupTab(btn.dataset.mtab);
  });

  if (['admin', 'lab_manager'].includes(currentUser.role)) {
    document.querySelectorAll('#page-makeup-center .nav-admin-only').forEach(el => { el.style.display = ''; });
  } else {
    document.querySelectorAll('#page-makeup-center .nav-admin-only').forEach(el => { el.style.display = 'none'; });
  }

  const [stats, courses, classes, classrooms, students] = await Promise.all([
    api('GET', '/api/makeup/stats'),
    api('GET', '/api/courses'),
    api('GET', '/api/classes'),
    api('GET', '/api/makeup/classrooms'),
    api('GET', '/api/makeup/students')
  ]);
  makeupCache = { courses, classes, classrooms, students };

  document.getElementById('makeup-stats').innerHTML = `
    <div class="stat-card"><div class="stat-value">${stats.total || 0}</div><div class="stat-label">申请总数</div></div>
    <div class="stat-card"><div class="stat-value" style="color:#f39c12">${(stats.pending || 0) + (stats.resubmitted || 0)}</div><div class="stat-label">待处理</div></div>
    <div class="stat-card"><div class="stat-value" style="color:#27ae60">${stats.approved || 0}</div><div class="stat-label">已通过</div></div>
    <div class="stat-card"><div class="stat-value" style="color:#e74c3c">${(stats.rejected || 0) + (stats.revoked || 0) + (stats.cancelled || 0)}</div><div class="stat-label">未通过</div></div>
    <div class="stat-card"><div class="stat-value">${(stats.by_type || {}).makeup || 0}</div><div class="stat-label">补课申请</div></div>
    <div class="stat-card"><div class="stat-value">${(stats.by_type || {}).swap_class || 0}</div><div class="stat-label">换班申请</div></div>
    <div class="stat-card"><div class="stat-value">${(stats.by_type || {}).reschedule || 0}</div><div class="stat-label">调时间申请</div></div>
  `;

  switchMakeupTab(currentMakeupTab);
}

async function loadMakeupTab(tab) {
  if (tab === 'list') await loadMakeupList();
  else if (tab === 'submit') renderMakeupSubmitForm();
  else if (tab === 'queue') await loadMakeupQueue();
  else if (tab === 'logs') await loadMakeupLogs();
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function loadMakeupList() {
  const filters = makeupFilters;
  const params = new URLSearchParams();
  Object.keys(filters).forEach(k => { if (filters[k]) params.append(k, filters[k]); });
  const q = params.toString();
  const list = await api('GET', `/api/makeup/requests${q ? '?' + q : ''}`);
  const { courses, classes } = makeupCache;

  const fb = document.getElementById('makeup-filters');
  fb.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <select id="mf-status" style="padding:6px 8px;border:1px solid #ddd;border-radius:4px">
        <option value="">全部状态</option>
        ${Object.entries(MAKEUP_STATUS_MAP).map(([k,v]) => `<option value="${k}" ${filters.status===k?'selected':''}>${v}</option>`).join('')}
      </select>
      <select id="mf-type" style="padding:6px 8px;border:1px solid #ddd;border-radius:4px">
        <option value="">全部类型</option>
        ${Object.entries(MAKEUP_TYPE_MAP).map(([k,v]) => `<option value="${k}" ${filters.type===k?'selected':''}>${v}</option>`).join('')}
      </select>
      <select id="mf-course" style="padding:6px 8px;border:1px solid #ddd;border-radius:4px">
        <option value="">全部课程</option>
        ${courses.map(c => `<option value="${c.id}" ${String(filters.course_id)===String(c.id)?'selected':''}>${c.name}</option>`).join('')}
      </select>
      <select id="mf-class" style="padding:6px 8px;border:1px solid #ddd;border-radius:4px">
        <option value="">全部班级</option>
        ${classes.map(cl => `<option value="${cl.id}" ${String(filters.class_id)===String(cl.id)?'selected':''}>${cl.name}</option>`).join('')}
      </select>
      <input type="text" id="mf-no" placeholder="申请单号..." value="${filters.request_no||''}" style="width:140px;padding:6px 8px;border:1px solid #ddd;border-radius:4px">
      <input type="date" id="mf-ds" value="${filters.date_start||''}" style="padding:6px 8px;border:1px solid #ddd;border-radius:4px">
      ~
      <input type="date" id="mf-de" value="${filters.date_end||''}" style="padding:6px 8px;border:1px solid #ddd;border-radius:4px">
      <button class="btn btn-primary" onclick="applyMakeupFilters()">🔍 筛选</button>
      <button class="btn" style="background:#eee;color:#555" onclick="resetMakeupFilters()">重置</button>
      <button class="btn btn-success" onclick="exportMakeupCsv()" style="margin-left:auto">📊 导出CSV</button>
      ${['admin','lab_manager'].includes(currentUser.role) ? '<button class="btn btn-info" onclick="showMakeupImportModal()">📤 导入JSON恢复</button>' : ''}
    </div>
  `;

  if (list.length === 0) {
    document.getElementById('makeup-list').innerHTML = '<div class="empty-state">暂无申请记录</div>';
    return;
  }

  let h = '<table class="data-table"><thead><tr><th>单号</th><th>类型</th><th>课程</th><th>班级</th><th>申请人</th><th>新日期/时间/教室</th><th>课时</th><th>状态</th><th>操作</th></tr></thead><tbody>';
  list.forEach(r => {
    const newInfo = r.new_date ? `${r.new_date || ''} ${r.new_start_time || ''}-${r.new_end_time || ''}<br>${r.new_classroom_name || (r.new_class_id ? r.new_class_name : '') || ''}`
      : (r.new_class_name ? `换班至: ${r.new_class_name}` : '-');
    h += `<tr>
      <td><a href="#" onclick="showMakeupDetail(${r.id});return false">${escapeHtml(r.request_no)}</a></td>
      <td>${MAKEUP_TYPE_MAP[r.type] || r.type}</td>
      <td>${escapeHtml(r.course_name)}</td>
      <td>${escapeHtml(r.class_name)}${r.new_class_name && r.new_class_name !== r.class_name ? ' → ' + escapeHtml(r.new_class_name) : ''}</td>
      <td>${escapeHtml(r.teacher_name)}</td>
      <td style="font-size:12px">${newInfo}</td>
      <td>${r.hours}</td>
      <td><span class="status-badge ${MAKEUP_STATUS_CLASS[r.status]}">${MAKEUP_STATUS_MAP[r.status] || r.status}</span></td>
      <td class="action-cell">
        <button class="btn btn-xs btn-info" onclick="showMakeupDetail(${r.id})">详情</button>
      </td>
    </tr>`;
  });
  h += '</tbody></table>';
  document.getElementById('makeup-list').innerHTML = h;
}

function applyMakeupFilters() {
  makeupFilters = {
    status: document.getElementById('mf-status').value,
    type: document.getElementById('mf-type').value,
    course_id: document.getElementById('mf-course').value,
    class_id: document.getElementById('mf-class').value,
    request_no: document.getElementById('mf-no').value.trim(),
    date_start: document.getElementById('mf-ds').value,
    date_end: document.getElementById('mf-de').value,
    teacher_id: ''
  };
  loadMakeupList();
}

function resetMakeupFilters() {
  makeupFilters = { status: '', type: '', teacher_id: '', course_id: '', class_id: '', request_no: '', date_start: '', date_end: '' };
  loadMakeupList();
}

async function exportMakeupCsv() {
  const params = new URLSearchParams();
  Object.keys(makeupFilters).forEach(k => { if (makeupFilters[k]) params.append(k, makeupFilters[k]); });
  const q = params.toString();
  try {
    const res = await fetch(`/api/makeup/export/csv${q ? '?' + q : ''}`, { credentials: 'include' });
    if (!res.ok) throw new Error('导出失败');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const disp = res.headers.get('Content-Disposition');
    a.download = disp && disp.includes('filename=') ? disp.split('filename=')[1].replace(/"/g, '') : `makeup-requests.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('导出成功');
  } catch (e) { toast(e.message, 'error'); }
}

function showMakeupImportModal() {
  let h = '<div class="form-group"><label>选择补课/调课申请 JSON 文件</label>';
  h += '<input type="file" id="makeup-import-file" accept=".json,application/json" required>';
  h += '<p class="form-hint">支持数组或 {"requests":[...]} 结构。重复单号会自动跳过，冲突时间不导入，缺失字段会跳过并记录。</p>';
  h += '</div>';
  h += `<div style="margin-top:16px;display:flex;gap:8px">`;
  h += `<button id="mk-imp-confirm" class="btn btn-primary" style="flex:1">开始导入</button>`;
  h += `<button id="mk-imp-cancel" class="btn" style="flex:1;background:#eee;color:#555">取消</button>`;
  h += `</div>`;
  showModal('导入历史申请（恢复）', h);
  document.getElementById('mk-imp-cancel').onclick = closeModal;
  document.getElementById('mk-imp-confirm').onclick = async () => {
    const file = document.getElementById('makeup-import-file').files[0];
    if (!file) { toast('请先选择文件', 'warn'); return; }
    const btn = document.getElementById('mk-imp-confirm');
    btn.disabled = true; btn.textContent = '导入中...';
    try {
      const text = await file.text();
      let data; try { data = JSON.parse(text); } catch(e) { throw new Error('JSON 解析失败'); }
      const r = await api('POST', '/api/makeup/import/json', data);
      closeModal();
      const msg = `导入完成: 成功${r.imported}条, 跳过${r.skipped}条(重复${r.duplicates}/冲突${r.conflicts}), 失败${r.failed}条`;
      toast(msg, r.imported > 0 ? 'info' : 'warn');
      loadMakeupCenter();
    } catch(e) {
      btn.disabled = false; btn.textContent = '开始导入';
      toast(e.message, 'error');
    }
  };
}

function renderMakeupSubmitForm() {
  const { courses, classes, classrooms } = makeupCache;
  const myCourses = currentUser.role === 'teacher' ? courses.filter(c => c.teacher_id === currentUser.id) : courses;

  let h = '';
  h += '<form id="makeup-submit-form" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">';
  h += `<div class="form-group"><label>申请类型 *</label>
    <select id="mk-type" required onchange="updateMakeupFormVisibility()">
      <option value="makeup">补课（指定新日期时间）</option>
      <option value="swap_class">换班（转到其他班级）</option>
      <option value="reschedule">调时间（同班级调时间）</option>
    </select></div>`;
  h += `<div class="form-group"><label>课程 *</label>
    <select id="mk-course" required onchange="refreshClassOptions()">
      ${myCourses.map(c => `<option value="${c.id}" data-teacher="${c.teacher_id}">${c.name}</option>`).join('')}
    </select></div>`;
  h += `<div class="form-group"><label>原班级 *</label><select id="mk-class" required></select></div>`;
  h += `<div class="form-group"><label>课时 *</label><input type="number" id="mk-hours" min="0.5" step="0.5" value="2" required></div>`;
  h += `<div class="form-group makeup-original-fields"><label>原排课日期</label><input type="date" id="mk-odate"></div>`;
  h += `<div class="form-group makeup-original-fields"><label>原排课时段</label>
    <div style="display:flex;gap:8px"><input type="time" id="mk-ostart" style="flex:1"> ~ <input type="time" id="mk-oend" style="flex:1"></div></div>`;
  h += `<div class="form-group makeup-original-fields"><label>原教室</label>
    <select id="mk-oclassroom"><option value="">--</option>${classrooms.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}</select></div>`;
  h += `<div class="form-group makeup-target-classroom"><label>新教室</label>
    <select id="mk-nclassroom"><option value="">--</option>${classrooms.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}</select></div>`;
  h += `<div class="form-group makeup-target-date"><label>新日期 *</label><input type="date" id="mk-ndate"></div>`;
  h += `<div class="form-group makeup-target-date"><label>新时段 *</label>
    <div style="display:flex;gap:8px"><input type="time" id="mk-nstart" style="flex:1" value="08:00"> ~ <input type="time" id="mk-nend" style="flex:1" value="10:00"></div></div>`;
  h += `<div class="form-group makeup-target-class"><label>目标班级 *</label><select id="mk-nclass"></select></div>`;
  h += `<div class="form-group"><label>指定学员（留空=全班）</label>
    <select id="mk-students" multiple size="4" style="min-height:80px"></select>
    <p class="form-hint">Windows按住Ctrl、Mac按住Cmd多选</p></div>`;
  h += `<div class="form-group" style="grid-column:1/-1"><label>申请原因 *</label><textarea id="mk-reason" rows="3" required placeholder="请说明补课/换班/调时间的具体原因..."></textarea></div>`;
  h += `<div id="mk-conflict-hint" style="grid-column:1/-1;display:none" class="conflict-box"></div>`;
  h += `<div style="grid-column:1/-1;display:flex;gap:8px">
    <button type="button" class="btn btn-secondary" onclick="precheckMakeupConflicts()">🔍 预检冲突</button>
    <button type="submit" class="btn btn-primary" style="flex:1">提交申请</button>
    <button type="reset" class="btn" style="background:#eee;color:#555">重置表单</button>
  </div>`;
  h += '</form>';

  document.getElementById('makeup-submit-form').innerHTML = h;
  refreshClassOptions();
  updateMakeupFormVisibility();

  document.getElementById('mk-class').onchange = refreshStudentOptions;

  document.getElementById('makeup-submit-form').onsubmit = async (e) => {
    e.preventDefault();
    const type = document.getElementById('mk-type').value;
    const courseId = parseInt(document.getElementById('mk-course').value);
    const classId = parseInt(document.getElementById('mk-class').value);
    const studentSel = document.getElementById('mk-students');
    const studentIds = Array.from(studentSel.selectedOptions).map(o => parseInt(o.value));
    const body = {
      type, course_id: courseId, class_id: classId,
      student_ids: studentIds.length > 0 ? studentIds : null,
      hours: parseFloat(document.getElementById('mk-hours').value),
      reason: document.getElementById('mk-reason').value.trim(),
      original_date: document.getElementById('mk-odate').value || null,
      original_start_time: document.getElementById('mk-ostart').value || null,
      original_end_time: document.getElementById('mk-oend').value || null,
      original_classroom_id: document.getElementById('mk-oclassroom').value ? parseInt(document.getElementById('mk-oclassroom').value) : null,
      new_date: document.getElementById('mk-ndate').value || null,
      new_start_time: document.getElementById('mk-nstart').value || null,
      new_end_time: document.getElementById('mk-nend').value || null,
      new_classroom_id: document.getElementById('mk-nclassroom').value ? parseInt(document.getElementById('mk-nclassroom').value) : null,
      new_class_id: document.getElementById('mk-nclass').value ? parseInt(document.getElementById('mk-nclass').value) : null
    };
    try {
      const r = await api('POST', '/api/makeup/requests', body);
      toast(`申请已提交，单号 ${r.request_no}`);
      switchMakeupTab('list');
    } catch (err) {
      if (err.message.includes('时间冲突') && err.conflicts) {
        renderConflictBox(err.conflicts);
      } else {
        toast(err.message, 'error');
      }
    }
  };
}

function updateMakeupFormVisibility() {
  const t = document.getElementById('mk-type').value;
  const needDate = ['makeup', 'reschedule'].includes(t);
  const needClass = t === 'swap_class';
  document.querySelectorAll('.makeup-target-date').forEach(el => el.style.display = needDate ? '' : 'none');
  document.querySelectorAll('.makeup-target-class').forEach(el => el.style.display = needClass ? '' : 'none');
  document.querySelectorAll('.makeup-target-classroom').forEach(el => el.style.display = needDate ? '' : 'none');
  if (needClass) { const nc = document.getElementById('mk-nclass'); if (nc && nc.options.length === 0) refreshTargetClassOptions(); }
}

function refreshClassOptions() {
  const cid = parseInt(document.getElementById('mk-course').value);
  const sel = document.getElementById('mk-class');
  sel.innerHTML = makeupCache.classes.filter(c => c.course_id === cid).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  refreshTargetClassOptions();
  refreshStudentOptions();
}

function refreshTargetClassOptions() {
  const cid = parseInt(document.getElementById('mk-course').value);
  const sel = document.getElementById('mk-nclass');
  if (!sel) return;
  sel.innerHTML = makeupCache.classes.filter(c => c.course_id === cid).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
}

async function refreshStudentOptions() {
  const classId = parseInt(document.getElementById('mk-class').value);
  const sel = document.getElementById('mk-students');
  if (!sel || !classId) return;
  try {
    const list = await api('GET', `/api/makeup/students-by-class/${classId}`);
    sel.innerHTML = list.map(s => `<option value="${s.id}">${s.student_no} - ${s.name}</option>`).join('');
  } catch(e) {}
}

async function precheckMakeupConflicts() {
  const t = document.getElementById('mk-type').value;
  const classId = parseInt(document.getElementById('mk-class').value);
  const courseSel = document.getElementById('mk-course');
  const teacherId = parseInt(courseSel.selectedOptions[0]?.dataset.teacher || currentUser.id);
  const studentSel = document.getElementById('mk-students');
  const studentIds = Array.from(studentSel.selectedOptions).map(o => parseInt(o.value));
  const needDate = ['makeup', 'reschedule'].includes(t);
  const date = needDate ? document.getElementById('mk-ndate').value : null;
  const start = needDate ? document.getElementById('mk-nstart').value : null;
  const end = needDate ? document.getElementById('mk-nend').value : null;
  const classroomId = document.getElementById('mk-nclassroom').value ? parseInt(document.getElementById('mk-nclassroom').value) : null;
  const nClassId = t === 'swap_class' ? parseInt(document.getElementById('mk-nclass').value) : null;
  if (needDate && (!date || !start || !end)) { toast('请先填写新日期和时段', 'warn'); return; }
  try {
    const r = await api('POST', '/api/makeup/check-conflicts', {
      teacher_id: teacherId, classroom_id: classroomId, student_ids: studentIds,
      date, start_time: start, end_time: end,
      class_id: classId, new_class_id: nClassId
    });
    if (r.has_conflict) renderConflictBox(r.conflicts);
    else {
      const box = document.getElementById('mk-conflict-hint');
      box.style.display = 'block';
      box.className = 'conflict-box conflict-ok';
      box.innerHTML = '✅ 未检测到教师/教室/学员时间冲突，可以提交。';
    }
  } catch(e) { toast(e.message, 'error'); }
}

function renderConflictBox(conflicts) {
  const box = document.getElementById('mk-conflict-hint');
  box.style.display = 'block';
  box.className = 'conflict-box conflict-error';
  let h = '⚠️ 检测到时间冲突：<ul style="margin:8px 0 0 0;padding-left:20px">';
  if (conflicts.teacher && conflicts.teacher.length) {
    h += '<li><strong>教师时间冲突:</strong><ul style="padding-left:20px">';
    conflicts.teacher.forEach(c => h += `<li>${c.date} ${c.start}-${c.end} (来源:${c.type==='schedule'?'固定课表':'其他申请'}${c.class_id?` class#${c.class_id}`:''})</li>`);
    h += '</ul></li>';
  }
  if (conflicts.classroom && conflicts.classroom.length) {
    h += '<li><strong>教室占用冲突:</strong><ul style="padding-left:20px">';
    conflicts.classroom.forEach(c => h += `<li>${c.date} ${c.start}-${c.end} (${c.type==='schedule'?'固定课表':'其他申请'})</li>`);
    h += '</ul></li>';
  }
  if (conflicts.student && conflicts.student.length) {
    h += '<li><strong>学员时间冲突:</strong><ul style="padding-left:20px">';
    const seen = new Set();
    conflicts.student.forEach(c => {
      const k = `${c.student_id}|${c.date}|${c.start}|${c.end}`;
      if (seen.has(k)) return; seen.add(k);
      h += `<li>${c.student_name||('学员#'+c.student_id)} (${c.student_no||''}) ${c.date} ${c.start}-${c.end} (${c.type==='schedule'?'固定课表':'其他申请'})</li>`;
    });
    h += '</ul></li>';
  }
  h += '</ul>';
  box.innerHTML = h;
}

async function loadMakeupQueue() {
  const list = await api('GET', '/api/makeup/queue/pending');
  if (list.length === 0) {
    document.getElementById('makeup-queue').innerHTML = '<div class="empty-state">✅ 太棒了！当前没有待处理的申请</div>';
    return;
  }
  let h = '<table class="data-table"><thead><tr><th>单号</th><th>类型</th><th>申请人</th><th>课程/班级</th><th>安排</th><th>提交时间</th><th>操作</th></tr></thead><tbody>';
  list.forEach(r => {
    h += `<tr>
      <td><a href="#" onclick="showMakeupDetail(${r.id});return false">${escapeHtml(r.request_no)}</a></td>
      <td>${MAKEUP_TYPE_MAP[r.type] || r.type} <span class="status-badge ${MAKEUP_STATUS_CLASS[r.status]}">${MAKEUP_STATUS_MAP[r.status]||r.status}</span></td>
      <td>${escapeHtml(r.teacher_name)}</td>
      <td>${escapeHtml(r.course_name)} / ${escapeHtml(r.class_name)}${r.new_class_name ? ' → ' + escapeHtml(r.new_class_name) : ''}</td>
      <td style="font-size:12px">${r.new_date?r.new_date+' '+r.new_start_time+'-'+r.new_end_time:''}<br>${r.new_classroom_name||''}</td>
      <td class="log-time">${new Date(r.created_at).toLocaleString()}</td>
      <td class="action-cell">
        <button class="btn btn-sm btn-success" onclick="quickApproveMakeup(${r.id})">通过</button>
        <button class="btn btn-sm btn-danger" onclick="quickRejectMakeup(${r.id})">驳回</button>
        <button class="btn btn-xs btn-info" onclick="showMakeupDetail(${r.id})">详情</button>
      </td></tr>`;
  });
  h += '</tbody></table>';
  document.getElementById('makeup-queue').innerHTML = h;
}

async function quickApproveMakeup(id) {
  if (!confirm('确认通过该申请？')) return;
  try {
    await api('PUT', `/api/makeup/requests/${id}/approve`, { comment: '快速通过' });
    toast('审批通过'); loadMakeupTab('queue'); loadMakeupList();
    loadMakeupCenter();
  } catch (e) { toast(e.message, 'error'); }
}

function quickRejectMakeup(id) { showRejectMakeupModal(id, true); }

function showRejectMakeupModal(id, fromQueue) {
  let h = `<form id="mk-reject-form">
    <div class="form-group"><label>驳回原因 *</label>
    <textarea id="mk-reject-reason" rows="4" required placeholder="请填写驳回原因，教师可以据此修改后重新提交..."></textarea></div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button type="submit" class="btn btn-danger" style="flex:1">确认驳回</button>
      <button type="button" class="btn" style="flex:1;background:#eee;color:#555" onclick="closeModal()">取消</button>
    </div></form>`;
  showModal('驳回申请', h);
  document.getElementById('mk-reject-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('PUT', `/api/makeup/requests/${id}/reject`, { reason: document.getElementById('mk-reject-reason').value.trim() });
      closeModal(); toast('已驳回');
      if (fromQueue) { loadMakeupTab('queue'); loadMakeupCenter(); }
      else { showMakeupDetail(id); loadMakeupList(); }
    } catch(err) { toast(err.message, 'error'); }
  };
}

async function showMakeupDetail(id) {
  const d = await api('GET', `/api/makeup/requests/${id}`);
  const isOwner = currentUser.role === 'teacher' && d.teacher_id === currentUser.id;
  const isAdmin = ['admin', 'lab_manager'].includes(currentUser.role);
  let h = '';
  h += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
    <div style="background:#f8f9fa;padding:12px;border-radius:6px;border:1px solid #e9ecef">
      <div style="font-size:12px;color:#666;margin-bottom:4px">申请单号</div>
      <div style="font-weight:bold">${escapeHtml(d.request_no)}</div>
    </div>
    <div style="background:#f8f9fa;padding:12px;border-radius:6px;border:1px solid #e9ecef">
      <div style="font-size:12px;color:#666;margin-bottom:4px">类型 / 状态</div>
      <div style="font-weight:bold">${MAKEUP_TYPE_MAP[d.type]} / <span class="status-badge ${MAKEUP_STATUS_CLASS[d.status]}">${MAKEUP_STATUS_MAP[d.status]}</span></div>
    </div>
  </div>`;

  h += '<table class="data-table compact" style="margin-bottom:16px"><tbody>';
  h += `<tr><th style="width:120px">申请人</th><td>${escapeHtml(d.teacher_name)} (ID: ${d.teacher_id})</td></tr>`;
  h += `<tr><th>课程 / 班级</th><td>${escapeHtml(d.course_name)} / ${escapeHtml(d.class_name)}</td></tr>`;
  h += `<tr><th>原安排</th><td>${d.original_date||''} ${d.original_start_time||''}-${d.original_end_time||''} ${d.original_classroom_name?'@ '+escapeHtml(d.original_classroom_name):''}</td></tr>`;
  h += `<tr><th>新安排</th><td>${d.new_date?d.new_date+' '+d.new_start_time+'-'+d.new_end_time:''} ${d.new_classroom_name?'@ '+escapeHtml(d.new_classroom_name):''} ${d.new_class_name?'→ 班级: '+escapeHtml(d.new_class_name):''} ${d.new_teacher_name?'/ 代课: '+escapeHtml(d.new_teacher_name):''}</td></tr>`;
  h += `<tr><th>课时</th><td>${d.hours} 课时${d.hours_written_back?' <span style="color:#27ae60">(已回写)</span>':''}</td></tr>`;
  const stuText = (d.student_ids_parsed && d.student_ids_parsed.length) ? `指定${d.student_ids_parsed.length}人` : '全班学员';
  h += `<tr><th>学员范围</th><td>${stuText}</td></tr>`;
  h += `<tr><th>申请原因</th><td>${escapeHtml(d.reason)}</td></tr>`;
  if (d.approval_comment) h += `<tr><th>审批意见</th><td style="color:#1e8449">${escapeHtml(d.approval_comment)}${d.approved_at?' <span style="color:#999;font-size:12px">'+new Date(d.approved_at).toLocaleString()+'</span>':''}</td></tr>`;
  if (d.reject_reason) h += `<tr><th>驳回原因</th><td style="color:#c0392b">${escapeHtml(d.reject_reason)}${d.rejected_at?' <span style="color:#999;font-size:12px">'+new Date(d.rejected_at).toLocaleString()+'</span>':''}</td></tr>`;
  if (d.revoke_reason) h += `<tr><th>撤销原因</th><td style="color:#d35400">${escapeHtml(d.revoke_reason)}${d.revoked_at?' <span style="color:#999;font-size:12px">'+new Date(d.revoked_at).toLocaleString()+'</span>':''}</td></tr>`;
  h += `<tr><th>提交时间</th><td>${new Date(d.created_at).toLocaleString()}${d.resubmitted_count?` <span style="color:#999">(第${d.resubmitted_count}次重提)`:''}</td></tr>`;
  h += '</tbody></table>';

  if (d.writebacks && d.writebacks.length) {
    h += '<h4 style="margin:16px 0 8px">课时回写记录</h4>';
    h += '<table class="data-table compact"><thead><tr><th>时间</th><th>原课时</th><th>差异</th><th>新课时</th><th>操作人</th></tr></thead><tbody>';
    d.writebacks.forEach(w => {
      h += `<tr><td>${new Date(w.created_at).toLocaleString()}</td><td>${w.original_hours}</td><td style="color:${w.delta_hours>=0?'#27ae60':'#c0392b'}">${w.delta_hours>=0?'+':''}${w.delta_hours}</td><td>${w.new_hours}</td><td>${escapeHtml(w.operator_name||'')}</td></tr>`;
    });
    h += '</tbody></table>';
  }

  if (d.approvals && d.approvals.length) {
    h += '<h4 style="margin:16px 0 8px">操作追溯（审批链）</h4>';
    h += '<table class="data-table compact"><thead><tr><th>时间</th><th>动作</th><th>操作人</th><th>备注</th></tr></thead><tbody>';
    const actMap = { submit: '提交', approve: '审批通过', reject: '驳回', revoke: '撤销审批', cancel: '取消申请', resubmit: '重新提交', writeback: '课时回写', import: '导入恢复' };
    d.approvals.forEach(a => {
      h += `<tr><td>${new Date(a.created_at).toLocaleString()}</td><td>${actMap[a.action]||a.action}</td><td>${escapeHtml(a.operator_name||'')}</td><td>${escapeHtml(a.comment||'')}</td></tr>`;
    });
    h += '</tbody></table>';
  }

  h += '<div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">';
  if (isAdmin && ['pending', 'resubmitted'].includes(d.status)) {
    h += `<button class="btn btn-success" onclick="quickApproveMakeup(${d.id})">✅ 审批通过</button>`;
    h += `<button class="btn btn-danger" onclick="showRejectMakeupModal(${d.id})">❌ 驳回</button>`;
  }
  if (isAdmin && d.status === 'approved' && !d.hours_written_back) {
    h += `<button class="btn btn-info" onclick="doWritebackHours(${d.id})">💾 课时回写</button>`;
  }
  if (isAdmin && d.status === 'approved') {
    h += `<button class="btn btn-warning" onclick="showRevokeMakeupModal(${d.id})">↩️ 撤销审批</button>`;
  }
  if (['pending', 'resubmitted'].includes(d.status) && isOwner) {
    h += `<button class="btn" style="background:#95a5a6;color:#fff" onclick="cancelMakeup(${d.id})">取消申请</button>`;
  }
  if (d.status === 'approved' && isAdmin) {
    h += `<button class="btn" style="background:#95a5a6;color:#fff" onclick="cancelMakeup(${d.id})">管理员取消</button>`;
  }
  if (['rejected', 'revoked', 'cancelled'].includes(d.status) && (isOwner || isAdmin)) {
    h += `<button class="btn btn-primary" onclick="showResubmitMakeupModal(${d.id})">🔁 重新提交</button>`;
  }
  h += '</div>';

  showModal(`申请详情 #${d.id} ${d.request_no}`, h);
}

async function doWritebackHours(id) {
  if (!confirm('确认执行课时回写？回写后不可撤销。')) return;
  try {
    const r = await api('PUT', `/api/makeup/requests/${id}/writeback-hours`);
    toast(`回写成功：原${r.writeback.original_hours} → 新${r.writeback.new_hours} (${r.writeback.delta_hours>=0?'+':''}${r.writeback.delta_hours})`);
    showMakeupDetail(id); loadMakeupCenter();
  } catch(e) { toast(e.message, 'error'); }
}

function showRevokeMakeupModal(id) {
  let h = `<form id="mk-revoke-form"><div class="form-group"><label>撤销原因 *</label>
    <textarea id="mk-revoke-reason" rows="4" required placeholder="说明撤销审批的原因..."></textarea></div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button type="submit" class="btn btn-warning" style="flex:1">确认撤销</button>
      <button type="button" class="btn" style="flex:1;background:#eee;color:#555" onclick="closeModal()">取消</button>
    </div></form>`;
  showModal('撤销已通过的审批', h);
  document.getElementById('mk-revoke-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('PUT', `/api/makeup/requests/${id}/revoke`, { reason: document.getElementById('mk-revoke-reason').value.trim() });
      closeModal(); toast('已撤销审批'); showMakeupDetail(id); loadMakeupCenter();
    } catch(err) { toast(err.message, 'error'); }
  };
}

async function cancelMakeup(id) {
  const reason = prompt('请输入取消原因（可选）：') || '';
  try {
    await api('PUT', `/api/makeup/requests/${id}/cancel`, { reason });
    closeModal(); toast('申请已取消'); loadMakeupCenter();
  } catch(e) { toast(e.message, 'error'); }
}

function showResubmitMakeupModal(id) {
  const html = `<div style="background:#fff8e1;border:1px solid #ffe082;padding:12px;border-radius:6px;margin-bottom:12px">
    💡 重新提交会创建新的申请单（关联原单），你可以修改日期/时间/教室/班级/学员等信息。
    若不修改，系统会沿用原单内容；若原冲突未解决，系统会再次拦截。
  </div>
  <form id="mk-resubmit-form">
    <div class="form-group"><label>修改申请原因（可选，不填则沿用）</label>
      <textarea id="mk-resubmit-reason" rows="3" placeholder="如需修改申请原因请填写..."></textarea></div>
    <div class="form-group"><label>提交说明（本次为何重提）</label>
      <textarea id="mk-resubmit-submit" rows="2" placeholder="说明修改了什么..."></textarea></div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button type="submit" class="btn btn-primary" style="flex:1">直接重提（沿用原信息）</button>
      <button type="button" class="btn" style="flex:1;background:#eee;color:#555" onclick="closeModal()">取消</button>
    </div>
  </form>`;
  showModal('重新提交申请', html);
  document.getElementById('mk-resubmit-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const body = {};
      const reason = document.getElementById('mk-resubmit-reason').value.trim();
      const sr = document.getElementById('mk-resubmit-submit').value.trim();
      if (reason) body.reason = reason;
      if (sr) body.submit_reason = sr;
      const r = await api('POST', `/api/makeup/requests/${id}/resubmit`, body);
      closeModal(); toast(`重新提交成功，新单号 ${r.request_no}`);
      switchMakeupTab('list'); loadMakeupCenter();
    } catch (err) {
      if (err.message && err.message.includes('时间冲突')) toast('仍有时间冲突，请在列表中新建申请修改具体信息', 'error');
      else toast(err.message, 'error');
    }
  };
}

async function loadMakeupLogs() {
  const params = new URLSearchParams();
  Object.keys(makeupLogFilters).forEach(k => { if (makeupLogFilters[k]) params.append(k, makeupLogFilters[k]); });
  const q = params.toString();
  const list = await api('GET', `/api/makeup/logs${q ? '?' + q : ''}`);
  const { users } = makeupCache;
  const allUsers = await api('GET', '/api/users');

  const fb = document.getElementById('makeup-log-filters');
  fb.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <select id="mlf-action" style="padding:6px 8px;border:1px solid #ddd;border-radius:4px">
        <option value="">全部动作</option>
        ${['submit','approve','reject','revoke','cancel','resubmit','writeback','import','conflict_blocked','export_csv','import_requests'].map(a => `<option value="makeup_${a}" ${makeupLogFilters.action==='makeup_'+a?'selected':''}>${a}</option>`).join('')}
      </select>
      <select id="mlf-user" style="padding:6px 8px;border:1px solid #ddd;border-radius:4px">
        <option value="">全部用户</option>
        ${allUsers.map(u => `<option value="${u.id}" ${String(makeupLogFilters.user_id)===String(u.id)?'selected':''}>${u.name}</option>`).join('')}
      </select>
      <input type="text" id="mlf-kw" placeholder="关键字..." value="${makeupLogFilters.keyword||''}" style="width:140px;padding:6px 8px;border:1px solid #ddd;border-radius:4px">
      <input type="date" id="mlf-ds" value="${makeupLogFilters.date_start||''}" style="padding:6px 8px;border:1px solid #ddd;border-radius:4px">
      ~
      <input type="date" id="mlf-de" value="${makeupLogFilters.date_end||''}" style="padding:6px 8px;border:1px solid #ddd;border-radius:4px">
      <button class="btn btn-primary" onclick="applyMakeupLogFilters()">🔍 筛选</button>
      <button class="btn" style="background:#eee;color:#555" onclick="resetMakeupLogFilters()">重置</button>
    </div>`;

  fb.querySelector('#mlf-action').onchange = applyMakeupLogFilters;
  fb.querySelector('#mlf-user').onchange = applyMakeupLogFilters;
  document.getElementById('mlf-kw').onkeyup = (e) => { if (e.key === 'Enter') applyMakeupLogFilters(); };
  document.getElementById('mlf-ds').onchange = applyMakeupLogFilters;
  document.getElementById('mlf-de').onchange = applyMakeupLogFilters;

  if (list.length === 0) {
    document.getElementById('makeup-log-list').innerHTML = '<div class="empty-state">暂无操作日志</div>';
    return;
  }

  let h = '<table class="data-table"><thead><tr><th>时间</th><th>动作</th><th>用户</th><th>详情</th></tr></thead><tbody>';
  list.forEach(l => {
    const details = typeof l.details === 'object' ? JSON.stringify(l.details, null, 2) : (l.details || '');
    h += `<tr><td class="log-time">${new Date(l.created_at).toLocaleString()}</td><td>${l.action}</td><td>${l.user_name||'-'}</td><td class="log-details"><pre>${escapeHtml(details)}</pre></td></tr>`;
  });
  h += '</tbody></table>';
  document.getElementById('makeup-log-list').innerHTML = h;
}

function applyMakeupLogFilters() {
  const getEl = (id) => document.getElementById(id);
  makeupLogFilters = {
    action: getEl('mlf-action') ? getEl('mlf-action').value : '',
    user_id: getEl('mlf-user') ? getEl('mlf-user').value : '',
    keyword: getEl('mlf-kw') ? getEl('mlf-kw').value.trim() : '',
    date_start: getEl('mlf-ds') ? getEl('mlf-ds').value : '',
    date_end: getEl('mlf-de') ? getEl('mlf-de').value : ''
  };
  loadMakeupLogs();
}

function resetMakeupLogFilters() {
  makeupLogFilters = { action: '', user_id: '', keyword: '', date_start: '', date_end: '' };
  loadMakeupLogs();
}

let repairCache = { courses: [], equipment: [], orders: [] };

async function loadRepairCenter() {
  repairCache.courses = await api('GET', '/api/courses');
  repairCache.equipment = await api('GET', '/api/equipment');

  document.querySelectorAll('.makeup-tab[data-rtab]').forEach(t => {
    t.onclick = () => switchRepairTab(t.dataset.rtab);
  });

  if (['admin','lab_manager'].includes(currentUser.role)) {
    document.querySelectorAll('.nav-admin-only[data-rtab]').forEach(t => { t.style.display = 'inline-block'; });
  }

  await loadRepairStats();
  await loadRepairList();
}

function switchRepairTab(tabName) {
  document.querySelectorAll('.makeup-tab[data-rtab]').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.makeup-tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`[data-rtab="${tabName}"]`).classList.add('active');
  document.getElementById(`repair-tab-${tabName}`).classList.add('active');

  if (tabName === 'list') loadRepairList();
  else if (tabName === 'submit') loadRepairSubmitForm();
  else if (tabName === 'schedules') loadRepairSchedules();
  else if (tabName === 'import') loadRepairImportExport();
  else if (tabName === 'approvals') loadRepairApprovals();
}

async function loadRepairStats() {
  try {
    const stats = await api('GET', '/api/repair/stats');
    const sg = document.getElementById('repair-stats');
    sg.innerHTML = `
      <div class="stat-card"><div class="stat-value">${stats.total||0}</div><div class="stat-label">维修单总数</div></div>
      <div class="stat-card"><div class="stat-value">${stats.pending||0}</div><div class="stat-label">待处理</div></div>
      <div class="stat-card"><div class="stat-value">${stats.repairing||0}</div><div class="stat-label">维修中</div></div>
      <div class="stat-card"><div class="stat-value">${stats.returned||0}</div><div class="stat-label">已回库</div></div>
      <div class="stat-card"><div class="stat-value">${stats.scrapped||0}</div><div class="stat-label">已报废</div></div>
    `;
  } catch(e) { console.error(e); }
}

async function loadRepairList() {
  const list = await api('GET', '/api/repair/orders');
  repairCache.orders = list;

  const fb = document.getElementById('repair-filters');
  fb.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <select id="rf-status" style="padding:6px 8px;border:1px solid #ddd;border-radius:4px">
        <option value="">全部状态</option>
        ${Object.entries(REPAIR_STATUS_MAP).map(([k,v]) => `<option value="${k}">${v}</option>`).join('')}
      </select>
      <input type="text" id="rf-kw" placeholder="搜索单号/器材/课程..." style="width:200px;padding:6px 8px;border:1px solid #ddd;border-radius:4px">
      <button class="btn btn-primary" onclick="applyRepairFilters()">🔍 筛选</button>
    </div>`;

  renderRepairList(list);
}

function applyRepairFilters() {
  const status = document.getElementById('rf-status').value;
  const kw = document.getElementById('rf-kw').value.trim().toLowerCase();
  let list = repairCache.orders;
  if (status) list = list.filter(o => o.status === status);
  if (kw) list = list.filter(o =>
    o.order_no.toLowerCase().includes(kw) ||
    o.equipment_name.toLowerCase().includes(kw) ||
    o.course_name.toLowerCase().includes(kw)
  );
  renderRepairList(list);
}

function renderRepairList(list) {
  if (list.length === 0) {
    document.getElementById('repair-list').innerHTML = '<div class="empty-state">暂无维修单</div>';
    return;
  }

  let h = '<table class="data-table"><thead><tr><th>单号</th><th>课程</th><th>器材</th><th>数量</th><th>故障现象</th><th>状态</th><th>上报人</th><th>操作</th></tr></thead><tbody>';
  list.forEach(o => {
    h += `<tr>
      <td><a href="#" onclick="showRepairDetail(${o.id});return false">${o.order_no}</a></td>
      <td>${escapeHtml(o.course_name)}</td>
      <td>${escapeHtml(o.equipment_name)}</td>
      <td>${o.qty}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(o.fault_phenomenon||'')}</td>
      <td><span class="status-badge ${REPAIR_STATUS_CLASS[o.status]}">${REPAIR_STATUS_MAP[o.status]}</span></td>
      <td>${escapeHtml(o.reporter_name||'')}</td>
      <td class="action-cell">`;
    h += `<button class="btn btn-sm btn-info" onclick="showRepairDetail(${o.id})">详情</button>`;
    h += '</td></tr>';
  });
  h += '</tbody></table>';
  document.getElementById('repair-list').innerHTML = h;
}

async function loadRepairSubmitForm() {
  const isTeacher = currentUser.role === 'teacher';
  const myCourses = isTeacher ? repairCache.courses.filter(c => c.teacher_id === currentUser.id) : repairCache.courses;

  let h = '<form id="repair-submit-form-inner">';
  h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">';
  h += '<div class="form-group"><label>课程 *</label><select name="course_id" required>';
  myCourses.forEach(c => { h += `<option value="${c.id}">${escapeHtml(c.name)}</option>`; });
  h += '</select></div>';
  h += '<div class="form-group"><label>器材 *</label><select name="equipment_id" required>';
  repairCache.equipment.forEach(e => { h += `<option value="${e.id}">${escapeHtml(e.name)} (可用:${e.available_qty})</option>`; });
  h += '</select></div>';
  h += '<div class="form-group"><label>数量 *</label><input type="number" name="qty" min="1" value="1" required></div>';
  h += '</div>';
  h += '<div class="form-group"><label>故障现象 *</label><textarea name="fault_phenomenon" rows="3" required placeholder="请详细描述故障现象..."></textarea></div>';
  h += '<div class="form-group"><label>处理建议</label><textarea name="handling_suggestion" rows="2" placeholder="您建议如何处理（可选）..."></textarea></div>';
  h += '<button type="submit" class="btn btn-primary btn-block">提交故障单</button></form>';

  document.getElementById('repair-submit-form').innerHTML = h;
  document.getElementById('repair-submit-form-inner').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const data = Object.fromEntries(fd);
      const conflict = await api('GET', `/api/repair/check-conflict/${data.equipment_id}`);
      if (conflict.hasConflict) {
        if (!confirm(`该器材存在流转冲突：${conflict.message}\n是否仍要提交故障单？`)) return;
      }
      const r = await api('POST', '/api/repair/orders', data);
      toast(`故障单提交成功：${r.order_no}`);
      switchRepairTab('list');
      loadRepairStats();
    } catch(err) { toast(err.message, 'error'); }
  };
}

async function showRepairDetail(id) {
  const d = await api('GET', `/api/repair/orders/${id}`);
  const isAdmin = ['admin','lab_manager'].includes(currentUser.role);
  const isOwner = d.reporter_id === currentUser.id;
  const canEdit = isAdmin || (isOwner && ['pending','reviewing'].includes(d.status));

  let h = '';
  h += `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px">
    <div style="background:#f8f9fa;padding:12px;border-radius:6px;border:1px solid #e9ecef">
      <div style="font-size:12px;color:#666;margin-bottom:4px">维修单号</div>
      <div style="font-weight:bold">${escapeHtml(d.order_no)}</div>
    </div>
    <div style="background:#f8f9fa;padding:12px;border-radius:6px;border:1px solid #e9ecef">
      <div style="font-size:12px;color:#666;margin-bottom:4px">状态</div>
      <div style="font-weight:bold"><span class="status-badge ${REPAIR_STATUS_CLASS[d.status]}">${REPAIR_STATUS_MAP[d.status]}</span></div>
    </div>
    <div style="background:#f8f9fa;padding:12px;border-radius:6px;border:1px solid #e9ecef">
      <div style="font-size:12px;color:#666;margin-bottom:4px">处理决定</div>
      <div style="font-weight:bold">${d.decision?REPAIR_DECISION_MAP[d.decision]:'待决定'}</div>
    </div>
  </div>`;

  h += '<table class="data-table compact" style="margin-bottom:16px"><tbody>';
  h += `<tr><th style="width:120px">上报人</th><td>${escapeHtml(d.reporter_name||'')} (ID: ${d.reporter_id})</td></tr>`;
  h += `<tr><th>课程 / 器材</th><td>${escapeHtml(d.course_name)} / ${escapeHtml(d.equipment_name)} × ${d.qty}</td></tr>`;
  h += `<tr><th>故障现象</th><td>${escapeHtml(d.fault_phenomenon||'')}</td></tr>`;
  if (d.handling_suggestion) h += `<tr><th>处理建议</th><td>${escapeHtml(d.handling_suggestion)}</td></tr>`;
  if (d.approver_name) h += `<tr><th>审批人</th><td>${escapeHtml(d.approver_name)}${d.approval_comment?' / 意见: '+escapeHtml(d.approval_comment):''}</td></tr>`;
  if (d.repair_vendor) h += `<tr><th>维修厂商</th><td>${escapeHtml(d.repair_vendor)}${d.repair_cost?' / 费用: ¥'+d.repair_cost:''}</td></tr>`;
  if (d.return_note) h += `<tr><th>回库备注</th><td>${escapeHtml(d.return_note)}</td></tr>`;
  h += `<tr><th>创建时间</th><td>${new Date(d.created_at).toLocaleString()}</td></tr>`;
  if (d.updated_at) h += `<tr><th>更新时间</th><td>${new Date(d.updated_at).toLocaleString()}</td></tr>`;
  h += '</tbody></table>';

  if (d.approvals && d.approvals.length) {
    h += '<h4 style="margin:16px 0 8px">审批记录</h4>';
    h += '<table class="data-table compact"><thead><tr><th>时间</th><th>动作</th><th>操作人</th><th>备注</th></tr></thead><tbody>';
    const actMap = {
      create: '创建', review: '审核', deactivate: '停用', repair: '安排维修',
      replace: '安排换件', scrap: '报废', return: '回库', cancel: '取消',
      revoke: '撤销', schedule: '排期', import: '导入'
    };
    d.approvals.forEach(a => {
      h += `<tr><td>${new Date(a.created_at).toLocaleString()}</td><td>${actMap[a.action]||a.action}</td><td>${escapeHtml(a.operator_name||'')}</td><td>${escapeHtml(a.comment||'')}</td></tr>`;
    });
    h += '</tbody></table>';
  }

  h += '<div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">';
  if (isAdmin && d.status === 'pending') {
    h += `<button class="btn btn-info" onclick="repairAction(${d.id}, 'review')">开始审核</button>`;
  }
  if (isAdmin && ['reviewing','deactivated'].includes(d.status)) {
    h += `<button class="btn btn-warning" onclick="showRepairActionModal(${d.id}, 'deactivate')">停用器材</button>`;
    h += `<button class="btn btn-success" onclick="showRepairActionModal(${d.id}, 'repair')">安排维修</button>`;
    h += `<button class="btn btn-success" onclick="showRepairActionModal(${d.id}, 'replace')">安排换件</button>`;
    h += `<button class="btn btn-danger" onclick="showRepairActionModal(${d.id}, 'scrap')">报废器材</button>`;
  }
  if (isAdmin && ['repairing','replacing'].includes(d.status)) {
    h += `<button class="btn btn-success" onclick="showRepairActionModal(${d.id}, 'return')">回库复用</button>`;
  }
  if (isAdmin && !['returned','scrapped','cancelled','revoked'].includes(d.status)) {
    h += `<button class="btn btn-danger" onclick="showRepairActionModal(${d.id}, 'cancel')">取消</button>`;
  }
  if (isAdmin && ['deactivated','repairing','replacing'].includes(d.status)) {
    h += `<button class="btn btn-warning" onclick="showRepairActionModal(${d.id}, 'revoke')">撤销并恢复库存</button>`;
  }
  if (isOwner && ['pending','reviewing'].includes(d.status) && !isAdmin) {
    h += `<button class="btn" style="background:#95a5a6;color:#fff" onclick="showRepairActionModal(${d.id}, 'cancel')">取消申请</button>`;
  }
  h += '</div>';

  showModal(`维修单详情 ${d.order_no}`, h);
}

async function repairAction(id, action) {
  try {
    await api('PUT', `/api/repair/orders/${id}/${action}`);
    toast('操作成功');
    closeModal();
    loadRepairList();
    loadRepairStats();
  } catch(err) { toast(err.message, 'error'); }
}

function showRepairActionModal(id, action) {
  let title = '', h = '';
  const actionMap = {
    deactivate: { title: '停用器材', fields: ['reason'] },
    repair: { title: '安排维修', fields: ['vendor', 'scheduled_date', 'estimated_cost', 'reason'] },
    replace: { title: '安排换件', fields: ['reason'] },
    scrap: { title: '报废器材', fields: ['reason'] },
    return: { title: '回库复用', fields: ['actual_cost', 'return_note', 'actual_return_date'] },
    cancel: { title: '取消维修单', fields: ['reason'] },
    revoke: { title: '撤销并恢复库存', fields: ['reason'] }
  };

  const cfg = actionMap[action];
  title = cfg.title;

  h = `<form id="repair-action-form">`;
  if (cfg.fields.includes('vendor')) {
    h += '<div class="form-group"><label>维修厂商</label><input type="text" name="vendor" placeholder="如：XX仪器维修公司"></div>';
  }
  if (cfg.fields.includes('scheduled_date')) {
    h += '<div class="form-group"><label>计划维修日期</label><input type="date" name="scheduled_date"></div>';
  }
  if (cfg.fields.includes('estimated_cost')) {
    h += '<div class="form-group"><label>预估费用 (元)</label><input type="number" name="estimated_cost" min="0" step="0.01"></div>';
  }
  if (cfg.fields.includes('actual_cost')) {
    h += '<div class="form-group"><label>实际费用 (元)</label><input type="number" name="actual_cost" min="0" step="0.01"></div>';
  }
  if (cfg.fields.includes('return_note')) {
    h += '<div class="form-group"><label>回库备注</label><textarea name="return_note" rows="2" placeholder="维修情况说明..."></textarea></div>';
  }
  if (cfg.fields.includes('actual_return_date')) {
    h += '<div class="form-group"><label>实际归还日期</label><input type="date" name="actual_return_date"></div>';
  }
  if (cfg.fields.includes('reason')) {
    h += `<div class="form-group"><label>${action==='revoke'?'撤销原因':(action==='cancel'?'取消原因':'处理原因')} *</label><textarea name="reason" rows="3" required placeholder="请说明原因..."></textarea></div>`;
  }
  h += `<div style="display:flex;gap:8px;margin-top:12px">
    <button type="submit" class="btn btn-primary" style="flex:1">确认${cfg.title}</button>
    <button type="button" class="btn" style="flex:1;background:#eee;color:#555" onclick="closeModal()">取消</button>
  </div></form>`;

  showModal(title, h);
  document.getElementById('repair-action-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = Object.fromEntries(fd);
    try {
      await api('PUT', `/api/repair/orders/${id}/${action}`, data);
      toast('操作成功');
      closeModal();
      loadRepairList();
      loadRepairStats();
    } catch(err) { toast(err.message, 'error'); }
  };
}

async function loadRepairSchedules() {
  const list = await api('GET', '/api/repair/schedules');
  const ab = document.getElementById('repair-schedule-actions');
  ab.innerHTML = '<button class="btn btn-primary" onclick="showCreateScheduleModal()">+ 新建排期</button>';

  if (list.length === 0) {
    document.getElementById('repair-schedule-list').innerHTML = '<div class="empty-state">暂无维修排期</div>';
    return;
  }

  let h = '<table class="data-table"><thead><tr><th>ID</th><th>维修单号</th><th>器材</th><th>维修厂商</th><th>计划日期</th><th>预估费用</th><th>状态</th><th>操作</th></tr></thead><tbody>';
  list.forEach(s => {
    h += `<tr>
      <td>${s.id}</td>
      <td>${escapeHtml(s.order_no||'')}</td>
      <td>${escapeHtml(s.equipment_name||'')}</td>
      <td>${escapeHtml(s.vendor||'')}</td>
      <td>${s.scheduled_date||''}</td>
      <td>${s.estimated_cost?'¥'+s.estimated_cost:''}</td>
      <td><span class="status-badge ${REPAIR_SCHEDULE_STATUS_CLASS[s.status]||''}">${REPAIR_SCHEDULE_STATUS_MAP[s.status]||s.status||'待安排'}</span></td>
      <td class="action-cell">
        <button class="btn btn-sm btn-info" onclick="showEditScheduleModal(${s.id})">编辑</button>
      </td>
    </tr>`;
  });
  h += '</tbody></table>';
  document.getElementById('repair-schedule-list').innerHTML = h;
}

function showCreateScheduleModal() {
  let h = '<form id="schedule-form">';
  h += '<div class="form-group"><label>关联维修单</label><select name="order_id" required>';
  repairCache.orders.filter(o => ['pending','reviewing','deactivated','repairing'].includes(o.status)).forEach(o => {
    h += `<option value="${o.id}">${o.order_no} - ${o.equipment_name}</option>`;
  });
  h += '</select></div>';
  h += '<div class="form-group"><label>维修厂商 *</label><input type="text" name="vendor" required></div>';
  h += '<div class="form-group"><label>计划维修日期</label><input type="date" name="scheduled_date"></div>';
  h += '<div class="form-group"><label>预估费用 (元)</label><input type="number" name="estimated_cost" min="0" step="0.01"></div>';
  h += '<div class="form-group"><label>备注</label><textarea name="notes" rows="2"></textarea></div>';
  h += '<button type="submit" class="btn btn-primary btn-block">创建排期</button></form>';
  showModal('新建维修排期', h);
  document.getElementById('schedule-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('POST', '/api/repair/schedules', Object.fromEntries(fd));
      toast('排期创建成功');
      closeModal();
      loadRepairSchedules();
    } catch(err) { toast(err.message, 'error'); }
  };
}

async function showEditScheduleModal(id) {
  const schedules = await api('GET', '/api/repair/schedules');
  const s = schedules.find(x => x.id === id);
  if (!s) return;

  let h = `<form id="schedule-edit-form">
    <div class="form-group"><label>维修厂商</label><input type="text" name="vendor" value="${escapeHtml(s.vendor||'')}"></div>
    <div class="form-group"><label>计划维修日期</label><input type="date" name="scheduled_date" value="${s.scheduled_date||''}"></div>
    <div class="form-group"><label>预估费用 (元)</label><input type="number" name="estimated_cost" min="0" step="0.01" value="${s.estimated_cost||''}"></div>
    <div class="form-group"><label>实际费用 (元)</label><input type="number" name="actual_cost" min="0" step="0.01" value="${s.actual_cost||''}"></div>
    <div class="form-group"><label>取件日期</label><input type="date" name="pickup_date" value="${s.pickup_date||''}"></div>
    <div class="form-group"><label>归还日期</label><input type="date" name="return_date" value="${s.return_date||''}"></div>
    <div class="form-group"><label>状态</label><select name="status">
      ${Object.entries(REPAIR_SCHEDULE_STATUS_MAP).map(([k,v]) => `<option value="${k}" ${s.status===k?'selected':''}>${v}</option>`).join('')}
    </select></div>
    <div class="form-group"><label>备注</label><textarea name="notes" rows="2">${escapeHtml(s.notes||'')}</textarea></div>
    <button type="submit" class="btn btn-primary btn-block">保存修改</button>
  </form>`;
  showModal('编辑维修排期', h);
  document.getElementById('schedule-edit-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('PUT', `/api/repair/schedules/${id}`, Object.fromEntries(fd));
      toast('排期更新成功');
      closeModal();
      loadRepairSchedules();
    } catch(err) { toast(err.message, 'error'); }
  };
}

function loadRepairImportExport() {
  const ab = document.getElementById('repair-import-actions');
  ab.innerHTML = `
    <button class="btn btn-success" onclick="exportRepairCsv()">📤 导出 CSV</button>
    <button class="btn btn-primary" onclick="document.getElementById('repair-csv-input').click()">📥 导入 CSV</button>
    <input type="file" id="repair-csv-input" accept=".csv" style="display:none" onchange="importRepairCsv(event)">
  `;

  let h = '';
  h += '<div class="card" style="margin-bottom:16px">';
  h += '<h4 style="margin:0 0 12px 0">CSV 导入说明</h4>';
  h += '<p style="color:#666;margin:4px 0">必填列：<b>器材名称、数量、故障现象</b>（维修单号留空将自动生成）</p>';
  h += '<p style="color:#666;margin:4px 0">支持中文字段名：维修单号、状态、器材ID、器材名称、数量、课程ID、课程名称、班级ID、班级名称、故障现象、处理建议、处理决定、决定原因、上报人ID、上报人、审批人ID、审批人、审批时间、维修厂商、维修费用、排期日期、预计归还日期、实际归还日期、维修备注、创建时间、更新时间</p>';
  h += '<p style="color:#666;margin:4px 0">状态可选值：pending(待处理)、reviewing(审核中)、deactivated(已停用)、repairing(维修中)、replacing(换件中)、returned(已回库)、scrapped(已报废)、cancelled(已取消)、revoked(已撤销)</p>';
  h += '<p style="color:#d9534f;margin:4px 0">⚠️ 所有行校验通过后才会写入数据库，任何一行错误都会导致整体导入失败，不会写脏数据</p>';
  h += '</div>';

  h += '<div class="card">';
  h += '<h4 style="margin:0 0 12px 0">导入结果预览</h4>';
  h += '<div id="repair-import-result" class="empty-state">请选择 CSV 文件进行导入</div>';
  h += '</div>';

  document.getElementById('repair-import-form').innerHTML = h;
}

async function exportRepairCsv() {
  try {
    const res = await fetch('/api/repair/export/csv', { credentials: 'include' });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `repair_orders_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast('导出成功');
  } catch(err) { toast(err.message, 'error'); }
}

async function importRepairCsv(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const r = await api('POST', '/api/repair/import/csv', { csv_data: text });

    let h = '<div style="margin-bottom:12px">';
    h += `<p><b>导入结果：</b>成功 ${r.imported} 条，跳过 ${r.skipped} 条，失败 ${r.errors} 条</p>`;
    
    if (r.error_items && r.error_items.length) {
      h += '<div style="background:#ffebee;padding:8px;border-radius:4px;margin:8px 0;max-height:200px;overflow-y:auto">';
      h += '<b style="color:#c62828">错误详情：</b><ul style="margin:4px 0;padding-left:20px">';
      r.error_items.forEach(item => { 
        const errMsgs = Array.isArray(item.errors) ? item.errors.join('；') : (item.error || '未知错误');
        h += `<li style="color:#c62828">第 ${item.row} 行${item.order_no?`（${item.order_no}）`:''}：${escapeHtml(errMsgs)}</li>`; 
      });
      h += '</ul></div>';
    }
    
    if (r.skipped_items && r.skipped_items.length) {
      h += '<div style="background:#fff8e1;padding:8px;border-radius:4px;margin:8px 0;max-height:200px;overflow-y:auto">';
      h += '<b style="color:#f57f17">跳过项：</b><ul style="margin:4px 0;padding-left:20px">';
      r.skipped_items.forEach(item => { 
        h += `<li style="color:#f57f17">第 ${item.row} 行${item.order_no?`（${item.order_no}）`:''}：${escapeHtml(item.reason || '跳过')}</li>`; 
      });
      h += '</ul></div>';
    }
    h += '</div>';

    document.getElementById('repair-import-result').innerHTML = h;
    if (r.imported > 0) {
      loadRepairList();
      loadRepairStats();
    }
  } catch(err) { toast(err.message, 'error'); }
  event.target.value = '';
}

async function loadRepairApprovals() {
  const list = await api('GET', '/api/repair/orders');
  let allApprovals = [];
  for (const o of list) {
    try {
      const approvals = await api('GET', `/api/repair/orders/${o.id}/approvals`);
      approvals.forEach(a => {
        a.order_no = o.order_no;
        a.equipment_name = o.equipment_name;
      });
      allApprovals = allApprovals.concat(approvals);
    } catch(e) {}
  }

  allApprovals.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));

  if (allApprovals.length === 0) {
    document.getElementById('repair-approval-list').innerHTML = '<div class="empty-state">暂无审批记录</div>';
    return;
  }

  let h = '<table class="data-table"><thead><tr><th>时间</th><th>维修单号</th><th>器材</th><th>动作</th><th>操作人</th><th>备注</th></tr></thead><tbody>';
  const actMap = {
    submit: '提交', review: '审核', deactivate: '停用', repair: '安排维修',
    replace: '安排换件', scrap: '报废', return: '回库', cancel: '取消',
    revoke: '撤销', schedule: '排期', import: '导入'
  };
  allApprovals.forEach(a => {
    h += `<tr>
      <td>${new Date(a.created_at).toLocaleString()}</td>
      <td>${escapeHtml(a.order_no||'')}</td>
      <td>${escapeHtml(a.equipment_name||'')}</td>
      <td>${actMap[a.action]||a.action}</td>
      <td>${escapeHtml(a.operator_name||'')}</td>
      <td>${escapeHtml(a.comment||'')}</td>
    </tr>`;
  });
  h += '</tbody></table>';
  document.getElementById('repair-approval-list').innerHTML = h;
}

(async () => {
  try {
    const res = await api('GET', '/api/me');
    currentUser = res.user;
    showMainPage();
  } catch (e) {
    showLoginPage();
  }
})();
