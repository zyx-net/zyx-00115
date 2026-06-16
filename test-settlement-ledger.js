const http = require('http');

const BASE = process.env.BASE_URL || 'http://localhost:3001';
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
  console.log('\n=== 导出复盘台账功能测试 ===\n');

  console.log('--- 步骤 0: 重置数据 ---');
  await request('POST', '/api/reset', {}, '');

  let adminCookie = '';
  let teacherCookie = '';
  let labManagerCookie = '';

  const admin = await login('admin', 'admin123', '');
  adminCookie = admin.cookie;
  assert(admin.status === 200, '管理员登录成功');

  const teacher = await login('zhangsan', '123456', '');
  teacherCookie = teacher.cookie;
  assert(teacher.status === 200, '教师登录成功');

  const labManager = await login('wangwu', '123456', '');
  labManagerCookie = labManager.cookie;
  assert(labManager.status === 200, '实验员登录成功');

  console.log('\n=== 1. 权限测试：教师不能访问台账接口 ===');

  const teacherLedger = await request('GET', '/api/settlements/ledger', null, teacherCookie);
  assert(teacherLedger.status === 403, '教师访问台账列表返回 403');

  const teacherLedgerSummary = await request('GET', '/api/settlements/ledger/summary', null, teacherCookie);
  assert(teacherLedgerSummary.status === 403, '教师访问台账摘要返回 403');

  const teacherLedgerDetail = await request('GET', '/api/settlements/ledger/1', null, teacherCookie);
  assert(teacherLedgerDetail.status === 403, '教师访问台账详情返回 403');

  const teacherLedgerExport = await request('GET', '/api/settlements/ledger/export/csv', null, teacherCookie);
  assert(teacherLedgerExport.status === 403, '教师导出台账返回 403');

  console.log('\n=== 2. 权限测试：管理员和实验员可以访问台账 ===');

  const adminLedger = await request('GET', '/api/settlements/ledger', null, adminCookie);
  assert(adminLedger.status === 200, '管理员访问台账列表成功');

  const labManagerLedger = await request('GET', '/api/settlements/ledger', null, labManagerCookie);
  assert(labManagerLedger.status === 200, '实验员访问台账列表成功');

  console.log('\n=== 3. 准备测试数据：创建结转、导出、对比 ===');

  const res1 = await request('POST', '/api/reservations', {
    course_id: 1, class_id: 1, equipment_id: 1, qty: 1, week_key: '2026-W50'
  }, adminCookie);
  assert(res1.status === 200, '创建预约成功');

  await request('PUT', `/api/reservations/${res1.body.id}/approve`, {}, adminCookie);
  await request('PUT', `/api/reservations/${res1.body.id}/collect`, {}, adminCookie);
  await request('PUT', `/api/reservations/${res1.body.id}/return`, { return_qty: 1 }, adminCookie);

  const st1 = await request('POST', '/api/settlements/weekly', { week_key: '2026-W50' }, adminCookie);
  assert(st1.status === 200, 'W50 结转成功');
  const settlementId1 = st1.body.id;

  await request('POST', '/api/settlements/' + settlementId1 + '/notes', { content: '测试说明1' }, adminCookie);
  await request('POST', '/api/settlements/' + settlementId1 + '/notes', { content: '测试说明2' }, adminCookie);

  const exp1 = await request('GET', '/api/export/2026-W50', null, adminCookie);
  assert(exp1.status === 200, '导出 W50 JSON 成功');

  const res2 = await request('POST', '/api/reservations', {
    course_id: 2, class_id: 3, equipment_id: 3, qty: 2, week_key: '2026-W51'
  }, adminCookie);
  assert(res2.status === 200, '创建 W51 预约成功');

  await request('PUT', `/api/reservations/${res2.body.id}/approve`, {}, adminCookie);
  await request('PUT', `/api/reservations/${res2.body.id}/collect`, {}, adminCookie);
  await request('PUT', `/api/reservations/${res2.body.id}/return`, { return_qty: 2 }, adminCookie);

  const st2 = await request('POST', '/api/settlements/weekly', { week_key: '2026-W51' }, adminCookie);
  assert(st2.status === 200, 'W51 结转成功');
  const settlementId2 = st2.body.id;

  const exp2 = await request('GET', '/api/export/2026-W51', null, adminCookie);
  assert(exp2.status === 200, '导出 W51 JSON 成功');

  const cmpExport = await request('POST', '/api/settlements/compare/export-csv', {
    settlement_a_id: settlementId1, settlement_b_id: settlementId2
  }, adminCookie);
  assert(cmpExport.status === 200, '导出对比 CSV 成功');

  console.log('\n=== 4. 台账列表和筛选功能 ===');

  const ledgerAll = await request('GET', '/api/settlements/ledger', null, adminCookie);
  assert(ledgerAll.status === 200, '获取台账列表成功');
  assert(ledgerAll.body.list.length >= 3, `台账列表至少有 3 条记录（实际: ${ledgerAll.body.list.length}）`);
  assert(ledgerAll.body.summary, '台账包含 summary 字段');
  assert(ledgerAll.body.summary.total_count >= 3, 'summary total_count 正确');
  assert(ledgerAll.body.summary.single_count >= 2, 'summary single_count 正确');
  assert(ledgerAll.body.summary.comparison_count >= 1, 'summary comparison_count 正确');

  const firstItem = ledgerAll.body.list[0];
  assert(firstItem.week_key_a !== undefined, '列表项包含 week_key_a');
  assert(firstItem.filename !== undefined, '列表项包含 filename');
  assert(firstItem.row_count !== undefined, '列表项包含 row_count');
  assert(firstItem.related_note_count !== undefined, '列表项包含 related_note_count');
  assert(firstItem.type !== undefined, '列表项包含 type');
  assert(firstItem.created_by_user_name !== undefined, '列表项包含 created_by_user_name');
  assert(firstItem.invalid !== undefined, '列表项包含 invalid 字段');

  const w50Item = ledgerAll.body.list.find(x => x.week_key_a === '2026-W50' && x.type === 'single');
  assert(w50Item, '找到 W50 单周导出记录');
  assert(w50Item.related_note_count === 2, `W50 关联说明条数为 2（实际: ${w50Item.related_note_count}）`);
  assert(w50Item.invalid === 0, 'W50 记录状态为有效');

  const comparisonItem = ledgerAll.body.list.find(x => x.type === 'comparison');
  assert(comparisonItem, '找到对比导出记录');
  assert(comparisonItem.week_key_a === '2026-W50', '对比记录 week_key_a 正确');
  assert(comparisonItem.week_key_b === '2026-W51', '对比记录 week_key_b 正确');

  console.log('\n=== 5. 按周次范围筛选 ===');

  const filterWeek = await request('GET', '/api/settlements/ledger?week_key_start=2026-W51&week_key_end=2026-W51', null, adminCookie);
  assert(filterWeek.status === 200, '按周次筛选成功');
  const week51Items = filterWeek.body.list.filter(x => x.week_key_a === '2026-W51' || x.week_key_b === '2026-W51');
  assert(week51Items.length >= 1, '筛选出 W51 相关记录');
  const w50Only = filterWeek.body.list.find(x => x.week_key_a === '2026-W50' && !x.week_key_b);
  assert(!w50Only, 'W50 单周记录不在筛选结果中');

  console.log('\n=== 6. 按导出类型筛选 ===');

  const filterSingle = await request('GET', '/api/settlements/ledger?export_type=single', null, adminCookie);
  assert(filterSingle.status === 200, '按 single 类型筛选成功');
  assert(filterSingle.body.list.every(x => x.type === 'single'), '筛选结果全部为 single 类型');
  assert(filterSingle.body.summary.single_count === filterSingle.body.summary.total_count, 'summary 匹配筛选结果');

  const filterComparison = await request('GET', '/api/settlements/ledger?export_type=comparison', null, adminCookie);
  assert(filterComparison.status === 200, '按 comparison 类型筛选成功');
  assert(filterComparison.body.list.every(x => x.type === 'comparison'), '筛选结果全部为 comparison 类型');

  console.log('\n=== 7. 按操作人筛选 ===');

  const users = await request('GET', '/api/users', null, adminCookie);
  const adminUser = users.body.find(u => u.username === 'admin');
  assert(adminUser, '找到管理员用户');

  const filterUser = await request('GET', `/api/settlements/ledger?created_by=${adminUser.id}`, null, adminCookie);
  assert(filterUser.status === 200, '按操作人筛选成功');
  assert(filterUser.body.list.every(x => x.created_by === adminUser.id), '筛选结果全部为该操作人');

  console.log('\n=== 8. 按是否失效筛选 ===');

  const filterValid = await request('GET', '/api/settlements/ledger?invalid=false', null, adminCookie);
  assert(filterValid.status === 200, '筛选有效记录成功');
  assert(filterValid.body.list.every(x => x.invalid === 0), '筛选结果全部为有效');
  assert(filterValid.body.summary.valid_count === filterValid.body.summary.total_count, 'summary valid_count 正确');

  const filterInvalid = await request('GET', '/api/settlements/ledger?invalid=true', null, adminCookie);
  assert(filterInvalid.status === 200, '筛选失效记录成功');
  assert(filterInvalid.body.list.length === 0, '当前没有失效记录');

  console.log('\n=== 9. 台账详情 ===');

  const detailId = ledgerAll.body.list[0].id;
  const detail = await request('GET', `/api/settlements/ledger/${detailId}`, null, adminCookie);
  assert(detail.status === 200, '获取台账详情成功');
  assert(detail.body.id === detailId, '详情 ID 正确');
  assert(detail.body.type !== undefined, '详情包含 type');
  assert(detail.body.filename !== undefined, '详情包含 filename');
  assert(detail.body.created_by_user_name !== undefined, '详情包含操作人姓名');

  const comparisonDetailId = comparisonItem.id;
  const comparisonDetail = await request('GET', `/api/settlements/ledger/${comparisonDetailId}`, null, adminCookie);
  assert(comparisonDetail.status === 200, '获取对比详情成功');
  assert(comparisonDetail.body.type === 'comparison', '详情 type 为 comparison');
  assert(comparisonDetail.body.settlement_a_id !== undefined, '详情包含 settlement_a_id');
  assert(comparisonDetail.body.settlement_b_id !== undefined, '详情包含 settlement_b_id');
  assert(comparisonDetail.body.comparison_diff_summary !== undefined, '详情包含对比摘要');

  console.log('\n=== 10. 撤销联动：撤销后台账记录标记为失效 ===');

  const beforeRevoke = await request('GET', '/api/settlements/ledger', null, adminCookie);
  const validBefore = beforeRevoke.body.list.filter(x => x.invalid === 0).length;

  const revoke = await request('DELETE', '/api/settlements/2026-W51/revoke', null, adminCookie);
  assert(revoke.status === 200, '撤销 W51 结转成功');

  const afterRevoke = await request('GET', '/api/settlements/ledger', null, adminCookie);
  const w51Invalid = afterRevoke.body.list.filter(x =>
    (x.week_key_a === '2026-W51' || x.week_key_b === '2026-W51') && x.invalid === 1
  );
  assert(w51Invalid.length >= 2, `W51 相关记录（单周导出+对比）标记为失效（实际: ${w51Invalid.length}）`);

  const w50StillValid = afterRevoke.body.list.find(x => x.week_key_a === '2026-W50' && !x.week_key_b && x.invalid === 0);
  assert(w50StillValid, 'W50 单周导出记录仍然有效');

  const invalidItem = w51Invalid[0];
  assert(invalidItem.invalidated_at !== undefined, '失效记录包含 invalidated_at');
  assert(invalidItem.invalidated_by_user_name !== undefined, '失效记录包含失效人');
  assert(invalidItem.invalidated_reason === '撤销周结转', '失效原因正确');
  assert(invalidItem.last_cleaned_stats !== undefined, '失效记录包含清理统计');
  assert(invalidItem.last_cleaned_stats.cleaned_notes !== undefined, '清理统计包含 cleaned_notes');
  assert(invalidItem.last_cleaned_stats.cleaned_exports_total !== undefined, '清理统计包含 cleaned_exports_total');

  const filterInvalidAfter = await request('GET', '/api/settlements/ledger?invalid=true', null, adminCookie);
  assert(filterInvalidAfter.body.list.length >= 2, '筛选失效记录能找到 W51 相关记录');

  console.log('\n=== 11. 再次导出：新记录为有效状态 ===');

  const st3 = await request('POST', '/api/settlements/weekly', { week_key: '2026-W51' }, adminCookie);
  assert(st3.status === 200, '重新结转 W51 成功');

  const exp3 = await request('GET', '/api/export/2026-W51', null, adminCookie);
  assert(exp3.status === 200, '重新导出 W51 JSON 成功');

  const afterReExport = await request('GET', '/api/settlements/ledger', null, adminCookie);
  const w51NewValid = afterReExport.body.list.find(x =>
    x.week_key_a === '2026-W51' && !x.week_key_b && x.invalid === 0 && x.created_at > revoke.body.revoked_at
  );
  assert(w51NewValid, '新导出的 W51 记录为有效状态');

  const w51OldInvalid = afterReExport.body.list.find(x =>
    x.week_key_a === '2026-W51' && !x.week_key_b && x.invalid === 1
  );
  assert(w51OldInvalid, '旧的 W51 记录保持失效状态');

  console.log('\n=== 12. 导入结转后移除：导入记录失效标记 ===');

  const exported = exp1.body;
  exported.week_key = '2026-W52';
  const imp = await request('POST', '/api/settlements/import', exported, adminCookie);
  assert(imp.status === 201, '导入 W52 成功');

  const impExp = await request('GET', '/api/export/2026-W52?source=imported', null, adminCookie);
  assert(impExp.status === 200, '导出导入视图成功');

  const afterImportExp = await request('GET', '/api/settlements/ledger', null, adminCookie);
  const w52Item = afterImportExp.body.list.find(x => x.week_key_a === '2026-W52' && x.invalid === 0);
  assert(w52Item, 'W52 导入导出记录有效');

  const rmImp = await request('DELETE', '/api/settlements/2026-W52/remove-import', null, adminCookie);
  assert(rmImp.status === 200, '移除导入成功');

  const afterRmImp = await request('GET', '/api/settlements/ledger', null, adminCookie);
  const w52Invalid = afterRmImp.body.list.find(x => x.week_key_a === '2026-W52' && x.invalid === 1);
  assert(w52Invalid, 'W52 记录标记为失效');
  assert(w52Invalid.invalidated_reason === '移除导入结转', '失效原因正确');

  console.log('\n=== 13. 台账导出 CSV 链路 ===');

  const ledgerExport = await request('GET', '/api/settlements/ledger/export/csv', null, adminCookie);
  assert(ledgerExport.status === 200, '导出台账 CSV 成功');

  const logs = await request('GET', '/api/logs', null, adminCookie);
  const exportLog = logs.body.find(l => l.action === 'export_settlement_ledger_csv');
  assert(exportLog, '操作日志包含导出台账记录');

  const exportWithFilter = await request('GET', '/api/settlements/ledger/export/csv?export_type=single&invalid=false', null, adminCookie);
  assert(exportWithFilter.status === 200, '带筛选条件导出台账 CSV 成功');

  console.log('\n=== 14. 台账摘要接口 ===');

  const summary = await request('GET', '/api/settlements/ledger/summary', null, adminCookie);
  assert(summary.status === 200, '获取台账摘要成功');
  assert(summary.body.total_count !== undefined, '摘要包含 total_count');
  assert(summary.body.single_count !== undefined, '摘要包含 single_count');
  assert(summary.body.comparison_count !== undefined, '摘要包含 comparison_count');
  assert(summary.body.valid_count !== undefined, '摘要包含 valid_count');
  assert(summary.body.invalid_count !== undefined, '摘要包含 invalid_count');
  assert(summary.body.total_rows !== undefined, '摘要包含 total_rows');

  const summaryFiltered = await request('GET', '/api/settlements/ledger/summary?invalid=true', null, adminCookie);
  assert(summaryFiltered.body.invalid_count === summaryFiltered.body.total_count, '筛选后摘要正确');

  console.log('\n=== 15. 操作日志完整性 ===');

  const allLogs = await request('GET', '/api/logs', null, adminCookie);
  const actions = allLogs.body.map(l => l.action);
  assert(actions.includes('export_settlement_single_json'), '日志包含 export_settlement_single_json');
  assert(actions.includes('export_settlement_ledger_csv'), '日志包含 export_settlement_ledger_csv');
  assert(actions.includes('revoke_weekly_settlement'), '日志包含 revoke_weekly_settlement');
  assert(actions.includes('remove_imported_settlement'), '日志包含 remove_imported_settlement');

  const revokeLogs = allLogs.body.filter(l => l.action === 'revoke_weekly_settlement');
  assert(revokeLogs.length >= 1, '撤销日志存在');
  const revokeDetails = typeof revokeLogs[0].details === 'string' ? JSON.parse(revokeLogs[0].details) : revokeLogs[0].details;
  assert(revokeDetails.cleaned_notes !== undefined, '撤销日志包含 cleaned_notes');
  assert(revokeDetails.cleaned_exports_total !== undefined, '撤销日志包含 cleaned_exports_total');

  console.log(`\n=== 导出复盘台账测试结果: ${passed} 通过, ${failed} 失败 ===\n`);
}

runTests().catch(e => { console.error('测试执行失败:', e.message); process.exit(1); });
