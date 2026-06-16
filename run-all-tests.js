const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TEST_PORT = 3099;
const env = Object.assign({}, process.env, { PORT: TEST_PORT });
let serverProc = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitForPort(port, timeout = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        res.resume();
        resolve(true);
      }).on('error', () => {
        if (Date.now() - start > timeout) reject(new Error('端口超时'));
        else setTimeout(check, 300);
      });
      req.setTimeout(500, () => req.destroy());
    };
    check();
  });
}

function killServer() {
  return new Promise(resolve => {
    if (!serverProc) return resolve();
    try {
      const pid = serverProc.pid;
      if (process.platform === 'win32') {
        try { execSync(`taskkill /F /PID ${pid} /T 2>nul`, { stdio: 'ignore' }); } catch (_) {}
      } else {
        serverProc.kill('SIGKILL');
      }
    } catch (_) {}
    setTimeout(async () => {
      // 清理残留 node
      if (process.platform === 'win32') {
        try {
          const nets = execSync(`netstat -ano 2>nul | findstr :${TEST_PORT} | findstr LISTENING`, { encoding: 'utf8' }).trim();
          const lines = nets.split('\n').filter(l => l.length > 0);
          lines.forEach(l => {
            const m = l.match(/(\d+)\s*$/);
            if (m) try { execSync(`taskkill /F /PID ${m[1]} /T 2>nul`, { stdio: 'ignore' }); } catch(_) {}
          });
        } catch(_) {}
      }
      serverProc = null;
      await sleep(2000);
      resolve();
    }, 500);
  });
}

async function startServer() {
  serverProc = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logBuf = [];
  serverProc.stdout.on('data', d => logBuf.push(d.toString()));
  serverProc.stderr.on('data', d => logBuf.push(d.toString()));
  serverProc.on('exit', (code) => {
    if (code && code !== 0 && code !== -1073740791 && code !== null) {
      console.log('[server exited with code ' + code + ']\n' + logBuf.join(''));
    }
  });
  try {
    await waitForPort(TEST_PORT);
    console.log(`  ✓ 服务器启动，端口 ${TEST_PORT}`);
    return true;
  } catch (e) {
    console.error('  ✗ 服务器启动失败: ' + e.message);
    return false;
  }
}

function runMocha(testFile) {
  return new Promise((resolve) => {
    const nodeBin = process.execPath;
    const c = spawn(nodeBin, [testFile], {
      cwd: __dirname,
      env: Object.assign({}, process.env, { TEST_PORT: TEST_PORT, BASE_URL: `http://127.0.0.1:${TEST_PORT}` }),
      stdio: 'inherit'
    });
    c.on('exit', resolve);
  });
}

async function main() {
  console.log('\n========== 全流程测试启动（端口 ' + TEST_PORT + '） ==========\n');

  // 确保 test-settlement-diff.js 用 TEST_PORT
  process.env.TEST_PORT = String(TEST_PORT);

  console.log('\n[阶段 1] 启动服务器 → 运行回归测试 (test-settlement-diff.js)');
  const ok1 = await startServer();
  if (!ok1) { console.error('无法启动服务器，终止'); process.exit(1); }

  // 修改测试脚本使用 TEST_PORT
  const oldContent = {};
  ['test-settlement-diff.js', 'test-restart-settlement-diff.js'].forEach(f => {
    const full = path.join(__dirname, f);
    oldContent[f] = fs.readFileSync(full, 'utf8');
    let c = oldContent[f];
    // 替换 BASE 端口
    const port = TEST_PORT;
    c = c.replace("const BASE = 'http://localhost:3001';", `const BASE = 'http://127.0.0.1:${port}';`);
    c = c.replace("const BASE = 'http://localhost:3000';", `const BASE = 'http://127.0.0.1:${port}';`);
    // 确保 server.js 也能响应 /api/health 检查
    fs.writeFileSync(full, c);
  });

  // 临时给 server.js 加 /api/health
  const serverFile = path.join(__dirname, 'server.js');
  const serverOld = fs.readFileSync(serverFile, 'utf8');
  if (!serverOld.includes('/api/health')) {
    let newSrv = serverOld.replace("app.get('/api/me'", `app.get('/api/health', (req, res) => res.json({ok:true}));\napp.get('/api/me'`);
    fs.writeFileSync(serverFile, newSrv);
  }

  let code1 = 1;
  try {
    code1 = await runMocha('test-settlement-diff.js');
    console.log(`\n  回归测试退出码: ${code1}`);
  } catch (e) { console.error(e); }

  console.log('\n[阶段 2] 停止服务器 → 等待 3 秒 → 重启服务器（模拟重启）');
  await killServer();
  await sleep(3000);
  const ok2 = await startServer();
  if (!ok2) { console.error('重启服务器失败，终止'); process.exit(1); }

  console.log('\n[阶段 3] 运行跨重启核对 (test-restart-settlement-diff.js)');
  let code2 = 1;
  try {
    code2 = await runMocha('test-restart-settlement-diff.js');
    console.log(`\n  跨重启核对退出码: ${code2}`);
  } catch (e) { console.error(e); }

  console.log('\n[阶段 4] 清理临时文件 + 停服务器');
  // 恢复文件
  Object.entries(oldContent).forEach(([f, c]) => {
    fs.writeFileSync(path.join(__dirname, f), c);
  });
  fs.writeFileSync(serverFile, serverOld);
  await killServer();

  const total = (code1 === 0) && (code2 === 0);
  console.log('\n========== 全流程测试结束 ==========');
  console.log(`  回归测试: ${code1 === 0 ? '✅ 通过' : '❌ 失败'}`);
  console.log(`  重启核对: ${code2 === 0 ? '✅ 通过' : '❌ 失败'}`);
  console.log(`  总体: ${total ? '✅ 全部通过' : '❌ 有失败项'}`);

  process.exit(total ? 0 : 1);
}

process.on('SIGINT', async () => { console.log('\nCtrl+C, 清理服务器...'); await killServer(); process.exit(2); });
process.on('exit', async () => { if (serverProc) await killServer(); });

main().catch(e => { console.error(e); killServer().then(() => process.exit(1)); });
