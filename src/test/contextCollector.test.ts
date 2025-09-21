import assert from 'node:assert/strict';
import Module from 'node:module';
import { it } from 'node:test';

const makeUri = (fsPath: string) => ({
  fsPath,
  path: fsPath,
  scheme: 'file',
  toString: () => fsPath,
});

it('prioritizes changed files and forwards custom exclude globs', async () => {
  const changedUri = makeUri('/repo/src/changed.ts');
  const otherUri = makeUri('/repo/src/other.ts');
  let capturedExcludePattern: { pattern?: string } | undefined;

  const vscodeMock = {
    workspace: {
      workspaceFolders: [{ uri: makeUri('/repo'), name: 'repo' }],
      textDocuments: [],
      getWorkspaceFolder: () => ({ uri: makeUri('/repo'), name: 'repo' }),
      fs: {
        async stat() {
          return { type: 0, ctime: 0, mtime: 0, size: 10 };
        },
        async readFile(uri: { fsPath: string }) {
          return Buffer.from(`content of ${uri.fsPath}`);
        },
      },
      async findFiles(_include: unknown, exclude: any) {
        capturedExcludePattern = exclude;
        return [otherUri];
      },
    },
    window: {
      activeTextEditor: undefined,
    },
    RelativePattern: class {
      constructor(public base: unknown, public pattern: string) {}
    },
    Uri: {
      file: makeUri,
    },
    extensions: {
      getExtension: () => ({
        isActive: true,
        exports: {
          getAPI: () => ({
            repositories: [
              {
                state: {
                  workingTreeChanges: [{ uri: changedUri }],
                  indexChanges: [],
                  mergeChanges: [],
                },
              },
            ],
          }),
        },
      }),
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
    const { ContextCollector } = await import('../assistant/contextCollector.js');
    const collector = new ContextCollector({
      maxFiles: 5,
      maxFileSize: 1024,
      maxTotalSize: 4096,
      includeBinary: false,
      excludeGlobs: ['**/*.log'],
      useDefaultExcludes: true,
      prioritizeChangedFiles: true,
    });

    const context = await collector.collect();
    assert.ok(context.includes('### File: src/changed.ts (changed)'), 'changed file should be labelled');
    assert.ok(
      context.indexOf('src/changed.ts') < context.indexOf('src/other.ts'),
      'changed files should appear before other files'
    );
    assert.ok(capturedExcludePattern);
    const pattern = String(capturedExcludePattern?.pattern ?? '');
    assert.ok(pattern.includes('**/.git/**'), 'default excludes should be forwarded');
    assert.ok(pattern.includes('**/*.log'), 'custom exclude glob should be forwarded');
  } finally {
    (Module as unknown as { _load?: Function })._load = originalLoad;
  }
});
