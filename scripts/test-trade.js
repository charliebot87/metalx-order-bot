#!/usr/bin/env node
/**
 * test-trade.js — Place small test trades on Metal X DEX and verify bot notifications.
 *
 * Flow:
 *   1. Check charliebot's XMD balance
 *   2. BUY: transfer 2.000000 XMD → dex, placeorder + process
 *   3. Wait 15 seconds
 *   4. SELL: transfer ~850 XPR → dex, placeorder + process
 *   5. Wait 30 seconds, print reminder to check Telegram
 *
 * Usage: node scripts/test-trade.js
 */

import { JsonRpc, Api, JsSignatureProvider } from '@proton/js';

// ─── Config ──────────────────────────────────────────────────────────────────

const ACCOUNT = 'charliebot';
const PRIVATE_KEY = process.env.XPR_PRIVATE_KEY;
if (!PRIVATE_KEY) { console.error('Error: XPR_PRIVATE_KEY env var required'); process.exit(1); }
const RPC_ENDPOINT = 'https://api.protonnz.com';
const EXPLORER = 'https://explorer.xprnetwork.org/transaction';

// Market 1: XPR/XMD
const MARKET_ID = 1;
const BID_SYMBOL = { sym: '4,XPR', contract: 'eosio.token' };
const ASK_SYMBOL = { sym: '6,XMD', contract: 'xmd.token' };

// Buy order: spend 2 XMD at price 0.002350 XMD/XPR
const BUY_XMD_AMOUNT = 2.0;          // XMD to spend
const BUY_PRICE = 2350;              // price in units (0.002350 XMD/XPR * 1_000_000)

// Sell order: sell 850 XPR at price 0.002330 XMD/XPR
const SELL_XPR_AMOUNT = 850;         // XPR to sell
const SELL_PRICE = 2330;             // price in units (0.002330 XMD/XPR * 1_000_000)

// ─── Setup ───────────────────────────────────────────────────────────────────

const rpc = new JsonRpc([RPC_ENDPOINT]);
const api = new Api({ rpc, signatureProvider: new JsSignatureProvider([PRIVATE_KEY]) });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function txLink(trxId) {
  return `${EXPLORER}/${trxId}`;
}

// ─── Balance check ───────────────────────────────────────────────────────────

async function getXmdBalance() {
  const result = await rpc.get_currency_balance('xmd.token', ACCOUNT, 'XMD');
  if (!result || result.length === 0) return '0.000000 XMD';
  return result[0];
}

async function getXprBalance() {
  const result = await rpc.get_currency_balance('eosio.token', ACCOUNT, 'XPR');
  if (!result || result.length === 0) return '0.0000 XPR';
  return result[0];
}

// ─── Buy order ───────────────────────────────────────────────────────────────

async function placeBuyOrder() {
  console.log('\n─── BUY ORDER ───────────────────────────────────────────────');
  console.log(`Transferring ${BUY_XMD_AMOUNT.toFixed(6)} XMD to dex at price ${(BUY_PRICE / 1_000_000).toFixed(6)} XMD/XPR`);

  const xmdQuantityStr = `${BUY_XMD_AMOUNT.toFixed(6)} XMD`;
  // quantity for placeorder = XMD amount * 1_000_000
  const orderQuantity = Math.round(BUY_XMD_AMOUNT * 1_000_000);

  const result = await api.transact(
    {
      actions: [
        // 1. Transfer XMD to dex
        {
          account: 'xmd.token',
          name: 'transfer',
          authorization: [{ actor: ACCOUNT, permission: 'active' }],
          data: {
            from: ACCOUNT,
            to: 'dex',
            quantity: xmdQuantityStr,
            memo: '',
          },
        },
        // 2. Place buy order (order_side: 1 = buy)
        {
          account: 'dex',
          name: 'placeorder',
          authorization: [{ actor: ACCOUNT, permission: 'active' }],
          data: {
            account: ACCOUNT,
            market_id: MARKET_ID,
            order_side: 1,
            order_type: 1,
            quantity: orderQuantity,
            price: BUY_PRICE,
            bid_symbol: BID_SYMBOL,
            ask_symbol: ASK_SYMBOL,
            trigger_price: null,
            fill_type: 0,
            referrer: '',
          },
        },
        // 3. Process the orderbook
        {
          account: 'dex',
          name: 'process',
          authorization: [{ actor: ACCOUNT, permission: 'active' }],
          data: { q_size: 10, show_error_msg: false },
        },
      ],
    },
    { blocksBehind: 3, expireSeconds: 60 }
  );

  const trxId = result.transaction_id;
  console.log(`✅ Buy order placed!`);
  console.log(`   TX: ${txLink(trxId)}`);
  return trxId;
}

// ─── Sell order ──────────────────────────────────────────────────────────────

async function placeSellOrder() {
  console.log('\n─── SELL ORDER ──────────────────────────────────────────────');
  console.log(`Transferring ${SELL_XPR_AMOUNT.toFixed(4)} XPR to dex at price ${(SELL_PRICE / 1_000_000).toFixed(6)} XMD/XPR`);

  const xprQuantityStr = `${SELL_XPR_AMOUNT.toFixed(4)} XPR`;
  // quantity for placeorder = XPR amount * 10000 (4 decimal places)
  const orderQuantity = Math.round(SELL_XPR_AMOUNT * 10_000);

  const result = await api.transact(
    {
      actions: [
        // 1. Transfer XPR to dex
        {
          account: 'eosio.token',
          name: 'transfer',
          authorization: [{ actor: ACCOUNT, permission: 'active' }],
          data: {
            from: ACCOUNT,
            to: 'dex',
            quantity: xprQuantityStr,
            memo: '',
          },
        },
        // 2. Place sell order (order_side: 2 = sell)
        {
          account: 'dex',
          name: 'placeorder',
          authorization: [{ actor: ACCOUNT, permission: 'active' }],
          data: {
            account: ACCOUNT,
            market_id: MARKET_ID,
            order_side: 2,
            order_type: 1,
            quantity: orderQuantity,
            price: SELL_PRICE,
            bid_symbol: BID_SYMBOL,
            ask_symbol: ASK_SYMBOL,
            trigger_price: null,
            fill_type: 0,
            referrer: '',
          },
        },
        // 3. Process the orderbook
        {
          account: 'dex',
          name: 'process',
          authorization: [{ actor: ACCOUNT, permission: 'active' }],
          data: { q_size: 10, show_error_msg: false },
        },
      ],
    },
    { blocksBehind: 3, expireSeconds: 60 }
  );

  const trxId = result.transaction_id;
  console.log(`✅ Sell order placed!`);
  console.log(`   TX: ${txLink(trxId)}`);
  return trxId;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Metal X DEX Test Trade ===');
  console.log(`Account: ${ACCOUNT}`);
  console.log(`RPC:     ${RPC_ENDPOINT}`);

  // 1. Check balances
  console.log('\n─── BALANCES ────────────────────────────────────────────────');
  const [xmdBalance, xprBalance] = await Promise.all([getXmdBalance(), getXprBalance()]);
  console.log(`  XMD: ${xmdBalance}`);
  console.log(`  XPR: ${xprBalance}`);

  const xmdAmount = parseFloat(xmdBalance.split(' ')[0]);
  if (xmdAmount < BUY_XMD_AMOUNT) {
    console.error(`\n❌ Insufficient XMD balance (have ${xmdBalance}, need ${BUY_XMD_AMOUNT.toFixed(6)} XMD)`);
    process.exit(1);
  }

  // 2. Place buy order
  const buyTrxId = await placeBuyOrder();

  // 3. Wait 15 seconds
  console.log('\nWaiting 15 seconds before sell order...');
  for (let i = 15; i > 0; i--) {
    process.stdout.write(`\r  ${i}s remaining...`);
    await sleep(1000);
  }
  process.stdout.write('\r  Done waiting.        \n');

  // 4. Place sell order
  const sellTrxId = await placeSellOrder();

  // 5. Wait 30 seconds
  console.log('\nWaiting 30 seconds for bot to detect and send notifications...');
  for (let i = 30; i > 0; i--) {
    process.stdout.write(`\r  ${i}s remaining...`);
    await sleep(1000);
  }
  process.stdout.write('\r  Done waiting.        \n');

  // Summary
  console.log('\n=== Summary =====================================================');
  console.log(`Buy TX:  ${txLink(buyTrxId)}`);
  console.log(`Sell TX: ${txLink(sellTrxId)}`);
  console.log('\nExpected Telegram notifications:');
  console.log('  📋 Order Placed  — on buy deposit (2.000000 XMD → dex)');
  console.log('  💰 Order Fill    — when buy fills (receiving XPR)');
  console.log('  📋 Order Placed  — on sell deposit (850.0000 XPR → dex)');
  console.log('  💰 Order Fill    — when sell fills (receiving XMD)');
  console.log('\nDone - check Telegram for notifications');
}

main().catch(err => {
  console.error('\n❌ Error:', err.message ?? err);
  process.exit(1);
});
