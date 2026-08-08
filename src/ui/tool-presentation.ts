import type { Translator } from '../locale/types.js';
import type {
  DetailItem,
  ToolPresentation,
  ToolPresentationStatus,
} from '../tui/transcript-types.js';
import { formatUnknownError } from '../utils/error-message.js';
import { buildSubagentCompletionPresentation } from './subagent-presentation.js';

const GROUPABLE_TOOLS = new Set<string>(['glob', 'grep', 'read_file']);

const TOOL_ALIASES: Record<string, string> = {
  read: 'read_file',
  search: 'glob',
};

const ERROR_PREFIX = /^\s*Error:\s*/i;

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;

const SUMMARY_MAX_LENGTH = 200;

const GROUP_TITLE_KEYS = {
  glob: {
    one: 'toolPresentation.group.glob.one',
    other: 'toolPresentation.group.glob.other',
  },
  read: {
    one: 'toolPresentation.group.read.one',
    other: 'toolPresentation.group.read.other',
  },
  default: {
    one: 'toolPresentation.group.default.one',
    other: 'toolPresentation.group.default.other',
  },
} as const;

const GLOB_FILE_COUNT_KEYS = {
  one: 'toolPresentation.count.files.one',
  other: 'toolPresentation.count.files.other',
} as const;

const GREP_MATCH_KEYS = {
  one: 'toolPresentation.grep.matches.one',
  other: 'toolPresentation.grep.matches.other',
} as const;

export interface BuildToolPresentationInput {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  output: string;
  durationMs?: number;
}

interface PresentationBase {
  toolUseId: string;
  toolName: string;
  status: ToolPresentationStatus;
}

interface StatusClassification {
  status: ToolPresentationStatus;
  errorMessage?: string;
}

export function normalizeToolName(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}

export function isGroupableTool(name: string): boolean {
  return GROUPABLE_TOOLS.has(normalizeToolName(name));
}

export function buildToolGroupTitle(
  name: string,
  count: number,
  translator: Translator,
): string {
  const normalized = normalizeToolName(name);
  const n = sanitizeCount(count);

  switch (normalized) {
    case 'glob':
    case 'grep':
      return translator.t(GROUP_TITLE_KEYS.glob[pluralKey(n)], { count: n });
    case 'read_file':
      return translator.t(GROUP_TITLE_KEYS.read[pluralKey(n)], { count: n });
    default:
      return translator.t(GROUP_TITLE_KEYS.default[pluralKey(n)], { count: n });
  }
}

export function buildToolPresentation(
  input: BuildToolPresentationInput,
  translator: Translator,
): ToolPresentation {
  const { toolUseId, toolName, input: toolInput, output, durationMs } = input;
  const normalized = normalizeToolName(toolName);
  const classification = classifyStatus(output);
  const { status } = classification;
  const errorMessage = classification.errorMessage;
  const base: PresentationBase = { toolUseId, toolName, status };

  switch (normalized) {
    case 'glob':
      return buildGlobPresentation(base, toolInput, output, errorMessage, translator);
    case 'grep':
      return buildGrepPresentation(base, toolInput, output, errorMessage, translator);
    case 'read_file':
      return buildReadFilePresentation(base, toolInput, output, errorMessage, translator);
    case 'spawn_agent':
      return buildSpawnAgentPresentation(
        base,
        toolInput,
        output,
        durationMs ?? 0,
        errorMessage,
        translator,
      );
    default:
      return buildGenericPresentation(base, toolName, output, errorMessage, translator);
  }
}

function classifyStatus(output: string): StatusClassification {
  const match = output.match(ERROR_PREFIX);
  if (match) {
    const body = output.slice(match[0].length);
    return { status: 'error', errorMessage: sanitizeErrorBody(body) };
  }

  if (output.trim() === '') {
    return { status: 'empty' };
  }

  return { status: 'success' };
}

function sanitizeErrorBody(body: string): string {
  const trimmed = body.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return formatUnknownError(parsed);
    } catch {
      return formatUnknownError(trimmed);
    }
  }

  return formatUnknownError(trimmed);
}

function buildGlobPresentation(
  base: PresentationBase,
  toolInput: Record<string, unknown>,
  output: string,
  errorMessage: string | undefined,
  translator: Translator,
): ToolPresentation {
  const pattern = asString(toolInput.pattern) ?? '<invalid pattern>';

  if (base.status === 'error') {
    return {
      ...base,
      summary: failedSummary(pattern, errorMessage, translator),
      details: [],
      errorMessage,
    };
  }

  const lines = splitNonEmptyLines(output);
  if (base.status === 'empty' || lines.length === 0) {
    return {
      ...base,
      summary: noMatchesSummary(pattern, translator),
      details: [],
    };
  }

  const details: DetailItem[] = lines.map(
    (path): DetailItem => ({ kind: 'path', path }),
  );

  return {
    ...base,
    summary: `${pattern} → ${translator.t(GLOB_FILE_COUNT_KEYS[pluralKey(lines.length)], {
      count: lines.length,
    })}`,
    details,
  };
}

function buildGrepPresentation(
  base: PresentationBase,
  toolInput: Record<string, unknown>,
  output: string,
  errorMessage: string | undefined,
  translator: Translator,
): ToolPresentation {
  const pattern = asString(toolInput.pattern) ?? '<invalid pattern>';
  const scope = asString(toolInput.path) ?? 'workspace';

  if (base.status === 'error') {
    return {
      ...base,
      summary: translator.t('toolPresentation.grep.failed', {
        pattern,
        scope,
        error: errorMessage ?? '',
      }),
      details: [],
      errorMessage,
    };
  }

  if (base.status === 'empty') {
    return {
      ...base,
      summary: translator.t('toolPresentation.grep.noMatches', { pattern, scope }),
      details: [],
    };
  }

  const lines = splitNonEmptyLines(output);
  let matches = 0;
  const details: DetailItem[] = [];

  for (const line of lines) {
    const parsed = parseGrepLine(line);
    if (parsed) {
      matches += 1;
      details.push({
        kind: 'snippet',
        text: parsed.text,
        path: parsed.path,
        line: parsed.line,
      });
      continue;
    }

    details.push({ kind: 'text', text: line });
  }

  return {
    ...base,
    summary: translator.t(GREP_MATCH_KEYS[pluralKey(matches)], {
      pattern,
      scope,
      count: matches,
    }),
    details,
  };
}

function buildReadFilePresentation(
  base: PresentationBase,
  toolInput: Record<string, unknown>,
  output: string,
  errorMessage: string | undefined,
  translator: Translator,
): ToolPresentation {
  const path = asString(toolInput.path) ?? '<invalid path>';

  if (base.status === 'error') {
    return {
      ...base,
      summary: failedSummary(path, errorMessage, translator),
      details: [],
      errorMessage,
    };
  }

  if (base.status === 'empty') {
    return { ...base, summary: path, details: [] };
  }

  return {
    ...base,
    summary: path,
    details: [{ kind: 'text', text: output }],
  };
}

function buildSpawnAgentPresentation(
  base: PresentationBase,
  toolInput: Record<string, unknown>,
  output: string,
  durationMs: number,
  errorMessage: string | undefined,
  translator: Translator,
): ToolPresentation {
  if (base.status === 'error') {
    return {
      ...base,
      summary: failedSummary('spawn_agent', errorMessage, translator),
      details: [],
      errorMessage,
    };
  }

  if (base.status === 'empty') {
    return { ...base, summary: noOutputSummary('spawn_agent', translator), details: [] };
  }

  const sub = buildSubagentCompletionPresentation(toolInput, output, durationMs);
  if (sub) {
    return {
      ...base,
      summary: sub.line.startsWith('● ') ? sub.line.slice(2) : sub.line,
      details: sub.fullOutput ? [{ kind: 'text', text: sub.fullOutput }] : [],
      layout: 'compact-completion',
    };
  }

  return {
    ...base,
    summary: summarizeOutput(output),
    details: [{ kind: 'text', text: output }],
  };
}

function buildGenericPresentation(
  base: PresentationBase,
  toolName: string,
  output: string,
  errorMessage: string | undefined,
  translator: Translator,
): ToolPresentation {
  if (base.status === 'error') {
    return {
      ...base,
      summary: failedSummary(toolName, errorMessage, translator),
      details: [],
      errorMessage,
    };
  }

  if (base.status === 'empty') {
    return { ...base, summary: noOutputSummary(toolName, translator), details: [] };
  }

  return {
    ...base,
    summary: summarizeOutput(output),
    details: [{ kind: 'text', text: output }],
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function splitNonEmptyLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseGrepLine(
  line: string,
): { path: string; line: number; text: string } | null {
  const match = line.match(/^(.+):(\d+): ?(.*)$/);
  if (!match) return null;

  const [, path, lineNo, text] = match;
  return {
    path: path!,
    line: Number(lineNo!),
    text: text!,
  };
}

function summarizeOutput(output: string): string {
  const cleaned = output.replace(ANSI_ESCAPE, '');
  const firstLine = splitNonEmptyLines(cleaned)[0] ?? '';
  return firstLine.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX_LENGTH);
}

function sanitizeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

function pluralKey(count: number): 'one' | 'other' {
  return count === 1 ? 'one' : 'other';
}

function failedSummary(
  subject: string,
  errorMessage: string | undefined,
  translator: Translator,
): string {
  return translator.t('toolPresentation.status.failed', {
    subject,
    error: errorMessage ?? '',
  });
}

function noMatchesSummary(subject: string, translator: Translator): string {
  return translator.t('toolPresentation.status.noMatches', { subject });
}

function noOutputSummary(subject: string, translator: Translator): string {
  return translator.t('toolPresentation.status.noOutput', { subject });
}
