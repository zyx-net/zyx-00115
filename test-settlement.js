const http = require('http');

const BASE = 'http://localhost:3001';
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

async function runTests() {
  console.log('\n=== 结转闭环回归测试 ===\n');

  console.log('--- 步骤 0: 重置数据 ---');
  await request('POST', '/api/reset', {}, '');

  let cookie = '';
  const admin = await login('admin', 'admin123', '');
  cookie = admin.cookie;
  assert(admin.status === 200, '管理员登录成功');

  console.log('\n=== 1. 基础结转流程 ===');
  const res1 = await request('POST', '/api/reservations', {
    course_id: 3, class_id: 2, equipment_id: 2, qty: 1, week_key: '2026-W88'
  }, cookie);
  assert(res1.status === 200, '预约万用表 1 件成功');
  const rsvId = res1.body.id;

  await request('PUT', `/api/reservations/${rsvId}/approve`, {}, cookie);
  await request('PUT', `/api/reservations/${rsvId}/collect`, {}, cookie);
  await request('PUT', `/api/reservations/${rsvId}/return`, { return_qty: 1 }, cookie);

  const st1 = await request('POST', '/api/settlements/weekly', { week_key: '2026-W88' }, cookie);
  assert(st1.status === 200, 'W88 结转成功');
  assert(st1.body.source === 'settled', '结转 source = settled');
  assert(st1.body.revoked === 0, '结转 revoked = 0');
  const origSettledAt = st1.body.settled_at;
  const origTotals = st1.body.totals;

  const dupSet = await request('POST', '/api/settlements/weekly', { week_key: '2026-W88' }, cookie);
  assert(dupSet.status === 409, '重复结转返回 409');

  console.log('\n=== 2. 导出结转 JSON ===');
  const exp1 = await request('GET', '/api/export/2026-W88', null, cookie);
  assert(exp1.status === 200, '导出成功');
  const exported = exp1.body;
  assert(exported.week_key === '2026-W88', '导出 week_key 正确');
  assert(JSON.stringify(exported.totals.equipment_snapshot) === JSON.stringify(origTotals.equipment_snapshot),
    '导出器材快照与结转一致');
  assert(JSON.stringify(exported.totals.reservation_summary) === JSON.stringify(origTotals.reservation_summary),
    '导出预约汇总与结转一致');
  assert(JSON.stringify(exported.totals.loss_summary) === JSON.stringify(origTotals.loss_summary),
    '导出损耗汇总与结转一致');
  assert(JSON.stringify(exported.totals.pending_returns) === JSON.stringify(origTotals.pending_returns),
    '导出待归还与结转一致');

  console.log('\n=== 3. 导入冲突：正式结转存在时导入被拒绝 ===');
  const impConflict = await request('POST', '/api/settlements/import', exported, cookie);
  assert(impConflict.status === 409, '正式结转存在时导入返回 409');
  assert(impConflict.body.conflict === 'official_exists', '冲突类型为 official_exists');

  console.log('\n=== 4. 撤销最新结转 ===');
  const revoke1 = await request('DELETE', '/api/settlements/2026-W88/revoke', null, cookie);
  assert(revoke1.status === 200, '撤销 W88 成功');
  assert(revoke1.body.ok === true, '撤销响应 ok=true');
  assert(revoke1.body.week_key === '2026-W88', '撤销响应包含 week_key');

  const listAfterRevoke = await request('GET', '/api/settlements', null, cookie);
  const w88AfterRevoke = listAfterRevoke.body.find(s => s.week_key === '2026-W88' && s.source === 'settled');
  assert(!w88AfterRevoke, '撤销后 W88 正式结转从列表中消失');

  console.log('\n=== 5. 重复撤销同一周次 ===');
  const revoke2 = await request('DELETE', '/api/settlements/2026-W88/revoke', null, cookie);
  assert(revoke2.status === 404, '重复撤销返回 404');

  console.log('\n=== 6. 撤销后可重新执行结转 ===');
  const st2 = await request('POST', '/api/settlements/weekly', { week_key: '2026-W88' }, cookie);
  assert(st2.status === 200, '撤销后重新结转 W88 成功');

  console.log('\n=== 7. 非最新周次撤销被拒绝 ===');
  const res2 = await request('POST', '/api/reservations', {
    course_id: 1, class_id: 1, equipment_id: 1, qty: 1, week_key: '2026-W89'
  }, cookie);
  assert(res2.status === 200, '预约示波器 1 件成功 (W89)');
  await request('PUT', `/api/reservations/${res2.body.id}/approve`, {}, cookie);
  await request('PUT', `/api/reservations/${res2.body.id}/collect`, {}, cookie);
  await request('PUT', `/api/reservations/${res2.body.id}/return`, { return_qty: 1 }, cookie);

  const st3 = await request('POST', '/api/settlements/weekly', { week_key: '2026-W89' }, cookie);
  assert(st3.status === 200, 'W89 结转成功');

  const revokeOld = await request('DELETE', '/api/settlements/2026-W88/revoke', null, cookie);
  assert(revokeOld.status === 400, '撤销非最新 W88 返回 400');
  assert(revokeOld.body.error.includes('最新周次'), '错误提示包含"最新周次"');

  const revokeW89 = await request('DELETE', '/api/settlements/2026-W89/revoke', null, cookie);
  assert(revokeW89.status === 200, '撤销最新 W89 成功');

  const revokeW88Again = await request('DELETE', '/api/settlements/2026-W88/revoke', null, cookie);
  assert(revokeW88Again.status === 200, 'W89 撤销后 W88 成为最新，可撤销');

  console.log('\n=== 8. 导入结转 JSON（保留原周次和统计口径）===');
  const imp1 = await request('POST', '/api/settlements/import', exported, cookie);
  assert(imp1.status === 201, '导入成功 (201)');
  assert(imp1.body.source === 'imported', '导入记录 source = imported');
  assert(imp1.body.week_key === '2026-W88', '导入保留原 week_key');
  assert(imp1.body.settled_at === origSettledAt, '导入保留原 settled_at');
  assert(JSON.stringify(imp1.body.totals.equipment_snapshot) === JSON.stringify(origTotals.equipment_snapshot),
    '导入器材快照与原始一致');
  assert(JSON.stringify(imp1.body.totals.reservation_summary) === JSON.stringify(origTotals.reservation_summary),
    '导入预约汇总与原始一致');
  assert(JSON.stringify(imp1.body.totals.loss_summary) === JSON.stringify(origTotals.loss_summary),
    '导入损耗汇总与原始一致');
  assert(JSON.stringify(imp1.body.totals.pending_returns) === JSON.stringify(origTotals.pending_returns),
    '导入待归还与原始一致');

  console.log('\n=== 9. 导入后正式结转不受影响 ===');
  const eqAfterImport = await request('GET', '/api/equipment', null, cookie);
  const eqAfterImportBefore = eqAfterImport.body;
  eqAfterImportBefore.forEach(e => {
    assert(e.available_qty === e.total_qty - e.locked_qty,
      `${e.name} 导入后不变式: avail(${e.available_qty}) + locked(${e.locked_qty}) = total(${e.total_qty})`);
  });

  console.log('\n=== 10. 重复导入同一周次被拒绝 ===');
  const impDup = await request('POST', '/api/settlements/import', exported, cookie);
  assert(impDup.status === 409, '重复导入返回 409');
  assert(impDup.body.conflict === 'imported_exists', '冲突类型为 imported_exists');

  console.log('\n=== 11. 移除导入视图 ===');
  const rmImp = await request('DELETE', '/api/settlements/2026-W88/remove-import', null, cookie);
  assert(rmImp.status === 200, '移除导入成功');

  const listAfterRm = await request('GET', '/api/settlements', null, cookie);
  const w88ImportedAfterRm = listAfterRm.body.find(s => s.week_key === '2026-W88' && s.source === 'imported');
  assert(!w88ImportedAfterRm, '移除后导入视图消失');

  const rmImpAgain = await request('DELETE', '/api/settlements/2026-W88/remove-import', null, cookie);
  assert(rmImpAgain.status === 404, '重复移除导入返回 404');

  console.log('\n=== 12. 权限：教师不能撤销/导入 ===');
  const zs = await login('zhangsan', '123456', '');
  const revokeTeacher = await request('DELETE', '/api/settlements/2026-W88/revoke', null, zs.cookie);
  assert(revokeTeacher.status === 403, '教师撤销返回 403');

  const impTeacher = await request('POST', '/api/settlements/import', exported, zs.cookie);
  assert(impTeacher.status === 403, '教师导入返回 403');

  const rmImpTeacher = await request('DELETE', '/api/settlements/2026-W88/remove-import', null, zs.cookie);
  assert(rmImpTeacher.status === 403, '教师移除导入返回 403');

  console.log('\n=== 13. 结转列表包含 is_latest_settled 和 source 标识 ===');
  await request('POST', '/api/settlements/weekly', { week_key: '2026-W88' }, cookie);
  const listFinal = await request('GET', '/api/settlements', null, cookie);
  const w88settled = listFinal.body.find(s => s.week_key === '2026-W88' && s.source === 'settled');
  assert(w88settled, '列表包含 W88 正式结转');
  assert(w88settled.is_latest_settled === true, 'W88 is_latest_settled = true');
  assert(w88settled.source === 'settled', 'source = settled');

  console.log('\n=== 14. 导出支持 source=imported 参数 ===');
  const exportedForImp = JSON.parse(JSON.stringify(exported));
  exportedForImp.week_key = '2026-W97';
  await request('POST', '/api/settlements/import', exportedForImp, cookie);
  const expImp = await request('GET', '/api/export/2026-W97?source=imported', null, cookie);
  assert(expImp.status === 200, '导出导入视图成功');
  assert(expImp.body.source === 'imported', '导出内容 source = imported');

  const expSettled = await request('GET', '/api/export/2026-W88?source=settled', null, cookie);
  assert(expSettled.status === 200, '导出正式结转成功');
  assert(expSettled.body.source === 'settled', '导出内容 source = settled');

  console.log('\n=== 15. latest-info API ===');
  const latestInfo = await request('GET', '/api/settlements/latest-info', null, cookie);
  assert(latestInfo.status === 200, 'latest-info 请求成功');
  assert(latestInfo.body.has_latest === true, 'has_latest = true');
  assert(latestInfo.body.week_key === '2026-W88', '最新正式结转是 W88');

  console.log('\n=== 16. 操作日志完整性 ===');
  const logs = await request('GET', '/api/logs', null, cookie);
  const actions = logs.body.map(l => l.action);
  assert(actions.includes('weekly_settlement'), '日志包含 weekly_settlement');
  assert(actions.includes('revoke_weekly_settlement'), '日志包含 revoke_weekly_settlement');
  assert(actions.includes('import_weekly_settlement'), '日志包含 import_weekly_settlement');
  assert(actions.includes('remove_imported_settlement'), '日志包含 remove_imported_settlement');
  assert(actions.includes('revoke_settlement_not_found'), '日志包含 revoke_settlement_not_found');
  assert(actions.includes('revoke_settlement_not_latest'), '日志包含 revoke_settlement_not_latest');
  assert(actions.includes('import_settlement_duplicate_settled'), '日志包含 import_settlement_duplicate_settled');
  assert(actions.includes('import_settlement_duplicate_imported'), '日志包含 import_settlement_duplicate_imported');

  const revokeLogs = logs.body.filter(l => l.action === 'revoke_weekly_settlement');
  assert(revokeLogs.length >= 2, `撤销日志条数 >= 2 (实际: ${revokeLogs.length})`);

  console.log('\n=== 17. 导入数据校验 ===');
  const badImport1 = await request('POST', '/api/settlements/import', { week_key: '2026-W99' }, cookie);
  assert(badImport1.status === 400, '缺少 totals 导入返回 400');

  const badImport2 = await request('POST', '/api/settlements/import', {
    week_key: '2026-W99', totals: { equipment_snapshot: 'bad' }
  }, cookie);
  assert(badImport2.status === 400, 'equipment_snapshot 非数组导入返回 400');

  const badImport3 = await request('POST', '/api/settlements/import', {
    week_key: '2026-W99', totals: {
      equipment_snapshot: [],
      reservation_summary: {},
      loss_summary: {},
      pending_returns: []
    }
  }, cookie);
  assert(badImport3.status === 201, '格式正确的数据导入成功');
  await request('DELETE', '/api/settlements/2026-W99/remove-import', null, cookie);

  console.log('\n=== 18. 撤销幂等性：并发两次撤销只有一次成功 ===');
  const st4 = await request('POST', '/api/settlements/weekly', { week_key: '2026-W90' }, cookie);
  assert(st4.status === 200, 'W90 结转成功');
  const [r1, r2] = await Promise.all([
    request('DELETE', '/api/settlements/2026-W90/revoke', null, cookie),
    request('DELETE', '/api/settlements/2026-W90/revoke', null, cookie)
  ]);
  const oneSuccess = (r1.status === 200 ? 1 : 0) + (r2.status === 200 ? 1 : 0);
  assert(oneSuccess === 1, `并发撤销只有一次成功 (${r1.status}, ${r2.status})`);

  console.log(`\n=== 结转闭环回归测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
}

runTests().catch(e => { console.error('测试执行失败:', e.message); process.exit(1); });
