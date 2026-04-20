import type { Bot } from 'grammy';
import type { IDatabase } from './types.js';
import type { DexWithdrawal } from './hyperion.js';

// ─── Rate limiter ──────────────────────────────────────────────────────────────

export class RateLimiter {
  private windows = new Map<string, number[]>();
  private readonly maxPerMinute: number;

  constructor(maxPerMinute: number) {
    this.maxPerMinute = maxPerMinute;
  }

  allow(chatId: string): boolean {
    const now = Date.now();
    const cutoff = now - 60_000;
    const timestamps = (this.windows.get(chatId) ?? []).filter(t => t > cutoff);
    if (timestamps.length >= this.maxPerMinute) return false;
    timestamps.push(now);
    this.windows.set(chatId, timestamps);
    return true;
  }
}

// ─── Message formatting ────────────────────────────────────────────────────────

const METALX_URL = 'https://app.metalx.com';
const EXPLORER_URL = 'https://explorer.xprnetwork.org/transaction';

function explorerLink(trxId: string): string {
  return `${EXPLORER_URL}/${trxId}`;
}

/**
 * Build the Telegram HTML message for a DEX withdrawal notification.
 */
export function buildWithdrawalMessage(w: DexWithdrawal, account: string): string {
  const body = [
    `💰 <b>Order Filled</b>`,
    '',
    `Received: <b>${w.quantity}</b>`,
    `Account: <code>${account}</code>`,
  ].join('\n');

  const links = [
    `<a href="${METALX_URL}/dex">📊 View on Metal X</a>`,
    `<a href="${explorerLink(w.trxId)}">🔍 View Transaction</a>`,
  ].join('\n');

  return `${body}\n\n${links}`;
}

// ─── NotificationService ───────────────────────────────────────────────────────

export class NotificationService {
  private rateLimiter: RateLimiter;
  private bot: Bot;
  private db: IDatabase;

  constructor(bot: Bot, db: IDatabase, maxPerMinute: number) {
    this.bot = bot;
    this.db = db;
    this.rateLimiter = new RateLimiter(maxPerMinute);
  }

  async sendWithdrawal(chatId: string, w: DexWithdrawal, account: string): Promise<boolean> {
    // Dedup by global_seq (unique per action)
    const already = await this.db.hasNotified(chatId, w.globalSeq, 0);
    if (already) return false;

    if (!this.rateLimiter.allow(chatId)) {
      console.warn(`[notifications] Rate limit hit for chat ${chatId}`);
      return false;
    }

    const message = buildWithdrawalMessage(w, account);

    try {
      console.log(`[notifications] Sending withdrawal: ${w.quantity} to ${account} (chat ${chatId})`);
      await this.bot.api.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      await this.db.recordNotification(chatId, w.globalSeq, 0, 0);
      console.log(`[notifications] Sent successfully`);
      return true;
    } catch (err) {
      const errMsg = (err as Error).message ?? '';
      if (errMsg.includes('403') || errMsg.includes('blocked')) {
        console.warn(`[notifications] User ${chatId} blocked bot`);
      } else {
        console.error(`[notifications] Failed to send to ${chatId}:`, errMsg);
      }
      return false;
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (err) {
      console.error(`[notifications] sendText to ${chatId} failed:`, (err as Error).message);
    }
  }
}
