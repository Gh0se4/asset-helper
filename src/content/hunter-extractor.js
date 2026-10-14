/**
 * Hunter（奇安信鹰图）数据提取器
 *
 * 页面结构（2026-10 实测，Quasar 表格）:
 *   资产行: tr.q-table__row（页面可能同时存在多张重复表格，按 ip|port|domain 去重）
 *   列: .q-table_1_column_N
 *     2: IP（.q-tooltip）
 *     3: 域名（.q-tooltip）
 *     4: 端口（.q-tooltip）+ 协议（.protocol-tag）
 *     5: 标题
 *     6: 状态码（.q-tooltip）
 *     7: 企业名称
 *     8: 组件指纹（.component-name）
 *     9: 分类标签（.tags-more-box）
 *    10: 城市
 *    11: 更新时间
 */

console.log('[Asset Helper] Hunter 提取器已加载');

let lastSignature = '';
let lastEmptyWarn = 0;

function isListPage() {
  return /\/home\/list/.test(location.pathname);
}

function getCurrentPageNum() {
  const match = location.href.match(/[?&]page=(\d+)/);
  return match ? parseInt(match[1]) : 1;
}

function clean(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

// 单元格取值：克隆后移除菜单/图标（菜单是 display:none 的 popover，textContent 仍会读到）
function cellText(td) {
  if (!td) return '';
  const clone = td.cloneNode(true);
  clone.querySelectorAll('.q-popover, .row-icon, .qax-copy, i').forEach(n => n.remove());
  let text = clean(clone.textContent);
  if (text === '-' || text === '--') text = '';
  return text;
}

function firstTooltip(td) {
  if (!td) return '';
  const t = td.querySelector('.q-tooltip');
  return t ? clean(t.textContent) : '';
}

// 组合 URL：优先 协议://域名，其次 ip:端口
function buildUrl(protocol, domain, ip, port) {
  if (domain) {
    const scheme = /https?/.test(protocol) ? protocol : 'http';
    const isDefaultPort = (scheme === 'http' && port === '80') || (scheme === 'https' && port === '443');
    return `${scheme}://${domain}${port && !isDefaultPort ? ':' + port : ''}`;
  }
  return port ? `${ip}:${port}` : ip;
}

function extractAssets() {
  const rows = document.querySelectorAll('tr.q-table__row');
  const byKey = new Map();

  for (const row of rows) {
    const cell = (n) => row.querySelector('.q-table_1_column_' + n);

    const ip = firstTooltip(cell(2));
    const domain = firstTooltip(cell(3));
    const port = firstTooltip(cell(4));
    const protocol = clean(cell(4) && cell(4).querySelector('.protocol-tag') ? cell(4).querySelector('.protocol-tag').textContent : '');

    // 至少要有 IP 或域名才算有效资产（过滤空行/填充行）
    if (!ip && !domain) continue;

    const components = Array.from((cell(8) || row).querySelectorAll('.component-name'))
      .map(e => clean(e.textContent))
      .filter(Boolean)
      .join(', ');

    const asset = {
      url: buildUrl(protocol, domain, ip, port),
      ip_port: port ? `${ip}:${port}` : ip,
      ip,
      port,
      protocol,
      title: cellText(cell(5)),
      domain,
      country: '',
      region: '',
      city: cellText(cell(10)),
      asn: '',
      org: cellText(cell(7)),
      components,
      category: clean(cell(9) && cell(9).querySelector('.tags-more-box') ? cell(9).querySelector('.tags-more-box').textContent : ''),
      status_code: firstTooltip(cell(6)),
      cert_cn: '',
      cert_san: '',
      icon_hash: '',
      header_hash: '',
      banner_hash: '',
      tls_version: '',
      lastupdatetime: cellText(cell(11))
    };

    // 同一资产可能出现在多张重复表格中，按 ip|port|domain 去重
    const key = `${asset.ip}|${asset.port}|${asset.domain}`;
    if (!byKey.has(key)) byKey.set(key, asset);
  }

  return Array.from(byKey.values());
}

function sendToBackground(assets) {
  chrome.runtime.sendMessage({
    type: 'ASSET_DATA',
    source: 'hunter',
    pageNum: getCurrentPageNum(),
    url: location.href,
    assets,
    timestamp: Date.now()
  }, () => {
    if (chrome.runtime.lastError) {
      console.error('[Asset Helper] 发送失败:', chrome.runtime.lastError.message);
    } else {
      console.log('[Asset Helper] 已发送', assets.length, '条资产（Hunter）');
    }
  });
}

// 通知后台"新页面开始采集"：替换模式下先清空旧页数据
function notifyPageLoaded() {
  try {
    chrome.runtime.sendMessage(
      { type: 'PAGE_LOADED', source: 'hunter', url: location.href },
      () => { if (chrome.runtime.lastError) { /* 后台未就绪，忽略 */ } }
    );
  } catch (e) {}
}

let lastLoadedUrl = null;

function poll() {
  if (!isListPage()) return; // SPA 其他页面静默跳过
  if (document.hidden) return; // 后台标签页零消耗

  // SPA 翻页/换检索：URL 变化即视为新一页，通知后台（替换模式下清空旧数据）
  if (lastLoadedUrl !== null && location.href !== lastLoadedUrl) {
    notifyPageLoaded();
  }
  lastLoadedUrl = location.href;

  const assets = extractAssets();

  if (assets.length === 0) {
    const now = Date.now();
    if (now - lastEmptyWarn > 30000) {
      lastEmptyWarn = now;
      console.log('[Asset Helper] 暂未发现 Hunter 资产行，等待数据加载…');
    }
    return;
  }

  if (assets.length > 200) {
    console.warn('[Asset Helper] 提取结果异常（' + assets.length + ' 条），已忽略');
    return;
  }

  const signature = location.href + '::' + JSON.stringify(assets);
  if (signature === lastSignature) return;
  lastSignature = signature;

  console.log('[Asset Helper] 提取到', assets.length, '条资产（Hunter），示例:', assets[0]);
  sendToBackground(assets);
}

function start() {
  if (isListPage()) notifyPageLoaded();
  poll();

  // 接管旧实例（扩展热重载后重新注入时，避免重复轮询）
  if (window.__assetHelperHunterTimer) clearInterval(window.__assetHelperHunterTimer);
  if (window.__assetHelperHunterObserver) window.__assetHelperHunterObserver.disconnect();

  // DOM 变化触发：翻页 / 新检索渲染完成后接近实时提取
  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(poll, 600);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.__assetHelperHunterObserver = observer;

  // 兜底轮询
  window.__assetHelperHunterTimer = setInterval(poll, 10000);

  // 标签页恢复可见时立即补检（配合 hidden 跳过，后台标签页零消耗）
  window.__assetHelperVisHook = () => { if (!document.hidden) poll(); };
  if (!window.__assetHelperVisListenerAdded) {
    window.__assetHelperVisListenerAdded = true;
    document.addEventListener('visibilitychange', () => {
      if (window.__assetHelperVisHook) window.__assetHelperVisHook();
    });
  }

  console.log('[Asset Helper] Hunter 提取器已启动（DOM 变化触发 + 10 秒兜底检查）');
}

if (document.readyState === 'complete') {
  setTimeout(start, 1500);
} else {
  window.addEventListener('load', () => setTimeout(start, 1500));
}
