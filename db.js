const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'lab.db');

let db = null;
let dirty = false;
let saveTimer = null;

function ensureDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function initDatabase(forceReset) {
  const SQL = await initSqlJs();
  ensureDir();

  if (!forceReset && fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
    runMigrations();
  } else {
    db = new SQL.Database();
    createTables();
    seedData();
    saveToFile();
  }
  return db;
}

function runMigrations() {
  const resCols = all("PRAGMA table_info(reservations)").map(c => c.name);
  if (!resCols.includes('returned_qty')) {
    db.run('ALTER TABLE reservations ADD COLUMN returned_qty INTEGER NOT NULL DEFAULT 0');
    saveToFile();
  }
  const setCols = all("PRAGMA table_info(weekly_settlements)").map(c => c.name);
  if (!setCols.includes('source')) {
    db.run("ALTER TABLE weekly_settlements ADD COLUMN source TEXT NOT NULL DEFAULT 'settled'");
    saveToFile();
  }
  if (!setCols.includes('revoked')) {
    db.run('ALTER TABLE weekly_settlements ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0');
    saveToFile();
  }
  if (!setCols.includes('created_by')) {
    db.run('ALTER TABLE weekly_settlements ADD COLUMN created_by INTEGER REFERENCES users(id)');
    saveToFile();
  }
  if (!setCols.includes('revoked_at')) {
    db.run('ALTER TABLE weekly_settlements ADD COLUMN revoked_at TEXT');
    saveToFile();
  }
  if (!setCols.includes('revoked_by')) {
    db.run('ALTER TABLE weekly_settlements ADD COLUMN revoked_by INTEGER REFERENCES users(id)');
    saveToFile();
  }

  const existingTables = all("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name);

  if (!existingTables.includes('settlement_notes')) {
    db.run(`
      CREATE TABLE IF NOT EXISTS settlement_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        settlement_id INTEGER NOT NULL REFERENCES weekly_settlements(id),
        week_key TEXT NOT NULL,
        content TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id),
        created_by_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    saveToFile();
  }

  if (!existingTables.includes('settlement_comparisons')) {
    db.run(`
      CREATE TABLE IF NOT EXISTS settlement_comparisons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        settlement_a_id INTEGER NOT NULL REFERENCES weekly_settlements(id),
        settlement_b_id INTEGER NOT NULL REFERENCES weekly_settlements(id),
        week_key_a TEXT NOT NULL,
        week_key_b TEXT NOT NULL,
        diff_summary TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id),
        created_by_name TEXT,
        created_at TEXT NOT NULL
      );
    `);
    saveToFile();
  }

  if (!existingTables.includes('settlement_exports')) {
    db.run(`
      CREATE TABLE IF NOT EXISTS settlement_exports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('single','comparison')),
        settlement_id INTEGER REFERENCES weekly_settlements(id),
        comparison_id INTEGER REFERENCES settlement_comparisons(id),
        week_key_a TEXT,
        week_key_b TEXT,
        export_format TEXT NOT NULL DEFAULT 'csv',
        filename TEXT NOT NULL,
        row_count INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER REFERENCES users(id),
        created_by_name TEXT,
        created_at TEXT NOT NULL
      );
    `);
    saveToFile();
  }
}

function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','teacher','lab_manager')),
      password TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      total_qty INTEGER NOT NULL DEFAULT 0,
      available_qty INTEGER NOT NULL DEFAULT 0,
      locked_qty INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      teacher_id INTEGER NOT NULL REFERENCES users(id)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      course_id INTEGER NOT NULL REFERENCES courses(id),
      semester TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL REFERENCES courses(id),
      class_id INTEGER NOT NULL REFERENCES classes(id),
      equipment_id INTEGER NOT NULL REFERENCES equipment(id),
      qty INTEGER NOT NULL,
      returned_qty INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','collected','partially_returned','returned','cancelled')),
      week_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS loss_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id INTEGER NOT NULL REFERENCES reservations(id),
      equipment_id INTEGER NOT NULL REFERENCES equipment(id),
      qty INTEGER NOT NULL,
      reporter_id INTEGER NOT NULL REFERENCES users(id),
      approver_id INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      approved_at TEXT
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS weekly_settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_key TEXT NOT NULL,
      settled_at TEXT NOT NULL,
      totals TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'settled' CHECK(source IN ('settled','imported')),
      revoked INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      revoked_at TEXT,
      revoked_by INTEGER REFERENCES users(id)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      user_name TEXT,
      details TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS settlement_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      settlement_id INTEGER NOT NULL REFERENCES weekly_settlements(id),
      week_key TEXT NOT NULL,
      content TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_by_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS settlement_comparisons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      settlement_a_id INTEGER NOT NULL REFERENCES weekly_settlements(id),
      settlement_b_id INTEGER NOT NULL REFERENCES weekly_settlements(id),
      week_key_a TEXT NOT NULL,
      week_key_b TEXT NOT NULL,
      diff_summary TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_by_name TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS settlement_exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('single','comparison')),
      settlement_id INTEGER REFERENCES weekly_settlements(id),
      comparison_id INTEGER REFERENCES settlement_comparisons(id),
      week_key_a TEXT,
      week_key_b TEXT,
      export_format TEXT NOT NULL DEFAULT 'csv',
      filename TEXT NOT NULL,
      row_count INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_by_name TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

function seedData() {
  const now = new Date().toISOString();

  db.run("INSERT INTO users (username, name, role, password) VALUES ('admin', '系统管理员', 'admin', 'admin123')");
  db.run("INSERT INTO users (username, name, role, password) VALUES ('zhangsan', '张三(物理教师)', 'teacher', '123456')");
  db.run("INSERT INTO users (username, name, role, password) VALUES ('lisi', '李四(化学教师)', 'teacher', '123456')");
  db.run("INSERT INTO users (username, name, role, password) VALUES ('wangwu', '王五(实验员)', 'lab_manager', '123456')");

  db.run("INSERT INTO equipment (name, total_qty, available_qty, locked_qty) VALUES ('示波器', 10, 10, 0)");
  db.run("INSERT INTO equipment (name, total_qty, available_qty, locked_qty) VALUES ('万用表', 5, 5, 0)");
  db.run("INSERT INTO equipment (name, total_qty, available_qty, locked_qty) VALUES ('烧杯', 50, 50, 0)");
  db.run("INSERT INTO equipment (name, total_qty, available_qty, locked_qty) VALUES ('显微镜', 3, 3, 0)");
  db.run("INSERT INTO equipment (name, total_qty, available_qty, locked_qty) VALUES ('试管', 100, 100, 0)");

  db.run("INSERT INTO courses (name, teacher_id) VALUES ('大学物理实验', 2)");
  db.run("INSERT INTO courses (name, teacher_id) VALUES ('有机化学实验', 3)");
  db.run("INSERT INTO courses (name, teacher_id) VALUES ('生物基础实验', 2)");

  db.run("INSERT INTO classes (name, course_id, semester) VALUES ('物理实验A班', 1, '2025-2026-2')");
  db.run("INSERT INTO classes (name, course_id, semester) VALUES ('物理实验B班', 1, '2025-2026-2')");
  db.run("INSERT INTO classes (name, course_id, semester) VALUES ('化学实验A班', 2, '2025-2026-2')");

  db.run(`INSERT INTO operation_logs (action, user_id, user_name, details, created_at) VALUES ('system_init', 1, '系统管理员', '系统初始化，导入样例数据', '${now}')`);
}

function saveToFile() {
  ensureDir();
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
  dirty = false;
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (dirty) saveToFile();
  }, 500);
}

function forceSave() {
  if (dirty) saveToFile();
}

function run(sql, params) {
  if (params && params.length > 0) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    stmt.step();
    stmt.free();
  } else {
    db.run(sql);
  }
  scheduleSave();
}

function insertRun(sql, params) {
  if (params && params.length > 0) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    stmt.step();
    stmt.free();
  } else {
    db.run(sql);
  }
  const row = get("SELECT last_insert_rowid() AS id");
  scheduleSave();
  return row ? row.id : null;
}

function get(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  let row = null;
  if (stmt.step()) {
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    row = {};
    cols.forEach((c, i) => { row[c] = vals[i]; });
  }
  stmt.free();
  return row;
}

function all(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    const row = {};
    cols.forEach((c, i) => { row[c] = vals[i]; });
    rows.push(row);
  }
  stmt.free();
  return rows;
}

function addLog(action, userId, userName, details) {
  const now = new Date().toISOString();
  run(
    "INSERT INTO operation_logs (action, user_id, user_name, details, created_at) VALUES (?, ?, ?, ?, ?)",
    [action, userId, userName, typeof details === 'string' ? details : JSON.stringify(details), now]
  );
}

function getCurrentWeekKey() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const diff = now - start;
  const oneWeek = 604800000;
  const weekNum = Math.ceil((diff / oneWeek) + 1);
  return `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function getLatestSettlement() {
  const row = get(
    "SELECT * FROM weekly_settlements WHERE revoked = 0 AND source = 'settled' ORDER BY settled_at DESC, id DESC LIMIT 1"
  );
  return row;
}

function getActiveSettlementByWeek(weekKey) {
  const rows = all(
    "SELECT * FROM weekly_settlements WHERE week_key = ? AND revoked = 0 ORDER BY source ASC, settled_at DESC",
    [weekKey]
  );
  return rows.length > 0 ? rows[0] : null;
}

function hasActiveSettlementByWeekAndSource(weekKey, source) {
  const row = get(
    "SELECT COUNT(*) AS cnt FROM weekly_settlements WHERE week_key = ? AND source = ? AND revoked = 0",
    [weekKey, source]
  );
  return row && row.cnt > 0;
}

function cleanupSettlementRelatedData(settlementId) {
  run('DELETE FROM settlement_notes WHERE settlement_id = ?', [settlementId]);
  run('DELETE FROM settlement_comparisons WHERE settlement_a_id = ? OR settlement_b_id = ?', [settlementId, settlementId]);
  run('DELETE FROM settlement_exports WHERE settlement_id = ?', [settlementId]);
  run(`
    DELETE FROM settlement_exports
    WHERE comparison_id IN (
      SELECT id FROM settlement_comparisons WHERE settlement_a_id = ? OR settlement_b_id = ?
    )
  `, [settlementId, settlementId]);
  saveToFile();
}

function getNotesBySettlementId(settlementId) {
  return all(
    'SELECT * FROM settlement_notes WHERE settlement_id = ? ORDER BY created_at DESC',
    [settlementId]
  );
}

function computeSettlementDiff(settlementA, settlementB) {
  const totalsA = typeof settlementA.totals === 'string' ? JSON.parse(settlementA.totals) : settlementA.totals;
  const totalsB = typeof settlementB.totals === 'string' ? JSON.parse(settlementB.totals) : settlementB.totals;

  const result = {
    equipment_snapshot: { added: [], removed: [], changed: [] },
    reservation_summary: { added: [], removed: [], changed: [], total_diff: 0 },
    loss_summary: {},
    pending_returns: { added: [], removed: [], changed: [] }
  };

  const eqMapA = {};
  (totalsA.equipment_snapshot || []).forEach(e => { eqMapA[e.id] = e; });
  const eqMapB = {};
  (totalsB.equipment_snapshot || []).forEach(e => { eqMapB[e.id] = e; });

  const allEqIds = new Set([...Object.keys(eqMapA), ...Object.keys(eqMapB)]);
  allEqIds.forEach(id => {
    const a = eqMapA[id];
    const b = eqMapB[id];
    if (!a && b) {
      result.equipment_snapshot.added.push({ id: b.id, name: b.name, total: b.total, available: b.available, locked: b.locked });
    } else if (a && !b) {
      result.equipment_snapshot.removed.push({ id: a.id, name: a.name, total: a.total, available: a.available, locked: a.locked });
    } else if (a && b) {
      const changes = {};
      if (a.total !== b.total) changes.total = { from: a.total, to: b.total };
      if (a.available !== b.available) changes.available = { from: a.available, to: b.available };
      if (a.locked !== b.locked) changes.locked = { from: a.locked, to: b.locked };
      if (Object.keys(changes).length > 0) {
        result.equipment_snapshot.changed.push({ id: a.id, name: a.name, changes });
      }
    }
  });

  const rsA = totalsA.reservation_summary || { total: 0, by_status: {} };
  const rsB = totalsB.reservation_summary || { total: 0, by_status: {} };
  result.reservation_summary.total_diff = (rsB.total || 0) - (rsA.total || 0);

  const allStatuses = new Set([
    ...Object.keys(rsA.by_status || {}),
    ...Object.keys(rsB.by_status || {})
  ]);
  allStatuses.forEach(status => {
    const a = rsA.by_status[status] || 0;
    const b = rsB.by_status[status] || 0;
    if (a === 0 && b > 0) {
      result.reservation_summary.added.push({ status, count: b });
    } else if (a > 0 && b === 0) {
      result.reservation_summary.removed.push({ status, count: a });
    } else if (a !== b) {
      result.reservation_summary.changed.push({ status, from: a, to: b, diff: b - a });
    }
  });

  const lsA = totalsA.loss_summary || { total_reports: 0, total_qty: 0 };
  const lsB = totalsB.loss_summary || { total_reports: 0, total_qty: 0 };
  result.loss_summary = {
    reports_diff: (lsB.total_reports || 0) - (lsA.total_reports || 0),
    qty_diff: (lsB.total_qty || 0) - (lsA.total_qty || 0),
    a_reports: lsA.total_reports || 0,
    b_reports: lsB.total_reports || 0,
    a_qty: lsA.total_qty || 0,
    b_qty: lsB.total_qty || 0
  };

  const prMapA = {};
  (totalsA.pending_returns || []).forEach(pr => { prMapA[pr.id] = pr; });
  const prMapB = {};
  (totalsB.pending_returns || []).forEach(pr => { prMapB[pr.id] = pr; });

  const allPrIds = new Set([...Object.keys(prMapA), ...Object.keys(prMapB)]);
  allPrIds.forEach(id => {
    const a = prMapA[id];
    const b = prMapB[id];
    if (!a && b) {
      result.pending_returns.added.push({
        id: b.id, equipment_name: b.equipment_name, qty: b.qty, status: b.status
      });
    } else if (a && !b) {
      result.pending_returns.removed.push({
        id: a.id, equipment_name: a.equipment_name, qty: a.qty, status: a.status
      });
    } else if (a && b) {
      const changes = {};
      if (a.qty !== b.qty) changes.qty = { from: a.qty, to: b.qty };
      if (a.status !== b.status) changes.status = { from: a.status, to: b.status };
      if (Object.keys(changes).length > 0) {
        result.pending_returns.changed.push({
          id: a.id, equipment_name: a.equipment_name, changes
        });
      }
    }
  });

  return result;
}

module.exports = {
  initDatabase,
  run,
  insertRun,
  get,
  all,
  saveToFile,
  forceSave,
  addLog,
  getCurrentWeekKey,
  getLatestSettlement,
  getActiveSettlementByWeek,
  hasActiveSettlementByWeekAndSource,
  cleanupSettlementRelatedData,
  getNotesBySettlementId,
  computeSettlementDiff
};
