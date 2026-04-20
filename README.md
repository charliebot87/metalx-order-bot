# Metal X Order Bot 🔔

A self-hosted Telegram bot that sends you real-time notifications when your orders fill on [Metal X](https://metalx.com) — the decentralized exchange on XPR Network.

- ✅ Full and partial fill notifications
- ✅ All XMD trading pairs on Metal X
- ✅ Secure account verification (on-chain proof of ownership)
- ✅ SQLite (local) or PostgreSQL (Railway/cloud)
- ✅ Multiple RPC endpoint rotation with automatic failover
- ✅ Notification dedup — no spam on restarts
- ✅ Rate limiting — max 10 notifications/minute per user

## What It Looks Like

```
🟢 Order Filled (Buy)

Market: XBTC/XMD
Price: 76,150.00 XMD
Amount: 0.00262600 XBTC
Total: 199.97 XMD
Fee: 0 XMD

Order #27358724

📊 View on Metal X
🔍 View Transaction
```

```
🟡 Partial Fill (Sell)

Market: METAL/XMD
Amount filled: 1,577.60 METAL
Remaining: 41,293.71 METAL
Price: 0.001363 XMD

Order #27357485

📊 View on Metal X
🔍 View Transaction
```

---

## Quick Start

### 1. Create a Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/botfather)
2. Send `/newbot`
3. Choose a name (e.g. "My Metal X Notifications")
4. Choose a username (e.g. `my_metalx_bot`)
5. **Copy the bot token** — you'll need it next

Optionally, set the command menu in BotFather:
```
/setcommands
```
Then select your bot and paste:
```
start - Welcome message and setup guide
link - Link your XPR account
unlink - Remove a linked account
status - Show your linked accounts
markets - List all Metal X trading pairs
help - Show all commands
```

### 2. Clone & Configure

```bash
git clone https://github.com/XPRNetwork/metalx-order-bot.git
cd metalx-order-bot
cp .env.example .env
```

Edit `.env` and add your bot token:
```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
```

That's it for local use. SQLite is the default — no database setup needed.

### 3. Install & Run

```bash
npm install
npm run build
npm start
```

Or for development with auto-reload:
```bash
npm run dev
```

### 4. Link Your Account

1. Open your bot in Telegram
2. Send `/link youraccount` (your XPR account name)
3. The bot gives you a verification code
4. Send a self-transfer of `0.0001 XPR` to yourself with the code as the memo
5. The bot detects the transfer and verifies your account
6. You're done — fill notifications are now live

---

## Deploy to Railway

[Railway](https://railway.app) is the easiest way to run this 24/7 in the cloud.

### Option A: Railway Dashboard (no CLI needed)

1. Fork this repo to your GitHub account
2. Go to [railway.app](https://railway.app) and sign in with GitHub
3. Click **New Project → Deploy from GitHub repo**
4. Select your forked repo
5. Railway will auto-detect the Dockerfile
6. Add environment variables:
   - `TELEGRAM_BOT_TOKEN` = your bot token
   - `DATABASE_URL` = *(add a PostgreSQL plugin from Railway's dashboard, it auto-sets this)*
7. Click **Deploy**

### Option B: Railway CLI

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Create project
railway init

# Add PostgreSQL
railway add --plugin postgresql

# Set bot token
railway variables set TELEGRAM_BOT_TOKEN=your_bot_token_here

# Deploy
railway up
```

### Railway with PostgreSQL

When you add a PostgreSQL plugin on Railway, it automatically sets `DATABASE_URL`. The bot detects this and uses PostgreSQL instead of SQLite. No code changes needed.

### Railway with SQLite

If you don't add PostgreSQL, the bot uses SQLite by default. Note: Railway's filesystem is ephemeral — your SQLite data resets on each deploy. For persistent data, either:
- Use PostgreSQL (recommended)
- Mount a Railway volume at `/app/data`

---

## Configuration

All configuration is via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | **Yes** | — | Bot token from @BotFather |
| `DATABASE_URL` | No | *(SQLite)* | PostgreSQL connection string. If set, uses PostgreSQL. |
| `HYPERION_ENDPOINTS` | No | `https://api-xprnetwork-main.saltant.io,https://proton.greymass.com,https://api.protonnz.com` | Comma-separated Hyperion API endpoints (rotated on failure) |
| `RPC_ENDPOINTS` | No | `https://api.protonnz.com,https://proton.greymass.com` | Comma-separated RPC endpoints for on-chain reads |
| `POLL_INTERVAL` | No | `3000` | Milliseconds between poll cycles |
| `RATE_LIMIT` | No | `10` | Max notifications per user per minute |
| `MAX_STALE_SECONDS` | No | `300` | If the bot was offline longer than this, skip old events instead of replaying them |

---

## How Verification Works

To prevent anyone from subscribing to someone else's orders, the bot requires **on-chain proof of ownership**:

1. User sends `/link myaccount` to the bot
2. Bot generates a unique code (e.g. `METALX-A3K9VN`)
3. User sends **0.0001 XPR** (or any amount) from `myaccount` to `token.burn` with the code as the memo
4. Bot polls Hyperion for transfers matching the account + memo + recipient
5. On match → account is verified and linked

This proves the user controls the private key for that account. The XPR is sent to [`token.burn`](https://explorer.xprnetwork.org/account/token.burn) — a tiny burn to verify ownership.

---

## Supported Markets

The bot monitors all Metal X trading pairs:

| # | Market | Pair |
|---|--------|------|
| 1 | XPR/XMD | XPR ↔ XMD |
| 2 | XBTC/XMD | Bitcoin ↔ XMD |
| 3 | XETH/XMD | Ethereum ↔ XMD |
| 4 | XMD/XUSDT | XMD ↔ Tether |
| 7 | XMT/XMD | Metal DAO ↔ XMD |
| 9 | LOAN/XMD | LOAN ↔ XMD |
| 10 | METAL/XMD | Metal ↔ XMD |
| 11 | XDC/XMD | XDC ↔ XMD |
| 12 | XDOGE/XMD | Dogecoin ↔ XMD |
| 13 | XHBAR/XMD | Hedera ↔ XMD |
| 14 | XLTC/XMD | Litecoin ↔ XMD |
| 15 | XXRP/XMD | XRP ↔ XMD |
| 16 | XSOL/XMD | Solana ↔ XMD |
| 17 | XXLM/XMD | Stellar ↔ XMD |
| 18 | XADA/XMD | Cardano ↔ XMD |

Only XMD pairs are monitored. Markets are loaded from the on-chain `dex` contract and refreshed every 10 minutes.

---

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Telegram    │◄────│  Metal X Order   │────►│  Hyperion    │
│  Users       │     │  Bot             │     │  API Pool    │
└─────────────┘     └──────────────────┘     └──────────────┘
                           │                        │
                    ┌──────┴──────┐          ┌──────┴──────┐
                    │  SQLite or  │          │  RPC Pool   │
                    │  PostgreSQL │          │  (markets)  │
                    └─────────────┘          └─────────────┘
```

### Polling Loop

Every 3 seconds (configurable), the bot:

1. Queries Hyperion for new `dex:logexec` (trade fills) and `dex:logorder` (order status changes) actions
2. Correlates fills with order updates to determine full vs. partial fills
3. Checks if any fill involves a verified user's account
4. Sends Telegram notifications (with dedup and rate limiting)
5. Advances the checkpoint timestamp

### Endpoint Rotation

The bot maintains a health score for each Hyperion/RPC endpoint:
- On success: failure count decreases
- On failure: failure count increases, endpoint enters exponential backoff
- The bot always picks the healthiest available endpoint
- If all endpoints are in backoff, it tries the least-failed one

### Notification Dedup

Every notification is recorded in the database by `(chat_id, trade_id, order_id)`. If the bot restarts and re-processes the same events, duplicates are silently skipped.

### Stale Protection

If the bot was offline for more than `MAX_STALE_SECONDS` (default: 5 minutes), it resets its checkpoint to "now" instead of replaying potentially hundreds of old events. This prevents notification floods after downtime.

---

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and setup instructions |
| `/link <account>` | Link an XPR account with on-chain verification |
| `/unlink <account>` | Remove a linked account |
| `/status` | Show your linked accounts and verification status |
| `/markets` | List all 18 Metal X trading pairs |
| `/help` | Show all available commands |

---

## Troubleshooting

### Bot isn't responding
- Check that `TELEGRAM_BOT_TOKEN` is correct
- Make sure no other instance is running with the same token (Telegram only allows one long-polling connection per bot)

### Not receiving notifications
- Run `/status` to confirm your account is verified (✅ not ⏳)
- Check that you have active orders on Metal X
- Check the bot logs for Hyperion errors

### Verification not working
- Send any amount of XPR (we suggest `0.0001 XPR`) to `token.burn`
- The memo must match the code exactly (case-sensitive)
- Make sure you're sending **from** the account you're trying to link
- Try `/link <account>` again to get a fresh code

### "All RPC endpoints failed"
- The default Hyperion endpoints may be temporarily down
- Add more endpoints via `HYPERION_ENDPOINTS` in your `.env`
- Check [XPR Network status](https://status.xprnetwork.org) for outages

### SQLite errors on Railway
- Railway's filesystem is ephemeral. Use PostgreSQL instead (add the plugin in Railway dashboard)

---

## Development

```bash
# Install dependencies
npm install

# Run with auto-reload
npm run dev

# Build
npm run build

# Type check
npx tsc --noEmit
```

### Project Structure

```
src/
├── index.ts          # Entry point, polling loop, verification
├── bot.ts            # Telegram bot commands (grammy)
├── hyperion.ts       # Hyperion client with endpoint rotation
├── markets.ts        # Market registry + price/amount formatting
├── notifications.ts  # Notification formatting, dedup, rate limiting
├── types.ts          # Shared TypeScript interfaces
└── db/
    ├── index.ts      # Auto-detect SQLite vs PostgreSQL
    ├── sqlite.ts     # SQLite implementation (better-sqlite3)
    └── postgres.ts   # PostgreSQL implementation (pg)
```

---

## Contributing

Contributions welcome! This is an open-source community project.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -am 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

Please test locally before submitting.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Links

- [Metal X DEX](https://metalx.com)
- [XPR Network](https://xprnetwork.org)
- [WebAuth Wallet](https://webauth.com)
- [XPR Network Explorer](https://explorer.xprnetwork.org)
- [Metal X API Docs](https://api.dex.docs.metalx.com)
