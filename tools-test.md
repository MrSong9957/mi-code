# 工具测试报告

## 可用工具列表

### 1. run_bash
- **功能**: 执行shell命令并返回输出
- **参数**: command (字符串，必需)
- **示例**: `run_bash("ls -la")`

### 2. read_file
- **功能**: 读取文件内容，可限制行数
- **参数**: 
  - path (字符串，必需): 文件路径
  - limit (数字，可选): 最大行数
- **示例**: `read_file("test.txt", 10)`

### 3. write_file
- **功能**: 写入文件内容，自动创建父目录
- **参数**:
  - path (字符串，必需): 文件路径
  - content (字符串，必需): 写入内容
- **示例**: `write_file("test.txt", "内容")`

### 4. edit_file
- **功能**: 替换文件中的文本
- **参数**:
  - path (字符串，必需): 文件路径
  - old_text (字符串，必需): 要查找的文本
  - new_text (字符串，必需): 替换文本
- **示例**: `edit_file("test.txt", "旧文本", "新文本")`

### 5. todo_write
- **功能**: 创建和管理任务列表
- **参数**: items (JSON数组字符串，必需)
- **示例**: `todo_write('[{"id":"1","content":"任务","status":"pending"}]')`

### 6. background
- **功能**: 后台运行命令
- **参数**: action (字符串，必需): "run|status|list"
- **示例**: `background("run", "npm install")`

### 7. memory_write
- **功能**: 写入持久化内存
- **参数**:
  - name (字符串，必需): 内存名称
  - type (字符串，必需): 类型 (user/feedback/project/reference)
  - description (字符串，必需): 描述
  - body (字符串，必需): 内容

### 8. memory_read
- **功能**: 读取指定名称的内存
- **参数**: name (字符串，必需)

### 9. memory_list
- **功能**: 列出所有持久化内存

### 10. schedule_create
- **功能**: 创建定时任务
- **参数**:
  - cron (字符串，必需): cron表达式
  - prompt (字符串，必需): 提示内容
  - recurring (布尔值，可选): 是否重复
  - durable (布尔值，可选): 是否持久化

### 11. schedule_list
- **功能**: 列出所有定时任务

### 12. schedule_remove
- **功能**: 删除定时任务
- **参数**: schedule_id (字符串，必需)

### 13. schedule_update
- **功能**: 更新定时任务
- **参数**: schedule_id (字符串，必需)

### 14. send_message
- **功能**: 向队友发送消息
- **参数**:
  - to (字符串，必需): 队友名称
  - content (字符串，必需): 消息内容

### 15. read_inbox
- **功能**: 读取收件箱消息

### 16. create_task_matrix
- **功能**: 创建任务矩阵
- **参数**: tasks (JSON数组字符串，必需)

### 17. mark_task_done
- **功能**: 标记任务完成
- **参数**:
  - id (字符串，必需): 任务ID
  - result_summary (字符串，必需): 结果摘要

### 18. worktree
- **功能**: 管理git工作树
- **参数**: action (字符串，必需)

### 19. spawn_self_organizing
- **功能**: 生成自组织代理
- **参数**:
  - name (字符串，必需): 名称
  - role (字符串，必需): 角色
  - identity (字符串，必需): 身份描述
  - prompt (字符串，必需): 初始任务

### 20. load_skill
- **功能**: 加载技能文档
- **参数**: name (字符串，必需): 技能名称

### 21. submit_plan
- **功能**: 提交计划
- **参数**: plan (字符串，必需): 计划描述

### 22. approve_plan
- **功能**: 批准或拒绝计划
- **参数**:
  - request_id (字符串，必需): 计划请求ID
  - approve (布尔值，必需): 是否批准

### 23. respond_request
- **功能**: 响应待处理请求
- **参数**:
  - request_id (字符串，必需): 请求ID
  - approve (布尔值，必需): 是否批准

### 24. shutdown_request
- **功能**: 请求队友关闭
- **参数**: teammate (字符串，必需): 队友名称

### 25. idle
- **功能**: 进入空闲状态

## 测试状态
- [x] 工具列表展示完成
- [ ] 文件操作测试
- [ ] Bash命令测试
- [ ] 任务管理测试
- [ ] 内存工具测试

创建时间: 2026年7月3日