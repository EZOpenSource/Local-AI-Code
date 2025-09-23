import assert from 'node:assert/strict';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import * as fsPromises from 'node:fs/promises';
import { ResponseParser } from '../assistant/responseParser';

type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;

const testRequire = Module.createRequire(__filename);

const makeUri = (fsPath: string) => ({ fsPath, path: fsPath, scheme: 'file' });

function installVscodeMock(workspaceRoot: string): { restore: () => void } {
  const originalLoad = (Module as unknown as { _load?: ModuleLoader })._load;
  const vscodeMock = {
    window: {
      activeTextEditor: undefined,
      async showWarningMessage() {
        return 'Approve';
      },
      async showTextDocument() {
        return undefined;
      },
      showErrorMessage() {
        return undefined;
      },
    },
    workspace: {
      workspaceFolders: [{ uri: makeUri(workspaceRoot), name: path.basename(workspaceRoot) }],
      fs: {
        async createDirectory(uri: { fsPath: string }) {
          await fsPromises.mkdir(uri.fsPath, { recursive: true });
        },
        async writeFile(uri: { fsPath: string }, data: Buffer) {
          await fsPromises.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fsPromises.writeFile(uri.fsPath, data);
        },
        async stat(uri: { fsPath: string }) {
          return fsPromises.stat(uri.fsPath);
        },
        async delete(uri: { fsPath: string }) {
          await fsPromises.rm(uri.fsPath, { recursive: true, force: true });
        },
        async readFile(uri: { fsPath: string }) {
          return fsPromises.readFile(uri.fsPath);
        },
      },
      async openTextDocument(uri: { fsPath: string }) {
        return { uri };
      },
    },
    Uri: {
      file: makeUri,
    },
    CancellationError: class extends Error {},
  };

  (Module as unknown as { _load?: ModuleLoader })._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') {
      return vscodeMock;
    }
    return originalLoad?.call(this, request, parent, isMain);
  };

  return {
    restore: () => {
      (Module as unknown as { _load?: ModuleLoader })._load = originalLoad;
    },
  };
}

function loadFileActionExecutor(workspaceRoot: string): { FileActionExecutor: new (channel: any) => any; restore: () => void } {
  const { restore } = installVscodeMock(workspaceRoot);
  const modulePath = testRequire.resolve('../assistant/fileActionExecutor.js');
  delete testRequire.cache[modulePath];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const executorModule = testRequire('../assistant/fileActionExecutor.js') as typeof import('../assistant/fileActionExecutor');
  return {
    FileActionExecutor: executorModule.FileActionExecutor,
    restore: () => {
      restore();
      delete testRequire.cache[modulePath];
    },
  };
}

describe('assistant plan execution', () => {
  it('applies parsed file actions to create files', async () => {
    const workspaceRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ai-code-plan-'));
    const { FileActionExecutor, restore } = loadFileActionExecutor(workspaceRoot);
    const parser = new ResponseParser();
    const raw = JSON.stringify({
      summary: 'Create hello world script',
      message: 'Generate hello_world.py and document the workflow.',
      steps: [
        {
          title: 'Create hello_world.py',
          detail: 'Use FileActionExecutor.apply -> vscode.workspace.fs.writeFile to persist the file.',
          result: 'hello_world.py staged',
        },
      ],
      liveLog: ['FileActionExecutor.apply -> vscode.workspace.fs.writeFile will handle the write.'],
      qaFindings: [],
      testResults: [],
      commandRequests: [],
      fileActions: [
        { type: 'create', path: 'hello_world.py', content: 'print("Hello, World!")\n' },
      ],
    });

    const plan = parser.parse(raw);
    const logs: string[] = [];
    const channel = {
      append: (value: string) => {
        logs.push(value);
      },
      appendLine: (value: string) => {
        logs.push(`${value}\n`);
      },
    };

    try {
      const executor = new FileActionExecutor(channel);
      await executor.apply(plan.fileActions, { requireApproval: false });
      const content = await fsPromises.readFile(path.join(workspaceRoot, 'hello_world.py'), 'utf8');
      assert.equal(content, 'print("Hello, World!")\n');
      assert.ok(logs.some(entry => entry.includes('Auto-applying file action: create hello_world.py')));
    } finally {
      restore();
      await fsPromises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('skips writes when no file actions are provided', async () => {
    const workspaceRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ai-code-plan-'));
    const { FileActionExecutor, restore } = loadFileActionExecutor(workspaceRoot);
    const parser = new ResponseParser();
    const raw = JSON.stringify({
      summary: 'No changes required',
      message: 'Nothing to update in the workspace.',
      steps: [
        {
          title: 'Confirm no edits',
          detail: 'State that no fileActions are needed before returning an empty array.',
          result: 'No file changes recorded',
        },
      ],
      liveLog: ['No file changes required; returning empty fileActions array.'],
      qaFindings: [],
      testResults: [],
      commandRequests: [],
      fileActions: [],
    });

    const plan = parser.parse(raw);
    const channel = {
      append: () => undefined,
      appendLine: () => undefined,
    };

    try {
      const executor = new FileActionExecutor(channel);
      await executor.apply(plan.fileActions, { requireApproval: false });
      const entries = await fsPromises.readdir(workspaceRoot);
      assert.equal(entries.length, 0);
    } finally {
      restore();
      await fsPromises.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
