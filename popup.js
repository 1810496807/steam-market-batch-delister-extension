document.addEventListener('DOMContentLoaded', async () => {
  'use strict';

  const Core = globalThis.SteamBatchDelisterCore;
  const pageStatus = document.getElementById('page-status');
  const taskStatus = document.getElementById('task-status');
  const openMarketButton = document.getElementById('open-market-btn');
  const versionBadge = document.getElementById('version-badge');
  const multiSellForm = document.getElementById('multisell-form');
  const multiSellGame = document.getElementById('multisell-game');
  const multiSellAdvanced = document.getElementById('multisell-advanced');
  const multiSellAppId = document.getElementById('multisell-appid');
  const multiSellContextId = document.getElementById('multisell-contextid');
  const multiSellItems = document.getElementById('multisell-items');
  const multiSellAddCurrent = document.getElementById('multisell-add-current');
  const multiSellCount = document.getElementById('multisell-count');
  const multiSellStatus = document.getElementById('multisell-status');
  let currentListing = null;
  let currentListingError = null;

  versionBadge.textContent = 'v' + chrome.runtime.getManifest().version;

  openMarketButton.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://steamcommunity.com/market/' });
  });

  function multiSellErrorMessage(error) {
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
      TOO_MANY_MULTI_SELL_ITEMS: `每次最多处理 ${Core ? Core.MULTI_SELL_MAX_ITEMS : 100} 种物品`,
      MULTI_SELL_URL_TOO_LONG: '链接过长，请减少物品种类后分批打开'
    };

    return messages[error && error.code] || '无法生成 Steam 批量上架链接';
  }

  function setMultiSellStatus(message, type = '') {
    multiSellStatus.textContent = message;
    multiSellStatus.className = 'multisell-status' + (type ? ' multisell-status-' + type : '');
  }

  function getMultiSellPreset(appid, contextid) {
    return Core.MULTI_SELL_GAME_PRESETS.find((preset) => (
      preset.appid === String(appid || '') &&
      (contextid === undefined || preset.contextid === String(contextid || ''))
    )) || null;
  }

  function populateMultiSellGames() {
    multiSellGame.replaceChildren();
    for (const preset of Core.MULTI_SELL_GAME_PRESETS) {
      const option = document.createElement('option');
      option.value = preset.key;
      option.textContent = preset.label;
      multiSellGame.appendChild(option);
    }

    const customOption = document.createElement('option');
    customOption.value = 'custom';
    customOption.textContent = '其他游戏（高级）';
    multiSellGame.appendChild(customOption);
  }

  function syncMultiSellGame(options = {}) {
    const preset = getMultiSellPreset(multiSellAppId.value, multiSellContextId.value);
    multiSellGame.value = preset ? preset.key : 'custom';
    if (!preset && options.expandCustom === true) multiSellAdvanced.open = true;
  }

  function applyInferredMultiSellAppId(appid, plainNameCount = 0, announce = false) {
    if (!appid) return;

    const selection = Core.resolveMultiSellSelection({
      selectedAppid: multiSellAppId.value,
      selectedContextid: multiSellContextId.value,
      inferredAppid: appid,
      plainNameCount
    });
    const preset = selection.preset;
    multiSellAppId.value = selection.appid;
    multiSellContextId.value = selection.contextid;
    syncMultiSellGame({ expandCustom: !preset });

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
    const maximum = Core ? Core.MULTI_SELL_MAX_ITEMS : 100;
    let count;
    try {
      count = Core.parseMultiSellEntries(multiSellItems.value).itemNames.length;
    } catch (error) {
      const names = multiSellItems.value
        .split(/\r?\n/u)
        .map((name) => name.trim())
        .filter(Boolean);
      count = new Set(names).size;
    }
    multiSellCount.textContent = (count > maximum ? maximum + '+' : count) + ' / ' + maximum;
  }

  function focusMultiSellError(error) {
    const idError = error && (
      error.code === 'INVALID_MULTI_SELL_APPID' ||
      error.code === 'INVALID_MULTI_SELL_CONTEXTID'
    );
    if (idError) multiSellAdvanced.open = true;

    const target = error && error.code === 'INVALID_MULTI_SELL_APPID'
      ? multiSellAppId
      : (error && error.code === 'INVALID_MULTI_SELL_CONTEXTID'
          ? multiSellContextId
          : multiSellItems);
    target.setAttribute('aria-invalid', 'true');
    target.focus();
  }

  function addCurrentMarketItem() {
    if (!currentListing) {
      setMultiSellStatus(
        currentListingError && currentListingError.code === 'MARKET_LISTING_NAME_UNRESOLVED'
          ? multiSellErrorMessage(currentListingError)
          : '请先打开一个具体的 Steam 市场商品页',
        'error'
      );
      return;
    }

    try {
      let parsed;
      try {
        parsed = Core.parseMultiSellEntries(multiSellItems.value);
      } catch (error) {
        if (error.code !== 'EMPTY_MULTI_SELL_ITEMS') throw error;
        parsed = { appid: '', itemNames: [], plainNameCount: 0 };
      }

      if (parsed.appid && parsed.appid !== currentListing.appid) {
        throw new Core.SbdError('Steam market links belong to different games', {
          code: 'MIXED_MULTI_SELL_APPIDS'
        });
      }

      applyInferredMultiSellAppId(currentListing.appid, parsed.plainNameCount);
      if (parsed.itemNames.includes(currentListing.marketHashName)) {
        setMultiSellStatus('当前商品已在列表中', 'warning');
        return;
      }

      parsed.itemNames.push(currentListing.marketHashName);
      multiSellItems.value = parsed.itemNames.join('\n');
      multiSellItems.removeAttribute('aria-invalid');
      updateMultiSellCount();
      setMultiSellStatus(`已添加：${currentListing.marketHashName}`, 'success');
    } catch (error) {
      setMultiSellStatus(multiSellErrorMessage(error), 'error');
      focusMultiSellError(error);
    }
  }

  if (Core) {
    populateMultiSellGames();
    syncMultiSellGame();
  }

  multiSellGame.addEventListener('change', (event) => {
    if (event.currentTarget.value === 'custom') {
      multiSellAdvanced.open = true;
      multiSellItems.removeAttribute('aria-invalid');
      setMultiSellStatus('');
      multiSellAppId.focus();
      return;
    }

    const preset = Core.MULTI_SELL_GAME_PRESETS.find((item) => item.key === event.currentTarget.value);
    if (!preset) return;
    multiSellAppId.value = preset.appid;
    multiSellContextId.value = preset.contextid;
    multiSellAppId.removeAttribute('aria-invalid');
    multiSellContextId.removeAttribute('aria-invalid');
    multiSellItems.removeAttribute('aria-invalid');
    multiSellAdvanced.open = false;
    setMultiSellStatus('');
  });

  multiSellItems.addEventListener('input', () => {
    updateMultiSellCount();
    multiSellItems.removeAttribute('aria-invalid');
    setMultiSellStatus('');

    if (!Core) return;
    try {
      const parsed = Core.parseMultiSellEntries(multiSellItems.value);
      if (parsed.appid) {
        applyInferredMultiSellAppId(parsed.appid, parsed.plainNameCount, true);
      }
    } catch (error) {
      if (error.code !== 'EMPTY_MULTI_SELL_ITEMS') {
        setMultiSellStatus(multiSellErrorMessage(error), 'error');
        multiSellItems.setAttribute('aria-invalid', 'true');
      }
    }
  });

  for (const input of [multiSellAppId, multiSellContextId]) {
    input.addEventListener('input', () => {
      input.removeAttribute('aria-invalid');
      multiSellItems.removeAttribute('aria-invalid');
      syncMultiSellGame();
      setMultiSellStatus('');
    });
  }

  multiSellAddCurrent.addEventListener('click', (event) => {
    if (!event.isTrusted || !Core) return;
    addCurrentMarketItem();
  });

  updateMultiSellCount();

  multiSellForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!event.isTrusted) return;

    if (!Core) {
      setMultiSellStatus('核心模块未加载，请重新打开扩展', 'error');
      return;
    }

    try {
      const parsed = Core.parseMultiSellEntries(multiSellItems.value);
      if (parsed.appid) {
        applyInferredMultiSellAppId(parsed.appid, parsed.plainNameCount);
      }
      const url = Core.buildMultiSellUrl({
        appid: multiSellAppId.value,
        contextid: multiSellContextId.value,
        itemNames: parsed.itemNames
      });

      chrome.tabs.create({ url }, () => {
        if (chrome.runtime.lastError) {
          setMultiSellStatus('无法打开新标签页，请重试', 'error');
          return;
        }
        window.close();
      });
    } catch (error) {
      setMultiSellStatus(multiSellErrorMessage(error), 'error');
      focusMultiSellError(error);
    }
  });

  async function pingContentScript(tabId) {
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, { type: 'SBD_PING' });
        if (response && response.ready === true) return response;
      } catch (error) {
        lastError = error;
      }

      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }

    throw lastError || new Error('Content script unavailable');
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('No active tab');

    const response = await pingContentScript(tab.id);

    currentListing = response.currentListing || null;
    currentListingError = response.currentListingError || null;
    const currentListingUnresolved = Boolean(
      currentListingError && currentListingError.code === 'MARKET_LISTING_NAME_UNRESOLVED'
    );
    multiSellAddCurrent.hidden = !currentListing && !currentListingUnresolved;
    multiSellAddCurrent.disabled = !currentListing;
    if (currentListing) {
      multiSellAddCurrent.title = '添加 ' + currentListing.marketHashName;
      multiSellAddCurrent.setAttribute('aria-label', '添加当前页面商品：' + currentListing.marketHashName);
    } else if (currentListingUnresolved) {
      multiSellAddCurrent.title = '无法识别当前页面的标准商品名称';
      multiSellAddCurrent.setAttribute('aria-label', multiSellAddCurrent.title);
      setMultiSellStatus(multiSellErrorMessage(currentListingError), 'warning');
    }

    pageStatus.textContent = '已加载';
    pageStatus.style.color = '#83cf9d';
    taskStatus.textContent = response.scanning
      ? '正在扫描'
      : (response.running
          ? (response.paused ? '已暂停' : (response.phase === 'verifying' ? '正在核验' : '正在下架'))
          : '空闲');
    taskStatus.style.color = response.running || response.scanning ? '#e9bb6c' : '#b7c0c7';
  } catch (error) {
    pageStatus.textContent = '未加载';
    pageStatus.style.color = '#ff8989';
    taskStatus.textContent = '请打开或刷新市场页';
    taskStatus.style.color = '#b7c0c7';
  }
});
