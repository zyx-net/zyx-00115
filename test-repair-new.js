const http = require('http');

const BASE = 'http://localhost:3001';
let passed = 0;
let failed = 0;
let failures = [];

function assert(cond, msg) {
  if (cond) { 
    passed++; 
    console.log(`  PASS: ${msg}`); 
  } else { 
    failed++; 
    failures.push(msg);
    console.log(`  FAIL: ${msg}`); 
  }
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
  console.log('\n=== Quick Repair Tests ===\n');

  console.log('Reset...');
  await request('POST', '/api/reset');
  await new Promise(r => setTimeout(r, 500));

  const adminLogin = await request('POST', '/api/login', { username: 'admin', password: 'admin123' });
  const adminCookie = adminLogin.cookie.split(';')[0];
  assert(adminLogin.status === 200, 'Admin login');

  console.log('\n--- Test 1: Constants API ---');
  const constantsRes = await request('GET', '/api/repair/constants', null, adminCookie);
  assert(constantsRes.status === 200, 'Constants API returns 200');
  assert(constantsRes.data.order_statuses, 'Has order_statuses');
  assert(constantsRes.data.order_statuses.pending === '待处理', 'Pending status label correct');
  assert(constantsRes.data.schedule_statuses, 'Has schedule_statuses');
  assert(Array.isArray(constantsRes.data.csv_fields), 'Has csv_fields array');
  assert(constantsRes.data.status_flow, 'Has status_flow');

  console.log('\n--- Test 2: Empty CSV import ---');
  const emptyRes = await request('POST', '/api/repair/import/csv', { csv_data: '' }, adminCookie);
  assert(emptyRes.status === 400, 'Empty CSV returns 400');
  assert(emptyRes.data.error, 'Empty CSV has error message');
  console.log('  Empty CSV error:', emptyRes.data.error);

  console.log('\n--- Test 3: CSV with only header ---');
  const headerOnly = await request('POST', '/api/repair/import/csv', { csv_data: '维修单号,器材名称,数量,故障现象\n' }, adminCookie);
  assert(headerOnly.status === 400, 'Header-only CSV returns 400');

  console.log('\n--- Test 4: CSV missing required columns ---');
  const missingCols = await request('POST', '/api/repair/import/csv', { csv_data: '维修单号,故障现象\nRP001,测试故障' }, adminCookie);
  assert(missingCols.status === 400, 'Missing required columns returns 400');
  console.log('  Missing cols error:', missingCols.data.error);

  console.log('\n--- Test 5: Valid CSV import ---');
  const validCsv = '维修单号,器材名称,数量,故障现象,状态\nRPTEST001,示波器,2,测试导入故障,repairing';
  const validRes = await request('POST', '/api/repair/import/csv', { csv_data: validCsv }, adminCookie);
  assert(validRes.status === 200, 'Valid CSV returns 200');
  assert(validRes.data.imported === 1, 'Imported 1 order');
  assert(validRes.data.errors === 0, 'No errors');
  console.log('  Import result:', JSON.stringify(validRes.data));

  console.log('\n--- Test 6: Duplicate order number import ---');
  const dupRes = await request('POST', '/api/repair/import/csv', { csv_data: validCsv }, adminCookie);
  assert(dupRes.status === 200, 'Duplicate import returns 200');
  assert(dupRes.data.imported === 0, 'Imported 0 orders');
  assert(dupRes.data.skipped === 1, 'Skipped 1 order');
  console.log('  Dup import result:', JSON.stringify(dupRes.data));

  console.log('\n--- Test 7: Invalid status value ---');
  const invalidStatusCsv = '维修单号,器材名称,数量,故障现象,状态\nRPINVALID01,示波器,1,测试,invalid_status';
  const invalidStatusRes = await request('POST', '/api/repair/import/csv', { csv_data: invalidStatusCsv }, adminCookie);
  assert(invalidStatusRes.status === 400, 'Invalid status returns 400');
  assert(invalidStatusRes.data.errors === 1, 'Has 1 error');
  console.log('  Invalid status error:', JSON.stringify(invalidStatusRes.data));

  console.log('\n--- Test 8: Mixed valid and invalid rows ---');
  const mixedCsv = `维修单号,器材名称,数量,故障现象,状态
RPMIX001,示波器,1,正常行,repairing
RPMIX002,不存在的器材,1,器材不存在,pending
RPMIX003,示波器,0,数量为0,pending`;
  const mixedRes = await request('POST', '/api/repair/import/csv', { csv_data: mixedCsv }, adminCookie);
  assert(mixedRes.status === 400, 'Mixed CSV with errors returns 400');
  assert(mixedRes.data.imported === 0, 'No orders imported (atomic)');
  assert(mixedRes.data.errors >= 2, 'Has 2+ errors');
  console.log('  Mixed result:', JSON.stringify(mixedRes.data));

  console.log('\n--- Test 9: Verify no dirty data written after failed import ---');
  const ordersRes = await request('GET', '/api/repair/orders', null, adminCookie);
  const rpMix001 = ordersRes.data.find(o => o.order_no === 'RPMIX001');
  assert(!rpMix001, 'RPMIX001 not written (atomic failure)');

  console.log('\n--- Test 10: CSV export/import roundtrip ---');
  const exportRes = await request('GET', '/api/repair/export/csv', null, adminCookie);
  assert(exportRes.status === 200, 'Export CSV succeeds');
  assert(typeof exportRes.data === 'string', 'Export returns string');
  assert(exportRes.data.includes('维修单号'), 'Export has Chinese headers');
  console.log('  Export length:', exportRes.data.length);

  console.log('\n=== Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach((f, i) => console.log(`  ${i+1}. ${f}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('Test error:', e); process.exit(1); });
