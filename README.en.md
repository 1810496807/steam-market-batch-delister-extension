# Steam Market Batch Assistant

[中文说明](README.md)

A Chrome / Edge Manifest V3 extension for batch-removing active Steam Community Market listings and opening Steam's official bulk listing page.

## Features

- Reads the complete active-listing inventory through Steam's official `mylistings/render` endpoint with pagination.
- Opens the Steam Community Market in a new tab from both the page panel and the extension popup.
- Generates Steam's official `multisell` page from game presets, Steam item links, or market names.
- Searches by item name, game, AppID, listing ID, and price.
- Leaves newly scanned items unselected and shows a count and preview before batch operations.
- Sends delisting requests serially, with pause, immediate stop, and cancellable backoff support.
- Honors `Retry-After`; when it is absent, uses exponential backoff with jitter.
- Applies per-request timeouts; authentication failures, sustained rate limits, and ambiguous responses stop the remaining queue.
- Re-scans the active listings after delisting to verify the result against Steam's current state.
- Isolates the page panel with Shadow DOM and safely rebuilds it if the page removes it.

## Bulk Listing

1. Expand **Bulk listing** and choose a game. Presets include Counter-Strike 2, Dota 2, Team Fortress 2, Rust, PUBG, and Steam Community items.
2. Paste one Steam Market item-page link per line, or enter a market name directly. On a specific item page, you can click **Add current page item**.
3. Click **Open official bulk listing**. Set quantities and prices in the new Steam tab; Steam performs the final confirmation.

Traditional item links provide the exact `market_hash_name` and identify the game automatically. Steam's newer `G...` item-group links are internal identifiers rather than market names, so use **Add current page item** on the item page; the extension reads the canonical market name from the page data. If the name cannot be identified uniquely, link generation is blocked and the UI asks for a manual market name instead. Duplicate names are merged automatically. Quantities for identical items are selected on Steam's page, and links from different games must be processed separately.

Only the **Other game (advanced)** option requires editing AppID and ContextID. An AppID identifies a game; it is not an inventory asset ID or listing ID. Item links do not contain a ContextID. Unknown games default to `2` and require confirmation in Advanced settings; Steam Community items use `appid=753&contextid=6`. Steam's bulk listing page is primarily intended for stackable, identical items.

The extension accepts at most 100 item types per batch and limits the final URL length to avoid browser or Steam rejection. These are local safety limits, not Steam quotas.

## Installation

1. Open `chrome://extensions/` or `edge://extensions/`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select this directory.
4. Open or refresh `https://steamcommunity.com/market/`.

## Permissions and Privacy

- The content script matches only `https://steamcommunity.com/market/*`.
- `content.css` is exposed to `steamcommunity.com` only as the extension's own Shadow DOM stylesheet.
- The extension declares no `cookies`, `storage`, `tabs`, `activeTab`, `scripting`, or remote-host permissions.
- `sessionid` is read only while delisting and is submitted only to Steam's same-origin official delisting endpoint.
- The bulk-listing tool only generates and opens a fixed-domain Steam page. It does not read `sessionid`, enter prices, or submit a sell request automatically.
- There is no telemetry, remote script, third-party request, or account-data storage.

## Local Tests

Tests do not connect to Steam or perform real delisting requests:

```powershell
node --test tests\*.test.cjs
```

Before publishing, also run:

```powershell
node --check core.js
node --check content.js
node --check popup.js
```

## Directory Layout

- `core.js`: state, filtering, link validation, retry, cancellation, and queue logic; independently testable.
- `content.js`: Steam page parsing, bulk-listing entry point, panel interactions, and request verification.
- `content.css`: page-panel styles.
- `popup.html` / `popup.js`: extension status, Market shortcut, and bulk-listing URL generator.
- `tests/*.test.cjs`: offline core regression and UI wiring tests.
- `LICENSE`: MIT License.

## License

This project is distributed under the [MIT License](LICENSE).
