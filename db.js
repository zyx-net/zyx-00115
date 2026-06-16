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
  const cols = all("PRAGMA table_info(reservations)").map(c => c.name);
  if (!cols.includes('returned_qty')) {
    db.run('ALTER TABLE reservations ADD COLUMN returned_qty INTEGER NOT NULL DEFAULT 0');
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
      week_key TEXT UNIQUE NOT NULL,
      settled_at TEXT NOT NULL,
      totals TEXT NOT NULL
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

module.exports = {
  initDatabase,
  run,
  insertRun,
  get,
  all,
  saveToFile,
  forceSave,
  addLog,
  getCurrentWeekKey
};
