/**
 * 图提取 ImageGrab —— Content Script（内容脚本）
 *
 * 职责：
 *  1. 在淘宝 / 京东 / 拼多多商家版的「商品详情页」右下角注入「获取图片」悬浮按钮
 *     （使用 Shadow DOM 隔离样式，避免被页面 CSS 污染 / 遮挡）
 *  2. 点击后扫描页面全部商品图：
 *     <img> 的 src / srcset、data-* 懒加载属性、内联背景图 background-image
 *  3. 过滤图标 / logo / 占位图 / 1x1 / 小于 100x100 的图，
 *     补全相对路径为绝对 URL，尝试升级为原图地址，最后去重
 *  4. 结果写入 chrome.storage.local，并通知 Service Worker 打开画廊页
 */
(() => {
  'use strict';

  /* ====================== 可调参数 ====================== */
  const MIN_SIZE = 100;            // 小于该边长(px)的图视为装饰图标，过滤
  const MAX_IMAGES = 500;          // 最多提取数量，防止极端页面卡死
  const PROBE_TIMEOUT = 8000;      // 探测图片真实尺寸的超时(ms)
  const PROBE_CONCURRENCY = 5;     // 尺寸探测并发数

  const BTN_ID = 'imagegrab-fab-host';          // 悬浮按钮宿主元素 id
  const STORAGE_KEY = 'imagegrab_last_extract'; // 与 background / gallery 约定的存储键

  /* ====================== 规则配置 ====================== */

  /** 各平台懒加载常用的 data-* 属性（做兼容处理，命中即视为图片地址） */
  const LAZY_ATTRS = [
    'data-src', 'data-lazy-src', 'data-original', 'data-lazyload',
    'data-lazy', 'data-lazy-img', 'data-actualsrc', 'data-real-src',
    'data-img', 'data-url', 'data-ks-lazyload', 'data-kdx-src'
  ];

  /** 明显是图标 / logo / 占位图 的 URL 关键词（大小写不敏感） */
  const NOISE_RE = /(icon|logo|sprite|placeholder|blank|spacer|pixel|avatar|loading|lazy-?load(ing)?\.(png|gif|svg)|default[_-]?img|1x1|emoji|badge|corner-mark)/i;

  /**
   * 详情页 URL 特征：
   *  - 淘宝/天猫：item.htm、detail.tmall.com、main.tmall.com ...
   *  - 京东：item.jd.com/100012043978.html（/数字.html）
   *  - 拼多多/商家版：goods.html、mms 后台商品页
   */
  const DETAIL_URL_RE = /(item\.htm|detail\.tmall|main\.tmall|item\.jd\.com|\/\d{6,}\.html|goods\.html|\/goods\/|\/goods_detail|\/product\/|\/chanpin\/|sku\.pinduoduo)/i;

  /* 阿里 CDN 缩略图后缀：xxx.jpg_400x400q90.jpg —— 去掉即得原图 */
  const TB_THUMB_RE = /^(.*\.(?:jpe?g|png|webp|gif))_\d+x\d+[a-z0-9_-]*\.(?:jpe?g|png|webp|gif)(\?.*)?$/i;
  /* 京东 CDN 缩放段：/s450x450_jfs/... —— 去掉缩放段即得较大图 */
  const JD_SIZE_SEG_RE = /^(https?:\/\/[^/]+\/[^/]+\/)s\d+x\d+_(.+)$/i;
  /* 拼多多 pddpic 缩放参数：?imageView2/2/w/600/... —— 去掉即得原图 */
  const PDD_SCALE_QS_RE = /\?imageView2.*$/i;

  /* ====================== 工具函数 ====================== */

  /** 相对路径 / 协议相对路径 → 绝对 URL；非法返回 null */
  function toAbsoluteUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s || s.startsWith('javascript:')) return null;
    try {
      return new URL(s, location.href).href;
    } catch {
      return null;
    }
  }

  /**
   * 尝试把缩略图 URL「升级」为原图 URL，提升下载画质。
   * 升级失败不影响使用：画廊页加载失败时会自动回退原始 URL。
   */
  function upgradeUrl(absUrl) {
    let u = absUrl;
    // 1) 阿里系：xxx.jpg_400x400q90.jpg → xxx.jpg
    const m = u.match(TB_THUMB_RE);
    if (m) return m[1] + (m[2] || '');
    // 2) 京东：/n1/s450x450_jfs/xxx.jpg → /n1/jfs/xxx.jpg
    const j = u.match(JD_SIZE_SEG_RE);
    if (j) return j[1] + j[2];
    // 3) 拼多多商家版：去掉 ?imageView2 缩放参数（注意 yangkeduo 带签名串，不动 query）
    try {
      const host = new URL(u).hostname;
      if (/pddpic\.com$/i.test(host)) return u.replace(PDD_SCALE_QS_RE, '');
    } catch { /* ignore */ }
    return u;
  }

  /** 去重键：协议 + 域名 + 路径（忽略 query，避免同一文件因签名参数不同而重复） */
  function dedupeKey(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch {
      return url;
    }
  }

  /** 从 srcset 中选出分辨率最大的一张（描述符如 2x / 640w，无描述符按 1 处理） */
  function pickLargestFromSrcset(srcset) {
    if (!srcset) return null;
    let best = null, bestW = -1;
    for (const part of srcset.split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const m = seg.match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)[wx])?$/i);
      if (!m) continue;
      const weight = m[2] ? parseFloat(m[2]) : 1;
      if (weight > bestW) { bestW = weight; best = m[1]; }
    }
    return best;
  }

  /** 元素的「可见尺寸」，取渲染尺寸与 natural 尺寸中的较大者 */
  function elementSize(img) {
    const w = Math.max(img.naturalWidth || 0, img.clientWidth || 0, img.width || 0);
    const h = Math.max(img.naturalHeight || 0, img.clientHeight || 0, img.height || 0);
    return { w, h };
  }

  /**
   * 用 new Image() 探测跨域图片的真实尺寸（无需 CORS，仅解码不读像素）。
   * 升级版 URL 加载失败时自动回退原始 URL，并把 record.url 换回可用的那个。
   */
  function probeSize(record) {
    return new Promise((resolve) => {
      const attempt = (url, isFallback) => {
        const im = new Image();
        let settled = false;
        const finish = (val) => {
          if (settled) return;
          settled = true;
          resolve(val);
        };
        const timer = setTimeout(() => finish(null), PROBE_TIMEOUT);
        im.onload = () => {
          clearTimeout(timer);
          const w = im.naturalWidth, h = im.naturalHeight;
          if (!w || !h) return finish(null);
          if (isFallback) record.url = url; // 升级版不可用，回退原始 URL
          finish({ w, h });
        };
        im.onerror = () => {
          clearTimeout(timer);
          if (!isFallback && record.originalUrl && record.originalUrl !== record.url) {
            attempt(record.originalUrl, true);
          } else {
            finish(null);
          }
        };
        im.src = url;
      };
      attempt(record.url, false);
    });
  }

  /** 并发池：按 limit 并发执行任务数组 */
  async function runPool(tasks, limit) {
    const ret = new Array(tasks.length);
    let idx = 0;
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (idx < tasks.length) {
        const i = idx++;
        ret[i] = await tasks[i]();
      }
    });
    await Promise.all(workers);
    return ret;
  }

  /* ====================== 图片收集 ====================== */

  /**
   * 扫描页面，收集所有候选图片。
   * @returns {{records: Map<string, object>, count: number}}
   */
  function collectCandidates() {
    const records = new Map(); // dedupeKey -> record

    const add = (rawUrl, size, source) => {
      const abs = toAbsoluteUrl(rawUrl);
      if (!abs) return;
      // 仅接受 http(s) 与 data:（data: 大图偶见于详情页正文）
      if (!/^(https?:|data:image\/)/i.test(abs)) return;
      // data: 图片仅保留「元素足够大」的（图标多为 data: 小图）
      if (abs.startsWith('data:') && size && (size.w < MIN_SIZE || size.h < MIN_SIZE)) return;
      // 命中噪声关键词的 URL 直接丢弃
      if (!abs.startsWith('data:') && NOISE_RE.test(abs)) return;

      const upgraded = abs.startsWith('data:') ? abs : upgradeUrl(abs);
      const key = dedupeKey(upgraded);
      if (records.has(key)) return;

      records.set(key, {
        url: upgraded,
        originalUrl: upgraded === abs ? '' : abs, // 记录原始 URL，升级失败时回退
        w: size ? size.w : 0,
        h: size ? size.h : 0,
        source
      });
    };

    /* ---- 1) <img> 标签：src / srcset / data-* 懒加载属性 ---- */
    document.querySelectorAll('img').forEach((img) => {
      const size = elementSize(img);
      // 已渲染的 src 最优先
      if (img.src) add(img.src, size, 'img.src');
      // srcset 选最大
      const srcsetBest = pickLargestFromSrcset(img.getAttribute('srcset') || '');
      if (srcsetBest) add(srcsetBest, size, 'img.srcset');
      // data-srcset（懒加载版）
      const dSrcset = pickLargestFromSrcset(img.getAttribute('data-srcset') || '');
      if (dSrcset) add(dSrcset, size, 'img.data-srcset');
      // 各平台懒加载属性
      for (const attr of LAZY_ATTRS) {
        const v = img.getAttribute(attr);
        if (v) add(v, size, 'img.' + attr);
      }
    });

    /* ---- 2) <picture> / <source>（详情页新模板偶有使用） ---- */
    document.querySelectorAll('source[srcset]').forEach((s) => {
      const best = pickLargestFromSrcset(s.getAttribute('srcset'));
      if (best) add(best, null, 'source.srcset');
    });

    /* ---- 3) 内联样式背景图 background-image ---- */
    document.querySelectorAll('[style*="background"]').forEach((el) => {
      const style = el.getAttribute('style') || '';
      const m = style.match(/background(?:-image)?\s*:\s*url\((['"]?)([^'")]+)\1\)/i);
      if (m) {
        const r = el.getBoundingClientRect();
        add(m[2], { w: Math.round(r.width), h: Math.round(r.height) }, 'background');
      }
    });

    return records;
  }

  /* ====================== 详情页判定 ====================== */

  /**
   * 判断当前页面是否为商品详情页：
   *  1. URL 命中已知详情页特征
   *  2. 兜底：页面出现 4 张以上较大图片（URL 规则未覆盖的新页面形态）
   */
  function looksLikeDetailPage() {
    if (DETAIL_URL_RE.test(location.href)) return true;
    let big = 0;
    for (const img of document.querySelectorAll('img')) {
      const { w, h } = elementSize(img);
      if (w >= 200 && h >= 200) {
        big++;
        if (big >= 4) return true;
      }
    }
    return false;
  }

  /* ====================== 悬浮按钮 ====================== */

  let fabBtn = null;      // 按钮引用
  let toastEl = null;     // 轻提示引用
  let extracting = false; // 防重复点击

  /** 创建按钮 + 提示（挂在 Shadow DOM 里，样式与页面完全隔离） */
  function injectFab() {
    if (document.getElementById(BTN_ID)) return true;

    const host = document.createElement('div');
    host.id = BTN_ID;
    const shadow = host.attachShadow({ mode: 'open' });

    // 通过 web_accessible_resources 引入按钮样式（content.css）
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('content.css');

    const wrap = document.createElement('div');
    wrap.className = 'ig-wrap';

    toastEl = document.createElement('div');
    toastEl.className = 'ig-toast';
    toastEl.textContent = '';

    fabBtn = document.createElement('button');
    fabBtn.className = 'ig-fab';
    fabBtn.type = 'button';
    fabBtn.setAttribute('aria-label', '获取图片');
    fabBtn.innerHTML =
      '<svg class="ig-fab-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path fill="currentColor" d="M12 3a1 1 0 0 1 1 1v8.17l2.59-2.58a1 1 0 1 1 1.41 1.41l-4.29 4.3a1 1 0 0 1-1.42 0l-4.29-4.3a1 1 0 1 1 1.41-1.41L11 12.17V4a1 1 0 0 1 1-1zM4 19a1 1 0 0 1 1-1h14a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1z"/></svg>' +
      '<span class="ig-fab-text">获取图片</span>' +
      '<span class="ig-fab-spinner" aria-hidden="true"></span>';

    wrap.append(toastEl, fabBtn);
    shadow.append(link, wrap);
    document.documentElement.appendChild(host);

    fabBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      extractImages();
    });
    return true;
  }

  /** 按钮状态：idle | loading | done */
  function setFabState(state, text) {
    if (!fabBtn) return;
    fabBtn.classList.toggle('is-loading', state === 'loading');
    const textEl = fabBtn.querySelector('.ig-fab-text');
    if (textEl) textEl.textContent = state === 'loading' ? '提取中…' : (text || '获取图片');
  }

  /** 按钮上方轻提示，2.6s 后自动消失 */
  function showToast(msg, isError) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.toggle('is-error', !!isError);
    toastEl.classList.add('is-show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.remove('is-show'), 2600);
  }

  /* ====================== 提取主流程 ====================== */

  async function extractImages() {
    if (extracting) return;
    extracting = true;
    setFabState('loading');

    try {
      /* 1) 收集候选 */
      const records = collectCandidates();

      /* 2) 对未知尺寸的候选，并发探测真实尺寸（new Image 不受 CORS 限制） */
      const tasks = [];
      for (const rec of records.values()) {
        if (!(rec.w >= MIN_SIZE && rec.h >= MIN_SIZE)) {
          tasks.push(async () => {
            const s = await probeSize(rec);
            if (s) { rec.w = Math.max(rec.w, s.w); rec.h = Math.max(rec.h, s.h); }
          });
        }
      }
      await runPool(tasks, PROBE_CONCURRENCY);

      /* 3) 过滤：小尺寸图 / 1x1 占位图 */
      let list = [];
      for (const rec of records.values()) {
        if (rec.w && rec.h && (rec.w < MIN_SIZE || rec.h < MIN_SIZE)) continue;
        list.push(rec);
      }

      /* 4) 按面积从大到小排序（商品主图通常在前），并限制上限 */
      list.sort((a, b) => (b.w * b.h) - (a.w * a.h));
      list = list.slice(0, MAX_IMAGES);

      if (list.length === 0) {
        showToast('未在当前页面找到有效商品图片', true);
        return;
      }

      /* 5) 写入存储并通知后台打开画廊页 */
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          images: list,
          pageTitle: document.title || '',
          pageUrl: location.href || '',
          extractedAt: Date.now()
        }
      });
      chrome.runtime.sendMessage({ type: 'OPEN_GALLERY' });

      showToast(`已提取 ${list.length} 张图片，正在打开画廊…`);
    } catch (err) {
      console.error('[ImageGrab] 提取失败：', err);
      showToast('提取失败：' + (err && err.message ? err.message : '未知错误'), true);
    } finally {
      extracting = false;
      setFabState('idle');
    }
  }

  /* ====================== 初始化 ====================== */

  function tryInit(attempt) {
    if (injectFab()) return;
    // 详情页内容多为异步渲染，做几次延迟重试（2s / 5s / 10s）
    if (attempt >= 3) return;
    const delays = [2000, 5000, 10000];
    setTimeout(() => {
      if (looksLikeDetailPage()) tryInit(attempt + 1);
      else tryInit(attempt + 1); // 非详情页也重试判定，URL 形态可能变化（SPA）
    }, delays[attempt]);
  }

  function boot() {
    // 仅在详情页显示按钮，其他页面（列表页 / 首页 / 搜索页）不显示
    if (looksLikeDetailPage()) injectFab();
    else tryInit(0);
  }

  /* 监听来自 Service Worker 的指令（点击工具栏图标等同点击页面按钮） */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'TRIGGER_EXTRACT') {
      injectFab();
      extractImages();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
