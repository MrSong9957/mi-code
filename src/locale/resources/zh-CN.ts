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
  },
  errors: {
    placeholder: '错误',
  },
  confirmation: {
    greetByName: '你好，{name}！',
  },
  help: {
    placeholder: '帮助',
  },
  status: {
    fallbackDemo: '使用中文回退',
  },
  spinner: {
    placeholder: '处理中',
  },
  overlay: {
    placeholder: '覆盖层',
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
  },
  subagent: {
    placeholder: '子代理',
  },
  agent: {
    responseLanguagePreference: '请始终用中文回复。',
  },
};
