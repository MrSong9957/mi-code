# 路径沙箱完整加固

- **底层逻辑**：safePath 双关卡 = 词法关卡（startsWith + 尾部分隔符，防前缀碰撞 /a/sub vs /a/sub_evil）+ 真实关卡（realpath-existing-ancestor，防符号链接指向工作区外）。闸门 1（checker）覆盖 read+write+edit 三类文件工具的越界预检。workdir 真相源统一：index.ts 显式 setWorkdir(process.cwd())，checker 从 getWorkdir() 读，消除双源靠 cwd 巧合一致的漂移。附带修复 UI 渲染 bug：buildToolResultBlock 事实优先——output 为 [Blocked by permission]/Error:/[Tool Error] 时走 rawOutput 诚实展示，不让被拦截的 write_file 谎报 "Added N lines"。
- **TDD 测试点**：①前缀碰撞（兄弟目录真实建在磁盘上，破坏关卡 1 必须 RED）；②符号链接逃逸（外部软链路径必须抛错，Windows EPERM 自动 skip）；③未创建深层文件不误伤；④read_file 越界读 checker 必须 deny（双断言：decision + 磁盘 existsSync 无文件）；⑤read 正向基线不回归（读已存在文件仍 allow）；⑥write_file/edit_file 被拦截时走 rawOutput 不算行数（AAA：构造 Blocked output，断言 rawOutput 含拦截文本 + linesAdded undefined）。
- **失败原因**：①反假测试自检抓出 fixture 盲区——初版前缀碰撞用例未把 `_evil` 兄弟目录建在磁盘上，realpath 回溯退化到 workdir 自身，关卡 2 不抛错，破坏关卡 1 也假绿。修复：mkdirSync 真实建兄弟目录后，破坏关卡 1（去 sep）立即 RED（1 failed）。②端到端实测暴露 UI 矛盾：write_file 越界显示 "Added 1 line" 而非 Blocked——查证根因是 buildToolResultBlock 只看工具名不看 output，被拦截时仍按 input.content 算行数谎报成功；非沙箱失效（checker 直接测试 deny 正确）。
- **验证结果**：L1 路径沙箱 7 passed | 2 skipped；L1 权限执行 9 passed；L1 block-format 32 passed；L2 UI 目录 89 passed；L2 全回归 79 passed | 2 skipped；L3 全量 109 文件 1141 passed | 2 skipped，零回归；tsc --noEmit EXIT 0。反假自检①：破坏 isWithin 去 sep → 前缀碰撞 RED（1 failed），恢复 → GREEN。反假自检②：破坏 isNonSuccessOutput 返 false → 拦截用例 RED（7 failed），恢复 → GREEN。

