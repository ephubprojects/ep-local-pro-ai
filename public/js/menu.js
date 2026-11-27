/**
 * EP Local Pro AI — menu.js
 * Public customer-facing digital menu page.
 * Loaded by /menu.html — no auth required.
 */

import { db } from '/js/firebase.js';
import {
  doc, getDoc, addDoc, updateDoc,
  collection, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── State ─────────────────────────────────────────────────
let bizId        = null;
let bizData      = null;    // full businesses doc
let menuProfile  = {};
let categories   = [];
let items        = [];
let settings     = {};
let cart         = [];      // [{ id, name, emoji, imageUrl, price, qty }]
let selectedTip  = 0;       // tip %
let orderType    = 'pickup';
let activeOrderId = null;
let statusTimer   = null;

// ── Boot ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

async function init() {
  const params = new URLSearchParams(location.search);
  bizId = params.get('id');

  if (!bizId) {
    showError();
    return;
  }

  try {
    const snap = await getDoc(doc(db, 'businesses', bizId));
    if (!snap.exists()) { showError(); return; }

    bizData     = snap.data();
    menuProfile = bizData.menuProfile    || {};
    categories  = Array.isArray(bizData.menuCategories) ? bizData.menuCategories : [];
    items       = Array.isArray(bizData.menuItems)      ? bizData.menuItems      : [];
    settings    = bizData.menuSettings   || {};

    renderHeader();
    renderCatNav();
    renderSections();
    wireCart();
    hideLoading();
  } catch (err) {
    console.error('menu init error:', err);
    showError();
  }
}

// ── Header ─────────────────────────────────────────────────
function renderHeader() {
  const p = menuProfile;

  // Cover image
  if (p.coverUrl) {
    const cover = document.getElementById('menu-cover');
    cover.style.backgroundImage = `url('${p.coverUrl}')`;
    cover.classList.remove('hidden');
  }

  // Logo
  if (p.logoUrl) {
    const logo = document.getElementById('menu-logo');
    logo.src = p.logoUrl;
    logo.classList.add('visible');
    document.getElementById('menu-logo-emoji').style.display = 'none';
  }

  // Name + tagline
  document.getElementById('menu-biz-name').textContent = p.restaurantName || bizData.name || 'Restaurant';
  document.title = (p.restaurantName || bizData.name || 'Restaurant') + ' — Menu';
  if (p.tagline) document.getElementById('menu-tagline').textContent = p.tagline;

  // Hours badge
  const badge = document.getElementById('menu-hours-badge');
  const status = getHoursStatus(p.hours || {});
  if (status) {
    badge.textContent = status.label;
    badge.className   = 'menu-hours-badge ' + status.cls;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }

  document.getElementById('menu-header').classList.remove('hidden');
}

function getHoursStatus(hours) {
  const days  = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const now   = new Date();
  const day   = days[now.getDay()];
  const h     = hours[day];
  if (!h) return null;
  if (!h.open) return { label: 'Closed today', cls: 'closed' };

  const [oh, om] = (h.openTime  || '00:00').split(':').map(Number);
  const [ch, cm] = (h.closeTime || '23:59').split(':').map(Number);
  const curMins  = now.getHours() * 60 + now.getMinutes();
  const openMins = oh * 60 + om;
  const closeMins= ch * 60 + cm;

  if (curMins >= openMins && curMins < closeMins) {
    return { label: `Open · Closes ${h.closeTime}`, cls: 'open' };
  }
  if (curMins < openMins) {
    return { label: `Opens ${h.openTime}`, cls: 'closed' };
  }
  return { label: 'Closed', cls: 'closed' };
}

// ── Category nav ───────────────────────────────────────────
function renderCatNav() {
  const nav  = document.getElementById('cat-nav');
  const cats = categories.filter(c => c.enabled !== false);
  if (!cats.length) return;

  const specials = items.filter(it => it.isSpecial && it.available !== false);
  let html = '';
  if (specials.length) {
    html += `<button class="cat-pill" data-cat="specials">⭐ Specials</button>`;
  }
  html += cats.map(c => `<button class="cat-pill" data-cat="${esc(c.id)}">${esc(c.icon || '')} ${esc(c.name)}</button>`).join('');
  nav.innerHTML = html;
  nav.classList.remove('hidden');

  nav.querySelectorAll('.cat-pill').forEach(btn => {
    btn.onclick = () => scrollToSection(btn.dataset.cat);
  });
}

function scrollToSection(catId) {
  const el = document.getElementById('cat-' + catId);
  if (!el) return;
  const offset = document.getElementById('cat-nav').offsetHeight + 8;
  const top    = el.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top, behavior: 'smooth' });
  updateActivePill(catId);
}

function updateActivePill(catId) {
  document.querySelectorAll('.cat-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.cat === catId);
  });
}

// ── Sections ───────────────────────────────────────────────
function renderSections() {
  // Specials
  const specials = items.filter(it => it.isSpecial && it.available !== false);
  if (specials.length) {
    const sec = document.getElementById('specials-section');
    sec.classList.remove('hidden');
    sec.id = 'cat-specials';
    sec.innerHTML = `<div class="specials-title">⭐ Today's Specials</div><div class="items-grid">${specials.map(itemCard).join('')}</div>`;
  }

  // Category sections
  const cats = categories.filter(c => c.enabled !== false);
  const container = document.getElementById('menu-sections');
  container.innerHTML = cats.map(cat => {
    const catItems = items.filter(it => it.categoryId === cat.id);
    if (!catItems.length) return '';
    return `<div class="cat-section" id="cat-${esc(cat.id)}">
      <div class="cat-section-title">${esc(cat.icon || '')} ${esc(cat.name)}</div>
      <div class="items-grid">${catItems.map(itemCard).join('')}</div>
    </div>`;
  }).join('');

  // Uncategorized items
  const uncatItems = items.filter(it => !it.categoryId && it.available !== false);
  if (uncatItems.length) {
    container.innerHTML += `<div class="cat-section" id="cat-other">
      <div class="cat-section-title">🍽️ Other Items</div>
      <div class="items-grid">${uncatItems.map(itemCard).join('')}</div>
    </div>`;
  }

  document.getElementById('menu-main').classList.remove('hidden');

  // Wire add buttons
  document.querySelectorAll('[data-add-id]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.addId;
      if (btn.disabled) return;
      addToCart(id);
    };
  });

  // Scroll spy
  const sections = document.querySelectorAll('.cat-section, #cat-specials');
  if (sections.length) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          updateActivePill(entry.target.id.replace('cat-', ''));
        }
      });
    }, { rootMargin: '-50% 0px -40% 0px' });
    sections.forEach(s => observer.observe(s));
  }
}

function itemCard(item) {
  const unavail  = item.available === false;
  const imgHtml  = item.imageUrl
    ? `<img class="menu-card-img" src="${esc(item.imageUrl)}" alt="${esc(item.name)}" loading="lazy" />`
    : `<div class="menu-card-emoji">${esc(item.emoji || '🍽️')}</div>`;
  const badges = [
    item.isSpecial  ? '<span class="menu-badge mb-special">⭐ Special</span>' : '',
    item.spicyLevel ? `<span class="menu-badge mb-spicy">${'🌶️'.repeat(item.spicyLevel)}</span>` : '',
    unavail         ? '<span class="menu-badge mb-off">Unavailable</span>' : '',
  ].filter(Boolean).join('');

  return `<div class="menu-card${unavail ? ' unavail' : ''}">
    ${imgHtml}
    <div class="menu-card-body">
      <div class="menu-card-name">${esc(item.name)}</div>
      ${item.description ? `<div class="menu-card-desc">${esc(item.description)}</div>` : ''}
      ${badges ? `<div class="menu-card-badges">${badges}</div>` : ''}
      <div class="menu-card-row">
        <span class="menu-card-price">${fmtCurrency(item.price)}</span>
        <button class="menu-add-btn" data-add-id="${esc(item.id)}" ${unavail ? 'disabled' : ''} aria-label="Add ${esc(item.name)}">+</button>
      </div>
    </div>
  </div>`;
}

// ── Cart ───────────────────────────────────────────────────
function addToCart(itemId) {
  const item = items.find(it => it.id === itemId);
  if (!item) return;
  const existing = cart.find(c => c.id === itemId);
  if (existing) {
    existing.qty++;
  } else {
    cart.push({ id: item.id, name: item.name, emoji: item.emoji || '🍽️', imageUrl: item.imageUrl || '', price: item.price, qty: 1 });
  }
  renderCartBody();
  updateFab();
  if (cart.length === 1) openCart();
}

function changeQty(itemId, delta) {
  const idx = cart.findIndex(c => c.id === itemId);
  if (idx === -1) return;
  cart[idx].qty += delta;
  if (cart[idx].qty <= 0) cart.splice(idx, 1);
  renderCartBody();
  updateFab();
}

function renderCartBody() {
  const body     = document.getElementById('cart-body');
  const placeBtn = document.getElementById('place-order-btn');

  if (!cart.length) {
    body.innerHTML = '<div class="cart-empty">Your cart is empty</div>';
    placeBtn.disabled = true;
    return;
  }

  placeBtn.disabled = false;

  const taxRate  = (settings.taxRate || 0) / 100;
  const subtotal = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const tipAmt   = subtotal * (selectedTip / 100);
  const tax      = subtotal * taxRate;
  const total    = subtotal + tipAmt + tax;

  // Order types
  const allowedTypes = [];
  if (settings.allowPickup  !== false) allowedTypes.push('pickup');
  if (settings.allowDineIn  !== false) allowedTypes.push('dine-in');
  if (settings.allowDelivery)          allowedTypes.push('delivery');
  if (!allowedTypes.includes(orderType)) orderType = allowedTypes[0] || 'pickup';

  const otLabels = { pickup: '🥡 Pickup', 'dine-in': '🪑 Dine-In', delivery: '🚗 Delivery' };
  const otHtml   = allowedTypes.map(t =>
    `<button class="ot-btn${orderType === t ? ' active' : ''}" data-ot="${t}">${otLabels[t]}</button>`
  ).join('');

  // Tip options
  const tipOptions = Array.isArray(settings.tipOptions) && settings.tipOptions.length
    ? settings.tipOptions : [15, 18, 20, 25];
  const tipHtml = [0, ...tipOptions].map(pct =>
    `<button class="tip-btn${selectedTip === pct ? ' active' : ''}" data-tip="${pct}">${pct === 0 ? 'No tip' : pct + '%'}</button>`
  ).join('');

  body.innerHTML = `
    ${cart.map(c => `
      <div class="cart-item">
        <span class="cart-item-emoji">${esc(c.emoji)}</span>
        <div class="cart-item-info">
          <div class="cart-item-name">${esc(c.name)}</div>
          <div class="cart-item-price">${fmtCurrency(c.price)} each</div>
        </div>
        <div class="cart-qty-wrap">
          <button class="cart-qty-btn" data-minus="${esc(c.id)}">−</button>
          <span class="cart-qty-num">${c.qty}</span>
          <button class="cart-qty-btn" data-plus="${esc(c.id)}">+</button>
        </div>
      </div>`).join('')}

    <div class="cart-totals">
      <div class="cart-total-row"><span>Subtotal</span><span>${fmtCurrency(subtotal)}</span></div>
      ${tax > 0 ? `<div class="cart-total-row"><span>Tax (${settings.taxRate}%)</span><span>${fmtCurrency(tax)}</span></div>` : ''}
      ${tipAmt > 0 ? `<div class="cart-total-row"><span>Tip (${selectedTip}%)</span><span>${fmtCurrency(tipAmt)}</span></div>` : ''}
      <div class="cart-total-row grand"><span>Total</span><span>${fmtCurrency(total)}</span></div>
    </div>

    <div class="tip-label">Tip</div>
    <div class="tip-row">${tipHtml}</div>

    <div class="ot-label">Order type</div>
    <div class="ot-row">${otHtml}</div>

    <div id="table-row" class="${orderType === 'dine-in' ? 'visible' : ''}">
      <label class="ot-label" for="table-num">Table number</label>
      <input type="text" id="table-num" placeholder="e.g. 7" />
    </div>

    <div>
      <div class="ot-label">Special instructions <span style="font-weight:400;">(optional)</span></div>
      <textarea class="cart-notes" id="cart-notes" rows="2" placeholder="Allergies, substitutions…"></textarea>
    </div>`;

  // Wire qty buttons
  body.querySelectorAll('[data-minus]').forEach(btn => btn.onclick = () => changeQty(btn.dataset.minus, -1));
  body.querySelectorAll('[data-plus]').forEach(btn  => btn.onclick = () => changeQty(btn.dataset.plus,   1));

  // Wire tip buttons
  body.querySelectorAll('[data-tip]').forEach(btn => {
    btn.onclick = () => { selectedTip = parseInt(btn.dataset.tip); renderCartBody(); };
  });

  // Wire order type buttons
  body.querySelectorAll('[data-ot]').forEach(btn => {
    btn.onclick = () => {
      orderType = btn.dataset.ot;
      renderCartBody();
    };
  });
}

function updateFab() {
  const fab   = document.getElementById('cart-fab');
  const count = cart.reduce((s, c) => s + c.qty, 0);
  document.getElementById('cart-fab-count').textContent = count;
  fab.classList.toggle('hidden', count === 0);
}

function openCart() {
  document.getElementById('cart-backdrop').classList.add('open');
  document.getElementById('cart-panel').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeCart() {
  document.getElementById('cart-backdrop').classList.remove('open');
  document.getElementById('cart-panel').classList.remove('open');
  document.body.style.overflow = '';
}

function wireCart() {
  document.getElementById('cart-fab').onclick    = openCart;
  document.getElementById('cart-close-btn').onclick = closeCart;
  document.getElementById('cart-backdrop').onclick  = closeCart;
  document.getElementById('place-order-btn').onclick = placeOrder;
  document.getElementById('new-order-btn').onclick   = resetOrder;
}

// ── Place order ────────────────────────────────────────────
async function placeOrder() {
  const btn = document.getElementById('place-order-btn');
  btn.disabled = true;
  btn.textContent = 'Placing…';

  const taxRate   = (settings.taxRate || 0) / 100;
  const subtotal  = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const tipAmt    = subtotal * (selectedTip / 100);
  const tax       = subtotal * taxRate;
  const total     = subtotal + tipAmt + tax;
  const tableNum  = document.getElementById('table-num')?.value?.trim() || '';
  const notes     = document.getElementById('cart-notes')?.value?.trim() || '';
  const orderCode = Math.random().toString(36).slice(2, 6).toUpperCase();

  const orderData = {
    businessId:   bizId,
    businessName: menuProfile.restaurantName || bizData.name || '',
    slug:         bizData.slug || '',
    orderCode,
    orderType,
    tableNumber:  tableNum,
    items:        cart.map(c => ({ id: c.id, name: c.name, emoji: c.emoji, price: c.price, qty: c.qty })),
    subtotal:     +subtotal.toFixed(2),
    tax:          +tax.toFixed(2),
    tip:          +tipAmt.toFixed(2),
    total:        +total.toFixed(2),
    notes,
    status:       'new',
    createdAt:    serverTimestamp(),
    updatedAt:    serverTimestamp(),
  };

  try {
    const ref = await addDoc(collection(db, 'orders'), orderData);
    activeOrderId = ref.id;
    closeCart();
    showConfirmation(orderCode);
    startStatusPolling(ref.id);
  } catch (err) {
    console.error('placeOrder error:', err);
    btn.disabled = false;
    btn.textContent = 'Place Order →';
    alert('Could not place order. Please try again.');
  }
}

function showConfirmation(orderCode) {
  document.getElementById('confirm-code').textContent = '#' + orderCode;
  document.getElementById('confirm-status').textContent = 'Status: New order received';
  document.getElementById('confirm-screen').classList.add('show');
}

function startStatusPolling(orderId) {
  const statuses = {
    new:       'Status: New order received',
    confirmed: 'Status: Order confirmed ✓',
    preparing: 'Status: Preparing your order 🍳',
    ready:     'Status: Ready for pickup! 🎉',
    completed: 'Status: Completed ✓',
  };

  statusTimer = setInterval(async () => {
    try {
      const snap = await getDoc(doc(db, 'orders', orderId));
      if (!snap.exists()) return;
      const status = snap.data().status || 'new';
      const el = document.getElementById('confirm-status');
      if (el) el.textContent = statuses[status] || 'Status: ' + status;
      if (status === 'completed') clearInterval(statusTimer);
    } catch (_) {}
  }, 10_000);
}

function resetOrder() {
  clearInterval(statusTimer);
  cart         = [];
  selectedTip  = 0;
  orderType    = 'pickup';
  activeOrderId = null;
  document.getElementById('confirm-screen').classList.remove('show');
  renderCartBody();
  updateFab();
}

// ── Utilities ──────────────────────────────────────────────
function fmtCurrency(val) {
  if (val == null || isNaN(val)) return '$0.00';
  return '$' + Number(val).toFixed(2);
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function hideLoading() {
  const el = document.getElementById('menu-loading');
  if (el) { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }
}

function showError() {
  hideLoading();
  document.getElementById('menu-error').style.display = 'block';
}
