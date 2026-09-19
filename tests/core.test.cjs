'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');

globalThis.fetch = async function unexpectedNetwork() {
  throw new Error('UNEXPECTED_REAL_NETWORK');
};

function listing(id, overrides = {}) {
  return {
    id: String(id),
    name: 'Item ' + id,
    game: 'Counter-Strike 2',
    appid: '730',
    price: '¥1.00',
    ...overrides
  };
}

function steamRenderContextSource(queryData) {
  const context = {
    queryData: JSON.stringify(queryData)
  };
  return 'window.SSR.renderContext=JSON.parse(' + JSON.stringify(JSON.stringify(context)) + ');';
}

function steamLoaderDataSource(value) {
  return 'window.SSR.loaderData = ' + JSON.stringify([JSON.stringify(value)]) + ';window.SSR.clientAssets={};';
}

function jsonResponse(payload, options = {}) {
  return new Response(JSON.stringify(payload), {
    status: options.status || 200,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
}

test('new listings are unselected by default', () => {
  const store = new Core.ListingStore([listing(1), listing(2)]);

  assert.equal(store.size, 2);
  assert.deepEqual(store.values().map((item) => item.selected), [false, false]);
  assert.deepEqual(Core.getActionableListings(store), []);
});

test('checkbox change updates the canonical store and action targets', () => {
  class FakeCheckbox extends EventTarget {
    constructor(id) {
      super();
      this.dataset = { listingId: String(id) };
      this.checked = false;
    }
  }

  const store = new Core.ListingStore([listing(10)]);
  const checkbox = new FakeCheckbox(10);
  let changed = 0;
  Core.bindListingCheckbox(checkbox, store, () => { changed += 1; });

  checkbox.checked = true;
  checkbox.dispatchEvent(new Event('change'));
  assert.equal(store.get('10').selected, true);
  assert.equal(Core.getActionableListings(store).length, 1);

  checkbox.checked = false;
  checkbox.dispatchEvent(new Event('change'));
  assert.equal(store.get('10').selected, false);
  assert.equal(Core.getActionableListings(store).length, 0);
  assert.equal(changed, 2);
});

test('trusted-only checkbox binding ignores synthetic page events', () => {
  class FakeCheckbox extends EventTarget {
    constructor() {
      super();
      this.dataset = { listingId: '10' };
      this.checked = true;
    }
  }

  const store = new Core.ListingStore([listing(10)]);
  const checkbox = new FakeCheckbox();
  Core.bindListingCheckbox(checkbox, store, () => {}, { requireTrusted: true });
  checkbox.dispatchEvent(new Event('change'));

  assert.equal(store.get('10').selected, false);
});

test('filtering and execution share one predicate', () => {
  const store = new Core.ListingStore([
    listing(1, { name: 'AK-47 Redline', game: 'Counter-Strike 2', appid: '730' }),
    listing(2, { name: 'Dragonclaw Hook', game: 'Dota 2', appid: '570' }),
    listing(3, { name: 'Portal Card', game: 'Steam', appid: '753' })
  ]);
  store.selectWhere(() => true, true);

  const cases = [
    [{ query: 'ak-47', game: 'ALL' }, ['1']],
    [{ query: 'DOTA', game: 'ALL' }, ['2']],
    [{ query: '570', game: 'ALL' }, ['2']],
    [{ query: 'card', game: 'Steam' }, ['3']],
    [{ query: '', game: 'Counter-Strike 2' }, ['1']]
  ];

  for (const [filter, expectedIds] of cases) {
    const visible = store.values().filter((item) => Core.matchesListing(item, filter));
    const targets = Core.getActionableListings(store, filter);
    assert.equal(targets.length, visible.length);
    assert.deepEqual(targets.map((item) => item.id), expectedIds);
  }
});

test('count parsing ignores null, booleans and blank strings before using a fallback', () => {
  assert.equal(Core.parseNonNegativeInteger(null, 250), 250);
  assert.equal(Core.parseNonNegativeInteger(false, '42'), 42);
  assert.equal(Core.parseNonNegativeInteger('   ', '7'), 7);
  assert.equal(Core.parseNonNegativeInteger('0012'), 12);
  assert.equal(Core.parseNonNegativeInteger('-1', '1.5', Number.MAX_SAFE_INTEGER + 1), null);
});

test('multisell item names are trimmed, deduplicated and kept in order', () => {
  assert.deepEqual(
    Core.parseMultiSellItemNames('  Recoil Case \r\n\nDragonclaw Hook\r\nRecoil Case  \nrecoil case'),
    ['Recoil Case', 'Dragonclaw Hook', 'recoil case']
  );
});

test('multisell game presets expose common inventory contexts', () => {
  assert.deepEqual(
    Core.MULTI_SELL_GAME_PRESETS.map(({ appid, contextid }) => [appid, contextid]),
    [
      ['730', '2'],
      ['570', '2'],
      ['440', '2'],
      ['252490', '2'],
      ['578080', '2'],
      ['753', '6']
    ]
  );
});

test('Steam listing URLs expose the exact AppID and market hash name', () => {
  const cases = [
    ['https://steamcommunity.com/market/listings/730/Recoil%20Case', '730', 'Recoil Case'],
    ['steamcommunity.com/market/listings/570/%E9%BE%99%E7%88%AA', '570', '龙爪'],
    ['https://steamcommunity.com/market/listings/730/A+B', '730', 'A+B'],
    ['https://steamcommunity.com/market/listings/730/A%2BB', '730', 'A+B'],
    ['https://steamcommunity.com/market/listings/730/A%2FB', '730', 'A/B'],
    ['https://steamcommunity.com/market/listings/730/%252F', '730', '%2F'],
    ['https://steamcommunity.com/market/listings/730/Item?appid=570&contextid=6#ignored', '730', 'Item']
  ];

  for (const [value, appid, marketHashName] of cases) {
    assert.deepEqual(Core.parseSteamMarketListingUrl(value), { appid, marketHashName });
  }
});

test('modern Steam bucket URLs resolve the canonical market hash from renderContext', () => {
  const source = steamRenderContextSource({
    queries: [{
      state: {
        data: {
          appid: 730,
          name: '千瓦武器箱',
          market_hash_name: 'Kilowatt Case',
          market_bucket_group_id: 'G18A8263004'
        }
      }
    }]
  });

  assert.deepEqual(
    Core.resolveSteamMarketListingUrl(
      'https://steamcommunity.com/market/listings/730/G18A8263004',
      [source]
    ),
    { appid: '730', marketHashName: 'Kilowatt Case' }
  );
  assert.equal(Core.isSteamMarketBucketId('G18A8263004'), true);
  assert.equal(Core.isSteamMarketBucketId('Kilowatt Case'), false);
});

test('modern Steam bucket URLs fall back to loaderData bucket names', () => {
  const source = steamLoaderDataSource({
    success: true,
    appid: 730,
    buckets: [
      { bucket_id: 'Wrong Item', localized_name: '错误商品' },
      { bucket_id: 'Kilowatt Case', localized_name: '千瓦武器箱' }
    ],
    initialSelectedBucketID: 'Kilowatt Case',
    initialFallbackBucketID: 'Wrong Item',
    listingQuery: { appid: 730, strItemName: 'G18A8263004' }
  });

  assert.deepEqual(
    Core.resolveSteamMarketListingUrl(
      'steamcommunity.com/market/listings/730/G18A8263004',
      source
    ),
    { appid: '730', marketHashName: 'Kilowatt Case' }
  );
});

test('bare Steam bucket IDs resolve through market_bucket_id without matching ordinary hex names', () => {
  const source = steamRenderContextSource({
    queries: [{
      state: {
        data: {
          appid: 730,
          market_hash_name: 'Kilowatt Case',
          market_bucket_group_id: 'G18A8263004',
          market_bucket_id: '18A8263004'
        }
      }
    }]
  });

  assert.deepEqual(
    Core.resolveSteamMarketListingUrl(
      'https://steamcommunity.com/market/listings/730/18A8263004',
      source
    ),
    { appid: '730', marketHashName: 'Kilowatt Case' }
  );
  assert.equal(Core.isSteamMarketBucketId('18A8263004'), true);
  assert.equal(Core.isSteamMarketBucketId('18022091093004'), true);
  assert.equal(Core.isSteamMarketBucketId('DEADBEEF'), false);
  assert.equal(Core.isSteamMarketBucketId('1800123456'), false);
});

test('grouped listings use loaderData fallback instead of the first hydrated variant', () => {
  const renderSource = steamRenderContextSource({
    queries: [
      { state: { data: { appid: 730, market_hash_name: 'MAC-10 | Light Box (Well-Worn)', market_bucket_group_id: 'G1811208C093004' } } },
      { state: { data: { appid: 730, market_hash_name: 'MAC-10 | Light Box (Factory New)', market_bucket_group_id: 'G1811208C093004' } } }
    ]
  });
  const loaderSource = steamLoaderDataSource({
    success: true,
    appid: 730,
    buckets: [
      { bucket_id: 'MAC-10 | Light Box (Well-Worn)' },
      { bucket_id: 'MAC-10 | Light Box (Factory New)' }
    ],
    initialSelectedBucketID: null,
    initialFallbackBucketID: 'MAC-10 | Light Box (Factory New)',
    listingQuery: { appid: 730, strItemName: 'G1811208C093004' }
  });

  assert.deepEqual(
    Core.resolveSteamMarketListingUrl(
      'https://steamcommunity.com/market/listings/730/G1811208C093004',
      [renderSource, loaderSource]
    ),
    { appid: '730', marketHashName: 'MAC-10 | Light Box (Factory New)' }
  );
});

test('grouped listings without a selected or fallback variant fail closed', () => {
  const renderSource = steamRenderContextSource({
    queries: [
      { state: { data: { appid: 730, market_hash_name: 'Item (One)', market_bucket_group_id: 'G18ABCDEF01' } } },
      { state: { data: { appid: 730, market_hash_name: 'Item (Two)', market_bucket_group_id: 'G18ABCDEF01' } } }
    ]
  });
  const loaderSource = steamLoaderDataSource({
    success: true,
    appid: 730,
    buckets: [{ bucket_id: 'Item (One)' }, { bucket_id: 'Item (Two)' }],
    initialSelectedBucketID: null,
    initialFallbackBucketID: null,
    listingQuery: { appid: 730, strItemName: 'G18ABCDEF01' }
  });

  assert.throws(
    () => Core.resolveSteamMarketListingUrl(
      'https://steamcommunity.com/market/listings/730/G18ABCDEF01',
      [renderSource, loaderSource]
    ),
    (error) => error.code === 'MARKET_LISTING_NAME_UNRESOLVED'
  );
});

test('bucket URLs never silently become item names when canonical data is absent', () => {
  assert.throws(
    () => Core.parseSteamMarketListingUrl('https://steamcommunity.com/market/listings/730/G18A8263004'),
    (error) => error.code === 'MARKET_LISTING_NAME_UNRESOLVED'
  );
  assert.throws(
    () => Core.resolveSteamMarketListingUrl(
      'https://steamcommunity.com/market/listings/730/G18A8263004',
      steamRenderContextSource({
        queries: [{ state: { data: { appid: 570, market_hash_name: 'Wrong Game', market_bucket_group_id: 'G18A8263004' } } }]
      })
    ),
    (error) => error.code === 'MARKET_LISTING_NAME_UNRESOLVED'
  );
  assert.deepEqual(
    Core.resolveSteamMarketListingUrl(
      'https://steamcommunity.com/market/listings/730/Recoil%20Case'
    ),
    { appid: '730', marketHashName: 'Recoil Case' }
  );
});

test('Steam listing URL parsing rejects unsafe or ambiguous targets', () => {
  const invalid = [
    'http://steamcommunity.com/market/listings/730/Item',
    'https://steamcommunity.com.evil.test/market/listings/730/Item',
    'https://steamcommunity.com@evil.test/market/listings/730/Item',
    'https://user:pass@steamcommunity.com/market/listings/730/Item',
    'https://steamcommunity.com:444/market/listings/730/Item',
    'https://steamcommunity.com/market/listings/730/A/B',
    'https://steamcommunity.com/market/listings/730/',
    'https://steamcommunity.com/market/listings/0730/Item',
    'https://steamcommunity.com/market/listings/4294967296/Item',
    'https://steamcommunity.com/market/listings/730/%ZZ',
    'https://steamcommunity.com/market/listings/730/A%00B'
  ];

  for (const value of invalid) {
    assert.throws(
      () => Core.parseSteamMarketListingUrl(value),
      (error) => /^INVALID_(?:MARKET_LISTING|MULTI_SELL)/u.test(error.code)
    );
  }
});

test('multisell entries accept links and names but reject mixed games', () => {
  const parsed = Core.parseMultiSellEntries([
    'https://steamcommunity.com/market/listings/570/Dragonclaw%20Hook',
    'Treasure of the Crimson Witness',
    'https://steamcommunity.com/market/listings/570/Dragonclaw%20Hook'
  ]);

  assert.deepEqual(parsed, {
    appid: '570',
    itemNames: ['Dragonclaw Hook', 'Treasure of the Crimson Witness'],
    urlCount: 2,
    plainNameCount: 1
  });
  assert.deepEqual(Core.parseMultiSellEntries('Recoil Case\nFracture Case'), {
    appid: '',
    itemNames: ['Recoil Case', 'Fracture Case'],
    urlCount: 0,
    plainNameCount: 2
  });
  assert.throws(
    () => Core.parseMultiSellEntries([
      'https://steamcommunity.com/market/listings/730/Recoil%20Case',
      'https://steamcommunity.com/market/listings/570/Dragonclaw%20Hook'
    ]),
    (error) => error.code === 'MIXED_MULTI_SELL_APPIDS'
  );
  assert.throws(
    () => Core.parseMultiSellEntries('https://example.com/market/listings/730/Item'),
    (error) => error.code === 'INVALID_MARKET_LISTING_TARGET'
  );
});

test('multisell selection inference resets presets and blocks ambiguous names', () => {
  const repairedPreset = Core.resolveMultiSellSelection({
    selectedAppid: '730',
    selectedContextid: '6',
    inferredAppid: '730',
    plainNameCount: 0
  });
  assert.equal(repairedPreset.appid, '730');
  assert.equal(repairedPreset.contextid, '2');
  assert.equal(repairedPreset.preset.key, '730:2');

  assert.throws(
    () => Core.resolveMultiSellSelection({
      selectedAppid: '730',
      selectedContextid: '2',
      inferredAppid: '570',
      plainNameCount: 1
    }),
    (error) => error.code === 'AMBIGUOUS_MULTI_SELL_APPID'
  );

  const switchedPreset = Core.resolveMultiSellSelection({
    selectedAppid: '730',
    selectedContextid: '2',
    inferredAppid: '570',
    plainNameCount: 0
  });
  assert.equal(switchedPreset.appid, '570');
  assert.equal(switchedPreset.contextid, '2');
  assert.equal(switchedPreset.preset.key, '570:2');

  const unknownSameGame = Core.resolveMultiSellSelection({
    selectedAppid: '12345',
    selectedContextid: '7',
    inferredAppid: '12345',
    plainNameCount: 0
  });
  assert.deepEqual(unknownSameGame, { appid: '12345', contextid: '7', preset: null });
});

test('multisell URL uses the official endpoint and repeated items parameters', () => {
  const itemNames = [
    'Recoil Case',
    '龙爪弯刀 & 100% + #1',
    'x&appid=570&contextid=6#fragment',
    '//evil.example/collect?token=value'
  ];
  const result = Core.buildMultiSellUrl({
    appid: '730',
    contextid: '2',
    itemNames
  });
  const url = new URL(result);

  assert.equal(url.origin, 'https://steamcommunity.com');
  assert.equal(url.pathname, '/market/multisell');
  assert.equal(url.searchParams.get('appid'), '730');
  assert.equal(url.searchParams.get('contextid'), '2');
  assert.deepEqual(url.searchParams.getAll('items[]'), itemNames);
  assert.equal(url.searchParams.getAll('appid').length, 1);
  assert.equal(url.hash, '');
});

test('multisell identifiers accept only canonical positive decimal values', () => {
  assert.doesNotThrow(() => Core.buildMultiSellUrl({
    appid: '4294967295',
    contextid: '18446744073709551615',
    itemNames: ['Item']
  }));

  for (const appid of ['', '0', '00', '-1', '+730', '0730', '1e3', '1.5', '730&contextid=6', '4294967296']) {
    assert.throws(
      () => Core.buildMultiSellUrl({ appid, contextid: '2', itemNames: ['Item'] }),
      (error) => error.code === 'INVALID_MULTI_SELL_APPID'
    );
  }

  for (const contextid of ['', '0', '02', '-2', '+2', '2.0', '2&appid=570', '18446744073709551616', '123456789012345678901']) {
    assert.throws(
      () => Core.buildMultiSellUrl({ appid: '730', contextid, itemNames: ['Item'] }),
      (error) => error.code === 'INVALID_MULTI_SELL_CONTEXTID'
    );
  }
});

test('multisell item and URL limits fail closed', () => {
  assert.throws(
    () => Core.parseMultiSellItemNames(' \r\n '),
    (error) => error.code === 'EMPTY_MULTI_SELL_ITEMS'
  );
  assert.throws(
    () => Core.parseMultiSellItemNames(['valid', 'bad\u0000name']),
    (error) => error.code === 'INVALID_MULTI_SELL_ITEM'
  );
  assert.throws(
    () => Core.parseMultiSellItemNames(['x'.repeat(513)]),
    (error) => error.code === 'INVALID_MULTI_SELL_ITEM'
  );
  assert.throws(
    () => Core.parseMultiSellItemNames(['\ud800']),
    (error) => error.code === 'INVALID_MULTI_SELL_ITEM'
  );
  assert.throws(
    () => Core.parseMultiSellItemNames(Array.from({ length: 101 }, (_, index) => 'Item ' + index)),
    (error) => error.code === 'TOO_MANY_MULTI_SELL_ITEMS'
  );
  assert.throws(
    () => Core.buildMultiSellUrl({
      appid: '730',
      contextid: '2',
      itemNames: Array.from({ length: 20 }, (_, index) => String(index).padStart(3, '0') + 'x'.repeat(509))
    }),
    (error) => error.code === 'MULTI_SELL_URL_TOO_LONG'
  );
});

test('HTTP 200 with success false is a business failure', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ success: false, message: 'denied' });
  };

  await assert.rejects(
    Core.requestRemovalWithRetry({ listingId: '123', sessionid: 'session', fetchImpl }),
    (error) => error.code === 'BUSINESS_FAILURE' && error.retryable === false
  );
  assert.equal(calls, 1);
});

test('removal request is same-origin and accepts success or empty responses', async () => {
  const requests = [];
  const responses = [
    jsonResponse({ success: 1 }),
    new Response('', { status: 200 })
  ];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return responses.shift();
  };

  const confirmed = await Core.requestListingRemoval({
    listingId: '123',
    sessionid: 'abc123',
    fetchImpl
  });
  const unverified = await Core.requestListingRemoval({
    listingId: '456',
    sessionid: 'abc123',
    fetchImpl
  });

  assert.equal(confirmed.confirmed, true);
  assert.equal(unverified.confirmed, false);
  assert.equal(new URL(requests[0].url).origin, 'https://steamcommunity.com');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.credentials, 'same-origin');
  assert.equal(requests[0].init.redirect, 'manual');
  assert.match(requests[0].init.body, /sessionid=abc123/);
});

test('Retry-After seconds is respected before retry', async () => {
  let calls = 0;
  const delays = [];
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('', { status: 429, headers: { 'Retry-After': '3' } });
    }
    return jsonResponse({ success: true });
  };

  await Core.requestRemovalWithRetry({
    listingId: '123',
    sessionid: 'session',
    fetchImpl,
    sleepImpl: async (ms) => { delays.push(ms); }
  });

  assert.equal(calls, 2);
  assert.deepEqual(delays, [3000]);
});

test('missing Retry-After uses exponential backoff without retrying business failures', async () => {
  let calls = 0;
  const delays = [];
  const fetchImpl = async () => {
    calls += 1;
    if (calls <= 2) return new Response('', { status: 429 });
    return jsonResponse({ success: true });
  };

  await Core.requestRemovalWithRetry({
    listingId: '123',
    sessionid: 'session',
    fetchImpl,
    sleepImpl: async (ms) => { delays.push(ms); },
    backoff: { baseMs: 1000, jitterMs: 0, random: () => 0 }
  });

  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000]);
});

test('ambiguous POST failures are not replayed automatically', async () => {
  for (const fetchImpl of [
    async () => { throw new TypeError('socket reset'); },
    async () => new Response('', { status: 500 })
  ]) {
    let calls = 0;
    await assert.rejects(
      Core.requestRemovalWithRetry({
        listingId: '123',
        sessionid: 'session',
        fetchImpl: async (...args) => {
          calls += 1;
          return fetchImpl(...args);
        }
      }),
      (error) => error.ambiguous === true && error.retryable === false
    );
    assert.equal(calls, 1);
  }
});

test('response body read failures are ambiguous', async () => {
  const response = {
    ok: true,
    status: 200,
    redirected: false,
    type: 'basic',
    url: 'https://steamcommunity.com/market/removelisting/123',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    async text() {
      throw new TypeError('body stream reset');
    }
  };

  await assert.rejects(
    Core.requestListingRemoval({
      listingId: '123',
      sessionid: 'session',
      fetchImpl: async () => response
    }),
    (error) => error.code === 'RESPONSE_READ_ERROR' && error.ambiguous === true
  );
});

test('a removal request timeout is ambiguous and aborts the underlying fetch', async () => {
  let sawAbort = false;

  await assert.rejects(
    Core.requestListingRemoval({
      listingId: '123',
      sessionid: 'session',
      timeoutMs: 15,
      fetchImpl: async (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          sawAbort = true;
          reject(init.signal.reason);
        }, { once: true });
      })
    }),
    (error) => error.code === 'REQUEST_TIMEOUT' && error.ambiguous === true && error.fatal === true
  );

  assert.equal(sawAbort, true);
});

test('abort cancels an in-flight queue item and prevents the next request', async () => {
  const controller = new AbortController();
  const called = [];
  const unknown = [];

  const running = Core.runRemovalQueue({
    items: [listing(1), listing(2)],
    signal: controller.signal,
    executeItem: async (item, signal) => {
      called.push(item.id);
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Core.createAbortError()), { once: true });
      });
    },
    onItemUnknown(item) {
      unknown.push(item.id);
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(running, (error) => Core.isAbortError(error));
  assert.deepEqual(called, ['1']);
  assert.deepEqual(unknown, ['1']);
});

test('abort during rate-limit backoff prevents another POST', async () => {
  const controller = new AbortController();
  let calls = 0;
  let sleeping = false;

  const running = Core.requestRemovalWithRetry({
    listingId: '123',
    sessionid: 'session',
    signal: controller.signal,
    fetchImpl: async () => {
      calls += 1;
      return new Response('', { status: 429 });
    },
    sleepImpl: async (ms, signal) => {
      sleeping = true;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Core.createAbortError()), { once: true });
      });
    },
    backoff: { baseMs: 1, jitterMs: 0, random: () => 0 }
  });

  while (!sleeping) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(running, (error) => Core.isAbortError(error));
  assert.equal(calls, 1);
});

test('exhausted rate limiting stops the queue before the next listing', async () => {
  const requestedIds = [];

  await assert.rejects(
    Core.runRemovalQueue({
      items: [listing(1), listing(2)],
      executeItem: (item) => Core.requestRemovalWithRetry({
        listingId: item.id,
        sessionid: 'session',
        maxAttempts: 2,
        sleepImpl: async () => {},
        backoff: { baseMs: 1, jitterMs: 0, random: () => 0 },
        fetchImpl: async (url) => {
          requestedIds.push(new URL(url).pathname.split('/').pop());
          return new Response('', { status: 429 });
        }
      })
    }),
    (error) => (
      error.code === 'RATE_LIMITED' &&
      error.fatal === true &&
      error.queueReport.attempted === 1 &&
      error.queueReport.skipped === 1
    )
  );

  assert.deepEqual(requestedIds, ['1', '1']);
});

test('fatal network, server and redirect failures never reach the next listing', async (t) => {
  const cases = [
    ['network', async () => { throw new TypeError('offline'); }],
    ['server', async () => new Response('', { status: 503 })],
    ['redirect', async () => ({
      ok: false,
      status: 0,
      redirected: false,
      type: 'opaqueredirect',
      url: '',
      headers: new Headers(),
      text: async () => ''
    })]
  ];

  for (const [name, responseFactory] of cases) {
    await t.test(name, async () => {
      const requestedIds = [];

      await assert.rejects(
        Core.runRemovalQueue({
          items: [listing(1), listing(2)],
          executeItem: (item) => Core.requestRemovalWithRetry({
            listingId: item.id,
            sessionid: 'session',
            fetchImpl: async (url) => {
              requestedIds.push(new URL(url).pathname.split('/').pop());
              return responseFactory();
            }
          })
        }),
        (error) => error.fatal === true && error.queueReport.skipped === 1
      );

      assert.deepEqual(requestedIds, ['1']);
    });
  }
});

test('scan deduplicates pages and replacement preserves existing state', async () => {
  const pages = new Map([
    [0, { items: [listing('1'), listing('2')], totalCount: 3 }],
    [2, { items: [listing('2'), listing('3')], totalCount: 3 }]
  ]);

  const result = await Core.scanAllListings({
    pageSize: 2,
    pageDelayMs: 0,
    fetchPage: async (start) => pages.get(start)
  });

  assert.deepEqual(result.items.map((item) => item.id), ['1', '2', '3']);

  const store = new Core.ListingStore(result.items);
  store.setSelected('2', true);
  store.setStatus('3', 'failed', 'test');
  store.replace([listing('2'), listing('3'), listing('4')]);

  assert.equal(store.size, 3);
  assert.equal(store.get('2').selected, true);
  assert.equal(store.get('3').status, 'failed');
  assert.equal(store.get('4').selected, false);
});

test('an incomplete pagination result blocks the scan', async () => {
  const pages = new Map([
    [0, { items: [listing('1')], totalCount: 2 }],
    [1, { items: [], totalCount: 2 }]
  ]);

  await assert.rejects(
    Core.scanAllListings({
      pageSize: 1,
      pageDelayMs: 0,
      fetchPage: async (start) => pages.get(start)
    }),
    (error) => error.code === 'INCOMPLETE_SCAN'
  );
});

test('a decreasing total count cannot complete a partial scan', async () => {
  const pages = new Map([
    [0, { items: [listing('1'), listing('2')], totalCount: 4 }],
    [2, { items: [listing('3')], totalCount: 3 }]
  ]);

  await assert.rejects(
    Core.scanAllListings({
      pageSize: 2,
      pageDelayMs: 0,
      fetchPage: async (start) => pages.get(start)
    }),
    (error) => error.code === 'INCOMPLETE_SCAN'
  );
});

test('a scan without an authoritative total is rejected', async () => {
  await assert.rejects(
    Core.scanAllListings({
      pageSize: 100,
      pageDelayMs: 0,
      fetchPage: async () => ({ items: [] })
    }),
    (error) => error.code === 'PROTOCOL_ERROR' && error.fatal === true
  );
});

test('verification keeps failed listings and removes confirmed listings', () => {
  const store = new Core.ListingStore([listing(1), listing(2), listing(3)]);
  store.setStatus('1', 'submitted');
  store.setStatus('2', 'unknown');

  const result = Core.reconcileVerification(
    store,
    new Set(['1', '2']),
    [listing(2), listing(3)]
  );

  assert.deepEqual(result.confirmed, ['1']);
  assert.deepEqual(result.remaining, ['2']);
  assert.equal(store.has('1'), false);
  assert.equal(store.get('2').status, 'failed');
  assert.equal(store.get('2').selected, true);
});

test('removal outcomes update store and verification state consistently', () => {
  const store = new Core.ListingStore([listing(1), listing(2), listing(3), listing(4)]);
  const verificationIds = new Set();
  store.selectWhere(() => true, true);

  Core.applyRemovalOutcome(store, verificationIds, '1', 'accepted');
  Core.applyRemovalOutcome(store, verificationIds, '2', 'ambiguous', 'unknown result');
  Core.applyRemovalOutcome(store, verificationIds, '3', 'failed', 'denied');
  Core.applyRemovalOutcome(store, verificationIds, '4', 'aborted', 'stopped');

  assert.deepEqual(Array.from(verificationIds), ['1', '2', '4']);
  assert.deepEqual(
    store.values().map((item) => [item.id, item.status, item.selected]),
    [
      ['1', 'submitted', false],
      ['2', 'unknown', false],
      ['3', 'failed', true],
      ['4', 'unknown', false]
    ]
  );
});

test('scan forwards AbortSignal and stops after cancellation', async () => {
  const controller = new AbortController();
  let receivedSignal = null;
  let calls = 0;

  const running = Core.scanAllListings({
    signal: controller.signal,
    fetchPage: async (start, count, signal) => {
      calls += 1;
      receivedSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Core.createAbortError()), { once: true });
      });
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(running, (error) => Core.isAbortError(error));
  assert.equal(receivedSignal, controller.signal);
  assert.equal(calls, 1);
});

test('non-Steam request targets are rejected', () => {
  assert.throws(
    () => Core.getSteamMarketUrl('https://example.com/collect'),
    (error) => error.code === 'INVALID_TARGET'
  );
  assert.throws(
    () => Core.getSteamMarketUrl('/login/'),
    (error) => error.code === 'INVALID_TARGET'
  );
});

test('listing id resolution rejects conflicting DOM identifiers', () => {
  assert.equal(Core.resolveListingId('mylisting_123', "javascript:RemoveListing('123')"), '123');
  assert.equal(
    Core.resolveListingId('mylisting_123', "javascript:RemoveMarketListing('mylisting_123', 123, 730, '2', 'hash')"),
    '123'
  );
  assert.equal(Core.resolveListingId('mylisting_456', ''), '456');
  assert.equal(Core.resolveListingId('', "javascript:RemoveListing('789')"), '789');
  assert.equal(Core.resolveListingId('mylisting_bad', 'javascript:void(0)'), '');
  assert.throws(
    () => Core.resolveListingId('mylisting_123', "javascript:RemoveListing('999')"),
    (error) => error.code === 'LISTING_ID_MISMATCH'
  );
  assert.throws(
    () => Core.resolveListingId('mylisting_123', "javascript:RemoveMarketListing('mylisting_123', 999, 730, '2', 'hash')"),
    (error) => error.code === 'LISTING_ID_MISMATCH'
  );
  assert.throws(
    () => Core.resolveListingId('mylisting_123', "javascript:RemoveMarketListing('mylisting_999', 999, 730, '2', 'hash')"),
    (error) => error.code === 'LISTING_ID_MISMATCH'
  );
});

test('non-actionable statuses never enter the removal target list', () => {
  const store = new Core.ListingStore([
    listing(1), listing(2), listing(3), listing(4), listing(5)
  ]);
  store.selectWhere(() => true, true);
  store.setStatus('2', 'removing');
  store.setStatus('3', 'submitted');
  store.setStatus('4', 'removed');
  store.setStatus('5', 'unknown');

  assert.deepEqual(Core.getActionableListings(store).map((item) => item.id), ['1', '5']);
});
