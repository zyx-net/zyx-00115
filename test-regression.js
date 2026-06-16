const http = require('http');

const BASE = 'http://localhost:3001';
let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
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
      (opts.body = b);
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
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function login(u, p, cookie) {
  const r = await request('POST', '/api/login', { username: u, password: p }, cookie);
  return r;
}

async function runTests() {
  console.log('\n=== 步骤 0: 重置数据 ===');
  let cookie = '';
  await request('POST', '/api/reset', {}, cookie);
  console.log('  数据已重置');

  console.log('\n=== Bug 1 回归: 库存冲突检测公式错误 ===');
  console.log('预期: 显微镜 3 件, 张三锁 2 件后, 李四还能约 1 件, 李四约 2 件才冲突');
  const zs = await login('zhangsan', '123456', '');
  cookie = zs.cookie;

  const r1 = await request('POST', '/api/reservations', {
    course_id: 1, class_id: 1, equipment_id: 4, qty: 2, week_key: '2026-W99'
  }, cookie);
  assert(r1.status === 200, `张三预约显微镜 2 件成功 (${r1.status})`);

  const eq1 = await request('GET', '/api/equipment', null, cookie);
  const mic1 = eq1.body.find(e => e.id === 4);
  assert(mic1.total_qty === 3, `显微镜总量仍为 3 (实际: ${mic1.total_qty})`);
  assert(mic1.locked_qty === 2, `显微镜锁定量为 2 (实际: ${mic1.locked_qty})`);
  assert(mic1.available_qty === 1, `显微镜可用量为 1 (实际: ${mic1.available_qty})`);
  const checkVal = mic1.total_qty - mic1.locked_qty;
  assert(checkVal >= 0, `total - locked = ${checkVal} 不应为负`);
  assert(checkVal === 1, `total - locked = 1, 可再约 1 件 (实际: ${checkVal})`);

  const ls = await login('lisi', '123456', '');
  cookie = ls.cookie;

  const r2 = await request('POST', '/api/reservations', {
    course_id: 2, class_id: 3, equipment_id: 4, qty: 1, week_key: '2026-W99'
  }, cookie);
  assert(r2.status === 200, `李四再约显微镜 1 件应成功 (实际: ${r2.status} ${JSON.stringify(r2.body)})`);

  const r3 = await request('POST', '/api/reservations', {
    course_id: 2, class_id: 3, equipment_id: 4, qty: 2, week_key: '2026-W99'
  }, cookie);
  assert(r3.status === 409, `李四再约显微镜 2 件应返回 409 (实际: ${r3.status})`);

  const eq2 = await request('GET', '/api/equipment', null, cookie);
  const mic2 = eq2.body.find(e => e.id === 4);
  assert(mic2.locked_qty === 3, `显微镜锁定量应为 3 (2+1, 实际: ${mic2.locked_qty})`);
  assert(mic2.available_qty === 0, `显微镜可用量应为 0 (实际: ${mic2.available_qty})`);
  assert(mic2.available_qty >= 0, `显微镜可用量不应为负 (实际: ${mic2.available_qty})`);

  console.log('\n=== Bug 2 回归: 归还 1 件 + 审批损耗 1 件后状态对齐 ===');
  console.log('预期: 预约量 2, 归还 1 + 损耗 1 = 2 全量结清, 状态 returned, 无待归还');
  // 重置后做主流程
  await request('POST', '/api/reset', {}, '');
  const admin = await login('admin', 'admin123', '');
  cookie = admin.cookie;

  // 预约 2
  const res1 = await request('POST', '/api/reservations', {
    course_id: 3, class_id: 2, equipment_id: 2, qty: 2, week_key: '2026-W77'
  }, cookie);
  assert(res1.status === 200, `管理员预约万用表 2 件成功`);
  const resId = res1.body.id;

  // 审批
  const ap1 = await request('PUT', `/api/reservations/${resId}/approve`, {}, cookie);
  assert(ap1.status === 200, `审批通过`);

  // 领用
  const co1 = await request('PUT', `/api/reservations/${resId}/collect`, {}, cookie);
  assert(co1.status === 200, `领用成功`);

  // 归还 1
  const rt1 = await request('PUT', `/api/reservations/${resId}/return`, { return_qty: 1 }, cookie);
  assert(rt1.status === 200, `归还 1 件成功`);
  assert(rt1.body.status === 'partially_returned', `状态为 partially_returned (实际: ${rt1.body.status})`);
  if (rt1.body.returned_qty !== undefined) {
    assert(rt1.body.returned_qty === 1, `returned_qty = 1 (实际: ${rt1.body.returned_qty})`);
  }

  // 提交损耗 1
  const lp1 = await request('POST', '/api/loss-reports', {
    reservation_id: resId, qty: 1, reason: '测试损耗 1 件'
  }, cookie);
  assert(lp1.status === 200, `提交损耗成功`);
  const lpId = lp1.body.id;

  // 以 wangwu 审批（避免自我审批）
  const ww = await login('wangwu', '123456', '');
  cookie = ww.cookie;

  const la1 = await request('PUT', `/api/loss-reports/${lpId}/approve`, {}, cookie);
  assert(la1.status === 200, `审批损耗成功 (${la1.status})`);

  // 检查预约状态
  const ress = await request('GET', '/api/reservations', null, cookie);
  const target = ress.body.find(r => r.id === resId);
  assert(target.status === 'returned', `损耗审批后预约应为 returned (实际: ${target.status})`);

  // 检查库存
  const eq3 = await request('GET', '/api/equipment', null, cookie);
  const mm = eq3.body.find(e => e.id === 2);
  assert(mm.total_qty === 4, `万用表总量应为 4 (5-1损耗, 实际: ${mm.total_qty})`);
  assert(mm.locked_qty === 0, `万用表锁定应为 0 (实际: ${mm.locked_qty})`);
  assert(mm.available_qty === 4, `万用表可用应为 4 (实际: ${mm.available_qty})`);
  assert(mm.available_qty + mm.locked_qty === mm.total_qty,
    `恒等式 available + locked = total 成立 (${mm.available_qty}+${mm.locked_qty}=${mm.available_qty+mm.locked_qty}, total=${mm.total_qty})`);

  // 做周结转
  const st1 = await request('POST', '/api/settlements/weekly', { week_key: '2026-W77' }, cookie);
  assert(st1.status === 200, `周结转成功`);
  const totals = st1.body.totals;
  const snap = totals.equipment_snapshot.find(e => e.id === 2);
  assert(snap.total === mm.total_qty, `结转快照总量 = ${mm.total_qty} (实际: ${snap.total})`);
  assert(snap.locked === mm.locked_qty, `结转快照锁定 = ${mm.locked_qty} (实际: ${snap.locked})`);
  assert(snap.available === mm.available_qty, `结转快照可用 = ${mm.available_qty} (实际: ${snap.available})`);
  assert(totals.pending_returns.length === 0,
    `待归还是空 (实际: ${JSON.stringify(totals.pending_returns)})`);
  assert(totals.reservation_summary.by_status.returned === 1,
    `预约汇总 returned 应为 1 (实际: ${JSON.stringify(totals.reservation_summary.by_status)})`);
  assert(totals.loss_summary.total_reports === 1,
    `损耗汇总条数 1 (实际: ${totals.loss_summary.total_reports})`);
  assert(totals.loss_summary.total_qty === 1,
    `损耗汇总数量 1 (实际: ${totals.loss_summary.total_qty})`);

  // 重复结转
  const st2 = await request('POST', '/api/settlements/weekly', { week_key: '2026-W77' }, cookie);
  assert(st2.status === 409, `重复结转返回 409 (实际: ${st2.status})`);

  // 导出
  const exp = await request('GET', `/api/export/2026-W77`, null, cookie);
  assert(exp.status === 200, `导出成功`);
  const expTotals = exp.body.totals;
  assert(JSON.stringify(expTotals.equipment_snapshot) === JSON.stringify(totals.equipment_snapshot),
    `导出快照与结转快照一致`);
  assert(JSON.stringify(expTotals.pending_returns) === JSON.stringify(totals.pending_returns),
    `导出待归还与结转待归还一致`);
  assert(JSON.stringify(expTotals.loss_summary) === JSON.stringify(totals.loss_summary),
    `导出损耗与结转损耗一致`);
  assert(JSON.stringify(expTotals.reservation_summary) === JSON.stringify(totals.reservation_summary),
    `导出预约与结转预约一致`);

  // 重启持久化验证 (模拟 - 读取当前数据, 等重启后再核对)
  console.log('\n=== 持久化前置检查 ===');
  const beforeEq = await request('GET', '/api/equipment', null, cookie);
  const beforeRes = await request('GET', '/api/reservations', null, cookie);
  const beforeLoss = await request('GET', '/api/loss-reports', null, cookie);
  const beforeSet = await request('GET', '/api/settlements', null, cookie);
  console.log(`  持久化快照已采集: ${beforeEq.body.length} 器材 / ${beforeRes.body.length} 预约 / ${beforeLoss.body.length} 损耗 / ${beforeSet.body.length} 结转`);
  console.log('  (请重启服务器后调用 --verify-persistence 核对)');

  // 操作日志
  const logs = await request('GET', '/api/logs', null, cookie);
  const actionTypes = [...new Set(logs.body.map(l => l.action))];
  const required = ['login', 'create_reservation', 'approve_reservation', 'collect_equipment',
    'return_equipment', 'submit_loss_report', 'approve_loss_report', 'weekly_settlement'];
  for (const a of required) {
    assert(actionTypes.includes(a), `日志包含 ${a}`);
  }

  console.log(`\n=== 汇总: ${passed} 通过, ${failed} 失败 ===\n`);
}

runTests().catch(e => {
  console.error('测试执行失败:', e.message);
  process.exit(1);
});
