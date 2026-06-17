const http = require('http');

const BASE = 'http://localhost:3001';
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  OK: ${msg}`); }
  else { failed++; console.log(`  FAIL: ${msg}`); }
}

async function request(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: { 'Content-Type': 'application/json' } };
    if (cookie) opts.headers.Cookie = cookie;
    const req = http.request(opts, res => {
      let data = '';
      const setCookie = res.headers['set-cookie'];
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch(e) { parsed = data; }
        resolve({ status: res.statusCode, data: parsed, cookie: setCookie ? setCookie[0] : null, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function run() {
  console.log('\n=== 器材维修停用与复用中心 回归测试 ===\n');

  console.log('准备: 重置数据...');
  const resetRes = await request('POST', '/api/reset');
  await new Promise(r => setTimeout(r, 500));

  console.log('\n--- 1. 登录与基础环境 ---');
  const adminLogin = await request('POST', '/api/login', { username: 'admin', password: 'admin123' });
  const adminCookie = adminLogin.cookie.split(';')[0];
  assert(adminLogin.status === 200, '管理员登录成功');

  const teacherLogin = await request('POST', '/api/login', { username: 'zhangsan', password: '123456' });
  const teacherCookie = teacherLogin.cookie.split(';')[0];
  assert(teacherLogin.status === 200, '教师(张三)登录成功');

  const labManagerLogin = await request('POST', '/api/login', { username: 'wangwu', password: '123456' });
  const labManagerCookie = labManagerLogin.cookie.split(';')[0];
  assert(labManagerLogin.status === 200, '实验员(王五)登录成功');

  const equipmentRes = await request('GET', '/api/equipment', null, adminCookie);
  assert(equipmentRes.status === 200 && equipmentRes.data.length > 0, '获取器材列表成功');
  const oscillo = equipmentRes.data.find(e => e.id === 1);
  assert(oscillo && oscillo.name === '示波器', '示波器器材存在');

  console.log('\n--- 2. 故障上报（教师和实验员）---');
  const teacherReportRes = await request('POST', '/api/repair/orders', {
    course_id: 1,
    class_id: 1,
    equipment_id: 1,
    qty: 1,
    fault_phenomenon: '示波器开机无显示，电源指示灯不亮',
    handling_suggestion: '建议检查电源模块或送修'
  }, teacherCookie);
  assert(teacherReportRes.status === 201, '教师提交故障单成功');
  assert(teacherReportRes.data.status === 'pending', '初始状态为待处理');
  assert(teacherReportRes.data.order_no.startsWith('RP'), '维修单号格式正确(RP开头)');
  const teacherOrderId = teacherReportRes.data.id;
  const teacherOrderNo = teacherReportRes.data.order_no;
  console.log(`  教师提交单号: ${teacherOrderNo}`);

  const labManagerReportRes = await request('POST', '/api/repair/orders', {
    equipment_id: 2,
    qty: 1,
    fault_phenomenon: '万用表表笔接触不良，测量值不准',
    handling_suggestion: '更换表笔或内部校准'
  }, labManagerCookie);
  assert(labManagerReportRes.status === 201, '实验员提交故障单成功');
  const labManagerOrderId = labManagerReportRes.data.id;

  const reportMissing = await request('POST', '/api/repair/orders', {
    equipment_id: 1,
    qty: 1
  }, teacherCookie);
  assert(reportMissing.status === 400, '缺少故障现象时提交被拦截');

  const reportInvalidEq = await request('POST', '/api/repair/orders', {
    equipment_id: 999,
    qty: 1,
    fault_phenomenon: '测试'
  }, teacherCookie);
  assert(reportInvalidEq.status === 400, '器材不存在时提交被拦截');

  console.log('\n--- 3. 故障单列表查询与权限控制 ---');
  const adminListRes = await request('GET', '/api/repair/orders', null, adminCookie);
  assert(adminListRes.status === 200, '管理员可查看所有维修单');
  assert(adminListRes.data.length >= 2, '列表包含所有维修单');

  const teacherListRes = await request('GET', '/api/repair/orders', null, teacherCookie);
  assert(teacherListRes.status === 200, '教师可查看维修单');
  assert(teacherListRes.data.length >= 1, '教师至少能看到自己提交的维修单');
  const teacherCanSeeOwn = teacherListRes.data.some(o => o.reporter_id === 2);
  assert(teacherCanSeeOwn, '教师可以看到自己提交的维修单');

  const teacherDetailOwn = await request('GET', `/api/repair/orders/${teacherOrderId}`, null, teacherCookie);
  assert(teacherDetailOwn.status === 200, '教师可查看自己提交的维修单详情');

  const teacherDetailOther = await request('GET', `/api/repair/orders/${labManagerOrderId}`, null, teacherCookie);
  assert(teacherDetailOther.status === 403, '教师无法查看非自己课程相关的其他维修单');

  const teacherOrders = await request('GET', '/api/repair/teacher-orders', null, teacherCookie);
  assert(teacherOrders.status === 200, '教师专属查询接口可用');

  console.log('\n--- 4. 审核流程（状态流转）---');
  const reviewRes = await request('PUT', `/api/repair/orders/${teacherOrderId}/review`, {
    comment: '收到故障报告，开始审核'
  }, adminCookie);
  assert(reviewRes.status === 200, '审核通过，状态变为 reviewing');
  assert(reviewRes.data.status === 'reviewing', '状态更新为审核中');

  const invalidTransition = await request('PUT', `/api/repair/orders/${teacherOrderId}/return`, {}, adminCookie);
  assert(invalidTransition.status === 400, '状态倒退被拦截（不能直接从reviewing到returned）');

  const sameStatus = await request('PUT', `/api/repair/orders/${teacherOrderId}/review`, {}, adminCookie);
  assert(sameStatus.status === 400, '重复状态变更被拦截');

  console.log('\n--- 5. 冲突拦截测试（预约/领用/盘点中不能停用）---');
  const reserveRes = await request('POST', '/api/reservations', {
    course_id: 1, class_id: 1, equipment_id: 2, qty: 2, week_key: '2026-W24'
  }, adminCookie);
  assert(reserveRes.status === 200, '创建预约（制造流转态）');
  await request('PUT', `/api/reservations/${reserveRes.data.id}/approve`, {}, adminCookie);
  await request('PUT', `/api/reservations/${reserveRes.data.id}/collect`, {}, adminCookie);

  const conflictOrderRes = await request('POST', '/api/repair/orders', {
    equipment_id: 2,
    qty: 1,
    fault_phenomenon: '测试冲突'
  }, adminCookie);
  assert(conflictOrderRes.status === 201, '流转中的器材仍可提交故障单');
  const conflictOrderId = conflictOrderRes.data.id;

  await request('PUT', `/api/repair/orders/${conflictOrderId}/review`, {}, adminCookie);

  const deactivateConflictRes = await request('PUT', `/api/repair/orders/${conflictOrderId}/deactivate`, {
    reason: '尝试停用流转中的器材'
  }, adminCookie);
  assert(deactivateConflictRes.status === 409, '已领用器材停用时触发冲突拦截');
  assert(deactivateConflictRes.data.conflicts && deactivateConflictRes.data.conflicts.length > 0, '返回冲突详情');
  console.log(`  冲突详情: ${deactivateConflictRes.data.conflicts.map(c => c.message).join('; ')}`);

  const conflictCheckRes = await request('GET', '/api/repair/check-conflict/2', null, adminCookie);
  assert(conflictCheckRes.status === 200, '冲突检查接口可用');
  assert(conflictCheckRes.data.in_transit === true, '正确检测到流转状态');

  await request('PUT', `/api/reservations/${reserveRes.data.id}/return`, { return_qty: 2 }, adminCookie);
  const noConflictCheck = await request('GET', '/api/repair/check-conflict/2', null, adminCookie);
  assert(noConflictCheck.data.in_transit === false, '归还后流转状态清除');

  const batchRes = await request('POST', '/api/inventory/batches', { semester: '2025-2026-2', lab_name: '物理实验室' }, adminCookie);
  await request('PUT', `/api/inventory/batches/${batchRes.data.id}/lock`, {}, adminCookie);
  const conflictCheckInventory = await request('GET', '/api/repair/check-conflict/1', null, adminCookie);
  assert(conflictCheckInventory.data.in_transit === true, '盘点中的器材也被检测为流转态');

  await request('PUT', `/api/inventory/batches/${batchRes.data.id}/cancel`, {}, adminCookie);
  const noConflictAfterCancel = await request('GET', '/api/repair/check-conflict/1', null, adminCookie);
  assert(noConflictAfterCancel.data.in_transit === false, '取消盘点后流转状态清除');

  console.log('\n--- 6. 完整维修流程（停用→送修→回库）---');
  const deactivateRes = await request('PUT', `/api/repair/orders/${teacherOrderId}/deactivate`, {
    reason: '故障确认，立即停用待修'
  }, adminCookie);
  assert(deactivateRes.status === 200, '器材停用成功');
  assert(deactivateRes.data.status === 'deactivated', '状态变为已停用');

  const eqAfterDeactivate = await request('GET', '/api/equipment', null, adminCookie);
  const oscilloAfter = eqAfterDeactivate.data.find(e => e.id === 1);
  assert(oscilloAfter.available_qty === 9, '停用后可用数量减少1');
  assert(oscilloAfter.locked_qty === 1, '停用后锁定数量增加1');
  console.log(`  示波器停用后: available=${oscilloAfter.available_qty}, locked=${oscilloAfter.locked_qty}`);

  const repairRes = await request('PUT', `/api/repair/orders/${teacherOrderId}/repair`, {
    vendor: 'XX仪器维修中心',
    scheduled_date: '2026-06-20',
    estimated_cost: 200,
    reason: '电源模块损坏，需要专业维修'
  }, adminCookie);
  assert(repairRes.status === 200, '安排送修成功');
  assert(repairRes.data.status === 'repairing', '状态变为维修中');
  assert(repairRes.data.repair_vendor === 'XX仪器维修中心', '维修厂商信息保存');

  const returnRes = await request('PUT', `/api/repair/orders/${teacherOrderId}/return`, {
    actual_cost: 180,
    note: '已更换电源模块，测试正常',
    return_date: '2026-06-25'
  }, adminCookie);
  assert(returnRes.status === 200, '维修完成回库成功');
  assert(returnRes.data.status === 'returned', '状态变为已回库');

  const eqAfterReturn = await request('GET', '/api/equipment', null, adminCookie);
  const oscilloReturn = eqAfterReturn.data.find(e => e.id === 1);
  assert(oscilloReturn.available_qty === 10, '回库后可用数量恢复');
  assert(oscilloReturn.locked_qty === 0, '回库后锁定数量清零');
  console.log(`  示波器回库后: available=${oscilloReturn.available_qty}, locked=${oscilloReturn.locked_qty}`);

  console.log('\n--- 7. 换件与报废流程 ---');
  const scrapTestRes = await request('POST', '/api/repair/orders', {
    equipment_id: 3,
    qty: 2,
    fault_phenomenon: '烧杯破裂，无法修复'
  }, labManagerCookie);
  assert(scrapTestRes.status === 201, '创建烧杯故障单成功');
  const scrapOrderId = scrapTestRes.data.id;

  await request('PUT', `/api/repair/orders/${scrapOrderId}/review`, {}, adminCookie);

  const eqBeforeScrap = await request('GET', '/api/equipment', null, adminCookie);
  const beakerBefore = eqBeforeScrap.data.find(e => e.id === 3);
  console.log(`  报废前烧杯: total=${beakerBefore.total_qty}, available=${beakerBefore.available_qty}`);

  const scrapRes = await request('PUT', `/api/repair/orders/${scrapOrderId}/scrap`, {
    reason: '烧杯已破裂，无修复价值'
  }, adminCookie);
  assert(scrapRes.status === 200, '器材报废成功');
  assert(scrapRes.data.status === 'scrapped', '状态变为已报废');

  const eqAfterScrap = await request('GET', '/api/equipment', null, adminCookie);
  const beakerAfter = eqAfterScrap.data.find(e => e.id === 3);
  assert(beakerAfter.total_qty === 48, '报废后总数量减少2（50→48）');
  assert(beakerAfter.available_qty === 48, '报废后可用数量同步减少');
  console.log(`  报废后烧杯: total=${beakerAfter.total_qty}, available=${beakerAfter.available_qty}`);

  const replaceTestRes = await request('POST', '/api/repair/orders', {
    equipment_id: 4,
    qty: 1,
    fault_phenomenon: '显微镜镜头霉变，影响观察'
  }, teacherCookie);
  assert(replaceTestRes.status === 201, '创建显微镜故障单成功');
  const replaceOrderId = replaceTestRes.data.id;

  await request('PUT', `/api/repair/orders/${replaceOrderId}/review`, {}, adminCookie);
  const replaceRes = await request('PUT', `/api/repair/orders/${replaceOrderId}/replace`, {
    reason: '镜头需要更换，库存有备件'
  }, adminCookie);
  assert(replaceRes.status === 200, '安排换件成功');
  assert(replaceRes.data.status === 'replacing', '状态变为换件中');

  console.log('\n--- 8. 审批记录留痕查询 ---');
  const approvalsRes = await request('GET', `/api/repair/orders/${teacherOrderId}/approvals`, null, adminCookie);
  assert(approvalsRes.status === 200, '获取审批记录成功');
  assert(approvalsRes.data.length >= 4, '包含所有审批步骤（提交、审核、停用、维修、回库）');
  const actions = approvalsRes.data.map(a => a.action);
  assert(actions.includes('submit'), '有提交记录');
  assert(actions.includes('review'), '有审核记录');
  assert(actions.includes('deactivate'), '有停用记录');
  assert(actions.includes('repair'), '有维修记录');
  assert(actions.includes('return'), '有回库记录');
  console.log(`  审批操作序列: ${actions.join(' → ')}`);

  const orderDetail = await request('GET', `/api/repair/orders/${teacherOrderId}`, null, adminCookie);
  assert(orderDetail.data.approvals && orderDetail.data.approvals.length > 0, '维修单详情包含审批记录');

  console.log('\n--- 9. 维修排期管理 ---');
  const scheduleRes = await request('POST', '/api/repair/schedules', {
    repair_order_id: labManagerOrderId,
    vendor: 'YY电子维修部',
    contact_person: '李师傅',
    contact_phone: '13800001111',
    scheduled_date: '2026-06-22',
    estimated_cost: 150,
    notes: '万用表校准和更换表笔'
  }, adminCookie);
  assert(scheduleRes.status === 201, '创建维修排期成功');

  const schedulesList = await request('GET', '/api/repair/schedules', null, adminCookie);
  assert(schedulesList.status === 200, '获取排期列表成功');
  assert(schedulesList.data.length >= 1, '列表包含新创建的排期');

  const scheduleId = schedulesList.data[0].id;
  const updateScheduleRes = await request('PUT', `/api/repair/schedules/${scheduleId}`, {
    status: 'picked_up',
    pickup_date: '2026-06-22',
    actual_cost: 160
  }, adminCookie);
  assert(updateScheduleRes.status === 200, '更新排期状态成功');

  console.log('\n--- 10. 统计信息 ---');
  const statsRes = await request('GET', '/api/repair/stats', null, adminCookie);
  assert(statsRes.status === 200, '获取统计信息成功');
  assert(statsRes.data.total >= 4, '统计包含所有维修单');
  assert(statsRes.data.returned === 1, '已回库数量正确');
  assert(statsRes.data.scrapped === 1, '已报废数量正确');
  assert(statsRes.data.repairing === 0, '维修中数量正确');
  console.log(`  统计: 总数=${statsRes.data.total}, 待处理=${statsRes.data.pending}, 已回库=${statsRes.data.returned}, 已报废=${statsRes.data.scrapped}`);

  const teacherStats = await request('GET', '/api/repair/stats', null, teacherCookie);
  assert(teacherStats.status === 200, '教师获取统计成功');
  assert(teacherStats.data.total >= 2, '教师统计只包含自己相关的');

  console.log('\n--- 11. 取消与撤销能力 ---');
  const cancelTestRes = await request('POST', '/api/repair/orders', {
    equipment_id: 5,
    qty: 5,
    fault_phenomenon: '试管清洗时发现裂痕'
  }, teacherCookie);
  assert(cancelTestRes.status === 201, '创建待取消的故障单成功');
  const cancelOrderId = cancelTestRes.data.id;

  const cancelRes = await request('PUT', `/api/repair/orders/${cancelOrderId}/cancel`, {
    reason: '经确认可以继续使用，取消维修'
  }, teacherCookie);
  assert(cancelRes.status === 200, '教师取消自己提交的维修单成功');
  assert(cancelRes.data.status === 'cancelled', '状态变为已取消');

  const cancelOther = await request('PUT', `/api/repair/orders/${labManagerOrderId}/cancel`, {}, teacherCookie);
  assert(cancelOther.status === 403, '教师无法取消他人提交的维修单');

  const revokeTestRes = await request('POST', '/api/repair/orders', {
    equipment_id: 5,
    qty: 3,
    fault_phenomenon: '测试撤销功能'
  }, adminCookie);
  const revokeOrderId = revokeTestRes.data.id;
  await request('PUT', `/api/repair/orders/${revokeOrderId}/review`, {}, adminCookie);
  await request('PUT', `/api/repair/orders/${revokeOrderId}/deactivate`, {}, adminCookie);

  const eqBeforeRevoke = await request('GET', '/api/equipment', null, adminCookie);
  const tubeBefore = eqBeforeRevoke.data.find(e => e.id === 5);
  console.log(`  撤销前试管: available=${tubeBefore.available_qty}, locked=${tubeBefore.locked_qty}`);

  const revokeRes = await request('PUT', `/api/repair/orders/${revokeOrderId}/revoke`, {
    reason: '误操作，撤销维修单'
  }, adminCookie);
  assert(revokeRes.status === 200, '撤销维修单成功');
  assert(revokeRes.data.status === 'revoked', '状态变为已撤销');
  assert(revokeRes.data.revoked_from === 'deactivated', '记录撤销前的状态');

  const eqAfterRevoke = await request('GET', '/api/equipment', null, adminCookie);
  const tubeAfter = eqAfterRevoke.data.find(e => e.id === 5);
  assert(tubeAfter.available_qty === 100, '撤销后可用数量恢复');
  assert(tubeAfter.locked_qty === 0, '撤销后锁定数量清零');
  console.log(`  撤销后试管: available=${tubeAfter.available_qty}, locked=${tubeAfter.locked_qty}`);

  const revokeTerminal = await request('PUT', `/api/repair/orders/${teacherOrderId}/revoke`, {}, adminCookie);
  assert(revokeTerminal.status === 400, '终态（已回库）不可撤销');

  console.log('\n--- 12. CSV 导出与导入 ---');
  const csvRes = await request('GET', '/api/repair/export/csv', null, adminCookie);
  assert(csvRes.status === 200, '导出CSV成功');
  assert(typeof csvRes.data === 'string' && csvRes.data.includes('维修单号'), 'CSV内容包含标题');
  assert(csvRes.data.includes(teacherOrderNo), 'CSV包含教师提交的维修单号');
  console.log(`  导出CSV长度: ${csvRes.data.length} 字符`);

  const csvRowCount = csvRes.data.split('\n').filter(l => l.trim().length > 0).length;
  console.log(`  CSV行数: ${csvRowCount}`);

  await request('POST', '/api/reset');
  await new Promise(r => setTimeout(r, 500));
  const adminLogin2 = await request('POST', '/api/login', { username: 'admin', password: 'admin123' });
  const adminCookie2 = adminLogin2.cookie.split(';')[0];

  const importRes = await request('POST', '/api/repair/import/csv', {
    csv_data: csvRes.data
  }, adminCookie2);
  assert(importRes.status === 200, 'CSV导入成功');
  assert(importRes.data.imported > 0, '成功导入历史维修单');
  console.log(`  导入结果: 成功${importRes.data.imported}项, 跳过${importRes.data.skipped}项, 错误${importRes.data.errors}项`);

  const importDupRes = await request('POST', '/api/repair/import/csv', {
    csv_data: csvRes.data
  }, adminCookie2);
  assert(importDupRes.status === 200, '重复导入检测');
  assert(importDupRes.data.skipped === importRes.data.imported, '重复单号被跳过');
  console.log(`  重复导入: 跳过${importDupRes.data.skipped}项`);

  const importedList = await request('GET', '/api/repair/orders', null, adminCookie2);
  assert(importedList.data.length >= importRes.data.imported, '导入的维修单可查询');
  const importedOrder = importedList.data.find(o => o.order_no === teacherOrderNo);
  assert(importedOrder, '导入的维修单存在');
  assert(importedOrder.fault_phenomenon.includes('示波器'), '故障现象正确导入');
  assert(importedOrder.import_source === 'csv_import', '标记为导入来源');

  console.log('\n--- 13. 服务重启后数据一致性 ---');
  const persistentOrder = await request('POST', '/api/repair/orders', {
    equipment_id: 1,
    qty: 1,
    fault_phenomenon: '测试重启后数据保留',
    handling_suggestion: '重启测试'
  }, adminCookie2);
  const persistentOrderId = persistentOrder.data.id;
  const persistentOrderNo = persistentOrder.data.order_no;

  await request('PUT', `/api/repair/orders/${persistentOrderId}/review`, {}, adminCookie2);
  await request('PUT', `/api/repair/orders/${persistentOrderId}/deactivate`, {}, adminCookie2);

  await new Promise(r => setTimeout(r, 1000));

  const checkAfterSave = await request('GET', `/api/repair/orders/${persistentOrderId}`, null, adminCookie2);
  assert(checkAfterSave.status === 200, '保存后可查询');
  assert(checkAfterSave.data.status === 'deactivated', '状态保持');
  assert(checkAfterSave.data.approvals.length >= 3, '审批记录保持');

  console.log(`\n--- 14. 操作日志留痕 ---`);
  const logsRes = await request('GET', '/api/logs', null, adminCookie2);
  assert(logsRes.status === 200, '获取操作日志成功');
  const repairLogs = logsRes.data.filter(l => l.action && l.action.startsWith('repair_'));
  assert(repairLogs.length > 0, '维修相关操作有日志记录');
  const logActions = [...new Set(repairLogs.map(l => l.action))];
  console.log(`  维修相关日志类型: ${logActions.join(', ')}`);

  const createLog = repairLogs.find(l => l.action === 'repair_create_order');
  assert(createLog, '创建维修单有日志');

  console.log('\n=== 测试结果 ===');
  console.log(`通过: ${passed}`);
  console.log(`失败: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('测试异常:', e); process.exit(1); });
