let currentUser = null;
let coursesCache = [];
let classesCache = [];
let equipmentCache = [];

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
  if (['admin','lab_manager'].includes(currentUser.role)) {
    ab.innerHTML = '<button class="btn btn-primary" onclick="showSettlementModal()">执行周结转</button>';
  } else {
    ab.innerHTML = '';
  }

  let h = '';
  if (settlements.length === 0) {
    h = '<div class="empty-state">暂无结转记录</div>';
  } else {
    settlements.forEach(s => {
      h += '<div class="settlement-card">';
      h += `<div class="settlement-header"><h3>周次: ${s.week_key}</h3><span class="settlement-time">${new Date(s.settled_at).toLocaleString()}</span></div>`;
      h += '<div class="settlement-body">';
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
      h += `<div style="margin-top:12px"><a href="/api/export/${s.week_key}" class="btn btn-sm btn-info" target="_blank">📥 导出结转数据</a></div>`;
      h += '</div></div>';
    });
  }
  document.getElementById('settlement-list').innerHTML = h;
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
