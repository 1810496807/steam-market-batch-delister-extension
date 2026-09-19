(function (root, factory) {
  'use strict';

  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.SteamBatchDelisterCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STEAM_ORIGIN = 'https://steamcommunity.com';
  const ACTIONABLE_STATUSES = new Set(['pending', 'failed', 'unknown']);
  const MULTI_SELL_MAX_ITEMS = 100;
  const MULTI_SELL_MAX_ITEM_LENGTH = 512;
  const MULTI_SELL_MAX_URL_LENGTH = 8192;
  const MULTI_SELL_GAME_PRESETS = Object.freeze([
    Object.freeze({ key: '730:2', label: 'Counter-Strike 2', appid: '730', contextid: '2' }),
    Object.freeze({ key: '570:2', label: 'Dota 2', appid: '570', contextid: '2' }),
    Object.freeze({ key: '440:2', label: 'Team Fortress 2', appid: '440', contextid: '2' }),
    Object.freeze({ key: '252490:2', label: 'Rust', appid: '252490', contextid: '2' }),
    Object.freeze({ key: '578080:2', label: 'PUBG: BATTLEGROUNDS', appid: '578080', contextid: '2' }),
    Object.freeze({ key: '753:6', label: 'Steam 社区物品', appid: '753', contextid: '6' })
  ]);

  class SbdError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = 'SbdError';
      this.code = options.code || 'UNKNOWN';
      this.status = options.status || 0;
      this.retryable = Boolean(options.retryable);
      this.retryAfterMs = Number.isFinite(options.retryAfterMs) ? options.retryAfterMs : null;
      this.fatal = Boolean(options.fatal);
      this.ambiguous = Boolean(options.ambiguous);
    }
  }

  function createAbortError(message = 'Operation aborted') {
    const error = new Error(message);
    error.name = 'AbortError';
    error.code = 'ABORTED';
    return error;
  }

  function isAbortError(error) {
    return Boolean(error && (error.name === 'AbortError' || error.code === 'ABORTED'));
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : createAbortError();
    }
  }

  function abortableSleep(ms, signal) {
    throwIfAborted(signal);

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(finish, Math.max(0, ms));

      function finish() {
        if (signal) signal.removeEventListener('abort', abort);
        resolve();
      }

      function abort() {
        clearTimeout(timeoutId);
        reject(signal.reason instanceof Error ? signal.reason : createAbortError());
      }

      if (signal) signal.addEventListener('abort', abort, { once: true });
    });
  }

  function createAbortScope(parentSignal, timeoutMs) {
    const controller = new AbortController();
    const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
    let timedOut = false;
    let timeoutId = null;

    function forwardParentAbort() {
      if (controller.signal.aborted) return;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      const reason = parentSignal && parentSignal.reason instanceof Error
        ? parentSignal.reason
        : createAbortError();
      controller.abort(reason);
    }

    if (parentSignal) {
      if (parentSignal.aborted) {
        forwardParentAbort();
      } else {
        parentSignal.addEventListener('abort', forwardParentAbort, { once: true });
      }
    }

    if (hasTimeout && !controller.signal.aborted) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort(createAbortError('Request timed out'));
      }, timeoutMs);
    }

    return {
      signal: controller.signal,
      didTimeout() {
        return timedOut;
      },
      dispose() {
        if (timeoutId !== null) clearTimeout(timeoutId);
        if (parentSignal) parentSignal.removeEventListener('abort', forwardParentAbort);
      }
    };
  }

  function normalizeListing(input) {
    if (!input || input.id === undefined || input.id === null || String(input.id).trim() === '') {
      throw new TypeError('Listing id is required');
    }

    return {
      id: String(input.id),
      name: String(input.name || ('商品 #' + input.id)),
      game: String(input.game || 'Steam'),
      appid: String(input.appid || ''),
      price: String(input.price || ''),
      selected: input.selected === true,
      status: String(input.status || 'pending'),
      lastError: String(input.lastError || '')
    };
  }

  function resolveListingId(rowId, removeHref) {
    const rowMatch = String(rowId || '').match(/^mylisting_(\d+)$/);
    const href = String(removeHref || '');
    const hrefMatch = href.match(/Removelisting\s*\(\s*['"]?(\d+)['"]?\s*\)/i);
    const marketHrefMatch = href.match(/RemoveMarketListing\s*\(\s*['"](?:mylisting_)?(\d+)['"]\s*,\s*['"]?(\d+)['"]?/i);
    const rowListingId = rowMatch ? rowMatch[1] : '';
    const hrefRowListingId = marketHrefMatch ? marketHrefMatch[1] : '';
    const hrefListingId = hrefMatch ? hrefMatch[1] : (marketHrefMatch ? marketHrefMatch[2] : '');
    const ids = [rowListingId, hrefRowListingId, hrefListingId].filter(Boolean);

    if (new Set(ids).size > 1) {
      throw new SbdError('Steam listing identifiers do not match', {
        code: 'LISTING_ID_MISMATCH',
        fatal: true
      });
    }

    return hrefListingId || hrefRowListingId || rowListingId;
  }

  class ListingStore {
    constructor(initialItems = []) {
      this.items = new Map();
      this.merge(initialItems);
    }

    merge(nextItems) {
      for (const input of nextItems) {
        const next = normalizeListing(input);
        const current = this.items.get(next.id);

        if (current) {
          next.selected = current.selected;
          next.status = current.status;
          next.lastError = current.lastError;
        }

        this.items.set(next.id, next);
      }

      return this.values();
    }

    replace(nextItems) {
      const previous = this.items;
      const replacement = new Map();

      for (const input of nextItems) {
        const next = normalizeListing(input);
        const current = previous.get(next.id);

        if (current) {
          next.selected = current.selected;
          next.status = current.status;
          next.lastError = current.lastError;
        }

        replacement.set(next.id, next);
      }

      this.items = replacement;
      return this.values();
    }

    get(id) {
      return this.items.get(String(id));
    }

    has(id) {
      return this.items.has(String(id));
    }

    values() {
      return Array.from(this.items.values());
    }

    get size() {
      return this.items.size;
    }

    setSelected(id, selected) {
      const item = this.get(id);
      if (!item) return false;
      item.selected = Boolean(selected);
      return true;
    }

    setStatus(id, status, lastError = '') {
      const item = this.get(id);
      if (!item) return false;
      item.status = String(status);
      item.lastError = String(lastError || '');
      return true;
    }

    selectWhere(predicate, selected) {
      let changed = 0;

      for (const item of this.items.values()) {
        if (predicate(item) && ACTIONABLE_STATUSES.has(item.status)) {
          if (item.selected !== Boolean(selected)) changed += 1;
          item.selected = Boolean(selected);
        }
      }

      return changed;
    }
  }

  function bindListingCheckbox(checkbox, store, onChanged = function () {}, options = {}) {
    if (!checkbox || typeof checkbox.addEventListener !== 'function') {
      throw new TypeError('A checkbox EventTarget is required');
    }

    function handleChange(event) {
      if (options.requireTrusted && event.isTrusted !== true) return;
      const listingId = checkbox.dataset && checkbox.dataset.listingId;
      if (!listingId) return;
      store.setSelected(listingId, checkbox.checked === true);
      onChanged(store.get(listingId));
    }

    checkbox.addEventListener('change', handleChange);
    return function unbind() {
      checkbox.removeEventListener('change', handleChange);
    };
  }

  function normalizeSearchText(value) {
    return String(value || '').trim().toLocaleLowerCase();
  }

  function matchesListing(item, filter = {}) {
    const game = String(filter.game || 'ALL');
    if (game !== 'ALL' && item.game !== game) return false;

    const query = normalizeSearchText(filter.query);
    if (!query) return true;

    return [item.name, item.game, item.id, item.appid, item.price]
      .some((value) => normalizeSearchText(value).includes(query));
  }

  function getActionableListings(store, filter = {}) {
    return store.values().filter((item) => (
      item.selected &&
      ACTIONABLE_STATUSES.has(item.status) &&
      matchesListing(item, filter)
    ));
  }

  function reconcileVerification(store, verificationIds, scannedItems) {
    const ids = new Set(Array.from(verificationIds || [], (id) => String(id)));
    const remainingIds = new Set(Array.from(scannedItems || [], (item) => String(item.id)));
    const confirmed = [];
    const remaining = [];

    store.replace(scannedItems || []);

    for (const id of ids) {
      if (remainingIds.has(id) && store.has(id)) {
        remaining.push(id);
        store.setStatus(id, 'failed', '提交后仍在在售列表中');
        store.setSelected(id, true);
      } else {
        confirmed.push(id);
      }
    }

    return { confirmed, remaining };
  }

  function applyRemovalOutcome(store, verificationIds, itemOrId, outcome, message = '') {
    const id = String(itemOrId && itemOrId.id !== undefined ? itemOrId.id : itemOrId);
    if (!store.has(id)) return { updated: false, verificationRequired: false, failed: false };

    if (outcome === 'accepted') {
      verificationIds.add(id);
      store.setStatus(id, 'submitted');
      store.setSelected(id, false);
      return { updated: true, verificationRequired: true, failed: false };
    }

    if (outcome === 'ambiguous' || outcome === 'aborted') {
      verificationIds.add(id);
      store.setStatus(id, 'unknown', message);
      store.setSelected(id, false);
      return { updated: true, verificationRequired: true, failed: false };
    }

    if (outcome === 'failed') {
      store.setStatus(id, 'failed', message);
      store.setSelected(id, true);
      return { updated: true, verificationRequired: false, failed: true };
    }

    throw new TypeError('Unknown removal outcome: ' + outcome);
  }

  function clampDelay(value, minimum = 500, maximum = 5000, fallback = 800) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
  }

  function parseNonNegativeInteger(...values) {
    for (const value of values) {
      if (typeof value === 'number') {
        if (Number.isSafeInteger(value) && value >= 0) return value;
        continue;
      }

      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (!/^\d+$/.test(trimmed)) continue;
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed)) return parsed;
    }

    return null;
  }

  function parseRetryAfterMs(value, now = Date.now()) {
    if (value === null || value === undefined || String(value).trim() === '') return null;

    const raw = String(value).trim();
    const seconds = Number(raw);
    let milliseconds;

    if (Number.isFinite(seconds)) {
      milliseconds = seconds * 1000;
    } else {
      const timestamp = Date.parse(raw);
      if (!Number.isFinite(timestamp)) return null;
      milliseconds = timestamp - now;
    }

    if (!Number.isFinite(milliseconds)) return null;
    return Math.min(120000, Math.max(500, Math.ceil(milliseconds)));
  }

  function computeBackoffMs(attempt, options = {}) {
    const baseMs = Number.isFinite(options.baseMs) ? options.baseMs : 2000;
    const maxMs = Number.isFinite(options.maxMs) ? options.maxMs : 30000;
    const random = typeof options.random === 'function' ? options.random : Math.random;
    const jitterMs = Number.isFinite(options.jitterMs) ? options.jitterMs : 250;
    const exponential = baseMs * Math.pow(2, Math.max(0, attempt));
    return Math.min(maxMs, Math.round(exponential + (random() * jitterMs)));
  }

  function getSteamMarketUrl(pathOrUrl) {
    const url = new URL(pathOrUrl, STEAM_ORIGIN);

    if (url.origin !== STEAM_ORIGIN || !url.pathname.startsWith('/market/')) {
      throw new SbdError('Blocked non-Steam request target', {
        code: 'INVALID_TARGET',
        fatal: true
      });
    }

    return url.toString();
  }

  function parseMultiSellItemNames(input) {
    const source = Array.isArray(input)
      ? input
      : String(input === undefined || input === null ? '' : input).split(/\r?\n/u);
    const uniqueNames = [];
    const seen = new Set();

    for (const value of source) {
      const name = String(value === undefined || value === null ? '' : value).trim();
      if (!name || seen.has(name)) continue;

      if (name.length > MULTI_SELL_MAX_ITEM_LENGTH || /[\u0000-\u001f\u007f]/u.test(name)) {
        throw new SbdError('Invalid Steam market item name', {
          code: 'INVALID_MULTI_SELL_ITEM'
        });
      }

      try {
        encodeURIComponent(name);
      } catch (error) {
        throw new SbdError('Invalid Steam market item name', {
          code: 'INVALID_MULTI_SELL_ITEM'
        });
      }

      seen.add(name);
      uniqueNames.push(name);

      if (uniqueNames.length > MULTI_SELL_MAX_ITEMS) {
        throw new SbdError('Too many Steam market item names', {
          code: 'TOO_MANY_MULTI_SELL_ITEMS'
        });
      }
    }

    if (uniqueNames.length === 0) {
      throw new SbdError('At least one Steam market item name is required', {
        code: 'EMPTY_MULTI_SELL_ITEMS'
      });
    }

    return uniqueNames;
  }

  function parseSteamMarketListingTarget(value) {
    const raw = String(value === undefined || value === null ? '' : value).trim();
    const candidate = /^steamcommunity\.com\//iu.test(raw) ? 'https://' + raw : raw;
    let url;

    try {
      url = new URL(candidate);
    } catch (error) {
      throw new SbdError('Invalid Steam market listing URL', {
        code: 'INVALID_MARKET_LISTING_URL'
      });
    }

    if (
      url.protocol !== 'https:' ||
      url.origin !== STEAM_ORIGIN ||
      url.username ||
      url.password
    ) {
      throw new SbdError('Invalid Steam market listing target', {
        code: 'INVALID_MARKET_LISTING_TARGET'
      });
    }

    const parts = url.pathname.split('/');
    if (
      parts.length !== 5 ||
      parts[0] !== '' ||
      parts[1] !== 'market' ||
      parts[2] !== 'listings' ||
      !parts[3] ||
      !parts[4]
    ) {
      throw new SbdError('Invalid Steam market listing path', {
        code: 'INVALID_MARKET_LISTING_PATH'
      });
    }

    const appid = parts[3];
    if (!/^[1-9]\d{0,9}$/u.test(appid) || Number(appid) > 4294967295) {
      throw new SbdError('Invalid Steam AppID', {
        code: 'INVALID_MULTI_SELL_APPID'
      });
    }

    let marketHashName;
    try {
      marketHashName = decodeURIComponent(parts[4]);
    } catch (error) {
      throw new SbdError('Invalid Steam market listing path', {
        code: 'INVALID_MARKET_LISTING_PATH'
      });
    }

    marketHashName = parseMultiSellItemNames([marketHashName])[0];
    return { appid, slug: marketHashName };
  }

  function isSteamMarketBucketId(value) {
    const candidate = String(value === undefined || value === null ? '' : value).trim();
    // Steam currently exposes both group IDs (G...) and their bare 18... bucket IDs.
    if (/^G[0-9A-F]{8,}$/iu.test(candidate)) return true;
    if (!/^18[0-9A-F]{8,}$/iu.test(candidate)) return false;
    return /[A-F]/iu.test(candidate) || candidate.length >= 14;
  }

  function parseSteamMarketListingUrl(value) {
    const target = parseSteamMarketListingTarget(value);
    if (isSteamMarketBucketId(target.slug)) {
      throw new SbdError('Steam market listing uses an internal item group ID; resolve it from the listing page', {
        code: 'MARKET_LISTING_NAME_UNRESOLVED',
        ambiguous: true
      });
    }

    return { appid: target.appid, marketHashName: target.slug };
  }

  function normalizeSteamMarketPageSource(source) {
    if (Array.isArray(source)) {
      return source
        .map((value) => String(value === undefined || value === null ? '' : value))
        .join('\n');
    }
    return String(source === undefined || source === null ? '' : source);
  }

  function readJavaScriptStringLiteral(source, start) {
    const quote = source[start];
    if (quote !== '"' && quote !== "'") return null;

    let escaped = false;
    for (let index = start + 1; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === quote) return source.slice(start, index + 1);
    }
    return null;
  }

  function readJsonArrayLiteral(source, start) {
    if (source[start] !== '[') return null;

    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === quote) {
          quote = '';
        }
        continue;
      }

      if (character === '"') {
        quote = character;
      } else if (character === '[') {
        depth += 1;
      } else if (character === ']') {
        depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
      }
    }
    return null;
  }

  function getSteamSsrRenderContext(source) {
    const marker = 'window.SSR.renderContext';
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) return null;

    const parseIndex = source.indexOf('JSON.parse', markerIndex + marker.length);
    if (parseIndex < 0) return null;
    const openIndex = source.indexOf('(', parseIndex + 'JSON.parse'.length);
    if (openIndex < 0) return null;

    let literalIndex = openIndex + 1;
    while (/\s/u.test(source[literalIndex] || '')) literalIndex += 1;
    const literal = readJavaScriptStringLiteral(source, literalIndex);
    if (!literal || literal[0] !== '"') return null;

    try {
      return JSON.parse(JSON.parse(literal));
    } catch (error) {
      return null;
    }
  }

  function getSteamSsrLoaderData(source) {
    const marker = 'window.SSR.loaderData';
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) return [];

    const equalsIndex = source.indexOf('=', markerIndex + marker.length);
    if (equalsIndex < 0) return [];
    let arrayIndex = equalsIndex + 1;
    while (/\s/u.test(source[arrayIndex] || '')) arrayIndex += 1;
    const literal = readJsonArrayLiteral(source, arrayIndex);
    if (!literal) return [];

    try {
      const values = JSON.parse(literal);
      return Array.isArray(values) ? values : [];
    } catch (error) {
      return [];
    }
  }

  function collectSteamMarketHashNames(
    value,
    appid,
    bucketId,
    inheritedAppid = '',
    state = { nodes: 0 },
    results = new Set()
  ) {
    if (value === null || value === undefined || state.nodes >= 100000) return results;
    state.nodes += 1;

    if (Array.isArray(value)) {
      for (const child of value) {
        collectSteamMarketHashNames(child, appid, bucketId, inheritedAppid, state, results);
      }
      return results;
    }

    if (typeof value !== 'object') return results;
    const localAppid = value.appid === undefined || value.appid === null
      ? inheritedAppid
      : String(value.appid);
    if (
      (
        String(value.market_bucket_group_id || '') === bucketId ||
        String(value.market_bucket_id || '') === bucketId
      ) &&
      value.market_hash_name &&
      (!localAppid || localAppid === appid)
    ) {
      try {
        results.add(parseMultiSellItemNames([value.market_hash_name])[0]);
      } catch (error) {
        // Ignore malformed hydration entries and continue scanning siblings.
      }
    }

    for (const key of Object.keys(value)) {
      collectSteamMarketHashNames(value[key], appid, bucketId, localAppid, state, results);
    }
    return results;
  }

  function resolveSteamMarketHashNameFromPageSource(source, appid, bucketId) {
    const pageSource = normalizeSteamMarketPageSource(source);
    const expectedAppid = String(appid || '').trim();
    const expectedBucketId = String(bucketId || '').trim();
    if (!pageSource || !expectedAppid || !expectedBucketId) return '';

    const renderContext = getSteamSsrRenderContext(pageSource);
    let renderCandidates = [];
    if (renderContext) {
      let queryData = renderContext.queryData;
      if (typeof queryData === 'string') {
        try {
          queryData = JSON.parse(queryData);
        } catch (error) {
          queryData = null;
        }
      }
      renderCandidates = Array.from(
        collectSteamMarketHashNames(queryData, expectedAppid, expectedBucketId)
      );
    }

    // loaderData owns the page-level selected/fallback variant for grouped listings.
    let matchedLoaderData = false;
    for (const rawValue of getSteamSsrLoaderData(pageSource)) {
      let value = rawValue;
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch (error) {
          continue;
        }
      }
      if (!value || typeof value !== 'object' || String(value.appid || '') !== expectedAppid) continue;
      const query = value.listingQuery;
      if (!query || String(query.strItemName || '') !== expectedBucketId || !Array.isArray(value.buckets)) continue;
      matchedLoaderData = true;
      const bucketNames = new Set();
      for (const item of value.buckets) {
        if (!item || !item.bucket_id) continue;
        try {
          bucketNames.add(parseMultiSellItemNames([item.bucket_id])[0]);
        } catch (error) {
          // Ignore malformed buckets; selection remains fail-closed below.
        }
      }
      const selectedIds = [value.initialSelectedBucketID, value.initialFallbackBucketID]
        .map((item) => String(item || ''))
        .filter(Boolean);
      for (const selectedId of selectedIds) {
        if (!bucketNames.has(selectedId)) continue;
        if (renderCandidates.length > 0 && !renderCandidates.includes(selectedId)) continue;
        return selectedId;
      }

      if (bucketNames.size === 1) {
        const onlyBucket = bucketNames.values().next().value;
        if (renderCandidates.length === 0 || renderCandidates.includes(onlyBucket)) return onlyBucket;
      }
    }

    if (matchedLoaderData) return '';
    return renderCandidates.length === 1 ? renderCandidates[0] : '';
  }

  function resolveSteamMarketListingUrl(value, pageSource) {
    const target = parseSteamMarketListingTarget(value);
    if (!isSteamMarketBucketId(target.slug)) {
      return { appid: target.appid, marketHashName: target.slug };
    }

    const marketHashName = resolveSteamMarketHashNameFromPageSource(
      pageSource,
      target.appid,
      target.slug
    );
    if (!marketHashName) {
      throw new SbdError('Steam market item name could not be resolved from the listing page', {
        code: 'MARKET_LISTING_NAME_UNRESOLVED',
        ambiguous: true
      });
    }
    return { appid: target.appid, marketHashName };
  }

  function parseMultiSellEntries(input) {
    const source = Array.isArray(input)
      ? input
      : String(input === undefined || input === null ? '' : input).split(/\r?\n/u);
    const itemNames = [];
    let inferredAppid = '';
    let urlCount = 0;
    let plainNameCount = 0;

    for (const value of source) {
      const entry = String(value === undefined || value === null ? '' : value).trim();
      if (!entry) continue;

      const looksLikeUrl = /^[a-z][a-z\d+.-]*:\/\//iu.test(entry) || /^steamcommunity\.com\//iu.test(entry);
      if (!looksLikeUrl) {
        itemNames.push(entry);
        plainNameCount += 1;
        continue;
      }

      const listing = parseSteamMarketListingUrl(entry);
      if (inferredAppid && inferredAppid !== listing.appid) {
        throw new SbdError('Steam market links belong to different games', {
          code: 'MIXED_MULTI_SELL_APPIDS'
        });
      }

      inferredAppid = listing.appid;
      urlCount += 1;
      itemNames.push(listing.marketHashName);
    }

    return {
      appid: inferredAppid,
      itemNames: parseMultiSellItemNames(itemNames),
      urlCount,
      plainNameCount
    };
  }

  function resolveMultiSellSelection(options = {}) {
    const selectedAppid = String(options.selectedAppid === undefined ? '' : options.selectedAppid).trim();
    const selectedContextid = String(options.selectedContextid === undefined ? '2' : options.selectedContextid).trim();
    const inferredAppid = String(options.inferredAppid === undefined ? '' : options.inferredAppid).trim();
    const plainNameCount = Number.isSafeInteger(options.plainNameCount)
      ? Math.max(0, options.plainNameCount)
      : 0;

    if (!inferredAppid) {
      return {
        appid: selectedAppid,
        contextid: selectedContextid,
        preset: MULTI_SELL_GAME_PRESETS.find((item) => (
          item.appid === selectedAppid && item.contextid === selectedContextid
        )) || null
      };
    }

    if (!/^[1-9]\d{0,9}$/u.test(inferredAppid) || Number(inferredAppid) > 4294967295) {
      throw new SbdError('Invalid Steam AppID', {
        code: 'INVALID_MULTI_SELL_APPID'
      });
    }

    if (selectedAppid && selectedAppid !== inferredAppid && plainNameCount > 0) {
      throw new SbdError('Plain item names cannot be assigned to another game automatically', {
        code: 'AMBIGUOUS_MULTI_SELL_APPID'
      });
    }

    const preset = MULTI_SELL_GAME_PRESETS.find((item) => item.appid === inferredAppid) || null;
    return {
      appid: inferredAppid,
      contextid: preset
        ? preset.contextid
        : (selectedAppid === inferredAppid ? selectedContextid : '2'),
      preset
    };
  }

  function buildMultiSellUrl(options = {}) {
    const appid = String(options.appid === undefined ? '' : options.appid).trim();
    const contextid = String(options.contextid === undefined ? '2' : options.contextid).trim();

    if (!/^[1-9]\d{0,9}$/u.test(appid) || Number(appid) > 4294967295) {
      throw new SbdError('Invalid Steam AppID', {
        code: 'INVALID_MULTI_SELL_APPID'
      });
    }

    if (
      !/^[1-9]\d{0,19}$/u.test(contextid) ||
      BigInt(contextid) > 18446744073709551615n
    ) {
      throw new SbdError('Invalid Steam inventory context ID', {
        code: 'INVALID_MULTI_SELL_CONTEXTID'
      });
    }

    const itemNames = parseMultiSellItemNames(
      options.itemNames === undefined ? options.items : options.itemNames
    );
    const url = new URL('/market/multisell', STEAM_ORIGIN);
    url.searchParams.set('appid', appid);
    url.searchParams.set('contextid', contextid);

    for (const itemName of itemNames) {
      url.searchParams.append('items[]', itemName);
    }

    if (url.origin !== STEAM_ORIGIN || url.pathname !== '/market/multisell') {
      throw new SbdError('Blocked non-Steam multisell target', {
        code: 'INVALID_TARGET',
        fatal: true
      });
    }

    const result = url.toString();
    if (result.length > MULTI_SELL_MAX_URL_LENGTH) {
      throw new SbdError('Steam multisell URL is too long', {
        code: 'MULTI_SELL_URL_TOO_LONG'
      });
    }

    return result;
  }

  function successValue(value) {
    return value === true || value === 1 || value === '1';
  }

  function compactMessage(value, fallback) {
    const text = String(value || fallback || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 180);
  }

  async function requestListingRemoval(options) {
    const listingId = String(options.listingId || '');
    const sessionid = String(options.sessionid || '');
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const signal = options.signal;

    if (!/^\d+$/.test(listingId)) {
      throw new SbdError('Invalid listing id', { code: 'INVALID_LISTING', fatal: true });
    }
    if (!sessionid) {
      throw new SbdError('Missing Steam sessionid', { code: 'MISSING_SESSION', fatal: true });
    }

    throwIfAborted(signal);

    const url = getSteamMarketUrl('/market/removelisting/' + listingId);
    const formData = new URLSearchParams();
    const requestScope = createAbortScope(signal, Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000);
    formData.set('sessionid', sessionid);

    try {
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest'
          },
          body: formData.toString(),
          credentials: 'same-origin',
          redirect: 'manual',
          signal: requestScope.signal
        });
      } catch (error) {
        if (requestScope.didTimeout()) {
          throw new SbdError('Removal request timed out', {
            code: 'REQUEST_TIMEOUT',
            ambiguous: true,
            fatal: true
          });
        }
        if (isAbortError(error) || (signal && signal.aborted)) throw createAbortError();
        throw new SbdError('Network error while removing listing', {
          code: 'NETWORK_ERROR',
          retryable: false,
          ambiguous: true,
          fatal: true
        });
      }

      if (response.redirected || response.type === 'opaqueredirect' || response.status === 0) {
        throw new SbdError('Steam redirected the request; sign in again', {
          code: 'AUTH_REDIRECT',
          fatal: true,
          ambiguous: true
        });
      }

      if (response.url) {
        try {
          getSteamMarketUrl(response.url);
        } catch (error) {
          throw new SbdError('Unexpected response origin', {
            code: 'INVALID_RESPONSE_ORIGIN',
            fatal: true,
            ambiguous: true
          });
        }
      }

      if (!response.ok) {
        const status = response.status;
        throw new SbdError('Steam returned HTTP ' + status, {
          code: status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR',
          status,
          retryable: status === 425 || status === 429,
          retryAfterMs: parseRetryAfterMs(response.headers.get('Retry-After')),
          fatal: status === 401 || status === 403 || status === 408 || status >= 500,
          ambiguous: status === 408 || status >= 500
        });
      }

      let text;
      try {
        text = (await response.text()).trim();
      } catch (error) {
        if (requestScope.didTimeout()) {
          throw new SbdError('Removal response timed out', {
            code: 'REQUEST_TIMEOUT',
            ambiguous: true,
            fatal: true
          });
        }
        if (isAbortError(error) || (signal && signal.aborted)) throw createAbortError();
        throw new SbdError('Steam response body could not be read', {
          code: 'RESPONSE_READ_ERROR',
          ambiguous: true,
          fatal: true
        });
      }
      if (!text) return { accepted: true, confirmed: false };

      const contentType = response.headers.get('Content-Type') || '';
      const looksJson = contentType.includes('json') || text.startsWith('{') || text.startsWith('[');
      if (!looksJson) {
        throw new SbdError('Unexpected non-JSON response from Steam', {
          code: 'PROTOCOL_ERROR',
          fatal: true,
          ambiguous: true
        });
      }

      let payload;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new SbdError('Steam returned invalid JSON', {
          code: 'PROTOCOL_ERROR',
          fatal: true,
          ambiguous: true
        });
      }

      if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'success')) {
        if (!successValue(payload.success)) {
          throw new SbdError(compactMessage(payload.message || payload.error, 'Steam rejected the request'), {
            code: 'BUSINESS_FAILURE'
          });
        }
        return { accepted: true, confirmed: true, payload };
      }

      if (payload && typeof payload === 'object' && (payload.error || payload.message)) {
        throw new SbdError(compactMessage(payload.error || payload.message, 'Steam rejected the request'), {
          code: 'BUSINESS_FAILURE'
        });
      }

      if (payload && typeof payload === 'object' && Object.keys(payload).length === 0) {
        return { accepted: true, confirmed: false, payload };
      }

      throw new SbdError('Unexpected response payload from Steam', {
        code: 'PROTOCOL_ERROR',
        fatal: true,
        ambiguous: true
      });
    } finally {
      requestScope.dispose();
    }
  }

  async function requestRemovalWithRetry(options) {
    const maxAttempts = Number.isFinite(options.maxAttempts) ? options.maxAttempts : 4;
    const sleepImpl = options.sleepImpl || abortableSleep;
    const beforeAttempt = options.beforeAttempt || (async function () {});
    const onRetry = options.onRetry || function () {};

    let hadAmbiguousAttempt = false;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      throwIfAborted(options.signal);
      await beforeAttempt(options.signal);
      throwIfAborted(options.signal);

      try {
        return await requestListingRemoval(options);
      } catch (error) {
        if (isAbortError(error) || (options.signal && options.signal.aborted)) throw createAbortError();
        if (error.ambiguous) hadAmbiguousAttempt = true;
        if (!error.retryable || attempt >= maxAttempts - 1) {
          if (hadAmbiguousAttempt) error.ambiguous = true;
          if (error.retryable && attempt >= maxAttempts - 1) error.fatal = true;
          throw error;
        }

        const delayMs = error.retryAfterMs !== null
          ? error.retryAfterMs
          : computeBackoffMs(attempt, options.backoff);

        onRetry({ attempt: attempt + 1, delayMs, error });
        await sleepImpl(delayMs, options.signal);
      }
    }

    throw new SbdError('Removal attempts exhausted', { code: 'RETRY_EXHAUSTED' });
  }

  async function scanAllListings(options) {
    const pageSize = Number.isFinite(options.pageSize) ? options.pageSize : 100;
    const maxPages = Number.isFinite(options.maxPages) ? options.maxPages : 200;
    const sleepImpl = options.sleepImpl || abortableSleep;
    const pageDelayMs = Number.isFinite(options.pageDelayMs) ? options.pageDelayMs : 250;
    const onProgress = options.onProgress || function () {};
    const requireTotalCount = options.requireTotalCount !== false;
    const listings = new Map();
    let totalCount = Number.POSITIVE_INFINITY;
    let start = 0;

    let pagesRead = 0;

    for (let page = 0; page < maxPages && start < totalCount; page += 1) {
      throwIfAborted(options.signal);
      const result = await options.fetchPage(start, pageSize, options.signal);
      pagesRead += 1;
      const batch = Array.isArray(result.items) ? result.items : [];
      const beforeSize = listings.size;

      for (const item of batch) {
        const normalized = normalizeListing(item);
        listings.set(normalized.id, normalized);
      }

      const hasValidTotal = Number.isSafeInteger(result.totalCount) && result.totalCount >= 0;
      if (hasValidTotal) {
        totalCount = Number.isFinite(totalCount)
          ? Math.max(totalCount, result.totalCount)
          : result.totalCount;
      } else if (requireTotalCount) {
        throw new SbdError('Steam listing response did not include a valid total count', {
          code: 'PROTOCOL_ERROR',
          fatal: true
        });
      }

      onProgress({ loaded: listings.size, total: totalCount, page, start });

      if (batch.length === 0 || listings.size === beforeSize) {
        if (Number.isFinite(totalCount) && listings.size !== totalCount) {
          throw new SbdError('Steam pagination ended before all listings were loaded', {
            code: 'INCOMPLETE_SCAN'
          });
        }
        break;
      }

      if (!requireTotalCount && !Number.isFinite(totalCount) && batch.length < pageSize) {
        totalCount = listings.size;
        break;
      }

      start += pageSize;
      if (start < totalCount && pageDelayMs > 0) {
        await sleepImpl(pageDelayMs, options.signal);
      }
    }

    if (pagesRead >= maxPages && start < totalCount) {
      throw new SbdError('Steam listing scan exceeded the page safety limit', {
        code: 'SCAN_LIMIT_EXCEEDED'
      });
    }

    if (!Number.isFinite(totalCount)) {
      if (requireTotalCount) {
        throw new SbdError('Steam listing response did not include a total count', {
          code: 'PROTOCOL_ERROR',
          fatal: true
        });
      }
      totalCount = listings.size;
    }
    if (listings.size !== totalCount) {
      throw new SbdError('Steam listing scan was incomplete', {
        code: 'INCOMPLETE_SCAN'
      });
    }
    return { items: Array.from(listings.values()), totalCount };
  }

  async function runRemovalQueue(options) {
    const items = Array.from(options.items || []);
    const results = [];
    const sleepImpl = options.sleepImpl || abortableSleep;
    const waitUntilResumed = options.waitUntilResumed || (async function () {});
    const delayMs = Math.max(0, Number(options.delayMs) || 0);
    let attempted = 0;

    try {
      for (let index = 0; index < items.length; index += 1) {
        throwIfAborted(options.signal);
        await waitUntilResumed(options.signal);
        throwIfAborted(options.signal);

        const item = items[index];
        attempted = index + 1;
        if (options.onItemStart) options.onItemStart(item, index, items.length);

        try {
          const value = await options.executeItem(item, options.signal);
          results.push({ item, status: 'accepted', value });
          if (options.onItemComplete) options.onItemComplete(item, value, index, items.length);
        } catch (error) {
          if (isAbortError(error) || (options.signal && options.signal.aborted)) {
            if (options.onItemUnknown) options.onItemUnknown(item, error, index, items.length);
            throw createAbortError();
          }

          results.push({ item, status: 'failed', error });
          if (options.onItemError) options.onItemError(item, error, index, items.length);
          if (error.fatal) throw error;
        }

        if (index < items.length - 1 && delayMs > 0) {
          await sleepImpl(delayMs, options.signal);
        }
      }
    } catch (error) {
      if (error && typeof error === 'object') {
        error.queueReport = {
          total: items.length,
          attempted,
          skipped: Math.max(0, items.length - attempted),
          results: results.slice()
        };
      }
      throw error;
    }

    return {
      total: items.length,
      attempted,
      skipped: Math.max(0, items.length - attempted),
      results
    };
  }

  return {
    ACTIONABLE_STATUSES,
    MULTI_SELL_GAME_PRESETS,
    MULTI_SELL_MAX_ITEMS,
    ListingStore,
    SbdError,
    abortableSleep,
    applyRemovalOutcome,
    bindListingCheckbox,
    buildMultiSellUrl,
    clampDelay,
    computeBackoffMs,
    createAbortScope,
    createAbortError,
    getActionableListings,
    getSteamMarketUrl,
    isAbortError,
    matchesListing,
    normalizeListing,
    parseMultiSellEntries,
    parseMultiSellItemNames,
    parseNonNegativeInteger,
    parseRetryAfterMs,
    reconcileVerification,
    requestListingRemoval,
    requestRemovalWithRetry,
    resolveMultiSellSelection,
    resolveSteamMarketHashNameFromPageSource,
    resolveSteamMarketListingUrl,
    resolveListingId,
    isSteamMarketBucketId,
    parseSteamMarketListingUrl,
    parseSteamMarketListingTarget,
    runRemovalQueue,
    scanAllListings,
    throwIfAborted
  };
});
