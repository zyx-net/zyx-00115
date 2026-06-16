const http = require('http');
const fs = require('fs');

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

async function main() {
  console.log('\n=== 重启后持久化核对 + 真冲突 409 不被弱化 ===\n');

  const snap = JSON.parse(fs.readFileSync('./persistence-snap.json', 'utf8'));
  console.log(`  重启前快照: ${snap.equipment.length} 器材 / ${snap.reservations.length} 预约 / ${snap.losses.length} 损耗 / ${snap.settlements.length} 结转`);

  let cookie = '';
  const admin = await request('POST', '/api/login', { username: 'admin', password: 'admin123' }, cookie);
  cookie = admin.cookie;
  assert(admin.status === 200, `管理员登录成功`);

  // 1. 器材持久化
  console.log('\n--- 器材持久化核对 ---');
  const eq = await request('GET', '/api/equipment', null, cookie);
  assert(eq.body.length === snap.equipment.length, `器材条数一致 (${eq.body.length})`);
  eq.body.forEach((e, i) => {
    const s = snap.equipment[i];
    assert(e.id === s.id && e.name === s.name, `${s.name} id/name 一致`);
    assert(e.total_qty === s.total, `${s.name} total=${e.total_qty} == ${s.total}`);
    assert(e.available_qty === s.avail, `${s.name} avail=${e.available_qty} == ${s.avail}`);
    assert(e.locked_qty === s.locked, `${s.name} locked=${e.locked_qty} == ${s.locked}`);
    assert(e.available_qty === e.total_qty - e.locked_qty, `${s.name} 显示口径 == 冲突检测口径`);
    assert(e.available_qty >= 0, `${s.name} 显示可用量 >= 0`);
  });

  // 2. 预约持久化
  console.log('\n--- 预约持久化核对 ---');
  const rsv = await request('GET', '/api/reservations', null, cookie);
  assert(rsv.body.length === snap.reservations.length, `预约条数一致 (${rsv.body.length})`);
  rsv.body.forEach((r, i) => {
    const s = snap.reservations[i];
    assert(r.id === s.id, `id=${r.id} id一致`);
    assert(r.status === s.status, `id=${r.id} status=${r.status} == ${s.status}`);
    assert(r.returned_qty === s.returned_qty, `id=${r.id} returned_qty=${r.returned_qty} == ${s.returned_qty}`);
  });

  // 3. 损耗持久化
  console.log('\n--- 损耗持久化核对 ---');
  const loss = await request('GET', '/api/loss-reports', null, cookie);
  assert(loss.body.length === snap.losses.length, `损耗条数一致 (${loss.body.length})`);
  loss.body.forEach((l, i) => {
    assert(l.id === snap.losses[i].id, `id=${l.id} id一致`);
    assert(l.status === snap.losses[i].status, `id=${l.id} status=${l.status} == ${snap.losses[i].status}`);
  });

  // 4. 结转持久化 + 导出一致性
  console.log('\n--- 结转持久化 + 导出核对 ---');
  const set = await request('GET', '/api/settlements', null, cookie);
  assert(set.body.length === snap.settlements.length, `结转条数一致 (${set.body.length})`);
  assert(set.body[0].week_key === '2026-W25', `最近结转是 2026-W25`);
  const t = set.body[0].totals;
  assert(t.pending_returns.length === 0, `待归还空数组，不会误结转`);
  assert(t.reservation_summary.by_status.returned === 1, `returned 计数 = 1`);
  assert(t.loss_summary.total_reports === 1 && t.loss_summary.total_qty === 1, `损耗汇总正确`);

  const exp = await request('GET', '/api/export/2026-W25', null, cookie);
  assert(exp.status === 200, `导出成功`);
  const e = typeof exp.body === 'string' ? JSON.parse(exp.body) : exp.body;
  const expTotals = e.totals || e;
  assert(JSON.stringify(expTotals.equipment_snapshot) === JSON.stringify(t.equipment_snapshot),
    `导出 snapshot == 结转 snapshot`);
  assert(JSON.stringify(expTotals.pending_returns) === JSON.stringify(t.pending_returns),
    `导出 pending_returns == 结转 pending_returns`);
  assert(JSON.stringify(expTotals.reservation_summary) === JSON.stringify(t.reservation_summary),
    `导出 reservation_summary == 结转 reservation_summary`);
  assert(JSON.stringify(expTotals.loss_summary) === JSON.stringify(t.loss_summary),
    `导出 loss_summary == 结转 loss_summary`);

  // 5. 真冲突 409 不被弱化
  console.log('\n--- 真冲突 409 验证（不会因为显示逻辑改动而放宽校验）---');
  // 显微镜当前 total=2, avail=1, locked=1 —— 最多可约 1 件
  const mic = eq.body.find(x => x.id === 4);
  console.log(`    显微镜当前: total=${mic.total_qty}, avail=${mic.available_qty}, locked=${mic.locked_qty}`);
  const bad = await request('POST', '/api/reservations', {
    course_id: 1, class_id: 1, equipment_id: 4, qty: 2, week_key: '2026-W26'
  }, cookie);
  assert(bad.status === 409, `约 2 件应 409，真冲突不能放行 (实际 ${bad.status})`);
  assert(bad.body.available === 1, `冲突响应里 available = 1 (不是负数)`);
  assert(bad.body.available === mic.total_qty - mic.locked_qty,
    `冲突响应里 available 口径 = total - locked (${mic.total_qty - mic.locked_qty})`);
  const good = await request('POST', '/api/reservations', {
    course_id: 1, class_id: 1, equipment_id: 4, qty: 1, week_key: '2026-W26'
  }, cookie);
  assert(good.status === 200, `约 1 件应成功，没冲突不能误判 (实际 ${good.status})`);

  // 6. 操作日志持久化
  console.log('\n--- 日志持久化核对 ---');
  const logs = await request('GET', '/api/logs', null, cookie);
  const actions = logs.body.map(l => l.action);
  ['login', 'create_reservation', 'approve_reservation', 'collect_equipment',
   'return_equipment', 'submit_loss_report', 'approve_loss_report',
   'resolution_update_status_to_returned', 'weekly_settlement'].forEach(a => {
    assert(actions.includes(a), `日志包含 ${a}`);
  });

  console.log(`\n=== 重启后核对结果: ${passed} 通过, ${failed} 失败 ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
