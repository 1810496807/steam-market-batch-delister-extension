/**
 * Steam Market Batch Delister - content script
 * All authenticated requests are restricted to the Steam Community market origin.
 */

(function () {
  'use strict';

  if (window.__steamBatchDelisterLoaded) return;

  const Core = globalThis.SteamBatchDelisterCore;
  if (!Core) {
    console.error('[Steam Batch Delister] core.js failed to load.');
    return;
  }

  window.__steamBatchDelisterLoaded = true;

  const HOST_ID = 'steam-batch-delister-host';
  const STEAM_MARKET_URL = 'https://steamcommunity.com/market/';
  const REQUEST_TIMEOUT_MS = 20000;
  const store = new Core.ListingStore();
  const state = {
    scanning: false,
    running: false,
    paused: false,
    phase: 'idle',
    hasFullScan: false,
    scanController: null,
    batchController: null,
    renderTimer: null,
    multiSellDraft: {
      appid: '730',
      contextid: '2',
      itemNames: ''
    }
  };

  let host = null;
  let shadowRoot = null;
  let panel = null;
  let uiInitialized = false;
  let rebuildScheduled = false;
  let hostObserver = null;
  let lastCurrentMarketListingError = null;

  function isUIConnected() {
    return Boolean(
      host && host.isConnected &&
      shadowRoot && host.shadowRoot === shadowRoot &&
      panel && panel.isConnected && panel.getRootNode() === shadowRoot
    );
  }

  function ui(id) {
    return isUIConnected() ? panel.querySelector('#' + id) : null;
  }

  function assertSteamMarketPage() {
    if (location.origin !== 'https://steamcommunity.com' || !location.pathname.startsWith('/market/')) {
      throw new Core.SbdError('当前页面不是 Steam 社区市场', {
        code: 'INVALID_PAGE',
        fatal: true
      });
    }
  }

  function getSessionID() {
    const cookie = document.cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('sessionid='));

    if (cookie) {
      const value = cookie.slice('sessionid='.length);
      try {
        return decodeURIComponent(value);
      } catch (error) {
        return value;
      }
    }

    const input = document.querySelector('input[name="sessionid"]');
    return input && input.value ? String(input.value) : '';
  }

  function parseListingRowsFromDoc(rootNode) {
    const listings = [];
    const rows = rootNode.querySelectorAll('.market_recent_listing_row');

    rows.forEach((row) => {
      const removeButton = row.querySelector('a[href*="Removelisting"], .item_market_action_button');
      const removeHref = removeButton ? removeButton.getAttribute('href') || '' : '';
      const listingId = Core.resolveListingId(row.id, removeHref);
      if (!listingId) return;

      const nameElement = row.querySelector('.market_listing_item_name, .market_listing_item_name_link');
      const gameElement = row.querySelector('.market_listing_game_name');
      const priceElement = row.querySelector('.market_listing_price');
      const itemLink = row.querySelector('a.market_listing_item_name_link');
      const link = itemLink ? itemLink.getAttribute('href') || '' : '';
      const appMatch = link.match(/\/market\/listings\/(\d+)\//i);

      listings.push({
        id: listingId,
        name: nameElement ? nameElement.textContent.trim() : ('商品 #' + listingId),
        game: gameElement ? gameElement.textContent.trim() : 'Steam',
        appid: appMatch ? appMatch[1] : '',
        price: priceElement ? priceElement.textContent.replace(/\s+/g, ' ').trim() : '',
        selected: false,
        status: 'pending'
      });
    });

    return listings;
  }

  function scanCurrentDocument() {
    try {
      const items = parseListingRowsFromDoc(document);
      store.replace(items);
      state.hasFullScan = false;
      rebuildGameFilter();
      renderListings();
      setProgress(0, items.length > 0 ? `当前页检测到 ${items.length} 件` : '当前页未检测到在售商品');
    } catch (error) {
      store.replace([]);
      state.hasFullScan = false;
      renderListings();
      setProgress(0, '页面挂单标识异常，已阻止操作');
      appendLog('页面解析失败：' + formatError(error), 'error');
    }
  }

  async function fetchListingsPageOnce(start, count, signal) {
    assertSteamMarketPage();
    Core.throwIfAborted(signal);

    const url = new URL(Core.getSteamMarketUrl('/market/mylistings/render/'));
    url.searchParams.set('query', '');
    url.searchParams.set('start', String(start));
    url.searchParams.set('count', String(count));
    const requestScope = Core.createAbortScope(signal, REQUEST_TIMEOUT_MS);

    try {
      let response;
      try {
        response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
          },
          credentials: 'same-origin',
          redirect: 'manual',
          signal: requestScope.signal
        });
      } catch (error) {
        if (requestScope.didTimeout()) {
          throw new Core.SbdError('读取在售列表超时', {
            code: 'REQUEST_TIMEOUT',
            retryable: true
          });
        }
        if (Core.isAbortError(error) || (signal && signal.aborted)) throw Core.createAbortError();
        throw new Core.SbdError('读取在售列表时网络异常', {
          code: 'NETWORK_ERROR',
          retryable: true
        });
      }

      if (response.redirected || response.type === 'opaqueredirect' || response.status === 0) {
        throw new Core.SbdError('Steam 登录状态已失效', {
          code: 'AUTH_REDIRECT',
          fatal: true
        });
      }

      if (response.url) Core.getSteamMarketUrl(response.url);

      if (!response.ok) {
        const retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
        throw new Core.SbdError('读取列表失败：HTTP ' + response.status, {
          code: response.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR',
          status: response.status,
          retryable,
          retryAfterMs: Core.parseRetryAfterMs(response.headers.get('Retry-After')),
          fatal: response.status === 401 || response.status === 403
        });
      }

      let data;
      try {
        data = await response.json();
      } catch (error) {
        if (requestScope.didTimeout()) {
          throw new Core.SbdError('读取在售列表响应超时', {
            code: 'REQUEST_TIMEOUT',
            retryable: true
          });
        }
        if (Core.isAbortError(error) || (signal && signal.aborted)) throw Core.createAbortError();
        throw new Core.SbdError('Steam 返回了无法解析的列表数据', {
          code: 'PROTOCOL_ERROR',
          fatal: true
        });
      }

      if (!data || (data.success !== true && data.success !== 1)) {
        throw new Core.SbdError('Steam 拒绝读取在售列表', {
          code: 'BUSINESS_FAILURE',
          fatal: true
        });
      }

      if (typeof data.results_html !== 'string') {
        throw new Core.SbdError('Steam 列表响应缺少 results_html', {
          code: 'PROTOCOL_ERROR',
          fatal: true
        });
      }

      const parsed = new DOMParser().parseFromString(data.results_html, 'text/html');
      const rawTotal = Core.parseNonNegativeInteger(data.total_count, data.num_active_listings);
      if (rawTotal === null) {
        throw new Core.SbdError('Steam 列表响应缺少有效总数', {
          code: 'PROTOCOL_ERROR',
          fatal: true
        });
      }

      return {
        items: parseListingRowsFromDoc(parsed),
        totalCount: rawTotal
      };
    } finally {
      requestScope.dispose();
    }
  }

  async function fetchListingsPage(start, count, signal) {
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await fetchListingsPageOnce(start, count, signal);
      } catch (error) {
        if (Core.isAbortError(error) || (signal && signal.aborted)) throw Core.createAbortError();
        if (!error.retryable || attempt >= maxAttempts - 1) throw error;

        const delayMs = error.retryAfterMs !== null
          ? error.retryAfterMs
          : Core.computeBackoffMs(attempt, { baseMs: 1000, maxMs: 10000 });

        appendLog(`列表请求受限，${Math.ceil(delayMs / 1000)} 秒后重试`, 'warning');
        await Core.abortableSleep(delayMs, signal);
      }
    }

    throw new Core.SbdError('列表请求重试次数已用尽', { code: 'RETRY_EXHAUSTED' });
  }

  async function loadAllListings(signal, progressLabel) {
    return Core.scanAllListings({
      fetchPage: fetchListingsPage,
      signal,
      pageSize: 100,
      pageDelayMs: 250,
      maxPages: 200,
      onProgress(progress) {
        const total = Number.isFinite(progress.total) ? progress.total : '?';
        setProgress(0, `${progressLabel} ${progress.loaded} / ${total}`);
      }
    });
  }

  function reconcileScan(items) {
    const ambiguousIds = store.values()
      .filter((item) => ['removing', 'submitted', 'unknown'].includes(item.status))
      .map((item) => item.id);

    store.replace(items);

    for (const id of ambiguousIds) {
      if (store.has(id)) {
        store.setStatus(id, 'failed', '重新扫描后仍在售');
      }
    }
  }

  async function scanAll() {
    if (state.running) return;

    if (state.scanning) {
      state.scanController.abort();
      return;
    }

    state.scanning = true;
    state.hasFullScan = false;
    state.scanController = new AbortController();
    updateControls();
    appendLog('开始扫描全部在售商品', 'info');

    try {
      const result = await loadAllListings(state.scanController.signal, '正在扫描');
      reconcileScan(result.items);
      state.hasFullScan = true;
      rebuildGameFilter();
      renderListings();
      setProgress(100, `扫描完成，共 ${store.size} 件在售商品`);
      appendLog(`扫描完成：${store.size} 件，默认均未选择`, 'success');
    } catch (error) {
      if (Core.isAbortError(error)) {
        appendLog('扫描已取消，保留原列表', 'warning');
        setProgress(0, '扫描已取消');
      } else {
        appendLog('扫描失败：' + formatError(error), 'error');
        setProgress(0, '扫描失败');
      }
    } finally {
      state.scanning = false;
      state.scanController = null;
      updateControls();
      scheduleUIRebuild();
    }
  }

  function getCurrentFilter() {
    return {
      query: ui('sbd-search').value,
      game: ui('sbd-filter-game').value
    };
  }

  function getVisibleListings() {
    const filter = getCurrentFilter();
    return store.values().filter((item) => Core.matchesListing(item, filter));
  }

  function getTargets() {
    return Core.getActionableListings(store, getCurrentFilter());
  }

  function rebuildGameFilter() {
    if (!isUIConnected()) return;
    const select = ui('sbd-filter-game');
    const previous = select.value || 'ALL';
    const games = Array.from(new Set(store.values().map((item) => item.game).filter(Boolean)))
      .sort((left, right) => left.localeCompare(right, 'zh-CN'));

    select.replaceChildren();
    const allOption = document.createElement('option');
    allOption.value = 'ALL';
    allOption.textContent = '全部游戏';
    select.appendChild(allOption);

    games.forEach((game) => {
      const option = document.createElement('option');
      option.value = game;
      option.textContent = game;
      select.appendChild(option);
    });

    select.value = games.includes(previous) ? previous : 'ALL';
  }

  function statusLabel(status) {
    const labels = {
      pending: '待处理',
      removing: '处理中',
      submitted: '待核验',
      failed: '失败',
      unknown: '状态未知'
    };
    return labels[status] || status;
  }

  function createListingRow(item) {
    const row = document.createElement('label');
    row.className = 'sbd-listing-row';
    row.dataset.rowId = item.id;
    row.setAttribute('role', 'listitem');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'sbd-listing-checkbox';
    checkbox.dataset.listingId = item.id;
    checkbox.checked = item.selected;
    checkbox.disabled = state.running || !Core.ACTIONABLE_STATUSES.has(item.status);
    Core.bindListingCheckbox(checkbox, store, () => {
      updateStats();
      updateControls();
    }, { requireTrusted: true });

    const details = document.createElement('span');
    details.className = 'sbd-listing-details';

    const name = document.createElement('span');
    name.className = 'sbd-listing-name';
    name.textContent = item.name;
    name.title = item.name;

    const meta = document.createElement('span');
    meta.className = 'sbd-listing-meta';
    meta.textContent = [item.game, item.appid ? 'App ' + item.appid : '', item.price]
      .filter(Boolean)
      .join(' · ');

    const status = document.createElement('span');
    status.className = 'sbd-listing-status sbd-status-' + item.status;
    status.textContent = statusLabel(item.status);
    status.title = item.lastError || '';

    details.append(name, meta);
    row.append(checkbox, details, status);
    return row;
  }

  function renderListings() {
    if (!isUIConnected()) return;

    const list = ui('sbd-listings');
    const visible = getVisibleListings();
    const fragment = document.createDocumentFragment();

    visible.forEach((item) => fragment.appendChild(createListingRow(item)));
    list.replaceChildren(fragment);

    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sbd-empty-state';
      empty.textContent = store.size === 0 ? '暂无在售商品' : '当前筛选无匹配商品';
      list.appendChild(empty);
    }

    updateStats();
    updateControls();
  }

  function scheduleRender() {
    clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(renderListings, 120);
  }

  function updateStats() {
    if (!isUIConnected()) return;
    const visible = getVisibleListings();
    const selected = getTargets();
    ui('sbd-total-count').textContent = String(store.size);
    ui('sbd-visible-count').textContent = String(visible.length);
    ui('sbd-selected-count').textContent = String(selected.length);
  }

  function updateRowState(id) {
    if (!isUIConnected()) return;
    const item = store.get(id);
    const row = Array.from(panel.querySelectorAll('.sbd-listing-row'))
      .find((candidate) => candidate.dataset.rowId === String(id));
    if (!item || !row) return;

    const checkbox = row.querySelector('.sbd-listing-checkbox');
    const status = row.querySelector('.sbd-listing-status');
    checkbox.checked = item.selected;
    checkbox.disabled = state.running || !Core.ACTIONABLE_STATUSES.has(item.status);
    status.className = 'sbd-listing-status sbd-status-' + item.status;
    status.textContent = statusLabel(item.status);
    status.title = item.lastError || '';
  }

  function setProgress(percent, text) {
    if (!isUIConnected()) return;
    const normalizedPercent = Math.max(0, Math.min(100, percent));
    ui('sbd-progress-bar').style.width = normalizedPercent + '%';
    ui('sbd-progress-track').setAttribute('aria-valuenow', String(normalizedPercent));
    ui('sbd-progress-text').textContent = text;
  }

  function appendLog(message, type = 'info') {
    if (!isUIConnected()) return;
    const box = ui('sbd-logs');
    const item = document.createElement('div');
    item.className = 'sbd-log-item sbd-log-' + type;
    item.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
    box.appendChild(item);

    while (box.childElementCount > 400) {
      box.firstElementChild.remove();
    }

    box.scrollTop = box.scrollHeight;
  }

  function formatError(error) {
    const messages = {
      BUSINESS_FAILURE: 'Steam 拒绝了请求',
      AUTH_REDIRECT: '登录状态已失效，请重新登录',
      INVALID_RESPONSE_ORIGIN: 'Steam 返回了异常跳转',
      PROTOCOL_ERROR: 'Steam 返回了非预期响应',
      MISSING_SESSION: '未检测到 sessionid',
      NETWORK_ERROR: '网络连接失败',
      REQUEST_TIMEOUT: '请求超时',
      RATE_LIMITED: 'Steam 请求频率限制持续存在',
      HTTP_ERROR: 'Steam 返回了 HTTP 错误',
      SELECTION_CHANGED: '商品选择在确认后发生变化，任务已中止',
      RESPONSE_READ_ERROR: 'Steam 响应中断，结果需要核验',
      LISTING_ID_MISMATCH: '同一商品行出现冲突的挂单 ID',
      INCOMPLETE_SCAN: '分页结果不完整，已阻止批量操作',
      SCAN_LIMIT_EXCEEDED: '在售数量超过扫描安全上限'
    };

    return messages[error && error.code] || (error && error.message) || '未知错误';
  }

  async function waitUntilResumed(signal) {
    while (state.paused) {
      await Core.abortableSleep(150, signal);
    }
    Core.throwIfAborted(signal);
  }

  function buildConfirmation(targets, delay) {
    const preview = targets.slice(0, 5).map((item) => '• ' + item.name).join('\n');
    const remainder = targets.length > 5 ? `\n• 以及另外 ${targets.length - 5} 件` : '';
    return `确认下架当前筛选中已选择的 ${targets.length} 件商品？\n\n${preview}${remainder}\n\n请求间隔：${delay}ms`;
  }

  async function verifyBatch(verificationIds, signal) {
    if (verificationIds.size === 0) return { confirmed: 0, remaining: 0 };

    appendLog('提交完成，正在重新扫描核验结果', 'info');
    const result = await loadAllListings(signal, '正在核验');
    const reconciliation = Core.reconcileVerification(store, verificationIds, result.items);

    state.hasFullScan = true;
    rebuildGameFilter();
    renderListings();
    return {
      confirmed: reconciliation.confirmed.length,
      remaining: reconciliation.remaining.length
    };
  }

  async function executeBatchDelist() {
    if (state.running || state.scanning) return;
    if (!state.hasFullScan) {
      alert('请先完成一次全量扫描。');
      return;
    }

    assertSteamMarketPage();
    const sessionid = getSessionID();
    if (!sessionid) {
      alert('未检测到 Steam 登录状态，请重新登录后刷新页面。');
      return;
    }

    const targets = getTargets();
    if (targets.length === 0) {
      alert('当前筛选中没有已选择的商品。');
      return;
    }

    const delayInput = ui('sbd-input-delay');
    const delay = Core.clampDelay(delayInput.value);
    delayInput.value = String(delay);

    if (!confirm(buildConfirmation(targets, delay))) return;

    state.running = true;
    state.paused = false;
    state.phase = 'queue';
    state.batchController = new AbortController();
    const verificationIds = new Set();
    let failedCount = 0;
    let attemptedCount = 0;
    let stopped = false;
    updateControls();
    appendLog(`开始处理 ${targets.length} 件商品`, 'info');

    try {
      try {
        const queueReport = await Core.runRemovalQueue({
          items: targets,
          signal: state.batchController.signal,
          delayMs: delay,
          waitUntilResumed,
          executeItem: async (item, signal) => {
            const ensureStillSelected = async () => {
              await waitUntilResumed(signal);
              const current = store.get(item.id);
              if (!current || !current.selected) {
                throw new Core.SbdError('Listing selection changed after confirmation', {
                  code: 'SELECTION_CHANGED',
                  fatal: true
                });
              }
            };

            return Core.requestRemovalWithRetry({
              listingId: item.id,
              sessionid,
              signal,
              beforeAttempt: ensureStillSelected,
              maxAttempts: 4,
              onRetry(retry) {
                appendLog(`${item.name} 请求受限，${Math.ceil(retry.delayMs / 1000)} 秒后重试`, 'warning');
              }
            });
          },
          onItemStart(item, index, total) {
            attemptedCount = index + 1;
            store.setStatus(item.id, 'removing');
            updateRowState(item.id);
            setProgress(Math.round((index / total) * 100), `处理中 ${index + 1} / ${total}`);
          },
          onItemComplete(item, result, index, total) {
            Core.applyRemovalOutcome(store, verificationIds, item, 'accepted');
            updateRowState(item.id);
            updateStats();
            setProgress(Math.round(((index + 1) / total) * 100), `已提交 ${index + 1} / ${total}`);
            appendLog(`已提交：${item.name}${result.confirmed ? '' : '（待核验）'}`, 'success');
          },
          onItemError(item, error) {
            const errorMessage = formatError(error);
            if (error.ambiguous) {
              Core.applyRemovalOutcome(store, verificationIds, item, 'ambiguous', '请求结果不明确，等待核验');
              appendLog(`待核验：${item.name} - ${errorMessage}`, 'warning');
            } else {
              failedCount += 1;
              Core.applyRemovalOutcome(store, verificationIds, item, 'failed', errorMessage);
              appendLog(`失败：${item.name} - ${errorMessage}`, 'error');
            }
            updateRowState(item.id);
          },
          onItemUnknown(item) {
            Core.applyRemovalOutcome(store, verificationIds, item, 'aborted', '请求被停止，服务端结果未知');
            updateRowState(item.id);
          }
        });
        attemptedCount = queueReport.attempted;
      } catch (error) {
        if (error.queueReport) attemptedCount = error.queueReport.attempted;
        if (Core.isAbortError(error)) {
          stopped = true;
          state.hasFullScan = false;
          appendLog('任务已停止；已发送的请求需要重新扫描核验', 'warning');
        } else {
          appendLog('任务中止：' + formatError(error), 'error');
          if (error.fatal) state.hasFullScan = false;
        }
      }

      const skippedCount = Math.max(0, targets.length - attemptedCount);
      const finalPercent = skippedCount === 0
        ? 100
        : Math.round((attemptedCount / targets.length) * 100);

      if (stopped) {
        setProgress(finalPercent, `已停止：已尝试 ${attemptedCount} 件，未处理 ${skippedCount} 件`);
      } else if (verificationIds.size > 0) {
        try {
          await waitUntilResumed(state.batchController.signal);
          state.paused = false;
          state.phase = 'verifying';
          updateControls();
          const verification = await verifyBatch(verificationIds, state.batchController.signal);
          const totalFailed = verification.remaining + failedCount;
          const skippedSuffix = skippedCount > 0 ? `，未处理 ${skippedCount} 件` : '';
          appendLog(`核验完成：确认下架 ${verification.confirmed} 件，仍在售 ${verification.remaining} 件，直接失败 ${failedCount} 件${skippedSuffix}`, totalFailed > 0 || skippedCount > 0 ? 'warning' : 'success');
          setProgress(finalPercent, `确认下架 ${verification.confirmed} 件，失败 ${totalFailed} 件${skippedSuffix}`);
        } catch (error) {
          state.hasFullScan = false;
          if (Core.isAbortError(error)) {
            stopped = true;
            appendLog('核验已停止；请重新扫描确认最终结果', 'warning');
            setProgress(finalPercent, `核验已停止，未处理 ${skippedCount} 件，等待重新扫描`);
          } else {
            appendLog('下架请求已提交，但自动核验失败，请重新扫描', 'warning');
            setProgress(finalPercent, `提交完成，未处理 ${skippedCount} 件，等待手动重新扫描核验`);
          }
        }
      } else {
        const skippedSuffix = skippedCount > 0 ? `，未处理 ${skippedCount} 件` : '';
        setProgress(finalPercent, `任务结束，失败 ${failedCount} 件${skippedSuffix}`);
        appendLog(`任务结束：失败 ${failedCount} 件${skippedSuffix}`, failedCount > 0 || skippedCount > 0 ? 'warning' : 'success');
      }
    } finally {
      state.running = false;
      state.paused = false;
      state.phase = 'idle';
      state.batchController = null;
      renderListings();
      updateControls();
      scheduleUIRebuild();
    }
  }

  function formatMultiSellError(error) {
    const messages = {
      INVALID_MULTI_SELL_APPID: 'AppID 必须是有效的正整数',
      INVALID_MULTI_SELL_CONTEXTID: 'ContextID 必须是有效的正整数',
      EMPTY_MULTI_SELL_ITEMS: '请粘贴商品链接或输入市场名称',
      INVALID_MULTI_SELL_ITEM: '物品名称包含无效字符或长度超过 512',
      INVALID_MARKET_LISTING_URL: '商品链接格式无效',
      INVALID_MARKET_LISTING_TARGET: '只接受 Steam 社区市场商品链接',
      INVALID_MARKET_LISTING_PATH: '请粘贴具体商品页的 Steam 市场链接',
      MARKET_LISTING_NAME_UNRESOLVED: '无法从 Steam 页面识别标准商品名称，请刷新商品页或手动输入市场名称',
      MIXED_MULTI_SELL_APPIDS: '检测到多个游戏，请按游戏分批打开',
      AMBIGUOUS_MULTI_SELL_APPID: '手动输入的名称无法识别游戏，请先选择对应游戏',
      TOO_MANY_MULTI_SELL_ITEMS: `每次最多处理 ${Core.MULTI_SELL_MAX_ITEMS} 种物品`,
      MULTI_SELL_URL_TOO_LONG: '生成的链接过长，请减少物品种类后分批打开'
    };

    return messages[error && error.code] || '无法生成 Steam 批量上架链接';
  }

  function setMultiSellStatus(message, type = '') {
    const status = ui('sbd-multisell-status');
    if (!status) return;
    status.textContent = message;
    status.className = 'sbd-multisell-status' + (type ? ' sbd-multisell-status-' + type : '');
  }

  function getMultiSellPreset(appid, contextid) {
    return Core.MULTI_SELL_GAME_PRESETS.find((preset) => (
      preset.appid === String(appid || '') &&
      (contextid === undefined || preset.contextid === String(contextid || ''))
    )) || null;
  }

  function getCurrentMarketListing() {
    lastCurrentMarketListingError = null;
    try {
      const pageSources = Array.from(document.scripts || [], (script) => script.textContent || '')
        .filter((source) => source.includes('window.SSR.'));
      return Core.resolveSteamMarketListingUrl(location.href, pageSources);
    } catch (error) {
      lastCurrentMarketListingError = error;
      return null;
    }
  }

  function serializeCurrentMarketListingError() {
    if (!lastCurrentMarketListingError) return null;
    return {
      code: String(lastCurrentMarketListingError.code || '')
    };
  }

  function populateMultiSellGames() {
    const select = ui('sbd-multisell-game');
    if (!select) return;
    select.replaceChildren();

    for (const preset of Core.MULTI_SELL_GAME_PRESETS) {
      const option = document.createElement('option');
      option.value = preset.key;
      option.textContent = preset.label;
      select.appendChild(option);
    }

    const customOption = document.createElement('option');
    customOption.value = 'custom';
    customOption.textContent = '其他游戏（高级）';
    select.appendChild(customOption);
  }

  function syncMultiSellGameSelection(options = {}) {
    const select = ui('sbd-multisell-game');
    const advanced = ui('sbd-multisell-advanced');
    if (!select || !advanced) return;

    const preset = getMultiSellPreset(
      state.multiSellDraft.appid,
      state.multiSellDraft.contextid
    );
    select.value = preset ? preset.key : 'custom';
    if (!preset && options.expandCustom === true) advanced.open = true;
  }

  function syncMultiSellDraft() {
    const appidInput = ui('sbd-multisell-appid');
    const contextidInput = ui('sbd-multisell-contextid');
    const itemNamesInput = ui('sbd-multisell-items');
    if (!appidInput || !contextidInput || !itemNamesInput) return;

    state.multiSellDraft.appid = appidInput.value;
    state.multiSellDraft.contextid = contextidInput.value;
    state.multiSellDraft.itemNames = itemNamesInput.value;
  }

  function applyInferredMultiSellAppId(appid, plainNameCount = 0, announce = false) {
    if (!appid) return;

    const selection = Core.resolveMultiSellSelection({
      selectedAppid: state.multiSellDraft.appid,
      selectedContextid: state.multiSellDraft.contextid,
      inferredAppid: appid,
      plainNameCount
    });
    const preset = selection.preset;
    state.multiSellDraft.appid = selection.appid;
    state.multiSellDraft.contextid = selection.contextid;

    ui('sbd-multisell-appid').value = state.multiSellDraft.appid;
    ui('sbd-multisell-contextid').value = state.multiSellDraft.contextid;
    syncMultiSellGameSelection({ expandCustom: !preset });

    if (announce) {
      setMultiSellStatus(
        preset
          ? `已从链接识别：${preset.label}`
          : `已识别 AppID ${appid}；请在高级设置确认 ContextID`,
        preset ? 'success' : 'warning'
      );
    }
  }

  function updateMultiSellCount() {
    const counter = ui('sbd-multisell-count');
    if (!counter) return;

    let uniqueCount;
    try {
      uniqueCount = Core.parseMultiSellEntries(state.multiSellDraft.itemNames).itemNames.length;
    } catch (error) {
      const names = state.multiSellDraft.itemNames
        .split(/\r?\n/u)
        .map((name) => name.trim())
        .filter(Boolean);
      uniqueCount = new Set(names).size;
    }
    const displayCount = uniqueCount > Core.MULTI_SELL_MAX_ITEMS
      ? Core.MULTI_SELL_MAX_ITEMS + '+'
      : String(uniqueCount);
    counter.textContent = displayCount + ' / ' + Core.MULTI_SELL_MAX_ITEMS;
  }

  function focusMultiSellError(error) {
    const idError = error && (
      error.code === 'INVALID_MULTI_SELL_APPID' ||
      error.code === 'INVALID_MULTI_SELL_CONTEXTID'
    );
    if (idError) ui('sbd-multisell-advanced').open = true;

    const targetId = error && error.code === 'INVALID_MULTI_SELL_APPID'
      ? 'sbd-multisell-appid'
      : (error && error.code === 'INVALID_MULTI_SELL_CONTEXTID'
          ? 'sbd-multisell-contextid'
          : 'sbd-multisell-items');
    const target = ui(targetId);
    if (target) {
      target.setAttribute('aria-invalid', 'true');
      target.focus();
    }
  }

  function addCurrentMarketItem() {
    const listing = getCurrentMarketListing();
    if (!listing) {
      setMultiSellStatus(
        lastCurrentMarketListingError && lastCurrentMarketListingError.code === 'MARKET_LISTING_NAME_UNRESOLVED'
          ? formatMultiSellError(lastCurrentMarketListingError)
          : '请先打开一个具体的 Steam 市场商品页',
        'error'
      );
      return;
    }

    try {
      let parsed;
      try {
        parsed = Core.parseMultiSellEntries(state.multiSellDraft.itemNames);
      } catch (error) {
        if (error.code !== 'EMPTY_MULTI_SELL_ITEMS') throw error;
        parsed = { appid: '', itemNames: [], plainNameCount: 0 };
      }

      if (parsed.appid && parsed.appid !== listing.appid) {
        throw new Core.SbdError('Steam market links belong to different games', {
          code: 'MIXED_MULTI_SELL_APPIDS'
        });
      }

      applyInferredMultiSellAppId(listing.appid, parsed.plainNameCount);
      if (parsed.itemNames.includes(listing.marketHashName)) {
        setMultiSellStatus('当前商品已在列表中', 'warning');
        return;
      }

      parsed.itemNames.push(listing.marketHashName);
      state.multiSellDraft.itemNames = parsed.itemNames.join('\n');
      ui('sbd-multisell-items').value = state.multiSellDraft.itemNames;
      ui('sbd-multisell-items').removeAttribute('aria-invalid');
      updateMultiSellCount();
      setMultiSellStatus(`已添加：${listing.marketHashName}`, 'success');
    } catch (error) {
      setMultiSellStatus(formatMultiSellError(error), 'error');
      focusMultiSellError(error);
    }
  }

  function openOfficialMultiSell() {
    syncMultiSellDraft();

    try {
      const parsed = Core.parseMultiSellEntries(state.multiSellDraft.itemNames);
      if (parsed.appid) {
        applyInferredMultiSellAppId(parsed.appid, parsed.plainNameCount);
      }
      const url = Core.buildMultiSellUrl({
        appid: state.multiSellDraft.appid,
        contextid: state.multiSellDraft.contextid,
        itemNames: parsed.itemNames
      });
      const openedWindow = window.open(url, '_blank', 'noopener,noreferrer');
      if (openedWindow) openedWindow.opener = null;
      ui('sbd-multisell-items').removeAttribute('aria-invalid');
      setMultiSellStatus(`已请求打开 ${parsed.itemNames.length} 种物品的官方上架页面`, 'success');
    } catch (error) {
      setMultiSellStatus(formatMultiSellError(error), 'error');
      focusMultiSellError(error);
    }
  }

  function updateControls() {
    if (!isUIConnected()) return;

    const targets = getTargets();
    const scanButton = ui('sbd-btn-scan-all');
    const startButton = ui('sbd-btn-start');
    const pauseButton = ui('sbd-btn-pause');
    const stopButton = ui('sbd-btn-stop');

    scanButton.disabled = state.running;
    scanButton.textContent = state.scanning ? '停止扫描' : '扫描全部在售';
    scanButton.classList.toggle('sbd-btn-danger', state.scanning);
    scanButton.classList.toggle('sbd-btn-accent', !state.scanning);

    startButton.disabled = state.running || state.scanning || !state.hasFullScan || targets.length === 0;
    startButton.hidden = state.running;
    pauseButton.hidden = !state.running || state.phase !== 'queue';
    stopButton.hidden = !state.running;
    pauseButton.textContent = state.paused ? '继续' : '暂停';

    panel.querySelectorAll('.sbd-listing-checkbox').forEach((checkbox) => {
      const item = store.get(checkbox.dataset.listingId);
      checkbox.checked = Boolean(item && item.selected);
      checkbox.disabled = state.running || state.scanning || !item || !Core.ACTIONABLE_STATUSES.has(item.status);
    });

    ui('sbd-btn-select-visible').disabled = state.running || state.scanning || store.size === 0;
    ui('sbd-btn-clear-selection').disabled = state.running || state.scanning || store.size === 0;
    ui('sbd-search').disabled = state.running;
    ui('sbd-filter-game').disabled = state.running;
    ui('sbd-input-delay').disabled = state.running;
  }

  function requireTrustedClick(event, action) {
    if (!event.isTrusted) return;
    action();
  }

  function setupEvents() {
    ui('sbd-btn-scan-all').addEventListener('click', (event) => requireTrustedClick(event, scanAll));
    ui('sbd-btn-start').addEventListener('click', (event) => requireTrustedClick(event, executeBatchDelist));
    ui('sbd-btn-open-market').addEventListener('click', (event) => requireTrustedClick(event, () => {
      const openedWindow = window.open(STEAM_MARKET_URL, '_blank', 'noopener,noreferrer');
      if (openedWindow) openedWindow.opener = null;
    }));

    ui('sbd-multisell-form').addEventListener('submit', (event) => {
      event.preventDefault();
      requireTrustedClick(event, openOfficialMultiSell);
    });

    ui('sbd-multisell-add-current').addEventListener('click', (event) => {
      requireTrustedClick(event, addCurrentMarketItem);
    });

    ui('sbd-multisell-game').addEventListener('change', (event) => {
      const advanced = ui('sbd-multisell-advanced');
      if (event.currentTarget.value === 'custom') {
        advanced.open = true;
        ui('sbd-multisell-items').removeAttribute('aria-invalid');
        setMultiSellStatus('');
        ui('sbd-multisell-appid').focus();
        return;
      }

      const preset = Core.MULTI_SELL_GAME_PRESETS.find((item) => item.key === event.currentTarget.value);
      if (!preset) return;
      state.multiSellDraft.appid = preset.appid;
      state.multiSellDraft.contextid = preset.contextid;
      ui('sbd-multisell-appid').value = preset.appid;
      ui('sbd-multisell-contextid').value = preset.contextid;
      ui('sbd-multisell-appid').removeAttribute('aria-invalid');
      ui('sbd-multisell-contextid').removeAttribute('aria-invalid');
      ui('sbd-multisell-items').removeAttribute('aria-invalid');
      advanced.open = false;
      setMultiSellStatus('');
    });

    ui('sbd-multisell-items').addEventListener('input', () => {
      syncMultiSellDraft();
      updateMultiSellCount();
      ui('sbd-multisell-items').removeAttribute('aria-invalid');
      setMultiSellStatus('');

      try {
        const parsed = Core.parseMultiSellEntries(state.multiSellDraft.itemNames);
        if (parsed.appid) {
          applyInferredMultiSellAppId(parsed.appid, parsed.plainNameCount, true);
        }
      } catch (error) {
        if (error.code !== 'EMPTY_MULTI_SELL_ITEMS') {
          setMultiSellStatus(formatMultiSellError(error), 'error');
          ui('sbd-multisell-items').setAttribute('aria-invalid', 'true');
        }
      }
    });

    for (const id of ['sbd-multisell-appid', 'sbd-multisell-contextid']) {
      ui(id).addEventListener('input', () => {
        syncMultiSellDraft();
        ui(id).removeAttribute('aria-invalid');
        ui('sbd-multisell-items').removeAttribute('aria-invalid');
        syncMultiSellGameSelection();
        setMultiSellStatus('');
      });
    }

    ui('sbd-btn-pause').addEventListener('click', (event) => requireTrustedClick(event, () => {
      if (state.phase !== 'queue') return;
      state.paused = !state.paused;
      updateControls();
      appendLog(state.paused ? '任务已暂停，将不再发送下一项请求' : '任务已继续', 'warning');
    }));

    ui('sbd-btn-stop').addEventListener('click', (event) => requireTrustedClick(event, () => {
      state.paused = false;
      if (state.batchController) state.batchController.abort();
    }));

    ui('sbd-btn-select-visible').addEventListener('click', (event) => requireTrustedClick(event, () => {
      const filter = getCurrentFilter();
      store.selectWhere((item) => Core.matchesListing(item, filter), true);
      renderListings();
    }));

    ui('sbd-btn-clear-selection').addEventListener('click', (event) => requireTrustedClick(event, () => {
      store.selectWhere(() => true, false);
      renderListings();
    }));

    ui('sbd-search').addEventListener('input', scheduleRender);
    ui('sbd-filter-game').addEventListener('change', renderListings);
    ui('sbd-input-delay').addEventListener('change', (event) => {
      event.currentTarget.value = String(Core.clampDelay(event.currentTarget.value));
    });

    ui('sbd-btn-minimize').addEventListener('click', (event) => requireTrustedClick(event, () => {
      panel.classList.toggle('sbd-minimized');
      const minimized = panel.classList.contains('sbd-minimized');
      event.currentTarget.textContent = minimized ? '+' : '−';
      event.currentTarget.title = minimized ? '展开' : '最小化';
      event.currentTarget.setAttribute('aria-label', minimized ? '展开' : '最小化');
      event.currentTarget.setAttribute('aria-expanded', String(!minimized));
    }));
  }

  function observeUIHost() {
    if (hostObserver) hostObserver.disconnect();
    hostObserver = new MutationObserver(() => {
      if (isUIConnected()) return;

      if (state.batchController && !state.batchController.signal.aborted) {
        console.warn('[Steam Batch Delister] UI was removed; stopping the active batch.');
        state.paused = false;
        state.batchController.abort();
      }
      if (state.scanController && !state.scanController.signal.aborted) {
        console.warn('[Steam Batch Delister] UI was removed; stopping the active scan.');
        state.scanController.abort();
      }

      scheduleUIRebuild();
    });

    hostObserver.observe(document.body, { childList: true });
    hostObserver.observe(document.documentElement, { childList: true });
    hostObserver.observe(shadowRoot, { childList: true });
  }

  function scheduleUIRebuild() {
    if (rebuildScheduled || state.running || state.scanning || isUIConnected()) return;
    rebuildScheduled = true;

    queueMicrotask(() => {
      rebuildScheduled = false;
      if (!state.running && !state.scanning && !isUIConnected()) {
        createUI({ initial: !uiInitialized });
      }
    });
  }

  function createUI(options = {}) {
    if (isUIConnected()) return true;
    if (state.running || state.scanning || !document.body) return false;

    const initial = options.initial === true;
    const staleHost = document.getElementById(HOST_ID);
    if (staleHost) staleHost.remove();

    host = document.createElement('div');
    host.id = HOST_ID;
    shadowRoot = host.attachShadow({ mode: 'open' });

    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = chrome.runtime.getURL('content.css');
    stylesheet.addEventListener('error', () => {
      console.error('[Steam Batch Delister] content.css failed to load.');
    }, { once: true });

    panel = document.createElement('section');
    panel.id = 'steam-batch-delister-panel';
    panel.setAttribute('aria-label', 'Steam 市场批量助手');
    panel.innerHTML = `
      <header class="sbd-header">
        <div>
          <div class="sbd-title">Steam 市场批量助手</div>
          <div class="sbd-version">安全队列 <span id="sbd-version"></span></div>
        </div>
        <button id="sbd-btn-minimize" class="sbd-icon-btn" type="button" title="最小化" aria-label="最小化" aria-expanded="true">−</button>
      </header>
      <div class="sbd-body">
        <div class="sbd-stat-bar" aria-live="polite">
          <span>在售 <strong id="sbd-total-count">0</strong></span>
          <span>当前 <strong id="sbd-visible-count">0</strong></span>
          <span>已选 <strong id="sbd-selected-count">0</strong></span>
        </div>

        <div class="sbd-top-actions">
          <button id="sbd-btn-scan-all" class="sbd-btn sbd-btn-accent" type="button">扫描全部在售</button>
          <button id="sbd-btn-open-market" class="sbd-btn sbd-btn-secondary" type="button" title="在新标签页打开 Steam 社区市场">打开 Steam 市场 ↗</button>
        </div>

        <details class="sbd-multisell">
          <summary>批量上架</summary>
          <form id="sbd-multisell-form" class="sbd-multisell-form" novalidate>
            <label class="sbd-multisell-field-label" for="sbd-multisell-game">游戏</label>
            <select id="sbd-multisell-game" aria-label="选择游戏"></select>
            <details id="sbd-multisell-advanced" class="sbd-multisell-advanced">
              <summary>高级设置</summary>
              <div class="sbd-multisell-ids">
                <label for="sbd-multisell-appid">
                  <span>AppID</span>
                  <input id="sbd-multisell-appid" type="text" inputmode="numeric" maxlength="10" autocomplete="off" />
                </label>
                <label for="sbd-multisell-contextid">
                  <span>ContextID</span>
                  <input id="sbd-multisell-contextid" type="text" inputmode="numeric" maxlength="20" autocomplete="off" />
                </label>
              </div>
            </details>
            <label class="sbd-multisell-field-label" for="sbd-multisell-items">商品链接或市场名称（每行一种）</label>
            <textarea id="sbd-multisell-items" rows="4" spellcheck="false" autocomplete="off" placeholder="粘贴 Steam 商品链接，或输入市场名称" aria-describedby="sbd-multisell-count sbd-multisell-status"></textarea>
            <button id="sbd-multisell-add-current" class="sbd-btn sbd-btn-secondary" type="button" hidden>＋ 添加当前页面商品</button>
            <div class="sbd-multisell-meta">
              <span id="sbd-multisell-count">0 / ${Core.MULTI_SELL_MAX_ITEMS}</span>
              <span id="sbd-multisell-status" class="sbd-multisell-status" role="status" aria-live="polite"></span>
            </div>
            <button class="sbd-btn sbd-btn-primary" type="submit">打开官方批量上架 ↗</button>
          </form>
        </details>

        <div class="sbd-filter-grid">
          <input id="sbd-search" type="search" aria-label="搜索在售商品" placeholder="搜索名称、游戏、AppID 或挂单 ID" autocomplete="off" />
          <select id="sbd-filter-game" aria-label="筛选游戏"><option value="ALL">全部游戏</option></select>
        </div>

        <div class="sbd-selection-actions">
          <button id="sbd-btn-select-visible" class="sbd-btn sbd-btn-secondary" type="button">选择当前筛选</button>
          <button id="sbd-btn-clear-selection" class="sbd-btn sbd-btn-secondary" type="button">清空选择</button>
        </div>

        <div id="sbd-listings" class="sbd-listings" role="list"></div>

        <div class="sbd-run-settings">
          <label for="sbd-input-delay">请求间隔</label>
          <input id="sbd-input-delay" type="number" value="800" min="500" max="5000" step="100" />
          <span>ms</span>
        </div>

        <div class="sbd-main-actions">
          <button id="sbd-btn-start" class="sbd-btn sbd-btn-primary" type="button" disabled>开始下架</button>
          <button id="sbd-btn-pause" class="sbd-btn sbd-btn-warning" type="button" hidden>暂停</button>
          <button id="sbd-btn-stop" class="sbd-btn sbd-btn-danger" type="button" hidden>停止</button>
        </div>

        <div class="sbd-progress-section">
          <div id="sbd-progress-track" class="sbd-progress-track" role="progressbar" aria-label="批处理进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="sbd-progress-bar" class="sbd-progress-bar"></div></div>
          <div id="sbd-progress-text" class="sbd-progress-text" aria-live="polite">等待全量扫描</div>
        </div>

        <div id="sbd-logs" class="sbd-log-box" aria-live="polite"></div>
      </div>
    `;

    shadowRoot.append(stylesheet, panel);
    document.body.appendChild(host);
    observeUIHost();
    populateMultiSellGames();
    ui('sbd-multisell-appid').value = state.multiSellDraft.appid;
    ui('sbd-multisell-contextid').value = state.multiSellDraft.contextid;
    ui('sbd-multisell-items').value = state.multiSellDraft.itemNames;
    syncMultiSellGameSelection();
    const currentListing = getCurrentMarketListing();
    const currentListingError = serializeCurrentMarketListingError();
    const addCurrentButton = ui('sbd-multisell-add-current');
    const currentListingUnresolved = Boolean(
      currentListingError && currentListingError.code === 'MARKET_LISTING_NAME_UNRESOLVED'
    );
    addCurrentButton.hidden = !currentListing && !currentListingUnresolved;
    addCurrentButton.disabled = !currentListing;
    if (currentListing) {
      addCurrentButton.title = '添加 ' + currentListing.marketHashName;
      addCurrentButton.setAttribute('aria-label', '添加当前页面商品：' + currentListing.marketHashName);
    } else if (currentListingUnresolved) {
      addCurrentButton.title = '无法识别当前页面的标准商品名称';
      addCurrentButton.setAttribute('aria-label', addCurrentButton.title);
      setMultiSellStatus(formatMultiSellError(currentListingError), 'warning');
    }
    updateMultiSellCount();
    setupEvents();
    ui('sbd-version').textContent = 'v' + chrome.runtime.getManifest().version;

    if (initial && !uiInitialized) {
      scanCurrentDocument();
      appendLog('插件已加载；批量下架前需完成一次全量扫描', 'info');
    } else {
      rebuildGameFilter();
      renderListings();
      appendLog('界面已恢复；商品选择和任务状态已保留', 'warning');
    }

    uiInitialized = true;
    return true;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id === chrome.runtime.id && message && message.type === 'SBD_PING') {
      const ready = isUIConnected();
      if (!ready) scheduleUIRebuild();
      sendResponse({
        ready,
        version: chrome.runtime.getManifest().version,
        scanning: state.scanning,
        running: state.running,
        paused: state.paused,
        phase: state.phase,
        currentListing: getCurrentMarketListing(),
        currentListingError: serializeCurrentMarketListingError()
      });
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => createUI({ initial: true }), { once: true });
  } else {
    createUI({ initial: true });
  }
})();
