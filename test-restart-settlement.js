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
  console.log('\n=== 重启后结转状态核对 ===\n');

  const snap = JSON.parse(fs.readFileSync('./settlement-snap.json', 'utf8'));
  console.log(`  重启前快照: ${snap.equipment.length} 器材 / ${snap.reservations.length} 预约 / ${snap.losses.length} 损耗 / ${snap.settlements.length} 结转`);

  let cookie = '';
  const admin = await request('POST', '/api/login', { username: 'admin', password: 'admin123' }, cookie);
  cookie = admin.cookie;
  assert(admin.status === 200, '管理员登录成功');

  console.log('\n--- 器材持久化核对 ---');
  const eq = await request('GET', '/api/equipment', null, cookie);
  eq.body.forEach((e, i) => {
    const s = snap.equipment[i];
    assert(e.id === s.id, `${s.name} id 一致`);
    assert(e.total_qty === s.total, `${s.name} total 一致 (${e.total_qty})`);
    assert(e.available_qty === s.avail, `${s.name} avail 一致 (${e.available_qty})`);
    assert(e.locked_qty === s.locked, `${s.name} locked 一致 (${e.locked_qty})`);
  });

  console.log('\n--- 结转持久化核对 ---');
  const set = await request('GET', '/api/settlements', null, cookie);
  assert(set.body.length === snap.settlements.length,
    `结转条数一致 (${set.body.length} vs ${snap.settlements.length})`);
  set.body.forEach((s, i) => {
    const expected = snap.settlements[i];
    assert(s.week_key === expected.week_key, `结转[${i}] week_key = ${expected.week_key}`);
    assert(s.source === expected.source, `结转[${i}] source = ${expected.source}`);
    assert(s.is_latest_settled === expected.is_latest_settled,
      `结转[${i}] is_latest_settled = ${expected.is_latest_settled}`);
    assert(s.totals.equipment_snapshot.length === expected.equipment_snapshot_count,
      `结转[${i}] 快照器材数 = ${expected.equipment_snapshot_count}`);
    assert(s.totals.reservation_summary.total === expected.reservation_total,
      `结转[${i}] 预约总数 = ${expected.reservation_total}`);
  });

  console.log('\n--- latest-info 持久化核对 ---');
  const latestInfo = await request('GET', '/api/settlements/latest-info', null, cookie);
  assert(latestInfo.body.has_latest === snap.latestInfo.has_latest, 'has_latest 一致');
  if (snap.latestInfo.has_latest) {
    assert(latestInfo.body.week_key === snap.latestInfo.week_key,
      `最新周次一致: ${latestInfo.body.week_key}`);
  }

  console.log('\n--- 撤销行为重启后保持 ---');
  const revokeOld = await request('DELETE', '/api/settlements/2026-W89/revoke', null, cookie);
  assert(revokeOld.status === 404, '重启后撤销已撤销的 W89 仍返回 404');

  console.log('\n--- 日志持久化核对 ---');
  const logs = await request('GET', '/api/logs', null, cookie);
  const actions = [...new Set(logs.body.map(l => l.action))];
  snap.logActions.forEach(a => {
    assert(actions.includes(a), `日志包含 ${a}`);
  });
  assert(actions.includes('revoke_weekly_settlement'), '日志包含 revoke_weekly_settlement');
  assert(actions.includes('import_weekly_settlement'), '日志包含 import_weekly_settlement');

  console.log('\n--- 撤销+重新结转链路验证 ---');
  const latestSet = await request('GET', '/api/settlements/latest-info', null, cookie);
  if (latestSet.body.has_latest) {
    const revokeLatest = await request('DELETE', `/api/settlements/${latestSet.body.week_key}/revoke`, null, cookie);
    assert(revokeLatest.status === 200, `重启后撤销最新 ${latestSet.body.week_key} 成功`);
    const reSettle = await request('POST', '/api/settlements/weekly', { week_key: latestSet.body.week_key }, cookie);
    assert(reSettle.status === 200, `撤销后重新结转 ${latestSet.body.week_key} 成功`);
  }

  console.log(`\n=== 重启后核对结果: ${passed} 通过, ${failed} 失败 ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
