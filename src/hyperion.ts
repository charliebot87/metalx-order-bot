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
      throw err;
    }
  }

  endpointStatus(): string {
    return this.pool.status();
  }
}

// ─── Type-safe action data extractors ─────────────────────────────────────────

export function asLogExec(action: HyperionAction): LogExecData | null {
  if (action.act.name !== 'logexec') return null;
  const d = action.act.data as Record<string, unknown>;
  if (typeof d.trade_id !== 'number' || typeof d.market_id !== 'number') return null;
  return d as unknown as LogExecData;
}

export function asLogOrder(action: HyperionAction): LogOrderData | null {
  if (action.act.name !== 'logorder') return null;
  const d = action.act.data as Record<string, unknown>;
  if (!d.order || typeof d.status !== 'string') return null;
  return d as unknown as LogOrderData;
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
