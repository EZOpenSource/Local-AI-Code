import { ConversationMessage, ConversationRole } from '../types';

export class ConversationManager {
  private history: ConversationMessage[] = [];
  private readonly maxMessages: number;

  constructor(maxMessages = 20) {
    this.maxMessages = maxMessages;
  }

  public reset(): void {
    this.history = [];
  }

  public load(history: ConversationMessage[]): void {
    if (!Array.isArray(history)) {
      return;
    }
    const filtered = history
      .filter(entry => entry && typeof entry.content === 'string' && entry.content.trim().length > 0)
      .map(entry => ({ role: entry.role, content: entry.content }));
    if (filtered.length === 0) {
      this.history = [];
      return;
    }
    if (filtered.length > this.maxMessages) {
      this.history = filtered.slice(filtered.length - this.maxMessages);
    } else {
      this.history = filtered;
    }
  }

  public push(role: ConversationRole, content: string): void {
    this.history.push({ role, content });
    if (this.history.length > this.maxMessages) {
      this.history = this.history.slice(this.history.length - this.maxMessages);
    }
  }

  public getHistory(): ConversationMessage[] {
    return [...this.history];
  }
}
