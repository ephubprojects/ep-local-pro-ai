/* ============================================================
   EP Local Pro AI — dashboard.js
   Business owner dashboard logic. Firebase module script.
   ============================================================ */

import { auth, db, storage } from '/js/firebase.js';
import {
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, onSnapshot, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
  ref as storageRef, uploadBytes, getDownloadURL
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

// ── State ────────────────────────────────────────────────────
let currentUser  = null;
let ownerDoc     = null;
let bizDoc       = null;
let bizId        = null;
let bizSlug      = null;
let bizCategory  = null;
let selectedLang = 'en';
let ordersUnsub  = null;

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
  const tbody = qs('#docsTableBody');
  tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><p>Loading…</p></div></td></tr>`;

  // Wire generate button + dropdown
  const genBtn  = qs('#generateDocBtn');
  const genMenu = qs('#generateDocMenu');

  genBtn.onclick = (e) => {
    e.stopPropagation();
    genMenu.classList.toggle('open');
  };

  document.querySelectorAll('#generateDocMenu button[data-doc-type]').forEach(btn => {
    btn.onclick = () => {
      genMenu.classList.remove('open');
      openGenerateDocModal(btn.dataset.docType);
    };
  });

  try {
    const q = query(
      collection(db, 'documents'),
      where('businessId', '==', bizId),
      orderBy('createdAt', 'desc')
    );
    const snap = await getDocs(q);

    if (snap.empty) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><div class="empty-state-icon">📄</div><p>No documents yet.</p></div></td></tr>`;
      return;
    }

    tbody.innerHTML = '';
    snap.forEach(d => {
      const data = d.data();
      const typeCap = data.type ? data.type.charAt(0).toUpperCase() + data.type.slice(1) : '—';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span class="badge badge-${data.type || ''}">${typeCap}</span></td>
        <td>${data.customerName || '—'}</td>
        <td>${fmtDate(data.createdAt)}</td>
        <td>${data.status || 'generated'}</td>
        <td>
          <div class="row-actions">
            ${data.url ? `<a class="btn-action" href="${data.url}" target="_blank">View</a>` : ''}
            ${data.url ? `<a class="btn-action primary" href="${data.url}" download>Download</a>` : ''}
          </div>
        </td>`;
      tbody.appendChild(tr);
    });

  } catch (err) {
    console.error('loadDocuments error:', err);
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><p>Failed to load documents.</p></div></td></tr>`;
  }
}

function openGenerateDocModal(type) {
  const titles = { invoice: 'Generate Invoice', estimate: 'Generate Estimate', contract: 'Generate Contract', receipt: 'Generate Receipt' };
  qs('#genDocModalTitle').textContent = titles[type] || 'Generate Document';
  qs('#genDocType').value = type;

  // Populate business profile banner
  const biz = bizDoc || {};
  const logoUrl = biz.logoUrl || '';
  const logoEl = qs('#docBizLogoPreview');
  if (logoUrl) { logoEl.src = logoUrl; logoEl.style.display = 'block'; }
  else logoEl.style.display = 'none';
  qs('#docBizNamePreview').textContent = biz.companyName || biz.name || '—';
  const details = [biz.address, biz.phone, biz.email].filter(Boolean).join(' · ');
  qs('#docBizDetailPreview').textContent = details || 'Complete your Business Profile to personalize documents.';

  // Wire edit profile link inside modal
  const editLink = qs('#docBizBanner [data-nav="profile"]');
  if (editLink) {
    editLink.onclick = () => {
      qs('#generateDocModal').classList.add('hidden');
      showSection('profile');
    };
  }

  // Reset fields
  qs('#genDocCustomer').value = '';
  qs('#genDocCustEmail').value = '';
  qs('#genDocCustAddress').value = '';
  qs('#genDocDate').value = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  qs('#genDocTaxRate').value = '0';
  qs('#genDocNotes').value = '';
  qs('#genDocTerms').value = '';
  qs('#genDocTermsGroup').classList.toggle('hidden', type !== 'contract');

  // Reset line items — start with 1 blank row
  const list = qs('#genDocItemsList');
  list.innerHTML = '';
  addDocLineItem();

  updateDocTotals();
  qs('#generateDocModal').classList.remove('hidden');

  // Wire add item + tax rate change
  qs('#addDocItemBtn').onclick = addDocLineItem;
  qs('#genDocTaxRate').oninput = updateDocTotals;
  qs('#confirmGenDocBtn').onclick = () => generateDocument(type);
}

async function generateDocument(type) {
  const customer = qs('#genDocCustomer').value.trim();
  if (!customer) { showToast('Customer name is required.', 'error'); return; }

  // Collect line items
  const items = [];
  document.querySelectorAll('#genDocItemsList .doc-line-item-row').forEach(row => {
    const name  = row.querySelector('.dli-name').value.trim();
    const qty   = parseFloat(row.querySelector('.dli-qty').value) || 1;
    const price = parseFloat(row.querySelector('.dli-price').value) || 0;
    const desc  = row.querySelector('.dli-desc').value.trim();
    if (name) items.push({ name, qty, price, desc });
  });
  if (!items.length) { showToast('Add at least one item.', 'error'); return; }

  const biz = bizDoc || {};
  const taxRate = parseFloat(qs('#genDocTaxRate').value) || 0;

  const payload = {
    type,
    bizName:    biz.companyName || biz.name || '',
    bizAddress: biz.address  || '',
    bizPhone:   biz.phone    || '',
    bizEmail:   biz.email    || '',
    bizLogo:    biz.logoUrl  || '',
    customerName:    customer,
    customerEmail:   qs('#genDocCustEmail').value.trim(),
    customerAddress: qs('#genDocCustAddress').value.trim(),
    items,
    taxRate,
    notes:         qs('#genDocNotes').value.trim(),
    contractTerms: type === 'contract' ? qs('#genDocTerms').value.trim() : ''
  };

  const btn = qs('#confirmGenDocBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Generating…';

  try {
    const res = await fetch('/.netlify/functions/invoice-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Server error');

    // Store in Firestore
    await addDoc(collection(db, 'documents'), {
      businessId:   bizId,
      type,
      customerName: customer,
      amount:       result.total || 0,
      status:       'generated',
      htmlContent:  result.htmlContent || null,
      createdAt:    serverTimestamp()
    });

    qs('#generateDocModal').classList.add('hidden');
    showToast(`${type.charAt(0).toUpperCase() + type.slice(1)} generated!`);
    loadDocuments();

  } catch (err) {
    console.error('generateDocument error:', err);
    showToast('Failed to generate document.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate';
  }
}

// ── AI Settings ──────────────────────────────────────────────
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

    // AI page URL
    qs('#aiUrlDisplay').textContent = `https://ep-local-pro-ai.netlify.app/${bizSlug || '—'}`;

  } catch (err) {
    console.error('loadAiSettings error:', err);
    showToast('Failed to load AI settings.', 'error');
  }

  // Wire save
  qs('#saveAiSettingsBtn').onclick = saveAiSettings;

  // Wire lang toggle
  qs('#langEN').onclick = () => { selectedLang = 'en'; updateLangToggle('en'); };
  qs('#langES').onclick = () => { selectedLang = 'es'; updateLangToggle('es'); };

  // Wire copy URL
  qs('#copyUrlBtn').onclick = () => {
    const url = `https://ep-local-pro-ai.netlify.app/${bizSlug}`;
    navigator.clipboard.writeText(url).then(() => {
      const btn = qs('#copyUrlBtn');
      btn.textContent = '✅ Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '📋 Copy'; btn.classList.remove('copied'); }, 2000);
    }).catch(() => showToast('Could not copy to clipboard.', 'error'));
  };
}

function updateLangToggle(lang) {
  qs('#langEN').classList.toggle('active', lang === 'en');
  qs('#langES').classList.toggle('active', lang === 'es');
}

async function saveAiSettings() {
  if (!bizId) return;
  const btn = qs('#saveAiSettingsBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Saving…';

  try {
    await updateDoc(doc(db, 'businesses', bizId), {
      agentId:  qs('#agentIdInput').value.trim(),
      lang:     selectedLang,
      greeting: qs('#greetingInput').value.trim(),
      hours:    qs('#hoursInput').value.trim()
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
let wtLoadTime    = 0;
let wtUnread      = 0;
let wtPanelOpen   = false;
const wtPlayedSet = new Set();

// MediaRecorder state (owner PTT)
let wtMediaStream  = null;
let wtRecorder     = null;
let wtAudioChunks  = [];
let wtIsRecording  = false;
let wtRecTimer     = null;

// Audio playback queue (owner side)
let wtAudioQueue   = [];
let wtAudioPlaying = false;

function initWalkieTalkie() {
  const fabWrap = qs('#wtFabWrap');
  if (!fabWrap) return;
  fabWrap.classList.remove('hidden');

  qs('#wtFabBtn').addEventListener('click', () => {
    wtPanelOpen ? closeWtPanel() : openWtPanel();
  });
  qs('#wtPanelClose').addEventListener('click', closeWtPanel);

  const pttBtn = qs('#wtOwnerPtt');
  pttBtn.addEventListener('mousedown',  startOwnerRecording);
  pttBtn.addEventListener('touchstart', startOwnerRecording, { passive: false });
  pttBtn.addEventListener('mouseup',    stopOwnerRecording);
  pttBtn.addEventListener('touchend',   stopOwnerRecording,  { passive: false });
  pttBtn.addEventListener('mouseleave', stopOwnerRecording);

  wtLoadTime = Date.now();
  subscribeWtMessages();
  refreshWtOnlineList();
  setInterval(refreshWtOnlineList, 30_000);
}

function openWtPanel() {
  qs('#wtPanel').classList.add('open');
  qs('#wtFabBtn').classList.add('active');
  wtPanelOpen = true;
  // Clear unread badge
  wtUnread = 0;
  const badge = qs('#wtFabBadge');
  if (badge) { badge.textContent = '0'; badge.classList.add('hidden'); }
  // Scroll feed to bottom
  const feed = qs('#wtMsgList');
  if (feed) feed.scrollTop = feed.scrollHeight;
}

function closeWtPanel() {
  qs('#wtPanel').classList.remove('open');
  qs('#wtFabBtn').classList.remove('active');
  wtPanelOpen = false;
}

async function refreshWtOnlineList() {
  if (!bizId) return;
  try {
    const snap = await getDocs(query(collection(db, 'employees'), where('bizId', '==', bizId)));
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
  } catch {}
}

// ── All-staff message feed ────────────────────────────────────
function subscribeWtMessages() {
  if (!bizId) return;
  if (wtMsgUnsub) { wtMsgUnsub(); wtMsgUnsub = null; }

  const q = query(
    collection(db, 'wt_messages'),
    where('bizId', '==', bizId),
    orderBy('createdAt', 'asc'),
    limit(100)
  );

  wtMsgUnsub = onSnapshot(q, snap => {
    snap.docChanges().forEach(change => {
      if (change.type !== 'added') return;
      const msgId = change.doc.id;
      const data  = change.doc.data();

      if (wtPlayedSet.has(msgId)) return;
      wtPlayedSet.add(msgId);

      appendWtMessage(data);

      // Play audio + badge only for new messages not from owner
      const msgTime = data.createdAt?.toMillis?.() ?? 0;
      if (data.from !== 'owner' && msgTime >= wtLoadTime) {
        const name = data.fromName || 'Staff';
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
  }, err => console.error('wt_messages snapshot error:', err));
}

function appendWtMessage(data) {
  const feed = qs('#wtMsgList');
  if (!feed) return;

  // Remove hint text on first message
  const hint = feed.querySelector('.wt-panel-feed-hint');
  if (hint) hint.remove();

  const isOwner  = data.from === 'owner';
  const sender   = isOwner ? (data.fromName || 'Boss') : (data.fromName || 'Staff');
  const time     = data.createdAt?.toDate?.()?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || '';
  const dur      = data.duration ? ` · ${data.duration}s` : '';

  const row = document.createElement('div');
  row.className = 'wt-msg' + (isOwner ? ' wt-msg-owner' : '');
  row.innerHTML = `
    <span class="wt-msg-sender">${escWt(sender)}</span>
    <div class="wt-msg-bubble">🎤 Voice message${dur}</div>
    <span class="wt-msg-time">${time}</span>`;
  feed.appendChild(row);

  if (wtPanelOpen) feed.scrollTop = feed.scrollHeight;

  // Auto-open panel on new incoming staff message
  const msgTime = data.createdAt?.toMillis?.() ?? 0;
  if (data.from !== 'owner' && msgTime >= wtLoadTime && !wtPanelOpen) {
    openWtPanel();
  }
}

function escWt(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Owner PTT ────────────────────────────────────────────────
function startOwnerRecording(e) {
  e.preventDefault();
  if (wtIsRecording) return;

  // No mic yet — request right here inside the user gesture using .then()
  if (!wtMediaStream) {
    const status = qs('#wtOwnerStatus');
    if (status) status.textContent = '🎤 Allow microphone access…';
    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(stream => {
        wtMediaStream = stream;
        if (status) status.textContent = '✓ Mic ready — hold to talk';
      })
      .catch(() => {
        showToast('Microphone access denied. Check browser permissions.', 'error');
        if (status) status.textContent = 'Broadcast to all staff';
      });
    return; // first press = permission only
  }

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
  qs('#wtOwnerPtt')?.classList.remove('recording');
  const status = qs('#wtOwnerStatus');
  if (status) status.textContent = 'Broadcast to all staff';
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

  try {
    const payload = { bizId, from: 'owner', fromName: ownerName, mimeType, duration: durationSec, createdAt: serverTimestamp() };

    // Try Firebase Storage first; fall back to base64 in Firestore
    try {
      const ext  = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm';
      const path = `wt_audio/${bizId}/${Date.now()}_owner.${ext}`;
      const sRef = storageRef(storage, path);
      await uploadBytes(sRef, blob);
      payload.audioUrl = await getDownloadURL(sRef);
    } catch {
      payload.audioB64 = await wtBlobToBase64(blob);
    }

    await addDoc(collection(db, 'wt_messages'), payload);
  } catch (err) {
    console.error('sendWtAudio error:', err);
    showToast('Failed to send voice message.', 'error');
  } finally {
    resetOwnerPtt();
  }
}

function wtGetSupportedMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
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

function wtBlobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
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

