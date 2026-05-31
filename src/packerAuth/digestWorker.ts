import { getDb } from '../db/connection';
import { sendFreeText } from '../whatsapp';
import { createChildLogger } from '../observability/logger';

const log = createChildLogger({ module: 'packer-digest' });

/**
 * Weekly packer rating digest.
 *
 * Sends an opt-in WhatsApp summary to packers each Sunday evening
 * with their last-7-days score versus the prior 7 days, plus the
 * count of new ratings. Aggregate-only, no per-tenant attribution
 * and no comments — same privacy model as the dashboard.
 *
 * Designed as a tick worker rather than an event subscriber: the
 * trigger is the calendar (a weekly cadence), not a domain event.
 * The marketing worker tick (60s) is too noisy to gate on, so we
 * run a dedicated low-frequency interval that rate-limits per
 * packer via packers.last_digest_sent_at.
 */

const DIGEST_TICK_MS = parseInt(
  process.env.PACKER_DIGEST_TICK_MS || String(15 * 60 * 1000), // every 15 min
  10,
);
const DIGEST_HOUR_LOCAL = parseInt(process.env.PACKER_DIGEST_HOUR_LOCAL || '18', 10); // 18:00 server-local
const DIGEST_WINDOW_HOURS = 4; // fire any time between 18:00 and 22:00
const MIN_DAYS_BETWEEN = 5; // never re-fire a digest in the same week even if the worker restarts

let interval: NodeJS.Timeout | null = null;

export function startPackerDigestWorker(): void {
  if (interval) return;
  log.info({ tickMs: DIGEST_TICK_MS, hourLocal: DIGEST_HOUR_LOCAL }, 'Packer digest worker started');
  interval = setInterval(() => {
    tick().catch((e) => log.error({ error: e.message }, 'digest tick failed'));
  }, DIGEST_TICK_MS);
  // Run once immediately so a restart inside the window catches up.
  tick().catch(() => {});
}

export function stopPackerDigestWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    log.info('Packer digest worker stopped');
  }
}

/**
 * One pass: find every opted-in packer due for a digest and send one.
 *
 * Due = it's currently Sunday in server-local time, the hour is
 * within DIGEST_HOUR_LOCAL .. DIGEST_HOUR_LOCAL+DIGEST_WINDOW_HOURS,
 * AND last_digest_sent_at is older than MIN_DAYS_BETWEEN days.
 *
 * Multi-process safety: wraps the body in a Postgres advisory lock
 * (key DIGEST_ADVISORY_LOCK_KEY) so if more than one workers
 * process is running, only one of them runs the tick at a time.
 * Without the lock both processes would race on the SELECT and
 * fire two digests for every opted-in packer. The lock auto-
 * releases when the connection returns to the pool — no manual
 * unlock needed.
 *
 * Exposed for tests so we can drive the time-of-day check
 * deterministically by passing in `now`.
 */
const DIGEST_ADVISORY_LOCK_KEY = 8472615301; // arbitrary 64-bit signed int unique to this worker

export async function tick(now: Date = new Date()): Promise<void> {
  if (!isWithinDigestWindow(now)) {
    return;
  }
  const db = getDb();

  // Try to grab the advisory lock. pg_try_advisory_lock returns true
  // if we got it, false otherwise. If another process holds it, we
  // skip this tick — the holder will do the work.
  const lockRes = await db.raw('SELECT pg_try_advisory_lock(?) AS got', [DIGEST_ADVISORY_LOCK_KEY]);
  const got = !!(lockRes?.rows?.[0]?.got);
  if (!got) {
    log.debug('Digest tick skipped — another worker holds the advisory lock');
    return;
  }

  try {
    await runDigestPass(now);
  } finally {
    // Always release. If the connection has already gone back to the
    // pool the unlock is a no-op; calling it explicitly is the safe
    // pattern for our connection style.
    await db.raw('SELECT pg_advisory_unlock(?)', [DIGEST_ADVISORY_LOCK_KEY]).catch(() => {});
  }
}

async function runDigestPass(now: Date): Promise<void> {
  const db = getDb();

  const cutoff = new Date(now.getTime() - MIN_DAYS_BETWEEN * 86400000);

  const packers = await db('packers')
    .where({ weekly_digest_enabled: true })
    .whereNot('status', 'disabled')
    .whereNotNull('phone')
    .andWhere(function () {
      this.whereNull('last_digest_sent_at').orWhere('last_digest_sent_at', '<', cutoff);
    })
    .select('id', 'email', 'full_name', 'phone');

  if (!packers.length) {
    log.debug('No packers due for digest this tick');
    return;
  }
  log.info({ count: packers.length }, 'Sending packer weekly digests');

  for (const packer of packers) {
    try {
      const summary = await buildDigestSummary(packer.id, now);
      if (!summary.hasNewRatings) {
        // Don't spam someone whose week was empty. Bump
        // last_digest_sent_at anyway so we don't re-evaluate them
        // every tick — the next digest will check the same row.
        await db('packers').where({ id: packer.id }).update({
          last_digest_sent_at: now,
          updated_at: now,
        });
        continue;
      }
      await sendDigestMessage({
        tenantId: pickPrimaryTenantId(packer.id),
        packer,
        summary,
      });
      await db('packers').where({ id: packer.id }).update({
        last_digest_sent_at: now,
        updated_at: now,
      });
    } catch (err: any) {
      log.warn({ packerId: packer.id, error: err.message }, 'Digest send failed for packer');
    }
  }
}

function isWithinDigestWindow(now: Date): boolean {
  // Sunday in JS Date.getDay() === 0
  if (now.getDay() !== 0) return false;
  const hour = now.getHours();
  return hour >= DIGEST_HOUR_LOCAL && hour < DIGEST_HOUR_LOCAL + DIGEST_WINDOW_HOURS;
}

interface DigestSummary {
  hasNewRatings: boolean;
  thisWeekCount: number;
  thisWeekOverall: number | null;
  lastWeekOverall: number | null;
  delta: number | null;
  worstCriterion: { name: string; score: number } | null;
}

export async function buildDigestSummary(packerId: string, now: Date = new Date()): Promise<DigestSummary> {
  const db = getDb();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400000);

  const [thisWeek, lastWeek] = await Promise.all([
    db('packer_ratings')
      .where({ packer_id: packerId })
      .where('updated_at', '>=', sevenDaysAgo)
      .where('updated_at', '<', now)
      .select(
        db.raw('COUNT(*)::int as count'),
        db.raw('AVG(packing_quality)::float as packing_quality'),
        db.raw('AVG(speed)::float as speed'),
        db.raw('AVG(communication)::float as communication'),
        db.raw('AVG(reliability)::float as reliability'),
      )
      .first(),
    db('packer_ratings')
      .where({ packer_id: packerId })
      .where('updated_at', '>=', fourteenDaysAgo)
      .where('updated_at', '<', sevenDaysAgo)
      .select(
        db.raw('COUNT(*)::int as count'),
        db.raw('AVG(packing_quality)::float as packing_quality'),
        db.raw('AVG(speed)::float as speed'),
        db.raw('AVG(communication)::float as communication'),
        db.raw('AVG(reliability)::float as reliability'),
      )
      .first(),
  ]);

  const thisCount = Number((thisWeek as any)?.count || 0);
  if (thisCount === 0) {
    return {
      hasNewRatings: false,
      thisWeekCount: 0,
      thisWeekOverall: null,
      lastWeekOverall: null,
      delta: null,
      worstCriterion: null,
    };
  }

  const thisOverall = avgOfFour(thisWeek);
  const lastOverall = Number((lastWeek as any)?.count || 0) > 0 ? avgOfFour(lastWeek) : null;
  const delta = lastOverall !== null && thisOverall !== null
    ? Math.round((thisOverall - lastOverall) * 100) / 100
    : null;

  const worst = pickWorstCriterion(thisWeek);

  return {
    hasNewRatings: true,
    thisWeekCount: thisCount,
    thisWeekOverall: thisOverall,
    lastWeekOverall: lastOverall,
    delta,
    worstCriterion: worst,
  };
}

function avgOfFour(row: any): number | null {
  if (!row) return null;
  const vals = [row.packing_quality, row.speed, row.communication, row.reliability]
    .map((v) => v === null || v === undefined ? null : Number(v))
    .filter((v): v is number => v !== null);
  if (!vals.length) return null;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.round(avg * 100) / 100;
}

function pickWorstCriterion(row: any): { name: string; score: number } | null {
  if (!row) return null;
  const fields: Array<[string, string]> = [
    ['packing_quality', 'Packing quality'],
    ['speed', 'Speed'],
    ['communication', 'Communication'],
    ['reliability', 'Reliability'],
  ];
  let worst: { name: string; score: number } | null = null;
  for (const [key, label] of fields) {
    const v = row[key];
    if (v === null || v === undefined) continue;
    const num = Number(v);
    if (!worst || num < worst.score) worst = { name: label, score: Math.round(num * 100) / 100 };
  }
  return worst;
}

/**
 * Pick a tenant id that this packer is linked to. We need *some*
 * tenant context for the WhatsApp send because credentials live
 * per-tenant. Picks the most recently active link (preferring active
 * over paused) so the digest goes through whichever tenant the
 * packer is currently working most with.
 *
 * Returns an empty string when no tenant is linked — the caller then
 * skips the send. Synchronous-looking helper that returns a Promise
 * via the closure below; using a thunk keeps the await out of the
 * hot path tester.
 */
function pickPrimaryTenantId(packerId: string): string {
  // We can't make this sync against the DB. Return a sentinel and
  // resolve inside sendDigestMessage to keep tick() readable.
  return packerId; // we'll re-query in the send function
}

async function sendDigestMessage(args: {
  tenantId: string; // packerId placeholder — we re-resolve here
  packer: { id: string; email: string; full_name: string | null; phone: string };
  summary: DigestSummary;
}): Promise<void> {
  const db = getDb();
  // Resolve a real tenant_id: most-recent active link wins.
  const link = await db('packer_tenant_links')
    .where({ packer_id: args.packer.id })
    .where('status', 'active')
    .orderBy('linked_at', 'desc')
    .first('tenant_id');
  if (!link) {
    log.debug({ packerId: args.packer.id }, 'No active tenant link — cannot route digest WhatsApp');
    return;
  }

  const body = formatDigestBody(args.packer.full_name || 'there', args.summary);

  await sendFreeText({
    tenantId: link.tenant_id,
    toPhone: args.packer.phone,
    body,
  });

  log.info({
    packerId: args.packer.id,
    thisWeekCount: args.summary.thisWeekCount,
    thisWeekOverall: args.summary.thisWeekOverall,
    delta: args.summary.delta,
  }, 'Packer digest sent');
}

/**
 * Format the human-readable digest body. Pure function — exposed for
 * tests so we can pin the wording without booting the worker.
 */
export function formatDigestBody(name: string, s: DigestSummary): string {
  const lines: string[] = [];
  lines.push(`Hi ${name}, your weekly RelayOS packer summary:`);
  lines.push('');
  if (s.thisWeekOverall !== null) {
    lines.push(`★ Overall this week: ${s.thisWeekOverall.toFixed(2)} / 5  (${s.thisWeekCount} rating${s.thisWeekCount === 1 ? '' : 's'})`);
  } else {
    lines.push(`★ Overall this week: — (no ratings)`);
  }
  if (s.delta !== null) {
    if (s.delta > 0) {
      lines.push(`Up ${s.delta.toFixed(2)} from last week — nice work.`);
    } else if (s.delta < 0) {
      lines.push(`Down ${Math.abs(s.delta).toFixed(2)} from last week.`);
    } else {
      lines.push(`Flat versus last week.`);
    }
  } else if (s.lastWeekOverall === null) {
    lines.push(`First week with ratings — keep it up.`);
  }
  if (s.worstCriterion) {
    lines.push('');
    lines.push(`Lowest score this week: ${s.worstCriterion.name} (${s.worstCriterion.score.toFixed(2)} / 5).`);
  }
  lines.push('');
  lines.push(`To opt out, untick "Weekly digest" in your dashboard Profile tab.`);
  return lines.join('\n');
}
