const http = require('http');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const TEST_PORT = process.env.TEST_PORT || 3098;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; process.exitCode = 1; }
}

function request(method, path, body, cookieJar) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const opts = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method, headers: {}
    };
    let b;
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      b = JSON.stringify(body);
      opts.headers['Content-Length'] = Buffer.byteLength(b);
    }
    if (cookieJar) opts.headers['Cookie'] = cookieJar;
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; } catch(e) { parsed = {}; }
        const setCookie = res.headers['set-cookie'];
        if (setCookie && cookieJar !== undefined) {
          const newSid = setCookie[0].split(';')[0];
          if (newSid.startsWith('sid=')) cookieJar = newSid;
        }
        resolve({ status: res.statusCode, body: parsed, cookie: cookieJar });
      });
    });
    req.on('error', reject);
    if (b) req.write(b);
    req.end();
  });
}

async function login(u, p, cookie) {
  return request('POST', '/api/login', { username: u, password: p }, cookie);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitForPort(port, timeout = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        res.resume();
        resolve(true);
      }).on('error', () => {
        if (Date.now() - start > timeout) reject(new Error('端口超时'));
        else setTimeout(check, 300);
      });
      req.setTimeout(500, () => req.destroy());
    };
    check();
  });
}

let serverProc = null;

function startServer() {
  const { spawn } = require('child_process');
  const env = Object.assign({}, process.env, { PORT: TEST_PORT });
  serverProc = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return waitForPort(TEST_PORT);
}

function killServer() {
  return new Promise(resolve => {
    if (!serverProc) return resolve();
    try {
      const pid = serverProc.pid;
      if (process.platform === 'win32') {
        try { execSync(`taskkill /F /PID ${pid} /T 2>nul`, { stdio: 'ignore' }); } catch (_) {}
      } else {
        serverProc.kill('SIGKILL');
      }
    } catch (_) {}
    setTimeout(async () => {
      if (process.platform === 'win32') {
        try {
          const nets = execSync(`netstat -ano 2>nul | findstr :${TEST_PORT} | findstr LISTENING`, { encoding: 'utf8' }).trim();
          const lines = nets.split('\n').filter(l => l.length > 0);
          lines.forEach(l => {
            const m = l.match(/(\d+)\s*$/);
            if (m) try { execSync(`taskkill /F /PID ${m[1]} /T 2>nul`, { stdio: 'ignore' }); } catch(_) {}
          });
        } catch(_) {}
      }
      serverProc = null;
      await sleep(2000);
      resolve();
    }, 500);
  });
}

let beforeRestartState = null;

async function runPhase1() {
  console.log('\n=== [阶段 1] 重启前：准备数据并记录状态 ===\n');

  console.log('--- 重置数据 ---');
  await request('POST', '/api/reset', {}, '');

  let adminCookie = '';
  const admin = await login('admin', 'admin123', '');
  adminCookie = admin.cookie;
  assert(admin.status === 200, '管理员登录成功');

  console.log('\n--- 准备数据：创建结转、导出、对比、说明 ---');

  const res1 = await request('POST', '/api/reservations', {
    course_id: 1, class_id: 1, equipment_id: 1, qty: 1, week_key: '2026-W60'
  }, adminCookie);
  assert(res1.status === 200, '创建预约成功');

  await request('PUT', `/api/reservations/${res1.body.id}/approve`, {}, adminCookie);
  await request('PUT', `/api/reservations/${res1.body.id}/collect`, {}, adminCookie);
  await request('PUT', `/api/reservations/${res1.body.id}/return`, { return_qty: 1 }, adminCookie);

  const st1 = await request('POST', '/api/settlements/weekly', { week_key: '2026-W60' }, adminCookie);
  assert(st1.status === 200, 'W60 结转成功');
  const settlementId1 = st1.body.id;

  await request('POST', `/api/settlements/${settlementId1}/notes`, { content: '重启前测试说明1' }, adminCookie);
  await request('POST', `/api/settlements/${settlementId1}/notes`, { content: '重启前测试说明2' }, adminCookie);

  await request('GET', '/api/export/2026-W60', null, adminCookie);

  const res2 = await request('POST', '/api/reservations', {
    course_id: 2, class_id: 3, equipment_id: 3, qty: 2, week_key: '2026-W61'
  }, adminCookie);
  assert(res2.status === 200, '创建 W61 预约成功');

  await request('PUT', `/api/reservations/${res2.body.id}/approve`, {}, adminCookie);
  await request('PUT', `/api/reservations/${res2.body.id}/collect`, {}, adminCookie);
  await request('PUT', `/api/reservations/${res2.body.id}/return`, { return_qty: 2 }, adminCookie);

  const st2 = await request('POST', '/api/settlements/weekly', { week_key: '2026-W61' }, adminCookie);
  assert(st2.status === 200, 'W61 结转成功');
  const settlementId2 = st2.body.id;

  await request('GET', '/api/export/2026-W61', null, adminCookie);

  await request('POST', '/api/settlements/compare/export-csv', {
    settlement_a_id: settlementId1, settlement_b_id: settlementId2
  }, adminCookie);

  console.log('\n--- 撤销 W61，产生失效记录 ---');

  const revoke = await request('DELETE', '/api/settlements/2026-W61/revoke', null, adminCookie);
  assert(revoke.status === 200, '撤销 W61 成功');

  console.log('\n--- 记录重启前台账状态 ---');

  const ledgerBefore = await request('GET', '/api/settlements/ledger', null, adminCookie);
  assert(ledgerBefore.status === 200, '获取重启前台账成功');

  const validBefore = ledgerBefore.body.list.filter(x => x.invalid === 0);
  const invalidBefore = ledgerBefore.body.list.filter(x => x.invalid === 1);

  beforeRestartState = {
    total_count: ledgerBefore.body.list.length,
    valid_count: validBefore.length,
    invalid_count: invalidBefore.length,
    single_count: ledgerBefore.body.list.filter(x => x.type === 'single').length,
    comparison_count: ledgerBefore.body.list.filter(x => x.type === 'comparison').length,
    summary: ledgerBefore.body.summary,
    w60_item: ledgerBefore.body.list.find(x => x.week_key_a === '2026-W60' && x.type === 'single'),
    w61_invalid_items: ledgerBefore.body.list.filter(x =>
      (x.week_key_a === '2026-W61' || x.week_key_b === '2026-W61') && x.invalid === 1
    ),
    revoked_at: revoke.body.revoked_at,
    settlement_id_1: settlementId1
  };

  assert(beforeRestartState.total_count >= 3, `重启前至少 3 条记录（实际: ${beforeRestartState.total_count}）`);
  assert(beforeRestartState.invalid_count >= 2, `重启前至少 2 条失效记录（实际: ${beforeRestartState.invalid_count}）`);
  assert(beforeRestartState.w60_item, '重启前 W60 记录存在');
  assert(beforeRestartState.w60_item.related_note_count === 2, '重启前 W60 关联说明条数为 2');
  assert(beforeRestartState.w60_item.invalid === 0, '重启前 W60 状态为有效');
  assert(beforeRestartState.w61_invalid_items.length >= 2, '重启前 W61 相关记录为失效状态');

  beforeRestartState.w61_invalid_items.forEach(item => {
    assert(item.invalidated_reason === '撤销周结转', '重启前失效原因正确');
    assert(item.last_cleaned_stats !== null, '重启前失效记录包含清理统计');
  });

  console.log('\n--- 重启前权限验证 ---');

  const teacher = await login('zhangsan', '123456', '');
  const teacherLedger = await request('GET', '/api/settlements/ledger', null, teacher.cookie);
  assert(teacherLedger.status === 403, '重启前教师访问台账返回 403');

  console.log('\n--- 导出重启前台账 CSV ---');
  const exportBefore = await request('GET', '/api/settlements/ledger/export/csv?invalid=false', null, adminCookie);
  assert(exportBefore.status === 200, '重启前导出台账成功');
  beforeRestartState.export_row_count = exportBefore.body.length;

  const logsBefore = await request('GET', '/api/logs', null, adminCookie);
  beforeRestartState.log_actions = logsBefore.body.map(l => l.action);
  beforeRestartState.revoke_log = logsBefore.body.find(l => l.action === 'revoke_weekly_settlement');

  assert(beforeRestartState.log_actions.includes('export_settlement_single_json'), '重启前日志包含单周导出');
  assert(beforeRestartState.log_actions.includes('export_settlement_ledger_csv'), '重启前日志包含台账导出');
  assert(beforeRestartState.revoke_log, '重启前撤销日志存在');

  console.log('\n✅ 阶段 1 完成，数据状态已记录');
  return adminCookie;
}

async function runPhase2(adminCookie) {
  console.log('\n=== [阶段 2] 重启后：核对数据一致性 ===\n');

  console.log('\n--- 等待服务器就绪 ---');
  let healthOk = false;
  for (let i = 0; i < 10; i++) {
    try {
      const health = await request('GET', '/api/health', null, '');
      if (health.status === 200) {
        healthOk = true;
        break;
      }
    } catch (e) {}
    await sleep(500);
  }
  assert(healthOk, '重启后服务器健康检查通过');

  console.log('\n--- 重新登录（会话可能过期）---');
  const reLogin = await login('admin', 'admin123', '');
  adminCookie = reLogin.cookie;
  assert(reLogin.status === 200, '重启后重新登录成功');

  console.log('\n--- 重启后台账列表核对 ---');

  const ledgerAfter = await request('GET', '/api/settlements/ledger', null, adminCookie);
  assert(ledgerAfter.status === 200, '获取重启后台账成功');

  assert(ledgerAfter.body.list.length === beforeRestartState.total_count,
    `重启后记录总数一致（预期: ${beforeRestartState.total_count}, 实际: ${ledgerAfter.body.list.length}）`);
  assert(ledgerAfter.body.summary.total_count === beforeRestartState.summary.total_count,
    '重启后 summary total_count 一致');
  assert(ledgerAfter.body.summary.valid_count === beforeRestartState.summary.valid_count,
    '重启后 summary valid_count 一致');
  assert(ledgerAfter.body.summary.invalid_count === beforeRestartState.summary.invalid_count,
    '重启后 summary invalid_count 一致');
  assert(ledgerAfter.body.summary.single_count === beforeRestartState.summary.single_count,
    '重启后 summary single_count 一致');
  assert(ledgerAfter.body.summary.comparison_count === beforeRestartState.summary.comparison_count,
    '重启后 summary comparison_count 一致');

  console.log('\n--- 重启后 W60 记录核对 ---');

  const w60After = ledgerAfter.body.list.find(x => x.week_key_a === '2026-W60' && x.type === 'single');
  assert(w60After, '重启后 W60 记录存在');
  assert(w60After.invalid === 0, '重启后 W60 状态仍为有效');
  assert(w60After.related_note_count === 2, '重启后 W60 关联说明条数仍为 2');
  assert(w60After.filename === beforeRestartState.w60_item.filename, '重启后 filename 一致');
  assert(w60After.row_count === beforeRestartState.w60_item.row_count, '重启后 row_count 一致');
  assert(w60After.created_by_user_name === beforeRestartState.w60_item.created_by_user_name, '重启后操作人一致');
  assert(w60After.created_at === beforeRestartState.w60_item.created_at, '重启后创建时间一致');

  console.log('\n--- 重启后 W61 失效记录核对 ---');

  const w61InvalidAfter = ledgerAfter.body.list.filter(x =>
    (x.week_key_a === '2026-W61' || x.week_key_b === '2026-W61') && x.invalid === 1
  );
  assert(w61InvalidAfter.length === beforeRestartState.w61_invalid_items.length,
    `重启后失效记录数量一致（预期: ${beforeRestartState.w61_invalid_items.length}, 实际: ${w61InvalidAfter.length}）`);

  w61InvalidAfter.forEach(item => {
    assert(item.invalidated_reason === '撤销周结转', '重启后失效原因正确');
    assert(item.invalidated_at !== null, '重启后失效时间存在');
    assert(item.invalidated_by_user_name !== null, '重启后失效人存在');
    assert(item.last_cleaned_stats !== null, '重启后清理统计存在');
    assert(item.last_cleaned_stats.cleaned_notes !== undefined, '重启后清理统计包含 cleaned_notes');
    assert(item.last_cleaned_stats.cleaned_exports_total !== undefined, '重启后清理统计包含 cleaned_exports_total');
  });

  console.log('\n--- 重启后筛选功能核对 ---');

  const filterValidAfter = await request('GET', '/api/settlements/ledger?invalid=false', null, adminCookie);
  assert(filterValidAfter.body.list.every(x => x.invalid === 0), '重启后筛选有效记录正确');
  assert(filterValidAfter.body.list.length === beforeRestartState.valid_count, '重启后有效记录数量一致');

  const filterInvalidAfter = await request('GET', '/api/settlements/ledger?invalid=true', null, adminCookie);
  assert(filterInvalidAfter.body.list.every(x => x.invalid === 1), '重启后筛选失效记录正确');
  assert(filterInvalidAfter.body.list.length === beforeRestartState.invalid_count, '重启后失效记录数量一致');

  const filterWeekAfter = await request('GET', '/api/settlements/ledger?week_key_start=2026-W60&week_key_end=2026-W60', null, adminCookie);
  const w60OnlyAfter = filterWeekAfter.body.list.filter(x => x.week_key_a === '2026-W60' && !x.week_key_b);
  assert(w60OnlyAfter.length === 1, '重启后按周次筛选正确');

  console.log('\n--- 重启后详情接口核对 ---');

  const detailId = w60After.id;
  const detailAfter = await request('GET', `/api/settlements/ledger/${detailId}`, null, adminCookie);
  assert(detailAfter.status === 200, '重启后获取详情成功');
  assert(detailAfter.body.id === detailId, '重启后详情 ID 正确');
  assert(detailAfter.body.related_note_count === 2, '重启后详情关联说明条数正确');

  console.log('\n--- 重启后权限验证 ---');

  const teacherAfter = await login('zhangsan', '123456', '');
  const teacherLedgerAfter = await request('GET', '/api/settlements/ledger', null, teacherAfter.cookie);
  assert(teacherLedgerAfter.status === 403, '重启后教师访问台账仍返回 403');

  const teacherExportAfter = await request('GET', '/api/settlements/ledger/export/csv', null, teacherAfter.cookie);
  assert(teacherExportAfter.status === 403, '重启后教师导出台账仍返回 403');

  const teacherDetailAfter = await request('GET', '/api/settlements/ledger/1', null, teacherAfter.cookie);
  assert(teacherDetailAfter.status === 403, '重启后教师访问详情仍返回 403');

  console.log('\n--- 重启后操作日志核对 ---');

  const logsAfter = await request('GET', '/api/logs', null, adminCookie);
  const actionsAfter = logsAfter.body.map(l => l.action);
  assert(actionsAfter.includes('export_settlement_single_json'), '重启后日志仍包含单周导出');
  assert(actionsAfter.includes('export_settlement_ledger_csv'), '重启后日志仍包含台账导出');
  assert(actionsAfter.includes('revoke_weekly_settlement'), '重启后日志仍包含撤销');

  const revokeLogAfter = logsAfter.body.find(l => l.action === 'revoke_weekly_settlement');
  assert(revokeLogAfter, '重启后撤销日志存在');
  const revokeDetailsAfter = typeof revokeLogAfter.details === 'string' ? JSON.parse(revokeLogAfter.details) : revokeLogAfter.details;
  assert(revokeDetailsAfter.cleaned_notes !== undefined, '重启后撤销日志包含 cleaned_notes');
  assert(revokeDetailsAfter.cleaned_exports_total !== undefined, '重启后撤销日志包含 cleaned_exports_total');

  console.log('\n--- 重启后摘要接口核对 ---');

  const summaryAfter = await request('GET', '/api/settlements/ledger/summary', null, adminCookie);
  assert(summaryAfter.body.total_count === beforeRestartState.summary.total_count, '重启后摘要 total_count 一致');
  assert(summaryAfter.body.invalid_count === beforeRestartState.summary.invalid_count, '重启后摘要 invalid_count 一致');

  console.log('\n--- 重启后台账导出核对 ---');

  const exportAfter = await request('GET', '/api/settlements/ledger/export/csv?invalid=false', null, adminCookie);
  assert(exportAfter.status === 200, '重启后导出台账成功');

  console.log('\n--- 重启后执行新操作：再次导出、再次撤销 ---');

  const newExp = await request('GET', '/api/export/2026-W60', null, adminCookie);
  assert(newExp.status === 200, '重启后新导出成功');

  const ledgerAfterNewExp = await request('GET', '/api/settlements/ledger', null, adminCookie);
  const newValidCount = ledgerAfterNewExp.body.list.filter(x => x.invalid === 0).length;
  assert(newValidCount === beforeRestartState.valid_count + 1, '重启后新导出增加一条有效记录');

  const newW60Valid = ledgerAfterNewExp.body.list.find(x =>
    x.week_key_a === '2026-W60' && x.type === 'single' && x.invalid === 0 && x.created_at > beforeRestartState.w60_item.created_at
  );
  assert(newW60Valid, '重启后新导出的 W60 记录为有效状态');

  const oldW60Valid = ledgerAfterNewExp.body.list.find(x =>
    x.week_key_a === '2026-W60' && x.type === 'single' && x.id === beforeRestartState.w60_item.id
  );
  assert(oldW60Valid && oldW60Valid.invalid === 0, '重启后旧的 W60 记录仍为有效状态');

  console.log('\n--- 重启后执行完整撤销链路验证 ---');

  const st3 = await request('POST', '/api/settlements/weekly', { week_key: '2026-W62' }, adminCookie);
  assert(st3.status === 200, '重启后结转 W62 成功');

  await request('GET', '/api/export/2026-W62', null, adminCookie);

  const cmpExp = await request('POST', '/api/settlements/compare/export-csv', {
    settlement_a_id: beforeRestartState.settlement_id_1, settlement_b_id: st3.body.id
  }, adminCookie);
  assert(cmpExp.status === 200, '重启后导出对比 CSV 成功');

  const beforeRevoke2 = await request('GET', '/api/settlements/ledger', null, adminCookie);
  const validBefore2 = beforeRevoke2.body.list.filter(x => x.invalid === 0).length;

  const revoke2 = await request('DELETE', '/api/settlements/2026-W62/revoke', null, adminCookie);
  assert(revoke2.status === 200, '重启后撤销 W62 成功');

  const afterRevoke2 = await request('GET', '/api/settlements/ledger', null, adminCookie);
  const w62Invalid = afterRevoke2.body.list.filter(x =>
    (x.week_key_a === '2026-W62' || x.week_key_b === '2026-W62') && x.invalid === 1
  );
  assert(w62Invalid.length >= 2, '重启后撤销时相关记录正确标记为失效');

  const revokeLog2 = afterRevoke2.body.list.find(x =>
    x.week_key_a === '2026-W62' && !x.week_key_b && x.invalid === 1
  );
  assert(revokeLog2.invalidated_reason === '撤销周结转', '重启后撤销原因正确');
  assert(revokeLog2.last_cleaned_stats !== null, '重启后撤销清理统计正确');
  assert(revokeLog2.last_cleaned_stats.cleaned_exports_total >= 1, '重启后撤销清理统计包含正确的导出数');

  console.log('\n✅ 阶段 2 完成，重启后所有数据和状态一致');
}

async function main() {
  console.log('\n========== 台账重启回归测试启动（端口 ' + TEST_PORT + '） ==========\n');

  // 临时给 server.js 加 /api/health
  const serverFile = path.join(__dirname, 'server.js');
  const serverOld = fs.readFileSync(serverFile, 'utf8');
  if (!serverOld.includes('/api/health')) {
    let newSrv = serverOld.replace("app.get('/api/me'", `app.get('/api/health', (req, res) => res.json({ok:true}));\napp.get('/api/me'`);
    fs.writeFileSync(serverFile, newSrv);
  }

  console.log('\n[启动服务器]');
  const started = await startServer();
  if (!started) { console.error('无法启动服务器，终止'); process.exit(1); }
  console.log('  ✓ 服务器启动成功');

  let adminCookie = null;
  try {
    adminCookie = await runPhase1();

    console.log('\n[停止服务器]');
    await killServer();
    console.log('  ✓ 服务器已停止');

    console.log('\n[等待 3 秒]');
    await sleep(3000);

    console.log('\n[重启服务器]');
    const restarted = await startServer();
    if (!restarted) { console.error('重启服务器失败，终止'); process.exit(1); }
    console.log('  ✓ 服务器重启成功');

    await runPhase2(adminCookie);
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    console.log('\n[清理]');
    fs.writeFileSync(serverFile, serverOld);
    await killServer();
  }

  console.log('\n========== 台账重启回归测试结束 ==========');
  console.log(`  总体: ${failed === 0 ? '✅ 全部通过' : '❌ 有失败项'}`);
  console.log(`  通过: ${passed}, 失败: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

process.on('SIGINT', async () => { console.log('\nCtrl+C, 清理服务器...'); await killServer(); process.exit(2); });
process.on('exit', async () => { if (serverProc) await killServer(); });

main().catch(e => { console.error(e); killServer().then(() => process.exit(1)); });
