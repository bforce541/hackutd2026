/**
 * In-memory state with a JSON snapshot to data/state.json (SPEC §1). Implemented by: server-core.
 *
 * One server process owns all state. Everything else reads and writes through this interface.
 * Writers mutate through update()/put()/patch(); the store schedules a debounced snapshot.
 * Publishing SSE events is the caller's job (through the bus), not the store's.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  ActivityEvent,
  Approval,
  ArenaResults,
  Bill,
  Call,
  Case,
  Change,
  Day,
  Followup,
  Household,
  Message,
  Negotiation,
  Plan,
  Rules,
} from '@pacepay/shared';

/** Metadata for a stored image (bill photo or chart PNG). Bytes live in <dataDir>/media/<id>. */
export interface MediaMeta {
  id: string;
  contentType: string; // 'image/png' | 'image/jpeg' | ...
  name: string;
  bytes: number;
  source: 'inbound' | 'chart' | 'fixture' | 'upload';
  at: string;
}

/** Keyed collections. get/put/patch/list work on any of these. */
export interface Collections {
  cases: Case;
  plans: Plan;
  bills: Bill;
  approvals: Approval;
  calls: Call;
  negotiations: Negotiation;
  followups: Followup;
  media: MediaMeta;
}
export type CollectionName = keyof Collections;

export interface ServerState {
  version: 1;
  /** The household as loaded from the fixture; rules edits land in household.rules. Never mutated by accepted changes. */
  household: Household;
  /** Changes Yoshua accepted (e.g. the moved car payment and its fee); every forecast applies them. */
  acceptedChanges: Change[];
  cases: Record<string, Case>;
  plans: Record<string, Plan>;
  bills: Record<string, Bill>;
  approvals: Record<string, Approval>;
  calls: Record<string, Call>;
  negotiations: Record<string, Negotiation>;
  followups: Record<string, Followup>;
  media: Record<string, MediaMeta>;
  /** One case at a time (SPEC §5.3). */
  currentCaseId: string | null;
  /** The iMessage thread mirror, oldest first. */
  thread: Message[];
  /** The activity log, oldest first (capped). */
  activity: ActivityEvent[];
  /** The demo clock. */
  day: Day;
  arena: ArenaResults | null;
  /** Last SSE seq, so numbering continues after a restart. */
  lastSeq: number;
}

export interface Store {
  /** The whole state. Treat as read-only; write through update(). */
  get(): Readonly<ServerState>;
  /** Mutate the state in place, then schedule a snapshot. Returns fn's result. */
  update<R>(fn: (s: ServerState) => R): R;

  // Keyed collections
  getItem<K extends CollectionName>(kind: K, id: string): Collections[K] | undefined;
  /** Like getItem but throws a not_found error. */
  mustGet<K extends CollectionName>(kind: K, id: string): Collections[K];
  put<K extends CollectionName>(kind: K, value: Collections[K]): Collections[K];
  patch<K extends CollectionName>(kind: K, id: string, patch: Partial<Collections[K]>): Collections[K];
  list<K extends CollectionName>(kind: K): Collections[K][];

  // Convenience
  household(): Household;
  rules(): Rules;
  setRules(rules: Rules): Rules;
  /** Changes Yoshua committed to, across cases (the deal, a confirmed bill). Every forecast applies them. */
  acceptedChanges(): Change[];
  addAcceptedChanges(changes: Change[]): void;
  /** Replace the whole list (e.g. undo a change). */
  setAcceptedChanges(changes: Change[]): void;
  /**
   * What the server's current forecast applies: acceptedChanges plus the open case's baseChanges
   * (the bill being worked, counted as paid from checking). GET /api/forecast, /api/scores, the
   * SSE `forecast`, get_forecast, check_offer and planCallTargets (as ctx.baseChanges) all use this.
   */
  forecastChanges(): Change[];
  currentCase(): Case | null;
  setCurrentCase(id: string | null): void;
  pendingApprovals(): Approval[];
  thread(): Message[];
  appendMessage(m: Message): Message;
  activity(): ActivityEvent[];
  appendActivity(e: ActivityEvent): void;
  day(): Day;
  setDay(day: Day): Day;
  arena(): ArenaResults | null;
  setArena(r: ArenaResults | null): void;
  /** Follow-ups scheduled for a day <= `day` that have not been sent. */
  dueFollowups(day: Day): Followup[];

  // Media bytes
  putMedia(meta: Omit<MediaMeta, 'bytes' | 'at'>, data: Buffer): MediaMeta;
  getMedia(id: string): { meta: MediaMeta; data: Buffer } | undefined;

  /** Reload the fixture, clear cases, thread, calls and approvals, clock to day 0 (POST /api/demo/reset). */
  reset(household: Household): void;
  /** Write data/state.json now. */
  snapshot(): void;
}

export interface StoreOptions {
  household: Household;
  /** Default: <repo>/data. Holds state.json and media/. */
  dataDir: string;
  /** Load data/state.json if present (default true). */
  restore?: boolean;
  /** Debounce for snapshots in ms (default 250). 0 disables automatic snapshots. */
  snapshotDelayMs?: number;
}

const ACTIVITY_CAP = 5000;

export class NotFoundError extends Error {
  readonly code = 'not_found';
}

function freshState(household: Household): ServerState {
  return {
    version: 1,
    household: structuredClone(household),
    acceptedChanges: [],
    cases: {},
    plans: {},
    bills: {},
    approvals: {},
    calls: {},
    negotiations: {},
    followups: {},
    media: {},
    currentCaseId: null,
    thread: [],
    activity: [],
    day: 0,
    arena: null,
    lastSeq: 0,
  };
}

export function createStore(opts: StoreOptions): Store {
  const statePath = join(opts.dataDir, 'state.json');
  const mediaDir = join(opts.dataDir, 'media');
  const delay = opts.snapshotDelayMs ?? 250;
  let state = freshState(opts.household);

  if (opts.restore !== false && existsSync(statePath)) {
    try {
      const loaded = JSON.parse(readFileSync(statePath, 'utf8')) as ServerState;
      if (loaded.version === 1) state = loaded;
    } catch (err) {
      console.warn('[store] could not read state.json, starting fresh', err);
    }
  }

  let timer: NodeJS.Timeout | null = null;
  function schedule(): void {
    if (delay === 0 || timer) return;
    timer = setTimeout(() => {
      timer = null;
      store.snapshot();
    }, delay);
    timer.unref?.();
  }

  const store: Store = {
    get: () => state,
    update(fn) {
      const r = fn(state);
      schedule();
      return r;
    },
    getItem(kind, id) {
      return state[kind][id] as never;
    },
    mustGet(kind, id) {
      const v = state[kind][id];
      if (!v) throw new NotFoundError(`${kind} ${id} not found`);
      return v as never;
    },
    put(kind, value) {
      (state[kind] as Record<string, unknown>)[value.id] = value;
      schedule();
      return value;
    },
    patch(kind, id, patch) {
      const cur = store.mustGet(kind, id);
      const next = { ...cur, ...patch };
      (state[kind] as Record<string, unknown>)[id] = next;
      schedule();
      return next;
    },
    list(kind) {
      return Object.values(state[kind]) as never;
    },
    household: () => state.household,
    rules: () => state.household.rules,
    setRules(rules) {
      state.household.rules = rules;
      schedule();
      return rules;
    },
    acceptedChanges: () => state.acceptedChanges,
    addAcceptedChanges(changes) {
      state.acceptedChanges.push(...changes);
      schedule();
    },
    setAcceptedChanges(changes) {
      state.acceptedChanges = [...changes];
      schedule();
    },
    forecastChanges() {
      const open = store.currentCase();
      const base = open && open.state !== 'DONE' ? (open.baseChanges ?? []) : [];
      return [...state.acceptedChanges, ...base];
    },
    currentCase: () => (state.currentCaseId ? (state.cases[state.currentCaseId] ?? null) : null),
    setCurrentCase(id) {
      state.currentCaseId = id;
      schedule();
    },
    pendingApprovals: () => Object.values(state.approvals).filter((a) => a.status === 'pending'),
    thread: () => state.thread,
    appendMessage(m) {
      state.thread.push(m);
      schedule();
      return m;
    },
    activity: () => state.activity,
    appendActivity(e) {
      state.activity.push(e);
      if (state.activity.length > ACTIVITY_CAP) state.activity.splice(0, state.activity.length - ACTIVITY_CAP);
      state.lastSeq = Math.max(state.lastSeq, e.seq);
      schedule();
    },
    day: () => state.day,
    setDay(day) {
      state.day = day;
      schedule();
      return day;
    },
    arena: () => state.arena,
    setArena(r) {
      state.arena = r;
      schedule();
    },
    dueFollowups: (day) => Object.values(state.followups).filter((f) => f.status === 'scheduled' && f.atDay <= day),
    putMedia(meta, data) {
      mkdirSync(mediaDir, { recursive: true });
      writeFileSync(join(mediaDir, meta.id), data);
      const full: MediaMeta = { ...meta, bytes: data.length, at: new Date().toISOString() };
      state.media[meta.id] = full;
      schedule();
      return full;
    },
    getMedia(id) {
      const meta = state.media[id];
      if (!meta) return undefined;
      try {
        return { meta, data: readFileSync(join(mediaDir, id)) };
      } catch {
        return undefined;
      }
    },
    reset(household) {
      const keep = { arena: state.arena, media: state.media, lastSeq: state.lastSeq };
      state = { ...freshState(household), ...keep };
      schedule();
    },
    snapshot() {
      mkdirSync(dirname(statePath), { recursive: true });
      const tmp = `${statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, statePath);
    },
  };
  return store;
}
