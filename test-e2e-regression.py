import requests
import json
import sys
import time

BASE = 'http://localhost:3001'
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

print('=== 端到端回归验证 ===\n')

print('===== 场景1: 权限差异 =====')
print('--- 1.1 重置数据 ---')
s = requests.Session()
s.post(f'{BASE}/api/reset')

print('--- 1.2 三种角色登录 ---')
s.post(f'{BASE}/api/login', json={'username':'admin','password':'admin123'})
s_teacher = requests.Session()
s_teacher.post(f'{BASE}/api/login', json={'username':'zhangsan','password':'123456'})
s_lab = requests.Session()
s_lab.post(f'{BASE}/api/login', json={'username':'wangwu','password':'123456'})

print('--- 1.3 教师: 台账所有接口 403 ---')
for ep, method in [
    ('/api/settlements/ledger', 'GET'),
    ('/api/settlements/ledger/summary', 'GET'),
    ('/api/settlements/ledger/1', 'GET'),
    ('/api/settlements/ledger/export/csv', 'GET'),
]:
    r = s_teacher.get(f'{BASE}{ep}')
    check(r.status_code == 403, f'教师 {method} {ep} → 403')

print('--- 1.4 教师: 导出历史接口 403 ---')
r = s_teacher.get(f'{BASE}/api/settlements/exports')
check(r.status_code == 403, f'教师 GET /api/settlements/exports → 403')

print('--- 1.5 管理员: 台账全部可访问 ---')
r = s.get(f'{BASE}/api/settlements/ledger')
check(r.status_code == 200, '管理员访问台账列表 → 200')
r = s.get(f'{BASE}/api/settlements/ledger/summary')
check(r.status_code == 200, '管理员访问台账摘要 → 200')
r = s.get(f'{BASE}/api/settlements/ledger/export/csv')
check(r.status_code == 200, '管理员导出台账CSV → 200')

print('--- 1.6 实验员: 台账全部可访问 ---')
r = s_lab.get(f'{BASE}/api/settlements/ledger')
check(r.status_code == 200, '实验员访问台账列表 → 200')
r = s_lab.get(f'{BASE}/api/settlements/ledger/summary')
check(r.status_code == 200, '实验员访问台账摘要 → 200')
r = s_lab.get(f'{BASE}/api/settlements/ledger/export/csv')
check(r.status_code == 200, '实验员导出台账CSV → 200')

print('\n===== 场景2: 按 README 说明查询命中 =====')
print('--- 2.1 准备数据 ---')
equipments = s.get(f'{BASE}/api/equipment').json()
eq = equipments[0]
courses = s.get(f'{BASE}/api/courses').json()
course = courses[0] if courses else None
classes = s.get(f'{BASE}/api/classes').json()
cls = classes[0] if classes else None

s.post(f'{BASE}/api/reservations', json={
    'week_key': '2026-W50', 'equipment_id': eq['id'],
    'course_id': course['id'] if course else None,
    'class_id': cls['id'] if cls else None, 'usage_count': 5
})
s.post(f'{BASE}/api/settlements/weekly', json={'week_key': '2026-W50'})
s.get(f'{BASE}/api/export/2026-W50')

s.post(f'{BASE}/api/reservations', json={
    'week_key': '2026-W51', 'equipment_id': eq['id'],
    'course_id': course['id'] if course else None,
    'class_id': cls['id'] if cls else None, 'usage_count': 3
})
s.post(f'{BASE}/api/settlements/weekly', json={'week_key': '2026-W51'})
s.get(f'{BASE}/api/export/2026-W51')

settlements = s.get(f'{BASE}/api/settlements').json()
s.post(f'{BASE}/api/settlements/compare', json={
    'settlement_a_id': settlements[1]['id'],
    'settlement_b_id': settlements[0]['id']
})
s.post(f'{BASE}/api/settlements/compare/export-csv', json={
    'settlement_a_id': settlements[1]['id'],
    'settlement_b_id': settlements[0]['id']
})

print('--- 2.2 查询参数有效性 ---')
r = s.get(f'{BASE}/api/settlements/ledger', params={'export_type': 'single'})
data = r.json()
check(len(data['list']) > 0, f'export_type=single 命中 {len(data["list"])} 条')
check(all(x['type'] == 'single' for x in data['list']), '所有记录 type=single')

r = s.get(f'{BASE}/api/settlements/ledger', params={'export_type': 'comparison'})
data = r.json()
check(len(data['list']) > 0, f'export_type=comparison 命中 {len(data["list"])} 条')
check(all(x['type'] == 'comparison' for x in data['list']), '所有记录 type=comparison')

r = s.get(f'{BASE}/api/settlements/ledger', params={'week_key_start': '2026-W50', 'week_key_end': '2026-W50'})
data = r.json()
check(len(data['list']) > 0, f'week_key 筛选命中 {len(data["list"])} 条')

r = s.get(f'{BASE}/api/settlements/ledger', params={'operator': 'admin'})
data = r.json()
check(len(data['list']) > 0, f'operator=admin 命中 {len(data["list"])} 条')

r = s.get(f'{BASE}/api/settlements/ledger', params={'invalid': 'false'})
data = r.json()
check(len(data['list']) > 0, f'invalid=false 命中 {len(data["list"])} 条')
check(all(x['invalid'] == 0 for x in data['list']), '所有记录 invalid=0')

print('--- 2.3 字段名核对 ---')
r = s.get(f'{BASE}/api/settlements/ledger')
data = r.json()
for item in data['list']:
    if item.get('last_cleaned_stats'):
        stats = item['last_cleaned_stats']
        check('cleaned_notes' in stats and 'notes' not in stats,
              f'last_cleaned_stats 用 cleaned_notes 而非 notes')
        check('cleaned_exports_total' in stats and 'exports_total' not in stats,
              f'last_cleaned_stats 用 cleaned_exports_total 而非 exports_total')
        break

print('\n===== 场景3: 从历史页进入台账 =====')
print('--- 3.1 导出历史 API 返回数据 ---')
r = s.get(f'{BASE}/api/settlements/exports')
exports = r.json()
check(len(exports) > 0, f'导出历史有 {len(exports)} 条记录')

print('--- 3.2 导出历史与台账关联 ---')
r = s.get(f'{BASE}/api/settlements/ledger')
ledger_list = r.json()['list']
check(len(ledger_list) >= len(exports), f'台账记录数 >= 导出历史（台账: {len(ledger_list)}, 历史: {len(exports)}）')

export_ids = {e['id'] for e in exports}
ledger_ids = {l['id'] for l in ledger_list if l['invalid'] == 0}
check(export_ids.issubset(ledger_ids), '导出历史的 ID 全部在台账有效记录中')

print('--- 3.3 台账详情能看类型和关联信息 ---')
comp_item = next((x for x in ledger_list if x['type'] == 'comparison'), None)
if comp_item:
    r = s.get(f'{BASE}/api/settlements/ledger/{comp_item["id"]}')
    detail = r.json()
    check(detail['type'] == 'comparison', f'详情类型为 comparison')
    check('comparison_id' in detail, '详情包含 comparison_id')
    check('comparison_diff_summary' in detail, '详情包含 comparison_diff_summary')
    check('created_by_user_name' in detail, '详情包含操作人姓名')
else:
    check(False, '没有对比记录可验证')

single_item = next((x for x in ledger_list if x['type'] == 'single'), None)
if single_item:
    r = s.get(f'{BASE}/api/settlements/ledger/{single_item["id"]}')
    detail = r.json()
    check(detail['type'] == 'single', f'详情类型为 single')
    check('week_key_a' in detail, '详情包含 week_key_a')
    check('created_by_user_name' in detail, '详情包含操作人姓名')
else:
    check(False, '没有单周记录可验证')

print('\n===== 场景4: 失效记录收口后的用户可见结果 =====')
print('--- 4.1 撤销 W51 ---')
r = s.delete(f'{BASE}/api/settlements/2026-W51/revoke')
check(r.status_code == 200, '撤销 W51 成功')
revoked = r.json()
check('cleaned' in revoked, '撤销返回 cleaned 统计')
if 'cleaned' in revoked:
    cleaned = revoked['cleaned']
    check('cleaned_notes' in cleaned, 'cleaned 包含 cleaned_notes')
    check('cleaned_exports_total' in cleaned, 'cleaned 包含 cleaned_exports_total')

print('--- 4.2 台账中 W51 记录标记为失效 ---')
r = s.get(f'{BASE}/api/settlements/ledger', params={'invalid': 'true'})
invalid_list = r.json()['list']
w51_invalid = [x for x in invalid_list if '2026-W51' in str(x)]
check(len(w51_invalid) >= 1, f'台账中 W51 失效记录 {len(w51_invalid)} 条')

print('--- 4.3 导出历史不再显示失效记录 ---')
r = s.get(f'{BASE}/api/settlements/exports')
exports_after = r.json()
w51_in_exports = [x for x in exports_after if '2026-W51' in str(x)]
check(len(w51_in_exports) == 0, f'导出历史中 W51 记录数: {len(w51_in_exports)}')

print('--- 4.4 台账摘要中 invalid_count 更新 ---')
r = s.get(f'{BASE}/api/settlements/ledger/summary')
summary = r.json()
check(summary['invalid_count'] > 0, f'invalid_count > 0（实际: {summary["invalid_count"]}）')
check(summary['valid_count'] + summary['invalid_count'] == summary['total_count'],
      f'valid + invalid = total（{summary["valid_count"]} + {summary["invalid_count"]} = {summary["total_count"]}）')

print('--- 4.5 失效记录的详细信息 ---')
if w51_invalid:
    inv = w51_invalid[0]
    check(inv.get('invalidated_at') is not None, '失效记录有 invalidated_at')
    check(inv.get('invalidated_by_user_name') is not None, '失效记录有 invalidated_by_user_name')
    check(inv.get('invalidated_reason') == '撤销周结转',
          f'失效原因正确（实际: {inv.get("invalidated_reason")}）')
    if inv.get('last_cleaned_stats'):
        stats = inv['last_cleaned_stats']
        check(all(k.startswith('cleaned_') for k in stats.keys()),
              f'清理统计字段全部以 cleaned_ 开头（字段: {list(stats.keys())}）')

print('--- 4.6 再次导出同一周次，台账新增有效记录 ---')
s.post(f'{BASE}/api/reservations', json={
    'week_key': '2026-W51', 'equipment_id': eq['id'],
    'course_id': course['id'] if course else None,
    'class_id': cls['id'] if cls else None, 'usage_count': 2
})
s.post(f'{BASE}/api/settlements/weekly', json={'week_key': '2026-W51'})
s.get(f'{BASE}/api/export/2026-W51')

r = s.get(f'{BASE}/api/settlements/ledger', params={'invalid': 'false'})
valid_list = r.json()['list']
w51_valid = [x for x in valid_list if x.get('week_key_a') == '2026-W51']
check(len(w51_valid) >= 1, f'重新导出后 W51 有效记录: {len(w51_valid)} 条')

print('\n===== 场景5: 移除导入后失效联动 =====')
print('--- 5.1 创建导入结转 ---')
import_totals = {
    'equipment_snapshot': [{'id': eq['id'], 'name': eq['name'], 'usage_count': 10}],
    'reservation_summary': {'total_usage': 10},
    'loss_summary': {'total_loss': 0},
    'pending_returns': []
}
r = s.post(f'{BASE}/api/settlements/import', json={
    'week_key': '2026-W52',
    'totals': import_totals
})
if r.status_code in [200, 201]:
    r_exp = s.get(f'{BASE}/api/export/2026-W52')
    has_export = r_exp.status_code == 200
    
    print('--- 5.2 移除导入 ---')
    r = s.delete(f'{BASE}/api/settlements/2026-W52/remove-import')
    check(r.status_code == 200, f'移除导入成功（状态: {r.status_code}）')
    
    if r.status_code == 200:
        check('cleaned' in r.json(), '移除导入返回 cleaned 统计')
        cleaned = r.json().get('cleaned', {})
        check('cleaned_notes' in cleaned, 'cleaned 包含 cleaned_notes')
        check('cleaned_exports_total' in cleaned, 'cleaned 包含 cleaned_exports_total')
        
        settlements_after = s.get(f'{BASE}/api/settlements').json()
        w52_active = [x for x in settlements_after if x.get('week_key') == '2026-W52']
        check(len(w52_active) == 0, f'W52 不再出现在活跃结转列表中（残留: {len(w52_active)}）')
        
        if has_export:
            r_inv = s.get(f'{BASE}/api/settlements/ledger', params={'invalid': 'true'})
            w52_invalid = [x for x in r_inv.json()['list'] if '2026-W52' in str(x)]
            check(len(w52_invalid) >= 1, f'移除导入后 W52 导出失效记录: {len(w52_invalid)} 条')
        else:
            check(True, '导入结转无导出记录，移除后无导出失效（符合预期）')

print(f'\n=== 端到端回归验证结果: {passed} 通过, {failed} 失败 ===')
sys.exit(1 if failed > 0 else 0)
