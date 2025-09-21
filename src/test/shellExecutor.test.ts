import assert from 'node:assert/strict';
import Module from 'node:module';
import { it } from 'node:test';

it('executes approved commands and skips rejected ones', async () => {
  const approvals: string[] = [];
  const output: string[] = [];

  const vscodeMock = {
    window: {
      activeTextEditor: undefined,
      async showWarningMessage() {
        return approvals.shift() ?? 'Approve';
      },
      showErrorMessage: () => undefined,
      showInformationMessage: () => undefined,
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: process.cwd(), path: process.cwd(), scheme: 'file' }, name: 'repo' }],
      getWorkspaceFolder: () => undefined,
    },
    CancellationError: class extends Error {},
  };

  const originalLoad = (Module as unknown as { _load?: Function })._load;
  (Module as unknown as { _load?: Function })._load = function (request: string, parent: unknown, isMain: unknown) {
    if (request === 'vscode') {
      return vscodeMock;
    }
    return originalLoad?.call(this, request, parent, isMain);
  };

  try {
    const { ShellExecutor } = await import('../assistant/shellExecutor.js');
    const channel = {
      append: (text: string) => {
        output.push(text);
      },
      appendLine: (text: string) => {
        output.push(`${text}\n`);
      },
    };

    const executor = new ShellExecutor(channel as any);

    approvals.push('Approve');
    const approved = await executor.runWithApproval({ command: "node -e \"console.log('hello from shell')\"" }, 'default');
    assert.ok(approved);
    assert.match(approved.stdout, /hello from shell/);
    assert.ok(output.some(entry => entry.includes('hello from shell')));

    output.length = 0;
    approvals.push('Reject');
    const rejected = await executor.runWithApproval({ command: "node -e \"console.log('should not run')\"" }, 'default');
    assert.equal(rejected, null);
    assert.ok(output.some(entry => entry.includes('Command rejected')));
  } finally {
    (Module as unknown as { _load?: Function })._load = originalLoad;
  }
});
