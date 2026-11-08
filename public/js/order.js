/**
 * EP Local Pro AI — order.js
 * Customer-facing AI ordering page logic.
 * ElevenLabs SDK is loaded lazily only when the user starts a call.
 * Keep this file under 30KB.
 */

import { db } from '/js/firebase.js';
import {
  doc,
  getDoc,
  addDoc,
  collection,
  serverTimestamp,
  query,
  where,
  getDocs
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── State ────────────────────────────────────────────────
let bizData        = null;
let cart           = [];   // [{ itemId, name, price, qty, emoji }]
let orderType      = 'pickup';
let currentSession = null;
let orderId        = null;

// ── DOM refs ─────────────────────────────────────────────
const $  = id => document.getElementById(id);
const $skeleton    = $('loading-skeleton');
const $biz_header  = $('biz-header');
const $biz_emoji   = $('biz-emoji');
const $biz_name    = $('biz-name');
const $biz_cat     = $('biz-category');
const $main        = $('order-main');
const $error       = $('error-state');
const $footer      = $('order-footer');
const $mic_wrap    = $('mic-btn-wrap');
const $mic_btn     = $('mic-btn');
const $status      = $('ai-status');
const $transcript  = $('transcript');
const $end_btn     = $('end-call-btn');
const $cart_sect   = $('cart-section');
const $cart_items  = $('cart-items');
const $cart_total  = $('cart-total');
const $ot_wrap     = $('order-type-wrap');
const $place_btn   = $('place-order-btn');
const $pay_sect    = $('payment-section');
const $order_num   = $('order-number');
const $pay_btns    = $('payment-buttons');

// ── Boot ─────────────────────────────────────────────────
(async function init() {
  const params = new URLSearchParams(location.search);
  let demoSlug = params.get('demo');
  let bizSlug  = params.get('biz');

  // Path-based routing: /demo/:slug or /:slug
  if (!demoSlug && !bizSlug) {
    const parts = location.pathname.replace(/^\//, '').split('/');
    if (parts[0] === 'demo' && parts[1]) {
      demoSlug = parts[1];
    } else if (parts[0]) {
      bizSlug = parts[0];
    }
  }

  if (!demoSlug && !bizSlug) {
    return showError();
  }

  try {
    if (demoSlug) {
      bizData = await loadBySlug('demos', demoSlug);
      if (bizData) bizData.isDemo = true;
    } else {
      bizData = await loadBySlug('businesses', bizSlug);
    }
  } catch (err) {
    console.error('Firestore load error:', err);
  }

  if (!bizData) return showError();

  populateHeader();
  buildOrderTypeTabs();
  hideSkeleton();
  bindEvents();
})();

// ── Firestore helpers ─────────────────────────────────────
async function loadBySlug(collectionName, slug) {
  const q = query(
    collection(db, collectionName),
    where('slug', '==', slug)
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const docSnap = snap.docs[0];
  return { id: docSnap.id, ...docSnap.data() };
}

// ── UI: hydrate header ────────────────────────────────────
function populateHeader() {
  $biz_name.textContent  = bizData.businessName || bizData.bizName || bizData.name || 'Our Menu';
  $biz_cat.textContent   = bizData.categoryName  || bizData.category || '';
  $biz_emoji.textContent = bizData.categoryEmoji || bizData.emoji    || '🏪';
  document.title = `Order from ${$biz_name.textContent} — EP Local Pro AI`;
}

// ── UI: order type tabs ───────────────────────────────────
function buildOrderTypeTabs() {
  const types = bizData.orderTypes || ['pickup'];
  $ot_wrap.innerHTML = '';
  types.forEach(type => {
    const btn = document.createElement('button');
    btn.className = 'order-type-btn' + (type === orderType ? ' active' : '');
    btn.dataset.type = type;
    btn.textContent = capitalize(type);
    btn.addEventListener('click', () => selectOrderType(type));
    $ot_wrap.appendChild(btn);
  });
  // Default to first type if current orderType isn't available
  if (!types.includes(orderType)) {
    orderType = types[0];
  }
}

function selectOrderType(type) {
  orderType = type;
  $ot_wrap.querySelectorAll('.order-type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });
}

// ── UI: show / hide helpers ───────────────────────────────
function hideSkeleton() {
  $skeleton.style.display = 'none';
  $biz_header.classList.remove('hidden');
  $main.classList.remove('hidden');
  $footer.classList.remove('hidden');
}

function showError() {
  $skeleton.style.display = 'none';
  $error.classList.add('visible');
}

// ── Event bindings ────────────────────────────────────────
function bindEvents() {
  $mic_btn.addEventListener('click', onMicClick);
  $end_btn.addEventListener('click', endCall);
  $place_btn.addEventListener('click', placeOrder);
}

async function onMicClick() {
  if (currentSession) return; // Already connected
  $mic_btn.disabled = true;
  updateCallStatus('connecting');
  try {
    await startAiCall();
  } catch (err) {
    console.error('Failed to start AI call:', err);
    updateCallStatus('error');
    $mic_btn.disabled = false;
  }
}

// ── ElevenLabs (lazy loaded) ──────────────────────────────
async function startAiCall() {
  // Lazily load the ElevenLabs client SDK only when user triggers a call
  const { Conversation } = await import(
    'https://cdn.jsdelivr.net/npm/@11labs/client@latest/dist/index.esm.js'
  );

  currentSession = await Conversation.startSession({
    agentId: bizData.agentId || 'DEFAULT_AGENT_ID',
    overrides: {
      agent: {
        prompt: {
          prompt: buildAiPrompt(bizData)
        },
        firstMessage:
          bizData.greeting ||
          bizData.aiGreeting?.en ||
          'Hello! How can I help you today?'
      }
    },
    clientTools: {
      place_order: (params) => {
        // params: { items: [{ name, qty, price }] }
        handleAiPlacedOrder(params);
        return 'Order placed successfully!';
      },
      save_booking: (params) => {
        handleAiSaveBooking(params);
        return 'Booking saved!';
      },
      add_to_cart: (params) => {
        addToCartFromAI(params);
        return 'Added to cart!';
      }
    },
    onMessage:      (msg)    => appendTranscript(msg.role, msg.message),
    onStatusChange: (status) => updateCallStatus(status),
    onError:        (err)    => console.error('ElevenLabs error:', err)
  });

  updateCallStatus('connected');
}

// ── AI prompt builder ─────────────────────────────────────
function buildAiPrompt(biz) {
  const bizName = biz.businessName || biz.bizName || biz.name || 'this business';
  const base = (biz.aiPromptBase || DEFAULT_PROMPT_BASE).replace(/\{bizName\}/g, bizName);

  // Append phone / services / bio context for demos
  const extra = [
    biz.phone    ? `Phone: ${biz.phone}`       : '',
    biz.services ? `Services: ${biz.services}` : '',
    biz.bio      ? biz.bio                     : ''
  ].filter(Boolean).join('\n');

  const items = Array.isArray(biz.menuItems) && biz.menuItems.length
    ? '\n\nMENU:\n' + biz.menuItems.map(item =>
        `- ${item.emoji || ''} ${item.name}: $${Number(item.price).toFixed(2)}` +
        (item.description ? ` — ${item.description}` : '')
      ).join('\n')
    : '';

  return base + (extra ? '\n\n' + extra : '') + items;
}

const DEFAULT_PROMPT_BASE =
  'You are a friendly AI ordering assistant for {bizName}. ' +
  'Help customers browse the menu and place orders. ' +
  'When a customer is ready to order, use the add_to_cart or place_order tool.';

// ── AI tool handlers ──────────────────────────────────────
function handleAiPlacedOrder(params) {
  if (!Array.isArray(params?.items)) return;
  params.items.forEach(item => {
    addToCartFromAI(item);
  });
  placeOrder();
}

function handleAiSaveBooking(params) {
  // Future: write booking doc to Firestore
  console.log('Booking params from AI:', params);
}

function addToCartFromAI(params) {
  if (!params?.name) return;
  const name  = params.name;
  const qty   = Number(params.qty)   || 1;
  const price = Number(params.price) || 0;

  // Try to match against bizData.menuItems for accurate itemId + emoji
  const menuItem = (bizData.menuItems || []).find(
    m => m.name?.toLowerCase() === name.toLowerCase()
  );

  if (menuItem) {
    addToCart(menuItem.id || menuItem.name, qty);
  } else {
    // Fallback: add by name even if not in menu list
    const existing = cart.find(c => c.name?.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.qty += qty;
    } else {
      cart.push({ itemId: name, name, price, qty, emoji: params.emoji || '🍽️' });
    }
    renderCart();
  }
}

// ── Cart functions ────────────────────────────────────────
function addToCart(itemId, qty = 1) {
  const menuItem = (bizData.menuItems || []).find(
    m => (m.id || m.name) === itemId
  );
  if (!menuItem) return;

  const existing = cart.find(c => c.itemId === itemId);
  if (existing) {
    existing.qty += qty;
  } else {
    cart.push({
      itemId,
      name:  menuItem.name,
      price: Number(menuItem.price) || 0,
      qty,
      emoji: menuItem.emoji || '🍽️'
    });
  }
  renderCart();
}

function removeFromCart(itemId) {
  cart = cart.filter(c => c.itemId !== itemId);
  renderCart();
}

function updateQty(itemId, delta) {
  const item = cart.find(c => c.itemId === itemId);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) removeFromCart(itemId);
  else renderCart();
}

function calcTotal() {
  return cart.reduce((sum, item) => sum + item.price * item.qty, 0);
}

function renderCartItems() {
  if (!cart.length) {
    $cart_items.innerHTML =
      '<p style="color:var(--muted);font-size:var(--text-sm);text-align:center;padding:8px 0">No items yet. Talk to the AI to add items.</p>';
    return;
  }

  $cart_items.innerHTML = cart.map(item => {
    const lineTotal = (item.price * item.qty).toFixed(2);
    return `
      <div class="cart-item" role="listitem" data-item-id="${escHtml(item.itemId)}">
        <span class="cart-item-emoji" aria-hidden="true">${escHtml(item.emoji)}</span>
        <span class="cart-item-name">${escHtml(item.name)}</span>
        <div class="qty-controls" role="group" aria-label="Quantity for ${escHtml(item.name)}">
          <button class="qty-btn" data-action="dec" data-id="${escHtml(item.itemId)}" aria-label="Remove one ${escHtml(item.name)}">−</button>
          <span class="qty-num" aria-label="Quantity">${item.qty}</span>
          <button class="qty-btn" data-action="inc" data-id="${escHtml(item.itemId)}" aria-label="Add one more ${escHtml(item.name)}">+</button>
        </div>
        <span class="cart-item-price">$${lineTotal}</span>
      </div>
    `;
  }).join('');

  // Delegate qty button clicks
  $cart_items.querySelectorAll('.qty-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id    = btn.dataset.id;
      const delta = btn.dataset.action === 'inc' ? 1 : -1;
      updateQty(id, delta);
    });
  });
}

function renderCart() {
  renderCartItems();
  $cart_total.textContent = '$' + calcTotal().toFixed(2);

  if (cart.length > 0) {
    $cart_sect.classList.add('visible');
    $place_btn.disabled = false;
  } else {
    $cart_sect.classList.remove('visible');
  }
}

// ── Order placement ───────────────────────────────────────
async function placeOrder() {
  if (!cart.length) return;
  $place_btn.disabled = true;
  $place_btn.textContent = 'Placing order…';

  try {
    const orderDoc = {
      businessId: bizData.id,
      slug:        bizData.slug,
      categoryId:  bizData.categoryId   || null,
      items:       cart,
      total:       calcTotal(),
      orderType,
      notes:       $('order-notes').value.trim(),
      status:      'new',
      createdAt:   serverTimestamp(),
      isDemo:      bizData.isDemo || false
    };

    const ref = await addDoc(collection(db, 'orders'), orderDoc);
    orderId = ref.id;
  } catch (err) {
    console.error('Failed to place order:', err);
    $place_btn.disabled = false;
    $place_btn.textContent = 'Place Order →';
    return;
  }

  endCall();
  showPaymentSection();
}

// ── Payment section ───────────────────────────────────────
function showPaymentSection() {
  const num = generateOrderNumber();
  $order_num.textContent = num;

  buildPaymentButtons();

  $pay_sect.classList.add('visible');
  $main.classList.add('hidden');
  $pay_sect.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function buildPaymentButtons() {
  const opts    = bizData.paymentOptions || {};
  const total   = calcTotal().toFixed(2);
  const buttons = [];

  if (opts.stripe)  buttons.push({ label: '💳 Pay with Card', href: opts.stripe,  key: 'stripe'  });
  if (opts.paypal)  buttons.push({ label: '🅿️ PayPal',         href: opts.paypal,  key: 'paypal'  });
  if (opts.cashapp) buttons.push({ label: '💚 Cash App',       href: opts.cashapp, key: 'cashapp' });
  if (opts.zelle)   buttons.push({ label: '⚡ Zelle',          href: opts.zelle,   key: 'zelle'   });

  if (!buttons.length) {
    $pay_btns.innerHTML =
      '<p style="color:var(--muted);font-size:var(--text-sm)">Please pay at the counter or as directed. Thank you!</p>';
    return;
  }

  $pay_btns.innerHTML = buttons.map(b => `
    <a class="pay-btn" href="${escHtml(b.href)}" target="_blank" rel="noopener" aria-label="${escHtml(b.label)} — $${total}">
      <span class="pay-label">${escHtml(b.label)}</span>
      <span class="pay-amount">$${total}</span>
    </a>
  `).join('');
}

// ── Call status + transcript ──────────────────────────────
function updateCallStatus(status) {
  // Clear all state classes
  $status.className = '';
  $mic_btn.disabled = false;

  switch (status) {
    case 'connecting':
      $status.textContent = 'Connecting…';
      $mic_btn.disabled   = true;
      break;
    case 'connected':
      $mic_wrap.classList.add('active');
      $status.textContent = 'Listening…';
      $status.classList.add('listening');
      $transcript.classList.add('visible');
      $end_btn.classList.add('visible');
      $mic_btn.disabled = true;
      break;
    case 'disconnected':
      $mic_wrap.classList.remove('active');
      $status.textContent = 'Tap to start talking';
      $end_btn.classList.remove('visible');
      $mic_btn.disabled   = false;
      currentSession      = null;
      break;
    case 'speaking':
      $status.textContent = 'AI is speaking…';
      $status.classList.add('speaking');
      break;
    case 'listening':
      $status.textContent = 'Listening…';
      $status.classList.add('listening');
      break;
    case 'ready':
      $status.textContent = 'Order ready!';
      $status.classList.add('ready');
      break;
    case 'error':
      $mic_wrap.classList.remove('active');
      $status.textContent = 'Connection failed. Try again.';
      $status.classList.add('error');
      $end_btn.classList.remove('visible');
      currentSession = null;
      break;
    default:
      $status.textContent = status;
  }
}

function appendTranscript(role, text) {
  if (!text) return;
  const msg   = document.createElement('div');
  msg.className = `transcript-msg ${role === 'user' ? 'user' : 'assistant'}`;
  msg.innerHTML =
    `<div class="role">${escHtml(role === 'user' ? 'You' : 'AI')}</div>` +
    `<div class="text">${escHtml(text)}</div>`;
  $transcript.appendChild(msg);
  $transcript.scrollTop = $transcript.scrollHeight;
}

function endCall() {
  if (currentSession) {
    try { currentSession.endSession(); } catch (_) {}
    currentSession = null;
  }
  updateCallStatus('disconnected');
}

// ── Utilities ─────────────────────────────────────────────
function generateOrderNumber() {
  return '#' + Date.now().toString(36).toUpperCase();
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
