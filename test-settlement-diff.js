const http = require('http');
const fs = require('fs');

const BASE = 'http://localhost:3001';
let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); passed++; }
  else { console.error(`  ✗ ${msg}`); failed++; process.exitCode = 1; }
}

function request(method, path, body, cookieJar, expectJson = true) {
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
        if (expectJson) {
          try { parsed = data ? JSON.parse(data) : {}; } catch(e) { parsed = { _raw: data }; }
        } else {
          parsed = data;
        }
        const setCookie = res.headers['set-cookie'];
        if (setCookie && cookieJar !== undefined) {
          const newSid = setCookie[0].split(';')[0];
          if (newSid.startsWith('sid=')) cookieJar = newSid;
        }
        resolve({ status: res.statusCode, body: parsed, cookie: cookieJar, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (b) req.write(b);
    req.end();
  });
}

async function login(username, password, cookie) {
  const r = await request('POST', '/api/login', { username, password }, cookie);
  assert(r.status === 200, `${username} 登录成功`);
  return r.cookie;
}

async function resetAndInit() {
  await request('POST', '/api/reset', {}, '');
}

async function main() {
  console.log('\n=== 结转差异对比 + 说明留痕 完整回归测试 ===\n');
  await resetAndInit();

  let adminCookie = '';
  let teacherCookie = '';
  let labCookie = '';
  adminCookie = await login('admin', 'admin123', adminCookie);
  teacherCookie = await login('zhangsan', '123456', teacherCookie);
  labCookie = await login('wangwu', '123456', labCookie);

  console.log('\n--- Step 1: 准备数据 - 预约+审批+领用+损耗审批+两周结转 ---');
  const reserve = await request('POST', '/api/reservations', {
    course_id: 1, class_id: 1, equipment_id: 4, qty: 2, week_key: '2026-W24'
  }, teacherCookie);
  assert(reserve.status === 200, '教师创建预约成功');
  const rid = reserve.body.id;

  const approve = await request('PUT', `/api/reservations/${rid}/approve`, null, labCookie);
  assert(approve.status === 200, '实验员审批预约成功');
  const collect = await request('PUT', `/api/reservations/${rid}/collect`, null, teacherCookie);
  assert(collect.status === 200, '教师领用成功');

  const ret = await request('PUT', `/api/reservations/${rid}/return`, { return_qty: 1 }, teacherCookie);
  assert(ret.status === 200, '部分归还成功');

  const loss = await request('POST', '/api/loss-reports', {
    reservation_id: rid, qty: 1, reason: '镜头磨损测试'
  }, teacherCookie);
  assert(loss.status === 200, '申报损耗成功');

  const approveLoss = await request('PUT', `/api/loss-reports/${loss.body.id}/approve`, null, labCookie);
  assert(approveLoss.status === 200, '审批损耗成功');

  const s1 = await request('POST', '/api/settlements/weekly', { week_key: '2026-W24' }, labCookie);
  assert(s1.status === 200, '结转 2026-W24 成功');
  const sid1 = s1.body.id;

  const reserve2 = await request('POST', '/api/reservations', {
    course_id: 1, class_id: 2, equipment_id: 1, qty: 3, week_key: '2026-W25'
  }, teacherCookie);
  assert(reserve2.status === 200, '创建 W25 预约');
  const approve2 = await request('PUT', `/api/reservations/${reserve2.body.id}/approve`, null, labCookie);
  assert(approve2.status === 200, '审批 W25 预约');

  const s2 = await request('POST', '/api/settlements/weekly', { week_key: '2026-W25' }, labCookie);
  assert(s2.status === 200, '结转 2026-W25 成功');
  const sid2 = s2.body.id;
  assert(sid1 !== sid2, '两次结转 ID 不同');

  console.log('\n--- Step 2: 权限拦截 - 教师角色尝试违规操作 ---');
  const teacherAddNote = await request('POST', `/api/settlements/${sid1}/notes`, { content: '教师偷偷加说明' }, teacherCookie);
  assert(teacherAddNote.status === 403, `教师添加说明被拦截 (403, 实际: ${teacherAddNote.status})`);

  const teacherUpdateNote = await request('PUT', '/api/settlements/notes/9999', { content: 'x' }, teacherCookie);
  assert(teacherUpdateNote.status === 403, '教师修改说明被拦截 (403)');

  const teacherDeleteNote = await request('DELETE', '/api/settlements/notes/9999', null, teacherCookie);
  assert(teacherDeleteNote.status === 403, '教师删除说明被拦截 (403)');

  const teacherExportCsv = await request('POST', '/api/settlements/compare/export-csv', {
    settlement_a_id: sid1, settlement_b_id: sid2
  }, teacherCookie);
  assert(teacherExportCsv.status === 403, '教师导出对比 CSV 被拦截 (403)');

  console.log('\n--- Step 3: 结转说明 CRUD ---');
  const note1 = await request('POST', `/api/settlements/${sid1}/notes`, {
    content: '2026-W24 对账说明：显微镜1件损耗，已和张老师确认，后续采购补充。'
  }, labCookie);
  assert(note1.status === 201, '实验员添加说明成功 (201)');
  const nid1 = note1.body.id;
  assert(note1.body.week_key === '2026-W24', '说明关联正确 week_key');
  assert(note1.body.created_by_name === '王五(实验员)', '说明创建人正确');

  const note2 = await request('POST', `/api/settlements/${sid1}/notes`, {
    content: '补充：待归还显微镜已联系张老师下周归还。'
  }, adminCookie);
  assert(note2.status === 201, '管理员追加说明成功');
  const nid2 = note2.body.id;

  const settlements = await request('GET', '/api/settlements', null, labCookie);
  const sWithNotes = settlements.body.find(s => s.id === sid1);
  assert(sWithNotes && sWithNotes.notes && sWithNotes.notes.length === 2,
    `结转列表包含 notes 字段 (${sWithNotes && sWithNotes.notes ? sWithNotes.notes.length : 0} 条)`);

  const noteEmpty = await request('POST', `/api/settlements/${sid1}/notes`, { content: '   ' }, labCookie);
  assert(noteEmpty.status === 400, '空内容说明被拒绝 (400)');

  const updateNote = await request('PUT', `/api/settlements/notes/${nid1}`, {
    content: '2026-W24 对账说明：显微镜1件损耗，确认原因是学生操作不当，已教育；后续走采购流程补充。'
  }, labCookie);
  assert(updateNote.status === 200, '修改说明成功');
  assert(updateNote.body.updated_at !== updateNote.body.created_at, '修改后 updated_at 变更');
  assert(updateNote.body.content !== note1.body.content, '内容确实更新');

  const delNote = await request('DELETE', `/api/settlements/notes/${nid2}`, null, adminCookie);
  assert(delNote.status === 200, '删除说明成功');

  const notesAfter = await request('GET', `/api/settlements/${sid1}/notes`, null, teacherCookie);
  assert(notesAfter.body.length === 1, '删除后说明数量为1（教师也能查询）');

  console.log('\n--- Step 4: 差异对比 API ---');
  const diffResp = await request('POST', '/api/settlements/compare', {
    settlement_a_id: sid1, settlement_b_id: sid2
  }, labCookie);
  assert(diffResp.status === 200, '对比请求成功');
  const d = diffResp.body.diff;
  assert(d.equipment_snapshot, 'diff 包含 equipment_snapshot');
  assert(d.reservation_summary, 'diff 包含 reservation_summary');
  assert(d.loss_summary, 'diff 包含 loss_summary');
  assert(d.pending_returns, 'diff 包含 pending_returns');
  assert(typeof diffResp.body.comparison_id === 'number', '管理员/实验员对比后记录 comparison_id');
  assert(diffResp.body.settlement_a.week_key === '2026-W24', 'A 周次正确');
  assert(diffResp.body.settlement_b.week_key === '2026-W25', 'B 周次正确');

  const teacherDiff = await request('POST', '/api/settlements/compare', {
    settlement_a_id: sid1, settlement_b_id: sid2
  }, teacherCookie);
  assert(teacherDiff.status === 200, '教师也能查看对比');
  assert(teacherDiff.body.comparison_id === null, '教师对比后不记录 comparison_id (null)');

  const diffSame = await request('POST', '/api/settlements/compare', {
    settlement_a_id: sid1, settlement_b_id: sid1
  }, labCookie);
  assert(diffSame.status === 400, '不能对比同一条记录 (400)');

  const diffMissing = await request('POST', '/api/settlements/compare', {
    settlement_a_id: sid1, settlement_b_id: 99999
  }, labCookie);
  assert(diffMissing.status === 404, '不存在的 ID 返回 404');

  const diffParam = await request('POST', '/api/settlements/compare', {}, labCookie);
  assert(diffParam.status === 400, '缺少参数返回 400');

  console.log('\n--- Step 5: 对比导出 CSV ---');
  const csvResp = await request('POST', '/api/settlements/compare/export-csv', {
    settlement_a_id: sid1, settlement_b_id: sid2
  }, labCookie, false);
  assert(csvResp.status === 200, 'CSV 导出成功 (200)');
  assert(csvResp.headers['content-type'].includes('csv'), 'Content-Type 为 text/csv');
  assert(csvResp.headers['content-disposition'] && csvResp.headers['content-disposition'].includes('.csv'),
    'Content-Disposition 包含 .csv 文件名');
  const csvContent = csvResp.body;
  assert(csvContent.startsWith('\uFEFF'), 'CSV 带 UTF-8 BOM (Excel 兼容)');
  assert(csvContent.includes('类别,变化类型,项目,字段,'), 'CSV 表头正确');
  assert(csvContent.includes('器材快照'), '包含器材快照类');
  assert(csvContent.includes('预约汇总'), '包含预约汇总类');
  assert(csvContent.includes('损耗汇总'), '包含损耗汇总类');
  const rowCount = csvContent.split('\n').filter(l => l.trim().length > 0).length;
  assert(rowCount >= 2, `CSV 至少有表头+数据 (实际 ${rowCount} 行)`);

  console.log('\n--- Step 5.5: /api/settlements/exports 权限拦截 + 导出列表可见性 ---');
  const teacherExports = await request('GET', '/api/settlements/exports', null, teacherCookie);
  assert(teacherExports.status === 403, `教师访问 /api/settlements/exports 被拦截 (403, 实际: ${teacherExports.status})`);

  const labExportsBefore = await request('GET', '/api/settlements/exports', null, labCookie);
  assert(labExportsBefore.status === 200, '实验员能正常访问 exports 列表');
  assert(Array.isArray(labExportsBefore.body), 'exports 返回数组');
  const hasW25ExportBefore = labExportsBefore.body.some(e =>
    (e.week_key_a === '2026-W25') || (e.week_key_b === '2026-W25') || (e.type === 'comparison' && (e.week_key_a === '2026-W24' && e.week_key_b === '2026-W25'))
  );
  assert(hasW25ExportBefore, `撤销前列表中含涉及 W25 的导出记录（实际 ${labExportsBefore.body.length} 条）`);

  console.log(`\n--- Step 6: 操作日志核对（新增动作） ---`);
  const logs = await request('GET', '/api/logs', null, adminCookie);
  const actions = logs.body.map(l => l.action);
  const requiredNew = [
    'add_settlement_note',
    'update_settlement_note',
    'delete_settlement_note',
    'compare_settlements',
    'export_settlement_diff_csv'
  ];
  requiredNew.forEach(a => {
    assert(actions.includes(a), `操作日志包含新动作: ${a}`);
  });
  const compareLog = logs.body.find(l => l.action === 'compare_settlements');
  assert(compareLog && compareLog.details && compareLog.details.week_key_a === '2026-W24',
    '对比日志含 week_key_a');

  console.log('\n--- Step 7: 撤销后数据收口（关联说明、对比、导出记录清理 + exports 列表过滤） ---');
  const notesBefore = await request('GET', `/api/settlements/${sid2}/notes`, null, labCookie);
  const addS2Note = await request('POST', `/api/settlements/${sid2}/notes`, {
    content: 'W25 临时说明，撤销后应被清理'
  }, labCookie);
  assert(addS2Note.status === 201, '为 W25 添加说明');

  const s2diff = await request('POST', '/api/settlements/compare', {
    settlement_a_id: sid1, settlement_b_id: sid2
  }, labCookie);
  assert(s2diff.status === 200, '再做一次涉及 W25 的对比');

  const s2csv = await request('POST', '/api/settlements/compare/export-csv', {
    settlement_a_id: sid1, settlement_b_id: sid2
  }, labCookie, false);
  assert(s2csv.status === 200, '再做一次涉及 W25 的 CSV 导出');

  const exportsCountBeforeRevoke = (await request('GET', '/api/settlements/exports', null, labCookie)).body.length;
  console.log(`  [info] 撤销前 exports 列表共 ${exportsCountBeforeRevoke} 条`);

  const revokeS2 = await request('DELETE', `/api/settlements/2026-W25/revoke`, null, labCookie);
  assert(revokeS2.status === 200, '撤销 W25 成功');
  assert(typeof revokeS2.body.cleaned !== 'undefined', '撤销返回 cleaned 统计');
  assert(revokeS2.body.cleaned.notes >= 1, `撤销时统计 notes 清理数量 (${revokeS2.body.cleaned.notes})`);
  assert(revokeS2.body.cleaned.exports_total >= 1,
    `撤销时统计 exports 清理（含 comparison 关联）非0: single=${revokeS2.body.cleaned.exports_single}, comparison=${revokeS2.body.cleaned.exports_comparison}, total=${revokeS2.body.cleaned.exports_total}`);
  console.log(`  [info] cleaned: notes=${revokeS2.body.cleaned.notes}, comparisons=${revokeS2.body.cleaned.comparisons}, exports_total=${revokeS2.body.cleaned.exports_total}`);

  const s2notesAfter = await request('GET', `/api/settlements/${sid2}/notes`, null, labCookie);
  assert(s2notesAfter.status === 404, '撤销后说明查询返回 404（结转已失效）');

  const diffAfterRevoke = await request('POST', '/api/settlements/compare', {
    settlement_a_id: sid1, settlement_b_id: sid2
  }, labCookie);
  assert(diffAfterRevoke.status === 404, `撤销后涉及 W25 的对比返回 404 (实际: ${diffAfterRevoke.status})`);

  const csvAfterRevoke = await request('POST', '/api/settlements/compare/export-csv', {
    settlement_a_id: sid1, settlement_b_id: sid2
  }, labCookie, false);
  assert(csvAfterRevoke.status === 404, `撤销后涉及 W25 的 CSV 导出返回 404 (实际: ${csvAfterRevoke.status})`);

  const exportsAfterRevoke = await request('GET', '/api/settlements/exports', null, labCookie);
  assert(exportsAfterRevoke.status === 200, '撤销后 exports 查询正常');
  const hasW25ExportAfter = exportsAfterRevoke.body.some(e =>
    (e.week_key_a === '2026-W25') || (e.week_key_b === '2026-W25')
  );
  assert(hasW25ExportAfter === false, `撤销后 exports 列表中不再含涉及 W25 的记录（撤销前${exportsCountBeforeRevoke}条，撤销后${exportsAfterRevoke.body.length}条）`);

  const logsAfter = await request('GET', '/api/logs', null, adminCookie);
  const revokeLog = logsAfter.body.find(l => l.action === 'revoke_weekly_settlement');
  assert(revokeLog && revokeLog.details && typeof revokeLog.details.cleaned_notes === 'number',
    '撤销日志中包含 cleaned_notes 统计');
  assert(revokeLog && revokeLog.details && typeof revokeLog.details.cleaned_exports_total === 'number' && revokeLog.details.cleaned_exports_total >= 1,
    `撤销日志 cleaned_exports_total 非0（实际: ${revokeLog.details && revokeLog.details.cleaned_exports_total}）`);

  console.log('\n--- Step 8: 快照数据，用于跨重启验证 ---');
  const exportsSnapshot = (await request('GET', '/api/settlements/exports', null, adminCookie)).body.map(e => ({
    id: e.id,
    type: e.type,
    week_key_a: e.week_key_a,
    week_key_b: e.week_key_b,
    filename: e.filename,
    row_count: e.row_count
  }));
  const snap = {
    equipment: (await request('GET', '/api/equipment', null, adminCookie)).body.map(e => ({
      id: e.id, name: e.name, total: e.total_qty, avail: e.available_qty, locked: e.locked_qty
    })),
    settlements: (await request('GET', '/api/settlements', null, adminCookie)).body.map(s => ({
      id: s.id,
      week_key: s.week_key,
      source: s.source,
      is_latest_settled: s.is_latest_settled,
      notes_count: s.notes ? s.notes.length : 0,
      notes_content: s.notes ? s.notes.map(n => ({ id: n.id, content: n.content, updated_at: n.updated_at, created_by_name: n.created_by_name })) : [],
      equipment_snapshot_count: s.totals.equipment_snapshot.length,
      reservation_total: s.totals.reservation_summary.total
    })),
    latestInfo: (await request('GET', '/api/settlements/latest-info', null, adminCookie)).body,
    logActions: [...new Set(logsAfter.body.map(l => l.action))],
    exportsSnapshot: exportsSnapshot,
    exportsCount: exportsSnapshot.length
  };
  fs.writeFileSync('./settlement-diff-snap.json', JSON.stringify(snap, null, 2), 'utf8');
  console.log(`  已写入快照: ${snap.equipment.length} 器材 / ${snap.settlements.length} 结转 / ${snap.settlements[0] ? snap.settlements[0].notes_count : 0} 说明 / ${snap.exportsCount} exports 记录`);

  console.log(`\n=== 回归测试结果: ${passed} 通过, ${failed} 失败 ===`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
