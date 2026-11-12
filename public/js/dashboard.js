/* ============================================================
   EP Local Pro AI — dashboard.js
   Business owner dashboard logic. Firebase module script.
   ============================================================ */

import { auth, db, storage } from '/js/firebase.js';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';
import {
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, onSnapshot, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── State ────────────────────────────────────────────────────
let currentUser       = null;
let ownerDoc          = null;
let bizDoc            = null;
let bizId             = null;
let bizSlug           = null;
let bizCategory       = null;
let selectedLang      = 'en';
let ordersUnsub       = null;
let allDocs           = [];
let currentDocFilter  = 'all';

// ── Helpers ──────────────────────────────────────────────────
function relativeTime(ts) {
  if (!ts) return '—';
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

function fmtDate(ts) {
  if (!ts) return '—';
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtCurrency(val) {
  if (val == null || isNaN(val)) return '$0.00';
  return '$' + Number(val).toFixed(2);
}

function generateOrderNumber() {
  return '#' + Date.now().toString().slice(-6);
}

function qs(selector, parent = document) {
  return parent.querySelector(selector);
}

function showToast(msg, type = 'success') {
  const t = qs('#toast');
  t.textContent = msg;
  t.className = `toast ${type} visible`;
  clearTimeout(t._timeout);
  t._timeout = setTimeout(() => { t.className = 'toast'; }, 3200);
}

// ── Auth Gate + Init ─────────────────────────────────────────
// One-shot pattern: unsubscribe immediately after first fire so we only
// act on the initial auth state, not every future change.
const _authUnsub = onAuthStateChanged(auth, async (user) => {
  _authUnsub();
  if (!user) {
    window.location.href = '/auth.html?from=dash_no_user';
    return;
  }
  currentUser = user;
  await initDashboard();
  // Re-subscribe only to catch future signouts
  onAuthStateChanged(auth, u => { if (!u) window.location.href = '/auth.html?from=dash_signout'; });
});

async function initDashboard() {
  // Wire logout + mobile sidebar immediately — before any async work
  const logoutEl = document.getElementById('logoutBtn');
  if (logoutEl) logoutEl.addEventListener('click', signOutUser);
  const toggleEl = document.getElementById('sidebarToggle');
  if (toggleEl) toggleEl.addEventListener('click', toggleSidebar);
  const backdropEl = document.getElementById('sidebarBackdrop');
  if (backdropEl) backdropEl.addEventListener('click', closeSidebar);

  try {
    // Load owner doc
    const ownerRef = doc(db, 'owners', currentUser.uid);
    const ownerSnap = await getDoc(ownerRef);

    if (!ownerSnap.exists()) {
      window.location.href = '/auth.html?from=dash_no_doc';
      return;
    }

    ownerDoc = ownerSnap.data();

    // Redirect admins and personal accounts
    if (ownerDoc.role?.toLowerCase() === 'admin') {
      window.location.href = '/admin.html';
      return;
    }
    if (ownerDoc.acctType === 'personal') {
      window.location.href = '/user-dashboard.html';
      return;
    }

    // Find the business where ownerId == uid
    const bizQ = query(
      collection(db, 'businesses'),
      where('ownerId', '==', currentUser.uid),
      limit(1)
    );
    const bizSnap = await getDocs(bizQ);

    if (bizSnap.empty) {
      if (ownerDoc.acctType !== 'business') {
        hideLoading();
        showSection('dashboard');
        wireNavAndModals();
        showToast('Welcome! Your business page will be set up by your admin.', 'info');
        return;
      }
      // Business owner with no linked businesses doc — auto-create one so the dashboard works
      try {
        const autoBizRef = doc(db, 'businesses', currentUser.uid);
        await setDoc(autoBizRef, {
          ownerId:     currentUser.uid,
          ownerEmail:  currentUser.email || '',
          name:        ownerDoc.companyName || '',
          companyName: ownerDoc.companyName || '',
          category:    ownerDoc.categoryId  || '',
          plan:        ownerDoc.plan        || 'trial',
          createdAt:   serverTimestamp(),
        }, { merge: true });
        bizId       = currentUser.uid;
        bizDoc      = { ownerId: currentUser.uid, ownerEmail: currentUser.email, name: ownerDoc.companyName || '', companyName: ownerDoc.companyName || '', category: ownerDoc.categoryId || '', plan: ownerDoc.plan || 'trial' };
        bizSlug     = '';
        bizCategory = ownerDoc.categoryId || '';
      } catch (createErr) {
        console.error('Could not initialize business doc:', createErr);
        hideLoading();
        showSection('dashboard');
        wireNavAndModals();
        showToast('Could not load your business. Please refresh or contact support.', 'error');
        return;
      }
    } else {
      const bizDocSnap = bizSnap.docs[0];
      bizId       = bizDocSnap.id;
      bizDoc      = bizDocSnap.data();
      bizSlug     = bizDoc.slug || '';
      bizCategory = bizDoc.category || '';
    }

    // Populate sidebar
    qs('#sidebarBizName').textContent = bizDoc.name || 'Your Business';

    // Plan badge
    const plan = ownerDoc.plan || bizDoc.plan || 'trial';
    const planBadge = qs('#planBadge');
    planBadge.textContent = plan.charAt(0).toUpperCase() + plan.slice(1);
    planBadge.className = `plan-badge ${plan === 'trial' ? 'trial' : plan === 'pro' ? 'pro' : 'active'}`;

    if (plan === 'trial') {
      qs('#upgradeLink').classList.remove('hidden');
    }

    // AI page button
    qs('#openAiPageBtn').onclick = () => {
      if (bizSlug) window.open(`https://ep-local-pro-ai.netlify.app/${bizSlug}`, '_blank');
      else showToast('No slug set for your business.', 'error');
    };

    // Walkie Talkie FAB — only when bizId available
    if (bizId) initWalkieTalkie();

    hideLoading();

    // Load default section
    showSection('dashboard');
    wireNavAndModals();

  } catch (err) {
    console.error('initDashboard error:', err);
    const isPermission = err.code === 'permission-denied';
    showToast(
      isPermission
        ? 'Database rules not yet published. Please contact support.'
        : 'Failed to load dashboard.',
      'error'
    );
    // Show user email so sidebar doesn't stay on "Loading…"
    const nameEl = qs('#sidebarBizName');
    if (nameEl) nameEl.textContent = currentUser.email || 'Account';
    hideLoading();
    showSection('dashboard');
    wireNavAndModals();
  }
}

function hideLoading() {
  qs('#pageLoading').classList.add('hidden');
}

// ── Section Navigation ───────────────────────────────────────
function showSection(name) {
  // Update nav
  document.querySelectorAll('.sidebar-nav a[data-nav]').forEach(a => {
    a.classList.toggle('active', a.dataset.nav === name);
  });

  // Hide/show sections
  document.querySelectorAll('[data-section]').forEach(el => {
    el.classList.toggle('hidden', el.dataset.section !== name);
  });

  // Page title map
  const titles = {
    'dashboard':   'Dashboard',
    'orders':      'Orders',
    'menu':        'Menu',
    'documents':   'Documents',
    'profile':     'Business Profile',
    'ai-settings': 'AI Settings',
    'team':        'Team',
    'account':     'Account'
  };
  qs('#pageTitle').textContent = titles[name] || 'Dashboard';

  // Lazy load section data
  if (name === 'dashboard')   { loadStats(); loadRecentOrders(); }
  if (name === 'orders')      { loadOrders('all'); }
  if (name === 'menu')        { loadMenu(); }
  if (name === 'documents')   { loadDocuments(); }
  if (name === 'profile')     { loadProfile(); }
  if (name === 'ai-settings') { loadAiSettings(); }
  if (name === 'team')        { loadTeam(); }
  if (name === 'account')     { loadAccount(); }
}

// ── Wire nav + modals (called once after init) ───────────────
let _navWired = false;
function wireNavAndModals() {
  if (_navWired) return;
  _navWired = true;

  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      showSection(el.dataset.nav);
      closeSidebar();
    });
  });

  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.close;
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
  });

  document.addEventListener('click', (e) => {
    const menu = document.getElementById('generateDocMenu');
    const btn  = document.getElementById('generateDocBtn');
    if (menu && !menu.contains(e.target) && e.target !== btn) {
      menu.classList.remove('open');
    }
  });

  // Profile section — wire buttons once so they always respond
  document.getElementById('saveProfileBtn')?.addEventListener('click', saveProfile);

  document.getElementById('profileLogoUploadBtn')?.addEventListener('click', () => {
    document.getElementById('profileLogoFile')?.click();
  });

  document.getElementById('profileLogoFile')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { showToast('Image must be under 2MB.', 'error'); return; }
    if (!bizId) { showToast('Business not loaded yet. Please wait.', 'error'); return; }
    try {
      const dataUrl = await resizeLogo(file, 300, 120);
      qs('#profileLogoImg').src = dataUrl;
      qs('#profileLogoImg').style.display = 'block';
      qs('#profileLogoPlaceholder').style.display = 'none';
      await updateDoc(doc(db, 'businesses', bizId), { logoUrl: dataUrl });
      if (bizDoc) bizDoc.logoUrl = dataUrl;
      showToast('Logo saved!');
    } catch (err) {
      console.error('logo upload error:', err);
      showToast('Failed to save logo. ' + (err.message || ''), 'error');
    }
    e.target.value = '';
  });

  document.getElementById('removeLogoBtn')?.addEventListener('click', async () => {
    if (!confirm('Remove your logo?')) return;
    if (!bizId) return;
    try {
      await updateDoc(doc(db, 'businesses', bizId), { logoUrl: '' });
      if (bizDoc) bizDoc.logoUrl = '';
      qs('#profileLogoImg').src = '';
      qs('#profileLogoImg').style.display = 'none';
      qs('#profileLogoPlaceholder').style.display = 'flex';
      document.getElementById('profileLogoFile').value = '';
      showToast('Logo removed.');
    } catch (err) {
      showToast('Failed to remove logo. ' + (err.message || ''), 'error');
    }
  });
}

// ── Mobile Sidebar ───────────────────────────────────────────
function toggleSidebar() {
  qs('#dashSidebar').classList.toggle('open');
  qs('#sidebarBackdrop').classList.toggle('visible');
}

function closeSidebar() {
  qs('#dashSidebar').classList.remove('open');
  qs('#sidebarBackdrop').classList.remove('visible');
}

// ── Stats ────────────────────────────────────────────────────
function zeroStats() {
  ['#statToday','#statWeek','#statMonth'].forEach(s => { const el = qs(s); if (el) el.textContent = '0'; });
  const r = qs('#statRevenue'); if (r) r.textContent = '$0.00';
  ['#statTodayTrend','#statWeekTrend','#statMonthTrend','#statRevenueTrend'].forEach(s => {
    const el = qs(s); if (el) el.textContent = '—';
  });
}

async function loadStats() {
  if (!bizId) { zeroStats(); return; }

  try {
    const ordersRef = collection(db, 'orders');
    const q = query(ordersRef, where('businessId', '==', bizId));
    const snap = await getDocs(q);

    const now      = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart  = new Date(todayStart); weekStart.setDate(todayStart.getDate() - 6);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    let countToday = 0, countWeek = 0, countMonth = 0;
    let totalRevenue = 0;

    snap.forEach(d => {
      const data = d.data();
      const created = data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt || 0);
      const amount = Number(data.total || 0);

      totalRevenue += amount;
      if (created >= monthStart) { countMonth++; }
      if (created >= weekStart)  { countWeek++; }
      if (created >= todayStart) { countToday++; }
    });

    qs('#statToday').textContent   = countToday;
    qs('#statWeek').textContent    = countWeek;
    qs('#statMonth').textContent   = countMonth;
    qs('#statRevenue').textContent = fmtCurrency(totalRevenue);

    qs('#statTodayTrend').textContent   = countToday === 1 ? '1 order today' : `${countToday} orders today`;
    qs('#statWeekTrend').textContent    = `Last 7 days`;
    qs('#statMonthTrend').textContent   = `This month`;
    qs('#statRevenueTrend').textContent = `All time`;

  } catch (err) {
    console.error('loadStats error:', err);
  }
}

// ── Recent Orders (Dashboard) ────────────────────────────────
async function loadRecentOrders() {
  const container = qs('#recentOrdersList');
  if (!bizId) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📦</div><p>No orders yet. Orders placed through your AI page will appear here.</p></div>';
    return;
  }
  container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📦</div><p>Loading…</p></div>';

  try {
    const q = query(
      collection(db, 'orders'),
      where('businessId', '==', bizId),
      orderBy('createdAt', 'desc'),
      limit(5)
    );
    const snap = await getDocs(q);

    if (snap.empty) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📦</div><p>No orders yet. Orders placed through your AI page will appear here.</p></div>';
      return;
    }

    container.innerHTML = '';
    snap.forEach(d => {
      container.appendChild(renderOrderCard(d.id, d.data(), false));
    });

  } catch (err) {
    console.error('loadRecentOrders error:', err);
    container.innerHTML = '<div class="empty-state"><p>Failed to load orders.</p></div>';
  }
}

// ── Orders Section ───────────────────────────────────────────
let currentOrderFilter = 'all';

function loadOrders(filter) {
  if (!bizId) return;
  currentOrderFilter = filter;

  // Update tab UI
  document.querySelectorAll('#orderFilterTabs .filter-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.filter === filter);
  });

  // Wire tabs if not already wired
  document.querySelectorAll('#orderFilterTabs .filter-tab').forEach(tab => {
    tab.onclick = () => loadOrders(tab.dataset.filter);
  });

  const container = qs('#ordersList');
  container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📦</div><p>Loading…</p></div>';

  // Unsubscribe previous listener
  if (ordersUnsub) { ordersUnsub(); ordersUnsub = null; }

  let q;
  if (filter === 'all') {
    q = query(
      collection(db, 'orders'),
      where('businessId', '==', bizId),
      orderBy('createdAt', 'desc')
    );
  } else {
    q = query(
      collection(db, 'orders'),
      where('businessId', '==', bizId),
      where('status', '==', filter),
      orderBy('createdAt', 'desc')
    );
  }

  ordersUnsub = onSnapshot(q, (snap) => {
    if (snap.empty) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📦</div><p>No ${filter === 'all' ? '' : filter + ' '}orders found.</p></div>`;
      return;
    }
    container.innerHTML = '';
    snap.forEach(d => {
      container.appendChild(renderOrderCard(d.id, d.data(), true));
    });
  }, (err) => {
    console.error('loadOrders snapshot error:', err);
    container.innerHTML = '<div class="empty-state"><p>Failed to load orders.</p></div>';
  });
}

function renderOrderCard(orderId, data, showControls) {
  const card = document.createElement('div');
  card.className = 'order-card';
  card.dataset.status = data.status || 'new';
  card.dataset.orderId = orderId;

  const items = Array.isArray(data.items) ? data.items : [];
  const itemsHtml = items.length
    ? items.map(it => `<div class="order-items-row"><span>${it.qty || 1}× ${it.name || it}</span><span>${it.price ? fmtCurrency(it.price * (it.qty || 1)) : ''}</span></div>`).join('')
    : '<span>No items listed</span>';

  const isRestaurant = ['restaurant', 'coffee_shop'].includes(bizCategory);
  const statusOpts = ['new','confirmed','preparing','ready','completed'];
  const statusSelectHtml = showControls ? `
    <select class="order-status-select" data-order-id="${orderId}">
      ${statusOpts.map(s => `<option value="${s}" ${data.status === s ? 'selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('')}
    </select>` : '';

  const kitchenBtn = showControls && isRestaurant
    ? `<button class="btn-kitchen" data-order-id="${orderId}">🍳 Kitchen</button>` : '';

  card.innerHTML = `
    <div class="order-card-top">
      <div>
        <div class="order-number">${data.orderNumber || generateOrderNumber()}</div>
        <div class="order-customer">${data.customerName || 'Customer'}</div>
      </div>
      <span class="badge badge-${data.status || 'new'}">${data.status || 'new'}</span>
    </div>
    <div class="order-items">${itemsHtml}</div>
    <div class="order-card-bottom">
      <div>
        <div class="order-total">${fmtCurrency(data.total)}</div>
        <div class="order-time">${relativeTime(data.createdAt)}</div>
      </div>
      <div class="order-actions">
        ${kitchenBtn}
        ${statusSelectHtml}
      </div>
    </div>`;

  // Wire status select
  if (showControls) {
    const sel = card.querySelector('.order-status-select');
    if (sel) {
      sel.addEventListener('change', () => updateOrderStatus(orderId, sel.value, card));
    }
    const kitBtn = card.querySelector('.btn-kitchen');
    if (kitBtn) {
      kitBtn.addEventListener('click', () => openKitchenDisplay(orderId, data));
    }
  }

  return card;
}

async function updateOrderStatus(orderId, newStatus, cardEl) {
  try {
    await updateDoc(doc(db, 'orders', orderId), {
      status: newStatus,
      updatedAt: serverTimestamp()
    });
    if (cardEl) {
      cardEl.dataset.status = newStatus;
      const badge = cardEl.querySelector('.badge');
      if (badge) {
        badge.className = `badge badge-${newStatus}`;
        badge.textContent = newStatus;
      }
    }
    showToast(`Order updated to "${newStatus}".`);
  } catch (err) {
    console.error('updateOrderStatus error:', err);
    showToast('Failed to update status.', 'error');
  }
}

function openKitchenDisplay(orderId, data) {
  const items = Array.isArray(data.items) ? data.items : [];
  const itemsHtml = items.map(it =>
    `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e2e8f0;">
      <span style="font-size:1rem;font-weight:600;">${it.qty || 1}× ${it.name || it}</span>
      ${it.notes ? `<span style="font-size:0.8rem;color:#64748b;">Note: ${it.notes}</span>` : ''}
    </div>`
  ).join('') || '<p>No items.</p>';

  qs('#kitchenModalBody').innerHTML = `
    <div style="text-align:center;margin-bottom:16px;">
      <div style="font-size:1.5rem;font-weight:800;color:#0f172a;">${data.orderNumber || '#—'}</div>
      <div style="font-size:0.875rem;color:#64748b;">${data.customerName || 'Customer'} · ${relativeTime(data.createdAt)}</div>
    </div>
    <div>${itemsHtml}</div>
    ${data.notes ? `<div style="margin-top:14px;padding:10px;background:#fef3c7;border-radius:8px;font-size:0.875rem;"><strong>Notes:</strong> ${data.notes}</div>` : ''}`;

  qs('#kitchenModal').classList.remove('hidden');
}

// ── Menu ─────────────────────────────────────────────────────
async function loadMenu() {
  if (!bizId) return;
  const grid = qs('#menuGrid');
  grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><p>Loading menu…</p></div>';

  try {
    const bizRef  = doc(db, 'businesses', bizId);
    const bizSnap = await getDoc(bizRef);
    const data    = bizSnap.data() || {};
    const items   = Array.isArray(data.menuItems) ? data.menuItems : [];

    if (items.length === 0) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-state-icon">🍽️</div><p>No menu items yet. Add your first item!</p></div>`;
      return;
    }

    grid.innerHTML = '';
    items.forEach((item, index) => {
      grid.appendChild(renderMenuCard(item, index));
    });

  } catch (err) {
    console.error('loadMenu error:', err);
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><p>Failed to load menu.</p></div>';
  }

  // Wire add button
  qs('#addMenuItemBtn').onclick = openAddMenuItemModal;
}

function renderMenuCard(item, index) {
  const card = document.createElement('div');
  card.className = 'menu-item-card';
  card.dataset.index = index;
  card.innerHTML = `
    <div class="menu-item-emoji">${item.emoji || '🍴'}</div>
    <div class="menu-item-name">${item.name || 'Unnamed Item'}</div>
    <div class="menu-item-price">${fmtCurrency(item.price)}</div>
    ${item.description ? `<div class="menu-item-desc">${item.description}</div>` : ''}
    <div class="menu-item-actions">
      <button class="btn-icon" title="Edit" data-edit="${index}">✏️</button>
      <button class="btn-icon danger" title="Delete" data-delete="${index}">🗑️</button>
    </div>`;

  card.querySelector(`[data-edit="${index}"]`).onclick = (e) => {
    e.stopPropagation();
    openEditMenuItemModal(index, item);
  };
  card.querySelector(`[data-delete="${index}"]`).onclick = (e) => {
    e.stopPropagation();
    deleteMenuItem(index);
  };

  return card;
}

function openAddMenuItemModal() {
  qs('#menuItemModalTitle').textContent = 'Add Menu Item';
  qs('#menuItemIndex').value = '-1';
  qs('#menuItemName').value  = '';
  qs('#menuItemEmoji').value = '';
  qs('#menuItemPrice').value = '';
  qs('#menuItemDesc').value  = '';
  qs('#menuItemModal').classList.remove('hidden');
  qs('#saveMenuItemBtn').onclick = saveMenuItem;
}

function openEditMenuItemModal(index, item) {
  qs('#menuItemModalTitle').textContent = 'Edit Menu Item';
  qs('#menuItemIndex').value = index;
  qs('#menuItemName').value  = item.name || '';
  qs('#menuItemEmoji').value = item.emoji || '';
  qs('#menuItemPrice').value = item.price != null ? item.price : '';
  qs('#menuItemDesc').value  = item.description || '';
  qs('#menuItemModal').classList.remove('hidden');
  qs('#saveMenuItemBtn').onclick = saveMenuItem;
}

async function saveMenuItem() {
  const index = parseInt(qs('#menuItemIndex').value, 10);
  const name  = qs('#menuItemName').value.trim();
  const emoji = qs('#menuItemEmoji').value.trim();
  const price = parseFloat(qs('#menuItemPrice').value);
  const desc  = qs('#menuItemDesc').value.trim();

  if (!name) { showToast('Item name is required.', 'error'); return; }
  if (isNaN(price) || price < 0) { showToast('Enter a valid price.', 'error'); return; }

  const newItem = { name, emoji: emoji || '🍴', price, description: desc };

  try {
    const bizRef  = doc(db, 'businesses', bizId);
    const bizSnap = await getDoc(bizRef);
    const items   = Array.isArray(bizSnap.data()?.menuItems) ? [...bizSnap.data().menuItems] : [];

    if (index === -1) {
      items.push(newItem);
    } else {
      items[index] = newItem;
    }

    await updateDoc(bizRef, { menuItems: items });
    qs('#menuItemModal').classList.add('hidden');
    showToast(index === -1 ? 'Item added!' : 'Item updated!');
    loadMenu();

  } catch (err) {
    console.error('saveMenuItem error:', err);
    showToast('Failed to save item.', 'error');
  }
}

async function deleteMenuItem(index) {
  if (!confirm('Delete this menu item?')) return;

  try {
    const bizRef  = doc(db, 'businesses', bizId);
    const bizSnap = await getDoc(bizRef);
    const items   = Array.isArray(bizSnap.data()?.menuItems) ? [...bizSnap.data().menuItems] : [];
    items.splice(index, 1);
    await updateDoc(bizRef, { menuItems: items });
    showToast('Item deleted.');
    loadMenu();
  } catch (err) {
    console.error('deleteMenuItem error:', err);
    showToast('Failed to delete item.', 'error');
  }
}

// ── Documents ────────────────────────────────────────────────
async function loadDocuments() {
  if (!bizId) return;
  const list = qs('#docsList');
  if (!list) return;
  list.innerHTML = `<div class="empty-state"><p>Loading…</p></div>`;

  // Wire create cards
  document.querySelectorAll('[data-doc-type]').forEach(btn => {
    btn.onclick = () => openGenerateDocModal(btn.dataset.docType);
  });

  // Wire filter tabs
  document.querySelectorAll('.docs-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.docs-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentDocFilter = tab.dataset.filter;
      renderDocCards();
    };
  });

  try {
    const q = query(
      collection(db, 'documents'),
      where('businessId', '==', bizId),
      orderBy('createdAt', 'desc')
    );
    const snap = await getDocs(q);
    allDocs = [];
    snap.forEach(d => allDocs.push({ id: d.id, ...d.data() }));
    updateDocCounts();
    renderDocCards();
  } catch (err) {
    console.error('loadDocuments error:', err);
    list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div><p>Failed to load documents.</p></div>`;
  }
}

function updateDocCounts() {
  const counts = { all: allDocs.length, invoice: 0, estimate: 0, contract: 0, receipt: 0 };
  allDocs.forEach(d => { if (d.type && counts[d.type] !== undefined) counts[d.type]++; });
  Object.entries(counts).forEach(([type, count]) => {
    const key = type.charAt(0).toUpperCase() + type.slice(1);
    const el = qs(`#count${key}`);
    if (el) el.textContent = count;
  });
}

function renderDocCards() {
  const list = qs('#docsList');
  if (!list) return;
  const filtered = currentDocFilter === 'all'
    ? allDocs
    : allDocs.filter(d => d.type === currentDocFilter);

  if (!filtered.length) {
    const msg = currentDocFilter === 'all'
      ? 'No documents yet. Create your first one above.'
      : `No ${currentDocFilter}s yet.`;
    list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📄</div><p>${msg}</p></div>`;
    return;
  }

  const typeLabels  = { invoice: 'Invoice', estimate: 'Estimate', contract: 'Contract', receipt: 'Receipt' };
  const badgeCls    = { invoice: 'badge-invoice', estimate: 'badge-estimate', contract: 'badge-contract', receipt: 'badge-receipt' };

  list.innerHTML = '';
  filtered.forEach(docData => {
    const typeLbl   = typeLabels[docData.type] || docData.type || '—';
    const badgeClass = badgeCls[docData.type] || '';
    const amount    = docData.amount
      ? `$${Number(docData.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : '—';

    const card = document.createElement('div');
    card.className = 'doc-card';
    card.innerHTML = `
      <div class="doc-card-stripe stripe-${docData.type || ''}"></div>
      <div class="doc-card-body">
        <div class="doc-card-type">
          <span class="badge ${badgeClass}">${typeLbl}</span>
          ${docData.docNumber ? `<div class="doc-card-num">${docData.docNumber}</div>` : ''}
        </div>
        <div class="doc-card-info">
          <div class="doc-card-customer">${docData.customerName || '—'}</div>
          <div class="doc-card-meta">
            <span>${fmtDate(docData.createdAt)}</span>
            ${docData.status ? `<span class="doc-card-meta-dot">${docData.status}</span>` : ''}
          </div>
        </div>
        <div class="doc-card-amount">${amount}</div>
      </div>
      <div class="doc-card-actions">
        ${docData.htmlContent ? `<button class="btn-action" data-view>👁 View</button>` : ''}
        ${docData.htmlContent ? `<button class="btn-action primary" data-dl>↓ PDF</button>` : ''}
      </div>`;

    if (docData.htmlContent) {
      const label = docData.docNumber || typeLbl;
      card.querySelector('[data-view]')?.addEventListener('click', () => viewDocument(docData.htmlContent, label));
      card.querySelector('[data-dl]')?.addEventListener('click',   () => downloadDocument(docData.htmlContent, label));
    }
    list.appendChild(card);
  });
}

function viewDocument(htmlContent, label) {
  const frame = qs('#docPreviewFrame');
  if (!frame) return;
  qs('#docPreviewTitle').textContent = label || 'Document Preview';
  frame.srcdoc = htmlContent;
  qs('#docPreviewModal').classList.remove('hidden');
  qs('#docPrintBtn').onclick = () => frame.contentWindow?.print();
}

function downloadDocument(htmlContent, label) {
  viewDocument(htmlContent, label);
  setTimeout(() => qs('#docPreviewFrame')?.contentWindow?.print(), 700);
}

function openGenerateDocModal(type) {
  const configs = {
    invoice:  { title: 'New Invoice',  label: 'INVOICE',  cls: 'label-invoice'  },
    estimate: { title: 'New Estimate', label: 'ESTIMATE', cls: 'label-estimate' },
    contract: { title: 'New Contract', label: 'CONTRACT', cls: 'label-contract' },
    receipt:  { title: 'New Receipt',  label: 'RECEIPT',  cls: 'label-receipt'  },
  };
  const cfg = configs[type] || configs.invoice;
  qs('#genDocModalTitle').textContent = cfg.title;
  const labelEl = qs('#genDocLabel');
  labelEl.textContent = cfg.label;
  labelEl.className = `gen-doc-label ${cfg.cls}`;
  qs('#genDocType').value = type;

  const isContract = type === 'contract';
  const isReceipt  = type === 'receipt';
  qs('#genDocContractFields').classList.toggle('hidden', !isContract);
  qs('#genDocLineItemsSection').classList.toggle('hidden', isContract);
  qs('#genDocTaxGroup').classList.toggle('hidden', isContract);
  qs('#genDocTermsGroup').classList.toggle('hidden', !isContract);
  qs('#genDocPayMethodGroup').classList.toggle('hidden', !isReceipt);

  // Populate business profile banner
  const biz = bizDoc || {};
  const logoEl = qs('#docBizLogoPreview');
  if (biz.logoUrl) { logoEl.src = biz.logoUrl; logoEl.style.display = 'block'; }
  else logoEl.style.display = 'none';
  qs('#docBizNamePreview').textContent = biz.companyName || biz.name || '—';
  const details = [biz.address, biz.phone, biz.email].filter(Boolean).join(' · ');
  qs('#docBizDetailPreview').textContent = details || 'Complete your Business Profile to personalize documents.';

  const editLink = qs('#docBizBanner [data-nav="profile"]');
  if (editLink) editLink.onclick = () => { qs('#generateDocModal').classList.add('hidden'); showSection('profile'); };

  // Reset all fields
  ['#genDocCustomer','#genDocCustEmail','#genDocCustAddress','#genDocNotes','#genDocTerms',
   '#genDocJobDesc','#genDocPaymentTerms','#genDocContractTotal','#genDocStartDate','#genDocEndDate']
    .forEach(sel => { const el = qs(sel); if (el) el.value = ''; });
  qs('#genDocDate').value = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  qs('#genDocTaxRate').value = '0';

  if (!isContract) {
    qs('#genDocItemsList').innerHTML = '';
    addDocLineItem();
    updateDocTotals();
  }

  qs('#addDocItemBtn').onclick   = addDocLineItem;
  qs('#genDocTaxRate').oninput   = updateDocTotals;
  qs('#confirmGenDocBtn').onclick = () => generateDocument(type);
  qs('#generateDocModal').classList.remove('hidden');
}

async function generateDocument(type) {
  const customer = qs('#genDocCustomer').value.trim();
  if (!customer) { showToast('Customer name is required.', 'error'); return; }

  const biz        = bizDoc || {};
  const isContract = type === 'contract';

  let items, taxRate, totalAmount;

  if (isContract) {
    const contractTotal = parseFloat(qs('#genDocContractTotal').value) || 0;
    const jobDesc       = qs('#genDocJobDesc').value.trim() || 'Professional Services';
    items       = [{ name: jobDesc, qty: 1, price: contractTotal, desc: '' }];
    taxRate     = 0;
    totalAmount = contractTotal;
  } else {
    items = [];
    document.querySelectorAll('#genDocItemsList .doc-line-item-row').forEach(row => {
      const name  = row.querySelector('.dli-name').value.trim();
      const qty   = parseFloat(row.querySelector('.dli-qty').value)   || 1;
      const price = parseFloat(row.querySelector('.dli-price').value) || 0;
      const desc  = row.querySelector('.dli-desc').value.trim();
      if (name) items.push({ name, qty, price, desc });
    });
    if (!items.length) { showToast('Add at least one item.', 'error'); return; }
    taxRate     = parseFloat(qs('#genDocTaxRate').value) || 0;
    const sub   = items.reduce((s, i) => s + i.qty * i.price, 0);
    totalAmount = sub + sub * taxRate / 100;
  }

  const payload = {
    type,
    bizName:        biz.companyName || biz.name || '',
    bizAddress:     biz.address     || '',
    bizPhone:       biz.phone       || '',
    bizEmail:       biz.email       || '',
    bizLogo:        biz.logoUrl     || '',
    customerName:    customer,
    customerEmail:   qs('#genDocCustEmail').value.trim(),
    customerAddress: qs('#genDocCustAddress').value.trim(),
    items,
    taxRate,
    notes:          qs('#genDocNotes').value.trim(),
    jobDescription: isContract ? qs('#genDocJobDesc').value.trim()       : '',
    contractTerms:  isContract ? qs('#genDocTerms').value.trim()         : '',
    paymentTerms:   isContract ? qs('#genDocPaymentTerms').value.trim()  : '',
    paymentMethod:  type === 'receipt' ? qs('#genDocPayMethod').value    : '',
  };

  const btn = qs('#confirmGenDocBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Generating…';

  try {
    const res = await fetch('/.netlify/functions/invoice-generate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Server error');

    await addDoc(collection(db, 'documents'), {
      businessId:   bizId,
      type,
      docNumber:    result.docNumber    || null,
      customerName: customer,
      amount:       result.total        || totalAmount || 0,
      status:       'generated',
      htmlContent:  result.htmlContent  || null,
      createdAt:    serverTimestamp()
    });

    qs('#generateDocModal').classList.add('hidden');
    const typeCap = type.charAt(0).toUpperCase() + type.slice(1);
    showToast(`${typeCap} ${result.docNumber || ''} generated!`);
    loadDocuments();

  } catch (err) {
    console.error('generateDocument error:', err);
    showToast('Failed to generate document. Check your connection.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Generate';
  }
}

// ── AI Settings ──────────────────────────────────────────────

const AI_VOICES_EN = [
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel' },
  { id: '9BWtsMINqrJLrRacOk9x', name: 'Aria'   },
  { id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie' },
  { id: 'CwhRBWXHgrhyhFiotyx9', name: 'Roger'  },
];
const AI_VOICES_ES = [
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Valentina' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sofía'     },
  { id: 'pNInz6obpgDQGcFmaJgB', name: 'Alejandro' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Diego'     },
];

let aitwLang      = 'en';
let aitwVoiceId   = AI_VOICES_EN[0].id;
let aitwSession   = null;
let aitwActive    = false;
let aitwSdkLoaded = false;

async function loadAiSettings() {
  if (!bizId) return;

  try {
    const bizRef  = doc(db, 'businesses', bizId);
    const bizSnap = await getDoc(bizRef);
    const data    = bizSnap.data() || {};

    qs('#agentIdInput').value  = data.agentId   || '';
    qs('#greetingInput').value = data.greeting  || '';
    qs('#hoursInput').value    = data.hours      || '';

    selectedLang = data.lang || 'en';
    updateLangToggle(selectedLang);

    // Voice dropdowns
    qs('#voiceIdEnSelect').value = data.voiceIdEn || AI_VOICES_EN[0].id;
    qs('#voiceIdEsSelect').value = data.voiceIdEs || AI_VOICES_ES[0].id;

    // Sync test widget with saved settings
    aitwLang    = selectedLang;
    aitwVoiceId = selectedLang === 'es'
      ? (data.voiceIdEs || AI_VOICES_ES[0].id)
      : (data.voiceIdEn || AI_VOICES_EN[0].id);
    renderAitwVoicePills();
    updateAitwLangBtns();

    // AI page URL
    qs('#aiUrlDisplay').textContent = `https://ep-local-pro-ai.netlify.app/${bizSlug || '—'}`;

  } catch (err) {
    console.error('loadAiSettings error:', err);
    showToast('Failed to load AI settings.', 'error');
  }

  qs('#saveAiSettingsBtn').onclick = saveAiSettings;

  qs('#langEN').onclick = () => { selectedLang = 'en'; updateLangToggle('en'); };
  qs('#langES').onclick = () => { selectedLang = 'es'; updateLangToggle('es'); };

  qs('#copyUrlBtn').onclick = () => {
    const url = `https://ep-local-pro-ai.netlify.app/${bizSlug}`;
    navigator.clipboard.writeText(url).then(() => {
      const btn = qs('#copyUrlBtn');
      btn.textContent = '✅ Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '📋 Copy'; btn.classList.remove('copied'); }, 2000);
    }).catch(() => showToast('Could not copy to clipboard.', 'error'));
  };

  // Preload ElevenLabs SDK in background
  if (!aitwSdkLoaded && !window._aitwConvClass) {
    import('https://esm.sh/@elevenlabs/client@0.15.0')
      .then(m => { window._aitwConvClass = m.Conversation || null; aitwSdkLoaded = true; })
      .catch(() => {});
  }
}

function updateLangToggle(lang) {
  qs('#langEN').classList.toggle('active', lang === 'en');
  qs('#langES').classList.toggle('active', lang === 'es');
}

// ── AI Test Widget helpers ───────────────────────────────────

function setAiTestLang(lang) {
  if (aitwActive) return;
  aitwLang = lang;
  const voices = lang === 'es' ? AI_VOICES_ES : AI_VOICES_EN;
  if (!voices.find(v => v.id === aitwVoiceId)) aitwVoiceId = voices[0].id;
  renderAitwVoicePills();
  updateAitwLangBtns();
}

function updateAitwLangBtns() {
  qs('#aitwLangEN')?.classList.toggle('aitw-lang-active', aitwLang === 'en');
  qs('#aitwLangES')?.classList.toggle('aitw-lang-active', aitwLang === 'es');
  qs('#aitwLangEN')?.classList.toggle('aitw-lang-btn', true);
  qs('#aitwLangES')?.classList.toggle('aitw-lang-btn', true);
}

function renderAitwVoicePills() {
  const row = qs('#aitwVoiceRow');
  if (!row) return;
  const voices = aitwLang === 'es' ? AI_VOICES_ES : AI_VOICES_EN;
  row.innerHTML = voices.map(v => `
    <button class="aitw-voice-pill${v.id === aitwVoiceId ? ' selected' : ''}"
      onclick="pickAitwVoice('${v.id}')">${v.name}</button>
  `).join('');
}

function pickAitwVoice(id) {
  if (aitwActive) return;
  aitwVoiceId = id;
  renderAitwVoicePills();
}

async function toggleAiTestCall() {
  if (aitwActive) {
    endAiTestCall();
  } else {
    await startAiTestCall();
  }
}

function setAitwStatus(msg) {
  const el = qs('#aitwStatus');
  if (el) el.textContent = msg;
}

async function startAiTestCall() {
  const agentId = qs('#agentIdInput')?.value.trim();
  if (!agentId) {
    showToast('Enter your ElevenLabs Agent ID first.', 'error');
    return;
  }

  aitwActive = true;
  qs('#aitwFab')?.classList.add('active-call');
  qs('#aitwWaves')?.classList.add('active');
  qs('#aitwFabLabel').textContent = aitwLang === 'es' ? 'Toca para terminar' : 'Tap to end';
  setAitwStatus(aitwLang === 'es' ? '📡 Conectando…' : '📡 Connecting…');

  try {
    if (!window._aitwConvClass) {
      const m = await import('https://esm.sh/@elevenlabs/client@0.15.0');
      window._aitwConvClass = m.Conversation || null;
      aitwSdkLoaded = true;
    }
    if (!window._aitwConvClass) throw new Error('ElevenLabs SDK unavailable');

    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
    } catch {}

    const bizName = bizDoc?.name || '';
    const es = aitwLang === 'es';
    const prompt = qs('#greetingInput')?.value.trim() ||
      (es ? `Eres el recepcionista de IA de ${bizName}. Sé profesional y amable.`
           : `You are the AI receptionist for ${bizName}. Be professional and friendly.`);
    const firstMessage = es
      ? `¡Hola! Bienvenido a ${bizName}. Soy su recepcionista virtual. ¿En qué le puedo ayudar?`
      : `Hello! Welcome to ${bizName}. I'm your AI receptionist. How can I help you today?`;

    aitwSession = await window._aitwConvClass.startSession({
      agentId,
      overrides: {
        agent: {
          prompt: { prompt },
          language: aitwLang,
          firstMessage
        },
        tts: { voiceId: aitwVoiceId, modelId: 'eleven_turbo_v2_5' }
      },
      onConnect: () => {
        setAitwStatus(es ? '🟢 Conectado — hablando…' : '🟢 Connected — speaking…');
      },
      onDisconnect: () => { endAiTestCall(); },
      onError: (e) => {
        const msg = e?.message || '';
        setAitwStatus('⚠️ ' + (msg.slice(0, 60) || (es ? 'Error de conexión.' : 'Connection error.')));
        endAiTestCall(true);
      }
    });

  } catch (err) {
    console.error('AI test call error:', err);
    setAitwStatus('⚠️ ' + (err.message?.slice(0, 70) || 'Could not connect.'));
    endAiTestCall(true);
  }
}

function endAiTestCall(skipEnd = false) {
  if (aitwSession && !skipEnd) {
    try { aitwSession.endSession().catch(() => {}); } catch {}
  }
  aitwSession = null;
  aitwActive  = false;
  qs('#aitwFab')?.classList.remove('active-call');
  qs('#aitwWaves')?.classList.remove('active');
  if (qs('#aitwFabLabel')) qs('#aitwFabLabel').textContent = 'Talk to Your AI';
  setAitwStatus('');
}

// expose to onclick handlers
window.setAiTestLang   = setAiTestLang;
window.pickAitwVoice   = pickAitwVoice;
window.toggleAiTestCall = toggleAiTestCall;

async function saveAiSettings() {
  if (!bizId) return;
  const btn = qs('#saveAiSettingsBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Saving…';

  try {
    await updateDoc(doc(db, 'businesses', bizId), {
      agentId:    qs('#agentIdInput').value.trim(),
      lang:       selectedLang,
      voiceIdEn:  qs('#voiceIdEnSelect').value,
      voiceIdEs:  qs('#voiceIdEsSelect').value,
      greeting:   qs('#greetingInput').value.trim(),
      hours:      qs('#hoursInput').value.trim()
    });
    showToast('AI settings saved!');
  } catch (err) {
    console.error('saveAiSettings error:', err);
    showToast('Failed to save settings.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save AI Settings';
  }
}

// ── Account ──────────────────────────────────────────────────
async function loadAccount() {
  if (!ownerDoc || !bizDoc) return;

  qs('#accBizName').value    = bizDoc.name     || '';
  qs('#accCategory').value   = bizDoc.category || '';
  qs('#accAddress').value    = bizDoc.address  || '';
  qs('#accPhone').value      = bizDoc.phone    || ownerDoc.phone || '';
  qs('#accOwnerName').value  = ownerDoc.name   || '';
  qs('#accEmail').value      = currentUser.email || '';

  // Payment options
  const pay = bizDoc.payment || {};
  qs('#accStripe').value   = pay.stripe  || '';
  qs('#accPaypal').value   = pay.paypal  || '';
  qs('#accCashapp').value  = pay.cashapp || '';
  qs('#accZelle').value    = pay.zelle   || '';

  // Plan
  const plan = ownerDoc.plan || bizDoc.plan || 'trial';
  const planCap = plan.charAt(0).toUpperCase() + plan.slice(1);
  const planBadgeEl = qs('#accPlanBadge');
  planBadgeEl.textContent = planCap;
  planBadgeEl.className   = `badge badge-${plan === 'trial' ? 'trial' : plan === 'pro' ? 'pro' : 'active'}`;
  qs('#accPlanDesc').textContent = plan === 'trial'
    ? 'Free trial — upgrade to unlock all features.'
    : plan === 'pro'
    ? 'Pro plan — full access.'
    : 'Active plan.';

  // Wire save
  qs('#saveAccountBtn').onclick = saveAccount;
}

async function saveAccount() {
  if (!bizId || !currentUser) return;
  const btn = qs('#saveAccountBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Saving…';

  try {
    // Update business doc
    await updateDoc(doc(db, 'businesses', bizId), {
      name:    qs('#accBizName').value.trim(),
      address: qs('#accAddress').value.trim(),
      phone:   qs('#accPhone').value.trim(),
      payment: {
        stripe:  qs('#accStripe').value.trim(),
        paypal:  qs('#accPaypal').value.trim(),
        cashapp: qs('#accCashapp').value.trim(),
        zelle:   qs('#accZelle').value.trim()
      }
    });

    // Update owner doc
    await updateDoc(doc(db, 'owners', currentUser.uid), {
      name:  qs('#accOwnerName').value.trim(),
      phone: qs('#accPhone').value.trim()
    });

    // Reflect sidebar biz name update
    bizDoc.name = qs('#accBizName').value.trim();
    qs('#sidebarBizName').textContent = bizDoc.name;

    showToast('Account saved!');
  } catch (err) {
    console.error('saveAccount error:', err);
    showToast('Failed to save account.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  }
}

// ── Sign Out ─────────────────────────────────────────────────
async function signOutUser() {
  try {
    await signOut(auth);
    window.location.href = '/auth.html';
  } catch (err) {
    console.error('signOut error:', err);
    showToast('Sign out failed.', 'error');
  }
}

// ════════════════════════════════════════════════════════════
//  TEAM MANAGEMENT
// ════════════════════════════════════════════════════════════

function genEmpCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function loadTeam() {
  // Wire button before bizId check so it always works
  qs('#addEmpBtn').onclick = addEmployee;

  if (!bizId) return;

  const tbody = qs('#empTableBody');
  tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><p>Loading…</p></div></td></tr>`;

  try {
    const q = query(
      collection(db, 'employees'),
      where('bizId', '==', bizId)
    );
    const snap = await getDocs(q);

    qs('#empCount').textContent = `${snap.size} member${snap.size !== 1 ? 's' : ''}`;

    if (snap.empty) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><div class="empty-state-icon">👷</div><p>No team members yet. Add your first employee above.</p></div></td></tr>`;
      return;
    }

    tbody.innerHTML = '';
    snap.forEach(d => {
      const emp    = d.data();
      const active = emp.wtActive !== false;
      const wtLink = `https://ep-local-pro-ai.netlify.app/wt?b=${bizId}&e=${emp.code}`;
      const tr     = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-weight:600;">${emp.name || '—'}</td>
        <td>${emp.role || '—'}</td>
        <td><span class="emp-code-badge">${emp.code}</span></td>
        <td class="emp-link-cell">
          <span style="font-size:0.75rem;color:var(--indigo);font-family:monospace;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${wtLink}</span>
          <button class="btn-action" data-link="${wtLink}">Copy</button>
        </td>
        <td>
          <button class="btn-wt-toggle ${active ? 'active' : 'off'}"
            data-empid="${d.id}" data-active="${active}"
            title="${active ? 'Click to remove radio access' : 'Click to restore radio access'}">
            ${active ? '📻 On' : '🔇 Off'}
          </button>
        </td>
        <td>
          <button class="btn-action danger" data-empid="${d.id}" style="color:var(--red,#ef4444);border-color:#fca5a5;">Delete</button>
        </td>`;

      tr.querySelector('[data-link]').onclick = function() {
        navigator.clipboard.writeText(this.dataset.link).then(() => {
          this.textContent = '✓ Copied';
          setTimeout(() => { this.textContent = 'Copy'; }, 1800);
        });
      };

      tr.querySelector('.btn-wt-toggle').onclick = function() {
        const isActive = this.dataset.active === 'true';
        toggleEmployeeWt(this.dataset.empid, isActive);
      };

      tr.querySelector('.btn-action.danger').onclick = function() {
        deleteEmployee(this.dataset.empid);
      };

      tbody.appendChild(tr);
    });

    loadOwnerWtLink();

    // Refresh WT online list
    if (typeof refreshWtOnlineList === 'function') refreshWtOnlineList();

  } catch (err) {
    console.error('loadTeam error:', err);
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><p>Failed to load team.</p></div></td></tr>`;
  }
}

async function addEmployee() {
  const name = qs('#empName').value.trim();
  const role = qs('#empRole').value.trim();

  if (!name) { showToast('Employee name is required.', 'error'); return; }
  if (!role) { showToast('Role is required.', 'error'); return; }
  if (!bizId) { showToast('No business set up yet.', 'error'); return; }

  const btn = qs('#addEmpBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Adding…';

  try {
    const code = genEmpCode();
    await addDoc(collection(db, 'employees'), {
      bizId,
      ownerId:  currentUser.uid,
      name,
      role,
      code,
      wtActive: true,
      createdAt: serverTimestamp()
    });
    qs('#empName').value = '';
    qs('#empRole').value = '';
    showToast(`${name} added!`);
    loadTeam();
  } catch (err) {
    console.error('addEmployee error:', err);
    showToast('Failed to add employee.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '＋ Add Employee';
  }
}

async function deleteEmployee(empId) {
  if (!confirm('Remove this employee? Their walkie talkie link will stop working.')) return;
  try {
    await deleteDoc(doc(db, 'employees', empId));
    showToast('Employee removed.');
    loadTeam();
  } catch (err) {
    console.error('deleteEmployee error:', err);
    showToast('Failed to remove employee.', 'error');
  }
}

async function loadOwnerWtLink() {
  if (!bizId) return;
  const card = qs('#ownerWtCard');
  if (!card) return;

  try {
    // Load or generate the owner WT token
    let token = bizDoc?.wtOwnerToken;
    if (!token) {
      token = Array.from(crypto.getRandomValues(new Uint8Array(16)),
        b => b.toString(16).padStart(2, '0')).join('');
      await updateDoc(doc(db, 'businesses', bizId), { wtOwnerToken: token });
      if (bizDoc) bizDoc.wtOwnerToken = token;
    }

    const link = `https://ep-local-pro-ai.netlify.app/wt?b=${bizId}&o=${token}`;
    const textEl = qs('#ownerWtLinkText');
    if (textEl) textEl.textContent = link;

    const copyBtn = qs('#copyOwnerWtBtn');
    if (copyBtn) {
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(link).then(() => {
          copyBtn.textContent = '✓ Copied';
          setTimeout(() => { copyBtn.textContent = 'Copy Link'; }, 2000);
        });
      };
    }

    card.style.display = '';
  } catch (err) {
    console.error('loadOwnerWtLink error:', err);
  }
}

async function toggleEmployeeWt(empId, currentActive) {
  const newActive = !currentActive;
  const label     = newActive ? 'restore' : 'remove';
  if (!confirm(`${label === 'restore' ? 'Restore' : 'Remove'} walkie talkie access for this employee?`)) return;
  try {
    await updateDoc(doc(db, 'employees', empId), { wtActive: newActive });
    showToast(newActive ? 'Radio access restored.' : 'Radio access removed.');
    loadTeam();
  } catch (err) {
    console.error('toggleEmployeeWt error:', err);
    showToast('Failed to update access.', 'error');
  }
}

// ════════════════════════════════════════════════════════════
//  WALKIE TALKIE FAB — two-way all-staff channel
// ════════════════════════════════════════════════════════════

let wtMsgUnsub    = null;
let wtUnread      = 0;
let wtPanelOpen    = false;
let wtHistoryLoaded = false;
const wtPlayedSet  = new Set();

// MediaRecorder state (owner PTT)
let wtMediaStream  = null;
let wtRecorder     = null;
let wtAudioChunks  = [];
let wtIsRecording  = false;
let wtRecTimer     = null;

// Audio playback queue (owner side)
let wtAudioQueue   = [];
let wtAudioPlaying = false;

// Push notifications
let wtSwRegistration = null;
const WT_VAPID_PUBLIC_KEY = 'BImnaD28aQfG8YdR9_PjwdlPLIfiGk4vfBfbmzo2uDOF21EEgDruZVxBUlupf2ObNL3zP5ATrlEgZDFRlhsEFxY';

// Contacts / channel targeting
let wtSelectedTargets = new Set(); // empty = all staff broadcast; Set of empCodes = targeted
let wtLastSpeakerId   = null;      // empCode of most recent incoming message
let wtEmployeeList   = [];    // [{empId, empCode, name, role, lastSeen, wtOnline}]
let wtContactsOpen   = false; // contacts dropdown state

function initWalkieTalkie() {
  const fabWrap = qs('#wtFabWrap');
  if (!fabWrap) return;
  wtRegisterSW();
  fabWrap.classList.remove('hidden');

  qs('#wtFabBtn').addEventListener('click', () => {
    wtPanelOpen ? closeWtPanel() : openWtPanel();
  });
  qs('#wtPanelClose').addEventListener('click', closeWtPanel);
  qs('#wtContactsToggle')?.addEventListener('click', toggleWtContacts);

  const pttBtn  = qs('#wtOwnerPtt');
  const statusEl = qs('#wtOwnerStatus');

  function onOwnerActivate(e) {
    e.preventDefault();
    e.stopPropagation();
    pttBtn.classList.remove('wt-owner-activate');
    pttBtn.querySelector('.wt-ptt-text').textContent = 'Hold to Talk';
    if (statusEl) statusEl.textContent = '🎤 Allow microphone in the popup…';

    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(stream => {
        wtMediaStream = stream;
        if (statusEl) {
          if (wtSelectedTargets.size === 1) {
            const code = [...wtSelectedTargets][0];
            const emp  = wtEmployeeList.find(e => e.empCode === code);
            statusEl.textContent = `Hold to reply to ${emp?.name || 'Staff'} only`;
          } else if (wtSelectedTargets.size > 1) {
            statusEl.textContent = `Hold to talk to ${wtSelectedTargets.size} employees`;
          } else {
            statusEl.textContent = 'Hold to broadcast to all staff';
          }
        }
        wtSubscribePush();
        pttBtn.addEventListener('mousedown',  startOwnerRecording);
        pttBtn.addEventListener('touchstart', startOwnerRecording, { passive: false });
        pttBtn.addEventListener('mouseup',    stopOwnerRecording);
        pttBtn.addEventListener('touchend',   stopOwnerRecording,  { passive: false });
        pttBtn.addEventListener('mouseleave', stopOwnerRecording);
      })
      .catch(() => {
        pttBtn.classList.add('wt-owner-activate');
        pttBtn.querySelector('.wt-ptt-text').textContent = 'Activate Radio';
        if (statusEl) statusEl.textContent = '⚠️ Mic blocked — allow mic then tap again';
      });
  }

  pttBtn.addEventListener('click',      onOwnerActivate, { once: true, passive: false });
  pttBtn.addEventListener('touchstart', onOwnerActivate, { once: true, passive: false });

  wtRequestNotifPermission();
  subscribeWtMessages();
  refreshWtOnlineList();
  setInterval(refreshWtOnlineList, 30_000);
  loadWtEmployees();
}

function openWtPanel() {
  qs('#wtPanel').classList.add('open');
  qs('#wtFabBtn').classList.add('active');
  wtPanelOpen = true;
  wtUnread = 0;
  const badge = qs('#wtFabBadge');
  if (badge) { badge.textContent = '0'; badge.classList.add('hidden'); }
}

function closeWtPanel() {
  qs('#wtPanel').classList.remove('open');
  qs('#wtFabBtn').classList.remove('active');
  wtPanelOpen = false;
}

async function refreshWtOnlineList() {
  if (!bizId) return;
  try {
    const snap   = await getDocs(query(collection(db, 'employees'), where('bizId', '==', bizId)));
    const now    = Date.now();
    const twoMin = 120_000;
    const online = snap.docs.map(d => d.data()).filter(e => {
      const ls = e.lastSeen?.toMillis?.() ?? 0;
      return e.wtOnline && (now - ls) < twoMin;
    });
    const textEl = qs('#wtPanelOnlineText');
    if (textEl) {
      textEl.textContent = online.length
        ? `${online.length} staff online: ${online.map(e => e.name || 'Staff').join(', ')}`
        : 'No staff online yet';
    }
    // Sync online status into the contacts list
    snap.docs.forEach(d => {
      const idx = wtEmployeeList.findIndex(e => e.empId === d.id);
      if (idx >= 0) {
        wtEmployeeList[idx].lastSeen = d.data().lastSeen || null;
        wtEmployeeList[idx].wtOnline = d.data().wtOnline || false;
      }
    });
    renderWtContacts();
  } catch {}
}

async function loadWtEmployees() {
  if (!bizId) return;
  try {
    const snap = await getDocs(query(collection(db, 'employees'), where('bizId', '==', bizId)));
    wtEmployeeList = snap.docs
      .filter(d => d.data().wtActive !== false)
      .map(d => ({
        empId:    d.id,
        empCode:  d.data().code || '',
        name:     d.data().name || 'Staff',
        role:     d.data().role || '',
        lastSeen: d.data().lastSeen || null,
        wtOnline: d.data().wtOnline || false
      }));
    renderWtContacts();
  } catch (err) {
    console.error('loadWtEmployees error:', err);
  }
}

function renderWtContacts() {
  const list = qs('#wtContactList');
  if (!list) return;
  const now    = Date.now();
  const twoMin = 120_000;

  list.innerHTML = '';

  // "All Staff" broadcast row — selected when no specific targets chosen
  const allBtn = document.createElement('button');
  allBtn.className = 'wt-contact-item' + (wtSelectedTargets.size === 0 ? ' selected' : '');
  allBtn.dataset.target = '';
  const allIcon = document.createElement('span');
  allIcon.className = 'wt-contact-icon';
  allIcon.textContent = '📡';
  const allInfo = document.createElement('div');
  allInfo.className = 'wt-contact-info';
  const allName = document.createElement('span');
  allName.className = 'wt-contact-name';
  allName.textContent = 'All Staff';
  const allRole = document.createElement('span');
  allRole.className = 'wt-contact-role';
  allRole.textContent = 'Broadcast';
  allInfo.append(allName, allRole);
  allBtn.append(allIcon, allInfo);
  allBtn.addEventListener('click', () => selectWtTarget(null));
  list.appendChild(allBtn);

  for (const emp of wtEmployeeList) {
    const isOnline    = emp.wtOnline && (now - (emp.lastSeen?.toMillis?.() ?? 0)) < twoMin;
    const isSelected  = wtSelectedTargets.has(emp.empCode);
    const hasActivity = wtLastSpeakerId === emp.empCode;

    const btn = document.createElement('button');
    btn.className = 'wt-contact-item' +
      (isSelected  ? ' selected'  : '') +
      (hasActivity ? ' activity'  : '');
    btn.dataset.empCode = emp.empCode;

    const dot = document.createElement('span');
    dot.className = 'wt-contact-dot' + (isOnline ? ' online' : '');

    const info = document.createElement('div');
    info.className = 'wt-contact-info';
    const nameEl = document.createElement('span');
    nameEl.className = 'wt-contact-name';
    nameEl.textContent = emp.name;
    const roleEl = document.createElement('span');
    roleEl.className = 'wt-contact-role';
    roleEl.textContent = emp.role;
    info.append(nameEl, roleEl);

    btn.append(dot, info);

    if (isSelected) {
      const chk = document.createElement('span');
      chk.className = 'wt-contact-badge';
      chk.textContent = '✓';
      btn.appendChild(chk);
    } else if (hasActivity) {
      const badge = document.createElement('span');
      badge.className = 'wt-contact-badge';
      badge.textContent = '🔊';
      btn.appendChild(badge);
    }

    btn.addEventListener('click', () => selectWtTarget(emp.empCode));
    list.appendChild(btn);
  }
  updateWtContactsToggle();
}

function selectWtTarget(empCode) {
  if (!empCode) {
    // All Staff — clear all selections back to broadcast
    wtSelectedTargets.clear();
    wtLastSpeakerId = null;
  } else {
    // Toggle the employee in/out of the target set
    if (wtSelectedTargets.has(empCode)) {
      wtSelectedTargets.delete(empCode);
      if (wtLastSpeakerId === empCode) wtLastSpeakerId = null;
    } else {
      wtSelectedTargets.add(empCode);
    }
  }
  renderWtContacts();
  updateWtContactsToggle();

  const pttBtn   = qs('#wtOwnerPtt');
  const statusEl = qs('#wtOwnerStatus');
  if (!pttBtn || pttBtn.classList.contains('wt-owner-activate') || wtIsRecording) return;

  const pttLabel = pttBtn.querySelector('.wt-ptt-text');
  if (wtSelectedTargets.size === 1) {
    const code = [...wtSelectedTargets][0];
    const emp  = wtEmployeeList.find(e => e.empCode === code);
    const n    = emp?.name || 'Staff';
    if (pttLabel) pttLabel.textContent = `Reply to ${n}`;
    if (statusEl) statusEl.textContent = `Hold to reply to ${n} only`;
  } else if (wtSelectedTargets.size > 1) {
    if (pttLabel) pttLabel.textContent = `Talk to ${wtSelectedTargets.size}`;
    if (statusEl) statusEl.textContent = `Hold to talk to ${wtSelectedTargets.size} employees`;
  } else {
    if (pttLabel) pttLabel.textContent = 'Hold to Talk';
    if (statusEl) statusEl.textContent = 'Hold to broadcast to all staff';
  }
}

function openWtContacts() {
  wtContactsOpen = true;
  qs('#wtContacts')?.classList.add('open');
}

function closeWtContacts() {
  wtContactsOpen = false;
  qs('#wtContacts')?.classList.remove('open');
}

function toggleWtContacts() {
  wtContactsOpen ? closeWtContacts() : openWtContacts();
}

function updateWtContactsToggle() {
  const el = qs('#wtContactsCurrent');
  if (!el) return;
  if (wtSelectedTargets.size === 0) {
    el.textContent = '📡 All Staff';
    el.classList.remove('has-activity');
  } else if (wtSelectedTargets.size === 1) {
    const code = [...wtSelectedTargets][0];
    const emp  = wtEmployeeList.find(e => e.empCode === code);
    const hasActivity = wtLastSpeakerId === code;
    el.textContent = (emp?.name || 'Staff') + (hasActivity ? ' 🔊' : '');
    el.classList.toggle('has-activity', hasActivity);
  } else {
    el.textContent = `${wtSelectedTargets.size} Employees`;
    el.classList.remove('has-activity');
  }
}

// ── All-staff message feed ────────────────────────────────────
function subscribeWtMessages() {
  if (!bizId) return;
  if (wtMsgUnsub) { wtMsgUnsub(); wtMsgUnsub = null; }

  const q = query(
    collection(db, 'wt_messages'),
    where('bizId', '==', bizId)
  );

  wtMsgUnsub = onSnapshot(q, snap => {
    snap.docChanges().forEach(change => {
      if (change.type !== 'added') return;
      const msgId = change.doc.id;
      const data  = change.doc.data();

      if (wtPlayedSet.has(msgId)) return;
      wtPlayedSet.add(msgId);

      // Skip messages not directed to owner (employee-to-employee private chats)
      if (data.to) {
        const toList = Array.isArray(data.to) ? data.to : [data.to];
        if (!toList.includes('owner')) return;
      }

      // Play audio + badge only for new real-time messages (not history)
      if (wtHistoryLoaded && data.from !== 'owner') {
        const name = data.fromName || 'Staff';

        // Auto-select the employee who just spoke and open the dropdown
        wtLastSpeakerId  = data.from;
        wtSelectedTargets = new Set([data.from]);
        openWtContacts();
        renderWtContacts();
        updateWtContactsToggle();
        // Update PTT text to show targeted reply
        const _ptt = qs('#wtOwnerPtt');
        const _st  = qs('#wtOwnerStatus');
        if (_ptt && !_ptt.classList.contains('wt-owner-activate') && !wtIsRecording) {
          const _emp = wtEmployeeList.find(e => e.empCode === data.from);
          const _n   = _emp?.name || data.fromName || 'Staff';
          const _lbl = _ptt.querySelector('.wt-ptt-text');
          if (_lbl) _lbl.textContent = `Reply to ${_n}`;
          if (_st)  _st.textContent  = `Hold to reply to ${_n} only`;
        }

        wtNotifyIncoming(name);
        if (data.audioUrl) {
          enqueueWtAudio(name, data.audioUrl, null);
        } else if (data.audioB64) {
          enqueueWtAudio(name, null, { b64: data.audioB64, type: data.mimeType || 'audio/webm' });
        }

        if (!wtPanelOpen) {
          wtUnread++;
          const badge = qs('#wtFabBadge');
          if (badge) { badge.textContent = wtUnread; badge.classList.remove('hidden'); }
        }
      }
    });
    wtHistoryLoaded = true;
  }, err => console.error('wt_messages snapshot error:', err));
}

// ── Owner PTT ────────────────────────────────────────────────
function startOwnerRecording(e) {
  e.preventDefault();
  if (wtIsRecording || !wtMediaStream) return;

  wtIsRecording = true;
  wtAudioChunks = [];
  qs('#wtOwnerPtt').classList.add('recording');
  qs('#wtOwnerStatus').textContent = '🔴 Recording…';

  const mimeType = wtGetSupportedMimeType();
  try {
    wtRecorder = new MediaRecorder(wtMediaStream, mimeType ? { mimeType } : {});
  } catch {
    wtRecorder = new MediaRecorder(wtMediaStream);
  }
  wtRecorder.ondataavailable = ev => { if (ev.data.size > 0) wtAudioChunks.push(ev.data); };
  wtRecorder.onstop = onOwnerRecordingStop;
  wtRecorder.start(100);

  // Auto-stop after 20 seconds
  wtRecTimer = setTimeout(() => { if (wtIsRecording) stopOwnerRecording(); }, 20_000);
}

function stopOwnerRecording(e) {
  if (e) e.preventDefault();
  if (!wtIsRecording) return;
  clearTimeout(wtRecTimer);
  wtIsRecording = false;
  qs('#wtOwnerPtt')?.classList.remove('recording');
  qs('#wtOwnerStatus').textContent = 'Sending…';
  if (wtRecorder?.state === 'recording') wtRecorder.stop();
}

function resetOwnerPtt() {
  const ptt = qs('#wtOwnerPtt');
  ptt?.classList.remove('recording');
  const status = qs('#wtOwnerStatus');
  if (status) {
    const lbl = ptt?.querySelector('.wt-ptt-text');
    if (wtSelectedTargets.size === 1) {
      const code = [...wtSelectedTargets][0];
      const emp  = wtEmployeeList.find(e => e.empCode === code);
      const n    = emp?.name || code;
      status.textContent = `Hold to reply to ${n} only`;
      if (lbl) lbl.textContent = `Reply to ${n}`;
    } else if (wtSelectedTargets.size > 1) {
      status.textContent = `Hold to talk to ${wtSelectedTargets.size} employees`;
      if (lbl) lbl.textContent = `Talk to ${wtSelectedTargets.size}`;
    } else {
      status.textContent = 'Broadcast to all staff';
      if (lbl) lbl.textContent = 'Hold to Talk';
    }
  }
  wtRecorder = null;
}

async function onOwnerRecordingStop() {
  wtRecorder = null;
  if (!wtAudioChunks.length) { resetOwnerPtt(); return; }

  const mimeType    = wtAudioChunks[0]?.type || 'audio/webm';
  const blob        = new Blob(wtAudioChunks, { type: mimeType });
  wtAudioChunks     = [];

  if (blob.size < 500) { resetOwnerPtt(); return; }

  const statusEl = qs('#wtOwnerStatus');
  if (statusEl) statusEl.textContent = 'Sending…';

  const durationSec = Math.max(1, Math.round(blob.size / 3000));
  const ownerName   = bizDoc?.name || ownerDoc?.companyName || 'Boss';

  // Transcode to WAV so iOS Safari (which can't play webm) can play audio from Chrome senders
  let sendBlob = blob;
  let sendMime = 'audio/wav';
  try { sendBlob = await wtEncodeToWav(blob); } catch { sendBlob = blob; sendMime = mimeType; }

  try {
    const payload = { bizId, from: 'owner', fromName: ownerName, mimeType: sendMime, duration: durationSec, createdAt: serverTimestamp() };
    if (wtSelectedTargets.size === 1) {
      payload.to = [...wtSelectedTargets][0];
    } else if (wtSelectedTargets.size > 1) {
      payload.to = [...wtSelectedTargets];
    }

    const aRef = storageRef(storage, `wt_audio/${bizId}/${Date.now()}_owner.wav`);
    const snap  = await uploadBytes(aRef, sendBlob, { contentType: sendMime });
    payload.audioUrl    = await getDownloadURL(snap.ref);
    payload.storagePath = snap.ref.fullPath;

    await addDoc(collection(db, 'wt_messages'), payload);
    wtSendPush(ownerName, payload.to ?? null);
  } catch (err) {
    console.error('sendWtAudio error:', err);
    showToast('Failed to send voice message.', 'error');
  } finally {
    resetOwnerPtt();
  }
}

function wtGetSupportedMimeType() {
  const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

// ── Audio playback queue (owner side) ────────────────────────
function enqueueWtAudio(fromName, audioUrl, b64Data) {
  wtAudioQueue.push({ fromName, audioUrl, b64Data });
  if (!wtAudioPlaying) drainWtAudioQueue();
}

async function drainWtAudioQueue() {
  if (!wtAudioQueue.length) { wtAudioPlaying = false; return; }
  wtAudioPlaying = true;
  const { fromName, audioUrl, b64Data } = wtAudioQueue.shift();

  const audioInd  = qs('#wtPanelAudioInd');
  const audioFrom = qs('#wtPanelAudioFrom');
  if (audioFrom) audioFrom.textContent = fromName;
  if (audioInd)  audioInd.classList.remove('hidden');

  try {
    let url = audioUrl;
    let isObjectUrl = false;
    if (!url && b64Data?.b64) {
      const bytes = Uint8Array.from(atob(b64Data.b64), c => c.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bytes], { type: b64Data.type }));
      isObjectUrl = true;
    }
    if (!url) { if (audioInd) audioInd.classList.add('hidden'); drainWtAudioQueue(); return; }

    const player = new Audio(url);
    player.onended = () => {
      if (isObjectUrl) URL.revokeObjectURL(url);
      if (audioInd) audioInd.classList.add('hidden');
      drainWtAudioQueue();
    };
    player.onerror = () => {
      if (isObjectUrl) URL.revokeObjectURL(url);
      if (audioInd) audioInd.classList.add('hidden');
      drainWtAudioQueue();
    };
    await player.play();
  } catch (err) {
    console.error('drainWtAudioQueue error:', err);
    if (audioInd) audioInd.classList.add('hidden');
    drainWtAudioQueue();
  }
}

async function wtEncodeToWav(blob) {
  const arrayBuf = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try {
    decoded = await audioCtx.decodeAudioData(arrayBuf);
  } finally {
    audioCtx.close();
  }
  const targetSr = 16000;
  const srcData  = decoded.getChannelData(0);
  const ratio    = decoded.sampleRate / targetSr;
  const outLen   = Math.ceil(srcData.length / ratio);
  const pcm16    = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const v = Math.max(-1, Math.min(1, srcData[Math.floor(i * ratio)]));
    pcm16[i] = v < 0 ? v * 32768 : v * 32767;
  }
  const dataBytes = pcm16.buffer.byteLength;
  const wavBuf    = new ArrayBuffer(44 + dataBytes);
  const dv        = new DataView(wavBuf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE'); str(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, targetSr, true); dv.setUint32(28, targetSr * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, dataBytes, true);
  new Int16Array(wavBuf, 44).set(pcm16);
  return new Blob([wavBuf], { type: 'audio/wav' });
}

// ── WT Notifications ─────────────────────────────────────────
let wtNotifGranted = false;

function wtRequestNotifPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') { wtNotifGranted = true; return; }
  if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(p => { wtNotifGranted = (p === 'granted'); }).catch(() => {});
  }
}

function wtNotifyIncoming(senderName) {
  if (!wtNotifGranted) return;
  try {
    new Notification(`📻 ${senderName} is talking`, {
      body:     'Staff Radio — open dashboard to reply',
      tag:      'wt-incoming',
      renotify: true
    });
  } catch {}
}

function wtUrlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function wtRegisterSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    wtSwRegistration = await navigator.serviceWorker.register('/sw.js');
  } catch {}
}

async function wtSubscribePush() {
  if (!wtSwRegistration || !bizId) return;
  try {
    let sub = await wtSwRegistration.pushManager.getSubscription();
    if (!sub) {
      sub = await wtSwRegistration.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: wtUrlBase64ToUint8Array(WT_VAPID_PUBLIC_KEY)
      });
    }
    await setDoc(doc(db, 'wt_push_subs', `${bizId}_owner`), {
      bizId,
      identity:     'owner',
      subscription: sub.toJSON(),
      url:          window.location.href,
      updatedAt:    serverTimestamp()
    });
  } catch {}
}

async function wtSendPush(fromName, to) {
  try {
    let q;
    if (!to) {
      q = query(collection(db, 'wt_push_subs'), where('bizId', '==', bizId));
    } else {
      const toList = Array.isArray(to) ? to : [to];
      q = query(collection(db, 'wt_push_subs'), where('bizId', '==', bizId), where('identity', 'in', toList));
    }
    const snap = await getDocs(q);
    const items = [];
    snap.forEach(d => {
      const data = d.data();
      if (data.identity !== 'owner' && data.subscription) {
        items.push({ subscription: data.subscription, url: data.url || '/dashboard' });
      }
    });
    if (!items.length) return;
    fetch('/.netlify/functions/send-wt-push', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        items,
        title: '📻 Staff Radio',
        body:  `${fromName} sent a voice message — tap to listen`,
        tag:   'wt-call'
      })
    }).catch(() => {});
  } catch {}
}

// ── Doc Line Item helpers ────────────────────────────────────
function addDocLineItem(item = {}) {
  const list = qs('#genDocItemsList');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'doc-line-item-row';
  row.innerHTML = `
    <input class="dli-name"  type="text"   placeholder="Service / Item"  value="${escDocAttr(item.name  || '')}" />
    <input class="dli-qty"   type="number" placeholder="Qty" value="${item.qty != null ? item.qty : 1}" min="0.01" step="any" style="width:60px;" />
    <input class="dli-price" type="number" placeholder="Price" value="${item.price != null ? item.price : ''}" min="0" step="0.01" style="width:90px;" />
    <input class="dli-desc"  type="text"   placeholder="Notes (optional)" value="${escDocAttr(item.desc || '')}" />
    <button class="btn-remove-item" type="button" title="Remove">✕</button>`;
  row.querySelector('.btn-remove-item').onclick = () => { row.remove(); updateDocTotals(); };
  row.querySelectorAll('input').forEach(inp => inp.addEventListener('input', updateDocTotals));
  list.appendChild(row);
  updateDocTotals();
}

function updateDocTotals() {
  let subtotal = 0;
  document.querySelectorAll('#genDocItemsList .doc-line-item-row').forEach(row => {
    const qty   = parseFloat(row.querySelector('.dli-qty').value)   || 0;
    const price = parseFloat(row.querySelector('.dli-price').value) || 0;
    subtotal += qty * price;
  });
  const taxRate = parseFloat(qs('#genDocTaxRate')?.value) || 0;
  const tax   = subtotal * taxRate / 100;
  const total = subtotal + tax;

  const taxRow = qs('#genDocTaxRow');
  if (taxRow) taxRow.style.display = taxRate > 0 ? '' : 'none';
  const sub = qs('#genDocSubtotal'); if (sub) sub.textContent = '$' + subtotal.toFixed(2);
  const taxEl = qs('#genDocTaxAmt');   if (taxEl) taxEl.textContent = '$' + tax.toFixed(2);
  const tot = qs('#genDocTotal');     if (tot) tot.textContent = '$' + total.toFixed(2);
}

function escDocAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Business Profile ─────────────────────────────────────────
async function loadProfile() {
  if (!bizId) return;
  try {
    const snap = await getDoc(doc(db, 'businesses', bizId));
    const data = snap.data() || {};

    qs('#profCompanyName').value = data.companyName || data.name || '';
    qs('#profTagline').value     = data.tagline  || '';
    qs('#profAddress').value     = data.address  || '';
    qs('#profPhone').value       = data.phone    || '';
    qs('#profEmail').value       = data.email    || '';
    qs('#profWebsite').value     = data.website  || '';
    qs('#profLicense').value     = data.licenseNum || '';
    qs('#profHours').value       = data.hours    || '';

    // Logo preview
    if (data.logoUrl) {
      qs('#profileLogoImg').src = data.logoUrl;
      qs('#profileLogoImg').style.display = 'block';
      qs('#profileLogoPlaceholder').style.display = 'none';
    } else {
      qs('#profileLogoImg').style.display = 'none';
      qs('#profileLogoPlaceholder').style.display = 'flex';
    }
  } catch (err) {
    console.error('loadProfile error:', err);
    showToast('Failed to load profile.', 'error');
  }

}

async function saveProfile() {
  if (!bizId) {
    showToast('No business loaded — please refresh the page.', 'error');
    return;
  }
  const btn = qs('#saveProfileBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Saving…';

  try {
    const updates = {
      companyName: qs('#profCompanyName').value.trim(),
      tagline:     qs('#profTagline').value.trim(),
      address:     qs('#profAddress').value.trim(),
      phone:       qs('#profPhone').value.trim(),
      email:       qs('#profEmail').value.trim(),
      website:     qs('#profWebsite').value.trim(),
      licenseNum:  qs('#profLicense').value.trim(),
      hours:       qs('#profHours').value.trim(),
      updatedAt:   serverTimestamp()
    };
    await updateDoc(doc(db, 'businesses', bizId), updates);
    // Keep local bizDoc in sync for doc generation
    Object.assign(bizDoc, updates);
    showToast('Business profile saved!');
  } catch (err) {
    console.error('saveProfile error:', err);
    showToast('Error: ' + (err.message || err.code || 'Unknown error'), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Business Profile';
  }
}

function resizeLogo(file, maxW, maxH) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let w = img.width, h = img.height;
        const ratio = Math.min(maxW / w, maxH / h, 1);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/png', 0.85));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

