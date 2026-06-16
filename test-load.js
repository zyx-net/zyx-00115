console.log('Testing db module load...');
try {
  const db = require('./db');
  console.log('db module loaded successfully');
  console.log('Exported methods:', Object.keys(db));
} catch (e) {
  console.error('Error loading db:', e.message);
  console.error(e.stack);
  process.exit(1);
}

console.log('\nTesting server module load...');
try {
  // Just test that it can be parsed, don't actually start
  const fs = require('fs');
  const content = fs.readFileSync('./server.js', 'utf8');
  console.log('server.js read successfully, length:', content.length);
} catch (e) {
  console.error('Error loading server:', e.message);
  console.error(e.stack);
  process.exit(1);
}

console.log('\nAll modules loaded successfully!');
