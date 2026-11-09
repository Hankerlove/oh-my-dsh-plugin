window.__ModuleLoader__.load({
	id: '@hankerlove/dsh-todo-list',
	/**
	 * Client half of the todo list bundle.
	 *
	 * One floating card in the frame-wide `shell.overlay` layer. It opens at the
	 * top-right corner, collapses to a draggable pill at its own position, shows
	 * one day at a time (today by default, with a day navigator), reminds the
	 * user at due times through system notifications and a light chime, and
	 * keeps everything browser-local. No Host route, tool or service is used.
	 */
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		const { useCallback, useEffect, useMemo, useRef, useState } = React;

		// #region constants
		const NS = 'todo-list';
		/** Browser-local storage keys (the desktop page origin is stable). */
		const MODEL_KEY = 'dsh.todo-list.v2';
		const LEGACY_MODEL_KEY = 'dsh.todo-list.v1';
		const VIEW_KEY = 'dsh.todo-list.view.v3';
		const SETTINGS_KEY = 'dsh.todo-list.settings.v1';
		/** How often due labels, reminders and repeating occurrences are evaluated. */
		const TICK_MS = 30000;
		/** A snoozed reminder comes back after this long. */
		const SNOOZE_MS = 10 * 60000;
		/** A reminder older than this when the page wakes up is recorded, not fired. */
		const NOTIFY_STALE_MS = 5 * 60000;
		/** Card geometry. */
		const PANEL_WIDTH = 332;
		const EDGE = 10;
		/** First-run / reset position: the top-right corner of the page. */
		const DEFAULT_TOP = 72;
		const RIGHT_INSET = 24;
		/** Room a collapsed pill needs around its centre. */
		const PILL_HALF = 58;
		const HISTORY_LIMIT = 200;
		const REPEATS = ['none', 'workdays', 'weekends', 'daily', 'weekly', 'monthly', 'yearly'];
		const PRIORITIES = ['p0', 'p1', 'p2'];
		const PRIORITY_RANK = { p0: 0, p1: 1, p2: 2 };
		const MAX_TITLE = 200;
		// #endregion

		// #region China work calendar
		/**
		 * Statutory holidays and make-up workdays from the State Council notices:
		 *  - 2026: published 2025-11-04
		 *    https://www.gov.cn/zhengce/content/202511/content_7047090.htm
		 *  - 2027: published 2026-11-05
		 *    https://www.gov.cn/zhengce/content/202611/content_7085101.htm
		 *
		 * Only the covered years are listed. Outside them the workday rules fall
		 * back to Monday–Friday, so a future notice must extend this table.
		 */
		const CN_HOLIDAYS = [
			// 2026 元旦
			'2026-01-01', '2026-01-02', '2026-01-03',
			// 2026 春节
			'2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
			// 2026 清明
			'2026-04-04', '2026-04-05', '2026-04-06',
			// 2026 劳动节
			'2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
			// 2026 端午
			'2026-06-19', '2026-06-20', '2026-06-21',
			// 2026 中秋
			'2026-09-25', '2026-09-26', '2026-09-27',
			// 2026 国庆
			'2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
			// 2027 元旦
			'2027-01-01', '2027-01-02', '2027-01-03',
			// 2027 春节
			'2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12', '2027-02-13',
			// 2027 清明
			'2027-04-03', '2027-04-04', '2027-04-05',
			// 2027 劳动节
			'2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05',
			// 2027 端午
			'2027-06-09',
			// 2027 中秋
			'2027-09-15',
			// 2027 国庆
			'2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04', '2027-10-05', '2027-10-06', '2027-10-07',
		];
		const CN_MAKEUP_WORKDAYS = [
			// 2026
			'2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10',
			// 2027
			'2027-01-31', '2027-02-14', '2027-05-08', '2027-09-26', '2027-10-09',
		];
		const HOLIDAY_SET = new Set(CN_HOLIDAYS);
		const MAKEUP_SET = new Set(CN_MAKEUP_WORKDAYS);
		// #endregion

		// #region pure model helpers
		const pad2 = (value) => String(value).padStart(2, '0');

		function dateKeyOf(date) {
			return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
		}

		function parseDateKey(key) {
			if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
			const parts = key.split('-').map(Number);
			const date = new Date(parts[0], parts[1] - 1, parts[2]);
			if (!Number.isFinite(date.getTime())) return null;
			// Reject impossible calendar days such as 2026-02-30, which the Date
			// constructor would otherwise roll into the next month.
			if (date.getFullYear() !== parts[0] || date.getMonth() !== parts[1] - 1 || date.getDate() !== parts[2]) return null;
			return date;
		}

		function isDateKey(value) {
			return /^\d{4}-\d{2}-\d{2}$/.test(value) && parseDateKey(value) !== null;
		}

		function normalizeTime(value) {
			return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d/.test(value) ? value.slice(0, 5) : '';
		}

		/** ISO weekday 0 (Sunday) … 6 (Saturday), or -1 for an unreadable key. */
		function weekdayOf(dateKey) {
			const date = parseDateKey(dateKey);
			return date === null ? -1 : date.getDay();
		}

		function instantOf(dateKey, time) {
			const date = parseDateKey(dateKey);
			if (date === null) return null;
			const clock = normalizeTime(time);
			if (clock !== '') {
				date.setHours(Number(clock.slice(0, 2)), Number(clock.slice(3, 5)), 0, 0);
			} else {
				date.setHours(23, 59, 0, 0);
			}
			return date.getTime();
		}

		function addDaysKey(dateKey, days) {
			const date = parseDateKey(dateKey);
			if (date === null) return dateKey;
			date.setDate(date.getDate() + days);
			return dateKeyOf(date);
		}

		function addMonthsKey(dateKey, months) {
			const date = parseDateKey(dateKey);
			if (date === null) return dateKey;
			const day = date.getDate();
			date.setDate(1);
			date.setMonth(date.getMonth() + months);
			const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
			date.setDate(Math.min(day, lastDay));
			return dateKeyOf(date);
		}

		/** A statutory rest day, or a weekend that was not made up for work. */
		function isWorkday(dateKey) {
			if (MAKEUP_SET.has(dateKey)) return true;
			if (HOLIDAY_SET.has(dateKey)) return false;
			const day = weekdayOf(dateKey);
			return day >= 1 && day <= 5;
		}

		function isWeekendDay(dateKey) {
			if (MAKEUP_SET.has(dateKey)) return false;
			const day = weekdayOf(dateKey);
			return day === 0 || day === 6;
		}

		function advanceDate(dateKey, repeat) {
			if (repeat === 'daily') return addDaysKey(dateKey, 1);
			if (repeat === 'weekly') return addDaysKey(dateKey, 7);
			if (repeat === 'monthly') return addMonthsKey(dateKey, 1);
			if (repeat === 'yearly') return addMonthsKey(dateKey, 12);
			if (repeat === 'workdays') {
				let next = addDaysKey(dateKey, 1);
				let guard = 0;
				while (!isWorkday(next) && guard < 400) {
					next = addDaysKey(next, 1);
					guard += 1;
				}
				return next;
			}
			if (repeat === 'weekends') {
				let next = addDaysKey(dateKey, 1);
				let guard = 0;
				while (!isWeekendDay(next) && guard < 400) {
					next = addDaysKey(next, 1);
					guard += 1;
				}
				return next;
			}
			return dateKey;
		}

		function nextOccurrenceFrom(dateKey, repeat, today) {
			if (repeat === 'none' || !isDateKey(dateKey)) return dateKey;
			let next = advanceDate(dateKey, repeat);
			let guard = 0;
			while (next < today && guard < 5000) {
				next = advanceDate(next, repeat);
				guard += 1;
			}
			return next;
		}

		function alignToRepeat(dateKey, repeat) {
			if (repeat === 'workdays' && !isWorkday(dateKey)) {
				let next = dateKey;
				let guard = 0;
				while (!isWorkday(next) && guard < 400) {
					next = addDaysKey(next, 1);
					guard += 1;
				}
				return next;
			}
			if (repeat === 'weekends' && !isWeekendDay(dateKey)) {
				let next = dateKey;
				let guard = 0;
				while (!isWeekendDay(next) && guard < 400) {
					next = addDaysKey(next, 1);
					guard += 1;
				}
				return next;
			}
			return dateKey;
		}

		let idCounter = 0;
		function makeId() {
			idCounter = (idCounter + 1) % 100000;
			return `todo-${Date.now().toString(36)}-${idCounter}`;
		}

		function todayKey(now) {
			return dateKeyOf(new Date(now ?? Date.now()));
		}

		function dayDiff(fromKey, toKey) {
			const from = parseDateKey(fromKey);
			const to = parseDateKey(toKey);
			if (from === null || to === null) return 0;
			return Math.round((to.getTime() - from.getTime()) / 86400000);
		}

		function priorityRank(priority) {
			return priority !== null && Object.prototype.hasOwnProperty.call(PRIORITY_RANK, priority) ? PRIORITY_RANK[priority] : 3;
		}

		function loadJson(key) {
			try {
				const raw = window.localStorage.getItem(key);
				return raw === null ? null : JSON.parse(raw);
			} catch (error) {
				return null;
			}
		}

		function saveJson(key, value) {
			try {
				window.localStorage.setItem(key, JSON.stringify(value));
			} catch (error) {
				// A full or blocked storage must not break the panel.
			}
		}

		function normalizeTodo(item, seen) {
			if (item === null || typeof item !== 'object') return null;
			const title = typeof item.title === 'string' ? item.title.trim() : '';
			if (title === '') return null;
			let id = typeof item.id === 'string' && item.id !== '' ? item.id : makeId();
			if (seen.has(id)) id = makeId();
			seen.add(id);
			return {
				id,
				title: title.slice(0, MAX_TITLE),
				date: isDateKey(item.date) ? item.date : todayKey(),
				time: normalizeTime(item.time),
				repeat: REPEATS.includes(item.repeat) ? item.repeat : 'none',
				priority: PRIORITIES.includes(item.priority) ? item.priority : null,
				done: item.done === true,
				doneAt: Number.isFinite(item.doneAt) ? item.doneAt : null,
				nextDate: isDateKey(item.nextDate) ? item.nextDate : null,
				notifiedKey: typeof item.notifiedKey === 'string' ? item.notifiedKey : null,
				createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
			};
		}

		function normalizeHistory(raw, seen) {
			if (!Array.isArray(raw)) return [];
			const out = [];
			for (const item of raw) {
				if (item === null || typeof item !== 'object') continue;
				const title = typeof item.title === 'string' ? item.title.trim() : '';
				if (title === '') continue;
				if (!isDateKey(item.date)) continue;
				out.push({
					id: typeof item.id === 'string' && item.id !== '' ? item.id : makeId(),
					title: title.slice(0, MAX_TITLE),
					date: item.date,
					time: normalizeTime(item.time),
					repeat: REPEATS.includes(item.repeat) ? item.repeat : 'none',
					priority: PRIORITIES.includes(item.priority) ? item.priority : null,
					status: item.status === 'missed' ? 'missed' : 'done',
					at: Number.isFinite(item.at) ? item.at : (instantOf(item.date, item.time) ?? Date.now()),
				});
			}
			return out;
		}

		function pruneHistory(history) {
			if (history.length <= HISTORY_LIMIT) return history;
			return history.slice(history.length - HISTORY_LIMIT);
		}

		function normalizeModel(raw) {
			const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : { todos: Array.isArray(raw) ? raw : [] };
			const seen = new Set();
			const todos = [];
			for (const item of Array.isArray(source.todos) ? source.todos : []) {
				const todo = normalizeTodo(item, seen);
				if (todo !== null) todos.push(todo);
			}
			const history = normalizeHistory(source.history, seen);
			return { todos, history: pruneHistory(history) };
		}

		/**
		 * Advance every repeating todo to today, folding what happened meanwhile
		 * into the history: a completed occurrence becomes a `done` entry, a
		 * skipped occurrence becomes a `missed` entry. Pure: returns new arrays.
		 */
		function settle(model, now) {
			const today = todayKey(now);
			const history = [...model.history];
			let changed = false;
			const todos = model.todos.map((todo) => {
				let item = todo;
				if (item.done && item.repeat !== 'none' && item.nextDate !== null) {
					const arrived =
						item.time === ''
							? item.nextDate <= today
							: (instantOf(item.nextDate, item.time) ?? Number.POSITIVE_INFINITY) <= now;
					if (arrived) {
						history.push({
							id: makeId(),
							title: item.title,
							date: item.date,
							time: item.time,
							repeat: item.repeat,
							priority: item.priority,
							status: 'done',
							at: item.doneAt ?? now,
						});
						item = { ...item, done: false, doneAt: null, date: item.nextDate, nextDate: null, notifiedKey: null };
						changed = true;
					}
				}
				if (!item.done && item.repeat !== 'none') {
					let nextDate = item.date;
					let guard = 0;
					while (nextDate < today && guard < 400) {
						history.push({
							id: makeId(),
							title: item.title,
							date: nextDate,
							time: item.time,
							repeat: item.repeat,
							priority: item.priority,
							status: 'missed',
							at: instantOf(nextDate, item.time) ?? now,
						});
						nextDate = advanceDate(nextDate, item.repeat);
						guard += 1;
						changed = true;
					}
					if (nextDate !== item.date) item = { ...item, date: nextDate, notifiedKey: null };
				}
				return item;
			});
			const pruned = pruneHistory(history);
			if (pruned.length !== history.length) changed = true;
			return { todos, history: pruned, changed };
		}

		/** One todo row order: urgency first, then priority, then due time. */
		function compareOpen(left, right) {
			const leftAt = instantOf(left.date, left.time);
			const rightAt = instantOf(right.date, right.time);
			if (leftAt !== null && rightAt !== null && leftAt !== rightAt) return leftAt - rightAt;
			const rank = priorityRank(left.priority) - priorityRank(right.priority);
			if (rank !== 0) return rank;
			if (leftAt === null && rightAt !== null) return 1;
			if (leftAt !== null && rightAt === null) return -1;
			return left.createdAt - right.createdAt;
		}

		/** Items that reached their clock time and still owe a reminder. */
		function collectDue(todos, now) {
			const due = [];
			for (const todo of todos) {
				if (todo.done || todo.time === '') continue;
				const instant = instantOf(todo.date, todo.time);
				if (instant === null || instant > now) continue;
				const key = `${todo.date} ${todo.time}`;
				if (todo.notifiedKey === key) continue;
				due.push({ id: todo.id, key, title: todo.title, time: todo.time, stale: now - instant > NOTIFY_STALE_MS });
			}
			return due;
		}

		/** Everything shown for one calendar day. */
		function dayView(todos, history, day) {
			const active = [];
			const doneEntries = [];
			for (const todo of todos) {
				if (todo.date !== day) continue;
				if (todo.done) doneEntries.push({ kind: 'todo', at: todo.doneAt ?? 0, todo });
				else active.push(todo);
			}
			active.sort(compareOpen);
			const missed = [];
			for (const entry of history) {
				if (entry.date !== day) continue;
				if (entry.status === 'done') doneEntries.push({ kind: 'history', at: entry.at, history: entry });
				else missed.push(entry);
			}
			doneEntries.sort((left, right) => right.at - left.at);
			missed.sort((left, right) => right.at - left.at);
			return { active, doneEntries, missed };
		}

		/** Cross-day counts behind the "overdue / upcoming" chips. */
		function summarize(todos, today) {
			let overdue = 0;
			let future = 0;
			let overdueDate = null;
			let futureDate = null;
			for (const todo of todos) {
				if (todo.done) continue;
				if (todo.date < today) {
					overdue += 1;
					if (overdueDate === null || todo.date < overdueDate) overdueDate = todo.date;
				} else if (todo.date > today) {
					future += 1;
					if (futureDate === null || todo.date < futureDate) futureDate = todo.date;
				}
			}
			return { overdue, future, overdueDate, futureDate };
		}

		function createObservable(initial) {
			let snapshot = initial;
			const listeners = new Set();
			return {
				getSnapshot() {
					return snapshot;
				},
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				set(next) {
					if (Object.is(next, snapshot)) return;
					snapshot = next;
					for (const listener of [...listeners]) {
						try {
							listener();
						} catch (error) {
							// One crashed subscriber must not stop the others.
						}
					}
				},
			};
		}

		function useObservable(observable) {
			const [snapshot, setSnapshot] = useState(() => observable.getSnapshot());
			useEffect(() => {
				setSnapshot(observable.getSnapshot());
				return observable.subscribe(() => setSnapshot(observable.getSnapshot()));
			}, [observable]);
			return snapshot;
		}

		function loadStoredModel() {
			const stored = loadJson(MODEL_KEY);
			if (stored !== null) return normalizeModel(stored);
			const legacy = loadJson(LEGACY_MODEL_KEY);
			if (legacy !== null) return normalizeModel({ todos: Array.isArray(legacy) ? legacy : [], history: [] });
			return { todos: [], history: [] };
		}
		// #endregion

		// #region stores
		function createTodoStore() {
			const initial = loadStoredModel();
			const observable = createObservable({ todos: initial.todos, history: initial.history, now: Date.now() });

			function commit(model) {
				saveJson(MODEL_KEY, { todos: model.todos, history: model.history });
				observable.set({ todos: model.todos, history: model.history, now: Date.now() });
			}

			function patchTodos(change) {
				const snapshot = observable.getSnapshot();
				const todos = change(snapshot.todos);
				if (todos === null) return;
				commit({ todos, history: snapshot.history });
			}

			const store = {
				getSnapshot: observable.getSnapshot,
				subscribe: observable.subscribe,
				refresh() {
					const snapshot = observable.getSnapshot();
					observable.set({ todos: snapshot.todos, history: snapshot.history, now: Date.now() });
				},
				add(input) {
					const title = typeof input.title === 'string' ? input.title.trim() : '';
					if (title === '') return null;
					const repeat = REPEATS.includes(input.repeat) ? input.repeat : 'none';
					const priority = PRIORITIES.includes(input.priority) ? input.priority : null;
					let date = isDateKey(input.date) ? input.date : todayKey();
					if (repeat !== 'none') date = alignToRepeat(date, repeat);
					const todo = {
						id: makeId(),
						title: title.slice(0, MAX_TITLE),
						date,
						time: normalizeTime(input.time),
						repeat,
						priority,
						done: false,
						doneAt: null,
						nextDate: null,
						notifiedKey: null,
						createdAt: Date.now(),
					};
					const snapshot = observable.getSnapshot();
					commit({ todos: [...snapshot.todos, todo], history: snapshot.history });
					return todo;
				},
				toggle(id) {
					const now = Date.now();
					const today = todayKey(now);
					patchTodos((todos) =>
						todos.map((todo) => {
							if (todo.id !== id) return todo;
							if (todo.done) return { ...todo, done: false, doneAt: null, nextDate: null, notifiedKey: null };
							if (todo.repeat === 'none') return { ...todo, done: true, doneAt: now, nextDate: null };
							return { ...todo, done: true, doneAt: now, nextDate: nextOccurrenceFrom(todo.date, todo.repeat, today) };
						}),
					);
				},
				remove(id) {
					patchTodos((todos) => todos.filter((todo) => todo.id !== id));
				},
				removeHistory(id) {
					const snapshot = observable.getSnapshot();
					commit({ todos: snapshot.todos, history: snapshot.history.filter((entry) => entry.id !== id) });
				},
				markNotified(entries) {
					if (entries.length === 0) return;
					const keys = new Map(entries.map((entry) => [entry.id, entry.key]));
					patchTodos((todos) => todos.map((todo) => (keys.has(todo.id) ? { ...todo, notifiedKey: keys.get(todo.id) } : todo)));
				},
				clearDone() {
					const snapshot = observable.getSnapshot();
					commit({
						todos: snapshot.todos.filter((todo) => !todo.done || todo.repeat !== 'none'),
						history: [],
					});
				},
				tick() {
					const snapshot = observable.getSnapshot();
					const next = settle({ todos: snapshot.todos, history: snapshot.history }, Date.now());
					if (next.changed) {
						commit({ todos: next.todos, history: next.history });
					} else {
						observable.set({ todos: next.todos, history: next.history, now: Date.now() });
					}
				},
			};
			return store;
		}

		function loadSettings() {
			const raw = loadJson(SETTINGS_KEY);
			if (raw === null || typeof raw !== 'object') return { notify: true };
			return { notify: raw.notify !== false };
		}

		function createSettingsStore() {
			const observable = createObservable(loadSettings());
			return {
				getSnapshot: observable.getSnapshot,
				subscribe: observable.subscribe,
				set(next) {
					saveJson(SETTINGS_KEY, { notify: next.notify !== false });
					observable.set({ notify: next.notify !== false });
				},
			};
		}

		/** Reminders that are currently demanding attention. */
		function createAlertStore() {
			const observable = createObservable({ alerts: [] });
			return {
				getSnapshot: observable.getSnapshot,
				subscribe: observable.subscribe,
				set(next) {
					observable.set(next);
				},
			};
		}
		// #endregion

		// #region reminders
		function sendDesktopNotification(title, body, tag) {
			try {
				if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
				const notice = new Notification(title, {
					body,
					tag,
					// The plugin plays its own soft chime, and a reminder stays on
					// screen until it is dealt with where the platform allows it.
					silent: true,
					requireInteraction: true,
					renotify: true,
				});
				notice.onclick = () => {
					try {
						window.focus();
					} catch (error) {
						// Ignore a blocked focus request.
					}
				};
			} catch (error) {
				// Desktop notifications are optional.
			}
		}

		/** Two soft sine notes, short and quiet; unlocked on the first gesture. */
		function createChime() {
			let audio = null;
			function ensure() {
				try {
					const Ctor = window.AudioContext || window.webkitAudioContext;
					if (Ctor === undefined) return null;
					if (audio === null || audio.state === 'closed') audio = new Ctor();
					if (audio.state === 'suspended') audio.resume().catch(() => {});
					return audio;
				} catch (error) {
					return null;
				}
			}
			return {
				unlock() {
					ensure();
				},
				play() {
					const context = ensure();
					if (context === null) return;
					const start = context.currentTime;
					const notes = [
						{ frequency: 987.77, offset: 0 },
						{ frequency: 1318.51, offset: 0.13 },
					];
					for (const note of notes) {
						const oscillator = context.createOscillator();
						const gain = context.createGain();
						const at = start + note.offset;
						oscillator.type = 'sine';
						oscillator.frequency.value = note.frequency;
						gain.gain.setValueAtTime(0.0001, at);
						gain.gain.exponentialRampToValueAtTime(0.05, at + 0.02);
						gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
						oscillator.connect(gain);
						gain.connect(context.destination);
						oscillator.start(at);
						oscillator.stop(at + 0.55);
					}
				},
				dispose() {
					if (audio === null) return;
					try {
						audio.close();
					} catch (error) {
						// Already closed.
					}
					audio = null;
				},
			};
		}
		// #endregion

		// #region view geometry
		/** Default geometry: the top-right corner of the window. */
		function defaultView() {
			const width = typeof window === 'undefined' ? 1280 : window.innerWidth;
			const x = Math.max(EDGE, width - PANEL_WIDTH - RIGHT_INSET);
			return { x, y: DEFAULT_TOP, collapsed: false, pillX: x + PANEL_WIDTH / 2, pillY: DEFAULT_TOP };
		}

		function normalizeView(raw) {
			const base = defaultView();
			if (raw === null || typeof raw !== 'object') return base;
			const x = Number.isFinite(raw.x) ? raw.x : base.x;
			const y = Number.isFinite(raw.y) ? raw.y : base.y;
			return {
				x,
				y,
				collapsed: raw.collapsed === true,
				pillX: Number.isFinite(raw.pillX) ? raw.pillX : x + PANEL_WIDTH / 2,
				pillY: Number.isFinite(raw.pillY) ? raw.pillY : y,
			};
		}

		function viewport() {
			return {
				width: typeof window === 'undefined' ? 1280 : window.innerWidth,
				height: typeof window === 'undefined' ? 800 : window.innerHeight,
			};
		}

		function clampCard(view) {
			const size = viewport();
			const maxX = Math.max(EDGE, size.width - PANEL_WIDTH - EDGE);
			const maxY = Math.max(EDGE, size.height - 148);
			return {
				...view,
				x: Math.min(maxX, Math.max(EDGE, view.x)),
				y: Math.min(maxY, Math.max(EDGE, view.y)),
			};
		}

		function clampPill(view) {
			const size = viewport();
			return {
				...view,
				pillX: Math.min(size.width - PILL_HALF - EDGE, Math.max(PILL_HALF + EDGE, view.pillX)),
				pillY: Math.min(Math.max(EDGE, size.height - 70), Math.max(EDGE, view.pillY)),
			};
		}

		function clampView(view) {
			return clampPill(clampCard(view));
		}
		// #endregion

		// #region formatting
		function intlLocale() {
			const lang = typeof document === 'undefined' ? '' : document.documentElement.lang;
			return typeof lang === 'string' && lang !== '' ? lang : 'zh-CN';
		}

		function formatWeekday(dateKey) {
			const date = parseDateKey(dateKey);
			if (date === null) return '';
			try {
				return new Intl.DateTimeFormat(intlLocale(), { weekday: 'short' }).format(date);
			} catch (error) {
				return '';
			}
		}

		function formatShortDate(dateKey) {
			const date = parseDateKey(dateKey);
			if (date === null) return '';
			try {
				return new Intl.DateTimeFormat(intlLocale(), { month: 'numeric', day: 'numeric' }).format(date);
			} catch (error) {
				return dateKey;
			}
		}

		/** `YYYY/MM/DD` — the day heading format. */
		function formatDayStamp(dayKey) {
			const date = parseDateKey(dayKey);
			if (date === null) return dayKey;
			return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`;
		}

		function relativeDayLabel(t, dayKey, today) {
			const diff = dayDiff(today, dayKey);
			if (diff === 0) return t('when.today');
			if (diff === 1) return t('when.tomorrow');
			if (diff === -1) return t('when.yesterday');
			if (diff === 2) return t('when.dayAfterTomorrow');
			return formatWeekday(dayKey);
		}

		function formatWhen(t, dateKey, time, today) {
			const date = parseDateKey(dateKey);
			if (date === null) return '';
			const diff = dayDiff(today, dateKey);
			let day;
			if (diff === 0) day = t('when.today');
			else if (diff === 1) day = t('when.tomorrow');
			else if (diff === -1) day = t('when.yesterday');
			else if (diff > 1 && diff < 7) day = formatWeekday(dateKey);
			else day = formatShortDate(dateKey);
			const clock = normalizeTime(time);
			return clock === '' ? day : `${day} ${clock}`;
		}

		function repeatLabel(t, repeat) {
			if (repeat === 'workdays') return t('repeat.workdays');
			if (repeat === 'weekends') return t('repeat.weekends');
			if (repeat === 'daily') return t('repeat.daily');
			if (repeat === 'weekly') return t('repeat.weekly');
			if (repeat === 'monthly') return t('repeat.monthly');
			if (repeat === 'yearly') return t('repeat.yearly');
			return t('repeat.none');
		}

		function priorityLabel(t, priority) {
			if (priority === 'p0') return t('priority.p0');
			if (priority === 'p1') return t('priority.p1');
			if (priority === 'p2') return t('priority.p2');
			return t('priority.none');
		}
		// #endregion

		// #region icons
		function Glyph({ children, size, style }) {
			return h(
				'svg',
				{
					viewBox: '0 0 24 24',
					width: size ?? 16,
					height: size ?? 16,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.7,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
					style: Object.assign({ display: 'block', flex: 'none' }, style),
				},
				children,
			);
		}

		const IcoCheck = (props) => h(Glyph, props, h('path', { d: 'M5 12.6l4.4 4.4L19 7.4' }));
		const IcoPlus = (props) => h(Glyph, props, h('path', { d: 'M12 5v14M5 12h14' }));
		const IcoTrash = (props) =>
			h(Glyph, props, h('path', { d: 'M4 7h16M9.5 7V5h5v2M6.5 7l1 13h9l1-13M10 11v6M14 11v6' }));
		const IcoRepeat = (props) => h(Glyph, props, h('path', { d: 'M4.5 9.5h12.5l-3-3M19.5 14.5H7l3 3' }));
		const IcoChevron = ({ open, ...props }) => h(Glyph, props, h('path', { d: open ? 'M6 15l6-6 6 6' : 'M9 6l6 6-6 6' }));
		const IcoChevronDown = (props) => h(Glyph, props, h('path', { d: 'M6 9l6 6 6-6' }));
		const IcoArrowLeft = (props) => h(Glyph, props, h('path', { d: 'M14.5 6l-6 6 6 6' }));
		const IcoArrowRight = (props) => h(Glyph, props, h('path', { d: 'M9.5 6l6 6-6 6' }));
		const IcoPanel = (props) =>
			h(
				Glyph,
				props,
				h('rect', { x: 4, y: 3.5, width: 16, height: 17, rx: 3 }),
				h('path', { d: 'M8.5 8.5h7M8.5 12h7M8.5 15.5h4' }),
			);
		const IcoTarget = (props) =>
			h(
				Glyph,
				props,
				h('circle', { cx: 12, cy: 12, r: 7 }),
				h('circle', { cx: 12, cy: 12, r: 2 }),
				h('path', { d: 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3' }),
			);
		const IcoDash = (props) => h(Glyph, props, h('path', { d: 'M7 12h10' }));
		const IcoBell = (props) =>
			h(Glyph, props, h('path', { d: 'M6 9.5a6 6 0 1 1 12 0c0 3.2 1.2 4.6 1.2 4.6H4.8S6 12.7 6 9.5' }), h('path', { d: 'M10 17.5a2 2 0 0 0 4 0' }));
		const IcoBellOff = (props) =>
			h(
				Glyph,
				props,
				h('path', { d: 'M6 9.5a6 6 0 0 1 9.1-5.1M18 9.5c0 3.2 1.2 4.6 1.2 4.6H8M10 17.5a2 2 0 0 0 4 0' }),
				h('path', { d: 'M4 4l16 16' }),
			);
		// #endregion

		// #region styles
		const CSS = `
.dsh-todo-head { cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
.dsh-todo-head.is-dragging { cursor: grabbing; }
.dsh-todo-card.is-dragging { box-shadow: 0 26px 64px rgba(0, 0, 0, 0.34), 0 4px 14px rgba(0, 0, 0, 0.16) !important; }
.dsh-todo-action { transition: background 120ms ease, color 120ms ease, opacity 120ms ease; }
.dsh-todo-action:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-todo-action:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-todo-row { transition: background 120ms ease; }
.dsh-todo-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-todo-row:hover .dsh-todo-del, .dsh-todo-del:focus-visible { opacity: 1 !important; }
.dsh-todo-check { transition: border-color 140ms ease, background 140ms ease, transform 140ms ease; }
.dsh-todo-check:hover { border-color: var(--dsw-alias-brand-primary); }
.dsh-todo-check:active { transform: scale(0.9); }
.dsh-todo-check:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsh-todo-check.is-done { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #ffffff; }
.dsh-todo-clickable:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; border-radius: 8px; }
.dsh-todo-field { font: inherit; font-size: 12px; outline: none; transition: border-color 120ms ease; }
.dsh-todo-field:focus { border-color: var(--dsw-alias-brand-primary) !important; }
.dsh-todo-input::placeholder { color: var(--dsw-alias-label-secondary); opacity: 0.85; }
.dsh-todo-card { animation: dsh-todo-appear 160ms ease-out; }
@keyframes dsh-todo-appear { from { opacity: 0; transform: translateY(-4px) scale(0.99); } to { opacity: 1; transform: none; } }
.dsh-todo-pill { animation: dsh-todo-fade 160ms ease-out; }
@keyframes dsh-todo-fade { from { opacity: 0; } to { opacity: 1; } }
.dsh-todo-scroll { scrollbar-width: thin; scrollbar-color: var(--dsw-alias-border-l2) transparent; }
.dsh-todo-scroll::-webkit-scrollbar { width: 6px; }
.dsh-todo-scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2); border-radius: 999px; }
.dsh-todo-scroll::-webkit-scrollbar-track { background: transparent; }
.dsh-todo-pill { cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
.dsh-todo-pill.is-dragging { cursor: grabbing; }
.dsh-todo-pill:hover { box-shadow: 0 12px 30px rgba(0, 0, 0, 0.2), 0 2px 6px rgba(0, 0, 0, 0.1) !important; }
.dsh-todo-menu { animation: dsh-todo-menu-in 110ms ease-out; }
@keyframes dsh-todo-menu-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
.dsh-todo-option:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-todo-option:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dsh-todo-chip:hover { filter: brightness(0.97); }
.dsh-todo-alert { animation: dsh-todo-alert-in 200ms cubic-bezier(0.2, 0.9, 0.3, 1.05); }
@keyframes dsh-todo-alert-in { from { opacity: 0; transform: translateY(-8px) scale(0.98); } to { opacity: 1; transform: none; } }
.dsh-todo-alert-icon { animation: dsh-todo-ring 1.8s ease-out infinite; }
@keyframes dsh-todo-ring {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dsw-alias-state-error-primary) 46%, transparent); }
  70% { box-shadow: 0 0 0 11px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
.dsh-todo-alert-action { transition: filter 120ms ease; }
.dsh-todo-alert-action:hover { filter: brightness(0.96); }
`;
		// #endregion

		// #region view constants
		const COLOR = {
			label: 'var(--dsw-alias-label-primary)',
			label2: 'var(--dsw-alias-label-secondary)',
			border: 'var(--dsw-alias-border-l1)',
			border2: 'var(--dsw-alias-border-l2)',
			layer2: 'var(--dsw-alias-bg-layer-2)',
			overlay: 'var(--dsw-alias-bg-overlay)',
			accent: 'var(--dsw-alias-brand-primary)',
			danger: 'var(--dsw-alias-state-error-primary)',
			warn: 'var(--dsw-alias-state-warn-primary)',
		};
		const PRIORITY_COLOR = {
			p0: 'var(--dsw-alias-state-error-primary)',
			p1: 'var(--dsw-alias-state-warn-primary)',
			p2: 'var(--dsw-alias-brand-primary)',
		};
		const FONT =
			'var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif)';
		const shadow = '0 18px 48px rgba(0, 0, 0, 0.22), 0 2px 8px rgba(0, 0, 0, 0.1)';
		const FIELD_HEIGHT = 30;
		const FIELD_BOX = {
			height: FIELD_HEIGHT,
			padding: '0 9px',
			borderRadius: 9,
			border: `0.5px solid ${COLOR.border2}`,
			background: COLOR.layer2,
			color: COLOR.label,
			fontFamily: FONT,
			fontSize: 12,
			minWidth: 0,
			boxSizing: 'border-box',
		};
		const FIELD_INPUT = Object.assign({}, FIELD_BOX, { display: 'block' });
		const FIELD_FLEX = Object.assign({}, FIELD_BOX, { display: 'flex', alignItems: 'center' });
		// #endregion

		// #region components
		function ActionButton({ label, onClick, children, size, style }) {
			return h(
				'button',
				{
					type: 'button',
					className: 'dsh-todo-action',
					title: label,
					'aria-label': label,
					'data-todo-nodrag': '1',
					onClick,
					onMouseDown: (event) => event.preventDefault(),
					style: Object.assign(
						{
							display: 'inline-flex',
							alignItems: 'center',
							justifyContent: 'center',
							width: size ?? 26,
							height: size ?? 26,
							padding: 0,
							border: 'none',
							borderRadius: 8,
							background: 'transparent',
							color: COLOR.label2,
							cursor: 'pointer',
							fontFamily: FONT,
							flex: 'none',
						},
						style,
					),
				},
				children,
			);
		}

		function CheckCircle({ done, label, onClick }) {
			return h(
				'button',
				{
					type: 'button',
					className: `dsh-todo-check${done ? ' is-done' : ''}`,
					'aria-label': label,
					title: label,
					onClick,
					onMouseDown: (event) => event.preventDefault(),
					style: {
						display: 'inline-flex',
						alignItems: 'center',
						justifyContent: 'center',
						width: 22,
						height: 22,
						marginTop: 1,
						padding: 0,
						borderRadius: '50%',
						border: done ? '1.5px solid transparent' : '1.5px solid var(--dsw-alias-border-l2)',
						background: done ? COLOR.accent : 'transparent',
						color: done ? '#ffffff' : 'transparent',
						cursor: 'pointer',
						flex: 'none',
					},
				},
				h(IcoCheck, { size: 13, style: { strokeWidth: 2.6 } }),
			);
		}

		function DeleteButton({ label, onClick }) {
			return h(
				'button',
				{
					type: 'button',
					className: 'dsh-todo-del',
					title: label,
					'aria-label': label,
					onClick,
					onMouseDown: (event) => event.preventDefault(),
					style: {
						display: 'inline-flex',
						alignItems: 'center',
						justifyContent: 'center',
						width: 22,
						height: 22,
						marginTop: 1,
						padding: 0,
						border: 'none',
						borderRadius: 6,
						background: 'transparent',
						color: COLOR.label2,
						opacity: 0.35,
						cursor: 'pointer',
						flex: 'none',
						transition: 'opacity 120ms ease',
					},
				},
				h(IcoTrash, { size: 13 }),
			);
		}

		function PriorityBadge({ t, priority }) {
			if (priority === null) return null;
			const color = PRIORITY_COLOR[priority];
			return h(
				'span',
				{
					title: t('priority.label'),
					style: {
						display: 'inline-flex',
						alignItems: 'center',
						justifyContent: 'center',
						flex: 'none',
						height: 15,
						padding: '0 4px',
						borderRadius: 4,
						fontSize: 9.5,
						fontWeight: 700,
						letterSpacing: '0.02em',
						background: `color-mix(in srgb, ${color} 18%, transparent)`,
						color,
					},
				},
				priorityLabel(t, priority),
			);
		}

		function RowFrame({ leading, title, meta, metaColor, struck, muted, accent, badge, onRemove, removeLabel }) {
			return h(
				'div',
				{
					className: 'dsh-todo-row',
					style: {
						display: 'flex',
						alignItems: 'flex-start',
						gap: 10,
						padding: '7px 8px 7px 7px',
						borderRadius: 10,
						borderLeft: `2.5px solid ${accent ?? 'transparent'}`,
						opacity: muted ? 0.92 : 1,
					},
				},
				leading,
				h(
					'div',
					{ style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 1 } },
					h(
						'div',
						{ style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
						badge ?? null,
						h(
							'span',
							{
								style: {
									flex: 1,
									minWidth: 0,
									fontSize: 13.5,
									lineHeight: '18px',
									color: muted ? COLOR.label2 : COLOR.label,
									textDecoration: struck ? 'line-through' : 'none',
									textDecorationColor: COLOR.label2,
									textDecorationThickness: '1px',
									wordBreak: 'break-word',
									opacity: muted ? 0.72 : 1,
								},
							},
							title,
						),
					),
					meta === ''
						? null
						: h(
								'div',
								{
									style: {
										display: 'flex',
										alignItems: 'center',
										gap: 4,
										fontSize: 11,
										lineHeight: '15px',
										color: metaColor ?? COLOR.label2,
										opacity: muted ? 0.85 : 1,
									},
								},
								meta,
							),
				),
				onRemove === undefined ? null : h(DeleteButton, { label: removeLabel, onClick: onRemove }),
			);
		}

		function TodoRow({ todo, t, now, today, onToggle, onRemove }) {
			const instant = instantOf(todo.date, todo.time);
			const overdue = !todo.done && instant !== null && instant < now;
			let text;
			if (todo.done) {
				text = todo.repeat !== 'none' && todo.nextDate !== null
					? t('row.next', { when: formatWhen(t, todo.nextDate, todo.time, today) })
					: t('history.done');
			} else {
				text = formatWhen(t, todo.date, todo.time, today);
				if (todo.repeat !== 'none') text = `${text} · ${repeatLabel(t, todo.repeat)}`;
			}
			const meta = h(
				'span',
				{ style: { display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 } },
				todo.repeat !== 'none' ? h(IcoRepeat, { key: 'repeat', size: 11 }) : null,
				h('span', null, text),
			);
			return h(RowFrame, {
				leading: h(CheckCircle, {
					done: todo.done,
					label: todo.done ? t('row.markOpen') : t('row.markDone'),
					onClick: () => onToggle(todo.id),
				}),
				title: todo.title,
				meta,
				metaColor: overdue ? COLOR.danger : undefined,
				struck: todo.done,
				muted: todo.done,
				accent: todo.done || todo.priority === null ? undefined : PRIORITY_COLOR[todo.priority],
				badge: h(PriorityBadge, { t, priority: todo.priority }),
				onRemove: () => onRemove(todo.id),
				removeLabel: t('row.delete'),
			});
		}

		function HistoryRow({ entry, t, today, onRemove }) {
			const done = entry.status === 'done';
			const meta = [
				done ? t('history.done') : t('history.missed'),
				formatWhen(t, entry.date, entry.time, today),
			].join(' · ');
			const leading = h(
				'div',
				{
					style: {
						display: 'inline-flex',
						alignItems: 'center',
						justifyContent: 'center',
						width: 22,
						height: 22,
						marginTop: 1,
						borderRadius: '50%',
						border: done ? '1.5px solid transparent' : `1.5px solid ${COLOR.border2}`,
						background: done ? COLOR.label2 : 'transparent',
						color: done ? '#ffffff' : COLOR.label2,
						flex: 'none',
						opacity: done ? 0.7 : 0.9,
					},
				},
				h(done ? IcoCheck : IcoDash, { size: 12, style: { strokeWidth: done ? 2.6 : 2 } }),
			);
			return h(RowFrame, {
				leading,
				title: entry.title,
				meta,
				metaColor: done ? COLOR.label2 : COLOR.warn,
				struck: done,
				muted: true,
				badge: h(PriorityBadge, { t, priority: entry.priority }),
				onRemove: () => onRemove(entry.id),
				removeLabel: t('row.delete'),
			});
		}

		/** Shared dropdown: a full-width field plus a menu that drops below it. */
		function Picker({ ariaLabel, prefix, value, items, onChange, width, alignRight }) {
			const [open, setOpen] = useState(false);
			const rootRef = useRef(null);
			const current = items.find((item) => item.value === value) ?? items[0];

			useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					const root = rootRef.current;
					if (root !== null && typeof root.contains === 'function' && root.contains(event.target)) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === 'Escape') setOpen(false);
				};
				document.addEventListener('pointerdown', onPointerDown, true);
				document.addEventListener('keydown', onKeyDown, true);
				return () => {
					document.removeEventListener('pointerdown', onPointerDown, true);
					document.removeEventListener('keydown', onKeyDown, true);
				};
			}, [open]);

			return h(
				'div',
				{ ref: rootRef, style: { position: 'relative', width: width ?? '100%', minWidth: 0 } },
				h(
					'button',
					{
						type: 'button',
						className: 'dsh-todo-field dsh-todo-clickable',
						'aria-haspopup': 'listbox',
						'aria-expanded': open,
						'aria-label': ariaLabel,
						title: ariaLabel,
						onClick: () => setOpen((previous) => !previous),
						style: Object.assign({}, FIELD_FLEX, { width: '100%', justifyContent: 'space-between', cursor: 'pointer' }),
					},
					h(
						'span',
						{ style: { display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 } },
						prefix === undefined ? null : h('span', { style: { color: COLOR.label2, fontSize: 11.5, flex: 'none' } }, prefix),
						current.color === undefined
							? null
							: h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: current.color, flex: 'none' } }),
						h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, current.label),
					),
					h(IcoChevronDown, {
						size: 13,
						style: { color: COLOR.label2, flex: 'none', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 120ms ease' },
					}),
				),
				open
					? h(
							'div',
							{
								className: 'dsh-todo-menu',
								role: 'listbox',
								'aria-label': ariaLabel,
								style: {
									position: 'absolute',
									top: 'calc(100% + 4px)',
									left: alignRight ? 'auto' : 0,
									right: alignRight ? 0 : 'auto',
									zIndex: 30,
									minWidth: 152,
									padding: 4,
									borderRadius: 10,
									border: `0.5px solid ${COLOR.border}`,
									background: COLOR.overlay,
									boxShadow: '0 14px 34px rgba(0, 0, 0, 0.22), 0 2px 8px rgba(0, 0, 0, 0.1)',
									maxHeight: 236,
									overflowY: 'auto',
								},
							},
							items.map((item) =>
								h(
									'button',
									{
										key: String(item.value),
										type: 'button',
										role: 'option',
										'aria-selected': item.value === value,
										className: 'dsh-todo-option',
										onClick: () => {
											onChange(item.value);
											setOpen(false);
										},
										style: {
											display: 'flex',
											alignItems: 'center',
											justifyContent: 'space-between',
											gap: 8,
											width: '100%',
											height: 30,
											padding: '0 8px',
											border: 'none',
											borderRadius: 7,
											background: 'transparent',
											color: COLOR.label,
											fontFamily: FONT,
											fontSize: 12,
											cursor: 'pointer',
											textAlign: 'left',
										},
									},
									h(
										'span',
										{ style: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 } },
										item.color === undefined
											? null
											: h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: item.color, flex: 'none' } }),
										h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.label),
									),
									item.value === value ? h(IcoCheck, { size: 13, style: { color: COLOR.accent, flex: 'none' } }) : null,
								),
							),
						)
					: null,
			);
		}

		function AddBar({ t, onAdd }) {
			const [title, setTitle] = useState('');
			const [date, setDate] = useState(() => todayKey());
			const [time, setTime] = useState('');
			const [repeat, setRepeat] = useState('none');
			const [priority, setPriority] = useState(null);
			const inputRef = useRef(null);

			// The card stays mounted across midnight, so roll the default date
			// forward; a date the user deliberately picked is left alone.
			useEffect(() => {
				const timer = window.setInterval(() => {
					const current = todayKey();
					setDate((previous) => (previous < current ? current : previous));
				}, TICK_MS);
				return () => window.clearInterval(timer);
			}, []);

			const repeatItems = useMemo(
				() => REPEATS.map((value) => ({ value, label: repeatLabel(t, value) })),
				[t],
			);
			const priorityItems = useMemo(
				() => [
					{ value: null, label: t('priority.none') },
					{ value: 'p0', label: 'P0', color: PRIORITY_COLOR.p0 },
					{ value: 'p1', label: 'P1', color: PRIORITY_COLOR.p1 },
					{ value: 'p2', label: 'P2', color: PRIORITY_COLOR.p2 },
				],
				[t],
			);

			const submit = useCallback(() => {
				if (title.trim() === '') return;
				onAdd({ title, date, time, repeat, priority });
				// Every new todo starts from a clean form: today, no time, no repeat, no priority.
				setTitle('');
				setDate(todayKey());
				setTime('');
				setRepeat('none');
				setPriority(null);
				const element = inputRef.current;
				if (element !== null) element.focus();
			}, [title, date, time, repeat, priority, onAdd]);

			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 7, padding: '0 12px 10px' } },
				h(
					'div',
					{ style: { display: 'flex', alignItems: 'center', gap: 7 } },
					h('input', {
						ref: inputRef,
						type: 'text',
						value: title,
						placeholder: t('add.placeholder'),
						'aria-label': t('add.placeholder'),
						maxLength: MAX_TITLE,
						className: 'dsh-todo-field dsh-todo-input',
						onChange: (event) => setTitle(event.target.value),
						onKeyDown: (event) => {
							if (event.key !== 'Enter') return;
							const native = event.nativeEvent;
							if (native !== undefined && native !== null && (native.isComposing === true || native.keyCode === 229)) return;
							event.preventDefault();
							submit();
						},
						style: Object.assign({}, FIELD_INPUT, { flex: 1, height: 32, padding: '0 10px', borderRadius: 9, fontSize: 13 }),
					}),
					h(
						'button',
						{
							type: 'button',
							title: t('add.action'),
							'aria-label': t('add.action'),
							onClick: submit,
							disabled: title.trim() === '',
							style: {
								display: 'inline-flex',
								alignItems: 'center',
								justifyContent: 'center',
								width: 32,
								height: 32,
								padding: 0,
								border: 'none',
								borderRadius: 9,
								background: title.trim() === '' ? COLOR.layer2 : COLOR.accent,
								color: title.trim() === '' ? COLOR.label2 : '#ffffff',
								cursor: title.trim() === '' ? 'default' : 'pointer',
								opacity: title.trim() === '' ? 0.6 : 1,
								flex: 'none',
								transition: 'background 120ms ease, opacity 120ms ease',
							},
						},
						h(IcoPlus, { size: 15, style: { strokeWidth: 2.2 } }),
					),
				),
				h(
					'div',
					{ style: { display: 'flex', alignItems: 'center', gap: 7 } },
					h('input', {
						type: 'date',
						value: date,
						'aria-label': t('add.date'),
						title: t('add.date'),
						className: 'dsh-todo-field',
						onChange: (event) => setDate(event.target.value === '' ? todayKey() : event.target.value),
						style: Object.assign({}, FIELD_INPUT, { flex: '1 1 150px' }),
					}),
					h('input', {
						type: 'time',
						value: time,
						'aria-label': t('add.time'),
						title: t('add.time'),
						className: 'dsh-todo-field',
						onChange: (event) => setTime(normalizeTime(event.target.value)),
						style: Object.assign({}, FIELD_INPUT, { flex: '0 0 96px' }),
					}),
				),
				h(
					'div',
					{ style: { display: 'flex', alignItems: 'center', gap: 7 } },
					h(Picker, { ariaLabel: t('add.repeat'), prefix: t('add.repeatLabel'), value: repeat, items: repeatItems, onChange: setRepeat }),
					h(Picker, {
						ariaLabel: t('priority.label'),
						value: priority,
						items: priorityItems,
						onChange: setPriority,
						width: 118,
						alignRight: true,
					}),
				),
			);
		}

		function EmptyState({ t, dayKey, today }) {
			const isToday = dayKey === today;
			return h(
				'div',
				{
					style: {
						display: 'flex',
						flexDirection: 'column',
						alignItems: 'center',
						gap: 6,
						padding: '26px 16px 30px',
						color: COLOR.label2,
						textAlign: 'center',
					},
				},
				h(
					'div',
					{
						style: {
							display: 'inline-flex',
							alignItems: 'center',
							justifyContent: 'center',
							width: 42,
							height: 42,
							borderRadius: 13,
							background: COLOR.layer2,
							color: COLOR.label2,
							marginBottom: 2,
						},
					},
					h(IcoPanel, { size: 22 }),
				),
				h('div', { style: { fontSize: 12.5, color: COLOR.label2 } }, isToday ? t('empty.titleToday') : t('empty.titleDay')),
			);
		}

		function SummaryChip({ label, color, background, onClick }) {
			return h(
				'button',
				{
					type: 'button',
					className: 'dsh-todo-chip',
					'data-todo-nodrag': '1',
					onClick,
					onMouseDown: (event) => event.preventDefault(),
					style: {
						display: 'inline-flex',
						alignItems: 'center',
						height: 18,
						padding: '0 6px',
						border: 'none',
						borderRadius: 7,
						background,
						color,
						fontFamily: FONT,
						fontSize: 10.5,
						fontWeight: 600,
						cursor: 'pointer',
						flex: 'none',
						transition: 'filter 120ms ease',
					},
				},
				label,
			);
		}

		function ReminderAlertCard({ t, alert, todo, onDone, onSnooze, onClose }) {
			const time = todo !== undefined ? todo.time : alert.time;
			const priority = todo !== undefined ? todo.priority : null;
			const meta = [time === '' ? '' : time, priority === null ? '' : priorityLabel(t, priority)]
				.filter((part) => part !== '')
				.join(' · ');
			const secondaryButton = {
				height: 30,
				padding: '0 11px',
				border: `0.5px solid ${COLOR.border2}`,
				borderRadius: 9,
				background: 'transparent',
				color: COLOR.label,
				fontFamily: FONT,
				fontSize: 12,
				cursor: 'pointer',
			};
			return h(
				'div',
				{
					className: 'dsh-todo-alert',
					role: 'alertdialog',
					'aria-label': t('alert.title'),
					style: {
						display: 'flex',
						flexDirection: 'column',
						gap: 12,
						width: 360,
						maxWidth: 'calc(100vw - 24px)',
						padding: '14px 14px 12px',
						borderRadius: 18,
						border: `0.5px solid ${COLOR.border}`,
						background: COLOR.overlay,
						boxShadow: '0 26px 64px rgba(0, 0, 0, 0.36), 0 4px 14px rgba(0, 0, 0, 0.18)',
						backdropFilter: 'blur(28px) saturate(180%)',
						WebkitBackdropFilter: 'blur(28px) saturate(180%)',
						pointerEvents: 'auto',
					},
				},
				h(
					'div',
					{ style: { display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 } },
					h(
						'div',
						{
							className: 'dsh-todo-alert-icon',
							style: {
								display: 'inline-flex',
								alignItems: 'center',
								justifyContent: 'center',
								width: 36,
								height: 36,
								borderRadius: 12,
								background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent)',
								color: COLOR.danger,
								flex: 'none',
							},
						},
						h(IcoBell, { size: 18 }),
					),
					h(
						'div',
						{ style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 } },
						h('div', { style: { fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', color: COLOR.danger } }, t('alert.title')),
						h('div', { style: { fontSize: 15, fontWeight: 600, lineHeight: '20px', color: COLOR.label, wordBreak: 'break-word' } }, alert.title),
						meta === '' ? null : h('div', { style: { fontSize: 11.5, color: COLOR.label2 } }, meta),
					),
					h(
						'span',
						{ style: { display: 'inline-flex', flex: 'none' }, title: t('priority.label') },
						h(PriorityBadge, { t, priority }),
					),
				),
				h(
					'div',
					{ style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 } },
					h('button', {
						type: 'button',
						className: 'dsh-todo-alert-action dsh-todo-clickable',
						onClick: onClose,
						style: Object.assign({}, secondaryButton, { color: COLOR.label2 }),
					}, t('alert.close')),
					h('button', {
						type: 'button',
						className: 'dsh-todo-alert-action dsh-todo-clickable',
						onClick: onSnooze,
						style: secondaryButton,
					}, t('alert.snooze')),
					h('button', {
						type: 'button',
						className: 'dsh-todo-alert-action dsh-todo-clickable',
						onClick: onDone,
						style: {
							height: 30,
							padding: '0 14px',
							border: 'none',
							borderRadius: 9,
							background: COLOR.accent,
							color: '#ffffff',
							fontFamily: FONT,
							fontSize: 12,
							fontWeight: 600,
							cursor: 'pointer',
						},
					}, t('alert.done')),
				),
			);
		}

		/** Stacked reminders, shown above every column until they are handled. */
		function ReminderAlerts({ t, store, alertStore, actions }) {
			const alertState = useObservable(alertStore);
			const todoState = useObservable(store);
			if (alertState.alerts.length === 0) return null;
			const byId = new Map();
			for (const todo of todoState.todos) byId.set(todo.id, todo);
			const visible = alertState.alerts.slice(0, 3);
			const hidden = alertState.alerts.length - visible.length;
			return h(
				'div',
				{
					style: {
						position: 'fixed',
						left: 0,
						right: 0,
						top: 18,
						display: 'flex',
						flexDirection: 'column',
						alignItems: 'center',
						gap: 10,
						zIndex: 3,
						pointerEvents: 'none',
					},
				},
				visible.map((alert) =>
					h(ReminderAlertCard, {
						key: alert.id,
						t,
						alert,
						todo: byId.get(alert.todoId),
						onDone: () => actions.completeAlert(alert.id),
						onSnooze: () => actions.snoozeAlert(alert.id),
						onClose: () => actions.dismissAlert(alert.id),
					}),
				),
				hidden > 0
					? h(
							'div',
							{
								style: {
									pointerEvents: 'auto',
									padding: '3px 10px',
									borderRadius: 8,
									background: COLOR.overlay,
									border: `0.5px solid ${COLOR.border}`,
									color: COLOR.label2,
									fontFamily: FONT,
									fontSize: 11,
									boxShadow: shadow,
								},
							},
							t('alert.more', { n: hidden }),
						)
					: null,
			);
		}

		function TodoCard({ t, store, settingsStore, themeObservable, actions }) {
			const state = useObservable(store);
			const settings = useObservable(settingsStore);
			const theme = useObservable(themeObservable);
			const [view, setView] = useState(() => clampView(normalizeView(loadJson(VIEW_KEY))));
			const [dragging, setDragging] = useState(null);
			const [selectedDay, setSelectedDay] = useState(() => todayKey());
			const [showDone, setShowDone] = useState(true);
			const [notice, setNotice] = useState(null);
			const viewRef = useRef(view);
			const dragRef = useRef(null);
			const noticeTimer = useRef(null);
			const dayRef = useRef(selectedDay);

			const todos = state.todos;
			const history = state.history;
			const now = state.now;
			const today = dateKeyOf(new Date(now));

			useEffect(() => {
				viewRef.current = view;
			}, [view]);

			useEffect(() => {
				dayRef.current = selectedDay;
			}, [selectedDay]);

			// When midnight passes, a view that followed "today" follows it again.
			const todayRef = useRef(today);
			useEffect(() => {
				if (todayRef.current === today) return;
				const previous = todayRef.current;
				todayRef.current = today;
				setSelectedDay((current) => (current === previous ? today : current));
			}, [today]);

			useEffect(() => () => {
				if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
			}, []);

			const flash = useCallback((text) => {
				if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
				setNotice(text);
				noticeTimer.current = window.setTimeout(() => {
					noticeTimer.current = null;
					setNotice(null);
				}, 2600);
			}, []);

			const persistView = useCallback((next) => {
				saveJson(VIEW_KEY, { x: next.x, y: next.y, collapsed: next.collapsed, pillX: next.pillX, pillY: next.pillY });
			}, []);

			const collapseTo = useCallback(
				() => {
					const current = viewRef.current;
					const next = clampView({
						...current,
						collapsed: true,
						pillX: current.x + PANEL_WIDTH / 2,
						pillY: current.y,
					});
					viewRef.current = next;
					setView(next);
					persistView(next);
				},
				[persistView],
			);

			const expandFrom = useCallback(
				() => {
					const pill = viewRef.current;
					const next = clampView({
						...pill,
						collapsed: false,
						x: pill.pillX - PANEL_WIDTH / 2,
						y: pill.pillY,
					});
					viewRef.current = next;
					setView(next);
					persistView(next);
				},
				[persistView],
			);

			const resetPosition = useCallback(() => {
				const next = clampView({ ...defaultView(), collapsed: viewRef.current.collapsed });
				viewRef.current = next;
				setView(next);
				persistView(next);
			}, [persistView]);

			// Keep everything on screen when the window shrinks.
			useEffect(() => {
				const onResize = () => {
					const next = clampView(viewRef.current);
					if (next.x === viewRef.current.x && next.y === viewRef.current.y && next.pillX === viewRef.current.pillX && next.pillY === viewRef.current.pillY) return;
					viewRef.current = next;
					setView(next);
					persistView(next);
				};
				window.addEventListener('resize', onResize);
				return () => window.removeEventListener('resize', onResize);
			}, [persistView]);

			const beginDrag = useCallback((event, kind) => {
				if (event.pointerType === 'mouse' && event.button !== 0) return;
				const target = event.target;
				if (target !== null && typeof target.closest === 'function' && target.closest('[data-todo-nodrag]') !== null) return;
				dragRef.current = {
					kind,
					pointerId: event.pointerId,
					startX: event.clientX,
					startY: event.clientY,
					originX: kind === 'card' ? viewRef.current.x : viewRef.current.pillX,
					originY: kind === 'card' ? viewRef.current.y : viewRef.current.pillY,
					moved: false,
				};
				try {
					event.currentTarget.setPointerCapture(event.pointerId);
				} catch (error) {
					// Pointer capture is best-effort.
				}
				setDragging(kind);
			}, []);

			const onPointerMove = useCallback((event) => {
				const drag = dragRef.current;
				if (drag === null || drag.pointerId !== event.pointerId) return;
				const dx = event.clientX - drag.startX;
				const dy = event.clientY - drag.startY;
				if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
				if (!drag.moved) return;
				event.preventDefault();
				if (drag.kind === 'card') {
					const next = clampCard({ ...viewRef.current, x: drag.originX + dx, y: drag.originY + dy });
					viewRef.current = next;
					setView(next);
				} else {
					const next = clampPill({ ...viewRef.current, pillX: drag.originX + dx, pillY: drag.originY + dy });
					viewRef.current = next;
					setView(next);
				}
			}, []);

			const onPointerUp = useCallback((event) => {
				const drag = dragRef.current;
				if (drag === null) return;
				dragRef.current = null;
				setDragging(null);
				try {
					event.currentTarget.releasePointerCapture(event.pointerId);
				} catch (error) {
					// Released already.
				}
				if (drag.moved) {
					persistView(viewRef.current);
					return;
				}
				if (drag.kind === 'pill') expandFrom();
			}, [expandFrom, persistView]);

			const dayData = useMemo(() => dayView(todos, history, selectedDay), [todos, history, selectedDay]);
			const summary = useMemo(() => summarize(todos, today), [todos, today]);
			const openCount = dayData.active.length;
			const doneCount = dayData.doneEntries.length;
			const missedCount = dayData.missed.length;
			const isToday = selectedDay === today;
			const relative = relativeDayLabel(t, selectedDay, today);

			const colorScheme = theme !== null && theme !== undefined && theme.active !== undefined ? theme.active.colorScheme : undefined;
			const notifyOn = settings.notify;
			const permissionDenied =
				typeof Notification !== 'undefined' && Notification.permission === 'denied';

			const warnedRef = useRef(false);
			const warnPermission = useCallback(
				(status) => {
					if (status === 'granted' || warnedRef.current) return;
					warnedRef.current = true;
					flash(t('notify.blocked'));
				},
				[flash, t],
			);
			const onAdd = useCallback(
				(input) => {
					const created = store.add(input);
					if (created === null) return;
					if (created.date !== dayRef.current) flash(t('notice.added', { date: formatDayStamp(created.date) }));
					if (viewRef.current.collapsed) expandFrom();
					if (created.time !== '') actions.requestPermission().then(warnPermission);
				},
				[actions, expandFrom, flash, store, warnPermission],
			);
			const onToggle = useCallback((id) => store.toggle(id), [store]);
			const onRemove = useCallback((id) => store.remove(id), [store]);
			const onRemoveHistory = useCallback((id) => store.removeHistory(id), [store]);
			const onToggleNotify = useCallback(() => {
				const next = !settingsStore.getSnapshot().notify;
				settingsStore.set({ notify: next });
				if (next) {
					actions.primeAudio();
					actions.requestPermission().then(warnPermission);
				}
			}, [actions, settingsStore, warnPermission]);

			const dayControlProps = { 'data-todo-nodrag': '1' };

			// Collapsed: a draggable pill at its own remembered position.
			if (view.collapsed) {
				const todayOpen = openTodayCount(todos, today);
				const todayOverdue = overdueTodayCount(todos, today);
				return h(
					'div',
					{
						className: `dsh-todo-pill${dragging === 'pill' ? ' is-dragging' : ''}`,
						role: 'button',
						tabIndex: 0,
						'aria-label': t('panel.expand'),
						title: t('panel.expand'),
						onPointerDown: (event) => {
							actions.primeAudio();
							beginDrag(event, 'pill');
						},
						onPointerMove,
						onPointerUp,
						onPointerCancel: onPointerUp,
						onKeyDown: (event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault();
								expandFrom();
							}
						},
						style: {
							position: 'fixed',
							left: view.pillX,
							top: view.pillY,
							transform: 'translateX(-50%)',
							display: 'inline-flex',
							alignItems: 'center',
							gap: 8,
							height: 40,
							padding: '0 14px 0 12px',
							borderRadius: 20,
							border: `0.5px solid ${COLOR.border}`,
							background: COLOR.overlay,
							boxShadow: shadow,
							color: COLOR.label,
							fontFamily: FONT,
							fontSize: 12.5,
							fontWeight: 500,
							pointerEvents: 'auto',
							backdropFilter: 'blur(24px) saturate(180%)',
							WebkitBackdropFilter: 'blur(24px) saturate(180%)',
							zIndex: 1,
							colorScheme: colorScheme,
						},
					},
					h('style', { key: 'style' }, CSS),
					h('span', { style: { display: 'inline-flex', color: COLOR.accent } }, h(IcoPanel, { size: 17 })),
					h('span', null, t('panel.collapsedLabel')),
					todayOpen > 0
						? h(
								'span',
								{
									style: {
										display: 'inline-flex',
										alignItems: 'center',
										justifyContent: 'center',
										minWidth: 18,
										height: 18,
										padding: '0 5px',
										borderRadius: 9,
										background: todayOverdue > 0 ? COLOR.danger : COLOR.accent,
										color: '#ffffff',
										fontSize: 10.5,
										fontWeight: 600,
										fontVariantNumeric: 'tabular-nums',
									},
								},
								todayOpen,
							)
						: null,
				);
			}

			return h(
				'div',
				{
					className: `dsh-todo-card${dragging === 'card' ? ' is-dragging' : ''}`,
					role: 'region',
					'aria-label': t('panel.title'),
					onPointerDownCapture: () => actions.primeAudio(),
					style: {
						position: 'fixed',
						left: view.x,
						top: view.y,
						display: 'flex',
						flexDirection: 'column',
						width: PANEL_WIDTH,
						maxWidth: 'calc(100vw - 20px)',
						maxHeight: 'min(72vh, 620px)',
						borderRadius: 18,
						border: `0.5px solid ${COLOR.border}`,
						background: COLOR.overlay,
						boxShadow: shadow,
						color: COLOR.label,
						fontFamily: FONT,
						pointerEvents: 'auto',
						overflow: 'visible',
						backdropFilter: 'blur(26px) saturate(180%)',
						WebkitBackdropFilter: 'blur(26px) saturate(180%)',
						zIndex: 1,
						colorScheme: colorScheme,
					},
				},
				h('style', { key: 'style' }, CSS),
				h(
					'div',
					{
						className: `dsh-todo-head${dragging === 'card' ? ' is-dragging' : ''}`,
						onPointerDown: (event) => beginDrag(event, 'card'),
						onPointerMove,
						onPointerUp,
						onPointerCancel: onPointerUp,
						onDoubleClick: resetPosition,
						onDragStart: (event) => event.preventDefault(),
						style: { display: 'flex', alignItems: 'flex-start', gap: 6, padding: '11px 10px 6px 12px', flex: 'none' },
					},
					h(
						'div',
						{ style: { display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 } },
						h(
							'div',
							{ style: { display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 } },
							h(ActionButton, { label: t('day.prev'), size: 22, onClick: () => setSelectedDay(addDaysKey(selectedDay, -1)) }, h(IcoArrowLeft, { size: 14 })),
							h(
								'div',
								Object.assign({}, dayControlProps, {
									style: { position: 'relative', display: 'inline-flex', alignItems: 'baseline', gap: 6, padding: '0 4px', minWidth: 0, cursor: 'pointer' },
									title: t('day.pick'),
								}),
								h(
									'span',
									{ style: { fontSize: 15.5, fontWeight: 600, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } },
									formatDayStamp(selectedDay),
								),
								h('span', { style: { fontSize: 11.5, color: COLOR.label2, whiteSpace: 'nowrap' } }, formatWeekday(selectedDay)),
								h('input', {
									type: 'date',
									value: selectedDay,
									'aria-label': t('day.pick'),
									onChange: (event) => {
										if (event.target.value !== '') setSelectedDay(event.target.value);
									},
									onClick: (event) => {
										try {
											event.currentTarget.showPicker();
										} catch (error) {
											// Fall back to the native focus behaviour.
										}
									},
									style: { position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer', border: 'none', padding: 0 },
								}),
							),
							h(ActionButton, { label: t('day.next'), size: 22, onClick: () => setSelectedDay(addDaysKey(selectedDay, 1)) }, h(IcoArrowRight, { size: 14 })),
						),
						h(
							'div',
							{ style: { display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', paddingLeft: 24, minHeight: 18 } },
							h('span', { style: { fontSize: 11, color: COLOR.label2 } }, relative),
							h('span', { style: { fontSize: 11, color: COLOR.label2, opacity: 0.6 } }, '·'),
							h('span', { style: { fontSize: 11, color: COLOR.label2 } }, t('summary.open', { n: openCount })),
							!isToday
								? h(SummaryChip, {
										label: t('day.today'),
										color: COLOR.accent,
										background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent)',
										onClick: () => setSelectedDay(today),
									})
								: null,
							summary.overdue > 0 && summary.overdueDate !== null
								? h(SummaryChip, {
										label: t('summary.overdue', { n: summary.overdue }),
										color: COLOR.danger,
										background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent)',
										onClick: () => setSelectedDay(summary.overdueDate),
									})
								: null,
							summary.future > 0 && summary.futureDate !== null
								? h(SummaryChip, {
										label: t('summary.future', { n: summary.future }),
										color: COLOR.accent,
										background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent)',
										onClick: () => setSelectedDay(summary.futureDate),
									})
								: null,
						),
					),
					h(
						'div',
						Object.assign({}, dayControlProps, { style: { display: 'flex', alignItems: 'center', gap: 2, flex: 'none' } }),
						h(ActionButton, {
							label: notifyOn ? t('notify.on') : t('notify.off'),
							onClick: onToggleNotify,
							style: notifyOn ? { color: permissionDenied ? COLOR.danger : COLOR.accent } : undefined,
						}, notifyOn ? h(IcoBell, { size: 15 }) : h(IcoBellOff, { size: 15 })),
						h(ActionButton, { label: t('panel.resetPosition'), onClick: resetPosition }, h(IcoTarget, { size: 14 })),
						h(ActionButton, { label: t('panel.collapse'), onClick: collapseTo }, h(IcoChevron, { open: true, size: 15 })),
					),
				),
				h(AddBar, { t, onAdd }),
				notice !== null
					? h(
							'div',
							{
								style: {
									display: 'flex',
									alignItems: 'center',
									gap: 6,
									margin: '0 12px 6px',
									padding: '5px 8px',
									borderRadius: 8,
									background: COLOR.layer2,
									color: COLOR.label2,
									fontSize: 11,
									flex: 'none',
								},
							},
							notice,
						)
					: null,
				h(
					'div',
					{ className: 'dsh-todo-scroll', style: { overflowY: 'auto', overflowX: 'hidden', padding: '0 6px 6px', flex: '1 1 auto', minHeight: 0 } },
					openCount === 0 && doneCount === 0 && missedCount === 0 ? h(EmptyState, { t, dayKey: selectedDay, today }) : null,
					dayData.active.map((todo) => h(TodoRow, { key: todo.id, todo, t, now, today, onToggle, onRemove })),
					doneCount > 0
						? h(
								'div',
								{ style: { marginTop: 4, paddingBottom: 4 } },
								h(
									'div',
									{ style: { display: 'flex', alignItems: 'center', gap: 4, padding: '2px 2px 2px 4px' } },
									h(
										'button',
										{
											type: 'button',
											className: 'dsh-todo-clickable',
											onClick: () => setShowDone((value) => !value),
											'aria-expanded': showDone,
											title: t('done.title'),
											style: {
												display: 'inline-flex',
												alignItems: 'center',
												gap: 4,
												padding: '3px 6px',
												border: 'none',
												borderRadius: 7,
												background: 'transparent',
												color: COLOR.label2,
												fontFamily: FONT,
												fontSize: 11,
												fontWeight: 600,
												cursor: 'pointer',
											},
										},
										h(IcoChevron, { open: showDone, size: 12 }),
										h('span', null, `${t('done.title')} ${doneCount}`),
									),
									h('div', { style: { flex: 1 } }),
									h(
										'button',
										{
											type: 'button',
											className: 'dsh-todo-clickable',
											onClick: () => store.clearDone(),
											title: t('done.clear'),
											style: {
												padding: '2px 6px',
												border: 'none',
												borderRadius: 6,
												background: 'transparent',
												color: COLOR.label2,
												fontFamily: FONT,
												fontSize: 11,
												cursor: 'pointer',
											},
										},
										t('done.clear'),
									),
								),
								showDone
									? dayData.doneEntries.map((entry) =>
											entry.kind === 'todo'
												? h(TodoRow, { key: entry.todo.id, todo: entry.todo, t, now, today, onToggle, onRemove })
												: h(HistoryRow, { key: entry.history.id, entry: entry.history, t, today, onRemove: onRemoveHistory }),
										)
									: null,
							)
						: null,
					missedCount > 0
						? h(
								'div',
								{ style: { marginTop: 4, paddingBottom: 4 } },
								h(
									'div',
									{ style: { padding: '2px 2px 2px 8px', fontSize: 11, fontWeight: 600, color: COLOR.label2 } },
									`${t('done.missedTitle')} ${missedCount}`,
								),
								dayData.missed.map((entry) => h(HistoryRow, { key: entry.id, entry, t, today, onRemove: onRemoveHistory })),
							)
						: null,
				),
			);
		}

		function openTodayCount(todos, today) {
			let count = 0;
			for (const todo of todos) {
				if (!todo.done && todo.date === today) count += 1;
			}
			return count;
		}

		function overdueTodayCount(todos, today) {
			let count = 0;
			for (const todo of todos) {
				if (!todo.done && todo.date <= today && instantOf(todo.date, todo.time) !== null && instantOf(todo.date, todo.time) < Date.now()) count += 1;
			}
			return count;
		}
		// #endregion

		// #region dictionaries
		const ZH = {
			'panel.title': '待办事项',
			'panel.collapsedLabel': '待办',
			'panel.expand': '展开待办事项（可拖动）',
			'panel.collapse': '收起',
			'panel.resetPosition': '回到默认位置',
			'day.prev': '前一天',
			'day.next': '后一天',
			'day.pick': '选择日期',
			'day.today': '回到今天',
			'summary.open': '{n} 项待完成',
			'summary.overdue': '逾期 {n}',
			'summary.future': '未来 {n}',
			'add.placeholder': '添加待办事项…',
			'add.action': '添加',
			'add.date': '日期',
			'add.time': '时间',
			'add.repeat': '重复',
			'add.repeatLabel': '重复',
			'priority.label': '优先级',
			'priority.none': '无',
			'priority.p0': 'P0',
			'priority.p1': 'P1',
			'priority.p2': 'P2',
			'repeat.none': '不重复',
			'repeat.workdays': '工作日',
			'repeat.weekends': '周末',
			'repeat.daily': '每天',
			'repeat.weekly': '每周',
			'repeat.monthly': '每月',
			'repeat.yearly': '每年',
			'when.today': '今天',
			'when.tomorrow': '明天',
			'when.yesterday': '昨天',
			'when.dayAfterTomorrow': '后天',
			'history.done': '已完成',
			'history.missed': '未完成',
			'row.next': '下次：{when}',
			'row.markDone': '标记为完成',
			'row.markOpen': '标记为未完成',
			'row.delete': '删除',
			'done.title': '已完成',
			'done.missedTitle': '未完成',
			'done.clear': '清除',
			'empty.titleToday': '今天没有待办事项',
			'empty.titleDay': '这一天没有待办事项',
			'notice.added': '已添加到 {date}',
			'notify.on': '提醒已开启（点击关闭）',
			'notify.off': '提醒已关闭（点击开启）',
			'notify.title': '待办提醒',
			'notify.body': '{title} · {when}',
			'notify.blocked': '系统通知未授权，到点时会用页内提醒和提示音',
			'alert.title': '待办提醒',
			'alert.done': '完成',
			'alert.snooze': '稍后 10 分钟',
			'alert.close': '知道了',
			'alert.more': '还有 {n} 项到点',
		};

		const EN = {
			'panel.title': 'To-dos',
			'panel.collapsedLabel': 'To-dos',
			'panel.expand': 'Expand to-dos (draggable)',
			'panel.collapse': 'Collapse',
			'panel.resetPosition': 'Reset position',
			'day.prev': 'Previous day',
			'day.next': 'Next day',
			'day.pick': 'Pick a date',
			'day.today': 'Back to today',
			'summary.open': '{n} open',
			'summary.overdue': '{n} overdue',
			'summary.future': '{n} upcoming',
			'add.placeholder': 'Add a to-do…',
			'add.action': 'Add',
			'add.date': 'Due date',
			'add.time': 'Due time',
			'add.repeat': 'Repeat',
			'add.repeatLabel': 'Repeat',
			'priority.label': 'Priority',
			'priority.none': 'None',
			'priority.p0': 'P0',
			'priority.p1': 'P1',
			'priority.p2': 'P2',
			'repeat.none': 'Never',
			'repeat.workdays': 'Workdays',
			'repeat.weekends': 'Weekends',
			'repeat.daily': 'Daily',
			'repeat.weekly': 'Weekly',
			'repeat.monthly': 'Monthly',
			'repeat.yearly': 'Yearly',
			'when.today': 'Today',
			'when.tomorrow': 'Tomorrow',
			'when.yesterday': 'Yesterday',
			'when.dayAfterTomorrow': 'In two days',
			'history.done': 'Completed',
			'history.missed': 'Missed',
			'row.next': 'Next: {when}',
			'row.markDone': 'Mark as done',
			'row.markOpen': 'Mark as not done',
			'row.delete': 'Delete',
			'done.title': 'Completed',
			'done.missedTitle': 'Missed',
			'done.clear': 'Clear',
			'empty.titleToday': 'Nothing for today',
			'empty.titleDay': 'Nothing for this day',
			'notice.added': 'Added to {date}',
			'notify.on': 'Reminders on (click to mute)',
			'notify.off': 'Reminders off (click to enable)',
			'notify.title': 'To-do reminder',
			'notify.body': '{title} · {when}',
			'notify.blocked': 'System notifications are not allowed; reminders will stay in the panel and play a chime.',
			'alert.title': 'To-do reminder',
			'alert.done': 'Done',
			'alert.snooze': 'Snooze 10 min',
			'alert.close': 'Dismiss',
			'alert.more': '{n} more due',
		};
		// #endregion

		return {
			inject: ['slots', 'locale', 'theme'],
			apply(ctx) {
				const t = ctx.locale.bind(NS);
				const store = createTodoStore();
				const settingsStore = createSettingsStore();
				const alertStore = createAlertStore();
				const chime = createChime();
				const themeObservable = createObservable(ctx.theme.getTheme());
				const snoozeTimers = new Set();

				/** Best-effort OS notification permission; resolves to the state. */
				function requestPermission() {
					try {
						if (typeof Notification === 'undefined') return Promise.resolve('unsupported');
						if (Notification.permission === 'granted') {
							chime.unlock();
							return Promise.resolve('granted');
						}
						if (Notification.permission === 'denied') return Promise.resolve('denied');
						const result = Notification.requestPermission();
						if (result === undefined || typeof result.then !== 'function') return Promise.resolve(Notification.permission);
						return result.then((value) => value).catch(() => 'denied');
					} catch (error) {
						return Promise.resolve('unsupported');
					}
				}

				/** Dock / taskbar badge where the WebView supports app badges. */
				function updateAppBadge(count) {
					try {
						if (typeof navigator === 'undefined') return;
						if (count > 0 && typeof navigator.setAppBadge === 'function') navigator.setAppBadge(count);
						else if (count === 0 && typeof navigator.clearAppBadge === 'function') navigator.clearAppBadge();
					} catch (error) {
						// Optional surface.
					}
				}

				function setAlerts(next) {
					alertStore.set({ alerts: next });
					updateAppBadge(next.length);
				}

				function showAlerts(items) {
					const current = alertStore.getSnapshot().alerts;
					const known = new Set(current.map((alert) => alert.todoId));
					const next = current.slice();
					let seq = 0;
					for (const item of items) {
						if (known.has(item.id)) continue;
						known.add(item.id);
						next.push({
							id: `alert-${item.id}-${Date.now().toString(36)}-${seq}`,
							todoId: item.id,
							title: item.title,
							time: item.time,
							at: Date.now(),
						});
						seq += 1;
					}
					if (next.length !== current.length) setAlerts(next);
				}

				function pruneAlerts() {
					const current = alertStore.getSnapshot().alerts;
					if (current.length === 0) return;
					const open = new Set(store.getSnapshot().todos.filter((todo) => !todo.done).map((todo) => todo.id));
					const next = current.filter((alert) => open.has(alert.todoId));
					if (next.length !== current.length) setAlerts(next);
				}

				function dismissAlert(alertId) {
					setAlerts(alertStore.getSnapshot().alerts.filter((alert) => alert.id !== alertId));
				}

				function completeAlert(alertId) {
					const alert = alertStore.getSnapshot().alerts.find((item) => item.id === alertId);
					if (alert === undefined) return;
					const todo = store.getSnapshot().todos.find((item) => item.id === alert.todoId);
					if (todo !== undefined && !todo.done) store.toggle(todo.id);
					dismissAlert(alertId);
				}

				function snoozeAlert(alertId) {
					const alert = alertStore.getSnapshot().alerts.find((item) => item.id === alertId);
					if (alert === undefined) return;
					dismissAlert(alertId);
					const timer = window.setTimeout(() => {
						snoozeTimers.delete(timer);
						const todo = store.getSnapshot().todos.find((item) => item.id === alert.todoId);
						if (todo === undefined || todo.done) return;
						showAlerts([{ id: todo.id, title: todo.title, time: todo.time }]);
						if (settingsStore.getSnapshot().notify) chime.play();
					}, SNOOZE_MS);
					snoozeTimers.add(timer);
				}

				function flushReminders() {
					const snapshot = store.getSnapshot();
					const due = collectDue(snapshot.todos, Date.now());
					if (due.length === 0) return;
					const settings = settingsStore.getSnapshot();
					const fresh = due.filter((entry) => !entry.stale);
					if (settings.notify && fresh.length > 0) {
						chime.play();
						showAlerts(fresh);
						for (const entry of fresh.slice(0, 3)) {
							sendDesktopNotification(
								t('notify.title'),
								t('notify.body', { title: entry.title, when: entry.time }),
								`dsh-todo-${entry.id}`,
							);
						}
					}
					store.markNotified(due.map((entry) => ({ id: entry.id, key: entry.key })));
				}

				ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'todo-list: dictionaries');
				ctx.effect(() => ctx.locale.subscribe(() => store.refresh()), 'todo-list: locale changes');
				ctx.effect(() => ctx.on('theme/change', (snapshot) => themeObservable.set(snapshot)), 'todo-list: theme changes');
				ctx.effect(() => {
					const timer = window.setInterval(() => {
						store.tick();
						flushReminders();
						pruneAlerts();
					}, TICK_MS);
					return () => window.clearInterval(timer);
				}, 'todo-list: clock');
				ctx.effect(() => () => chime.dispose(), 'todo-list: audio');
				ctx.effect(() => () => {
					for (const timer of snoozeTimers) window.clearTimeout(timer);
					snoozeTimers.clear();
					updateAppBadge(0);
				}, 'todo-list: alert timers');

				store.tick();
				flushReminders();
				pruneAlerts();

				const cardActions = { requestPermission, primeAudio: () => chime.unlock() };
				const alertActions = { completeAlert, snoozeAlert, dismissAlert };
				const cardEntry = (props) => h(TodoCard, {
					t: typeof props.t === 'function' ? props.t : t,
					store,
					settingsStore,
					themeObservable,
					actions: cardActions,
				});
				const alertEntry = (props) => h(ReminderAlerts, {
					t: typeof props.t === 'function' ? props.t : t,
					store,
					alertStore,
					actions: alertActions,
				});

				ctx.slots.inject('shell.overlay', () => ctx.slots.register({
					name: 'shell.overlay',
					id: 'todo-list-floating-panel',
					order: 6,
					locale: NS,
				}, cardEntry));
				ctx.slots.inject('shell.overlay', () => ctx.slots.register({
					name: 'shell.overlay',
					id: 'todo-list-reminder-alert',
					order: 7,
					locale: NS,
				}, alertEntry));
			},
		};
	},
});
