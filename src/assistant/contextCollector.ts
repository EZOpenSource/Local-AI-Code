import * as vscode from 'vscode';
import * as path from 'path';

export interface ContextCollectorOptions {
  maxFiles: number;
  maxFileSize: number;
  maxTotalSize: number;
  includeBinary: boolean;
  excludeGlobs?: string[];
  useDefaultExcludes?: boolean;
  prioritizeChangedFiles?: boolean;
}

const DEFAULT_EXCLUDE_GLOBS = [
  '**/.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/out/**',
  '**/build/**',
  '**/.vscode/**',
  '**/.idea/**',
];

type GitChangeLike = { readonly uri?: vscode.Uri };

interface GitRepositoryLike {
  readonly state?: {
    readonly workingTreeChanges?: readonly GitChangeLike[];
    readonly indexChanges?: readonly GitChangeLike[];
    readonly mergeChanges?: readonly GitChangeLike[];
  };
}

interface GitApiLike {
  readonly repositories?: readonly GitRepositoryLike[];
}

export class ContextCollector {
  private readonly excludeGlobs: string[];
  private readonly prioritizeChangedFiles: boolean;

  constructor(private readonly options: ContextCollectorOptions) {
    const extras = Array.isArray(options.excludeGlobs) ? options.excludeGlobs.filter(Boolean) : [];
    const base = (options.useDefaultExcludes ?? true) ? DEFAULT_EXCLUDE_GLOBS : [];
    const merged = [...base, ...extras];
    const seen = new Set<string>();
    this.excludeGlobs = merged.filter(glob => {
      const trimmed = glob.trim();
      if (!trimmed) {
        return false;
      }
      if (seen.has(trimmed)) {
        return false;
      }
      seen.add(trimmed);
      return true;
    });
    this.prioritizeChangedFiles = options.prioritizeChangedFiles ?? true;
  }

  public async collect(token?: vscode.CancellationToken): Promise<string> {
    const { maxFiles, maxFileSize, maxTotalSize, includeBinary } = this.options;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return 'No workspace is currently open.';
    }

    const orderedFolders = this.getOrderedWorkspaceFolders(workspaceFolders);
    const includedFiles = new Set<string>();
    let totalBytes = 0;
    let appendedFiles = 0;
    const chunks: string[] = [];

    const throwIfCancelled = () => {
      if (token?.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
    };

    const enqueue = async (uri: vscode.Uri, label?: string) => {
      throwIfCancelled();
      if (appendedFiles >= maxFiles) {
        return;
      }
      if (includedFiles.has(uri.fsPath)) {
        return;
      }
      const fileStats = await vscode.workspace.fs.stat(uri);
      if (fileStats.size > maxFileSize) {
        return;
      }
      if (totalBytes + fileStats.size > maxTotalSize) {
        return;
      }
      const buffer = await vscode.workspace.fs.readFile(uri);
      if (!includeBinary && this.looksBinary(buffer)) {
        return;
      }
      const content = Buffer.from(buffer).toString('utf8');
      totalBytes += Buffer.byteLength(content, 'utf8');
      appendedFiles += 1;
      includedFiles.add(uri.fsPath);
      const relative = this.toRelativePath(uri);
      chunks.push(`### File: ${relative}${label ? ` (${label})` : ''}\n\n\u0060\u0060\u0060\n${content}\n\u0060\u0060\u0060`);
    };

    for (const doc of vscode.workspace.textDocuments) {
      throwIfCancelled();
      if (appendedFiles >= maxFiles) {
        break;
      }
      if (doc.isUntitled || doc.isDirty) {
        const fakeUri = doc.uri.scheme === 'untitled' ? vscode.Uri.file(doc.fileName) : doc.uri;
        const relative = this.toRelativePath(fakeUri);
        const text = doc.getText();
        const bytes = Buffer.byteLength(text, 'utf8');
        if (totalBytes + bytes > maxTotalSize) {
          continue;
        }
        totalBytes += bytes;
        chunks.push(`### File: ${relative} (unsaved)\n\n\u0060\u0060\u0060\n${text}\n\u0060\u0060\u0060`);
        appendedFiles += 1;
        includedFiles.add(fakeUri.fsPath);
      } else if (doc.uri.scheme === 'file') {
        try {
          await enqueue(doc.uri, 'open');
        } catch (error) {
          console.warn('Failed to include open document in context', error);
        }
      }
    }

    if (this.prioritizeChangedFiles && appendedFiles < maxFiles) {
      try {
        const changedFiles = await this.getChangedFileUris(token);
        for (const uri of changedFiles) {
          throwIfCancelled();
          if (appendedFiles >= maxFiles) {
            break;
          }
          if (uri.scheme !== 'file') {
            continue;
          }
          try {
            await enqueue(uri, 'changed');
          } catch (error) {
            console.warn('Failed to include changed file in context', error);
          }
        }
      } catch (error) {
        console.warn('Unable to prioritise changed files for context collection', error);
      }
    }

    for (const folder of orderedFolders) {
      throwIfCancelled();
      if (appendedFiles >= maxFiles) {
        break;
      }
      const includePattern = new vscode.RelativePattern(folder, '**/*');
      const excludePattern = this.excludeGlobs.length > 0
        ? new vscode.RelativePattern(folder, `{${this.excludeGlobs.join(',')}}`)
        : undefined;
      const files = await vscode.workspace.findFiles(includePattern, excludePattern, maxFiles * 5);
      for (const uri of files) {
        throwIfCancelled();
        if (appendedFiles >= maxFiles) {
          break;
        }
        if (uri.scheme !== 'file') {
          continue;
        }
        try {
          await enqueue(uri);
        } catch (error) {
          console.warn('Failed to include file in context', error);
        }
      }
    }

    const workspaceNames = workspaceFolders.map(folder => folder.name).join(', ');
    const workspaceLabel = workspaceFolders.length === 1 ? 'Workspace' : 'Workspaces';
    const summary = [`${workspaceLabel}: ${workspaceNames}`, `Files included: ${appendedFiles}`, `Total bytes: ${totalBytes}`].join('\n');
    return `${summary}\n\n${chunks.join('\n\n')}`;
  }

  private async getChangedFileUris(token?: vscode.CancellationToken): Promise<vscode.Uri[]> {
    try {
      const gitExtension = vscode.extensions.getExtension<any>('vscode.git');
      if (!gitExtension) {
        return [];
      }
      if (!gitExtension.isActive) {
        try {
          await gitExtension.activate();
        } catch (error) {
          console.warn('Failed to activate git extension for context collection', error);
          return [];
        }
      }
      const api: GitApiLike | undefined = gitExtension.exports?.getAPI?.(1);
      if (!api || !Array.isArray(api.repositories)) {
        return [];
      }
      const uris: vscode.Uri[] = [];
      const seen = new Set<string>();
      for (const repo of api.repositories) {
        if (!repo) {
          continue;
        }
        if (token?.isCancellationRequested) {
          throw new vscode.CancellationError();
        }
        const changes: GitChangeLike[] = [];
        const state = repo.state;
        if (state) {
          if (Array.isArray(state.workingTreeChanges)) {
            changes.push(...state.workingTreeChanges);
          }
          if (Array.isArray(state.indexChanges)) {
            changes.push(...state.indexChanges);
          }
          if (Array.isArray(state.mergeChanges)) {
            changes.push(...state.mergeChanges);
          }
        }
        for (const change of changes) {
          const uri = change?.uri;
          if (!uri || uri.scheme !== 'file') {
            continue;
          }
          const key = uri.fsPath;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          uris.push(uri);
        }
      }
      return uris;
    } catch (error) {
      console.warn('Failed to determine changed files for context collection', error);
      return [];
    }
  }

  private looksBinary(buffer: Uint8Array): boolean {
    const len = Math.min(buffer.length, 1000);
    for (let i = 0; i < len; i += 1) {
      const byte = buffer[i];
      if (byte === 0) {
        return true;
      }
    }
    let nonText = 0;
    for (let i = 0; i < len; i += 1) {
      const byte = buffer[i];
      if (byte < 7 || (byte > 13 && byte < 32) || byte === 127) {
        nonText += 1;
      }
    }
    return nonText / len > 0.3;
  }

  private toRelativePath(uri: vscode.Uri): string {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      return this.normalizeForDisplay(uri.fsPath);
    }
    const relative = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return this.normalizeForDisplay(uri.fsPath);
    }
    const normalized = this.normalizeForDisplay(relative);
    return normalized || this.normalizeForDisplay(path.basename(uri.fsPath));
  }

  private getOrderedWorkspaceFolders(
    folders: readonly vscode.WorkspaceFolder[]
  ): vscode.WorkspaceFolder[] {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (!activeUri) {
      return [...folders];
    }
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (!activeFolder) {
      return [...folders];
    }
    return [activeFolder, ...folders.filter(folder => folder !== activeFolder)];
  }

  private normalizeForDisplay(value: string): string {
    return value.replace(/\\+/g, '/');
  }
}
