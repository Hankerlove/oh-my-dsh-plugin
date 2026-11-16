/**
 * Outbound notifications.
 *
 * The Host has no notification service, so the plugin posts to a Feishu custom
 * bot webhook itself. Delivery is best effort: three attempts with backoff, and
 * a failure is recorded on the alert instead of thrown at the scheduler.
 */
import { sleep } from './util.js';

const TEMPLATE = {
  new_low: 'green',
  target: 'green',
  new_high: 'red',
  anomaly: 'orange',
  digest: 'blue',
};

const EMOJI = {
  new_low: '🔻',
  target: '🎯',
  new_high: '🔺',
  anomaly: '⚠️',
  digest: '📊',
};

const HEADLINE = {
  new_low: { zh: '机票新低', en: 'New fare low' },
  target: { zh: '到达目标价', en: 'Target reached' },
  new_high: { zh: '机票新高', en: 'New fare high' },
  anomaly: { zh: '价格监控需要处理', en: 'Price watch needs attention' },
  digest: { zh: '价格日报', en: 'Daily digest' },
};

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `¥${Math.round(n).toLocaleString('zh-CN')}` : '—';
}

function dayLabel(params) {
  if (!params) return '';
  if (params.trip === 'round') return `${params.departDate} → ${params.returnDate}`;
  return params.departDate;
}

/** Build one Feishu interactive card for one alert. */
export function buildAlertCard(alert, { panelUrl, locale = 'zh' }) {
  const kind = alert?.rule || 'digest';
  const headline = HEADLINE[kind]?.[locale] || HEADLINE[kind]?.zh || kind;
  const title = `${EMOJI[kind] || '•'} ${headline} · ${alert?.monitorTitle || ''}`.trim();

  const lines = [];
  lines.push(`**${dayLabel(alert?.params)}**　${money(alert?.total)}（含机建燃油·日历估算）`);
  if (kind === 'new_low' && Number.isFinite(alert?.ref)) lines.push(`上一最低价 ${money(alert.ref)}`);
  if (kind === 'new_high' && Number.isFinite(alert?.ref)) lines.push(`上一最高价 ${money(alert.ref)}`);
  if (kind === 'target' && Number.isFinite(alert?.ref)) lines.push(`目标价 ${money(alert.ref)}`);
  lines.push(`采集时间 ${String(alert?.firedAt || '').replace('T', ' ').replace(/\..*$/, '')}`);

  const elements = [{ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } }];
  if (panelUrl) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: locale === 'en' ? 'Open panel' : '查看走势' },
          url: panelUrl,
          type: 'primary',
        },
      ],
    });
  }

  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { template: TEMPLATE[kind] || 'blue', title: { tag: 'plain_text', content: title.slice(0, 100) } },
      elements,
    },
  };
}

/** Build the daily digest card from `[{ monitor, total, at }]` rows. */
export function buildDigestCard(rows, { panelUrl, locale = 'zh' }) {
  const lines = rows.map((row) => {
    const price = money(row.total);
    const when = row.at ? `（${String(row.at).slice(5, 16).replace('T', ' ')}）` : '';
    return `**${row.monitor?.title || ''}**　${dayLabel(row.monitor?.params)}　${price}${when}`;
  });
  if (lines.length === 0) lines.push(locale === 'en' ? 'No monitored route has data yet.' : '还没有采集到任何价格。');
  const elements = [{ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } }];
  if (panelUrl) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: locale === 'en' ? 'Open panel' : '查看走势' },
          url: panelUrl,
          type: 'default',
        },
      ],
    });
  }
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: 'blue',
        title: { tag: 'plain_text', content: `${EMOJI.digest} ${HEADLINE.digest[locale] || HEADLINE.digest.zh}` },
      },
      elements,
    },
  };
}

/**
 * POST one card to a Feishu webhook. Never throws.
 * @returns {Promise<{ok:boolean, attempts:number, error?:string}>}
 */
export async function sendFeishu(webhook, card, { logger, signal } = {}) {
  const url = String(webhook || '').trim();
  if (!/^https:\/\//i.test(url)) return { ok: false, attempts: 0, error: '未配置有效的飞书 webhook' };

  const delays = [0, 1000, 4000];
  let lastError = '';
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (attempt > 0) await sleep(delays[attempt]);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(card),
        signal,
      });
      const text = await response.text().catch(() => '');
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON reply */
      }
      const code = payload?.code ?? payload?.StatusCode ?? 0;
      if (response.ok && (code === 0 || code === undefined)) return { ok: true, attempts: attempt + 1 };
      lastError = `HTTP ${response.status} ${String(text).slice(0, 120)}`;
    } catch (error) {
      lastError = String(error?.message || error);
    }
    logger?.warn?.(`飞书推送第 ${attempt + 1} 次失败: ${lastError}`);
  }
  return { ok: false, attempts: delays.length, error: lastError };
}
