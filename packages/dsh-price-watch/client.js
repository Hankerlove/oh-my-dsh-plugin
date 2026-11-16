/**
 * Client half of the `@ultraslow/dsh-price-watch` bundle.
 *
 * Two slots and no floating layer:
 *  - `sidebar.panellist` contributes the price-tag glyph shown in the sidebar's
 *    global panel list. The sidebar owns the button, resolves the label from
 *    this registration's metadata, and opens the `main` panel whose key matches
 *    the list id; the glyph only draws itself.
 *  - `main` renders the whole page: a toolbar, a health strip, and four internal
 *    views (list / detail / settings / new) switched with component state.
 *
 * Data comes from this bundle's Host half over same-origin JSON:
 *   GET   /price-watch/api/status
 *   GET   /price-watch/api/monitors                     latest + sparkline points
 *   POST  /price-watch/api/monitors
 *   PATCH /price-watch/api/monitors/:id                 enabled / rules / passengers / params / cadence
 *   DELETE /price-watch/api/monitors/:id
 *   POST  /price-watch/api/monitors/:id/refresh
 *   GET   /price-watch/api/monitors/:id/prices?days=90
 *   GET/POST /price-watch/api/passengers, PATCH/DELETE /price-watch/api/passengers/:id
 *   GET/POST /price-watch/api/settings
 * Every response is `{ ok: true, data }` or `{ ok: false, error }`. The request
 * helper unwraps the first shape and turns the second into an Error carrying the
 * Host's own message, including on non-2xx responses.
 *
 * Failure policy: nothing here may cost the reader the entire Web UI. The two
 * registrations sit inside one try/catch, every failure keeps the previously
 * loaded data and raises an inline error bar, and an unreachable Host half
 * degrades to the empty state with a retry button instead of a blank page.
 */
window.__ModuleLoader__.load({
	id: '@ultraslow/dsh-price-watch',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		const { useCallback, useEffect, useMemo, useRef, useState } = React;

		// #region constants
		/** Locale namespace owned by this bundle. */
		const NS = 'price-watch';
		/** Host half route prefix (same origin as the Web UI). */
		const API_PREFIX = '/price-watch/api';
		/** Sidebar list id and `main` panel key; the sidebar pairs them by id. */
		const PANEL_ID = 'price-watch';
		/** How often the list and status strip re-read the Host. */
		const POLL_MS = 30000;
		/** Cadence choices offered in settings, in minutes. */
		const CADENCE_CHOICES = [15, 30, 60, 360];
		/** Fallback cadence when settings are not loaded yet. */
		const DEFAULT_CADENCE = 60;
		/** How much history the detail chart asks for. */
		const PRICE_DAYS = 90;
		const SPARK_WIDTH = 120;
		const SPARK_HEIGHT = 32;
		const CHART_WIDTH = 800;
		const CHART_HEIGHT = 220;
		const PASSENGER_TYPES = ['adult', 'student', 'child'];
		// #endregion

		// #region locale bridge
		/**
		 * The slot renderer hands components no props (a `main` panel is rendered
		 * as `renderSlot("main", {}, ...)`), so the bound translator and a revision
		 * counter live in this factory-scoped bridge. `apply` fills in `t` and bumps
		 * the counter whenever the active locale or the dictionaries change; the
		 * page subscribes so every label re-renders without a remount.
		 */
		function createRevision() {
			let value = 0;
			const listeners = new Set();
			return {
				get: () => value,
				bump: () => {
					value += 1;
					for (const listener of [...listeners]) {
						try {
							listener();
						} catch (error) {
							// A broken listener must not stop the others.
						}
					}
				},
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
			};
		}

		const runtime = {
			t: (key) => key,
			revision: createRevision(),
		};

		/** Re-render the caller when the locale changes. */
		function useLocaleRevision() {
			const [, setVersion] = useState(0);
			useEffect(() => runtime.revision.subscribe(() => setVersion((value) => value + 1)), []);
		}

		const t = (key, params) => runtime.t(key, params);
		// #endregion

		// #region formatting helpers
		function pad2(value) {
			return String(value).padStart(2, '0');
		}

		function parseTime(value) {
			if (typeof value !== 'string' || value === '') return null;
			const ms = Date.parse(value);
			return Number.isFinite(ms) ? ms : null;
		}

		/** Parse `YYYY-MM-DD` as a local calendar day (Date.parse would use UTC). */
		function parseDateOnly(value) {
			if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
			const parts = value.split('-').map(Number);
			const date = new Date(parts[0], parts[1] - 1, parts[2]);
			if (!Number.isFinite(date.getTime())) return null;
			if (date.getFullYear() !== parts[0] || date.getMonth() !== parts[1] - 1 || date.getDate() !== parts[2]) return null;
			return date;
		}

		function toDate(value) {
			const dateOnly = parseDateOnly(value);
			if (dateOnly !== null) return dateOnly;
			const ms = parseTime(value);
			return ms === null ? null : new Date(ms);
		}

		function formatMoney(value) {
			if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
			return `¥${Math.round(value).toLocaleString()}`;
		}

		/** `12/24`, or `—` when the Host sent nothing usable. */
		function shortDate(value) {
			const date = toDate(value);
			if (date === null || !Number.isFinite(date.getTime())) return '—';
			return `${date.getMonth() + 1}/${date.getDate()}`;
		}

		/** Toolbar status time: `12:30` today, `12/24 12:30` otherwise. */
		function formatLastCollect(value) {
			const date = toDate(value);
			if (date === null || !Number.isFinite(date.getTime())) return null;
			const now = new Date();
			const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
			const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
			return sameDay ? clock : `${date.getMonth() + 1}/${date.getDate()} ${clock}`;
		}

		function formatDateTime(ms) {
			const date = new Date(ms);
			return `${date.getMonth() + 1}/${date.getDate()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
		}

		/** `刚刚` / `x 分钟前` / `x 小时前` / `x 天前`. */
		function relativeTime(value) {
			const date = toDate(value);
			if (date === null || !Number.isFinite(date.getTime())) return t('time.never');
			const diff = Date.now() - date.getTime();
			if (!Number.isFinite(diff)) return t('time.never');
			if (diff < 45000) return t('time.justNow');
			const minutes = Math.floor(diff / 60000);
			if (minutes < 60) return t('time.minutes', { n: minutes });
			const hours = Math.floor(minutes / 60);
			if (hours < 24) return t('time.hours', { n: hours });
			return t('time.days', { n: Math.floor(hours / 24) });
		}

		/** Localised city name from the dictionary, falling back to the raw IATA code. */
		function cityLabel(code) {
			const raw = typeof code === 'string' ? code.trim().toUpperCase() : '';
			if (raw === '') return '—';
			const key = `city.${raw}`;
			const label = t(key);
			return label === key ? raw : label;
		}

		// #endregion

		// #region monitor helpers
		function monitorParams(monitor) {
			return monitor && typeof monitor === 'object' && monitor.params && typeof monitor.params === 'object' ? monitor.params : {};
		}

		function monitorRules(monitor) {
			return monitor && Array.isArray(monitor.rules) ? monitor.rules.filter((rule) => rule && typeof rule === 'object') : [];
		}

		function ruleTarget(rules) {
			for (const rule of Array.isArray(rules) ? rules : []) {
				if (!rule || rule.kind !== 'target') continue;
				if (typeof rule.value === 'number' && Number.isFinite(rule.value)) return rule.value;
			}
			return null;
		}

		function ruleHas(rules, kind) {
			return (Array.isArray(rules) ? rules : []).some((rule) => rule && rule.kind === kind);
		}

		function monitorTrip(monitor) {
			return monitorParams(monitor).trip === 'round' ? 'round' : 'oneway';
		}

		/** `上海 → 北京`, using `⇄` for round trips. */
		function monitorRoute(monitor) {
			const params = monitorParams(monitor);
			const arrow = monitorTrip(monitor) === 'round' ? '⇄' : '→';
			return `${cityLabel(params.dep)} ${arrow} ${cityLabel(params.arr)}`;
		}

		/** `单程 · 12/24` or `往返 · 12/24 – 12/27`. */
		function monitorDates(monitor) {
			const params = monitorParams(monitor);
			const trip = monitorTrip(monitor);
			const depart = shortDate(params.departDate);
			if (trip !== 'round') return `${t('card.oneway')} · ${depart}`;
			return `${t('card.round')} · ${depart} – ${shortDate(params.returnDate)}`;
		}

		/** API list points are `[[atISO, total], ...]`, oldest first. */
		function normalizeSeries(points) {
			if (!Array.isArray(points)) return [];
			const out = [];
			for (const point of points) {
				if (!Array.isArray(point) || point.length < 2) continue;
				const total = typeof point[1] === 'number' && Number.isFinite(point[1]) ? point[1] : null;
				if (total === null) continue;
				out.push({ at: parseTime(point[0]), total });
			}
			return out;
		}

		/** Price endpoint points are `{ at, total, bare, src }`, oldest first. */
		function normalizePricePoints(points) {
			if (!Array.isArray(points)) return [];
			const out = [];
			for (const point of points) {
				if (!point || typeof point !== 'object') continue;
				if (typeof point.total !== 'number' || !Number.isFinite(point.total)) continue;
				const at = parseTime(point.at);
				if (at === null) continue;
				out.push({
					at,
					total: point.total,
					bare: typeof point.bare === 'number' && Number.isFinite(point.bare) ? point.bare : null,
					src: typeof point.src === 'string' ? point.src : '',
				});
			}
			out.sort((left, right) => left.at - right.at);
			return out;
		}

		function latestTotal(monitor) {
			const latest = monitor && monitor.latest && typeof monitor.latest === 'object' ? monitor.latest : null;
			if (latest !== null && typeof latest.total === 'number' && Number.isFinite(latest.total)) {
				return { total: latest.total, at: typeof latest.at === 'string' ? latest.at : null };
			}
			const series = normalizeSeries(monitor && monitor.points);
			if (series.length === 0) return null;
			const last = series[series.length - 1];
			return { total: last.total, at: typeof last.at === 'number' ? new Date(last.at).toISOString() : null };
		}

		/** Percent change against the previous collection point, or null. */
		function trendPercent(series) {
			if (!Array.isArray(series) || series.length < 2) return null;
			const last = series[series.length - 1];
			const previous = series[series.length - 2];
			if (!Number.isFinite(last.total) || !Number.isFinite(previous.total) || previous.total <= 0) return null;
			return ((last.total - previous.total) / previous.total) * 100;
		}

		function trendChip(delta) {
			if (delta === null || !Number.isFinite(delta)) return { tone: 'flat', text: '—' };
			if (Math.abs(delta) < 0.5) return { tone: 'flat', text: '—' };
			const rounded = Math.round(Math.abs(delta));
			return delta > 0 ? { tone: 'up', text: `↑${rounded}%` } : { tone: 'down', text: `↓${rounded}%` };
		}

		function lowestTotal(series) {
			let lowest = null;
			for (const point of Array.isArray(series) ? series : []) {
				if (!Number.isFinite(point.total)) continue;
				if (lowest === null || point.total < lowest) lowest = point.total;
			}
			return lowest;
		}

		function highestTotal(series) {
			let highest = null;
			for (const point of Array.isArray(series) ? series : []) {
				if (!Number.isFinite(point.total)) continue;
				if (highest === null || point.total > highest) highest = point.total;
			}
			return highest;
		}
		// #endregion

		// #region HTTP
		function apiError(message, status) {
			const error = new Error(message);
			error.name = 'ApiError';
			error.status = status;
			return error;
		}

		/**
		 * Same-origin JSON request. Resolves with `payload.data`, rejects with an
		 * Error whose message is safe to show (Host text when present, a localized
		 * fallback otherwise). `credentials: 'same-origin'` keeps the Web UI session
		 * cookie on the request so the Host's own origin guard passes.
		 */
		async function apiFetch(path, options) {
			const settings = options && typeof options === 'object' ? options : {};
			const init = {
				method: typeof settings.method === 'string' ? settings.method : 'GET',
				credentials: 'same-origin',
				headers: { Accept: 'application/json' },
			};
			if (settings.body !== undefined) {
				init.headers['Content-Type'] = 'application/json';
				init.body = JSON.stringify(settings.body);
			}
			let response;
			try {
				response = await fetch(`${API_PREFIX}${path}`, init);
			} catch (error) {
				throw apiError(t('error.network'), 0);
			}
			let payload = null;
			try {
				payload = await response.json();
			} catch (error) {
				payload = null;
			}
			if (payload && payload.ok === true) return payload.data;
			const serverMessage = payload && typeof payload.error === 'string' ? payload.error.trim() : '';
			throw apiError(serverMessage !== '' ? serverMessage : t('error.http', { status: response.status }), response.status);
		}
		// #endregion

		// #region dictionaries
		const ZH = {
			nav: '价格监控',
			'list.new': '新建监控',
			'list.settings': '设置',
			'list.refresh': '刷新',
			'filter.all': '全部',
			'filter.flight': '机票',
			'status.ok': '采集正常',
			'status.warn': '采集异常',
			'status.never': '尚未采集',
			'status.last': '上次 {time}',
			'status.auth.unknown': '未登录',
			'status.auth.valid': '已登录',
			'status.auth.expired': '登录已过期',
			'status.auth.checking': '校验中',
			'status.auth.validAccount': '已登录 {account}',
			'status.auth.unavailable': '精确采集不可用',
			'status.auth.loggingIn': '请在弹出的窗口里登录…',
			'status.auth.blocked': '风控暂停至 {time}',
			'login.failed': '登录未完成，请重试',
			'login.notDetected': '未检测到登录，可重试',
			'login.logoutFailed': '退出登录失败，请重试',
			'login.pending': '登录中…',
			'card.oneway': '单程',
			'card.round': '往返',
			'card.waiting': '等待首次采集',
			'card.min': '历史最低 {price}',
			'card.target': '目标 {price}',
			'card.paused': '已暂停',
			'card.enable': '启用监控',
			'card.disable': '停用监控',
			'empty.title': '还没有价格监控',
			'empty.body': '新建一个监控后，插件会按设定频率自动采集机票最低价，留存历史曲线，并在跌破目标价或创新低、新高时提醒你。',
			'empty.action': '新建监控',
			'error.network': '网络请求失败，请检查连接后重试',
			'error.http': '请求失败（HTTP {status}）',
			'common.retry': '重试',
			'common.dismiss': '关闭',
			'common.saving': '保存中…',
			'common.listSeparator': '、',
			'detail.back': '返回',
			'detail.editRules': '编辑规则',
			'detail.pause': '暂停',
			'detail.resume': '启用',
			'detail.refresh': '立即刷新',
			'detail.delete': '删除',
			'detail.deleteConfirm': '删除这个监控？历史价格也会一并移除。',
			'detail.waiting': '还没有价格数据，稍后会按频率自动采集，也可以点「立即刷新」。',
			'detail.chart.title': '价格走势',
			'detail.chart.caption': '含税 · 日历最低价',
			'detail.stat.min': '最低',
			'detail.stat.max': '最高',
			'detail.stat.avg7': '7 日均价',
			'detail.stat.target': '目标价',
			'detail.rules.title': '提醒规则',
			'detail.rules.target': '目标价',
			'detail.rules.targetPlaceholder': '留空表示不设目标价',
			'detail.rules.newLow': '创新低',
			'detail.rules.newHigh': '创新高',
			'detail.rules.digest': '每日汇总',
			'detail.rules.empty': '还没有规则',
			'detail.rules.invalid': '目标价必须是正数。',
			'detail.rules.save': '保存规则',
			'detail.rules.cancel': '取消',
			'detail.passengers': '乘客',
			'detail.passengersCount': '{n} 位乘客',
			'detail.passengersPrefix': '乘客：{names}',
			'detail.cadence': '每 {n} 分钟采集',
			'chart.ref.min': '历史最低',
			'chart.ref.target': '目标价',
			'chart.ref.avg7': '7 日均价',
			'chart.empty': '还没有数据点',
			'chart.bare': '裸价 {price}',
			'settings.title': '设置',
			'settings.back': '返回',
			'settings.passengers.title': '乘客名单',
			'settings.passengers.help': '任务里勾选乘客，价格按乘客类型取最低可订票价。',
			'settings.passengers.empty': '还没有乘客，先添加一位。',
			'settings.passengers.nickname': '昵称',
			'settings.passengers.type': '类型',
			'settings.passengers.age': '年龄（可选）',
			'settings.passengers.ageUnit': '岁',
			'settings.passengers.ageInvalid': '年龄需在 0–120 之间。',
			'settings.passengers.nicknameRequired': '请填写昵称。',
			'settings.passengers.add': '添加',
			'settings.passengers.delete': '删除乘客',
			'settings.passengers.deleteConfirm': '删除乘客「{name}」？',
			'settings.passengers.referenced': '该乘客仍被任务引用，请先在任务里取消勾选。',
			'settings.feishu.title': '飞书通知',
			'settings.feishu.help': '在飞书单人群里添加自定义机器人，粘贴 webhook 地址。',
			'settings.feishu.placeholder': 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
			'settings.cadence.title': '采集频率',
			'settings.cadence.help': '越频繁越容易触发风控，默认 60 分钟。',
			'settings.l2.title': '精确采集',
			'settings.l2.enable': '启用精确采集（需登录携程）',
			'settings.l2.perDay': '每天最多精确采集次数',
			'settings.l2.times': '{n} 次',
			'settings.l2.help': '精确采集会用真实浏览器读取票价产品与含机建燃油总价；每天次数越多，被携程风控的概率越高。',
			'settings.l2.auth': '携程登录',
			'settings.l2.lastVerified': '上次校验 {time}',
			'settings.l2.neverVerified': '尚未校验登录态',
			'settings.login': '登录携程',
			'settings.logout': '退出登录',
			'settings.logoutConfirm': '退出登录会删除浏览器里的携程登录信息，确认退出？',
			'settings.notify.title': '通知降噪',
			'settings.notify.quiet': '静默时段',
			'settings.notify.cooldown': '冷却（分钟）',
			'settings.notify.digestAt': '每日汇总时间',
			'settings.save': '保存设置',
			'settings.saved': '已保存',
			'settings.saving': '保存中…',
			'new.title': '新建监控',
			'new.back': '取消',
			'new.route.title': '航线',
			'new.from': '出发地',
			'new.to': '目的地',
			'new.routeHint': '三字码：北京填 BJS、上海填 SHA。',
			'new.trip.title': '行程',
			'new.trip.oneway': '单程',
			'new.trip.round': '往返',
			'new.departDate': '出发日',
			'new.returnDate': '返回日',
			'new.passengers.title': '乘客',
			'new.passengers.help': '至少选 1 位乘客。',
			'new.passengers.empty': '还没有乘客，先去设置里添加乘客。',
			'new.passengers.goSettings': '去设置添加乘客',
			'new.target.title': '目标价（可选）',
			'new.target.help': '低于目标价时推送提醒。',
			'new.submit': '创建监控',
			'new.submitting': '创建中…',
			'new.required': '请填写必填项。',
			'new.invalidCode': '三字码必须是 3 个字母。',
			'new.sameCode': '出发地和目的地不能相同。',
			'new.passengerRequired': '至少选择 1 位乘客。',
			'new.returnRequired': '往返需要填写返回日。',
			'new.returnOrder': '返回日必须晚于出发日。',
			'type.adult': '成人',
			'type.student': '学生',
			'type.child': '儿童',
			'cadence.minutes': '{n} 分钟',
			'time.justNow': '刚刚',
			'time.minutes': '{n} 分钟前',
			'time.hours': '{n} 小时前',
			'time.days': '{n} 天前',
			'time.never': '从未',
			'rule.target': '目标价',
			'rule.new_low': '创新低',
			'rule.new_high': '创新高',
			'rule.digest': '每日汇总',
			'city.BJS': '北京',
			'city.PEK': '北京首都',
			'city.PKX': '北京大兴',
			'city.SHA': '上海',
			'city.PVG': '上海浦东',
			'city.CAN': '广州',
			'city.SZX': '深圳',
			'city.CTU': '成都',
			'city.TFU': '成都天府',
			'city.CKG': '重庆',
			'city.XIY': '西安',
			'city.HGH': '杭州',
			'city.NKG': '南京',
			'city.WUH': '武汉',
			'city.CSX': '长沙',
			'city.TAO': '青岛',
			'city.XMN': '厦门',
			'city.TSN': '天津',
			'city.CGO': '郑州',
			'city.SYX': '三亚',
			'city.HAK': '海口',
			'city.HRB': '哈尔滨',
			'city.SHE': '沈阳',
			'city.DLC': '大连',
			'city.KMG': '昆明',
			'city.KWE': '贵阳',
			'city.NNG': '南宁',
			'city.URC': '乌鲁木齐',
			'city.FOC': '福州',
			'city.TNA': '济南',
			'city.WNZ': '温州',
			'city.NGB': '宁波',
			'city.HFE': '合肥',
			'city.ZUH': '珠海',
			'city.LHW': '兰州',
			'city.TYN': '太原',
			'city.HET': '呼和浩特',
			'city.SJW': '石家庄',
			'city.INC': '银川',
			'city.XNN': '西宁',
			'city.CGQ': '长春',
			'city.LXA': '拉萨',
		};

		const EN = {
			nav: 'Price watch',
			'list.new': 'New watch',
			'list.settings': 'Settings',
			'list.refresh': 'Refresh',
			'filter.all': 'All',
			'filter.flight': 'Flights',
			'status.ok': 'Collector healthy',
			'status.warn': 'Collector failing',
			'status.never': 'Never collected',
			'status.last': 'Last {time}',
			'status.auth.unknown': 'Not signed in',
			'status.auth.valid': 'Signed in',
			'status.auth.expired': 'Sign-in expired',
			'status.auth.checking': 'Checking sign-in',
			'status.auth.validAccount': 'Signed in {account}',
			'status.auth.unavailable': 'Precise collection unavailable',
			'status.auth.loggingIn': 'Finish signing in in the opened window…',
			'status.auth.blocked': 'Rate-limited until {time}',
			'login.failed': 'Sign-in did not complete, try again',
			'login.notDetected': 'No sign-in detected, try again',
			'login.logoutFailed': 'Sign-out failed, try again',
			'login.pending': 'Signing in…',
			'card.oneway': 'One way',
			'card.round': 'Round trip',
			'card.waiting': 'Waiting for the first crawl',
			'card.min': 'Low {price}',
			'card.target': 'Target {price}',
			'card.paused': 'Paused',
			'card.enable': 'Enable watch',
			'card.disable': 'Disable watch',
			'empty.title': 'No price watches yet',
			'empty.body': 'Create a watch and this plugin polls the lowest fare on schedule, keeps a price history, and alerts you when the fare hits your target or sets a new low or high.',
			'empty.action': 'New watch',
			'error.network': 'Network request failed. Check your connection and retry.',
			'error.http': 'Request failed (HTTP {status})',
			'common.retry': 'Retry',
			'common.dismiss': 'Dismiss',
			'common.saving': 'Saving…',
			'common.listSeparator': ', ',
			'detail.back': 'Back',
			'detail.editRules': 'Edit rules',
			'detail.pause': 'Pause',
			'detail.resume': 'Resume',
			'detail.refresh': 'Refresh now',
			'detail.delete': 'Delete',
			'detail.deleteConfirm': 'Delete this watch? Its price history is removed too.',
			'detail.waiting': 'No prices yet. Collection runs on schedule, or press Refresh now.',
			'detail.chart.title': 'Price history',
			'detail.chart.caption': 'Tax included · calendar lowest fare',
			'detail.stat.min': 'Low',
			'detail.stat.max': 'High',
			'detail.stat.avg7': '7-day avg',
			'detail.stat.target': 'Target',
			'detail.rules.title': 'Alert rules',
			'detail.rules.target': 'Target price',
			'detail.rules.targetPlaceholder': 'Leave empty for no target',
			'detail.rules.newLow': 'New low',
			'detail.rules.newHigh': 'New high',
			'detail.rules.digest': 'Daily digest',
			'detail.rules.empty': 'No rules yet',
			'detail.rules.invalid': 'Target must be a positive number.',
			'detail.rules.save': 'Save rules',
			'detail.rules.cancel': 'Cancel',
			'detail.passengers': 'Passengers',
			'detail.passengersCount': '{n} passengers',
			'detail.passengersPrefix': 'Passengers: {names}',
			'detail.cadence': 'Collects every {n} min',
			'chart.ref.min': 'Historical low',
			'chart.ref.target': 'Target',
			'chart.ref.avg7': '7-day avg',
			'chart.empty': 'No data points yet',
			'chart.bare': 'Fare {price}',
			'settings.title': 'Settings',
			'settings.back': 'Back',
			'settings.passengers.title': 'Passengers',
			'settings.passengers.help': 'Pick passengers per watch; each price uses the cheapest fare that passenger can book.',
			'settings.passengers.empty': 'No passengers yet. Add one below.',
			'settings.passengers.nickname': 'Nickname',
			'settings.passengers.type': 'Type',
			'settings.passengers.age': 'Age (optional)',
			'settings.passengers.ageUnit': 'y',
			'settings.passengers.ageInvalid': 'Age must be between 0 and 120.',
			'settings.passengers.nicknameRequired': 'Nickname is required.',
			'settings.passengers.add': 'Add',
			'settings.passengers.delete': 'Delete passenger',
			'settings.passengers.deleteConfirm': 'Delete passenger "{name}"?',
			'settings.passengers.referenced': 'This passenger is still used by a watch. Uncheck it there first.',
			'settings.feishu.title': 'Feishu notifications',
			'settings.feishu.help': 'Add a custom bot to a Feishu group, then paste its webhook URL here.',
			'settings.feishu.placeholder': 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
			'settings.cadence.title': 'Collection cadence',
			'settings.cadence.help': 'Frequent polling risks rate limiting. 60 minutes by default.',
			'settings.l2.title': 'Precise collection',
			'settings.l2.enable': 'Enable precise collection (Ctrip sign-in required)',
			'settings.l2.perDay': 'Precise collections per day',
			'settings.l2.times': '{n}×',
			'settings.l2.help': 'Precise collection drives a real browser to read fare products and the tax-included total. More runs per day raises the chance of Ctrip rate limiting.',
			'settings.l2.auth': 'Ctrip sign-in',
			'settings.l2.lastVerified': 'Last checked {time}',
			'settings.l2.neverVerified': 'Sign-in has not been checked yet',
			'settings.login': 'Sign in to Ctrip',
			'settings.logout': 'Sign out',
			'settings.logoutConfirm': 'Signing out deletes the Ctrip session stored in the browser profile. Continue?',
			'settings.notify.title': 'Notification quieting',
			'settings.notify.quiet': 'Quiet hours',
			'settings.notify.cooldown': 'Cooldown (minutes)',
			'settings.notify.digestAt': 'Digest time',
			'settings.save': 'Save settings',
			'settings.saved': 'Saved',
			'settings.saving': 'Saving…',
			'new.title': 'New watch',
			'new.back': 'Cancel',
			'new.route.title': 'Route',
			'new.from': 'From',
			'new.to': 'To',
			'new.routeHint': 'IATA codes: Beijing is BJS, Shanghai is SHA.',
			'new.trip.title': 'Trip',
			'new.trip.oneway': 'One way',
			'new.trip.round': 'Round trip',
			'new.departDate': 'Departure',
			'new.returnDate': 'Return',
			'new.passengers.title': 'Passengers',
			'new.passengers.help': 'Pick at least one passenger.',
			'new.passengers.empty': 'No passengers yet. Add one in Settings first.',
			'new.passengers.goSettings': 'Add passengers in Settings',
			'new.target.title': 'Target price (optional)',
			'new.target.help': 'Get notified when the fare drops below this.',
			'new.submit': 'Create watch',
			'new.submitting': 'Creating…',
			'new.required': 'Fill in the required fields.',
			'new.invalidCode': 'Airport codes must be 3 letters.',
			'new.sameCode': 'Origin and destination must differ.',
			'new.passengerRequired': 'Pick at least one passenger.',
			'new.returnRequired': 'Round trips need a return date.',
			'new.returnOrder': 'Return must be after departure.',
			'type.adult': 'Adult',
			'type.student': 'Student',
			'type.child': 'Child',
			'cadence.minutes': '{n} min',
			'time.justNow': 'just now',
			'time.minutes': '{n} min ago',
			'time.hours': '{n} h ago',
			'time.days': '{n} d ago',
			'time.never': 'never',
			'rule.target': 'Target price',
			'rule.new_low': 'New low',
			'rule.new_high': 'New high',
			'rule.digest': 'Daily digest',
			'city.BJS': 'Beijing',
			'city.PEK': 'Beijing Capital',
			'city.PKX': 'Beijing Daxing',
			'city.SHA': 'Shanghai',
			'city.PVG': 'Shanghai Pudong',
			'city.CAN': 'Guangzhou',
			'city.SZX': 'Shenzhen',
			'city.CTU': 'Chengdu',
			'city.TFU': 'Chengdu Tianfu',
			'city.CKG': 'Chongqing',
			'city.XIY': "Xi'an",
			'city.HGH': 'Hangzhou',
			'city.NKG': 'Nanjing',
			'city.WUH': 'Wuhan',
			'city.CSX': 'Changsha',
			'city.TAO': 'Qingdao',
			'city.XMN': 'Xiamen',
			'city.TSN': 'Tianjin',
			'city.CGO': 'Zhengzhou',
			'city.SYX': 'Sanya',
			'city.HAK': 'Haikou',
			'city.HRB': 'Harbin',
			'city.SHE': 'Shenyang',
			'city.DLC': 'Dalian',
			'city.KMG': 'Kunming',
			'city.KWE': 'Guiyang',
			'city.NNG': 'Nanning',
			'city.URC': 'Urumqi',
			'city.FOC': 'Fuzhou',
			'city.TNA': 'Jinan',
			'city.WNZ': 'Wenzhou',
			'city.NGB': 'Ningbo',
			'city.HFE': 'Hefei',
			'city.ZUH': 'Zhuhai',
			'city.LHW': 'Lanzhou',
			'city.TYN': 'Taiyuan',
			'city.HET': 'Hohhot',
			'city.SJW': 'Shijiazhuang',
			'city.INC': 'Yinchuan',
			'city.XNN': 'Xining',
			'city.CGQ': 'Changchun',
			'city.LXA': 'Lhasa',
		};
		// #endregion

		// #region styles
		/**
		 * One scoped `<style>` node, injected by `apply` through `ctx.effect` and
		 * removed when the plugin unloads. Every selector is rooted at `.pw-root`
		 * (plus the prefixed keyframes), and every color is a `--dsw-alias-*`
		 * theme token, so dark mode comes from the host variables for free.
		 */
		const STYLE_TEXT = `
.pw-root { box-sizing: border-box; display: flex; flex-direction: column; flex: 1 1 auto; height: 100%; min-height: 0; overflow: hidden; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px; line-height: 1.5; }
.pw-root *, .pw-root *::before, .pw-root *::after { box-sizing: border-box; }
.pw-toolbar { flex: none; display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.pw-page-title { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
.pw-page-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.pw-strip { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 20px; border-bottom: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font-size: 12px; flex-wrap: wrap; }
.pw-strip-sep { color: var(--dsw-alias-border-l2); }
.pw-scroll { flex: 1; min-height: 0; overflow: auto; scrollbar-width: thin; scrollbar-color: var(--dsw-alias-border-l2) transparent; }
.pw-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.pw-scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2); border-radius: 999px; }
.pw-scroll::-webkit-scrollbar-track { background: transparent; }
.pw-body { width: 100%; max-width: 880px; margin: 0 auto; padding: 16px 20px 28px; display: flex; flex-direction: column; gap: 12px; }
.pw-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px; line-height: 1; cursor: pointer; white-space: nowrap; transition: background 120ms ease, border-color 120ms ease, color 120ms ease; }
.pw-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.pw-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.pw-btn:disabled { opacity: 0.55; cursor: default; }
.pw-btn-sm { height: 26px; padding: 0 9px; font-size: 12px; border-radius: 8px; }
.pw-btn-primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); font-weight: 500; }
.pw-btn-primary:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.pw-btn-danger { border-color: var(--dsw-alias-border-l1); color: var(--dsw-alias-state-error-primary); }
.pw-btn-danger:hover:not(:disabled) { border-color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-2); }
.pw-btn-lg { height: 34px; padding: 0 16px; border-radius: 11px; }
.pw-iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; transition: background 120ms ease, color 120ms ease; }
.pw-iconbtn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.pw-iconbtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.pw-iconbtn:disabled { opacity: 0.5; cursor: default; }
.pw-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.pw-col { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pw-grow { flex: 1; min-width: 0; }
.pw-muted { color: var(--dsw-alias-label-secondary); }
.pw-mono { font-variant-numeric: tabular-nums; }
.pw-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pw-card { position: relative; display: flex; align-items: center; gap: 14px; padding: 13px 16px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); cursor: pointer; text-align: left; font-family: inherit; color: var(--dsw-alias-label-primary); transition: background 120ms ease, border-color 120ms ease; }
.pw-card:hover { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.pw-card:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.pw-card[data-disabled="true"] { opacity: 0.62; }
.pw-card[data-disabled="true"]:hover { opacity: 0.85; }
.pw-card-title { display: flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 500; min-width: 0; }
.pw-card-meta { font-size: 12px; color: var(--dsw-alias-label-secondary); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.pw-price { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.pw-spark { flex: none; display: block; overflow: visible; }
.pw-chip { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 20px; padding: 0 7px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); font-size: 11px; font-weight: 500; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pw-chip[data-tone="up"] { color: var(--dsw-alias-state-error-primary); }
.pw-chip[data-tone="down"] { color: var(--dsw-alias-state-success-primary); }
.pw-chip[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.pw-chip[data-tone="flat"] { color: var(--dsw-alias-label-secondary); }
.pw-chip[data-tone="brand"] { color: var(--dsw-alias-brand-primary); }
.pw-authchip { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px; border-radius: 999px; border: 1px solid transparent; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 11px; font-weight: 500; line-height: 1; white-space: nowrap; }
.pw-authchip[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
.pw-authchip[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.pw-authchip[data-tone="idle"] { color: var(--dsw-alias-label-secondary); }
.pw-authchip[data-clickable="true"] { cursor: pointer; border-color: var(--dsw-alias-border-l1); }
.pw-authchip[data-clickable="true"]:hover { background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); }
.pw-authchip[data-clickable="true"]:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.pw-authchip[data-busy="true"] { color: var(--dsw-alias-label-secondary); }
.pw-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex: none; }
.pw-dot[data-tone="ok"] { background: var(--dsw-alias-state-success-primary); }
.pw-dot[data-tone="warn"] { background: var(--dsw-alias-state-warn-primary); }
.pw-dot[data-tone="error"] { background: var(--dsw-alias-state-error-primary); }
.pw-switch { position: relative; flex: none; width: 36px; height: 20px; padding: 0; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-3); cursor: pointer; transition: background 140ms ease, border-color 140ms ease; }
.pw-switch > span { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--dsw-alias-bg-base); transition: transform 140ms ease; }
.pw-switch[data-state="on"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.pw-switch[data-state="on"] > span { transform: translateX(16px); }
.pw-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.pw-switch:disabled { opacity: 0.5; cursor: default; }
.pw-input { width: 100%; height: 32px; padding: 0 10px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px; outline: none; transition: border-color 120ms ease; }
.pw-input:focus { border-color: var(--dsw-alias-brand-primary); }
.pw-input::placeholder { color: var(--dsw-alias-label-secondary); }
.pw-input:disabled { opacity: 0.6; }
.pw-input[data-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
select.pw-input { padding-right: 6px; cursor: pointer; }
textarea.pw-input { height: auto; min-height: 60px; padding: 8px 10px; resize: vertical; }
.pw-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pw-label { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.pw-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.pw-section { display: flex; flex-direction: column; gap: 12px; padding: 16px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.pw-section-head { display: flex; flex-direction: column; gap: 3px; }
.pw-section-title { font-size: 14px; font-weight: 600; }
.pw-section-help { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.pw-divider { height: 1px; background: var(--dsw-alias-border-l1); }
.pw-errbar { display: flex; align-items: center; gap: 10px; margin: 12px 20px 0; padding: 9px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px; }
.pw-notice { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-state-success-primary); font-size: 12px; }
.pw-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 64px 24px; text-align: center; }
.pw-empty-icon { width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-brand-primary); }
.pw-empty-title { font-size: 14px; font-weight: 600; }
.pw-empty-body { font-size: 12px; color: var(--dsw-alias-label-secondary); max-width: 420px; line-height: 1.6; }
.pw-skeleton { background: var(--dsw-alias-bg-layer-2); border-radius: 6px; animation: pw-skeleton-pulse 1600ms ease-in-out infinite; }
@keyframes pw-skeleton-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
.pw-passenger-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.pw-passenger-name { font-size: 13px; font-weight: 500; }
.pw-form-row { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
.pw-form-row > .pw-field { flex: 1 1 140px; }
.pw-tabs { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.pw-tab { height: 24px; padding: 0 10px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 12px; cursor: pointer; }
.pw-tab:hover { color: var(--dsw-alias-label-primary); }
.pw-tab[data-active="true"] { background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); font-weight: 500; }
.pw-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.pw-selectable { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 11px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px; cursor: pointer; transition: border-color 120ms ease, background 120ms ease; }
.pw-selectable:hover { background: var(--dsw-alias-bg-layer-2); }
.pw-selectable[data-selected="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.pw-selectable:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.pw-check { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-brand-primary); }
.pw-selectable[data-selected="true"] .pw-check { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.pw-chart-wrap { position: relative; width: 100%; }
.pw-chart { display: block; width: 100%; height: auto; overflow: visible; }
.pw-chart[data-hover="true"] { cursor: crosshair; }
.pw-tooltip { position: absolute; transform: translate(-50%, -118%); min-width: 84px; padding: 5px 8px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.45; white-space: nowrap; pointer-events: none; z-index: 2; }
.pw-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.pw-stat { display: flex; flex-direction: column; gap: 2px; padding: 9px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.pw-stat-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.pw-stat-value { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
.pw-rule-row { display: flex; align-items: center; gap: 10px; justify-content: space-between; padding: 4px 0; }
.pw-linkbtn { padding: 0; border: none; background: none; color: var(--dsw-alias-brand-primary); font-family: inherit; font-size: 12px; cursor: pointer; }
.pw-linkbtn:hover { text-decoration: underline; }
.pw-linkbtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: 4px; }
.pw-detail-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.pw-spacer { flex: 1; }
@media (max-width: 780px) { .pw-spark { display: none; } .pw-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } .pw-toolbar { flex-wrap: wrap; } }
@media (max-width: 520px) { .pw-card { flex-wrap: wrap; } }
`;
		// #endregion

		// #region icons
		function svgIcon(size, children, extra) {
			return h(
				'svg',
				{
					width: size,
					height: size,
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.7,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
					focusable: 'false',
					style: { display: 'block', flex: 'none' },
					...(extra || {}),
				},
				children
			);
		}

		const PlusIcon = (props) => svgIcon((props && props.size) || 16, h('path', { d: 'M12 5v14M5 12h14' }));
		const RefreshIcon = (props) => svgIcon((props && props.size) || 16, [h('path', { key: 'a', d: 'M20.5 12a8.5 8.5 0 1 1-2.5-6' }), h('path', { key: 'b', d: 'M20.5 4.5v6h-6' })]);
		const SettingsIcon = (props) => svgIcon((props && props.size) || 16, [
			h('path', { key: 'a', d: 'M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1' }),
			h('circle', { key: 'b', cx: 15, cy: 7, r: 2 }),
			h('circle', { key: 'c', cx: 9, cy: 12, r: 2 }),
			h('circle', { key: 'd', cx: 17, cy: 17, r: 2 }),
		]);
		const BackIcon = (props) => svgIcon((props && props.size) || 16, h('path', { d: 'M15 5l-7 7 7 7' }));
		const PlaneIcon = (props) => svgIcon((props && props.size) || 14, [h('path', { key: 'a', d: 'M21 3 3 10.6l7 2.4 2.4 7L21 3Z' }), h('path', { key: 'b', d: 'M10 13 21 3' })]);
		const TrashIcon = (props) => svgIcon((props && props.size) || 16, [h('path', { key: 'a', d: 'M4 7h16M9.5 7V4.8h5V7M6.5 7l1 13h9l1-13' }), h('path', { key: 'b', d: 'M10 11v5M14 11v5' })]);
		const PauseIcon = (props) => svgIcon((props && props.size) || 16, [h('path', { key: 'a', d: 'M9 5v14' }), h('path', { key: 'b', d: 'M15 5v14' })]);
		const PlayIcon = (props) => svgIcon((props && props.size) || 16, h('path', { d: 'M8 5l11 7-11 7V5Z' }));
		const TargetIcon = (props) => svgIcon((props && props.size) || 16, [
			h('circle', { key: 'a', cx: 12, cy: 12, r: 8.5 }),
			h('circle', { key: 'b', cx: 12, cy: 12, r: 4.2 }),
			h('circle', { key: 'c', cx: 12, cy: 12, r: 0.6, fill: 'currentColor', stroke: 'none' }),
		]);
		const CheckIcon = (props) => svgIcon((props && props.size) || 14, h('path', { d: 'M20 6 9 17l-5-5' }));
		const CloseIcon = (props) => svgIcon((props && props.size) || 14, h('path', { d: 'M6 6l12 12M18 6 6 18' }));
		const AlertIcon = (props) => svgIcon((props && props.size) || 16, [h('circle', { key: 'a', cx: 12, cy: 12, r: 9 }), h('path', { key: 'b', d: 'M12 7.5v5.5' }), h('circle', { key: 'c', cx: 12, cy: 16.5, r: 0.7, fill: 'currentColor', stroke: 'none' })]);
		const TagIcon = (props) => svgIcon((props && props.size) || 20, [
			h('path', { key: 'a', d: 'M4.2 4.2h6.1a2 2 0 0 1 1.42.59l8.1 8.1a2 2 0 0 1 0 2.83l-4.1 4.1a2 2 0 0 1-2.83 0l-8.1-8.1A2 2 0 0 1 4.2 10.3Z' }),
			h('circle', { key: 'b', cx: 7.6, cy: 7.6, r: 1.3 }),
			h('path', { key: 'c', d: 'M8.4 15.6 11.4 12.6 13.6 14.8 18.2 10.2' }),
		]);
		// #endregion

		// #region atoms
		function Button(props) {
			const variant = props.variant || 'default';
			const size = props.size || 'md';
			const className = ['pw-btn', variant === 'primary' ? 'pw-btn-primary' : null, variant === 'danger' ? 'pw-btn-danger' : null, size === 'sm' ? 'pw-btn-sm' : null, size === 'lg' ? 'pw-btn-lg' : null, props.className || null]
				.filter(Boolean)
				.join(' ');
			return h(
				'button',
				{
					type: 'button',
					className,
					title: props.title,
					disabled: props.disabled === true,
					onClick: props.onClick,
					'aria-label': props.ariaLabel,
				},
				props.icon || null,
				props.children === undefined || props.children === null ? null : h('span', null, props.children)
			);
		}

		function IconButton(props) {
			return h(
				'button',
				{
					type: 'button',
					className: 'pw-iconbtn',
					title: props.label,
					'aria-label': props.label,
					disabled: props.disabled === true,
					onClick: props.onClick,
					style: props.style,
				},
				props.children
			);
		}

		function Switch(props) {
			return h(
				'button',
				{
					type: 'button',
					className: 'pw-switch',
					role: 'switch',
					'aria-checked': props.checked ? 'true' : 'false',
					'aria-label': props.label,
					title: props.label,
					disabled: props.disabled === true,
					'data-state': props.checked ? 'on' : 'off',
					onClick: (event) => {
						event.stopPropagation();
						if (typeof props.onChange === 'function') props.onChange(!props.checked);
					},
				},
				h('span', null)
			);
		}

		function Chip(props) {
			return h('span', { className: 'pw-chip', 'data-tone': props.tone || 'flat', title: props.title }, props.children);
		}

		function Dot(props) {
			return h('span', { className: 'pw-dot', 'data-tone': props.tone || 'idle', 'aria-hidden': 'true' });
		}

		function Field(props) {
			return h(
				'div',
				{ className: 'pw-field' },
				props.label === undefined ? null : h('label', { className: 'pw-label' }, props.label),
				props.children,
				props.hint === undefined ? null : h('span', { className: 'pw-hint' }, props.hint),
				props.error === undefined || props.error === null || props.error === '' ? null : h('span', { className: 'pw-hint', style: { color: 'var(--dsw-alias-state-error-primary)' } }, props.error)
			);
		}

		function Section(props) {
			return h(
				'section',
				{ className: 'pw-section' },
				props.title === undefined
					? null
					: h('div', { className: 'pw-section-head' }, h('div', { className: 'pw-section-title' }, props.title), props.help === undefined ? null : h('div', { className: 'pw-section-help' }, props.help)),
				props.children
			);
		}

		function ErrorBar(props) {
			if (!props.message) return null;
			return h(
				'div',
				{ className: 'pw-errbar', role: 'alert', style: props.inline === true ? { margin: 0 } : undefined },
				h(AlertIcon, { size: 15 }),
				h('span', { className: 'pw-grow', style: { overflowWrap: 'anywhere' } }, props.message),
				props.onRetry === undefined ? null : h(Button, { size: 'sm', onClick: props.onRetry }, t('common.retry')),
				props.onDismiss === undefined
					? null
					: h(IconButton, { label: t('common.dismiss'), onClick: props.onDismiss }, h(CloseIcon, { size: 14 }))
			);
		}

		function Skeleton(props) {
			return h('div', {
				className: 'pw-skeleton',
				style: { height: props.height || 14, width: props.width || '100%', borderRadius: props.radius === undefined ? 6 : props.radius, ...(props.style || {}) },
			});
		}

		function EmptyState(props) {
			return h(
				'div',
				{ className: 'pw-empty' },
				h('div', { className: 'pw-empty-icon' }, props.icon || h(TagIcon, { size: 22 })),
				h('div', { className: 'pw-empty-title' }, props.title),
				props.body === undefined ? null : h('div', { className: 'pw-empty-body' }, props.body),
				props.action || null
			);
		}

		function Stats(props) {
			const entries = Array.isArray(props.items) ? props.items : [];
			return h(
				'div',
				{ className: 'pw-stats' },
				entries.map((entry, index) =>
					h(
						'div',
						{ className: 'pw-stat', key: entry.key || String(index) },
						h('span', { className: 'pw-stat-label' }, entry.label),
						h('span', { className: 'pw-stat-value' }, entry.value)
					)
				)
			);
		}
		// #endregion

		// #region charts
		/** Sparkline geometry: a bare polyline over the last collection points. */
		function buildSparkPath(points) {
			const series = normalizeSeries(points);
			if (series.length < 2) return null;
			const pad = 3;
			const width = SPARK_WIDTH - pad * 2;
			const height = SPARK_HEIGHT - pad * 2;
			let min = Infinity;
			let max = -Infinity;
			for (const point of series) {
				if (point.total < min) min = point.total;
				if (point.total > max) max = point.total;
			}
			const span = max - min || 1;
			const coords = series.map((point, index) => ({
				x: pad + (index / (series.length - 1)) * width,
				y: pad + (1 - (point.total - min) / span) * height,
			}));
			return {
				line: coords.map((coord, index) => `${index === 0 ? 'M' : 'L'}${coord.x.toFixed(1)} ${coord.y.toFixed(1)}`).join(' '),
				last: coords[coords.length - 1],
			};
		}

		function Sparkline(props) {
			const path = useMemo(() => buildSparkPath(props.points), [props.points]);
			if (path === null) return null;
			let stroke = 'var(--dsw-alias-brand-primary)';
			if (props.tone === 'up') stroke = 'var(--dsw-alias-state-error-primary)';
			else if (props.tone === 'down') stroke = 'var(--dsw-alias-state-success-primary)';
			return h(
				'svg',
				{
					className: 'pw-spark',
					width: SPARK_WIDTH,
					height: SPARK_HEIGHT,
					viewBox: `0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`,
					'aria-hidden': 'true',
					focusable: 'false',
				},
				h('path', { d: path.line, fill: 'none', stroke, strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
				h('circle', { cx: path.last.x, cy: path.last.y, r: 2, fill: stroke })
			);
		}

		/** Pick a 1/2/5 × 10^k step so the y axis carries four to five labels. */
		function niceStep(span, count) {
			if (!(span > 0)) return 1;
			const raw = span / Math.max(1, count);
			const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
			const residual = raw / magnitude;
			let step = 1;
			if (residual > 5) step = 10;
			else if (residual > 2) step = 5;
			else if (residual > 1) step = 2;
			return step * magnitude;
		}

		function numberOrNull(value) {
			return typeof value === 'number' && Number.isFinite(value) ? value : null;
		}

		/**
		 * Chart layout for the detail view: 800 × 220 viewBox, series line, area
		 * fill, three dashed reference lines and 4–5 y ticks. Pure — the hover
		 * state only indexes into `points`.
		 */
		function buildChart(points, stats) {
			const series = normalizePricePoints(points);
			if (series.length === 0) return null;
			const padLeft = 52;
			// Room on the right for the reference-line captions, including English ones.
			const padRight = 96;
			const padTop = 14;
			const padBottom = 26;
			const plotLeft = padLeft;
			const plotRight = CHART_WIDTH - padRight;
			const plotTop = padTop;
			const plotBottom = CHART_HEIGHT - padBottom;
			let minTime = series[0].at;
			let maxTime = series[series.length - 1].at;
			if (maxTime === minTime) {
				minTime -= 3600000;
				maxTime += 3600000;
			}
			const values = series.map((point) => point.total);
			const source = stats && typeof stats === 'object' ? stats : {};
			const references = [];
			const lowest = numberOrNull(source.min) === null ? lowestTotal(series) : numberOrNull(source.min);
			if (lowest !== null) references.push({ key: 'min', value: lowest, color: 'var(--dsw-alias-state-success-primary)' });
			const target = numberOrNull(source.target);
			if (target !== null) references.push({ key: 'target', value: target, color: 'var(--dsw-alias-state-warn-primary)' });
			const avg7 = numberOrNull(source.avg7);
			if (avg7 !== null) references.push({ key: 'avg7', value: avg7, color: 'var(--dsw-alias-state-idle-primary)' });
			const domain = values.concat(references.map((reference) => reference.value));
			let minValue = Math.min(...domain);
			let maxValue = Math.max(...domain);
			if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) return null;
			const spread = maxValue - minValue;
			const breathing = spread > 0 ? spread * 0.12 : Math.max(10, Math.abs(maxValue) * 0.05);
			minValue -= breathing;
			maxValue += breathing;
			if (maxValue === minValue) {
				minValue -= 1;
				maxValue += 1;
			}
			const xOf = (time) => plotLeft + ((time - minTime) / (maxTime - minTime)) * (plotRight - plotLeft);
			const yOf = (value) => plotBottom - ((value - minValue) / (maxValue - minValue)) * (plotBottom - plotTop);
			const step = niceStep(maxValue - minValue, 4);
			const ticks = [];
			const firstTick = Math.ceil(minValue / step) * step;
			for (let value = firstTick; value <= maxValue + step * 0.001 && ticks.length < 8; value += step) {
				ticks.push({ value, y: yOf(value) });
			}
			const coords = series.map((point) => ({ x: xOf(point.at), y: yOf(point.total), total: point.total, at: point.at, bare: point.bare }));
			const line = coords.map((coord, index) => `${index === 0 ? 'M' : 'L'}${coord.x.toFixed(1)} ${coord.y.toFixed(1)}`).join(' ');
			const area = `${line} L${coords[coords.length - 1].x.toFixed(1)} ${plotBottom} L${coords[0].x.toFixed(1)} ${plotBottom} Z`;
			const xLabels = [
				{ x: plotLeft, anchor: 'start', time: minTime },
				{ x: (plotLeft + plotRight) / 2, anchor: 'middle', time: (minTime + maxTime) / 2 },
				{ x: plotRight, anchor: 'end', time: maxTime },
			];
			return {
				series,
				coords,
				line,
				area,
				references,
				ticks,
				xLabels,
				plotLeft,
				plotRight,
				plotTop,
				plotBottom,
				xOf,
				yOf,
			};
		}

		function PriceChart(props) {
			const layout = useMemo(() => buildChart(props.points, props.stats), [props.points, props.stats]);
			const wrapRef = useRef(null);
			const [hoverIndex, setHoverIndex] = useState(null);
			const gradientId = useMemo(() => `pw-area-${Math.random().toString(36).slice(2, 8)}`, []);

			const handleMove = useCallback(
				(event) => {
					if (layout === null) return;
					const node = wrapRef.current;
					if (node === null) return;
					const rect = node.getBoundingClientRect();
					if (rect.width <= 0) return;
					const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
					const svgX = ratio * CHART_WIDTH;
					let best = 0;
					let bestDistance = Infinity;
					for (let index = 0; index < layout.coords.length; index += 1) {
						const distance = Math.abs(layout.coords[index].x - svgX);
						if (distance < bestDistance) {
							bestDistance = distance;
							best = index;
						}
					}
					setHoverIndex(best);
				},
				[layout]
			);

			const handleLeave = useCallback(() => setHoverIndex(null), []);

			if (layout === null) {
				return h(
					'div',
					{ className: 'pw-chart-wrap', style: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: 180, border: '1px dashed var(--dsw-alias-border-l1)', borderRadius: 12, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } },
					props.emptyText || t('chart.empty')
				);
			}

			const hover = hoverIndex !== null && hoverIndex >= 0 && hoverIndex < layout.coords.length ? layout.coords[hoverIndex] : null;
			const tooltipLeft = hover === null ? 0 : (hover.x / CHART_WIDTH) * 100;
			const tooltipTop = hover === null ? 0 : (hover.y / CHART_HEIGHT) * 100;
			const hovered = hover === null ? null : layout.series[hoverIndex];

			const children = [
				h(
					'defs',
					{ key: 'defs' },
					h(
						'linearGradient',
						{ id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1 },
						h('stop', { offset: '0%', stopColor: 'var(--dsw-alias-brand-primary)', stopOpacity: 0.18 }),
						h('stop', { offset: '100%', stopColor: 'var(--dsw-alias-brand-primary)', stopOpacity: 0 })
					)
				),
				layout.ticks.map((tick, index) =>
					h(
						'g',
						{ key: `tick-${index}` },
						h('line', { x1: layout.plotLeft - 4, y1: tick.y, x2: layout.plotLeft, y2: tick.y, stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 1 }),
						h('text', { x: layout.plotLeft - 8, y: tick.y, dy: '0.32em', textAnchor: 'end', fontSize: 11, fill: 'var(--dsw-alias-label-secondary)' }, formatMoney(tick.value))
					)
				),
				h('line', { key: 'baseline', x1: layout.plotLeft, y1: layout.plotBottom, x2: layout.plotRight, y2: layout.plotBottom, stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1 }),
				layout.xLabels.map((label, index) =>
					h('text', { key: `xlabel-${index}`, x: label.x, y: layout.plotBottom + 16, textAnchor: label.anchor, fontSize: 11, fill: 'var(--dsw-alias-label-secondary)' }, shortDate(new Date(label.time).toISOString()))
				),
				h('path', { key: 'area', d: layout.area, fill: `url(#${gradientId})`, stroke: 'none' }),
				h('path', { key: 'line', d: layout.line, fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
			];

			for (const reference of layout.references) {
				children.push(
					h(
						'g',
						{ key: `ref-${reference.key}` },
						h('line', {
							x1: layout.plotLeft,
							y1: layout.yOf(reference.value),
							x2: layout.plotRight,
							y2: layout.yOf(reference.value),
							stroke: reference.color,
							strokeWidth: 1,
							strokeDasharray: '4 4',
						}),
						h('text', { x: layout.plotRight + 8, y: layout.yOf(reference.value), dy: '0.32em', fontSize: 11, fill: reference.color }, t(`chart.ref.${reference.key}`))
					)
				);
			}

			if (hover !== null) {
				children.push(
					h('line', { key: 'crosshair', x1: hover.x, y1: layout.plotTop, x2: hover.x, y2: layout.plotBottom, stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 1, strokeDasharray: '3 3' }),
					h('circle', { key: 'hover-dot', cx: hover.x, cy: hover.y, r: 3.2, fill: 'var(--dsw-alias-bg-base)', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 2 })
				);
			}

			return h(
				'div',
				{
					className: 'pw-chart-wrap',
					ref: wrapRef,
					onMouseMove: handleMove,
					onMouseLeave: handleLeave,
				},
				h(
					'svg',
					{
						className: 'pw-chart',
						viewBox: `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`,
						role: 'img',
						'aria-label': t('detail.chart.title'),
						'data-hover': hover === null ? 'false' : 'true',
					},
					children
				),
				hovered === null
					? null
					: h(
							'div',
							{
								className: 'pw-tooltip',
								style: { left: `${tooltipLeft}%`, top: `${tooltipTop}%`, transform: hover.y < 70 ? 'translate(-50%, 16px)' : 'translate(-50%, -118%)' },
								role: 'status',
							},
							h('div', { style: { fontWeight: 500 } }, formatMoney(hovered.total)),
							h('div', { className: 'pw-muted' }, formatDateTime(hovered.at)),
							hovered.bare !== null && Math.round(hovered.bare) !== Math.round(hovered.total)
								? h('div', { className: 'pw-muted' }, t('chart.bare', { price: formatMoney(hovered.bare) }))
								: null
						)
			);
		}
		// #endregion

		// #region list view
		function statusHealth(status) {
			if (!status || typeof status !== 'object') return { tone: 'idle', labelKey: 'status.never' };
			const collectors = Array.isArray(status.collectors) ? status.collectors : [];
			// The L2 collector reports `ok: false` whenever it is disabled, blocked or
			// unavailable, which is a normal state; only L1 decides the health dot.
			if (collectors.some((collector) => collector && collector.ok === false && collector.id !== 'l2')) return { tone: 'error', labelKey: 'status.warn' };
			if (!status.lastCollectAt) return { tone: 'idle', labelKey: 'status.never' };
			return { tone: 'ok', labelKey: 'status.ok' };
		}

		/** Login chip content for the current auth snapshot (`status.auth`). */
		function authInfo(auth) {
			const source = auth && typeof auth === 'object' ? auth : {};
			if (source.available === false) return { tone: 'idle', label: t('status.auth.unavailable'), clickable: false };
			if (source.status === 'valid') {
				const account = typeof source.accountHint === 'string' ? source.accountHint.trim() : '';
				return { tone: 'ok', label: account === '' ? t('status.auth.valid') : t('status.auth.validAccount', { account }), clickable: false };
			}
			if (source.status === 'expired') return { tone: 'warn', label: t('status.auth.expired'), clickable: true };
			return { tone: 'idle', label: t('status.auth.unknown'), clickable: true };
		}

		/** `风控暂停至 13:20` while the L2 backoff is still running, else null. */
		function blockedNotice(auth) {
			const source = auth && typeof auth === 'object' ? auth : {};
			const until = typeof source.blockedUntil === 'string' ? Date.parse(source.blockedUntil) : NaN;
			if (!Number.isFinite(until) || until <= Date.now()) return null;
			const time = formatLastCollect(source.blockedUntil);
			return time === null ? null : t('status.auth.blocked', { time });
		}

		/**
		 * The sign-in chip. Valid/unavailable render as a plain badge; expired and
		 * unknown render as a button that starts the visible Chrome sign-in, and while
		 * that long request runs the chip explains itself and stops accepting clicks.
		 */
		function AuthChip(props) {
			if (props.pending === true) {
				return h('span', { className: 'pw-authchip', 'data-tone': 'idle', 'data-busy': 'true', role: 'status' }, h(Dot, { tone: 'idle' }), h('span', null, t('status.auth.loggingIn')));
			}
			const info = authInfo(props.auth);
			const content = [h(Dot, { key: 'dot', tone: info.tone }), h('span', { key: 'label' }, info.label)];
			if (info.clickable !== true || typeof props.onLogin !== 'function') {
				return h('span', { className: 'pw-authchip', 'data-tone': info.tone }, content);
			}
			return h(
				'button',
				{ type: 'button', className: 'pw-authchip', 'data-tone': info.tone, 'data-clickable': 'true', title: t('settings.login'), onClick: props.onLogin },
				content
			);
		}

		function MonitorCard(props) {
			const monitor = props.monitor;
			const series = normalizeSeries(monitor.points);
			const latest = latestTotal(monitor);
			const delta = trendPercent(series);
			const chip = trendChip(delta);
			const lowest = lowestTotal(series);
			const target = ruleTarget(monitor.rules);
			const disabled = monitor.enabled === false;
			const segments = [];
			if (latest === null) {
				segments.push(t('card.waiting'));
			} else {
				if (lowest !== null) segments.push(t('card.min', { price: formatMoney(lowest) }));
				if (target !== null) segments.push(t('card.target', { price: formatMoney(target) }));
				segments.push(relativeTime(latest.at));
			}
			const metaChildren = [];
			segments.forEach((segment, index) => {
				if (index > 0) metaChildren.push(h('span', { className: 'pw-strip-sep', key: `sep-${index}` }, '·'));
				metaChildren.push(h('span', { key: `seg-${index}` }, segment));
			});
			const titleChildren = [
				h(PlaneIcon, { key: 'plane', size: 14 }),
				h('span', { key: 'route', className: 'pw-ellipsis' }, monitorRoute(monitor)),
				h('span', { key: 'dates', className: 'pw-page-sub' }, monitorDates(monitor)),
			];
			if (disabled) titleChildren.push(h(Chip, { key: 'paused', tone: 'flat' }, t('card.paused')));

			return h(
				'div',
				{
					className: 'pw-card',
					role: 'button',
					tabIndex: 0,
					'data-disabled': disabled ? 'true' : 'false',
					'aria-label': `${monitorRoute(monitor)} ${monitorDates(monitor)}`,
					onClick: () => props.onOpen(monitor.id),
					onKeyDown: (event) => {
						if (event.target !== event.currentTarget) return;
						if (event.key !== 'Enter' && event.key !== ' ') return;
						event.preventDefault();
						props.onOpen(monitor.id);
					},
				},
				h(
					'div',
					{ className: 'pw-col pw-grow', style: { gap: 5 } },
					h('div', { className: 'pw-card-title' }, titleChildren),
					h('div', { className: 'pw-card-meta' }, metaChildren)
				),
				h(Sparkline, { points: monitor.points, tone: chip.tone }),
				h(
					'div',
					{ className: 'pw-col', style: { alignItems: 'flex-end', gap: 7, flex: 'none' } },
					h(Switch, {
						checked: !disabled,
						label: disabled ? t('card.enable') : t('card.disable'),
						disabled: props.busy === true,
						onChange: () => props.onToggle(monitor),
					}),
					latest === null
						? h('span', { className: 'pw-price pw-muted' }, '—')
						: h('div', { className: 'pw-row', style: { gap: 6 } }, h('span', { className: 'pw-price' }, formatMoney(latest.total)), h(Chip, { tone: chip.tone }, chip.text))
				)
			);
		}

		function ListView(props) {
			const monitors = Array.isArray(props.monitors) ? props.monitors : null;
			const status = props.status;
			const health = statusHealth(status);
			const blockedAuth = blockedNotice(status && status.auth);
			const filtered = monitors === null ? null : monitors.filter((monitor) => props.filter !== 'flight' || monitor.type === 'flight');
			const filters = [
				{ id: 'all', label: t('filter.all') },
				{ id: 'flight', label: t('filter.flight') },
			];

			return [
				h(
					'div',
					{ className: 'pw-toolbar', key: 'toolbar' },
					h('h1', { className: 'pw-page-title' }, t('nav')),
					h('span', { className: 'pw-spacer' }),
					h(Button, { variant: 'primary', icon: h(PlusIcon, { size: 14 }), onClick: props.onNew }, t('list.new')),
					h(Button, { icon: h(SettingsIcon, { size: 14 }), onClick: props.onSettings }, t('list.settings')),
					h(Button, { icon: h(RefreshIcon, { size: 14 }), onClick: props.onRefresh, disabled: props.refreshing === true }, t('list.refresh'))
				),
				h(
					'div',
					{ className: 'pw-strip', key: 'strip' },
					h(
						'div',
						{ className: 'pw-tabs', role: 'tablist' },
						filters.map((entry) =>
							h(
								'button',
								{
									key: entry.id,
									type: 'button',
									role: 'tab',
									className: 'pw-tab',
									'data-active': props.filter === entry.id ? 'true' : 'false',
									'aria-selected': props.filter === entry.id ? 'true' : 'false',
									onClick: () => props.onFilterChange(entry.id),
								},
								entry.label
							)
						)
					),
					h('span', { className: 'pw-strip-sep' }, '·'),
					h(Dot, { tone: health.tone }),
					h('span', null, t(health.labelKey)),
					status && status.lastCollectAt ? h('span', null, t('status.last', { time: formatLastCollect(status.lastCollectAt) })) : null,
					status ? h(AuthChip, { auth: status.auth, pending: props.loginPending === true, onLogin: props.onLogin }) : null,
					blockedAuth === null ? null : h(Chip, { tone: 'warn' }, blockedAuth)
				),
				h(
					'div',
					{ className: 'pw-scroll', key: 'scroll' },
					h(
						'div',
						{ className: 'pw-body' },
						monitors === null && props.error === null
							? [0, 1, 2].map((index) => h('div', { className: 'pw-card', key: `skeleton-${index}` }, h('div', { className: 'pw-col pw-grow' }, h(Skeleton, { height: 16, width: '46%' }), h(Skeleton, { height: 12, width: '68%' })), h(Skeleton, { height: 44, width: 120, radius: 10 })))
							: null,
						monitors !== null && filtered.length === 0
							? h(EmptyState, {
									title: t('empty.title'),
									body: t('empty.body'),
									icon: h(TagIcon, { size: 22 }),
									action: h(Button, { variant: 'primary', size: 'lg', icon: h(PlusIcon, { size: 15 }), onClick: props.onNew }, t('empty.action')),
								})
							: null,
						filtered === null
							? null
							: filtered.map((monitor) =>
									h(MonitorCard, {
										key: monitor.id,
										monitor,
										busy: props.busyKey === `toggle:${monitor.id}`,
										onOpen: props.onOpen,
										onToggle: props.onToggle,
									})
								)
					)
				),
			];
		}
		// #endregion

		// #region detail view
		function ruleSummary(rules) {
			const chips = [];
			const target = ruleTarget(rules);
			if (target !== null) chips.push({ key: 'target', label: `${t('rule.target')} ${formatMoney(target)}` });
			if (ruleHas(rules, 'new_low')) chips.push({ key: 'new_low', label: t('rule.new_low') });
			if (ruleHas(rules, 'new_high')) chips.push({ key: 'new_high', label: t('rule.new_high') });
			if (ruleHas(rules, 'digest')) chips.push({ key: 'digest', label: t('rule.digest') });
			return chips;
		}

		function DetailView(props) {
			const monitor = props.monitor;
			const [editing, setEditing] = useState(false);
			const [draft, setDraft] = useState({ target: '', newLow: false, newHigh: false, digest: false });
			const [saving, setSaving] = useState(false);
			const [ruleError, setRuleError] = useState(null);

			const prices = props.prices;
			const pricePoints = prices && Array.isArray(prices.points) ? prices.points : null;
			const priceStats = prices && prices.stats && typeof prices.stats === 'object' ? prices.stats : null;
			const series = normalizePricePoints(pricePoints);
			const passengerNames = (Array.isArray(props.passengers) ? props.passengers : [])
				.filter((passenger) => passenger && Array.isArray(monitor.passengerIds) && monitor.passengerIds.indexOf(passenger.id) >= 0)
				.map((passenger) => passenger.nickname)
				.filter((name) => typeof name === 'string' && name !== '');
			const cadence = monitor.cadence && typeof monitor.cadence === 'object' && typeof monitor.cadence.l1Minutes === 'number' ? monitor.cadence.l1Minutes : DEFAULT_CADENCE;
			const rules = monitorRules(monitor);
			const chips = ruleSummary(rules);
			const enabled = monitor.enabled !== false;
			const busy = props.busy === true;

			const beginEdit = () => {
				const target = ruleTarget(rules);
				setDraft({
					target: target === null ? '' : String(Math.round(target)),
					newLow: ruleHas(rules, 'new_low'),
					newHigh: ruleHas(rules, 'new_high'),
					digest: ruleHas(rules, 'digest'),
				});
				setRuleError(null);
				setEditing(true);
			};

			const cancelEdit = () => {
				setEditing(false);
				setRuleError(null);
			};

			const submitRules = async () => {
				const next = [];
				const raw = draft.target.trim();
				if (raw !== '') {
					const value = Number(raw);
					if (!Number.isFinite(value) || value <= 0) {
						setRuleError(t('detail.rules.invalid'));
						return;
					}
					next.push({ kind: 'target', value });
				}
				if (draft.newLow) next.push({ kind: 'new_low' });
				if (draft.newHigh) next.push({ kind: 'new_high' });
				if (draft.digest) next.push({ kind: 'digest' });
				setSaving(true);
				setRuleError(null);
				try {
					await props.onSaveRules(monitor.id, next);
					setEditing(false);
				} catch (error) {
					setRuleError(error && error.message ? error.message : String(error));
				} finally {
					setSaving(false);
				}
			};

			const targetValue = numberOrNull(priceStats && priceStats.target) === null ? ruleTarget(rules) : numberOrNull(priceStats && priceStats.target);
			// Pass the rule target down even when /prices returned no `stats.target`, so the
			// dashed target line still shows for a monitor that has a target rule.
			const chartStats = priceStats === null ? (targetValue === null ? null : { target: targetValue }) : { ...priceStats, target: targetValue };
			const statsItems = [
				{ key: 'min', label: t('detail.stat.min'), value: formatMoney(numberOrNull(priceStats && priceStats.min) === null ? lowestTotal(series) : priceStats.min) },
				{ key: 'max', label: t('detail.stat.max'), value: formatMoney(numberOrNull(priceStats && priceStats.max) === null ? highestTotal(series) : priceStats.max) },
				{ key: 'avg7', label: t('detail.stat.avg7'), value: formatMoney(priceStats && priceStats.avg7) },
				{ key: 'target', label: t('detail.stat.target'), value: formatMoney(targetValue) },
			];

			const meta = [];
			meta.push(h('span', { key: 'dates' }, monitorDates(monitor)));
			meta.push(h('span', { key: 'sep-0', className: 'pw-strip-sep' }, '·'));
			meta.push(h('span', { key: 'passengers' }, passengerNames.length > 0 ? t('detail.passengersPrefix', { names: passengerNames.join(t('common.listSeparator')) }) : t('detail.passengersCount', { n: Array.isArray(monitor.passengerIds) ? monitor.passengerIds.length : 0 })));
			meta.push(h('span', { key: 'sep-1', className: 'pw-strip-sep' }, '·'));
			meta.push(h('span', { key: 'cadence' }, t('detail.cadence', { n: cadence })));
			if (!enabled) meta.push(h(Chip, { key: 'paused', tone: 'flat' }, t('card.paused')));

			const ruleSection = editing
				? h(
						Section,
						{ title: t('detail.rules.title') },
						h(
							Field,
							{ label: t('detail.rules.target'), hint: t('detail.rules.targetPlaceholder') },
							h('input', {
								className: 'pw-input',
								type: 'number',
								inputMode: 'numeric',
								min: 0,
								placeholder: '¥',
								value: draft.target,
								onChange: (event) => setDraft({ ...draft, target: event.target.value }),
							})
						),
						['newLow', 'newHigh', 'digest'].map((key) => {
							const label = key === 'newLow' ? t('detail.rules.newLow') : key === 'newHigh' ? t('detail.rules.newHigh') : t('detail.rules.digest');
							return h(
								'div',
								{ className: 'pw-rule-row', key },
								h('span', null, label),
								h(Switch, {
									checked: draft[key] === true,
									label,
									onChange: (next) => setDraft({ ...draft, [key]: next }),
								})
							);
						}),
						ruleError === null ? null : h('div', { className: 'pw-hint', style: { color: 'var(--dsw-alias-state-error-primary)' }, role: 'alert' }, ruleError),
						h(
							'div',
							{ className: 'pw-row', style: { justifyContent: 'flex-end', gap: 8 } },
							h(Button, { size: 'sm', onClick: cancelEdit, disabled: saving }, t('detail.rules.cancel')),
							h(Button, { size: 'sm', variant: 'primary', onClick: submitRules, disabled: saving }, saving ? t('common.saving') : t('detail.rules.save'))
						)
					)
				: h(
						Section,
						{ title: t('detail.rules.title') },
						chips.length === 0
							? h('span', { className: 'pw-muted', style: { fontSize: 12 } }, t('detail.rules.empty'))
							: h(
									'div',
									{ className: 'pw-row', style: { flexWrap: 'wrap', gap: 6 } },
									chips.map((chip) => h(Chip, { key: chip.key, tone: chip.key === 'target' ? 'warn' : 'flat' }, chip.label))
								),
						h(
							'div',
							{ className: 'pw-row', style: { justifyContent: 'flex-end' } },
							h(Button, { size: 'sm', icon: h(TargetIcon, { size: 13 }), onClick: beginEdit, disabled: busy }, t('detail.editRules'))
						)
					);

			return h(
				'div',
				{ className: 'pw-scroll' },
				h(
					'div',
					{ className: 'pw-body' },
					h(
						'div',
						{ className: 'pw-row', style: { alignItems: 'flex-start', gap: 10 } },
						h(IconButton, { label: t('detail.back'), onClick: props.onBack }, h(BackIcon, { size: 16 })),
						h('div', { className: 'pw-col pw-grow', style: { gap: 4 } }, h('h2', { className: 'pw-page-title' }, monitorRoute(monitor)), h('div', { className: 'pw-detail-meta' }, meta)),
						h(
							'div',
							{ className: 'pw-row', style: { gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', flex: 'none' } },
							h(Button, { size: 'sm', icon: h(TargetIcon, { size: 13 }), onClick: beginEdit, disabled: busy }, t('detail.editRules')),
							h(
								Button,
								{
									size: 'sm',
									icon: enabled ? h(PauseIcon, { size: 13 }) : h(PlayIcon, { size: 13 }),
									onClick: () => props.onToggleEnabled(monitor),
									disabled: busy,
								},
								enabled ? t('detail.pause') : t('detail.resume')
							),
							h(Button, { size: 'sm', icon: h(RefreshIcon, { size: 13 }), onClick: () => props.onRefresh(monitor.id), disabled: busy }, t('detail.refresh')),
							h(Button, { size: 'sm', variant: 'danger', icon: h(TrashIcon, { size: 13 }), onClick: () => props.onDelete(monitor), disabled: busy }, t('detail.delete'))
						)
					),
					props.pricesError ? h(ErrorBar, { message: props.pricesError, inline: true, onRetry: () => props.onRefresh(monitor.id) }) : null,
					h(
						Section,
						{ title: t('detail.chart.title'), help: t('detail.chart.caption') },
						prices === null && props.pricesError === null
							? h(Skeleton, { height: 180, radius: 10 })
							: h(PriceChart, { points: pricePoints, stats: chartStats, emptyText: t('detail.waiting') }),
						h(Stats, { items: statsItems })
					),
					ruleSection
				)
			);
		}
		// #endregion

		// #region settings view
		function settingsDraftFrom(settings) {
			const source = settings && typeof settings === 'object' ? settings : {};
			const cadence = source.cadence && typeof source.cadence === 'object' ? source.cadence : {};
			const notify = source.notify && typeof source.notify === 'object' ? source.notify : {};
			const quiet = Array.isArray(notify.quietHours) && notify.quietHours.length === 2 ? notify.quietHours : null;
			const l2 = source.l2 && typeof source.l2 === 'object' ? source.l2 : {};
			const perDay = numberOrNull(l2.perDay);
			return {
				cadenceMinutes: numberOrNull(cadence.l1Minutes) === null ? DEFAULT_CADENCE : cadence.l1Minutes,
				l2Enabled: l2.enabled === true,
				l2PerDay: perDay === null ? 1 : Math.min(3, Math.max(1, Math.round(perDay))),
				feishuWebhook: typeof notify.feishuWebhook === 'string' ? notify.feishuWebhook : '',
				quietStart: String(quiet === null ? 22 : numberOrNull(quiet[0]) === null ? 22 : quiet[0]),
				quietEnd: String(quiet === null ? 8 : numberOrNull(quiet[1]) === null ? 8 : quiet[1]),
				cooldownMinutes: String(numberOrNull(notify.cooldownMinutes) === null ? 360 : notify.cooldownMinutes),
				digestAt: typeof notify.digestAt === 'string' && /^\d{2}:\d{2}$/.test(notify.digestAt) ? notify.digestAt : '12:00',
			};
		}

		function hourOptions() {
			const options = [];
			for (let hour = 0; hour < 24; hour += 1) options.push({ value: String(hour), label: `${pad2(hour)}:00` });
			return options;
		}

		function PassengerRow(props) {
			const passenger = props.passenger;
			const typeLabel = PASSENGER_TYPES.indexOf(passenger.type) >= 0 ? t(`type.${passenger.type}`) : passenger.type;
			return h(
				'div',
				{ className: 'pw-passenger-row' },
				h('span', { className: 'pw-passenger-name pw-ellipsis' }, passenger.nickname),
				h(Chip, { tone: 'flat' }, typeLabel),
				typeof passenger.age === 'number' && Number.isFinite(passenger.age) ? h('span', { className: 'pw-hint' }, `${passenger.age} ${t('settings.passengers.ageUnit')}`) : null,
				h('span', { className: 'pw-spacer' }),
				h(IconButton, { label: t('settings.passengers.delete'), onClick: () => props.onDelete(passenger), disabled: props.disabled === true }, h(TrashIcon, { size: 14 }))
			);
		}

		function SettingsView(props) {
			const [draft, setDraft] = useState(() => settingsDraftFrom(props.settings));
			const [saving, setSaving] = useState(false);
			const [saved, setSaved] = useState(false);
			const [settingsError, setSettingsError] = useState(null);
			const [passengerForm, setPassengerForm] = useState({ nickname: '', type: 'adult', age: '' });
			const [passengerError, setPassengerError] = useState(null);
			const [passengerBusy, setPassengerBusy] = useState(false);
			const hours = useMemo(() => hourOptions(), []);
			const passengers = Array.isArray(props.passengers) ? props.passengers : null;

			useEffect(() => {
				if (props.settings === null || props.settings === undefined) return;
				setDraft(settingsDraftFrom(props.settings));
			}, [props.settings]);

			useEffect(() => {
				if (!saved) return undefined;
				const timer = window.setTimeout(() => setSaved(false), 2600);
				return () => window.clearTimeout(timer);
			}, [saved]);

			const update = (patch) => setDraft((current) => ({ ...current, ...patch }));

			const saveSettings = async () => {
				const quietStart = Number(draft.quietStart);
				const quietEnd = Number(draft.quietEnd);
				const cooldown = Number(draft.cooldownMinutes);
				const body = {
					cadence: { l1Minutes: Number(draft.cadenceMinutes) || DEFAULT_CADENCE },
					l2: { enabled: draft.l2Enabled === true, perDay: Math.min(3, Math.max(1, Math.round(Number(draft.l2PerDay) || 1))) },
					notify: {
						feishuWebhook: draft.feishuWebhook.trim(),
						quietHours: [Number.isFinite(quietStart) ? Math.min(23, Math.max(0, Math.round(quietStart))) : 22, Number.isFinite(quietEnd) ? Math.min(23, Math.max(0, Math.round(quietEnd))) : 8],
						cooldownMinutes: Number.isFinite(cooldown) ? Math.max(0, Math.round(cooldown)) : 360,
						digestAt: /^\d{2}:\d{2}$/.test(draft.digestAt) ? draft.digestAt : '12:00',
					},
				};
				setSaving(true);
				setSettingsError(null);
				try {
					await props.onSaveSettings(body);
					setSaved(true);
				} catch (error) {
					setSettingsError(error && error.message ? error.message : String(error));
				} finally {
					setSaving(false);
				}
			};

			const submitPassenger = async () => {
				const nickname = passengerForm.nickname.trim();
				if (nickname === '') {
					setPassengerError(t('settings.passengers.nicknameRequired'));
					return;
				}
				const type = PASSENGER_TYPES.indexOf(passengerForm.type) >= 0 ? passengerForm.type : 'adult';
				const body = { nickname, type };
				const ageRaw = passengerForm.age.trim();
				if (ageRaw !== '') {
					const age = Number(ageRaw);
					if (!Number.isFinite(age) || age < 0 || age > 120) {
						setPassengerError(t('settings.passengers.ageInvalid'));
						return;
					}
					body.age = Math.round(age);
				}
				setPassengerBusy(true);
				setPassengerError(null);
				try {
					await props.onAddPassenger(body);
					setPassengerForm({ nickname: '', type: 'adult', age: '' });
				} catch (error) {
					setPassengerError(error && error.message ? error.message : String(error));
				} finally {
					setPassengerBusy(false);
				}
			};

			const removePassenger = async (passenger) => {
				const confirmed = typeof window.confirm === 'function' ? window.confirm(t('settings.passengers.deleteConfirm', { name: passenger.nickname })) : true;
				if (!confirmed) return;
				setPassengerBusy(true);
				setPassengerError(null);
				try {
					await props.onDeletePassenger(passenger);
				} catch (error) {
					setPassengerError(error && error.message ? error.message : t('settings.passengers.referenced'));
				} finally {
					setPassengerBusy(false);
				}
			};

			const auth = props.status && typeof props.status === 'object' && props.status.auth && typeof props.status.auth === 'object' ? props.status.auth : null;
			const blocked = blockedNotice(auth);
			const signedIn = auth !== null && (auth.status === 'valid' || auth.status === 'expired');
			const loginPending = props.loginPending === true;
			const signIn = async () => {
				if (loginPending) return;
				await props.onLogin();
			};
			const signOut = async () => {
				const confirmed = typeof window.confirm === 'function' ? window.confirm(t('settings.logoutConfirm')) : true;
				if (!confirmed) return;
				await props.onLogout();
			};

			return h(
				'div',
				{ className: 'pw-scroll' },
				h(
					'div',
					{ className: 'pw-body' },
					h(
						'div',
						{ className: 'pw-row', style: { alignItems: 'center', gap: 10 } },
						h(IconButton, { label: t('settings.back'), onClick: props.onBack }, h(BackIcon, { size: 16 })),
						h('h2', { className: 'pw-page-title' }, t('settings.title')),
						h('span', { className: 'pw-spacer' }),
						saved ? h('span', { className: 'pw-notice' }, h(CheckIcon, { size: 13 }), t('settings.saved')) : null,
						h(Button, { variant: 'primary', onClick: saveSettings, disabled: saving || props.loading === true || props.settings === null }, saving ? t('settings.saving') : t('settings.save'))
					),
					props.error ? h(ErrorBar, { message: props.error, inline: true, onRetry: props.onReload }) : null,
					settingsError === null ? null : h(ErrorBar, { message: settingsError, inline: true }),
					h(
						Section,
						{ title: t('settings.cadence.title'), help: t('settings.cadence.help') },
						h(
							'div',
							{ className: 'pw-form-row' },
							h(
								Field,
								{ label: t('settings.cadence.title') },
								h(
									'select',
									{
										className: 'pw-input',
										value: String(draft.cadenceMinutes),
										onChange: (event) => update({ cadenceMinutes: Number(event.target.value) }),
									},
									CADENCE_CHOICES.map((minutes) => h('option', { key: minutes, value: String(minutes) }, t('cadence.minutes', { n: minutes })))
								)
							)
						)
					),
					h(
						Section,
						{ title: t('settings.l2.title'), help: t('settings.l2.help') },
						h(
							'div',
							{ className: 'pw-rule-row' },
							h('span', null, t('settings.l2.enable')),
							h(Switch, { checked: draft.l2Enabled === true, label: t('settings.l2.enable'), onChange: (next) => update({ l2Enabled: next }) })
						),
						h(
							'div',
							{ className: 'pw-form-row' },
							h(
								Field,
								{ label: t('settings.l2.perDay') },
								h(
									'select',
									{ className: 'pw-input', value: String(draft.l2PerDay), onChange: (event) => update({ l2PerDay: Number(event.target.value) }) },
									[1, 2, 3].map((count) => h('option', { key: count, value: String(count) }, t('settings.l2.times', { n: count })))
								)
							)
						),
						h('div', { className: 'pw-divider' }),
						h(
							'div',
							{ className: 'pw-row', style: { gap: 8, flexWrap: 'wrap' } },
							h('span', { className: 'pw-label' }, t('settings.l2.auth')),
							h(AuthChip, { auth, pending: loginPending, onLogin: signIn }),
							blocked === null ? null : h(Chip, { tone: 'warn' }, blocked)
						),
						h(
							'span',
							{ className: 'pw-hint' },
							auth !== null && typeof auth.lastVerifiedAt === 'string' && auth.lastVerifiedAt !== ''
								? t('settings.l2.lastVerified', { time: relativeTime(auth.lastVerifiedAt) })
								: t('settings.l2.neverVerified')
						),
						h(
							'div',
							{ className: 'pw-row', style: { gap: 8, flexWrap: 'wrap' } },
							h(Button, { onClick: signIn, disabled: loginPending || (auth !== null && auth.available === false) }, loginPending ? t('login.pending') : t('settings.login')),
							h(Button, { variant: 'danger', onClick: signOut, disabled: loginPending || !signedIn }, t('settings.logout'))
						)
					),
					h(
						Section,
						{ title: t('settings.feishu.title'), help: t('settings.feishu.help') },
						h(
							Field,
							{ label: 'Webhook URL' },
							h('input', {
								className: 'pw-input',
								type: 'url',
								spellCheck: false,
								autoComplete: 'off',
								placeholder: t('settings.feishu.placeholder'),
								value: draft.feishuWebhook,
								onChange: (event) => update({ feishuWebhook: event.target.value }),
							})
						)
					),
					h(
						Section,
						{ title: t('settings.notify.title') },
						h(
							'div',
							{ className: 'pw-form-row' },
							h(
								Field,
								{ label: t('settings.notify.quiet') },
								h(
									'div',
									{ className: 'pw-row', style: { gap: 6 } },
									h(
										'select',
										{ className: 'pw-input', value: draft.quietStart, onChange: (event) => update({ quietStart: event.target.value }) },
										hours.map((hour) => h('option', { key: hour.value, value: hour.value }, hour.label))
									),
									h('span', { className: 'pw-hint' }, '—'),
									h(
										'select',
										{ className: 'pw-input', value: draft.quietEnd, onChange: (event) => update({ quietEnd: event.target.value }) },
										hours.map((hour) => h('option', { key: hour.value, value: hour.value }, hour.label))
									)
								)
							),
							h(
								Field,
								{ label: t('settings.notify.cooldown') },
								h('input', {
									className: 'pw-input',
									type: 'number',
									min: 0,
									inputMode: 'numeric',
									value: draft.cooldownMinutes,
									onChange: (event) => update({ cooldownMinutes: event.target.value }),
								})
							),
							h(
								Field,
								{ label: t('settings.notify.digestAt') },
								h('input', { className: 'pw-input', type: 'time', value: draft.digestAt, onChange: (event) => update({ digestAt: event.target.value }) })
							)
						)
					),
					h(
						Section,
						{ title: t('settings.passengers.title'), help: t('settings.passengers.help') },
						passengers === null
							? h(Skeleton, { height: 42, radius: 10 })
							: passengers.length === 0
								? h('span', { className: 'pw-muted', style: { fontSize: 12 } }, t('settings.passengers.empty'))
								: h('div', { className: 'pw-col', style: { gap: 6 } }, passengers.map((passenger) => h(PassengerRow, { key: passenger.id, passenger, disabled: passengerBusy, onDelete: removePassenger }))),
						h('div', { className: 'pw-divider' }),
						h(
							'div',
							{ className: 'pw-form-row' },
							h(Field, { label: t('settings.passengers.nickname') }, h('input', { className: 'pw-input', value: passengerForm.nickname, placeholder: '—', onChange: (event) => setPassengerForm({ ...passengerForm, nickname: event.target.value }) })),
							h(
								Field,
								{ label: t('settings.passengers.type') },
								h(
									'select',
									{ className: 'pw-input', value: passengerForm.type, onChange: (event) => setPassengerForm({ ...passengerForm, type: event.target.value }) },
									PASSENGER_TYPES.map((type) => h('option', { key: type, value: type }, t(`type.${type}`)))
								)
							),
							h(
								Field,
								{ label: t('settings.passengers.age') },
								h('input', {
									className: 'pw-input',
									type: 'number',
									min: 0,
									max: 120,
									inputMode: 'numeric',
									value: passengerForm.age,
									onChange: (event) => setPassengerForm({ ...passengerForm, age: event.target.value }),
								})
							),
							h(Button, { icon: h(PlusIcon, { size: 14 }), onClick: submitPassenger, disabled: passengerBusy }, t('settings.passengers.add'))
						),
						passengerError === null ? null : h('div', { className: 'pw-hint', style: { color: 'var(--dsw-alias-state-error-primary)' }, role: 'alert' }, passengerError)
					)
				)
			);
		}
		// #endregion

		// #region new view
		function NewView(props) {
			const [dep, setDep] = useState('');
			const [arr, setArr] = useState('');
			const [trip, setTrip] = useState('oneway');
			const [departDate, setDepartDate] = useState('');
			const [returnDate, setReturnDate] = useState('');
			const [selected, setSelected] = useState([]);
			const [target, setTarget] = useState('');
			const [error, setError] = useState(null);
			const [submitting, setSubmitting] = useState(false);
			const passengers = Array.isArray(props.passengers) ? props.passengers : null;
			const cadence = props.settings && props.settings.cadence && numberOrNull(props.settings.cadence.l1Minutes) !== null ? props.settings.cadence.l1Minutes : DEFAULT_CADENCE;

			useEffect(() => {
				if (passengers === null) return;
				setSelected((current) => current.filter((id) => passengers.some((passenger) => passenger.id === id)));
			}, [passengers]);

			const togglePassenger = (id) => {
				setSelected((current) => (current.indexOf(id) >= 0 ? current.filter((entry) => entry !== id) : current.concat([id])));
			};

			const validate = () => {
				const depCode = dep.trim().toUpperCase();
				const arrCode = arr.trim().toUpperCase();
				if (!/^[A-Z]{3}$/.test(depCode) || !/^[A-Z]{3}$/.test(arrCode)) return t('new.invalidCode');
				if (depCode === arrCode) return t('new.sameCode');
				if (!/^\d{4}-\d{2}-\d{2}$/.test(departDate)) return t('new.required');
				if (trip === 'round') {
					if (!/^\d{4}-\d{2}-\d{2}$/.test(returnDate)) return t('new.returnRequired');
					if (returnDate <= departDate) return t('new.returnOrder');
				}
				if (selected.length === 0) return t('new.passengerRequired');
				const targetRaw = target.trim();
				if (targetRaw !== '' && (!Number.isFinite(Number(targetRaw)) || Number(targetRaw) <= 0)) return t('detail.rules.invalid');
				return null;
			};

			const submit = async () => {
				const invalid = validate();
				if (invalid !== null) {
					setError(invalid);
					return;
				}
				const params = { mode: 'locked', trip, dep: dep.trim().toUpperCase(), arr: arr.trim().toUpperCase(), departDate };
				if (trip === 'round') params.returnDate = returnDate;
				const rules = [];
				const targetRaw = target.trim();
				if (targetRaw !== '') rules.push({ kind: 'target', value: Number(targetRaw) });
				else rules.push({ kind: 'new_low' });
				const body = { params, passengerIds: selected.slice(), rules, cadence: { l1Minutes: cadence } };
				setSubmitting(true);
				setError(null);
				try {
					await props.onCreate(body);
				} catch (submitError) {
					setError(submitError && submitError.message ? submitError.message : String(submitError));
				} finally {
					setSubmitting(false);
				}
			};

			const passengerSection =
				passengers === null
					? h(Skeleton, { height: 42, radius: 10 })
					: passengers.length === 0
						? h(
								'div',
								{ className: 'pw-col', style: { gap: 8, alignItems: 'flex-start' } },
								h('span', { className: 'pw-muted', style: { fontSize: 12 } }, t('new.passengers.empty')),
								h(Button, { size: 'sm', onClick: props.onGoSettings }, t('new.passengers.goSettings'))
							)
						: h(
								'div',
								{ className: 'pw-row', style: { flexWrap: 'wrap', gap: 6 } },
								passengers.map((passenger) => {
									const active = selected.indexOf(passenger.id) >= 0;
									const typeLabel = PASSENGER_TYPES.indexOf(passenger.type) >= 0 ? t(`type.${passenger.type}`) : passenger.type;
									return h(
										'button',
										{
											key: passenger.id,
											type: 'button',
											className: 'pw-selectable',
											'data-selected': active ? 'true' : 'false',
											'aria-pressed': active ? 'true' : 'false',
											onClick: () => togglePassenger(passenger.id),
										},
										h('span', { className: 'pw-check' }, active ? h(CheckIcon, { size: 11 }) : null),
										h('span', null, passenger.nickname),
										h('span', { className: 'pw-hint' }, typeLabel)
									);
								})
							);

			return h(
				'div',
				{ className: 'pw-scroll' },
				h(
					'div',
					{ className: 'pw-body' },
					h(
						'div',
						{ className: 'pw-row', style: { alignItems: 'center', gap: 10 } },
						h(IconButton, { label: t('new.back'), onClick: props.onBack }, h(BackIcon, { size: 16 })),
						h('h2', { className: 'pw-page-title' }, t('new.title')),
						h('span', { className: 'pw-spacer' }),
						h(Button, { variant: 'primary', onClick: submit, disabled: submitting || passengers === null || passengers.length === 0 }, submitting ? t('new.submitting') : t('new.submit'))
					),
					h(
						Section,
						{ title: t('new.route.title'), help: t('new.routeHint') },
						h(
							'div',
							{ className: 'pw-form-row' },
							h(
								Field,
								{ label: t('new.from') },
								h('input', {
									className: 'pw-input',
									maxLength: 3,
									autoComplete: 'off',
									spellCheck: false,
									placeholder: 'SHA',
									value: dep,
									onChange: (event) => setDep(event.target.value.toUpperCase()),
								})
							),
							h(Field, { label: t('new.to') }, h('input', { className: 'pw-input', maxLength: 3, autoComplete: 'off', spellCheck: false, placeholder: 'BJS', value: arr, onChange: (event) => setArr(event.target.value.toUpperCase()) }))
						)
					),
					h(
						Section,
						{ title: t('new.trip.title') },
						h(
							'div',
							{ className: 'pw-row', style: { gap: 10, flexWrap: 'wrap' } },
							h(
								'div',
								{ className: 'pw-tabs', role: 'tablist' },
								[
									{ id: 'oneway', label: t('new.trip.oneway') },
									{ id: 'round', label: t('new.trip.round') },
								].map((entry) =>
									h(
										'button',
										{
											key: entry.id,
											type: 'button',
											role: 'tab',
											className: 'pw-tab',
											'data-active': trip === entry.id ? 'true' : 'false',
											'aria-selected': trip === entry.id ? 'true' : 'false',
											onClick: () => setTrip(entry.id),
										},
										entry.label
									)
								)
							)
						),
						h(
							'div',
							{ className: 'pw-form-row' },
							h(Field, { label: t('new.departDate') }, h('input', { className: 'pw-input', type: 'date', value: departDate, onChange: (event) => setDepartDate(event.target.value) })),
							trip === 'round' ? h(Field, { label: t('new.returnDate') }, h('input', { className: 'pw-input', type: 'date', value: returnDate, onChange: (event) => setReturnDate(event.target.value) })) : null
						)
					),
					h(Section, { title: t('new.passengers.title'), help: t('new.passengers.help') }, passengerSection),
					h(
						Section,
						{ title: t('new.target.title'), help: t('new.target.help') },
						h('input', {
							className: 'pw-input',
							type: 'number',
							min: 0,
							inputMode: 'numeric',
							placeholder: '¥',
							value: target,
							onChange: (event) => setTarget(event.target.value),
						})
					),
					error === null ? null : h(ErrorBar, { message: error, inline: true, onDismiss: () => setError(null) }),
					h(
						'div',
						{ className: 'pw-row', style: { justifyContent: 'flex-end', gap: 8 } },
						h(Button, { onClick: props.onBack, disabled: submitting }, t('new.back')),
						h(Button, { variant: 'primary', onClick: submit, disabled: submitting || passengers === null || passengers.length === 0 }, submitting ? t('new.submitting') : t('new.submit'))
					)
				)
			);
		}
		// #endregion

		// #region page
		/**
		 * The whole panel. Owns every loaded resource so switching views keeps the
		 * previous data on screen; a failed poll only replaces the error banner.
		 */
		function PriceWatchPage() {
			useLocaleRevision();
			const [view, setView] = useState({ kind: 'list', monitorId: null });
			const [monitors, setMonitors] = useState(null);
			const [status, setStatus] = useState(null);
			const [passengers, setPassengers] = useState(null);
			const [settings, setSettings] = useState(null);
			const [error, setError] = useState(null);
			const [settingsError, setSettingsError] = useState(null);
			const [prices, setPrices] = useState(null);
			const [pricesError, setPricesError] = useState(null);
			const [busyKey, setBusyKey] = useState(null);
			const [filter, setFilter] = useState('all');
			const [refreshing, setRefreshing] = useState(false);
			const [dataLoading, setDataLoading] = useState(false);
			const [tick, setTick] = useState(0);
			const [auxReloadKey, setAuxReloadKey] = useState(0);
			// `/login/start` stays open while the user signs in (up to 8 minutes).
			const [loginPending, setLoginPending] = useState(false);

			const coreSeq = useRef(0);
			const pricesSeq = useRef(0);
			const auxSeq = useRef(0);
			const loginRef = useRef(false);

			// #region data loading
			const loadCore = useCallback(async (options) => {
				const manual = options && options.manual === true;
				const seq = coreSeq.current + 1;
				coreSeq.current = seq;
				if (manual) setRefreshing(true);
				try {
					const results = await Promise.allSettled([apiFetch('/monitors'), apiFetch('/status')]);
					if (seq !== coreSeq.current) return;
					let firstError = null;
					if (results[0].status === 'fulfilled') {
						const data = results[0].value;
						setMonitors(data && Array.isArray(data.monitors) ? data.monitors : []);
					} else {
						firstError = results[0].reason;
					}
					if (results[1].status === 'fulfilled') {
						setStatus(results[1].value && typeof results[1].value === 'object' ? results[1].value : null);
					} else if (firstError === null) {
						firstError = results[1].reason;
					}
					setError(firstError === null ? null : firstError.message || String(firstError));
				} finally {
					if (manual && seq === coreSeq.current) setRefreshing(false);
				}
			}, []);

			useEffect(() => {
				void loadCore();
			}, [loadCore, tick]);

			useEffect(() => {
				const timer = window.setInterval(() => setTick((value) => value + 1), POLL_MS);
				return () => window.clearInterval(timer);
			}, []);

			const detailId = view.kind === 'detail' ? view.monitorId : null;

			useEffect(() => {
				setPrices(null);
				setPricesError(null);
			}, [detailId]);

			useEffect(() => {
				if (detailId === null) return undefined;
				const seq = pricesSeq.current + 1;
				pricesSeq.current = seq;
				apiFetch(`/monitors/${encodeURIComponent(detailId)}/prices?days=${PRICE_DAYS}`)
					.then((data) => {
						if (seq !== pricesSeq.current) return;
						setPrices(data && typeof data === 'object' ? data : null);
						setPricesError(null);
					})
					.catch((reason) => {
						if (seq !== pricesSeq.current) return;
						setPricesError(reason && reason.message ? reason.message : String(reason));
					});
				return () => {
					pricesSeq.current += 1;
				};
			}, [detailId, tick]);

			const auxView = view.kind === 'settings' || view.kind === 'new' ? view.kind : null;

			useEffect(() => {
				if (auxView === null) return undefined;
				const seq = auxSeq.current + 1;
				auxSeq.current = seq;
				setDataLoading(true);
				Promise.allSettled([apiFetch('/passengers'), apiFetch('/settings')])
					.then((results) => {
						if (seq !== auxSeq.current) return;
						let firstError = null;
						if (results[0].status === 'fulfilled') {
							const data = results[0].value;
							setPassengers(data && Array.isArray(data.passengers) ? data.passengers : []);
						} else {
							firstError = results[0].reason;
						}
						if (results[1].status === 'fulfilled') {
							setSettings(results[1].value && typeof results[1].value === 'object' ? results[1].value : null);
						} else if (firstError === null) {
							firstError = results[1].reason;
						}
						setSettingsError(firstError === null ? null : firstError.message || String(firstError));
					})
					.finally(() => {
						if (seq === auxSeq.current) setDataLoading(false);
					});
				return () => {
					auxSeq.current += 1;
				};
			}, [auxView, auxReloadKey]);

			const reloadAux = useCallback(() => setAuxReloadKey((value) => value + 1), []);
			// #endregion

			// #region navigation
			const openDetail = useCallback((id) => setView({ kind: 'detail', monitorId: id }), []);
			const goList = useCallback(() => setView({ kind: 'list', monitorId: null }), []);
			const goSettings = useCallback(() => setView({ kind: 'settings', monitorId: null }), []);
			const goNew = useCallback(() => setView({ kind: 'new', monitorId: null }), []);
			// #endregion

			// #region actions
			const fail = useCallback((reason) => {
				setError(reason && reason.message ? reason.message : String(reason));
			}, []);

			const toggleEnabled = useCallback(
				async (monitor) => {
					const key = `toggle:${monitor.id}`;
					setBusyKey(key);
					try {
						await apiFetch(`/monitors/${encodeURIComponent(monitor.id)}`, { method: 'PATCH', body: { enabled: monitor.enabled === false } });
						await loadCore();
					} catch (reason) {
						fail(reason);
					} finally {
						setBusyKey(null);
					}
				},
				[loadCore, fail]
			);

			const refreshMonitor = useCallback(
				async (id) => {
					const key = `refresh:${id}`;
					setBusyKey(key);
					try {
						await apiFetch(`/monitors/${encodeURIComponent(id)}/refresh`, { method: 'POST' });
						await loadCore();
						setTick((value) => value + 1);
					} catch (reason) {
						fail(reason);
					} finally {
						setBusyKey(null);
					}
				},
				[loadCore, fail]
			);

			const deleteMonitor = useCallback(
				async (monitor) => {
					const confirmed = typeof window.confirm === 'function' ? window.confirm(t('detail.deleteConfirm')) : true;
					if (!confirmed) return;
					const key = `delete:${monitor.id}`;
					setBusyKey(key);
					try {
						await apiFetch(`/monitors/${encodeURIComponent(monitor.id)}`, { method: 'DELETE' });
						setView({ kind: 'list', monitorId: null });
						await loadCore();
					} catch (reason) {
						fail(reason);
					} finally {
						setBusyKey(null);
					}
				},
				[loadCore, fail]
			);

			const saveRules = useCallback(
				async (id, rules) => {
					await apiFetch(`/monitors/${encodeURIComponent(id)}`, { method: 'PATCH', body: { rules } });
					await loadCore();
				},
				[loadCore]
			);

			const createMonitor = useCallback(
				async (body) => {
					await apiFetch('/monitors', { method: 'POST', body });
					setView({ kind: 'list', monitorId: null });
					await loadCore();
				},
				[loadCore]
			);

			const saveSettings = useCallback(async (body) => {
				await apiFetch('/settings', { method: 'POST', body });
				const data = await apiFetch('/settings');
				setSettings(data && typeof data === 'object' ? data : null);
			}, []);

			const addPassenger = useCallback(async (body) => {
				await apiFetch('/passengers', { method: 'POST', body });
				const data = await apiFetch('/passengers');
				setPassengers(data && Array.isArray(data.passengers) ? data.passengers : []);
			}, []);

			const deletePassenger = useCallback(async (passenger) => {
				await apiFetch(`/passengers/${encodeURIComponent(passenger.id)}`, { method: 'DELETE' });
				const data = await apiFetch('/passengers');
				setPassengers(data && Array.isArray(data.passengers) ? data.passengers : []);
			}, []);

			/**
			 * Opens the visible Chrome window on the Host and waits for the sign-in
			 * (a long request, up to 8 minutes). The rest of the panel stays interactive:
			 * the chip explains the wait and ignores further clicks, and only this
			 * promise is outstanding. On completion the status and monitors are re-read.
			 */
			const startLogin = useCallback(async () => {
				if (loginRef.current) return;
				loginRef.current = true;
				setLoginPending(true);
				let failure = null;
				try {
					const data = await apiFetch('/login/start', { method: 'POST' });
					if (!data || data.ok !== true) {
						failure = data && typeof data.error === 'string' && data.error.trim() !== '' ? data.error : t('login.notDetected');
					}
				} catch (reason) {
					failure = reason && reason.message ? reason.message : t('login.failed');
				} finally {
					loginRef.current = false;
					setLoginPending(false);
					// The refresh below clears the page error when it succeeds, so a login
					// failure is raised afterwards to keep it on the status strip.
					await loadCore();
					if (failure !== null) setError(failure);
				}
			}, [loadCore]);

			const logout = useCallback(async () => {
				let failure = null;
				try {
					const data = await apiFetch('/login/logout', { method: 'POST' });
					if (data && data.ok === false) {
						failure = typeof data.error === 'string' && data.error !== '' ? data.error : t('login.logoutFailed');
					}
				} catch (reason) {
					failure = reason && reason.message ? reason.message : t('login.logoutFailed');
				}
				await loadCore();
				if (failure !== null) setError(failure);
			}, [loadCore]);
			// #endregion

			// A monitor can disappear between polls; fall back to the list instead of
			// rendering a detail page for a record that no longer exists.
			useEffect(() => {
				if (view.kind !== 'detail' || monitors === null) return;
				if (monitors.some((monitor) => monitor.id === view.monitorId)) return;
				setView({ kind: 'list', monitorId: null });
			}, [view, monitors]);

			const detailMonitor = detailId === null || monitors === null ? null : monitors.find((monitor) => monitor.id === detailId) || null;

			let content = null;
			if (view.kind === 'detail') {
				content =
					detailMonitor === null
						? h('div', { className: 'pw-scroll' }, h('div', { className: 'pw-body' }, h(Skeleton, { height: 32, width: '40%' }), h(Skeleton, { height: 180, radius: 12 }), h(Skeleton, { height: 70, radius: 12 })))
						: h(DetailView, {
								monitor: detailMonitor,
								passengers,
								prices,
								pricesError,
								busy: busyKey !== null,
								onBack: goList,
								onToggleEnabled: toggleEnabled,
								onRefresh: refreshMonitor,
								onDelete: deleteMonitor,
								onSaveRules: saveRules,
							});
			} else if (view.kind === 'settings') {
				content = h(SettingsView, {
					settings,
					passengers,
					status,
					loading: dataLoading,
					error: settingsError,
					onReload: reloadAux,
					onBack: goList,
					onSaveSettings: saveSettings,
					onAddPassenger: addPassenger,
					onDeletePassenger: deletePassenger,
					loginPending,
					onLogin: startLogin,
					onLogout: logout,
				});
			} else if (view.kind === 'new') {
				content = h(NewView, {
					passengers,
					settings,
					onCreate: createMonitor,
					onBack: goList,
					onGoSettings: goSettings,
				});
			} else {
				content = h(ListView, {
					monitors,
					status,
					filter,
					error,
					refreshing,
					busyKey,
					loginPending,
					onLogin: startLogin,
					onFilterChange: setFilter,
					onOpen: openDetail,
					onToggle: toggleEnabled,
					onNew: goNew,
					onSettings: goSettings,
					onRefresh: () => void loadCore({ manual: true }),
				});
			}

			return h(
				'div',
				{ className: 'pw-root' },
				h(ErrorBar, {
					message: error,
					onRetry: () => void loadCore({ manual: true }),
					onDismiss: () => setError(null),
				}),
				content
			);
		}
		// #endregion

		// #region sidebar glyph
		/**
		 * The sidebar row's glyph. `ownerProps` is `{ size, active }`: the button,
		 * the tooltip label and the panel switch belong to the sidebar. Active only
		 * needs a brand tint and a slightly heavier stroke.
		 */
		function PriceWatchIcon(props) {
			const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 20;
			const active = props && props.active === true;
			return h(
				'svg',
				{
					width: size,
					height: size,
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
					strokeWidth: active ? 2 : 1.7,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
					focusable: 'false',
					style: { display: 'block' },
				},
				h('path', { d: 'M4.2 4.2h6.1a2 2 0 0 1 1.42.59l8.1 8.1a2 2 0 0 1 0 2.83l-4.1 4.1a2 2 0 0 1-2.83 0l-8.1-8.1A2 2 0 0 1 4.2 10.3Z' }),
				h('circle', { cx: 7.6, cy: 7.6, r: 1.3 }),
				h('path', { d: 'M8.6 15.4 11.4 12.6 13.5 14.7 17.6 10.6' })
			);
		}
		// #endregion

		return {
			name: 'price-watch',
			inject: ['slots', 'locale'],
			apply(ctx) {
				try {
					runtime.t = ctx.locale.bind(NS);

					ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'price-watch: dictionaries');
					ctx.effect(() => ctx.locale.subscribe(() => runtime.revision.bump()), 'price-watch: locale revisions');

					ctx.effect(() => {
						const node = document.createElement('style');
						node.setAttribute('data-plugin', PANEL_ID);
						node.textContent = STYLE_TEXT;
						document.head.appendChild(node);
						return () => {
							if (node.parentNode !== null) node.parentNode.removeChild(node);
						};
					}, 'price-watch: styles');

					// The sidebar owns the button and the route; the glyph only paints.
					ctx.slots.inject('sidebar.panellist', () =>
						ctx.slots.register({ name: 'sidebar.panellist', id: 'price-watch', order: 20, label: () => t('nav'), locale: NS }, PriceWatchIcon)
					);
					// Keyed page; `price-watch` is a fresh key, so no shipped panel is shadowed.
					ctx.slots.inject('main', () =>
						ctx.slots.register({ name: 'main', key: 'price-watch', locale: NS }, PriceWatchPage)
					);

					runtime.revision.bump();
				} catch (error) {
					console.error('[price-watch] client half failed to apply', error);
				}
			},
		};
	},
});
