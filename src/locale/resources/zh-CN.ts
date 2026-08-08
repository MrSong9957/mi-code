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
    submit: 'Submit',
    submitAnswers: '提交答案',
    cancel: '取消',
    unansweredWarning: '请先完成所有问题再提交',
    otherDefault: '其他',
    chatAction: '与 Agent 讨论此问题',
    submitHint: 'Enter 提交 · Esc 取消本次访谈',
    inputModeHint: 'Enter 保存 · Esc 取消本次访谈',
    navigationHint: '↑↓ 导航 · Enter 选择 · Esc 取消本次访谈',
  },
  permission: {
    placeholder: '权限',
    header: '权限',
    question: '允许执行此操作吗？\n\n工具：{tool}\n原因：{reason}',
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
    status: {
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
      },
      duration: {
        seconds: '{count} 秒',
        minutes: '{count} 分',
        minutesSeconds: '{minutes} 分 {seconds} 秒',
      },
    },
  },
  thinking: {
    summary: '思考了 {seconds} 秒',
  },
  agent: {
    responseLanguagePreference: '请始终用中文回复。',
  },
};
