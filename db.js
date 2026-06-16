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
        created_at TEXT NOT NULL,
        invalid INTEGER NOT NULL DEFAULT 0,
        invalidated_at TEXT,
        invalidated_by INTEGER REFERENCES users(id),
        invalidated_reason TEXT,
        last_cleaned_stats TEXT
      );
    `);
    saveToFile();
  }

  const expCols = all("PRAGMA table_info(settlement_exports)").map(c => c.name);
  if (!expCols.includes('invalid')) {
    db.run('ALTER TABLE settlement_exports ADD COLUMN invalid INTEGER NOT NULL DEFAULT 0');
    saveToFile();
  }
  if (!expCols.includes('invalidated_at')) {
    db.run('ALTER TABLE settlement_exports ADD COLUMN invalidated_at TEXT');
    saveToFile();
  }
  if (!expCols.includes('invalidated_by')) {
    db.run('ALTER TABLE settlement_exports ADD COLUMN invalidated_by INTEGER REFERENCES users(id)');
    saveToFile();
  }
  if (!expCols.includes('invalidated_reason')) {
    db.run('ALTER TABLE settlement_exports ADD COLUMN invalidated_reason TEXT');
    saveToFile();
  }
  if (!expCols.includes('last_cleaned_stats')) {
    db.run('ALTER TABLE settlement_exports ADD COLUMN last_cleaned_stats TEXT');
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
      created_at TEXT NOT NULL,
      invalid INTEGER NOT NULL DEFAULT 0,
      invalidated_at TEXT,
      invalidated_by INTEGER REFERENCES users(id),
      invalidated_reason TEXT,
      last_cleaned_stats TEXT
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

function countRelatedCleanup(settlementId) {
  const noteCount = get(
    "SELECT COUNT(*) AS c FROM settlement_notes WHERE settlement_id = ?",
    [settlementId]
  ).c;
  const comparisonCount = get(
    "SELECT COUNT(*) AS c FROM settlement_comparisons WHERE settlement_a_id = ? OR settlement_b_id = ?",
    [settlementId, settlementId]
  ).c;
  const exportSingleCount = get(
    "SELECT COUNT(*) AS c FROM settlement_exports WHERE settlement_id = ?",
    [settlementId]
  ).c;
  const exportComparisonCount = get(
    `SELECT COUNT(*) AS c FROM settlement_exports
     WHERE comparison_id IN (
       SELECT id FROM settlement_comparisons WHERE settlement_a_id = ? OR settlement_b_id = ?
     )`,
    [settlementId, settlementId]
  ).c;
  return {
    cleaned_notes: noteCount,
    cleaned_comparisons: comparisonCount,
    cleaned_exports_single: exportSingleCount,
    cleaned_exports_comparison: exportComparisonCount,
    cleaned_exports_total: exportSingleCount + exportComparisonCount
  };
}

function cleanupSettlementRelatedData(settlementId, invalidatedBy = null, invalidatedReason = null) {
  const relatedCount = countRelatedCleanup(settlementId);

  if (invalidatedBy) {
    invalidateExportsBySettlementId(settlementId, invalidatedBy, invalidatedReason, relatedCount);
  }

  run('DELETE FROM settlement_comparisons WHERE settlement_a_id = ? OR settlement_b_id = ?', [settlementId, settlementId]);
  run('DELETE FROM settlement_notes WHERE settlement_id = ?', [settlementId]);
  saveToFile();
  return relatedCount;
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

function getRelatedNoteCount(settlementId) {
  const row = get(
    "SELECT COUNT(*) AS cnt FROM settlement_notes WHERE settlement_id = ?",
    [settlementId]
  );
  return row ? row.cnt : 0;
}

function getLatestCleanedStats(settlementId) {
  const logs = all(
    `SELECT details FROM operation_logs
     WHERE action IN ('revoke_weekly_settlement', 'remove_imported_settlement')
     AND details LIKE ?
     ORDER BY created_at DESC LIMIT 1`,
    [`%"settlement_id":${settlementId}%`]
  );
  if (logs.length === 0) return null;
  try {
    const details = JSON.parse(logs[0].details);
    return {
      cleaned_notes: details.cleaned_notes || 0,
      cleaned_comparisons: details.cleaned_comparisons || 0,
      cleaned_exports_single: details.cleaned_exports_single || 0,
      cleaned_exports_comparison: details.cleaned_exports_comparison || 0,
      cleaned_exports_total: details.cleaned_exports_total || 0
    };
  } catch (e) {
    return null;
  }
}

function invalidateExportsBySettlementId(settlementId, invalidatedBy, invalidatedReason, cleanedStats) {
  const now = new Date().toISOString();
  let statsToSave = null;
  if (cleanedStats) {
    statsToSave = {
      cleaned_notes: cleanedStats.cleaned_notes !== undefined ? cleanedStats.cleaned_notes : 0,
      cleaned_comparisons: cleanedStats.cleaned_comparisons !== undefined ? cleanedStats.cleaned_comparisons : 0,
      cleaned_exports_single: cleanedStats.cleaned_exports_single !== undefined ? cleanedStats.cleaned_exports_single : 0,
      cleaned_exports_comparison: cleanedStats.cleaned_exports_comparison !== undefined ? cleanedStats.cleaned_exports_comparison : 0,
      cleaned_exports_total: cleanedStats.cleaned_exports_total !== undefined ? cleanedStats.cleaned_exports_total : 0
    };
  }
  const statsJson = statsToSave ? JSON.stringify(statsToSave) : null;

  run(
    `UPDATE settlement_exports SET
       invalid = 1,
       invalidated_at = ?,
       invalidated_by = ?,
       invalidated_reason = ?,
       last_cleaned_stats = ?
     WHERE settlement_id = ?`,
    [now, invalidatedBy, invalidatedReason, statsJson, settlementId]
  );

  run(
    `UPDATE settlement_exports SET
       invalid = 1,
       invalidated_at = ?,
       invalidated_by = ?,
       invalidated_reason = ?,
       last_cleaned_stats = ?
     WHERE comparison_id IN (
       SELECT id FROM settlement_comparisons WHERE settlement_a_id = ? OR settlement_b_id = ?
     )`,
    [now, invalidatedBy, invalidatedReason, statsJson, settlementId, settlementId]
  );

  saveToFile();
}

function getLedgerExports(filters = {}) {
  let sql = `
    SELECT se.*,
           u.name AS created_by_user_name,
           u.username AS created_by_username,
           iv.name AS invalidated_by_user_name,
           iv.username AS invalidated_by_username
    FROM settlement_exports se
    LEFT JOIN users u ON se.created_by = u.id
    LEFT JOIN users iv ON se.invalidated_by = iv.id
    WHERE 1=1
  `;
  const params = [];

  if (filters.week_key_start) {
    sql += " AND (se.week_key_a >= ? OR se.week_key_b >= ?)";
    params.push(filters.week_key_start, filters.week_key_start);
  }
  if (filters.week_key_end) {
    sql += " AND (se.week_key_a <= ? OR se.week_key_b <= ?)";
    params.push(filters.week_key_end, filters.week_key_end);
  }
  if (filters.export_type) {
    sql += " AND se.type = ?";
    params.push(filters.export_type);
  }
  if (filters.export_format) {
    sql += " AND se.export_format = ?";
    params.push(filters.export_format);
  }
  if (filters.operator) {
    sql += " AND (u.username LIKE ? OR u.name LIKE ?)";
    params.push(`%${filters.operator}%`, `%${filters.operator}%`);
  }
  if (filters.created_by) {
    sql += " AND se.created_by = ?";
    params.push(filters.created_by);
  }
  if (filters.invalid !== undefined && filters.invalid !== null) {
    sql += " AND se.invalid = ?";
    params.push(filters.invalid ? 1 : 0);
  }

  sql += " ORDER BY se.created_at DESC LIMIT 500";

  const rows = all(sql, params);

  rows.forEach(row => {
    if (row.last_cleaned_stats) {
      try {
        let stats = typeof row.last_cleaned_stats === 'string' ? JSON.parse(row.last_cleaned_stats) : row.last_cleaned_stats;
        if (stats && typeof stats === 'object') {
          const normalized = {};
          normalized.cleaned_notes = stats.notes !== undefined ? stats.notes : 
                                   (stats.cleaned_notes !== undefined ? stats.cleaned_notes : 0);
          normalized.cleaned_comparisons = stats.comparisons !== undefined ? stats.comparisons :
                                       (stats.cleaned_comparisons !== undefined ? stats.cleaned_comparisons : 0);
          normalized.cleaned_exports_single = stats.exports_single !== undefined ? stats.exports_single :
                                            (stats.cleaned_exports_single !== undefined ? stats.cleaned_exports_single : 0);
          normalized.cleaned_exports_comparison = stats.exports_comparison !== undefined ? stats.exports_comparison :
                                                (stats.cleaned_exports_comparison !== undefined ? stats.cleaned_exports_comparison : 0);
          normalized.cleaned_exports_total = stats.exports_total !== undefined ? stats.exports_total :
                                           (stats.cleaned_exports_total !== undefined ? stats.cleaned_exports_total : 0);
          row.last_cleaned_stats = normalized;
        } else {
          row.last_cleaned_stats = null;
        }
      } catch (e) {
        row.last_cleaned_stats = null;
      }
    }
    
    if (row.settlement_id) {
      row.related_note_count = getRelatedNoteCount(row.settlement_id);
      if (!row.last_cleaned_stats) {
        row.last_cleaned_stats = getLatestCleanedStats(row.settlement_id);
      }
    } else {
      row.related_note_count = 0;
    }
  });

  return rows;
}

function getLedgerExportById(id) {
  const row = get(
    `SELECT se.*,
            u.name AS created_by_user_name,
            u.username AS created_by_username,
            iv.name AS invalidated_by_user_name,
            iv.username AS invalidated_by_username,
            sc.settlement_a_id, sc.settlement_b_id,
            sc.diff_summary AS comparison_diff_summary
     FROM settlement_exports se
     LEFT JOIN users u ON se.created_by = u.id
     LEFT JOIN users iv ON se.invalidated_by = iv.id
     LEFT JOIN settlement_comparisons sc ON se.comparison_id = sc.id
     WHERE se.id = ?`,
    [id]
  );

  if (!row) return null;

  if (row.last_cleaned_stats) {
    try {
      let stats = typeof row.last_cleaned_stats === 'string' ? JSON.parse(row.last_cleaned_stats) : row.last_cleaned_stats;
      if (stats && typeof stats === 'object') {
        const normalized = {};
        normalized.cleaned_notes = stats.notes !== undefined ? stats.notes : 
                                 (stats.cleaned_notes !== undefined ? stats.cleaned_notes : 0);
        normalized.cleaned_comparisons = stats.comparisons !== undefined ? stats.comparisons :
                                     (stats.cleaned_comparisons !== undefined ? stats.cleaned_comparisons : 0);
        normalized.cleaned_exports_single = stats.exports_single !== undefined ? stats.exports_single :
                                          (stats.cleaned_exports_single !== undefined ? stats.cleaned_exports_single : 0);
        normalized.cleaned_exports_comparison = stats.exports_comparison !== undefined ? stats.exports_comparison :
                                     (stats.cleaned_exports_comparison !== undefined ? stats.cleaned_exports_comparison : 0);
        normalized.cleaned_exports_total = stats.exports_total !== undefined ? stats.exports_total :
                                         (stats.cleaned_exports_total !== undefined ? stats.cleaned_exports_total : 0);
        row.last_cleaned_stats = normalized;
      } else {
        row.last_cleaned_stats = null;
      }
    } catch (e) {
      row.last_cleaned_stats = null;
    }
  }
  if (row.comparison_diff_summary) {
    try {
      row.comparison_diff_summary = JSON.parse(row.comparison_diff_summary);
    } catch (e) {
      row.comparison_diff_summary = null;
    }
  }
  if (row.settlement_id) {
    row.related_note_count = getRelatedNoteCount(row.settlement_id);
    if (!row.last_cleaned_stats) {
      row.last_cleaned_stats = getLatestCleanedStats(row.settlement_id);
    }
  } else {
    row.related_note_count = 0;
  }

  return row;
}

function getLedgerSummary(filters = {}) {
  let sql = `
    SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN se.type = 'single' THEN 1 ELSE 0 END) AS single_count,
      SUM(CASE WHEN se.type = 'comparison' THEN 1 ELSE 0 END) AS comparison_count,
      SUM(CASE WHEN se.invalid = 1 THEN 1 ELSE 0 END) AS invalid_count,
      SUM(CASE WHEN se.invalid = 0 THEN 1 ELSE 0 END) AS valid_count,
      SUM(se.row_count) AS total_rows
    FROM settlement_exports se
    LEFT JOIN users u ON se.created_by = u.id
    WHERE 1=1
  `;
  const params = [];

  if (filters.week_key_start) {
    sql += " AND (se.week_key_a >= ? OR se.week_key_b >= ?)";
    params.push(filters.week_key_start, filters.week_key_start);
  }
  if (filters.week_key_end) {
    sql += " AND (se.week_key_a <= ? OR se.week_key_b <= ?)";
    params.push(filters.week_key_end, filters.week_key_end);
  }
  if (filters.export_type) {
    sql += " AND se.type = ?";
    params.push(filters.export_type);
  }
  if (filters.export_format) {
    sql += " AND se.export_format = ?";
    params.push(filters.export_format);
  }
  if (filters.operator) {
    sql += " AND (u.username LIKE ? OR u.name LIKE ?)";
    params.push(`%${filters.operator}%`, `%${filters.operator}%`);
  }
  if (filters.created_by) {
    sql += " AND se.created_by = ?";
    params.push(filters.created_by);
  }
  if (filters.invalid !== undefined && filters.invalid !== null) {
    sql += " AND se.invalid = ?";
    params.push(filters.invalid ? 1 : 0);
  }

  const row = get(sql, params);
  return row || {
    total_count: 0,
    single_count: 0,
    comparison_count: 0,
    invalid_count: 0,
    valid_count: 0,
    total_rows: 0
  };
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
  countRelatedCleanup,
  cleanupSettlementRelatedData,
  getNotesBySettlementId,
  computeSettlementDiff,
  getRelatedNoteCount,
  getLatestCleanedStats,
  invalidateExportsBySettlementId,
  getLedgerExports,
  getLedgerExportById,
  getLedgerSummary
};
