import type { CanonicalResources } from '../types.js';

export const enUS: CanonicalResources = {
  commands: {
    placeholder: 'Commands',
    groups: {
      config: 'Config',
      mode: 'Mode',
      skills: 'Skills',
      session: 'Session',
    },
    help: {
      title: 'Available commands:',
    },
    suggestions: {
      config: 'Show or set configuration',
      login: 'Set API key for a provider',
      provider: 'Switch provider',
      model: 'Switch model',
      theme: 'Switch theme',
      language: 'Show current language or switch UI language',
      build: 'Standard mode: writes ask confirmation',
      plan: 'Plan mode: read-only',
      auto: 'Auto mode: everything allowed',
      skill: 'Manage skills',
      trigger: 'Trigger or block a skill',
      y: 'Confirm pending skill',
      n: 'Skip pending skill',
      edit: 'Feedback on pending skill',
      compact: 'Trigger context compaction',
      image: 'Attach image (file or clipboard)',
      help: 'Show available commands',
    },
    language: {
      current: 'Current language: {language}. Supported: {supported}.',
      updated: 'Language switched to {language}.',
      unsupported: 'Unsupported language: {language}. Supported: {supported}.',
      persistError: 'Failed to save language {language}: {error}',
      noRuntime: 'No language runtime available.',
    },
    compact: {
      triggered: 'Compaction triggered. Use the agent to run a task and it will auto-compact when needed.',
    },
    unknown: 'Unknown command: /{name}. Type /help for available commands.',
    skill: {
      unknown: 'Unknown skill command: /{name}',
      noRegistry: 'No skill registry available.',
      noNegotiator: 'No negotiator available.',
      blocked: 'Skill "{name}" blocked.',
      retryEnabled: 'Skill "{name}" retry enabled.',
      noSystem: 'No skill system available.',
      notFound: 'Skill "{name}" not found.',
    },
    confirmation: {
      noPending: 'No pending confirmation.',
      // Leading space is intentional: feedback suffix appended to confirmation text.
      feedbackSuffix: ' Feedback: {feedback}',
    },
    config: {
      currentHeader: 'Current configuration:',
      noProviders: '  No providers configured. Use /login <provider> to add one.',
      defaultProviderSet: 'Default provider set to: {value}',
      plansDirectorySet: 'plansDirectory set to: {value}',
      unknownKey: 'Unknown config key: {key}',
    },
    login: {
      saved: 'API Key saved for {provider}. Use /provider {provider} to activate.',
    },
    provider: {
      current: 'Current provider: {provider}',
      switched: 'Switched to provider: {provider}',
    },
    model: {
      current: 'Current model: {model}',
      set: 'Model set to: {model} (for {provider})',
    },
    mode: {
      set: 'Permission mode set to: {mode}',
    },
    theme: {
      switched: 'Theme switched to {theme}',
    },
  },
  cli: {
    placeholder: 'CLI',
    noSessions: 'No sessions found.',
    sessionsHeader: 'Sessions (most recent first):',
    resumeHintFooter: '\nResume with: micode --resume <id>  or  micode --continue',
    resumedMessages: '── resumed {count} messages ──',
    pendingPermissionExpired: '── {count} pending permission decision(s) from prior session expired (action snapshot no longer re-validatable) ──',
    resumeHintLabel: 'Resume this session with:',
    sessionCount: '({count} msgs)',
  },
  errors: {
    placeholder: 'Error',
    unserializable: '[Unserializable error object]',
    errorPrefix: '[Error] ',
    emptyResponse: '[Warning] API returned an empty response, no content was generated.',
    emptyResponseVision: '[Warning] API returned an empty response. This model may not support image input (vision). Please switch to a vision-capable model.',
    persistenceFailed: 'Failed to persist the final response: {error}',
  },
  confirmation: {
    greetByName: 'Hello, {name}!',
  },
  help: {
    placeholder: 'Help',
  },
  status: {
    fallbackDemo: '',
    connecting: 'Connecting',
    selectModel: 'Select model',
    modelSwitched: 'Model switched to: {label} ({value})',
    noApiKey: '[Error] No API Key for {provider} provider. Use /login {provider} <key> to configure.',
    rewindNotice: '── Last message rewound ──',
    overlayTitleThinking: 'Thinking',
    overlayTitleToolResult: 'Tool result',
    turnFinal: {
    currentStatus: 'Current status',
    obtainedResult: 'Result obtained',
    blockedAt: 'Failure or blocked at',
    nextStep: 'Next step',
    separator: ': ',
      success: 'Succeeded',
      partial: 'Partially completed',
      failure: 'Failed',
      none: 'None',
      taskComplete: 'Task completed',
      partialToolResultsObtained: 'Some tool results were obtained',
      partialResultsObtained: 'Some results were obtained',
      partialStepsIncomplete: 'Some steps were not completed',
      subagentIncomplete: 'Subagent incomplete: {reason}',
      retryFailedStep: 'Retry the failed step or provide missing information',
      noUsefulOutput: 'No useful output',
      retryOrAdjust: 'Retry or adjust the approach.',
    },
  },
  spinner: {
    placeholder: 'Working',
    thinking: 'thinking',
    thinkingWithEffort: 'thinking {effort}',
    thoughtFor: 'thought for {duration}',
    // NOTE: builtinVerbs 仅为资源结构对齐（CanonicalResources 形状要求 zh-CN 与 en-US
    // 都存在此字段）和资源文件独立可读而保留。运行时英文词库的唯一数据源是
    // src/tui/state/spinner-verbs.ts 的 SPINNER_VERBS 常量，spinner-verbs.ts 不再
    // 从本数组读取（避免循环依赖）。修改英文词库请改 SPINNER_VERBS，并同步更新此数组
    // 以保持文档一致。
    builtinVerbs: [
      'Thinking', 'Pondering', 'Reflecting', 'Contemplating', 'Reasoning',
      'Analyzing', 'Considering', 'Deliberating', 'Musing', 'Ruminating',
      'Crystallizing', 'Brainstorming', 'Synthesizing', 'Visualizing',
      'Conceptualizing', 'Theorizing', 'Hypothesizing', 'Interpreting',
      'Inferring', 'Deducing', 'Inducing', 'Comparing', 'Contrasting',
      'Classifying', 'Prioritizing', 'Evaluating', 'Assessing', 'Reviewing',
      'Examining', 'Inspecting', 'Questioning', 'Clarifying', 'Deciding',
      'Determining', 'Discovering', 'Uncovering', 'Recognizing', 'Recalling',
      'Remembering', 'Imagining', 'Envisioning', 'Predicting', 'Estimating',
      'Calculating', 'Debating', 'Arguing', 'Probing',
      'Crafting', 'Building', 'Creating', 'Designing', 'Constructing',
      'Generating', 'Composing', 'Shaping', 'Forging', 'Assembling',
      'Inventing', 'Developing', 'Prototyping', 'Modeling', 'Sketching',
      'Drafting', 'Writing', 'Rewriting', 'Editing', 'Refining',
      'Polishing', 'Tuning', 'Balancing', 'Arranging', 'Organizing',
      'Structuring', 'Sequencing', 'Grouping', 'Mapping', 'Charting',
      'Planning', 'Preparing', 'Designating', 'Naming', 'Defining',
      'Describing', 'Documenting', 'Explaining', 'Illustrating', 'Translating',
      'Adapting', 'Simplifying', 'Generalizing', 'Specializing', 'Personalizing',
      'Processing', 'Computing', 'Crunching', 'Parsing', 'Compiling',
      'Resolving', 'Investigating', 'Exploring', 'Working', 'Tackling',
      'Solving', 'Figuring', 'Unraveling', 'Navigating', 'Tracing',
      'Hunting', 'Digging', 'Searching', 'Scanning', 'Indexing',
      'Filtering', 'Sorting', 'Matching', 'Joining', 'Merging',
      'Splitting', 'Extracting', 'Converting', 'Encoding', 'Decoding',
      'Tokenizing', 'Validating', 'Checking', 'Testing',
      'Proving', 'Verifying', 'Measuring', 'Counting', 'Aggregating',
      'Summarizing', 'Reducing', 'Expanding', 'Transforming', 'Migrating',
      'Coding', 'Programming', 'Refactoring', 'Debugging', 'Fixing',
      'Patching', 'Branching', 'Committing',
      'Deploying', 'Releasing', 'Versioning', 'Packaging', 'Bundling',
      'Linking', 'Transpiling', 'Minifying',
      'Linting', 'Formatting', 'Typechecking', 'Annotating', 'Instrumenting',
      'Profiling', 'Benchmarking', 'Optimizing', 'Caching', 'Buffering',
      'Queueing', 'Scheduling', 'Parallelizing', 'Synchronizing', 'Locking',
      'Unlocking', 'Mounting', 'Unmounting', 'Connecting', 'Disconnecting',
      'Listening', 'Routing', 'Serving', 'Streaming', 'Uploading',
      'Downloading', 'Fetching', 'Sending', 'Receiving', 'Polling',
      'Consulting', 'Discussing', 'Collaborating', 'Coordinating', 'Delegating',
      'Negotiating', 'Communicating', 'Responding', 'Answering', 'Asking',
      'Suggesting', 'Recommending', 'Guiding', 'Helping', 'Teaching',
      'Browsing', 'Reading', 'Looking', 'Watching',
      'Noticing', 'Following', 'Leading', 'Tracking',
      'Monitoring', 'Observing', 'Waiting', 'Retrying', 'Resuming',
      'Continuing', 'Finishing', 'Completing', 'Delivering', 'Sharing',
      'Presenting', 'Demonstrating', 'Celebrating', 'Improving', 'Learning',
      'Adventuring', 'Wandering', 'Warming', 'Brewing', 'Cooking',
      'Baking', 'Churning', 'Cogitating', 'Sautéing', 'Wondering',
    ],
  },
  overlay: {
    placeholder: 'Overlay',
    submit: 'Submit',
    submitAnswers: 'Submit answers',
    cancel: 'Cancel',
    unansweredWarning: 'Please answer all questions before submitting',
    otherDefault: 'Other',
    chatAction: 'Discuss this question with the Agent',
    submitHint: 'Enter to submit · Esc to cancel',
    inputModeHint: 'Enter to save · Esc to cancel',
    navigationHint: '↑↓ to navigate · Enter to select · Esc to cancel',
  },
  planApproval: {
    placeholder: 'Plan approval',
    // Fallback when state.request.otherLabel is null (only this fixed string is
    // localized; an Agent-provided otherLabel stays RAW / untranslated).
    otherDefault: 'Suggest changes',
    chatAction: 'Discuss this plan with the Agent',
    inputModeHint: 'Enter to save feedback · Esc to cancel',
    navigationHint: '↑↓ to navigate · Enter to select · Esc to cancel',
    title: 'Ready to start coding?',
    intro: 'Here is the plan proposed by the Agent:',
    noPlanBody: 'Plan body not found',
    prompt: 'The Agent has completed the plan. Continue with execution?',
    // exit_plan_mode tool fixed approval questionnaire (program UI, not model content).
    // question/label/description/otherLabel follow locale; decision mapping reads stable value only.
    tool: {
      question: 'Claude has drafted an execution plan. Continue?',
      otherLabel: 'Suggest changes',
      autoClearLabel: 'Confirm, clear context and use auto mode',
      autoClearDescription: 'Reset the conversation ({usage}% used), Agent executes all changes automatically',
      autoKeepLabel: 'Confirm, use auto mode',
      autoKeepDescription: 'Keep current context, Agent executes all changes automatically',
      buildKeepLabel: 'Confirm, manually review changes',
      buildKeepDescription: 'Keep current context, each change needs your confirmation',
    },
  },
  permission: {
    placeholder: 'Permission',
    header: 'Permission',
    question: 'Allow this action?\n\nTool: {tool}\nReason: {reason}',
    reasons: {
      commandUnresolvableVar: 'Bash command has unresolvable variable, needs review',
    },
    options: {
      allowOnce: {
        label: 'Allow once',
        description: 'Run this action exactly once. Not remembered.',
      },
      allowExactSession: {
        label: 'Allow this exact action for this session',
        description: 'Run now and remember this exact action for this session.',
      },
      allowAlways: {
        label: 'Always allow',
        description: 'Run now and persist this permission; hard-deny rules are still re-checked.',
      },
      reject: {
        label: 'Reject',
        description: 'Do not run this action.',
      },
    },
  },
  toolPresentation: {
    group: {
      glob: {
        one: 'Searched {count} pattern',
        other: 'Searched {count} patterns',
      },
      read: {
        one: 'Read {count} item',
        other: 'Read {count} items',
      },
      default: {
        one: 'Ran {count} operation',
        other: 'Ran {count} operations',
      },
    },
    status: {
      failed: '{subject} → failed: {error}',
      noMatches: '{subject} → no matches',
      noOutput: '{subject} → no output',
    },
    count: {
      files: {
        one: '{count} file',
        other: '{count} files',
      },
    },
    grep: {
      matches: {
        one: '{pattern} in {scope} → {count} match',
        other: '{pattern} in {scope} → {count} matches',
      },
      noMatches: '{pattern} in {scope} → no matches',
      failed: '{pattern} in {scope} → failed: {error}',
    },
  },
  tool: {
    placeholder: 'Tool',
  },
  ask: {
    placeholder: 'Ask',
    presentation: {
      answered: {
        one: 'Answered {count} question',
        other: 'Answered {count} questions',
      },
      declinedSummary: 'Declined to answer',
      declinedLine: 'User declined to answer questions',
      feedbackSummary: 'Feedback: {feedback}',
      noAnswer: '(no answer)',
    },
  },
  subagent: {
    placeholder: 'Subagent',
    presentation: {
      status: {
        finished: 'finished',
        incomplete: 'incomplete',
        unverified: 'unverified',
        dispatched: 'dispatched',
        partial: 'partial',
        failed: 'failed',
        cancelled: 'cancelled',
      },
      duration: {
        seconds: '{count}s',
        minutes: '{count}m',
        minutesSeconds: '{minutes}m {seconds}s',
      },
    },
    // Label fallback when neither description nor prompt yields a meaningful line.
    agentFallback: 'Agent',
    // Status-line category label (prefix word in `● <label> "<label>" <status> · <dur>`).
    // Distinct from agentFallback (the noun used as label fallback): this is the
    // category word opening the status line, paired with the `●` glyph.
    statusLineLabel: 'Agent',
  },
  thinking: {
    summary: 'Thought for {seconds}s',
    // Temporary placeholder line for thinking_start (spinner).
    tempLabel: 'Thinking…',
    // Empty-thinking-buffer placeholder; the leading 2 spaces are intentional and
    // must match the has-content branch's `  ${l}` to keep a consistent visual
    // indent above INDENT.nested.
    noContent: '  (No thinking content received)',
  },
  agent: {
    responseLanguagePreference:
      'Use English by default for natural-language responses. If the user explicitly requests another response language, follow that request. If project rules require another response language, follow those rules.',
  },
};
