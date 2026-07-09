// AskUserManager：AI → 用户单向提问的"挂起-应答"状态机
//
// 物理本质：服务员把问题递给顾客，然后站在桌边等顾客回话。
// ask() = 递问题（贴到消息区 + 页脚提示）+ 站等（返回永不自动 resolve 的 Promise）
// resolve() = 顾客开口（handleInput 检测到 pending，把 input 喂给那个挂起的 Promise）
// cancel()  = 顾客摆手（ESC/空回车，resolve 空串让 agent 收到 "(no answer)" 继续）
//
// 关键约束：单例、一次只能有一个 pending。第二次 ask 在已有 pending 时覆盖旧
// （resolver 直接 resolve 空串），避免 agent 循环卡死。

/** 待答问题 */
export interface PendingQuestion {
  /** 调用方生成的唯一 id（用于日志/调试，单例下只有一个 pending） */
  id: string;
  /** 简短标题（页脚 hint 显示用） */
  header: string;
  /** 完整问题文本（消息区显示） */
  question: string;
  /** 可选预设选项 */
  options?: string[];
}

/** AskUserManager 注入的 UI 回调（避免直接依赖 layout/pipeline） */
export interface AskUserUI {
  /** 把一行文本固化进消息区（问题主体） */
  printLine: (text: string) => void;
  /** 设置/清除页脚提示行（"等待回答..." / undefined 清除） */
  setHint: (hint: string | undefined) => void;
}

export class AskUserManager {
  private pending: PendingQuestion | null = null;
  private resolver: ((answer: string) => void) | null = null;
  private ui: AskUserUI;

  constructor(ui: AskUserUI) {
    this.ui = ui;
  }

  /**
   * 提问并挂起等待回答。
   *
   * 立即在消息区显示问题 + 选项（如有），在页脚显示"等待回答"提示，
   * 然后返回一个 Promise，直到 resolve() 或 cancel() 被调用才 settle。
   *
   * 若已有 pending（agent 在嵌套调用），旧 pending 直接 resolve 空串，
   * 保证 agent 循环不卡死。
   */
  ask(q: PendingQuestion): Promise<string> {
    // 已有 pending：先 settle 旧的（避免泄漏 resolver）
    if (this.pending && this.resolver) {
      const oldResolver = this.resolver;
      this.pending = null;
      this.resolver = null;
      oldResolver('');
    }

    this.pending = q;

    // 渲染问题
    this.ui.printLine(`❓ ${q.question}`);
    if (q.options && q.options.length > 0) {
      q.options.forEach((opt, i) => {
        this.ui.printLine(`   ${i + 1}. ${opt}`);
      });
      this.ui.setHint(`Type option number or your answer, then Enter`);
    } else {
      this.ui.setHint(`Type your answer and press Enter`);
    }

    return new Promise<string>((resolve) => {
      this.resolver = resolve;
    });
  }

  /** 是否有 pending 问题等待回答 */
  hasPending(): boolean {
    return this.pending !== null;
  }

  /** 获取当前 pending（无则 null） */
  getPending(): PendingQuestion | null {
    return this.pending;
  }

  /**
   * 用户提交回答（handleInput 回车分支调用）。
   *
   * resolve 后清除 pending 与 hint，让 agent 循环继续。
   * 无 pending 时静默不抛错（防御性）。
   */
  resolve(answer: string): void {
    const r = this.resolver;
    this.pending = null;
    this.resolver = null;
    this.ui.setHint(undefined);
    if (r) r(answer);
  }

  /**
   * 取消 pending（resolve 空串）。
   *
   * 用于未来 ESC 键、超时、用户主动跳过等场景。
   */
  cancel(): void {
    this.resolve('');
  }
}
