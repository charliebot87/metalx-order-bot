// ─── Market types ─────────────────────────────────────────────────────────────

/** Raw market row from dex::markets on-chain table */
export interface OnChainMarket {
  market_id: number;
  bid_token: {
    sym: string;       // e.g. "8,XBTC"
    contract: string;  // e.g. "xtokens"
  };
  ask_token: {
    quantity: string;  // e.g. "0.000000 XMD"
    contract: string;  // e.g. "xmd"
  };
}

/** Parsed, human-friendly market info used throughout the bot */
export interface MarketInfo {
  market_id: number;
  bidSymbol: string;    // e.g. "XBTC"
  askSymbol: string;    // e.g. "XMD"
  bidPrecision: number; // e.g. 8
  askPrecision: number; // e.g. 6
  bidContract: string;
  askContract: string;
}

// ─── Hyperion action types ────────────────────────────────────────────────────

export interface HyperionAction {
  global_sequence: number;
  "@timestamp": string;
  trx_id: string;
  act: {
    account: string;
    name: string;
    data: Record<string, unknown>;
  };
}

export interface HyperionResponse {
  actions: HyperionAction[];
  total: { value: number; relation: string };
}

export interface TableRowsResponse<T> {
  rows: T[];
  more: boolean;
  next_key: string;
}

// ─── DEX action data ──────────────────────────────────────────────────────────

/** Data from the dex::logexec inline action */
export interface LogExecData {
  trade_id: number;
  market_id: number;
  /** Raw uint64 price in ask token units × 10^askPrecision */
  price: number;
  bid_user: string;
  bid_user_order_id: number;
  /** Raw uint64: total ask-token value of the bid order */
  bid_total: number;
  /** Raw uint64: bid-token amount filled */
  bid_amount: number;
  /** Raw uint64: fee paid by bid_user (in ask token) */
  bid_fee: number;
  ask_user: string;
  ask_user_order_id: number;
  /** Raw uint64: total bid-token value of the ask order */
  ask_total: number;
  /** Raw uint64: ask-token amount received */
  ask_amount: number;
  /** Raw uint64: fee paid by ask_user (in ask token) */
  ask_fee: number;
  /** 1 = buy-initiated, 2 = sell-initiated */
  order_side: number;
}

/** Data from the dex::logorder inline action */
export interface LogOrderData {
  order: {
    order_id: number;
    market_id: number;
    /** Raw uint64 remaining quantity */
    quantity: number;
    price: number;
    account_name: string;
    order_side: number;
    order_type: number;
    trigger_price: number;
    fill_type: number;
  };
  quantity_change: number;
  /** "create" | "update" (partial fill) | "delete" (fully filled or cancelled) */
  status: string;
}

// ─── Database row types ───────────────────────────────────────────────────────

export interface UserRow {
  id: number;
  telegram_chat_id: string;
  xpr_account: string;
  verified: boolean;
  verification_code: string | null;
  verification_started_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationLogRow {
  id: number;
  telegram_chat_id: string;
  trade_id: number;
  order_id: number;
  market_id: number;
  notified_at: string;
}

// ─── Database abstraction ─────────────────────────────────────────────────────

export interface IDatabase {
  initialize(): Promise<void>;
  close(): Promise<void>;

  // Users
  getVerifiedUsers(): Promise<UserRow[]>;
  getAllPendingUsers(): Promise<UserRow[]>;
  getUserByChatId(chatId: string): Promise<UserRow[]>;
  getUserByAccount(account: string): Promise<UserRow | undefined>;
  getPendingVerification(chatId: string, account: string): Promise<UserRow | undefined>;
  upsertUser(chatId: string, account: string, verificationCode: string): Promise<void>;
  verifyUser(chatId: string, account: string): Promise<void>;
  unlinkUser(chatId: string, account: string): Promise<void>;

  // Notification dedup
  hasNotified(chatId: string, tradeId: number, orderId: number): Promise<boolean>;
  recordNotification(chatId: string, tradeId: number, orderId: number, marketId: number): Promise<void>;

  // Bot state (key-value)
  getState(key: string): Promise<string | undefined>;
  setState(key: string, value: string): Promise<void>;
}

// ─── Fill notification payload ────────────────────────────────────────────────

export interface FillNotification {
  chatId: string;
  market: MarketInfo;
  exec: LogExecData;
  isBidUser: boolean;
  isFull: boolean;
  /** Raw uint64 remaining quantity (bid-token units), present when isFull=false */
  remaining?: number;
  trxId: string;
  timestamp: string;
}

// ─── Endpoint health tracking ─────────────────────────────────────────────────

export interface EndpointHealth {
  url: string;
  failures: number;
  lastFailure: number;
  backoffUntil: number;
}
