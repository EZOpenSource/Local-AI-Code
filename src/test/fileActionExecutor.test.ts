import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { it } from 'node:test';

const makeUri = (fsPath: string) => ({
  fsPath,
  path: fsPath,
  scheme: 'file',
});

it('applies file actions with optional approval', async () => {
  const approvals: string[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const deletes: string[] = [];
  const directories: string[] = [];
  const output: string[] = [];
  const files = new Map<string, string>([
    [path.join('/repo', 'src', 'existing.ts'), 'initial'],
    [path.join('/repo', 'src', 'to-remove.ts'), 'temp'],
  ]);

  const vscodeMock = {
    window: {
      activeTextEditor: undefined,
      async showWarningMessage() {
        return approvals.shift() ?? 'Approve';
      },
      showTextDocument: async () => undefined,
      showErrorMessage: () => undefined,
    },
    workspace: {
      workspaceFolders: [{ uri: makeUri('/repo'), name: 'repo' }],
      fs: {
        async createDirectory(uri: { fsPath: string }) {
          directories.push(uri.fsPath);
        },
        async writeFile(uri: { fsPath: string }, data: Buffer) {
          writes.push({ path: uri.fsPath, content: data.toString() });
          files.set(uri.fsPath, data.toString());
        },
        async stat(uri: { fsPath: string }) {
          if (!files.has(uri.fsPath)) {
            throw new Error('ENOENT');
          }
          return { type: 0, ctime: 0, mtime: 0, size: Buffer.byteLength(files.get(uri.fsPath) ?? '') };
        },
        async delete(uri: { fsPath: string }) {
          deletes.push(uri.fsPath);
          files.delete(uri.fsPath);
        },
        async readFile() {
          return Buffer.from('');
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

  const originalLoad = (Module as unknown as { _load?: Function })._load;
  (Module as unknown as { _load?: Function })._load = function (request: string, parent: unknown, isMain: unknown) {
    if (request === 'vscode') {
      return vscodeMock;
    }
    return originalLoad?.call(this, request, parent, isMain);
  };

  try {
    const { FileActionExecutor } = await import('../assistant/fileActionExecutor.js');
    const channel = {
      append: (text: string) => output.push(text),
      appendLine: (text: string) => output.push(`${text}\n`),
    };

    const executor = new FileActionExecutor(channel as any);

    await executor.apply(
      [
        { type: 'create', path: 'src/new.ts', content: 'new file' },
        { type: 'edit', path: 'src/existing.ts', content: 'updated content' },
      ],
      { requireApproval: false }
    );

    assert.deepEqual(
      writes.map(entry => [entry.path, entry.content]),
      [
        [path.join('/repo', 'src', 'new.ts'), 'new file'],
        [path.join('/repo', 'src', 'existing.ts'), 'updated content'],
      ]
    );
    assert.ok(directories.some(dir => dir.endsWith(path.join('src'))));

    writes.length = 0;
    directories.length = 0;
    approvals.push('Approve', 'Reject');

    await executor.apply(
      [
        { type: 'create', path: 'src/approved.ts', content: 'approved content' },
        { type: 'delete', path: 'src/to-remove.ts' },
      ],
      { requireApproval: true }
    );

    assert.deepEqual(writes.map(entry => entry.path), [path.join('/repo', 'src', 'approved.ts')]);
    assert.ok(files.has(path.join('/repo', 'src', 'to-remove.ts')), 'rejected delete should preserve file');
    assert.ok(deletes.length === 0, 'delete should not run when rejected');
    assert.ok(output.some(entry => entry.includes('File action rejected')));
  } finally {
    (Module as unknown as { _load?: Function })._load = originalLoad;
  }
});
