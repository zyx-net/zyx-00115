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
  const r = await request('POST', '/api/login', { username: u, password: p }, cookie);
  return r;
}

function printMic(e, tag) {
  const rem = e.total_qty - e.locked_qty;
  console.log(`    [${tag}] 显微镜: total=${e.total_qty}, avail=${e.available_qty}, locked=${e.locked_qty}, total-locked=${rem} => 显示口径=${e.available_qty}`);
  return { e, rem };
}

async function runReadmeDemo() {
  console.log('\n=== README 主流程端到端核对 ===\n');

  // 重置
  let c1 = '', c2 = '', c3 = '';
  await request('POST', '/api/reset', {}, '');
  console.log('  数据已重置\n');

  // ======== 步骤 1: 张三预约显微镜 2 件 ========
  console.log('--- 步骤 1: 张三预约显微镜 2 件 ---');
  const zs = await login('zhangsan', '123456', '');
  c1 = zs.cookie;

  const eqBefore = await request('GET', '/api/equipment', null, c1);
  const mBefore = eqBefore.body.find(e => e.id === 4);
  printMic(mBefore, '预约前');
  assert(mBefore.available_qty === 3, `预约前可用=3 (实际 ${mBefore.available_qty})`);

  const r1 = await request('POST', '/api/reservations', {
    course_id: 1, class_id: 1, equipment_id: 4, qty: 2, week_key: '2026-W25'
  }, c1);
  assert(r1.status === 200, `预约成功 (${r1.status})`);
  const resId = r1.body.id;

  const eq1 = await request('GET', '/api/equipment', null, c1);
  const m1 = eq1.body.find(e => e.id === 4);
  const { rem: rem1 } = printMic(m1, '张三锁2件后');
  assert(m1.available_qty === 1, `锁 2 件后 available=1 (实际 ${m1.available_qty})`);
  assert(m1.available_qty === rem1, `显示口径 available_qty == 冲突检测口径 total-locked`);
  assert(m1.available_qty >= 0, `显示可用量不会是负数 (实际 ${m1.available_qty})`);

  // ======== 失败路径 1: 李四约 2 件应 409，约 1 件应成功 ========
  console.log('\n--- 失败路径 1: 李四尝试抢低库存 ---');
  const ls = await login('lisi', '123456', '');
  c2 = ls.cookie;

  const fail1 = await request('POST', '/api/reservations', {
    course_id: 2, class_id: 3, equipment_id: 4, qty: 2, week_key: '2026-W25'
  }, c2);
  assert(fail1.status === 409, `李四约 2 件真冲突应 409 (实际 ${fail1.status})`);
  assert(fail1.body.available === 1, `冲突响应里可用=1 (实际 ${fail1.body.available})`);
  assert(fail1.body.available >= 0, `冲突响应里可用也不是负数`);

  const ok1 = await request('POST', '/api/reservations', {
    course_id: 2, class_id: 3, equipment_id: 4, qty: 1, week_key: '2026-W25'
  }, c2);
  assert(ok1.status === 200, `李四约 1 件应成功，不应被误判冲突 (实际 ${ok1.status})`);

  const eq2 = await request('GET', '/api/equipment', null, c2);
  const m2 = eq2.body.find(e => e.id === 4);
  const { rem: rem2 } = printMic(m2, '李四再锁1件后');
  assert(m2.available_qty === 0, `锁 3 件后可用=0 (实际 ${m2.available_qty})`);
  assert(m2.available_qty === rem2, `显示口径 == 冲突检测口径`);
  assert(m2.available_qty >= 0, `显示可用量不会是负数 (实际 ${m2.available_qty})`);
  eq2.body.forEach(e => {
    assert(e.available_qty === e.total_qty - e.locked_qty,
      `${e.name} 显示口径(${e.available_qty}) == 冲突检测口径(${e.total_qty - e.locked_qty})`);
    assert(e.available_qty >= 0, `${e.name} 显示可用量 >= 0`);
  });

  // ======== 步骤 2: 王五审批 ========
  console.log('\n--- 步骤 2: 王五审批张三的预约 ---');
  const ww = await login('wangwu', '123456', '');
  c3 = ww.cookie;
  const ap = await request('PUT', `/api/reservations/${resId}/approve`, {}, c3);
  assert(ap.status === 200, `审批通过 (${ap.status})`);
  assert(ap.body.status === 'approved', `状态为 approved`);

  // ======== 步骤 3: 张三领用 ========
  console.log('\n--- 步骤 3: 张三领用 ---');
  const co = await request('PUT', `/api/reservations/${resId}/collect`, {}, c1);
  assert(co.status === 200, `领用成功 (${co.status})`);
  assert(co.body.status === 'collected', `状态为 collected`);

  // ======== 步骤 4: 张三归还 1 件 ========
  console.log('\n--- 步骤 4: 张三归还 1 件 ---');
  const rt = await request('PUT', `/api/reservations/${resId}/return`, { return_qty: 1 }, c1);
  assert(rt.status === 200, `归还成功 (${rt.status})`);
  assert(rt.body.status === 'partially_returned', `状态为 partially_returned`);
  assert(rt.body.returned_qty === 1, `returned_qty = 1`);

  const eq3 = await request('GET', '/api/equipment', null, c1);
  const m3 = eq3.body.find(e => e.id === 4);
  printMic(m3, '归还1件后');
  assert(m3.available_qty === 1, `归还 1 件后可用=1 (实际 ${m3.available_qty})`);

  // ======== 步骤 5: 张三申报损耗 1 件 ========
  console.log('\n--- 步骤 5: 张三申报损耗 1 件 ---');
  const lp = await request('POST', '/api/loss-reports', {
    reservation_id: resId, qty: 1, reason: '镜头摔碎'
  }, c1);
  assert(lp.status === 200, `损耗申报成功`);
  const lpId = lp.body.id;

  // ======== 步骤 6: 王五审批损耗 ========
  console.log('\n--- 步骤 6: 王五审批损耗 ---');
  const apLoss = await request('PUT', `/api/loss-reports/${lpId}/approve`, {}, c3);
  assert(apLoss.status === 200, `审批损耗通过 (${apLoss.status})`);
  assert(apLoss.body.status === 'approved', `损耗状态为 approved`);

  const eq4 = await request('GET', '/api/equipment', null, c3);
  const m4 = eq4.body.find(e => e.id === 4);
  printMic(m4, '审批损耗后');
  assert(m4.total_qty === 2, `总量扣减为 2 (实际 ${m4.total_qty})`);
  assert(m4.locked_qty === 1, `locked 扣减 1 为 1 (实际 ${m4.locked_qty}) —— 这是李四那个预约的锁定`);
  assert(m4.available_qty === 1, `可用 = 1 (实际 ${m4.available_qty})`);
  assert(m4.available_qty === m4.total_qty - m4.locked_qty, `显示口径 == 冲突检测口径`);

  // 检查 reservation 状态已自动升级为 returned
  const rsvAfter = await request('GET', '/api/reservations', null, c3);
  const myRsv = rsvAfter.body.find(r => r.id === resId);
  assert(myRsv.status === 'returned', `损耗审批后 reservation 状态应升级为 returned (实际 ${myRsv.status})`);
  assert(myRsv.returned_qty === 1, `returned_qty 保持 1 (实际 ${myRsv.returned_qty})`);

  // ======== 步骤 7: 王五执行周结转 ========
  console.log('\n--- 步骤 7: 执行周结转 2026-W25 ---');
  const set = await request('POST', '/api/settlements/weekly', { week_key: '2026-W25' }, c3);
  assert(set.status === 200, `结转成功 (${set.status})`);
  const t = set.body.totals;
  assert(Array.isArray(t.pending_returns) && t.pending_returns.length === 0,
    `待归还应是空数组，不能包含已结清的预约 (实际 ${JSON.stringify(t.pending_returns)})`);
  assert(t.reservation_summary.by_status.returned === 1,
    `预约汇总 returned 计数=1 (实际 ${JSON.stringify(t.reservation_summary)})`);
  assert(t.loss_summary.total_reports === 1 && t.loss_summary.total_qty === 1,
    `损耗汇总正确 (实际 ${JSON.stringify(t.loss_summary)})`);
  const micSnap = t.equipment_snapshot.find(e => e.name === '显微镜');
  assert(micSnap.total === 2 && micSnap.available === 1 && micSnap.locked === 1,
    `结转快照显微镜正确 (实际 ${JSON.stringify(micSnap)})`);

  // 导出一致性
  const exp = await request('GET', `/api/export/2026-W25`, null, c3);
  assert(exp.status === 200, `导出成功`);
  const e = typeof exp.body === 'string' ? JSON.parse(exp.body) : exp.body;
  const expTotals = e.totals || e;
  assert(JSON.stringify(expTotals.equipment_snapshot) === JSON.stringify(t.equipment_snapshot),
    `导出快照与结转快照一致`);
  assert(JSON.stringify(expTotals.pending_returns) === JSON.stringify(t.pending_returns),
    `导出待归还与结转待归还一致`);
  assert(JSON.stringify(expTotals.reservation_summary) === JSON.stringify(t.reservation_summary),
    `导出预约汇总与结转预约汇总一致`);
  assert(JSON.stringify(expTotals.loss_summary) === JSON.stringify(t.loss_summary),
    `导出损耗汇总与结转损耗汇总一致`);

  // 重复结转 409
  const dupSet = await request('POST', '/api/settlements/weekly', { week_key: '2026-W25' }, c3);
  assert(dupSet.status === 409, `重复结转返回 409 (实际 ${dupSet.status})`);

  // ======== 持久化快照 ========
  console.log('\n--- 持久化前快照 ---');
  const snap = {
    equipment: (await request('GET', '/api/equipment', null, c3)).body.map(e => ({
      id: e.id, name: e.name, total: e.total_qty, avail: e.available_qty, locked: e.locked_qty
    })),
    reservations: (await request('GET', '/api/reservations', null, c3)).body.map(r => ({
      id: r.id, status: r.status, returned_qty: r.returned_qty
    })),
    losses: (await request('GET', '/api/loss-reports', null, c3)).body.map(l => ({
      id: l.id, status: l.status
    })),
    settlements: (await request('GET', '/api/settlements', null, c3)).body.map(s => ({
      week: s.week_key
    }))
  };
  console.log(`  器材 ${snap.equipment.length} 条, 预约 ${snap.reservations.length} 条, 损耗 ${snap.losses.length} 条, 结转 ${snap.settlements.length} 条`);
  require('fs').writeFileSync('./persistence-snap.json', JSON.stringify(snap, null, 2));

  // ======== 日志齐全 ========
  const logs = await request('GET', '/api/logs', null, c3);
  const actions = logs.body.map(l => l.action);
  ['login', 'create_reservation', 'approve_reservation', 'collect_equipment',
   'return_equipment', 'submit_loss_report', 'approve_loss_report',
   'resolution_update_status_to_returned', 'weekly_settlement'].forEach(a => {
    assert(actions.includes(a), `日志包含 ${a}`);
  });

  console.log(`\n=== README 核对结果: ${passed} 通过, ${failed} 失败 ===`);
  return { snap, passed, failed };
}

runReadmeDemo().catch(e => { console.error(e); process.exit(1); });
