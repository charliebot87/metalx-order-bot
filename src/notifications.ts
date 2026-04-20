import type { Bot } from 'grammy';
import type { HyperionAction, FillNotification, LogExecData, LogOrderData, MarketInfo } from './types.js';
import type { IDatabase } from './types.js';
import { asLogExec, asLogOrder } from './hyperion.js';
import { formatRaw, formatAmount, formatPrice } from './markets.js';

// ─── Rate limiter ──────────────────────────────────────────────────────────────

/** Sliding-window rate limiter keyed by chat ID. */
export class RateLimiter {
  private windows = new Map<string, number[]>();
  private readonly maxPerMinute: number;

  constructor(maxPerMinute: number) {
    this.maxPerMinute = maxPerMinute;
  }

  /** Returns true if the send is allowed, recording it. */
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

function marketUrl(market: MarketInfo): string {
  return `${METALX_URL}/dex/${market.bidSymbol}_${market.askSymbol}`;
}

/**
 * Build the Telegram HTML message for a fill notification.
 *
 * For the bid_user (buyer):
 *   - Amount = bid_amount (bid token received)
 *   - Total  = bid_total  (ask token spent, inclusive of fee)
 *   - Fee    = bid_fee    (ask token)
 *
 * For the ask_user (seller):
 *   - Amount = bid_amount (bid token sold — same unit as buyer received)
 *   - Total  = ask_amount (ask token received)
 *   - Fee    = ask_fee    (ask token)
 */
export function buildFillMessage(n: FillNotification): string {
  const { market, exec, isBidUser, isFull, remaining, trxId } = n;

  // order_side: 1=taker was buying, 2=taker was selling
  // bid_user = taker, ask_user = maker (resting order)
  // If you're bid_user: your side = order_side
  // If you're ask_user: your side = opposite of order_side
  let userSide: string;
  if (isBidUser) {
    userSide = exec.order_side === 1 ? 'Buy' : 'Sell';
  } else {
    userSide = exec.order_side === 1 ? 'Sell' : 'Buy';
  }
  const emoji = isFull ? '🟢' : '🟡';
  const status = isFull ? 'Order Filled' : 'Partial Fill';
  const orderId = isBidUser ? exec.bid_user_order_id : exec.ask_user_order_id;

  const priceStr   = `${formatPrice(exec.price, market)} ${market.askSymbol}`;
  const amountStr  = `${formatRaw(exec.bid_amount, market.bidPrecision)} ${market.bidSymbol}`;

  let totalStr: string;
  let feeStr: string;

  if (isBidUser) {
    totalStr = `${formatAmount(exec.bid_total / Math.pow(10, market.askPrecision), market.askPrecision)} ${market.askSymbol}`;
    feeStr   = `${formatAmount(exec.bid_fee   / Math.pow(10, market.askPrecision), market.askPrecision)} ${market.askSymbol}`;
  } else {
    totalStr = `${formatAmount(exec.ask_amount / Math.pow(10, market.askPrecision), market.askPrecision)} ${market.askSymbol}`;
    feeStr   = `${formatAmount(exec.ask_fee   / Math.pow(10, market.askPrecision), market.askPrecision)} ${market.askSymbol}`;
  }

  const marketName = `${market.bidSymbol}/${market.askSymbol}`;

  let body: string;

  if (isFull) {
    body = [
      `${emoji} <b>${status} (${userSide})</b>`,
      '',
      `Market: <b>${marketName}</b>`,
      `Price: ${priceStr}`,
      `Amount: ${amountStr}`,
      `Total: ${totalStr}`,
      `Fee: ${feeStr}`,
      '',
      `Order #${orderId}`,
    ].join('\n');
  } else {
    const remainStr =
      remaining !== undefined
        ? `${formatRaw(remaining, market.bidPrecision)} ${market.bidSymbol}`
        : 'unknown';
    body = [
      `${emoji} <b>${status} (${userSide})</b>`,
      '',
      `Market: <b>${marketName}</b>`,
      `Amount filled: ${amountStr}`,
      `Remaining: ${remainStr}`,
      `Price: ${priceStr}`,
      '',
      `Order #${orderId}`,
    ].join('\n');
  }

  const links = [
    `<a href="${marketUrl(market)}">📊 View on Metal X</a>`,
    `<a href="${explorerLink(trxId)}">🔍 View Transaction</a>`,
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

  async send(n: FillNotification): Promise<boolean> {
    const orderId = n.isBidUser ? n.exec.bid_user_order_id : n.exec.ask_user_order_id;

    // Dedup — never send the same fill twice for the same user
    const already = await this.db.hasNotified(n.chatId, n.exec.trade_id, orderId);
    if (already) return false;

    // Rate limit
    if (!this.rateLimiter.allow(n.chatId)) {
      console.warn(`[notifications] Rate limit hit for chat ${n.chatId}`);
      return false;
    }

    const message = buildFillMessage(n);

    try {
      console.log(`[notifications] Sending fill notification: trade=${n.exec.trade_id} to chat=${n.chatId}`);
      await this.bot.api.sendMessage(n.chatId, message, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      await this.db.recordNotification(n.chatId, n.exec.trade_id, orderId, n.market.market_id);
      console.log(`[notifications] Sent successfully: trade=${n.exec.trade_id}`);
      return true;
    } catch (err) {
      // If the user blocked the bot, remove them gracefully
      const errMsg = (err as Error).message ?? '';
      if (errMsg.includes('403') || errMsg.includes('blocked')) {
        console.warn(`[notifications] User ${n.chatId} blocked bot — unlinking`);
        // Don't delete — just log. They can /start again.
      } else {
        console.error(`[notifications] Failed to send to ${n.chatId}:`, errMsg);
      }
      return false;
    }
  }

  /** Send a plain text message to a chat (for system messages like verification). */
  async sendText(chatId: string, text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (err) {
      console.error(`[notifications] sendText to ${chatId} failed:`, (err as Error).message);
    }
  }
}

// ─── Action correlator ─────────────────────────────────────────────────────────

/**
 * Given a batch of Hyperion actions (logexec + logorder), correlate them
 * by transaction ID to determine whether each logexec is a full or partial fill.
 *
 * Returns a map: trxId → { deletedOrderIds: Set<number>, orderData: Map<orderId, LogOrderData> }
 */
export interface TrxCorrelation {
  deletedOrderIds: Set<number>;
  orderUpdates: Map<number, LogOrderData>;
}

export function correlateTrx(actions: HyperionAction[]): Map<string, TrxCorrelation> {
  const result = new Map<string, TrxCorrelation>();

  function get(trxId: string): TrxCorrelation {
    if (!result.has(trxId)) {
      result.set(trxId, { deletedOrderIds: new Set(), orderUpdates: new Map() });
    }
    return result.get(trxId)!;
  }

  for (const action of actions) {
    const logOrder = asLogOrder(action);
    if (!logOrder) continue;

    const corr = get(action.trx_id);
    if (logOrder.status === 'delete') {
      corr.deletedOrderIds.add(logOrder.order.order_id);
    } else if (logOrder.status === 'update') {
      corr.orderUpdates.set(logOrder.order.order_id, logOrder);
    }
  }

  return result;
}
