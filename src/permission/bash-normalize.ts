// 归一化检测：把 bash 命令经 shell-quote tokenize 后重拼，消除引号拼接混淆
//
// 物理本质（保姆级）：
// isDangerousBash 用正则找 "rm" 这种关键词，像安检员看行李标签。
// AI 用引号把标签撕开重贴——'r''m'——正则看到三个片段，找不到连续 "rm"。
// 归一化 = 安检员先把行李里的东西拼回原样再看。
// shell-quote 的 tokenizer 会把 'r''m' 合并成 "rm"，混淆就被拆穿。
//
// 为什么不用 tree-sitter（真 AST）：
// 调研结论——四种混淆攻击里只有引号拼接是真缺口（其余已被 Phase 1-2 拦），
// shell-quote（已是依赖，零新增）的 tokenizer 正好解这个唯一缺口。
// tree-sitter native 在 Windows 是负债（无预编译），web-tree-sitter 加 WASM 依赖，
// 都是杀鸡用牛刀。若未来混淆攻击面扩大，再升级到 tree-sitter。

import { parse } from 'shell-quote';

/**
 * 把 bash 命令经 shell-quote tokenize 后重拼成归一化字符串
 *
 * 关键能力：引号拼接合并。'r''m' → rm，'s''u''d''o' → sudo。
 * 这样 isDangerousBash 的正则就能抓到被引号断开的危险词。
 *
 * 算法：
 *   1. parse(command) → token 数组（shell-quote 自动合并相邻引号串：'r''m' → "rm"）
 *   2. 字符串 token：各自保留，空格 join
 *   3. operator 对象（{op:'>'}）：还原成原文
 *   4. 其他特殊 token：String() 保留
 *   5. parse 失败 → 返回原始 command（保守，不假报危险，由别处处理）
 *
 * 返回值：归一化后的命令字符串（非原始输入）
 */
export function normalizeBashForCheck(command: string): string {
  let tokens: ReturnType<typeof parse>;
  try {
    tokens = parse(command);
  } catch {
    // parse 失败（畸形 ${} 等）——保守返回原文，不假报危险
    // 这种情况会被 extractBashPaths 的 parseFailed 路径走 ask
    return command;
  }

  const parts: string[] = [];

  for (const tok of tokens) {
    if (typeof tok === 'string') {
      // shell-quote 已把相邻引号串合并成单 token（'r''m' → "rm"）。
      // 但空格分隔的独立参数（rm、-rf、/）是不同 token，各自 push、用空格 join。
      parts.push(tok);
    } else if (tok !== null && typeof tok === 'object' && 'op' in tok) {
      // operator 对象：还原成原文（>、>>、<、|、&&、;）
      const op = (tok as { op: string }).op;
      parts.push(op);
    } else {
      // 其他特殊 token（{glob}/{rule}/{comment}）：保留表示
      parts.push(String(tok));
    }
  }

  return parts.join(' ');
}
