/**
 * FOFA 悬浮面板注入器
 *
 * 特性：
 * - 开关状态 / 位置 / 尺寸持久化（chrome.storage.local）
 * - 页面刷新（新检索、翻页导致整页刷新）后自动恢复面板
 * - 拖动标题栏移动、右下角调整大小，几何信息自动保存
 */

console.log('[Asset Helper] 注入脚本已加载');

const OVERLAY_ID = 'fofa-helper-overlay';
const OVERLAY_STATE_KEY = 'fofaOverlayState';
let saveTimer = null;

/**
 * 保存面板状态（开关 + 位置 + 尺寸）
 * @param {boolean} open - 面板是否打开
 */
function persistOverlayState(open) {
  const el = document.getElementById(OVERLAY_ID);
  const state = { open: !!open };
  if (el) {
    state.left = el.offsetLeft;
    state.top = el.offsetTop;
    state.width = el.offsetWidth;
    state.height = el.offsetHeight;
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ [OVERLAY_STATE_KEY]: state });
  }, 150);
}

/**
 * 面板页面 URL（带时间戳，避免浏览器缓存旧版页面导致引用失效资源）
 */
function panelUrl() {
  return chrome.runtime.getURL('src/popup/index.html') + '?t=' + Date.now();
}

/**
 * 创建悬浮面板
 * @param {Object|null} geometry - 上次保存的位置尺寸
 */
function createFloatingPanel(geometry) {
  if (document.getElementById(OVERLAY_ID)) return;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.innerHTML = `
    <div class="fofa-overlay-header">
      <span class="fofa-overlay-title">Asset Helper</span>
      <div class="fofa-overlay-controls">
        <button class="fofa-overlay-btn" id="fofa-minimize">−</button>
        <button class="fofa-overlay-btn" id="fofa-close">×</button>
      </div>
    </div>
    <div class="fofa-overlay-content">
      <iframe src="${panelUrl()}"
              id="fofa-overlay-iframe"
              frameborder="0"></iframe>
    </div>
  `;

  // 恢复上次的位置与尺寸
  if (geometry) {
    if (geometry.width) overlay.style.width = geometry.width + 'px';
    if (geometry.height) overlay.style.height = geometry.height + 'px';
    if (typeof geometry.left === 'number') {
      overlay.style.left = geometry.left + 'px';
      overlay.style.right = 'auto';
    }
    if (typeof geometry.top === 'number') {
      overlay.style.top = geometry.top + 'px';
    }
  }

  const style = document.createElement('style');
  style.id = 'asset-helper-overlay-style';
  style.textContent = `
    #fofa-helper-overlay {
      position: fixed;
      right: 20px;
      top: 80px;
      width: 1000px;
      max-width: calc(100vw - 40px);
      height: 700px;
      max-height: calc(100vh - 120px);
      background: white;
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
      z-index: 999999;
      display: flex;
      flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      resize: both;
      overflow: hidden;
    }

    #fofa-helper-overlay.minimized {
      height: 42px !important;
      resize: none;
    }

    .fofa-overlay-header {
      background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
      color: white;
      padding: 8px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: move;
      user-select: none;
      flex-shrink: 0;
      border-radius: 8px 8px 0 0;
    }

    .fofa-overlay-title {
      font-weight: 600;
      font-size: 13px;
      letter-spacing: 0.3px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* 采集状态指示点（呼吸动效） */
    .fofa-overlay-title::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.6);
      animation: ah-pulse 2.2s ease-out infinite;
    }

    @keyframes ah-pulse {
      0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.55); }
      70% { box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
      100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }

    .fofa-overlay-controls {
      display: flex;
      gap: 6px;
    }

    .fofa-overlay-btn {
      width: 22px;
      height: 22px;
      border: none;
      background: rgba(255, 255, 255, 0.12);
      color: rgba(255, 255, 255, 0.85);
      border-radius: 5px;
      cursor: pointer;
      font-size: 15px;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
      padding: 0;
    }

    .fofa-overlay-btn:hover {
      background: rgba(255, 255, 255, 0.25);
      color: #fff;
    }

    #fofa-close:hover {
      background: #ef4444;
      color: #fff;
    }

    .fofa-overlay-content {
      flex: 1;
      overflow: hidden;
      display: flex;
    }

    #fofa-helper-overlay.minimized .fofa-overlay-content {
      display: none;
    }

    #fofa-overlay-iframe {
      width: 100%;
      height: 100%;
      border: none;
    }
  `;

  document.head.appendChild(style);
  document.body.appendChild(overlay);

  makeDraggable(overlay);

  document.getElementById('fofa-minimize').addEventListener('click', () => {
    overlay.classList.toggle('minimized');
  });

  document.getElementById('fofa-close').addEventListener('click', () => {
    persistOverlayState(false); // 先记录几何信息，再移除
    overlay.remove();
  });

  // 尺寸变化（含右下角拖拽调整）时保存
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      if (!overlay.classList.contains('minimized')) {
        persistOverlayState(true);
      }
    });
    ro.observe(overlay);
  }

  persistOverlayState(true);
  console.log('[Asset Helper] 悬浮面板已创建');
}

/**
 * 拖动功能
 */
function makeDraggable(element) {
  const header = element.querySelector('.fofa-overlay-header');
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

  header.onmousedown = dragMouseDown;

  function dragMouseDown(e) {
    e.preventDefault();
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    document.onmousemove = elementDrag;
  }

  function elementDrag(e) {
    e.preventDefault();
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    element.style.top = (element.offsetTop - pos2) + 'px';
    element.style.left = (element.offsetLeft - pos1) + 'px';
    element.style.right = 'auto';
  }

  function closeDragElement() {
    document.onmouseup = null;
    document.onmousemove = null;
    persistOverlayState(true); // 拖动结束保存位置
  }
}

// ============================================
// 接管旧实例（扩展热重载后重新注入时）
// ============================================

// 清理旧面板与样式残留（旧实例的 iframe 上下文已失效）
const orphanOverlay = document.getElementById(OVERLAY_ID);
if (orphanOverlay) orphanOverlay.remove();
const orphanStyle = document.getElementById('asset-helper-overlay-style');
if (orphanStyle) orphanStyle.remove();

// ============================================
// 消息处理：切换面板（保证同一页面只有一个处理器生效）
// ============================================

if (window.__assetHelperOverlayHandler) {
  try { chrome.runtime.onMessage.removeListener(window.__assetHelperOverlayHandler); } catch (e) {}
}

const overlayMessageHandler = (message, sender, sendResponse) => {
  if (message.type === 'TOGGLE_OVERLAY') {
    const existing = document.getElementById(OVERLAY_ID);
    if (existing) {
      persistOverlayState(false);
      existing.remove();
    } else {
      chrome.storage.local.get(OVERLAY_STATE_KEY, (res) => {
        const state = res && res[OVERLAY_STATE_KEY];
        createFloatingPanel(state || null);
      });
    }
    sendResponse({ ok: true });
  }
  return true;
};

window.__assetHelperOverlayHandler = overlayMessageHandler;
chrome.runtime.onMessage.addListener(overlayMessageHandler);

// ============================================
// 页面加载时：如果上次面板是打开的，自动恢复（刷新/新检索/翻页后保持）
// ============================================

chrome.storage.local.get(OVERLAY_STATE_KEY, (res) => {
  const state = res && res[OVERLAY_STATE_KEY];
  if (state && state.open) {
    console.log('[Asset Helper] 检测到上次面板处于打开状态，自动恢复');
    createFloatingPanel(state);
  }
});
