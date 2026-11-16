/**
 * Alert rules.
 *
 * Evaluation is a pure function of (monitor, its price history, the scheduler
 * state). Two anti-noise mechanisms are mandatory per the design:
 *
 *   1. hysteresis for `target` — fire once when crossing from above to below,
 *      then stay quiet until the price goes back above;
 *   2. one fire per calendar day per rule for `new_low` / `new_high`, so a price
 *      that keeps making new highs is reported once and folded into the digest
 *      rather than every poll.
 *
 * A third, time-based cooldown applies to every rule.
 */
import { isoDate, isoNow } from './util.js';

const RULE_LEVEL = {
  target: 'alert',
  new_low: 'alert',
  new_high: 'alert',
  digest: 'info',
  anomaly: 'critical',
};

const RULE_LABEL = {
  target: { zh: '跌破目标价', en: 'Target hit' },
  new_low: { zh: '历史新低', en: 'New low' },
  new_high: { zh: '历史新高', en: 'New high' },
  digest: { zh: '价格日报', en: 'Daily digest' },
  anomaly: { zh: '采集异常', en: 'Collection problem' },
};

export function ruleLabel(kind, locale = 'zh') {
  return (RULE_LABEL[kind] || { zh: kind, en: kind })[locale] || kind;
}

/**
 * @param {object} monitor
 * @param {Array<{at:string, price:{total:number}}>} points  oldest → newest, newest last
 * @param {{ state: any, config: any, now?: Date }} context
 */
export function evaluate(monitor, points, { state, config, now = new Date() }) {
  const fired = [];
  const unchanged = () => ({
    alerts: [],
    state: { cooldowns: state?.cooldowns || {}, dayFired: state?.dayFired || {}, sides: state?.sides || {} },
  });
  if (!Array.isArray(points) || points.length === 0) return unchanged();
  if (monitor.enabled === false) return unchanged();

  const latest = points[points.length - 1];
  const total = Number(latest?.price?.total);
  if (!Number.isFinite(total) || total <= 0) return unchanged();

  const previous = points.slice(0, -1);
  const priorTotals = previous.map((point) => Number(point?.price?.total)).filter((value) => Number.isFinite(value) && value > 0);
  const minBefore = priorTotals.length ? Math.min(...priorTotals) : null;
  const maxBefore = priorTotals.length ? Math.max(...priorTotals) : null;
  const today = isoDate(now);
  const cooldownMs = Math.max(0, Number(config?.notify?.cooldownMinutes ?? 360)) * 60000;

  const cooldowns = { ...(state.cooldowns || {}) };
  const dayFired = { ...(state.dayFired || {}) };
  const sides = { ...(state.sides || {}) };

  const canFire = (kind) => {
    const key = `${monitor.id}:${kind}`;
    if (dayFired[key] === today) return false;
    const last = Date.parse(cooldowns[key] || '');
    if (Number.isFinite(last) && now.getTime() - last < cooldownMs) return false;
    return true;
  };

  const push = (kind, ref) => {
    const key = `${monitor.id}:${kind}`;
    cooldowns[key] = isoNow();
    if (kind === 'new_low' || kind === 'new_high') dayFired[key] = today;
    fired.push({
      id: `a_${Math.random().toString(16).slice(2, 10)}`,
      monitorId: monitor.id,
      monitorTitle: monitor.title,
      rule: kind,
      level: RULE_LEVEL[kind] || 'info',
      firedAt: isoNow(),
      total,
      ref: ref ?? null,
      params: monitor.params,
    });
  };

  for (const rule of monitor.rules || []) {
    if (!rule || typeof rule !== 'object') continue;

    if (rule.kind === 'target') {
      const target = Number(rule.value);
      if (!Number.isFinite(target) || target <= 0) continue;
      const key = `${monitor.id}:target`;
      const nextSide = total <= target ? 'below' : 'above';
      const previousSide = sides[key];
      sides[key] = nextSide;
      // First evaluation only records the side; firing needs a real crossing.
      if (previousSide === 'above' && nextSide === 'below' && canFire('target')) push('target', target);
      continue;
    }

    if (rule.kind === 'new_low') {
      if (minBefore === null) continue;
      if (total < minBefore && canFire('new_low')) push('new_low', minBefore);
      continue;
    }

    if (rule.kind === 'new_high') {
      if (maxBefore === null) continue;
      if (total > maxBefore && canFire('new_high')) push('new_high', maxBefore);
      continue;
    }
  }

  return { alerts: fired, state: { cooldowns, dayFired, sides } };
}
