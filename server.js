const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const PORT = 3001;

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

  if (eq.available_qty - eq.locked_qty < qty) {
    db.addLog('reservation_conflict', req.user.id, req.user.name, {
      equipment_id, requested: qty, available: eq.available_qty - eq.locked_qty
    });
    db.forceSave();
    return res.status(409).json({
      error: `库存不足：${eq.name} 可用 ${eq.available_qty - eq.locked_qty}，需 ${qty}`,
      available: eq.available_qty - eq.locked_qty,
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
  const newStatus = qty >= maxReturn ? 'returned' : 'partially_returned';

  db.run('UPDATE equipment SET available_qty = available_qty + ?, locked_qty = locked_qty - ? WHERE id = ?',
    [qty, qty, r.equipment_id]);
  db.run('UPDATE reservations SET status = ?, updated_at = ? WHERE id = ?', [newStatus, now, id]);

  db.addLog('return_equipment', req.user.id, req.user.name, {
    reservation_id: id, return_qty: qty, status: newStatus
  });
  db.forceSave();

  res.json({ ok: true, status: newStatus, returned: qty });
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

  const existing = db.get('SELECT * FROM weekly_settlements WHERE week_key = ?', [wk]);
  if (existing) {
    db.addLog('duplicate_settlement_rejected', req.user.id, req.user.name, { week_key: wk });
    db.forceSave();
    return res.status(409).json({ error: `${wk} 已完成结转，不可重复执行`, existing });
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
    'INSERT INTO weekly_settlements (week_key, settled_at, totals) VALUES (?, ?, ?)',
    [wk, now, JSON.stringify(totals)]
  );

  db.addLog('weekly_settlement', req.user.id, req.user.name, {
    week_key: wk, reservations: reservations.length, losses: lossReports.length
  });
  db.forceSave();

  const settlement = db.get('SELECT * FROM weekly_settlements WHERE week_key = ?', [wk]);
  settlement.totals = JSON.parse(settlement.totals);

  res.json(settlement);
});

app.get('/api/settlements', requireAuth, (req, res) => {
  const list = db.all('SELECT * FROM weekly_settlements ORDER BY settled_at DESC');
  list.forEach(s => { s.totals = JSON.parse(s.totals); });
  res.json(list);
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
  const settlement = db.get('SELECT * FROM weekly_settlements WHERE week_key = ?', [wk]);
  if (!settlement) return res.status(404).json({ error: `${wk} 未找到结转记录` });

  settlement.totals = JSON.parse(settlement.totals);
  res.setHeader('Content-Disposition', `attachment; filename="settlement-${wk}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.json(settlement);
});

app.get('/api/dashboard', requireAuth, (req, res) => {
  const equipment = db.all('SELECT * FROM equipment ORDER BY id');
  const reservationStats = db.all("SELECT status, COUNT(*) AS cnt FROM reservations GROUP BY status");
  const lossStats = db.all("SELECT status, COUNT(*) AS cnt FROM loss_reports GROUP BY status");
  const pendingReturns = db.all("SELECT COUNT(*) AS cnt FROM reservations WHERE status IN ('collected','partially_returned')");
  const latestSettlement = db.get('SELECT * FROM weekly_settlements ORDER BY settled_at DESC LIMIT 1');

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
