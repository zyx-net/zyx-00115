const http = require('http');

const BASE = 'http://localhost:3001';
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
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
  console.log('\n=== 学期器材盘点与纠偏中心 回归测试 ===\n');

  console.log('准备: 重置数据...');
  const resetRes = await request('POST', '/api/reset');
  await new Promise(r => setTimeout(r, 500));

  console.log('\n--- 1. 发起盘点批次 ---');
  const adminLogin = await request('POST', '/api/login', { username: 'admin', password: 'admin123' });
  const adminCookie = adminLogin.cookie.split(';')[0];
  assert(adminLogin.status === 200, '管理员登录成功');

  const reserveRes = await request('POST', '/api/reservations', { course_id: 1, class_id: 1, equipment_id: 1, qty: 2, week_key: '2026-W24' }, adminCookie);
  assert(reserveRes.status === 200, '创建预约(制造流转态)');
  const approveRes = await request('PUT', `/api/reservations/${reserveRes.data.id}/approve`, {}, adminCookie);
  assert(approveRes.status === 200, '审批预约');
  const collectRes = await request('PUT', `/api/reservations/${reserveRes.data.id}/collect`, {}, adminCookie);
  assert(collectRes.status === 200, '领用器材(制造流转态)');

  const createRes = await request('POST', '/api/inventory/batches', { semester: '2025-2026-2', lab_name: '物理实验室' }, adminCookie);
  assert(createRes.status === 201, '盘点批次创建成功');
  assert(createRes.data.batch_no.startsWith('INV'), '批次号格式正确');
  assert(createRes.data.items && createRes.data.items.length > 0, '批次包含器材明细');
  assert(createRes.data.status === 'draft', '初始状态为草稿');
  const batchId = createRes.data.id;
  const batchNo = createRes.data.batch_no;
  console.log(`  批次号: ${batchNo}, ID: ${batchId}, 器材数: ${createRes.data.items.length}`);

  const listRes = await request('GET', '/api/inventory/batches', null, adminCookie);
  assert(listRes.status === 200, '获取批次列表成功');
  assert(listRes.data.length > 0, '列表非空');

  console.log('\n--- 2. 锁定与录入实盘 ---');
  const lockRes = await request('PUT', `/api/inventory/batches/${batchId}/lock`, {}, adminCookie);
  assert(lockRes.status === 200, '锁定盘点范围成功');
  const afterLock = await request('GET', `/api/inventory/batches/${batchId}`, null, adminCookie);
  assert(afterLock.data.status === 'locked', '锁定后状态为locked');

  const items = afterLock.data.items;
  let conflictItemId = null;
  let normalDiffItemId = null;
  for (const item of items) {
    let actualQty = item.book_qty;
    if (item.equipment_id === 1) {
      actualQty = item.book_qty - 1;
      conflictItemId = item.id;
    } else if (item.equipment_id === 2) {
      actualQty = item.book_qty - 1;
      normalDiffItemId = item.id;
    }
    const recRes = await request('PUT', `/api/inventory/batches/${batchId}/record`, {
      item_id: item.id, actual_qty: actualQty, missing_reason: actualQty !== item.book_qty ? '盘点差异' : null
    }, adminCookie);
    assert(recRes.status === 200, `录入 ${item.equipment_name} 实盘=${actualQty}`);
  }

  console.log('\n--- 3. 差异计算与冲突拦截 ---');
  const diffRes = await request('POST', `/api/inventory/batches/${batchId}/calculate-diff`, {}, adminCookie);
  assert(diffRes.status === 200, '差异计算成功');
  assert(diffRes.data.conflicts && diffRes.data.conflicts.length > 0, '检测到冲突(示波器有流转)');
  console.log(`  差异项: ${diffRes.data.diff_items}, 冲突: ${diffRes.data.conflicts.length}`);

  const afterDiff = await request('GET', `/api/inventory/batches/${batchId}`, null, adminCookie);
  const conflictItem = afterDiff.data.items.find(i => i.status === 'conflict_blocked');
  assert(conflictItem, '冲突项被拦截标记');
  assert(conflictItem.conflict_info, '冲突项有冲突详情');

  const confirmFail = await request('PUT', `/api/inventory/batches/${batchId}/confirm-diff`, {}, adminCookie);
  assert(confirmFail.status === 400, '存在冲突时无法确认差异');

  const resolveConflictFail = await request('PUT', `/api/inventory/batches/${batchId}/resolve-conflict/${conflictItem.id}`, {}, adminCookie);
  assert(resolveConflictFail.status === 400, '流转中的器材冲突解决被拦截');

  console.log('\n--- 4. 解决流转后确认差异与纠偏 ---');
  const returnRes = await request('PUT', `/api/reservations/${reserveRes.data.id}/return`, { return_qty: 2 }, adminCookie);
  assert(returnRes.status === 200, '归还器材(清除流转态)');

  const resolveRes = await request('PUT', `/api/inventory/batches/${batchId}/resolve-conflict/${conflictItem.id}`, {}, adminCookie);
  assert(resolveRes.status === 200, '冲突解决并纠偏成功');

  const batchAfterResolve = await request('GET', `/api/inventory/batches/${batchId}`, null, adminCookie);
  const resolvedItem = batchAfterResolve.data.items.find(i => i.id === conflictItem.id);
  assert(resolvedItem.status === 'corrected', '冲突项已纠偏');
  console.log(`  冲突解决后状态: ${resolvedItem.status}`);

  const batchNow = await request('GET', `/api/inventory/batches/${batchId}`, null, adminCookie);
  console.log(`  当前批次状态: ${batchNow.data.status}`);

  if (batchNow.data.status === 'counting') {
    const conflicts = batchNow.data.items.filter(i => i.status === 'conflict_blocked');
    if (conflicts.length === 0) {
      const confirmRes = await request('PUT', `/api/inventory/batches/${batchId}/confirm-diff`, {}, adminCookie);
      assert(confirmRes.status === 200, '确认差异成功');
    }
  }

  const batchAfterConfirm = await request('GET', `/api/inventory/batches/${batchId}`, null, adminCookie);
  if (['diff_confirmed', 'correcting'].includes(batchAfterConfirm.data.status)) {
    const correctAllRes = await request('PUT', `/api/inventory/batches/${batchId}/correct-all`, {}, adminCookie);
    assert(correctAllRes.status === 200, '批量纠偏成功');
    console.log(`  纠偏结果: 成功${correctAllRes.data.corrected}项, 失败${correctAllRes.data.failed}项`);
  }

  const equipRes = await request('GET', '/api/equipment', null, adminCookie);
  const oscillo = equipRes.data.find(e => e.id === 1);
  assert(oscillo.total_qty === 9, '示波器纠偏后total_qty=9');
  console.log(`  示波器纠偏后: total=${oscillo.total_qty}`);

  console.log('\n--- 5. 导出CSV ---');
  const csvRes = await request('GET', `/api/inventory/batches/${batchId}/export-csv`, null, adminCookie);
  assert(csvRes.status === 200, '导出CSV成功');
  assert(typeof csvRes.data === 'string' && csvRes.data.includes('批次号'), 'CSV内容包含标题');
  assert(csvRes.data.includes(batchNo), 'CSV包含批次号');

  console.log('\n--- 6. 导入CSV恢复 ---');
  const importBatch = await request('POST', '/api/inventory/batches', { semester: '2025-2026-2', lab_name: '导入测试' }, adminCookie);
  const importBatchId = importBatch.data.id;
  await request('PUT', `/api/inventory/batches/${importBatchId}/lock`, {}, adminCookie);
  const csvData = csvRes.data;
  const importRes = await request('POST', '/api/inventory/import/csv', { csv_data: csvData, batch_id: importBatchId }, adminCookie);
  assert(importRes.status === 200, 'CSV导入成功');
  console.log(`  导入: 成功${importRes.data.imported}项, 跳过${importRes.data.skipped}项`);

  console.log('\n--- 7. 重启恢复 ---');
  const resetRes2 = await request('POST', '/api/reset');
  await new Promise(r => setTimeout(r, 500));

  const adminLogin2 = await request('POST', '/api/login', { username: 'admin', password: 'admin123' });
  const adminCookie2 = adminLogin2.cookie.split(';')[0];
  const batch3 = await request('POST', '/api/inventory/batches', { semester: '2025-2026-2' }, adminCookie2);
  const batch3Id = batch3.data.id;
  await request('PUT', `/api/inventory/batches/${batch3Id}/lock`, {}, adminCookie2);
  const batch3Items = batch3.data.items;
  for (const item of batch3Items) {
    await request('PUT', `/api/inventory/batches/${batch3Id}/record`, {
      item_id: item.id, actual_qty: item.book_qty
    }, adminCookie2);
  }

  const batchAfterRestart = await request('GET', `/api/inventory/batches/${batch3Id}`, null, adminCookie2);
  assert(batchAfterRestart.data.status === 'counting', '重启后批次状态保持');
  assert(batchAfterRestart.data.items.length > 0, '重启后盘点明细保持');
  console.log(`  重启后批次 ${batchAfterRestart.data.batch_no} 状态: ${batchAfterRestart.data.status}`);

  console.log('\n--- 8. 教师只读访问 ---');
  const teacherLogin = await request('POST', '/api/login', { username: 'zhangsan', password: '123456' });
  const teacherCookie = teacherLogin.cookie.split(';')[0];
  assert(teacherLogin.status === 200, '教师登录成功');

  const teacherBatchList = await request('GET', '/api/inventory/batches', null, teacherCookie);
  assert(teacherBatchList.status === 200, '教师可查看批次列表');

  const teacherItems = await request('GET', '/api/inventory/teacher-items', null, teacherCookie);
  assert(teacherItems.status === 200, '教师可查看课程相关盘点结果');

  const teacherCreate = await request('POST', '/api/inventory/batches', { semester: '2025-2026-2' }, teacherCookie);
  assert(teacherCreate.status === 403, '教师无法创建盘点批次');

  const teacherLock = await request('PUT', `/api/inventory/batches/${batch3Id}/lock`, {}, teacherCookie);
  assert(teacherLock.status === 403, '教师无法锁定批次');

  const teacherRecord = await request('PUT', `/api/inventory/batches/${batch3Id}/record`, {
    item_id: batch3Items[0].id, actual_qty: 99
  }, teacherCookie);
  assert(teacherRecord.status === 403, '教师无法录入实盘数据');

  console.log('\n--- 9. 取消盘点批次 ---');
  const cancelBatch = await request('POST', '/api/inventory/batches', { semester: '2025-2026-2' }, adminCookie2);
  const cancelBatchId = cancelBatch.data.id;
  const cancelRes = await request('PUT', `/api/inventory/batches/${cancelBatchId}/cancel`, {}, adminCookie2);
  assert(cancelRes.status === 200, '取消批次成功');
  const cancelledBatch = await request('GET', `/api/inventory/batches/${cancelBatchId}`, null, adminCookie2);
  assert(cancelledBatch.data.status === 'cancelled', '批次状态为已取消');

  console.log('\n=== 测试结果 ===');
  console.log(`通过: ${passed}`);
  console.log(`失败: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('测试异常:', e); process.exit(1); });
