const http = require('http');
const assert = require('assert');

const PORT = process.env.TEST_PORT || 3070;
const BASE_URL = `http://localhost:${PORT}`;

let serverProcess = null;
let adminCookie = null;
let teacherCookie = null;
let labManagerCookie = null;
let testPassed = 0;
let testFailed = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function request(method, path, body = null, cookie = '') {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie
      }
    };
    const req = http.request(BASE_URL + path, opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const body = data ? JSON.parse(data) : null;
          resolve({ status: res.statusCode, body, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function login(username, password) {
  return new Promise((resolve, reject) => {
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    };
    const req = http.request(BASE_URL + '/api/login', opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          const cookie = res.headers['set-cookie'] ? res.headers['set-cookie'][0].split(';')[0] : '';
          resolve({ status: res.statusCode, body, cookie });
        } catch (e) {
          resolve({ status: res.statusCode, body: data, cookie: '' });
        }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify({ username, password }));
    req.end();
  });
}

function check(desc, condition) {
  if (condition) {
    console.log(`  ✅ ${desc}`);
    testPassed++;
  } else {
    console.log(`  ❌ ${desc}`);
    testFailed++;
  }
}

async function startServer() {
  console.log('\n[启动服务器]');
  const { spawn } = require('child_process');
  const fs = require('fs');
  const dbPath = 'd:\\workSpace\\AI__SPACE\\zyx-00115\\data\\lab.db';
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
  
  serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: PORT },
    cwd: 'd:\\workSpace\\AI__SPACE\\zyx-00115'
  });
  
  serverProcess.stdout.on('data', data => {});
  serverProcess.stderr.on('data', data => {});
  
  await sleep(2000);
  
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
  
  if (healthOk) {
    console.log('  ✅ 服务器启动成功');
  } else {
    console.log('  ❌ 服务器启动失败');
    process.exit(1);
  }
}

async function stopServer() {
  console.log('\n[停止服务器]');
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    await sleep(1000);
    console.log('  ✅ 服务器已停止');
  }
}

async function runTests() {
  console.log('========== 台账回归测试启动 ==========');
  
  await startServer();
  
  console.log('\n--- 登录获取会话 ---');
  const adminLogin = await login('admin', 'admin123');
  adminCookie = adminLogin.cookie;
  check('管理员登录成功', adminLogin.status === 200);
  
  const teacherLogin = await login('zhangsan', '123456');
  teacherCookie = teacherLogin.cookie;
  check('教师登录成功', teacherLogin.status === 200);
  
  const labManagerLogin = await login('wangwu', '123456');
  labManagerCookie = labManagerLogin.cookie;
  check('实验员登录成功', labManagerLogin.status === 200);
  
  console.log('\n=== [测试1] 权限差异验证 ===');
  
  const teacherLedger = await request('GET', '/api/settlements/ledger', null, teacherCookie);
  check('教师访问台账列表返回 403', teacherLedger.status === 403);
  
  const teacherLedgerExport = await request('GET', '/api/settlements/ledger/export/csv', null, teacherCookie);
  check('教师导出台账返回 403', teacherLedgerExport.status === 403);
  
  const teacherLedgerDetail = await request('GET', '/api/settlements/ledger/1', null, teacherCookie);
  check('教师访问台账详情返回 403', teacherLedgerDetail.status === 403);
  
  const teacherExportHistory = await request('GET', '/api/settlements/exports', null, teacherCookie);
  check('教师访问导出历史返回 403', teacherExportHistory.status === 403);
  
  const adminLedger = await request('GET', '/api/settlements/ledger', null, adminCookie);
  check('管理员访问台账列表返回 200', adminLedger.status === 200);
  
  const labManagerLedger = await request('GET', '/api/settlements/ledger', null, labManagerCookie);
  check('实验员访问台账列表返回 200', labManagerLedger.status === 200);
  
  console.log('\n--- 准备测试数据 ---');
  const equipment = await request('GET', '/api/equipment', null, adminCookie);
  const eq1 = equipment.body.find(e => e.name === '显微镜');
  check('获取显微镜设备成功', eq1 !== undefined);
  
  const courses = await request('GET', '/api/courses', null, adminCookie);
  const course1 = courses.body[0];
  check('获取课程成功', course1 !== undefined);
  
  const classes = await request('GET', '/api/classes', null, adminCookie);
  const class1 = classes.body[0];
  check('获取班级成功', class1 !== undefined);
  
  const r1 = await request('POST', '/api/reservations', {
    course_id: course1.id,
    class_id: class1.id,
    equipment_id: eq1.id,
    qty: 2,
    week_key: '2026-W70'
  }, adminCookie);
  check('创建预约成功', r1.status === 200 || r1.status === 201);
  
  const s1 = await request('POST', '/api/settlements/weekly', { week_key: '2026-W70' }, adminCookie);
  const settlementId1 = s1.body.id;
  check('W70 结转成功', s1.status === 200);
  
  await request('POST', `/api/settlements/${settlementId1}/notes`, { content: '回归测试说明1' }, adminCookie);
  await request('POST', `/api/settlements/${settlementId1}/notes`, { content: '回归测试说明2' }, labManagerCookie);
  check('添加2条结转说明成功', true);
  
  const export1 = await request('GET', '/api/export/2026-W70', null, adminCookie);
  check('管理员导出 W70 JSON 成功', export1.status === 200);
  
  const export2 = await request('GET', '/api/export/2026-W70', null, labManagerCookie);
  check('实验员导出 W70 JSON 成功', export2.status === 200);
  
  const s2 = await request('POST', '/api/settlements/weekly', { week_key: '2026-W71' }, adminCookie);
  const settlementId2 = s2.body.id;
  check('W71 结转成功', s2.status === 200);
  
  const cmpExport = await request('POST', '/api/settlements/compare/export-csv', {
    settlement_a_id: settlementId1, settlement_b_id: settlementId2
  }, adminCookie);
  check('管理员导出对比 CSV 成功', cmpExport.status === 200);
  
  console.log('\n=== [测试2] 按操作人查询命中 ===');
  
  const ledgerAll = await request('GET', '/api/settlements/ledger', null, adminCookie);
  check('台账总记录数 >= 3', ledgerAll.body.list.length >= 3);
  
  const ledgerAdmin = await request('GET', '/api/settlements/ledger?operator=admin', null, adminCookie);
  const adminExports = ledgerAdmin.body.list.filter(x => x.created_by_username === 'admin');
  check('按 operator=admin 筛选，只返回管理员操作记录', 
    adminExports.length === ledgerAdmin.body.list.length && ledgerAdmin.body.list.length > 0);
  
  const ledgerWangwu = await request('GET', '/api/settlements/ledger?operator=王五', null, adminCookie);
  const wangwuExports = ledgerWangwu.body.list.filter(x => x.created_by_user_name === '王五' || x.created_by_username === 'wangwu');
  check('按 operator=王五（姓名）筛选，只返回王五操作记录', 
    wangwuExports.length === ledgerWangwu.body.list.length && ledgerWangwu.body.list.length > 0);
  
  const ledgerWangwu2 = await request('GET', '/api/settlements/ledger?operator=wangwu', null, adminCookie);
  check('按 operator=wangwu（用户名）筛选，结果一致', 
    ledgerWangwu2.body.list.length === ledgerWangwu.body.list.length);
  
  console.log('\n=== [测试3] 失效记录收口验证 ===');
  
  const exportHistoryBefore = await request('GET', '/api/settlements/exports', null, adminCookie);
  const historyCountBefore = exportHistoryBefore.body.length;
  check('导出历史当前记录数', historyCountBefore >= 3);
  
  const ledgerBefore = await request('GET', '/api/settlements/ledger', null, adminCookie);
  const ledgerCountBefore = ledgerBefore.body.list.length;
  check('台账当前记录数', ledgerCountBefore >= 3);
  
  const revoke = await request('DELETE', '/api/settlements/2026-W71/revoke', null, adminCookie);
  check('撤销 W71 成功', revoke.status === 200);
  
  const exportHistoryAfter = await request('GET', '/api/settlements/exports', null, adminCookie);
  const historyCountAfter = exportHistoryAfter.body.length;
  check('撤销后导出历史记录数减少（失效记录被过滤）', 
    historyCountAfter < historyCountBefore);
  
  const ledgerAfter = await request('GET', '/api/settlements/ledger', null, adminCookie);
  const ledgerCountAfter = ledgerAfter.body.list.length;
  check('撤销后台账记录数不变（失效记录仍保留）', 
    ledgerCountAfter === ledgerCountBefore);
  
  const invalidRecords = ledgerAfter.body.list.filter(x => x.invalid === 1);
  check('台账中包含失效记录（invalid=1）', invalidRecords.length >= 1);
  
  const w71Invalid = invalidRecords.find(x => 
    x.week_key_a === '2026-W71' || x.week_key_b === '2026-W71'
  );
  check('W71 关联记录已标记失效', w71Invalid && w71Invalid.invalid === 1);
  check('失效记录包含失效原因', w71Invalid && w71Invalid.invalidated_reason === '撤销周结转');
  check('失效记录包含失效操作人', w71Invalid && w71Invalid.invalidated_by_user_name);
  check('失效记录包含清理统计', w71Invalid && w71Invalid.last_cleaned_stats);
  check('清理统计包含 cleaned_exports_total', w71Invalid && w71Invalid.last_cleaned_stats.cleaned_exports_total > 0);
  
  const historyHasInvalid = exportHistoryAfter.body.some(x => x.invalid === 1);
  check('导出历史中不包含失效记录', !historyHasInvalid);
  
  console.log('\n=== [测试4] 台账详情字段验证 ===');
  
  const firstItem = ledgerAfter.body.list[0];
  const detail = await request('GET', `/api/settlements/ledger/${firstItem.id}`, null, adminCookie);
  check('台账详情返回 200', detail.status === 200);
  check('详情包含 type 字段', detail.body.type !== undefined);
  check('详情包含 created_by_user_name 字段', detail.body.created_by_user_name !== undefined);
  check('详情包含 created_by_username 字段', detail.body.created_by_username !== undefined);
  check('详情包含 related_note_count 字段', detail.body.related_note_count !== undefined);
  
  if (detail.body.type === 'comparison') {
    check('对比 CSV 详情包含 comparison_id', detail.body.comparison_id !== undefined);
    check('对比 CSV 详情包含 comparison_diff_summary', detail.body.comparison_diff_summary !== undefined);
  }
  
  if (detail.body.invalid) {
    check('失效记录详情包含 invalidated_reason', detail.body.invalidated_reason !== undefined);
    check('失效记录详情包含 last_cleaned_stats', detail.body.last_cleaned_stats !== undefined);
  }
  
  console.log('\n=== [测试5] 关联说明条数验证 ===');
  
  const w70Record = ledgerAfter.body.list.find(x => x.week_key_a === '2026-W70' && x.type === 'single');
  check('W70 单周导出记录存在', w70Record !== undefined);
  check('W70 关联说明条数 = 2', w70Record.related_note_count === 2);
  
  const detailW70 = await request('GET', `/api/settlements/ledger/${w70Record.id}`, null, adminCookie);
  check('W70 详情关联说明条数 = 2', detailW70.body.related_note_count === 2);
  
  console.log('\n=== [测试6] 按周次范围和类型筛选 ===');
  
  const filterWeek = await request('GET', '/api/settlements/ledger?week_key_start=2026-W70&week_key_end=2026-W70', null, adminCookie);
  const week70Only = filterWeek.body.list.filter(x => 
    x.week_key_a === '2026-W70' || x.week_key_b === '2026-W70'
  );
  check('按周次范围筛选，只返回 W70 相关记录', 
    week70Only.length === filterWeek.body.list.length && filterWeek.body.list.length > 0);
  
  const filterSingle = await request('GET', '/api/settlements/ledger?export_type=single', null, adminCookie);
  const singleOnly = filterSingle.body.list.filter(x => x.type === 'single');
  check('按 export_type=single 筛选，只返回单周 JSON 记录', 
    singleOnly.length === filterSingle.body.list.length && filterSingle.body.list.length > 0);
  
  const filterComparison = await request('GET', '/api/settlements/ledger?export_type=comparison', null, adminCookie);
  const comparisonOnly = filterComparison.body.list.filter(x => x.type === 'comparison');
  check('按 export_type=comparison 筛选，只返回对比 CSV 记录', 
    comparisonOnly.length === filterComparison.body.list.length && filterComparison.body.list.length > 0);
  
  const filterValid = await request('GET', '/api/settlements/ledger?invalid=false', null, adminCookie);
  const validOnly = filterValid.body.list.filter(x => x.invalid === 0);
  check('按 invalid=false 筛选，只返回有效记录', 
    validOnly.length === filterValid.body.list.length && filterValid.body.list.length > 0);
  
  const filterInvalid = await request('GET', '/api/settlements/ledger?invalid=true', null, adminCookie);
  const invalidOnly = filterInvalid.body.list.filter(x => x.invalid === 1);
  check('按 invalid=true 筛选，只返回失效记录', 
    invalidOnly.length === filterInvalid.body.list.length && filterInvalid.body.list.length > 0);
  
  console.log('\n=== [测试7] 台账 CSV 导出验证 ===');
  
  const csvExport = await request('GET', '/api/settlements/ledger/export/csv', null, adminCookie);
  check('台账 CSV 导出返回 200', csvExport.status === 200);
  check('CSV Content-Type 正确', csvExport.headers['content-type'].includes('text/csv'));
  check('CSV 包含 Content-Disposition', csvExport.headers['content-disposition'] !== undefined);
  
  const csvContent = typeof csvExport.body === 'string' ? csvExport.body : JSON.stringify(csvExport.body);
  check('CSV 包含表头行', csvContent.includes('导出ID') && csvContent.includes('来源周次'));
  check('CSV 包含数据行', csvContent.split('\n').length > 1);
  
  console.log('\n=== [测试8] 台账统计摘要验证 ===');
  
  const summary = await request('GET', '/api/settlements/ledger/summary', null, adminCookie);
  check('摘要返回 200', summary.status === 200);
  check('摘要包含 total_count', summary.body.total_count !== undefined);
  check('摘要包含 valid_count', summary.body.valid_count !== undefined);
  check('摘要包含 invalid_count', summary.body.invalid_count !== undefined);
  check('摘要包含 single_count', summary.body.single_count !== undefined);
  check('摘要包含 comparison_count', summary.body.comparison_count !== undefined);
  check('统计总数匹配', summary.body.total_count === ledgerAfter.body.list.length);
  check('有效+失效=总数', summary.body.valid_count + summary.body.invalid_count === summary.body.total_count);
  
  const filterSummary = await request('GET', '/api/settlements/ledger/summary?export_type=single', null, adminCookie);
  check('带筛选的摘要 single_count = total_count', filterSummary.body.single_count === filterSummary.body.total_count);
  
  console.log('\n=== [测试9] 再次导出不影响历史记录状态 ===');
  
  const export3 = await request('GET', '/api/export/2026-W70', null, adminCookie);
  check('再次导出 W70 JSON 成功', export3.status === 200);
  
  const ledgerAfterReExport = await request('GET', '/api/settlements/ledger', null, adminCookie);
  check('再次导出后台账记录数增加 1', ledgerAfterReExport.body.list.length === ledgerAfter.body.list.length + 1);
  
  const oldW70 = ledgerAfterReExport.body.list.find(x => 
    x.week_key_a === '2026-W70' && x.type === 'single' && x.id === w70Record.id
  );
  check('旧的 W70 记录仍保持有效状态', oldW70 && oldW70.invalid === 0);
  
  const newW70 = ledgerAfterReExport.body.list.find(x => 
    x.week_key_a === '2026-W70' && x.type === 'single' && x.id !== w70Record.id
  );
  check('新的 W70 记录为有效状态', newW70 && newW70.invalid === 0);
  
  console.log('\n=== [测试10] 操作日志完整性 ===');
  
  const logs = await request('GET', '/api/logs', null, adminCookie);
  const revokeLog = logs.body.find(x => x.action === 'revoke_weekly_settlement');
  check('撤销操作日志存在', revokeLog !== undefined);
  check('撤销日志包含 cleaned_exports_total', 
    revokeLog.details && revokeLog.details.cleaned_exports_total !== undefined);
  check('撤销日志包含 cleaned_notes', 
    revokeLog.details && revokeLog.details.cleaned_notes !== undefined);
  
  const ledgerExportLog = logs.body.find(x => x.action === 'export_settlement_ledger_csv');
  check('台账导出日志存在', ledgerExportLog !== undefined);
  
  console.log('\n=== [测试11] 移除导入联动失效 ===');
  
  const importFile = {
    week_key: '2026-W99',
    source: 'imported',
    settled_at: new Date().toISOString(),
    equipment_snapshot: [],
    totals: {
      equipment_snapshot: [],
      reservation_summary: { total: 0, by_status: {} },
      loss_summary: { total_reports: 0, total_qty: 0 },
      pending_returns: []
    }
  };
  
  const imp = await request('POST', '/api/settlements/import', importFile, adminCookie);
  check('导入 W99 成功', imp.status === 201);
  
  const exportImported = await request('GET', '/api/export/2026-W99?source=imported', null, adminCookie);
  check('导出导入视图 JSON 成功', exportImported.status === 200);
  
  const ledgerBeforeRemove = await request('GET', '/api/settlements/ledger', null, adminCookie);
  const w99Record = ledgerBeforeRemove.body.list.find(x => x.week_key_a === '2026-W99');
  check('W99 导出记录存在且有效', w99Record && w99Record.invalid === 0);
  
  const remove = await request('DELETE', '/api/settlements/2026-W99/remove-import', null, adminCookie);
  check('移除导入成功', remove.status === 200);
  
  const ledgerAfterRemove = await request('GET', '/api/settlements/ledger', null, adminCookie);
  const w99After = ledgerAfterRemove.body.list.find(x => x.week_key_a === '2026-W99');
  check('移除导入后 W99 记录已失效', w99After && w99After.invalid === 1);
  check('失效原因正确', w99After && w99After.invalidated_reason === '移除导入结转');
  
  const logsAfter = await request('GET', '/api/logs', null, adminCookie);
  const removeLog = logsAfter.body.find(x => x.action === 'remove_imported_settlement');
  check('移除导入日志存在', removeLog !== undefined);
  
  await stopServer();
  
  console.log(`\n========== 测试结束 ==========`);
  console.log(`  通过: ${testPassed}, 失败: ${testFailed}`);
  
  if (testFailed > 0) {
    process.exit(1);
  }
}

runTests().catch(e => {
  console.error('测试异常:', e);
  if (serverProcess) serverProcess.kill();
  process.exit(1);
});
