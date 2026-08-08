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
    },
  },
  cli: {
    placeholder: 'CLI',
  },
  errors: {
    placeholder: 'Error',
  },
  confirmation: {
    greetByName: 'Hello, {name}!',
  },
  help: {
    placeholder: 'Help',
  },
  status: {
    fallbackDemo: '',
  },
  spinner: {
    placeholder: 'Working',
  },
  overlay: {
    placeholder: 'Overlay',
  },
  permission: {
    placeholder: 'Permission',
    header: 'Permission',
    question: 'Allow this action?\n\nTool: {tool}\nReason: {reason}',
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
  tool: {
    placeholder: 'Tool',
  },
  ask: {
    placeholder: 'Ask',
  },
  subagent: {
    placeholder: 'Subagent',
  },
  agent: {
    responseLanguagePreference: 'Always respond in English.',
  },
};
