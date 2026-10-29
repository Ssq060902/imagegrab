/**
 * 图提取 ImageGrab —— gallery.js（画廊页逻辑）
 *
 * 职责：
 *  1. 读取 content script 写入 chrome.storage.local 的图片列表，网格化展示
 *  2. 全选 / 反选 / 已选数量统计
 *  3. 批量下载：勾选图片 → canvas 统一转 PNG → chrome.downloads 保存
 *  4. 下载进度与结果反馈
 *
 * 说明：PNG 转换放在画廊页执行，因为 Service Worker（MV3）中没有
 * canvas / DOM；而本页面属于扩展页面，已通过 manifest 的 host_permissions
 * 获得对图片 CDN 域名的跨域 fetch 权限，可直接读取像素并转码。
 */
(() => {
  'use strict';

  /* ====================== 常量 ====================== */
  const STORAGE_KEY = 'imagegrab_last_extract';
  const CONVERT_CONCURRENCY = 3;   // 同时转换 / 下载的任务数
  const DOWNLOAD_WAIT_TIMEOUT = 120000; // 单个下载最长等待(ms)

  /* ====================== 状态 ====================== */
  let images = [];          // [{ url, originalUrl, w, h, source }]
  let selected = new Set(); // 已勾选的下标
  let downloading = false;  // 是否正在批量下载

  /* ====================== DOM ====================== */
  const $grid = document.getElementById('grid');
  const $empty = document.getElementById('emptyState');
  const $selCount = document.getElementById('selCount');
  const $btnSelectAll = document.getElementById('btnSelectAll');
  const $btnInvert = document.getElementById('btnInvert');
  const $btnDownload = document.getElementById('btnDownload');
  const $pageSource = document.getElementById('pageSource');
  const $progressWrap = document.getElementById('progressWrap');
  const $progressText = document.getElementById('progressText');
  const $progressPct = document.getElementById('progressPct');
  const $progressBar = document.getElementById('progressBar');
  const $toast = document.getElementById('toast');

  /* ====================== 初始化 ====================== */

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      const payload = data && data[STORAGE_KEY];
      if (payload && Array.isArray(payload.images) && payload.images.length > 0) {
        images = payload.images;
        if (payload.pageTitle) {
          $pageSource.textContent = payload.pageTitle;
          $pageSource.title = payload.pageUrl || '';
        }
        renderGrid();
        updateSelCount();
      } else {
        showEmpty();
      }
    } catch (err) {
      console.error('[ImageGrab] 读取提取结果失败：', err);
      showEmpty();
    }
  }

  function showEmpty() {
    $grid.hidden = true;
    $empty.hidden = false;
  }

  /* ====================== 渲染 ====================== */

  function renderGrid() {
    const frag = document.createDocumentFragment();

    images.forEach((item, i) => {
      const card = document.createElement('div');
      card.className = 'ig-card';
      card.dataset.index = String(i);

      /* 勾选框（覆盖在左上角） */
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'ig-check';
      checkbox.checked = false;
      checkbox.setAttribute('aria-label', '选择第 ' + (i + 1) + ' 张图片');
      checkbox.addEventListener('click', (e) => e.stopPropagation());
      checkbox.addEventListener('change', () => {
        toggleSelect(i, checkbox.checked);
      });

      /* 缩略图（懒加载；升级 URL 失败时回退原始 URL） */
      const imgWrap = document.createElement('div');
      imgWrap.className = 'ig-thumb';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '图片 ' + (i + 1);
      img.src = item.url;
      img.addEventListener('error', () => {
        if (item.originalUrl && img.src !== item.originalUrl) {
          img.src = item.originalUrl;
        } else {
          imgWrap.classList.add('is-broken');
        }
      });
      // 点击缩略图 → 新标签页查看原图
      imgWrap.addEventListener('click', () => {
        chrome.tabs.create({ url: img.src });
      });
      imgWrap.appendChild(img);

      /* 尺寸信息 + 状态标签 */
      const meta = document.createElement('div');
      meta.className = 'ig-meta';
      const sizeText = document.createElement('span');
      sizeText.textContent = item.w && item.h ? `${item.w} × ${item.h}` : '尺寸未知';
      const status = document.createElement('span');
      status.className = 'ig-status';
      status.dataset.index = String(i);
      meta.append(sizeText, status);

      card.append(checkbox, imgWrap, meta);
      frag.appendChild(card);
    });

    $grid.appendChild(frag);
  }

  /** 设置单张图片的处理状态标签 */
  function setStatus(index, text, type) {
    const el = $grid.querySelector(`.ig-status[data-index="${index}"]`);
    if (!el) return;
    el.textContent = text || '';
    el.className = 'ig-status' + (type ? ' is-' + type : '');
  }

  /* ====================== 选择 ====================== */

  function toggleSelect(index, on) {
    if (on) selected.add(index);
    else selected.delete(index);
    const card = $grid.querySelector(`.ig-card[data-index="${index}"]`);
    if (card) card.classList.toggle('is-selected', on);
    updateSelCount();
  }

  function updateSelCount() {
    $selCount.textContent = `已选 ${selected.size} 张`;
    $btnDownload.disabled = selected.size === 0 || downloading;
  }

  $btnSelectAll.addEventListener('click', () => {
    // 已全选 → 点击取消全选；否则 → 全选
    const allSelected = images.length > 0 && selected.size === images.length;
    selected.clear();
    if (!allSelected) images.forEach((_, i) => selected.add(i));
    $grid.querySelectorAll('.ig-card').forEach((card) => {
      const i = Number(card.dataset.index);
      const on = selected.has(i);
      card.classList.toggle('is-selected', on);
      card.querySelector('.ig-check').checked = on;
    });
    updateSelCount();
  });

  $btnInvert.addEventListener('click', () => {
    images.forEach((_, i) => {
      const on = !selected.has(i);
      toggleSelect(i, on);
      const card = $grid.querySelector(`.ig-card[data-index="${i}"]`);
      if (card) card.querySelector('.ig-check').checked = on;
    });
  });

  /* ====================== PNG 转换与批量下载 ====================== */

  $btnDownload.addEventListener('click', downloadSelected);

  /**
   * 拉取图片并用 canvas 转成 PNG Blob。
   * 依次尝试：升级版 URL → 原始 URL；全部失败则抛错（由调用方兜底直链下载）。
   */
  async function convertToPng(url) {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      return await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png');
      });
    } finally {
      bmp.close && bmp.close();
    }
  }

  /** 等待某个下载任务完成（onChanged 监听 + 超时兜底） */
  function waitDownload(id) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        chrome.downloads.onChanged.removeListener(listener);
        clearTimeout(timer);
        resolve(ok);
      };
      const listener = (delta) => {
        if (delta.id !== id) return;
        const st = delta.state && delta.state.current;
        if (st === 'complete') finish(true);
        else if (st === 'interrupted') finish(false);
      };
      const timer = setTimeout(() => finish(true), DOWNLOAD_WAIT_TIMEOUT); // 超时不阻塞后续
      chrome.downloads.onChanged.addListener(listener);
      chrome.downloads.search({ id }, (items) => {
        const st = items && items[0] && items[0].state;
        if (st === 'complete') finish(true);
        else if (st === 'interrupted') finish(false);
      });
    });
  }

  /** 文件名只保留安全字符 */
  function safeFilename(name) {
    return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  }

  /** 更新进度条 */
  function updateProgress(done, total, okCount, failCount) {
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);
    $progressPct.textContent = pct + '%';
    $progressBar.style.width = pct + '%';
    $progressText.textContent = `正在处理 ${done}/${total}（成功 ${okCount} · 失败 ${failCount}）`;
  }

  /** 结束后 Toast 反馈 */
  function showToast(msg, isError) {
    $toast.textContent = msg;
    $toast.classList.toggle('is-error', !!isError);
    $toast.classList.add('is-show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => $toast.classList.remove('is-show'), 4000);
  }

  async function downloadSelected() {
    if (downloading || selected.size === 0) return;
    downloading = true;
    $btnDownload.disabled = true;
    $progressWrap.hidden = false;
    $progressBar.style.width = '0%';

    const indices = Array.from(selected).sort((a, b) => a - b);
    const total = indices.length;
    let done = 0, okCount = 0, failCount = 0, fallbackCount = 0;

    updateProgress(0, total, 0, 0);

    /* 任务队列：每个下标一个处理函数，CONVERT_CONCURRENCY 并发执行 */
    const tasks = indices.map((imgIndex, order) => async () => {
      const item = images[imgIndex];
      const seq = String(order + 1).padStart(3, '0'); // 序号补零：001 / 002 ...
      const filename = safeFilename(`商品图_${seq}.png`);
      setStatus(imgIndex, '转换中', 'run');

      try {
        /* 首选：转 PNG 后保存（升级 URL 失败自动回退原始 URL） */
        let pngBlob = null;
        try {
          pngBlob = await convertToPng(item.url);
        } catch {
          if (item.originalUrl) pngBlob = await convertToPng(item.originalUrl);
        }

        const objUrl = URL.createObjectURL(pngBlob);
        try {
          const id = await chrome.downloads.download({
            url: objUrl,
            filename,
            conflictAction: 'uniquify',
            saveAs: false
          });
          const ok = await waitDownload(id);
          if (!ok) throw new Error('下载被中断');
        } finally {
          URL.revokeObjectURL(objUrl);
        }

        okCount++;
        setStatus(imgIndex, '已保存', 'ok');
      } catch (err) {
        /* 兜底：canvas 转换失败（如跨域 / 编码异常）→ 直接下载原图，
           此时保留原格式，文件名仍按序号编号 */
        console.warn('[ImageGrab] PNG 转换失败，尝试直链下载原图：', err);
        try {
          const ext = (item.originalUrl || item.url).split('?')[0].match(/\.(\w{3,4})$/i);
          const fallbackName = safeFilename(`商品图_${seq}.${ext ? ext[1] : 'jpg'}`);
          await chrome.downloads.download({
            url: item.originalUrl || item.url,
            filename: fallbackName,
            conflictAction: 'uniquify',
            saveAs: false
          });
          okCount++;
          fallbackCount++;
          setStatus(imgIndex, '原图保存', 'warn');
        } catch (e2) {
          failCount++;
          setStatus(imgIndex, '失败', 'fail');
          console.error('[ImageGrab] 下载失败：', e2);
        }
      } finally {
        done++;
        updateProgress(done, total, okCount, failCount);
      }
    });

    /* 简易并发池 */
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONVERT_CONCURRENCY, tasks.length) }, async () => {
        while (cursor < tasks.length) {
          const t = tasks[cursor++];
          await t();
        }
      })
    );

    downloading = false;
    updateSelCount();

    /* 结果反馈 */
    if (failCount === 0 && fallbackCount === 0) {
      showToast(`全部完成：成功下载 ${okCount} 张 PNG`);
    } else if (failCount === 0) {
      showToast(`完成：${okCount} 张成功（其中 ${fallbackCount} 张保留原图格式）`);
    } else {
      showToast(`完成：成功 ${okCount} 张，失败 ${failCount} 张`, failCount > 0);
    }

    setTimeout(() => { $progressWrap.hidden = true; }, 2500);
  }
})();
