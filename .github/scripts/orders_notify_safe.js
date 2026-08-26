const fs = require('fs');
const { execFileSync } = require('child_process');

const ORDERS_PATH = process.env.ORDERS_PATH || 'orders.json';
const BRAND_ID = process.env.BRAND_ID || 'mahfouz_market';
const OWNER_TOPIC = (process.env.OWNER_TOPIC || '').trim();
const DRY_RUN_INPUT = String(process.env.DRY_RUN || '').trim();
const DRY_RUN = DRY_RUN_INPUT.toLowerCase() === 'true';
const WORKFLOW_REPAIR_ORDER_ID = DRY_RUN_INPUT.toLowerCase().startsWith('repair:')
  ? DRY_RUN_INPUT.substring('repair:'.length).trim()
  : '';
const RECENT_MS = Number(process.env.RECENT_WINDOW_HOURS || 12) * 60 * 60 * 1000;
const TIMER_LOOKBACK_MS =
  Number(process.env.TIMER_LOOKBACK_HOURS || 24) * 60 * 60 * 1000;
const TIMER_RECEIPTS_SINCE_RAW = String(
  process.env.TIMER_RECEIPTS_SINCE || '',
).trim();
let TIMER_RECEIPTS_SINCE_MS = null;
if (TIMER_RECEIPTS_SINCE_RAW) {
  TIMER_RECEIPTS_SINCE_MS = Date.parse(TIMER_RECEIPTS_SINCE_RAW);
  if (!Number.isFinite(TIMER_RECEIPTS_SINCE_MS)) {
    throw new Error('TIMER_RECEIPTS_SINCE must be a valid UTC timestamp.');
  }
}
const EVENT_NAME = process.env.GITHUB_EVENT_NAME || '';
const IS_NOUNAS = BRAND_ID === 'nounas_food';

// Mahfouz and Nouna intentionally share one Firebase project. FCM topic names
// alone are therefore not a sufficient app boundary: a stale registration can
// remain subscribed to the other brand's topic. Bind every platform payload to
// the intended binary as a second, sender-side enforcement layer. APNs rejects
// a device token that does not belong to `apns-topic`; Android accepts only a
// registration whose package matches `restrictedPackageName`.
const BRAND_APP_TARGETS = Object.freeze({
  mahfouz_market: Object.freeze({
    iosBundleId: 'MAHFOUZ.MARKET.MM-APP',
    androidPackageName: 'com.mahfouzmarket.mahfouz_market',
  }),
  nounas_food: Object.freeze({
    iosBundleId: 'com.mahfouz.nounasfood',
    androidPackageName: 'com.mahfouzmarket.nounas_food',
  }),
});
const BRAND_APP_TARGET = BRAND_APP_TARGETS[BRAND_ID];
if (!BRAND_APP_TARGET) {
  throw new Error(`Unsupported BRAND_ID for push target isolation: ${BRAND_ID}`);
}

// Recovery is disabled unless a deployer explicitly supplies both flags at
// the receipt-enabled cutover. A baked-in historical default can replay a
// recent order's current status when Firestore has no receipt for it.
const RECOVERY_SWEEP_ENABLED =
  String(process.env.RECOVERY_SWEEP_ENABLED || '').trim().toLowerCase() === 'true';
const RECEIPTS_SINCE_RAW = String(process.env.RECEIPTS_SINCE || '').trim();
let RECEIPTS_SINCE_MS = null;
if (RECOVERY_SWEEP_ENABLED) {
  if (!RECEIPTS_SINCE_RAW) {
    throw new Error('RECOVERY_SWEEP_ENABLED requires an explicit RECEIPTS_SINCE cutover timestamp.');
  }
  const parsedCutover = Date.parse(RECEIPTS_SINCE_RAW);
  if (
    !Number.isFinite(parsedCutover) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(RECEIPTS_SINCE_RAW) ||
    parsedCutover > Date.now() + 5 * 60 * 1000
  ) {
    throw new Error('RECEIPTS_SINCE must be an explicit valid UTC cutover timestamp.');
  }
  RECEIPTS_SINCE_MS = parsedCutover;
}

function sh(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch (_) {
    return '';
  }
}

function eventJson() {
  try {
    return JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function changedFilesForPush() {
  const event = eventJson();
  const before = String(event.before || '').trim();
  const after = String(event.after || 'HEAD').trim() || 'HEAD';
  if (!before || before.startsWith('0000000')) return [];
  const out = sh(['diff', '--name-only', before, after]);
  return out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

function loadOrdersText(text) {
  if (!String(text || '').trim()) return { wrapped: false, root: [], orders: [] };
  const decoded = JSON.parse(text);
  if (Array.isArray(decoded)) return { wrapped: false, root: decoded, orders: decoded };
  if (decoded && Array.isArray(decoded.orders)) {
    return { wrapped: true, root: decoded, orders: decoded.orders };
  }
  return { wrapped: false, root: [], orders: [] };
}

function readPrevOrders() {
  const event = eventJson();
  const before = String(event.before || '').trim();
  if (before && !before.startsWith('0000000')) {
    const txt = sh(['show', `${before}:${ORDERS_PATH}`]);
    if (txt) return loadOrdersText(txt).orders;
  }
  const txt = sh(['show', `HEAD^:${ORDERS_PATH}`]);
  return txt ? loadOrdersText(txt).orders : [];
}

function idOf(o) {
  return String(o && (o.orderId || o.id || '')).trim();
}

function statusOf(o) {
  return String(o && (o.status || 'NEW')).trim().toUpperCase() || 'NEW';
}

function isPickup(o) {
  if (o && o.pickup === true) return true;
  const v = o && (o.isPickup ?? o.fulfillment ?? o.mode ?? o.serviceType);
  const s = String(v || '').trim().toUpperCase();
  return s === 'PICKUP' || s === 'TRUE' || s === '1';
}

function effectiveStatus(o) {
  const st = statusOf(o);
  if (isPickup(o) && st === 'PICKED_UP') return 'READY_TO_PICKUP';
  return st;
}

function branchKey(o) {
  if (IS_NOUNAS) return 'nounas_food';
  const bk = String(o.branchKey || '').trim().toLowerCase();
  if (bk) return bk;
  const b = String(o.branch || '').trim().toLowerCase();
  if (
    b.startsWith('g') ||
    b.includes('geitawi') ||
    b.includes('achrafieh') ||
    b.includes('ashrafieh')
  ) {
    return 'geitawi';
  }
  if (b.startsWith('m') || b.includes('medawar') || b.includes('karantina')) {
    return 'medawar';
  }
  return 'geitawi';
}

function prettyBranch(bk) {
  if (IS_NOUNAS) return "Nouna's Food";
  if (bk === 'geitawi') return 'Geitawi';
  if (bk === 'medawar') return 'Medawar';
  return bk || 'Branch';
}

function safeTopic(s) {
  return String(s || '').replace(/[^A-Za-z0-9_]/g, '_');
}

function ownerTopic(bk) {
  if (OWNER_TOPIC) return OWNER_TOPIC;
  return `orders_${BRAND_ID}_${bk}`;
}

function orderTopic(id) {
  return `ord_${safeTopic(id)}`;
}

function driverIdOf(o) {
  return String((o && (o.driverId || o.assignedDriverId)) || '').trim();
}

// A driver phone subscribes to drv_<brand>_<branch>_<id>, but the <id> it uses
// depends on how that build signed in: the drivers_v1 id (drv_sys_...) on PIN
// login, or the staff name/driverKey on phone or access-code login. The branch
// segment likewise differs ("medawar", "Medawar", or "all" when the staff record
// has no branch-scoped order_receiver link). We cannot know which build is on
// the phone, so driver-directed alerts go to every plausible channel. Extra
// topics with no subscribers are free. Once every driver runs a build that
// resolves the canonical driver id, this can shrink back to one topic.
function driverTopics(o) {
  const bk = branchKey(o);
  const ids = [driverIdOf(o), String((o && o.driverName) || '').trim().toLowerCase()];
  const branches = IS_NOUNAS ? [bk, 'all'] : [bk, prettyBranch(bk), 'all'];
  const out = [];
  for (const rawId of ids) {
    const id = rawId.trim();
    if (!id) continue;
    // FCM topic names accept [a-zA-Z0-9-_.~%] only; a name with a space can
    // never be subscribed to, so there is nothing to reach on that channel.
    if (!/^[A-Za-z0-9\-_.~%]+$/.test(id)) continue;
    for (const br of branches) {
      const topic = `drv_${BRAND_ID}_${br}_${id}`;
      if (!out.includes(topic)) out.push(topic);
    }
  }
  return out;
}

function customerName(o) {
  const c = (o && o.customer) || {};
  return (
    String(o.customer_name || '').trim() ||
    String(c.name || '').trim() ||
    String(c.fullName || '').trim() ||
    String(o.customerName || '').trim() ||
    String(o.name || '').trim() ||
    'Customer'
  );
}

function driverName(o) {
  return (
    String(o.delivery_man_name || '').trim() ||
    String(o.driverName || '').trim() ||
    String(o.driver_name || '').trim() ||
    'Driver'
  );
}

function fmtInt(n) {
  return Math.round(n).toLocaleString('en-US');
}

function amount(o) {
  const usd = Number(o.totalUsd ?? o.total_usd ?? 0);
  const lbp = Number(o.totalLbp ?? o.total_lbp ?? 0);
  const out = [];
  if (Number.isFinite(usd) && usd > 0) out.push(`${usd.toFixed(2)} USD`);
  if (Number.isFinite(lbp) && lbp > 0) out.push(`${fmtInt(lbp)} LBP`);
  return out.join(' • ');
}

function timeMs(raw) {
  const ms = Date.parse(String(raw || '').trim());
  return Number.isFinite(ms) ? ms : 0;
}

function orderTimeMs(o) {
  return timeMs(o.createdAt || o.ts || o.time);
}

function durationStr(fromRaw, toRaw) {
  const a = timeMs(fromRaw);
  const b = timeMs(toRaw);
  if (!a || !b || b <= a) return '';
  let mins = Math.round((b - a) / 60000);
  const days = Math.floor(mins / (60 * 24));
  mins -= days * 60 * 24;
  const hrs = Math.floor(mins / 60);
  mins -= hrs * 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hrs) parts.push(`${hrs}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}

function suppressed(o) {
  return (
    o.suppressNotify === true ||
    o.clientClosed === true ||
    o.silentClose === true ||
    String(o.finalStatus || o.final_status || '').toUpperCase() === 'DELIVERED'
  );
}

function recent(o) {
  const ms = orderTimeMs(o);
  return ms > 0 && Date.now() - ms <= RECENT_MS;
}

function skipReason(o) {
  if (suppressed(o)) return 'suppressed';
  if (!recent(o)) return 'historical';
  return '';
}

let messaging = null;
let firestore = null;

async function ensureMessaging() {
  if (DRY_RUN) return null;
  if (messaging) return messaging;
  const { cert, getApps, initializeApp } = require('firebase-admin/app');
  const { getMessaging } = require('firebase-admin/messaging');
  const { getFirestore } = require('firebase-admin/firestore');
  const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
  if (!svc.project_id) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON');
  if (svc.private_key && typeof svc.private_key === 'string') {
    svc.private_key = svc.private_key.replace(/\\n/g, '\n');
  }
  if (getApps().length === 0) {
    initializeApp({ credential: cert(svc) });
  }
  messaging = getMessaging();
  firestore = getFirestore();
  return messaging;
}

async function send(topic, title, body, data) {
  if (!topic) return;
  const brandAnchorTopic = `broadcast_${BRAND_ID}`;
  const brandCondition =
    `'${topic}' in topics && '${brandAnchorTopic}' in topics`;
  if (DRY_RUN) {
    console.log(
      'DRY_SEND',
      JSON.stringify({ topic, brandAnchorTopic, brandCondition, title, body, data }),
    );
    return;
  }
  const collapseId = notificationCollapseId(data);
  const msg = {
    // Staff/order topic membership was historically allowed to cross brands
    // for an owner account. Require the app's brand broadcast topic as an FCM
    // selection boundary too; platform headers alone are not sufficient for
    // shared-project topic fan-out.
    condition: brandCondition,
    notification: { title, body },
    data: Object.fromEntries(
      Object.entries(data || {}).map(([k, v]) => [k, String(v ?? '')]),
    ),
    android: {
      ...(collapseId ? { collapseKey: collapseId } : {}),
      priority: 'high',
      restrictedPackageName: BRAND_APP_TARGET.androidPackageName,
      notification: { sound: 'default' },
    },
    apns: {
      headers: {
        'apns-topic': BRAND_APP_TARGET.iosBundleId,
        'apns-priority': '10',
        'apns-push-type': 'alert',
        ...(collapseId ? { 'apns-collapse-id': collapseId } : {}),
      },
      payload: { aps: { sound: 'default', ...(collapseId ? { 'thread-id': collapseId } : {}) } },
    },
  };
  const client = await ensureMessaging();
  const sent = await client.send(msg);
  console.log(
    'SENT',
    topic,
    sent,
    `anchor=${brandAnchorTopic}`,
    data && data.orderId ? `order=${data.orderId}` : '',
  );
}

async function sendMany(topics, title, body, data) {
  for (const topic of topics) {
    await send(topic, title, body, data);
  }
}

// ===== Delivery receipts =====
// A run can die before it sends (GitHub cancels the older pending run whenever
// a third push arrives in the same concurrency group, and runners fail), and
// each run only ever looks at its own before..after diff, so nothing else would
// ever retry that transition. Every alert group therefore writes a receipt, and
// the 5-minute scheduled run re-sends whatever the current status is missing.
// Receipts live in Firestore, not in orders.json: writing them back to the repo
// would mean a commit per notification, a push race with every phone that edits
// orders.json, and a second Actions run for every status change.
function receiptRef(orderId) {
  if (!firestore) return null;
  return firestore
    .collection('brands')
    .doc(BRAND_ID)
    .collection('notify_receipts')
    .doc(safeTopic(orderId));
}

async function loadReceipt(orderId) {
  if (DRY_RUN) return {};
  try {
    await ensureMessaging();
    const ref = receiptRef(orderId);
    if (!ref) return {};
    const snap = await ref.get();
    return snap.exists ? snap.data() || {} : {};
  } catch (error) {
    // Unknown receipt state must not block the alert itself.
    console.error('RECEIPT_READ_FAILED', orderId, error && error.message ? error.message : error);
    return {};
  }
}

async function saveReceipt(orderId, kind, extra = {}) {
  if (DRY_RUN) {
    console.log('DRY_RECEIPT', orderId, kind);
    return;
  }
  try {
    await ensureMessaging();
    const ref = receiptRef(orderId);
    if (!ref) return;
    await ref.set(
      {
        orderId,
        [kind]: new Date().toISOString(),
        ...extra,
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    );
  } catch (error) {
    console.error('RECEIPT_WRITE_FAILED', orderId, kind, error && error.message ? error.message : error);
  }
}

function trackingId(o, id) {
  return String(o.trackingId || o.tracking_id || id || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '_');
}

function liveActivityVisual(o, status) {
  if (status === 'ACCEPTED') {
    return {
      statusTitle: 'Your order is being prepared',
      statusDetail: 'The market team is preparing your items.',
      progress: 0.34,
      isFinal: false,
    };
  }
  if (status === 'ASSIGNED_DRIVER') {
    const driver = driverName(o);
    return {
      statusTitle: 'Your driver is getting ready',
      statusDetail: driver ? driver + ' is assigned.' : 'A driver is assigned.',
      progress: 0.58,
      isFinal: false,
    };
  }
  if (status === 'PICKED_UP') {
    return {
      statusTitle: 'Your order is on the way',
      statusDetail: 'Follow the driver in Mahfouz Market.',
      progress: 0.78,
      isFinal: false,
    };
  }
  if (status === 'READY_TO_PICKUP') {
    return {
      statusTitle: 'Your order is ready',
      statusDetail: 'You can pick it up from the market.',
      progress: 1,
      isFinal: false,
    };
  }
  if (status === 'DELIVERED') {
    return {
      statusTitle: 'Delivered',
      statusDetail: 'Thank you for shopping with Mahfouz Market.',
      progress: 1,
      isFinal: true,
    };
  }
  if (status === 'CANCELLED') {
    return {
      statusTitle: 'Order cancelled',
      statusDetail: 'This order is now closed.',
      progress: 1,
      isFinal: true,
    };
  }
  return {
    statusTitle: 'Order received',
    statusDetail: 'We received your order and will start shortly.',
    progress: 0.12,
    isFinal: false,
  };
}

function liveActivityEta(o, status) {
  const eta = new Date(o.estimatedArrivalAt || o.etaAt || o.estimated_delivery_at || '');
  if (!Number.isNaN(eta.getTime())) {
    if (status === 'READY_TO_PICKUP') return 'Ready';
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Beirut',
      hour: 'numeric',
      minute: '2-digit',
    }).format(eta);
    return 'By ' + formatted;
  }
  if (status === 'ACCEPTED') return '0-1 min';
  if (status === 'ASSIGNED_DRIVER') return '1-6 min';
  if (status === 'PICKED_UP') return '6-9 min';
  if (status === 'DELIVERED') return '9-10 min';
  if (status === 'READY_TO_PICKUP') return 'Ready';
  if (status === 'CANCELLED') return '';
  return '10 min';
}

async function sendLiveActivity(o, id, status) {
  if (DRY_RUN) return true;
  const tracking = trackingId(o, id);
  if (!tracking) return false;
  try {
    const client = await ensureMessaging();
    if (!firestore) return false;
    const registrations = firestore
      .collection('brands')
      .doc(BRAND_ID)
      .collection('live_activity_tokens');
    const directRef = registrations.doc(tracking);
    const directSnapshot = await directRef.get();
    let snapshots = directSnapshot.exists ? [directSnapshot] : [];

    // The SQL/public compatibility feed deliberately omits the customer's
    // private tracking id. Older registrations are therefore stored under
    // that private id while this notifier can only derive the public order
    // id. Resolve the registration through its non-secret orderId field
    // instead of exporting the private tracking credential to orders.json.
    if (snapshots.length === 0) {
      const byOrder = await registrations.where('orderId', '==', id).limit(10).get();
      snapshots = byOrder.docs;
    }
    if (snapshots.length === 0) {
      console.log('LIVE_ACTIVITY_SKIP no_token', id);
      return false;
    }

    const visual = liveActivityVisual(o, status);
    const now = Math.floor(Date.now() / 1000);
    const aps = {
      timestamp: now,
      event: visual.isFinal ? 'end' : 'update',
      'content-state': {
        statusTitle: visual.statusTitle,
        statusDetail: visual.statusDetail,
        etaText: liveActivityEta(o, status),
        progress: visual.progress,
        updatedAtEpoch: Date.now() / 1000,
        isFinal: visual.isFinal,
      },
      'stale-date': now + 5 * 60,
      'relevance-score': visual.isFinal ? 50 : 100,
    };
    // A completed/cancelled order is closed, so remove its lock-screen route
    // immediately instead of keeping a stale final card for another 15 min.
    if (visual.isFinal) aps['dismissal-date'] = now;

    let sent = 0;
    for (const snapshot of snapshots) {
      const registration = snapshot.data() || {};
      const fcmToken = String(registration.fcmToken || '').trim();
      const activityToken = String(registration.liveActivityToken || '').trim();
      if (!fcmToken || !activityToken) continue;

      await client.send({
        token: fcmToken,
        apns: {
          liveActivityToken: activityToken,
          headers: { 'apns-priority': '10' },
          payload: { aps },
        },
      });
      await snapshot.ref.set({
        active: !visual.isFinal,
        status,
        lastRemoteUpdateAt: new Date().toISOString(),
        ...(visual.isFinal ? { expiresAt: new Date(Date.now() + 60 * 60 * 1000) } : {}),
      }, { merge: true });
      sent++;
    }
    if (sent === 0) {
      console.log('LIVE_ACTIVITY_SKIP incomplete_token', id);
      return false;
    }
    console.log('LIVE_ACTIVITY_SENT', status, id, `registrations=${sent}`);
    return true;
  } catch (error) {
    console.error('LIVE_ACTIVITY_FAILED', id, error && error.message ? error.message : error);
    return false;
  }
}

function notificationCollapseId(data) {
  const order = safeTopic(data && data.orderId);
  const event = safeTopic(data && (data.kind || data.type));
  if (!order || !event) return '';
  return `${BRAND_ID}_${order}_${event}`.slice(0, 64);
}

function baseData(o, id, bk) {
  return {
    orderId: id,
    brandId: BRAND_ID,
    branchKey: bk,
    driverId: driverIdOf(o),
    customer_name: customerName(o),
    delivery_man_name: driverName(o),
    totalUsd: String(o.totalUsd ?? ''),
    totalLbp: String(o.totalLbp ?? ''),
    pickup: String(isPickup(o)),
  };
}

// Every alert group lives here so the push path and the recovery sweep can
// never drift apart.
async function notifyKind(o, id, kind) {
  const bk = branchKey(o);
  const name = customerName(o);
  const drv = driverName(o);
  const money = amount(o);
  const moneyPart = money ? ` • ${money}` : '';
  const data = baseData(o, id, bk);

  if (kind === 'new_order') {
    await send(ownerTopic(bk), `${prettyBranch(bk)} • ${name}`, `New order${moneyPart}`, {
      ...data,
      type: 'NEW_ORDER',
      kind: 'new_order',
    });
    return;
  }

  if (kind === 'delivery_assigned') {
    const d = { ...data, type: 'ORDER_ASSIGNED', kind: 'delivery_assigned' };
    await send(orderTopic(id), 'Driver assigned', `The driver ${drv} has been assigned to your order.`, d);
    await send(
      ownerTopic(bk),
      `${prettyBranch(bk)} • Delivery assigned`,
      `${name} order assigned to ${drv}${moneyPart}`,
      d,
    );
    await sendMany(driverTopics(o), 'New order assigned', `${name} order assigned to you${moneyPart}`, d);
    return;
  }

  if (kind === 'ready_to_pickup') {
    const d = { ...data, type: 'ORDER_READY_TO_PICKUP', kind: 'ready_to_pickup' };
    await send(orderTopic(id), 'Order ready to pick up', `Your order is ready to pick up${moneyPart}`, d);
    await send(
      ownerTopic(bk),
      `${prettyBranch(bk)} • Ready to pick up`,
      `Order ready to pick up${moneyPart} • ${name}`,
      d,
    );
    return;
  }

  if (kind === 'picked_up') {
    const d = { ...data, type: 'ORDER_PICKED_UP', kind: 'picked_up' };
    await send(orderTopic(id), 'Picked up', 'Your order has been picked up.', d);
    await send(ownerTopic(bk), `Picked up • ${prettyBranch(bk)}`, `Picked up by ${drv} • ${name}`, d);
    return;
  }

  if (kind === 'delivered') {
    const dur = durationStr(o.createdAt || o.ts, o.deliveredAt || o.statusUpdatedAt);
    const timePart = dur ? ` • Time: ${dur}` : '';
    const body = `${name}${moneyPart} • Driver: ${drv}${timePart}`;
    const d = { ...data, type: 'ORDER_DELIVERED', kind: 'delivered' };
    await send(orderTopic(id), 'Delivered', 'Your order has been delivered.', d);
    await send(ownerTopic(bk), `Delivered • ${prettyBranch(bk)}`, body, d);
    await sendMany(driverTopics(o), `Delivered • ${prettyBranch(bk)}`, body, d);
    return;
  }

  if (kind === 'cancelled') {
    const d = { ...data, type: 'ORDER_CANCELLED', kind: 'cancelled' };
    await send(orderTopic(id), 'Order cancelled', 'Your order has been cancelled.', d);
    await send(ownerTopic(bk), `Cancelled • ${prettyBranch(bk)}`, `${name}${moneyPart}`, d);
    return;
  }

  throw new Error(`Unknown notification kind: ${kind}`);
}

// The alert that describes an order's current state. Used by the sweep: if this
// one has no receipt, whoever needed to know was never told.
function kindForStatus(status) {
  if (status === 'NEW') return 'new_order';
  if (status === 'ASSIGNED_DRIVER') return 'delivery_assigned';
  if (status === 'READY_TO_PICKUP') return 'ready_to_pickup';
  if (status === 'PICKED_UP') return 'picked_up';
  if (status === 'DELIVERED') return 'delivered';
  if (status === 'CANCELLED') return 'cancelled';
  return '';
}

async function recordSent(o, id, kind) {
  const extra = kind === 'delivery_assigned' ? { delivery_assigned_driver: driverIdOf(o) } : {};
  await saveReceipt(id, kind, extra);
}

async function handlePushTransitions(parsed) {
  const curOrders = parsed.orders.filter((o) => o && typeof o === 'object');
  const prevOrders = readPrevOrders().filter((o) => o && typeof o === 'object');
  if (EVENT_NAME === 'push' && curOrders.length > 0 && prevOrders.length === 0) {
    // The 5-minute sweep re-sends whatever this run cannot compare.
    console.log('ABORT: previous orders file unavailable, refusing replay-prone send.');
    return 0;
  }

  const prev = new Map(prevOrders.map((o) => [idOf(o), o]).filter(([id]) => id));
  let sentGroups = 0;
  let skipped = 0;

  for (const o of curOrders) {
    const id = idOf(o);
    if (!id) continue;
    const reason = skipReason(o);
    if (reason) {
      skipped++;
      continue;
    }

    const old = prev.get(id) || null;
    const curSt = effectiveStatus(o);
    const oldSt = old ? effectiveStatus(old) : '';
    const curDriver = driverIdOf(o);
    const oldDriver = old ? driverIdOf(old) : '';
    const isNewOrder = !old && curSt === 'NEW';
    const assignedNow =
      curSt === 'ASSIGNED_DRIVER' &&
      curDriver &&
      (oldSt !== 'ASSIGNED_DRIVER' || curDriver !== oldDriver);
    const pickedUpNow = curSt === 'PICKED_UP' && oldSt !== 'PICKED_UP';
    const readyPickupNow = curSt === 'READY_TO_PICKUP' && oldSt !== 'READY_TO_PICKUP';
    const deliveredNow = curSt === 'DELIVERED' && oldSt !== 'DELIVERED';
    const cancelledNow = curSt === 'CANCELLED' && oldSt !== 'CANCELLED';

    const kinds = [];
    if (isNewOrder) kinds.push('new_order');
    if (assignedNow) kinds.push('delivery_assigned');
    if (readyPickupNow) kinds.push('ready_to_pickup');
    if (pickedUpNow) kinds.push('picked_up');
    if (deliveredNow) kinds.push('delivered');
    if (cancelledNow) kinds.push('cancelled');
    if (kinds.length === 0) continue;

    await sendLiveActivity(o, id, curSt);

    for (const kind of kinds) {
      await notifyKind(o, id, kind);
      await recordSent(o, id, kind);
      sentGroups++;
    }
  }

  console.log(`PUSH_DONE sent_groups=${sentGroups} skipped=${skipped} dry_run=${DRY_RUN}`);
  return sentGroups;
}

// Recovery sweep: catches transitions whose run was cancelled or failed.
async function handleMissedTransitions(parsed) {
  if (RECEIPTS_SINCE_MS === null) {
    console.log('SWEEP_DISABLED explicit_receipt_cutover_required');
    return 0;
  }
  let recovered = 0;
  let checked = 0;

  for (const o of parsed.orders) {
    if (!o || typeof o !== 'object') continue;
    const id = idOf(o);
    if (!id) continue;
    if (skipReason(o)) continue;
    if (orderTimeMs(o) < RECEIPTS_SINCE_MS) continue;

    const curSt = effectiveStatus(o);
    const kind = kindForStatus(curSt);
    if (!kind) continue;

    checked++;
    const receipt = await loadReceipt(id);
    const already = String(receipt[kind] || '').trim();
    const driverChanged =
      kind === 'delivery_assigned' &&
      String(receipt.delivery_assigned_driver || '').trim() !== driverIdOf(o);
    if (already && !driverChanged) continue;

    console.log('RECOVER', id, curSt, kind, driverChanged ? '(driver changed)' : '(never sent)');
    await sendLiveActivity(o, id, curSt);
    await notifyKind(o, id, kind);
    await recordSent(o, id, kind);
    recovered++;
  }

  console.log(`SWEEP_DONE checked=${checked} recovered=${recovered} dry_run=${DRY_RUN}`);
  return recovered;
}

function timerEligible(baseMs, minMinutes) {
  if (!baseMs) return false;
  if (TIMER_RECEIPTS_SINCE_MS === null || baseMs < TIMER_RECEIPTS_SINCE_MS) {
    return false;
  }
  const age = Date.now() - baseMs;
  return age >= minMinutes * 60 * 1000 && age <= TIMER_LOOKBACK_MS;
}

async function handleTimerAlerts(parsed) {
  if (TIMER_RECEIPTS_SINCE_MS === null) {
    console.log('TIMER_DISABLED explicit_receipt_cutover_required');
    return 0;
  }
  let sent = 0;
  const legacy = (o, key) => String((o.notifs && o.notifs[key]) || '').trim();

  for (const o of parsed.orders) {
    if (!o || typeof o !== 'object') continue;
    if (suppressed(o)) continue;
    const id = idOf(o);
    if (!id) continue;

    const st = effectiveStatus(o);
    const bk = branchKey(o);
    const data = baseData(o, id, bk);
    const name = customerName(o);
    const drv = driverName(o);
    const money = amount(o);
    const moneyPart = money ? ` • ${money}` : '';

    // Legacy markers in orders.json still count as sent, so upgrading the
    // notifier cannot replay alerts the old version already delivered.
    // The receipt is fetched only once a timing window actually matched —
    // reading one per order would be hundreds of Firestore reads every 5 min.
    let receipt = null;
    const alreadySent = async (kind, legacyKey) => {
      if (legacy(o, legacyKey) !== '') return true;
      if (receipt === null) receipt = await loadReceipt(id);
      return String(receipt[kind] || '').trim() !== '';
    };

    if (
      st === 'NEW' &&
      timerEligible(orderTimeMs(o), 5) &&
      !(await alreadySent('not_assigned_5m', 'notTaken5mSentAt'))
    ) {
      const title = `${prettyBranch(bk)} • Not assigned`;
      const body = `${name} still NEW after 5 min${moneyPart}`;
      await send(ownerTopic(bk), title, body, {
        ...data,
        type: 'ORDER_LATE',
        kind: 'not_assigned_5m',
      });
      await saveReceipt(id, 'not_assigned_5m');
      sent++;
    }

    if (
      st === 'ASSIGNED_DRIVER' &&
      timerEligible(timeMs(o.assignedAt || o.statusUpdatedAt), 15) &&
      !(await alreadySent('pickup_late_15m', 'pickupLate15mSentAt'))
    ) {
      const title = `${prettyBranch(bk)} • Pickup late`;
      const body = `${drv} has not picked up ${name} order after 15 min${moneyPart}`;
      const lateData = { ...data, type: 'ORDER_LATE', kind: 'pickup_late_15m' };
      await send(ownerTopic(bk), title, body, lateData);
      await sendMany(driverTopics(o), title, body, lateData);
      await saveReceipt(id, 'pickup_late_15m');
      sent++;
    }

    if (
      st === 'PICKED_UP' &&
      timerEligible(timeMs(o.pickedUpAt || o.statusUpdatedAt), 10) &&
      !(await alreadySent('delivery_late_10m', 'deliveryLate10mSentAt'))
    ) {
      const title = `${prettyBranch(bk)} • Delivery late`;
      const body = `${drv} has not delivered ${name} order after 10 min${moneyPart}`;
      const lateData = { ...data, type: 'ORDER_LATE', kind: 'delivery_late_10m' };
      await send(ownerTopic(bk), title, body, lateData);
      await sendMany(driverTopics(o), title, body, lateData);
      await saveReceipt(id, 'delivery_late_10m');
      sent++;
    }
  }

  console.log(`TIMER_DONE sent=${sent} dry_run=${DRY_RUN}`);
  return sent;
}

function setOutput(name, value) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (outPath) fs.appendFileSync(outPath, `${name}=${value}\n`);
}

async function main() {
  const parsed = loadOrdersText(fs.readFileSync(ORDERS_PATH, 'utf8'));

  const repairOrderId = String(
    process.env.LIVE_ACTIVITY_REPAIR_ORDER_ID || WORKFLOW_REPAIR_ORDER_ID,
  ).trim();
  if (EVENT_NAME === 'workflow_dispatch' && repairOrderId) {
    const order = parsed.orders.find((candidate) => idOf(candidate) === repairOrderId);
    if (!order) throw new Error(`Live Activity repair order not found: ${repairOrderId}`);
    const repaired = await sendLiveActivity(
      order,
      repairOrderId,
      effectiveStatus(order),
    );
    if (!repaired) throw new Error(`Live Activity repair failed: ${repairOrderId}`);
    setOutput('orders_changed', 'false');
    console.log('LIVE_ACTIVITY_REPAIR_DONE', repairOrderId, effectiveStatus(order));
    return;
  }

  // Timer markers and delivery receipts live in Firestore now, so no run ever
  // needs to write orders.json back to the repo.
  setOutput('orders_changed', 'false');

  if (EVENT_NAME === 'push') {
    const changed = changedFilesForPush();
    console.log('changed_files', JSON.stringify(changed));
    if (!changed.includes(ORDERS_PATH)) {
      console.log(`ABORT: ${ORDERS_PATH} was not changed in this push.`);
      return;
    }
    await handlePushTransitions(parsed);
    return;
  }

  if (EVENT_NAME === 'schedule') {
    await handleMissedTransitions(parsed);
    await handleTimerAlerts(parsed);
    return;
  }

  if (EVENT_NAME === 'workflow_dispatch') {
    await handlePushTransitions(parsed);
    await handleMissedTransitions(parsed);
    await handleTimerAlerts(parsed);
    return;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
