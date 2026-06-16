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

async function main() {
  console.log('\n=== 重启后 - 差异对比+说明留痕 状态一致性核对 ===\n');

  const snapPath = './settlement-diff-snap.json';
  if (!fs.existsSync(snapPath)) {
    console.error('  找不到 settlement-diff-snap.json，请先运行 test-settlement-diff.js 并在重启前准备数据');
    process.exit(1);
  }
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  console.log(`  重启前快照: ${snap.equipment.length} 器材 / ${snap.settlements.length} 结转 / 说明: ${snap.settlements[0] ? snap.settlements[0].notes_count : 0} 条`);

  let adminCookie = '';
  let teacherCookie = '';
  let labCookie = '';
  adminCookie = await login('admin', 'admin123', adminCookie);
  teacherCookie = await login('zhangsan', '123456', teacherCookie);
  labCookie = await login('wangwu', '123456', labCookie);

  console.log('\n--- 1. 器材持久化核对 ---');
  const eq = await request('GET', '/api/equipment', null, adminCookie);
  eq.body.forEach((e, i) => {
    const s = snap.equipment[i];
    assert(e.id === s.id, `${s.name} id 一致`);
    assert(e.total_qty === s.total, `${s.name} total 一致`);
    assert(e.available_qty === s.avail, `${s.name} avail 一致`);
    assert(e.locked_qty === s.locked, `${s.name} locked 一致`);
  });

  console.log('\n--- 2. 结转+说明持久化核对 ---');
  const set = await request('GET', '/api/settlements', null, adminCookie);
  assert(set.body.length === snap.settlements.length,
    `结转条数一致 (${set.body.length} vs ${snap.settlements.length})`);
  set.body.forEach((s, i) => {
    const expected = snap.settlements[i];
    assert(s.week_key === expected.week_key, `结转[${i}] week_key = ${expected.week_key}`);
    assert(s.source === expected.source, `结转[${i}] source = ${expected.source}`);
    assert(s.is_latest_settled === expected.is_latest_settled, `结转[${i}] is_latest_settled = ${expected.is_latest_settled}`);
    assert(s.totals.equipment_snapshot.length === expected.equipment_snapshot_count, `结转[${i}] 快照器材数 = ${expected.equipment_snapshot_count}`);
    assert(s.totals.reservation_summary.total === expected.reservation_total, `结转[${i}] 预约总数 = ${expected.reservation_total}`);
    const notes_count = s.notes ? s.notes.length : 0;
    assert(notes_count === expected.notes_count, `结转[${i}] 说明条数一致 (${notes_count} vs ${expected.notes_count})`);
    expected.notes_content.forEach((en, ni) => {
      const an = s.notes[ni];
      assert(an && an.id === en.id, `说明[${ni}] id 一致`);
      assert(an.content === en.content, `说明[${ni}] 内容一致`);
      assert(an.updated_at === en.updated_at, `说明[${ni}] updated_at 一致`);
      assert(an.created_by_name === en.created_by_name, `说明[${ni}] 创建人名字一致`);
    });
  });

  console.log('\n--- 3. latest-info 持久化核对 ---');
  const latestInfo = await request('GET', '/api/settlements/latest-info', null, adminCookie);
  assert(latestInfo.body.has_latest === snap.latestInfo.has_latest, 'has_latest 一致');

  console.log('\n--- 4. 权限拦截重启后一致 ---');
  const teacherAddNote = await request('POST', `/api/settlements/${set.body[0].id}/notes`, { content: '教师重启后加说明' }, teacherCookie);
  assert(teacherAddNote.status === 403, `重启后教师添加说明仍被拦截 (403, 实际: ${teacherAddNote.status})`);
  const teacherExport = await request('POST', '/api/settlements/compare/export-csv', {
    settlement_a_id: 1, settlement_b_id: 2
  }, teacherCookie, false);
  assert(teacherExport.status === 403, `重启后教师导出 CSV 仍被拦截`);

  console.log('\n--- 5. 对比+CSV导出重启后一致 ---');
  if (set.body.length >= 2) {
    const idA = set.body[0].id;
    const idB = set.body[1].id;
    const diffRestart = await request('POST', '/api/settlements/compare', {
      settlement_a_id: idA, settlement_b_id: idB
    }, labCookie);
    assert(diffRestart.status === 200, '重启后对比请求仍有效');
    assert(typeof diffRestart.body.diff, '重启后返回 diff 结构');

    const csvRestart = await request('POST', '/api/settlements/compare/export-csv', {
      settlement_a_id: idA, settlement_b_id: idB
    }, labCookie, false);
    assert(csvRestart.status === 200, '重启后 CSV 导出仍有效 (200)');
    const csv = csvRestart.body;
    assert(csv.startsWith('\uFEFF'), 'CSV BOM 依旧');
    assert(csv.includes('类别,变化类型'), 'CSV 表头完整');

    console.log('\n--- 6. 撤销收口重启后生效 ---');
    const targetLatest = await request('GET', '/api/settlements/latest-info', null, adminCookie);
    if (targetLatest.body.has_latest) {
      const lc = targetLatest.body.week_key;
      const addNoteBefore = (await request('GET', '/api/settlements', null, adminCookie)).body.find(s => s.week_key === lc);
      const note = await request('POST', `/api/settlements/${addNoteBefore.id}/notes`, {
        content: '重启后为最新周次添加临时说明'
      }, labCookie);
      assert(note.status === 201, '重启后给最新周次加说明成功');
      const rev = await request('DELETE', `/api/settlements/${lc}/revoke`, null, labCookie);
      assert(rev.status === 200, `重启后撤销最新 ${lc} 成功`);
      assert(typeof rev.body.cleaned, '撤销返回 cleaned 统计');
      assert(rev.body.cleaned.notes >= 1, `撤销时清理说明数正确`);
      const revs = await request('POST', '/api/settlements', null, adminCookie);
      assert(!revs.body.find(s => s.week_key === lc), `撤销后 ${lc} 在列表中消失`);
    }
  }

  console.log('\n--- 7. 日志持久化核对 ---');
  const logs = await request('GET', '/api/logs', null, adminCookie);
  const actions = [...new Set(logs.body.map(l => l.action))];
  const requiredPersist = [
    'add_settlement_note', 'update_settlement_note', 'delete_settlement_note',
    'compare_settlements', 'export_settlement_diff_csv'
  ];
  requiredPersist.forEach(a => {
    assert(actions.includes(a), `重启后日志保留 ${a}`);
  });

  console.log(`\n=== 重启核对结果: ${passed} 通过, ${failed} 失败 ===`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
