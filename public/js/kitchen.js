/**
 * EP Local Pro AI — kitchen.js
 * Kitchen Display System (KDS) logic.
 * Module script — loaded by /kitchen.html
 */

import { db } from '/js/firebase.js';
import {
  collection, query, where, onSnapshot, doc, updateDoc,
  serverTimestamp, orderBy, getDocs
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── State ──────────────────────────────────────────────────
let bizSlug   = '';
let bizId     = null;
let soundEnabled = true;
let orderTimers  = {};           // { orderId: intervalId }
let knownOrderIds = new Set();   // track seen IDs to detect truly new arrivals
let unsubscribeOrders = null;

const NEW_ALERT_MIN  = 15;
const PREP_ALERT_MIN = 20;

// ── Boot ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

async function init() {
  startClock();
  wireSoundToggle();

  const params = new URLSearchParams(window.location.search);
  bizSlug = params.get('slug') || '';

  if (!bizSlug) {
    setLoadingMsg('No restaurant slug in URL. Use /kitchen?slug=YOUR-SLUG');
    return;
  }

  try {
    await loadBusiness();
    subscribeToOrders();
    hideLoading();
  } catch (err) {
    console.error('KDS init error:', err);
    setLoadingMsg('Could not connect. Check your slug and try again.');
    setOffline();
  }
}

// ── Clock ──────────────────────────────────────────────────
function startClock() {
  function tick() {
    const now  = new Date();
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const date = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    document.getElementById('kds-time').textContent = time;
    document.getElementById('kds-date').textContent = date;
  }
  tick();
  setInterval(tick, 1000);
}

// ── Sound toggle ───────────────────────────────────────────
function wireSoundToggle() {
  const btn = document.getElementById('kds-sound-toggle');
  btn.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    btn.classList.toggle('muted', !soundEnabled);
    btn.title = soundEnabled ? 'Toggle sound alerts (on)' : 'Toggle sound alerts (off)';
    btn.textContent = soundEnabled ? '🔔' : '🔕';
  });
}

// ── Load business ──────────────────────────────────────────
async function loadBusiness() {
  // Try `businesses` collection first, fall back to `demos`
  const collections = ['businesses', 'demos'];

  for (const col of collections) {
    const q = query(collection(db, col), where('slug', '==', bizSlug));
    const snap = await getDocs(q);
    if (!snap.empty) {
      const bizDoc = snap.docs[0];
      bizId = bizDoc.id;
      const data = bizDoc.data();
      const name = data.name || data.businessName || bizSlug;
      document.getElementById('kds-biz-name').textContent = name;
      return;
    }
  }

  throw new Error(`No business found with slug: ${bizSlug}`);
}

// ── Subscribe to live orders ───────────────────────────────
function subscribeToOrders() {
  if (unsubscribeOrders) unsubscribeOrders();

  const q = query(
    collection(db, 'orders'),
    where('businessId', '==', bizId),
    where('status', 'in', ['new', 'confirmed', 'preparing', 'ready']),
    orderBy('createdAt', 'asc')
  );

  unsubscribeOrders = onSnapshot(
    q,
    (snap) => {
      setOnline();
      renderSnapshot(snap);
    },
    (err) => {
      console.error('Orders snapshot error:', err);
      setOffline();
    }
  );
}

// ── Render snapshot ────────────────────────────────────────
function renderSnapshot(snap) {
  // Stop existing age timers — we'll re-create them after rendering
  clearAllTimers();

  const colMap = {
    new:       document.getElementById('orders-new'),
    confirmed: document.getElementById('orders-new'),   // confirmed shows in NEW column
    preparing: document.getElementById('orders-preparing'),
    ready:     document.getElementById('orders-ready'),
  };

  // Clear columns
  for (const colEl of Object.values(new Set(Object.values(colMap)))) {
    colEl.innerHTML = '';
  }
  // Clear both unique column elements
  document.getElementById('orders-new').innerHTML       = '';
  document.getElementById('orders-preparing').innerHTML = '';
  document.getElementById('orders-ready').innerHTML     = '';

  const counts = { new: 0, preparing: 0, ready: 0 };
  const newlyArrived = [];

  snap.forEach((docSnap) => {
    const id   = docSnap.id;
    const data = docSnap.data();
    const status = data.status || 'new';

    const targetCol = colMap[status];
    if (!targetCol) return;

    // Track new arrivals for sound
    if (!knownOrderIds.has(id)) {
      newlyArrived.push(id);
      knownOrderIds.add(id);
    }

    const isNew = newlyArrived.includes(id);
    const card  = buildCard(id, data, isNew);
    targetCol.appendChild(card);

    // Column counter
    if (status === 'new' || status === 'confirmed') counts.new++;
    else if (status === 'preparing') counts.preparing++;
    else if (status === 'ready')     counts.ready++;

    // Start age timer for this card
    startAgeTimer(id, data);
  });

  // Empty-state placeholders
  if (!document.getElementById('orders-new').children.length) {
    document.getElementById('orders-new').innerHTML = '<div class="kds-empty">No orders</div>';
  }
  if (!document.getElementById('orders-preparing').children.length) {
    document.getElementById('orders-preparing').innerHTML = '<div class="kds-empty">No orders</div>';
  }
  if (!document.getElementById('orders-ready').children.length) {
    document.getElementById('orders-ready').innerHTML = '<div class="kds-empty">No orders</div>';
  }

  // Update counts
  document.getElementById('count-new').textContent       = counts.new;
  document.getElementById('count-preparing').textContent = counts.preparing;
  document.getElementById('count-ready').textContent     = counts.ready;

  // Play beep for new arrivals
  if (newlyArrived.length > 0) {
    playBeep();
  }
}

// ── Build order card DOM element ───────────────────────────
function buildCard(id, data, isNewArrival) {
  const card = document.createElement('div');
  card.classList.add('kds-card');
  if (isNewArrival) card.classList.add('kds-new-flash');
  card.dataset.orderId = id;
  card.dataset.status  = data.status;

  const orderNum    = data.orderNumber || data.number || ('#' + id.slice(-4).toUpperCase());
  const status      = data.status || 'new';
  const orderType   = (data.orderType || data.type || 'pickup').toLowerCase();
  const tableNumber = data.tableNumber || data.table || null;
  const items       = data.items || [];
  const total       = data.total != null ? formatCurrency(data.total) : null;
  const createdAt   = data.createdAt?.toDate?.() || (data.createdAt ? new Date(data.createdAt) : new Date());
  const ageMin      = getAgeMinutes(createdAt);

  // ── Card header ──
  const typeBadgeHtml = `<span class="kds-type-badge ${orderType}">${capitalize(orderType)}</span>`;

  card.innerHTML = `
    <div class="kds-card-header">
      <div class="kds-order-num">${escHtml(orderNum)}</div>
      <div class="kds-card-meta">
        ${typeBadgeHtml}
        <span class="kds-timestamp">${formatTime(createdAt)}</span>
        <span class="kds-card-age" id="age-${id}">${ageMin}m ago</span>
      </div>
    </div>
    ${tableNumber ? `
    <div class="kds-table">
      <span class="kds-table-label">Table</span>
      <span>${escHtml(String(tableNumber))}</span>
    </div>` : ''}
    <ul class="kds-items" id="items-${id}">
      ${renderItems(items)}
    </ul>
    <div class="kds-card-footer">
      <span class="kds-order-total">${total ? `Total: <strong>${total}</strong>` : ''}</span>
      ${renderActionButton(id, status)}
    </div>
  `;

  // Wire item line-through toggle
  card.querySelectorAll('.kds-item').forEach((li) => {
    li.addEventListener('click', () => li.classList.toggle('done'));
  });

  // Apply urgent class immediately if already over threshold
  applyUrgentClass(card, status, ageMin);

  return card;
}

function renderItems(items) {
  if (!items.length) return '<li class="kds-item"><span class="kds-item-name">(no items)</span></li>';
  return items.map((item) => {
    const emoji = item.emoji || '🍽';
    const qty   = item.quantity || item.qty || 1;
    const name  = item.name || item.title || 'Item';
    return `
      <li class="kds-item">
        <span class="kds-item-emoji">${emoji}</span>
        <span class="kds-item-qty">${qty}×</span>
        <span class="kds-item-name">${escHtml(name)}</span>
      </li>`;
  }).join('');
}

function renderActionButton(id, status) {
  if (status === 'new' || status === 'confirmed') {
    return `<button class="kds-btn kds-btn-start" onclick="window._kdsMove('${id}', 'preparing')">▶ Start Preparing</button>`;
  }
  if (status === 'preparing') {
    return `<button class="kds-btn kds-btn-ready" onclick="window._kdsMove('${id}', 'ready')">✓ Mark Ready</button>`;
  }
  if (status === 'ready') {
    return `<button class="kds-btn kds-btn-complete" onclick="window._kdsMove('${id}', 'completed')">Complete ✓</button>`;
  }
  return '';
}

// Expose moveOrder globally so inline onclick handlers can reach it
window._kdsMove = moveOrder;

// ── Move order ─────────────────────────────────────────────
async function moveOrder(orderId, newStatus) {
  const statusTimestamps = {
    preparing: { preparingAt: serverTimestamp() },
    ready:     { readyAt:     serverTimestamp() },
    completed: { completedAt: serverTimestamp() },
  };

  try {
    await updateDoc(doc(db, 'orders', orderId), {
      status: newStatus,
      ...(statusTimestamps[newStatus] || {}),
    });
    // Snapshot listener will re-render automatically.
    // If moving to 'completed', remove from knownOrderIds so it won't retrigger sound
    if (newStatus === 'completed') {
      knownOrderIds.delete(orderId);
    }
  } catch (err) {
    console.error('moveOrder error:', err);
    alert('Could not update order. Check your connection.');
  }
}

// ── Age timers ─────────────────────────────────────────────
function startAgeTimer(orderId, data) {
  const createdAt = data.createdAt?.toDate?.() || (data.createdAt ? new Date(data.createdAt) : new Date());
  const status    = data.status || 'new';

  const intervalId = setInterval(() => {
    const ageEl = document.getElementById(`age-${orderId}`);
    if (!ageEl) {
      clearInterval(intervalId);
      delete orderTimers[orderId];
      return;
    }

    const ageMin = getAgeMinutes(createdAt);
    ageEl.textContent = `${ageMin}m ago`;

    // Apply urgent styling
    const card = ageEl.closest('.kds-card');
    if (card) {
      applyUrgentClass(card, status, ageMin);
    }
  }, 60_000);

  orderTimers[orderId] = intervalId;
}

function applyUrgentClass(card, status, ageMin) {
  const isNewCol  = status === 'new' || status === 'confirmed';
  const isPrep    = status === 'preparing';
  const urgent    = (isNewCol && ageMin >= NEW_ALERT_MIN) || (isPrep && ageMin >= PREP_ALERT_MIN);
  card.classList.toggle('kds-urgent', urgent);
}

function clearAllTimers() {
  for (const id of Object.keys(orderTimers)) {
    clearInterval(orderTimers[id]);
  }
  orderTimers = {};
}

// ── Sound ──────────────────────────────────────────────────
function playBeep() {
  if (!soundEnabled) return;
  try {
    const ctx  = new AudioContext();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.5);
  } catch (e) {
    // AudioContext may be blocked until a user gesture — that's fine
    console.warn('KDS beep blocked:', e.message);
  }
}

// ── Online / offline indicator ─────────────────────────────
function setOnline() {
  const el = document.getElementById('kds-status');
  el.classList.remove('offline');
  document.getElementById('kds-status-text').textContent = 'Online';
}

function setOffline() {
  const el = document.getElementById('kds-status');
  el.classList.add('offline');
  document.getElementById('kds-status-text').textContent = 'Offline';
}

// ── Loading overlay helpers ────────────────────────────────
function hideLoading() {
  const el = document.getElementById('kds-loading');
  if (el) {
    el.classList.add('hidden');
    setTimeout(() => el.remove(), 450);
  }
}

function setLoadingMsg(msg) {
  const el = document.getElementById('kds-loading-msg');
  if (el) el.textContent = msg;
  const spinner = document.querySelector('.kds-spinner');
  if (spinner) spinner.style.display = 'none';
}

// ── Utilities ──────────────────────────────────────────────
function getAgeMinutes(date) {
  return Math.floor((Date.now() - date.getTime()) / 60_000);
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
