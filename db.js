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

  const existingTables2 = all("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name);

  if (!existingTables2.includes('classrooms')) {
    db.run(`
      CREATE TABLE IF NOT EXISTS classrooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        capacity INTEGER NOT NULL DEFAULT 30,
        equipment TEXT
      );
    `);
    saveToFile();
  }
  if (!existingTables2.includes('students')) {
    db.run(`
      CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_no TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        gender TEXT,
        contact TEXT
      );
    `);
    saveToFile();
  }
  if (!existingTables2.includes('class_students')) {
    db.run(`
      CREATE TABLE IF NOT EXISTS class_students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL REFERENCES classes(id),
        student_id INTEGER NOT NULL REFERENCES students(id),
        UNIQUE(class_id, student_id)
      );
    `);
    saveToFile();
  }
  if (!existingTables2.includes('course_schedules')) {
    db.run(`
      CREATE TABLE IF NOT EXISTS course_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id INTEGER NOT NULL REFERENCES courses(id),
        class_id INTEGER NOT NULL REFERENCES classes(id),
        teacher_id INTEGER NOT NULL REFERENCES users(id),
        classroom_id INTEGER REFERENCES classrooms(id),
        day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 1 AND 7),
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        semester TEXT NOT NULL,
        hours_per_session REAL NOT NULL DEFAULT 2,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled','makeup')),
        notes TEXT,
        created_at TEXT NOT NULL
      );
    `);
    saveToFile();
  }
  if (!existingTables2.includes('makeup_requests')) {
    db.run(`
      CREATE TABLE IF NOT EXISTS makeup_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_no TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('makeup','swap_class','reschedule')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled','revoked','resubmitted','completed')),
        teacher_id INTEGER NOT NULL REFERENCES users(id),
        course_id INTEGER NOT NULL REFERENCES courses(id),
        class_id INTEGER NOT NULL REFERENCES classes(id),
        student_ids TEXT,
        original_schedule_id INTEGER REFERENCES course_schedules(id),
        original_date TEXT,
        original_start_time TEXT,
        original_end_time TEXT,
        original_classroom_id INTEGER REFERENCES classrooms(id),
        new_class_id INTEGER REFERENCES classes(id),
        new_date TEXT,
        new_start_time TEXT,
        new_end_time TEXT,
        new_classroom_id INTEGER REFERENCES classrooms(id),
        new_teacher_id INTEGER REFERENCES users(id),
        hours REAL NOT NULL DEFAULT 2,
        reason TEXT NOT NULL,
        submit_reason TEXT,
        reject_reason TEXT,
        revoke_reason TEXT,
        approval_comment TEXT,
        approved_by INTEGER REFERENCES users(id),
        approved_at TEXT,
        rejected_by INTEGER REFERENCES users(id),
        rejected_at TEXT,
        revoked_by INTEGER REFERENCES users(id),
        revoked_at TEXT,
        cancelled_by INTEGER REFERENCES users(id),
        cancelled_at TEXT,
        resubmitted_count INTEGER NOT NULL DEFAULT 0,
        parent_request_id INTEGER REFERENCES makeup_requests(id),
        hours_written_back INTEGER NOT NULL DEFAULT 0,
        import_source TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    saveToFile();
  }
  if (!existingTables2.includes('makeup_approvals')) {
    db.run(`
      CREATE TABLE IF NOT EXISTS makeup_approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL REFERENCES makeup_requests(id),
        action TEXT NOT NULL CHECK(action IN ('submit','approve','reject','revoke','cancel','resubmit','writeback','import')),
        operator_id INTEGER REFERENCES users(id),
        operator_name TEXT,
        comment TEXT,
        details TEXT,
        created_at TEXT NOT NULL
      );
    `);
    saveToFile();
  }
  if (!existingTables2.includes('makeup_hours_writeback')) {
    db.run(`
      CREATE TABLE IF NOT EXISTS makeup_hours_writeback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL REFERENCES makeup_requests(id),
        schedule_id INTEGER REFERENCES course_schedules(id),
        original_hours REAL NOT NULL DEFAULT 0,
        delta_hours REAL NOT NULL DEFAULT 0,
        new_hours REAL NOT NULL DEFAULT 0,
        operator_id INTEGER REFERENCES users(id),
        operator_name TEXT,
        created_at TEXT NOT NULL
      );
    `);
    saveToFile();
  }

  const mrCols = all("PRAGMA table_info(makeup_requests)").map(c => c.name);
  if (!mrCols.includes('import_source')) {
    db.run('ALTER TABLE makeup_requests ADD COLUMN import_source TEXT');
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
  db.run(`
    CREATE TABLE IF NOT EXISTS classrooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 30,
      equipment TEXT
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_no TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      gender TEXT,
      contact TEXT
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS class_students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL REFERENCES classes(id),
      student_id INTEGER NOT NULL REFERENCES students(id),
      UNIQUE(class_id, student_id)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS course_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL REFERENCES courses(id),
      class_id INTEGER NOT NULL REFERENCES classes(id),
      teacher_id INTEGER NOT NULL REFERENCES users(id),
      classroom_id INTEGER REFERENCES classrooms(id),
      day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 1 AND 7),
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      semester TEXT NOT NULL,
      hours_per_session REAL NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled','makeup')),
      notes TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS makeup_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_no TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('makeup','swap_class','reschedule')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled','revoked','resubmitted','completed')),
      teacher_id INTEGER NOT NULL REFERENCES users(id),
      course_id INTEGER NOT NULL REFERENCES courses(id),
      class_id INTEGER NOT NULL REFERENCES classes(id),
      student_ids TEXT,
      original_schedule_id INTEGER REFERENCES course_schedules(id),
      original_date TEXT,
      original_start_time TEXT,
      original_end_time TEXT,
      original_classroom_id INTEGER REFERENCES classrooms(id),
      new_class_id INTEGER REFERENCES classes(id),
      new_date TEXT,
      new_start_time TEXT,
      new_end_time TEXT,
      new_classroom_id INTEGER REFERENCES classrooms(id),
      new_teacher_id INTEGER REFERENCES users(id),
      hours REAL NOT NULL DEFAULT 2,
      reason TEXT NOT NULL,
      submit_reason TEXT,
      reject_reason TEXT,
      revoke_reason TEXT,
      approval_comment TEXT,
      approved_by INTEGER REFERENCES users(id),
      approved_at TEXT,
      rejected_by INTEGER REFERENCES users(id),
      rejected_at TEXT,
      revoked_by INTEGER REFERENCES users(id),
      revoked_at TEXT,
      cancelled_by INTEGER REFERENCES users(id),
      cancelled_at TEXT,
      resubmitted_count INTEGER NOT NULL DEFAULT 0,
      parent_request_id INTEGER REFERENCES makeup_requests(id),
      hours_written_back INTEGER NOT NULL DEFAULT 0,
      import_source TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS makeup_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES makeup_requests(id),
      action TEXT NOT NULL CHECK(action IN ('submit','approve','reject','revoke','cancel','resubmit','writeback','import')),
      operator_id INTEGER REFERENCES users(id),
      operator_name TEXT,
      comment TEXT,
      details TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS makeup_hours_writeback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES makeup_requests(id),
      schedule_id INTEGER REFERENCES course_schedules(id),
      original_hours REAL NOT NULL DEFAULT 0,
      delta_hours REAL NOT NULL DEFAULT 0,
      new_hours REAL NOT NULL DEFAULT 0,
      operator_id INTEGER REFERENCES users(id),
      operator_name TEXT,
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

  db.run("INSERT INTO classrooms (name, capacity, equipment) VALUES ('物理实验室A101', 40, '示波器、万用表')");
  db.run("INSERT INTO classrooms (name, capacity, equipment) VALUES ('物理实验室A102', 35, '示波器、显微镜')");
  db.run("INSERT INTO classrooms (name, capacity, equipment) VALUES ('化学实验室B201', 30, '烧杯、试管')");
  db.run("INSERT INTO classrooms (name, capacity, equipment) VALUES ('生物实验室C301', 25, '显微镜')");

  db.run("INSERT INTO students (student_no, name, gender, contact) VALUES ('202501001', '小明', '男', '13800000001')");
  db.run("INSERT INTO students (student_no, name, gender, contact) VALUES ('202501002', '小红', '女', '13800000002')");
  db.run("INSERT INTO students (student_no, name, gender, contact) VALUES ('202501003', '小刚', '男', '13800000003')");
  db.run("INSERT INTO students (student_no, name, gender, contact) VALUES ('202501004', '小丽', '女', '13800000004')");
  db.run("INSERT INTO students (student_no, name, gender, contact) VALUES ('202501005', '小华', '男', '13800000005')");
  db.run("INSERT INTO students (student_no, name, gender, contact) VALUES ('202501006', '小芳', '女', '13800000006')");
  db.run("INSERT INTO students (student_no, name, gender, contact) VALUES ('202501007', '小强', '男', '13800000007')");
  db.run("INSERT INTO students (student_no, name, gender, contact) VALUES ('202501008', '小燕', '女', '13800000008')");

  db.run("INSERT INTO class_students (class_id, student_id) VALUES (1, 1)");
  db.run("INSERT INTO class_students (class_id, student_id) VALUES (1, 2)");
  db.run("INSERT INTO class_students (class_id, student_id) VALUES (1, 3)");
  db.run("INSERT INTO class_students (class_id, student_id) VALUES (1, 4)");
  db.run("INSERT INTO class_students (class_id, student_id) VALUES (2, 5)");
  db.run("INSERT INTO class_students (class_id, student_id) VALUES (2, 6)");
  db.run("INSERT INTO class_students (class_id, student_id) VALUES (3, 7)");
  db.run("INSERT INTO class_students (class_id, student_id) VALUES (3, 8)");

  db.run(`INSERT INTO course_schedules (course_id, class_id, teacher_id, classroom_id, day_of_week, start_time, end_time, semester, hours_per_session, status, notes, created_at) VALUES (1, 1, 2, 1, 3, '08:00', '10:00', '2025-2026-2', 2, 'active', '周三上午物理实验A班', '${now}')`);
  db.run(`INSERT INTO course_schedules (course_id, class_id, teacher_id, classroom_id, day_of_week, start_time, end_time, semester, hours_per_session, status, notes, created_at) VALUES (1, 2, 2, 2, 4, '14:00', '16:00', '2025-2026-2', 2, 'active', '周四下午物理实验B班', '${now}')`);
  db.run(`INSERT INTO course_schedules (course_id, class_id, teacher_id, classroom_id, day_of_week, start_time, end_time, semester, hours_per_session, status, notes, created_at) VALUES (2, 3, 3, 3, 2, '09:00', '11:00', '2025-2026-2', 2, 'active', '周二上午化学实验A班', '${now}')`);
  db.run(`INSERT INTO course_schedules (course_id, class_id, teacher_id, classroom_id, day_of_week, start_time, end_time, semester, hours_per_session, status, notes, created_at) VALUES (3, 1, 2, 4, 5, '10:00', '12:00', '2025-2026-2', 2, 'active', '周五上午生物基础实验', '${now}')`);

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

function generateMakeupRequestNo() {
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(Math.random() * 9000 + 1000);
  return `MK${ymd}${rand}`;
}

function dateToDayOfWeek(dateStr) {
  const d = new Date(dateStr);
  const wd = d.getDay();
  return wd === 0 ? 7 : wd;
}

function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function isTimeOverlap(s1, e1, s2, e2) {
  const a = timeToMinutes(s1);
  const b = timeToMinutes(e1);
  const c = timeToMinutes(s2);
  const d = timeToMinutes(e2);
  return !(b <= c || d <= a);
}

function parseStudentIds(studentIds) {
  if (!studentIds) return [];
  if (Array.isArray(studentIds)) return studentIds.map(Number).filter(n => !isNaN(n));
  try {
    const parsed = JSON.parse(studentIds);
    return Array.isArray(parsed) ? parsed.map(Number).filter(n => !isNaN(n)) : [];
  } catch (e) {
    return String(studentIds).split(',').map(s => Number(s.trim())).filter(n => !isNaN(n));
  }
}

function serializeStudentIds(arr) {
  if (!arr || arr.length === 0) return null;
  return JSON.stringify(arr.map(Number));
}

function getStudentsByClassId(classId) {
  return all(`
    SELECT s.* FROM students s
    JOIN class_students cs ON cs.student_id = s.id
    WHERE cs.class_id = ?
    ORDER BY s.student_no
  `, [classId]);
}

function getClassroomScheduleBusySlots(classroomId, date, excludeRequestId) {
  const dow = dateToDayOfWeek(date);
  const slots = [];

  all(`
    SELECT id, day_of_week, start_time, end_time, class_id
    FROM course_schedules
    WHERE classroom_id = ? AND status = 'active' AND day_of_week = ?
  `, [classroomId, dow]).forEach(r => {
    slots.push({ type: 'schedule', id: r.id, start: r.start_time, end: r.end_time, class_id: r.class_id });
  });

  const params = [classroomId, date];
  let excl = '';
  if (excludeRequestId) { params.push(excludeRequestId); excl = ' AND mr.id != ?'; }
  all(`
    SELECT mr.id, mr.new_start_time, mr.new_end_time, mr.class_id
    FROM makeup_requests mr
    WHERE mr.new_classroom_id = ? AND mr.new_date = ?
      AND mr.status IN ('pending','approved','resubmitted')${excl}
  `, params).forEach(r => {
    slots.push({ type: 'request', id: r.id, start: r.new_start_time, end: r.new_end_time, class_id: r.class_id });
  });
  return slots;
}

function getTeacherScheduleBusySlots(teacherId, date, excludeRequestId) {
  const dow = dateToDayOfWeek(date);
  const slots = [];

  all(`
    SELECT id, day_of_week, start_time, end_time, class_id
    FROM course_schedules
    WHERE teacher_id = ? AND status = 'active' AND day_of_week = ?
  `, [teacherId, dow]).forEach(r => {
    slots.push({ type: 'schedule', id: r.id, start: r.start_time, end: r.end_time, class_id: r.class_id });
  });

  const params = [teacherId, teacherId, date];
  let excl = '';
  if (excludeRequestId) { params.push(excludeRequestId); excl = ' AND mr.id != ?'; }
  all(`
    SELECT mr.id, mr.new_start_time, mr.new_end_time, mr.class_id
    FROM makeup_requests mr
    WHERE (mr.new_teacher_id = ? OR (mr.new_teacher_id IS NULL AND mr.teacher_id = ?))
      AND mr.new_date = ?
      AND mr.status IN ('pending','approved','resubmitted')${excl}
  `, params).forEach(r => {
    slots.push({ type: 'request', id: r.id, start: r.new_start_time, end: r.new_end_time, class_id: r.class_id });
  });
  return slots;
}

function getStudentBusySlots(studentIds, date, excludeRequestId) {
  if (!studentIds || studentIds.length === 0) return [];
  const dow = dateToDayOfWeek(date);
  const placeholders = studentIds.map(() => '?').join(',');
  const slots = [];

  all(`
    SELECT DISTINCT s.id, s.student_no, s.name, sc.day_of_week, sc.start_time, sc.end_time, sc.class_id
    FROM course_schedules sc
    JOIN class_students cs ON cs.class_id = sc.class_id
    JOIN students s ON s.id = cs.student_id
    WHERE s.id IN (${placeholders}) AND sc.status = 'active' AND sc.day_of_week = ?
  `, [...studentIds, dow]).forEach(r => {
    slots.push({ type: 'schedule', student_id: r.id, student_no: r.student_no, student_name: r.name,
      start: r.start_time, end: r.end_time, class_id: r.class_id });
  });

  const classFilterSQL = `mr.class_id IN (SELECT class_id FROM class_students WHERE student_id IN (${placeholders}))`;
  let excl = '';
  const reqParams = [...studentIds, date];
  if (excludeRequestId) { reqParams.push(excludeRequestId); excl = ' AND mr.id != ?'; }
  const studentBusyReqs = all(`
    SELECT DISTINCT mr.id, mr.new_start_time, mr.new_end_time, mr.class_id, mr.student_ids
    FROM makeup_requests mr
    WHERE (${classFilterSQL} OR mr.student_ids IS NOT NULL)
      AND mr.new_date = ?
      AND mr.status IN ('pending','approved','resubmitted')
      ${excl}
  `, reqParams);

  studentBusyReqs.forEach(r => {
    const reqStudentIds = parseStudentIds(r.student_ids);
    if (reqStudentIds.length > 0) {
      reqStudentIds.forEach(sid => {
        if (studentIds.includes(sid)) {
          const st = get('SELECT id, student_no, name FROM students WHERE id = ?', [sid]);
          if (st) slots.push({
            type: 'request', request_id: r.id, student_id: sid, student_no: st.student_no, student_name: st.name,
            start: r.new_start_time, end: r.new_end_time, class_id: r.class_id
          });
        }
      });
    } else {
      const classStudents = getStudentsByClassId(r.class_id);
      classStudents.forEach(st => {
        if (studentIds.includes(st.id)) {
          slots.push({
            type: 'request', request_id: r.id, student_id: st.id, student_no: st.student_no, student_name: st.name,
            start: r.new_start_time, end: r.new_end_time, class_id: r.class_id
          });
        }
      });
    }
  });
  return slots;
}

function checkAllTimeConflicts(opts) {
  const {
    teacherId, classroomId, studentIds, date, startTime, endTime, excludeRequestId, classId, newClassId
  } = opts;

  const conflicts = { teacher: [], classroom: [], student: [] };

  if (teacherId && date && startTime && endTime) {
    const tSlots = getTeacherScheduleBusySlots(teacherId, date, excludeRequestId);
    tSlots.forEach(s => {
      if (isTimeOverlap(startTime, endTime, s.start, s.end)) {
        conflicts.teacher.push({ ...s, date, teacher_id: teacherId });
      }
    });
  }

  if (classroomId && date && startTime && endTime) {
    const cSlots = getClassroomScheduleBusySlots(classroomId, date, excludeRequestId);
    cSlots.forEach(s => {
      if (isTimeOverlap(startTime, endTime, s.start, s.end)) {
        conflicts.classroom.push({ ...s, date, classroom_id: classroomId });
      }
    });
  }

  const actualStudentIds = (studentIds && studentIds.length > 0) ? studentIds :
    (classId ? getStudentsByClassId(newClassId || classId).map(s => s.id) : []);

  if (actualStudentIds.length > 0 && date && startTime && endTime) {
    const sSlots = getStudentBusySlots(actualStudentIds, date, excludeRequestId);
    const seen = new Set();
    sSlots.forEach(s => {
      if (isTimeOverlap(startTime, endTime, s.start, s.end)) {
        const key = `${s.student_id}|${s.start}|${s.end}|${s.type}`;
        if (!seen.has(key)) {
          seen.add(key);
          conflicts.student.push({ ...s, date });
        }
      }
    });
  }

  const total = conflicts.teacher.length + conflicts.classroom.length + conflicts.student.length;
  return { has_conflict: total > 0, conflicts, total };
}

function addMakeupApproval(requestId, action, operatorId, operatorName, comment, details) {
  const now = new Date().toISOString();
  insertRun(
    `INSERT INTO makeup_approvals (request_id, action, operator_id, operator_name, comment, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [requestId, action, operatorId, operatorName, comment,
      details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null, now]
  );
}

function getMakeupApprovalsByRequestId(requestId) {
  return all(`
    SELECT ma.*, u.username AS operator_username
    FROM makeup_approvals ma
    LEFT JOIN users u ON ma.operator_id = u.id
    WHERE ma.request_id = ?
    ORDER BY ma.created_at ASC, ma.id ASC
  `, [requestId]);
}

function getMakeupRequestById(id) {
  const row = get(`
    SELECT mr.*,
      tc.name AS course_name,
      tcl.name AS class_name, tcl.semester AS class_semester,
      tu.name AS teacher_name,
      ncl.name AS new_class_name,
      ntu.name AS new_teacher_name,
      ocr.name AS original_classroom_name,
      ncr.name AS new_classroom_name
    FROM makeup_requests mr
    JOIN courses tc ON tc.id = mr.course_id
    JOIN classes tcl ON tcl.id = mr.class_id
    JOIN users tu ON tu.id = mr.teacher_id
    LEFT JOIN classes ncl ON ncl.id = mr.new_class_id
    LEFT JOIN users ntu ON ntu.id = mr.new_teacher_id
    LEFT JOIN classrooms ocr ON ocr.id = mr.original_classroom_id
    LEFT JOIN classrooms ncr ON ncr.id = mr.new_classroom_id
    WHERE mr.id = ?
  `, [id]);
  if (!row) return null;
  row.student_ids_parsed = parseStudentIds(row.student_ids);
  row.approvals = getMakeupApprovalsByRequestId(id);
  return row;
}

function getMakeupRequestsByFilters(filters = {}, currentUser) {
  let sql = `
    SELECT mr.*,
      tc.name AS course_name,
      tcl.name AS class_name, tcl.semester AS class_semester,
      tu.name AS teacher_name,
      ncl.name AS new_class_name,
      ocr.name AS original_classroom_name,
      ncr.name AS new_classroom_name,
      (SELECT COUNT(*) FROM makeup_approvals ma WHERE ma.request_id = mr.id) AS approval_count
    FROM makeup_requests mr
    JOIN courses tc ON tc.id = mr.course_id
    JOIN classes tcl ON tcl.id = mr.class_id
    JOIN users tu ON tu.id = mr.teacher_id
    LEFT JOIN classes ncl ON ncl.id = mr.new_class_id
    LEFT JOIN classrooms ocr ON ocr.id = mr.original_classroom_id
    LEFT JOIN classrooms ncr ON ncr.id = mr.new_classroom_id
    WHERE 1=1
  `;
  const params = [];

  if (currentUser && currentUser.role === 'teacher') {
    sql += ' AND mr.teacher_id = ?';
    params.push(currentUser.id);
  }

  if (filters.status) {
    sql += ' AND mr.status = ?';
    params.push(filters.status);
  }
  if (filters.type) {
    sql += ' AND mr.type = ?';
    params.push(filters.type);
  }
  if (filters.teacher_id) {
    sql += ' AND mr.teacher_id = ?';
    params.push(parseInt(filters.teacher_id));
  }
  if (filters.course_id) {
    sql += ' AND mr.course_id = ?';
    params.push(parseInt(filters.course_id));
  }
  if (filters.class_id) {
    sql += ' AND mr.class_id = ?';
    params.push(parseInt(filters.class_id));
  }
  if (filters.request_no) {
    sql += ' AND mr.request_no LIKE ?';
    params.push(`%${filters.request_no}%`);
  }
  if (filters.date_start) {
    sql += ' AND COALESCE(mr.new_date, mr.original_date) >= ?';
    params.push(filters.date_start);
  }
  if (filters.date_end) {
    sql += ' AND COALESCE(mr.new_date, mr.original_date) <= ?';
    params.push(filters.date_end);
  }

  sql += ' ORDER BY mr.created_at DESC, mr.id DESC LIMIT 500';

  const rows = all(sql, params);
  rows.forEach(r => {
    r.student_ids_parsed = parseStudentIds(r.student_ids);
  });
  return rows;
}

function writeBackHours(requestId, operatorId, operatorName) {
  const req = getMakeupRequestById(requestId);
  if (!req) return { ok: false, error: '申请不存在' };
  if (req.hours_written_back) return { ok: false, error: '该申请已完成课时回写' };

  const now = new Date().toISOString();
  const scheduleId = req.original_schedule_id;
  let originalHours = 0;
  if (scheduleId) {
    const s = get('SELECT hours_per_session FROM course_schedules WHERE id = ?', [scheduleId]);
    if (s) originalHours = s.hours_per_session;
  }
  const delta = (req.hours || 0) - originalHours;

  insertRun(
    `INSERT INTO makeup_hours_writeback (request_id, schedule_id, original_hours, delta_hours, new_hours, operator_id, operator_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [requestId, scheduleId, originalHours, delta, req.hours || 0, operatorId, operatorName, now]
  );

  run('UPDATE makeup_requests SET hours_written_back = 1, updated_at = ? WHERE id = ?', [now, requestId]);

  addMakeupApproval(requestId, 'writeback', operatorId, operatorName,
    `课时回写: 原${originalHours}课时, 新${req.hours || 0}课时, 差异${delta >= 0 ? '+' : ''}${delta}`,
    { original_hours: originalHours, new_hours: req.hours || 0, delta_hours: delta });

  addLog('makeup_writeback_hours', operatorId, operatorName, {
    request_id: requestId, request_no: req.request_no,
    original_hours: originalHours, new_hours: req.hours || 0, delta_hours: delta
  });

  return { ok: true, original_hours: originalHours, new_hours: req.hours || 0, delta_hours: delta };
}

function getMakeupWritebackByRequestId(requestId) {
  return all(`
    SELECT mhw.*, u.username AS operator_username
    FROM makeup_hours_writeback mhw
    LEFT JOIN users u ON mhw.operator_id = u.id
    WHERE mhw.request_id = ?
    ORDER BY mhw.created_at ASC
  `, [requestId]);
}

function getMakeupStats(currentUser) {
  const base = currentUser && currentUser.role === 'teacher'
    ? ' WHERE teacher_id = ' + currentUser.id : '';
  const rows = all(`SELECT status, COUNT(*) AS cnt FROM makeup_requests${base} GROUP BY status`);
  const typeRows = all(`SELECT type, COUNT(*) AS cnt FROM makeup_requests${base} GROUP BY type`);
  const stats = {
    total: 0, pending: 0, approved: 0, rejected: 0, cancelled: 0, revoked: 0, resubmitted: 0, completed: 0,
    by_type: { makeup: 0, swap_class: 0, reschedule: 0 }
  };
  rows.forEach(r => { stats[r.status] = r.cnt; stats.total += r.cnt; });
  typeRows.forEach(r => { stats.by_type[r.type] = r.cnt; });
  return stats;
}

function getClassrooms() {
  return all('SELECT * FROM classrooms ORDER BY id');
}

function getStudents(query) {
  let sql = 'SELECT * FROM students';
  const params = [];
  if (query) {
    sql += ' WHERE name LIKE ? OR student_no LIKE ?';
    params.push(`%${query}%`, `%${query}%`);
  }
  sql += ' ORDER BY student_no LIMIT 200';
  return all(sql, params);
}

function getSchedulesByClassId(classId) {
  return all(`
    SELECT cs.*, c.name AS classroom_name, u.name AS teacher_name
    FROM course_schedules cs
    LEFT JOIN classrooms c ON c.id = cs.classroom_id
    LEFT JOIN users u ON u.id = cs.teacher_id
    WHERE cs.class_id = ? AND cs.status = 'active'
    ORDER BY cs.day_of_week, cs.start_time
  `, [classId]);
}

function getSchedulesByTeacherId(teacherId) {
  return all(`
    SELECT cs.*, c.name AS classroom_name, cl.name AS class_name
    FROM course_schedules cs
    LEFT JOIN classrooms c ON c.id = cs.classroom_id
    LEFT JOIN classes cl ON cl.id = cs.class_id
    WHERE cs.teacher_id = ? AND cs.status = 'active'
    ORDER BY cs.day_of_week, cs.start_time
  `, [teacherId]);
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
  getLedgerSummary,
  generateMakeupRequestNo,
  dateToDayOfWeek,
  timeToMinutes,
  isTimeOverlap,
  parseStudentIds,
  serializeStudentIds,
  getStudentsByClassId,
  getClassroomScheduleBusySlots,
  getTeacherScheduleBusySlots,
  getStudentBusySlots,
  checkAllTimeConflicts,
  addMakeupApproval,
  getMakeupApprovalsByRequestId,
  getMakeupRequestById,
  getMakeupRequestsByFilters,
  writeBackHours,
  getMakeupWritebackByRequestId,
  getMakeupStats,
  getClassrooms,
  getStudents,
  getSchedulesByClassId,
  getSchedulesByTeacherId
};
