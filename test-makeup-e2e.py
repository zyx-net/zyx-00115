import requests
import json
import sys
import time
import os

BASE = 'http://localhost:3001'
s_admin = requests.Session()
s_teacher1 = requests.Session()
s_teacher2 = requests.Session()
s_lab = requests.Session()

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

def pause(ms):
    time.sleep(ms / 1000.0)

print('========================================')
print('  补课与调课审批中心 Python E2E 测试')
print('========================================\n')

# ============== 步骤0: 重置 + 登录 ==============
print('--- 步骤0: 重置数据 & 多角色登录 ---')
r = s_admin.post(f'{BASE}/api/reset', json={})
check(r.status_code == 200, '重置数据成功')
pause(600)

r = s_admin.post(f'{BASE}/api/login', json={'username':'admin','password':'admin123'})
check(r.status_code == 200, f'管理员登录 (code={r.status_code})')

r = s_teacher1.post(f'{BASE}/api/login', json={'username':'zhangsan','password':'123456'})
check(r.status_code == 200, f'教师张三登录 (code={r.status_code})')
t1_id = j(r).get('user', {}).get('id')
check(t1_id == 2, f'张三ID=2 (实际={t1_id})')

r = s_teacher2.post(f'{BASE}/api/login', json={'username':'lisi','password':'123456'})
check(r.status_code == 200, f'教师李四登录 (code={r.status_code})')

r = s_lab.post(f'{BASE}/api/login', json={'username':'wangwu','password':'123456'})
check(r.status_code == 200, f'实验员王五登录 (code={r.status_code})')

# ============== 步骤1: 基础数据 ==============
print('\n--- 步骤1: 基础数据接口 ---')
r = s_admin.get(f'{BASE}/api/makeup/classrooms')
cls = j(r)
check(r.status_code == 200 and len(cls) >= 4, f'教室列表 >=4 (实际={len(cls)})')

r = s_admin.get(f'{BASE}/api/makeup/students')
sts = j(r)
check(r.status_code == 200 and len(sts) >= 8, f'学员列表 >=8 (实际={len(sts)})')

r = s_admin.get(f'{BASE}/api/makeup/schedules', params={'teacher_id': 2})
sch = j(r)
check(r.status_code == 200, f'课表接口 200 (条数={len(sch) if isinstance(sch,list) else 0})')

r = s_teacher1.get(f'{BASE}/api/makeup/stats')
st = j(r)
check(r.status_code == 200 and st.get('total') == 0, f'初始统计 total=0')

# ============== 步骤2: 提交申请 ==============
print('\n--- 步骤2: 教师提交补课申请 ---')
payload_makeup = {
    'type': 'makeup',
    'course_id': 1,
    'class_id': 1,
    'student_ids': [1, 2],
    'original_schedule_id': 1,
    'original_date': '2026-02-18',
    'original_start_time': '08:00',
    'original_end_time': '10:00',
    'original_classroom_id': 1,
    'new_date': '2026-03-09',
    'new_start_time': '14:00',
    'new_end_time': '16:00',
    'new_classroom_id': 2,
    'hours': 2,
    'reason': 'E2E测试-物理实验补课'
}
r = s_teacher1.post(f'{BASE}/api/makeup/requests', json=payload_makeup)
check(r.status_code == 200, f'提交补课申请 (code={r.status_code})')
body = j(r)
req1_id = body.get('id')
req1_no = body.get('request_no')
check(req1_id is not None and req1_no is not None, f'返回ID={req1_id}, 单号={req1_no}')
check(body.get('status') == 'pending', '初始状态=pending')

# ============== 步骤3: 冲突拦截 ==============
print('\n--- 步骤3: 三类时间冲突拦截 ---')
r = s_teacher1.post(f'{BASE}/api/makeup/check-conflicts', json={
    'teacherId': 2, 'classroomId': 4, 'studentIds': [5,6],
    'date': '2026-03-10', 'startTime': '14:00', 'endTime': '16:00', 'classId': 2
})
check(r.status_code == 200 and j(r).get('has_conflict') == False,
    f'预检空闲无冲突 (code={r.status_code})')

tc_payload = dict(payload_makeup)
tc_payload['new_date'] = '2026-03-09'
tc_payload['new_start_time'] = '14:30'
tc_payload['new_end_time'] = '15:30'
tc_payload['new_classroom_id'] = 3
tc_payload['reason'] = '教师时间重叠测试'
r = s_teacher1.post(f'{BASE}/api/makeup/requests', json=tc_payload)
check(r.status_code == 409, f'教师时间重叠 409 (code={r.status_code})')
rb = j(r)
check(isinstance(rb.get('conflicts', {}).get('teacher'), list) and len(rb['conflicts']['teacher']) > 0,
    '响应含 teacher 冲突明细')

rc_payload = dict(payload_makeup)
rc_payload['new_date'] = '2026-03-09'
rc_payload['new_start_time'] = '14:30'
rc_payload['new_end_time'] = '15:30'
rc_payload['new_classroom_id'] = 2
rc_payload['course_id'] = 2
rc_payload['class_id'] = 3
rc_payload['student_ids'] = [7,8]
rc_payload['reason'] = '教室冲突测试'
r = s_teacher2.post(f'{BASE}/api/makeup/requests', json=rc_payload)
check(r.status_code == 409, f'教室时间重叠 409 (code={r.status_code})')
rb = j(r)
check(len(rb.get('conflicts', {}).get('classroom', [])) > 0, '响应含 classroom 冲突明细')

sc_payload = dict(payload_makeup)
sc_payload['course_id'] = 2
sc_payload['class_id'] = 3
sc_payload['new_date'] = '2026-03-09'
sc_payload['new_start_time'] = '14:30'
sc_payload['new_end_time'] = '15:30'
sc_payload['new_classroom_id'] = 4
sc_payload['student_ids'] = [1, 2]
sc_payload['reason'] = '学员冲突测试(李四提交自己的化学课)'
r = s_teacher2.post(f'{BASE}/api/makeup/requests', json=sc_payload)
check(r.status_code == 409, f'学员时间重叠 409 (code={r.status_code})')
rb = j(r)
check(len(rb.get('conflicts', {}).get('student', [])) > 0, '响应含 student 冲突明细')

# ============== 步骤4: 权限过滤 ==============
print('\n--- 步骤4: 权限与数据隔离 ---')
r = s_teacher1.get(f'{BASE}/api/makeup/requests')
lst = j(r)
check(r.status_code == 200 and len(lst) == 1, f'张三看到 {len(lst)} 条自己的申请')

r = s_teacher2.get(f'{BASE}/api/makeup/requests')
lst2 = j(r)
check(r.status_code == 200 and len(lst2) == 0, f'李四看到 {len(lst2)} 条（无他的）')

r = s_admin.get(f'{BASE}/api/makeup/requests')
check(r.status_code == 200 and len(j(r)) >= 1, '管理员看到所有申请')

r = s_teacher2.get(f'{BASE}/api/makeup/requests/{req1_id}')
check(r.status_code == 403, f'李四看张三的单据 403 (code={r.status_code})')

r = s_admin.get(f'{BASE}/api/makeup/requests/{req1_id}')
dt = j(r)
check(r.status_code == 200 and isinstance(dt.get('approvals'), list) and len(dt['approvals']) >= 1,
    f'管理员看详情 200，审批链 {len(dt.get("approvals",[]))} 条')

# ============== 步骤5: 审批驳回 ==============
print('\n--- 步骤5: 待处理队列 & 驳回 ---')
r = s_admin.get(f'{BASE}/api/makeup/queue/pending')
q = j(r)
check(r.status_code == 200 and len(q) >= 1, f'待处理队列 >=1 条 (实际={len(q)})')

r = s_teacher1.get(f'{BASE}/api/makeup/queue/pending')
check(r.status_code == 403, f'教师看待处理队列 403')

r = s_admin.put(f'{BASE}/api/makeup/requests/{req1_id}/reject', json={'reason': ''})
check(r.status_code == 400, f'驳回不给原因 400')

r = s_admin.put(f'{BASE}/api/makeup/requests/{req1_id}/reject', json={'reason': '与四六级考试冲突'})
check(r.status_code == 200, f'驳回成功 (code={r.status_code})')
rb = j(r)
check(rb.get('status') == 'rejected' and rb.get('reject_reason'), '状态=rejected 且记录原因')

r = s_teacher1.get(f'{BASE}/api/makeup/requests/{req1_id}')
apv = j(r).get('approvals', [])
check(any(a.get('action') == 'reject' for a in apv), '审批链追加 reject 动作')

# ============== 步骤6: 重新提交 ==============
print('\n--- 步骤6: 从 rejected 重新提交 ---')
r = s_teacher1.post(f'{BASE}/api/makeup/requests/{req1_id}/resubmit', json={
    'new_date': '2026-03-02', 'new_start_time': '10:00', 'new_end_time': '12:00',
    'new_classroom_id': 2, 'hours': 2, 'reason': '改到周一上午'
})
check(r.status_code == 200, f'重新提交成功 (code={r.status_code})')
rb = j(r)
req2_id = rb.get('id')
req2_no = rb.get('request_no')
check(rb.get('status') == 'resubmitted', '新单状态=resubmitted')
check(rb.get('parent_request_id') == req1_id, f'parent_request_id={rb.get("parent_request_id")} 关联原单')
check(rb.get('resubmitted_count') == 1, 'resubmitted_count=1')
print(f'    新单: {req2_no} (父单={req1_no})')

# ============== 步骤7: 审批通过 + 课时回写 ==============
print('\n--- 步骤7: 审批通过 + 课时回写 ---')
r = s_teacher1.put(f'{BASE}/api/makeup/requests/{req2_id}/approve', json={'comment':'教师自批'})
check(r.status_code == 403, '教师不能审批 (403)')

r = s_lab.put(f'{BASE}/api/makeup/requests/{req2_id}/approve', json={'comment':'时间合理'})
check(r.status_code == 200, f'实验员审批通过 (code={r.status_code})')
check(j(r).get('status') == 'approved' and j(r).get('approved_at'),
    '状态=approved，记录审批人/时间')

r = s_teacher1.put(f'{BASE}/api/makeup/requests/{req2_id}/writeback-hours', json={})
check(r.status_code == 403, '教师不能回写课时')

r = s_admin.put(f'{BASE}/api/makeup/requests/{req2_id}/writeback-hours', json={})
check(r.status_code == 200, f'管理员回写课时 (code={r.status_code})')
wb = j(r)
check(wb.get('ok') is True and isinstance(wb.get('delta_hours'), (int, float)),
    f'回写成功 delta_hours={wb.get("delta_hours")}')

r = s_admin.get(f'{BASE}/api/makeup/requests/{req2_id}')
check(j(r).get('hours_written_back') == 1, 'hours_written_back=1')
check(any(a.get('action') == 'writeback' for a in j(r).get('approvals', [])),
    '审批链包含 writeback')

r = s_admin.put(f'{BASE}/api/makeup/requests/{req2_id}/writeback-hours', json={})
check(r.status_code == 400, f'重复回写 400 (code={r.status_code})')

# ============== 步骤8: 撤销审批 ==============
print('\n--- 步骤8: 撤销审批通过 ---')
r = s_teacher1.post(f'{BASE}/api/makeup/requests', json={
    **payload_makeup,
    'new_date': '2026-03-17', 'new_start_time': '09:00', 'new_end_time': '11:00',
    'new_classroom_id': 1, 'reason': '用于撤销测试'
})
req3_id = j(r).get('id')
check(r.status_code == 200 and req3_id, '第三单提交成功')

s_admin.put(f'{BASE}/api/makeup/requests/{req3_id}/approve', json={'comment':'先通过'})

r = s_lab.put(f'{BASE}/api/makeup/requests/{req3_id}/revoke', json={'reason': ''})
check(r.status_code == 400, f'撤销无原因 400')

r = s_lab.put(f'{BASE}/api/makeup/requests/{req3_id}/revoke', json={'reason': '期中模考冲突'})
check(r.status_code == 200, f'撤销成功 (code={r.status_code})')
check(j(r).get('status') == 'revoked' and j(r).get('revoke_reason'),
    '状态=revoked，记录原因')

# ============== 步骤9: 取消申请 ==============
print('\n--- 步骤9: 取消申请 ---')
r = s_teacher1.post(f'{BASE}/api/makeup/requests', json={
    **payload_makeup,
    'new_date': '2026-03-18', 'new_start_time': '15:00', 'new_end_time': '17:00',
    'new_classroom_id': 3, 'reason': '用于取消测试'
})
req4_id = j(r).get('id')
check(r.status_code == 200, '第四单提交成功')

r = s_teacher2.put(f'{BASE}/api/makeup/requests/{req4_id}/cancel', json={'reason': '越权取消'})
check(r.status_code == 403, '李四取消张三单据 403')

r = s_teacher1.put(f'{BASE}/api/makeup/requests/{req4_id}/cancel', json={'reason': '没时间'})
check(r.status_code == 200, f'张三取消自己的单据 (code={r.status_code})')
check(j(r).get('status') == 'cancelled', '状态=cancelled')

# ============== 步骤10: 非法迁移 ==============
print('\n--- 步骤10: 非法状态迁移拦截 ---')
r = s_admin.put(f'{BASE}/api/makeup/requests/{req2_id}/approve', json={})
check(r.status_code == 400, f'approved 状态再审批 400')

r = s_admin.put(f'{BASE}/api/makeup/requests/{req1_id}/approve', json={})
check(r.status_code == 400, f'rejected 状态直接审批 400')

# ============== 步骤11: 统计 ==============
print('\n--- 步骤11: 统计校验 ---')
st = j(s_admin.get(f'{BASE}/api/makeup/stats'))
print(f'    {json.dumps(st, ensure_ascii=False)}')
check(st.get('total') >= 4, f'total={st.get("total")} >=4')
check(st.get('approved') >= 1, f'approved={st.get("approved")}')
check(st.get('rejected') >= 1, f'rejected={st.get("rejected")}')
check(st.get('revoked') >= 1, f'revoked={st.get("revoked")}')
check(st.get('cancelled') >= 1, f'cancelled={st.get("cancelled")}')
check(st.get('by_type', {}).get('makeup', 0) >= 3, f'makeup类型>={st.get("by_type",{}).get("makeup",0)}')

# ============== 步骤12: CSV导出 ==============
print('\n--- 步骤12: CSV 导出 ---')
r = s_admin.get(f'{BASE}/api/makeup/export/csv', params={'status': 'approved'})
check(r.status_code == 200, f'导出CSV 200')
csv_text = r.content.decode('utf-8-sig') if r.content[:3] == b'\xef\xbb\xbf' else r.text
check(len(csv_text) > 200, f'CSV 长度={len(csv_text)} >200')
check(req2_no in csv_text, f'CSV 包含通过单号 {req2_no}')
check('申请单号' in csv_text and '状态' in csv_text, 'CSV 中文表头正确')

# ============== 步骤13: JSON导入 ==============
print('\n--- 步骤13: JSON 导入（含重复/冲突/失败） ---')
now_iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
imp = {
    'requests': [
        {'request_no': req1_no, 'type': 'makeup', 'course_id': 1, 'class_id': 1,
         'teacher_id': 2, 'new_date': '2026-03-22', 'new_start_time': '08:00',
         'new_end_time': '10:00', 'hours': 2, 'reason': '重复单号',
         'status': 'pending', 'created_at': now_iso, 'updated_at': now_iso},
        {'request_no': 'PY-IMPORT-001', 'type': 'makeup', 'course_id': 1, 'class_id': 1,
         'teacher_id': 2, 'new_date': '2026-03-02', 'new_start_time': '10:30',
         'new_end_time': '11:30', 'new_classroom_id': 2, 'hours': 2, 'reason': '时间冲突',
         'status': 'pending', 'created_at': now_iso, 'updated_at': now_iso},
        {'request_no': 'PY-IMPORT-002', 'type': 'reschedule', 'course_id': 1, 'class_id': 1,
         'teacher_id': 2, 'new_date': '2026-03-23', 'new_start_time': '14:00',
         'new_end_time': '16:00', 'new_classroom_id': 4, 'hours': 2, 'reason': '合法导入(reschedule)',
         'status': 'approved', 'created_at': now_iso, 'updated_at': now_iso},
        {'request_no': 'PY-IMPORT-003', 'type': 'swap_class', 'course_id': 1, 'class_id': 1,
         'teacher_id': 2, 'new_date': '2026-03-24', 'new_start_time': '14:00',
         'new_end_time': '16:00', 'new_classroom_id': 3, 'new_class_id': 2, 'hours': 2,
         'reason': '合法导入(换班)', 'status': 'approved', 'created_at': now_iso, 'updated_at': now_iso}
    ]
}
r = s_teacher1.post(f'{BASE}/api/makeup/import/json', json=imp)
check(r.status_code == 403, '教师导入 403')

r = s_admin.post(f'{BASE}/api/makeup/import/json', json=imp)
check(200 <= r.status_code < 300, f'管理员导入成功 (code={r.status_code})')
ib = j(r)
print(f'    导入结果: {json.dumps({k:v for k,v in ib.items() if k!="details"}, ensure_ascii=False)}')
for d in ib.get('details', []):
    print(f'      · {json.dumps(d, ensure_ascii=False)}')
check(ib.get('imported') >= 1, f'imported={ib.get("imported")} >=1')
check(ib.get('duplicates') >= 1, f'duplicates={ib.get("duplicates")} >=1')
check(ib.get('conflicts') >= 1, f'conflicts={ib.get("conflicts")} >=1')
check(isinstance(ib.get('details'), list) and len(ib['details']) >= 3,
    f'details 明细 >=3 条')

# ============== 步骤14: 日志筛选 ==============
print('\n--- 步骤14: 操作日志筛选 ---')
r = s_admin.get(f'{BASE}/api/makeup/logs')
logs = j(r)
check(r.status_code == 200 and isinstance(logs, list) and len(logs) >= 5,
    f'全部日志 {len(logs)} 条 >=5')

r = s_admin.get(f'{BASE}/api/makeup/logs', params={'action': 'makeup_submit_request'})
logs_s = j(r)
check(r.status_code == 200 and len(logs_s) >= 1, f'按动作筛选 submit >=1')

r = s_admin.get(f'{BASE}/api/makeup/logs', params={'user_id': 2})
logs_u = j(r)
check(r.status_code == 200 and len(logs_u) >= 1, f'按用户(张三)筛选 >=1')

# ============== 步骤15: 持久化 & 重启验证准备 ==============
print('\n--- 步骤15: 服务重启状态保留验证 (落盘检查) ---')
db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'lab.db')
check(os.path.exists(db_path), f'SQLite 文件存在: {db_path}')
sz = os.path.getsize(db_path)
check(sz > 10000, f'DB 文件 {sz} 字节 >10KB')
print(f'    DB 文件大小: {sz} 字节')

pause(800)

# ============== 步骤16: 重置后再写，作为重启后验证基准 ==============
print('\n--- 步骤16: 重建持久化基准数据（用于重启验证） ---')
s_admin.post(f'{BASE}/api/reset', json={})
pause(500)

s_admin.post(f'{BASE}/api/login', json={'username':'admin','password':'admin123'})
s_teacher1.post(f'{BASE}/api/login', json={'username':'zhangsan','password':'123456'})

r = s_teacher1.post(f'{BASE}/api/makeup/requests', json={
    'type': 'swap_class',
    'course_id': 1, 'class_id': 1, 'new_class_id': 2,
    'new_date': '2026-03-25', 'new_start_time': '14:00', 'new_end_time': '16:00',
    'new_classroom_id': 2, 'hours': 2,
    'reason': '基准持久化测试：A班换B班（重启后验证存在）'
})
check(r.status_code == 200, '写基准换课申请成功')
bench_id = j(r).get('id')
bench_no = j(r).get('request_no')

r = s_admin.put(f'{BASE}/api/makeup/requests/{bench_id}/approve',
    json={'comment': '基准审批通过（重启后验证）'})
check(r.status_code == 200, f'基准单审批通过 status={j(r).get("status")}')

pause(1000)

print(f'\n    >>> 请重启服务后，验证单号 {bench_no} (ID={bench_id}) 仍为 approved 状态 <<<')

# ============== 结束 ==============
print('\n========================================')
print(f'  测试结束: PASS={passed}  FAIL={failed}')
print('========================================')

if failed > 0:
    sys.exit(1)
else:
    print('\n🎉 Python E2E 测试全部通过！')
