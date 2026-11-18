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
 * A monitor is either a `calendar` watch (no date: the L1 lowest-price calendar,
 * drawn as a bar chart of the next ~380 days) or a `watch` (a fixed date: only
 * L2 `{min, series}` + the `flights` snapshot from the logged-in browser). Both
 * modes share one rhythm ladder (`CADENCE_MINUTES`) and one wording for it; the
 * watch page is a conclusion block, one merged price trend and a TOP10 flight
 * table, with the Feishu delivery status at the bottom. Rules and the daily
 * digest are gone from the model, so the page neither renders nor edits them.
 *
 * Data comes from this bundle's Host half over same-origin JSON:
 *   GET   /price-watch/api/status                       health, auth, L2 availability
 *   GET   /price-watch/api/monitors                     mode/latest/spark/calendarSummary/nextDue
 *   POST  /price-watch/api/monitors                     flat body; no date ⇒ calendar mode
 *   PATCH /price-watch/api/monitors/:id                 enabled / passengers / params / cadence
 *   DELETE /price-watch/api/monitors/:id
 *   GET   /price-watch/api/monitors/:id/calendar        the ~380-day snapshot (calendar mode)
 *   GET   /price-watch/api/monitors/:id/flights         last L2 snapshot + tax split
 *   GET   /price-watch/api/monitors/:id/prices?days=90   `min` trend + per-passenger series
 *   POST  /price-watch/api/monitors/:id/refresh          collect once, right now
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
		/**
		 * The one rhythm ladder both modes share (spec A1 v2 §1): 30m / 1h / 3h /
		 * 6h / 12h / 24h. Anything else is clamped upward to the next bucket.
		 */
		const CADENCE_MINUTES = [30, 60, 180, 360, 720, 1440];
		/** Host default when a monitor carries no rhythm of its own. */
		const CADENCE_DEFAULT = 360;
		/** How much history the watch charts ask for. */
		const PRICE_DAYS = 90;
		const SPARK_WIDTH = 120;
		const SPARK_HEIGHT = 32;
		const CHART_WIDTH = 800;
		const CHART_HEIGHT = 220;
		const CHART_COMPACT_HEIGHT = 150;
		const CALENDAR_HEIGHT = 190;
		const PASSENGER_TYPES = ['adult', 'student', 'child'];
		/** Chinese airports offered by the city search; the dictionary owns their names. */
		/**
		 * Built-in city / airport catalog, ordered roughly by traffic so an empty
		 * query already shows the majors. `zh` + `en` are display names, `intl` marks
		 * a non-mainland destination (the picker groups by it), and `alias` carries the
		 * nicknames people actually type (「浦东」「大兴」「潮汕」…). Search matches the
		 * Chinese name, its aliases and the IATA code — never the English name, so a
		 * stray latin word does not surface a city by accident.
		 *
		 * Add a row here and everything downstream (new-monitor picker, card subtitle,
		 * pin flow) picks it up: nothing assumes mainland-only routes.
		 */
		const CITIES = [
			// ── mainland China ────────────────────────────────────────────────────
			{ code: 'BJS', zh: '北京', en: 'Beijing', intl: false },
			{ code: 'SHA', zh: '上海', en: 'Shanghai', intl: false, alias: { zh: ['上海虹桥', '虹桥'] } },
			{ code: 'CAN', zh: '广州', en: 'Guangzhou', intl: false },
			{ code: 'SZX', zh: '深圳', en: 'Shenzhen', intl: false },
			{ code: 'CTU', zh: '成都', en: 'Chengdu', intl: false },
			{ code: 'CKG', zh: '重庆', en: 'Chongqing', intl: false },
			{ code: 'XIY', zh: '西安', en: "Xi'an", intl: false },
			{ code: 'HGH', zh: '杭州', en: 'Hangzhou', intl: false },
			{ code: 'NKG', zh: '南京', en: 'Nanjing', intl: false },
			{ code: 'WUH', zh: '武汉', en: 'Wuhan', intl: false },
			{ code: 'CSX', zh: '长沙', en: 'Changsha', intl: false },
			{ code: 'TAO', zh: '青岛', en: 'Qingdao', intl: false },
			{ code: 'XMN', zh: '厦门', en: 'Xiamen', intl: false },
			{ code: 'TSN', zh: '天津', en: 'Tianjin', intl: false },
			{ code: 'CGO', zh: '郑州', en: 'Zhengzhou', intl: false },
			{ code: 'SYX', zh: '三亚', en: 'Sanya', intl: false },
			{ code: 'HAK', zh: '海口', en: 'Haikou', intl: false },
			{ code: 'HRB', zh: '哈尔滨', en: 'Harbin', intl: false },
			{ code: 'SHE', zh: '沈阳', en: 'Shenyang', intl: false },
			{ code: 'DLC', zh: '大连', en: 'Dalian', intl: false },
			{ code: 'KMG', zh: '昆明', en: 'Kunming', intl: false },
			{ code: 'KWE', zh: '贵阳', en: 'Guiyang', intl: false },
			{ code: 'NNG', zh: '南宁', en: 'Nanning', intl: false },
			{ code: 'URC', zh: '乌鲁木齐', en: 'Urumqi', intl: false },
			{ code: 'FOC', zh: '福州', en: 'Fuzhou', intl: false },
			{ code: 'TNA', zh: '济南', en: 'Jinan', intl: false },
			{ code: 'WNZ', zh: '温州', en: 'Wenzhou', intl: false },
			{ code: 'NGB', zh: '宁波', en: 'Ningbo', intl: false },
			{ code: 'HFE', zh: '合肥', en: 'Hefei', intl: false },
			{ code: 'ZUH', zh: '珠海', en: 'Zhuhai', intl: false },
			{ code: 'LHW', zh: '兰州', en: 'Lanzhou', intl: false },
			{ code: 'TYN', zh: '太原', en: 'Taiyuan', intl: false },
			{ code: 'HET', zh: '呼和浩特', en: 'Hohhot', intl: false },
			{ code: 'SJW', zh: '石家庄', en: 'Shijiazhuang', intl: false },
			{ code: 'INC', zh: '银川', en: 'Yinchuan', intl: false },
			{ code: 'XNN', zh: '西宁', en: 'Xining', intl: false },
			{ code: 'CGQ', zh: '长春', en: 'Changchun', intl: false },
			{ code: 'LXA', zh: '拉萨', en: 'Lhasa', intl: false },
			{ code: 'PEK', zh: '北京首都', en: 'Beijing Capital', intl: false, alias: { zh: ['首都', '首都机场'] } },
			{ code: 'PKX', zh: '北京大兴', en: 'Beijing Daxing', intl: false, alias: { zh: ['大兴', '大兴机场'] } },
			{ code: 'PVG', zh: '上海浦东', en: 'Shanghai Pudong', intl: false, alias: { zh: ['浦东', '浦东机场'] } },
			{ code: 'TFU', zh: '成都天府', en: 'Chengdu Tianfu', intl: false, alias: { zh: ['天府', '天府机场'] } },
			{ code: 'WUX', zh: '无锡', en: 'Wuxi', intl: false },
			{ code: 'CZX', zh: '常州', en: 'Changzhou', intl: false },
			{ code: 'XUZ', zh: '徐州', en: 'Xuzhou', intl: false },
			{ code: 'YTY', zh: '扬州', en: 'Yangzhou', intl: false, alias: { zh: ['扬州泰州', '泰州'] } },
			{ code: 'NTG', zh: '南通', en: 'Nantong', intl: false },
			{ code: 'YNZ', zh: '盐城', en: 'Yancheng', intl: false },
			{ code: 'LYG', zh: '连云港', en: 'Lianyungang', intl: false },
			{ code: 'HIA', zh: '淮安', en: "Huai'an", intl: false },
			{ code: 'WHA', zh: '芜湖', en: 'Wuhu', intl: false, alias: { zh: ['芜宣'] } },
			{ code: 'JUH', zh: '池州', en: 'Chizhou', intl: false, alias: { zh: ['九华山'] } },
			{ code: 'TXN', zh: '黄山', en: 'Huangshan', intl: false, alias: { zh: ['屯溪'] } },
			{ code: 'AQG', zh: '安庆', en: 'Anqing', intl: false },
			{ code: 'FUG', zh: '阜阳', en: 'Fuyang', intl: false },
			{ code: 'YIW', zh: '义乌', en: 'Yiwu', intl: false },
			{ code: 'HSN', zh: '舟山', en: 'Zhoushan', intl: false, alias: { zh: ['普陀山'] } },
			{ code: 'HYN', zh: '台州', en: 'Taizhou', intl: false, alias: { zh: ['黄岩'] } },
			{ code: 'JUZ', zh: '衢州', en: 'Quzhou', intl: false },
			{ code: 'KHN', zh: '南昌', en: 'Nanchang', intl: false },
			{ code: 'KOW', zh: '赣州', en: 'Ganzhou', intl: false },
			{ code: 'JDZ', zh: '景德镇', en: 'Jingdezhen', intl: false },
			{ code: 'JIU', zh: '九江', en: 'Jiujiang', intl: false, alias: { zh: ['庐山'] } },
			{ code: 'JGS', zh: '井冈山', en: 'Jinggangshan', intl: false },
			{ code: 'YIC', zh: '宜春', en: 'Yichun (Jiangxi)', intl: false },
			{ code: 'SQD', zh: '上饶', en: 'Shangrao', intl: false },
			{ code: 'JJN', zh: '泉州', en: 'Quanzhou', intl: false, alias: { zh: ['晋江'] } },
			{ code: 'WUS', zh: '武夷山', en: 'Wuyishan', intl: false },
			{ code: 'SQJ', zh: '三明', en: 'Sanming', intl: false },
			{ code: 'LCX', zh: '连城', en: 'Liancheng', intl: false, alias: { zh: ['龙岩'] } },
			{ code: 'SWA', zh: '揭阳', en: 'Jieyang', intl: false, alias: { zh: ['潮汕', '汕头'] } },
			{ code: 'ZHA', zh: '湛江', en: 'Zhanjiang', intl: false },
			{ code: 'MXZ', zh: '梅州', en: 'Meizhou', intl: false },
			{ code: 'HUZ', zh: '惠州', en: 'Huizhou', intl: false },
			{ code: 'FUO', zh: '佛山', en: 'Foshan', intl: false },
			{ code: 'KWL', zh: '桂林', en: 'Guilin', intl: false },
			{ code: 'LZH', zh: '柳州', en: 'Liuzhou', intl: false },
			{ code: 'BHY', zh: '北海', en: 'Beihai', intl: false },
			{ code: 'WUZ', zh: '梧州', en: 'Wuzhou', intl: false },
			{ code: 'AEB', zh: '百色', en: 'Baise', intl: false },
			{ code: 'HCJ', zh: '河池', en: 'Hechi', intl: false },
			{ code: 'YLX', zh: '玉林', en: 'Yulin (Guangxi)', intl: false },
			{ code: 'BAR', zh: '琼海', en: 'Qionghai', intl: false, alias: { zh: ['博鳌'] } },
			{ code: 'DYG', zh: '张家界', en: 'Zhangjiajie', intl: false },
			{ code: 'CGD', zh: '常德', en: 'Changde', intl: false },
			{ code: 'HJJ', zh: '怀化', en: 'Huaihua', intl: false },
			{ code: 'HNY', zh: '衡阳', en: 'Hengyang', intl: false },
			{ code: 'WGN', zh: '邵阳', en: 'Shaoyang', intl: false, alias: { zh: ['武冈'] } },
			{ code: 'YYA', zh: '岳阳', en: 'Yueyang', intl: false },
			{ code: 'LLF', zh: '永州', en: 'Yongzhou', intl: false },
			{ code: 'YIH', zh: '宜昌', en: 'Yichang', intl: false },
			{ code: 'XFN', zh: '襄阳', en: 'Xiangyang', intl: false },
			{ code: 'WDS', zh: '十堰', en: 'Shiyan', intl: false, alias: { zh: ['武当山'] } },
			{ code: 'ENH', zh: '恩施', en: 'Enshi', intl: false },
			{ code: 'LYA', zh: '洛阳', en: 'Luoyang', intl: false },
			{ code: 'NNY', zh: '南阳', en: 'Nanyang', intl: false },
			{ code: 'XAI', zh: '信阳', en: 'Xinyang', intl: false },
			{ code: 'DAT', zh: '大同', en: 'Datong', intl: false },
			{ code: 'CIH', zh: '长治', en: 'Changzhi', intl: false },
			{ code: 'YCU', zh: '运城', en: 'Yuncheng', intl: false },
			{ code: 'LFQ', zh: '临汾', en: 'Linfen', intl: false },
			{ code: 'WUT', zh: '忻州', en: 'Xinzhou', intl: false, alias: { zh: ['五台山'] } },
			{ code: 'LLV', zh: '吕梁', en: 'Luliang', intl: false },
			{ code: 'BAV', zh: '包头', en: 'Baotou', intl: false },
			{ code: 'DSN', zh: '鄂尔多斯', en: 'Ordos', intl: false },
			{ code: 'CIF', zh: '赤峰', en: 'Chifeng', intl: false },
			{ code: 'TGO', zh: '通辽', en: 'Tongliao', intl: false },
			{ code: 'HLD', zh: '呼伦贝尔', en: 'Hulunbuir', intl: false, alias: { zh: ['海拉尔'] } },
			{ code: 'XIL', zh: '锡林浩特', en: 'Xilinhot', intl: false },
			{ code: 'HLH', zh: '乌兰浩特', en: 'Ulanhot', intl: false },
			{ code: 'NZH', zh: '满洲里', en: 'Manzhouli', intl: false },
			{ code: 'ERL', zh: '二连浩特', en: 'Erenhot', intl: false },
			{ code: 'RLK', zh: '巴彦淖尔', en: 'Bayannur', intl: false },
			{ code: 'WUA', zh: '乌海', en: 'Wuhai', intl: false },
			{ code: 'AXF', zh: '阿拉善左旗', en: 'Alxa Left Banner', intl: false },
			{ code: 'BPE', zh: '秦皇岛', en: 'Qinhuangdao', intl: false },
			{ code: 'TVS', zh: '唐山', en: 'Tangshan', intl: false },
			{ code: 'HDG', zh: '邯郸', en: 'Handan', intl: false },
			{ code: 'ZQZ', zh: '张家口', en: 'Zhangjiakou', intl: false },
			{ code: 'CDE', zh: '承德', en: 'Chengde', intl: false },
			{ code: 'DDG', zh: '丹东', en: 'Dandong', intl: false },
			{ code: 'JNZ', zh: '锦州', en: 'Jinzhou', intl: false },
			{ code: 'CHG', zh: '朝阳', en: 'Chaoyang', intl: false },
			{ code: 'AOG', zh: '鞍山', en: 'Anshan', intl: false, alias: { zh: ['腾鳌'] } },
			{ code: 'CNI', zh: '长海', en: 'Changhai', intl: false },
			{ code: 'YNJ', zh: '延吉', en: 'Yanji', intl: false },
			{ code: 'TNH', zh: '通化', en: 'Tonghua', intl: false },
			{ code: 'NBS', zh: '长白山', en: 'Changbaishan', intl: false },
			{ code: 'DBC', zh: '白城', en: 'Baicheng', intl: false },
			{ code: 'NDG', zh: '齐齐哈尔', en: 'Qiqihar', intl: false },
			{ code: 'MDG', zh: '牡丹江', en: 'Mudanjiang', intl: false },
			{ code: 'JMU', zh: '佳木斯', en: 'Jiamusi', intl: false },
			{ code: 'DQA', zh: '大庆', en: 'Daqing', intl: false },
			{ code: 'JXA', zh: '鸡西', en: 'Jixi', intl: false },
			{ code: 'LDS', zh: '伊春', en: 'Yichun (Heilongjiang)', intl: false },
			{ code: 'OHE', zh: '漠河', en: 'Mohe', intl: false },
			{ code: 'HEK', zh: '黑河', en: 'Heihe', intl: false },
			{ code: 'JGD', zh: '加格达奇', en: 'Jiagedaqi', intl: false },
			{ code: 'UYN', zh: '榆林', en: 'Yulin (Shaanxi)', intl: false },
			{ code: 'ENY', zh: '延安', en: "Yan'an", intl: false },
			{ code: 'HZG', zh: '汉中', en: 'Hanzhong', intl: false },
			{ code: 'AKA', zh: '安康', en: 'Ankang', intl: false },
			{ code: 'DNH', zh: '敦煌', en: 'Dunhuang', intl: false },
			{ code: 'JGN', zh: '嘉峪关', en: 'Jiayuguan', intl: false },
			{ code: 'YZY', zh: '张掖', en: 'Zhangye', intl: false },
			{ code: 'IQN', zh: '庆阳', en: 'Qingyang', intl: false },
			{ code: 'THQ', zh: '天水', en: 'Tianshui', intl: false },
			{ code: 'JIC', zh: '金昌', en: 'Jinchang', intl: false },
			{ code: 'LNL', zh: '陇南', en: 'Longnan', intl: false },
			{ code: 'GXH', zh: '夏河', en: 'Xiahe', intl: false },
			{ code: 'GOQ', zh: '格尔木', en: 'Golmud', intl: false },
			{ code: 'YUS', zh: '玉树', en: 'Yushu', intl: false },
			{ code: 'GMQ', zh: '果洛', en: 'Golog', intl: false },
			{ code: 'HTT', zh: '花土沟', en: 'Huatugou', intl: false },
			{ code: 'HXD', zh: '德令哈', en: 'Delingha', intl: false },
			{ code: 'ZHY', zh: '中卫', en: 'Zhongwei', intl: false, alias: { zh: ['沙坡头'] } },
			{ code: 'GYU', zh: '固原', en: 'Guyuan', intl: false },
			{ code: 'KHG', zh: '喀什', en: 'Kashgar', intl: false },
			{ code: 'YIN', zh: '伊宁', en: 'Yining', intl: false },
			{ code: 'KRL', zh: '库尔勒', en: 'Korla', intl: false },
			{ code: 'AKU', zh: '阿克苏', en: 'Aksu', intl: false },
			{ code: 'HTN', zh: '和田', en: 'Hotan', intl: false },
			{ code: 'KRY', zh: '克拉玛依', en: 'Karamay', intl: false },
			{ code: 'AAT', zh: '阿勒泰', en: 'Altay', intl: false },
			{ code: 'TCG', zh: '塔城', en: 'Tacheng', intl: false },
			{ code: 'KCA', zh: '库车', en: 'Kuqa', intl: false },
			{ code: 'HMI', zh: '哈密', en: 'Hami', intl: false },
			{ code: 'TLQ', zh: '吐鲁番', en: 'Turpan', intl: false },
			{ code: 'BPL', zh: '博乐', en: 'Bole', intl: false },
			{ code: 'FYN', zh: '富蕴', en: 'Fuyun', intl: false },
			{ code: 'KJI', zh: '布尔津', en: 'Burqin', intl: false, alias: { zh: ['喀纳斯'] } },
			{ code: 'RKZ', zh: '日喀则', en: 'Shigatse', intl: false },
			{ code: 'LZY', zh: '林芝', en: 'Nyingchi', intl: false },
			{ code: 'BPX', zh: '昌都', en: 'Qamdo', intl: false },
			{ code: 'NGQ', zh: '阿里', en: 'Ngari', intl: false },
			{ code: 'MIG', zh: '绵阳', en: 'Mianyang', intl: false },
			{ code: 'YBP', zh: '宜宾', en: 'Yibin', intl: false },
			{ code: 'LZO', zh: '泸州', en: 'Luzhou', intl: false },
			{ code: 'NAO', zh: '南充', en: 'Nanchong', intl: false },
			{ code: 'DZH', zh: '达州', en: 'Dazhou', intl: false },
			{ code: 'XIC', zh: '西昌', en: 'Xichang', intl: false },
			{ code: 'PZI', zh: '攀枝花', en: 'Panzhihua', intl: false },
			{ code: 'JZH', zh: '九寨沟', en: 'Jiuzhaigou', intl: false },
			{ code: 'GYS', zh: '广元', en: 'Guangyuan', intl: false },
			{ code: 'BZX', zh: '巴中', en: 'Bazhong', intl: false },
			{ code: 'GZG', zh: '甘孜', en: 'Garze', intl: false },
			{ code: 'DCY', zh: '稻城', en: 'Daocheng', intl: false, alias: { zh: ['亚丁'] } },
			{ code: 'KGT', zh: '康定', en: 'Kangding', intl: false },
			{ code: 'WXN', zh: '万州', en: 'Wanzhou', intl: false },
			{ code: 'JIQ', zh: '黔江', en: 'Qianjiang', intl: false },
			{ code: 'LJG', zh: '丽江', en: 'Lijiang', intl: false },
			{ code: 'DLU', zh: '大理', en: 'Dali', intl: false },
			{ code: 'JHG', zh: '西双版纳', en: 'Xishuangbanna', intl: false, alias: { zh: ['景洪', '版纳'] } },
			{ code: 'DIG', zh: '香格里拉', en: 'Shangri-La', intl: false, alias: { zh: ['迪庆'] } },
			{ code: 'TCZ', zh: '腾冲', en: 'Tengchong', intl: false },
			{ code: 'BSD', zh: '保山', en: 'Baoshan', intl: false },
			{ code: 'LNJ', zh: '临沧', en: 'Lincang', intl: false },
			{ code: 'ZAT', zh: '昭通', en: 'Zhaotong', intl: false },
			{ code: 'WNH', zh: '文山', en: 'Wenshan', intl: false },
			{ code: 'SYM', zh: '普洱', en: "Pu'er", intl: false, alias: { zh: ['思茅'] } },
			{ code: 'CWJ', zh: '沧源', en: 'Cangyuan', intl: false },
			{ code: 'NLH', zh: '泸沽湖', en: 'Lugu Lake', intl: false, alias: { zh: ['宁蒗'] } },
			{ code: 'ZYI', zh: '遵义', en: 'Zunyi', intl: false },
			{ code: 'ACX', zh: '兴义', en: 'Xingyi', intl: false },
			{ code: 'TEN', zh: '铜仁', en: 'Tongren', intl: false },
			{ code: 'LLB', zh: '荔波', en: 'Libo', intl: false },
			{ code: 'AVA', zh: '安顺', en: 'Anshun', intl: false },
			{ code: 'BFJ', zh: '毕节', en: 'Bijie', intl: false },
			{ code: 'LPF', zh: '六盘水', en: 'Liupanshui', intl: false },
			{ code: 'HZH', zh: '黎平', en: 'Liping', intl: false },
			// ── international ─────────────────────────────────────────────────────
			{ code: 'HKG', zh: '香港', en: 'Hong Kong', intl: true },
			{ code: 'TPE', zh: '台北', en: 'Taipei', intl: true },
			{ code: 'TSA', zh: '台北松山', en: 'Taipei Songshan', intl: true, alias: { zh: ['松山'] } },
			{ code: 'KHH', zh: '高雄', en: 'Kaohsiung', intl: true },
			{ code: 'NRT', zh: '东京成田', en: 'Tokyo Narita', intl: true, alias: { zh: ['成田'] } },
			{ code: 'HND', zh: '东京羽田', en: 'Tokyo Haneda', intl: true, alias: { zh: ['羽田'] } },
			{ code: 'KIX', zh: '大阪关西', en: 'Osaka Kansai', intl: true, alias: { zh: ['关西', '大阪'] } },
			{ code: 'ICN', zh: '首尔仁川', en: 'Seoul Incheon', intl: true, alias: { zh: ['仁川'] } },
			{ code: 'GMP', zh: '首尔金浦', en: 'Seoul Gimpo', intl: true, alias: { zh: ['金浦'] } },
			{ code: 'SIN', zh: '新加坡', en: 'Singapore', intl: true },
			{ code: 'BKK', zh: '曼谷', en: 'Bangkok', intl: true },
			{ code: 'KUL', zh: '吉隆坡', en: 'Kuala Lumpur', intl: true },
			{ code: 'SGN', zh: '胡志明市', en: 'Ho Chi Minh City', intl: true, alias: { zh: ['西贡'] } },
			{ code: 'HAN', zh: '河内', en: 'Hanoi', intl: true },
			{ code: 'DAD', zh: '岘港', en: 'Da Nang', intl: true },
			{ code: 'MNL', zh: '马尼拉', en: 'Manila', intl: true },
			{ code: 'CGK', zh: '雅加达', en: 'Jakarta', intl: true },
			{ code: 'DXB', zh: '迪拜', en: 'Dubai', intl: true },
			{ code: 'LHR', zh: '伦敦', en: 'London', intl: true },
			{ code: 'CDG', zh: '巴黎', en: 'Paris', intl: true },
			{ code: 'FRA', zh: '法兰克福', en: 'Frankfurt', intl: true },
			{ code: 'AMS', zh: '阿姆斯特丹', en: 'Amsterdam', intl: true },
			{ code: 'ZRH', zh: '苏黎世', en: 'Zurich', intl: true },
			{ code: 'JFK', zh: '纽约', en: 'New York', intl: true },
			{ code: 'LAX', zh: '洛杉矶', en: 'Los Angeles', intl: true },
			{ code: 'SFO', zh: '旧金山', en: 'San Francisco', intl: true },
			{ code: 'SEA', zh: '西雅图', en: 'Seattle', intl: true },
			{ code: 'YVR', zh: '温哥华', en: 'Vancouver', intl: true },
			{ code: 'SYD', zh: '悉尼', en: 'Sydney', intl: true },
			{ code: 'MEL', zh: '墨尔本', en: 'Melbourne', intl: true },
			{ code: 'AKL', zh: '奥克兰', en: 'Auckland', intl: true },
			{ code: 'DEL', zh: '德里', en: 'Delhi', intl: true },
			{ code: 'IST', zh: '伊斯坦布尔', en: 'Istanbul', intl: true },
			{ code: 'SVO', zh: '莫斯科', en: 'Moscow', intl: true },
		];
		/** `code` → catalog row, and a lowercased search haystack per row. */
		const CITY_BY_CODE = new Map();
		const CITY_ROWS = CITIES.map((entry) => {
			const aliases = entry.alias && Array.isArray(entry.alias.zh) ? entry.alias.zh : [];
			const row = { code: entry.code, zh: entry.zh, en: entry.en, intl: entry.intl === true, aliases };
			// Searchable text is the Chinese name plus its aliases; the IATA code is
			// matched separately and the English name is display-only (typing "shang"
			// must not silently turn into a city).
			row.haystack = [row.zh].concat(row.aliases).map((text) => text.toLowerCase());
			CITY_BY_CODE.set(row.code, row);
			return row;
		});
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
			/** Active host locale; the city catalog keeps a zh and an en name per row. */
			activeLocale: 'zh',
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
		/** Catalog row for a IATA code, or null when the catalog does not know it. */
		function cityEntry(code) {
			const raw = typeof code === 'string' ? code.trim().toUpperCase() : '';
			return raw === '' ? null : CITY_BY_CODE.get(raw) || null;
		}

		/** Localised display name for a code (`BJS` → `北京` / `Beijing`); raw code otherwise. */
		function cityLabel(code) {
			const raw = typeof code === 'string' ? code.trim().toUpperCase() : '';
			if (raw === '') return '—';
			const entry = cityEntry(raw);
			if (entry === null) return raw;
			return runtime.activeLocale === 'en' ? entry.en : entry.zh;
		}

		/** `北京 BJS` — the form the picker writes back into its input. */
		function citySelectionLabel(code) {
			const raw = typeof code === 'string' ? code.trim().toUpperCase() : '';
			if (raw === '') return '';
			return cityEntry(raw) === null ? raw : `${cityLabel(raw)} ${raw}`;
		}

		// #endregion

		// #region monitor helpers
		function monitorParams(monitor) {
			return monitor && typeof monitor === 'object' && monitor.params && typeof monitor.params === 'object' ? monitor.params : {};
		}

		function monitorTrip(monitor) {
			return monitorParams(monitor).trip === 'round' ? 'round' : 'oneway';
		}

		/** `calendar` = no date picked (L1 calendar only); `watch` = dates fixed. */
		function monitorMode(monitor) {
			return monitor && monitor.mode === 'calendar' ? 'calendar' : 'watch';
		}

		/** First-level type from the Host list (`flight` today, `hotel` later). */
		function monitorType(monitor) {
			return monitor && monitor.type === 'hotel' ? 'hotel' : 'flight';
		}

		function tripLabel(trip) {
			return trip === 'round' ? t('card.round') : t('card.oneway');
		}

		/** `上海 → 北京`, using `⇄` for round trips. */
		function monitorRoute(monitor) {
			const params = monitorParams(monitor);
			const arrow = monitorTrip(monitor) === 'round' ? '⇄' : '→';
			return `${cityLabel(params.dep)} ${arrow} ${cityLabel(params.arr)}`;
		}

		/** Card / detail subtitle: `日期待定` or the fixed departure (and return) date. */
		function monitorDates(monitor) {
			const params = monitorParams(monitor);
			const trip = monitorTrip(monitor);
			if (monitorMode(monitor) === 'calendar') return `${tripLabel(trip)} · ${t('card.dateTbd')}`;
			const depart = shortDate(params.departDate);
			if (trip !== 'round') return `${tripLabel('oneway')} · ${depart}`;
			return `${tripLabel('round')} · ${depart} – ${shortDate(params.returnDate)}`;
		}

		/** Host-computed title when present, otherwise the same shape rebuilt locally. */
		function monitorTitle(monitor) {
			if (monitor && typeof monitor.title === 'string' && monitor.title.trim() !== '') return monitor.title;
			const route = monitorRoute(monitor);
			if (monitorMode(monitor) === 'calendar') {
				return monitorTrip(monitor) === 'round' ? `${route} · ${t('card.round')} · ${t('card.dateTbd')}` : `${route} · ${t('card.dateTbd')}`;
			}
			const depart = shortDate(monitorParams(monitor).departDate);
			if (monitorTrip(monitor) !== 'round') return `${route} · ${depart}`;
			return `${route} · ${depart}–${shortDate(monitorParams(monitor).returnDate)}`;
		}

		/** API list `spark` is `[[atISO, total], ...]`, oldest first. */
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

		/** Chart points: `{ at, total, bare?, src?, taxSource? }`, oldest first. */
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
					taxSource: typeof point.taxSource === 'string' ? point.taxSource : '',
				});
			}
			out.sort((left, right) => left.at - right.at);
			return out;
		}

		/** `GET /monitors/:id/calendar` rows are `{ date, total, bare }`, ascending. */
		function normalizeCalendarDays(rows) {
			if (!Array.isArray(rows)) return [];
			const out = [];
			for (const row of rows) {
				if (!row || typeof row !== 'object') continue;
				if (typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;
				if (typeof row.total !== 'number' || !Number.isFinite(row.total)) continue;
				out.push({ date: row.date, total: row.total, bare: typeof row.bare === 'number' && Number.isFinite(row.bare) ? row.bare : null });
			}
			out.sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0));
			return out;
		}

		/** Lowest / highest / average over the calendar, plus the cheapest day. */
		function calendarStats(days) {
			const points = Array.isArray(days) ? days : [];
			if (points.length === 0) return null;
			let min = points[0];
			let max = points[0];
			let sum = 0;
			for (const point of points) {
				if (point.total < min.total) min = point;
				if (point.total > max.total) max = point;
				sum += point.total;
			}
			return { min, max, avg: Math.round(sum / points.length), count: points.length };
		}

		function latestTotal(monitor) {
			const latest = monitor && monitor.latest && typeof monitor.latest === 'object' ? monitor.latest : null;
			if (latest !== null && typeof latest.total === 'number' && Number.isFinite(latest.total)) {
				return { total: latest.total, at: typeof latest.at === 'string' ? latest.at : null, note: typeof latest.note === 'string' ? latest.note : '' };
			}
			const series = normalizeSeries(monitor && monitor.spark);
			if (series.length === 0) return null;
			const last = series[series.length - 1];
			return { total: last.total, at: typeof last.at === 'number' ? new Date(last.at).toISOString() : null, note: '' };
		}

		/** Cheapest day from the lightweight list summary, when the Host sent one. */
		function calendarSummaryOf(monitor) {
			const summary = monitor && monitor.calendarSummary && typeof monitor.calendarSummary === 'object' ? monitor.calendarSummary : null;
			if (summary === null) return null;
			const min = summary.min && typeof summary.min === 'object' && typeof summary.min.date === 'string' ? summary.min : null;
			return {
				fetchedAt: typeof summary.fetchedAt === 'string' ? summary.fetchedAt : null,
				count: numberOrNull(summary.count),
				min: min === null || typeof min.total !== 'number' || !Number.isFinite(min.total) ? null : { date: min.date, total: min.total },
			};
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

		/** `12-03` for the calendar axis and the pin button. */
		function monthDay(date) {
			const parsed = toDate(date);
			if (parsed === null || !Number.isFinite(parsed.getTime())) return '—';
			return `${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`;
		}

		/** A monitor's own rhythm in minutes, or null when it inherits the default. */
		function monitorCadence(monitor) {
			const cadence = monitor && monitor.cadence && typeof monitor.cadence === 'object' ? monitor.cadence : {};
			return clampCadence(cadence.minutes);
		}

		/** Clamp any value up to the next legal bucket (120 → 180, 240 → 360). */
		function clampCadence(value) {
			const minutes = numberOrNull(value);
			if (minutes === null || minutes <= 0) return null;
			for (const bucket of CADENCE_MINUTES) {
				if (minutes <= bucket) return bucket;
			}
			return CADENCE_MINUTES[CADENCE_MINUTES.length - 1];
		}

		/** Bucket for a page-level default, never null. */
		function defaultCadence(value) {
			const clamped = clampCadence(value);
			return clamped === null ? CADENCE_DEFAULT : clamped;
		}

		/** `30 分钟` / `1 小时` — a duration, no "every" prefix. */
		function cadenceDuration(minutes) {
			const clamped = clampCadence(minutes);
			if (clamped === null) return '—';
			return clamped < 60 ? t('cadence.unit.minutes', { n: clamped }) : t('cadence.unit.hours', { n: clamped / 60 });
		}

		/** `每 6 小时` — the one wording both modes use. */
		function cadenceEvery(minutes) {
			const clamped = clampCadence(minutes);
			if (clamped === null) return '—';
			return t('cadence.every', { value: cadenceDuration(clamped) });
		}

		/**
		 * Last collection failure for one monitor, tolerant of where the Host puts
		 * it: the monitor row itself, `/status.failures[id]`, or the legacy `l2`
		 * block on the row. Absent everywhere ⇒ null.
		 */
		function monitorFailure(monitor, status) {
			const asMessage = (value) => {
				if (typeof value === 'string' && value.trim() !== '') return value.trim();
				if (value && typeof value === 'object' && typeof value.message === 'string' && value.message.trim() !== '') return value.message.trim();
				return null;
			};
			if (monitor && typeof monitor === 'object') {
				const direct = asMessage(monitor.lastError) || asMessage(monitor.error);
				if (direct !== null) return direct;
				if (monitor.l2 && typeof monitor.l2 === 'object') {
					const nested = asMessage(monitor.l2.lastError);
					if (nested !== null) return nested;
				}
			}
			const failures = status && typeof status.failures === 'object' && !Array.isArray(status.failures) ? status.failures : null;
			if (failures !== null && monitor && typeof monitor.id === 'string') {
				const hit = asMessage(failures[monitor.id]);
				if (hit !== null) return hit;
			}
			return null;
		}

		/**
		 * Ranked city search: exact code / exact Chinese name / exact alias / name
		 * prefix / code prefix / substring. Results are grouped domestic-first so the
		 * picker can render 国内 / 国际; at most nine rows come back.
		 *
		 * A three-letter query the catalog does not know also yields a `fallback` row
		 * (`直接使用 XXX`) so the user can still type an airport we have not listed.
		 */
		function citySearch(query) {
			const raw = typeof query === 'string' ? query.trim() : '';
			const lower = raw.toLowerCase();
			const fallback = /^[A-Za-z]{3}$/.test(raw) && cityEntry(raw) === null ? { code: raw.toUpperCase(), fallback: true } : null;
			if (raw === '') {
				const popular = CITY_ROWS.filter((row) => !row.intl).slice(0, 9);
				return { results: popular.map(cityRowResult), fallback: null };
			}
			// A finished pick ("北京 BJS") searches by the code it ends with.
			const tail = /(?:^|\s)([A-Za-z]{3})$/.exec(raw);
			const codeQuery = tail !== null ? tail[1].toUpperCase() : raw.toUpperCase();
			const ranked = [];
			for (const row of CITY_ROWS) {
				const rank = cityMatchRank(row, lower, codeQuery);
				if (rank === null) continue;
				ranked.push({ row, rank });
			}
			ranked.sort((left, right) => left.rank - right.rank);
			const domestic = ranked.filter((item) => item.row.intl !== true);
			const international = ranked.filter((item) => item.row.intl === true);
			return { results: domestic.concat(international).slice(0, 9).map((item) => cityRowResult(item.row)), fallback };
		}

		function cityRowResult(row) {
			return { code: row.code, name: runtime.activeLocale === 'en' ? row.en : row.zh, intl: row.intl };
		}

		function cityMatchRank(row, lower, codeQuery) {
			if (row.code === codeQuery) return 0;
			if (row.zh.toLowerCase() === lower) return 1;
			for (const alias of row.aliases) {
				if (alias.toLowerCase() === lower) return 2;
			}
			for (const text of row.haystack) {
				if (text.startsWith(lower)) return 3;
			}
			if (row.code.startsWith(codeQuery)) return 4;
			for (const text of row.haystack) {
				if (text.indexOf(lower) >= 0) return 5;
			}
			return null;
		}

		/**
		 * Resolve typed text to a three-letter code: `BJS`, `北京 BJS`, an exact Chinese
		 * name or an alias. A bare three-letter string always resolves (the Host is the
		 * one that validates it), so an unlisted airport can still be submitted.
		 */
		function resolveCity(query) {
			const raw = typeof query === 'string' ? query.trim() : '';
			if (raw === '') return null;
			const tail = /(?:^|\s)([A-Za-z]{3})$/.exec(raw);
			if (tail !== null) return tail[1].toUpperCase();
			const lower = raw.toLowerCase();
			for (const row of CITY_ROWS) {
				if (row.zh.toLowerCase() === lower) return row.code;
				for (const alias of row.aliases) {
					if (alias.toLowerCase() === lower) return row.code;
				}
			}
			return null;
		}

		/**
		 * L2 (logged-in browser) availability. In the simplified model `status.l2` is
		 * only `{ available, lastError }` — no daily budget, no minimum interval and
		 * no backoff window — but old Hosts may still carry the flags on `auth`.
		 */
		function l2State(status) {
			const source = status && typeof status === 'object' ? status : {};
			const l2 = source.l2 && typeof source.l2 === 'object' ? source.l2 : {};
			const auth = source.auth && typeof source.auth === 'object' ? source.auth : {};
			return {
				available: typeof l2.available === 'boolean' ? l2.available : auth.available !== false,
				lastError: typeof l2.lastError === 'string' && l2.lastError.trim() !== '' ? l2.lastError.trim() : null,
			};
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
			'nav': '价格监控',
			'list.new': '新建监控',
			'list.settings': '设置',
			'list.refresh': '刷新',
			'list.newHotelHint': '酒店监控即将支持',
			'filter.all': '全部',
			'filter.calendar': '行情',
			'filter.watch': '监控',
			'filter.type.flight': '机票',
			'filter.type.hotel': '酒店',
			'filter.type.label': '监控类型',
			'filter.mode.label': '监控模式',
			'status.ok': '采集正常',
			'status.warn': '采集异常',
			'status.never': '尚未采集',
			'status.last': '上次 {time}',
			'status.auth.unknown': '未登录',
			'status.auth.valid': '已登录',
			'status.auth.expired': '登录已过期',
			'status.auth.validAccount': '已登录 {account}',
			'status.auth.unavailable': '采集不可用',
			'status.auth.loggingIn': '请在弹出的窗口里登录…',
			'login.failed': '登录未完成，请重试',
			'login.notDetected': '未检测到登录，可重试',
			'login.logoutFailed': '退出登录失败，请重试',
			'login.pending': '登录中…',
			'card.oneway': '单程',
			'card.round': '往返',
			'card.mode.calendar': '行情',
			'card.mode.watch': '监控',
			'card.dateTbd': '日期待定',
			'card.waiting': '等待首次采集',
			'card.paused': '已暂停',
			'card.enable': '启用监控',
			'card.disable': '停用监控',
			'card.latest': '最新 {price}',
			'card.lowestDay': '最低 {date}',
			'card.calendarNote': '380 天最低',
			'card.updated': '更新于 {when}',
			'empty.title': '还没有价格监控',
			'empty.body': '没定日期就创建「行情监控」，看未来 380 天的价格日历；定了日期就创建「监控」，追踪价格走势和登录态实付价。',
			'empty.action': '新建监控',
			'empty.filtered': '当前筛选下没有监控。',
			'empty.hotelTitle': '酒店监控还在开发中',
			'empty.hotelBody': '上线后这里会列出酒店监控，现在可以先用机票监控。',
			'error.network': '网络请求失败，请检查连接后重试',
			'error.http': '请求失败（HTTP {status}）',
			'common.retry': '重试',
			'common.dismiss': '关闭',
			'common.saving': '保存中…',
			'common.cancel': '取消',
			'time.justNow': '刚刚',
			'time.minutes': '{n} 分钟前',
			'time.hours': '{n} 小时前',
			'time.days': '{n} 天前',
			'time.never': '从未',
			'type.adult': '成人',
			'type.student': '学生',
			'type.child': '儿童',
			'cadence.unit.minutes': '{n} 分钟',
			'cadence.unit.hours': '{n} 小时',
			'cadence.every': '每 {value}',
			'cadence.title': '采集节奏',
			'cadence.next': '下次采集 {when}',
			'cadence.nextUnknown': '下次采集时间待定',
			'cadence.inherit': '跟随全局默认',
			'cadence.lastError': '上次采集失败：{message}',
			'cadence.interval': '间隔',
			'cadence.edit': '调整节奏',
			'cadence.save': '保存节奏',
			'cadence.failed': '节奏保存失败，请重试',
			'detail.back': '返回',
			'detail.pause': '暂停',
			'detail.resume': '启用',
			'detail.refresh': '立即采集',
			'detail.delete': '删除',
			'detail.deleteConfirm': '删除这个监控？历史数据也会一并移除。',
			'detail.passengersCount': '{n} 位乘客',
			'detail.passengersNone': '未指定乘客',
			'calendar.title': '未来价格日历',
			'calendar.caption': '未来 380 天每天最低含税价',
			'calendar.out': '去程',
			'calendar.back': '回程',
			'calendar.outBeforeBack': '去程必须早于回程',
			'calendar.backAfterOut': '回程必须晚于去程',
			'calendar.empty': '还没有日历数据，稍后会自动刷新',
			'calendar.fetchedAt': '更新于 {when}',
			'calendar.pin': '钉住 {date} · {price}',
			'calendar.pinRound': '钉住 {depart} – {return} · {price}',
			'calendar.pinNeedReturn': '再选一个回程日期',
			'calendar.pinNeedPassenger': '钉住这天会创建「监控」，先选一位乘客',
			'calendar.pinPickPassenger': '选择乘客',
			'calendar.pinCreatePassenger': '新建乘客',
			'calendar.stat.min': '最低',
			'calendar.stat.max': '最高',
			'calendar.stat.avg': '平均',
			'calendar.stat.minDay': '最低日',
			'calendar.dayHint': '{date} · {price}',
			'watch.flights': '航班与待支付价',
			'watch.flightsRound': '去程航班与待支付价',
			'watch.flightsRoundHelp': '去程单买按待支付价升序的前 10 个航班',
			'watch.flightsEmpty': '还没有航班快照，点「立即采集」试试',
			'watch.scheme.round': '联程',
			'watch.scheme.oneway': '两段单买',
			'watch.scheme.listPrice': '列表起价',
			'watch.compare.title': '两种买法对比',
			'watch.compare.partial': '部分数据缺失：{sides}',
			'watch.compare.partialGeneric': '部分数据缺失',
			'watch.compare.join': '、',
			'watch.compare.returnLeg': '回程 {flightNo} {depTime}→{arrTime}',
			'watch.compare.split': '{outLabel} {outPrice} + {backLabel} {backPrice}',
			'watch.compare.roundCheaper': '联程省 {amount}',
			'watch.compare.onewayCheaper': '两段单买省 {amount}',
			'watch.compare.tie': '两者持平',
			'watch.lowestLabel': '当前最低可订价',
			'watch.vsLast': '比上次 {percent}（上次 {price}）',
			'watch.trendTitle': '最低可订价走势',
			'watch.trendEmpty': '还没有采集到实付价，登录携程后点「立即采集」',
			'watch.taxIncluded': '待支付价',
			'watch.seats': '余票',
			'watch.soldOut': '售罄',
			'watch.seatsLeft': '剩 {n} 张',
			'watch.status': '状态',
			'watch.noPrice': '未采到价格',
			'watch.bookable': '可订',
			'watch.priceMissingHint': '该航班未采到价格',
			'watch.flightsHelp': '按待支付价升序的前 10 个航班',
			'delivery.ok': '上次投递：成功 {when}',
			'delivery.failed': '上次投递失败：{error}',
			'delivery.none': '还没有投递记录',
			'delivery.unknownError': '未知错误',
			'watch.flightNo': '航班号',
			'watch.airline': '航司',
			'watch.time': '时刻',
			'watch.craft': '机型',
			'watch.airport': '机场',
			'watch.fetchedAt': '采集于 {when}',
			'chart.title': '价格走势',
			'chart.empty': '还没有数据点',
			'settings.title': '设置',
			'settings.back': '返回',
			'settings.save': '保存设置',
			'settings.saved': '已保存',
			'settings.saving': '保存中…',
			'settings.login': '登录携程',
			'settings.logout': '退出登录',
			'settings.logoutConfirm': '退出登录会删除浏览器里的携程登录信息，确认退出？',
			'settings.auth.title': '用户登录',
			'settings.auth.lastVerified': '上次校验 {time}',
			'settings.auth.neverVerified': '尚未校验登录态',
			'settings.feishu.title': '飞书通知',
			'settings.feishu.label': 'Webhook 地址',
			'settings.feishu.help': '在飞书群聊里添加自定义机器人，粘贴 webhook 地址。',
			'settings.feishu.placeholder': 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
			'settings.notify.channel': '投递方式',
			'settings.notify.channel.app': '企业自建应用（推荐）',
			'settings.notify.channel.webhook': '自定义机器人',
			'settings.notify.appId': 'App ID',
			'settings.notify.appSecret': 'App Secret',
			'settings.notify.appSecretSet': '已设置，留空则不修改',
			'settings.notify.chatId': '群 chat_id',
			'settings.notify.chatIdPlaceholder': 'oc_ 开头的群 ID',
			'settings.notify.chatIdHelp': '把机器人拉进群后，用群设置里的 chat_id。',
			'settings.notify.test': '发送测试消息',
			'settings.notify.testing': '发送中…',
			'settings.notify.testOk': '测试消息已发送。',
			'settings.notify.testFailed': '测试失败：{error}',
			'passengers.title': '乘客',
			'passengers.manage': '管理乘客',
			'passengers.new': '新建乘客',
			'passengers.empty': '还没有乘客。',
			'passengers.nickname': '昵称',
			'passengers.type': '类型',
			'passengers.age': '年龄（可选）',
			'passengers.ageUnit': '岁',
			'passengers.ageInvalid': '年龄需在 0–120 之间。',
			'passengers.nicknameRequired': '请填写昵称。',
			'passengers.add': '添加',
			'passengers.delete': '删除乘客',
			'passengers.deleteConfirm': '删除乘客「{name}」？',
			'passengers.referenced': '该乘客仍被任务引用，请先在任务里取消勾选。',
			'new.title': '新建监控',
			'new.back': '取消',
			'new.route.title': '航线',
			'new.from': '出发地',
			'new.to': '目的地',
			'new.cityPlaceholder': '城市名，如 北京 / 上海浦东',
			'new.cityGroup.domestic': '国内',
			'new.cityGroup.intl': '国际',
			'new.cityUseCode': '直接使用 {code}',
			'new.cityEmpty': '没有匹配的城市',
			'new.trip.title': '行程',
			'new.trip.oneway': '单程',
			'new.trip.round': '往返',
			'new.date.title': '日期',
			'new.date.known': '已确定日期',
			'new.departDate': '出发日',
			'new.returnDate': '返回日',
			'new.passengers.title': '乘客',
			'new.passengers.empty': '还没有乘客，先新建一位。',
			'new.passengers.calendarHint': '行情价按平台最低参考价，与你选的乘客无关，可以不选。',
			'new.advanced.title': '高级选项',
			'new.advanced.cadence': '采集节奏',
			'new.submit.calendar': '创建行情监控',
			'new.submit.watch': '创建监控',
			'new.submitting': '创建中…',
			'new.invalidCode': '请填三字码（如 BJS）或城市名（如北京）。',
			'new.sameCode': '出发地和目的地不能相同。',
			'new.passengerRequired': '至少选择 1 位乘客。',
			'new.returnRequired': '往返需要填写返回日。',
			'new.returnOrder': '返回日必须晚于出发日。',
			'new.departRequired': '请选择出发日。',
		};

		const EN = {
			'nav': 'Price watch',
			'list.new': 'New watch',
			'list.settings': 'Settings',
			'list.refresh': 'Refresh',
			'list.newHotelHint': 'Hotel monitors are coming soon',
			'filter.all': 'All',
			'filter.calendar': 'Calendar',
			'filter.watch': 'Watch',
			'filter.type.flight': 'Flights',
			'filter.type.hotel': 'Hotels',
			'filter.type.label': 'Monitor type',
			'filter.mode.label': 'Monitor mode',
			'status.ok': 'Collector healthy',
			'status.warn': 'Collector failing',
			'status.never': 'Never collected',
			'status.last': 'Last {time}',
			'status.auth.unknown': 'Not signed in',
			'status.auth.valid': 'Signed in',
			'status.auth.expired': 'Sign-in expired',
			'status.auth.validAccount': 'Signed in {account}',
			'status.auth.unavailable': 'Collection unavailable',
			'status.auth.loggingIn': 'Finish signing in in the opened window…',
			'login.failed': 'Sign-in did not complete, try again',
			'login.notDetected': 'No sign-in detected, try again',
			'login.logoutFailed': 'Sign-out failed, try again',
			'login.pending': 'Signing in…',
			'card.oneway': 'One way',
			'card.round': 'Round trip',
			'card.mode.calendar': 'Calendar',
			'card.mode.watch': 'Watch',
			'card.dateTbd': 'dates not fixed',
			'card.waiting': 'Waiting for the first crawl',
			'card.paused': 'Paused',
			'card.enable': 'Enable watch',
			'card.disable': 'Disable watch',
			'card.latest': 'Latest {price}',
			'card.lowestDay': 'Low {date}',
			'card.calendarNote': '380-day low',
			'card.updated': 'Updated {when}',
			'empty.title': 'No price watches yet',
			'empty.body': 'Create a calendar watch when the dates are open: it keeps the next 380 days of lowest fares. Fix the dates for a watch that tracks the price trend and the signed-in real fare.',
			'empty.action': 'New watch',
			'empty.filtered': 'Nothing matches this filter.',
			'empty.hotelTitle': 'Hotel monitors are still in development',
			'empty.hotelBody': 'Hotel price monitoring will show up here once it ships. Flight monitors work today.',
			'error.network': 'Network request failed. Check your connection and retry.',
			'error.http': 'Request failed (HTTP {status})',
			'common.retry': 'Retry',
			'common.dismiss': 'Close',
			'common.saving': 'Saving…',
			'common.cancel': 'Cancel',
			'time.justNow': 'just now',
			'time.minutes': '{n} min ago',
			'time.hours': '{n} h ago',
			'time.days': '{n} d ago',
			'time.never': 'never',
			'type.adult': 'Adult',
			'type.student': 'Student',
			'type.child': 'Child',
			'cadence.unit.minutes': '{n} min',
			'cadence.unit.hours': '{n} h',
			'cadence.every': 'Every {value}',
			'cadence.title': 'Collection rhythm',
			'cadence.next': 'Next run {when}',
			'cadence.nextUnknown': 'Next run not scheduled',
			'cadence.inherit': 'Uses the global default',
			'cadence.lastError': 'Last collection failed: {message}',
			'cadence.interval': 'Interval',
			'cadence.edit': 'Change rhythm',
			'cadence.save': 'Save rhythm',
			'cadence.failed': 'Failed to save the rhythm, try again',
			'detail.back': 'Back',
			'detail.pause': 'Pause',
			'detail.resume': 'Resume',
			'detail.refresh': 'Collect now',
			'detail.delete': 'Delete',
			'detail.deleteConfirm': 'Delete this watch? Its history is removed too.',
			'detail.passengersCount': '{n} passengers',
			'detail.passengersNone': 'No passengers',
			'calendar.title': 'Upcoming price calendar',
			'calendar.caption': 'Lowest tax-included fare for each of the next 380 days',
			'calendar.out': 'Outbound',
			'calendar.back': 'Return',
			'calendar.outBeforeBack': 'Departure must be before the return',
			'calendar.backAfterOut': 'Return must be after the departure',
			'calendar.empty': 'No calendar data yet. It refreshes on schedule.',
			'calendar.fetchedAt': 'Updated {when}',
			'calendar.pin': 'Pin {date} · {price}',
			'calendar.pinRound': 'Pin {depart} – {return} · {price}',
			'calendar.pinNeedReturn': 'Pick a return day too',
			'calendar.pinNeedPassenger': 'Pinning creates a Watch, so pick a passenger first',
			'calendar.pinPickPassenger': 'Pick a passenger',
			'calendar.pinCreatePassenger': 'New passenger',
			'calendar.stat.min': 'Low',
			'calendar.stat.max': 'High',
			'calendar.stat.avg': 'Average',
			'calendar.stat.minDay': 'Cheapest day',
			'calendar.dayHint': '{date} · {price}',
			'watch.flights': 'Flights and payable price',
			'watch.flightsRound': 'Outbound flights and payable price',
			'watch.flightsRoundHelp': 'Top 10 outbound one-way flights by payable price',
			'watch.flightsEmpty': 'No flight snapshot yet. Try "Collect now".',
			'watch.scheme.round': 'Through ticket',
			'watch.scheme.oneway': 'Two one-ways',
			'watch.scheme.listPrice': 'List price',
			'watch.compare.title': 'Ticket options compared',
			'watch.compare.partial': 'Some data is missing: {sides}',
			'watch.compare.partialGeneric': 'Some data is missing',
			'watch.compare.join': ', ',
			'watch.compare.returnLeg': 'Return {flightNo} {depTime}→{arrTime}',
			'watch.compare.split': '{outLabel} {outPrice} + {backLabel} {backPrice}',
			'watch.compare.roundCheaper': 'Through ticket saves {amount}',
			'watch.compare.onewayCheaper': 'Two one-ways save {amount}',
			'watch.compare.tie': 'Same total',
			'watch.lowestLabel': 'Lowest bookable price',
			'watch.vsLast': '{percent} vs last time ({price})',
			'watch.trendTitle': 'Lowest bookable price trend',
			'watch.trendEmpty': 'No real fares collected yet. Sign in to Ctrip and use "Collect now".',
			'watch.taxIncluded': 'Payable',
			'watch.seats': 'Seats',
			'watch.soldOut': 'Sold out',
			'watch.seatsLeft': '{n} left',
			'watch.status': 'Status',
			'watch.noPrice': 'No price',
			'watch.bookable': 'Bookable',
			'watch.priceMissingHint': 'No price collected for this flight',
			'watch.flightsHelp': 'Top 10 flights by payable price',
			'delivery.ok': 'Last delivery: success {when}',
			'delivery.failed': 'Last delivery failed: {error}',
			'delivery.none': 'No deliveries yet',
			'delivery.unknownError': 'Unknown error',
			'watch.flightNo': 'Flight',
			'watch.airline': 'Airline',
			'watch.time': 'Time',
			'watch.craft': 'Aircraft',
			'watch.airport': 'Airports',
			'watch.fetchedAt': 'Collected {when}',
			'chart.title': 'Price history',
			'chart.empty': 'No data points yet',
			'settings.title': 'Settings',
			'settings.back': 'Back',
			'settings.save': 'Save settings',
			'settings.saved': 'Saved',
			'settings.saving': 'Saving…',
			'settings.login': 'Sign in to Ctrip',
			'settings.logout': 'Sign out',
			'settings.logoutConfirm': 'Signing out deletes the Ctrip session stored in the browser profile. Continue?',
			'settings.auth.title': 'Sign-in',
			'settings.auth.lastVerified': 'Last checked {time}',
			'settings.auth.neverVerified': 'Sign-in has not been checked yet',
			'settings.feishu.title': 'Feishu notifications',
			'settings.feishu.label': 'Webhook URL',
			'settings.feishu.help': 'Add a custom bot to a Feishu group, then paste its webhook URL here.',
			'settings.feishu.placeholder': 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
			'settings.notify.channel': 'Delivery channel',
			'settings.notify.channel.app': 'Custom app (recommended)',
			'settings.notify.channel.webhook': 'Custom bot webhook',
			'settings.notify.appId': 'App ID',
			'settings.notify.appSecret': 'App Secret',
			'settings.notify.appSecretSet': 'Configured — leave empty to keep',
			'settings.notify.chatId': 'Group chat_id',
			'settings.notify.chatIdPlaceholder': 'Group id starting with oc_',
			'settings.notify.chatIdHelp': 'Add the bot to the group, then copy the chat_id from the group settings.',
			'settings.notify.test': 'Send test message',
			'settings.notify.testing': 'Sending…',
			'settings.notify.testOk': 'Test message sent.',
			'settings.notify.testFailed': 'Test failed: {error}',
			'passengers.title': 'Passengers',
			'passengers.manage': 'Manage passengers',
			'passengers.new': 'New passenger',
			'passengers.empty': 'No passengers yet.',
			'passengers.nickname': 'Nickname',
			'passengers.type': 'Type',
			'passengers.age': 'Age (optional)',
			'passengers.ageUnit': 'y',
			'passengers.ageInvalid': 'Age must be between 0 and 120.',
			'passengers.nicknameRequired': 'Nickname is required.',
			'passengers.add': 'Add',
			'passengers.delete': 'Delete passenger',
			'passengers.deleteConfirm': 'Delete passenger "{name}"?',
			'passengers.referenced': 'This passenger is still used by a watch. Uncheck it there first.',
			'new.title': 'New watch',
			'new.back': 'Cancel',
			'new.route.title': 'Route',
			'new.from': 'From',
			'new.to': 'To',
			'new.cityPlaceholder': 'City name or IATA code, e.g. BJS',
			'new.cityGroup.domestic': 'Domestic',
			'new.cityGroup.intl': 'International',
			'new.cityUseCode': 'Use {code}',
			'new.cityEmpty': 'No matching city',
			'new.trip.title': 'Trip',
			'new.trip.oneway': 'One way',
			'new.trip.round': 'Round trip',
			'new.date.title': 'Dates',
			'new.date.known': 'Dates fixed',
			'new.departDate': 'Departure',
			'new.returnDate': 'Return',
			'new.passengers.title': 'Passengers',
			'new.passengers.empty': 'No passengers yet. Create one first.',
			'new.passengers.calendarHint': 'Calendar fares are the platform lowest reference price and do not depend on passengers — leaving this empty is fine.',
			'new.advanced.title': 'Advanced',
			'new.advanced.cadence': 'Collection rhythm',
			'new.submit.calendar': 'Create calendar watch',
			'new.submit.watch': 'Create watch',
			'new.submitting': 'Creating…',
			'new.invalidCode': 'Type an IATA code (e.g. BJS) or a city name (e.g. Beijing).',
			'new.sameCode': 'Origin and destination must differ.',
			'new.passengerRequired': 'Pick at least one passenger.',
			'new.returnRequired': 'Round trips need a return date.',
			'new.returnOrder': 'Return must be after departure.',
			'new.departRequired': 'Pick a departure date.',
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
.pw-root { --pw-inset: clamp(24px, 4vw, 48px); --pw-max: 864px; box-sizing: border-box; display: flex; flex-direction: column; flex: 1 1 auto; height: 100%; min-height: 0; overflow: hidden; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px; line-height: 1.5; }
.pw-root *, .pw-root *::before, .pw-root *::after { box-sizing: border-box; }
@media (max-width: 767px) { .pw-root { --pw-inset: 20px; } }
/* page shell: the heading sits inside the scrolling column, like the native task list (28px above, 24px below, no rule) */
.pw-view { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.pw-head { display: flex; flex-direction: column; padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px)); }
.pw-head-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 16px; margin-bottom: 24px; min-width: 0; }
.pw-head-lead { flex: none; display: flex; align-items: center; }
.pw-head-text { display: flex; flex-direction: column; gap: 4px; flex: 0 0 auto; max-width: 100%; min-width: 0; }
.pw-title { margin: 0; font-size: 20px; font-weight: 500; line-height: 28px; letter-spacing: -0.01em; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.pw-intro { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.pw-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.pw-head-actions { display: flex; align-items: center; justify-content: flex-end; gap: 16px; flex-wrap: wrap; flex: none; margin-left: auto; }
.pw-head-icons { display: flex; align-items: center; gap: 4px; margin-right: -8px; }
.pw-head-sub { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; margin-bottom: 14px; }
.pw-status { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.pw-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; scrollbar-width: thin; scrollbar-color: var(--dsw-alias-scrollbar-bg-l2) transparent; }
.pw-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.pw-scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2); border-radius: 999px; }
.pw-scroll::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l2); }
.pw-scroll::-webkit-scrollbar-track { background: transparent; }
.pw-content { width: 100%; max-width: calc(var(--pw-max) + 2 * var(--pw-inset)); margin: 0 auto; padding: 0 var(--pw-inset) 48px; }
.pw-body { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
/* layout helpers */
.pw-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.pw-col { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pw-grow { flex: 1 1 auto; min-width: 0; }
.pw-spacer { flex: 1 1 auto; }
.pw-muted { color: var(--dsw-alias-label-secondary); }
.pw-mono { font-variant-numeric: tabular-nums; }
.pw-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pw-divider { height: .5px; background: var(--dsw-alias-border-l1); }
/* typography */
.pw-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.pw-label { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.pw-group-title { margin: 0; font-size: 13px; font-weight: 600; line-height: 20px; color: var(--dsw-alias-label-primary); }
.pw-linkbtn { padding: 0; border: none; background: none; color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 12px; line-height: 20px; cursor: pointer; }
.pw-linkbtn:hover { color: var(--dsw-alias-label-primary); }
.pw-linkbtn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; border-radius: 4px; }
/* buttons */
.pw-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: var(--dsw-radius-md, 12px); border: .5px solid var(--dsw-alias-border-l3); background: transparent; color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px; line-height: 20px; cursor: pointer; white-space: nowrap; transition: background 120ms ease, border-color 120ms ease, color 120ms ease; }
.pw-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.pw-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.pw-btn:disabled { opacity: 0.4; cursor: default; }
.pw-btn-lg { height: 36px; padding: 0 16px; font-size: 13px; border-radius: var(--dsw-radius-lg, 16px); }
.pw-btn-header { border-radius: 16px; }
.pw-btn-sm { height: 28px; padding: 0 10px; font-size: 12px; border-radius: var(--dsw-radius-sm, 8px); }
.pw-btn-primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary)); color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base)); font-weight: 500; }
.pw-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-label-primary-dimmed)); border-color: transparent; }
.pw-btn-danger { border-color: transparent; color: var(--dsw-alias-state-error-primary); }
.pw-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.pw-iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: none; border-radius: var(--dsw-radius-sm, 8px); background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; transition: background 120ms ease, color 120ms ease; }
.pw-iconbtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.pw-iconbtn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.pw-iconbtn:disabled { opacity: 0.4; cursor: default; }
.pw-iconbtn[data-tone="danger"] { color: var(--dsw-alias-state-error-primary); }
.pw-iconbtn[data-tone="danger"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
/* form */
.pw-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pw-form-row { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
.pw-form-row > .pw-field { flex: 1 1 160px; }
.pw-input { width: 100%; height: 32px; padding: 0 10px; border-radius: var(--dsw-radius-md, 12px); border: .5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px; outline: none; transition: border-color 120ms ease, box-shadow 120ms ease; }
.pw-input:hover:not(:disabled) { border-color: var(--dsw-alias-border-l3); }
.pw-input:focus { border-color: var(--dsw-alias-state-business-primary); box-shadow: inset 0 0 0 .5px var(--dsw-alias-state-business-primary); }
.pw-input::placeholder { color: var(--dsw-alias-label-caption); }
.pw-input:disabled { opacity: 0.6; }
.pw-input[data-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); box-shadow: none; }
select.pw-input { padding-right: 6px; cursor: pointer; }
textarea.pw-input { height: auto; min-height: 60px; padding: 8px 10px; resize: vertical; }
/* date field: the whole box opens the native picker */
.pw-date { position: relative; display: flex; width: 100%; cursor: pointer; }
.pw-date input[type="date"] { cursor: pointer; }
.pw-date input[type="date"]::-webkit-calendar-picker-indicator { cursor: pointer; opacity: 0.65; }
/* inline segmented control (trip, modes) */
.pw-seg { display: inline-flex; align-items: center; gap: 2px; height: 30px; padding: 2px; border-radius: var(--dsw-radius-sm, 8px); border: .5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.pw-seg-btn { height: 26px; padding: 0 10px; border: none; border-radius: calc(var(--dsw-radius-sm, 8px) - 2px); background: transparent; color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 12px; line-height: 1; cursor: pointer; white-space: nowrap; transition: background 120ms ease, color 120ms ease; }
.pw-seg-btn:hover { color: var(--dsw-alias-label-primary); }
.pw-seg-btn[data-active="true"] { background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font-weight: 500; }
.pw-seg-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.pw-seg-sm { height: 26px; padding: 2px; gap: 2px; border: .5px solid var(--dsw-alias-border-l1); background: transparent; }
.pw-seg-sm .pw-seg-btn { height: 20px; padding: 0 8px; border-radius: 6px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.pw-seg-sm .pw-seg-btn:hover { color: var(--dsw-alias-label-primary); }
.pw-seg-sm .pw-seg-btn[data-active="true"] { background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font-weight: 500; }
/* filter pills (list page) */
.pw-filters { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; }
.pw-filter-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; width: 100%; min-width: 0; }
.pw-filter-meta-end { display: flex; align-items: center; gap: 8px; margin-left: auto; min-width: 0; }
.pw-filter { display: inline-flex; align-items: center; height: 28px; padding: 0 10px; border: none; border-radius: 14px; background: transparent; color: var(--dsw-alias-label-tertiary); font-family: inherit; font-size: 14px; line-height: 22px; cursor: pointer; white-space: nowrap; }
.pw-filter:hover { background: var(--dsw-alias-interactive-bg-hover); }
.pw-filter[data-active="true"] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.pw-filter:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
/* groups (new-monitor form) */
.pw-form { display: flex; flex-direction: column; gap: 20px; }
.pw-group { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.pw-group-head { display: flex; align-items: center; gap: 8px; min-height: 20px; }
.pw-group-head .pw-linkbtn { margin-left: auto; }
/* cards */
.pw-card { position: relative; display: flex; align-items: center; gap: 14px; padding: 12px 14px; border-radius: var(--dsw-radius-lg, 16px); border: .5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); cursor: pointer; text-align: left; font-family: inherit; color: var(--dsw-alias-label-primary); transition: background 120ms ease, border-color 120ms ease; }
.pw-card:hover { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.pw-card:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; }
.pw-card[data-disabled="true"] { opacity: 0.62; }
.pw-card[data-disabled="true"]:hover { opacity: 0.85; }
.pw-card-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; line-height: 20px; min-width: 0; }
.pw-card-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.pw-list { display: flex; flex-direction: column; gap: 8px; }
.pw-price { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.pw-section { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; border-radius: var(--dsw-radius-lg, 16px); border: .5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.pw-section-head { display: flex; flex-direction: column; gap: 3px; }
.pw-section-title { font-size: 14px; font-weight: 600; line-height: 20px; }
.pw-section-help { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
/* chips, dots, switches */
.pw-chip { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 20px; padding: 0 7px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); font-size: 11px; font-weight: 500; line-height: 1; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pw-chip[data-tone="up"] { color: var(--dsw-alias-state-error-primary); }
.pw-chip[data-tone="down"] { color: var(--dsw-alias-state-success-primary); }
.pw-chip[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.pw-chip[data-tone="flat"] { color: var(--dsw-alias-label-secondary); }
.pw-chip[data-tone="brand"] { color: var(--dsw-alias-state-business-primary); }
.pw-authchip { display: inline-flex; align-items: center; gap: 5px; padding: 0; border: none; background: transparent; color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 12px; font-weight: 400; line-height: 20px; white-space: nowrap; }
.pw-authchip[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
.pw-authchip[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.pw-authchip[data-tone="idle"] { color: var(--dsw-alias-label-secondary); }
.pw-authchip[data-clickable="true"] { cursor: pointer; }
.pw-authchip[data-clickable="true"]:hover { color: var(--dsw-alias-label-primary); }
.pw-authchip[data-clickable="true"]:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.pw-authchip[data-busy="true"] { color: var(--dsw-alias-label-secondary); }
.pw-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex: none; }
.pw-dot[data-tone="ok"] { background: var(--dsw-alias-state-success-primary); }
.pw-dot[data-tone="warn"] { background: var(--dsw-alias-state-warn-primary); }
.pw-dot[data-tone="error"] { background: var(--dsw-alias-state-error-primary); }
.pw-switch { position: relative; flex: none; width: 36px; height: 20px; padding: 0; border-radius: 999px; border: .5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-3); cursor: pointer; transition: background 140ms ease, border-color 140ms ease; }
.pw-switch > span { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--dsw-alias-switch-thumb, var(--dsw-alias-bg-base)); transition: transform 140ms ease; }
.pw-switch[data-state="on"] { background: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-state-business-primary); }
.pw-switch[data-state="on"] > span { transform: translateX(16px); }
.pw-switch:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.pw-switch:disabled { opacity: 0.5; cursor: default; }
/* selectable passenger chips */
.pw-selectable { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border-radius: var(--dsw-radius-md, 12px); border: .5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px; cursor: pointer; transition: border-color 120ms ease, background 120ms ease; }
.pw-selectable:hover { background: var(--dsw-alias-interactive-bg-hover); }
.pw-selectable[data-selected="true"] { border-color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); }
.pw-selectable:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.pw-check { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-state-business-primary); flex: none; }
.pw-selectable[data-selected="true"] .pw-check { border-color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-bg-layer-2); }
/* collapsible advanced block */
.pw-adv { display: flex; flex-direction: column; gap: 12px; padding-top: 12px; border-top: .5px solid var(--dsw-alias-border-l1); }
.pw-adv-toggle { display: inline-flex; align-items: center; gap: 4px; align-self: flex-start; padding: 0; border: none; background: none; color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 12px; line-height: 20px; cursor: pointer; }
.pw-adv-toggle:hover { color: var(--dsw-alias-label-primary); }
.pw-adv-toggle:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; border-radius: 4px; }
.pw-adv-toggle svg { transition: transform 160ms ease; }
.pw-adv-toggle[aria-expanded="true"] svg { transform: rotate(180deg); }
.pw-adv-body { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
/* inline info tip (feishu webhook hint) */
.pw-infowrap { position: relative; display: inline-flex; flex: none; }
.pw-tip { position: absolute; z-index: 20; top: calc(100% + 6px); left: 0; width: max-content; max-width: 260px; padding: 6px 10px; border-radius: var(--dsw-radius-sm, 8px); border: .5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; text-align: left; box-shadow: var(--dsw-elevation-prominent, none); }
.pw-tip[data-align="end"] { left: auto; right: -4px; }
/* dialog (passenger manager) */
.pw-overlay { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--dsw-alias-bg-mask-1); backdrop-filter: var(--dsw-mask-blur, none); }
.pw-dialog { display: flex; flex-direction: column; width: min(520px, 100%); max-height: min(640px, 100%); min-height: 0; overflow: hidden; border-radius: var(--dsw-radius-xl, 20px); border: .5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay); box-shadow: var(--dsw-elevation-prominent, none); }
.pw-dialog:focus { outline: none; }
.pw-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px 10px; }
.pw-dialog-title { margin: 0; font-size: 15px; font-weight: 600; line-height: 22px; }
.pw-dialog-body { display: flex; flex-direction: column; gap: 12px; min-height: 0; overflow: auto; padding: 0 18px 18px; scrollbar-width: thin; }
.pw-listitem { display: flex; align-items: center; gap: 10px; padding: 9px 11px; border-radius: var(--dsw-radius-md, 12px); border: .5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.pw-listitem-name { font-size: 13px; font-weight: 500; }
/* charts */
.pw-chart-wrap { position: relative; width: 100%; }
.pw-chart { display: block; width: 100%; height: auto; overflow: visible; }
.pw-chart[data-hover="true"] { cursor: crosshair; }
.pw-cal-wrap { position: relative; width: 100%; }
.pw-cal { display: block; width: 100%; height: auto; cursor: pointer; }
.pw-cal-bar { transition: opacity 120ms ease; }
.pw-tooltip { position: absolute; transform: translate(-50%, -118%); min-width: 84px; padding: 5px 8px; border-radius: var(--dsw-radius-sm, 8px); border: .5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.45; white-space: nowrap; pointer-events: none; z-index: 2; box-shadow: var(--dsw-elevation-prominent, none); }
.pw-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.pw-stat { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: var(--dsw-radius-md, 12px); border: .5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.pw-stat-label { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.pw-stat-value { font-size: 14px; font-weight: 600; line-height: 20px; font-variant-numeric: tabular-nums; }
.pw-pin-bar { position: sticky; bottom: 0; z-index: 3; display: flex; align-items: center; gap: 10px; margin-top: 4px; padding: 10px 12px; border-radius: var(--dsw-radius-md, 12px); border: .5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay); box-shadow: var(--dsw-elevation-prominent, none); }
/* tables (flight snapshot) */
.pw-table-wrap { width: 100%; overflow-x: auto; }
.pw-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.pw-table th { padding: 8px; text-align: left; font-weight: 500; color: var(--dsw-alias-label-secondary); border-bottom: .5px solid var(--dsw-alias-border-l2); white-space: nowrap; }
.pw-table td { padding: 8px; border-bottom: .5px solid var(--dsw-alias-border-l2); vertical-align: middle; }
.pw-table tbody tr:hover td { background: var(--dsw-alias-interactive-bg-hover); }
.pw-table tbody tr[data-cheapest="true"] td { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent); }
.pw-table tbody tr[data-cheapest="true"] td:first-child { box-shadow: inset 2px 0 0 var(--dsw-alias-state-success-primary); }
.pw-nowrap { white-space: nowrap; }
.pw-table th.pw-seats, .pw-table td.pw-seats { width: 1%; white-space: nowrap; }
.pw-seats[data-tone="normal"] { color: var(--dsw-alias-label-secondary); }
.pw-seats[data-tone="few"] { color: var(--dsw-alias-state-warn-primary); }
.pw-seats[data-tone="soldout"] { color: var(--dsw-alias-state-error-primary); }
.pw-seats[data-tone="none"] { color: var(--dsw-alias-label-tertiary); }
@media (max-width: 760px) { .pw-table .pw-craft { display: none; } }
.pw-table tr:last-child td { border-bottom: none; }
.pw-table .pw-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
/* watch detail bits */
.pw-notice { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-state-success-primary); font-size: 12px; }
/* city combobox */
.pw-combo { position: relative; }
.pw-combo-list { position: absolute; z-index: 5; left: 0; right: 0; top: calc(100% + 4px); max-height: 260px; overflow: auto; padding: 4px; border-radius: var(--dsw-radius-md, 12px); border: .5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay); box-shadow: var(--dsw-elevation-prominent, none); }
.pw-combo-item { display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 6px 8px; border: none; border-radius: var(--dsw-radius-sm, 8px); background: transparent; color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.pw-combo-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.pw-combo-item[data-highlight="true"] { background: var(--dsw-alias-interactive-bg-hover); }
.pw-combo-group { padding: 6px 8px 2px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.pw-combo-fallback { color: var(--dsw-alias-state-business-primary); }
.pw-combo-code { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
/* skeleton, empty, error */
.pw-skeleton { background: var(--dsw-alias-bg-skeleton, var(--dsw-alias-bg-layer-2)); border-radius: 6px; animation: pw-skeleton-pulse 1600ms ease-in-out infinite; }
@keyframes pw-skeleton-pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
.pw-errbar { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--dsw-radius-md, 12px); border: .5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; }
.pw-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 48px 20px; text-align: center; }
.pw-empty-icon { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-caption); }
.pw-empty-title { font-size: 14px; font-weight: 500; line-height: 20px; color: var(--dsw-alias-label-primary); }
.pw-empty-body { max-width: 420px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
/* watch detail: conclusion block + delivery status */
.pw-summary { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 16px; border-radius: var(--dsw-radius-lg, 16px); border: .5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.pw-summary-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.pw-summary-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.pw-summary-price { font-size: 28px; font-weight: 600; line-height: 34px; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.pw-summary-delta { font-size: 12px; line-height: 18px; }
.pw-summary-delta[data-tone="up"] { color: var(--dsw-alias-state-error-primary); }
.pw-summary-delta[data-tone="down"] { color: var(--dsw-alias-state-success-primary); }
.pw-summary-delta[data-tone="flat"] { color: var(--dsw-alias-label-secondary); }
.pw-summary-route { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.pw-summary-scheme { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
/* round-trip comparison card */
.pw-compare-sides { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.pw-compare-side { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: 12px; border-radius: var(--dsw-radius-md, 12px); border: .5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.pw-compare-side[data-cheaper="true"] { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent); }
.pw-compare-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.pw-compare-price { font-size: 20px; font-weight: 600; line-height: 26px; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.pw-compare-side[data-cheaper="true"] .pw-compare-price { color: var(--dsw-alias-state-success-primary); }
.pw-compare-detail { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.pw-compare-verdict { font-size: 13px; line-height: 20px; }
.pw-compare-verdict[data-cheaper="round"], .pw-compare-verdict[data-cheaper="oneway"] { color: var(--dsw-alias-state-success-primary); font-weight: 500; }
.pw-compare-verdict[data-cheaper="tie"] { color: var(--dsw-alias-label-secondary); }
.pw-compare-warning { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-primary); }
@media (max-width: 640px) { .pw-compare-sides { grid-template-columns: minmax(0, 1fr); } }
.pw-delivery { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.pw-delivery[data-ok="false"] { color: var(--dsw-alias-state-error-primary); }
.pw-test-result { font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.pw-test-result[data-ok="true"] { color: var(--dsw-alias-state-success-primary); }
.pw-test-result[data-ok="false"] { color: var(--dsw-alias-state-error-primary); }
.pw-strip-sep { color: var(--dsw-alias-border-l2); }
@media (max-width: 780px) { .pw-spark { display: none; } .pw-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } .pw-head-row { flex-wrap: wrap; } .pw-head-actions { margin-left: 0; } }
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
		const CheckIcon = (props) => svgIcon((props && props.size) || 14, h('path', { d: 'M20 6 9 17l-5-5' }));
		const CloseIcon = (props) => svgIcon((props && props.size) || 14, h('path', { d: 'M6 6l12 12M18 6 6 18' }));
		const AlertIcon = (props) => svgIcon((props && props.size) || 16, [h('circle', { key: 'a', cx: 12, cy: 12, r: 9 }), h('path', { key: 'b', d: 'M12 7.5v5.5' }), h('circle', { key: 'c', cx: 12, cy: 16.5, r: 0.7, fill: 'currentColor', stroke: 'none' })]);
		const TagIcon = (props) => svgIcon((props && props.size) || 20, [
			h('path', { key: 'a', d: 'M4.2 4.2h6.1a2 2 0 0 1 1.42.59l8.1 8.1a2 2 0 0 1 0 2.83l-4.1 4.1a2 2 0 0 1-2.83 0l-8.1-8.1A2 2 0 0 1 4.2 10.3Z' }),
			h('circle', { key: 'b', cx: 7.6, cy: 7.6, r: 1.3 }),
			h('path', { key: 'c', d: 'M8.4 15.6 11.4 12.6 13.6 14.8 18.2 10.2' }),
		]);
		const ChevronDownIcon = (props) => svgIcon((props && props.size) || 14, h('path', { d: 'M6 9.5l6 6 6-6' }));
		const BedIcon = (props) =>
			svgIcon((props && props.size) || 22, [
				h('path', { key: 'a', d: 'M3 19v-6h18v6' }),
				h('path', { key: 'b', d: 'M3 19h18' }),
				h('path', { key: 'c', d: 'M6 13V8.5A1.5 1.5 0 0 1 7.5 7h9A1.5 1.5 0 0 1 18 8.5V13' }),
				h('path', { key: 'd', d: 'M9 13v-2.5h4V13' }),
			]);
		const InfoIcon = (props) =>
			svgIcon((props && props.size) || 14, [
				h('circle', { key: 'a', cx: 12, cy: 12, r: 9 }),
				h('path', { key: 'b', d: 'M12 11v5.5' }),
				h('circle', { key: 'c', cx: 12, cy: 7.8, r: 0.9, fill: 'currentColor', stroke: 'none' }),
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
					'data-tone': props.tone === 'danger' ? 'danger' : undefined,
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
		/** Page shell: one fixed head (title row plus an optional sub row) over one scrolling column. */
		function PageShell(props) {
			// The heading lives inside the scrolling column, exactly like the native
			// task list: 28px above the title, 24px below it, no rule under it.
			// Children are spread as separate arguments so React never sees one bare
			// array and asks for keys on static view content.
			return h(
				'div',
				{ className: 'pw-view' },
				h(
					'div',
					{ className: 'pw-scroll' },
					h(
						'div',
						{ className: 'pw-content' },
						h(
							'header',
							{ className: 'pw-head' },
							h(
								'div',
								{ className: 'pw-head-row' },
								props.lead === undefined || props.lead === null ? null : h('div', { className: 'pw-head-lead' }, props.lead),
								h(
									'div',
									{ className: 'pw-head-text' },
									h('h1', { className: 'pw-title' }, props.title),
									props.intro === undefined || props.intro === null ? null : h('p', { className: 'pw-intro' }, props.intro),
									props.meta === undefined || props.meta === null ? null : h('div', { className: 'pw-meta' }, props.meta)
								),
								props.actions === undefined || props.actions === null ? null : h('div', { className: 'pw-head-actions' }, props.actions)
							),
							props.sub === undefined || props.sub === null ? null : h('div', { className: 'pw-head-sub' }, props.sub)
						),
						h('div', { className: 'pw-body' }, ...(Array.isArray(props.children) ? props.children : [props.children]))
					)
				)
			);
		}

		/** A form group: 13/600 title over 10px-spaced controls. */
		function Group(props) {
			return h(
				'section',
				{ className: 'pw-group' },
				h(
					'div',
					{ className: 'pw-group-head' },
					h('h2', { className: 'pw-group-title' }, props.title),
					props.action === undefined || props.action === null ? null : props.action
				),
				props.children
			);
		}

		/** Inline segmented control: content-width, 30px tall, exactly one selected option. */
		/**
		 * Inline segmented control: content-width, exactly one selected option.
		 * `role="group"` + `aria-pressed` when it acts as a filter, tabs otherwise;
		 * `className` lets a caller ask for the smaller (`pw-seg-sm`) variant.
		 */
		function SegControl(props) {
			const asGroup = props.role === 'group';
			return h(
				'div',
				{ className: ['pw-seg', props.className || null].filter(Boolean).join(' '), role: asGroup ? 'group' : 'tablist', 'aria-label': props.label },
				props.options.map((option) =>
					h(
						'button',
						{
							key: option.id,
							type: 'button',
							role: asGroup ? undefined : 'tab',
							className: 'pw-seg-btn',
							'data-active': props.value === option.id ? 'true' : 'false',
							...(asGroup ? { 'aria-pressed': props.value === option.id ? 'true' : 'false' } : { 'aria-selected': props.value === option.id ? 'true' : 'false' }),
							onClick: () => props.onChange(option.id),
						},
						option.label
					)
				)
			);
		}

		/**
		 * Whole-box date input: the container opens the native picker through
		 * `showPicker()`, and the control keeps `type="date"` so the system calendar
		 * and keyboard entry still work.
		 */
		function DateField(props) {
			const inputRef = useRef(null);
			const openPicker = () => {
				const node = inputRef.current;
				if (node === null || typeof node.showPicker !== 'function') return;
				try {
					node.showPicker();
				} catch (error) {
					// Already open, or the browser refuses a programmatic call: the click
					// on the input itself still opens the native picker.
				}
			};
			return h(
				'div',
				{ className: 'pw-date', onClick: openPicker },
				h('input', {
					ref: inputRef,
					className: 'pw-input',
					type: 'date',
					value: props.value,
					min: props.min,
					disabled: props.disabled === true,
					onChange: (event) => props.onChange(event.target.value),
				})
			);
		}

		/**
		 * ⓘ trigger plus a bubble tip. The tip opens on hover and on keyboard focus
		 * (not just `title`), exposes `role="tooltip"` and is wired with
		 * `aria-describedby`; Escape and blur close it.
		 */
		function InfoTip(props) {
			const [open, setOpen] = useState(false);
			const id = useMemo(() => `pw-tip-${Math.random().toString(36).slice(2, 8)}`, []);
			return h(
				'span',
				{ className: 'pw-infowrap', onMouseEnter: () => setOpen(true), onMouseLeave: () => setOpen(false) },
				h(
					'button',
					{
						type: 'button',
						className: 'pw-iconbtn',
						'aria-label': props.text,
						'aria-describedby': open ? id : undefined,
						'aria-expanded': open ? 'true' : 'false',
						onFocus: () => setOpen(true),
						onBlur: () => setOpen(false),
						onClick: () => setOpen((value) => !value),
						onKeyDown: (event) => {
							if (event.key === 'Escape') setOpen(false);
						},
					},
					h(InfoIcon, { size: 14 })
				),
				open ? h('span', { id, role: 'tooltip', className: 'pw-tip', 'data-align': props.align === 'end' ? 'end' : 'start' }, props.text) : null
			);
		}
		/** Centred dialog: mask click and Escape close it, body scrolls, hairline border. */
		function Modal(props) {
			const dialogRef = useRef(null);
			useEffect(() => {
				// Move focus into the dialog so Escape and Tab act on it, not the page.
				if (dialogRef.current !== null && typeof dialogRef.current.focus === 'function') dialogRef.current.focus();
				const onKeyDown = (event) => {
					if (event.key !== 'Escape') return;
					props.onClose();
				};
				document.addEventListener('keydown', onKeyDown);
				return () => document.removeEventListener('keydown', onKeyDown);
			}, [props.onClose]);
			return h(
				'div',
				{
					className: 'pw-overlay',
					onMouseDown: (event) => {
						if (event.target === event.currentTarget) props.onClose();
					},
				},
				h(
					'div',
					{ className: 'pw-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title, tabIndex: -1, ref: dialogRef },
					h(
						'div',
						{ className: 'pw-dialog-head' },
						h('h2', { className: 'pw-dialog-title' }, props.title),
						h(IconButton, { label: t('common.dismiss'), onClick: props.onClose }, h(CloseIcon, { size: 14 }))
					),
					h('div', { className: 'pw-dialog-body' }, props.children)
				)
			);
		}
		/**
		 * Delivery status line, shared by the watch detail footer and the Feishu
		 * settings group: success shows the time, failure shows the Host's reason in
		 * the error colour, and "never delivered" is a muted note.
		 */
		function DeliveryLine(props) {
			const delivery = props.delivery && typeof props.delivery === 'object' ? props.delivery : null;
			if (delivery === null || typeof delivery.at !== 'string' || delivery.at === '') {
				return h('div', { className: 'pw-delivery' }, h('span', null, t('delivery.none')));
			}
			const when = formatLastCollect(delivery.at);
			if (delivery.ok === false) {
				const reason = typeof delivery.error === 'string' && delivery.error.trim() !== '' ? delivery.error.trim() : t('delivery.unknownError');
				return h('div', { className: 'pw-delivery', 'data-ok': 'false', role: 'status' }, h('span', null, t('delivery.failed', { error: reason })), when === null ? null : h('span', { className: 'pw-mono' }, when));
			}
			return h('div', { className: 'pw-delivery', 'data-ok': 'true' }, h('span', null, t('delivery.ok', { when: when === null ? '—' : when })));
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
			let stroke = 'var(--dsw-alias-state-business-primary)';
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
		 * Chart layout for a per-passenger series: 800 × 220 viewBox, series line,
		 * area fill and 4–5 y ticks. Pure — the hover state only indexes into
		 * `points`.
		 */
		function buildChart(points, height) {
			const series = normalizePricePoints(points);
			if (series.length === 0) return null;
			const chartHeight = Number.isFinite(height) ? height : CHART_HEIGHT;
			const padLeft = 52;
			const padRight = 14;
			const padTop = 14;
			const padBottom = 26;
			const plotLeft = padLeft;
			const plotRight = CHART_WIDTH - padRight;
			const plotTop = padTop;
			const plotBottom = chartHeight - padBottom;
			let minTime = series[0].at;
			let maxTime = series[series.length - 1].at;
			if (maxTime === minTime) {
				minTime -= 3600000;
				maxTime += 3600000;
			}
			const values = series.map((point) => point.total);
			let minValue = Math.min(...values);
			let maxValue = Math.max(...values);
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
			const chartHeight = props.compact === true ? CHART_COMPACT_HEIGHT : CHART_HEIGHT;
			const layout = useMemo(() => buildChart(props.points, chartHeight), [props.points, chartHeight]);
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
			const tooltipTop = hover === null ? 0 : (hover.y / chartHeight) * 100;
			const hovered = hover === null ? null : layout.series[hoverIndex];

			const children = [
				h(
					'defs',
					{ key: 'defs' },
					h(
						'linearGradient',
						{ id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1 },
						h('stop', { offset: '0%', stopColor: 'var(--dsw-alias-state-business-primary)', stopOpacity: 0.18 }),
						h('stop', { offset: '100%', stopColor: 'var(--dsw-alias-state-business-primary)', stopOpacity: 0 })
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
				h('path', { key: 'line', d: layout.line, fill: 'none', stroke: 'var(--dsw-alias-state-business-primary)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
			];

			if (hover !== null) {
				children.push(
					h('line', { key: 'crosshair', x1: hover.x, y1: layout.plotTop, x2: hover.x, y2: layout.plotBottom, stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 1, strokeDasharray: '3 3' }),
					h('circle', { key: 'hover-dot', cx: hover.x, cy: hover.y, r: 3.2, fill: 'var(--dsw-alias-bg-base)', stroke: 'var(--dsw-alias-state-business-primary)', strokeWidth: 2 })
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
						viewBox: `0 0 ${CHART_WIDTH} ${chartHeight}`,
						role: 'img',
						'aria-label': t('chart.title'),
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
							h('div', { className: 'pw-muted' }, formatDateTime(hovered.at))
						)
			);
		}
		/**
		 * Bars for the 380-day calendar; y is the tax-included lowest fare.
		 * `disabledBefore` greys out every bar on or before that day and
		 * `disabledAfter` every bar on or after it (round-trip constraints).
		 */
		function buildCalendarLayout(days, selectedDate, disabledBefore, disabledAfter) {
			const points = Array.isArray(days) ? days : [];
			if (points.length === 0) return null;
			const padLeft = 48;
			const padRight = 10;
			const padTop = 14;
			const padBottom = 24;
			const plotLeft = padLeft;
			const plotRight = CHART_WIDTH - padRight;
			const plotTop = padTop;
			const plotBottom = CALENDAR_HEIGHT - padBottom;
			let min = Infinity;
			let max = -Infinity;
			let minIndex = 0;
			for (let index = 0; index < points.length; index += 1) {
				const value = points[index].total;
				if (value < min) {
					min = value;
					minIndex = index;
				}
				if (value > max) max = value;
			}
			const spread = max - min;
			const breathing = spread > 0 ? spread * 0.18 : Math.max(20, Math.abs(max) * 0.08);
			const domainMin = Math.max(0, min - breathing);
			const domainMax = max + breathing;
			const yOf = (value) => plotBottom - ((value - domainMin) / (domainMax - domainMin)) * (plotBottom - plotTop);
			const step = niceStep(domainMax - domainMin, 4);
			const yTicks = [];
			for (let value = Math.ceil(domainMin / step) * step; value <= domainMax + step * 0.001 && yTicks.length < 8; value += step) {
				yTicks.push({ value, y: yOf(value) });
			}
			const slot = (plotRight - plotLeft) / points.length;
			const barWidth = Math.max(0.9, slot * 0.68);
			const isDisabled = (date) => {
				if (typeof disabledBefore === 'string' && disabledBefore !== '' && date <= disabledBefore) return true;
				if (typeof disabledAfter === 'string' && disabledAfter !== '' && date >= disabledAfter) return true;
				return false;
			};
			const bars = points.map((point, index) => {
				const y = yOf(point.total);
				return {
					date: point.date,
					total: point.total,
					bare: point.bare,
					index,
					disabled: isDisabled(point.date),
					x: plotLeft + index * slot + (slot - barWidth) / 2,
					y,
					width: barWidth,
					height: Math.max(1, plotBottom - y),
				};
			});
			const monthTicks = [];
			for (let index = 0; index < points.length; index += 1) {
				const date = toDate(points[index].date);
				if (date === null || date.getDate() !== 1) continue;
				monthTicks.push({ x: plotLeft + index * slot + slot / 2, label: `${date.getMonth() + 1}/${date.getDate()}` });
			}
			const stride = Math.max(1, Math.ceil(monthTicks.length / 7));
			return {
				points,
				bars,
				yTicks,
				xTicks: monthTicks.filter((tick, index) => index % stride === 0),
				plotLeft,
				plotRight,
				plotTop,
				plotBottom,
				slot,
				min,
				max,
				minIndex,
			};
		}

		/**
		 * The 行情 chart: one bar per calendar day, every price a tax-included
		 * `total`. All bars sharing the period low are green; the hovered bar is
		 * bright with a stroke and the rest dim to 0.55; the picked bar keeps a brand
		 * outline. Clicking a bar reports the day to the pin bar below.
		 *
		 * `disabledBefore` / `disabledAfter` mark days outside the legal window (the
		 * round-trip calendars use them to keep the return after the departure): those
		 * bars are faint, ignore hover and click and never show a tooltip.
		 */
		function CalendarChart(props) {
			const layout = useMemo(
				() => buildCalendarLayout(props.days, props.selectedDate, props.disabledBefore, props.disabledAfter),
				[props.days, props.selectedDate, props.disabledBefore, props.disabledAfter]
			);
			const wrapRef = useRef(null);
			const [hoverIndex, setHoverIndex] = useState(null);

			const pickIndex = (event) => {
				if (layout === null) return null;
				const node = wrapRef.current;
				if (node === null) return null;
				const rect = node.getBoundingClientRect();
				if (rect.width <= 0) return null;
				const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
				const svgX = ratio * CHART_WIDTH;
				if (svgX < layout.plotLeft || svgX > layout.plotRight) return null;
				const index = Math.floor((svgX - layout.plotLeft) / layout.slot);
				return Math.min(layout.points.length - 1, Math.max(0, index));
			};

			if (layout === null) {
				return h(
					'div',
					{ style: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: 150, border: '.5px dashed var(--dsw-alias-border-l1)', borderRadius: 12, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } },
					t('calendar.empty')
				);
			}

			const hovered = hoverIndex === null ? null : layout.points[hoverIndex];
			const hoverBar = hoverIndex === null ? null : layout.bars[hoverIndex];

			const children = [
				layout.yTicks.map((tick, index) =>
					h(
						'g',
						{ key: `y-${index}` },
						h('line', { x1: layout.plotLeft, y1: tick.y, x2: layout.plotRight, y2: tick.y, stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1 }),
						h('text', { x: layout.plotLeft - 8, y: tick.y, dy: '0.32em', textAnchor: 'end', fontSize: 11, fill: 'var(--dsw-alias-label-secondary)' }, formatMoney(tick.value))
					)
				),
				layout.bars.map((bar) => {
					const disabled = bar.disabled === true;
					const selected = !disabled && props.selectedDate === bar.date;
					const isLowest = bar.total === layout.min;
					const isHovered = !disabled && hoverIndex === bar.index;
					const dimmed = !disabled && hoverIndex !== null && !isHovered;
					let opacity = 0.8;
					if (disabled) opacity = 0.25;
					else if (dimmed) opacity = 0.55;
					else if (isHovered) opacity = 1;
					const stroke = disabled ? 'none' : selected ? 'var(--dsw-alias-state-business-primary)' : isHovered ? 'var(--dsw-alias-label-secondary)' : 'none';
					return h('rect', {
						key: bar.date,
						className: 'pw-cal-bar',
						x: bar.x,
						y: bar.y,
						width: bar.width,
						height: bar.height,
						rx: Math.min(2.5, bar.width / 2),
						fill: isLowest ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)',
						opacity,
						stroke,
						strokeWidth: disabled ? 0 : selected ? 1.6 : isHovered ? 1 : 0,
						'data-selected': selected ? 'true' : 'false',
						'data-lowest': isLowest ? 'true' : 'false',
						'data-disabled': disabled ? 'true' : 'false',
					});
				}),
				layout.xTicks.map((tick, index) => h('text', { key: `x-${index}`, x: tick.x, y: layout.plotBottom + 16, textAnchor: 'middle', fontSize: 11, fill: 'var(--dsw-alias-label-secondary)' }, tick.label)),
				hoverBar === null
					? null
					: h('line', {
							key: 'hover',
							x1: hoverBar.x + hoverBar.width / 2,
							y1: layout.plotTop,
							x2: hoverBar.x + hoverBar.width / 2,
							y2: layout.plotBottom,
							stroke: 'var(--dsw-alias-border-l2)',
							strokeWidth: 1,
							strokeDasharray: '3 3',
						}),
			];

			return h(
				'div',
				{
					className: 'pw-cal-wrap',
					ref: wrapRef,
					onMouseMove: (event) => {
						const index = pickIndex(event);
						// A greyed bar is not a candidate: no hover state, no tooltip.
						setHoverIndex(index !== null && layout.bars[index] && layout.bars[index].disabled ? null : index);
					},
					onMouseLeave: () => setHoverIndex(null),
					onClick: (event) => {
						const index = pickIndex(event);
						if (index === null || typeof props.onPick !== 'function') return;
						if (layout.bars[index] && layout.bars[index].disabled) return;
						props.onPick(layout.points[index]);
					},
				},
				h('svg', { className: 'pw-cal', viewBox: `0 0 ${CHART_WIDTH} ${CALENDAR_HEIGHT}`, role: 'img', 'aria-label': props.title || t('calendar.title') }, children),
				hovered === null || hoverBar === null
					? null
					: h(
							'div',
							{
								className: 'pw-tooltip',
								style: {
									left: `${((hoverBar.x + hoverBar.width / 2) / CHART_WIDTH) * 100}%`,
									top: `${(hoverBar.y / CALENDAR_HEIGHT) * 100}%`,
									transform: hoverBar.y < 60 ? 'translate(-50%, 14px)' : 'translate(-50%, -118%)',
								},
								role: 'status',
							},
							h('div', { style: { fontWeight: 500 } }, t('calendar.dayHint', { date: monthDay(hovered.date), price: formatMoney(hovered.total) }))
						)
			);
		}

		// #endregion

		// #region list view
		/** Health dot from the L1 probe plus the last successful collect. */
		function statusHealth(status) {
			if (!status || typeof status !== 'object') return { tone: 'idle', labelKey: 'status.never' };
			const l1 = status.l1 && typeof status.l1 === 'object' ? status.l1 : null;
			if (l1 !== null && l1.ok === false) return { tone: 'error', labelKey: 'status.warn' };
			if (!status.lastCollectAt) return { tone: 'idle', labelKey: 'status.never' };
			return { tone: 'ok', labelKey: 'status.ok' };
		}

		/** Login chip content for the current snapshot (`auth` + `l2` blocks). */
		function authInfo(status) {
			const source = status && typeof status === 'object' ? status : {};
			const auth = source.auth && typeof source.auth === 'object' ? source.auth : {};
			const l2 = l2State(source);
			if (l2.available === false) return { tone: 'idle', label: t('status.auth.unavailable'), clickable: false };
			if (auth.status === 'valid') {
				const account = typeof auth.accountHint === 'string' ? auth.accountHint.trim() : '';
				return { tone: 'ok', label: account === '' ? t('status.auth.valid') : t('status.auth.validAccount', { account }), clickable: false };
			}
			if (auth.status === 'expired') return { tone: 'warn', label: t('status.auth.expired'), clickable: true };
			return { tone: 'idle', label: t('status.auth.unknown'), clickable: true };
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
			const info = authInfo(props.status);
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

		function ModeChip(props) {
			const calendar = props.mode === 'calendar';
			return h(Chip, { tone: calendar ? 'flat' : 'brand', title: calendar ? t('card.mode.calendar') : t('card.mode.watch') }, calendar ? t('card.mode.calendar') : t('card.mode.watch'));
		}

		function MonitorCard(props) {
			const monitor = props.monitor;
			const calendar = monitorMode(monitor) === 'calendar';
			const latest = latestTotal(monitor);
			const summary = calendarSummaryOf(monitor);
			const spark = normalizeSeries(monitor.spark);
			const delta = calendar ? null : trendPercent(spark);
			const chip = trendChip(delta);
			const disabled = monitor.enabled === false;
			const defaults = props.cadenceDefaults && typeof props.cadenceDefaults === 'object' ? props.cadenceDefaults : null;
			const ownCadence = monitorCadence(monitor);
			const cadenceMinutes = ownCadence === null ? (defaults === null ? null : defaults[calendar ? 'calendar' : 'watch']) : ownCadence;
			const segments = [monitorDates(monitor)];
			if (cadenceMinutes !== null) segments.push(cadenceEvery(cadenceMinutes));
			if (calendar) {
				if (summary !== null && summary.min !== null) segments.push('' + t('card.lowestDay', { date: monthDay(summary.min.date) }) + ' ' + formatMoney(summary.min.total));
				segments.push(latest === null ? t('card.waiting') : t('card.updated', { when: relativeTime(latest.at) }));
			} else {
				segments.push(latest === null ? t('card.waiting') : t('card.latest', { price: formatMoney(latest.total) }));
				if (latest !== null) segments.push(relativeTime(latest.at));
			}
			const metaChildren = [];
			segments.forEach((segment, index) => {
				if (index > 0) metaChildren.push(h('span', { className: 'pw-strip-sep', key: `sep-${index}` }, '·'));
				metaChildren.push(h('span', { key: `seg-${index}` }, segment));
			});
			const titleChildren = [h(PlaneIcon, { key: 'plane', size: 14 }), h('span', { key: 'route', className: 'pw-ellipsis' }, monitorRoute(monitor)), h(ModeChip, { key: 'mode', mode: calendar ? 'calendar' : 'watch' })];
			if (disabled) titleChildren.push(h(Chip, { key: 'paused', tone: 'flat' }, t('card.paused')));

			const priceCell =
				latest === null
					? h('span', { className: 'pw-price pw-muted' }, '—')
					: h(
							'div',
							{ className: 'pw-row', style: { gap: 6, justifyContent: 'flex-end' } },
							h('span', { className: 'pw-price' }, formatMoney(latest.total)),
							calendar
								? h(Chip, { tone: 'flat', title: latest.note || '' }, t('card.calendarNote'))
								: h(Chip, { tone: chip.tone }, chip.text)
						);

			return h(
				'div',
				{
					className: 'pw-card',
					role: 'button',
					tabIndex: 0,
					'data-disabled': disabled ? 'true' : 'false',
					'data-mode': calendar ? 'calendar' : 'watch',
					'aria-label': `${monitorTitle(monitor)} ${monitorDates(monitor)}`,
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
				calendar ? null : h(Sparkline, { points: monitor.spark, tone: chip.tone }),
				h(
					'div',
					{ className: 'pw-col', style: { alignItems: 'flex-end', gap: 7, flex: 'none' } },
					h(Switch, {
						checked: !disabled,
						label: disabled ? t('card.enable') : t('card.disable'),
						disabled: props.busy === true,
						onChange: () => props.onToggle(monitor),
					}),
					priceCell
				)
			);
		}

		/** One row of filter pills: `role="group"` + `aria-pressed`, like the native task list. */
		function FilterTabs(props) {
			return h(
				'div',
				{ className: 'pw-filters', role: 'group', 'aria-label': props.label },
				props.options.map((option) =>
					h(
						'button',
						{
							key: option.id,
							type: 'button',
							className: 'pw-filter',
							'data-active': props.value === option.id ? 'true' : 'false',
							'aria-pressed': props.value === option.id ? 'true' : 'false',
							onClick: () => props.onChange(option.id),
						},
						option.label
					)
				)
			);
		}

		function ListView(props) {
			const monitors = Array.isArray(props.monitors) ? props.monitors : null;
			const status = props.status;
			const cadenceDefaults = props.cadenceDefaults && typeof props.cadenceDefaults === 'object' ? props.cadenceDefaults : null;
			const health = statusHealth(status);
			// Two levels: `type` first (flight / hotel), then `mode` for flight only.
			const type = props.filterType === 'hotel' ? 'hotel' : 'flight';
			const mode = props.filterMode === 'calendar' || props.filterMode === 'watch' ? props.filterMode : 'all';
			const hotel = type === 'hotel';
			const ofType = monitors === null ? null : monitors.filter((monitor) => monitorType(monitor) === type);
			const filtered = ofType === null || hotel ? null : ofType.filter((monitor) => mode === 'all' || monitorMode(monitor) === mode);
			const typeOptions = [
				{ id: 'flight', label: t('filter.type.flight') },
				{ id: 'hotel', label: t('filter.type.hotel') },
			];
			const modeOptions = [
				{ id: 'all', label: t('filter.all') },
				{ id: 'calendar', label: t('filter.calendar') },
				{ id: 'watch', label: t('filter.watch') },
			];
			const empty = filtered !== null && filtered.length === 0;
			const nothingAtAll = ofType !== null && ofType.length === 0;
			const newHint = hotel ? t('list.newHotelHint') : undefined;

			const body = [];
			if (monitors === null) {
				body.push(
					h(
						'div',
						{ className: 'pw-list', key: 'skeleton' },
						[0, 1, 2].map((index) =>
							h(
								'div',
								{ className: 'pw-card', key: `skeleton-${index}` },
								h('div', { className: 'pw-col pw-grow' }, h(Skeleton, { height: 16, width: '46%' }), h(Skeleton, { height: 12, width: '68%' })),
								h(Skeleton, { height: 44, width: 120, radius: 10 })
							)
						)
					)
				);
			} else if (hotel) {
				body.push(h(EmptyState, { key: 'hotel', title: t('empty.hotelTitle'), body: t('empty.hotelBody'), icon: h(BedIcon, { size: 24 }) }));
			} else if (nothingAtAll) {
				body.push(
					h(EmptyState, {
						key: 'empty',
						title: t('empty.title'),
						body: t('empty.body'),
						icon: h(TagIcon, { size: 22 }),
						action: h(Button, { variant: 'primary', icon: h(PlusIcon, { size: 15 }), onClick: props.onNew }, t('empty.action')),
					})
				);
			} else if (empty) {
				body.push(h(EmptyState, { key: 'filtered', title: t('empty.filtered') }));
			} else if (filtered !== null) {
				body.push(
					h(
						'div',
						{ className: 'pw-list', key: 'list' },
						filtered.map((monitor) =>
							h(MonitorCard, {
								key: monitor.id,
								monitor,
								cadenceDefaults,
								busy: props.busyKey === `toggle:${monitor.id}`,
								onOpen: props.onOpen,
								onToggle: props.onToggle,
							})
						)
					)
				);
			}

			const statusChips = [
				h(Dot, { key: 'dot', tone: health.tone }),
				h('span', { key: 'health' }, t(health.labelKey)),
				status && status.lastCollectAt ? h('span', { key: 'last' }, t('status.last', { time: formatLastCollect(status.lastCollectAt) })) : null,
				status ? h(AuthChip, { key: 'auth', status, pending: props.loginPending === true, onLogin: props.onLogin }) : null,
			];

			return h(
				PageShell,
				{
					title: t('nav'),
					// The header keeps only the native-style create button.
					actions: [
						h(
							Button,
							{
								key: 'new',
								variant: 'primary',
								className: 'pw-btn-header',
								icon: h(PlusIcon, { size: 13 }),
								onClick: props.onNew,
								disabled: hotel,
								title: newHint,
								ariaLabel: newHint,
							},
							t('list.new')
						),
					],
					sub: h(
						React.Fragment,
						null,
						// Level 1: product type, native filter pills on a transparent row.
						h(FilterTabs, { label: t('filter.type.label'), options: typeOptions, value: type, onChange: props.onTypeChange }),
						// Level 2: the current type's conditions, a smaller segmented
						// control; status chips and the icon actions sit on its right edge.
						h(
							'div',
							{ className: 'pw-filter-meta' },
							hotel
								? null
								: h(SegControl, {
										className: 'pw-seg-sm',
										role: 'group',
										label: t('filter.mode.label'),
										options: modeOptions,
										value: mode,
										onChange: props.onModeChange,
									}),
							h(
								'div',
								{ className: 'pw-filter-meta-end' },
								h('div', { className: 'pw-status' }, statusChips),
								h(
									'div',
									{ className: 'pw-head-icons' },
									h(IconButton, { label: t('list.settings'), onClick: props.onSettings }, h(SettingsIcon, { size: 15 })),
									h(IconButton, { label: t('list.refresh'), onClick: props.onRefresh, disabled: props.refreshing === true }, h(RefreshIcon, { size: 15 }))
								)
							)
						)
					),
				},
				props.banner,
				...body
			);
		}

		// #endregion

		// #region detail view
		/** Stats row for one calendar chart (out or back). */
		function calendarStatsItems(days) {
			const stats = calendarStats(days);
			if (stats === null) return [];
			return [
				{ key: 'min', label: t('calendar.stat.min'), value: formatMoney(stats.min.total) },
				{ key: 'max', label: t('calendar.stat.max'), value: formatMoney(stats.max.total) },
				{ key: 'avg', label: t('calendar.stat.avg'), value: formatMoney(stats.avg) },
				{ key: 'minDay', label: t('calendar.stat.minDay'), value: monthDay(stats.min.date) },
			];
		}

		/**
		 * Shared rhythm editor for both detail pages. Both modes use the same bucket
		 * ladder, and the section also shows when the Host will collect next plus —
		 * for a watch — why the last collection failed. Saving PATCHes
		 * `{ cadence: { minutes } }` only, so editing the rhythm touches nothing else.
		 */
		function CadenceEditor(props) {
			const current = clampCadence(props.value);
			const initial = current === null ? CADENCE_DEFAULT : current;
			const [editing, setEditing] = useState(false);
			const [draft, setDraft] = useState(initial);
			const [saving, setSaving] = useState(false);
			const [error, setError] = useState(null);
			const busy = props.busy === true;
			const nextRun = typeof props.nextDue === 'string' ? formatLastCollect(props.nextDue) : null;
			const failure = typeof props.failure === 'string' && props.failure.trim() !== '' ? props.failure.trim() : null;

			const beginEdit = () => {
				setDraft(initial);
				setError(null);
				setEditing(true);
			};

			const save = async () => {
				const minutes = clampCadence(Number(draft));
				setSaving(true);
				setError(null);
				try {
					await props.onSave({ minutes: minutes === null ? CADENCE_DEFAULT : minutes });
					setEditing(false);
				} catch (reason) {
					setError(reason && reason.message ? reason.message : t('cadence.failed'));
				} finally {
					setSaving(false);
				}
			};

			return h(
				Section,
				{ title: t('cadence.title') },
				h(
					'div',
					{ className: 'pw-row', style: { gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
					current === null ? h('span', { className: 'pw-hint' }, t('cadence.inherit')) : h(Chip, { tone: 'flat' }, cadenceEvery(current)),
					h('span', { className: 'pw-hint' }, nextRun === null ? t('cadence.nextUnknown') : t('cadence.next', { when: nextRun })),
					h(Button, { size: 'sm', onClick: beginEdit, disabled: busy }, t('cadence.edit'))
				),
				failure === null ? null : h('span', { className: 'pw-hint', style: { color: 'var(--dsw-alias-state-error-primary)' }, role: 'status' }, t('cadence.lastError', { message: failure })),
				editing
					? h(
							'div',
							{ className: 'pw-col', style: { gap: 8 } },
							h(
								Field,
								{ label: t('cadence.interval') },
								h(
									'select',
									{ className: 'pw-input', value: String(draft), onChange: (event) => setDraft(Number(event.target.value)) },
									CADENCE_MINUTES.map((value) => h('option', { key: value, value: String(value) }, cadenceDuration(value)))
								)
							),
							error === null ? null : h('div', { className: 'pw-hint', style: { color: 'var(--dsw-alias-state-error-primary)' }, role: 'alert' }, error),
							h(
								'div',
								{ className: 'pw-row', style: { justifyContent: 'flex-end', gap: 8 } },
								h(Button, { size: 'sm', onClick: () => setEditing(false), disabled: saving }, t('common.cancel')),
								h(Button, { size: 'sm', variant: 'primary', onClick: () => void save(), disabled: saving }, saving ? t('common.saving') : t('cadence.save'))
							)
						)
					: null
			);
		}

		/**
		 * 行情 mode: two bar calendars (round) and a pin bar that turns the picked
		 * day (or day pair) into a watch monitor via `POST /monitors`. Every number
		 * here is the tax-included `total`.
		 */
		function CalendarDetailView(props) {
			const monitor = props.monitor;
			const round = monitorTrip(monitor) === 'round';
			const calendar = props.calendar;
			const outDays = useMemo(() => normalizeCalendarDays(calendar && calendar.out), [calendar]);
			const backDays = useMemo(() => normalizeCalendarDays(calendar && calendar.back), [calendar]);
			const outStatsItems = useMemo(() => calendarStatsItems(outDays), [outDays, runtime.revision.get()]);
			const backStatsItems = useMemo(() => calendarStatsItems(backDays), [backDays, runtime.revision.get()]);
			const [selectedOut, setSelectedOut] = useState(null);
			const [selectedBack, setSelectedBack] = useState(null);
			// The pin creates a watch, which must carry a passenger; a calendar monitor
			// may have none, so this picker only appears when the source roster is empty.
			const [pinPassengerId, setPinPassengerId] = useState('');
			useLocaleRevision();

			const outPick = outDays.find((day) => day.date === selectedOut) || null;
			const backPick = backDays.find((day) => day.date === selectedBack) || null;

			/**
			 * The two calendars are mutually constrained: the return has to be strictly
			 * after the departure. Picking one side clears the other when the pair is no
			 * longer legal, so the pin bar can never carry an inverted date range.
			 */
			const pickOut = (day) => {
				const next = day.date === selectedOut ? null : day.date;
				setSelectedOut(next);
				if (next !== null && selectedBack !== null && selectedBack <= next) setSelectedBack(null);
			};
			const pickBack = (day) => {
				const next = day.date === selectedBack ? null : day.date;
				setSelectedBack(next);
				if (next !== null && selectedOut !== null && selectedOut >= next) setSelectedOut(null);
			};
			const pinTotal = outPick === null ? null : round ? (backPick === null ? null : outPick.total + backPick.total) : outPick.total;
			const sourcePassengerIds = Array.isArray(monitor.passengerIds) ? monitor.passengerIds.filter((id) => typeof id === 'string') : [];
			const needsPassenger = sourcePassengerIds.length === 0;
			const passengerOptions = Array.isArray(props.passengers) ? props.passengers : [];
			const pickedPassenger = needsPassenger && passengerOptions.some((passenger) => passenger.id === pinPassengerId);
			const canPin = outPick !== null && pinTotal !== null && !props.busy && (!needsPassenger || pickedPassenger);
			const enabled = monitor.enabled !== false;
			const fetchedAt = calendar && typeof calendar.fetchedAt === 'string' ? calendar.fetchedAt : null;
			const passengerCount = sourcePassengerIds.length;

			const meta = [monitorDates(monitor)];
			meta.push(h('span', { key: 'sep-0', className: 'pw-strip-sep' }, '·'));
			meta.push(h('span', { key: 'passengers' }, passengerCount === 0 ? t('detail.passengersNone') : t('detail.passengersCount', { n: passengerCount })));
			if (!enabled) meta.push(h(Chip, { key: 'paused', tone: 'flat' }, t('card.paused')));

			let pinLabel = t('calendar.pinNeedReturn');
			if (outPick !== null) {
				pinLabel = round
					? backPick === null
						? t('calendar.pinNeedReturn')
						: t('calendar.pinRound', { depart: monthDay(outPick.date), return: monthDay(backPick.date), price: formatMoney(outPick.total + backPick.total) })
					: t('calendar.pin', { date: monthDay(outPick.date), price: formatMoney(outPick.total) });
			}

			return h(
				PageShell,
				{
					lead: h(IconButton, { label: t('detail.back'), onClick: props.onBack }, h(BackIcon, { size: 18 })),
					title: monitorTitle(monitor),
					meta,
					actions: [
						h(Button, { key: 'refresh', size: 'sm', icon: h(RefreshIcon, { size: 13 }), onClick: () => props.onRefresh(monitor.id), disabled: props.busy === true }, t('detail.refresh')),
						// Pause / delete are icon buttons, exactly like the list page's actions.
						h(
							'div',
							{ className: 'pw-head-icons', key: 'icons' },
							h(
								IconButton,
								{ label: enabled ? t('detail.pause') : t('detail.resume'), onClick: () => props.onToggleEnabled(monitor), disabled: props.busy === true },
								enabled ? h(PauseIcon, { size: 15 }) : h(PlayIcon, { size: 15 })
							),
							h(IconButton, { label: t('detail.delete'), tone: 'danger', onClick: () => props.onDelete(monitor), disabled: props.busy === true }, h(TrashIcon, { size: 15 }))
						),
					],
				},
				props.banner,
				props.calendarError ? h(ErrorBar, { key: 'calendar-error', message: props.calendarError, inline: true, onRetry: () => props.onRefresh(monitor.id) }) : null,
				h(
					Section,
					{ key: 'out', title: round ? `${t('calendar.title')} · ${t('calendar.out')}` : t('calendar.title'), help: t('calendar.caption') },
					calendar === null && props.calendarError === null
						? h(Skeleton, { height: 150, radius: 12 })
						: h(CalendarChart, { days: outDays, selectedDate: selectedOut, disabledAfter: selectedBack, onPick: pickOut }),
					round && selectedBack !== null ? h('span', { className: 'pw-hint' }, t('calendar.outBeforeBack')) : null,
					outStatsItems.length === 0 ? null : h(Stats, { items: outStatsItems }),
					fetchedAt === null ? null : h('span', { className: 'pw-hint' }, t('calendar.fetchedAt', { when: relativeTime(fetchedAt) }))
				),
				round
					? h(
							Section,
							{ key: 'back', title: `${t('calendar.title')} · ${t('calendar.back')}`, help: t('calendar.caption') },
							calendar === null && props.calendarError === null
								? h(Skeleton, { height: 150, radius: 12 })
								: h(CalendarChart, { days: backDays, selectedDate: selectedBack, disabledBefore: selectedOut, onPick: pickBack }),
							round && selectedOut !== null ? h('span', { className: 'pw-hint' }, t('calendar.backAfterOut')) : null,
							backStatsItems.length === 0 ? null : h(Stats, { items: backStatsItems })
						)
					: null,
				h(CadenceEditor, { key: 'cadence', value: monitorCadence(monitor), nextDue: monitor.nextDue, busy: props.busy, onSave: (cadence) => props.onSaveCadence(monitor.id, cadence) }),
				selectedOut === null
					? null
					: h(
							'div',
							{ className: 'pw-pin-bar', key: 'pin', style: { flexWrap: 'wrap' } },
							h('span', { className: 'pw-grow', style: { fontSize: 12 } }, outPick === null ? '' : `${monthDay(outPick.date)}${round && backPick !== null ? ` – ${monthDay(backPick.date)}` : ''}${pinTotal === null ? '' : ` · ${formatMoney(pinTotal)}`}`),
							// 来源监控没有乘客时，钉住必须先补一位：绝不带着空乘客去 POST，
							// 否则 Host 会拒绝创建 watch 监控。
							needsPassenger
								? h(
										'div',
										{ className: 'pw-row', style: { gap: 6, alignItems: 'center' } },
										h('span', { className: 'pw-hint' }, t('calendar.pinNeedPassenger')),
										passengerOptions.length === 0
											? h(Button, { size: 'sm', onClick: props.onSettings }, t('calendar.pinCreatePassenger'))
											: h(
													'select',
													{
														className: 'pw-input',
														style: { width: 'auto', minWidth: 132 },
														value: pinPassengerId,
														'aria-label': t('calendar.pinPickPassenger'),
														onChange: (event) => setPinPassengerId(event.target.value),
													},
													h('option', { value: '' }, t('calendar.pinPickPassenger')),
													passengerOptions.map((passenger) => h('option', { key: passenger.id, value: passenger.id }, passenger.nickname))
												)
									)
								: null,
							h(Button, { size: 'sm', onClick: () => { setSelectedOut(null); setSelectedBack(null); setPinPassengerId(''); }, disabled: props.busy === true }, t('common.cancel')),
							h(
								Button,
								{
									variant: 'primary',
									size: 'sm',
									onClick: () =>
										props.onPin({
											departDate: outPick === null ? null : outPick.date,
											returnDate: round && backPick !== null ? backPick.date : null,
											passengerIds: needsPassenger ? [pinPassengerId] : sourcePassengerIds.slice(),
										}),
									disabled: !canPin,
								},
								pinLabel
							)
						)
			);
		}

		/** `-2.5%` / `+1.2%`; null when there is nothing to compare. */
		function formatPercentDelta(delta) {
			if (delta === null || !Number.isFinite(delta)) return null;
			const magnitude = Math.abs(delta);
			const text = `${magnitude < 0.05 ? '0.0' : magnitude.toFixed(1)}%`;
			if (delta > 0.05) return `+${text}`;
			if (delta < -0.05) return `-${text}`;
			return text;
		}

		/** `prices.min` = one point per collection: `[{ at, total }]`, oldest first. */
		function normalizeMinSeries(points) {
			if (!Array.isArray(points)) return [];
			const out = [];
			for (const point of points) {
				if (!point || typeof point !== 'object') continue;
				if (typeof point.total !== 'number' || !Number.isFinite(point.total)) continue;
				const at = parseTime(point.at);
				if (at === null) continue;
				out.push({ at, total: point.total });
			}
			out.sort((left, right) => left.at - right.at);
			return out;
		}

		/** `MF8561 · 08:00 大兴国际机场 → 10:10 浦东国际机场T2`. */
		function flightRouteLine(flight) {
			if (flight === null || flight === undefined) return '';
			const route = `${flight.depTime || '—'} ${flight.depAirport || '—'} → ${flight.arrTime || '—'} ${flight.arrAirport || '—'}`;
			return typeof flight.no === 'string' && flight.no !== '' ? `${flight.no} · ${route}` : route;
		}

		/** Cheapest bookable total in the snapshot: `flights.lowest.total`, else the newest trend point. */
		function lowestBookable(flightsData, minSeries) {
			const lowest = flightsData && flightsData.lowest && typeof flightsData.lowest === 'object' ? flightsData.lowest : null;
			if (lowest !== null && typeof lowest.total === 'number' && Number.isFinite(lowest.total)) {
				return {
					total: lowest.total,
					flightNo: typeof lowest.flightNo === 'string' ? lowest.flightNo : null,
					// `round` = one through-ticket, `oneway` = two separate one-way tickets.
					scheme: typeof lowest.scheme === 'string' ? lowest.scheme : null,
				};
			}
			const last = Array.isArray(minSeries) && minSeries.length > 0 ? minSeries[minSeries.length - 1] : null;
			if (last !== null) return { total: last.total, flightNo: null, scheme: null };
			return null;
		}

		/**
		 * Normalised `flights.roundTrip` (D10): the through ticket vs the sum of two
		 * one-ways, which side is cheaper, and what the Host could not collect. Returns
		 * null for a one-way monitor, so nothing renders for those.
		 */
		function roundTripInfo(flightsData) {
			const roundTrip = flightsData && flightsData.roundTrip && typeof flightsData.roundTrip === 'object' ? flightsData.roundTrip : null;
			if (roundTrip === null) return null;
			const round = roundTrip.round && typeof roundTrip.round === 'object' ? roundTrip.round : null;
			const oneway = roundTrip.oneway && typeof roundTrip.oneway === 'object' ? roundTrip.oneway : null;
			const out = oneway && oneway.out && typeof oneway.out === 'object' ? oneway.out : null;
			const back = oneway && oneway.back && typeof oneway.back === 'object' ? oneway.back : null;
			const roundPayable = round !== null && typeof round.payable === 'number' && Number.isFinite(round.payable) ? round.payable : null;
			const outPayable = out !== null && typeof out.payable === 'number' && Number.isFinite(out.payable) ? out.payable : null;
			const backPayable = back !== null && typeof back.payable === 'number' && Number.isFinite(back.payable) ? back.payable : null;
			const onewayTotal = oneway !== null && typeof oneway.sum === 'number' && Number.isFinite(oneway.sum) ? oneway.sum : outPayable !== null && backPayable !== null ? outPayable + backPayable : null;
			const comparison = roundTrip.comparison && typeof roundTrip.comparison === 'object' ? roundTrip.comparison : null;
			const declared = comparison && (comparison.cheaper === 'round' || comparison.cheaper === 'oneway' || comparison.cheaper === 'tie') ? comparison.cheaper : null;
			const diff = comparison && typeof comparison.diff === 'number' && Number.isFinite(comparison.diff) ? comparison.diff : roundPayable !== null && onewayTotal !== null ? Math.abs(roundPayable - onewayTotal) : null;
			const cheaper = declared !== null ? declared : roundPayable !== null && onewayTotal !== null ? (roundPayable < onewayTotal ? 'round' : roundPayable > onewayTotal ? 'oneway' : 'tie') : null;
			const errors = roundTrip.errors && typeof roundTrip.errors === 'object' ? roundTrip.errors : {};
			return {
				partial: roundTrip.partial === true,
				round: {
					payable: roundPayable,
					source: round !== null && typeof round.payableSource === 'string' ? round.payableSource : null,
					flight: round,
					returnLeg: round !== null && round.return && typeof round.return === 'object' ? round.return : null,
				},
				oneway: { total: onewayTotal, outPayable, backPayable },
				cheaper,
				diff,
				roundMissing: roundPayable === null || errors.round !== null,
				onewayMissing: onewayTotal === null || errors.out !== null || errors.back !== null,
			};
		}

		/** One side of the round-trip comparison: label, price and a single detail line. */
		function CompareSide(props) {
			return h(
				'div',
				{ className: 'pw-compare-side', 'data-cheaper': props.cheaper === true ? 'true' : 'false' },
				h('span', { className: 'pw-compare-label' }, props.label),
				h('span', { className: 'pw-compare-price' }, props.price === null ? '—' : formatMoney(props.price)),
				props.detail === null ? null : h('span', { className: 'pw-compare-detail' }, props.detail)
			);
		}

		/**
		 * 联程 vs 两段单买 (D10): both totals, one detail line each, a verdict on which is
		 * cheaper (green on the winning side), and a warning line when the Host could
		 * only collect part of the comparison.
		 */
		function RoundTripCompare(props) {
			const info = props.info;
			const roundFlight = info.round.flight;
			const returnLeg = info.round.returnLeg;
			const routeParts = [];
			if (roundFlight !== null && typeof roundFlight.flightNo === 'string' && roundFlight.flightNo !== '') {
				routeParts.push(`${roundFlight.flightNo} ${roundFlight.depTime || '—'}→${roundFlight.arrTime || '—'}`);
			}
			if (returnLeg !== null) {
				routeParts.push(
					t('watch.compare.returnLeg', {
						flightNo: typeof returnLeg.flightNo === 'string' && returnLeg.flightNo !== '' ? returnLeg.flightNo : '—',
						depTime: returnLeg.depTime || '—',
						arrTime: returnLeg.arrTime || '—',
					})
				);
			}
			const roundDetail = routeParts.length === 0 ? null : routeParts.join(' / ');
			const onewayDetail =
				info.oneway.outPayable === null || info.oneway.backPayable === null
					? null
					: t('watch.compare.split', {
							outLabel: t('calendar.out'),
							outPrice: formatMoney(info.oneway.outPayable),
							backLabel: t('calendar.back'),
							backPrice: formatMoney(info.oneway.backPayable),
						});

			const missing = [];
			if (info.roundMissing) missing.push(t('watch.scheme.round'));
			if (info.onewayMissing) missing.push(t('watch.scheme.oneway'));
			const warning = info.partial
				? missing.length === 0
					? t('watch.compare.partialGeneric')
					: t('watch.compare.partial', { sides: missing.join(t('watch.compare.join')) })
				: null;

			const bothKnown = info.round.payable !== null && info.oneway.total !== null;
			let verdict = null;
			let verdictTone = 'tie';
			if (bothKnown && info.cheaper === 'round') {
				verdict = t('watch.compare.roundCheaper', { amount: formatMoney(info.diff === null ? 0 : info.diff) });
				verdictTone = 'round';
			} else if (bothKnown && info.cheaper === 'oneway') {
				verdict = t('watch.compare.onewayCheaper', { amount: formatMoney(info.diff === null ? 0 : info.diff) });
				verdictTone = 'oneway';
			} else if (bothKnown && info.cheaper === 'tie') {
				verdict = t('watch.compare.tie');
			}

			return h(
				Section,
				{ title: t('watch.compare.title') },
				warning === null ? null : h('div', { className: 'pw-compare-warning', role: 'status' }, warning),
				h(
					'div',
					{ className: 'pw-compare-sides' },
					h(CompareSide, { label: t('watch.scheme.round'), price: info.round.payable, detail: roundDetail, cheaper: info.cheaper === 'round' && info.round.payable !== null }),
					h(CompareSide, { label: t('watch.scheme.oneway'), price: info.oneway.total, detail: onewayDetail, cheaper: info.cheaper === 'oneway' && info.oneway.total !== null })
				),
				verdict === null ? null : h('div', { className: 'pw-compare-verdict', 'data-cheaper': verdictTone, role: 'status' }, verdict)
			);
		}

		/** The flight row the summary line describes: by `lowest.flightNo`, else by price. */
		function lowestFlightOf(flights, lowest) {
			if (lowest === null) return null;
			if (lowest.flightNo !== null) {
				const byNumber = flights.find((flight) => flight && flight.no === lowest.flightNo);
				if (byNumber) return byNumber;
			}
			return flights.find((flight) => flight && Number.isFinite(flight.taxIncluded) && flight.taxIncluded === lowest.total) || null;
		}

		/** One flight's payable total, or null when the row was never priced. */
		function payableOf(flight) {
			return flight && typeof flight.taxIncluded === 'number' && Number.isFinite(flight.taxIncluded) ? flight.taxIncluded : null;
		}

		/**
		 * 余票 cell: `售罄` / `剩 N 张` / `—`, with a tone for the scarce cases so the
		 * table can colour them without a second lookup.
		 */
		function seatsInfo(flight) {
			if (flight && flight.soldOut === true) return { text: t('watch.soldOut'), tone: 'soldout' };
			const seats = flight && typeof flight.seats === 'number' && Number.isFinite(flight.seats) ? Math.max(0, Math.round(flight.seats)) : null;
			if (seats === null) return { text: '—', tone: 'none' };
			if (seats <= 0) return { text: t('watch.soldOut'), tone: 'soldout' };
			return { text: t('watch.seatsLeft', { n: seats }), tone: seats <= 3 ? 'few' : 'normal' };
		}

		/**
		 * TOP10 flights: 航班号 / 航司 / 时刻 / 机场 / 机型 / 待支付价 / 余票 / 状态,
		 * cheapest first with unpriced rows last. The cheapest row is highlighted; an
		 * unpriced row shows `—` and explains itself in its `title`. The 机型 column
		 * is hidden on narrow panels so the 余票 column never squeezes the table.
		 */
		function FlightTable(props) {
			const flights = Array.isArray(props.flights) ? props.flights.filter((flight) => flight && typeof flight === 'object') : [];
			if (flights.length === 0) return h('div', { className: 'pw-hint' }, t('watch.flightsEmpty'));
			const sorted = flights
				.slice()
				.sort((left, right) => {
					const a = payableOf(left);
					const b = payableOf(right);
					if (a === null && b === null) return 0;
					if (a === null) return 1;
					if (b === null) return -1;
					return a - b;
				})
				.slice(0, 10);
			const cheapest = payableOf(sorted[0]);
			const headers = [t('watch.flightNo'), t('watch.airline'), t('watch.time'), t('watch.airport'), t('watch.craft'), t('watch.taxIncluded'), t('watch.seats'), t('watch.status')];
			const headerClass = (index) => (index === 5 ? 'pw-num' : index === 4 ? 'pw-craft' : index === 6 ? 'pw-seats' : undefined);
			return h(
				'div',
				{ className: 'pw-table-wrap' },
				h(
					'table',
					{ className: 'pw-table' },
					h('thead', null, h('tr', null, headers.map((label, index) => h('th', { key: index, className: headerClass(index) }, label)))),
					h(
						'tbody',
						null,
						sorted.map((flight, index) => {
							const total = payableOf(flight);
							const prices = Array.isArray(flight.prices) ? flight.prices : [];
							const fareLabel = prices.map((item) => (item && typeof item.fareLabel === 'string' ? item.fareLabel : '')).find((label) => label !== '') || '';
							const isCheapest = total !== null && total === cheapest;
							const seats = seatsInfo(flight);
							return h(
								'tr',
								{ key: `${flight.no || 'flight'}-${index}`, 'data-cheapest': isCheapest ? 'true' : 'false', title: total === null ? t('watch.priceMissingHint') : undefined },
								h('td', { className: 'pw-mono pw-nowrap' }, flight.no || '—'),
								h('td', null, flight.airline || '—'),
								h('td', { className: 'pw-mono pw-nowrap' }, `${flight.depTime || '—'} – ${flight.arrTime || '—'}`),
								h('td', null, `${flight.depAirport || '—'} → ${flight.arrAirport || '—'}`),
								h('td', { className: 'pw-craft' }, flight.craft || '—'),
								h('td', { className: 'pw-num' }, total === null ? '—' : formatMoney(total)),
								h('td', { className: 'pw-seats', 'data-tone': seats.tone }, seats.text),
								h('td', { className: 'pw-nowrap' }, total === null ? h('span', { className: 'pw-hint' }, t('watch.noPrice')) : fareLabel !== '' ? h('span', { className: 'pw-hint' }, fareLabel) : h('span', { className: 'pw-hint' }, t('watch.bookable')))
							);
						})
					)
				)
			);
		}

		/**
		 * 监控 mode, rebuilt per A2/B3: the conclusion block (lowest bookable price,
		 * change since the previous collection, the cheapest flight), one merged
		 * trend of that same price, the TOP10 flight table and the delivery status.
		 */
		function WatchDetailView(props) {
			useLocaleRevision();
			const monitor = props.monitor;
			const prices = props.prices;
			const flightsData = props.flights;
			const flights = Array.isArray(flightsData && flightsData.flights) ? flightsData.flights.filter((flight) => flight && typeof flight === 'object') : [];
			const flightsFetchedAt = flightsData && typeof flightsData.fetchedAt === 'string' ? flightsData.fetchedAt : null;
			const enabled = monitor.enabled !== false;
			const busy = props.busy === true;
			const passengerIds = Array.isArray(monitor.passengerIds) ? monitor.passengerIds : [];

			// One point per collection: the price the conclusion block shows.
			const minSeries = useMemo(() => normalizeMinSeries(prices && prices.min), [prices]);
			const lowest = lowestBookable(flightsData, minSeries);
			const lowestFlight = lowestFlightOf(flights, lowest);
			// Round-trip monitors carry the through-ticket vs two-one-ways comparison;
			// one-way monitors keep the exact layout they had (roundTrip is null).
			const roundTrip = roundTripInfo(flightsData);
			const roundMode = monitorTrip(monitor) === 'round';
			// The scheme tag only makes sense for a round-trip monitor: 联程 (one through
			// ticket) vs 两段单买 (two one-ways). A one-way monitor keeps its old header.
			const schemeLabel =
				!roundMode || lowest === null || lowest.scheme === null ? null : lowest.scheme === 'round' ? t('watch.scheme.round') : lowest.scheme === 'oneway' ? t('watch.scheme.oneway') : null;
			const listPriceNote = roundMode && roundTrip !== null && lowest !== null && lowest.scheme === 'round' && roundTrip.round.source === 'list';
			const latestPoint = minSeries.length > 0 ? minSeries[minSeries.length - 1] : null;
			const previousPoint = minSeries.length > 1 ? minSeries[minSeries.length - 2] : null;
			const deltaPercent = latestPoint !== null && previousPoint !== null && previousPoint.total > 0 ? ((latestPoint.total - previousPoint.total) / previousPoint.total) * 100 : null;
			const deltaText = formatPercentDelta(deltaPercent);
			const deltaTone = deltaPercent === null || Math.abs(deltaPercent) < 0.05 ? 'flat' : deltaPercent > 0 ? 'up' : 'down';

			const meta = [monitorDates(monitor)];
			meta.push(h('span', { key: 'sep-0', className: 'pw-strip-sep' }, '·'));
			meta.push(h('span', { key: 'passengers' }, passengerIds.length === 0 ? t('detail.passengersNone') : t('detail.passengersCount', { n: passengerIds.length })));
			if (!enabled) meta.push(h(Chip, { key: 'paused', tone: 'flat' }, t('card.paused')));

			const conclusion = h(
				'div',
				{ className: 'pw-summary', key: 'summary' },
				h(
					'div',
					{ className: 'pw-summary-main' },
					h('span', { className: 'pw-summary-label' }, t('watch.lowestLabel')),
					h('span', { className: 'pw-summary-price' }, lowest === null ? '—' : formatMoney(lowest.total)),
					schemeLabel === null
						? null
						: h(
								'div',
								{ className: 'pw-summary-scheme' },
								h(Chip, { tone: 'brand' }, schemeLabel),
								listPriceNote ? h('span', { className: 'pw-hint' }, t('watch.scheme.listPrice')) : null
							),
					deltaText === null ? null : h('span', { className: 'pw-summary-delta', 'data-tone': deltaTone }, t('watch.vsLast', { percent: deltaText, price: formatMoney(previousPoint.total) })),
					lowestFlight === null ? null : h('span', { className: 'pw-summary-route' }, flightRouteLine(lowestFlight))
				),
				h(Button, { variant: 'primary', icon: h(RefreshIcon, { size: 13 }), onClick: () => props.onRefresh(monitor.id), disabled: busy }, t('detail.refresh'))
			);

			return h(
				PageShell,
				{
					lead: h(IconButton, { label: t('detail.back'), onClick: props.onBack }, h(BackIcon, { size: 18 })),
					title: monitorTitle(monitor),
					meta,
					actions: [
						// Pause / delete are icon buttons, exactly like the list page's actions.
						h(
							'div',
							{ className: 'pw-head-icons', key: 'icons' },
							h(
								IconButton,
								{ label: enabled ? t('detail.pause') : t('detail.resume'), onClick: () => props.onToggleEnabled(monitor), disabled: busy },
								enabled ? h(PauseIcon, { size: 15 }) : h(PlayIcon, { size: 15 })
							),
							h(IconButton, { label: t('detail.delete'), tone: 'danger', onClick: () => props.onDelete(monitor), disabled: busy }, h(TrashIcon, { size: 15 }))
						),
					],
				},
				props.banner,
				props.pricesError ? h(ErrorBar, { key: 'prices-error', message: props.pricesError, inline: true, onRetry: () => props.onRefresh(monitor.id) }) : null,
				props.flightsError ? h(ErrorBar, { key: 'flights-error', message: props.flightsError, inline: true, onRetry: () => props.onRefresh(monitor.id) }) : null,
				conclusion,
				roundTrip === null ? null : h(RoundTripCompare, { key: 'compare', info: roundTrip }),
				h(
					Section,
					{ key: 'trend', title: t('watch.trendTitle') },
					prices === null && props.pricesError === null ? h(Skeleton, { height: 150, radius: 12 }) : h(PriceChart, { points: prices && prices.min, emptyText: t('watch.trendEmpty') })
				),
				h(
					Section,
					{
						key: 'flights',
						title: roundMode ? t('watch.flightsRound') : t('watch.flights'),
						help:
							flightsFetchedAt === null
								? roundMode
									? t('watch.flightsRoundHelp')
									: t('watch.flightsHelp')
								: `${roundMode ? t('watch.flightsRoundHelp') : t('watch.flightsHelp')} · ${t('watch.fetchedAt', { when: relativeTime(flightsFetchedAt) })}`,
					},
					flightsData === null && props.flightsError === null ? h(Skeleton, { height: 180, radius: 12 }) : h(FlightTable, { flights })
				),
				h(CadenceEditor, {
					key: 'cadence',
					value: monitorCadence(monitor),
					nextDue: monitor.nextDue,
					failure: monitorFailure(monitor, props.status),
					busy: props.busy,
					onSave: (next) => props.onSaveCadence(monitor.id, next),
				}),
				h(DeliveryLine, { key: 'delivery', delivery: monitor.delivery })
			);
		}

		/** Detail dispatcher: the mode decides between the bar calendar and the watch. */
		function DetailView(props) {
			useLocaleRevision();
			if (monitorMode(props.monitor) === 'calendar') return h(CalendarDetailView, props);
			return h(WatchDetailView, props);
		}
		// #endregion

		// #region settings view
		/** `/settings` cadence block, tolerant of a missing or partial read. */
		function settingsCadence(settings) {
			const source = settings && typeof settings === 'object' ? settings : {};
			return source.cadence && typeof source.cadence === 'object' ? source.cadence : {};
		}

		/**
		 * The settings page only owns the Feishu block now: the L1/L2 budget and the
		 * "precise collection" switch are gone from the model itself.
		 */
		function settingsDraftFrom(settings) {
			const source = settings && typeof settings === 'object' ? settings : {};
			const notify = source.notify && typeof source.notify === 'object' ? source.notify : {};
			return {
				// `app` = enterprise self-built bot (recommended), `webhook` = legacy custom bot.
				channel: notify.channel === 'webhook' ? 'webhook' : 'app',
				appId: typeof notify.appId === 'string' ? notify.appId : '',
				// GET /settings never returns the secret, only whether one is stored.
				appSecret: '',
				appSecretSet: notify.appSecretSet === true,
				chatId: typeof notify.chatId === 'string' ? notify.chatId : '',
				feishuWebhook: typeof notify.feishuWebhook === 'string' ? notify.feishuWebhook : '',
			};
		}

		function SettingsView(props) {
			const [draft, setDraft] = useState(() => settingsDraftFrom(props.settings));
			const [saving, setSaving] = useState(false);
			const [saved, setSaved] = useState(false);
			const [settingsError, setSettingsError] = useState(null);
			const [testing, setTesting] = useState(false);
			const [testResult, setTestResult] = useState(null);

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
				// Partial POST: the channel plus the fields that channel owns. An empty
				// App Secret is never sent, so the Host keeps the stored one.
				const notify = { channel: draft.channel === 'webhook' ? 'webhook' : 'app' };
				if (notify.channel === 'app') {
					notify.appId = draft.appId.trim();
					notify.chatId = draft.chatId.trim();
					const secret = draft.appSecret.trim();
					if (secret !== '') notify.appSecret = secret;
				} else {
					notify.feishuWebhook = draft.feishuWebhook.trim();
				}
				const body = { notify };
				setSaving(true);
				setSettingsError(null);
				// A stale test result must not look like it describes the new config.
				setTestResult(null);
				try {
					await props.onSaveSettings(body);
					setSaved(true);
				} catch (error) {
					setSettingsError(error && error.message ? error.message : String(error));
				} finally {
					setSaving(false);
				}
			};

			/**
			 * `POST /notify/test` sends one real card with the *saved* config, so the
			 * result says whether the stored channel works. The Host's own error text is
			 * surfaced verbatim; nothing is retried here.
			 */
			const sendTest = async () => {
				if (testing) return;
				setTesting(true);
				setTestResult(null);
				try {
					const data = await apiFetch('/notify/test', { method: 'POST' });
					const outcome = data && typeof data === 'object' ? data : {};
					if (outcome.ok === false) {
						const reason = typeof outcome.error === 'string' && outcome.error.trim() !== '' ? outcome.error.trim() : t('delivery.unknownError');
						setTestResult({ ok: false, message: reason });
					} else {
						setTestResult({ ok: true, message: '' });
					}
				} catch (error) {
					setTestResult({ ok: false, message: error && error.message ? error.message : t('delivery.unknownError') });
				} finally {
					setTesting(false);
				}
			};

			const statusSnapshot = props.status && typeof props.status === 'object' ? props.status : null;
			const statusNotify = statusSnapshot && statusSnapshot.notify && typeof statusSnapshot.notify === 'object' ? statusSnapshot.notify : null;
			const lastDelivery = statusNotify && statusNotify.lastDelivery && typeof statusNotify.lastDelivery === 'object' ? statusNotify.lastDelivery : null;
			const auth = statusSnapshot && statusSnapshot.auth && typeof statusSnapshot.auth === 'object' ? statusSnapshot.auth : null;
			const l2Live = l2State(statusSnapshot);
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

			const channel = draft.channel === 'webhook' ? 'webhook' : 'app';
			const channelPicker = h(
				'div',
				{ className: 'pw-field', key: 'channel' },
				h('span', { className: 'pw-label' }, t('settings.notify.channel')),
				h(SegControl, {
					role: 'group',
					label: t('settings.notify.channel'),
					value: channel,
					onChange: (next) => {
						update({ channel: next });
						setTestResult(null);
					},
					options: [
						{ id: 'app', label: t('settings.notify.channel.app') },
						{ id: 'webhook', label: t('settings.notify.channel.webhook') },
					],
				})
			);
			const secretPlaceholder = draft.appSecretSet ? t('settings.notify.appSecretSet') : t('settings.notify.appSecret');
			const channelFields =
				channel === 'app'
					? [
							h(
								Field,
								{ key: 'appId', label: t('settings.notify.appId') },
								h('input', {
									className: 'pw-input',
									spellCheck: false,
									autoComplete: 'off',
									value: draft.appId,
									placeholder: 'cli_…',
									onChange: (event) => update({ appId: event.target.value }),
								})
							),
							h(
								Field,
								{ key: 'appSecret', label: t('settings.notify.appSecret') },
								h('input', {
									className: 'pw-input',
									type: 'password',
									spellCheck: false,
									autoComplete: 'new-password',
									value: draft.appSecret,
									placeholder: secretPlaceholder,
									onChange: (event) => update({ appSecret: event.target.value }),
								})
							),
							h(
								'div',
								{ className: 'pw-field', key: 'chatId' },
								h('label', { className: 'pw-label' }, t('settings.notify.chatId')),
								h(
									'div',
									{ className: 'pw-row', style: { gap: 6, alignItems: 'center' } },
									h('input', {
										className: 'pw-input',
										spellCheck: false,
										autoComplete: 'off',
										value: draft.chatId,
										placeholder: t('settings.notify.chatIdPlaceholder'),
										onChange: (event) => update({ chatId: event.target.value }),
									}),
									h(InfoTip, { text: t('settings.notify.chatIdHelp'), align: 'end' })
								)
							),
							h(
								'div',
								{ className: 'pw-row', style: { gap: 8, alignItems: 'center', flexWrap: 'wrap' }, key: 'test' },
								h(Button, { onClick: () => void sendTest(), disabled: testing || props.loading === true }, testing ? t('settings.notify.testing') : t('settings.notify.test')),
								testResult === null
									? null
									: h(
											'span',
											{ className: 'pw-test-result', 'data-ok': testResult.ok ? 'true' : 'false', role: 'status' },
											testResult.ok ? t('settings.notify.testOk') : t('settings.notify.testFailed', { error: testResult.message })
										)
							),
						]
					: [
							h(
								'div',
								{ className: 'pw-field', key: 'webhook' },
								h('label', { className: 'pw-label' }, t('settings.feishu.label')),
								h(
									'div',
									{ className: 'pw-row', style: { gap: 6, alignItems: 'center' } },
									h('input', {
										className: 'pw-input',
										type: 'url',
										spellCheck: false,
										autoComplete: 'off',
										placeholder: t('settings.feishu.placeholder'),
										value: draft.feishuWebhook,
										onChange: (event) => update({ feishuWebhook: event.target.value }),
									}),
									h(InfoTip, { text: t('settings.feishu.help'), align: 'end' })
								)
							),
						];

			return h(
				PageShell,
				{
					lead: h(IconButton, { label: t('settings.back'), onClick: props.onBack }, h(BackIcon, { size: 18 })),
					title: t('settings.title'),
					actions: [
						saved ? h('span', { className: 'pw-notice', key: 'saved' }, h(CheckIcon, { size: 13 }), t('settings.saved')) : null,
						h(Button, { key: 'save', variant: 'primary', onClick: () => void saveSettings(), disabled: saving || props.loading === true || props.settings === null }, saving ? t('settings.saving') : t('settings.save')),
					],
				},
				props.banner,
				props.error ? h(ErrorBar, { key: 'reload-error', message: props.error, inline: true, onRetry: props.onReload }) : null,
				settingsError === null ? null : h(ErrorBar, { key: 'save-error', message: settingsError, inline: true }),
				h(
					Section,
					{ key: 'auth', title: t('settings.auth.title') },
					h(
						'div',
						{ className: 'pw-row', style: { flexWrap: 'wrap', gap: 8 } },
						h(AuthChip, { status: statusSnapshot, pending: loginPending, onLogin: signIn }),
						h(
							'span',
							{ className: 'pw-hint' },
							auth !== null && typeof auth.lastVerifiedAt === 'string' && auth.lastVerifiedAt !== ''
								? t('settings.auth.lastVerified', { time: relativeTime(auth.lastVerifiedAt) })
								: t('settings.auth.neverVerified')
						)
					),
					h(
						'div',
						{ className: 'pw-row', style: { gap: 8, flexWrap: 'wrap' } },
						h(Button, { onClick: () => void signIn(), disabled: loginPending || l2Live.available === false }, loginPending ? t('login.pending') : t('settings.login')),
						h(Button, { variant: 'danger', onClick: () => void signOut(), disabled: loginPending || !signedIn }, t('settings.logout'))
					)
				),
				h(
					Section,
					{ key: 'feishu', title: t('settings.feishu.title') },
					channelPicker,
					...channelFields,
					// Same status line as the watch detail footer (A2 §4.5).
					h(DeliveryLine, { key: 'delivery', delivery: lastDelivery })
				)
			);
		}

		// #endregion

		// #region new view
		/**
		 * Keyboard intent for the city picker, kept pure so it can be exercised without
		 * a DOM: `close`, `open`, `move` the highlight, or `pick` the highlighted row.
		 */
		function cityKeyAction(key, open, optionCount, highlight) {
			if (key === 'Escape') return { type: 'close' };
			if (key === 'Enter') {
				if (!open || optionCount === 0) return null;
				return { type: 'pick', index: Math.min(Math.max(highlight, 0), optionCount - 1) };
			}
			if (key !== 'ArrowDown' && key !== 'ArrowUp') return null;
			if (!open || optionCount === 0) return { type: 'open' };
			const delta = key === 'ArrowDown' ? 1 : -1;
			const current = Math.min(Math.max(highlight, 0), optionCount - 1);
			return { type: 'move', index: (current + delta + optionCount) % optionCount };
		}

		/**
		 * City picker: searches the built-in catalog by Chinese name, alias or IATA
		 * code, groups the hits into 国内 / 国际, and supports ↑ ↓ / Enter / Esc. A
		 * finished pick is written back as `北京 BJS`; a bare three-letter search the
		 * catalog does not know also offers a `直接使用 XXX` fallback so unlisted
		 * airports stay reachable.
		 */
		function CityField(props) {
			const [open, setOpen] = useState(false);
			const [highlight, setHighlight] = useState(0);
			const query = typeof props.query === 'string' ? props.query : '';
			const listId = useMemo(() => `pw-city-${Math.random().toString(36).slice(2, 8)}`, []);
			const search = useMemo(() => (open ? citySearch(query) : { results: [], fallback: null }), [open, query, runtime.revision.get()]);
			const options = search.fallback === null ? search.results : search.results.concat([search.fallback]);
			const showEmpty = open && query.trim() !== '' && options.length === 0;

			useEffect(() => {
				setHighlight(0);
			}, [query, open]);

			const pick = (code) => {
				setOpen(false);
				props.onPick(code);
			};

			const handleKeyDown = (event) => {
				const action = cityKeyAction(event.key, open, options.length, highlight);
				if (action === null) return;
				if (action.type === 'close') {
					setOpen(false);
					return;
				}
				if (action.type === 'open') {
					event.preventDefault();
					setOpen(true);
					return;
				}
				if (action.type === 'move') {
					event.preventDefault();
					setHighlight(action.index);
					return;
				}
				const target = options[action.index];
				if (target === undefined) return;
				event.preventDefault();
				pick(target.code);
			};

			// Group headers render inline; `optionIndex` keeps the flat keyboard order in
			// sync with what the user sees.
			const rows = [];
			let group = null;
			let optionIndex = 0;
			search.results.forEach((result) => {
				const groupKey = result.intl ? 'intl' : 'domestic';
				if (group !== groupKey) {
					group = groupKey;
					rows.push(h('div', { className: 'pw-combo-group', key: `group-${groupKey}`, role: 'presentation' }, t(result.intl ? 'new.cityGroup.intl' : 'new.cityGroup.domestic')));
				}
				const index = optionIndex;
				optionIndex += 1;
				rows.push(
					h(
						'button',
						{
							key: result.code,
							type: 'button',
							id: `${listId}-${index}`,
							className: 'pw-combo-item',
							role: 'option',
							'aria-selected': index === highlight ? 'true' : 'false',
							'data-highlight': index === highlight ? 'true' : 'false',
							onMouseEnter: () => setHighlight(index),
							onMouseDown: (event) => {
								event.preventDefault();
								pick(result.code);
							},
						},
						h('span', null, result.name),
						h('span', { className: 'pw-combo-code' }, result.code)
					)
				);
			});
			if (search.fallback !== null) {
				const index = optionIndex;
				rows.push(
					h(
						'button',
						{
							key: 'fallback',
							type: 'button',
							className: 'pw-combo-item pw-combo-fallback',
							role: 'option',
							'aria-selected': index === highlight ? 'true' : 'false',
							'data-highlight': index === highlight ? 'true' : 'false',
							onMouseEnter: () => setHighlight(index),
							onMouseDown: (event) => {
								event.preventDefault();
								pick(search.fallback.code);
							},
						},
						h('span', null, t('new.cityUseCode', { code: search.fallback.code }))
					)
				);
			}

			return h(
				'div',
				{ className: 'pw-combo' },
				h('input', {
					className: 'pw-input',
					value: query,
					placeholder: t('new.cityPlaceholder'),
					autoComplete: 'off',
					spellCheck: false,
					role: 'combobox',
					'aria-autocomplete': 'list',
					'aria-expanded': open ? 'true' : 'false',
					'aria-controls': open && rows.length > 0 ? listId : undefined,
					onChange: (event) => {
						setOpen(true);
						props.onQuery(event.target.value);
					},
					onFocus: () => setOpen(true),
					onBlur: () => window.setTimeout(() => setOpen(false), 120),
					onKeyDown: handleKeyDown,
				}),
				open && rows.length > 0 ? h('div', { className: 'pw-combo-list', role: 'listbox', id: listId }, rows) : null,
				showEmpty
					? h('div', { className: 'pw-combo-list' }, h('div', { className: 'pw-combo-item', style: { color: 'var(--dsw-alias-label-secondary)' } }, t('new.cityEmpty')))
					: null
			);
		}

		/** Passenger manager dialog: list, add form and delete, with the Host's own errors. */
		function PassengerDialog(props) {
			const passengers = Array.isArray(props.passengers) ? props.passengers : [];
			const [form, setForm] = useState({ nickname: '', type: 'adult', age: '' });
			const [error, setError] = useState(null);
			const [busy, setBusy] = useState(false);

			const submit = async () => {
				const nickname = form.nickname.trim();
				if (nickname === '') {
					setError(t('passengers.nicknameRequired'));
					return;
				}
				const type = PASSENGER_TYPES.indexOf(form.type) >= 0 ? form.type : 'adult';
				const body = { nickname, type };
				const ageRaw = form.age.trim();
				if (ageRaw !== '') {
					const age = Number(ageRaw);
					if (!Number.isFinite(age) || age < 0 || age > 120) {
						setError(t('passengers.ageInvalid'));
						return;
					}
					body.age = Math.round(age);
				}
				setBusy(true);
				setError(null);
				try {
					await props.onAdd(body);
					setForm({ nickname: '', type: 'adult', age: '' });
				} catch (reason) {
					setError(reason && reason.message ? reason.message : String(reason));
				} finally {
					setBusy(false);
				}
			};

			const remove = async (passenger) => {
				const confirmed = typeof window.confirm === 'function' ? window.confirm(t('passengers.deleteConfirm', { name: passenger.nickname })) : true;
				if (!confirmed) return;
				setBusy(true);
				setError(null);
				try {
					await props.onDelete(passenger);
				} catch (reason) {
					setError(reason && reason.message ? reason.message : t('passengers.referenced'));
				} finally {
					setBusy(false);
				}
			};

			return h(
				Modal,
				{ title: t('passengers.title'), onClose: props.onClose },
				passengers.length === 0
					? h('p', { className: 'pw-hint', style: { margin: 0 } }, t('passengers.empty'))
					: h(
							'div',
							{ style: { display: 'flex', flexDirection: 'column', gap: 8 } },
							passengers.map((passenger) =>
								h(
									'div',
									{ className: 'pw-listitem', key: passenger.id },
									h('span', { className: 'pw-listitem-name pw-ellipsis' }, passenger.nickname),
									h(Chip, { tone: 'flat' }, PASSENGER_TYPES.indexOf(passenger.type) >= 0 ? t(`type.${passenger.type}`) : passenger.type),
									typeof passenger.age === 'number' && Number.isFinite(passenger.age) ? h('span', { className: 'pw-hint' }, `${passenger.age} ${t('passengers.ageUnit')}`) : null,
									h('span', { className: 'pw-spacer' }),
									h(IconButton, { label: t('passengers.delete'), onClick: () => void remove(passenger), disabled: busy }, h(TrashIcon, { size: 14 }))
								)
							)
						),
				h('div', { className: 'pw-divider' }),
				h(
					'div',
					{ className: 'pw-form-row' },
					h(Field, { label: t('passengers.nickname') }, h('input', { className: 'pw-input', value: form.nickname, placeholder: '—', onChange: (event) => setForm({ ...form, nickname: event.target.value }) })),
					h(
						Field,
						{ label: t('passengers.type') },
						h(
							'select',
							{ className: 'pw-input', value: form.type, onChange: (event) => setForm({ ...form, type: event.target.value }) },
							PASSENGER_TYPES.map((type) => h('option', { key: type, value: type }, t(`type.${type}`)))
						)
					),
					h(
						Field,
						{ label: t('passengers.age') },
						h('input', { className: 'pw-input', type: 'number', min: 0, max: 120, inputMode: 'numeric', value: form.age, onChange: (event) => setForm({ ...form, age: event.target.value }) })
					),
					h(Button, { icon: h(PlusIcon, { size: 14 }), onClick: () => void submit(), disabled: busy }, t('passengers.add'))
				),
				error === null ? null : h('p', { className: 'pw-hint', style: { margin: 0, color: 'var(--dsw-alias-state-error-primary)' }, role: 'alert' }, error)
			);
		}

		function NewView(props) {
			const [depQuery, setDepQuery] = useState('');
			const [depCode, setDepCode] = useState('');
			const [arrQuery, setArrQuery] = useState('');
			const [arrCode, setArrCode] = useState('');
			const [trip, setTrip] = useState('oneway');
			const [datesFixed, setDatesFixed] = useState(false);
			const [departDate, setDepartDate] = useState('');
			const [returnDate, setReturnDate] = useState('');
			// Nothing is selected by default. A watch needs at least one passenger;
			// a calendar monitor may go without (the calendar price is passenger-agnostic).
			const [selected, setSelected] = useState([]);
			const [advancedOpen, setAdvancedOpen] = useState(false);
			const [cadenceTouched, setCadenceTouched] = useState(false);
			// Both modes draw from the same ladder; only the defaults differ.
			const [calendarMinutes, setCalendarMinutes] = useState(CADENCE_DEFAULT);
			const [watchMinutes, setWatchMinutes] = useState(CADENCE_DEFAULT);
			const [managerOpen, setManagerOpen] = useState(false);
			const [error, setError] = useState(null);
			const [submitting, setSubmitting] = useState(false);
			const passengers = Array.isArray(props.passengers) ? props.passengers : null;
			const mode = datesFixed ? 'watch' : 'calendar';
			const ids = Array.isArray(selected) ? selected : [];
			// 行情模式可以不选乘客；只有定了日期的监控才强制至少一位。
			const canSubmit = submitting === false && (datesFixed ? ids.length > 0 : true);

			// Keep only ids that still exist; a later reload never re-selects anything.
			useEffect(() => {
				if (passengers === null) return;
				setSelected((current) => (Array.isArray(current) ? current.filter((id) => passengers.some((passenger) => passenger.id === id)) : []));
			}, [passengers]);

			// The advanced cadence select starts on the global defaults from /settings
			// (`cadence.calendarMinutes` for calendar, `cadence.watchMinutes` for watch).
			useEffect(() => {
				const cadence = settingsCadence(props.settings);
				setCalendarMinutes(defaultCadence(cadence.calendarMinutes));
				setWatchMinutes(defaultCadence(cadence.watchMinutes));
			}, [props.settings]);

			const togglePassenger = (id) => {
				setSelected((current) => {
					const list = Array.isArray(current) ? current : [];
					return list.indexOf(id) >= 0 ? list.filter((entry) => entry !== id) : list.concat([id]);
				});
			};

			const submit = async () => {
				const dep = resolveCity(depQuery) || (depCode !== '' ? depCode : null);
				const arr = resolveCity(arrQuery) || (arrCode !== '' ? arrCode : null);
				if (dep === null || arr === null) {
					setError(t('new.invalidCode'));
					return;
				}
				if (dep === arr) {
					setError(t('new.sameCode'));
					return;
				}
				if (datesFixed) {
					if (!/^\d{4}-\d{2}-\d{2}$/.test(departDate)) {
						setError(t('new.departRequired'));
						return;
					}
					if (trip === 'round') {
						if (!/^\d{4}-\d{2}-\d{2}$/.test(returnDate)) {
							setError(t('new.returnRequired'));
							return;
						}
						if (returnDate <= departDate) {
							setError(t('new.returnOrder'));
							return;
						}
					}
				}
				// Host enforces the same rule; surfacing it here keeps the message local.
				if (datesFixed && ids.length === 0) {
					setError(t('new.passengerRequired'));
					return;
				}
				const body = { trip, dep, arr, passengerIds: ids.slice() };
				if (datesFixed) {
					body.departDate = departDate;
					if (trip === 'round') body.returnDate = returnDate;
				}
				// Optional: only an explicit choice overrides the global default.
				// Untouched ⇒ no `cadence` at all, so the Host applies its global default.
				if (cadenceTouched) {
					body.cadence = { minutes: mode === 'calendar' ? calendarMinutes : watchMinutes };
				}
				setSubmitting(true);
				setError(null);
				try {
					await props.onCreate(body);
				} catch (reason) {
					setError(reason && reason.message ? reason.message : String(reason));
				} finally {
					setSubmitting(false);
				}
			};

			const passengerBlock =
				passengers === null
					? h(Skeleton, { height: 42, radius: 12 })
					: passengers.length === 0
						? h(
								'div',
								{ className: 'pw-row', style: { gap: 10, flexWrap: 'wrap' } },
								h('span', { className: 'pw-hint' }, t('new.passengers.empty')),
								h(Button, { size: 'sm', icon: h(PlusIcon, { size: 13 }), onClick: () => setManagerOpen(true) }, t('passengers.new'))
							)
						: h(
								'div',
								{ className: 'pw-row', style: { flexWrap: 'wrap', gap: 8 } },
								passengers.map((passenger) => {
									const active = ids.indexOf(passenger.id) >= 0;
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
				PageShell,
				{
					lead: h(IconButton, { label: t('new.back'), onClick: props.onBack }, h(BackIcon, { size: 18 })),
					title: t('new.title'),
				},
				props.banner,
				h(
					'div',
					{ className: 'pw-form' },
					h(
						Group,
						{ key: 'route', title: t('new.route.title') },
						h(
							'div',
							{ className: 'pw-form-row' },
							h(Field, { label: t('new.from') }, h(CityField, { query: depQuery, onQuery: (value) => { setDepQuery(value); setDepCode(resolveCity(value) || ''); }, onPick: (code) => { setDepCode(code); setDepQuery(citySelectionLabel(code)); } })),
							h(Field, { label: t('new.to') }, h(CityField, { query: arrQuery, onQuery: (value) => { setArrQuery(value); setArrCode(resolveCity(value) || ''); }, onPick: (code) => { setArrCode(code); setArrQuery(citySelectionLabel(code)); } }))
						)
					),
					h(
						Group,
						{ key: 'trip', title: t('new.trip.title') },
						h(SegControl, {
							label: t('new.trip.title'),
							value: trip,
							onChange: setTrip,
							options: [
								{ id: 'oneway', label: t('new.trip.oneway') },
								{ id: 'round', label: t('new.trip.round') },
							],
						})
					),
					h(
						Group,
						{ key: 'date', title: t('new.date.title') },
						h(
							'div',
							{ className: 'pw-row', style: { gap: 8 } },
							h(Switch, { checked: datesFixed, label: t('new.date.known'), onChange: (next) => setDatesFixed(next) }),
							h('span', null, t('new.date.known'))
						),
						datesFixed
							? h(
									'div',
									{ className: 'pw-form-row' },
									h(Field, { label: t('new.departDate') }, h(DateField, { value: departDate, onChange: setDepartDate })),
									trip === 'round' ? h(Field, { label: t('new.returnDate') }, h(DateField, { value: returnDate, min: departDate || undefined, onChange: setReturnDate })) : null
								)
							: null
					),
					h(
						Group,
						{
							key: 'passengers',
							title: t('new.passengers.title'),
							action: passengers === null ? null : h('button', { type: 'button', className: 'pw-linkbtn', onClick: () => setManagerOpen(true) }, t('passengers.manage')),
						},
						passengerBlock,
						// 行情价是平台最低参考价，乘客选择只影响「监控」模式。
						mode === 'calendar' ? h('span', { className: 'pw-hint' }, t('new.passengers.calendarHint')) : null
					),
					h(
						'div',
						{ key: 'advanced', className: 'pw-adv' },
						h(
							'button',
							{
								type: 'button',
								className: 'pw-adv-toggle',
								'aria-expanded': advancedOpen ? 'true' : 'false',
								onClick: () => setAdvancedOpen(!advancedOpen),
							},
							h(ChevronDownIcon, { size: 14 }),
							h('span', null, t('new.advanced.title'))
						),
						advancedOpen
							? h(
									'div',
									{ className: 'pw-adv-body' },
									h(
										Field,
										{ label: t('new.advanced.cadence') },
										h(
											'select',
											{
												className: 'pw-input',
												value: String(mode === 'calendar' ? calendarMinutes : watchMinutes),
												onChange: (event) => {
													const value = clampCadence(Number(event.target.value));
													if (value === null) return;
													setCadenceTouched(true);
													if (mode === 'calendar') setCalendarMinutes(value);
													else setWatchMinutes(value);
												},
											},
											CADENCE_MINUTES.map((value) => h('option', { key: value, value: String(value) }, cadenceDuration(value)))
										)
									)
								)
							: null
					),
					error === null ? null : h(ErrorBar, { key: 'error', message: error, inline: true, onDismiss: () => setError(null) }),
					h(
						'div',
						{ key: 'submit', className: 'pw-row', style: { justifyContent: 'flex-end', gap: 8 } },
						h(Button, { onClick: props.onBack, disabled: submitting }, t('new.back')),
						h(Button, { variant: 'primary', onClick: () => void submit(), disabled: !canSubmit }, submitting ? t('new.submitting') : t(mode === 'watch' ? 'new.submit.watch' : 'new.submit.calendar'))
					)
				),
				managerOpen
					? h(PassengerDialog, {
							key: 'manager',
							passengers,
							onAdd: props.onAddPassenger,
							onDelete: props.onDeletePassenger,
							onClose: () => setManagerOpen(false),
						})
					: null
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
			const [flights, setFlights] = useState(null);
			const [flightsError, setFlightsError] = useState(null);
			const [calendar, setCalendar] = useState(null);
			const [calendarError, setCalendarError] = useState(null);
			const [busyKey, setBusyKey] = useState(null);
			// Two filter levels: type is sticky, mode is only meaningful for flights.
			const [filterType, setFilterType] = useState('flight');
			const [filterMode, setFilterMode] = useState('all');
			const [refreshing, setRefreshing] = useState(false);
			const [dataLoading, setDataLoading] = useState(false);
			const [tick, setTick] = useState(0);
			const [auxReloadKey, setAuxReloadKey] = useState(0);
			// `/login/start` stays open while the user signs in (up to 8 minutes).
			const [loginPending, setLoginPending] = useState(false);

			const coreSeq = useRef(0);
			const pricesSeq = useRef(0);
			const calendarSeq = useRef(0);
			const auxSeq = useRef(0);
			const loginRef = useRef(false);

			// #region data loading
			const loadCore = useCallback(async (options) => {
				const manual = options && options.manual === true;
				const seq = coreSeq.current + 1;
				coreSeq.current = seq;
				if (manual) setRefreshing(true);
				try {
					const results = await Promise.allSettled([apiFetch('/monitors'), apiFetch('/status'), apiFetch('/settings')]);
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
					if (results[2].status === 'fulfilled') {
						const next = results[2].value;
						// Keep the same object when nothing changed so the 30s poll cannot
						// reset the settings form while the user is editing it.
						setSettings((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
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
			const detailMonitor = detailId === null || monitors === null ? null : monitors.find((monitor) => monitor.id === detailId) || null;
			const detailMode = detailMonitor === null ? null : monitorMode(detailMonitor);
			// Global rhythm defaults, used by the list cards for monitors that inherit.
			const globalCadence = settingsCadence(settings);
			const cadenceDefaults = {
				calendar: defaultCadence(globalCadence.calendarMinutes),
				watch: defaultCadence(globalCadence.watchMinutes),
			};

			useEffect(() => {
				setPrices(null);
				setPricesError(null);
				setFlights(null);
				setFlightsError(null);
				setCalendar(null);
				setCalendarError(null);
			}, [detailId]);

			// Watch mode: reference + per-passenger series and the last flight snapshot.
			useEffect(() => {
				if (detailId === null || detailMode !== 'watch') return undefined;
				const seq = pricesSeq.current + 1;
				pricesSeq.current = seq;
				Promise.allSettled([apiFetch(`/monitors/${encodeURIComponent(detailId)}/prices?days=${PRICE_DAYS}`), apiFetch(`/monitors/${encodeURIComponent(detailId)}/flights`)]).then((results) => {
					if (seq !== pricesSeq.current) return;
					if (results[0].status === 'fulfilled') {
						setPrices(results[0].value && typeof results[0].value === 'object' ? results[0].value : null);
						setPricesError(null);
					} else {
						setPricesError(results[0].reason && results[0].reason.message ? results[0].reason.message : String(results[0].reason));
					}
					if (results[1].status === 'fulfilled') {
						setFlights(results[1].value && typeof results[1].value === 'object' ? results[1].value : null);
						setFlightsError(null);
					} else {
						setFlightsError(results[1].reason && results[1].reason.message ? results[1].reason.message : String(results[1].reason));
					}
				});
				return () => {
					pricesSeq.current += 1;
				};
			}, [detailId, detailMode, tick]);

			// Calendar mode: the 380-day fare calendar for the picked route.
			useEffect(() => {
				if (detailId === null || detailMode !== 'calendar') return undefined;
				const seq = calendarSeq.current + 1;
				calendarSeq.current = seq;
				apiFetch(`/monitors/${encodeURIComponent(detailId)}/calendar`)
					.then((data) => {
						if (seq !== calendarSeq.current) return;
						setCalendar(data && typeof data === 'object' ? data : null);
						setCalendarError(null);
					})
					.catch((reason) => {
						if (seq !== calendarSeq.current) return;
						setCalendarError(reason && reason.message ? reason.message : String(reason));
					});
				return () => {
					calendarSeq.current += 1;
				};
			}, [detailId, detailMode, tick]);

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

			// Detail views name passengers, and the calendar pin bar may need to pick
			// one, so the roster is read on demand even if the user never opened the
			// new/settings view. `tick` retries a failed read on the next poll.
			useEffect(() => {
				if (view.kind !== 'detail' || passengers !== null) return undefined;
				let live = true;
				apiFetch('/passengers')
					.then((data) => {
						if (live) setPassengers(data && Array.isArray(data.passengers) ? data.passengers : []);
					})
					.catch(() => {
						/* the roster is optional here; the rest of the page still works */
					});
				return () => {
					live = false;
				};
			}, [view, passengers, tick]);
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
						// One manual trigger for both modes; the old `{ l2 }` flag is gone.
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

			/** Turn a picked calendar day into a watch monitor (dates fixed). */
			const pinDate = useCallback(
				async (monitor, selection) => {
					if (!monitor || !selection || typeof selection.departDate !== 'string') return;
					const params = monitorParams(monitor);
					const trip = monitorTrip(monitor);
					const sourceIds = Array.isArray(monitor.passengerIds) ? monitor.passengerIds.slice() : [];
					const passengerIds = Array.isArray(selection.passengerIds) ? selection.passengerIds.slice() : sourceIds;
					// 钉住生成的是 watch 监控，Host 要求至少一位乘客：宁可在这里拦住，
					// 也不能把空乘客发出去换一个 400。
					if (passengerIds.length === 0) {
						fail(new Error(t('calendar.pinNeedPassenger')));
						return;
					}
					const key = `pin:${monitor.id}`;
					setBusyKey(key);
					try {
						const body = { trip, dep: params.dep, arr: params.arr, departDate: selection.departDate, passengerIds };
						if (trip === 'round' && typeof selection.returnDate === 'string') body.returnDate = selection.returnDate;
						const data = await apiFetch('/monitors', { method: 'POST', body });
						const created = data && data.monitor && typeof data.monitor === 'object' ? data.monitor : null;
						await loadCore();
						if (created && typeof created.id === 'string') setView({ kind: 'detail', monitorId: created.id });
						else setView({ kind: 'list', monitorId: null });
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

			/** Only `cadence` is sent; the detail page re-reads it after the save. */
			const saveCadence = useCallback(
				async (id, cadence) => {
					await apiFetch(`/monitors/${encodeURIComponent(id)}`, { method: 'PATCH', body: { cadence } });
					await loadCore();
					// Re-read the detail payload so the page reflects the new rhythm at once.
					setTick((value) => value + 1);
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

			// Every view owns the full page shell, so the one shared error bar rides in
			// each view's content column instead of floating above the fixed head.
			const banner = h(ErrorBar, {
				message: error,
				onRetry: () => void loadCore({ manual: true }),
				onDismiss: () => setError(null),
			});

			let content = null;
			if (view.kind === 'detail') {
				content =
					detailMonitor === null
						? h(
								PageShell,
								{ title: t('nav') },
								h(Skeleton, { height: 28, width: '40%' }),
								h(Skeleton, { height: 180, radius: 16 }),
								h(Skeleton, { height: 70, radius: 16 })
							)
						: h(DetailView, {
								monitor: detailMonitor,
								passengers,
								calendar,
								calendarError,
								prices,
								pricesError,
								flights,
								flightsError,
								status,
								banner,
								busy: busyKey !== null,
								onBack: goList,
								onToggleEnabled: toggleEnabled,
								onRefresh: refreshMonitor,
								onDelete: deleteMonitor,
								onSaveCadence: saveCadence,
								onSettings: goSettings,
								onPin: (selection) => void pinDate(detailMonitor, selection),
							});
			} else if (view.kind === 'settings') {
				content = h(SettingsView, {
					settings,
					passengers,
					status,
					loading: dataLoading,
					error: settingsError,
					banner,
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
					banner,
					onCreate: createMonitor,
					onAddPassenger: addPassenger,
					onDeletePassenger: deletePassenger,
					onBack: goList,
				});
			} else {
				content = h(ListView, {
					monitors,
					status,
					cadenceDefaults,
					filterType,
					filterMode,
					banner,
					refreshing,
					busyKey,
					loginPending,
					onLogin: startLogin,
					onTypeChange: (next) => {
						setFilterType(next);
						// A type switch always drops back to the full mode list.
						setFilterMode('all');
					},
					onModeChange: setFilterMode,
					onOpen: openDetail,
					onToggle: toggleEnabled,
					onNew: goNew,
					onSettings: goSettings,
					onRefresh: () => void loadCore({ manual: true }),
				});
			}

			return h('div', { className: 'pw-root' }, content);
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
					const syncLocale = () => {
						let active = '';
						try {
							const snapshot = ctx.locale.getSnapshot();
							active = snapshot && typeof snapshot.active === 'string' ? snapshot.active : '';
						} catch (error) {
							active = '';
						}
						runtime.activeLocale = active.toLowerCase().indexOf('en') === 0 ? 'en' : 'zh';
					};
					syncLocale();

					ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'price-watch: dictionaries');
					ctx.effect(
						() =>
							ctx.locale.subscribe(() => {
								syncLocale();
								runtime.revision.bump();
							}),
						'price-watch: locale revisions'
					);

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
