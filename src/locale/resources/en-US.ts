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
    thinking: 'thinking',
    thinkingWithEffort: 'thinking {effort}',
    thoughtFor: 'thought for {duration}',
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
  },
  thinking: {
    summary: 'Thought for {seconds}s',
  },
  agent: {
    responseLanguagePreference: 'Always respond in English.',
  },
};
