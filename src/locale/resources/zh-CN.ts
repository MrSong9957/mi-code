export const zhCN = {
  commands: {
    placeholder: '命令',
    groups: {
      config: '配置',
      mode: '模式',
      skills: '技能',
      session: '会话',
    },
    help: {
      title: '可用命令：',
    },
    suggestions: {
      config: '查看或设置配置',
      login: '为提供商设置 API Key',
      provider: '切换提供商',
      model: '切换模型',
      theme: '切换主题',
      language: '查看当前语言或切换界面语言',
      build: '标准模式：写操作需确认',
      plan: '计划模式：只读',
      auto: '自动模式：允许全部操作',
      skill: '管理技能',
      trigger: '触发或屏蔽技能',
      y: '确认待处理技能',
      n: '跳过待处理技能',
      edit: '对待处理技能补充反馈',
      compact: '触发上下文压缩',
      image: '附加图片（文件或剪贴板）',
      help: '显示可用命令',
    },
    language: {
      current: '当前语言：{language}。支持：{supported}。',
      updated: '语言已切换为 {language}。',
      unsupported: '不支持的语言：{language}。支持：{supported}。',
      persistError: '保存语言 {language} 失败：{error}',
      noRuntime: '无可用语言运行时。',
    },
    compact: {
      triggered: '已触发压缩。让 Agent 执行任务，它会在需要时自动压缩。',
    },
    unknown: '未知命令：/{name}。输入 /help 查看可用命令。',
    skill: {
      unknown: '未知技能命令：/{name}',
      noRegistry: '无可用技能注册表。',
      noNegotiator: '无可用的技能协商器。',
      blocked: '技能 "{name}" 已屏蔽。',
      retryEnabled: '技能 "{name}" 重试已启用。',
      noSystem: '无可用技能系统。',
      notFound: '未找到技能 "{name}"。',
    },
    confirmation: {
      noPending: '没有待处理的确认。',
      // 前导空格刻意保留：作为反馈文本的后缀，与前面的确认文本拼接。
      feedbackSuffix: ' 反馈：{feedback}',
    },
    config: {
      currentHeader: '当前配置：',
      noProviders: '尚未配置任何提供商。使用 /login <provider> 添加一个。',
      defaultProviderSet: '默认提供商已设置为：{value}',
      plansDirectorySet: 'plansDirectory 已设置为：{value}',
      unknownKey: '未知的配置项：{key}',
    },
    login: {
      saved: '已为 {provider} 保存 API Key。使用 /provider {provider} 激活。',
    },
    provider: {
      current: '当前提供商：{provider}',
      switched: '已切换到提供商：{provider}',
    },
    model: {
      current: '当前模型：{model}',
      set: '模型已设置为：{model}（{provider}）',
    },
    mode: {
      set: '权限模式已切换为：{mode}',
    },
    theme: {
      switched: '已切换到主题 {theme}',
    },
  },
  cli: {
    placeholder: '命令行',
    noSessions: '未找到会话。',
    sessionsHeader: '会话（最近优先）：',
    resumeHintFooter: '\n使用以下命令恢复：micode --resume <id>  或  micode --continue',
    resumedMessages: '── 已恢复 {count} 条消息 ──',
    pendingPermissionExpired: '── 来自上一会话的 {count} 个待处理权限决策已过期（操作快照无法重新验证）──',
    resumeHintLabel: '使用以下命令恢复本次会话：',
    sessionCount: '（{count} 条消息）',
  },
  errors: {
    placeholder: '错误',
    unserializable: '[无法序列化的错误对象]',
    errorPrefix: '[错误] ',
    emptyResponse: '[警告] API 返回空响应，没有生成任何内容。',
    emptyResponseVision: '[警告] API 返回空响应。该模型可能不支持图片输入（vision）。请换用支持 vision 的模型。',
    persistenceFailed: '最终回复落盘失败：{error}',
  },
  confirmation: {
    greetByName: '你好，{name}！',
  },
  help: {
    placeholder: '帮助',
  },
  status: {
    fallbackDemo: '使用中文回退',
    connecting: '连接中',
    selectModel: '选择模型',
    modelSwitched: '已切换到模型：{label}（{value}）',
    noApiKey: '[错误] {provider} provider 缺少 API Key。请使用 /login {provider} <key> 配置。',
    rewindNotice: '── 上一条消息已撤回 ──',
    overlayTitleThinking: '思考',
    overlayTitleToolResult: '工具结果',
    turnFinal: {
      partialLine: '⚠ 部分完成',
      failedLine: '✖ 失败',
      cancelledLine: '○ 已取消',
    },
  },
  spinner: {
    placeholder: '处理中',
    thinking: '思考中',
    thinkingWithEffort: '思考中 {effort}',
    thoughtFor: '思考了 {duration}',
    builtinVerbs: [
      '思考', '分析', '推理', '构建', '组织', '编写',
      '调试', '审查', '探索', '搜索', '读取', '解析',
      '计算', '验证', '测试', '规划', '设计', '重构',
      '优化', '编译', '部署', '查询', '匹配', '汇总',
      '生成', '转换', '追踪', '监听', '协调', '整理',
      '校对', '打磨',
    ],
  },
  overlay: {
    placeholder: '覆盖层',
    submit: '提交',
    submitAnswers: '提交答案',
    cancel: '取消',
    unansweredWarning: '请先完成所有问题再提交',
    otherDefault: '其他',
    chatAction: '与 Agent 讨论此问题',
    submitHint: 'Enter 提交 · Esc 取消本次访谈',
    inputModeHint: 'Enter 保存 · Esc 取消本次访谈',
    navigationHint: '↑↓ 导航 · Enter 选择 · Esc 取消本次访谈',
  },
  planApproval: {
    placeholder: '计划审批',
    // state.request.otherLabel 为 null 时的 fallback（仅此固定文案本地化；
    // Agent 提供的 otherLabel 保持 RAW 不翻译）。
    otherDefault: '提出修改意见',
    chatAction: '与 Agent 讨论此计划',
    inputModeHint: 'Enter 保存修改意见 · Esc 取消',
    navigationHint: '↑↓ 导航 · Enter 选择 · Esc 取消',
    title: '准备开始编码？',
    intro: '以下是 Agent 拟定的计划：',
    noPlanBody: '未找到计划正文',
    prompt: 'Agent 已完成计划，是否继续执行？',
    // exit_plan_mode 工具构造的固定审批问卷（程序固定 UI，非模型内容）。
    // question/label/description/otherLabel 随 locale 翻译；决策映射只读稳定 value。
    tool: {
      question: 'Claude 已拟定执行方案，是否继续？',
      otherLabel: '提出修改意见',
      autoClearLabel: '确认执行，清空上下文并使用自动模式',
      autoClearDescription: '重置对话（已占用 {usage}%），Agent 自动执行所有修改',
      autoKeepLabel: '确认执行，使用自动模式',
      autoKeepDescription: '保留当前上下文，Agent 自动执行所有修改',
      buildKeepLabel: '确认执行，手动审核修改',
      buildKeepDescription: '保留当前上下文，每步修改需你确认',
    },
  },
  permission: {
    placeholder: '权限',
    header: '权限',
    question: '允许执行此操作吗？\n\n工具：{tool}\n原因：{reason}',
    reasons: {
      commandUnresolvableVar: 'Bash 命令包含无法解析的变量，需要审核',
    },
    options: {
      allowOnce: {
        label: '允许一次',
        description: '仅执行这一次，不记住此选择。',
      },
      allowExactSession: {
        label: '本会话允许此精确操作',
        description: '立即执行，并在本会话中记住这个精确操作。',
      },
      allowAlways: {
        label: '始终允许',
        description: '立即执行并持久允许；仍会重新检查硬拒绝规则。',
      },
      reject: {
        label: '拒绝',
        description: '不执行此操作。',
      },
    },
  },
  toolPresentation: {
    group: {
      glob: {
        one: '搜索了 {count} 个模式',
        other: '搜索了 {count} 个模式',
      },
      read: {
        one: '读取了 {count} 项',
        other: '读取了 {count} 项',
      },
      default: {
        one: '运行了 {count} 个操作',
        other: '运行了 {count} 个操作',
      },
    },
    // 确定性语义摘要：仅依据工具名 + 输入推导，禁止解析命令文本或猜测路径形状。
    // read_file 仅 path === '.'（工作区根目录）判定为目录读取；其余路径保留既有读取摘要。
    semantic: {
      memory: '检查了记忆',
      readDirectory: '读取了项目结构',
    },
    status: {
      cancelled: '{subject} → 已取消',
      failed: '{subject} → 失败：{error}',
      noMatches: '{subject} → 无匹配',
      noOutput: '{subject} → 无输出',
    },
    count: {
      files: {
        one: '{count} 个文件',
        other: '{count} 个文件',
      },
    },
    grep: {
      matches: {
        one: '{pattern} 在 {scope} 中 → {count} 个匹配',
        other: '{pattern} 在 {scope} 中 → {count} 个匹配',
      },
      noMatches: '{pattern} 在 {scope} 中 → 无匹配',
      failed: '{pattern} 在 {scope} 中 → 失败：{error}',
    },
  },
  tool: {
    placeholder: '工具',
  },
  ask: {
    placeholder: '提问',
    presentation: {
      answered: {
        one: '已回答 {count} 个问题',
        other: '已回答 {count} 个问题',
      },
      declinedSummary: '已拒绝回答',
      declinedLine: '用户拒绝回答问题',
      feedbackSummary: '反馈：{feedback}',
      noAnswer: '（未回答）',
    },
  },
  subagent: {
    placeholder: '子代理',
    presentation: {
      status: {
        finished: '已完成',
        incomplete: '未完成',
        unverified: '未验证',
        dispatched: '已派发',
        partial: '部分完成',
        failed: '失败',
        cancelled: '已取消',
        unknown: '未知',
      },
      duration: {
        seconds: '{count} 秒',
        minutes: '{count} 分',
        minutesSeconds: '{minutes} 分 {seconds} 秒',
      },
    },
    // description 与 prompt 均无意义时的 label 回退。
    agentFallback: '代理',
    // 状态行类别标签（`● <label> "<label>" <status> · <dur>` 的前缀词）。
    // 与 agentFallback（名词 `代理`，作 label 兜底）区分：这里用 `子代理` 作为
    // 状态行起始的类别词，与「●」glyph 组合构成"子代理事件"语义。
    statusLineLabel: '子代理',
  },
  thinking: {
    summary: '思考了 {seconds} 秒',
    // thinking_start 的临时行标签(spinner 占位)。
    tempLabel: '思考中…',
    // thinking 无 delta 时的占位;前导 2 空格刻意保留(与 buildThinkingFullLines 的
    // has-content 分支 `  ${l}` 缩进对齐,INDENT.nested 之上再加一级视觉缩进)。
    noContent: '  （无思考内容）',
  },
  agent: {
    responseLanguagePreference:
      '默认使用中文回复自然语言内容；用户明确要求其他回复语言时，以用户要求为准；项目规则另有要求时，以项目规则为准。',
  },
};
