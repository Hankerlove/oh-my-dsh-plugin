window.__ModuleLoader__.load({
	id: '@ultraslow/dsh-boot-skin',
	/**
	 * Client half of the boot video + wallpaper bundle.
	 *
	 * Two visual layers, both mounted as plain DOM children of `document.body`
	 * rather than through a slot:
	 *
	 *  - the boot film, a full-viewport `<video>` created as early as this entry
	 *    activates, so it covers the frame while the shell is still assembling;
	 *  - the wallpaper, a `z-index: -1` fixed layer behind every surface, which
	 *    only becomes visible because the same bundle repoints a handful of
	 *    `--dsw-alias-*` surface tokens at translucent colours through the
	 *    official `ctx.theme.overrideTokens` API.
	 *
	 * Plain DOM on purpose: `shell.overlay` sits inside the frame's stacking
	 * context, where an ancestor `transform`/`filter`/`contain` traps any
	 * `z-index` we set, and slot entries mount only after every client entry has
	 * activated — too late for a film that must cover the first frame. Both
	 * layers are registered with `ctx.effect`, so disabling the plugin removes
	 * them completely.
	 *
	 * Every failure mode here degrades to "nothing shows up". A cosmetic layer
	 * must never be able to cost the user their shell.
	 */
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		const { useCallback, useEffect, useRef, useState } = React;

		// #region constants
		const NS = 'boot-skin';
		/** Bumped on every behaviour change: the settings page prints it so a stale bundle is obvious. */
		const DIAG_BUILD = '2026-11-10 16:36';
		const API = '/boot-skin';
		/** Marks "the film already played in this page session" (a launch = a page load). */
		const PLAYED_KEY = 'dsh.boot-skin.played.v1';
		/** Upper bound for a config round-trip before the feature gives up silently. */
		const REQUEST_TIMEOUT_MS = 8000;
		const Z_FILM = '2147483000';
		const Z_WALLPAPER = '-1';

		const ZH = {
			'meta.title': '开屏与壁纸',
			'film.skipHint': '点击或按 Esc 跳过',
			'settings.loading': '正在读取配置…',
			'settings.loadFailed': '读不到插件配置',
			'settings.retry': '重试',
			'settings.intro': '开屏视频与壁纸共用同一份媒体库。视频建议 5–10 秒、H.264 编码的 mp4；壁纸支持图片或静音循环视频。上传后立即生效，无需重启。',
			'common.uploading': '上传中…',
			'common.remove': '移除',
			'boot.title': '开屏视频',
			'boot.description': '启动或刷新页面时全屏播放一次。',
			'boot.enabled': '启用开屏视频',
			'boot.enabledHint': '关闭后完全不影响启动速度',
			'boot.file': '视频文件',
			'boot.noFile': '还没有上传视频',
			'boot.pick': '选择本地视频',
			'boot.opacity': '视频不透明度',
			'boot.fadeIn': '渐入时长',
			'boot.fadeInHint': '从黑场过渡到画面的时间',
			'boot.fadeOut': '渐隐时长',
			'boot.fadeOutHint': '播完后淡出、交还主界面',
			'boot.maxMs': '最长时长',
			'boot.maxMsHint': '超时强制进入主界面，防止卡在开屏',
			'boot.muted': '静音播放',
			'boot.mutedHint': '浏览器通常禁止自动播放带声音的视频',
			'boot.skip': '允许跳过',
			'boot.skipHint': '点击画面或按 Esc 跳过',
			'boot.once': '每次启动只播一次',
			'boot.onceHint': '关闭后每次刷新页面都会播放',
			'boot.preview': '预览开屏',
			'wallpaper.title': '壁纸',
			'wallpaper.description': '铺在整个界面下方的一层背景。',
			'wallpaper.enabled': '启用壁纸',
			'wallpaper.enabledHint': '会把界面表面调成半透明以便透出壁纸',
			'wallpaper.file': '壁纸文件',
			'wallpaper.noFile': '还没有上传壁纸',
			'wallpaper.pick': '选择图片或视频',
			'wallpaper.opacity': '壁纸不透明度',
			'wallpaper.blur': '模糊',
			'wallpaper.blurHint': '数值越大越柔和',
			'wallpaper.dim': '暗化',
			'wallpaper.dimHint': '压暗壁纸以提升文字可读性',
			'wallpaper.fit': '填充方式',
			'wallpaper.fitHint': 'cover 铺满裁切，contain 完整显示',
			'wallpaper.fitCover': '铺满（cover）',
			'wallpaper.fitContain': '完整（contain）',
			'wallpaper.fitFill': '拉伸（fill）',
			'wallpaper.videoMode': '播放方式',
			'wallpaper.videoModeHint': '仅对视频壁纸生效',
			'wallpaper.modeLoop': '循环播放',
			'wallpaper.modeOnce': '播放一次（进入 / 切换会话时重播）',
			'wallpaper.surfaceAlpha': '界面不透明度',
			'wallpaper.surfaceAlphaHint': '越低壁纸越明显，但文字越难读（建议 75–90）',
			'wallpaper.diagCanvas': '画布 token 实际值',
			'wallpaper.diagLayer': '壁纸层',
		};
		const EN = {
			'meta.title': 'Boot & Wallpaper',
			'film.skipHint': 'Click or press Esc to skip',
			'settings.loading': 'Loading configuration…',
			'settings.loadFailed': 'Could not read the plugin configuration',
			'settings.retry': 'Retry',
			'settings.intro': 'The boot film and the wallpaper share one media library. A 5–10s H.264 mp4 works best for the film; the wallpaper accepts an image or a muted looping video. Changes apply immediately, no restart needed.',
			'common.uploading': 'Uploading…',
			'common.remove': 'Remove',
			'boot.title': 'Boot film',
			'boot.description': 'Plays full-screen once when DSH launches or the page reloads.',
			'boot.enabled': 'Enable the boot film',
			'boot.enabledHint': 'Off costs nothing at startup',
			'boot.file': 'Video file',
			'boot.noFile': 'No video uploaded yet',
			'boot.pick': 'Choose a local video',
			'boot.opacity': 'Video opacity',
			'boot.fadeIn': 'Fade in',
			'boot.fadeInHint': 'How long the transition from black takes',
			'boot.fadeOut': 'Fade out',
			'boot.fadeOutHint': 'Fades out to hand the viewport back',
			'boot.maxMs': 'Maximum duration',
			'boot.maxMsHint': 'Forces the app in when the film runs long',
			'boot.muted': 'Play muted',
			'boot.mutedHint': 'Browsers usually refuse autoplay with sound',
			'boot.skip': 'Allow skipping',
			'boot.skipHint': 'Click the frame or press Esc',
			'boot.once': 'Once per launch',
			'boot.onceHint': 'Off replays on every page reload',
			'boot.preview': 'Preview',
			'wallpaper.title': 'Wallpaper',
			'wallpaper.description': 'One background layer behind the whole shell.',
			'wallpaper.enabled': 'Enable the wallpaper',
			'wallpaper.enabledHint': 'Makes the shell surfaces translucent so it shows through',
			'wallpaper.file': 'Wallpaper file',
			'wallpaper.noFile': 'No wallpaper uploaded yet',
			'wallpaper.pick': 'Choose an image or video',
			'wallpaper.opacity': 'Wallpaper opacity',
			'wallpaper.blur': 'Blur',
			'wallpaper.blurHint': 'Higher is softer',
			'wallpaper.dim': 'Dim',
			'wallpaper.dimHint': 'Darkens the wallpaper for readable text',
			'wallpaper.fit': 'Fit',
			'wallpaper.fitHint': 'cover fills and crops, contain shows all of it',
			'wallpaper.fitCover': 'Cover',
			'wallpaper.fitContain': 'Contain',
			'wallpaper.fitFill': 'Fill',
			'wallpaper.videoMode': 'Playback',
			'wallpaper.videoModeHint': 'Video wallpapers only',
			'wallpaper.modeLoop': 'Loop',
			'wallpaper.modeOnce': 'Play once (replays on entry / session switch)',
			'wallpaper.surfaceAlpha': 'Surface opacity',
			'wallpaper.surfaceAlphaHint': 'Lower shows more wallpaper but hurts legibility (75–90 recommended)',
			'wallpaper.diagCanvas': 'Canvas token, live',
			'wallpaper.diagLayer': 'Wallpaper layer',
		};
		// #endregion

		// #region pure helpers
		function clampNumber(value, min, max, fallback) {
			const n = Number(value);
			if (!Number.isFinite(n)) return fallback;
			return Math.min(max, Math.max(min, n));
		}

		function formatBytes(bytes) {
			const n = Number(bytes);
			if (!Number.isFinite(n) || n <= 0) return '—';
			if (n < 1024) return `${n} B`;
			if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
			return `${(n / (1024 * 1024)).toFixed(1)} MB`;
		}

		/** `fetch` with a hard timeout; every caller treats rejection as "feature off". */
		function apiRequest(path, options) {
			const controller = typeof AbortController === 'function' ? new AbortController() : null;
			const timer = controller === null ? null : setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
			return fetch(API + path, {
				credentials: 'same-origin',
				cache: 'no-store',
				...(controller === null ? {} : { signal: controller.signal }),
				...options,
			})
				.then((response) => response.text().then((text) => {
					let body = null;
					try {
						body = text === '' ? null : JSON.parse(text);
					} catch (error) {
						body = null;
					}
					if (!response.ok) {
						const message = body !== null && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
						throw new Error(message);
					}
					return body;
				}))
				.finally(() => {
					if (timer !== null) clearTimeout(timer);
				});
		}

		const readState = () => apiRequest('/state');
		const writeConfig = (patch) => apiRequest('/config', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(patch),
		});
		const uploadMedia = (kind, file) => apiRequest(`/upload?id=${encodeURIComponent(kind)}`, {
			method: 'POST',
			headers: {
				'content-type': file.type !== '' ? file.type : 'application/octet-stream',
				'x-file-name': encodeURIComponent(file.name),
			},
			body: file,
		});
		const resetMedia = (kind) => apiRequest(`/reset?id=${encodeURIComponent(kind)}`, { method: 'POST' });

		/** `object-fit` accepts `fill`; `background-size` does not — there it means 100% 100%. */
		function backgroundSizeFor(fit) {
			if (fit === 'contain') return 'contain';
			if (fit === 'fill') return '100% 100%';
			return 'cover';
		}






		/**
		 * Average colour of a decoded image or a video frame.
		 *
		 * Used to tint the strip above the wallpaper layer, so reserving the window's
		 * title strip does not leave a visible band of unrelated colour there. Tinting
		 * `html` paints that strip without adding any element — adding one is exactly
		 * what broke window dragging in the first place.
		 */
		function averageColorOf(source) {
			try {
				const canvas = document.createElement('canvas');
				canvas.width = 8;
				canvas.height = 8;
				const context = canvas.getContext('2d');
				if (context === null) return null;
				context.drawImage(source, 0, 0, 8, 8);
				const pixels = context.getImageData(0, 0, 8, 8).data;
				let red = 0;
				let green = 0;
				let blue = 0;
				for (let index = 0; index < pixels.length; index += 4) {
					red += pixels[index];
					green += pixels[index + 1];
					blue += pixels[index + 2];
				}
				const count = pixels.length / 4;
				return `rgb(${Math.round(red / count)}, ${Math.round(green / count)}, ${Math.round(blue / count)})`;
			} catch (error) {
				return null;
			}
		}

		/**
		 * One decoded frame as a data URL.
		 *
		 * The strip above the wallpaper layer is filled from a `body` background image —
		 * a background is not an element, so it cannot interfere with the window drag
		 * rects the way an overlay does. A video has no background-image equivalent, so
		 * it contributes one still frame for that 48px band.
		 */
		function frameDataUrl(element) {
			try {
				const width = 640;
				const ratio = element.videoWidth > 0 ? element.videoHeight / element.videoWidth : 9 / 16;
				const height = Math.max(1, Math.round(width * ratio));
				const canvas = document.createElement('canvas');
				canvas.width = width;
				canvas.height = height;
				const context = canvas.getContext('2d');
				if (context === null) return null;
				context.drawImage(element, 0, 0, width, height);
				return canvas.toDataURL('image/jpeg', 0.72);
			} catch (error) {
				return null;
			}
		}

		function prefersReducedMotion() {
			try {
				return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			} catch (error) {
				return false;
			}
		}

		/**
		 * Release the inline first-paint cover the host injected into index.html.
		 *
		 * The cover hides the app root until the film is on screen. Releasing REMOVES
		 * the style nodes, so it is one-way: nothing re-applies it when the film later
		 * unmounts. The injected 10s guard is only the fallback for a client that never
		 * runs at all.
		 */
		function releaseFirstPaintCover() {
			try {
				const guard = window.__BOOT_SKIN_GUARD__;
				if (guard === null || guard === undefined || typeof guard !== 'object') return;
				if (typeof guard.clear === 'function') guard.clear();
				if (typeof guard.release === 'function') guard.release();
			} catch (error) {
				/* nothing to release */
			}
		}

		/** Run `fn` once `document.body` exists (normally already true when a client entry activates). */
		function onBodyReady(fn) {
			if (document.body !== null) {
				fn();
				return () => {};
			}
			const listener = () => fn();
			document.addEventListener('DOMContentLoaded', listener, { once: true });
			return () => document.removeEventListener('DOMContentLoaded', listener);
		}

		/**
		 * The token set that lets a wallpaper be seen through the shell's surfaces.
		 *
		 * `--dsw-alias-bg-base` is painted by the frame, the conversation column
		 * and the details column, so all three have to become translucent before a
		 * layer at `z-index: -1` is visible at all. The values are the shell's own
		 * neutral tones with the configured alpha.
		 */
		function translucentSurfaceTokens(surfaceAlpha) {
			const level = clampNumber(surfaceAlpha, 40, 100, 84) / 100;
			// `--dsw-alias-bg-base` is painted by SEVERAL NESTED containers, not one:
			// the frame, the content row and the conversation column each declare it
			// (measured in ui-layout and ui-conversation: 5 rules each). Their opacity
			// compounds — three layers at 84% leave 0.16^3 ≈ 0.4% of the wallpaper,
			// which is exactly why the sidebar showed the image and the chat area did
			// not (the sidebar has a single layer).
			//
			// Solving (1 - a)^depth = 1 - level for `a` makes the slider mean "how much
			// wallpaper survives", independent of how deep the host nests its canvas.
			// `depth: 3` is the measured worst case; a shallower tree is simply a
			// little more transparent, never less visible.
			const depth = 3;
			const canvasAlpha = 1 - Math.pow(1 - level, 1 / depth);
			const mix = (r, g, b, alpha) => `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(4)})`;
			return {
				// The canvas: corrected for nesting, so the picture is actually visible.
				'--dsw-alias-bg-base': { light: mix(255, 255, 255, canvasAlpha), dark: mix(21, 21, 23, canvasAlpha) },
				// Raised surfaces (cards, panels, composer): translucent panels that
				// float over the wallpaper rather than hiding it.
				'--dsw-alias-bg-layer-1': { light: mix(255, 255, 255, level), dark: mix(30, 30, 33, level) },
				'--dsw-alias-bg-layer-2': { light: mix(248, 249, 252, level), dark: mix(38, 38, 42, level) },
				'--dsw-alias-bg-layer-3': { light: mix(250, 251, 253, level), dark: mix(44, 44, 48, level) },
				'--dsw-alias-bg-module-platform': { light: mix(243, 244, 246, level), dark: mix(52, 52, 56, level) },
				'--dsw-specific-sidebar-fill': { light: mix(250, 250, 252, level), dark: mix(26, 26, 29, level) },
			};
		}
		// #endregion

		// #region boot film (plain DOM)
		/**
		 * Build and run the boot film.
		 *
		 * Ordering rules, all learned from the field:
		 *  - the layer is appended and painted opaque before playback starts, so
		 *    the frame never shows through mid-startup;
		 *  - exactly one path ends the film (`finish`), guarded by a flag, because
		 *    a double finish fires `onDone` twice and re-runs the teardown;
		 *  - an unplayable or erroring source ends the film immediately instead of
		 *    leaving the app behind a black rectangle;
		 *  - the teardown pauses and detaches the element; removing a `<video>`
		 *    from the DOM alone leaves its decoder running.
		 */
		function createBootFilm(options) {
			const { url, boot, muted, t, onDone } = options;
			const fadeInMs = clampNumber(boot.fadeInMs, 0, 3000, 240);
			const fadeOutMs = clampNumber(boot.fadeOutMs, 0, 3000, 560);
			const opacity = clampNumber(boot.opacity, 0, 100, 100) / 100;
			const skip = boot.skip !== false;
			let done = false;
			let ceilingTimer = null;
			let fadeTimer = null;
			let hintTimer = null;

			const layer = document.createElement('div');
			layer.setAttribute('data-boot-skin', 'film');
			layer.setAttribute('role', 'presentation');
			// The layer is opaque from the start so the frame is covered at once; the
			// video itself fades in over `fadeInMs`, so the first frame of a dark clip
			// does not pop. The transition here is only for the exit.
			layer.style.cssText = [
				'position:fixed',
				'inset:0',
				`z-index:${Z_FILM}`,
				'background:#000',
				'opacity:1',
				`transition:opacity ${fadeOutMs}ms ease`,
				// CRITICAL: never swallow pointer events. The whole viewport being
				// pointer-events:auto made the window title bar undraggable for as long
				// as the film was up (the native app-region hit test never saw the mouse
				// down). Click-to-skip is implemented with a capture-phase listener on
				// `window` below instead, which cannot block the drag region.
				'pointer-events:none',
				'overflow:hidden',
			].join(';');

			const video = document.createElement('video');
			video.setAttribute('playsinline', '');
			video.setAttribute('preload', 'auto');
			video.setAttribute('aria-hidden', 'true');
			video.muted = muted;
			video.style.cssText = [
				'position:absolute',
				'inset:0',
				'width:100%',
				'height:100%',
				'object-fit:cover',
				'opacity:0',
				`transition:opacity ${fadeInMs}ms ease`,
				'background:#000',
			].join(';');

			const hint = document.createElement('div');
			hint.textContent = t('film.skipHint');
			hint.style.cssText = [
				'position:absolute',
				'right:18px',
				'bottom:16px',
				'font:12px/1.4 system-ui,-apple-system,sans-serif',
				'color:rgba(255,255,255,.62)',
				'letter-spacing:.02em',
				'pointer-events:none',
				'opacity:0',
				'transition:opacity 400ms ease',
				'user-select:none',
			].join(';');

			function clearTimers() {
				if (ceilingTimer !== null) clearTimeout(ceilingTimer);
				if (fadeTimer !== null) clearTimeout(fadeTimer);
				if (hintTimer !== null) clearTimeout(hintTimer);
				ceilingTimer = null;
				fadeTimer = null;
				hintTimer = null;
			}

			function cleanup() {
				clearTimers();
				window.removeEventListener('keydown', onKeyDown, true);
				window.removeEventListener('click', onClickCapture, true);
				try {
					video.pause();
					video.removeAttribute('src');
					video.load();
				} catch (error) {
					/* the element may already be detached */
				}
				if (layer.parentNode !== null) layer.parentNode.removeChild(layer);
			}

			function finish() {
				if (done) return;
				done = true;
				clearTimers();
				layer.style.pointerEvents = 'none';
				layer.style.opacity = '0';
				video.style.transition = `opacity ${fadeOutMs}ms ease`;
				video.style.opacity = '0';
				if (fadeOutMs <= 0) {
					cleanup();
					onDone();
					return;
				}
				fadeTimer = setTimeout(() => {
					fadeTimer = null;
					cleanup();
					onDone();
				}, fadeOutMs);
			}

			/**
			 * Click-to-skip without owning pointer events.
			 *
			 * A capture-phase listener sees the click even though the film layer is
			 * `pointer-events: none` (which is what keeps the window draggable), and
			 * stopping it here means the click does not also activate whatever button
			 * was underneath.
			 */
			function onClickCapture(event) {
				if (done) return;
				// Swallow the click either way: with `skip` off, letting it through would
				// activate a control the user cannot even see under the film.
				event.stopPropagation();
				event.preventDefault();
				if (skip) finish();
			}

			function onKeyDown(event) {
				if (event.key === 'Escape' || event.key === 'Esc') {
					event.stopPropagation();
					finish();
				}
			}

			video.addEventListener('ended', finish, { once: true });
			video.addEventListener('error', finish, { once: true });
			video.addEventListener('playing', () => {
				video.style.opacity = String(opacity);
				if (skip) {
					hint.style.opacity = '1';
					hintTimer = setTimeout(() => {
						hintTimer = null;
						hint.style.opacity = '0';
					}, 2600);
				}
			}, { once: true });

			// Registered regardless of `skip`: the capture listener is what keeps clicks
			// from reaching the covered interface now that the layer itself lets pointer
			// events pass (which is what keeps the window draggable).
			window.addEventListener('click', onClickCapture, true);
			if (skip) window.addEventListener('keydown', onKeyDown, true);

			layer.appendChild(video);
			if (skip) layer.appendChild(hint);
			document.body.appendChild(layer);
			ceilingTimer = setTimeout(finish, clampNumber(boot.maxMs, 1000, 60000, 15000));
			video.src = url;

			const attempt = video.play();
			if (attempt !== undefined && typeof attempt.catch === 'function') {
				attempt.catch(() => {
					// Autoplay with sound is refused by the webview; retry muted before
					// giving up, which is what a user expects from a boot film anyway.
					if (!video.muted) {
						video.muted = true;
						const retry = video.play();
						if (retry !== undefined && typeof retry.catch === 'function') retry.catch(finish);
						return;
					}
					finish();
				});
			}

			return { finish };
		}
		// #endregion

		// #region wallpaper (plain DOM)
		/**
		 * The wallpaper layer: one fixed child of `document.body` under everything.
		 *
		 * A wallpaper is never expressed as a token — it is a canvas behind the
		 * shell, and the tokens only make the shell translucent enough to see it
		 * (see `translucentSurfaceTokens`). The media element is rebuilt only when
		 * the source changes, so dragging the blur/opacity sliders never restarts
		 * a video wallpaper.
		 */
		function createWallpaper() {
			/** @type {HTMLElement | null} */
			let layer = null;
			/** @type {HTMLElement | null} */
			let mediaEl = null;
			/** @type {HTMLElement | null} */
			let dimEl = null;
			/** @type {HTMLVideoElement | null} */
			let video = null;
			/** Identity of the currently mounted source. */
			let sourceKey = '';
			/** `loop` or `once`; see the `videoMode` setting. */
			let videoMode = 'loop';
			/** Last tint applied to the document element for the reserved title strip. */
			let stripTint = '';
			/** Source painted behind the shell to fill the reserved title strip. */
			let stripSource = null;
			/** Inline body background saved before we touched it, so teardown restores it. */
			let savedBackground = null;
			/**
			 * Held while the boot film still covers the viewport.
			 *
			 * Without this the wallpaper video starts on mount, plays its single run
			 * behind the film, and is already parked on its last frame by the time the
			 * interface appears — which reads as "the wallpaper never played". The film's
			 * exit releases the hold, so a `once` wallpaper performs its one run when the
			 * user can actually see it.
			 */
			let held = false;

			/** Stop any wallpaper playback while the boot film owns the viewport. */
			function hold() {
				held = true;
				if (video === null) return;
				try {
					video.pause();
				} catch (error) {
					/* a detached element cannot pause, and does not need to */
				}
			}

			/**
			 * The film handed the viewport back: let a waiting wallpaper run.
			 *
			 * A `once` clip that was never started runs from 0 here; a finished one
			 * restarts only because `replay` is what a fresh reveal means for it.
			 */
			function resume() {
				if (!held) return;
				held = false;
				if (video === null) return;
				try {
					// A `once` clip owes the user one complete run, and the neutral state
					// before a film is a few buffered milliseconds in — restart it.
					if (videoMode === 'once' || video.ended) video.currentTime = 0;
					const attempt = video.play();
					if (attempt !== undefined && typeof attempt.catch === 'function') attempt.catch(() => {});
				} catch (error) {
					/* the element went away between the film and the reveal */
				}
			}

			function tintStrip(color) {
				if (color === null || color === stripTint) return;
				stripTint = color;
				try {
					document.documentElement.style.backgroundColor = color;
				} catch (error) {
					/* a frozen documentElement is not worth failing over */
				}
			}

			/**
			 * Fill the reserved title strip from a background image.
			 *
			 * `body`'s own background paints under everything, including the strip where
			 * our layer must not reach — and because it is a background rather than a
			 * box, it cannot swallow the window's drag rects.
			 */
			function fillStrip(url, fit, dim) {
				if (url === null) return;
				try {
					const body = document.body;
					if (body === null) return;
					if (savedBackground === null) {
						savedBackground = {
							image: body.style.backgroundImage,
							size: body.style.backgroundSize,
							position: body.style.backgroundPosition,
							repeat: body.style.backgroundRepeat,
							attachment: body.style.backgroundAttachment,
						};
					}
					if (stripSource !== url) stripSource = url;
					const shade = clampNumber(dim, 0, 100, 25) / 100;
					body.style.backgroundImage = `linear-gradient(rgba(0,0,0,${shade}), rgba(0,0,0,${shade})), url("${url}")`;
					body.style.backgroundSize = `auto, ${backgroundSizeFor(fit)}`;
					body.style.backgroundPosition = 'center, center top';
					body.style.backgroundRepeat = 'no-repeat, no-repeat';
					body.style.backgroundAttachment = 'fixed, fixed';
				} catch (error) {
					/* a background that refuses to apply only costs the strip */
				}
			}

			function clearStripSource() {
				stripSource = null;
				if (savedBackground === null) return;
				try {
					const body = document.body;
					body.style.backgroundImage = savedBackground.image;
					body.style.backgroundSize = savedBackground.size;
					body.style.backgroundPosition = savedBackground.position;
					body.style.backgroundRepeat = savedBackground.repeat;
					body.style.backgroundAttachment = savedBackground.attachment;
				} catch (error) {
					/* ignore */
				}
				savedBackground = null;
			}

			function clearStripTint() {
				if (stripTint === '') return;
				stripTint = '';
				try {
					document.documentElement.style.backgroundColor = '';
				} catch (error) {
					/* ignore */
				}
			}

			function teardown() {
				held = false;
				clearStripTint();
				clearStripSource();
				if (video !== null) {
					try {
						video.pause();
						video.removeAttribute('src');
						video.load();
					} catch (error) {
						/* already detached */
					}
				}
				if (layer !== null && layer.parentNode !== null) layer.parentNode.removeChild(layer);
				layer = null;
				mediaEl = null;
				dimEl = null;
				video = null;
				sourceKey = '';
			}

			/**
			 * Restart a `once` wallpaper video from the beginning.
			 *
			 * Called when the conversation view is re-entered. A looping wallpaper
			 * is already running, and a still image has nothing to restart.
			 */
			function replay() {
				if (video === null || videoMode !== 'once') return;
				try {
					video.currentTime = 0;
					const attempt = video.play();
					if (attempt !== undefined && typeof attempt.catch === 'function') attempt.catch(() => {});
				} catch (error) {
					/* a source that refuses to seek simply keeps its last frame */
				}
			}

			function rebuild(node, isVideo, url, fit) {
				while (node.firstChild !== null) node.removeChild(node.firstChild);
				if (video !== null) {
					try {
						video.pause();
					} catch (error) {
						/* ignore */
					}
					video = null;
				}
				if (isVideo) {
					const element = document.createElement('video');
					element.muted = true;
					element.loop = videoMode === 'loop';
					element.autoplay = true;
					element.setAttribute('playsinline', '');
					element.setAttribute('aria-hidden', 'true');
					element.src = url;
					element.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:${fit};`;
					element.addEventListener('loadeddata', () => {
						const color = averageColorOf(element);
						if (color !== null) tintStrip(color);
						const frame = frameDataUrl(element);
						if (frame !== null) fillStrip(frame, fit, dim);
					}, { once: true });
					node.appendChild(element);
					video = element;
					mediaEl = element;
					if (!held) {
						const attempt = element.play();
						if (attempt !== undefined && typeof attempt.catch === 'function') attempt.catch(() => {});
					}
				} else {
					const element = document.createElement('div');
					element.style.cssText = `position:absolute;inset:0;background-image:url("${url}");background-size:${backgroundSizeFor(fit)};background-position:center;background-repeat:no-repeat;`;
					node.appendChild(element);
					mediaEl = element;
					try {
						const probe = new Image();
						probe.onload = () => {
							const color = averageColorOf(probe);
							if (color !== null) tintStrip(color);
							fillStrip(url, fit, dim);
						};
						probe.src = url;
					} catch (error) {
						/* tinting is cosmetic */
					}
				}
				const dim = document.createElement('div');
				dim.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
				node.appendChild(dim);
				dimEl = dim;
			}

			/**
			 * @param {{ enabled: boolean, opacity: number, blurPx: number, dim: number, fit: string }} wallpaper
			 * @param {{ url: string | null, mime: string | null }} media
			 */
			function apply(wallpaper, media) {
				if (wallpaper === null || wallpaper.enabled !== true || media.url === null) {
					teardown();
					return;
				}
				const nextMode = wallpaper.videoMode === 'once' ? 'once' : 'loop';
				if (nextMode !== videoMode) {
					videoMode = nextMode;
					if (video !== null) {
						video.loop = nextMode === 'loop';
						// Switching back to loop after the clip ended must resume it;
						// switching to `once` mid-play keeps playing, it just stops looping.
						if (nextMode === 'loop' && !held) {
							const attempt = video.play();
							if (attempt !== undefined && typeof attempt.catch === 'function') attempt.catch(() => {});
						}
					}
				}
				if (layer === null) {
					const node = document.createElement('div');
					node.setAttribute('data-boot-skin', 'wallpaper');
					node.setAttribute('aria-hidden', 'true');
					node.style.cssText = [
						'position:fixed',
						'inset:0',
						// CRITICAL: start BELOW the window's title strip.
						//
						// Chromium recomputes the frameless window's draggable rects by hit
						// testing, and `pointer-events:none` is not honoured by that pass: a
						// full-viewport fixed layer eats the title bar's drag rect on the next
						// repaint. The symptom is nasty because the FIRST drag still works —
						// the rects were computed before this layer existed — and every drag
						// after that does not. Leaving the strip uncovered keeps the window
						// draggable; it also means the wallpaper correctly respects the
						// titlebar instead of painting under it.
						'top:var(--dsh-frame-top-clearance,0px)',
						`z-index:${Z_WALLPAPER}`,
						'pointer-events:none',
						'overflow:hidden',
						'background:transparent',
					].join(';');
					document.body.appendChild(node);
					layer = node;
				}

				const blur = clampNumber(wallpaper.blurPx, 0, 40, 0);
				const fit = wallpaper.fit === 'contain' || wallpaper.fit === 'fill' ? wallpaper.fit : 'cover';
				const isVideo = typeof media.mime === 'string' && media.mime.indexOf('video/') === 0;
				// Keyed on the file's identity, not its URL: the URL carries a revision,
				// so keying on it would restart a video wallpaper whenever an unrelated
				// setting changed the revision.
				const nextKey = `${isVideo ? 'v' : 'i'}|${media.key === undefined || media.key === null ? media.url : media.key}`;

				layer.style.opacity = String(clampNumber(wallpaper.opacity, 0, 100, 45) / 100);
				if (nextKey !== sourceKey) {
					rebuild(layer, isVideo, media.url, fit);
					sourceKey = nextKey;
				}
				if (mediaEl !== null) {
					mediaEl.style.objectFit = fit;
					mediaEl.style.backgroundSize = backgroundSizeFor(fit);
					mediaEl.style.filter = blur > 0 ? `blur(${blur}px)` : 'none';
					// Scaling up hides the transparent edge a blur leaves behind.
					mediaEl.style.transform = blur > 0 ? 'scale(1.06)' : 'none';
				}
				if (dimEl !== null) {
					dimEl.style.background = `rgba(0, 0, 0, ${clampNumber(wallpaper.dim, 0, 100, 25) / 100})`;
				}
				// Keep the strip's fill in step with the sliders the user is dragging.
				if (stripSource !== null) fillStrip(stripSource, fit, wallpaper.dim);
			}

			return { apply, hold, replay, resume, teardown };
		}
		// #endregion

		// #region settings UI
		const VALUE_STYLE = { fontSize: 11, minWidth: 46, textAlign: 'right', color: 'var(--dsw-alias-label-secondary)' };
		const SELECT_STYLE = {
			fontSize: 12,
			padding: '4px 8px',
			borderRadius: 8,
			color: 'var(--dsw-alias-label-primary)',
			background: 'var(--dsw-alias-bg-layer-2)',
			border: '1px solid var(--dsw-alias-border-l2)',
		};
		const BUTTON_STYLE = {
			padding: '6px 12px',
			borderRadius: 8,
			fontSize: 12,
			cursor: 'pointer',
			border: '1px solid var(--dsw-alias-border-l2)',
			background: 'var(--dsw-alias-bg-layer-2)',
			color: 'var(--dsw-alias-label-primary)',
		};

		function Row(props) {
			return h(
				'div',
				{ style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '10px 0' } },
				h('div', { style: { minWidth: 0 } },
					h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, props.label),
					props.hint === undefined
						? null
						: h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 2 } }, props.hint),
				),
				h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 } }, props.children),
			);
		}

		function Slider(props) {
			return h('input', {
				type: 'range',
				min: props.min,
				max: props.max,
				step: props.step === undefined ? 1 : props.step,
				value: props.value,
				disabled: props.disabled === true,
				onChange: (event) => props.onChange(Number(event.target.value)),
				style: { width: 168, accentColor: 'var(--dsw-alias-brand-primary)' },
			});
		}

		function Switch(props) {
			const on = props.value === true;
			return h('button', {
				type: 'button',
				role: 'switch',
				'aria-checked': on,
				onClick: () => props.onChange(!on),
				style: {
					width: 44,
					height: 24,
					borderRadius: 999,
					border: '1px solid var(--dsw-alias-border-l2)',
					background: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)',
					cursor: 'pointer',
					position: 'relative',
					padding: 0,
				},
			}, h('span', {
				style: {
					position: 'absolute',
					top: 2,
					left: on ? 22 : 2,
					width: 18,
					height: 18,
					borderRadius: 999,
					background: '#fff',
					transition: 'left 160ms ease',
				},
			}));
		}

		function Card(props) {
			return h('section', {
				style: {
					border: '1px solid var(--dsw-alias-border-l2)',
					borderRadius: 12,
					padding: '6px 16px 16px',
					marginBottom: 16,
					background: 'var(--dsw-alias-bg-layer-1)',
				},
			},
				h('h3', { style: { fontSize: 13, fontWeight: 600, margin: '14px 0 2px', color: 'var(--dsw-alias-label-primary)' } }, props.title),
				props.description === undefined
					? null
					: h('p', { style: { fontSize: 11, margin: '0 0 8px', color: 'var(--dsw-alias-label-secondary)' } }, props.description),
				props.children,
			);
		}

		function FilePicker(props) {
			return h('label', {
				style: {
					padding: '6px 12px',
					borderRadius: 8,
					fontSize: 12,
					cursor: props.disabled ? 'default' : 'pointer',
					border: '1px solid var(--dsw-alias-border-l2)',
					color: 'var(--dsw-alias-label-primary)',
					opacity: props.disabled ? 0.6 : 1,
				},
			},
				props.busy ? props.labelBusy : props.label,
				h('input', {
					type: 'file',
					accept: props.accept,
					style: { display: 'none' },
					disabled: props.disabled,
					onChange: props.onChange,
				}),
			);
		}

		/**
		 * The plugin's settings page.
		 *
		 * Every mutation goes host-side through `/config` or `/upload`; the page
		 * never keeps its own copy of the truth, so a second window stays in sync.
		 */
		function SettingsPage(props) {
			const { state, t, onRefresh, onPreview, loadError, onRetry } = props;
			const [busy, setBusy] = useState('');
			const [error, setError] = useState('');
			/** Local echo of unsent edits: the controls must move under the cursor. */
			const [draft, setDraft] = useState({});
			const pending = useRef({});
			const timer = useRef(null);

			/**
			 * Coalesced setting writes.
			 *
			 * A slider drag emits dozens of input events per second. Writing each one
			 * costs an atomic file write, a new revision, a `/state` round-trip and a
			 * full token re-projection — enough to make the wallpaper flicker while the
			 * user is still dragging. Everything is merged here and flushed once the
			 * user pauses, while `draft` keeps the control visually live in the
			 * meantime.
			 */
			/**
			 * One string a user can paste into an issue.
			 *
			 * The window-chrome lines are what make a "cannot drag the window" report
			 * actionable: they say which chrome mode the shell is in and whether any of
			 * our layers is still mounted.
			 */

			const commit = useCallback(() => {
				timer.current = null;
				const patch = pending.current;
				pending.current = {};
				if (Object.keys(patch).length === 0) return;
				setError('');
				writeConfig(patch)
					.then((next) => {
						if (next !== null && next.config !== undefined) onRefresh(next);
						// No newer edit arrived while this request was in flight: drop the
						// optimistic copy so the host becomes the truth again.
						if (Object.keys(pending.current).length === 0) setDraft({});
					})
					.catch((cause) => {
						setError(cause.message);
						setDraft({});
					});
			}, [onRefresh]);

			const mutate = useCallback((patch) => {
				const merged = { ...pending.current };
				for (const section of Object.keys(patch)) {
					merged[section] = { ...(pending.current[section] ?? {}), ...patch[section] };
				}
				pending.current = merged;
				setDraft((previous) => {
					const next = { ...previous };
					for (const section of Object.keys(patch)) {
						next[section] = { ...(previous[section] ?? {}), ...patch[section] };
					}
					return next;
				});
				if (timer.current === null) timer.current = setTimeout(commit, 150);
			}, [commit]);

			useEffect(() => () => {
				if (timer.current !== null) clearTimeout(timer.current);
			}, []);

			const pick = useCallback((kind) => (event) => {
				const input = event.target;
				const file = input.files !== null && input.files.length > 0 ? input.files[0] : null;
				input.value = '';
				if (file === null) return;
				setError('');
				setBusy(kind);
				uploadMedia(kind, file)
					.then((next) => {
						if (next !== null && next.config !== undefined) {
							onRefresh(next);
							setDraft({});
						}
					})
					.catch((cause) => setError(cause.message))
					.then(() => setBusy(''));
			}, [onRefresh]);

			const clear = useCallback((kind) => {
				setError('');
				setBusy(kind);
				resetMedia(kind)
					.then((next) => {
						if (next !== null && next.config !== undefined) {
							onRefresh(next);
							setDraft({});
						}
					})
					.catch((cause) => setError(cause.message))
					.then(() => setBusy(''));
			}, [onRefresh]);

			const config = state === null ? null : state.config;
			if (config === null) {
				if (typeof loadError === 'string' && loadError !== '') {
					return h('div', { style: { padding: 16, fontSize: 13 } },
						h('div', { style: { marginBottom: 10, color: 'var(--dsw-alias-state-error-primary)' } }, `${t('settings.loadFailed')}: ${loadError}`),
						h('button', { type: 'button', onClick: onRetry, style: BUTTON_STYLE }, t('settings.retry')),
					);
				}
				return h('div', { style: { padding: 16, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, t('settings.loading'));
			}
			const boot = draft.boot === undefined ? config.boot : { ...config.boot, ...draft.boot };
			const wallpaper = draft.wallpaper === undefined ? config.wallpaper : { ...config.wallpaper, ...draft.wallpaper };
			const bootMedia = config.media.boot;
			const wallpaperMedia = config.media.wallpaper;
			const wallpaperIsVideo =
				wallpaperMedia !== null &&
				typeof wallpaperMedia.mime === 'string' &&
				wallpaperMedia.mime.indexOf('video/') === 0;
			// A host that predates the setting omits it; hide the control rather than
			// showing a dropdown whose writes that host would ignore.
			const hasVideoMode = wallpaper.videoMode === 'loop' || wallpaper.videoMode === 'once';
			const disabled = busy !== '';

			return h('div', { style: { padding: '4px 0 24px', maxWidth: 720 } },
				h('p', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '4px 0 16px', lineHeight: 1.6 } }, t('settings.intro')),
				error === ''
					? null
					: h('div', {
						style: {
							margin: '0 0 12px',
							padding: '8px 12px',
							borderRadius: 8,
							fontSize: 12,
							color: 'var(--dsw-alias-state-error-primary)',
							border: '1px solid var(--dsw-alias-border-l2)',
						},
					}, error),

				h(Card, { title: t('boot.title'), description: t('boot.description') },
					h(Row, { label: t('boot.enabled'), hint: t('boot.enabledHint') },
						h(Switch, { value: boot.enabled, onChange: (value) => mutate({ boot: { enabled: value } }) }),
					),
					h(Row, {
						label: t('boot.file'),
						hint: bootMedia === null ? t('boot.noFile') : `${bootMedia.name} · ${formatBytes(bootMedia.bytes)}`,
					},
						h(FilePicker, {
							label: t('boot.pick'),
							labelBusy: t('common.uploading'),
							busy: busy === 'boot',
							disabled,
							accept: 'video/mp4,video/webm',
							onChange: pick('boot'),
						}),
						bootMedia === null
							? null
							: h('button', { type: 'button', onClick: () => clear('boot'), disabled, style: BUTTON_STYLE }, t('common.remove')),
					),
					h(Row, { label: t('boot.opacity') },
						h(Slider, { value: boot.opacity, min: 0, max: 100, onChange: (value) => mutate({ boot: { opacity: value } }) }),
						h('span', { style: VALUE_STYLE }, `${boot.opacity}%`),
					),
					h(Row, { label: t('boot.fadeIn'), hint: t('boot.fadeInHint') },
						h(Slider, { value: boot.fadeInMs, min: 0, max: 3000, step: 40, onChange: (value) => mutate({ boot: { fadeInMs: value } }) }),
						h('span', { style: VALUE_STYLE }, `${boot.fadeInMs}ms`),
					),
					h(Row, { label: t('boot.fadeOut'), hint: t('boot.fadeOutHint') },
						h(Slider, { value: boot.fadeOutMs, min: 0, max: 3000, step: 40, onChange: (value) => mutate({ boot: { fadeOutMs: value } }) }),
						h('span', { style: VALUE_STYLE }, `${boot.fadeOutMs}ms`),
					),
					h(Row, { label: t('boot.maxMs'), hint: t('boot.maxMsHint') },
						h(Slider, { value: boot.maxMs, min: 1000, max: 60000, step: 500, onChange: (value) => mutate({ boot: { maxMs: value } }) }),
						h('span', { style: VALUE_STYLE }, `${(boot.maxMs / 1000).toFixed(1)}s`),
					),
					h(Row, { label: t('boot.muted'), hint: t('boot.mutedHint') },
						h(Switch, { value: boot.muted, onChange: (value) => mutate({ boot: { muted: value } }) }),
					),
					h(Row, { label: t('boot.skip'), hint: t('boot.skipHint') },
						h(Switch, { value: boot.skip, onChange: (value) => mutate({ boot: { skip: value } }) }),
					),
					h(Row, { label: t('boot.once'), hint: t('boot.onceHint') },
						h(Switch, { value: boot.once, onChange: (value) => mutate({ boot: { once: value } }) }),
					),
					h('div', { style: { display: 'flex', gap: 10, marginTop: 12 } },
						h('button', {
							type: 'button',
							onClick: onPreview,
							disabled: bootMedia === null || state.urls.boot === null,
							style: BUTTON_STYLE,
						}, t('boot.preview')),
					),
				),

				h(Card, { title: t('wallpaper.title'), description: t('wallpaper.description') },
					h(Row, { label: t('wallpaper.enabled'), hint: t('wallpaper.enabledHint') },
						h(Switch, { value: wallpaper.enabled, onChange: (value) => mutate({ wallpaper: { enabled: value } }) }),
					),
					h(Row, {
						label: t('wallpaper.file'),
						hint: wallpaperMedia === null ? t('wallpaper.noFile') : `${wallpaperMedia.name} · ${formatBytes(wallpaperMedia.bytes)}`,
					},
						h(FilePicker, {
							label: t('wallpaper.pick'),
							labelBusy: t('common.uploading'),
							busy: busy === 'wallpaper',
							disabled,
							accept: 'image/png,image/jpeg,image/webp,image/avif,image/gif,video/mp4,video/webm',
							onChange: pick('wallpaper'),
						}),
						wallpaperMedia === null
							? null
							: h('button', { type: 'button', onClick: () => clear('wallpaper'), disabled, style: BUTTON_STYLE }, t('common.remove')),
					),
					wallpaperIsVideo && hasVideoMode
						? h(Row, { label: t('wallpaper.videoMode'), hint: t('wallpaper.videoModeHint') },
							h('select', {
								value: wallpaper.videoMode,
								onChange: (event) => mutate({ wallpaper: { videoMode: event.target.value } }),
								style: SELECT_STYLE,
							},
								h('option', { value: 'loop' }, t('wallpaper.modeLoop')),
								h('option', { value: 'once' }, t('wallpaper.modeOnce')),
							),
						)
						: null,
					h(Row, { label: t('wallpaper.opacity') },
						h(Slider, { value: wallpaper.opacity, min: 0, max: 100, onChange: (value) => mutate({ wallpaper: { opacity: value } }) }),
						h('span', { style: VALUE_STYLE }, `${wallpaper.opacity}%`),
					),
					h(Row, { label: t('wallpaper.blur'), hint: t('wallpaper.blurHint') },
						h(Slider, { value: wallpaper.blurPx, min: 0, max: 40, onChange: (value) => mutate({ wallpaper: { blurPx: value } }) }),
						h('span', { style: VALUE_STYLE }, `${wallpaper.blurPx}px`),
					),
					h(Row, { label: t('wallpaper.dim'), hint: t('wallpaper.dimHint') },
						h(Slider, { value: wallpaper.dim, min: 0, max: 100, onChange: (value) => mutate({ wallpaper: { dim: value } }) }),
						h('span', { style: VALUE_STYLE }, `${wallpaper.dim}%`),
					),
					h(Row, { label: t('wallpaper.fit'), hint: t('wallpaper.fitHint') },
						h('select', {
							value: wallpaper.fit,
							onChange: (event) => mutate({ wallpaper: { fit: event.target.value } }),
							style: SELECT_STYLE,
						},
							h('option', { value: 'cover' }, t('wallpaper.fitCover')),
							h('option', { value: 'contain' }, t('wallpaper.fitContain')),
							h('option', { value: 'fill' }, t('wallpaper.fitFill')),
						),
					),
					h(Row, { label: t('wallpaper.surfaceAlpha'), hint: t('wallpaper.surfaceAlphaHint') },
						h(Slider, { value: wallpaper.surfaceAlpha, min: 40, max: 100, onChange: (value) => mutate({ wallpaper: { surfaceAlpha: value } }) }),
						h('span', { style: VALUE_STYLE }, `${wallpaper.surfaceAlpha}%`),
					),
				),
			);
		}
		// #endregion

		return {
			name: NS,
			// Only the two services every Web client always provides are static.
			// `theme` is resolved dynamically inside apply, so a host without it
			// loses the wallpaper translucency but never the whole GUI: a static
			// dependency the host cannot satisfy leaves this entry `pending`, and
			// the web boot treats that as fatal.
			inject: ['slots', 'locale'],
			apply(ctx) {
				// A cosmetic plugin must never be the reason the web boot reports a
				// failed entry — the host treats any non-active client entry as fatal
				// ("web boot: N entry did not activate") and the whole GUI fails to
				// load. Report and stay idle instead of propagating.
				try {
				const t = ctx.locale.bind(NS);
				const wallpaper = createWallpaper();

				/** @type {null | { config: any, revision: string, urls: { boot: string | null, wallpaper: string | null } }} */
				let state = null;
				let disposed = false;
				/** @type {null | { finish: () => void }} */
				let film = null;
				/** Bumped per film so a superseded film's exit callback stands down. */
				let filmGeneration = 0;
				/** @type {null | (() => void)} */
				let restoreTokens = null;
				/** @type {any} */
				let themeService = null;
				let unwireBody = () => {};

				// A tiny observable so the settings page re-renders after host writes.
				const listeners = new Set();
				const store = {
					get: () => state,
					subscribe(listener) {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
					emit() {
						for (const listener of listeners) {
							try {
								listener();
							} catch (error) {
								/* one broken listener must not break the rest */
							}
						}
					},
				};

				/** Pure: decides from a payload, so it can run BEFORE the layers react to it. */
				function shouldPlayFilm(candidate) {
					if (candidate === null || candidate === undefined) return false;
					if (candidate.config === undefined || candidate.config.boot === undefined) return false;
					if (candidate.config.boot.enabled !== true) return false;
					if (candidate.urls === undefined || candidate.urls.boot === null) return false;
					if (candidate.config.boot.once === false) return true;
					try {
						return window.sessionStorage.getItem(PLAYED_KEY) !== '1';
					} catch (error) {
						return true;
					}
				}

				function markPlayed() {
					try {
						window.sessionStorage.setItem(PLAYED_KEY, '1');
					} catch (error) {
						/* private mode */
					}
				}

				function playFilm(manual) {
					if (disposed || state === null || state.urls.boot === null) return false;
					if (prefersReducedMotion()) return false;
					// A manual preview must not consume "already played this launch", or
					// previewing once would silence the film on the next reload.
					if (manual !== true) markPlayed();
					// A new film supersedes any running one; the generation guard keeps the
					// superseded film's exit callback from releasing the wallpaper hold that
					// the new film is about to need.
					const generation = ++filmGeneration;
					if (film !== null) film.finish();
					film = createBootFilm({
						url: state.urls.boot,
						boot: state.config.boot,
						muted: state.config.boot.muted === true,
						t,
						onDone: () => {
							if (disposed || generation !== filmGeneration) return;
							film = null;
							// The curtain is gone: let a held wallpaper perform its run now,
							// where the user can actually see it.
							wallpaper.resume();
						},
					});
					return true;
				}

				/** Take the viewport for a film: hold the wallpaper, and never leave it held. */
				function startFilm(manual) {
					if (disposed || state === null || state.urls.boot === null) return;
					if (prefersReducedMotion()) return;
					wallpaper.hold();
					if (!playFilm(manual)) wallpaper.resume();
				}

				/** Re-point the surface tokens so the wallpaper can be seen through them. */
				function syncTokens() {
					if (themeService === null) return;
					if (restoreTokens !== null) {
						try {
							restoreTokens();
						} catch (error) {
							/* the layer may already be gone */
						}
						restoreTokens = null;
					}
					if (state === null || state.config.wallpaper.enabled !== true) return;
					try {
						restoreTokens = themeService.overrideTokens(NS, translucentSurfaceTokens(state.config.wallpaper.surfaceAlpha));
					} catch (error) {
						// A rejected override set costs the wallpaper, never the shell.
						restoreTokens = null;
					}
				}

				function syncWallpaper() {
					if (state === null) {
						wallpaper.apply({ enabled: false }, { url: null, mime: null });
						return;
					}
					const media = state.config.media.wallpaper;
					wallpaper.apply(state.config.wallpaper, {
						url: media === null ? null : state.urls.wallpaper,
						mime: media === null ? null : media.mime,
						key: media === null ? null : `${media.file}|${media.bytes}|${media.updatedAt}`,
					});
				}

				function adopt(next) {
					if (disposed || next === null || typeof next !== 'object') return;
					state = next;
					syncTokens();
					syncWallpaper();
					store.emit();
				}

				let loadError = '';
				/** The first probe mount is the page load itself, not a session switch. */
				let probeMounted = false;

				function reload() {
					loadError = '';
					return readState()
						.then((next) => {
							if (disposed) return;
							// Decide from the payload BEFORE adopting it: adopting mounts the
							// wallpaper, and a wallpaper that starts here would begin under the
							// film and be seen only as its final frame. Hold first, then adopt.
							const willPlayFilm = shouldPlayFilm(next) && !prefersReducedMotion();
							if (willPlayFilm) wallpaper.hold();
							adopt(next);
							if (willPlayFilm && !playFilm(false)) wallpaper.resume();
							// The film layer (when it was created) is already opaque and
							// appended above everything, so revealing the app underneath
							// cannot flash.
							releaseFirstPaintCover();
						})
						.catch((cause) => {
							if (disposed) return;
							// The host route is missing or refused (host-side failure, or
							// this half cached after the plugin was removed). Stay plain,
							// but say why in the settings page instead of loading forever.
							loadError = cause !== null && cause !== undefined && cause.message !== undefined
								? String(cause.message)
								: String(cause);
							// No host route means no film either: never leave the app hidden.
							releaseFirstPaintCover();
							store.emit();
						});
				}

				ctx.effect(() => {
					disposed = false;
					unwireBody = onBodyReady(() => {
						reload();
					});
					return () => {
						disposed = true;
						unwireBody();
						if (film !== null) film.finish();
						releaseFirstPaintCover();
						wallpaper.teardown();
						if (restoreTokens !== null) {
							try {
								restoreTokens();
							} catch (error) {
								/* ignore */
							}
							restoreTokens = null;
						}
						listeners.clear();
					};
				}, 'boot-skin: layers');

				// `theme` is optional: a host that lacks it simply gets no wallpaper
				// translucency instead of a pending entry.
				if (typeof ctx.inject === 'function') {
					ctx.inject(['theme'], (ready) => {
						themeService = ready.theme;
						syncTokens();
					});
				}

				ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'boot-skin: dictionaries');

				ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
					name: 'settings.plugins.tab',
					id: 'boot-skin-settings',
					order: 60,
					label: () => t('meta.title'),
					locale: NS,
				}, (slotProps) => {
					const translate = typeof slotProps.t === 'function' ? slotProps.t : t;
					const [snapshot, setSnapshot] = useState(store.get());
					useEffect(() => store.subscribe(() => setSnapshot(store.get())), []);
					return h(SettingsPage, {
						state: snapshot,
						t: translate,
						loadError,
						onRetry: reload,
						onRefresh: adopt,
						onPreview: () => startFilm(true),
					});
				}));

				// Session-scoped probe: a null-rendering entry whose MOUNT means "the
				// conversation view was (re)entered". Session-scoped slots are torn down
				// and rebuilt on a session switch, which is exactly the moment a `once`
				// wallpaper should replay — and it relies only on an official slot, never
				// on an unpublished session service.
				ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
					name: 'conversation.composer.dock',
					id: 'boot-skin-session-probe',
					order: 900,
					locale: NS,
				}, () => {
					useEffect(() => {
						if (!probeMounted) {
							probeMounted = true;
							return;
						}
						wallpaper.replay();
					}, []);
					return null;
				}));
				} catch (error) {
					try {
						console.error('[boot-skin] failed to start', error);
					} catch (ignored) {
						/* console unavailable */
					}
				}
			},
		};
	},
});
