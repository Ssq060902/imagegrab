/**
 * 图提取 ImageGrab —— Background Service Worker
 *
 * 职责：
 *  1. 接收 Content Script 的消息，转发 / 打开画廊页（gallery.html）
 *  2. 兜底下载：直接用 chrome.downloads 下载原始图片 URL（不做 PNG 转换）
 *     —— PNG 转换需要 canvas / DOM，Service Worker 中不可用，
 *        因此转换统一放在画廊页（gallery.js）中执行，见 gallery.js 注释
 *  3. 监听工具栏图标点击，向当前标签页注入提取指令（等同于页面右下角按钮）
 */

/* 与 content.js / gallery.js 约定的存储键 */
const STORAGE_KEY = 'imagegrab_last_extract';

/**
 * 支持的电商域名（详情页才显示按钮，域名级别先做第一道过滤）
 * @param {string} url
 * @returns {boolean}
 */
function isSupportedUrl(url) {
  if (!url) return false;
  return /^https?:\/\/[^/]*(taobao\.com|tmall\.com|jd\.com|pinduoduo\.com|yangkeduo\.com)\//i.test(url);
}

/* ======================= 消息路由 ======================= */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  /* Content Script：提取完成，请求打开画廊页 */
  if (msg.type === 'OPEN_GALLERY') {
    chrome.tabs.create({ url: chrome.runtime.getURL('gallery.html') }, (tab) => {
      // 打开失败时（极少见）回落到窗口方式
      if (chrome.runtime.lastError) {
        console.warn('[ImageGrab] 打开画廊页失败：', chrome.runtime.lastError.message);
      }
      void tab;
    });
    sendResponse({ ok: true });
    return;
  }

  /* 画廊页兜底下载：不经过 canvas 转换，直接下载原图
     items: [{ url, filename }] */
  if (msg.type === 'DOWNLOAD_URLS' && Array.isArray(msg.items)) {
    const results = msg.items.map((it) =>
      chrome.downloads.download({
        url: it.url,
        filename: it.filename,
        conflictAction: 'uniquify',
        saveAs: false
      })
    );
    // download() 返回 Promise（MV3），全部触发后再答复
    Promise.allSettled(results).then(() => sendResponse({ ok: true }));
    return true; // 异步 sendResponse
  }

  /* Content Script 探活（用于工具栏图标点击前确认脚本已注入） */
  if (msg.type === 'PING') {
    sendResponse({ ok: true });
  }
});

/* ======================= 工具栏图标点击 ======================= */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !isSupportedUrl(tab.url)) return;
  try {
    // 若 Content Script 尚未注入（例如扩展刚被加载），先动态注入
    await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_EXTRACT' });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      // 注入后稍等初始化，再触发提取
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_EXTRACT' }).catch(() => {});
      }, 300);
    } catch (e) {
      console.warn('[ImageGrab] 注入失败：', e);
    }
  }
});

/**
 * 清理：标签页关闭后，若画廊页全部关闭，可清空提取缓存，避免占用存储
 */
chrome.tabs.onRemoved.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('gallery.html') + '*' });
    if (tabs.length === 0) {
      // 保留最近一次结果，便于用户重新打开画廊；此处不做清理
      // 如需彻底清理可调用：chrome.storage.local.remove(STORAGE_KEY)
      void STORAGE_KEY;
    }
  } catch {
    /* 忽略 */
  }
});
