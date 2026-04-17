---
name: git-workflow
description: Git 分支管理和提交规范指导
---

## Git 工作流规范

### 分支策略
- main: 稳定分支，只接受 PR 合并
- feat/*: 功能分支，从 main 创建
- fix/*: 修复分支，从 main 创建

### 提交规范
- 使用中文描述
- 格式：`类型：简述`
- 类型：feat / fix / refactor / docs / test / chore

### 合并规则
- 必须通过 Code Review
- squash merge 保持提交历史清晰
