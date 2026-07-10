# 路径沙箱完整加固

- **底层逻辑**：safePath 双关卡 = 词法关卡（startsWith + 尾部分隔符，防前缀碰撞 /a/sub vs /a/sub_evil）+ 真实关卡（realpath-existing-ancestor，防符号链接指向工作区外）。闸门 1（checker）覆盖 read+write+edit 三类文件工具的越界预检。workdir 真相源统一：index.ts 显式 setWorkdir(process.cwd())，checker 从 getWorkdir() 读，消除双源靠 cwd 巧合一致的漂移。附带修复 UI 渲染 bug：buildToolResultBlock 事实优先——output 为 [Blocked by permission]/Error:/[Tool Error] 时走 rawOutput 诚实展示，不让被拦截的 write_file 谎报 "Added N lines"。
- **TDD 测试点**：①前缀碰撞（兄弟目录真实建在磁盘上，破坏关卡 1 必须 RED）；②符号链接逃逸（外部软链路径必须抛错，Windows EPERM 自动 skip）；③未创建深层文件不误伤；④read_file 越界读 checker 必须 deny（双断言：decision + 磁盘 existsSync 无文件）；⑤read 正向基线不回归（读已存在文件仍 allow）；⑥write_file/edit_file 被拦截时走 rawOutput 不算行数（AAA：构造 Blocked output，断言 rawOutput 含拦截文本 + linesAdded undefined）。
- **失败原因**：①反假测试自检抓出 fixture 盲区——初版前缀碰撞用例未把 `_evil` 兄弟目录建在磁盘上，realpath 回溯退化到 workdir 自身，关卡 2 不抛错，破坏关卡 1 也假绿。修复：mkdirSync 真实建兄弟目录后，破坏关卡 1（去 sep）立即 RED（1 failed）。②端到端实测暴露 UI 矛盾：write_file 越界显示 "Added 1 line" 而非 Blocked——查证根因是 buildToolResultBlock 只看工具名不看 output，被拦截时仍按 input.content 算行数谎报成功；非沙箱失效（checker 直接测试 deny 正确）。
- **验证结果**：L1 路径沙箱 7 passed | 2 skipped；L1 权限执行 9 passed；L1 block-format 32 passed；L2 UI 目录 89 passed；L2 全回归 79 passed | 2 skipped；L3 全量 109 文件 1141 passed | 2 skipped，零回归；tsc --noEmit EXIT 0。反假自检①：破坏 isWithin 去 sep → 前缀碰撞 RED（1 failed），恢复 → GREEN。反假自检②：破坏 isNonSuccessOutput 返 false → 拦截用例 RED（7 failed），恢复 → GREEN。

## run_bash 路径沙箱（Phase 1：解析 + 路径围栏）

- **底层逻辑**：run_bash 是"会翻墙的快递员"，能用 cat/tee/>/cp 等命令读写工作区外文件，原 file 工具围栏管不住。Phase 1 用 shell-quote 解析命令字符串，提取路径候选（重定向目标无条件提取 + verb-aware 路径参数），逐个过 isPathOutsideWorkspace。越界 deny、解析失败/变量未知 ask（不自动放行）。接入 checker 闸门1 的 run_bash 分支（isDangerousBash 之后）。
- **TDD 测试点**：①越界读 cat/cp 绝对路径与相对 .. → deny；②越界写 cp 目标/重定向>/tee → deny；③合法放行（auto 模式）cat 工作区内/ls/git commit flag 内 ///curl URL → 不被路径围栏拦；④解析失败 echo ${（shell-quote 抛 Bad substitution）→ ask；⑤变量未知 cat $STOLEN → ask；⑥副作用核对 ../leak 越界 deny 时 existsSync 确认无文件；⑦rm -rf 仍被 isDangerousBash 拦（回归保护）。
- **失败原因**：①反假测试自检抓出测试盲区——初版"curl URL 不当路径"用例没真正测 isPathCandidate 的 URL 排除（curl 非 PATH_VERB，URL 根本不进提取流程，破坏 URL 排除也不变红）。补"cat https://"用例（PATH_VERB + URL）后破坏 URL 排除立即 RED（1 failed），证明测试真能测。②shell-quote 对畸形 ${} 抛错但对奇数引号不抛（宽松处理），修正测试用 echo ${。③发现 shell-quote 破坏 Windows 反斜杠路径（C:\Users→C:Users），副作用测试改用相对路径 ../（真实攻击向量，规避平台坑）。
- **验证结果**：L1 bash-path-sandbox 26 passed；L2 全回归 8 文件 105 passed | 2 skipped；L3 全量 110 文件 1167 passed | 2 skipped，零回归；tsc EXIT 0；ESLint EXIT 0。反假自检①：破坏重定向提取（跳过 redirect target）→ 4 failed（含重定向越界检测）；反假自检②：破坏 URL 排除 → 1 failed（cat https:// 用例），恢复 → GREEN。
- **已知局限**：①shell-quote 破坏 Windows 反斜杠绝对路径（C:\ 风格），但相对路径/POSIX 路径不受影响——这是真实攻击向量的主战场；②不防网络外泄（curl -d @.env）——命令问题，留 Phase 3/4；③不防代码解释器逃逸（python -c）；④不深度解析子 shell（$() 已由 isDangerousBash 兜底）。
- **后续 Phase**：Phase 2（层6 tree-kill 进程终止+输出上限）、Phase 3（层4 tree-sitter AST 注入检测）、Phase 4（层5 sandbox-runtime OS 沙箱）。

