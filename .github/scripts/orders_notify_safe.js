const fs = require('fs');
const { execFileSync } = require('child_process');

const ORDERS_PATH = process.env.ORDERS_PATH || 'orders.json';
const BRAND_ID = process.env.BRAND_ID || 'mahfouz_market';
const OWNER_TOPIC = (process.env.OWNER_TOPIC || '').trim();
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === 'true';
const RECENT_MS = Number(process.env.RECENT_WINDOW_HOURS || 12) * 60 * 60 * 1000;
const TIMER_LOOKBACK_MS =
  Number(process.env.TIMER_LOOKBACK_HOURS || 24) * 60 * 60 * 1000;
const EVENT_NAME = process.env.GITHUB_EVENT_NAME || '';
const IS_NOUNAS = BRAND_ID === 'nounas_food';

// Mahfouz and Nouna intentionally share one Firebase project. Topic names
// alone cannot enforce the app boundary when a stale registration remains on
// the other brand's topic. Bind every platform payload to the intended binary.
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

function saveOrders(parsed) {
  const root = parsed.wrapped ? { ...parsed.root, orders: parsed.orders } : parsed.orders;
  fs.writeFileSync(ORDERS_PATH, JSON.stringify(root, null, 2) + '\n', 'utf8');
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

function driverTopic(o) {
  const did = String(o.driverId || o.assignedDriverId || '').trim();
  return did ? `drv_${BRAND_ID}_${branchKey(o)}_${did}` : '';
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

async function ensureMessaging() {
  if (DRY_RUN) return null;
  if (messaging) return messaging;
  const admin = require('firebase-admin');
  const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
  if (!svc.project_id) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON');
  if (svc.private_key && typeof svc.private_key === 'string') {
    svc.private_key = svc.private_key.replace(/\\n/g, '\n');
  }
  admin.initializeApp({ credential: admin.credential.cert(svc) });
  messaging = admin.messaging();
  return messaging;
}

async function send(topic, title, body, data) {
  if (!topic) return;
  if (DRY_RUN) {
    console.log('DRY_SEND', JSON.stringify({ topic, title, body, data }));
    return;
  }
  const collapseId = notificationCollapseId(data);
  const msg = {
    topic,
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
  console.log('SENT', topic, sent, data && data.orderId ? `order=${data.orderId}` : '');
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
    driverId: String(o.driverId || o.assignedDriverId || ''),
    customer_name: customerName(o),
    delivery_man_name: driverName(o),
    totalUsd: String(o.totalUsd ?? ''),
    totalLbp: String(o.totalLbp ?? ''),
    pickup: String(isPickup(o)),
  };
}

async function handlePushTransitions(parsed) {
  const curOrders = parsed.orders.filter((o) => o && typeof o === 'object');
  const prevOrders = readPrevOrders().filter((o) => o && typeof o === 'object');
  if (EVENT_NAME === 'push' && curOrders.length > 0 && prevOrders.length === 0) {
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
    const curDriver = String(o.driverId || o.assignedDriverId || '').trim();
    const oldDriver = old ? String(old.driverId || old.assignedDriverId || '').trim() : '';
    const isNewOrder = !old && curSt === 'NEW';
    const assignedNow =
      curSt === 'ASSIGNED_DRIVER' &&
      curDriver &&
      (oldSt !== 'ASSIGNED_DRIVER' || curDriver !== oldDriver);
    const pickedUpNow = curSt === 'PICKED_UP' && oldSt !== 'PICKED_UP';
    const readyPickupNow = curSt === 'READY_TO_PICKUP' && oldSt !== 'READY_TO_PICKUP';
    const deliveredNow = curSt === 'DELIVERED' && oldSt !== 'DELIVERED';
    const cancelledNow = curSt === 'CANCELLED' && oldSt !== 'CANCELLED';
    if (
      !isNewOrder &&
      !assignedNow &&
      !pickedUpNow &&
      !readyPickupNow &&
      !deliveredNow &&
      !cancelledNow
    ) {
      continue;
    }

    const bk = branchKey(o);
    const name = customerName(o);
    const drv = driverName(o);
    const money = amount(o);
    const moneyPart = money ? ` • ${money}` : '';
    const data = baseData(o, id, bk);

    if (isNewOrder) {
      await send(ownerTopic(bk), `${prettyBranch(bk)} • ${name}`, `New order${moneyPart}`, {
        ...data,
        type: 'NEW_ORDER',
        kind: 'new_order',
      });
      sentGroups++;
    }
    if (assignedNow) {
      await send(orderTopic(id), 'Driver assigned', `The driver ${drv} has been assigned to your order.`, {
        ...data,
        type: 'ORDER_ASSIGNED',
        kind: 'delivery_assigned',
      });
      await send(
        ownerTopic(bk),
        `${prettyBranch(bk)} • Delivery assigned`,
        `${name} order assigned to ${drv}${moneyPart}`,
        { ...data, type: 'ORDER_ASSIGNED', kind: 'delivery_assigned' },
      );
      await send(driverTopic(o), 'New order assigned', `${name} order assigned to you${moneyPart}`, {
        ...data,
        type: 'ORDER_ASSIGNED',
        kind: 'delivery_assigned',
      });
      sentGroups++;
    }
    if (readyPickupNow) {
      await send(orderTopic(id), 'Order ready to pick up', `Your order is ready to pick up${moneyPart}`, {
        ...data,
        type: 'ORDER_READY_TO_PICKUP',
        kind: 'ready_to_pickup',
      });
      await send(
        ownerTopic(bk),
        `${prettyBranch(bk)} • Ready to pick up`,
        `Order ready to pick up${moneyPart} • ${name}`,
        { ...data, type: 'ORDER_READY_TO_PICKUP', kind: 'ready_to_pickup' },
      );
      sentGroups++;
    }
    if (pickedUpNow) {
      await send(orderTopic(id), 'Picked up', 'Your order has been picked up.', {
        ...data,
        type: 'ORDER_PICKED_UP',
        kind: 'picked_up',
      });
      await send(ownerTopic(bk), `Picked up • ${prettyBranch(bk)}`, `Picked up by ${drv} • ${name}`, {
        ...data,
        type: 'ORDER_PICKED_UP',
        kind: 'picked_up',
      });
      sentGroups++;
    }
    if (deliveredNow) {
      const dur = durationStr(o.createdAt || o.ts, o.deliveredAt || o.statusUpdatedAt);
      const timePart = dur ? ` • Time: ${dur}` : '';
      const body = `${name}${moneyPart} • Driver: ${drv}${timePart}`;
      await send(orderTopic(id), 'Delivered', 'Your order has been delivered.', {
        ...data,
        type: 'ORDER_DELIVERED',
        kind: 'delivered',
      });
      await send(ownerTopic(bk), `Delivered • ${prettyBranch(bk)}`, body, {
        ...data,
        type: 'ORDER_DELIVERED',
        kind: 'delivered',
      });
      await send(driverTopic(o), `Delivered • ${prettyBranch(bk)}`, body, {
        ...data,
        type: 'ORDER_DELIVERED',
        kind: 'delivered',
      });
      sentGroups++;
    }
    if (cancelledNow) {
      await send(orderTopic(id), 'Order cancelled', 'Your order has been cancelled.', {
        ...data,
        type: 'ORDER_CANCELLED',
        kind: 'cancelled',
      });
      await send(ownerTopic(bk), `Cancelled • ${prettyBranch(bk)}`, `${name}${moneyPart}`, {
        ...data,
        type: 'ORDER_CANCELLED',
        kind: 'cancelled',
      });
      sentGroups++;
    }
  }

  console.log(`PUSH_DONE sent_groups=${sentGroups} skipped=${skipped} dry_run=${DRY_RUN}`);
  return sentGroups;
}

function timerEligible(baseMs, minMinutes) {
  if (!baseMs) return false;
  const age = Date.now() - baseMs;
  return age >= minMinutes * 60 * 1000 && age <= TIMER_LOOKBACK_MS;
}

async function handleTimerAlerts(parsed) {
  let changed = false;
  let sent = 0;
  const nowIso = new Date().toISOString();

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

    if (!o.notifs || typeof o.notifs !== 'object') {
      o.notifs = {};
    }

    if (
      st === 'NEW' &&
      !o.notifs.notTaken5mSentAt &&
      timerEligible(orderTimeMs(o), 5)
    ) {
      const title = `${prettyBranch(bk)} • Not assigned`;
      const body = `${name} still NEW after 5 min${moneyPart}`;
      await send(ownerTopic(bk), title, body, {
        ...data,
        type: 'ORDER_LATE',
        kind: 'not_assigned_5m',
      });
      o.notifs.notTaken5mSentAt = nowIso;
      changed = true;
      sent++;
    }

    if (
      st === 'ASSIGNED_DRIVER' &&
      !o.notifs.pickupLate15mSentAt &&
      timerEligible(timeMs(o.assignedAt || o.statusUpdatedAt), 15)
    ) {
      const title = `${prettyBranch(bk)} • Pickup late`;
      const body = `${drv} has not picked up ${name} order after 15 min${moneyPart}`;
      const lateData = { ...data, type: 'ORDER_LATE', kind: 'pickup_late_15m' };
      await send(ownerTopic(bk), title, body, lateData);
      await send(driverTopic(o), title, body, lateData);
      o.notifs.pickupLate15mSentAt = nowIso;
      changed = true;
      sent++;
    }

    if (
      st === 'PICKED_UP' &&
      !o.notifs.deliveryLate10mSentAt &&
      timerEligible(timeMs(o.pickedUpAt || o.statusUpdatedAt), 10)
    ) {
      const title = `${prettyBranch(bk)} • Delivery late`;
      const body = `${drv} has not delivered ${name} order after 10 min${moneyPart}`;
      const lateData = { ...data, type: 'ORDER_LATE', kind: 'delivery_late_10m' };
      await send(ownerTopic(bk), title, body, lateData);
      await send(driverTopic(o), title, body, lateData);
      o.notifs.deliveryLate10mSentAt = nowIso;
      changed = true;
      sent++;
    }
  }

  if (changed && !DRY_RUN) saveOrders(parsed);
  console.log(`TIMER_DONE sent=${sent} changed=${changed} dry_run=${DRY_RUN}`);
  return { sent, changed: changed && !DRY_RUN };
}

function setOutput(name, value) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (outPath) fs.appendFileSync(outPath, `${name}=${value}\n`);
}

async function main() {
  const parsed = loadOrdersText(fs.readFileSync(ORDERS_PATH, 'utf8'));

  if (EVENT_NAME === 'push') {
    const changed = changedFilesForPush();
    console.log('changed_files', JSON.stringify(changed));
    if (!changed.includes(ORDERS_PATH)) {
      console.log(`ABORT: ${ORDERS_PATH} was not changed in this push.`);
      setOutput('orders_changed', 'false');
      return;
    }
    await handlePushTransitions(parsed);
    setOutput('orders_changed', 'false');
    return;
  }

  if (EVENT_NAME === 'schedule') {
    const result = await handleTimerAlerts(parsed);
    setOutput('orders_changed', result.changed ? 'true' : 'false');
    return;
  }

  if (EVENT_NAME === 'workflow_dispatch') {
    await handlePushTransitions(parsed);
    const result = await handleTimerAlerts(parsed);
    setOutput('orders_changed', result.changed ? 'true' : 'false');
    return;
  }

  setOutput('orders_changed', 'false');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
