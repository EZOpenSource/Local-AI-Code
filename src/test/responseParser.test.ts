import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ResponseParser } from '../assistant/responseParser';

describe('ResponseParser', () => {
  it('parses minimal valid payloads', () => {
    const parser = new ResponseParser();
    const raw = JSON.stringify({
      summary: 'done',
      message: 'complete',
      steps: [
        { title: 'Collect context', detail: 'Review open files', result: 'Inspected README.md' },
        { title: 'Implement changes', outcome: 'Added new helper' },
      ],
      liveLog: ['Reviewed README.md'],
      qaFindings: ['No issues detected'],
      testResults: ['npm test — passed'],
      commandRequests: [
        { command: 'npm test', description: 'run tests' },
        { command: 'invalid', description: 123 },
      ],
      fileActions: [
        { type: 'create', path: 'src/index.ts', content: 'console.log(1);' },
        { type: 'delete', path: 'README.md' },
        { type: 'noop' },
      ],
    });

    const plan = parser.parse(raw);
    assert.equal(plan.summary, 'done');
    assert.equal(plan.message, 'complete');
    assert.deepEqual(plan.steps, [
      { title: 'Collect context', detail: 'Review open files', result: 'Inspected README.md' },
      { title: 'Implement changes', result: 'Added new helper' },
    ]);
    assert.deepEqual(plan.liveLog, ['Reviewed README.md']);
    assert.deepEqual(plan.qaFindings, ['No issues detected']);
    assert.deepEqual(plan.testResults, ['npm test — passed']);
    assert.equal(plan.commandRequests.length, 2);
    assert.equal(plan.commandRequests[0].command, 'npm test');
    assert.equal(plan.fileActions.length, 2);
    assert.deepEqual(plan.fileActions[0], {
      type: 'create',
      path: 'src/index.ts',
      content: 'console.log(1);',
    });
  });

  it('extracts JSON from code fences and loose braces', () => {
    const parser = new ResponseParser();
    const raw = `Here is the plan:\n\n\n\`\`\`json\n{\n  "summary": "summary",\n  "message": "message",\n  "commandRequests": [],\n  "fileActions": []\n}\n\`\`\``;
    const plan = parser.parse(raw);
    assert.equal(plan.summary, 'summary');
    assert.equal(plan.message, 'message');
    assert.deepEqual(plan.steps, []);
    assert.deepEqual(plan.liveLog, []);
    assert.deepEqual(plan.qaFindings, []);
    assert.deepEqual(plan.testResults, []);
  });

  it('strips reasoning tags before parsing', () => {
    const parser = new ResponseParser();
    const raw = `<think>internal notes\n- collect context\n- plan work</think>\n\n{\n  "summary": "ready",\n  "message": "execute",\n  "steps": [],\n  "liveLog": [],\n  "qaFindings": [],\n  "testResults": [],\n  "commandRequests": [],\n  "fileActions": []\n}`;

    const plan = parser.parse(raw);
    assert.equal(plan.summary, 'ready');
    assert.equal(plan.message, 'execute');
    assert.deepEqual(plan.steps, []);
  });

  it('ignores invalid step entries gracefully', () => {
    const parser = new ResponseParser();
    const raw = JSON.stringify({
      summary: 'test',
      message: 'message',
      steps: [
        { title: 'Valid step', detail: 'with detail' },
        { title: '   ' },
        42,
        null,
      ],
      liveLog: [' note one ', '', 99],
      qaFindings: [' issue found '],
      tests: [' npm run lint  failed '],
      commandRequests: [],
      fileActions: [],
    });

    const plan = parser.parse(raw);
    assert.deepEqual(plan.steps, [{ title: 'Valid step', detail: 'with detail' }]);
    assert.deepEqual(plan.liveLog, ['note one']);
    assert.deepEqual(plan.qaFindings, ['issue found']);
    assert.deepEqual(plan.testResults, ['npm run lint  failed']);
  });

  it('normalizes flexible file action payloads', () => {
    const parser = new ResponseParser();
    const raw = JSON.stringify({
      summary: 'actions',
      message: 'created files',
      steps: [],
      liveLog: [],
      qaFindings: [],
      testResults: [],
      fileActions: [
        {
          type: 'CREATE_FILE',
          file: 'src/newFile.ts',
          contents: ['export const answer = 42;', ''],
          detail: 'add new module',
        },
        {
          action: 'modify',
          path: 'src/existing.ts',
          text: 'console.log("updated");',
          notes: 'refresh log',
        },
        {
          kind: 'REMOVE-FILE',
          target: 'src/old.ts',
        },
        {
          type: 'noop',
          path: 'ignored.ts',
        },
      ],
    });

    const plan = parser.parse(raw);
    assert.deepEqual(plan.fileActions, [
      {
        type: 'create',
        path: 'src/newFile.ts',
        content: 'export const answer = 42;\n',
        description: 'add new module',
      },
      {
        type: 'edit',
        path: 'src/existing.ts',
        content: 'console.log("updated");',
        description: 'refresh log',
      },
      {
        type: 'delete',
        path: 'src/old.ts',
      },
    ]);
  });

  it('parses command requests expressed as strings', () => {
    const parser = new ResponseParser();
    const raw = JSON.stringify({
      summary: 'string commands',
      message: 'ensure command parsing',
      steps: [],
      liveLog: [],
      qaFindings: [],
      testResults: [],
      commandRequests: [
        '- mkdir project-root - create project directory',
        'Command: git init',
        'npm run lint -- --fix — run lint with autofix',
      ],
      fileActions: [],
    });

    const plan = parser.parse(raw);
    assert.deepEqual(plan.commandRequests, [
      { command: 'mkdir project-root', description: 'create project directory' },
      { command: 'git init' },
      { command: 'npm run lint -- --fix', description: 'run lint with autofix' },
    ]);
  });

  it('parses file actions expressed as strings', () => {
    const parser = new ResponseParser();
    const raw = JSON.stringify({
      summary: 'string actions',
      message: 'ensure file action parsing',
      steps: [],
      liveLog: [],
      qaFindings: [],
      testResults: [],
      commandRequests: [],
      fileActions: [
        '1. CREATE README.md - document the project',
        '* Edit src/index.ts — update entry point',
        'Delete directory dist - remove build artifacts',
      ],
    });

    const plan = parser.parse(raw);
    assert.deepEqual(plan.fileActions, [
      {
        type: 'create',
        path: 'README.md',
        description: 'document the project',
      },
      {
        type: 'edit',
        path: 'src/index.ts',
        description: 'update entry point',
      },
      {
        type: 'delete',
        path: 'dist',
        description: 'remove build artifacts',
      },
    ]);
  });

  it('throws when JSON cannot be recovered', () => {
    const parser = new ResponseParser();
    assert.throws(() => parser.parse('not json at all'));
  });

  it('recovers from trailing commas inside fenced JSON payloads', () => {
    const parser = new ResponseParser();
    const raw = '```json\n{\n  "summary": "comma support",\n  "message": "allow relaxed parsing",\n  "steps": [\n    { "title": "Context", },\n  ],\n  "liveLog": ["noted",],\n  "qaFindings": [ ],\n  "testResults": [ ],\n  "commandRequests": [ ],\n  "fileActions": [ ],\n}\n```';

    const plan = parser.parse(raw);
    assert.equal(plan.summary, 'comma support');
    assert.equal(plan.message, 'allow relaxed parsing');
    assert.deepEqual(plan.steps, [{ title: 'Context' }]);
    assert.deepEqual(plan.liveLog, ['noted']);
  });

  it('falls back to manual cleanup when jsonc-parser is unavailable', () => {
    const parser = new ResponseParser();
    (parser as unknown as { jsoncParse: null }).jsoncParse = null;
    const raw = '```json\n{\n  "summary": "fallback",\n  "message": "manual cleanup",\n  "steps": [\n    { "title": "Context", },\n  ],\n  "liveLog": ["note"],\n  "qaFindings": [],\n  "testResults": [],\n  "commandRequests": [],\n  "fileActions": []\n}\n```';

    const plan = parser.parse(raw);
    assert.equal(plan.summary, 'fallback');
    assert.equal(plan.message, 'manual cleanup');
    assert.deepEqual(plan.steps, [{ title: 'Context' }]);
    assert.deepEqual(plan.liveLog, ['note']);
  });
});
