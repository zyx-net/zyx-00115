import requests
import json
import sys

BASE = 'http://localhost:3001'
s = requests.Session()

passed = 0
failed = 0

def check(cond, msg):
    global passed, failed
    if cond:
        print(f'  PASS: {msg}')
        passed += 1
    else:
        print(f'  FAIL: {msg}')
        failed += 1

def j(resp):
    try:
        return resp.json()
    except:
        return {}

print('=== 接口核对：用 Python requests 跑真实 HTTP 请求 ===\n')

print('--- 步骤0: 重置数据 ---')
r = s.post(f'{BASE}/api/reset')
check(r.status_code == 200, '重置数据成功')

print('--- 步骤1: 登录 ---')
r = s.post(f'{BASE}/api/login', json={'username':'admin','password':'admin123'})
check(r.status_code == 200, '管理员登录成功')
admin_cookie = s.cookies.get_dict()

r_teacher = requests.Session()
r_t = r_teacher.post(f'{BASE}/api/login', json={'username':'zhangsan','password':'123456'})
check(r_t.status_code == 200, '教师登录成功')

r_lab = requests.Session()
r_l = r_lab.post(f'{BASE}/api/login', json={'username':'wangwu','password':'123456'})
check(r_l.status_code == 200, '实验员登录成功')

print('\n--- 步骤2: 权限核对（教师 403） ---')
r = r_teacher.get(f'{BASE}/api/settlements/ledger')
check(r.status_code == 403, f'教师访问台账列表返回 403（实际: {r.status_code}）')

r = r_teacher.get(f'{BASE}/api/settlements/ledger/summary')
check(r.status_code == 403, f'教师访问台账摘要返回 403（实际: {r.status_code}）')

r = r_teacher.get(f'{BASE}/api/settlements/ledger/999')
check(r.status_code == 403, f'教师访问台账详情返回 403（实际: {r.status_code}）')

r = r_teacher.get(f'{BASE}/api/settlements/ledger/export/csv')
check(r.status_code == 403, f'教师导出台账返回 403（实际: {r.status_code}）')

print('\n--- 步骤3: 管理员和实验员可访问台账 ---')
r = s.get(f'{BASE}/api/settlements/ledger')
check(r.status_code == 200, f'管理员访问台账列表返回 200（实际: {r.status_code}）')

r = r_lab.get(f'{BASE}/api/settlements/ledger')
check(r.status_code == 200, f'实验员访问台账列表返回 200（实际: {r.status_code}）')

print('\n--- 步骤4: 准备测试数据 ---')
equipments = s.get(f'{BASE}/api/equipment').json()
eq = equipments[0] if equipments else None
check(eq is not None, f'获取设备成功: {eq["name"] if eq else "无"}')

courses = s.get(f'{BASE}/api/courses').json()
course = courses[0] if courses else None
classes = s.get(f'{BASE}/api/classes').json()
cls = classes[0] if classes else None

r = s.post(f'{BASE}/api/reservations', json={
    'week_key': '2026-W50',
    'equipment_id': eq['id'],
    'course_id': course['id'] if course else None,
    'class_id': cls['id'] if cls else None,
    'usage_count': 5
})
check(r.status_code in [200, 201, 400], f'创建预约（状态: {r.status_code}）')

r = s.post(f'{BASE}/api/settlements/weekly', json={'week_key': '2026-W50'})
check(r.status_code == 200, f'W50 结转成功')

r = s.get(f'{BASE}/api/export/2026-W50')
check(r.status_code == 200, f'导出 W50 JSON 成功')

r = s.post(f'{BASE}/api/reservations', json={
    'week_key': '2026-W51',
    'equipment_id': eq['id'],
    'course_id': course['id'] if course else None,
    'class_id': cls['id'] if cls else None,
    'usage_count': 3,
    'notes': '接口核对测试2'
})
r = s.post(f'{BASE}/api/settlements/weekly', json={'week_key': '2026-W51'})
check(r.status_code == 200, f'W51 结转成功')

r = s.get(f'{BASE}/api/export/2026-W51')
check(r.status_code == 200, f'导出 W51 JSON 成功')

settlements = s.get(f'{BASE}/api/settlements').json()
if len(settlements) >= 2:
    r = s.post(f'{BASE}/api/settlements/compare', json={
        'settlement_a_id': settlements[1]['id'],
        'settlement_b_id': settlements[0]['id']
    })
    check(r.status_code == 200, f'对比成功')

    r = s.post(f'{BASE}/api/settlements/compare/export-csv', json={
        'settlement_a_id': settlements[1]['id'],
        'settlement_b_id': settlements[0]['id']
    })
    check(r.status_code == 200, f'导出对比 CSV（状态: {r.status_code}）')
else:
    check(False, '结转记录不足，无法对比')

print('\n--- 步骤5: 台账列表字段核对 ---')
r = s.get(f'{BASE}/api/settlements/ledger')
data = r.json()
check('list' in data, '返回包含 list 字段')
check('summary' in data, '返回包含 summary 字段')

if data['list']:
    item = data['list'][0]
    required_fields = ['id', 'week_key_a', 'filename', 'row_count', 'related_note_count',
                       'type', 'created_by_user_name', 'created_by_username', 'invalid']
    for f in required_fields:
        check(f in item, f'列表项包含 {f} 字段')
    
    if item.get('last_cleaned_stats'):
        stats = item['last_cleaned_stats']
        check('cleaned_notes' in stats, 'last_cleaned_stats 包含 cleaned_notes')
        check('cleaned_exports_total' in stats, 'last_cleaned_stats 包含 cleaned_exports_total')
        check('notes' not in stats, 'last_cleaned_stats 不包含旧字段名 notes')
        check('exports_total' not in stats, 'last_cleaned_stats 不包含旧字段名 exports_total')

summary = data['summary']
check('total_count' in summary, 'summary 包含 total_count')
check('valid_count' in summary, 'summary 包含 valid_count')
check('invalid_count' in summary, 'summary 包含 invalid_count')
check('single_count' in summary, 'summary 包含 single_count')
check('comparison_count' in summary, 'summary 包含 comparison_count')

print('\n--- 步骤6: 按 README 说明查询命中 ---')
r = s.get(f'{BASE}/api/settlements/ledger', params={'export_type': 'single'})
data = r.json()
check(all(item['type'] == 'single' for item in data['list']), 'export_type=single 筛选正确')
check(data['summary']['single_count'] == data['summary']['total_count'], 'summary 与筛选匹配')

r = s.get(f'{BASE}/api/settlements/ledger', params={'export_type': 'comparison'})
data = r.json()
check(all(item['type'] == 'comparison' for item in data['list']), 'export_type=comparison 筛选正确')

r = s.get(f'{BASE}/api/settlements/ledger', params={'week_key_start': '2026-W50', 'week_key_end': '2026-W50'})
data = r.json()
check(all(item.get('week_key_a') <= '2026-W50' or item.get('week_key_b') <= '2026-W50' for item in data['list']),
      'week_key_start/end 筛选正确')

r = s.get(f'{BASE}/api/settlements/ledger', params={'operator': 'admin'})
data = r.json()
check(all(item.get('created_by_user_name') == '管理员' or item.get('created_by_username') == 'admin' for item in data['list']),
      'operator=admin 筛选正确')

r = s.get(f'{BASE}/api/settlements/ledger', params={'invalid': 'false'})
data = r.json()
check(all(item['invalid'] == 0 for item in data['list']), 'invalid=false 筛选正确')

print('\n--- 步骤7: 台账详情字段核对 ---')
if data['list']:
    detail_id = data['list'][0]['id']
    r = s.get(f'{BASE}/api/settlements/ledger/{detail_id}')
    detail = r.json()
    check(r.status_code == 200, f'详情接口返回 200')
    check('type' in detail, '详情包含 type 字段')
    check('created_by_user_name' in detail, '详情包含 created_by_user_name')
    check('created_by_username' in detail, '详情包含 created_by_username')
    check('related_note_count' in detail, '详情包含 related_note_count')
    
    if detail['type'] == 'comparison':
        check('comparison_id' in detail, '对比CSV详情包含 comparison_id')
        check('comparison_diff_summary' in detail, '对比CSV详情包含 comparison_diff_summary')
        check('settlement_a_id' in detail, '对比CSV详情包含 settlement_a_id')
        check('settlement_b_id' in detail, '对比CSV详情包含 settlement_b_id')

print('\n--- 步骤8: 撤销联动失效收口 ---')
r = s.delete(f'{BASE}/api/settlements/2026-W51/revoke')
check(r.status_code == 200, f'撤销 W51 成功')

r = s.get(f'{BASE}/api/settlements/ledger', params={'invalid': 'true'})
invalid_list = r.json()['list']
w51_invalid = [x for x in invalid_list if x.get('week_key_a') == '2026-W51' or x.get('week_key_b') == '2026-W51']
check(len(w51_invalid) >= 1, f'W51 相关记录标记为失效（实际: {len(w51_invalid)}）')

if w51_invalid:
    inv = w51_invalid[0]
    check('invalidated_at' in inv, '失效记录包含 invalidated_at')
    check('invalidated_by_user_name' in inv, '失效记录包含 invalidated_by_user_name')
    check(inv.get('invalidated_reason') == '撤销周结转', f'失效原因正确（实际: {inv.get("invalidated_reason")}）')
    
    if inv.get('last_cleaned_stats'):
        stats = inv['last_cleaned_stats']
        check('cleaned_notes' in stats, '失效记录清理统计包含 cleaned_notes')
        check('cleaned_exports_total' in stats, '失效记录清理统计包含 cleaned_exports_total')
        check('notes' not in stats, '清理统计不含旧字段名 notes')
        check('exports_total' not in stats, '清理统计不含旧字段名 exports_total')

print('\n--- 步骤9: 导出历史不含失效记录 ---')
r = s.get(f'{BASE}/api/settlements/exports')
exports = r.json()
w51_in_exports = [x for x in exports if x.get('week_key_a') == '2026-W51' or x.get('week_key_b') == '2026-W51']
check(len(w51_in_exports) == 0, f'导出历史不含 W51 失效记录（实际: {len(w51_in_exports)}）')

print('\n--- 步骤10: 台账 CSV 导出 ---')
r = s.get(f'{BASE}/api/settlements/ledger/export/csv')
check(r.status_code == 200, '台账CSV导出返回 200')
check('text/csv' in r.headers.get('Content-Type', ''), 'Content-Type 为 text/csv')
csv_text = r.text
check(csv_text.startswith('\ufeff'), 'CSV 包含 BOM')
lines = csv_text.strip().split('\n')
check(len(lines) >= 2, f'CSV 至少有表头+1行数据（实际行数: {len(lines)}）')

print(f'\n=== 接口核对结果: {passed} 通过, {failed} 失败 ===')
sys.exit(1 if failed > 0 else 0)
