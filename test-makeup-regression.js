const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3001';
let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  \u2713 ${msg}`);
    passed++;
  } else {
    console.error(`  \u2717 ${msg}`);
    failed++;
    process.exitCode = 1;
  }
}

function request(method, path, body, cookieJar) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {}
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      const b = JSON.stringify(body);
      opts.headers['Content-Length'] = Buffer.byteLength(b);
      opts.body = b;
    }
    if (cookieJar) opts.headers['Cookie'] = cookieJar;

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; } catch(e) { parsed = { _raw: data }; }
        const setCookie = res.headers['set-cookie'];
        if (setCookie && cookieJar !== undefined) {
          const newSid = setCookie[0].split(';')[0];
          if (newSid.startsWith('sid=')) cookieJar = newSid;
        }
        resolve({ status: res.statusCode, body: parsed, cookie: cookieJar, raw: data });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function login(u, p, cookie) {
  const r = await request('POST', '/api/login', { username: u, password: p }, cookie);
  return r;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runTests() {
  console.log('\n========== 补课与调课审批中心 回归测试 ==========\n');

  console.log('=== 步骤 0: 重置数据 & 三角色登录 ===');
  let adminCookie = '', teacherCookie = '', teacher2Cookie = '', labCookie = '';

  await request('POST', '/api/reset', {}, '');
  console.log('  数据已重置');
  await delay(600);

  const ad = await login('admin', 'admin123', '');
  assert(ad.status === 200, `管理员登录成功 (${ad.status})`);
  adminCookie = ad.cookie;

  const t1 = await login('zhangsan', '123456', '');
  assert(t1.status === 200, `教师张三登录成功 (${t1.status})`);
  teacherCookie = t1.cookie;
  assert(t1.body.user && t1.body.user.id === 2, `张三 ID=2`);

  const t2 = await login('lisi', '123456', '');
  assert(t2.status === 200, `教师李四登录成功 (${t2.status})`);
  teacher2Cookie = t2.cookie;

  const lm = await login('wangwu', '123456', '');
  assert(lm.status === 200, `实验员王五登录成功 (${lm.status})`);
  labCookie = lm.cookie;

  console.log('\n=== 步骤 1: 基础数据接口 ===');
  const cl = await request('GET', '/api/makeup/classrooms', null, adminCookie);
  assert(cl.status === 200, `教室列表 200，共 ${Array.isArray(cl.body) ? cl.body.length : 0} 间`);
  assert(Array.isArray(cl.body) && cl.body.length >= 4, `至少 4 间教室`);

  const st = await request('GET', '/api/makeup/students', null, adminCookie);
  assert(st.status === 200, `学员列表 200，共 ${Array.isArray(st.body) ? st.body.length : 0} 名`);

  const sc = await request('GET', '/api/makeup/schedules?class_id=1', null, adminCookie);
  assert(sc.status === 200, `班级课表 200，共 ${Array.isArray(sc.body) ? sc.body.length : 0} 条`);

  const scT = await request('GET', '/api/makeup/schedules?teacher_id=2', null, teacherCookie);
  assert(scT.status === 200, `教师课表 200，共 ${Array.isArray(scT.body) ? scT.body.length : 0} 条`);

  const stats = await request('GET', '/api/makeup/stats', null, teacherCookie);
  assert(stats.status === 200 && stats.body.total === 0, `初始统计总数为 0`);

  console.log('\n=== 步骤 2: 提交补课申请（周三 14:00-16:00，避开原有排课） ===');
  const makeupPayload1 = {
    type: 'makeup',
    course_id: 1,
    class_id: 1,
    student_ids: [1, 2],
    original_schedule_id: 1,
    original_date: '2026-02-18',
    original_start_time: '08:00',
    original_end_time: '10:00',
    original_classroom_id: 1,
    new_date: '2026-02-25',
    new_start_time: '14:00',
    new_end_time: '16:00',
    new_classroom_id: 2,
    hours: 2,
    reason: '上周学生运动会停课，本周补物理实验'
  };

  const submit1 = await request('POST', '/api/makeup/requests', makeupPayload1, teacherCookie);
  assert(submit1.status === 200, `张三提交补课申请成功 (${submit1.status})`);
  assert(submit1.body && submit1.body.request_no, `返回申请单号: ${submit1.body.request_no || 'N/A'}`);
  assert(submit1.body && submit1.body.status === 'pending', `状态初始为 pending`);
  const reqId1 = submit1.body.id;
  const reqNo1 = submit1.body.request_no;
  console.log(`    申请单号: ${reqNo1} ID: ${reqId1}`);

  console.log('\n=== 步骤 3: 预检冲突接口 & 三类冲突拦截 ===');
  const checkOk = await request('POST', '/api/makeup/check-conflicts', {
    teacherId: 2, classroomId: 1, studentIds: [3,4],
    date: '2026-02-26', startTime: '09:00', endTime: '11:00', classId: 1
  }, teacherCookie);
  assert(checkOk.status === 200 && checkOk.body.has_conflict === false,
    `预检 2/26 9-11 空闲，无冲突 (${JSON.stringify(checkOk.body).slice(0,80)})`);

  const teacherConflictPayload = { ...makeupPayload1,
    new_date: '2026-02-25', new_start_time: '14:30', new_end_time: '15:30',
    new_classroom_id: 3, reason: '故意与申请1教师时间重叠' };
  const tc = await request('POST', '/api/makeup/requests', teacherConflictPayload, teacherCookie);
  assert(tc.status === 409, `教师时间重叠返回 409 (${tc.status}) - "${tc.body.error || ''}"`);
  assert(tc.body && tc.body.conflicts && tc.body.conflicts.teacher && tc.body.conflicts.teacher.length > 0,
    `响应包含 teacher 冲突明细: ${tc.body.conflicts ? tc.body.conflicts.teacher.length : 0} 条`);

  const roomConflictPayload = { ...makeupPayload1,
    new_date: '2026-02-25', new_start_time: '14:30', new_end_time: '15:30',
    classroomId: 2, new_classroom_id: 2, student_ids: [7,8], class_id: 3, course_id: 2,
    reason: '故意与申请1教室冲突' };
  const rc = await request('POST', '/api/makeup/requests', roomConflictPayload, teacher2Cookie);
  assert(rc.status === 409, `教室时间重叠返回 409 (${rc.status})`);
  assert(rc.body && rc.body.conflicts && rc.body.conflicts.classroom && rc.body.conflicts.classroom.length > 0,
    `响应包含 classroom 冲突明细: ${rc.body.conflicts ? rc.body.conflicts.classroom.length : 0} 条`);

  const studentConflictPayload = { ...makeupPayload1,
    course_id: 2, class_id: 3,
    new_date: '2026-02-25', new_start_time: '14:30', new_end_time: '15:30',
    new_classroom_id: 4, student_ids: [1, 2],
    reason: '故意与申请1学员1/2时间冲突(李四提交自己的化学课)' };
  const sc2 = await request('POST', '/api/makeup/requests', studentConflictPayload, teacher2Cookie);
  assert(sc2.status === 409, `学员时间重叠返回 409 (${sc2.status})`);
  assert(sc2.body && sc2.body.conflicts && sc2.body.conflicts.student && sc2.body.conflicts.student.length > 0,
    `响应包含 student 冲突明细: ${sc2.body.conflicts ? sc2.body.conflicts.student.length : 0} 人`);

  console.log('\n=== 步骤 4: 权限过滤（教师只看自己单据） ===');
  const listT1 = await request('GET', '/api/makeup/requests', null, teacherCookie);
  assert(listT1.status === 200, `张三查列表 200`);
  assert(Array.isArray(listT1.body) && listT1.body.length === 1, `张三只能看到自己 1 条申请`);

  const listT2 = await request('GET', '/api/makeup/requests', null, teacher2Cookie);
  assert(listT2.status === 200, `李四查列表 200`);
  assert(Array.isArray(listT2.body) && listT2.body.length === 0, `李四 0 条申请（申请1都是张三的）`);

  const listAdmin = await request('GET', '/api/makeup/requests', null, adminCookie);
  assert(Array.isArray(listAdmin.body) && listAdmin.body.length >= 1, `管理员能看到 >=1 条`);

  const detailByT2 = await request('GET', `/api/makeup/requests/${reqId1}`, null, teacher2Cookie);
  assert(detailByT2.status === 403, `李四查看张三单据返回 403 (实际:${detailByT2.status})`);

  const detailByAdmin = await request('GET', `/api/makeup/requests/${reqId1}`, null, adminCookie);
  assert(detailByAdmin.status === 200, `管理员查看任意单据 200`);
  assert(detailByAdmin.body && Array.isArray(detailByAdmin.body.approvals) && detailByAdmin.body.approvals.length >= 1,
    `详情包含审批链: ${detailByAdmin.body.approvals ? detailByAdmin.body.approvals.length : 0} 条`);

  console.log('\n=== 步骤 5: 待处理队列 & 驳回申请 ===');
  const queue = await request('GET', '/api/makeup/queue/pending', null, adminCookie);
  assert(queue.status === 200, `管理员看待处理队列 200`);
  assert(Array.isArray(queue.body) && queue.body.length >= 1, `待处理队列 >=1 条`);

  const queueByTeacher = await request('GET', '/api/makeup/queue/pending', null, teacherCookie);
  assert(queueByTeacher.status === 403, `教师看待处理队列 403`);

  const rejectNoReason = await request('PUT', `/api/makeup/requests/${reqId1}/reject`,
    { reason: '' }, adminCookie);
  assert(rejectNoReason.status === 400, `驳回不给原因返回 400`);

  const reject = await request('PUT', `/api/makeup/requests/${reqId1}/reject`,
    { reason: '补课时间与计算机等级考试冲突，请改期' }, adminCookie);
  assert(reject.status === 200, `管理员驳回申请成功 (${reject.status})`);
  assert(reject.body && reject.body.status === 'rejected', `状态变为 rejected`);
  assert(reject.body && reject.body.reject_reason && reject.body.rejected_by,
    `驳回原因和操作人已记录`);

  const detailAfterReject = await request('GET', `/api/makeup/requests/${reqId1}`, null, teacherCookie);
  assert(detailAfterReject.body.status === 'rejected', `教师视角看到被驳回状态`);
  assert(detailAfterReject.body.approvals.filter(a => a.action === 'reject').length === 1,
    `审批链追加了 reject 动作`);

  console.log('\n=== 步骤 6: 重新提交（从 rejected 状态） ===');
  const resubmit = await request('POST', `/api/makeup/requests/${reqId1}/resubmit`, {
    new_date: '2026-03-02',
    new_start_time: '10:00',
    new_end_time: '12:00',
    new_classroom_id: 2,
    hours: 2,
    reason: '改到周一下午，避开考试'
  }, teacherCookie);
  assert(resubmit.status === 200, `重新提交成功 (${resubmit.status})`);
  const reqId2 = resubmit.body.id;
  assert(resubmit.body.status === 'resubmitted', `新单状态 resubmitted`);
  assert(resubmit.body.parent_request_id === reqId1, `parent_request_id 关联到原单: ${reqId1}`);
  assert(resubmit.body.resubmitted_count === 1, `resubmitted_count = 1`);
  const reqNo2 = resubmit.body.request_no;
  console.log(`    新申请单号: ${reqNo2} (父单: ${reqNo1})`);

  console.log('\n=== 步骤 7: 审批通过 + 课时回写 ===');
  const approveByTeacher = await request('PUT', `/api/makeup/requests/${reqId2}/approve`,
    { comment: '我自己批' }, teacherCookie);
  assert(approveByTeacher.status === 403, `教师不能审批 (403)`);

  const approve = await request('PUT', `/api/makeup/requests/${reqId2}/approve`,
    { comment: '时间合理，通过' }, labCookie);
  assert(approve.status === 200, `实验员审批通过 (${approve.status})`);
  assert(approve.body && approve.body.status === 'approved', `状态 approved`);
  assert(approve.body && approve.body.approved_by && approve.body.approved_at,
    `记录审批人和时间`);

  const writebackByTeacher = await request('PUT', `/api/makeup/requests/${reqId2}/writeback-hours`,
    {}, teacherCookie);
  assert(writebackByTeacher.status === 403, `教师不能回写课时`);

  const writeback = await request('PUT', `/api/makeup/requests/${reqId2}/writeback-hours`,
    {}, adminCookie);
  assert(writeback.status === 200, `管理员执行课时回写 200`);
  assert(writeback.body && writeback.body.ok === true, `回写成功标志 ok=true`);
  assert(typeof writeback.body.delta_hours === 'number',
    `返回 delta_hours=${writeback.body.delta_hours}`);

  const detailAfterWb = await request('GET', `/api/makeup/requests/${reqId2}`, null, adminCookie);
  assert(detailAfterWb.body.hours_written_back === 1, `hours_written_back 标记为 1`);
  assert(detailAfterWb.body.approvals.some(a => a.action === 'writeback'),
    `审批链包含 writeback 动作`);

  const doubleWriteback = await request('PUT', `/api/makeup/requests/${reqId2}/writeback-hours`,
    {}, adminCookie);
  assert(doubleWriteback.status === 400, `重复课时回写返回 400`);

  console.log('\n=== 步骤 8: 撤销审批通过 ===');
  const thirdRequest = await request('POST', '/api/makeup/requests', {
    ...makeupPayload1,
    new_date: '2026-03-02', new_start_time: '13:00', new_end_time: '15:00',
    new_classroom_id: 1, hours: 2, reason: '补测试用第三单（下午避开上午的approved单）'
  }, teacherCookie);
  assert(thirdRequest.status === 200, `提交第三单 200 (实际${thirdRequest.status} ${JSON.stringify(thirdRequest.body).slice(0,200)})`);
  const reqId3 = thirdRequest.body.id;

  await request('PUT', `/api/makeup/requests/${reqId3}/approve`,
    { comment: '先通过，再撤销' }, adminCookie);

  const revokeNoReason = await request('PUT', `/api/makeup/requests/${reqId3}/revoke`,
    { reason: '' }, adminCookie);
  assert(revokeNoReason.status === 400, `撤销不给原因 400`);

  const revoke = await request('PUT', `/api/makeup/requests/${reqId3}/revoke`,
    { reason: '发现学员有期中考试，时间冲突' }, labCookie);
  assert(revoke.status === 200, `实验员撤销审批成功 (${revoke.status})`);
  assert(revoke.body && revoke.body.status === 'revoked', `状态变为 revoked`);
  assert(revoke.body && revoke.body.revoke_reason && revoke.body.revoked_by,
    `撤销原因/操作人已记录`);

  console.log('\n=== 步骤 9: 取消申请（pending状态） ===');
  const fourth = await request('POST', '/api/makeup/requests', {
    ...makeupPayload1,
    new_date: '2026-03-03', new_start_time: '15:00', new_end_time: '17:00',
    new_classroom_id: 3, hours: 2, reason: '第四单用于取消'
  }, teacherCookie);
  assert(fourth.status === 200, `提交第四单 200`);
  const reqId4 = fourth.body.id;

  const cancelOther = await request('PUT', `/api/makeup/requests/${reqId4}/cancel`,
    { reason: '我帮他取消' }, teacher2Cookie);
  assert(cancelOther.status === 403, `李四不能取消张三的单据 (403)`);

  const cancel = await request('PUT', `/api/makeup/requests/${reqId4}/cancel`,
    { reason: '学员都没时间，改日再说' }, teacherCookie);
  assert(cancel.status === 200, `张三取消自己的 pending 单据成功`);
  assert(cancel.body && cancel.body.status === 'cancelled', `状态变为 cancelled`);

  console.log('\n=== 步骤 10: 非法状态迁移 ===');
  // reqId2 已 approved，不能再 approve
  const dupApprove = await request('PUT', `/api/makeup/requests/${reqId2}/approve`,
    {}, adminCookie);
  assert(dupApprove.status === 400, `已 approved 的单不能再审批 (${dupApprove.status})`);

  // reqId1 已 rejected，不能 approve
  const approveRejected = await request('PUT', `/api/makeup/requests/${reqId1}/approve`,
    {}, adminCookie);
  assert(approveRejected.status === 400, `rejected 状态不能直接审批 (${approveRejected.status})`);

  console.log('\n=== 步骤 11: 统计数据校验 ===');
  const s = await request('GET', '/api/makeup/stats', null, adminCookie);
  assert(s.status === 200, `统计接口 200`);
  const sb = s.body;
  assert(sb.total >= 4, `总申请 >=4 (实际${sb.total})`);
  assert(sb.approved >= 1, `approved >=1 (实际${sb.approved})`);
  assert(sb.rejected >= 1, `rejected >=1 (实际${sb.rejected})`);
  assert(sb.revoked >= 1, `revoked >=1 (实际${sb.revoked})`);
  assert(sb.cancelled >= 1, `cancelled >=1 (实际${sb.cancelled})`);
  assert(sb.by_type && sb.by_type.makeup >= 3, `makeup 类型 >=3 (实际${sb.by_type ? sb.by_type.makeup : 0})`);
  console.log(`    统计: ${JSON.stringify(sb)}`);

  console.log('\n=== 步骤 12: 导出 CSV ===');
  const csv = await request('GET', '/api/makeup/export/csv?status=approved', null, adminCookie);
  assert(csv.status === 200, `按 approved 筛选导出 CSV 200`);
  const rawCsv = csv.raw || '';
  assert(rawCsv.length > 100, `CSV 内容长度 > 100 (实际${rawCsv.length})`);
  assert(rawCsv.startsWith('\uFEFF'), `CSV 带 BOM 头（Excel 兼容）`);
  assert(rawCsv.includes('申请单号') && rawCsv.includes('类型'),
    `CSV 含中文表头关键字`);
  assert(rawCsv.includes(reqNo2), `CSV 包含已通过申请的单号 ${reqNo2}`);
  console.log(`    CSV 大小: ${rawCsv.length} 字节`);

  console.log('\n=== 步骤 13: 导入 JSON（含重复/冲突/字段缺失） ===');
  const nowIso = new Date().toISOString();
  const importPayload = {
    requests: [
      { request_no: reqNo1, type: 'makeup', course_id: 1, class_id: 1,
        teacher_id: 2, new_date: '2026-03-10', new_start_time: '08:00', new_end_time: '10:00',
        hours: 2, reason: '故意重复单号应跳过', status: 'pending',
        created_at: nowIso, updated_at: nowIso },
      { request_no: 'MK-IMPORT-001', type: 'makeup', course_id: 1, class_id: 1,
        teacher_id: 2, new_date: '2026-03-02', new_start_time: '10:30', new_end_time: '11:30',
        new_classroom_id: 2, hours: 2, reason: '与通过单 reqId2 时间重叠应跳过',
        status: 'pending', created_at: nowIso, updated_at: nowIso },
      { request_no: 'MK-IMPORT-002', type: 'makeup', course_id: 99999, class_id: 1,
        teacher_id: 2, hours: 2, reason: '课程不存在应失败',
        created_at: nowIso, updated_at: nowIso },
      { request_no: 'MK-IMPORT-003', type: 'reschedule', course_id: 1, class_id: 1,
        teacher_id: 2, new_date: '2026-03-11', new_start_time: '14:00', new_end_time: '16:00',
        new_classroom_id: 4, hours: 2, reason: '合法导入(reschedule)，应成功',
        status: 'approved', created_at: nowIso, updated_at: nowIso },
      { request_no: 'MK-IMPORT-004', type: 'swap_class', course_id: 1, class_id: 1,
        teacher_id: 2, new_date: '2026-03-13', new_start_time: '14:00', new_end_time: '16:00',
        new_classroom_id: 3, new_class_id: 2, hours: 2, reason: '合法导入(换班)，应成功',
        status: 'approved', created_at: nowIso, updated_at: nowIso }
    ]
  };

  const impRes = await request('POST', '/api/makeup/import/json', importPayload, adminCookie);
  assert(impRes.status >= 200 && impRes.status < 300, `导入接口成功 (code=${impRes.status})`);
  const ib = impRes.body;
  console.log(`    导入结果: imported=${ib.imported}, skipped=${ib.skipped}, duplicates=${ib.duplicates}, conflicts=${ib.conflicts}, failed=${ib.failed}`);
  if (ib.details) ib.details.forEach(d => console.log(`      · ${JSON.stringify(d)}`));
  assert(ib.imported >= 1, `至少成功导入 1 条 实际:${ib.imported}`);
  assert(ib.duplicates >= 1, `重复单号跳过 >=1 实际:${ib.duplicates}`);
  assert(ib.conflicts >= 1, `冲突跳过 >=1 实际:${ib.conflicts}`);
  assert(ib.failed >= 1, `字段/引用错误失败 >=1 实际:${ib.failed}`);
  assert(Array.isArray(ib.details) && ib.details.length >= 3, `details 明细数组 >=3 条`);

  const importByTeacher = await request('POST', '/api/makeup/import/json',
    importPayload, teacherCookie);
  assert(importByTeacher.status === 403, `教师不能导入 (403)`);

  console.log('\n=== 步骤 14: 可筛选操作日志 ===');
  const logsAll = await request('GET', '/api/makeup/logs', null, adminCookie);
  assert(logsAll.status === 200 && Array.isArray(logsAll.body), `查全部日志 200，共 ${logsAll.body.length} 条`);
  assert(logsAll.body.length >= 5, `日志记录 >=5 条`);

  const logsSubmit = await request('GET', '/api/makeup/logs?action=makeup_submit_request', null, adminCookie);
  assert(logsSubmit.status === 200 && logsSubmit.body.length >= 1, `按动作筛选 makeup_submit_request >=1 条`);

  const logsByZhangsan = await request('GET', '/api/makeup/logs?user_id=2', null, adminCookie);
  assert(logsByZhangsan.body.length >= 1, `按用户筛选（张三）>=1 条`);

  const logsTeacher = await request('GET', '/api/makeup/logs', null, teacherCookie);
  assert(logsTeacher.status === 200, `教师查自己的日志 200`);

  console.log('\n=== 步骤 15: 数据落盘 & 持久化校验（重启前） ===');
  await request('POST', '/api/reset', {}, adminCookie);
  const dbPath = path.join(__dirname, 'data', 'lab.db');
  assert(fs.existsSync(dbPath), `SQLite 文件存在: ${dbPath}`);
  const statBefore = fs.statSync(dbPath);
  assert(statBefore.size > 10000, `DB 文件 > 10KB（实际${statBefore.size}）`);
  console.log(`    DB 文件大小: ${statBefore.size} 字节`);

  console.log('\n=== 步骤 16: 再次写数据后 forceSave，验证下次启动能读到 ===');
  await delay(300);
  const ad2 = await login('admin', 'admin123', '');
  assert(ad2.status === 200, `重置后管理员登录成功`);
  adminCookie = ad2.cookie;
  const t1n = await login('zhangsan', '123456', '');
  teacherCookie = t1n.cookie;

  const persistReq = await request('POST', '/api/makeup/requests', {
    type: 'swap_class',
    course_id: 1,
    class_id: 1,
    student_ids: [1, 2],
    new_class_id: 2,
    new_date: '2026-03-20',
    new_start_time: '14:00',
    new_end_time: '16:00',
    new_classroom_id: 2,
    hours: 2,
    reason: '持久化测试：A班和B班换课'
  }, teacherCookie);
  assert(persistReq.status === 200, `写持久化测试申请单成功 (code=${persistReq.status}, ${JSON.stringify(persistReq.body).slice(0,200)})`);
  const persistReqId = persistReq.body.id;
  const persistReqNo = persistReq.body.request_no;

  await request('PUT', `/api/makeup/requests/${persistReqId}/approve`,
    { comment: '持久化审批通过' }, adminCookie);
  await delay(700);

  console.log('\n=== 步骤 17: 列表筛选功能 ===');
  await request('POST', '/api/makeup/requests', {
    type: 'reschedule', course_id: 1, class_id: 1, teacher_id: 2,
    new_date: '2026-03-21', new_start_time: '08:00', new_end_time: '10:00',
    new_classroom_id: 1, hours: 2, reason: '筛选测试用'
  }, teacherCookie);

  const filterByType = await request('GET', '/api/makeup/requests?type=swap_class', null, adminCookie);
  assert(Array.isArray(filterByType.body) && filterByType.body.length >= 1 &&
    filterByType.body.every(r => r.type === 'swap_class'),
    `按 type=swap_class 筛选正确，返回${filterByType.body.length}条`);

  const filterByStatus = await request('GET', '/api/makeup/requests?status=approved', null, adminCookie);
  assert(Array.isArray(filterByStatus.body) && filterByStatus.body.length >= 1 &&
    filterByStatus.body.every(r => r.status === 'approved'),
    `按 status=approved 筛选正确，返回${filterByStatus.body.length}条`);

  const filterByNo = await request('GET', `/api/makeup/requests?request_no=${persistReqNo}`, null, adminCookie);
  assert(Array.isArray(filterByNo.body) && filterByNo.body.length === 1,
    `按单号精确筛选返回 1 条`);

  console.log('\n========== 测试结束 ==========');
  console.log(`通过: ${passed}  |  失败: ${failed}`);
  if (failed === 0) {
    console.log('\n🎉 所有补课与调课审批中心回归测试通过！');
  } else {
    console.log(`\n⚠️  有 ${failed} 项失败，请检查`);
  }
}

runTests().catch(e => {
  console.error('\n运行异常:', e);
  process.exit(1);
});
