/**
 * Asset Helper - Background Service Worker
 *
 * 职责：
 * 1. 会话管理与数据聚合（替换 / 累积两种模式）
 * 2. 整行去重的数据合并
 * 3. 消息路由（内容脚本 ↔ 悬浮面板）
 * 4. 会话数据持久化、扩展角标与平台白名单判定
 */

// ============================================
// 数据存储结构
// ============================================

class DataStore {
  constructor() {
    this.mode = 'replace';  // 'replace' | 'accumulate'
    this.currentSession = null;
    this.sessionHistory = [];
  }

  /**
   * 创建新会话
   */
  createSession(url) {
    return {
      id: Date.now(),
      url: url,
      query: this.extractQuery(url),
      startTime: Date.now(),
      pages: [],
      allRows: [],
      stats: {
        totalPages: 0,
        totalRows: 0,
        uniqueIPs: new Set(),
        lastUpdate: Date.now()
      }
    };
  }

  extractQuery(url) {
    try {
      const match = url.match(/qbase64=([^&]+)/);
      if (match) {
        return atob(match[1]);
      }
    } catch (e) {
      console.warn('[Asset Helper] 提取查询失败:', e);
    }
    return '';
  }

  /**
   * 添加页面数据
   */
  addPageData(pageNum, assets, url) {
    if (!this.currentSession) {
      this.currentSession = this.createSession(url);
    }

    const page = {
      pageNum: pageNum,
      url: url,
      rowCount: assets.length,
      timestamp: Date.now()
    };

    if (this.mode === 'accumulate') {
      // 累积模式：去重后追加
      const newRows = this.deduplicateAssets(assets);
      this.currentSession.allRows.push(...newRows);

      // 同一页面（URL 相同）的分阶段重复上报不重复计页
      const lastPage = this.currentSession.pages[this.currentSession.pages.length - 1];
      if (lastPage && lastPage.url === url) {
        lastPage.rowCount = Math.max(lastPage.rowCount, assets.length);
        lastPage.timestamp = Date.now();
      } else {
        this.currentSession.pages.push(page);
      }

      console.log(`[Asset Helper] 累积模式：新增 ${newRows.length}/${assets.length} 条（已去重）`);
    } else {
      // 替换模式：直接替换
      this.currentSession.allRows = assets;
      this.currentSession.pages = [page];

      console.log(`[Asset Helper] 替换模式：设置 ${assets.length} 条数据`);
    }

    this.updateStats();
  }

  /**
   * 去重逻辑：整行内容比对
   * （用 ip|port 做键会把"IP/端口为空"的不同行误判为重复而丢弃，必须用整行内容）
   */
  deduplicateAssets(newAssets) {
    const existingKeys = new Set(
      this.currentSession.allRows.map(row => JSON.stringify(row))
    );

    return newAssets.filter(asset => {
      const key = JSON.stringify(asset);
      if (existingKeys.has(key)) {
        return false;
      }
      existingKeys.add(key);
      return true;
    });
  }

  /**
   * 更新统计信息
   */
  updateStats() {
    if (!this.currentSession) return;

    const session = this.currentSession;
    session.stats.totalPages = session.pages.length;
    session.stats.totalRows = session.allRows.length;
    session.stats.uniqueIPs = new Set(
      session.allRows.map(row => row.ip).filter(Boolean)
    );
    session.stats.lastUpdate = Date.now();
  }

  /**
   * 切换模式
   */
  setMode(mode) {
    const oldMode = this.mode;
    this.mode = mode;

    console.log(`[Asset Helper] 模式切换: ${oldMode} → ${mode}`);
    // 说明：模式切换本身不销毁数据，替换语义从"下一次页面加载"开始生效
  }

  /**
   * 归档会话
   */
  archiveSession() {
    if (this.currentSession && this.currentSession.allRows.length > 0) {
      this.sessionHistory.push(this.currentSession);
      console.log(`[Asset Helper] 会话已归档，ID: ${this.currentSession.id}`);
    }
    this.currentSession = null;
  }

  /**
   * 清空当前数据
   */
  clear() {
    this.archiveSession();
    console.log('[Asset Helper] 数据已清空');
  }

  /**
   * 获取所有数据
   */
  getAllRows() {
    return this.currentSession?.allRows || [];
  }

  /**
   * 获取统计信息
   */
  getStats() {
    if (!this.currentSession) {
      return {
        totalPages: 0,
        totalRows: 0,
        uniqueIPs: 0,
        mode: this.mode
      };
    }

    return {
      totalPages: this.currentSession.stats.totalPages,
      totalRows: this.currentSession.stats.totalRows,
      uniqueIPs: this.currentSession.stats.uniqueIPs.size,
      mode: this.mode,
      lastUpdate: this.currentSession.stats.lastUpdate
    };
  }
}

// ============================================
// 消息处理器
// ============================================

class MessageHandler {
  constructor(dataStore) {
    this.dataStore = dataStore;
    this.handlers = {
      'ASSET_DATA': this.handleAssetData.bind(this),
      'PAGE_LOADED': this.handlePageLoaded.bind(this),
      'GET_DATA': this.handleGetData.bind(this),
      'GET_STATS': this.handleGetStats.bind(this),
      'SET_MODE': this.handleSetMode.bind(this),
      'CLEAR_DATA': this.handleClearData.bind(this),
      'PING': this.handlePing.bind(this)
    };
  }

  async handle(message, sender, sendResponse) {
    const handler = this.handlers[message.type];

    if (handler) {
      try {
        const result = await handler(message, sender);
        sendResponse({ ok: true, data: result });
      } catch (error) {
        console.error(`[Asset Helper] 处理消息失败 (${message.type}):`, error);
        sendResponse({ ok: false, error: error.message });
      }
    } else {
      console.warn(`[Asset Helper] 未知消息类型: ${message.type}`);
      sendResponse({ ok: false, error: 'Unknown message type' });
    }
  }

  /**
   * 处理 FOFA 数据
   */
  handleAssetData(message) {
    const { pageNum, url, assets, source } = message;

    console.log(`[Asset Helper] 收到资产数据 (来源: ${source}):`, {
      pageNum,
      assetCount: assets.length,
      url
    });

    if (!assets || assets.length === 0) {
      console.warn('[Asset Helper] 数据为空，跳过处理');
      return { processed: false };
    }

    // 双保险：仅接受支持平台清单内的数据
    if (!getPlatform(url)) {
      console.warn('[Asset Helper] 非支持平台的数据，已忽略:', url);
      return { processed: false };
    }

    // 添加数据
    this.dataStore.addPageData(pageNum, assets, url);
    persistStore();
    updateBadge();

    // 通知 Side Panel 更新
    this.notifySidePanel({
      type: 'UPDATE_TABLE',
      payload: {
        mode: this.dataStore.mode,
        stats: this.dataStore.getStats(),
        newRowCount: assets.length,
        allRows: this.dataStore.getAllRows()
      }
    });

    return {
      processed: true,
      rowCount: assets.length,
      totalRows: this.dataStore.getStats().totalRows
    };
  }

  /**
   * 新页面开始采集：替换模式下清空旧页数据（累积模式保留）
   */
  handlePageLoaded(message) {
    if (!getPlatform(message.url)) {
      return { cleared: false, reason: 'unsupported' };
    }
    if (this.dataStore.mode !== 'replace') {
      return { cleared: false, mode: this.dataStore.mode };
    }

    this.dataStore.clear();
    persistStore();
    updateBadge();

    console.log('[Asset Helper] 新页面开始采集（替换模式），已清空旧数据:', message.url);

    this.notifySidePanel({
      type: 'UPDATE_TABLE',
      payload: {
        mode: this.dataStore.mode,
        stats: this.dataStore.getStats(),
        newRowCount: 0,
        allRows: []
      }
    });

    return { cleared: true };
  }

  /**
   * 获取数据
   */
  handleGetData() {
    return {
      rows: this.dataStore.getAllRows(),
      stats: this.dataStore.getStats()
    };
  }

  /**
   * 获取统计
   */
  handleGetStats() {
    return this.dataStore.getStats();
  }

  /**
   * 设置模式
   */
  handleSetMode(message) {
    const { mode } = message;

    if (!['replace', 'accumulate'].includes(mode)) {
      throw new Error(`Invalid mode: ${mode}`);
    }

    this.dataStore.setMode(mode);
    persistStore();

    // 通知 Side Panel
    this.notifySidePanel({
      type: 'MODE_CHANGED',
      payload: { mode }
    });

    return { mode };
  }

  /**
   * 清空数据
   */
  handleClearData() {
    this.dataStore.clear();
    persistStore();
    updateBadge();

    // 通知 Side Panel
    this.notifySidePanel({
      type: 'DATA_CLEARED',
      payload: {}
    });

    return { cleared: true };
  }

  /**
   * Ping（健康检查）
   */
  handlePing() {
    return { pong: true, timestamp: Date.now() };
  }

  /**
   * 通知 Side Panel
   */
  notifySidePanel(message) {
    chrome.runtime.sendMessage(message).catch(err => {
      // Side Panel 可能未打开，忽略错误
      console.debug('[Asset Helper] Side Panel 未响应:', err.message);
    });
  }
}

// ============================================
// 初始化
// ============================================

const dataStore = new DataStore();
const messageHandler = new MessageHandler(dataStore);

// ============================================
// 数据持久化（跨 Service Worker 休眠 / 页面刷新，浏览器重启后清空）
// ============================================

const STORE_KEY = 'fofaDataStore';

async function persistStore() {
  try {
    const session = dataStore.currentSession;
    await chrome.storage.session.set({
      [STORE_KEY]: {
        mode: dataStore.mode,
        // stats 内含 Set，无法序列化，恢复时重建
        currentSession: session ? {
          id: session.id,
          url: session.url,
          query: session.query,
          startTime: session.startTime,
          pages: session.pages,
          allRows: session.allRows
        } : null
      }
    });
  } catch (e) {
    console.error('[Asset Helper] 持久化失败:', e);
  }
}

async function restoreStore() {
  try {
    const res = await chrome.storage.session.get(STORE_KEY);
    const saved = res && res[STORE_KEY];
    if (!saved) return;
    if (saved.mode) dataStore.mode = saved.mode;
    if (saved.currentSession) {
      const session = saved.currentSession;
      session.stats = { totalPages: 0, totalRows: 0, uniqueIPs: new Set(), lastUpdate: Date.now() };
      dataStore.currentSession = session;
      dataStore.updateStats();
      updateBadge();
      console.log('[Asset Helper] 已恢复会话数据:', session.allRows.length, '行，模式:', dataStore.mode);
    }
  } catch (e) {
    console.error('[Asset Helper] 恢复失败:', e);
  }
}

const readyPromise = restoreStore();

/**
 * 扩展图标角标：显示已采集行数（一眼可见采集状态）
 *
 * 角标跟随当前活动标签页：只有停留在支持的测绘平台页面时才显示数字，
 * 切到其他站点立即清空，避免"当前页面已经没有数据、角标却还挂着数字"。
 * 数据本身不随页面切换销毁，切回平台页面会重新显示。
 */
async function updateBadge() {
  try {
    chrome.action.setBadgeBackgroundColor({ color: '#0366d6' });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const onPlatform = !!(tab && getPlatform(tab.url));
    const rows = dataStore.getStats().totalRows;

    chrome.action.setBadgeText({ text: onPlatform && rows ? String(rows) : '' });
  } catch (e) {
    console.warn('[Asset Helper] 更新角标失败:', e);
  }
}

// 扩展安装/更新/重载后：向已打开的 FOFA 结果页重新注入内容脚本
// （扩展重载会让旧页面的脚本上下文失效，表现为"数据不再更新、面板打不开"，这里自动恢复）
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Asset Helper] Asset Helper 已安装/更新');
  try {
    const manifest = chrome.runtime.getManifest();
    const injected = new Set();
    for (const entry of (manifest.content_scripts || [])) {
      const files = entry.js || [];
      if (!files.length) continue;
      for (const pattern of (entry.matches || [])) {
        let tabs = [];
        try {
          tabs = await chrome.tabs.query({ url: pattern });
        } catch (e) { continue; }
        for (const t of tabs) {
          if (injected.has(t.id)) continue;
          injected.add(t.id);
          try {
            await chrome.scripting.executeScript({ target: { tabId: t.id }, files });
            console.log('[Asset Helper] 已向标签页重新注入内容脚本:', t.id, pattern);
          } catch (e) {
            // 页面正在导航等场景可忽略
          }
        }
      }
    }
  } catch (e) {
    console.error('[Asset Helper] 内容脚本重注入失败:', e);
  }
});

// ============================================
// 支持的测绘平台清单（唯一运行时判定源）
// 新增平台：在此添加域名规则，并在 manifest.json 的 content_scripts / host_permissions 中同步
// ============================================

const SUPPORTED_PLATFORMS = [
  { name: 'FOFA',   pattern: /^https?:\/\/([a-z0-9-]+\.)*fofa\.info\// },
  { name: 'Hunter', pattern: /^https?:\/\/hunter\.qianxin\.com\// }
];

function getPlatform(url) {
  if (!url) return null;
  return SUPPORTED_PLATFORMS.find(p => p.pattern.test(url)) || null;
}

// ============================================
// 角标跟随活动标签页：切换 / 导航 / 关闭标签页时重新评估
// ============================================

chrome.tabs.onActivated.addListener(() => updateBadge());

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.active) return;
  if (changeInfo.url || changeInfo.status === 'complete') updateBadge();
});

chrome.tabs.onRemoved.addListener(() => updateBadge());

// ============================================
// 图标点击：仅当当前标签页处于支持平台清单内才响应（清单外零动作）
// ============================================

chrome.action.onClicked.addListener(async (tab) => {
  const url = (tab && tab.url) || '';
  const platform = getPlatform(url);

  if (!platform) {
    console.log('[Asset Helper] 当前页面不在支持的测绘平台清单内，忽略点击');
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_OVERLAY' });
  } catch (e) {
    console.log(`[Asset Helper] ${platform.name} 页面脚本未就绪（非结果页或需刷新页面）`);
  }
});

// 监听消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Asset Helper] 收到消息:', message.type, sender.tab ? `from tab ${sender.tab.id}` : 'from extension');

  // 异步处理消息
  readyPromise.then(() => messageHandler.handle(message, sender, sendResponse));

  // 保持消息通道开放
  return true;
});

console.log('[Asset Helper] Service Worker 已启动');
console.log('[Asset Helper] 数据存储已初始化，模式:', dataStore.mode);
