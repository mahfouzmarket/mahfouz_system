const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const script = path.join(__dirname, 'orders_notify_safe.js');

test('every topic push is hard-bound to the active app binary', () => {
  const source = fs.readFileSync(script, 'utf8');
  assert.match(source, /const brandAnchorTopic = `broadcast_\$\{BRAND_ID\}`/);
  assert.match(
    source,
    /`'\$\{topic\}' in topics && '\$\{brandAnchorTopic\}' in topics`/,
  );
  assert.match(source, /condition: brandCondition/);
  assert.doesNotMatch(source, /const msg = \{\s*topic,/);
  assert.match(source, /'apns-topic': BRAND_APP_TARGET\.iosBundleId/);
  assert.match(
    source,
    /restrictedPackageName: BRAND_APP_TARGET\.androidPackageName/,
  );
  assert.match(source, /iosBundleId: 'MAHFOUZ\.MARKET\.MM-APP'/);
  assert.match(source, /iosBundleId: 'com\.mahfouz\.nounasfood'/);
  assert.match(
    source,
    /androidPackageName: 'com\.mahfouzmarket\.mahfouz_market'/,
  );
  assert.match(
    source,
    /androidPackageName: 'com\.mahfouzmarket\.nounas_food'/,
  );
  assert.match(source, /Unsupported BRAND_ID for push target isolation/);
});

test('terminal Live Activity pushes dismiss the closed order immediately', () => {
  const source = fs.readFileSync(script, 'utf8');
  assert.match(source, /aps\['dismissal-date'\] = now;/);
  assert.doesNotMatch(source, /dismissal-date'\] = now \+ 15 \* 60/);
});

test('Live Activity lookup survives the private tracking id being absent from the public feed', () => {
  const source = fs.readFileSync(script, 'utf8');
  assert.match(
    source,
    /registrations\.where\('orderId', '==', id\)\.limit\(10\)\.get\(\)/,
  );
  assert.match(source, /for \(const snapshot of snapshots\)/);
  assert.match(source, /await snapshot\.ref\.set\(/);
});

test('a manual repair targets only the requested Live Activity', () => {
  const source = fs.readFileSync(script, 'utf8');
  assert.match(source, /LIVE_ACTIVITY_REPAIR_ORDER_ID/);
  assert.match(source, /DRY_RUN_INPUT\.toLowerCase\(\)\.startsWith\('repair:'\)/);
  assert.match(source, /LIVE_ACTIVITY_REPAIR_DONE/);
  assert.match(source, /if \(!repaired\) throw new Error/);
});

function runSchedule(extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mahfouz-notifier-guard-'));
  const ordersPath = path.join(root, 'orders.json');
  const createdAt = new Date(Date.now() - 60 * 1000).toISOString();
  fs.writeFileSync(
    ordersPath,
    JSON.stringify([{ orderId: 'guard-test-order', status: 'NEW', createdAt }]),
    'utf8',
  );
  const env = {
    ...process.env,
    ORDERS_PATH: ordersPath,
    BRAND_ID: 'mahfouz_market',
    DRY_RUN: 'true',
    GITHUB_EVENT_NAME: 'schedule',
    RECENT_WINDOW_HOURS: '12',
    TIMER_LOOKBACK_HOURS: '24',
    ...extraEnv,
  };
  delete env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!Object.hasOwn(extraEnv, 'RECOVERY_SWEEP_ENABLED')) {
    delete env.RECOVERY_SWEEP_ENABLED;
  }
  if (!Object.hasOwn(extraEnv, 'RECEIPTS_SINCE')) {
    delete env.RECEIPTS_SINCE;
  }
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  fs.rmSync(root, { recursive: true, force: true });
  return result;
}

test('recovery sweep is disabled when cutover configuration is absent', () => {
  const result = runSchedule();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SWEEP_DISABLED explicit_receipt_cutover_required/);
  assert.match(result.stdout, /TIMER_DISABLED explicit_receipt_cutover_required/);
  assert.doesNotMatch(result.stdout, /DRY_SEND/);
});

test('timer cutover must be an explicit valid timestamp', () => {
  const result = runSchedule({ TIMER_RECEIPTS_SINCE: 'not-a-timestamp' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TIMER_RECEIPTS_SINCE must be a valid UTC timestamp/);
  assert.doesNotMatch(result.stdout, /DRY_SEND/);
});

test('a stale legacy timestamp alone cannot enable recovery', () => {
  const result = runSchedule({ RECEIPTS_SINCE: '2026-08-04T13:20:00Z' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SWEEP_DISABLED explicit_receipt_cutover_required/);
  assert.doesNotMatch(result.stdout, /DRY_SEND/);
});

test('enabling recovery without a cutover timestamp fails closed', () => {
  const result = runSchedule({ RECOVERY_SWEEP_ENABLED: 'true' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires an explicit RECEIPTS_SINCE/);
  assert.doesNotMatch(result.stdout, /DRY_SEND/);
});

test('explicit current cutover enables the receipt recovery sweep', () => {
  const cutover = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const result = runSchedule({
    RECOVERY_SWEEP_ENABLED: 'true',
    RECEIPTS_SINCE: cutover,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SWEEP_DONE checked=1 recovered=1 dry_run=true/);
  assert.match(result.stdout, /DRY_SEND/);
});
