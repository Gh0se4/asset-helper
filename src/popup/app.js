/**
 * Asset Helper - 悬浮面板主逻辑
 *
 * 职责：
 * 1. 资产表格展示（Tabulator，虚拟滚动）
 * 2. 列级操作（列头"追加 / 覆盖"徽章 → 暂存区）
 * 3. 暂存区管理（追加、覆盖、去重、导出）
 * 4. 统计信息、CSV / JSON 导出与 Toast 通知
 */

// 必须从 UMD 完整版导入：ESM 构建会因为 package.json 的 sideEffects 声明
// 被 tree-shaking 摇掉模块注册代码，导致渲染器失效、表格无法显示数据
import Tabulator from 'tabulator-tables/dist/js/tabulator.js';
import 'tabulator-tables/dist/css/tabulator_simple.min.css';

// ============================================
// Toast 通知管理器
// ============================================

class ToastManager {
  constructor() {
    this.container = document.getElementById('toastContainer');
  }

  show(message, type = 'info', duration = 3000) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icons = {
      success: '✓',
      error: '✗',
      info: 'ℹ'
    };

    toast.innerHTML = `
      <span class="toast-icon">${icons[type] || icons.info}</span>
      <span class="toast-message">${message}</span>
    `;

    this.container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  success(msg) { this.show(msg, 'success'); }
  error(msg) { this.show(msg, 'error'); }
  info(msg) { this.show(msg, 'info'); }
}

const toast = new ToastManager();

// ============================================
// 暂存区管理器（新增核心功能）
// ============================================

class StashManager {
  constructor() {
    this.textarea = document.getElementById('stashTextarea');
    this.countLabel = document.getElementById('stashCount');
    this.panel = document.getElementById('stashPanel');
    this.saveTimer = null;
    this.initEventListeners();
    this.restoreStash();
    this.updateCount();
  }

  initEventListeners() {
    // 折叠/展开
    document.getElementById('toggleStash').addEventListener('click', () => {
      this.toggle();
    });

    // 折叠状态下，点击竖条空白区域即可展开（点按钮本身时不重复触发，避免收起后立即又展开）
    this.panel.querySelector('.stash-header').addEventListener('click', (e) => {
      if (e.target.closest('#toggleStash')) return;
      if (this.panel.classList.contains('collapsed')) {
        this.toggle();
      }
    });

    // 清空
    document.getElementById('clearStash').addEventListener('click', () => {
      if (confirm('确认清空暂存区吗？')) {
        this.clear();
        toast.success('暂存区已清空');
      }
    });

    // 复制
    document.getElementById('copyStash').addEventListener('click', () => {
      this.copy();
    });

    // 导出
    document.getElementById('exportStash').addEventListener('click', () => {
      this.export();
    });

    // 去重按钮
    document.getElementById('dedupeStash').addEventListener('click', () => {
      this.dedupe();
    });

    // 监听内容变化（并持久化，页面刷新不丢失）
    this.textarea.addEventListener('input', () => {
      this.updateCount();
      this.scheduleSave();
    });

    // 页面关闭前立即保存
    window.addEventListener('pagehide', () => this.saveNow());
  }

  /**
   * 追加数据到暂存区
   */
  append(data, separator = '\n') {
    const currentContent = this.textarea.value.trim();
    const newContent = Array.isArray(data) ? data.join(separator) : String(data);

    if (currentContent) {
      this.textarea.value = currentContent + separator + newContent;
    } else {
      this.textarea.value = newContent;
    }

    this.updateCount();
    this.scrollToBottom();
    this.saveNow();
  }

  /**
   * 覆盖暂存区内容
   */
  replace(data, separator = '\n') {
    const newContent = Array.isArray(data) ? data.join(separator) : String(data);
    this.textarea.value = newContent;
    this.updateCount();
    this.saveNow();
  }

  /**
   * 获取暂存区内容（按行分割）
   */
  getLines() {
    return this.textarea.value
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
  }

  /**
   * 获取暂存区原始内容
   */
  getContent() {
    return this.textarea.value;
  }

  /**
   * 清空暂存区
   */
  clear() {
    this.textarea.value = '';
    this.updateCount();
    this.saveNow();
  }

  /**
   * 复制暂存区内容
   */
  copy() {
    const content = this.getContent();

    if (!content) {
      toast.error('暂存区为空');
      return;
    }

    navigator.clipboard.writeText(content).then(() => {
      const lines = this.getLines().length;
      toast.success(`已复制 ${lines} 行到剪贴板`);
    }).catch(err => {
      toast.error('复制失败: ' + err.message);
    });
  }

  /**
   * 导出暂存区为文本文件
   */
  export() {
    const content = this.getContent();

    if (!content) {
      toast.error('暂存区为空');
      return;
    }

    const filename = `stash_${this.getTimestamp()}.txt`;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    this.downloadBlob(blob, filename);

    toast.success(`已导出到 ${filename}`);
  }

  /**
   * 折叠/展开暂存区
   */
  toggle() {
    const collapsed = this.panel.classList.toggle('collapsed');
    const btn = document.getElementById('toggleStash');
    btn.textContent = collapsed ? '◀' : '▶';
    btn.title = collapsed ? '展开暂存区' : '收起暂存区';
  }

  /**
   * 从 storage 恢复暂存内容（页面刷新/重开面板后不丢失）
   */
  restoreStash() {
    chrome.storage.local.get('stashContent', (res) => {
      if (res && typeof res.stashContent === 'string' && res.stashContent) {
        this.textarea.value = res.stashContent;
        this.updateCount();
      }
    });
  }

  /**
   * 输入时防抖保存
   */
  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 300);
  }

  /**
   * 立即保存暂存区内容
   */
  saveNow() {
    clearTimeout(this.saveTimer);
    chrome.storage.local.set({ stashContent: this.textarea.value });
  }

  /**
   * 去重：按行去除重复数据
   */
  dedupe() {
    const lines = this.getLines();
    const seen = new Set();
    const unique = [];
    let removed = 0;
    for (const line of lines) {
      if (seen.has(line)) { removed++; continue; }
      seen.add(line);
      unique.push(line);
    }
    if (removed === 0) {
      toast.info('暂存区没有重复数据');
      return;
    }
    this.replace(unique);
    toast.success(`已去重，删除 ${removed} 条重复数据`);
  }

  /**
   * 更新计数
   */
  updateCount() {
    const count = this.getLines().length;
    this.countLabel.textContent = count;
    this.countLabel.classList.toggle('is-empty', count === 0);
  }

  /**
   * 滚动到底部
   */
  scrollToBottom() {
    this.textarea.scrollTop = this.textarea.scrollHeight;
  }

  /**
   * 下载 Blob
   */
  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 100);
  }

  /**
   * 获取时间戳
   */
  getTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }
}

// ============================================
// Tabulator 表格管理（增强版：支持暂存区操作）
// ============================================

class AssetTable {
  constructor(stashManager) {
    this.table = null;
    this.stash = stashManager;
    this.emptyState = document.getElementById('emptyState');
    this.tableContainer = document.querySelector('.table-panel');
    this.initTable();
  }

  /**
   * 初始化表格
   */
  initTable() {
    this.table = new Tabulator("#asset-table", {
      data: [],
      layout: "fitColumns",
      height: "100%",
      rowHeight: 26,
      placeholder: "加载中...",

      // 列定义（紧凑布局 + 列头快捷角标 + 禁用排序）
      columns: [
        {
          title: "URL",
          field: "url",
          width: 185,
          minWidth: 150,
          headerSort: false,
          titleFormatter: this.makeTitleFormatter("url", "URL"),
          tooltip: true,
          formatter: (cell) => {
            const value = cell.getValue() || '';
            if (!value) return '';
            // 无协议的 IP:端口 自动补 http://，保证都可以点击访问
            const href = /^https?:\/\//i.test(value) ? value : `http://${value}`;
            const esc = (str) => String(str)
              .replace(/&/g, '&amp;').replace(/</g, '&lt;')
              .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            return `<a href="${esc(href)}" target="_blank" class="cell-link" title="${esc(href)}">${esc(value)}</a>`;
          }
        },
        { title: "IP:端口", field: "ip_port", width: 128, minWidth: 118, headerSort: false, titleFormatter: this.makeTitleFormatter("ip_port", "IP:端口"), tooltip: true },
        { title: "IP", field: "ip", width: 106, minWidth: 96, headerSort: false, titleFormatter: this.makeTitleFormatter("ip", "IP"), tooltip: true },
        { title: "端口", field: "port", width: 62, minWidth: 58, headerSort: false, titleFormatter: this.makeTitleFormatter("port", "端口"), tooltip: true },
        { title: "协议", field: "protocol", width: 64, minWidth: 60, headerSort: false, titleFormatter: this.makeTitleFormatter("protocol", "协议"), tooltip: true },
        { title: "标题", field: "title", minWidth: 140, headerSort: false, titleFormatter: this.makeTitleFormatter("title", "标题"), tooltip: true },
        { title: "域名", field: "domain", width: 132, minWidth: 115, headerSort: false, titleFormatter: this.makeTitleFormatter("domain", "域名"), tooltip: true },
        { title: "证书CN", field: "cert_cn", width: 130, minWidth: 108, headerSort: false, titleFormatter: this.makeTitleFormatter("cert_cn", "证书CN"), tooltip: true },
        { title: "SAN", field: "cert_san", width: 120, minWidth: 100, headerSort: false, titleFormatter: this.makeTitleFormatter("cert_san", "SAN"), tooltip: true },
        { title: "国家", field: "country", width: 64, minWidth: 60, headerSort: false, titleFormatter: this.makeTitleFormatter("country", "国家"), tooltip: true },
        { title: "地区", field: "region", width: 66, minWidth: 62, headerSort: false, titleFormatter: this.makeTitleFormatter("region", "地区"), tooltip: true },
        { title: "城市", field: "city", width: 66, minWidth: 62, headerSort: false, titleFormatter: this.makeTitleFormatter("city", "城市"), tooltip: true },
        { title: "ASN", field: "asn", width: 66, minWidth: 62, headerSort: false, titleFormatter: this.makeTitleFormatter("asn", "ASN"), tooltip: true },
        { title: "组织", field: "org", width: 132, minWidth: 112, headerSort: false, titleFormatter: this.makeTitleFormatter("org", "组织"), tooltip: true },
        { title: "组件", field: "components", width: 104, minWidth: 88, headerSort: false, titleFormatter: this.makeTitleFormatter("components", "组件"), tooltip: true },
        { title: "图标哈希", field: "icon_hash", width: 88, minWidth: 78, headerSort: false, titleFormatter: this.makeTitleFormatter("icon_hash", "图标哈希"), tooltip: true },
        { title: "更新时间", field: "lastupdatetime", width: 90, minWidth: 86, headerSort: false, titleFormatter: this.makeTitleFormatter("lastupdatetime", "更新时间"), tooltip: true }
      ],

      // 虚拟滚动
      virtualDom: true,
      virtualDomBuffer: 300
    });

    // 列头角标点击（事件委托，列头重绘后依然有效）
    document.getElementById('asset-table').addEventListener('click', (e) => this.handleHeaderBadgeClick(e));

    // 容器尺寸自适应：调整悬浮窗大小 / 暂存区折叠时重算列宽，避免列溢出折行
    let resizeTimer = null;
    const tableEl = document.getElementById('asset-table');
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          try { this.table.redraw(true); } catch (e) {}
        }, 120);
      }).observe(tableEl);
    }

    console.log('[Asset Helper] 表格已初始化');
  }

  /**
   * 生成列头格式器：标题 + 「加」「覆」两个快捷角标
   */
  makeTitleFormatter(field, label) {
    return () => {
      const wrap = document.createElement('span');
      wrap.className = 'col-hdr';

      const title = document.createElement('span');
      title.className = 'col-hdr-title';
      title.textContent = label;
      title.title = label;

      const actions = document.createElement('span');
      actions.className = 'col-hdr-actions';

      const appendBtn = document.createElement('button');
      appendBtn.type = 'button';
      appendBtn.className = 'col-badge';
      appendBtn.dataset.field = field;
      appendBtn.dataset.action = 'append';
      appendBtn.textContent = '加';
      appendBtn.title = '追加本列到暂存区';

      const replaceBtn = document.createElement('button');
      replaceBtn.type = 'button';
      replaceBtn.className = 'col-badge col-badge-replace';
      replaceBtn.dataset.field = field;
      replaceBtn.dataset.action = 'replace';
      replaceBtn.textContent = '覆';
      replaceBtn.title = '用本列覆盖暂存区';

      actions.appendChild(appendBtn);
      actions.appendChild(replaceBtn);
      wrap.appendChild(title);
      wrap.appendChild(actions);
      return wrap;
    };
  }

  /**
   * 列头角标点击：追加 / 覆盖暂存区
   */
  handleHeaderBadgeClick(e) {
    const btn = e.target.closest('.col-badge');
    if (!btn) return;
    e.stopPropagation();
    e.preventDefault();

    const field = btn.dataset.field;
    const values = this.table.getData()
      .map(r => r[field])
      .filter(v => v !== undefined && v !== null && String(v).trim() !== '')
      .map(v => String(v).trim());

    if (values.length === 0) {
      toast.error('本列没有可用数据');
      return;
    }

    if (btn.dataset.action === 'append') {
      this.stash.append(values);
      toast.success(`已追加 ${values.length} 项到暂存区`);
    } else {
      if (this.stash.getContent().trim() && !confirm('确认用本列数据覆盖暂存区现有内容吗？')) return;
      this.stash.replace(values);
      toast.success(`已用 ${values.length} 项覆盖暂存区`);
    }
  }

  setData(data) {
    if (!data || data.length === 0) {
      this.showEmptyState();
      return;
    }

    this.hideEmptyState();
    this.table.setData(data);
    console.log('[Asset Helper] 表格数据已更新:', data.length, '行');
  }

  addData(data) {
    if (!data || data.length === 0) return;

    this.hideEmptyState();
    this.table.addData(data);
    console.log('[Asset Helper] 表格数据已追加:', data.length, '行');
  }

  getData() {
    return this.table.getData();
  }

  clearData() {
    this.table.clearData();
    this.showEmptyState();
  }

  showEmptyState() {
    this.emptyState.style.display = 'flex';
    document.getElementById('asset-table').style.display = 'none';
  }

  hideEmptyState() {
    this.emptyState.style.display = 'none';
    document.getElementById('asset-table').style.display = 'block';
  }
}

// ============================================
// 导出管理器
// ============================================

class ExportManager {
  constructor(table) {
    this.table = table;
  }

  exportCSV() {
    const data = this.table.getData();

    if (data.length === 0) {
      toast.error('没有数据可导出');
      return;
    }

    const columns = this.table.table.getColumns()
      .filter(col => col.isVisible())
      .map(col => ({
        field: col.getField(),
        title: col.getDefinition().title
      }));

    const headers = columns.map(c => c.title);
    const csvRows = [headers.map(this.csvEscape).join(',')];

    for (const row of data) {
      const values = columns.map(c => this.csvEscape(row[c.field] || ''));
      csvRows.push(values.join(','));
    }

    const csv = '﻿' + csvRows.join('\n');
    const filename = `fofa_export_${this.getTimestamp()}.csv`;

    this.download(csv, filename, 'text/csv;charset=utf-8;');
    toast.success(`已导出 ${data.length} 条数据到 ${filename}`);
  }

  exportJSON() {
    const data = this.table.getData();

    if (data.length === 0) {
      toast.error('没有数据可导出');
      return;
    }

    const json = JSON.stringify(data, null, 2);
    const filename = `fofa_export_${this.getTimestamp()}.json`;

    this.download(json, filename, 'application/json');
    toast.success(`已导出 ${data.length} 条数据到 ${filename}`);
  }

  csvEscape(value) {
    const str = String(value ?? '');
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  download(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 100);
  }

  getTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }
}

// ============================================
// 统计信息更新
// ============================================

function updateStats(stats) {
  const rows = stats.totalRows || 0;
  const pages = stats.totalPages || 0;
  const ips = stats.uniqueIPs || 0;

  document.getElementById('rowCount').textContent = rows;
  document.getElementById('pageCount').textContent = pages;
  document.getElementById('uniqueIPs').textContent = ips;

  // 有数据时统计胶囊高亮，突出采集状态
  document.getElementById('statRows').classList.toggle('is-active', rows > 0);
  document.getElementById('statPages').classList.toggle('is-active', pages > 0);
  document.getElementById('statIPs').classList.toggle('is-active', ips > 0);
}

// ============================================
// 主应用逻辑
// ============================================

class SidePanelApp {
  constructor() {
    this.stashManager = new StashManager();
    this.assetTable = new AssetTable(this.stashManager);
    this.exporter = new ExportManager(this.assetTable);
    this.initEventListeners();
    this.initMessageListener();
    this.loadInitialData();

    console.log('[Asset Helper] 应用已初始化（含暂存区功能）');
  }

  initEventListeners() {
    // 累积模式开关
    document.getElementById('accumulateMode').addEventListener('change', (e) => {
      const mode = e.target.checked ? 'accumulate' : 'replace';

      chrome.runtime.sendMessage({ type: 'SET_MODE', mode }, (response) => {
        if (response && response.ok) {
          toast.success(`已切换到${mode === 'accumulate' ? '累积' : '替换'}模式`);
          // 切换模式不影响已收集的数据；替换语义从下一次页面加载开始生效
        }
      });
    });

    // 清空按钮
    document.getElementById('clearBtn').addEventListener('click', () => {
      if (confirm('确认清空所有数据吗？')) {
        chrome.runtime.sendMessage({ type: 'CLEAR_DATA' }, (response) => {
          if (response && response.ok) {
            this.assetTable.clearData();
            updateStats({ totalRows: 0, totalPages: 0, uniqueIPs: 0 });
            toast.success('数据已清空');
          }
        });
      }
    });

    // 导出按钮
    document.getElementById('exportCSV').addEventListener('click', () => {
      this.exporter.exportCSV();
    });

    document.getElementById('exportJSON').addEventListener('click', () => {
      this.exporter.exportJSON();
    });
  }

  initMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender) => {
      console.log('[Asset Helper] 收到消息:', message.type);

      switch (message.type) {
        case 'UPDATE_TABLE':
          this.handleUpdateTable(message.payload);
          break;

        case 'MODE_CHANGED':
          this.handleModeChanged(message.payload);
          break;

        case 'DATA_CLEARED':
          this.handleDataCleared();
          break;
      }
    });
  }

  loadInitialData() {
    chrome.runtime.sendMessage({ type: 'GET_DATA' }, (response) => {
      if (response && response.ok) {
        const { rows, stats } = response.data;

        if (rows && rows.length > 0) {
          this.assetTable.setData(rows);
          updateStats(stats);
        } else {
          this.assetTable.showEmptyState();
        }

        if (stats && stats.mode === 'accumulate') {
          document.getElementById('accumulateMode').checked = true;
        }
      }
    });
  }

  handleUpdateTable(payload) {
    const { mode, stats, allRows } = payload;

    this.assetTable.setData(allRows);
    updateStats(stats);
    if (stats.totalRows > 0) {
      toast.info(`数据已更新，当前 ${stats.totalRows} 行`);
    }
  }

  handleModeChanged(payload) {
    const checkbox = document.getElementById('accumulateMode');
    checkbox.checked = payload.mode === 'accumulate';
  }

  handleDataCleared() {
    this.assetTable.clearData();
    updateStats({ totalRows: 0, totalPages: 0, uniqueIPs: 0 });
  }
}

// ============================================
// 启动应用
// ============================================

let app;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    app = new SidePanelApp();
  });
} else {
  app = new SidePanelApp();
}

console.log('[Asset Helper] 脚本已加载（含暂存区功能）');
