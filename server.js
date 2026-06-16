const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = {};

function parseCookies(req) {
  const c = {};
  (req.headers.cookie || '').split(';').forEach(pair => {
    const [k, v] = pair.trim().split('=');
    if (k) c[k] = v;
  });
  return c;
}

function getSessionUser(req) {
  const cookies = parseCookies(req);
  const sid = cookies['sid'];
  if (!sid || !sessions[sid]) return null;
  return sessions[sid];
}

function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: '请先登录' });
  req.user = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ error: '请先登录' });
    if (!roles.includes(user.role)) return res.status(403).json({ error: '权限不足' });
    req.user = user;
    next();
  };
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password]);
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });

  const sid = crypto.randomBytes(16).toString('hex');
  const userData = { id: user.id, username: user.username, name: user.name, role: user.role };
  sessions[sid] = userData;

  db.addLog('login', user.id, user.name, `用户 ${user.name} 登录`);
  res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly`);
  res.json({ user: userData });
});

app.post('/api/logout', (req, res) => {
  const user = getSessionUser(req);
  if (user) {
    db.addLog('logout', user.id, user.name, `用户 ${user.name} 登出`);
    const cookies = parseCookies(req);
    const sid = cookies['sid'];
    if (sid) delete sessions[sid];
  }
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ok:true}));
app.get('/api/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  res.json({ user });
});

app.get('/api/users', requireAuth, (req, res) => {
  const users = db.all('SELECT id, username, name, role FROM users');
  res.json(users);
});

app.get('/api/equipment', requireAuth, (req, res) => {
  const list = db.all('SELECT * FROM equipment ORDER BY id');
  res.json(list);
});

app.put('/api/equipment/:id', requireRole('admin', 'lab_manager'), (req, res) => {
  const id = req.params.id;
  const { total_qty } = req.body;
  const eq = db.get('SELECT * FROM equipment WHERE id = ?', [id]);
  if (!eq) return res.status(404).json({ error: '器材不存在' });
  const diff = total_qty - eq.total_qty;
  const newAvail = eq.available_qty + diff;
  if (newAvail < 0) return res.status(400).json({ error: '调整后可用数量不能为负' });
  db.run('UPDATE equipment SET total_qty = ?, available_qty = ? WHERE id = ?', [total_qty, newAvail, id]);
  db.addLog('update_equipment', req.user.id, req.user.name, { equipment_id: id, old_total: eq.total_qty, new_total: total_qty });
  db.forceSave();
  res.json({ ok: true });
});

app.get('/api/courses', requireAuth, (req, res) => {
  const list = db.all('SELECT c.*, u.name AS teacher_name FROM courses c JOIN users u ON c.teacher_id = u.id ORDER BY c.id');
  res.json(list);
});

app.get('/api/classes', requireAuth, (req, res) => {
  const list = db.all('SELECT cl.*, c.name AS course_name FROM classes cl JOIN courses c ON cl.course_id = c.id ORDER BY cl.id');
  res.json(list);
});

app.post('/api/reservations', requireRole('teacher', 'admin'), (req, res) => {
  const { course_id, class_id, equipment_id, qty, week_key } = req.body;
  if (!course_id || !class_id || !equipment_id || !qty || qty <= 0) {
    return res.status(400).json({ error: '缺少必要参数或数量不合法' });
  }

  const course = db.get('SELECT * FROM courses WHERE id = ?', [course_id]);
  if (!course) return res.status(404).json({ error: '课程不存在' });
  if (req.user.role === 'teacher' && course.teacher_id !== req.user.id) {
    return res.status(403).json({ error: '只能预约自己负责的课程' });
  }

  const eq = db.get('SELECT * FROM equipment WHERE id = ?', [equipment_id]);
  if (!eq) return res.status(404).json({ error: '器材不存在' });

  if (eq.total_qty - eq.locked_qty < qty) {
    db.addLog('reservation_conflict', req.user.id, req.user.name, {
      equipment_id, requested: qty, available: eq.total_qty - eq.locked_qty
    });
    db.forceSave();
    return res.status(409).json({
      error: `库存不足：${eq.name} 可用 ${eq.total_qty - eq.locked_qty}，需 ${qty}`,
      available: eq.total_qty - eq.locked_qty,
      requested: qty
    });
  }

  const now = new Date().toISOString();
  const wk = week_key || db.getCurrentWeekKey();

  const resId = db.insertRun(
    'INSERT INTO reservations (course_id, class_id, equipment_id, qty, status, week_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [course_id, class_id, equipment_id, qty, 'pending', wk, now, now]
  );

  db.run('UPDATE equipment SET locked_qty = locked_qty + ? WHERE id = ?', [qty, equipment_id]);
  db.run('UPDATE equipment SET available_qty = available_qty - ? WHERE id = ?', [qty, equipment_id]);

  db.addLog('create_reservation', req.user.id, req.user.name, {
    reservation_id: resId, equipment_id, qty, week_key: wk
  });
  db.forceSave();

  const reservation = db.get('SELECT * FROM reservations WHERE id = ?', [resId]);
  res.json(reservation);
});

app.get('/api/reservations', requireAuth, (req, res) => {
  const list = db.all(`
    SELECT r.*, e.name AS equipment_name, c.name AS course_name, cl.name AS class_name
    FROM reservations r
    JOIN equipment e ON r.equipment_id = e.id
    JOIN courses c ON r.course_id = c.id
    JOIN classes cl ON r.class_id = cl.id
    ORDER BY r.created_at DESC
  `);
  res.json(list);
});

app.put('/api/reservations/:id/approve', requireRole('admin', 'lab_manager'), (req, res) => {
  const id = req.params.id;
  const r = db.get('SELECT * FROM reservations WHERE id = ?', [id]);
  if (!r) return res.status(404).json({ error: '预约不存在' });
  if (r.status !== 'pending') return res.status(400).json({ error: `当前状态为 ${r.status}，无法审批` });

  const now = new Date().toISOString();
  db.run("UPDATE reservations SET status = 'approved', updated_at = ? WHERE id = ?", [now, id]);
  db.addLog('approve_reservation', req.user.id, req.user.name, { reservation_id: id });
  db.forceSave();
  res.json({ ok: true, status: 'approved' });
});

app.put('/api/reservations/:id/collect', requireRole('teacher', 'admin'), (req, res) => {
  const id = req.params.id;
  const r = db.get('SELECT * FROM reservations WHERE id = ?', [id]);
  if (!r) return res.status(404).json({ error: '预约不存在' });
  if (r.status !== 'approved') return res.status(400).json({ error: `当前状态为 ${r.status}，无法领用` });

  const course = db.get('SELECT * FROM courses WHERE id = ?', [r.course_id]);
  if (req.user.role === 'teacher' && course.teacher_id !== req.user.id) {
    return res.status(403).json({ error: '只能领用自己课程的器材' });
  }

  const now = new Date().toISOString();
  db.run("UPDATE reservations SET status = 'collected', updated_at = ? WHERE id = ?", [now, id]);
  db.addLog('collect_equipment', req.user.id, req.user.name, { reservation_id: id, qty: r.qty });
  db.forceSave();
  res.json({ ok: true, status: 'collected' });
});

app.put('/api/reservations/:id/return', requireRole('teacher', 'admin'), (req, res) => {
  const id = req.params.id;
  const { return_qty } = req.body;
  const r = db.get('SELECT * FROM reservations WHERE id = ?', [id]);
  if (!r) return res.status(404).json({ error: '预约不存在' });
  if (!['collected', 'partially_returned'].includes(r.status)) {
    return res.status(400).json({ error: `当前状态为 ${r.status}，无法归还` });
  }

  const qty = return_qty || r.qty;
  if (qty <= 0 || qty > r.qty) return res.status(400).json({ error: '归还数量不合法' });

  const lossRows = db.all('SELECT COALESCE(SUM(qty),0) AS total FROM loss_reports WHERE reservation_id = ? AND status = ?', [id, 'approved']);
  const alreadyLost = lossRows[0] ? lossRows[0].total : 0;
  const maxReturn = r.qty - alreadyLost;
  if (qty > maxReturn) {
    return res.status(400).json({ error: `归还数量超出：已损耗 ${alreadyLost}，最多可归还 ${maxReturn}` });
  }

  const now = new Date().toISOString();
  const existingReturned = r.returned_qty || 0;
  const newReturned = existingReturned + qty;
  const newStatus = newReturned >= maxReturn ? 'returned' : 'partially_returned';

  db.run('UPDATE equipment SET available_qty = available_qty + ?, locked_qty = locked_qty - ? WHERE id = ?',
    [qty, qty, r.equipment_id]);
  db.run('UPDATE reservations SET status = ?, returned_qty = ?, updated_at = ? WHERE id = ?', [newStatus, newReturned, now, id]);

  db.addLog('return_equipment', req.user.id, req.user.name, {
    reservation_id: id, return_qty: qty, returned_total: newReturned, status: newStatus
  });
  db.forceSave();

  res.json({ ok: true, status: newStatus, returned: qty, returned_qty: newReturned });
});

app.post('/api/loss-reports', requireRole('teacher', 'admin'), (req, res) => {
  const { reservation_id, qty, reason } = req.body;
  if (!reservation_id || !qty || qty <= 0 || !reason) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  const r = db.get('SELECT * FROM reservations WHERE id = ?', [reservation_id]);
  if (!r) return res.status(404).json({ error: '预约不存在' });
  if (!['collected', 'partially_returned'].includes(r.status)) {
    return res.status(400).json({ error: '只能对已领用的器材申报损耗' });
  }

  const existingLoss = db.all('SELECT COALESCE(SUM(qty),0) AS total FROM loss_reports WHERE reservation_id = ?', [reservation_id]);
  const alreadyLost = existingLoss[0] ? existingLoss[0].total : 0;
  if (alreadyLost + qty > r.qty) {
    return res.status(400).json({ error: `损耗数量超出：预约 ${r.qty}，已申报损耗 ${alreadyLost}，本次申报 ${qty} 超出总量` });
  }

  const now = new Date().toISOString();
  const reportId = db.insertRun(
    'INSERT INTO loss_reports (reservation_id, equipment_id, qty, reporter_id, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [reservation_id, r.equipment_id, qty, req.user.id, 'pending', reason, now]
  );

  db.addLog('submit_loss_report', req.user.id, req.user.name, {
    report_id: reportId, reservation_id, qty, reason
  });
  db.forceSave();

  const report = db.get('SELECT * FROM loss_reports WHERE id = ?', [reportId]);
  res.json(report);
});

app.get('/api/loss-reports', requireAuth, (req, res) => {
  const list = db.all(`
    SELECT lr.*, e.name AS equipment_name, r.qty AS reservation_qty,
           reporter.name AS reporter_name, approver.name AS approver_name
    FROM loss_reports lr
    JOIN equipment e ON lr.equipment_id = e.id
    JOIN reservations r ON lr.reservation_id = r.id
    JOIN users reporter ON lr.reporter_id = reporter.id
    LEFT JOIN users approver ON lr.approver_id = approver.id
    ORDER BY lr.created_at DESC
  `);
  res.json(list);
});

app.put('/api/loss-reports/:id/approve', requireRole('admin', 'lab_manager'), (req, res) => {
  const id = req.params.id;
  const report = db.get('SELECT * FROM loss_reports WHERE id = ?', [id]);
  if (!report) return res.status(404).json({ error: '损耗记录不存在' });
  if (report.status !== 'pending') return res.status(400).json({ error: `当前状态为 ${report.status}，无法审批` });

  if (report.reporter_id === req.user.id) {
    db.addLog('self_approve_rejected', req.user.id, req.user.name, { report_id: id });
    db.forceSave();
    return res.status(403).json({ error: '不能审批自己提交的损耗申报' });
  }

  const now = new Date().toISOString();

  db.run('UPDATE loss_reports SET status = ?, approver_id = ?, approved_at = ? WHERE id = ?',
    ['approved', req.user.id, now, id]);

  db.run('UPDATE equipment SET total_qty = total_qty - ?, locked_qty = locked_qty - ? WHERE id = ?',
    [report.qty, report.qty, report.equipment_id]);

  const rsv = db.get('SELECT * FROM reservations WHERE id = ?', [report.reservation_id]);
  if (rsv) {
    const lossRows = db.all(
      'SELECT COALESCE(SUM(qty),0) AS total FROM loss_reports WHERE reservation_id = ? AND status = ?',
      [report.reservation_id, 'approved']
    );
    const totalApprovedLoss = lossRows[0] ? lossRows[0].total : 0;
    const ret = rsv.returned_qty || 0;
    if (ret + totalApprovedLoss >= rsv.qty) {
      db.run("UPDATE reservations SET status = 'returned', updated_at = ? WHERE id = ?", [now, report.reservation_id]);
      db.addLog('resolution_update_status_to_returned', req.user.id, req.user.name, {
        reservation_id: report.reservation_id,
        returned_qty: ret,
        approved_loss: totalApprovedLoss,
        reservation_qty: rsv.qty
      });
    }
  }

  db.addLog('approve_loss_report', req.user.id, req.user.name, {
    report_id: id, equipment_id: report.equipment_id, qty: report.qty
  });
  db.forceSave();

  res.json({ ok: true, status: 'approved' });
});

app.put('/api/loss-reports/:id/reject', requireRole('admin', 'lab_manager'), (req, res) => {
  const id = req.params.id;
  const report = db.get('SELECT * FROM loss_reports WHERE id = ?', [id]);
  if (!report) return res.status(404).json({ error: '损耗记录不存在' });
  if (report.status !== 'pending') return res.status(400).json({ error: `当前状态为 ${report.status}，无法操作` });

  if (report.reporter_id === req.user.id) {
    return res.status(403).json({ error: '不能审批自己提交的损耗申报' });
  }

  const now = new Date().toISOString();
  db.run('UPDATE loss_reports SET status = ?, approver_id = ?, approved_at = ? WHERE id = ?',
    ['rejected', req.user.id, now, id]);

  db.addLog('reject_loss_report', req.user.id, req.user.name, { report_id: id });
  db.forceSave();
  res.json({ ok: true, status: 'rejected' });
});

app.post('/api/settlements/weekly', requireRole('admin', 'lab_manager'), (req, res) => {
  const { week_key } = req.body;
  const wk = week_key || db.getCurrentWeekKey();

  const existingSettled = db.get(
    "SELECT * FROM weekly_settlements WHERE week_key = ? AND source = 'settled' AND revoked = 0",
    [wk]
  );
  if (existingSettled) {
    db.addLog('duplicate_settlement_rejected', req.user.id, req.user.name, { week_key: wk });
    db.forceSave();
    return res.status(409).json({ error: `${wk} 已完成结转，不可重复执行` });
  }

  const equipment = db.all('SELECT * FROM equipment ORDER BY id');
  const reservations = db.all('SELECT * FROM reservations WHERE week_key = ?', [wk]);
  const lossReports = db.all(`
    SELECT lr.* FROM loss_reports lr
    JOIN reservations r ON lr.reservation_id = r.id
    WHERE r.week_key = ? AND lr.status = 'approved'
  `, [wk]);

  const pendingReturns = db.all(`
    SELECT r.*, e.name AS equipment_name FROM reservations r
    JOIN equipment e ON r.equipment_id = e.id
    WHERE r.week_key = ? AND r.status IN ('collected', 'partially_returned')
  `, [wk]);

  const totals = {
    week_key: wk,
    equipment_snapshot: equipment.map(e => ({
      id: e.id, name: e.name,
      total: e.total_qty, available: e.available_qty, locked: e.locked_qty
    })),
    reservation_summary: {
      total: reservations.length,
      by_status: {}
    },
    loss_summary: {
      total_reports: lossReports.length,
      total_qty: lossReports.reduce((s, l) => s + l.qty, 0)
    },
    pending_returns: pendingReturns.map(pr => ({
      id: pr.id, equipment_name: pr.equipment_name, qty: pr.qty, status: pr.status
    }))
  };

  reservations.forEach(r => {
    totals.reservation_summary.by_status[r.status] = (totals.reservation_summary.by_status[r.status] || 0) + 1;
  });

  const now = new Date().toISOString();
  db.run(
    "INSERT INTO weekly_settlements (week_key, settled_at, totals, source, created_by) VALUES (?, ?, ?, 'settled', ?)",
    [wk, now, JSON.stringify(totals), req.user.id]
  );

  db.addLog('weekly_settlement', req.user.id, req.user.name, {
    week_key: wk, reservations: reservations.length, losses: lossReports.length
  });
  db.forceSave();

  const settlement = db.get(
    "SELECT * FROM weekly_settlements WHERE week_key = ? AND source = 'settled' AND revoked = 0 ORDER BY id DESC LIMIT 1",
    [wk]
  );
  settlement.totals = JSON.parse(settlement.totals);

  res.json(settlement);
});

app.delete('/api/settlements/:week_key/revoke', requireRole('admin', 'lab_manager'), (req, res) => {
  const wk = req.params.week_key;

  const target = db.get(
    "SELECT * FROM weekly_settlements WHERE week_key = ? AND source = 'settled' AND revoked = 0",
    [wk]
  );
  if (!target) {
    db.addLog('revoke_settlement_not_found', req.user.id, req.user.name, { week_key: wk });
    db.forceSave();
    return res.status(404).json({ error: `${wk} 没有可撤销的有效结转记录` });
  }

  const latest = db.getLatestSettlement();
  if (!latest || latest.id !== target.id) {
    db.addLog('revoke_settlement_not_latest', req.user.id, req.user.name, {
      week_key: wk,
      latest_week: latest ? latest.week_key : null
    });
    db.forceSave();
    return res.status(400).json({
      error: `只能撤销最新周次的结转，当前最新周次为 ${latest ? latest.week_key : '无'}`
    });
  }

  const now = new Date().toISOString();
  db.run(
    'UPDATE weekly_settlements SET revoked = 1, revoked_at = ?, revoked_by = ? WHERE id = ?',
    [now, req.user.id, target.id]
  );

  const totals = JSON.parse(target.totals);
  const relatedCount = db.cleanupSettlementRelatedData(target.id, req.user.id, '撤销周结转');

  db.addLog('revoke_weekly_settlement', req.user.id, req.user.name, {
    week_key: wk,
    settlement_id: target.id,
    original_settled_at: target.settled_at,
    equipment_count: totals.equipment_snapshot ? totals.equipment_snapshot.length : 0,
    reservation_total: totals.reservation_summary ? totals.reservation_summary.total : 0,
    loss_qty: totals.loss_summary ? totals.loss_summary.total_qty : 0,
    pending_returns: totals.pending_returns ? totals.pending_returns.length : 0,
    cleaned_notes: relatedCount.notes,
    cleaned_comparisons: relatedCount.comparisons,
    cleaned_exports_single: relatedCount.exports_single,
    cleaned_exports_comparison: relatedCount.exports_comparison,
    cleaned_exports_total: relatedCount.exports_total
  });
  db.forceSave();

  res.json({
    ok: true,
    week_key: wk,
    revoked_at: now,
    message: `${wk} 周结转已撤销，可重新执行结转`,
    cleaned: relatedCount
  });
});

app.post('/api/settlements/import', requireRole('admin', 'lab_manager'), (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: '导入数据格式错误，需要 JSON 对象' });
  }

  const { week_key, settled_at, totals } = data;
  if (!week_key || typeof week_key !== 'string') {
    return res.status(400).json({ error: '缺少 week_key 字段' });
  }
  if (!totals || typeof totals !== 'object') {
    return res.status(400).json({ error: '缺少 totals 字段或格式错误' });
  }
  if (!totals.equipment_snapshot || !Array.isArray(totals.equipment_snapshot)) {
    return res.status(400).json({ error: 'totals.equipment_snapshot 缺失或非数组' });
  }
  if (!totals.reservation_summary || typeof totals.reservation_summary !== 'object') {
    return res.status(400).json({ error: 'totals.reservation_summary 缺失' });
  }
  if (!totals.loss_summary || typeof totals.loss_summary !== 'object') {
    return res.status(400).json({ error: 'totals.loss_summary 缺失' });
  }
  if (!totals.pending_returns || !Array.isArray(totals.pending_returns)) {
    return res.status(400).json({ error: 'totals.pending_returns 缺失或非数组' });
  }

  const existingSettled = db.get(
    "SELECT * FROM weekly_settlements WHERE week_key = ? AND source = 'settled' AND revoked = 0",
    [week_key]
  );
  if (existingSettled) {
    db.addLog('import_settlement_duplicate_settled', req.user.id, req.user.name, { week_key });
    db.forceSave();
    return res.status(409).json({
      error: `${week_key} 已存在正式结转记录，导入被拒绝（不能覆盖正式数据）`,
      conflict: 'official_exists'
    });
  }

  const existingImported = db.get(
    "SELECT * FROM weekly_settlements WHERE week_key = ? AND source = 'imported' AND revoked = 0",
    [week_key]
  );
  if (existingImported) {
    db.addLog('import_settlement_duplicate_imported', req.user.id, req.user.name, { week_key });
    db.forceSave();
    return res.status(409).json({
      error: `${week_key} 已存在导入记录，如需重新导入请先撤销原导入记录`,
      conflict: 'imported_exists'
    });
  }

  const useSettledAt = settled_at && typeof settled_at === 'string' ? settled_at : new Date().toISOString();
  const now = new Date().toISOString();

  db.run(
    "INSERT INTO weekly_settlements (week_key, settled_at, totals, source, created_by) VALUES (?, ?, ?, 'imported', ?)",
    [week_key, useSettledAt, JSON.stringify(totals), req.user.id]
  );

  db.addLog('import_weekly_settlement', req.user.id, req.user.name, {
    week_key,
    original_settled_at: useSettledAt,
    imported_at: now,
    equipment_count: totals.equipment_snapshot.length,
    reservation_total: totals.reservation_summary.total,
    loss_qty: totals.loss_summary.total_qty,
    pending_returns: totals.pending_returns.length
  });
  db.forceSave();

  const imported = db.get(
    "SELECT * FROM weekly_settlements WHERE week_key = ? AND source = 'imported' AND revoked = 0 ORDER BY id DESC LIMIT 1",
    [week_key]
  );
  imported.totals = JSON.parse(imported.totals);

  res.status(201).json(imported);
});

app.delete('/api/settlements/:week_key/remove-import', requireRole('admin', 'lab_manager'), (req, res) => {
  const wk = req.params.week_key;
  const target = db.get(
    "SELECT * FROM weekly_settlements WHERE week_key = ? AND source = 'imported' AND revoked = 0",
    [wk]
  );
  if (!target) {
    return res.status(404).json({ error: `${wk} 没有可移除的导入结转记录` });
  }
  const now = new Date().toISOString();
  db.run(
    'UPDATE weekly_settlements SET revoked = 1, revoked_at = ?, revoked_by = ? WHERE id = ?',
    [now, req.user.id, target.id]
  );
  const relatedCount = db.cleanupSettlementRelatedData(target.id, req.user.id, '移除导入结转');
  db.addLog('remove_imported_settlement', req.user.id, req.user.name, {
    week_key: wk,
    settlement_id: target.id,
    cleaned_notes: relatedCount.notes,
    cleaned_comparisons: relatedCount.comparisons,
    cleaned_exports_single: relatedCount.exports_single,
    cleaned_exports_comparison: relatedCount.exports_comparison,
    cleaned_exports_total: relatedCount.exports_total
  });
  db.forceSave();
  res.json({ ok: true, week_key: wk, revoked_at: now, cleaned: relatedCount });
});

app.get('/api/settlements', requireAuth, (req, res) => {
  const list = db.all(
    "SELECT * FROM weekly_settlements WHERE revoked = 0 ORDER BY settled_at DESC, id DESC"
  );
  const latest = db.getLatestSettlement();
  const latestId = latest ? latest.id : null;
  list.forEach(s => {
    s.totals = JSON.parse(s.totals);
    s.is_latest_settled = s.source === 'settled' && s.id === latestId;
    s.notes = db.getNotesBySettlementId(s.id);
  });
  res.json(list);
});

app.get('/api/settlements/:id/notes', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const s = db.get('SELECT * FROM weekly_settlements WHERE id = ? AND revoked = 0', [id]);
  if (!s) return res.status(404).json({ error: '结转记录不存在或已撤销' });
  const notes = db.getNotesBySettlementId(id);
  res.json(notes);
});

app.post('/api/settlements/:id/notes', requireRole('admin', 'lab_manager'), (req, res) => {
  const id = parseInt(req.params.id);
  const { content } = req.body;
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({ error: '说明内容不能为空' });
  }
  const s = db.get('SELECT * FROM weekly_settlements WHERE id = ? AND revoked = 0', [id]);
  if (!s) return res.status(404).json({ error: '结转记录不存在或已撤销，无法添加说明' });

  const now = new Date().toISOString();
  const noteId = db.insertRun(
    'INSERT INTO settlement_notes (settlement_id, week_key, content, created_by, created_by_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, s.week_key, content.trim(), req.user.id, req.user.name, now, now]
  );
  db.addLog('add_settlement_note', req.user.id, req.user.name, {
    settlement_id: id,
    week_key: s.week_key,
    note_id: noteId,
    content_length: content.trim().length
  });
  db.forceSave();
  const note = db.get('SELECT * FROM settlement_notes WHERE id = ?', [noteId]);
  res.status(201).json(note);
});

app.put('/api/settlements/notes/:noteId', requireRole('admin', 'lab_manager'), (req, res) => {
  const noteId = parseInt(req.params.noteId);
  const { content } = req.body;
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({ error: '说明内容不能为空' });
  }
  const note = db.get('SELECT * FROM settlement_notes WHERE id = ?', [noteId]);
  if (!note) return res.status(404).json({ error: '说明记录不存在' });

  const s = db.get('SELECT * FROM weekly_settlements WHERE id = ? AND revoked = 0', [note.settlement_id]);
  if (!s) return res.status(404).json({ error: '关联结转记录已撤销，无法修改说明' });

  const now = new Date().toISOString();
  db.run(
    'UPDATE settlement_notes SET content = ?, updated_at = ? WHERE id = ?',
    [content.trim(), now, noteId]
  );
  db.addLog('update_settlement_note', req.user.id, req.user.name, {
    note_id: noteId,
    settlement_id: note.settlement_id,
    week_key: note.week_key,
    original_content_length: note.content.length,
    new_content_length: content.trim().length
  });
  db.forceSave();
  const updated = db.get('SELECT * FROM settlement_notes WHERE id = ?', [noteId]);
  res.json(updated);
});

app.delete('/api/settlements/notes/:noteId', requireRole('admin', 'lab_manager'), (req, res) => {
  const noteId = parseInt(req.params.noteId);
  const note = db.get('SELECT * FROM settlement_notes WHERE id = ?', [noteId]);
  if (!note) return res.status(404).json({ error: '说明记录不存在' });

  db.run('DELETE FROM settlement_notes WHERE id = ?', [noteId]);
  db.addLog('delete_settlement_note', req.user.id, req.user.name, {
    note_id: noteId,
    settlement_id: note.settlement_id,
    week_key: note.week_key
  });
  db.forceSave();
  res.json({ ok: true, note_id: noteId });
});

app.post('/api/settlements/compare', requireAuth, (req, res) => {
  const { settlement_a_id, settlement_b_id } = req.body;
  if (!settlement_a_id || !settlement_b_id) {
    return res.status(400).json({ error: '需要指定两条结转记录的 ID' });
  }
  if (parseInt(settlement_a_id) === parseInt(settlement_b_id)) {
    return res.status(400).json({ error: '不能对比同一条结转记录' });
  }

  const a = db.get('SELECT * FROM weekly_settlements WHERE id = ? AND revoked = 0', [parseInt(settlement_a_id)]);
  const b = db.get('SELECT * FROM weekly_settlements WHERE id = ? AND revoked = 0', [parseInt(settlement_b_id)]);

  if (!a || !b) {
    const missing = [];
    if (!a) missing.push(settlement_a_id);
    if (!b) missing.push(settlement_b_id);
    return res.status(404).json({ error: `结转记录不存在或已撤销: ${missing.join(', ')}` });
  }

  const diff = db.computeSettlementDiff(a, b);
  let comparisonId = null;

  if (['admin', 'lab_manager'].includes(req.user.role)) {
    const summary = {
      equipment_added: diff.equipment_snapshot.added.length,
      equipment_removed: diff.equipment_snapshot.removed.length,
      equipment_changed: diff.equipment_snapshot.changed.length,
      reservation_total_diff: diff.reservation_summary.total_diff,
      loss_qty_diff: diff.loss_summary.qty_diff,
      pending_added: diff.pending_returns.added.length,
      pending_removed: diff.pending_returns.removed.length,
      pending_changed: diff.pending_returns.changed.length
    };
    const now = new Date().toISOString();
    comparisonId = db.insertRun(
      'INSERT INTO settlement_comparisons (settlement_a_id, settlement_b_id, week_key_a, week_key_b, diff_summary, created_by, created_by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [a.id, b.id, a.week_key, b.week_key, JSON.stringify(summary), req.user.id, req.user.name, now]
    );
    db.addLog('compare_settlements', req.user.id, req.user.name, {
      comparison_id: comparisonId,
      settlement_a_id: a.id,
      settlement_b_id: b.id,
      week_key_a: a.week_key,
      week_key_b: b.week_key
    });
    db.forceSave();
  }

  res.json({
    comparison_id: comparisonId,
    settlement_a: {
      id: a.id, week_key: a.week_key, source: a.source, settled_at: a.settled_at
    },
    settlement_b: {
      id: b.id, week_key: b.week_key, source: b.source, settled_at: b.settled_at
    },
    diff
  });
});

function diffToCsvRows(comparisonResult) {
  const rows = [];
  const { settlement_a, settlement_b, diff } = comparisonResult;

  rows.push(['类别', '变化类型', '项目', '字段', settlement_a.week_key, settlement_b.week_key, '差异']);

  diff.equipment_snapshot.added.forEach(e => {
    rows.push(['器材快照', '新增', e.name, '总量', '', e.total, `+${e.total}`]);
    rows.push(['器材快照', '新增', e.name, '可用', '', e.available, `+${e.available}`]);
    rows.push(['器材快照', '新增', e.name, '锁定', '', e.locked, `+${e.locked}`]);
  });
  diff.equipment_snapshot.removed.forEach(e => {
    rows.push(['器材快照', '减少', e.name, '总量', e.total, '', `-${e.total}`]);
    rows.push(['器材快照', '减少', e.name, '可用', e.available, '', `-${e.available}`]);
    rows.push(['器材快照', '减少', e.name, '锁定', e.locked, '', `-${e.locked}`]);
  });
  diff.equipment_snapshot.changed.forEach(e => {
    Object.entries(e.changes).forEach(([field, ch]) => {
      const label = { total: '总量', available: '可用', locked: '锁定' }[field] || field;
      rows.push(['器材快照', '变化', e.name, label, ch.from, ch.to, (ch.to - ch.from) > 0 ? `+${ch.to - ch.from}` : `${ch.to - ch.from}`]);
    });
  });

  diff.reservation_summary.added.forEach(s => {
    rows.push(['预约汇总', '新增', `状态:${s.status}`, '条数', '', s.count, `+${s.count}`]);
  });
  diff.reservation_summary.removed.forEach(s => {
    rows.push(['预约汇总', '减少', `状态:${s.status}`, '条数', s.count, '', `-${s.count}`]);
  });
  diff.reservation_summary.changed.forEach(s => {
    rows.push(['预约汇总', '变化', `状态:${s.status}`, '条数', s.from, s.to, s.diff > 0 ? `+${s.diff}` : `${s.diff}`]);
  });

  const ls = diff.loss_summary;
  rows.push(['损耗汇总', '对比', '损耗申报数', '条数', ls.a_reports, ls.b_reports, ls.reports_diff > 0 ? `+${ls.reports_diff}` : `${ls.reports_diff}`]);
  rows.push(['损耗汇总', '对比', '损耗件数', '件数', ls.a_qty, ls.b_qty, ls.qty_diff > 0 ? `+${ls.qty_diff}` : `${ls.qty_diff}`]);

  diff.pending_returns.added.forEach(p => {
    rows.push(['待归还', '新增', p.equipment_name, '数量', '', p.qty, `+${p.qty}`]);
    rows.push(['待归还', '新增', p.equipment_name, '状态', '', p.status, '']);
  });
  diff.pending_returns.removed.forEach(p => {
    rows.push(['待归还', '减少', p.equipment_name, '数量', p.qty, '', `-${p.qty}`]);
    rows.push(['待归还', '减少', p.equipment_name, '状态', p.status, '', '']);
  });
  diff.pending_returns.changed.forEach(p => {
    Object.entries(p.changes).forEach(([field, ch]) => {
      if (field === 'qty') {
        rows.push(['待归还', '变化', p.equipment_name, '数量', ch.from, ch.to, (ch.to - ch.from) > 0 ? `+${ch.to - ch.from}` : `${ch.to - ch.from}`]);
      } else if (field === 'status') {
        rows.push(['待归还', '状态变化', p.equipment_name, '状态', ch.from, ch.to, '状态变更']);
      }
    });
  });

  return rows;
}

app.post('/api/settlements/compare/export-csv', requireRole('admin', 'lab_manager'), (req, res) => {
  const { settlement_a_id, settlement_b_id } = req.body;
  if (!settlement_a_id || !settlement_b_id) {
    return res.status(400).json({ error: '需要指定两条结转记录的 ID' });
  }

  const a = db.get('SELECT * FROM weekly_settlements WHERE id = ? AND revoked = 0', [parseInt(settlement_a_id)]);
  const b = db.get('SELECT * FROM weekly_settlements WHERE id = ? AND revoked = 0', [parseInt(settlement_b_id)]);
  if (!a || !b) return res.status(404).json({ error: '结转记录不存在或已撤销' });

  const diff = db.computeSettlementDiff(a, b);
  const comparisonResult = {
    settlement_a: { week_key: a.week_key },
    settlement_b: { week_key: b.week_key },
    diff
  };
  const rows = diffToCsvRows(comparisonResult);
  const summary = {
    equipment_added: diff.equipment_snapshot.added.length,
    equipment_removed: diff.equipment_snapshot.removed.length,
    equipment_changed: diff.equipment_snapshot.changed.length,
    reservation_total_diff: diff.reservation_summary.total_diff,
    loss_qty_diff: diff.loss_summary.qty_diff,
    pending_added: diff.pending_returns.added.length,
    pending_removed: diff.pending_returns.removed.length,
    pending_changed: diff.pending_returns.changed.length
  };
  const now = new Date().toISOString();
  const comparisonId = db.insertRun(
    'INSERT INTO settlement_comparisons (settlement_a_id, settlement_b_id, week_key_a, week_key_b, diff_summary, created_by, created_by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [a.id, b.id, a.week_key, b.week_key, JSON.stringify(summary), req.user.id, req.user.name, now]
  );

  const filename = `settlement-diff-${a.week_key}_vs_${b.week_key}.csv`;
  db.insertRun(
    'INSERT INTO settlement_exports (type, comparison_id, week_key_a, week_key_b, export_format, filename, row_count, created_by, created_by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['comparison', comparisonId, a.week_key, b.week_key, 'csv', filename, rows.length, req.user.id, req.user.name, now]
  );
  db.addLog('export_settlement_diff_csv', req.user.id, req.user.name, {
    comparison_id: comparisonId,
    week_key_a: a.week_key,
    week_key_b: b.week_key,
    filename,
    row_count: rows.length
  });
  db.forceSave();

  const csvContent = rows.map(r => r.map(cell => {
    const s = String(cell == null ? '' : cell);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');

  const bom = '\uFEFF';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(bom + csvContent);
});

app.get('/api/settlements/exports', requireRole('admin', 'lab_manager'), (req, res) => {
  const list = db.all(`
    SELECT se.* FROM settlement_exports se
    WHERE (
      se.settlement_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM weekly_settlements ws WHERE ws.id = se.settlement_id AND ws.revoked = 0)
    )
    OR (
      se.comparison_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM settlement_comparisons sc
        JOIN weekly_settlements wa ON wa.id = sc.settlement_a_id
        JOIN weekly_settlements wb ON wb.id = sc.settlement_b_id
        WHERE sc.id = se.comparison_id AND wa.revoked = 0 AND wb.revoked = 0
      )
    )
    ORDER BY se.created_at DESC LIMIT 100
  `);
  res.json(list);
});

app.get('/api/settlements/ledger', requireRole('admin', 'lab_manager'), (req, res) => {
  const filters = {
    week_key_start: req.query.week_key_start,
    week_key_end: req.query.week_key_end,
    export_type: req.query.export_type,
    export_format: req.query.export_format,
    created_by: req.query.created_by ? parseInt(req.query.created_by) : undefined,
    invalid: req.query.invalid !== undefined ? req.query.invalid === 'true' : undefined
  };
  const list = db.getLedgerExports(filters);
  const summary = db.getLedgerSummary(filters);
  res.json({ list, summary });
});

app.get('/api/settlements/ledger/summary', requireRole('admin', 'lab_manager'), (req, res) => {
  const filters = {
    week_key_start: req.query.week_key_start,
    week_key_end: req.query.week_key_end,
    export_type: req.query.export_type,
    export_format: req.query.export_format,
    created_by: req.query.created_by ? parseInt(req.query.created_by) : undefined,
    invalid: req.query.invalid !== undefined ? req.query.invalid === 'true' : undefined
  };
  const summary = db.getLedgerSummary(filters);
  res.json(summary);
});

app.get('/api/settlements/ledger/:id', requireRole('admin', 'lab_manager'), (req, res) => {
  const id = parseInt(req.params.id);
  const detail = db.getLedgerExportById(id);
  if (!detail) return res.status(404).json({ error: '台账记录不存在' });
  res.json(detail);
});

app.get('/api/settlements/ledger/export/csv', requireRole('admin', 'lab_manager'), (req, res) => {
  const filters = {
    week_key_start: req.query.week_key_start,
    week_key_end: req.query.week_key_end,
    export_type: req.query.export_type,
    export_format: req.query.export_format,
    created_by: req.query.created_by ? parseInt(req.query.created_by) : undefined,
    invalid: req.query.invalid !== undefined ? req.query.invalid === 'true' : undefined
  };
  const list = db.getLedgerExports(filters);

  const rows = [];
  rows.push([
    '导出ID', '来源周次', '导出类型', '文件格式', '文件名', '行数',
    '关联说明条数', '状态', '操作人', '导出时间',
    '失效原因', '失效人', '失效时间',
    '清理说明数', '清理对比数', '清理单周导出数', '清理对比导出数', '清理总导出数'
  ]);

  list.forEach(item => {
    const sourceWeek = item.week_key_b ? `${item.week_key_a} vs ${item.week_key_b}` : item.week_key_a;
    const typeLabel = item.type === 'single' ? '单周JSON' : '对比CSV';
    const status = item.invalid ? '已失效' : '有效';
    const stats = item.last_cleaned_stats || {};

    rows.push([
      item.id,
      sourceWeek,
      typeLabel,
      item.export_format,
      item.filename,
      item.row_count,
      item.related_note_count || 0,
      status,
      item.created_by_user_name || item.created_by_name || '',
      item.created_at,
      item.invalidated_reason || '',
      item.invalidated_by_user_name || '',
      item.invalidated_at || '',
      stats.cleaned_notes || 0,
      stats.cleaned_comparisons || 0,
      stats.cleaned_exports_single || 0,
      stats.cleaned_exports_comparison || 0,
      stats.cleaned_exports_total || 0
    ]);
  });

  const csvContent = rows.map(r => r.map(cell => {
    const s = String(cell == null ? '' : cell);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `settlement-ledger-${timestamp}.csv`;
  const bom = '\uFEFF';

  db.addLog('export_settlement_ledger_csv', req.user.id, req.user.name, {
    filename,
    row_count: rows.length - 1,
    filters
  });
  db.forceSave();

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(bom + csvContent);
});

app.get('/api/settlements/latest-info', requireAuth, (req, res) => {
  const latest = db.getLatestSettlement();
  if (latest) {
    res.json({
      has_latest: true,
      week_key: latest.week_key,
      id: latest.id,
      settled_at: latest.settled_at
    });
  } else {
    res.json({ has_latest: false });
  }
});

app.get('/api/logs', requireAuth, (req, res) => {
  const list = db.all('SELECT * FROM operation_logs ORDER BY created_at DESC LIMIT 200');
  list.forEach(l => {
    try { l.details = JSON.parse(l.details); } catch(e) {}
  });
  res.json(list);
});

app.get('/api/export/:week_key', requireAuth, (req, res) => {
  const wk = req.params.week_key;
  const source = req.query.source || 'settled';
  const validSource = ['settled', 'imported'].includes(source) ? source : 'settled';
  const settlement = db.get(
    `SELECT * FROM weekly_settlements WHERE week_key = ? AND source = ? AND revoked = 0 ORDER BY id DESC LIMIT 1`,
    [wk, validSource]
  );
  if (!settlement) return res.status(404).json({ error: `${wk} 未找到有效的${validSource === 'imported' ? '导入' : ''}结转记录` });

  const totals = JSON.parse(settlement.totals);
  const rowCount = totals.equipment_snapshot ? totals.equipment_snapshot.length : 0;
  const now = new Date().toISOString();
  const filename = `settlement-${wk}-${validSource}.json`;

  db.insertRun(
    `INSERT INTO settlement_exports (type, settlement_id, week_key_a, export_format, filename, row_count, created_by, created_by_name, created_at)
     VALUES ('single', ?, ?, 'json', ?, ?, ?, ?, ?)`,
    [settlement.id, wk, filename, rowCount, req.user.id, req.user.name, now]
  );
  db.addLog('export_settlement_single_json', req.user.id, req.user.name, {
    settlement_id: settlement.id,
    week_key: wk,
    source: validSource,
    filename,
    row_count: rowCount
  });
  db.forceSave();

  settlement.totals = totals;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.json(settlement);
});

app.get('/api/dashboard', requireAuth, (req, res) => {
  const equipment = db.all('SELECT * FROM equipment ORDER BY id');
  const reservationStats = db.all("SELECT status, COUNT(*) AS cnt FROM reservations GROUP BY status");
  const lossStats = db.all("SELECT status, COUNT(*) AS cnt FROM loss_reports GROUP BY status");
  const pendingReturns = db.all("SELECT COUNT(*) AS cnt FROM reservations WHERE status IN ('collected','partially_returned')");
  const latestSettlement = db.getLatestSettlement();

  if (latestSettlement) {
    try { latestSettlement.totals = JSON.parse(latestSettlement.totals); } catch(e) {}
  }

  res.json({
    equipment,
    reservation_stats: reservationStats,
    loss_stats: lossStats,
    pending_returns: pendingReturns[0] ? pendingReturns[0].cnt : 0,
    latest_settlement: latestSettlement,
    current_week: db.getCurrentWeekKey()
  });
});

app.post('/api/reset', (req, res) => {
  Object.keys(sessions).forEach(k => delete sessions[k]);
  db.initDatabase(true).then(() => {
    res.json({ ok: true });
  }).catch(err => {
    res.status(500).json({ error: err.message });
  });
});

async function start() {
  await db.initDatabase(false);
  app.listen(PORT, () => {
    console.log(`\n实验课器材预约与损耗结转系统已启动`);
    console.log(`  访问 http://localhost:${PORT}`);
    console.log(`\n预置账号：`);
    console.log(`  管理员     admin / admin123`);
    console.log(`  教师(张三) zhangsan / 123456`);
    console.log(`  教师(李四) lisi / 123456`);
    console.log(`  实验员(王五) wangwu / 123456\n`);
  });
}

process.on('SIGINT', () => {
  db.forceSave();
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.forceSave();
  process.exit(0);
});

start().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
