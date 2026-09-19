'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(name) {
  return fs.readFileSync(path.join(root, name), 'utf8');
}

test('page panel wires multisell through a trusted event to an isolated Steam tab', () => {
  const source = read('content.js');
  const controls = source.slice(
    source.indexOf('function updateControls()'),
    source.indexOf('function requireTrustedClick(')
  );

  assert.match(source, /id="sbd-multisell-form"/);
  assert.match(source, /id="sbd-multisell-game"/);
  assert.match(source, /id="sbd-multisell-advanced"/);
  assert.match(source, /id="sbd-multisell-add-current"/);
  assert.match(source, /Core\.parseMultiSellEntries\(/);
  assert.match(source, /Core\.buildMultiSellUrl\(/);
  assert.match(source, /requireTrustedClick\(event, openOfficialMultiSell\)/);
  assert.match(source, /requireTrustedClick\(event, addCurrentMarketItem\)/);
  assert.match(source, /window\.open\(url, '_blank', 'noopener,noreferrer'\)/);
  assert.match(source, /currentListing: getCurrentMarketListing\(\)/);
  assert.doesNotMatch(controls, /multisell/);
});

test('popup loads the shared core before wiring the multisell form', () => {
  const html = read('popup.html');
  const source = read('popup.js');

  assert.ok(html.indexOf('<script src="core.js"></script>') < html.indexOf('<script src="popup.js"></script>'));
  assert.match(html, /id="multisell-form"/);
  assert.match(html, /id="multisell-game"/);
  assert.match(html, /id="multisell-advanced"/);
  assert.match(html, /id="multisell-add-current"/);
  assert.match(source, /Core\.parseMultiSellEntries\(/);
  assert.match(source, /Core\.buildMultiSellUrl\(/);
  assert.match(source, /chrome\.tabs\.create\(\{ url \}/);
  assert.match(source, /currentListing = response\.currentListing \|\| null/);
});

test('multisell adds no permissions and contains no direct sell request', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const executableSource = [read('core.js'), read('content.js'), read('popup.js')].join('\n');

  assert.equal(manifest.manifest_version, 3);
  assert.equal(Object.hasOwn(manifest, 'permissions'), false);
  assert.equal(Object.hasOwn(manifest, 'host_permissions'), false);
  assert.doesNotMatch(executableSource, /\/market\/sellitem/i);
});

test('multisell panel styles cover its inputs, status and responsive grid', () => {
  const css = read('content.css');

  assert.match(css, /\.sbd-multisell-form/);
  assert.match(css, /\.sbd-multisell-ids/);
  assert.match(css, /\.sbd-multisell-advanced/);
  assert.match(css, /\.sbd-multisell-status-error/);
  assert.match(css, /\.sbd-multisell-status-warning/);
  assert.match(css, /textarea:focus-visible/);
});
