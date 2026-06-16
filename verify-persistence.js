const http = require('http');
const base = { hostname: 'localhost', port: 3001, method: 'GET', headers: { 'Cookie': '' } };

function req(method, path, cookieJar, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: 'localhost', port: 3001, path, method,
      headers: {
        'Cookie': Object.entries(cookieJar).map(([k,v]) => `${k}=${v}`).join('; '),
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        (res.headers['set-cookie'] || []).forEach(c => {
          const m = c.match(/^([^=]+)=([^;]+)/);
          if (m) cookieJar[m[1]] = m[2];
        });
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const cj1 = {};
  let r = await req('POST', '/api/login', cj1, { username: 'admin', password: 'admin123' });
  console.log('login admin', r.status);

  r = await req('GET', '/api/equipment', cj1);
  console.log('\n=== 器材持久化 ===');
  r.body.forEach(e => console.log(`  ${e.name}: total=${e.total_qty}, avail=${e.available_qty}, locked=${e.locked_qty}  (不变式: ${e.total_qty === e.available_qty + e.locked_qty ? 'OK' : 'FAIL'})`));

  r = await req('GET', '/api/reservations', cj1);
  console.log('\n=== 预约持久化 ===');
  r.body.forEach(x => console.log(`  id=${x.id} ${x.equipment_name} qty=${x.qty} returned_qty=${x.returned_qty} status=${x.status}`));

  r = await req('GET', '/api/loss-reports', cj1);
  console.log('\n=== 损耗持久化 ===');
  r.body.forEach(x => console.log(`  id=${x.id} rsv=${x.reservation_id} qty=${x.qty} status=${x.status}`));

  r = await req('GET', '/api/settlements', cj1);
  console.log('\n=== 周结转持久化 ===');
  r.body.forEach(s => {
    const t = typeof s.totals === 'string' ? JSON.parse(s.totals) : s.totals;
    console.log(`  week=${s.week_key} at=${s.settled_at}`);
    console.log(`    pending_returns=${JSON.stringify(t.pending_returns)}`);
    console.log(`    reservation_summary=${JSON.stringify(t.reservation_summary)}`);
    console.log(`    loss_summary=${JSON.stringify(t.loss_summary)}`);
    console.log(`    equipment_snapshot[万用表]=${JSON.stringify(t.equipment_snapshot.find(x=>x.name==='万用表'))}`);
    console.log(`    equipment_snapshot[显微镜]=${JSON.stringify(t.equipment_snapshot.find(x=>x.name==='显微镜'))}`);
  });

  const last = r.body[r.body.length - 1];
  if (last) {
    r = await req('GET', `/api/export/${last.week_key}`, cj1);
    const e = typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
    const t = typeof last.totals === 'string' ? JSON.parse(last.totals) : last.totals;
    console.log('\n=== 导出和结转快照一致性 ===');
    console.log(`  万用表快照对齐: ${JSON.stringify(e.equipment_snapshot.find(x=>x.name==='万用表')) === JSON.stringify(t.equipment_snapshot.find(x=>x.name==='万用表'))}`);
    console.log(`  待归还对齐: ${JSON.stringify(e.pending_returns) === JSON.stringify(t.pending_returns)}`);
    console.log(`  预约汇总对齐: ${JSON.stringify(e.reservation_summary) === JSON.stringify(t.reservation_summary)}`);
    console.log(`  损耗汇总对齐: ${JSON.stringify(e.loss_summary) === JSON.stringify(t.loss_summary)}`);
  }

  console.log('\n--- 持久化验证完成 ---');
})().catch(e => console.error(e));
