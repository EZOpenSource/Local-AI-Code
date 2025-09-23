import { AssistantPlan, FileAction, FileActionType, PlanStep, ShellCommandRequest } from '../types';

const FILE_ACTION_FILLER_WORDS = new Set(['file', 'files', 'the', 'a', 'an', 'path', 'folder', 'directory']);

type JsoncParseError = { error: number; offset: number; length: number };
type JsoncParseOptions = { allowTrailingComma?: boolean; disallowComments?: boolean };
type JsoncParse = (text: string, errors?: JsoncParseError[], options?: JsoncParseOptions) => unknown;

function loadJsoncParser(): JsoncParse | null {
  try {
    const candidate = require('jsonc-parser') as { parse?: JsoncParse } | undefined;
    if (candidate && typeof candidate.parse === 'function') {
      return candidate.parse.bind(candidate);
    }
  } catch {
    // Swallow the error – the extension can still operate with the manual fallback below.
  }
  return null;
}

export class ResponseParser {
  private readonly jsoncParse: JsoncParse | null = loadJsoncParser();
  private jsoncWarningLogged = false;

  public parse(raw: string): AssistantPlan {
    const parsed = this.safeParse(raw);
    const summary = this.expectString(parsed.summary, 'summary');
    const message = this.expectString(parsed.message, 'message', { allowEmpty: true });
    const steps = this.parseSteps(parsed.steps);
    const liveLog = this.parseStringArray(parsed.liveLog ?? parsed.workLog ?? parsed.log, 'liveLog');
    const qaFindings = this.parseStringArray(parsed.qaFindings ?? parsed.qualityFindings, 'qaFindings');
    const testResults = this.parseStringArray(
      parsed.testResults ?? parsed.tests ?? parsed.testLog ?? parsed.testOutcomes,
      'testResults'
    );
    const commandRequests = this.parseCommands(parsed.commandRequests);
    const fileActions = this.parseFileActions(parsed.fileActions);
    return {
      summary,
      message,
      steps,
      liveLog,
      qaFindings,
      testResults,
      commandRequests,
      fileActions,
    };
  }

  private safeParse(raw: string): Record<string, unknown> {
    const attempts = this.buildParseAttempts(raw);
    for (const candidate of attempts) {
      const parsed = this.tryParseStrict(candidate) ?? this.tryParseLenient(candidate);
      if (parsed) {
        return parsed;
      }
    }
    throw new Error(`Failed to parse assistant response as JSON. Received: ${raw}`);
  }

  private tryParseStrict(candidate: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(candidate);
      return this.ensureObject(parsed);
    } catch {
      return null;
    }
  }

  private tryParseLenient(candidate: string): Record<string, unknown> | null {
    if (this.jsoncParse) {
      const errors: JsoncParseError[] = [];
      const parsed = this.jsoncParse(candidate, errors, { allowTrailingComma: true, disallowComments: false });
      if (errors.length === 0) {
        return this.ensureObject(parsed);
      }
      return null;
    }

    return this.fallbackLenientParse(candidate);
  }

  private ensureObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private buildParseAttempts(raw: string): string[] {
    const attempts: string[] = [];
    const trimmed = raw.trim();
    this.pushCandidate(attempts, trimmed);

    const withoutReasoning = this.stripReasoningTags(trimmed);
    if (withoutReasoning !== trimmed) {
      this.pushCandidate(attempts, withoutReasoning);
    }

    const fenced = this.extractFromCodeFence(trimmed);
    this.pushCandidate(attempts, fenced);

    if (withoutReasoning !== trimmed) {
      const fencedWithoutReasoning = this.extractFromCodeFence(withoutReasoning);
      this.pushCandidate(attempts, fencedWithoutReasoning);
    }

    const braced = this.extractJsonObject(trimmed);
    this.pushCandidate(attempts, braced);

    if (withoutReasoning !== trimmed) {
      const bracedWithoutReasoning = this.extractJsonObject(withoutReasoning);
      this.pushCandidate(attempts, bracedWithoutReasoning);
    }

    return attempts;
  }

  private pushCandidate(attempts: string[], candidate: string | null | undefined): void {
    if (!candidate) {
      return;
    }
    const trimmed = candidate.trim();
    if (trimmed && !attempts.includes(trimmed)) {
      attempts.push(trimmed);
    }
  }

  private fallbackLenientParse(candidate: string): Record<string, unknown> | null {
    const cleaned = this.stripJsonNoise(candidate);
    if (!cleaned) {
      return null;
    }

    if (!this.jsoncWarningLogged) {
      this.jsoncWarningLogged = true;
      // eslint-disable-next-line no-console -- provide guidance when the optional dependency is missing
      console.warn(
        'jsonc-parser dependency is unavailable. Falling back to best-effort cleanup – run `npm install` to restore full JSONC parsing support.'
      );
    }

    return this.tryParseStrict(cleaned);
  }

  private stripJsonNoise(input: string): string | null {
    let withoutComments = '';
    let inString = false;
    let stringDelimiter: string | null = null;

    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      const next = input[i + 1];

      if (inString) {
        withoutComments += char;
        if (char === '\\' && i + 1 < input.length) {
          withoutComments += input[++i];
          continue;
        }
        if (char === stringDelimiter) {
          inString = false;
          stringDelimiter = null;
        }
        continue;
      }

      if (char === '"' || char === '\'') {
        inString = true;
        stringDelimiter = char;
        withoutComments += char;
        continue;
      }

      if (char === '/' && next === '/') {
        i += 1;
        while (i + 1 < input.length) {
          const lookahead = input[i + 1];
          if (lookahead === '\n' || lookahead === '\r') {
            break;
          }
          i += 1;
        }
        continue;
      }

      if (char === '/' && next === '*') {
        i += 1;
        while (i + 1 < input.length) {
          if (input[i + 1] === '*' && input[i + 2] === '/') {
            i += 2;
            break;
          }
          i += 1;
        }
        continue;
      }

      withoutComments += char;
    }

    const withoutTrailingCommas = this.removeTrailingCommas(withoutComments);
    const trimmed = withoutTrailingCommas.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private removeTrailingCommas(input: string): string {
    let result = '';
    let inString = false;
    let stringDelimiter: string | null = null;

    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      if (inString) {
        result += char;
        if (char === '\\' && i + 1 < input.length) {
          result += input[++i];
          continue;
        }
        if (char === stringDelimiter) {
          inString = false;
          stringDelimiter = null;
        }
        continue;
      }

      if (char === '"' || char === '\'') {
        inString = true;
        stringDelimiter = char;
        result += char;
        continue;
      }

      if (char === ',') {
        const nextMeaningfulIndex = this.findNextMeaningfulChar(input, i + 1);
        if (nextMeaningfulIndex !== -1) {
          const nextChar = input[nextMeaningfulIndex];
          if (nextChar === '}' || nextChar === ']') {
            continue;
          }
        }
        result += char;
        continue;
      }

      result += char;
    }

    return result;
  }

  private findNextMeaningfulChar(input: string, start: number): number {
    for (let i = start; i < input.length; i++) {
      const char = input[i];
      if (char !== ' ' && char !== '\n' && char !== '\r' && char !== '\t') {
        return i;
      }
    }
    return -1;
  }

  private extractFromCodeFence(raw: string): string | null {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (match && match[1]) {
      return match[1].trim();
    }
    if (raw.startsWith('```')) {
      const firstLineBreak = raw.indexOf('\n');
      if (firstLineBreak !== -1) {
        const afterFence = raw.slice(firstLineBreak + 1);
        const closingIndex = afterFence.lastIndexOf('```');
        const inside = closingIndex !== -1 ? afterFence.slice(0, closingIndex) : afterFence;
        const candidate = inside.trim();
        if (candidate) {
          return candidate;
        }
      }
    }
    return null;
  }

  private stripReasoningTags(input: string): string {
    if (!input) {
      return input;
    }
    const withoutThink = input.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');
    return withoutThink.replace(/<reflection>[\s\S]*?(<\/reflection>|$)/gi, '');
  }

  private extractJsonObject(raw: string): string | null {
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return null;
    }
    const candidate = raw.slice(firstBrace, lastBrace + 1).trim();
    return candidate.length > 0 ? candidate : null;
  }

  private expectString(value: unknown, field: string, options?: { allowEmpty?: boolean }): string {
    if (typeof value !== 'string') {
      throw new Error(`Assistant response field \`${field}\` is missing or empty.`);
    }
    const trimmed = value.trim();
    if (!options?.allowEmpty && trimmed.length === 0) {
      throw new Error(`Assistant response field \`${field}\` is missing or empty.`);
    }
    if (options?.allowEmpty) {
      return trimmed.length === 0 ? '' : value;
    }
    return value;
  }

  private parseCommands(value: unknown): ShellCommandRequest[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const commands: ShellCommandRequest[] = [];
    for (const entry of value) {
      if (typeof entry === 'string') {
        const parsed = this.parseCommandString(entry);
        if (parsed) {
          commands.push(parsed);
        }
        continue;
      }
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const command = 'command' in entry && typeof (entry as { command: unknown }).command === 'string'
        ? (entry as { command: string }).command.trim()
        : null;
      if (!command) {
        continue;
      }
      const description = 'description' in entry && typeof (entry as { description: unknown }).description === 'string'
        ? (entry as { description: string }).description
        : undefined;
      commands.push({ command, description });
    }
    return commands;
  }

  private parseSteps(value: unknown): PlanStep[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const steps: PlanStep[] = [];
    for (const entry of value) {
      if (typeof entry === 'string') {
        const title = entry.trim();
        if (title.length > 0) {
          steps.push({ title });
        }
        continue;
      }
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const candidate = entry as {
        title?: unknown;
        detail?: unknown;
        description?: unknown;
        result?: unknown;
        outcome?: unknown;
      };
      const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
      if (!title) {
        continue;
      }
      const detailSource =
        typeof candidate.detail === 'string' ? candidate.detail :
        typeof candidate.description === 'string' ? candidate.description :
        undefined;
      const detail = detailSource?.trim();
      const resultSource =
        typeof candidate.result === 'string' ? candidate.result :
        typeof candidate.outcome === 'string' ? candidate.outcome :
        undefined;
      const result = resultSource?.trim();
      const step: PlanStep = { title };
      if (detail) {
        step.detail = detail;
      }
      if (result) {
        step.result = result;
      }
      steps.push(step);
    }
    return steps;
  }

  private parseStringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const result: string[] = [];
    for (const entry of value) {
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (trimmed.length > 0) {
          result.push(trimmed);
        }
      }
    }
    if (result.length === 0 && value.length > 0) {
      this.warnIgnored(field);
    }
    return result;
  }

  private warnIgnored(field: string): void {
    // eslint-disable-next-line no-console -- Surface parsing quirks for debugging
    console.warn(`Assistant response field \`${field}\` contained unsupported values and was ignored.`);
  }

  private parseFileActions(value: unknown): FileAction[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const actions: FileAction[] = [];
    for (const entry of value) {
      if (typeof entry === 'string') {
        const parsed = this.parseFileActionString(entry);
        if (parsed) {
          actions.push(parsed);
        }
        continue;
      }
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const type = this.normalizeFileActionType(
        this.getFirstString(record, ['type', 'action', 'kind', 'operation'])
      );
      if (!type) {
        continue;
      }
      const rawPath = this.getFirstString(record, ['path', 'file', 'target', 'uri', 'filename', 'filePath']);
      const path = rawPath ? this.normalizeFilePath(rawPath) : '';
      if (!path) {
        continue;
      }
      const action: FileAction = { type, path };
      const content = this.extractFileContent(record);
      if (content !== undefined) {
        action.content = content;
      }
      const description = this.getFirstString(record, ['description', 'detail', 'notes', 'note', 'summary']);
      if (description) {
        action.description = description;
      }
      actions.push(action);
    }
    return actions;
  }

  private normalizeFileActionType(value: string | null): FileActionType | null {
    if (!value) {
      return null;
    }
    const lowered = value.trim().toLowerCase();
    if (!lowered) {
      return null;
    }
    const collapsed = lowered.replace(/[^a-z]/g, '');
    if (this.startsWithAny(collapsed, ['create', 'add', 'write', 'new', 'make'])) {
      return 'create';
    }
    if (this.startsWithAny(collapsed, ['edit', 'update', 'modify', 'change', 'replace', 'revise', 'patch'])) {
      return 'edit';
    }
    if (this.startsWithAny(collapsed, ['delete', 'remove', 'drop', 'unlink', 'erase'])) {
      return 'delete';
    }
    return null;
  }

  private startsWithAny(value: string, candidates: string[]): boolean {
    return candidates.some(candidate => value.startsWith(candidate));
  }

  private getFirstString(record: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const raw = record[key];
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }
    return null;
  }

  private extractFileContent(record: Record<string, unknown>): string | undefined {
    const contentKeys = ['content', 'contents', 'text', 'body', 'data', 'code', 'value'];
    for (const key of contentKeys) {
      if (!(key in record)) {
        continue;
      }
      const raw = record[key];
      if (typeof raw === 'string') {
        return raw;
      }
      if (Array.isArray(raw) && raw.every(item => typeof item === 'string')) {
        return raw.join('\n');
      }
    }
    return undefined;
  }

  private parseCommandString(value: string): ShellCommandRequest | null {
    const stripped = this.stripLeadingLabel(this.stripListPrefix(value), ['command', 'cmd', 'shell']);
    if (!stripped) {
      return null;
    }
    const [command, description] = this.splitValueAndDescription(stripped);
    if (!command) {
      return null;
    }
    return description ? { command, description } : { command };
  }

  private parseFileActionString(value: string): FileAction | null {
    const stripped = this.stripLeadingLabel(this.stripListPrefix(value), ['file action', 'file', 'action']);
    if (!stripped) {
      return null;
    }
    const tokens = stripped
      .split(/\s+/)
      .map(token => token.trim())
      .filter(token => token.length > 0);
    if (tokens.length === 0) {
      return null;
    }

    let type = this.normalizeFileActionType(tokens[0]);
    let startIndex = 1;

    if (!type && tokens.length >= 2) {
      const combined = `${tokens[0]} ${tokens[1]}`;
      type = this.normalizeFileActionType(combined);
      if (type) {
        startIndex = 2;
      }
    }

    if (!type) {
      return null;
    }

    const remainderTokens = tokens.slice(startIndex).filter(token => token.length > 0);
    while (remainderTokens.length > 0 && FILE_ACTION_FILLER_WORDS.has(remainderTokens[0].toLowerCase())) {
      remainderTokens.shift();
    }
    if (remainderTokens.length === 0) {
      return null;
    }
    const remainder = remainderTokens.join(' ');
    const [pathPart, description] = this.splitValueAndDescription(remainder);
    const path = this.normalizeFilePath(pathPart);
    if (!path) {
      return null;
    }
    const action: FileAction = { type, path };
    if (description) {
      action.description = description;
    }
    return action;
  }

  private stripListPrefix(value: string): string {
    let result = value.trim();
    result = result.replace(/^[-*•]+\s+/, '');
    result = result.replace(/^\d+[.)]\s+/, '');
    result = result.replace(/^\(\d+\)\s+/, '');
    result = result.replace(/^[a-z]\)\s+/i, '');
    return result.trim();
  }

  private stripLeadingLabel(value: string, labels: string[]): string {
    let result = value.trim();
    for (const label of labels) {
      const pattern = new RegExp(`^${label}(?:\s*[:：=-]\s*|\s+)`, 'i');
      if (pattern.test(result)) {
        result = result.replace(pattern, '').trim();
        break;
      }
    }
    return result;
  }

  private splitValueAndDescription(value: string): [string, string | null] {
    const trimmed = value.trim();
    if (!trimmed) {
      return ['', null];
    }
    const separatorMatch = /\s[-–—]\s/.exec(trimmed);
    if (!separatorMatch || separatorMatch.index === undefined) {
      return [trimmed, null];
    }
    const command = trimmed.slice(0, separatorMatch.index).trim();
    const description = trimmed.slice(separatorMatch.index + separatorMatch[0].length).trim();
    return [command, description.length > 0 ? description : null];
  }

  private normalizeFilePath(value: string): string {
    let result = value.trim();
    if (!result) {
      return '';
    }

    const wrappers: Array<[string, string]> = [
      ['"', '"'],
      ['\'', '\''],
      ['`', '`'],
      ['“', '”'],
      ['‘', '’'],
      ['«', '»'],
      ['**', '**'],
      ['*', '*'],
    ];

    let updated = true;
    while (updated) {
      updated = false;
      for (const [open, close] of wrappers) {
        if (
          result.length >= open.length + close.length &&
          result.startsWith(open) &&
          result.endsWith(close)
        ) {
          result = result.slice(open.length, result.length - close.length).trim();
          updated = true;
        }
      }
    }

    result = result.replace(/^[*`]+/, '').replace(/[*`]+$/, '').trim();

    return result;
  }
}
