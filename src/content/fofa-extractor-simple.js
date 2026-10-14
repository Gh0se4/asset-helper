/**
 * FOFA 数据提取器 v2 —— 基于真实 DOM 结构
 *
 * 通过 moli 抓取真实页面验证的结构（2026-10）:
 *   资产卡片:  .hsxa-meta-data-item（每页 10 条）
 *   - URL:    span.hsxa-copy-btn[data-clipboard-text]
 *   - 其他字段: a[href*="qbase64="] 链接里的 base64 参数
 *             (ip="x" / port="x" / country="x" / asn="x" / org="x" / domain="x")
 *   - 标题:   .hsxa-meta-data-list-main-left 里第一个纯文本 p.hsxa-one-line
 *   - 时间:   左栏中形如 2026-10-13 的 span
 */

console.log('[Asset Helper] 提取器 v2 加载');

let lastSignature = '';
let lastEmptyWarn = 0;

// 指纹类参数的键名映射（FOFA 原键名含点号）
const KEY_MAP = {
  'tls.ja3s': 'ja3s',
  'tls.version': 'tls_version'
};

function getCurrentPageNum() {
  const match = location.href.match(/[?&]page=(\d+)/);
  return match ? parseInt(match[1]) : 1;
}

// 解析 /result?qbase64=xxx 链接，返回 {key, value}
function decodeParam(href) {
  try {
    const m = (href || '').match(/qbase64=([^&]+)/);
    if (!m) return null;
    const decoded = atob(decodeURIComponent(m[1]));
    const kv = decoded.match(/^([a-zA-Z_.]+)="(.*)"$/);
    if (!kv) return null;
    return { key: kv[1], value: kv[2] };
  } catch (e) {
    return null;
  }
}

function extractAssets() {
  const items = document.querySelectorAll('.hsxa-meta-data-item');
  const assets = [];

  for (const item of items) {
    const asset = {
      url: '', ip_port: '', ip: '', port: '', protocol: '', title: '', domain: '',
      country: '', region: '', city: '', asn: '', org: '', lastupdatetime: '',
      cert_cn: '', cert_issuer: '', cert_san: '', ja3s: '', jarm: '',
      icon_hash: '', header_hash: '', banner_hash: '', tls_version: ''
    };

    // 1. URL：复制按钮上的 data-clipboard-text
    const copyBtn = item.querySelector('span.hsxa-copy-btn[data-clipboard-text]');
    if (copyBtn) asset.url = (copyBtn.getAttribute('data-clipboard-text') || '').trim();

    // 2. 结构化字段：解析卡片内所有 qbase64 跳转链接
    item.querySelectorAll('a[href*="qbase64="]').forEach(a => {
      const kv = decodeParam(a.getAttribute('href'));
      if (!kv) return;
      const key = KEY_MAP[kv.key] || kv.key;
      if (key in asset && !asset[key]) {
        asset[key] = kv.value;
      }
    });

    // 3. 左栏补充：标题 / 国家行 / 更新时间
    const leftMain = item.querySelector('.hsxa-meta-data-list-main-left');
    if (leftMain) {
      const lines = leftMain.querySelectorAll('p.hsxa-one-line');

      // 标题 = 第一个纯文本行（不含国家图标、不含跳转链接）
      for (const p of lines) {
        if (p.querySelector('img[alt="country"]')) continue;
        if (p.querySelector('a[href*="qbase64"]')) continue;
        const text = (p.textContent || '').trim();
        if (text) { asset.title = text; break; }
      }

      // 国家/地区/城市：取可见文本（中文直观），覆盖 qbase64 里的 CN 代码
      const countryLine = Array.from(lines).find(p => p.querySelector('img[alt="country"]'));
      if (countryLine) {
        const parts = (countryLine.textContent || '').split('/').map(s => s.trim()).filter(Boolean);
        if (parts[0]) asset.country = parts[0];
        if (parts[1]) asset.region = parts[1];
        if (parts[2]) asset.city = parts[2];
      }

      // 更新时间
      const dateSpan = Array.from(leftMain.querySelectorAll('p > span')).find(s =>
        /^\d{4}-\d{2}-\d{2}$/.test((s.textContent || '').trim())
      );
      if (dateSpan) asset.lastupdatetime = dateSpan.textContent.trim();
    }

    // 4. 证书：Subject / Issuer 的 CommonName
    item.querySelectorAll('.hsxa-cert-item').forEach(certItem => {
      const titleEl = certItem.querySelector('.hsxa-cert-title .hsxa-text-title');
      const certTitle = (titleEl ? titleEl.textContent : '').trim().toLowerCase();
      if (certTitle !== 'subject' && certTitle !== 'issuer') return;
      certItem.querySelectorAll('.hsxa-cert-content > div').forEach(row => {
        const spans = row.querySelectorAll('span');
        if (spans.length < 2) return;
        const label = (spans[0].textContent || '').trim().toLowerCase();
        const value = (spans[spans.length - 1].textContent || '').trim();
        if (!value || !label.startsWith('commonname')) return;
        if (certTitle === 'subject') asset.cert_cn = value;
        else asset.cert_issuer = value;
      });
    });

    // 5. SAN（列表页默认不渲染，若证书详情区出现 SAN/DNS 列表则提取）
    const certDetail = item.querySelector('.hsxa-certs-detail');
    if (certDetail) {
      const detailText = (certDetail.textContent || '').replace(/\s+/g, ' ').trim();
      if (detailText) {
        const sanMatch = detailText.match(/(?:SAN|DNS\s*Name|Subject Alternative)[:：]?\s*([^;；]+)/i);
        if (sanMatch && sanMatch[1]) asset.cert_san = sanMatch[1].trim();
      }
    }

    // 6. 组合列：IP:端口
    if (asset.ip && !asset.ip_port) {
      asset.ip_port = asset.port ? `${asset.ip}:${asset.port}` : asset.ip;
    }

    // 至少要有 IP 或 URL 才算有效资产
    if (asset.ip || asset.url) assets.push(asset);
  }

  return assets;
}

function sendToBackground(assets) {
  chrome.runtime.sendMessage({
    type: 'ASSET_DATA',
    source: 'fofa',
    pageNum: getCurrentPageNum(),
    url: location.href,
    assets,
    timestamp: Date.now()
  }, () => {
    if (chrome.runtime.lastError) {
      console.error('[Asset Helper] 发送失败:', chrome.runtime.lastError.message);
    } else {
      console.log('[Asset Helper] 已发送', assets.length, '条资产');
    }
  });
}

function poll() {
  if (document.hidden) return; // 后台标签页零消耗
  const assets = extractAssets();

  if (assets.length === 0) {
    // 页面渲染中 / 未登录 / 无结果：静默等待，限频提示（每 30 秒最多一条）
    const now = Date.now();
    if (now - lastEmptyWarn > 30000) {
      lastEmptyWarn = now;
      console.log('[Asset Helper] 暂未发现资产卡片，等待数据加载…');
    }
    return;
  }

  // 判定：数量异常说明选择器抓错了元素（如页面结构变化），拒绝发送
  if (assets.length > 200) {
    console.warn('[Asset Helper] 提取结果异常（' + assets.length + ' 条），已忽略');
    return;
  }

  // 数据或页面未变化时不重复发送
  const signature = location.href + '::' + JSON.stringify(assets);
  if (signature === lastSignature) return;
  lastSignature = signature;

  console.log('[Asset Helper] 提取到', assets.length, '条资产，示例:', assets[0]);
  sendToBackground(assets);
}

// 通知后台"新页面开始采集"：替换模式下先清空旧页数据
function notifyPageLoaded() {
  try {
    chrome.runtime.sendMessage(
      { type: 'PAGE_LOADED', source: 'fofa', url: location.href },
      () => { if (chrome.runtime.lastError) { /* 后台未就绪，忽略 */ } }
    );
  } catch (e) {}
}

function start() {
  notifyPageLoaded();
  poll();

  // 接管旧实例（扩展热重载后重新注入时，避免重复轮询）
  if (window.__assetHelperExtractorTimer) clearInterval(window.__assetHelperExtractorTimer);
  if (window.__assetHelperExtractorObserver) window.__assetHelperExtractorObserver.disconnect();

  // DOM 变化触发：翻页 / 新检索渲染完成后接近实时提取，页面空闲时零开销
  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(poll, 600);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.__assetHelperExtractorObserver = observer;

  // 兜底轮询：防止变化检测遗漏
  window.__assetHelperExtractorTimer = setInterval(poll, 10000);

  // 标签页恢复可见时立即补检（配合 hidden 跳过，后台标签页零消耗）
  window.__assetHelperVisHook = () => { if (!document.hidden) poll(); };
  if (!window.__assetHelperVisListenerAdded) {
    window.__assetHelperVisListenerAdded = true;
    document.addEventListener('visibilitychange', () => {
      if (window.__assetHelperVisHook) window.__assetHelperVisHook();
    });
  }

  console.log('[Asset Helper] 提取器已启动（DOM 变化触发 + 10 秒兜底检查）');
}

if (document.readyState === 'complete') {
  setTimeout(start, 1500);
} else {
  window.addEventListener('load', () => setTimeout(start, 1500));
}
