import type {
  HyperionAction,
  HyperionResponse,
  LogExecData,
  LogOrderData,
  EndpointHealth,
} from './types.js';

const BACKOFF_BASE_MS = 10_000;
const BACKOFF_MAX_MS  = 300_000;
const MAX_FAILURES    = 5;
const REQUEST_TIMEOUT = 12_000;

// ─── Endpoint rotation with exponential backoff ────────────────────────────────

export class EndpointPool {
  private endpoints: EndpointHealth[];

  constructor(urls: string[]) {
    this.endpoints = urls.map(url => ({
      url,
      failures: 0,
      lastFailure: 0,
      backoffUntil: 0,
    }));
  }

  /** Return the best available endpoint (lowest failures, past backoff window). */
  pick(): string {
    const now = Date.now();
    // Prefer endpoints that are past their backoff window
    const available = this.endpoints.filter(e => now >= e.backoffUntil);
    const pool = available.length > 0 ? available : this.endpoints;
    // Pick the one with fewest failures
    pool.sort((a, b) => a.failures - b.failures);
    return pool[0].url;
  }

  markSuccess(url: string): void {
    const ep = this.endpoints.find(e => e.url === url);
    if (ep) ep.failures = Math.max(0, ep.failures - 1);
  }

  markFailure(url: string): void {
    const ep = this.endpoints.find(e => e.url === url);
    if (!ep) return;
    ep.failures++;
    ep.lastFailure = Date.now();
    const backoff = Math.min(
      BACKOFF_BASE_MS * Math.pow(2, Math.min(ep.failures - 1, MAX_FAILURES)),
      BACKOFF_MAX_MS,
    );
    ep.backoffUntil = Date.now() + backoff;
    console.warn(`[hyperion] ${url} failed ${ep.failures}x, backoff ${backoff / 1000}s`);
  }

  endpointCount(): number {
    return this.endpoints.length;
  }

  status(): string {
    return this.endpoints
      .map(e => {
        const inBackoff = Date.now() < e.backoffUntil;
        return `${e.url} (failures=${e.failures}${inBackoff ? ', in backoff' : ''})`;
      })
      .join(', ');
  }
}

// ─── HyperionClient ────────────────────────────────────────────────────────────

export class HyperionClient {
  private pool: EndpointPool;

  constructor(endpoints: string[]) {
    this.pool = new EndpointPool(endpoints);
  }

  /**
   * Fetch dex:logexec and dex:logorder actions after a given ISO timestamp.
   * Returns actions sorted ascending by global_sequence.
   */
  async getDexActions(afterTimestamp: string, limit = 100): Promise<HyperionAction[]> {
    const params = new URLSearchParams({
      account: 'dex',
      filter: 'dex:logexec,dex:logorder',
      sort: 'asc',
      after: afterTimestamp,
      limit: String(limit),
    });

    return this.request<HyperionResponse>(`/v2/history/get_actions?${params}`)
      .then(data => data.actions ?? []);
  }

  /**
   * Fetch recent eosio.token:transfer actions sent by an account,
   * used for verifying the burn-to-token.burn verification flow.
   */
  async getTransfers(account: string, limit = 30): Promise<HyperionAction[]> {
    const params = new URLSearchParams({
      account,
      filter: 'eosio.token:transfer',
      sort: 'desc',
      limit: String(limit),
    });

    return this.request<HyperionResponse>(`/v2/history/get_actions?${params}`)
      .then(data => data.actions ?? []);
  }

  private async request<T>(path: string): Promise<T> {
    const maxRetries = this.pool.endpointCount();
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const url = this.pool.pick();
      const fullUrl = `${url}${path}`;

      try {
        const res = await fetch(fullUrl, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const data = (await res.json()) as T;
        this.pool.markSuccess(url);
        return data;
      } catch (err) {
        this.pool.markFailure(url);
        lastErr = err as Error;
      }
    }

    throw lastErr ?? new Error('All endpoints failed');
  }

  endpointStatus(): string {
    return this.pool.status();
  }
}

// ─── Type-safe action data extractors ─────────────────────────────────────────

export function asLogExec(action: HyperionAction): LogExecData | null {
  if (action.act.name !== 'logexec') return null;
  const d = action.act.data as Record<string, unknown>;
  if (d.trade_id === undefined || d.market_id === undefined) return null;
  // Hyperion returns numeric fields as strings — coerce them
  return {
    trade_id: Number(d.trade_id),
    market_id: Number(d.market_id),
    price: Number(d.price),
    bid_user: String(d.bid_user),
    bid_user_order_id: Number(d.bid_user_order_id),
    bid_total: Number(d.bid_total),
    bid_amount: Number(d.bid_amount),
    bid_fee: Number(d.bid_fee),
    ask_user: String(d.ask_user),
    ask_user_order_id: Number(d.ask_user_order_id),
    ask_total: Number(d.ask_total),
    ask_amount: Number(d.ask_amount),
    ask_fee: Number(d.ask_fee),
    order_side: Number(d.order_side),
  } satisfies LogExecData;
}

export function asLogOrder(action: HyperionAction): LogOrderData | null {
  if (action.act.name !== 'logorder') return null;
  const d = action.act.data as Record<string, unknown>;
  if (!d.order || !d.status) return null;
  const o = d.order as Record<string, unknown>;
  return {
    order: {
      order_id: Number(o.order_id),
      market_id: Number(o.market_id),
      quantity: Number(o.quantity),
      price: Number(o.price),
      account_name: String(o.account_name),
      order_side: Number(o.order_side),
      order_type: Number(o.order_type),
      trigger_price: Number(o.trigger_price),
      fill_type: Number(o.fill_type),
    },
    quantity_change: Number(d.quantity_change),
    status: String(d.status),
  } satisfies LogOrderData;
}

// ─── Checkpoint helpers ────────────────────────────────────────────────────────

/** Ensure a timestamp has a Z suffix (Hyperion returns without it). */
function ensureUtc(iso: string): string {
  return iso.endsWith('Z') ? iso : iso + 'Z';
}

/** Advance an ISO timestamp by 1ms to avoid re-fetching the last seen action. */
export function advanceTimestamp(iso: string): string {
  return new Date(new Date(ensureUtc(iso)).getTime() + 1).toISOString();
}

/** Return the highest @timestamp seen in a set of actions, with Z suffix. */
export function latestTimestamp(actions: HyperionAction[]): string | null {
  if (actions.length === 0) return null;
  const raw = actions.reduce((max, a) => (a['@timestamp'] > max ? a['@timestamp'] : max), actions[0]['@timestamp']);
  return ensureUtc(raw);
}
