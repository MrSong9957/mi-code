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

## run_bash 进程控制（Phase 2：进程终止 + 资源限制）

- **底层逻辑**：spawnSync 超时只杀直接子进程（cmd.exe），孙进程（dev server）变孤儿泄漏。Phase 2 改 spawnSync→异步 spawn + 手动 setTimeout + killProcessTree 做全楼清场（taskkill /T /F 杀整棵进程树）。输出 maxBuffer 崩溃改流式截断（累计 1MB 后追加 '... (truncated)'，不杀进程、不 pause 流防 backpressure）。复用 background-manager 的 spawn+close+error 模式与 Encoder.decodeBuffer（GBK 回退）。
- **TDD 测试点**：①killProcessTree 单元——长驻 node 进程/shell 包装 cmd→node 孙进程，杀后 process.kill(pid,0) 抛错确认死透（AAA 实体核对副作用）；②流式截断——2MB 输出含 '... (truncated)' + 长度≤1.1MB，小输出不截断；③正常基线——node --version/echo hello/不存在命令不破坏；④GBK 解码保留。
- **失败原因**：无功能性失败。反假自检①破坏 killProcessTree（return 空操作）→ 2 failed（进程仍存在被实体核对抓出）；反假自检②破坏截断（MAX_OUTPUT 调 100MB）→ 1 failed（2MB 不截断）。两个方向都证明测试真能测对应行为。
- **验证结果**：L1 bash-process-control 7 passed；L3 全量 111 文件 1176 passed | 2 skipped，零回归（executor 核心改动跨模块，全量必须）；tsc EXIT 0；ESLint EXIT 0。
- **研究结论**：tree-kill npm 包在 Windows 上就是 taskkill /T /F 一行包装，可靠性相同（TOCTOU 竞态），无引入价值——直接调 taskkill（数组参数无 shell，零注入）。child.kill() 只杀直接子进程，Windows 无进程组概念（process.kill(-pid) 不可用）。ToolExecutor 已是 async 契约，所有调用方已 await，spawnSync→spawn 是纯内部改动不破坏接缝。
- **已知局限**：①TOCTOU 竞态——taskkill /T 枚举后、终止前新派生孙进程可能逃脱（Windows 固有，95% 场景覆盖）；②breakaway 进程不受 /T 管辖；③唯一内核级保证是 Windows Job Object（KILL_ON_JOB_CLOSE），属 Phase 4 OS 沙箱。
- **后续 Phase**：Phase 3（层4 tree-sitter AST 注入检测）、Phase 4（层5 sandbox-runtime OS 沙箱，含 Job Object）。

## 归一化检测（Phase 3：防引号拼接混淆，原计划 AST 改名更诚实）

- **底层逻辑**：isDangerousBash 用正则找 "rm -rf" 关键词，AI 可用引号撕开标签绕过——'r''m' -rf /，正则看到 'r'、'm'、-rf 三个片段找不到连续 rm。归一化检测：shell-quote 的 tokenizer 自动把相邻引号串合并（'r''m'→"rm"），再对归一化后命令跑同一套正则，混淆被拆穿。isDangerousBash 改为原始+归一化双查（任一命中即危险），checker 与 hook 两处调用点共享同一函数自动生效。
- **关键转折**：原计划引入 tree-sitter 做 AST 检测，调研证伪——四种混淆攻击里只有引号拼接是真缺口（$VAR 已被 Phase 1 拦、$() 已被层2 正则拦、路径别名是命令策略问题），而 shell-quote（Phase 1 已引入，零新依赖）的 tokenizer 正好解这个唯一缺口。tree-sitter native 在 Windows 是负债（无预编译、node-gyp），web-tree-sitter 加 WASM 依赖，都是杀鸡用牛刀。层名从"AST 注入检测"改为"归一化检测"，诚实反映实现（token 流归一化，非真 AST）。
- **TDD 测试点**：①引号拼接攻击（'r''m'/r'm'/"r""m"/'s''u''d''o' 四种变形 → dangerous）；②正常引号不误伤（echo "hello world"/git commit -m "fix"/ls -la → safe）；③归一化器单元（合并验证 + operator 还原 + parse 失败保守返回原文）；④原始 rm -rf/sudo 仍被直接抓（回归保护，归一化是叠加非替代）。
- **失败原因**：实现初版有逻辑 bug——误把"连续字符串 token"当相邻引号串合并，导致 rm/-rf// 被拼成 rm-rf/（丢了空格）。单元测试因只断言 toContain('rm') 而蒙混过关（rm-rf 也含 rm），是集成测试（isDangerousBash 需完整 rm -rf）才抓出。修正：去掉错误合并逻辑，每个字符串 token 独立 push、空格 join（shell-quote 已在 parse 阶段合并了相邻引号串）。这印证集成层断言更严格的价值。
- **验证结果**：L1 bash-normalize 16 passed；L3 全量 112 文件 1191 passed | 2 skipped（注：history.test.ts 有 1 个 flaky 用例全量时偶发失败，单独跑 28 passed 稳定通过，与 Phase 3 改动无代码路径交集，属预先存在的时序问题）；tsc EXIT 0；ESLint EXIT 0。反假自检：破坏 normalizeBashForCheck（直接返回原文）→ 8 failed（归一化单元 + 引号拼接攻击），恢复 → GREEN。
- **诚实声明覆盖面**：✅抓引号拼接混淆；❌不抓语法正常的恶意命令（curl -d @.env，需 Phase 4 OS 沙箱）；❌不抓变量拼接（${cmd}m，但已被 Phase 1 UNRESOLVABLE_VAR 覆盖走 ask）。这是"补正则被混淆绕过的口子"，非"消灭所有注入"。
- **后续 Phase**：Phase 4（层5 OS 沙箱）。若未来混淆攻击面扩大（新绕过手法），再升级到 tree-sitter 真 AST。

