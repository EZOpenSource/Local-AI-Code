import * as vscode from 'vscode';
import * as path from 'path';
import { FileAction } from '../types';

export interface FileActionProgress {
  readonly index: number;
  readonly total: number;
  readonly action: FileAction;
  readonly stage: 'start' | 'complete';
}

export interface FileActionExecutorOptions {
  requireApproval: boolean;
  token?: vscode.CancellationToken;
  onProgress?: (progress: FileActionProgress) => void;
}

export class FileActionExecutor {
  constructor(private readonly output: vscode.OutputChannel) {}

  public async apply(
    actions: FileAction[],
    options: FileActionExecutorOptions = { requireApproval: true }
  ): Promise<void> {
    const total = actions.length;
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      if (options.token?.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      options.onProgress?.({ index, total, action, stage: 'start' });
      try {
        await this.applySingle(action, options.requireApproval, options.token);
        options.onProgress?.({ index, total, action, stage: 'complete' });
      } catch (error) {
        if (error instanceof vscode.CancellationError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Failed to ${action.type} ${action.path}: ${message}`);
      }
    }
  }

  private async applySingle(
    action: FileAction,
    requireApproval: boolean,
    token?: vscode.CancellationToken
  ): Promise<void> {
    const targetUri = this.resolveUri(action.path);
    if (!targetUri) {
      throw new Error('Unable to resolve workspace path.');
    }

    const detailParts = [action.description].filter(Boolean) as string[];
    if (action.content) {
      detailParts.push(`--- Proposed content preview ---\n${action.content.slice(0, 500)}${action.content.length > 500 ? '\n... (truncated)' : ''}`);
    }
    const detail = detailParts.join('\n\n');

    if (requireApproval) {
      this.throwIfCancelled(token);
      const approval = await vscode.window.showWarningMessage(
        `Approve assistant request to ${action.type} ${action.path}?`,
        { modal: true, detail: detail || undefined },
        'Approve',
        'Reject'
      );
      this.throwIfCancelled(token);
      if (approval !== 'Approve') {
        this.output.appendLine(`File action rejected: ${action.type} ${action.path}`);
        return;
      }
    } else {
      this.output.appendLine(`Auto-applying file action: ${action.type} ${action.path}`);
      if (detail) {
        this.output.appendLine(detail);
      }
    }

    this.throwIfCancelled(token);

    switch (action.type) {
      case 'create':
        await this.createFile(targetUri, action.content ?? '', token);
        break;
      case 'edit':
        await this.editFile(targetUri, action.content ?? '', token);
        break;
      case 'delete':
        await this.deleteFile(targetUri, token);
        break;
      default:
        throw new Error(`Unsupported file action: ${action.type}`);
    }

    this.output.appendLine(`File action applied: ${action.type} ${action.path}`);
  }

  private async createFile(
    uri: vscode.Uri,
    content: string,
    token?: vscode.CancellationToken
  ): Promise<void> {
    this.throwIfCancelled(token);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    this.throwIfCancelled(token);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    this.throwIfCancelled(token);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private async editFile(
    uri: vscode.Uri,
    content: string,
    token?: vscode.CancellationToken
  ): Promise<void> {
    this.throwIfCancelled(token);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      throw new Error('Cannot edit a file that does not exist.');
    }
    this.throwIfCancelled(token);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  }

  private async deleteFile(uri: vscode.Uri, token?: vscode.CancellationToken): Promise<void> {
    this.throwIfCancelled(token);
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
  }

  private throwIfCancelled(token?: vscode.CancellationToken): void {
    if (token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
  }

  private resolveUri(filePath: string): vscode.Uri | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return null;
    }

    const normalized = path.normalize(filePath);
    const orderedFolders = this.getOrderedWorkspaceFolders(folders);
    const segments = normalized.split(/[\\/]/).filter(Boolean);

    if (path.isAbsolute(normalized)) {
      const candidate = path.normalize(normalized);
      for (const folder of orderedFolders) {
        if (this.isInsideWorkspace(candidate, folder.uri.fsPath)) {
          return vscode.Uri.file(candidate);
        }
      }

      if (segments.length > 1) {
        const [maybeWorkspace, ...rest] = segments;
        const matchingFolder = folders.find(folder => folder.name.toLowerCase() === maybeWorkspace.toLowerCase());
        if (matchingFolder && rest.length > 0) {
          const fallback = path.join(matchingFolder.uri.fsPath, ...rest);
          if (this.isInsideWorkspace(fallback, matchingFolder.uri.fsPath)) {
            return vscode.Uri.file(fallback);
          }
        }
      }

      return null;
    }

    let relativePath = normalized;
    if (segments.length > 0) {
      const targetName = segments[0].toLowerCase();
      const matchingFolder = folders.find(folder => folder.name.toLowerCase() === targetName);
      if (matchingFolder) {
        const trimmedSegments = segments.slice(1);
        if (trimmedSegments.length === 0) {
          return null;
        }
        relativePath = trimmedSegments.join(path.sep);
        const prioritized = [matchingFolder, ...orderedFolders.filter(folder => folder !== matchingFolder)];
        for (const folder of prioritized) {
          const resolved = path.join(folder.uri.fsPath, relativePath);
          if (this.isInsideWorkspace(resolved, folder.uri.fsPath)) {
            return vscode.Uri.file(resolved);
          }
        }
        return null;
      }
    }

    for (const folder of orderedFolders) {
      const resolved = path.join(folder.uri.fsPath, relativePath);
      if (this.isInsideWorkspace(resolved, folder.uri.fsPath)) {
        return vscode.Uri.file(resolved);
      }
    }

    return null;
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

  private isInsideWorkspace(targetPath: string, workspaceRoot: string): boolean {
    const normalizedRoot = path.resolve(workspaceRoot);
    const normalizedTarget = path.resolve(targetPath);
    const relative = path.relative(normalizedRoot, normalizedTarget);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }
}
