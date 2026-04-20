import 'dotenv/config';
import { Bot } from 'grammy';
import { createDatabase } from './db/index.js';
import { MarketRegistry } from './markets.js';
import { HyperionClient, asLogExec, asLogOrder, advanceTimestamp, latestTimestamp } from './hyperion.js';
import { NotificationService, correlateTrx } from './notifications.js';
import { setupBot } from './bot.js';
import type { HyperionAction, FillNotification } from './types.js';

// ─── Config ───────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function parseEndpoints(envVar: string, defaults: string[]): string[] {
  const val = process.env[envVar];
  if (!val) return defaults;
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

const BOT_TOKEN = requireEnv('TELEGRAM_BOT_TOKEN');

const HYPERION_ENDPOINTS = parseEndpoints('HYPERION_ENDPOINTS', [
  'https://proton.protonuk.io',
  'https://proton-api.eosiomadrid.io',
  'https://api-xprnetwork-main.saltant.io',
  'https://xpr-mainnet-api.bloxprod.io',
  'https://proton-hyperion.luminaryvisn.com',
  'https://proton.eosusa.io',
]);

const RPC_ENDPOINTS = parseEndpoints('RPC_ENDPOINTS', [
  'https://api.protonnz.com',
  'https://proton.greymass.com',
]);

const POLL_INTERVAL_MS  = parseInt(process.env.POLL_INTERVAL    ?? '3000', 10);
const RATE_LIMIT        = parseInt(process.env.RATE_LIMIT        ?? '10',   10);
const MAX_STALE_SECONDS = parseInt(process.env.MAX_STALE_SECONDS ?? '300',  10);

// ─── Verification polling ──────────────────────────────────────────────────────

async function pollVerification(
  hyperion: HyperionClient,
  db: Awaited<ReturnType<typeof createDatabase>>,
  notifications: NotificationService,
): Promise<void> {
  const pending = await db.getAllPendingUsers();
  if (pending.length > 0) {
    console.log(`[verification] Checking ${pending.length} pending user(s)`);
  }

  for (const user of pending) {
    if (!user.verification_code) continue;
    const { telegram_chat_id: chatId, xpr_account: account, verification_code: code } = user;
    console.log(`[verification] Checking ${account} for code ${code}`);

    try {
      const transfers = await hyperion.getTransfers(account);
      const matched = transfers.find(t => {
        const d = t.act.data as Record<string, unknown>;
        return (
          t.act.name === 'transfer' &&
          d.from === account &&
          d.to === 'token.burn' &&
          typeof d.memo === 'string' &&
          d.memo.trim() === 'METALX-BOT'
        );
      });

      if (matched) {
        await db.verifyUser(chatId, account);
        await notifications.sendText(
          chatId,
          `✅ <b>Account verified!</b>\n\n<code>${account}</code> is now linked. You'll receive notifications for all your order fills on Metal X.`,
        );
        console.log(`[verification] Verified ${account} for chat ${chatId}`);
      }
    } catch (err) {
      console.warn(`[verification] Error checking ${account}:`, (err as Error).message);
    }
  }
}

// ─── Main polling loop ────────────────────────────────────────────────────────

async function pollDexActions(
  hyperion: HyperionClient,
  db: Awaited<ReturnType<typeof createDatabase>>,
  markets: MarketRegistry,
  notifications: NotificationService,
): Promise<void> {
  // Load checkpoint
  let checkpoint = await db.getState('last_timestamp');

  if (!checkpoint) {
    // First run — start from now
    checkpoint = new Date().toISOString();
    await db.setState('last_timestamp', checkpoint);
    console.log('[poll] First run, starting from now:', checkpoint);
    return;
  }

  // Stale protection: if checkpoint is older than MAX_STALE_SECONDS, reset
  const checkpointAge = (Date.now() - new Date(checkpoint).getTime()) / 1000;
  if (checkpointAge > MAX_STALE_SECONDS) {
    const resetTo = new Date().toISOString();
    console.warn(
      `[poll] Checkpoint is ${Math.round(checkpointAge)}s old (>${MAX_STALE_SECONDS}s), resetting to now`,
    );
    await db.setState('last_timestamp', resetTo);
    return;
  }

  let actions: HyperionAction[];
  try {
    actions = await hyperion.getDexActions(checkpoint);
  } catch (err) {
    console.error('[poll] Hyperion fetch failed:', (err as Error).message);
    return;
  }

  if (actions.length === 0) return;

  // Correlate logorder events by trx_id to know full vs partial fills
  const correlations = correlateTrx(actions);

  // Get all verified users indexed by XPR account
  const verifiedUsers = await db.getVerifiedUsers();
  const accountToChats = new Map<string, string[]>();
  for (const u of verifiedUsers) {
    const chats = accountToChats.get(u.xpr_account) ?? [];
    chats.push(u.telegram_chat_id);
    accountToChats.set(u.xpr_account, chats);
  }

  // Process each logexec action
  for (const action of actions) {
    const exec = asLogExec(action);
    if (!exec) continue;

    const market = await markets.get(exec.market_id);
    if (!market) {
      console.warn(`[poll] Unknown market_id ${exec.market_id}`);
      continue;
    }

    const corr = correlations.get(action.trx_id);

    // Notify bid_user (buyer)
    const bidChats = accountToChats.get(exec.bid_user) ?? [];
    for (const chatId of bidChats) {
      const orderId = exec.bid_user_order_id;
      const isFull = corr?.deletedOrderIds.has(orderId) ?? false;
      const logOrderUpdate = corr?.orderUpdates.get(orderId);
      const remaining = isFull ? undefined : logOrderUpdate?.order.quantity;

      const notification: FillNotification = {
        chatId,
        market,
        exec,
        isBidUser: true,
        isFull,
        remaining,
        trxId: action.trx_id,
        timestamp: action['@timestamp'],
      };

      await notifications.send(notification);
    }

    // Notify ask_user (seller) — skip if same as bid_user to avoid double-dip
    if (exec.ask_user !== exec.bid_user) {
      const askChats = accountToChats.get(exec.ask_user) ?? [];
      for (const chatId of askChats) {
        const orderId = exec.ask_user_order_id;
        const isFull = corr?.deletedOrderIds.has(orderId) ?? false;
        const logOrderUpdate = corr?.orderUpdates.get(orderId);
        const remaining = isFull ? undefined : logOrderUpdate?.order.quantity;

        const notification: FillNotification = {
          chatId,
          market,
          exec,
          isBidUser: false,
          isFull,
          remaining,
          trxId: action.trx_id,
          timestamp: action['@timestamp'],
        };

        await notifications.send(notification);
      }
    }
  }

  // Advance checkpoint to the latest timestamp seen
  const latest = latestTimestamp(actions);
  if (latest) {
    const next = advanceTimestamp(latest);
    await db.setState('last_timestamp', next);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[boot] Starting Metal X Order Bot…');

  // Database
  const db = await createDatabase();
  console.log('[boot] Database initialized');

  // Markets
  const markets = new MarketRegistry(RPC_ENDPOINTS);
  await markets.refresh().catch(err =>
    console.warn('[boot] Market load failed, using fallback data:', err.message),
  );

  // Hyperion client
  const hyperion = new HyperionClient(HYPERION_ENDPOINTS);

  // Telegram bot
  const bot = new Bot(BOT_TOKEN);

  // Notification service
  const notificationService = new NotificationService(bot, db, RATE_LIMIT);

  // Register bot commands
  setupBot(bot, db, markets, notificationService, hyperion);

  // Set BotFather command list
  await bot.api.setMyCommands([
    { command: 'start',   description: 'Welcome message and setup guide' },
    { command: 'link',    description: 'Link your XPR account' },
    { command: 'unlink',  description: 'Remove a linked account' },
    { command: 'status',  description: 'Show your linked accounts' },
    { command: 'markets', description: 'List all Metal X trading pairs' },
    { command: 'help',    description: 'Show all commands' },
  ]).catch(err => console.warn('[boot] setMyCommands failed:', err.message));

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[shutdown] Received ${signal}`);
    bot.stop();
    await db.close();
    process.exit(0);
  };
  process.once('SIGINT',  () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  // Start polling loop
  console.log(`[boot] Starting poll loop (interval: ${POLL_INTERVAL_MS}ms)`);

  const poll = async () => {
    try {
      await pollDexActions(hyperion, db, markets, notificationService);
    } catch (err) {
      console.error('[poll] Unhandled error:', err);
    }

    try {
      await pollVerification(hyperion, db, notificationService);
    } catch (err) {
      console.error('[verification] Unhandled error:', err);
    }

    setTimeout(() => void poll(), POLL_INTERVAL_MS);
  };

  // Start bot and polling concurrently
  bot.start({
    onStart: info => console.log(`[bot] Running as @${info.username}`),
    drop_pending_updates: true,
  });

  // Small delay to let the bot connect before polling starts
  setTimeout(() => void poll(), 1_000);
}

main().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});
