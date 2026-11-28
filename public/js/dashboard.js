/* ============================================================
   EP Local Pro AI — dashboard.js
   Business owner dashboard logic. Firebase module script.
   ============================================================ */

import { auth, db, storage } from '/js/firebase.js';
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';
import {
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, onSnapshot, serverTimestamp, increment
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

    // Show Market Rate nav if add-on is enabled
    if (ownerDoc.addOns?.marketRate === true) {
      const navMR = document.getElementById('navMarketRate');
      if (navMR) navMR.style.display = '';
    }

    // AI Help FAB
    if (ownerDoc.aiSupport === true) _aiInitSupport();

    // Real-time leads badge
    _initLeadsBadge();

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
    'qr':          'QR Codes',
    'documents':   'Documents',
    'myleads':     'My Leads',
    'photos':      'Job Photos',
    'financing':   'Financing',
    'gmb':         'Google My Business',
    'profile':     'Business Profile',
    'ai-settings': 'AI Settings',
    'team':        'Team',
    'account':     'Account',
    'market-rate': 'Market Rate Calculator'
  };
  qs('#pageTitle').textContent = titles[name] || 'Dashboard';

  // Lazy load section data
  if (name === 'dashboard')   { loadStats(); loadRecentOrders(); }
  if (name === 'orders')      { loadOrders('all'); }
  if (name === 'menu')        { loadMenu(); }
  if (name === 'qr')          { loadQrCodes(); }
  if (name === 'documents')   { loadDocuments(); }
  if (name === 'myleads')     { window._loadMyLeads(); }
  if (name === 'photos')      { window._loadPhotosSection(); }
  if (name === 'financing')   { _loadFinancingSection(); }
  if (name === 'gmb')        { window._loadGmbSection(); }
  if (name === 'profile')     { loadProfile(); }
  if (name === 'ai-settings') { loadAiSettings(); }
  if (name === 'team')        { loadTeam(); }
  if (name === 'account')     { loadAccount(); }
  if (name === 'market-rate') { _mrRenderHistoryDash(); }
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
      showToast('Uploading logo…');
      const blob = await resizeLogo(file, 300, 120);
      const snap = await uploadBytes(storageRef(storage, `businesses/${bizId}/logo`), blob, { contentType: 'image/webp' });
      const url  = await getDownloadURL(snap.ref);
      qs('#profileLogoImg').src = url;
      qs('#profileLogoImg').style.display = 'block';
      qs('#profileLogoPlaceholder').style.display = 'none';
      await updateDoc(doc(db, 'businesses', bizId), { logoUrl: url });
      if (bizDoc) bizDoc.logoUrl = url;
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

// ── Digital Menu ─────────────────────────────────────────────
let _dmData      = { profile: {}, categories: [], items: [], settings: {} };
let _dmActiveCat = 'all';

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function loadMenu() {
  if (!bizId) return;

  document.querySelectorAll('[data-dm-tab]').forEach(btn => {
    btn.onclick = () => dmSwitchTab(btn.dataset.dmTab);
  });

  try {
    const snap = await getDoc(doc(db, 'businesses', bizId));
    const data = snap.data() || {};
    _dmData.profile    = data.menuProfile    || {};
    _dmData.categories = Array.isArray(data.menuCategories) ? data.menuCategories : [];
    _dmData.items      = Array.isArray(data.menuItems)      ? data.menuItems      : [];
    _dmData.settings   = data.menuSettings   || {};
    dmPopulateProfile();
    dmRenderCategories();
    dmRenderItems();
    dmPopulateSettings();
  } catch (err) {
    console.error('loadMenu error:', err);
    showToast('Failed to load menu data.', 'error');
  }
}

function dmSwitchTab(tab) {
  document.querySelectorAll('[data-dm-tab]').forEach(b => b.classList.toggle('active', b.dataset.dmTab === tab));
  document.querySelectorAll('.dm-panel').forEach(p => p.classList.add('hidden'));
  const panel = document.getElementById('dmPanel-' + tab);
  if (panel) panel.classList.remove('hidden');
  if (tab === 'share') dmPopulateShare();
}

// ── Restaurant Profile ──────────────────────────────────────
const _dmDays = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];

function dmPopulateProfile() {
  const p = _dmData.profile;
  qs('#dmRestaurantName').value = p.restaurantName || '';
  qs('#dmTagline').value        = p.tagline        || '';
  qs('#dmLogoUrl').value        = p.logoUrl        || '';
  qs('#dmCoverUrl').value       = p.coverUrl       || '';
  dmRenderHoursTable(p.hours || {});
  qs('#dmSaveProfileBtn').onclick = dmSaveProfile;
}

function dmRenderHoursTable(hours) {
  qs('#dmHoursTable').innerHTML = _dmDays.map(day => {
    const h   = hours[day] || { open: true, openTime: '09:00', closeTime: '21:00' };
    const cap = day.charAt(0).toUpperCase() + day.slice(1);
    return `<div class="dm-hours-row" data-day="${day}">
      <label class="dm-hours-day">
        <input type="checkbox" class="dm-hours-open" ${h.open ? 'checked' : ''} /> ${cap}
      </label>
      <div class="dm-hours-times${h.open ? '' : ' hidden'}">
        <input type="time" class="dm-hours-from" value="${h.openTime  || '09:00'}" />
        <span>–</span>
        <input type="time" class="dm-hours-to"   value="${h.closeTime || '21:00'}" />
      </div>
      <span class="dm-hours-closed${h.open ? ' hidden' : ''}">Closed</span>
    </div>`;
  }).join('');

  qs('#dmHoursTable').querySelectorAll('.dm-hours-open').forEach(cb => {
    cb.onchange = () => {
      const row = cb.closest('.dm-hours-row');
      row.querySelector('.dm-hours-times').classList.toggle('hidden', !cb.checked);
      row.querySelector('.dm-hours-closed').classList.toggle('hidden',  cb.checked);
    };
  });
}

async function dmSaveProfile() {
  const btn = qs('#dmSaveProfileBtn');
  btn.disabled = true;
  const hours = {};
  document.querySelectorAll('.dm-hours-row').forEach(row => {
    hours[row.dataset.day] = {
      open:      row.querySelector('.dm-hours-open').checked,
      openTime:  row.querySelector('.dm-hours-from').value  || '09:00',
      closeTime: row.querySelector('.dm-hours-to').value    || '21:00',
    };
  });
  const profile = {
    restaurantName: qs('#dmRestaurantName').value.trim(),
    tagline:        qs('#dmTagline').value.trim(),
    logoUrl:        qs('#dmLogoUrl').value.trim(),
    coverUrl:       qs('#dmCoverUrl').value.trim(),
    hours,
  };
  try {
    await updateDoc(doc(db, 'businesses', bizId), { menuProfile: profile });
    _dmData.profile = profile;
    showToast('Restaurant profile saved!');
  } catch (err) {
    showToast('Failed to save profile.', 'error');
  } finally {
    btn.disabled = false;
  }
}

// ── Categories ──────────────────────────────────────────────
function dmRenderCategories() {
  const list = qs('#dmCategoriesList');
  qs('#dmAddCatBtn').onclick = () => dmOpenCatModal(null);
  if (!_dmData.categories.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📂</div><p>No categories yet. Add your first one!</p></div>';
    return;
  }
  list.innerHTML = _dmData.categories.map(cat => `
    <div class="dm-cat-row">
      <span class="dm-cat-icon">${esc(cat.icon || '📂')}</span>
      <span class="dm-cat-name">${esc(cat.name)}</span>
      <label style="margin-left:auto;display:flex;align-items:center;gap:6px;font-weight:400;cursor:pointer;">
        <input type="checkbox" class="dm-cat-enabled" data-catid="${esc(cat.id)}" ${cat.enabled !== false ? 'checked' : ''} /> Active
      </label>
      <button class="btn-icon" onclick="window._dmEditCat('${esc(cat.id)}')">✏️</button>
      <button class="btn-icon danger" onclick="window._dmDeleteCat('${esc(cat.id)}')">🗑️</button>
    </div>`).join('');

  list.querySelectorAll('.dm-cat-enabled').forEach(cb => {
    cb.onchange = async () => {
      const cat = _dmData.categories.find(c => c.id === cb.dataset.catid);
      if (cat) { cat.enabled = cb.checked; await _dmSaveCategories(); }
    };
  });
}

function dmOpenCatModal(catId) {
  const cat = catId ? _dmData.categories.find(c => c.id === catId) : null;
  qs('#dmCatModalTitle').textContent = cat ? 'Edit Category' : 'Add Category';
  qs('#dmCatId').value   = catId || '';
  qs('#dmCatName').value = cat?.name || '';
  qs('#dmCatIcon').value = cat?.icon || '';
  qs('#dmCatModal').classList.remove('hidden');
  qs('#dmSaveCatBtn').onclick = dmSaveCat;
}

async function dmSaveCat() {
  const id   = qs('#dmCatId').value;
  const name = qs('#dmCatName').value.trim();
  const icon = qs('#dmCatIcon').value.trim() || '📂';
  if (!name) { showToast('Category name is required.', 'error'); return; }
  if (id) {
    const cat = _dmData.categories.find(c => c.id === id);
    if (cat) { cat.name = name; cat.icon = icon; }
  } else {
    _dmData.categories.push({ id: 'cat_' + Date.now(), name, icon, enabled: true });
  }
  await _dmSaveCategories();
  qs('#dmCatModal').classList.add('hidden');
  dmRenderCategories();
  dmBuildCatFilter();
  showToast(id ? 'Category updated!' : 'Category added!');
}

async function _dmSaveCategories() {
  await updateDoc(doc(db, 'businesses', bizId), { menuCategories: _dmData.categories });
}

window._dmEditCat = (catId) => dmOpenCatModal(catId);
window._dmDeleteCat = async (catId) => {
  if (!confirm('Delete this category? Items will become uncategorized.')) return;
  _dmData.categories = _dmData.categories.filter(c => c.id !== catId);
  await _dmSaveCategories();
  dmRenderCategories();
  dmBuildCatFilter();
  showToast('Category deleted.');
};

// ── Items ───────────────────────────────────────────────────
function dmBuildCatFilter() {
  const row  = qs('#dmCatFilter');
  const cats = _dmData.categories.filter(c => c.enabled !== false);
  row.innerHTML = `<button class="dm-cat-pill${_dmActiveCat === 'all' ? ' active' : ''}" onclick="window._dmSetCat('all')">All</button>` +
    cats.map(c => `<button class="dm-cat-pill${_dmActiveCat === c.id ? ' active' : ''}" onclick="window._dmSetCat('${esc(c.id)}')">${esc(c.icon)} ${esc(c.name)}</button>`).join('');
}

window._dmSetCat = (catId) => { _dmActiveCat = catId; dmBuildCatFilter(); dmRenderItems(); };

function dmRenderItems() {
  const grid = qs('#dmItemsGrid');
  qs('#dmAddItemBtn').onclick = () => dmOpenItemModal(null);
  dmBuildCatFilter();

  const items = _dmActiveCat === 'all'
    ? _dmData.items
    : _dmData.items.filter(it => it.categoryId === _dmActiveCat);

  if (!items.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-state-icon">🍽️</div><p>No items${_dmActiveCat !== 'all' ? ' in this category' : ''}. Add your first!</p></div>`;
    return;
  }

  grid.innerHTML = '';
  items.forEach(item => {
    const catName = _dmData.categories.find(c => c.id === item.categoryId)?.name || '';
    const card    = document.createElement('div');
    card.className = 'menu-item-card' + (item.available === false ? ' dm-unavailable' : '');
    card.innerHTML = `
      ${item.imageUrl
        ? `<div class="dm-item-img" style="background-image:url('${esc(item.imageUrl)}')"></div>`
        : `<div class="menu-item-emoji">${esc(item.emoji || '🍽️')}</div>`}
      <div class="menu-item-name">${esc(item.name || '')}</div>
      ${catName ? `<div style="font-size:0.72rem;color:var(--muted);">${esc(catName)}</div>` : ''}
      <div class="menu-item-price">${fmtCurrency(item.price)}</div>
      ${item.description ? `<div class="menu-item-desc">${esc(item.description)}</div>` : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;">
        ${item.isSpecial   ? '<span class="dm-badge dm-badge-special">⭐ Special</span>'  : ''}
        ${item.spicyLevel  ? `<span class="dm-badge dm-badge-spicy">${'🌶️'.repeat(item.spicyLevel)}</span>` : ''}
        ${item.available === false ? '<span class="dm-badge dm-badge-off">Unavailable</span>' : ''}
      </div>
      <div class="menu-item-actions">
        <button class="btn-icon" onclick="window._dmEditItem('${esc(item.id)}')">✏️</button>
        <button class="btn-icon danger" onclick="window._dmDeleteItem('${esc(item.id)}')">🗑️</button>
      </div>`;
    grid.appendChild(card);
  });
}

function dmOpenItemModal(itemId) {
  const item = itemId ? _dmData.items.find(it => it.id === itemId) : null;
  qs('#dmItemModalTitle').textContent = item ? 'Edit Menu Item' : 'Add Menu Item';
  qs('#dmItemId').value        = itemId || '';
  qs('#dmItemName').value      = item?.name        || '';
  qs('#dmItemEmoji').value     = item?.emoji       || '';
  qs('#dmItemPrice').value     = item?.price != null ? item.price : '';
  qs('#dmItemDesc').value      = item?.description || '';
  qs('#dmItemImageUrl').value  = item?.imageUrl    || '';
  qs('#dmItemSpicy').value     = item?.spicyLevel  || 0;
  qs('#dmItemSpecial').checked   = item?.isSpecial  || false;
  qs('#dmItemAvailable').checked = item?.available !== false;

  const catSel = qs('#dmItemCategory');
  catSel.innerHTML = '<option value="">— No category —</option>' +
    _dmData.categories.map(c => `<option value="${esc(c.id)}"${item?.categoryId === c.id ? ' selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('');

  qs('#dmItemModal').classList.remove('hidden');
  qs('#dmSaveItemBtn').onclick = dmSaveItem;
}

async function dmSaveItem() {
  const id    = qs('#dmItemId').value;
  const name  = qs('#dmItemName').value.trim();
  const price = parseFloat(qs('#dmItemPrice').value);
  if (!name)                        { showToast('Item name is required.', 'error'); return; }
  if (isNaN(price) || price < 0)   { showToast('Enter a valid price.', 'error');   return; }

  const newItem = {
    id:          id || 'item_' + Date.now(),
    name,
    emoji:       qs('#dmItemEmoji').value.trim()    || '🍽️',
    price,
    description: qs('#dmItemDesc').value.trim(),
    imageUrl:    qs('#dmItemImageUrl').value.trim(),
    categoryId:  qs('#dmItemCategory').value,
    spicyLevel:  parseInt(qs('#dmItemSpicy').value) || 0,
    isSpecial:   qs('#dmItemSpecial').checked,
    available:   qs('#dmItemAvailable').checked,
  };

  if (id) {
    const idx = _dmData.items.findIndex(it => it.id === id);
    if (idx !== -1) _dmData.items[idx] = newItem; else _dmData.items.push(newItem);
  } else {
    _dmData.items.push(newItem);
  }

  try {
    await updateDoc(doc(db, 'businesses', bizId), { menuItems: _dmData.items });
    qs('#dmItemModal').classList.add('hidden');
    showToast(id ? 'Item updated!' : 'Item added!');
    dmRenderItems();
  } catch (err) {
    showToast('Failed to save item.', 'error');
  }
}

window._dmEditItem   = (itemId) => dmOpenItemModal(itemId);
window._dmDeleteItem = async (itemId) => {
  if (!confirm('Delete this menu item?')) return;
  _dmData.items = _dmData.items.filter(it => it.id !== itemId);
  try {
    await updateDoc(doc(db, 'businesses', bizId), { menuItems: _dmData.items });
    showToast('Item deleted.');
    dmRenderItems();
  } catch (err) {
    showToast('Failed to delete item.', 'error');
  }
};

// ── Settings ────────────────────────────────────────────────
function dmPopulateSettings() {
  const s = _dmData.settings;
  qs('#dmTaxRate').value        = s.taxRate  != null ? s.taxRate  : 8.5;
  qs('#dmCurrency').value       = s.currency || 'USD';
  qs('#dmAcceptCash').checked   = s.acceptCash  !== false;
  qs('#dmAcceptCard').checked   = s.acceptCard  !== false;
  qs('#dmTipOptions').value     = Array.isArray(s.tipOptions) ? s.tipOptions.join(', ') : '15, 18, 20, 25';
  qs('#dmAllowPickup').checked  = s.allowPickup   !== false;
  qs('#dmAllowDineIn').checked  = s.allowDineIn   !== false;
  qs('#dmAllowDelivery').checked = s.allowDelivery || false;
  qs('#dmSaveSettingsBtn').onclick = dmSaveSettings;
}

async function dmSaveSettings() {
  const btn = qs('#dmSaveSettingsBtn');
  btn.disabled = true;
  const settings = {
    taxRate:       parseFloat(qs('#dmTaxRate').value)  || 0,
    currency:      qs('#dmCurrency').value             || 'USD',
    acceptCash:    qs('#dmAcceptCash').checked,
    acceptCard:    qs('#dmAcceptCard').checked,
    tipOptions:    qs('#dmTipOptions').value.split(',').map(v => parseInt(v.trim())).filter(n => !isNaN(n)),
    allowPickup:   qs('#dmAllowPickup').checked,
    allowDineIn:   qs('#dmAllowDineIn').checked,
    allowDelivery: qs('#dmAllowDelivery').checked,
  };
  try {
    await updateDoc(doc(db, 'businesses', bizId), { menuSettings: settings });
    _dmData.settings = settings;
    showToast('Settings saved!');
  } catch (err) {
    showToast('Failed to save settings.', 'error');
  } finally {
    btn.disabled = false;
  }
}

// ── Share ────────────────────────────────────────────────────
function dmPopulateShare() {
  const origin     = location.origin;
  const menuUrl    = origin + '/menu?id=' + bizId;
  const kitchenUrl = origin + '/kitchen?slug=' + (bizSlug || bizId);
  const orderUrl   = origin + '/order?biz=' + (bizSlug || bizId);
  const mu = qs('#dmMenuUrl');    if (mu) mu.value = menuUrl;
  const ku = qs('#dmKitchenUrl'); if (ku) ku.value = kitchenUrl;
  const ou = qs('#dmOrderUrl');   if (ou) ou.value = orderUrl;
  const qr = qs('#dmQrCode');
  if (qr) qr.innerHTML = `<img src="https://chart.googleapis.com/chart?chs=200x200&cht=qr&chl=${encodeURIComponent(menuUrl)}" alt="QR Code" width="200" height="200" loading="lazy" />`;
}

window._dmCopyUrl = (inputId) => {
  const input = qs('#' + inputId);
  if (!input) return;
  navigator.clipboard.writeText(input.value).then(() => showToast('Copied!')).catch(() => {
    input.select();
    document.execCommand('copy');
    showToast('Copied!');
  });
};

// ── QR Codes ─────────────────────────────────────────────────
let _qrData        = [];
let _qrLibLoaded   = false;
let _qrPrevTimeout = null;

function _loadQrLib() {
  if (_qrLibLoaded) return Promise.resolve();
  return new Promise(resolve => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    s.onload = () => { _qrLibLoaded = true; resolve(); };
    document.head.appendChild(s);
  });
}

async function loadQrCodes() {
  if (!bizId) return;
  await _loadQrLib();
  try {
    const snap = await getDoc(doc(db, 'businesses', bizId));
    _qrData = Array.isArray(snap.data()?.qrCodes) ? snap.data().qrCodes : [];
    _renderQrList();
  } catch (err) {
    console.error('loadQrCodes error:', err);
    showToast('Failed to load QR codes.', 'error');
  }
  qs('#addQrBtn').onclick = () => _openQrModal(null);
}

function _renderQrList() {
  const list = qs('#qrCodesList');
  if (!_qrData.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📱</div><p>No QR codes yet. Create your first one!</p></div>';
    return;
  }
  list.innerHTML = '';
  _qrData.forEach(qr => {
    const card = document.createElement('div');
    card.className = 'qr-card' + (qr.enabled !== false ? '' : ' qr-disabled');
    card.innerHTML = `
      <div class="qr-card-preview" id="qrp-${esc(qr.id)}"></div>
      <div class="qr-card-body">
        <div class="qr-card-name">${esc(qr.name)}</div>
        ${qr.description ? `<div class="qr-card-desc">${esc(qr.description)}</div>` : ''}
        <div class="qr-card-url" title="${esc(qr.targetUrl || '')}">${esc(qr.targetUrl || '—')}</div>
        <div class="qr-card-actions">
          <span class="qr-status ${qr.enabled !== false ? 'qr-active' : 'qr-inactive'}">${qr.enabled !== false ? '● Active' : '○ Inactive'}</span>
          <button class="btn-secondary btn-xs" onclick="window._qrEdit('${esc(qr.id)}')">✏️ Edit</button>
          <button class="btn-secondary btn-xs" onclick="window._qrDownload('${esc(qr.id)}')">⬇️ Download</button>
          <button class="btn-secondary btn-xs" onclick="window._qrPrint('${esc(qr.id)}')">🖨️ Print</button>
          <button class="btn-secondary btn-xs danger" onclick="window._qrDelete('${esc(qr.id)}')">🗑️</button>
        </div>
      </div>`;
    list.appendChild(card);
    // Render QR into preview
    _buildQrCanvas(card.querySelector('#qrp-' + qr.id), _qrLandingUrl(qr.id), qr.color || '#000000', qr.bgColor || '#ffffff', 100);
  });
}

function _qrLandingUrl(qrId) {
  return location.origin + '/qr?biz=' + encodeURIComponent(bizId) + '&id=' + encodeURIComponent(qrId);
}

function _buildQrCanvas(container, text, dark, light, size) {
  container.innerHTML = '';
  if (!_qrLibLoaded || !window.QRCode) return;
  new window.QRCode(container, { text, width: size, height: size, colorDark: dark, colorLight: light, correctLevel: window.QRCode.CorrectLevel.M });
}

function _openQrModal(qrId) {
  const qr = qrId ? _qrData.find(q => q.id === qrId) : null;
  qs('#qrModalTitle').textContent = qr ? 'Edit QR Code' : 'Create QR Code';
  qs('#qrId').value           = qrId || '';
  qs('#qrName').value         = qr?.name        || '';
  qs('#qrDescription').value  = qr?.description || '';
  qs('#qrTargetUrl').value    = qr?.targetUrl   || '';
  qs('#qrColor').value        = qr?.color       || '#4f46e5';
  qs('#qrBgColor').value      = qr?.bgColor     || '#ffffff';
  qs('#qrEnabled').checked    = qr?.enabled !== false;
  qs('#qrModal').classList.remove('hidden');
  qs('#qrSaveBtn').onclick = _saveQrCode;
  ['#qrName','#qrDescription','#qrColor','#qrBgColor'].forEach(sel => {
    qs(sel).addEventListener('input', _updateQrPreview);
  });
  _updateQrPreview();
}

function _updateQrPreview() {
  clearTimeout(_qrPrevTimeout);
  _qrPrevTimeout = setTimeout(() => {
    const id      = qs('#qrId').value;
    const previewUrl = id ? _qrLandingUrl(id) : (qs('#qrTargetUrl').value.trim() || location.origin);
    _buildQrCanvas(qs('#qrPreview'), previewUrl, qs('#qrColor').value || '#000', qs('#qrBgColor').value || '#fff', 150);
    qs('#qrPreviewName').textContent = qs('#qrName').value.trim() || 'Label Name';
    qs('#qrPreviewDesc').textContent = qs('#qrDescription').value.trim();
  }, 250);
}

async function _saveQrCode() {
  const id   = qs('#qrId').value;
  const name = qs('#qrName').value.trim();
  const url  = qs('#qrTargetUrl').value.trim();
  if (!name) { showToast('Label name is required.', 'error'); return; }
  if (!url)  { showToast('Target URL is required.', 'error'); return; }

  const item = {
    id:          id || 'qr_' + Date.now(),
    name,
    description: qs('#qrDescription').value.trim(),
    targetUrl:   url,
    color:       qs('#qrColor').value   || '#000000',
    bgColor:     qs('#qrBgColor').value || '#ffffff',
    enabled:     qs('#qrEnabled').checked,
  };

  if (id) {
    const idx = _qrData.findIndex(q => q.id === id);
    if (idx !== -1) _qrData[idx] = item; else _qrData.push(item);
  } else {
    _qrData.push(item);
  }

  try {
    await updateDoc(doc(db, 'businesses', bizId), { qrCodes: _qrData });
    qs('#qrModal').classList.add('hidden');
    showToast(id ? 'QR code updated!' : 'QR code created!');
    _renderQrList();
  } catch (err) {
    showToast('Failed to save QR code.', 'error');
  }
}

window._qrEdit = (qrId) => _openQrModal(qrId);

window._qrDelete = async (qrId) => {
  if (!confirm('Delete this QR code? This cannot be undone.')) return;
  _qrData = _qrData.filter(q => q.id !== qrId);
  try {
    await updateDoc(doc(db, 'businesses', bizId), { qrCodes: _qrData });
    showToast('QR code deleted.');
    _renderQrList();
  } catch (err) {
    showToast('Failed to delete.', 'error');
  }
};

window._qrDownload = (qrId) => {
  const qr = _qrData.find(q => q.id === qrId);
  if (!qr) return;
  _qrHighResCanvas(qrId, qr, 1000, (dataUrl) => {
    const a  = document.createElement('a');
    a.download = (qr.name || 'qr-code').replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.png';
    a.href = dataUrl;
    a.click();
  });
};

window._qrPrint = (qrId) => {
  const qr = _qrData.find(q => q.id === qrId);
  if (!qr) return;
  _qrHighResCanvas(qrId, qr, 800, (img) => {
    const win = window.open('', '_blank', 'width=500,height=640');
    win.document.write(`<!DOCTYPE html><html><head><title>${qr.name}</title><style>
      *{box-sizing:border-box;margin:0;padding:0;}
      body{font-family:sans-serif;text-align:center;padding:48px 32px;background:#fff;color:#0f172a;}
      h2{font-size:1.6rem;margin-bottom:8px;}
      .desc{color:#64748b;font-size:0.9rem;margin-bottom:28px;}
      img{width:260px;height:260px;display:block;margin:0 auto 20px;}
      .hint{font-size:0.75rem;color:#94a3b8;margin-top:16px;}
      .url{font-size:0.65rem;color:#cbd5e1;margin-top:6px;word-break:break-all;}
      @media print{.no-print{display:none;}}
    </style></head><body>
      <h2>${qr.name}</h2>
      ${qr.description ? `<p class="desc">${qr.description}</p>` : ''}
      <img src="${img}" />
      <p class="hint">📷 Scan with your phone camera</p>
      <p class="url">${_qrLandingUrl(qrId)}</p>
      <br/><button class="no-print" onclick="window.print()" style="padding:10px 24px;background:#4f46e5;color:#fff;border:none;border-radius:8px;font-size:0.9rem;cursor:pointer;margin-top:16px;">🖨️ Print</button>
    </body></html>`);
    win.document.close();
  });
};

function _qrHighResCanvas(qrId, qr, size, callback) {
  const tmp = document.createElement('div');
  tmp.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
  document.body.appendChild(tmp);
  const url = _qrLandingUrl(qrId);
  new window.QRCode(tmp, {
    text: url, width: size, height: size,
    colorDark: qr.color || '#000000', colorLight: qr.bgColor || '#ffffff',
    correctLevel: window.QRCode.CorrectLevel.M,
  });
  setTimeout(() => {
    const canvas = tmp.querySelector('canvas');
    const dataUrl = canvas ? canvas.toDataURL('image/png') : null;
    document.body.removeChild(tmp);
    if (dataUrl) callback(dataUrl);
    else showToast('Could not generate high-res QR.', 'error');
  }, 300);
}

// ── Documents ────────────────────────────────────────────────
async function loadDocuments() {
  if (!bizId) return;
  const list = qs('#docsList');
  if (!list) return;
  list.innerHTML = `<div class="empty-state"><p>Loading…</p></div>`;

  // Wire create cards
  document.querySelectorAll('[data-doc-type]').forEach(btn => {
    btn.onclick = () => openDocCreator(btn.dataset.docType);
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

  // Fetch global financing URL set by admin
  try {
    const fSnap = await getDoc(doc(db, 'config', 'financing'));
    _dFinancingUrl = fSnap.exists() ? (fSnap.data().url || '') : '';
    const finRow = document.getElementById('docFinancingSection');
    if (finRow) finRow.style.display = _dFinancingUrl ? '' : 'none';
  } catch (_) { _dFinancingUrl = ''; }

  try {
    const q = query(
      collection(db, 'documents'),
      where('businessId', '==', bizId)
    );
    const snap = await getDocs(q);
    allDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    allDocs.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
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

  const typeLabels = { invoice: 'Invoice', estimate: 'Estimate', contract: 'Contract', receipt: 'Receipt' };
  const typeIcons  = { invoice: '🧾', estimate: '📋', contract: '📝', receipt: '🧾' };
  const badgeCls   = { invoice: 'badge-invoice', estimate: 'badge-estimate', contract: 'badge-contract', receipt: 'badge-receipt' };

  list.innerHTML = '';
  filtered.forEach(docData => {
    const typeLbl    = typeLabels[docData.type] || docData.type || '—';
    const typeIcon   = typeIcons[docData.type] || '📄';
    const badgeClass = badgeCls[docData.type] || '';
    const amount     = docData.amount
      ? `$${Number(docData.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : '—';
    const label      = docData.docNumber ? `#${docData.docNumber}` : typeLbl;
    const statusTxt  = docData.status || 'draft';
    const viewUrl    = docData.id ? `${location.origin}/view-doc.html?id=${docData.id}` : '';
    const canSign    = docData.type === 'estimate' || docData.type === 'contract';

    const row = document.createElement('div');
    row.className = 'doc-row';
    row.innerHTML = `
      <div class="doc-row-bar bar-${docData.type || 'default'}"></div>
      <div class="doc-row-main">
        <div class="doc-row-type">
          <span class="doc-row-icon">${typeIcon}</span>
          <div>
            <span class="badge ${badgeClass}">${typeLbl}</span>
            ${docData.docNumber ? `<div class="doc-row-num">#${docData.docNumber}</div>` : ''}
          </div>
        </div>
        <div class="doc-row-customer">
          <div class="doc-row-cust-name">${docData.customerName || '—'}</div>
          ${docData.bizName ? `<div class="doc-row-cust-biz">${docData.bizName}</div>` : ''}
        </div>
        <div class="doc-row-date">${fmtDate(docData.createdAt)}</div>
        <div class="doc-row-amount">${amount}</div>
        <div class="doc-row-status">
          <span class="status-btn status-${statusTxt.toLowerCase()}">${statusTxt.charAt(0).toUpperCase() + statusTxt.slice(1)}</span>
        </div>
        <div class="doc-row-actions">
          ${docData.htmlContent ? `<button class="btn-action btn-action-view" data-view>👁 View</button>` : ''}
          <button class="btn-action btn-action-edit" data-edit>✏️ Edit</button>
          ${viewUrl ? `<button class="btn-action btn-action-share" data-share>📤 Share</button>` : ''}
          ${viewUrl ? `<button class="btn-action btn-action-copy" data-copy>🔗 Copy Link</button>` : ''}
          ${canSign ? `<button class="btn-action btn-action-sign" data-sign>✍️ Sign</button>` : ''}
          <button class="btn-action btn-action-delete" data-del>🗑 Delete</button>
        </div>
      </div>`;

    const viewLabel = docData.docNumber || typeLbl;
    if (docData.htmlContent) {
      row.querySelector('[data-view]')?.addEventListener('click', () => viewDocument(docData, viewLabel));
    }
    row.querySelector('[data-edit]')?.addEventListener('click', () => openDocCreator(docData.type, docData));
    row.querySelector('[data-sign]')?.addEventListener('click', () => dashOwnerSign(docData.id, docData));

    if (viewUrl) {
      row.querySelector('[data-share]')?.addEventListener('click', () => {
        _dShowShareModal(viewUrl, typeLbl, docData.docNumber || '', docData.type);
      });
      row.querySelector('[data-copy]')?.addEventListener('click', (e) => {
        const btn = e.currentTarget;
        navigator.clipboard.writeText(viewUrl).then(() => {
          const orig = btn.innerHTML;
          btn.innerHTML = '✅ Copied!';
          btn.style.background = '#10b981';
          setTimeout(() => { btn.innerHTML = orig; btn.style.background = ''; }, 2000);
        });
      });
    }

    row.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!confirm(`Delete this ${typeLbl}? This cannot be undone.`)) return;
      try {
        await deleteDoc(doc(db, 'documents', docData.id));
        allDocs = allDocs.filter(d => d.id !== docData.id);
        updateDocCounts();
        renderDocCards();
        showToast(`${typeLbl} deleted.`, 'success');
      } catch (err) {
        console.error('deleteDoc error:', err);
        showToast('Failed to delete document.', 'error');
      }
    });

    list.appendChild(row);
  });
}

function _dashSigHtml(name, date, ip, consented) {
  const fmtD = d => d ? (d.toDate ? d.toDate() : new Date(d)).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}) : '';
  return `<div style="font-family:Georgia,serif;font-size:22pt;font-style:italic;font-weight:bold;color:#15803d;line-height:1.1;">${name}</div>` +
    `<div style="font-size:0.62rem;color:#94a3b8;margin-top:3px;">Signed ${fmtD(date)}${ip?' · IP: '+ip:''}</div>` +
    (consented
      ? `<div style="display:inline-flex;align-items:center;gap:5px;margin-top:6px;padding:3px 8px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:20px;">` +
        `<span style="font-size:0.65rem;color:#15803d;">✅ Reviewed &amp; consented to terms</span></div>`
      : '');
}

function _dashInjectSigs(iframe, data) {
  try {
    const fdoc = iframe.contentDocument;
    if (!fdoc) return;
    if (data.ownerSig?.name) {
      const el = fdoc.getElementById('ep-sig-owner');
      if (el) { el.style.borderBottom='none'; el.style.height='auto'; el.innerHTML=_dashSigHtml(data.ownerSig.name,data.ownerSig.signedAt,'',data.ownerSig.consentGiven); }
    }
    if (data.customerSig?.name) {
      const el = fdoc.getElementById('ep-sig-client');
      if (el) { el.style.borderBottom='none'; el.style.height='auto'; el.innerHTML=_dashSigHtml(data.customerSig.name,data.customerSig.signedAt,data.customerSig.ip||'',data.customerSig.consentGiven); }
    }
  } catch(_) {}
}

function viewDocument(docData, label) {
  const frame = qs('#docPreviewFrame');
  if (!frame) return;
  const htmlContent = typeof docData === 'string' ? docData : docData.htmlContent;
  qs('#docPreviewTitle').textContent = label || 'Document Preview';
  frame.srcdoc = htmlContent;
  frame.onload = () => {
    if (typeof docData === 'object') _dashInjectSigs(frame, docData);
    try { const h = frame.contentDocument?.body?.scrollHeight; if (h>100) frame.style.height=h+'px'; } catch(_) {}
  };
  qs('#docPreviewModal').classList.remove('hidden');
  qs('#docPrintBtn').onclick = () => frame.contentWindow?.print();
}

async function dashOwnerSign(docId, cachedData) {
  let data = cachedData;
  if (!data?.htmlContent) {
    try { const s = await getDoc(doc(db,'documents',docId)); data = s.data(); } catch(e) { alert('Could not load document: '+e.message); return; }
  }
  const existing  = data?.ownerSig;
  const typeLabel = (data?.type||'document').charAt(0).toUpperCase()+(data?.type||'document').slice(1);
  const docNumber = data?.docNumber || '';

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9999;display:flex;flex-direction:column;';
  overlay.innerHTML = `
    <div style="background:#0f172a;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;gap:12px;">
      <div style="color:#fff;font-weight:700;font-size:0.9rem;">✍️ Sign — ${typeLabel}${docNumber?' #'+docNumber:''}</div>
      <button id="_dsClose" style="background:rgba(255,255,255,.1);border:none;color:#fff;border-radius:6px;padding:5px 12px;font-size:0.82rem;cursor:pointer;">✕ Close</button>
    </div>
    <div style="flex:1;overflow-y:auto;background:#f1f5f9;">
      <iframe id="_dsFrame" style="width:100%;border:none;display:block;" scrolling="no"></iframe>
      <div style="max-width:620px;margin:0 auto;padding:24px 16px 48px;">
        ${existing ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:12px 16px;margin-bottom:16px;font-size:0.82rem;color:#166534;">✅ Already signed by <strong>${existing.name}</strong> — you can update it below.</div>` : ''}
        <div style="background:#fff;border-radius:14px;padding:24px;box-shadow:0 4px 24px rgba(0,0,0,.08);">
          <div style="font-size:0.95rem;font-weight:800;color:#1e293b;margin-bottom:4px;">Owner / Business Signature</div>
          <div style="font-size:0.8rem;color:#64748b;margin-bottom:18px;">Review the document above, then type your full legal name and confirm your consent below.</div>
          <div style="font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:6px;">Full Legal Name</div>
          <input id="_dsInp" type="text" placeholder="Type your name…" autocomplete="name"
            style="width:100%;padding:12px 16px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:1rem;outline:none;box-sizing:border-box;margin-bottom:14px;transition:border-color .15s;"
            value="${existing ? existing.name : ''}"/>
          <div style="background:#f8fafc;border-radius:10px;padding:14px 18px;min-height:60px;border:1.5px dashed #cbd5e1;margin-bottom:20px;display:flex;flex-direction:column;justify-content:flex-end;">
            <div id="_dsPrev" style="font-family:Georgia,serif;font-size:26pt;font-style:italic;font-weight:bold;color:#15803d;line-height:1.1;">${existing ? existing.name : ''}</div>
            <div style="font-size:0.6rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-top:6px;">Signature Preview</div>
          </div>
          <label id="_dsConsentWrap" style="display:flex;gap:12px;align-items:flex-start;padding:14px 16px;background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;cursor:pointer;margin-bottom:16px;transition:border-color .15s;">
            <input type="checkbox" id="_dsConsent" style="margin-top:2px;width:16px;height:16px;accent-color:#15803d;flex-shrink:0;cursor:pointer;"/>
            <span style="font-size:0.8rem;color:#475569;line-height:1.6;">
              I have reviewed this <strong>${typeLabel}</strong> and agree to the described scope, pricing, and terms.
              I declare my consent to proceed and understand that this electronic signature is legally binding
              under the ESIGN Act and UETA.
            </span>
          </label>
          <button id="_dsConfirm" disabled style="width:100%;background:#94a3b8;color:#fff;border:none;border-radius:10px;padding:14px;font-size:0.95rem;font-weight:800;cursor:not-allowed;transition:background .15s;">✅ Sign Document</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const iframe  = document.getElementById('_dsFrame');
  const inp     = document.getElementById('_dsInp');
  const prev    = document.getElementById('_dsPrev');
  const consent = document.getElementById('_dsConsent');
  const wrap    = document.getElementById('_dsConsentWrap');
  const btn     = document.getElementById('_dsConfirm');

  if (data?.htmlContent) {
    iframe.srcdoc = data.htmlContent;
    iframe.onload = () => {
      _dashInjectSigs(iframe, data);
      try { const h = iframe.contentDocument?.body?.scrollHeight; if (h>100) iframe.style.height=h+'px'; } catch(_) {}
      setTimeout(() => { try { const h = iframe.contentDocument?.body?.scrollHeight; if (h>100) iframe.style.height=h+'px'; } catch(_) {} }, 600);
    };
  }

  function updateBtn() {
    const ready = inp.value.trim() && consent.checked;
    btn.disabled = !ready;
    btn.style.background = ready ? '#15803d' : '#94a3b8';
    btn.style.cursor     = ready ? 'pointer'  : 'not-allowed';
    wrap.style.borderColor = consent.checked ? '#15803d' : '#e2e8f0';
    wrap.style.background  = consent.checked ? '#f0fdf4' : '#f8fafc';
  }

  inp.focus();
  inp.addEventListener('input',    () => { prev.textContent = inp.value; updateBtn(); });
  consent.addEventListener('change', updateBtn);

  document.getElementById('_dsClose').addEventListener('click', () => overlay.remove());

  btn.addEventListener('click', async () => {
    const name = inp.value.trim();
    if (!name)            { inp.style.borderColor='#dc2626'; inp.focus(); return; }
    if (!consent.checked) { wrap.style.borderColor='#dc2626'; return; }
    btn.textContent='⏳ Signing…'; btn.disabled=true;
    try {
      await updateDoc(doc(db,'documents',docId), {
        ownerSig: { name, signedAt: serverTimestamp(), consentGiven: true, consentAt: serverTimestamp() },
        updatedAt: serverTimestamp()
      });
      _dashInjectSigs(iframe, { ownerSig:{name,signedAt:new Date(),consentGiven:true}, customerSig: data.customerSig });
      // Update local cache
      const idx = allDocs.findIndex(d=>d.id===docId);
      if (idx!==-1) allDocs[idx].ownerSig={name,signedAt:new Date(),consentGiven:true};
      showToast('Document signed!','success');
      btn.textContent='✅ Signed!'; btn.style.background='#166534';
      setTimeout(() => overlay.remove(), 1400);
    } catch(e) {
      btn.textContent='✅ Sign Document'; btn.disabled=false;
      alert('Error saving signature: '+e.message);
    }
  });
}

function downloadDocument(htmlContent, label) {
  viewDocument(htmlContent, label);
  setTimeout(() => qs('#docPreviewFrame')?.contentWindow?.print(), 700);
}

// openGenerateDocModal replaced by openDocCreator — see bottom of file

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
let selectedWidgetTheme = 'cyan';
let widgetImgUrl  = '';
let aiBgImageUrl  = '';

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

    // Widget theme + images
    selectedWidgetTheme = data.widgetTheme || 'cyan';
    widgetImgUrl  = data.widgetImgUrl  || '';
    aiBgImageUrl  = data.aiBgImage     || '';
    applyWidgetThemeUI();
    applyBgImageUI();

    // AI page URL
    qs('#aiUrlDisplay').textContent = `https://ep-local-pro-ai.netlify.app/ai/${bizSlug || '—'}`;

  } catch (err) {
    console.error('loadAiSettings error:', err);
    showToast('Failed to load AI settings.', 'error');
  }

  qs('#saveAiSettingsBtn').onclick = saveAiSettings;

  qs('#langEN').onclick = () => { selectedLang = 'en'; updateLangToggle('en'); };
  qs('#langES').onclick = () => { selectedLang = 'es'; updateLangToggle('es'); };

  qs('#copyUrlBtn').onclick = () => {
    const url = `https://ep-local-pro-ai.netlify.app/ai/${bizSlug}`;
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
window.setAiTestLang    = setAiTestLang;
window.pickAitwVoice    = pickAitwVoice;
window.toggleAiTestCall = toggleAiTestCall;

// ── Widget theme ─────────────────────────────────────────────

const THEME_LABELS = { cyan: 'Cyan (default)', red: 'Red', gold: 'Gold' };

function applyWidgetThemeUI() {
  document.querySelectorAll('.wt-swatch').forEach(el => {
    el.classList.toggle('selected', el.dataset.theme === selectedWidgetTheme && !widgetImgUrl);
  });
  if (widgetImgUrl) {
    const preview = qs('#widgetImgPreview');
    const thumb   = qs('#widgetImgThumb');
    if (preview && thumb) {
      thumb.src            = widgetImgUrl;
      preview.style.display = 'flex';
    }
  }
  const status = qs('#widgetThemeStatus');
  if (status) {
    status.textContent = widgetImgUrl
      ? 'Style: Custom Image'
      : `Style: ${THEME_LABELS[selectedWidgetTheme] || 'Cyan (default)'}`;
  }
}

window.pickWidgetTheme = function(theme) {
  selectedWidgetTheme = theme;
  widgetImgUrl = '';
  const preview = qs('#widgetImgPreview');
  if (preview) preview.style.display = 'none';
  applyWidgetThemeUI();
};

window.uploadWidgetImg = async function(input) {
  const file = input.files?.[0];
  if (!file || !bizId) return;
  const status = qs('#widgetThemeStatus');
  if (status) status.textContent = 'Uploading…';
  try {
    const r    = storageRef(storage, `ai_widget_img/${bizId}/${Date.now()}_${file.name}`);
    const snap = await uploadBytes(r, file, { contentType: file.type });
    widgetImgUrl = await getDownloadURL(snap.ref);
    const thumb   = qs('#widgetImgThumb');
    const preview = qs('#widgetImgPreview');
    if (thumb)   thumb.src             = widgetImgUrl;
    if (preview) preview.style.display = 'flex';
    document.querySelectorAll('.wt-swatch').forEach(el => el.classList.remove('selected'));
    if (status)  status.textContent    = 'Style: Custom Image';
  } catch (e) {
    if (status) status.textContent = '⚠️ Upload failed';
    console.error('Widget img upload error:', e);
  }
  input.value = '';
};

window.clearWidgetImg = function() {
  widgetImgUrl = '';
  const preview = qs('#widgetImgPreview');
  if (preview) preview.style.display = 'none';
  applyWidgetThemeUI();
};

// ── AI background image ──────────────────────────────────────

function applyBgImageUI() {
  const preview = qs('#aiBgPreview');
  const thumb   = qs('#aiBgThumb');
  const status  = qs('#aiBgStatus');
  if (aiBgImageUrl) {
    if (thumb)   thumb.src             = aiBgImageUrl;
    if (preview) preview.style.display = 'flex';
    if (status)  status.textContent    = '✅ Background image set';
  } else {
    if (preview) preview.style.display = 'none';
    if (status)  status.textContent    = '';
  }
}

window.uploadAiBg = async function(input) {
  const file = input.files?.[0];
  if (!file || !bizId) return;
  const status = qs('#aiBgStatus');
  if (status) status.textContent = 'Uploading…';
  try {
    const r    = storageRef(storage, `ai_bg_img/${bizId}/${Date.now()}_${file.name}`);
    const snap = await uploadBytes(r, file, { contentType: file.type });
    aiBgImageUrl = await getDownloadURL(snap.ref);
    applyBgImageUI();
  } catch (e) {
    if (status) status.textContent = '⚠️ Upload failed';
    console.error('BG image upload error:', e);
  }
  input.value = '';
};

window.clearAiBg = function() {
  aiBgImageUrl = '';
  applyBgImageUI();
};

async function saveAiSettings() {
  if (!bizId) return;
  const btn = qs('#saveAiSettingsBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Saving…';

  try {
    await updateDoc(doc(db, 'businesses', bizId), {
      agentId:      qs('#agentIdInput').value.trim(),
      lang:         selectedLang,
      voiceIdEn:    qs('#voiceIdEnSelect').value,
      voiceIdEs:    qs('#voiceIdEsSelect').value,
      widgetTheme:  selectedWidgetTheme,
      widgetImgUrl: widgetImgUrl || null,
      aiBgImage:    aiBgImageUrl || null,
      greeting:     qs('#greetingInput').value.trim(),
      hours:        qs('#hoursInput').value.trim()
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
const wtPlayedSet    = new Set();
const WT_LOAD_MS     = Date.now(); // page-load timestamp for filtering historical messages

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

// ── WT Message Limit (owner side) ────────────────────────────
const WT_PLAN_LIMITS_DASH = { starter: 1000, pro: 2000 };

async function wtCheckDashLimit() {
  if (!bizId) return { canSend: true };
  try {
    const monthKey = new Date().toISOString().slice(0, 7);
    const bizSnap  = await getDoc(doc(db, 'businesses', bizId));
    const biz      = bizSnap.data() || {};
    const plan     = ownerDoc?.addOns?.wtPlan    || 'starter';
    const extra    = ownerDoc?.addOns?.wtMsgExtra || 0;
    const total    = (WT_PLAN_LIMITS_DASH[plan] || 200) + extra;
    const count    = (biz.wtMsgMonth === monthKey) ? (biz.wtMsgCount || 0) : 0;
    if (count >= total) {
      return { canSend: false, msg: `📵 Monthly WT limit reached (${count}/${total}). Contact support to add more messages.` };
    }
    return { canSend: true, monthKey, isNewMonth: biz.wtMsgMonth !== monthKey };
  } catch (e) {
    console.error('wtCheckDashLimit:', e);
    return { canSend: true };
  }
}

async function wtIncrDashUsage(monthKey, isNewMonth) {
  try {
    await updateDoc(doc(db, 'businesses', bizId),
      isNewMonth ? { wtMsgMonth: monthKey, wtMsgCount: 1 } : { wtMsgCount: increment(1) }
    );
  } catch (e) {
    console.error('wtIncrDashUsage:', e);
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

      // Skip historical messages (sent before this dashboard session loaded)
      const msgMs = data.createdAt?.toMillis?.() ?? Date.now();
      if (msgMs < WT_LOAD_MS - 5000) return;

      // Skip messages not directed to owner (employee-to-employee private chats)
      if (data.to) {
        const toList = Array.isArray(data.to) ? data.to : [data.to];
        if (!toList.includes('owner')) return;
      }

      // Play audio for new messages from staff (not the owner's own messages)
      if (data.from !== 'owner') {
        const name = data.fromName || 'Staff';
        console.log('[WT-DASH] Received from', name, '| to:', data.to ?? '(broadcast)', '| hasAudio:', !!data.audioUrl, '| playing:', wtAudioPlaying, '| queue:', wtAudioQueue.length);

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
  try {
    sendBlob = await wtEncodeToWav(blob);
    console.log('[WT] WAV encode OK — size', sendBlob.size);
  } catch (encErr) {
    console.error('[WT] WAV encode FAILED, sending original', mimeType, encErr);
    sendBlob = blob;
    sendMime = mimeType;
    if (statusEl) statusEl.textContent = `⚠️ Sending as ${mimeType.split(';')[0]} (iOS may not play)`;
  }

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

    const limitCheck = await wtCheckDashLimit();
    if (!limitCheck.canSend) {
      showToast(limitCheck.msg, 'error');
      resetOwnerPtt();
      return;
    }

    await addDoc(collection(db, 'wt_messages'), payload);
    wtIncrDashUsage(limitCheck.monthKey, limitCheck.isNewMonth).catch(() => {});
    wtSendPush(ownerName, payload.to ?? null);
    const sentTo = wtSelectedTargets.size === 0
      ? 'all staff'
      : [...wtSelectedTargets].map(c => wtEmployeeList.find(e => e.empCode === c)?.name || c).join(', ');
    showToast(`✓ Sent to ${sentTo}`, 'success');
  } catch (err) {
    console.error('sendWtAudio error:', err);
    showToast('Failed to send voice message.', 'error');
  } finally {
    resetOwnerPtt();
  }
}

function wtGetSupportedMimeType() {
  // webm/opus must come first — audio/mp4 fails in decodeAudioData even though Chrome can record it
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

// ── Audio playback queue (owner side) ────────────────────────
function enqueueWtAudio(fromName, audioUrl, b64Data) {
  wtAudioQueue.push({ fromName, audioUrl, b64Data });
  console.log('[WT-DASH] enqueue from', fromName, '| queue:', wtAudioQueue.length, '| playing:', wtAudioPlaying);
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

  let blobUrl = null;
  // Fresh element per message — no previous src means no MEDIA_ERR_ABORTED on load(),
  // and keeping it in the DOM prevents Chrome from GC'ing it before onended fires.
  const el = document.createElement('audio');
  document.body.appendChild(el);

  try {
    let src = audioUrl;
    if (!src && b64Data?.b64) {
      const bytes = Uint8Array.from(atob(b64Data.b64), c => c.charCodeAt(0));
      blobUrl = URL.createObjectURL(new Blob([bytes], { type: b64Data.type || 'audio/mp4' }));
      src = blobUrl;
    }
    if (!src) throw new Error('no audio source');

    console.log('[WT-DASH] Playing from', fromName, src.slice(0, 60));
    el.src = src;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { console.warn('[WT-DASH] ⏱ 25s timeout — onended never fired'); resolve(); }, 25_000);
      el.onended = () => { clearTimeout(timeout); console.log('[WT-DASH] ✓ played OK'); resolve(); };
      el.onerror = () => {
        const code = el.error?.code ?? 0;
        if (code === 1) {
          console.log('[WT-DASH] code-1 abort ignored, load continues');
          return; // MEDIA_ERR_ABORTED from src assignment — load algorithm continues
        }
        clearTimeout(timeout);
        const msg = ['','aborted','network','decode','unsupported'][code] || code;
        console.error('[WT-DASH] onerror code', code, msg);
        reject(new Error(`MediaError: ${msg}`));
      };
      el.play()
        .then(() => console.log('[WT-DASH] play() started OK'))
        .catch(err => {
          clearTimeout(timeout);
          console.error('[WT-DASH] play() blocked:', err.name, err.message);
          reject(new Error(`play blocked: ${err.name}`));
        });
    });
  } catch (err) {
    console.error('[WT-DASH] playback error:', err.message);
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    el.onended = null;
    el.onerror = null;
    el.src = '';
    el.remove();
    if (audioInd) audioInd.classList.add('hidden');
    drainWtAudioQueue();
  }
}

async function wtEncodeToWav(blob) {
  const arrayBuf = await blob.arrayBuffer();
  // OfflineAudioContext: purely computational, never touches the audio output stack.
  // Using AudioContext here would trigger Chrome's autoplay-policy reset on close,
  // blocking subsequent $wtPanelAudio.play() calls with NotAllowedError.
  const offCtx = new OfflineAudioContext(1, 1, 44100);
  const decoded = await offCtx.decodeAudioData(arrayBuf);
  console.log('[WT] decoded sampleRate:', decoded.sampleRate, 'length:', decoded.length);
  if (!decoded || decoded.length === 0) throw new Error('decoded audio empty');
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

// addDocLineItem / updateDocTotals / escDocAttr removed — replaced by _dashDoc* functions below

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
    reader.onload = e => {
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
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('toBlob failed')), 'image/webp', 0.85);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Market Rate Calculator (dashboard) ───────────────────────
function _mrFmtDash(n) {
  if (!n && n !== 0) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function _mrRenderResultDash(container, d, service, city, fromCache) {
  const refs = (d.references || []).map(r =>
    `<li><span class="mr-ref-src">${r.source || ''}</span><span class="mr-ref-price">${r.range || ''}</span></li>`
  ).join('');
  const factors = (d.factors || []).map(f => `<span class="mr-factor">${f}</span>`).join('');
  container.innerHTML = `
    <div class="mr-card">
      <div class="mr-card-header">
        <div class="mr-card-title">${service} · <span class="mr-city">${city}</span></div>
        ${fromCache ? '<span class="mr-cached">cached</span>' : ''}
      </div>
      <div class="mr-ranges">
        <div class="mr-range-item">
          <span class="mr-range-label">Low</span>
          <span class="mr-range-val low">${_mrFmtDash(d.min)}</span>
        </div>
        <div class="mr-range-item highlight">
          <span class="mr-range-label">Average</span>
          <span class="mr-range-val avg">${_mrFmtDash(d.average)}</span>
        </div>
        <div class="mr-range-item">
          <span class="mr-range-label">High</span>
          <span class="mr-range-val high">${_mrFmtDash(d.max)}</span>
        </div>
      </div>
      <div class="mr-suggestion">💡 Suggested starting price: <strong>${_mrFmtDash(d.suggestion)}</strong> <em>${d.unit || 'per job'}</em></div>
      ${d.breakdown ? `<div class="mr-breakdown">${d.breakdown}</div>` : ''}
      ${factors    ? `<div class="mr-factors">${factors}</div>`       : ''}
      ${refs       ? `<ul class="mr-refs">${refs}</ul>`               : ''}
      <div class="mr-disclaimer">${d.disclaimer || ''}</div>
    </div>`;
}

const _mrKey = () => `mr_history_${currentUser?.uid || 'anon'}`;

function _mrSaveHistoryDash(service, city, data) {
  try {
    const hist = JSON.parse(localStorage.getItem(_mrKey()) || '[]');
    const entry = { service, city, min: data.min, max: data.max, average: data.average, unit: data.unit, ts: Date.now() };
    const filtered = hist.filter(h => !(h.service === service && h.city === city));
    filtered.unshift(entry);
    localStorage.setItem(_mrKey(), JSON.stringify(filtered.slice(0, 10)));
  } catch {}
}

function _mrRenderHistoryDash() {
  const container = document.getElementById('mrHistoryDash');
  if (!container) return;
  try {
    const hist = JSON.parse(localStorage.getItem(_mrKey()) || '[]');
    if (!hist.length) { container.innerHTML = ''; return; }
    container.innerHTML = `
      <div class="mr-history-header">
        <span class="mr-history-title">🕐 Recent Lookups</span>
        <button class="mr-clear-all-btn" data-clear-all>Clear all</button>
      </div>
      <div class="mr-history-list">
        ${hist.map((h, i) => `
          <div class="mr-history-item" data-idx="${i}">
            <div class="mr-history-num">${i + 1}</div>
            <div class="mr-history-svc" title="${h.service}">${h.service}</div>
            <div class="mr-history-city">📍 ${h.city}</div>
            <div class="mr-history-range">${_mrFmtDash(h.min)} – ${_mrFmtDash(h.max)} <span class="mr-history-unit">${h.unit || 'per job'}</span></div>
            <button class="mr-del-btn" data-del="${i}" title="Remove">✕</button>
          </div>`).join('')}
      </div>`;

    container.querySelectorAll('.mr-history-item').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('[data-del]')) return;
        const h = hist[+el.dataset.idx];
        const s = document.getElementById('mrServiceDash');
        const c = document.getElementById('mrCityDash');
        if (s) s.value = h.service;
        if (c) c.value = h.city;
        window._mrGetRatesDash();
      });
    });
    container.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        try {
          const h2 = JSON.parse(localStorage.getItem(_mrKey()) || '[]');
          h2.splice(+btn.dataset.del, 1);
          localStorage.setItem(_mrKey(), JSON.stringify(h2));
        } catch {}
        _mrRenderHistoryDash();
      });
    });
    container.querySelector('[data-clear-all]')?.addEventListener('click', () => {
      localStorage.removeItem(_mrKey());
      container.innerHTML = '';
    });
  } catch {}
}

let _mrLangDash = 'en-US';

window._mrSetLangDash = function(lang) {
  _mrLangDash = lang;
  document.getElementById('mrLangDashEN')?.classList.toggle('active', lang === 'en-US');
  document.getElementById('mrLangDashES')?.classList.toggle('active', lang === 'es-MX');
};

let _mrVoiceActiveDash = null;

window._mrVoiceDash = function(fieldId) {
  const btn = document.querySelector(`[data-mr-voice-for="${fieldId}"]`);

  // Second click = stop
  if (_mrVoiceActiveDash) {
    _mrVoiceActiveDash.stop();
    return;
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showToast('Voice input is not supported in this browser.', 'error'); return; }

  const inp = document.getElementById(fieldId);
  const sr  = new SR();
  sr.lang           = _mrLangDash;
  sr.continuous     = true;
  sr.interimResults = true;
  sr.maxAlternatives = 1;

  _mrVoiceActiveDash = sr;
  if (btn) { btn.textContent = '🔴'; btn.title = 'Tap to stop'; btn.classList.add('mr-voice-active'); }

  let finalText = '';

  sr.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript + ' ';
      else interim += e.results[i][0].transcript;
    }
    if (inp) inp.value = (finalText + interim).trim();
  };

  sr.onend = () => {
    _mrVoiceActiveDash = null;
    if (btn) { btn.textContent = '🎤'; btn.title = 'Voice input'; btn.classList.remove('mr-voice-active'); }
    if (inp && inp.value) inp.dispatchEvent(new Event('input'));
  };

  sr.onerror = e => {
    _mrVoiceActiveDash = null;
    if (btn) { btn.textContent = '🎤'; btn.title = 'Voice input'; btn.classList.remove('mr-voice-active'); }
    if (e.error !== 'no-speech' && e.error !== 'aborted') showToast('Voice error: ' + e.error, 'error');
  };

  sr.start();
};

window._mrGetRatesDash = async function() {
  const service  = (document.getElementById('mrServiceDash')?.value || '').trim();
  const city     = (document.getElementById('mrCityDash')?.value    || '').trim();
  const resultEl = document.getElementById('mrResultDash');
  const btnEl    = document.getElementById('mrBtnDash');
  if (!service || !city) { showToast('Enter both a service type and a city.', 'error'); return; }

  const cacheKey = `mr_${_mrLangDash}_${service.toLowerCase().replace(/\s+/g,'-')}_${city.toLowerCase().replace(/\s+/g,'-')}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const { data, ts } = JSON.parse(cached);
      if (Date.now() - ts < 86_400_000) { _mrRenderResultDash(resultEl, data, service, city, true); return; }
    } catch {}
  }

  if (btnEl) { btnEl.disabled = true; btnEl.textContent = '⏳ Fetching market data…'; }
  if (resultEl) resultEl.innerHTML = '';

  try {
    const resp = await fetch('/.netlify/functions/market-rate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service, city, lang: _mrLangDash })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to get market rates');
    localStorage.setItem(cacheKey, JSON.stringify({ data, ts: Date.now() }));
    _mrSaveHistoryDash(service, city, data);
    _mrRenderResultDash(resultEl, data, service, city, false);
    _mrRenderHistoryDash();
  } catch (e) {
    if (resultEl) resultEl.innerHTML = `<div class="mr-error">⚠️ ${e.message}</div>`;
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = '📊 Get Market Rates'; }
  }
};

window._mrClearDash = function() {
  const r = document.getElementById('mrResultDash');
  if (r) r.innerHTML = '';
};


// ══════════════════════════════════════════════════════════════
// DASHBOARD DOCUMENT CREATOR — Full-screen, 5 templates
// ══════════════════════════════════════════════════════════════

let _dLang        = 'en';
let _dType        = 'invoice';
let _dDesign      = 'classic';
let _dItems       = [];
let _dLogoUrl     = '';
let _dCurrentDocId = null;
let _dShowPricing  = true;
let _dAllCustomers = [];
let _dFinancingUrl = '';
let _dBizPaymentMethods = {};
let _dVoiceRecognizer   = null;

const _DASH_DOC_LABELS = {
  en: {
    invoice:'Invoice', estimate:'Estimate', contract:'Contract', receipt:'Receipt',
    billTo:'Bill To', date:'Date', due:'Due Date', docNum:'Document #',
    desc:'Description', qty:'Qty', price:'Price', total:'Total',
    subtotal:'Subtotal', tax:'Tax', grandTotal:'TOTAL',
    advance:'Advance Payment', balance:'Remaining Balance',
    notes:'Notes', terms:'Terms & Conditions', tcTitle:'TERMS AND CONDITIONS',
    thankYou:'Thank you for your business!',
    page:'Page'
  },
  es: {
    invoice:'Factura', estimate:'Presupuesto', contract:'Contrato', receipt:'Recibo',
    billTo:'Facturar a', date:'Fecha', due:'Vencimiento', docNum:'Numero',
    desc:'Descripcion', qty:'Cant.', price:'Precio', total:'Total',
    subtotal:'Subtotal', tax:'Impuesto', grandTotal:'TOTAL',
    advance:'Anticipo Recibido', balance:'Saldo Pendiente',
    notes:'Notas', terms:'Terminos y Condiciones', tcTitle:'TERMINOS Y CONDICIONES',
    thankYou:'Gracias por su preferencia!',
    page:'Pagina'
  }
};

const _DASH_ITEM_TYPES = [
  { value:'labor',     label:'Laborar',     labelEs:'Mano de Obra' },
  { value:'parts',     label:'Parts',       labelEs:'Partes'       },
  { value:'material',  label:'Material',    labelEs:'Material'     },
  { value:'equipment', label:'Equipment',   labelEs:'Equipo'       },
  { value:'permit',    label:'Permit',      labelEs:'Permiso'      },
  { value:'service',   label:'Service',     labelEs:'Servicio'     },
  { value:'other',     label:'Other',       labelEs:'Otro'         }
];

const _DASH_TC_DEFAULT = {
  en: `TERMS AND CONDITIONS\n\n1. Payment: Full payment is due upon completion of work unless a written payment plan is agreed upon. A finance charge of 1.5% per month (18% per annum) will be applied to all past-due balances.\n\n2. Advance Payment: Any deposit or advance payment applied to this estimate/invoice is non-refundable once materials have been ordered or work has commenced.\n\n3. Scope of Work: Work is limited to items described herein. Additional work or materials discovered during service will be quoted and approved separately before proceeding.\n\n4. Warranty: Workmanship is guaranteed for 90 days from the date of completion. Parts and materials carry only the manufacturer's warranty.\n\n5. Right of Access: Customer shall provide safe and unobstructed access to the work area. Delays caused by lack of access may result in additional charges at our standard hourly rate.\n\n6. Cancellation Policy: Cancellations must be made at least 24 hours in advance. Late cancellations or no-shows may be subject to a service call fee.\n\n7. Limitation of Liability: Our liability is limited to the value of services rendered. We are not responsible for pre-existing conditions, concealed defects, or consequential damages.\n\n8. Governing Law: This agreement is governed by the laws of the state where services are rendered.`,
  es: `TERMINOS Y CONDICIONES\n\n1. Pago: El pago total vence al completar el trabajo, salvo acuerdo escrito de plan de pagos. Se aplicara un cargo financiero del 1.5% mensual a todos los saldos vencidos.\n\n2. Anticipo: Cualquier deposito o anticipo no es reembolsable una vez que los materiales han sido ordenados o el trabajo ha comenzado.\n\n3. Alcance: El trabajo se limita a los elementos descritos. El trabajo adicional sera cotizado y aprobado por separado.\n\n4. Garantia: La mano de obra tiene garantia de 90 dias. Las piezas tienen unicamente la garantia del fabricante.\n\n5. Acceso: El cliente proporcionara acceso seguro al area de trabajo. Los retrasos por falta de acceso pueden resultar en cargos adicionales.\n\n6. Cancelacion: Las cancelaciones deben realizarse con al menos 24 horas de anticipacion.\n\n7. Responsabilidad: Nuestra responsabilidad se limita al costo de los servicios prestados.\n\n8. Ley Aplicable: Este acuerdo se rige por las leyes del estado donde se prestan los servicios.`
};

function _dEsc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _dSetVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

// ── Set Type ──────────────────────────────────────────────────
window._dashDocSetType = function(type) {
  _dType = type;
  document.querySelectorAll('#docCreatorModal .doc-type-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.doctype === type);
  });
  const numEl = document.getElementById('docNumber');
  if (numEl && /^(INV|EST|CON|REC)-\d+$/i.test(numEl.value)) {
    const suffix = numEl.value.split('-')[1];
    numEl.value = type.slice(0,3).toUpperCase() + '-' + suffix;
  }
  _dApplyTypeLayout();
  window._dashDocUpdatePreview();
};

// ── Set Lang ──────────────────────────────────────────────────
window._dashDocSetLang = function(lang) {
  _dLang = lang;
  document.getElementById('dashDocLangEn')?.classList.toggle('active', lang === 'en');
  document.getElementById('dashDocLangEs')?.classList.toggle('active', lang === 'es');
  const modal = document.getElementById('docCreatorModal');
  if (!modal) return;
  modal.querySelectorAll('[data-en]').forEach(el => {
    el.textContent = el.getAttribute('data-' + lang) || el.getAttribute('data-en');
  });
  _dApplyTypeLayout();
  window._dashDocUpdatePreview();
};

// ── Set Design ────────────────────────────────────────────────
window._dashDocSetDesign = function(name) {
  _dDesign = name;
  document.querySelectorAll('#dashDocDesignPicker .doc-design-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('dashDocDesign-' + name)?.classList.add('active');
  window._dashDocUpdatePreview();
};

// ── Type Layout ───────────────────────────────────────────────
function _dApplyTypeLayout() {
  const show = (id, v) => { const el = document.getElementById(id); if (el) el.style.display = v ? '' : 'none'; };
  const setTxt = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  const isInvoice  = _dType === 'invoice';
  const isEstimate = _dType === 'estimate';
  const isContract = _dType === 'contract';
  const isReceipt  = _dType === 'receipt';
  const es = _dLang === 'es';

  const BANNER = {
    invoice:  { icon:'document', color:'#4f46e5', title: es?'Factura':'Invoice',       desc: es?'Solicitar pago por trabajo completado':'Request payment for completed work' },
    estimate: { icon:'clipboard',color:'#059669', title: es?'Estimacion':'Estimate',   desc: es?'Proponer un precio antes de comenzar':'Propose a price before starting the job' },
    contract: { icon:'pencil',   color:'#7c3aed', title: es?'Contrato':'Contract',     desc: es?'Acuerdo legal con su cliente':'Legal agreement between you and your client' },
    receipt:  { icon:'receipt',  color:'#0891b2', title: es?'Recibo':'Receipt',         desc: es?'Confirmar que se recibio el pago':'Confirm payment has been received in full' },
  };
  const bd = BANNER[_dType] || BANNER.invoice;
  setTxt('docTypeBannerTitle', bd.title);
  setTxt('docTypeBannerDesc',  bd.desc);
  const bannerEl = document.getElementById('docTypeBanner');
  if (bannerEl) bannerEl.style.borderLeftColor = bd.color;

  show('docInvoiceRefRow',   isReceipt);
  show('docPayInstructRow',  isInvoice);
  show('docProjectTitleRow', isEstimate || isContract || isInvoice);
  show('docDueDateWrap',     !isReceipt);
  if (isEstimate)      setTxt('docDueDateLabel', es ? 'Valido Hasta' : 'Valid Until');
  else if (isContract) setTxt('docDueDateLabel', es ? 'Fecha de Fin' : 'End Date');
  else                 setTxt('docDueDateLabel', es ? 'Vencimiento' : 'Due Date');

  show('docPaymentMethodRow', isReceipt);
  show('docJobDetailsSection', isEstimate || isContract || isInvoice);
  show('docOrderedByRow', isEstimate || isInvoice);
  show('docDurationRow',  isEstimate);
  setTxt('docJobDetailsTitle', isContract ? (es ? 'Detalles del Proyecto' : 'Project Details') : (es ? 'Detalles del Trabajo' : 'Job Details'));
  show('docScopeSection', isEstimate || isContract);

  const liSec = document.getElementById('docLineItemsSection');
  if (liSec) liSec.classList.toggle('hidden', isContract);

  if (isReceipt)       setTxt('docLineItemsTitle', es ? 'Articulos / Servicios Pagados' : 'Items / Services Paid');
  else if (isEstimate) setTxt('docLineItemsTitle', es ? 'Partidas del Proyecto' : 'Project Items & Costs');
  else                 setTxt('docLineItemsTitle', es ? 'Partidas y Precios' : 'Line Items & Pricing');

  show('docTaxRow',     !isReceipt);
  show('docAdvanceRow', !isReceipt && !isContract);
  show('docBalanceRow', !isReceipt && !isContract);

  if (isReceipt) setTxt('docGrandTotalLabelSpan', es ? 'Total Recibido' : 'Amount Received');
  else           setTxt('docGrandTotalLabelSpan', es ? 'Total' : 'Total');

  const conSec = document.getElementById('docContractSection');
  if (conSec) conSec.classList.toggle('hidden', !isContract);

  show('docTCFormSection', !isReceipt);
  if (isContract) {
    const cb = document.getElementById('docIncludeTC');
    if (cb && !cb.checked) { cb.checked = true; document.getElementById('docTCSection')?.classList.remove('hidden'); }
  }

  if (isReceipt)       setTxt('docBillToLabel', es ? 'Recibido De' : 'Received From');
  else if (isContract) setTxt('docBillToLabel', es ? 'Cliente' : 'Client');
  else if (isEstimate) setTxt('docBillToLabel', es ? 'Preparado Para' : 'Prepared For');
  else                 setTxt('docBillToLabel', es ? 'Facturar a' : 'Bill To');

  const notesEl = document.getElementById('docNotes');
  if (notesEl) {
    const ph = notesEl.dataset['ph' + _dType.charAt(0).toUpperCase() + _dType.slice(1)];
    if (ph) notesEl.placeholder = ph;
  }
}

// ── Pricing & TC toggles ──────────────────────────────────────
window._dashDocTogglePricing = function() {
  _dShowPricing = document.getElementById('docShowPricing')?.checked ?? true;
  document.getElementById('docPricingContent')?.classList.toggle('hidden', !_dShowPricing);
  window._dashDocUpdatePreview();
};

window._dashDocToggleTC = function() {
  const checked = document.getElementById('docIncludeTC')?.checked;
  document.getElementById('docTCSection')?.classList.toggle('hidden', !checked);
  if (checked) {
    const ta = document.getElementById('docTermsText');
    if (ta && !ta.value.trim()) ta.value = _DASH_TC_DEFAULT[_dLang] || _DASH_TC_DEFAULT.en;
  }
  window._dashDocUpdatePreview();
};

window._dashDocResetTC = function() {
  const ta = document.getElementById('docTermsText');
  if (ta) ta.value = _DASH_TC_DEFAULT[_dLang] || _DASH_TC_DEFAULT.en;
  window._dashDocUpdatePreview();
};

// ── Line Items ────────────────────────────────────────────────
window._dashDocAddItem = function() {
  _dItems.push({ desc:'', price:0, type:'labor' });
  window._dashDocRenderItems();
  window._dashDocUpdateTotals();
  window._dashDocUpdatePreview();
};

window._dashDocRemoveItem = function(idx) {
  _dItems.splice(idx, 1);
  if (_dItems.length === 0) _dItems.push({ desc:'', price:0, type:'labor' });
  window._dashDocRenderItems();
  window._dashDocUpdateTotals();
  window._dashDocUpdatePreview();
};

window._dashDocItemSet = function(i, field, val) {
  if (!_dItems[i]) return;
  _dItems[i][field] = (field === 'desc' || field === 'type') ? val : (parseFloat(val) || 0);
  window._dashDocUpdateTotals();
  window._dashDocUpdatePreview();
};

window._dashDocRenderItems = function() {
  const container = document.getElementById('docItemsList');
  if (!container) return;
  container.innerHTML = _dItems.map((item, i) => `
    <div class="doc-item-row">
      <select class="doc-item-type" onchange="window._dashDocItemSet(${i},'type',this.value)">
        ${_DASH_ITEM_TYPES.map(t => `<option value="${t.value}"${item.type===t.value?' selected':''}>${_dLang==='es'?t.labelEs:t.label}</option>`).join('')}
      </select>
      <input type="text" value="${_dEsc(item.desc)}" placeholder="Description / Notes"
        oninput="window._dashDocItemSet(${i},'desc',this.value)" />
      <input type="number" value="${item.price}" min="0" step="0.01" placeholder="0.00"
        oninput="window._dashDocItemSet(${i},'price',this.value)" />
      <button class="doc-item-del" onclick="window._dashDocRemoveItem(${i})">x</button>
    </div>`).join('');
};

// ── Totals ────────────────────────────────────────────────────
window._dashDocUpdateTotals = function() {
  const subtotal = _dItems.reduce((s, it) => s + (it.price||0), 0);
  const taxRate  = parseFloat(document.getElementById('docTaxRate')?.value || 0);
  const taxAmt   = subtotal * taxRate / 100;
  const grand    = subtotal + taxAmt;
  const sub = document.getElementById('docSubtotal');   if (sub)  sub.textContent  = '$' + subtotal.toFixed(2);
  const tax = document.getElementById('docTaxAmt');     if (tax)  tax.textContent  = '$' + taxAmt.toFixed(2);
  const tot = document.getElementById('docGrandTotal'); if (tot)  tot.textContent  = '$' + grand.toFixed(2);
  const advance = parseFloat(document.getElementById('docAdvancePayment')?.value || 0);
  const balance = Math.max(0, grand - advance);
  const balEl = document.getElementById('docBalanceDue');
  if (balEl) {
    if (advance > 0 && advance >= grand) { balEl.textContent = 'Paid in Full'; balEl.style.color = '#15803d'; }
    else { balEl.textContent = '$' + balance.toFixed(2); balEl.style.color = ''; }
  }
};

// ── Preview ───────────────────────────────────────────────────
window._dashDocUpdatePreview = function() {
  const frame = document.getElementById('dashDocPreviewFrame');
  if (!frame) return;
  frame.onload = () => {
    try {
      const h = frame.contentDocument?.body?.scrollHeight;
      if (h && h > 100) frame.style.height = h + 'px';
    } catch(_) {}
  };
  frame.srcdoc = window._dashDocGenerateHTML();
};

// ── Logo upload ───────────────────────────────────────────────
function _dWireLogoUpload() {
  const input = document.getElementById('docLogoInput');
  if (!input || input._dashWired) return;
  input._dashWired = true;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    const img = document.getElementById('docLogoImg');
    const ph  = document.getElementById('docLogoPlaceholder');
    // Instant preview while upload runs
    const preview = URL.createObjectURL(file);
    if (img) { img.src = preview; img.style.display = 'block'; }
    if (ph)  ph.style.display = 'none';
    try {
      const blob = await resizeLogo(file, 300, 120);
      const snap = await uploadBytes(storageRef(storage, `businesses/${bizId}/doc_logo`), blob, { contentType: 'image/webp' });
      _dLogoUrl = await getDownloadURL(snap.ref);
      if (img) img.src = _dLogoUrl;
      window._dashDocUpdatePreview();
    } catch (err) {
      console.error('doc logo upload:', err);
      showToast('Logo upload failed', 'error');
    }
  });
}

// ── Payment block HTML (from business profile payment methods) ─
function _dPaymentBlock() {
  const methods = _dBizPaymentMethods;
  if (!methods) return '';
  const PM_CFG = {
    cashapp:   { icon:'', label:'Pay with CashApp', bg:'#00c244', color:'#000', href: v => v.startsWith('http') ? v : `https://cash.app/${v.startsWith('$')?v:'$'+v}` },
    zelle:     { icon:'', label:'Send via Zelle',   bg:'#6b1fbf', color:'#fff', href: v => v.startsWith('http') ? v : null },
    card:      { icon:'', label:'Pay by Card',      bg:'#1a56db', color:'#fff', href: v => v.startsWith('http') ? v : null },
    financing: { icon:'', label:'Apply Financing',  bg:'#ea580c', color:'#fff', href: v => v.startsWith('http') ? v : null }
  };
  const btns = [];
  for (const [key, cfg] of Object.entries(PM_CFG)) {
    const m = methods[key];
    if (!m?.enabled || !m?.value) continue;
    if (key === 'financing' && !m.adminEnabled) continue;
    const link = cfg.href(m.value);
    const style = `display:inline-flex;align-items:center;gap:7px;padding:10px 20px;background:${cfg.bg};color:${cfg.color};border-radius:8px;font-size:0.82rem;font-weight:700;text-decoration:none;letter-spacing:.01em;`;
    btns.push(link
      ? `<a href="${_dEsc(link)}" target="_blank" rel="noopener" style="${style}">${cfg.icon} ${cfg.label}</a>`
      : `<span style="${style}">${cfg.icon} ${cfg.label}: ${_dEsc(m.value)}</span>`);
  }
  return btns.join('');
}

// ── Signature section ─────────────────────────────────────────
function _dSigSection(custName, bizName) {
  const es = _dLang === 'es';
  return `<div style="margin-top:36px;padding-top:20px;border-top:2px solid #e2e8f0;">
  <div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:20px;">${es?'Firmas Autorizadas':'Authorized Signatures'}</div>
  <div style="display:flex;gap:40px;flex-wrap:wrap;">
    <div style="flex:1;min-width:200px;">
      <div style="font-size:0.62rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:8px;">${es?'Negocio / Propietario':'Business / Owner'}</div>
      <div style="min-height:40px;border-bottom:1px dashed #cbd5e1;margin-bottom:6px;"></div>
      <div style="font-size:0.72rem;font-weight:600;color:#1e293b;">${_dEsc(bizName)||'--'}</div>
    </div>
    <div style="flex:1;min-width:200px;">
      <div style="font-size:0.62rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:8px;">${es?'Cliente / Firmante':'Customer / Client'}</div>
      <div style="min-height:40px;border-bottom:1px dashed #cbd5e1;margin-bottom:6px;"></div>
      <div style="font-size:0.72rem;font-weight:600;color:#1e293b;">${_dEsc(custName)||'--'}</div>
    </div>
  </div>
</div>`;
}

// ── Shared data extractor ─────────────────────────────────────
function _dGetData() {
  const L = _DASH_DOC_LABELS[_dLang];
  const bizName    = document.getElementById('docBizName')?.value    || '';
  const bizAddress = document.getElementById('docBizAddress')?.value || '';
  const bizPhone   = document.getElementById('docBizPhone')?.value   || '';
  const bizEmail   = document.getElementById('docBizEmail')?.value   || '';
  const custName   = document.getElementById('docCustName')?.value   || '';
  const custEmail  = document.getElementById('docCustEmail')?.value  || '';
  const custPhone  = document.getElementById('docCustPhone')?.value  || '';
  const custAddr   = document.getElementById('docCustAddress')?.value|| '';
  const docNumber  = document.getElementById('docNumber')?.value     || '';
  const docDate    = document.getElementById('docDate')?.value       || '';
  const docDueDate = document.getElementById('docDueDate')?.value    || '';
  const notes      = document.getElementById('docNotes')?.value        || '';
  const contractTxt= document.getElementById('docContractText')?.value || '';
  const projectTitle=document.getElementById('docProjectTitle')?.value || '';
  const jobOrderedBy=document.getElementById('docJobOrderedBy')?.value || '';
  const jobLocation= document.getElementById('docJobLocation')?.value  || '';
  const duration   = document.getElementById('docDuration')?.value     || '';
  const jobScope   = document.getElementById('docJobScope')?.value     || '';
  const taxRate    = parseFloat(document.getElementById('docTaxRate')?.value || 0);
  const advance    = parseFloat(document.getElementById('docAdvancePayment')?.value || 0);
  const includeTC  = document.getElementById('docIncludeTC')?.checked || false;
  const termsText  = document.getElementById('docTermsText')?.value || '';
  const subtotal   = _dItems.reduce((s, it) => s + (it.price||0), 0);
  const taxAmt     = subtotal * taxRate / 100;
  const grand      = subtotal + taxAmt;
  const balance    = Math.max(0, grand - advance);
  const grandTotalLabel = _dType === 'estimate'
    ? (_dLang === 'es' ? 'COSTO ESTIMADO DEL PROYECTO' : 'ESTIMATED PROJECT COST')
    : L.grandTotal;
  const typeLabel  = L[_dType] || _dType;
  const custLabel  = _dType === 'receipt'   ? (_dLang === 'es' ? 'Para'           : 'To')
                   : _dType === 'contract'  ? (_dLang === 'es' ? 'Cliente'        : 'Client')
                   : _dType === 'estimate'  ? (_dLang === 'es' ? 'Preparado Para' : 'Prepared For')
                   :                          (_dLang === 'es' ? 'Facturar a'     : 'Bill To');
  const fmtDate    = d => { if (!d) return ''; const [y,m,day] = d.split('-'); return `${m}/${day}/${y}`; };
  const TYPE_COLORS   = { labor:'#4f46e5', parts:'#0891b2', material:'#059669', equipment:'#d97706', permit:'#7c3aed', service:'#db2777', other:'#64748b' };
  const TYPE_LABELS_ES= { labor:'Mano de Obra', parts:'Partes', material:'Material', equipment:'Equipo', permit:'Permiso', service:'Servicio', other:'Otro' };
  const scopeHtml = (() => {
    if (!jobScope) return '';
    const lines = jobScope.split('\n'); let html = ''; let inList = false;
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('- ') || t.startsWith('- ') || t.startsWith('* ')) {
        if (!inList) { html += '<ul style="margin:6px 0 8px 18px;padding:0">'; inList = true; }
        html += `<li style="margin:3px 0;font-size:0.82rem;color:#475569">${_dEsc(t.slice(2))}</li>`;
      } else { if (inList) { html += '</ul>'; inList = false; } if (t) html += `<p style="margin:0 0 6px;font-size:0.82rem;color:#475569">${_dEsc(t)}</p>`; }
    }
    if (inList) html += '</ul>'; return html;
  })();
  const logoHtml = _dLogoUrl ? `<img src="${_dLogoUrl}" alt="Logo" style="max-height:70px;max-width:150px;object-fit:contain;"/>` : '';
  const paymentMethod = document.getElementById('docPaymentMethod')?.value || '';
  const PM_LABELS = { cash:'Cash', check:'Check', card:'Card / Debit', zelle:'Zelle', venmo:'Venmo', cashapp:'Cash App', transfer:'Bank Transfer', other:'Other' };
  const PM_LABELS_ES = { cash:'Efectivo', check:'Cheque', card:'Tarjeta / Debito', zelle:'Zelle', venmo:'Venmo', cashapp:'Cash App', transfer:'Transferencia', other:'Otro' };
  const paymentMethodLabel = (_dLang === 'es' ? PM_LABELS_ES[paymentMethod] : PM_LABELS[paymentMethod]) || paymentMethod;
  const pmRowLabel = _dLang === 'es' ? 'Metodo de Pago' : 'Payment Method';
  const receiptPaymentHtml = (_dType === 'receipt' && paymentMethod)
    ? `<tr><td style="padding:6px 10px;font-size:0.82rem;color:#475569;">${pmRowLabel}</td><td style="padding:6px 10px;text-align:right;font-weight:700;color:#15803d;">${_dEsc(paymentMethodLabel)}</td></tr>`
    : '';
  const invoiceRef = document.getElementById('docInvoiceRef')?.value || '';
  const paidInFullHtml = (_dType === 'receipt')
    ? `<div style="margin:16px 0;padding:12px 20px;background:linear-gradient(135deg,#15803d,#166534);color:#fff;border-radius:10px;text-align:center;font-size:1.05rem;font-weight:800;letter-spacing:.06em;">${_dLang==='es'?'PAGO RECIBIDO EN SU TOTALIDAD':'PAID IN FULL'}</div>`
    : '';
  const payInstructions = document.getElementById('docPayInstructions')?.value || '';
  const payInstructionsHtml = (_dType === 'invoice' && payInstructions)
    ? `<div style="margin-top:12px;padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-left:4px solid #4f46e5;border-radius:6px;"><div style="font-size:0.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:5px;">${_dLang==='es'?'Instrucciones de Pago':'Payment Instructions'}</div><div style="font-size:0.82rem;color:#475569;white-space:pre-wrap;">${_dEsc(payInstructions)}</div></div>`
    : '';
  return { L, bizName, bizAddress, bizPhone, bizEmail, custName, custEmail, custPhone, custAddr,
    docNumber, docDate, docDueDate, notes, contractTxt, projectTitle, jobOrderedBy, jobLocation,
    duration, jobScope, taxRate, advance, includeTC, termsText, subtotal, taxAmt, grand, balance,
    grandTotalLabel, typeLabel, custLabel, fmtDate, logoHtml, TYPE_COLORS, TYPE_LABELS_ES, scopeHtml,
    paymentMethod, paymentMethodLabel, receiptPaymentHtml, invoiceRef, paidInFullHtml,
    payInstructions, payInstructionsHtml, paymentBlockHtml: _dPaymentBlock() };
}

// ── HTML Generator dispatcher ─────────────────────────────────
window._dashDocGenerateHTML = function() {
  switch (_dDesign) {
    case 'bold':      return _dTplBold();
    case 'executive': return _dTplExecutive();
    case 'modern':    return _dTplModern();
    case 'minimal':   return _dTplMinimal();
    default:          return _dTplClassic();
  }
};

// ── Template 1: Classic ───────────────────────────────────────
function _dTplClassic() {
  const L = _DASH_DOC_LABELS[_dLang];
  const bizName    = document.getElementById('docBizName')?.value    || '';
  const bizAddress = document.getElementById('docBizAddress')?.value || '';
  const bizPhone   = document.getElementById('docBizPhone')?.value   || '';
  const bizEmail   = document.getElementById('docBizEmail')?.value   || '';
  const custName   = document.getElementById('docCustName')?.value   || '';
  const custEmail  = document.getElementById('docCustEmail')?.value  || '';
  const custPhone  = document.getElementById('docCustPhone')?.value  || '';
  const custAddr   = document.getElementById('docCustAddress')?.value|| '';
  const docNumber  = document.getElementById('docNumber')?.value     || '';
  const docDate    = document.getElementById('docDate')?.value       || '';
  const docDueDate = document.getElementById('docDueDate')?.value    || '';
  const notes       = document.getElementById('docNotes')?.value        || '';
  const contractTxt = document.getElementById('docContractText')?.value || '';
  const projectTitle = document.getElementById('docProjectTitle')?.value || '';
  const jobOrderedBy= document.getElementById('docJobOrderedBy')?.value || '';
  const jobLocation = document.getElementById('docJobLocation')?.value  || '';
  const duration    = document.getElementById('docDuration')?.value     || '';
  const jobScope    = document.getElementById('docJobScope')?.value     || '';
  const taxRate     = parseFloat(document.getElementById('docTaxRate')?.value || 0);
  const advance     = parseFloat(document.getElementById('docAdvancePayment')?.value || 0);
  const includeTC   = document.getElementById('docIncludeTC')?.checked || false;
  const termsText   = document.getElementById('docTermsText')?.value || '';
  const subtotal   = _dItems.reduce((s, it) => s + (it.price||0), 0);
  const taxAmt     = subtotal * taxRate / 100;
  const grand      = subtotal + taxAmt;
  const balance    = Math.max(0, grand - advance);
  const grandTotalLabel = _dType === 'estimate'
    ? (_dLang === 'es' ? 'COSTO ESTIMADO DEL PROYECTO' : 'ESTIMATED PROJECT COST') : L.grandTotal;
  const ptLabel = _dLang === 'es' ? 'Terminos de Pago' : 'Payment Terms';
  const ptLine1 = _dLang === 'es'
    ? 'Un anticipo de <strong>$' + advance.toFixed(2) + '</strong> se aplica al costo total de <strong>$' + grand.toFixed(2) + '</strong>.'
    : 'A <strong>$' + advance.toFixed(2) + '</strong> advance payment is applied toward the total of <strong>$' + grand.toFixed(2) + '</strong>.';
  const ptLine2 = _dLang === 'es'
    ? 'El saldo restante de <strong>$' + balance.toFixed(2) + '</strong> vence al completar el trabajo.'
    : 'The remaining <strong>$' + balance.toFixed(2) + '</strong> balance is due upon completion of the work.';
  const durationLabel = _dLang === 'es' ? 'Duracion Estimada' : 'Estimated Duration';
  const durationApprox = _dLang === 'es' ? 'Aproximadamente' : 'Approximately';
  const durationNote   = _dLang === 'es' ? ', sujeto a las condiciones del sitio.' : ', subject to actual site conditions.';
  const scopeHtml = (() => {
    if (!jobScope) return '';
    const lines = jobScope.split('\n'); let html = ''; let inList = false;
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('- ') || t.startsWith('* ')) {
        if (!inList) { html += '<ul style="margin:6px 0 8px 18px;padding:0">'; inList = true; }
        html += `<li style="margin:3px 0;font-size:0.82rem;color:#475569">${_dEsc(t.slice(2))}</li>`;
      } else { if (inList) { html += '</ul>'; inList = false; } if (t) html += `<p style="margin:0 0 6px;font-size:0.82rem;color:#475569">${_dEsc(t)}</p>`; }
    }
    if (inList) html += '</ul>'; return html;
  })();
  const logoHtml = _dLogoUrl ? `<img src="${_dLogoUrl}" alt="Logo" style="max-height:70px;max-width:150px;object-fit:contain;"/>` : '';
  const paymentMethod = document.getElementById('docPaymentMethod')?.value || '';
  const PM_LABELS = { cash:'Cash', check:'Check', card:'Card / Debit', zelle:'Zelle', venmo:'Venmo', cashapp:'Cash App', transfer:'Bank Transfer', other:'Other' };
  const PM_LABELS_ES = { cash:'Efectivo', check:'Cheque', card:'Tarjeta / Debito', zelle:'Zelle', venmo:'Venmo', cashapp:'Cash App', transfer:'Transferencia', other:'Otro' };
  const paymentMethodLabel = (_dLang === 'es' ? PM_LABELS_ES[paymentMethod] : PM_LABELS[paymentMethod]) || paymentMethod;
  const pmRowLabel = _dLang === 'es' ? 'Metodo de Pago' : 'Payment Method';
  const receiptPaymentHtml = (_dType === 'receipt' && paymentMethod)
    ? `<tr><td style="padding:6px 10px;font-size:0.82rem;color:#475569;">${pmRowLabel}</td><td style="padding:6px 10px;text-align:right;font-weight:700;color:#15803d;">${_dEsc(paymentMethodLabel)}</td></tr>` : '';
  const invoiceRef = document.getElementById('docInvoiceRef')?.value || '';
  const paidInFullHtml = (_dType === 'receipt')
    ? `<div style="margin:16px 0;padding:12px 20px;background:linear-gradient(135deg,#15803d,#166534);color:#fff;border-radius:10px;text-align:center;font-size:1.05rem;font-weight:800;letter-spacing:.06em;">${_dLang==='es'?'PAGO RECIBIDO EN SU TOTALIDAD':'PAID IN FULL'}</div>` : '';
  const payInstructions = document.getElementById('docPayInstructions')?.value || '';
  const payInstructionsHtml = (_dType === 'invoice' && payInstructions)
    ? `<div style="margin-top:12px;padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-left:4px solid #4f46e5;border-radius:6px;"><div style="font-size:0.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:5px;">${_dLang==='es'?'Instrucciones de Pago':'Payment Instructions'}</div><div style="font-size:0.82rem;color:#475569;white-space:pre-wrap;">${_dEsc(payInstructions)}</div></div>` : '';
  const paymentBlockHtml = _dPaymentBlock();
  const typeLabel = L[_dType] || _dType;
  const custLabel = _dType === 'receipt'  ? (_dLang === 'es' ? 'Para'           : 'To')
                  : _dType === 'contract' ? (_dLang === 'es' ? 'Cliente'        : 'Client')
                  : _dType === 'estimate' ? (_dLang === 'es' ? 'Preparado Para' : 'Prepared For')
                  :                         (_dLang === 'es' ? 'Facturar a'     : 'Bill To');
  const fmtDate = d => { if (!d) return ''; const [y,m,day] = d.split('-'); return `${m}/${day}/${y}`; };
  const TYPE_COLORS = { labor:'#4f46e5', parts:'#0891b2', material:'#059669', equipment:'#d97706', permit:'#7c3aed', service:'#db2777', other:'#64748b' };
  const TYPE_LABELS_ES = { labor:'Mano de Obra', parts:'Partes', material:'Material', equipment:'Equipo', permit:'Permiso', service:'Servicio', other:'Otro' };
  const itemsRowsHtml = _dType !== 'contract' ? _dItems.map(it => {
    const typeKey = it.type || 'other';
    const typeColor = TYPE_COLORS[typeKey] || '#64748b';
    const tLabel = _dLang === 'es' ? (TYPE_LABELS_ES[typeKey] || typeKey) : typeKey.charAt(0).toUpperCase() + typeKey.slice(1);
    const typeBadge = `<span style="display:inline-block;padding:2px 7px;border-radius:12px;font-size:0.65rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;background:${typeColor}18;color:${typeColor};border:1px solid ${typeColor}44;">${_dEsc(tLabel)}</span>`;
    return `<tr><td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;">${typeBadge}<br><span style="font-size:0.82rem">${_dEsc(it.desc)}</span></td><td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:600;">$${(it.price||0).toFixed(2)}</td></tr>`;
  }).join('') : '';

  return `<!DOCTYPE html><html lang="${_dLang==='es'?'es':'en'}"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${typeLabel} ${docNumber}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1e293b;background:#fff;padding:32px;font-size:13px;line-height:1.5}.doc-wrap{max-width:760px;margin:0 auto}.doc-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;gap:16px;flex-wrap:wrap}.doc-top-left{flex:1;min-width:200px}.doc-top-right{text-align:right;min-width:160px}.doc-type-title{font-size:2rem;font-weight:800;color:#4f46e5;letter-spacing:-0.02em;text-transform:uppercase}.biz-name{font-size:1rem;font-weight:700;color:#1e293b;margin-top:6px}.biz-detail{font-size:0.78rem;color:#64748b;margin-top:2px}.doc-meta{font-size:0.82rem;color:#475569;margin-top:4px}.doc-meta strong{color:#1e293b}.doc-parties{display:flex;gap:24px;margin-bottom:24px;flex-wrap:wrap}.doc-party{flex:1;min-width:180px;background:#f8fafc;border-radius:8px;padding:12px 16px;border:1px solid #e2e8f0}.party-label{font-size:0.68rem;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}.party-name{font-size:0.95rem;font-weight:700;color:#1e293b;margin-bottom:2px}.party-detail{font-size:0.78rem;color:#64748b;line-height:1.4}table{width:100%;border-collapse:collapse;margin-bottom:20px}thead tr{background:#4f46e5;color:#fff}thead th{padding:10px;text-align:left;font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em}thead th:not(:first-child){text-align:right}tbody tr:nth-child(even){background:#f8fafc}.totals-table{margin-left:auto;width:auto;min-width:220px}.totals-table td{padding:5px 10px;font-size:0.85rem;color:#475569}.totals-table .grand td{font-size:1rem;font-weight:800;color:#1e293b;border-top:2px solid #4f46e5;padding-top:8px}.doc-contract{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:20px;white-space:pre-wrap;font-size:0.82rem;color:#475569;line-height:1.6}.doc-notes{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;font-size:0.82rem;color:#78350f}.doc-footer{margin-top:32px;padding-top:16px;border-top:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;font-size:0.72rem;color:#94a3b8}.accent-bar{height:4px;background:linear-gradient(90deg,#4f46e5,#7c3aed);border-radius:2px;margin-bottom:24px}@media print{body{padding:16px}.doc-wrap{max-width:100%}}</style>
</head><body><div class="doc-wrap">
  <div class="accent-bar"></div>
  <div class="doc-top">
    <div class="doc-top-left">${logoHtml}${bizName?`<div class="biz-name">${_dEsc(bizName)}</div>`:''}${bizAddress?`<div class="biz-detail">${_dEsc(bizAddress)}</div>`:''}${bizPhone?`<div class="biz-detail">${_dEsc(bizPhone)}</div>`:''}${bizEmail?`<div class="biz-detail">${_dEsc(bizEmail)}</div>`:''}</div>
    <div class="doc-top-right"><div class="doc-type-title">${typeLabel}</div>${docNumber?`<div class="doc-meta">#&nbsp;<strong>${_dEsc(docNumber)}</strong></div>`:''}${docDate?`<div class="doc-meta">${L.date}:&nbsp;<strong>${fmtDate(docDate)}</strong></div>`:''}${docDueDate&&_dType!=='receipt'&&_dType!=='contract'?`<div class="doc-meta">${L.due}:&nbsp;<strong>${fmtDate(docDueDate)}</strong></div>`:''}${invoiceRef&&_dType==='receipt'?`<div class="doc-meta">${_dLang==='es'?'Factura Ref':'Ref Invoice'}:&nbsp;<strong>${_dEsc(invoiceRef)}</strong></div>`:''}</div>
  </div>
  <div class="doc-parties">
    <div class="doc-party"><div class="party-label">${_dLang==='es'?'De':'From'}</div><div class="party-name">${_dEsc(bizName)}</div>${bizAddress?`<div class="party-detail">${_dEsc(bizAddress)}</div>`:''}${bizPhone?`<div class="party-detail">${_dEsc(bizPhone)}</div>`:''}${bizEmail?`<div class="party-detail">${_dEsc(bizEmail)}</div>`:''}</div>
    <div class="doc-party"><div class="party-label">${custLabel}</div><div class="party-name">${_dEsc(custName)||'--'}</div>${custAddr?`<div class="party-detail">${_dEsc(custAddr)}</div>`:''}${custPhone?`<div class="party-detail">${_dEsc(custPhone)}</div>`:''}${custEmail?`<div class="party-detail">${_dEsc(custEmail)}</div>`:''}</div>
  </div>
  ${(jobOrderedBy||jobLocation)?`<div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;">${jobOrderedBy?`<div style="flex:1;min-width:160px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;"><div style="font-size:0.68rem;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">${_dLang==='es'?'Ordenado Por':'Ordered By'}</div><div style="font-size:0.9rem;font-weight:600;color:#1e293b;">${_dEsc(jobOrderedBy)}</div></div>`:''}${jobLocation?`<div style="flex:1;min-width:160px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;"><div style="font-size:0.68rem;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">${_dLang==='es'?'Ubicacion del Trabajo':'Job Location'}</div><div style="font-size:0.9rem;font-weight:600;color:#1e293b;">${_dEsc(jobLocation)}</div></div>`:''}</div>`:''}
  ${projectTitle?`<div style="margin-bottom:20px;border-left:4px solid #4f46e5;padding-left:14px;"><div style="font-size:1.05rem;font-weight:800;color:#1e293b;line-height:1.3;">${_dEsc(projectTitle)}</div></div>`:''}
  ${jobScope?`<div style="margin-bottom:20px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;"><div style="font-size:0.68rem;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">${_dLang==='es'?'Alcance del Trabajo':'Scope of Work'}</div>${scopeHtml}</div>`:''}
  ${(_dShowPricing&&_dType!=='contract')?`<table><thead><tr><th>${L.desc}</th><th style="text-align:right">${L.total}</th></tr></thead><tbody>${itemsRowsHtml}</tbody></table>
  <table class="totals-table"><tr><td>${L.subtotal}</td><td style="text-align:right">$${subtotal.toFixed(2)}</td></tr>${taxRate>0?`<tr><td>${L.tax} (${taxRate}%)</td><td style="text-align:right">$${taxAmt.toFixed(2)}</td></tr>`:''}<tr class="grand"><td><strong>${grandTotalLabel}</strong></td><td style="text-align:right"><strong>$${grand.toFixed(2)}</strong></td></tr>${receiptPaymentHtml}${advance>0?`<tr><td style="color:#15803d;">${L.advance}</td><td style="text-align:right;color:#15803d;">- $${advance.toFixed(2)}</td></tr>`:''} ${advance>0?`<tr><td><strong style="color:#dc2626;">${L.balance}</strong></td><td style="text-align:right;color:#dc2626;font-weight:800;font-size:1.1rem;">$${balance.toFixed(2)}</td></tr>`:''}</table>
  ${paidInFullHtml}${payInstructionsHtml}`:''}
  ${_dType==='estimate'&&advance>0?`<div style="margin-bottom:20px;padding:14px 16px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;"><div style="font-size:0.68rem;font-weight:800;color:#1d4ed8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">${ptLabel}</div><p style="font-size:0.82rem;color:#1e3a5f;margin:0 0 6px;">${ptLine1}</p><p style="font-size:0.82rem;color:#1e3a5f;margin:0;">${ptLine2}</p></div>`:''}
  ${duration?`<div style="margin-bottom:20px;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;"><div style="font-size:0.68rem;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">${durationLabel}</div><p style="font-size:0.85rem;color:#1e293b;margin:0;">${durationApprox} <strong>${_dEsc(duration)}</strong>${durationNote}</p></div>`:''}
  ${_dType==='contract'&&contractTxt?`<div style="font-size:0.75rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">${L.terms}</div><div class="doc-contract">${_dEsc(contractTxt)}</div>`:''}
  ${notes?`<div class="doc-notes">${_dEsc(notes)}</div>`:''}
  ${includeTC&&termsText?`<div style="margin-top:28px;padding-top:16px;border-top:2px solid #e2e8f0;"><div style="font-size:0.68rem;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;">${L.tcTitle}</div><div style="font-size:0.75rem;color:#475569;line-height:1.7;white-space:pre-wrap;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;">${_dEsc(termsText)}</div></div>`:''}
  ${paymentBlockHtml?`<div style="margin-top:28px;padding:18px 20px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;text-align:center;"><div style="font-size:0.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:12px;">${_dLang==='es'?'Opciones de Pago':'Payment Options'}</div><div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;">${paymentBlockHtml}</div></div>`:''}
  ${(_dType==='estimate'||_dType==='contract')?_dSigSection(custName,bizName):''}
  <div class="doc-footer"><span>${L.thankYou}</span><span>${typeLabel} ${_dEsc(docNumber)}</span></div>
</div></body></html>`;
}

// ── Template 2: Bold Contractor ───────────────────────────────
function _dTplBold() {
  const { L, bizName, bizAddress, bizPhone, bizEmail, custName, custEmail, custPhone, custAddr,
    docNumber, docDate, notes, contractTxt, projectTitle, jobOrderedBy, jobLocation,
    duration, jobScope, taxRate, advance, includeTC, termsText, subtotal, taxAmt, grand, balance,
    grandTotalLabel, typeLabel, custLabel, fmtDate, logoHtml, TYPE_LABELS_ES, scopeHtml,
    receiptPaymentHtml, paidInFullHtml, payInstructionsHtml, invoiceRef, paymentBlockHtml } = _dGetData();
  const itemsHtml = _dType !== 'contract' ? _dItems.map(it => {
    const k = it.type || 'other'; const tl = _dLang==='es'?(TYPE_LABELS_ES[k]||k):k.charAt(0).toUpperCase()+k.slice(1);
    return `<tr><td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;"><span style="font-size:0.65rem;font-weight:800;text-transform:uppercase;color:#dc2626;">${_dEsc(tl)}</span><br><span style="font-size:0.82rem;">${_dEsc(it.desc)}</span></td><td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700;">$${(it.price||0).toFixed(2)}</td></tr>`;
  }).join('') : '';
  return `<!DOCTYPE html><html lang="${_dLang==='es'?'es':'en'}"><head><meta charset="utf-8"/><title>${typeLabel} ${docNumber}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1e293b;background:#fff;padding:0;font-size:13px;line-height:1.5}.wrap{max-width:760px;margin:0 auto}.hdr{background:#111;display:flex;align-items:stretch;min-height:100px}.hdr-logo{background:#fff;padding:14px 20px;display:flex;align-items:center;justify-content:center;min-width:120px}.hdr-mid{flex:1;padding:16px 20px;display:flex;flex-direction:column;justify-content:center}.hdr-biz{font-size:1rem;font-weight:800;color:#fff}.hdr-det{font-size:0.72rem;color:#94a3b8;margin-top:2px}.hdr-right{background:#dc2626;padding:14px 20px;text-align:center;display:flex;flex-direction:column;justify-content:center;align-items:center;min-width:140px}.hdr-type{font-size:1.3rem;font-weight:900;color:#fff;text-transform:uppercase}.hdr-num{font-size:0.75rem;color:#fecaca;margin-top:4px}.red-bar{height:5px;background:#dc2626}.info-row{display:flex}.info-box{flex:1;padding:14px 16px;border:1px solid #e2e8f0;border-top:3px solid #111}.info-box.red{border-top-color:#dc2626}.info-lbl{font-size:0.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:6px}.info-name{font-size:0.9rem;font-weight:700;color:#1e293b}.info-det{font-size:0.75rem;color:#64748b;line-height:1.5;margin-top:2px}.body{padding:20px}table{width:100%;border-collapse:collapse;margin-bottom:16px}thead tr{background:#111;color:#fff}thead th{padding:9px 12px;text-align:left;font-size:0.72rem;font-weight:800;text-transform:uppercase;letter-spacing:.04em}thead th:not(:first-child){text-align:right}tbody tr:nth-child(even){background:#fafafa}.totals{margin-left:auto;width:280px;border-top:3px solid #dc2626;border:1px solid #e2e8f0}.totals td{padding:7px 12px;font-size:0.85rem;color:#475569;border-bottom:1px solid #f1f5f9}.totals .grand td{font-size:1rem;font-weight:900;color:#111;background:#f8f8f8}.totals .balance td{font-size:1.05rem;font-weight:900;color:#dc2626;background:#fff5f5}.scope-box{padding:12px 16px;border:1px solid #e2e8f0;border-left:4px solid #dc2626;background:#fafafa;margin-bottom:16px}.scope-lbl{font-size:0.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:8px}.notes{background:#fffbeb;border-left:4px solid #d97706;padding:10px 14px;font-size:0.82rem;color:#78350f;margin-bottom:14px}.foot{background:#111;color:#94a3b8;padding:10px 20px;display:flex;justify-content:space-between;font-size:0.7rem;margin-top:20px}@media print{body{padding:0}.wrap{max-width:100%}}</style></head>
<body><div class="wrap">
  <div class="hdr">
    <div class="hdr-logo">${logoHtml||`<div style="width:80px;height:60px;background:#f1f5f9;border-radius:4px;"></div>`}</div>
    <div class="hdr-mid"><div class="hdr-biz">${_dEsc(bizName)}</div>${bizAddress?`<div class="hdr-det">${_dEsc(bizAddress)}</div>`:''}${bizPhone?`<div class="hdr-det">${_dEsc(bizPhone)}</div>`:''}${bizEmail?`<div class="hdr-det">${_dEsc(bizEmail)}</div>`:''}</div>
    <div class="hdr-right"><div class="hdr-type">${typeLabel}</div>${docNumber?`<div class="hdr-num">#${_dEsc(docNumber)}</div>`:''}${docDate?`<div class="hdr-num">${fmtDate(docDate)}</div>`:''}${invoiceRef&&_dType==='receipt'?`<div class="hdr-num">Ref: ${_dEsc(invoiceRef)}</div>`:''}</div>
  </div>
  <div class="red-bar"></div>
  <div class="info-row">
    <div class="info-box"><div class="info-lbl">${_dLang==='es'?'De':'From'}</div><div class="info-name">${_dEsc(bizName)||'--'}</div><div class="info-det">${[bizAddress,bizPhone,bizEmail].filter(Boolean).map(x=>_dEsc(x)).join('<br>')}</div></div>
    <div class="info-box red"><div class="info-lbl">${custLabel}</div><div class="info-name">${_dEsc(custName)||'--'}</div><div class="info-det">${[custAddr,custPhone,custEmail].filter(Boolean).map(x=>_dEsc(x)).join('<br>')}</div></div>
  </div>
  <div class="body">
    ${(projectTitle||jobOrderedBy||jobLocation||duration)?`<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">${projectTitle?`<div><div style="font-size:0.62rem;font-weight:800;text-transform:uppercase;color:#94a3b8;margin-bottom:4px;">${_dLang==='es'?'Proyecto':'Project'}</div><div style="font-size:0.85rem;font-weight:600;border-bottom:1px solid #e2e8f0;padding-bottom:3px;">${_dEsc(projectTitle)}</div></div>`:''}${jobOrderedBy?`<div><div style="font-size:0.62rem;font-weight:800;text-transform:uppercase;color:#94a3b8;margin-bottom:4px;">${_dLang==='es'?'Ordenado Por':'Ordered By'}</div><div style="font-size:0.85rem;font-weight:600;border-bottom:1px solid #e2e8f0;padding-bottom:3px;">${_dEsc(jobOrderedBy)}</div></div>`:''}${jobLocation?`<div><div style="font-size:0.62rem;font-weight:800;text-transform:uppercase;color:#94a3b8;margin-bottom:4px;">${_dLang==='es'?'Ubicacion':'Location'}</div><div style="font-size:0.85rem;font-weight:600;border-bottom:1px solid #e2e8f0;padding-bottom:3px;">${_dEsc(jobLocation)}</div></div>`:''}${duration?`<div><div style="font-size:0.62rem;font-weight:800;text-transform:uppercase;color:#94a3b8;margin-bottom:4px;">${_dLang==='es'?'Duracion':'Duration'}</div><div style="font-size:0.85rem;font-weight:600;border-bottom:1px solid #e2e8f0;padding-bottom:3px;">${_dEsc(duration)}</div></div>`:''}</div>`:''}
    ${jobScope?`<div class="scope-box"><div class="scope-lbl">${_dLang==='es'?'Alcance del Trabajo':'Scope of Work'}</div>${scopeHtml}</div>`:''}
    ${(_dShowPricing&&_dType!=='contract')?`<table><thead><tr><th>${L.desc}</th><th style="text-align:right;">${L.total}</th></tr></thead><tbody>${itemsHtml}</tbody></table>
    <div style="display:flex;justify-content:flex-end;margin-bottom:20px;"><table class="totals"><tr><td>${L.subtotal}</td><td style="text-align:right;">$${subtotal.toFixed(2)}</td></tr>${taxRate>0?`<tr><td>${L.tax} (${taxRate}%)</td><td style="text-align:right;">$${taxAmt.toFixed(2)}</td></tr>`:''}<tr class="grand"><td><strong>${grandTotalLabel}</strong></td><td style="text-align:right;"><strong>$${grand.toFixed(2)}</strong></td></tr>${receiptPaymentHtml}${advance>0?`<tr><td>${L.advance}</td><td style="text-align:right;color:#15803d;">-$${advance.toFixed(2)}</td></tr>`:''}${advance>0?`<tr class="balance"><td><strong>${L.balance}</strong></td><td style="text-align:right;"><strong>$${balance.toFixed(2)}</strong></td></tr>`:''}</table></div>${paidInFullHtml}${payInstructionsHtml}`:''}
    ${_dType==='contract'&&contractTxt?`<div style="font-size:0.82rem;color:#475569;white-space:pre-wrap;line-height:1.6;border:1px solid #e2e8f0;padding:14px;margin-bottom:16px;">${_dEsc(contractTxt)}</div>`:''}
    ${notes?`<div class="notes">${_dEsc(notes)}</div>`:''}
    ${includeTC&&termsText?`<div style="margin-top:20px;padding-top:14px;border-top:2px solid #e2e8f0;"><div style="font-size:0.65rem;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;">${L.tcTitle}</div><div style="font-size:0.75rem;color:#475569;line-height:1.7;white-space:pre-wrap;background:#f8fafc;border:1px solid #e2e8f0;padding:12px;">${_dEsc(termsText)}</div></div>`:''}
    ${paymentBlockHtml?`<div style="margin-top:20px;padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;text-align:center;"><div style="font-size:0.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:10px;">${_dLang==='es'?'Opciones de Pago':'Payment Options'}</div><div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;">${paymentBlockHtml}</div></div>`:''}
    ${(_dType==='estimate'||_dType==='contract')?_dSigSection(custName,bizName):''}
  </div>
  <div class="foot"><span>${L.thankYou}</span><span>${typeLabel} ${_dEsc(docNumber)}</span></div>
</div></body></html>`;
}

// ── Template 3: Executive Dark ────────────────────────────────
function _dTplExecutive() {
  const { L, bizName, bizAddress, bizPhone, bizEmail, custName, custEmail, custPhone, custAddr,
    docNumber, docDate, notes, contractTxt, projectTitle, jobOrderedBy, jobLocation,
    duration, jobScope, taxRate, advance, includeTC, termsText, subtotal, taxAmt, grand, balance,
    grandTotalLabel, typeLabel, custLabel, fmtDate, logoHtml, TYPE_LABELS_ES, scopeHtml,
    receiptPaymentHtml, paidInFullHtml, payInstructionsHtml, invoiceRef, paymentBlockHtml } = _dGetData();
  const gold = '#c9972b'; const navy = '#0f172a';
  const itemsHtml = _dType !== 'contract' ? _dItems.map(it => {
    const k = it.type || 'other'; const tl = _dLang==='es'?(TYPE_LABELS_ES[k]||k):k.charAt(0).toUpperCase()+k.slice(1);
    return `<tr><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;"><span style="font-size:0.65rem;font-weight:700;color:${gold};text-transform:uppercase;letter-spacing:.04em;">${_dEsc(tl)}</span><br><span style="font-size:0.82rem;">${_dEsc(it.desc)}</span></td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700;">$${(it.price||0).toFixed(2)}</td></tr>`;
  }).join('') : '';
  return `<!DOCTYPE html><html lang="${_dLang==='es'?'es':'en'}"><head><meta charset="utf-8"/><title>${typeLabel} ${docNumber}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Georgia',serif;color:#1e293b;background:#fff;padding:0;font-size:13px;line-height:1.6}.wrap{max-width:760px;margin:0 auto}.hdr{background:${navy};padding:28px 32px;display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap}.hdr-left{display:flex;align-items:center;gap:16px}.logo-box{background:rgba(255,255,255,.1);padding:8px;border-radius:4px;min-width:60px;text-align:center}.biz-name{font-size:1.1rem;font-weight:700;color:#fff}.biz-det{font-size:0.75rem;color:#94a3b8;margin-top:2px}.hdr-right{text-align:right}.doc-type{font-size:1.8rem;font-weight:400;color:${gold};letter-spacing:.06em;text-transform:uppercase;font-style:italic}.doc-num{font-size:0.8rem;color:#94a3b8;margin-top:4px}.gold-bar{height:3px;background:linear-gradient(90deg,${gold},#f5d87a,${gold})}.party-row{display:flex;gap:1px;background:#e2e8f0}.party{flex:1;background:#fff;padding:16px 20px;border-bottom:3px solid ${gold}}.party.client{border-bottom-color:${navy}}.plbl{font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:${gold};margin-bottom:6px}.pname{font-size:0.95rem;font-weight:700;color:${navy}}.pdet{font-size:0.75rem;color:#64748b;margin-top:3px;line-height:1.5}.body{padding:24px}table{width:100%;border-collapse:collapse;margin-bottom:16px}thead tr{background:${navy};color:#fff}thead th{padding:10px 14px;text-align:left;font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em}thead th:not(:first-child){text-align:right}tbody tr:nth-child(even){background:#fafaf8}.totals{margin-left:auto;width:300px;border-top:3px solid ${gold};border:1px solid #e2e8f0}.totals td{padding:8px 14px;font-size:0.85rem;color:#475569;border-bottom:1px solid #f1f5f9}.totals .grand td{font-weight:800;color:${navy};background:#fdf8ef;border-bottom:none}.totals .balance td{font-weight:800;color:#dc2626;background:#fff5f5}.scope-box{padding:16px 20px;background:#fafaf8;border-left:4px solid ${gold};margin-bottom:20px}.scope-lbl{font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:8px}.notes{background:#fdf8ef;border:1px solid #fde68a;padding:12px 16px;font-size:0.82rem;color:#78350f;margin-bottom:16px}.foot{background:${navy};color:#94a3b8;padding:12px 24px;display:flex;justify-content:space-between;font-size:0.7rem;margin-top:24px}@media print{body{padding:0}.wrap{max-width:100%}}</style></head>
<body><div class="wrap">
  <div class="hdr">
    <div class="hdr-left"><div class="logo-box">${logoHtml||`<div style="width:60px;height:50px;background:rgba(255,255,255,.1);border-radius:4px;"></div>`}</div><div><div class="biz-name">${_dEsc(bizName)}</div>${bizAddress?`<div class="biz-det">${_dEsc(bizAddress)}</div>`:''}${bizPhone?`<div class="biz-det">${_dEsc(bizPhone)}</div>`:''}${bizEmail?`<div class="biz-det">${_dEsc(bizEmail)}</div>`:''}</div></div>
    <div class="hdr-right"><div class="doc-type">${typeLabel}</div>${docNumber?`<div class="doc-num"># ${_dEsc(docNumber)}</div>`:''}${docDate?`<div class="doc-num">${fmtDate(docDate)}</div>`:''}${invoiceRef&&_dType==='receipt'?`<div class="doc-num">Ref: ${_dEsc(invoiceRef)}</div>`:''}</div>
  </div>
  <div class="gold-bar"></div>
  <div class="party-row">
    <div class="party"><div class="plbl">${_dLang==='es'?'De':'From'}</div><div class="pname">${_dEsc(bizName)}</div><div class="pdet">${[bizAddress,bizPhone,bizEmail].filter(Boolean).map(x=>_dEsc(x)).join('<br>')}</div></div>
    <div class="party client"><div class="plbl" style="color:${navy}">${custLabel}</div><div class="pname">${_dEsc(custName)||'--'}</div><div class="pdet">${[custAddr,custPhone,custEmail].filter(Boolean).map(x=>_dEsc(x)).join('<br>')}</div></div>
  </div>
  <div class="body">
    ${(projectTitle||jobOrderedBy||jobLocation||duration)?`<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px;">${projectTitle?`<div style="padding:10px 14px;background:#fafaf8;border:1px solid #e2e8f0;border-left:3px solid ${gold};"><div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:4px;">${_dLang==='es'?'Proyecto':'Project'}</div><div style="font-size:0.9rem;font-weight:700;color:${navy};">${_dEsc(projectTitle)}</div></div>`:''}${jobOrderedBy?`<div style="padding:10px 14px;background:#fafaf8;border:1px solid #e2e8f0;"><div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:4px;">${_dLang==='es'?'Ordenado Por':'Ordered By'}</div><div style="font-size:0.85rem;font-weight:600;">${_dEsc(jobOrderedBy)}</div></div>`:''}${jobLocation?`<div style="padding:10px 14px;background:#fafaf8;border:1px solid #e2e8f0;"><div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:4px;">${_dLang==='es'?'Ubicacion':'Location'}</div><div style="font-size:0.85rem;font-weight:600;">${_dEsc(jobLocation)}</div></div>`:''}${duration?`<div style="padding:10px 14px;background:#fafaf8;border:1px solid #e2e8f0;"><div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:4px;">${_dLang==='es'?'Duracion':'Duration'}</div><div style="font-size:0.85rem;font-weight:600;">${_dEsc(duration)}</div></div>`:''}</div>`:''}
    ${jobScope?`<div class="scope-box"><div class="scope-lbl">${_dLang==='es'?'Alcance del Trabajo':'Scope of Work'}</div>${scopeHtml}</div>`:''}
    ${(_dShowPricing&&_dType!=='contract')?`<table><thead><tr><th>${L.desc}</th><th style="text-align:right;">${L.total}</th></tr></thead><tbody>${itemsHtml}</tbody></table>
    <div style="display:flex;justify-content:flex-end;margin-bottom:20px;"><table class="totals"><tr><td>${L.subtotal}</td><td style="text-align:right;">$${subtotal.toFixed(2)}</td></tr>${taxRate>0?`<tr><td>${L.tax} (${taxRate}%)</td><td style="text-align:right;">$${taxAmt.toFixed(2)}</td></tr>`:''}<tr class="grand"><td><strong>${grandTotalLabel}</strong></td><td style="text-align:right;"><strong>$${grand.toFixed(2)}</strong></td></tr>${receiptPaymentHtml}${advance>0?`<tr><td style="color:#15803d;">${L.advance}</td><td style="text-align:right;color:#15803d;">-$${advance.toFixed(2)}</td></tr>`:''}${advance>0?`<tr class="balance"><td><strong>${L.balance}</strong></td><td style="text-align:right;"><strong>$${balance.toFixed(2)}</strong></td></tr>`:''}</table></div>${paidInFullHtml}${payInstructionsHtml}`:''}
    ${_dType==='contract'&&contractTxt?`<div style="font-size:0.82rem;color:#475569;white-space:pre-wrap;line-height:1.7;border:1px solid #e2e8f0;padding:16px;background:#fafaf8;margin-bottom:16px;">${_dEsc(contractTxt)}</div>`:''}
    ${notes?`<div class="notes">${_dEsc(notes)}</div>`:''}
    ${includeTC&&termsText?`<div style="margin-top:20px;padding-top:14px;border-top:1px solid #e2e8f0;"><div style="font-size:0.65rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;">${L.tcTitle}</div><div style="font-size:0.75rem;color:#475569;line-height:1.7;white-space:pre-wrap;background:#fafaf8;border:1px solid #e2e8f0;padding:14px;">${_dEsc(termsText)}</div></div>`:''}
    ${paymentBlockHtml?`<div style="margin-top:20px;padding:16px;background:#fdf8ef;border:1px solid #fde68a;border-radius:10px;text-align:center;"><div style="font-size:0.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#92400e;margin-bottom:10px;">${_dLang==='es'?'Opciones de Pago':'Payment Options'}</div><div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;">${paymentBlockHtml}</div></div>`:''}
    ${(_dType==='estimate'||_dType==='contract')?_dSigSection(custName,bizName):''}
  </div>
  <div class="foot"><span>${L.thankYou}</span><span>${typeLabel} ${_dEsc(docNumber)}</span></div>
</div></body></html>`;
}

// ── Template 4: Modern Gradient ───────────────────────────────
function _dTplModern() {
  const { L, bizName, bizAddress, bizPhone, bizEmail, custName, custEmail, custPhone, custAddr,
    docNumber, docDate, notes, contractTxt, projectTitle, jobOrderedBy, jobLocation,
    duration, jobScope, taxRate, advance, includeTC, termsText, subtotal, taxAmt, grand, balance,
    grandTotalLabel, typeLabel, fmtDate, logoHtml, TYPE_COLORS, TYPE_LABELS_ES, scopeHtml,
    receiptPaymentHtml, paidInFullHtml, payInstructionsHtml, invoiceRef, paymentBlockHtml } = _dGetData();
  const itemsHtml = _dType !== 'contract' ? _dItems.map(it => {
    const k = it.type || 'other'; const tc = TYPE_COLORS[k]||'#64748b'; const tl = _dLang==='es'?(TYPE_LABELS_ES[k]||k):k.charAt(0).toUpperCase()+k.slice(1);
    return `<tr><td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;"><span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:0.6rem;font-weight:800;text-transform:uppercase;background:${tc};color:#fff;margin-bottom:3px;">${_dEsc(tl)}</span><br><span style="font-size:0.82rem;">${_dEsc(it.desc)}</span></td><td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:700;">$${(it.price||0).toFixed(2)}</td></tr>`;
  }).join('') : '';
  return `<!DOCTYPE html><html lang="${_dLang==='es'?'es':'en'}"><head><meta charset="utf-8"/><title>${typeLabel} ${docNumber}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1e293b;background:#f1f5f9;padding:20px;font-size:13px;line-height:1.5}.wrap{max-width:760px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.1)}.hdr{background:linear-gradient(135deg,#7c3aed 0%,#0891b2 100%);padding:28px 32px;color:#fff;display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}.logo-wrap{background:rgba(255,255,255,.2);border-radius:12px;padding:8px;display:inline-flex;align-items:center;justify-content:center}.hdr-biz{font-size:1rem;font-weight:800}.hdr-det{font-size:0.72rem;color:rgba(255,255,255,.75);margin-top:2px}.doc-type{font-size:2rem;font-weight:900;letter-spacing:-0.02em;text-transform:uppercase}.doc-num{font-size:0.75rem;color:rgba(255,255,255,.75);margin-top:4px}.party-cards{display:flex;gap:16px;padding:20px 24px;flex-wrap:wrap}.card{flex:1;min-width:200px;background:#f8fafc;border-radius:12px;padding:14px 18px;border:1px solid #e2e8f0}.card-lbl{font-size:0.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:6px}.card-name{font-size:0.95rem;font-weight:700;color:#1e293b}.card-det{font-size:0.75rem;color:#64748b;line-height:1.5;margin-top:3px}.body{padding:0 24px 24px}table{width:100%;border-collapse:collapse;margin-bottom:16px;border-radius:12px;overflow:hidden}thead tr{background:linear-gradient(90deg,#7c3aed,#0891b2);color:#fff}thead th{padding:10px 14px;text-align:left;font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em}thead th:not(:first-child){text-align:right}tbody tr:nth-child(even){background:#f8fafc}.totals-wrap{display:flex;justify-content:flex-end;margin-bottom:20px}.totals{width:300px;background:#f8fafc;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0}.totals td{padding:8px 16px;font-size:0.85rem;color:#475569;border-bottom:1px solid #f1f5f9}.totals .grand td{font-size:1.05rem;font-weight:800;color:#1e293b;background:linear-gradient(90deg,#f0f0ff,#e8f9ff);border-bottom:none}.totals .balance td{font-size:1.05rem;font-weight:800;color:#dc2626;background:#fff5f5}.scope-card{background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:20px;border:1px solid #e2e8f0;border-left:4px solid #7c3aed}.scope-lbl{font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:8px}.notes{background:#fffbeb;border-radius:10px;border:1px solid #fde68a;padding:12px 16px;font-size:0.82rem;color:#78350f;margin-bottom:16px}.foot{background:linear-gradient(135deg,#7c3aed,#0891b2);color:rgba(255,255,255,.8);padding:12px 24px;display:flex;justify-content:space-between;font-size:0.72rem}@media print{body{padding:0;background:#fff}.wrap{box-shadow:none;border-radius:0;max-width:100%}}</style></head>
<body><div class="wrap">
  <div class="hdr">
    <div style="display:flex;align-items:center;gap:14px;"><div class="logo-wrap">${logoHtml||`<div style="width:52px;height:44px;background:rgba(255,255,255,.2);border-radius:8px;"></div>`}</div><div><div class="hdr-biz">${_dEsc(bizName)}</div>${bizAddress?`<div class="hdr-det">${_dEsc(bizAddress)}</div>`:''}${bizPhone?`<div class="hdr-det">${_dEsc(bizPhone)}</div>`:''}${bizEmail?`<div class="hdr-det">${_dEsc(bizEmail)}</div>`:''}</div></div>
    <div style="text-align:right;"><div class="doc-type">${typeLabel}</div>${docNumber?`<div class="doc-num">#${_dEsc(docNumber)}</div>`:''}${docDate?`<div class="doc-num">${fmtDate(docDate)}</div>`:''}${invoiceRef&&_dType==='receipt'?`<div class="doc-num">Ref: ${_dEsc(invoiceRef)}</div>`:''}</div>
  </div>
  <div class="party-cards">
    <div class="card"><div class="card-lbl">${_dLang==='es'?'De':'From'}</div><div class="card-name">${_dEsc(bizName)}</div><div class="card-det">${[bizAddress,bizPhone,bizEmail].filter(Boolean).map(x=>_dEsc(x)).join('<br>')}</div></div>
    <div class="card"><div class="card-lbl">${custLabel}</div><div class="card-name">${_dEsc(custName)||'--'}</div><div class="card-det">${[custAddr,custPhone,custEmail].filter(Boolean).map(x=>_dEsc(x)).join('<br>')}</div></div>
  </div>
  <div class="body">
    ${(projectTitle||jobOrderedBy||jobLocation||duration)?`<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;">${projectTitle?`<div style="background:#f8fafc;border-radius:10px;padding:12px 14px;border:1px solid #e2e8f0;border-left:3px solid #7c3aed;"><div style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:4px;">${_dLang==='es'?'Proyecto':'Project'}</div><div style="font-size:0.85rem;font-weight:600;color:#1e293b;">${_dEsc(projectTitle)}</div></div>`:''}${jobOrderedBy?`<div style="background:#f8fafc;border-radius:10px;padding:12px 14px;border:1px solid #e2e8f0;"><div style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:4px;">${_dLang==='es'?'Ordenado Por':'Ordered By'}</div><div style="font-size:0.85rem;font-weight:600;color:#1e293b;">${_dEsc(jobOrderedBy)}</div></div>`:''}${jobLocation?`<div style="background:#f8fafc;border-radius:10px;padding:12px 14px;border:1px solid #e2e8f0;"><div style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:4px;">${_dLang==='es'?'Ubicacion':'Location'}</div><div style="font-size:0.85rem;font-weight:600;color:#1e293b;">${_dEsc(jobLocation)}</div></div>`:''}${duration?`<div style="background:#f8fafc;border-radius:10px;padding:12px 14px;border:1px solid #e2e8f0;"><div style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:4px;">${_dLang==='es'?'Duracion':'Duration'}</div><div style="font-size:0.85rem;font-weight:600;color:#1e293b;">${_dEsc(duration)}</div></div>`:''}</div>`:''}
    ${jobScope?`<div class="scope-card"><div class="scope-lbl">${_dLang==='es'?'Alcance del Trabajo':'Scope of Work'}</div>${scopeHtml}</div>`:''}
    ${(_dShowPricing&&_dType!=='contract')?`<table><thead><tr><th>${L.desc}</th><th style="text-align:right;">${L.total}</th></tr></thead><tbody>${itemsHtml}</tbody></table>
    <div class="totals-wrap"><table class="totals"><tr><td>${L.subtotal}</td><td style="text-align:right;">$${subtotal.toFixed(2)}</td></tr>${taxRate>0?`<tr><td>${L.tax} (${taxRate}%)</td><td style="text-align:right;">$${taxAmt.toFixed(2)}</td></tr>`:''}<tr class="grand"><td><strong>${grandTotalLabel}</strong></td><td style="text-align:right;"><strong>$${grand.toFixed(2)}</strong></td></tr>${receiptPaymentHtml}${advance>0?`<tr><td style="color:#15803d;">${L.advance}</td><td style="text-align:right;color:#15803d;">-$${advance.toFixed(2)}</td></tr>`:''}${advance>0?`<tr class="balance"><td><strong>${L.balance}</strong></td><td style="text-align:right;"><strong>$${balance.toFixed(2)}</strong></td></tr>`:''}</table></div>${paidInFullHtml}${payInstructionsHtml}`:''}
    ${_dType==='contract'&&contractTxt?`<div style="font-size:0.82rem;color:#475569;white-space:pre-wrap;line-height:1.7;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;padding:16px;margin-bottom:16px;">${_dEsc(contractTxt)}</div>`:''}
    ${notes?`<div class="notes">${_dEsc(notes)}</div>`:''}
    ${includeTC&&termsText?`<div style="margin-top:20px;padding-top:14px;border-top:1px solid #e2e8f0;"><div style="font-size:0.65rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;">${L.tcTitle}</div><div style="font-size:0.75rem;color:#475569;line-height:1.7;white-space:pre-wrap;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;padding:14px;">${_dEsc(termsText)}</div></div>`:''}
    ${paymentBlockHtml?`<div style="margin-top:20px;padding:16px;background:#f0f4ff;border:1px solid #c7d2fe;border-radius:12px;text-align:center;"><div style="font-size:0.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#4338ca;margin-bottom:10px;">${_dLang==='es'?'Opciones de Pago':'Payment Options'}</div><div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;">${paymentBlockHtml}</div></div>`:''}
    ${(_dType==='estimate'||_dType==='contract')?_dSigSection(custName,bizName):''}
  </div>
  <div class="foot"><span>${L.thankYou}</span><span>${typeLabel} ${_dEsc(docNumber)}</span></div>
</div></body></html>`;
}

// ── Template 5: Minimal Pro ───────────────────────────────────
function _dTplMinimal() {
  const { L, bizName, bizAddress, bizPhone, bizEmail, custName, custEmail, custPhone, custAddr,
    docNumber, docDate, notes, contractTxt, projectTitle, jobOrderedBy, jobLocation,
    duration, jobScope, taxRate, advance, includeTC, termsText, subtotal, taxAmt, grand, balance,
    grandTotalLabel, typeLabel, custLabel, fmtDate, logoHtml, TYPE_LABELS_ES, scopeHtml,
    receiptPaymentHtml, paidInFullHtml, payInstructionsHtml, invoiceRef, paymentBlockHtml } = _dGetData();
  const itemsHtml = _dType !== 'contract' ? _dItems.map(it => {
    const k = it.type || 'other'; const tl = _dLang==='es'?(TYPE_LABELS_ES[k]||k):k.charAt(0).toUpperCase()+k.slice(1);
    return `<tr><td style="padding:10px 0;border-bottom:1px solid #e2e8f0;"><span style="font-size:0.65rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;">${_dEsc(tl)}</span><br><span style="font-size:0.85rem;">${_dEsc(it.desc)}</span></td><td style="padding:10px 0;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600;">$${(it.price||0).toFixed(2)}</td></tr>`;
  }).join('') : '';
  return `<!DOCTYPE html><html lang="${_dLang==='es'?'es':'en'}"><head><meta charset="utf-8"/><title>${typeLabel} ${docNumber}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1e293b;background:#fff;padding:40px;font-size:13px;line-height:1.6}.wrap{max-width:720px;margin:0 auto}.top{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:20px;border-bottom:2px solid #1e293b;margin-bottom:28px;gap:16px;flex-wrap:wrap}.biz-name{font-size:0.9rem;font-weight:700;margin-top:8px}.biz-det{font-size:0.75rem;color:#64748b;margin-top:1px}.doc-type{font-size:2rem;font-weight:300;text-transform:uppercase;letter-spacing:.08em}.doc-num{font-size:0.78rem;color:#94a3b8;margin-top:6px}.parties{display:flex;gap:40px;margin-bottom:28px;padding-bottom:28px;border-bottom:1px solid #e2e8f0;flex-wrap:wrap}.party{flex:1;min-width:160px}.party-lbl{font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;border-bottom:1px solid #e2e8f0;padding-bottom:4px;margin-bottom:6px}.party-name{font-size:0.9rem;font-weight:600}.party-det{font-size:0.75rem;color:#64748b;margin-top:3px;line-height:1.5}table{width:100%;border-collapse:collapse;margin-bottom:16px}thead th{padding:8px 0;text-align:left;font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;border-bottom:2px solid #1e293b}thead th:not(:first-child){text-align:right}.totals{margin-left:auto;width:260px}.totals td{padding:5px 0;font-size:0.85rem;color:#475569;border-bottom:1px solid #f1f5f9}.totals .grand td{font-size:1rem;font-weight:700;color:#1e293b;border-top:2px solid #1e293b;border-bottom:none;padding-top:8px}.totals .balance td{font-size:1.05rem;font-weight:800}.section-head{font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;border-bottom:1px solid #e2e8f0;padding-bottom:4px;margin-bottom:8px}.notes{border-left:3px solid #1e293b;padding:8px 14px;font-size:0.82rem;color:#475569;margin-bottom:16px}.foot{margin-top:40px;padding-top:16px;border-top:2px solid #1e293b;display:flex;justify-content:space-between;font-size:0.7rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8}@media print{body{padding:24px}.wrap{max-width:100%}}</style></head>
<body><div class="wrap">
  <div class="top">
    <div>${logoHtml}<div class="biz-name">${_dEsc(bizName)}</div>${bizAddress?`<div class="biz-det">${_dEsc(bizAddress)}</div>`:''}${bizPhone?`<div class="biz-det">${_dEsc(bizPhone)}</div>`:''}${bizEmail?`<div class="biz-det">${_dEsc(bizEmail)}</div>`:''}</div>
    <div style="text-align:right;"><div class="doc-type">${typeLabel}</div>${docNumber?`<div class="doc-num"># ${_dEsc(docNumber)}</div>`:''}${docDate?`<div class="doc-num">${fmtDate(docDate)}</div>`:''}${invoiceRef&&_dType==='receipt'?`<div class="doc-num">Ref: ${_dEsc(invoiceRef)}</div>`:''}</div>
  </div>
  <div class="parties">
    <div class="party"><div class="party-lbl">${_dLang==='es'?'De':'From'}</div><div class="party-name">${_dEsc(bizName)||'--'}</div><div class="party-det">${[bizAddress,bizPhone,bizEmail].filter(Boolean).map(x=>_dEsc(x)).join('<br>')}</div></div>
    <div class="party"><div class="party-lbl">${custLabel}</div><div class="party-name">${_dEsc(custName)||'--'}</div><div class="party-det">${[custAddr,custPhone,custEmail].filter(Boolean).map(x=>_dEsc(x)).join('<br>')}</div></div>
    ${jobOrderedBy||jobLocation?`<div class="party">${jobOrderedBy?`<div class="party-lbl">${_dLang==='es'?'Ordenado Por':'Ordered By'}</div><div class="party-name">${_dEsc(jobOrderedBy)}</div>`:''} ${jobLocation?`<div class="party-lbl" style="margin-top:8px;">${_dLang==='es'?'Ubicacion':'Location'}</div><div class="party-det">${_dEsc(jobLocation)}</div>`:''}</div>`:''}
  </div>
  ${projectTitle?`<div style="margin-bottom:20px;"><div class="section-head">${_dLang==='es'?'Proyecto':'Project'}</div><div style="font-size:1rem;font-weight:600;">${_dEsc(projectTitle)}</div></div>`:''}
  ${jobScope?`<div style="margin-bottom:24px;"><div class="section-head">${_dLang==='es'?'Alcance del Trabajo':'Scope of Work'}</div>${scopeHtml}</div>`:''}
  ${(_dShowPricing&&_dType!=='contract')?`<table><thead><tr><th>${L.desc}</th><th style="text-align:right;">${L.total}</th></tr></thead><tbody>${itemsHtml}</tbody></table>
  <div style="display:flex;justify-content:flex-end;margin-bottom:24px;"><table class="totals"><tr><td>${L.subtotal}</td><td style="text-align:right;">$${subtotal.toFixed(2)}</td></tr>${taxRate>0?`<tr><td>${L.tax} (${taxRate}%)</td><td style="text-align:right;">$${taxAmt.toFixed(2)}</td></tr>`:''}<tr class="grand"><td><strong>${grandTotalLabel}</strong></td><td style="text-align:right;"><strong>$${grand.toFixed(2)}</strong></td></tr>${receiptPaymentHtml}${advance>0?`<tr><td>${L.advance}</td><td style="text-align:right;">-$${advance.toFixed(2)}</td></tr>`:''}${advance>0?`<tr class="balance"><td><strong>${L.balance}</strong></td><td style="text-align:right;"><strong>$${balance.toFixed(2)}</strong></td></tr>`:''}</table></div>${paidInFullHtml}${payInstructionsHtml}`:''}
  ${duration?`<div style="margin-bottom:20px;"><div class="section-head">${_dLang==='es'?'Duracion Estimada':'Est. Duration'}</div><div style="font-size:0.85rem;">${_dEsc(duration)}</div></div>`:''}
  ${_dType==='contract'&&contractTxt?`<div style="margin-bottom:20px;"><div class="section-head">${L.terms}</div><div style="font-size:0.82rem;color:#475569;white-space:pre-wrap;line-height:1.7;">${_dEsc(contractTxt)}</div></div>`:''}
  ${notes?`<div class="notes">Note: ${_dEsc(notes)}</div>`:''}
  ${includeTC&&termsText?`<div style="margin-top:20px;padding-top:14px;border-top:1px solid #e2e8f0;"><div class="section-head">${L.tcTitle}</div><div style="font-size:0.75rem;color:#475569;line-height:1.7;white-space:pre-wrap;">${_dEsc(termsText)}</div></div>`:''}
  ${paymentBlockHtml?`<div style="margin-top:28px;padding:16px;border:1px solid #e2e8f0;border-left:3px solid #1e293b;text-align:center;"><div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:10px;">${_dLang==='es'?'Opciones de Pago':'Payment Options'}</div><div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;">${paymentBlockHtml}</div></div>`:''}
  ${(_dType==='estimate'||_dType==='contract')?_dSigSection(custName,bizName):''}
  <div class="foot"><span>${L.thankYou}</span><span>${typeLabel} ${_dEsc(docNumber)}</span></div>
</div></body></html>`;
}

// ── Customer search ───────────────────────────────────────────
window._dashDocSearchCustomers = function(query) {
  const dropdown = document.getElementById('docCustDropdown');
  if (!dropdown) return;
  if (!query.trim()) { dropdown.classList.add('hidden'); dropdown.innerHTML = ''; return; }
  const q = query.toLowerCase();
  const matches = _dAllCustomers.filter(c =>
    (c.name||'').toLowerCase().includes(q) ||
    (c.email||'').toLowerCase().includes(q) ||
    (c.phone||'').includes(q)
  ).slice(0, 8);
  if (!matches.length) { dropdown.classList.add('hidden'); dropdown.innerHTML = ''; return; }
  dropdown.innerHTML = matches.map(c => `
    <div class="doc-cust-item" onclick="window._dashDocSelectCustomer(${JSON.stringify(JSON.stringify(c))})">
      <div class="cust-name">${_dEsc(c.name)}</div>
      <div class="cust-sub">${[c.email, c.phone].filter(Boolean).join(' · ')}</div>
    </div>`).join('');
  dropdown.classList.remove('hidden');
};

window._dashDocSelectCustomer = function(cJson) {
  const c = JSON.parse(cJson);
  _dSetVal('docCustName',    c.name    || '');
  _dSetVal('docCustEmail',   c.email   || '');
  _dSetVal('docCustPhone',   c.phone   || '');
  _dSetVal('docCustAddress', c.address || '');
  _dSetVal('docJobOrderedBy', c.name   || '');
  const dd = document.getElementById('docCustDropdown');
  if (dd) { dd.classList.add('hidden'); dd.innerHTML = ''; }
  const inp = document.getElementById('docCustSearch');
  if (inp) inp.value = c.name || '';
  window._dashDocUpdatePreview();
};

async function _dLoadCustomers() {
  if (!bizId) return;
  try {
    const snap = await getDocs(query(collection(db, 'customers'), where('businessId', '==', bizId), orderBy('createdAt', 'desc')));
    _dAllCustomers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch(e) { _dAllCustomers = []; }
}

async function _dAutoSaveCustomer(custData) {
  try {
    const existing = _dAllCustomers.find(c => c.name?.toLowerCase() === custData.custName?.toLowerCase());
    if (!existing) {
      const ref = await addDoc(collection(db, 'customers'), {
        businessId: bizId,
        name:    custData.custName,
        email:   custData.custEmail   || '',
        phone:   custData.custPhone   || '',
        address: custData.custAddress || '',
        createdAt: serverTimestamp()
      });
      _dAllCustomers.push({ id: ref.id, name: custData.custName, email: custData.custEmail || '', phone: custData.custPhone || '', address: custData.custAddress || '' });
    }
  } catch(e) { console.warn('_dAutoSaveCustomer:', e); }
}

// ── Voice input ───────────────────────────────────────────────
window._dashDocVoiceField = function(fieldId) {
  const SR = window.SpeechRecognition || (window).webkitSpeechRecognition;
  if (!SR) { showToast('Voice input not supported in this browser.', 'error'); return; }
  const btn = document.querySelector(`[onclick="window._dashDocVoiceField('${fieldId}')"]`);
  if (btn) btn.classList.add('listening');
  const rec = new SR();
  rec.lang = _dLang === 'es' ? 'es-US' : 'en-US';
  rec.interimResults = false;
  rec.onresult = e => {
    const text = e.results[0]?.[0]?.transcript || '';
    const el = document.getElementById(fieldId);
    if (el) { el.value = (el.value ? el.value + ' ' : '') + text; }
    window._dashDocUpdatePreview();
    if (btn) btn.classList.remove('listening');
  };
  rec.onerror = () => { if (btn) btn.classList.remove('listening'); };
  rec.onend   = () => { if (btn) btn.classList.remove('listening'); };
  rec.start();
};

window._dashDocVoiceSearch = function() {
  const SR = window.SpeechRecognition || (window).webkitSpeechRecognition;
  if (!SR) { showToast('Voice input not supported.', 'error'); return; }
  const btn = document.getElementById('docCustVoiceBtn');
  if (btn) btn.classList.add('listening');
  const rec = new SR();
  rec.lang = _dLang === 'es' ? 'es-US' : 'en-US';
  rec.interimResults = false;
  rec.onresult = e => {
    const text = e.results[0]?.[0]?.transcript || '';
    const inp = document.getElementById('docCustSearch');
    if (inp) { inp.value = text; window._dashDocSearchCustomers(text); }
    if (btn) btn.classList.remove('listening');
  };
  rec.onerror = () => { if (btn) btn.classList.remove('listening'); };
  rec.onend   = () => { if (btn) btn.classList.remove('listening'); };
  rec.start();
};

// ── Share & Copy ──────────────────────────────────────────────
function _dNeedsSave() { showToast('Save the document first to get a shareable link.', 'error'); }

window._dashDocShareWA = function() {
  if (!_dCurrentDocId) { _dNeedsSave(); return; }
  const L = _DASH_DOC_LABELS[_dLang];
  const typeLabel = L[_dType] || _dType;
  const viewUrl   = `${window.location.origin}/view.html?id=${_dCurrentDocId}`;
  const msg = (_dLang === 'es' ? `Revisa tu ${typeLabel} aqui` : `Review your ${typeLabel} here`) + ':\n' + viewUrl;
  window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
};

window._dashDocShareEmail = function() {
  if (!_dCurrentDocId) { _dNeedsSave(); return; }
  const L = _DASH_DOC_LABELS[_dLang];
  const typeLabel = L[_dType] || _dType;
  const docNum    = document.getElementById('docNumber')?.value || '';
  const custEmail = document.getElementById('docCustEmail')?.value || '';
  const viewUrl   = `${window.location.origin}/view.html?id=${_dCurrentDocId}`;
  const msg = (_dLang === 'es' ? `Revisa tu ${typeLabel} aqui` : `Review your ${typeLabel} here`) + ':\n' + viewUrl + '\n\nThis link always shows the latest version.';
  const subject = encodeURIComponent(`${typeLabel}${docNum ? ' #' + docNum : ''}`);
  window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(custEmail)}&su=${subject}&body=${encodeURIComponent(msg)}`, '_blank', 'noopener');
};

window._dashDocCopy = function() {
  if (!_dCurrentDocId) { _dNeedsSave(); return; }
  const btn = document.getElementById('dashDocCopyBtn');
  const url = `${window.location.origin}/view.html?id=${_dCurrentDocId}`;
  navigator.clipboard.writeText(url).then(() => {
    if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 2000); }
  }).catch(() => alert('Could not copy to clipboard.'));
};

window._dashDocPrint = function() {
  const frame = document.getElementById('dashDocPreviewFrame');
  if (frame?.contentWindow) frame.contentWindow.print();
};

// ── Save to Firestore ─────────────────────────────────────────
window._dashDocSave = async function() {
  const btn = document.getElementById('dashDocSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  try {
    // If logo is a data-URL, keep inline (dashboard user, Storage not needed for personal doc)
    const htmlContent = window._dashDocGenerateHTML();
    const taxRate = parseFloat(document.getElementById('docTaxRate')?.value || 0);
    const subtotal = _dItems.reduce((s, it) => s + (it.price||0), 0);
    const grand    = subtotal + subtotal * taxRate / 100;
    const custName    = document.getElementById('docCustName')?.value    || '';
    const custEmail   = document.getElementById('docCustEmail')?.value   || '';
    const custPhone   = document.getElementById('docCustPhone')?.value   || '';
    const custAddress = document.getElementById('docCustAddress')?.value || '';

    const data = {
      businessId:   bizId,
      type:         _dType,
      lang:         _dLang,
      template:     _dDesign,
      docNumber:    document.getElementById('docNumber')?.value     || '',
      docDate:      document.getElementById('docDate')?.value       || '',
      docDueDate:   document.getElementById('docDueDate')?.value    || '',
      bizName:      document.getElementById('docBizName')?.value    || '',
      bizAddress:   document.getElementById('docBizAddress')?.value || '',
      bizPhone:     document.getElementById('docBizPhone')?.value   || '',
      bizEmail:     document.getElementById('docBizEmail')?.value   || '',
      custName,
      customerName: custName,
      custEmail,
      custPhone,
      custAddress,
      projectTitle: document.getElementById('docProjectTitle')?.value  || '',
      jobOrderedBy: document.getElementById('docJobOrderedBy')?.value  || '',
      jobLocation:  document.getElementById('docJobLocation')?.value   || '',
      duration:     document.getElementById('docDuration')?.value      || '',
      jobScope:     document.getElementById('docJobScope')?.value      || '',
      contractText: document.getElementById('docContractText')?.value  || '',
      notes:        document.getElementById('docNotes')?.value         || '',
      taxRate,
      advance:      parseFloat(document.getElementById('docAdvancePayment')?.value || 0),
      items:        _dItems,
      showPricing:  _dShowPricing,
      includeTC:    document.getElementById('docIncludeTC')?.checked || false,
      termsText:    document.getElementById('docTermsText')?.value || '',
      paymentMethod:    document.getElementById('docPaymentMethod')?.value  || '',
      payInstructions:  document.getElementById('docPayInstructions')?.value || '',
      invoiceRef:       document.getElementById('docInvoiceRef')?.value      || '',
      logoUrl:      _dLogoUrl,
      htmlContent,
      amount:       grand.toFixed(2),
      financingEnabled: document.getElementById('docFinancingEnabled')?.checked || false,
      financingUrl:     _dFinancingUrl,
      createdAt:    serverTimestamp()
    };

    if (document.getElementById('docSaveCust')?.checked && custName) {
      await _dAutoSaveCustomer(data);
    }

    let savedId = _dCurrentDocId;
    if (_dCurrentDocId) {
      await updateDoc(doc(db, 'documents', _dCurrentDocId), { ...data, updatedAt: serverTimestamp() });
    } else {
      const ref = await addDoc(collection(db, 'documents'), { ...data, status: 'pending', ownerUid: currentUser?.uid || '' });
      savedId = ref.id;
      _dCurrentDocId = savedId;
    }

    // Show share modal
    const viewUrl  = `${window.location.origin}/view.html?id=${savedId}`;
    const L        = _DASH_DOC_LABELS[_dLang];
    const typeLabel = L[_dType] || _dType;
    const docNum   = data.docNumber;
    _dShowShareModal(viewUrl, typeLabel, docNum, _dType);

    // Refresh doc list in background
    loadDocuments();
  } catch(e) {
    console.error('_dashDocSave error:', e);
    alert('Error saving document: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = 'Save Document'; }
  }
};

function _dShowShareModal(viewUrl, typeLabel, docNumber, type) {
  const existing = document.getElementById('dashDocShareModal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'dashDocShareModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:28px;max-width:460px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3);">
      <div style="text-align:center;margin-bottom:20px;">
        <div style="font-size:2.5rem;margin-bottom:8px;"></div>
        <div style="font-size:1.1rem;font-weight:800;color:#1e293b;">Document Saved!</div>
        <div style="font-size:0.82rem;color:#64748b;margin-top:4px;">${typeLabel}${docNumber?' #'+docNumber:''} is ready to share</div>
      </div>
      <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:6px;">Shareable Link</div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:10px 14px;margin-bottom:16px;display:flex;align-items:center;gap:8px;">
        <span style="font-size:0.78rem;color:#475569;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${viewUrl}</span>
        <button id="dsmCopyBtn" style="background:#4f46e5;color:#fff;border:none;border-radius:7px;padding:6px 12px;font-size:0.75rem;font-weight:700;cursor:pointer;white-space:nowrap;">Copy Link</button>
      </div>
      <div style="display:flex;gap:10px;">
        <button id="dsmWA"    style="flex:1;background:#22c55e;color:#fff;border:none;border-radius:9px;padding:10px;font-size:0.82rem;font-weight:700;cursor:pointer;">WhatsApp</button>
        <button id="dsmEmail" style="flex:1;background:#4f46e5;color:#fff;border:none;border-radius:9px;padding:10px;font-size:0.82rem;font-weight:700;cursor:pointer;">Email</button>
        <button id="dsmDone"  style="flex:1;background:#f1f5f9;color:#1e293b;border:none;border-radius:9px;padding:10px;font-size:0.82rem;font-weight:700;cursor:pointer;">Done</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  document.getElementById('dsmCopyBtn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(viewUrl).then(() => {
      const b = document.getElementById('dsmCopyBtn'); if (b) { b.textContent = 'Copied!'; setTimeout(() => b.textContent = 'Copy Link', 2000); }
    });
  });
  document.getElementById('dsmWA')?.addEventListener('click', () => {
    const L = _DASH_DOC_LABELS[_dLang];
    const tl = L[type] || type;
    window.open('https://wa.me/?text=' + encodeURIComponent((_dLang==='es'?`Revisa tu ${tl} aqui`:`Review your ${tl} here`) + ':\n' + viewUrl), '_blank');
  });
  document.getElementById('dsmEmail')?.addEventListener('click', () => {
    const L = _DASH_DOC_LABELS[_dLang];
    const tl = L[type] || type;
    const sub = encodeURIComponent(`${tl}${docNumber?' #'+docNumber:''}`);
    const body = encodeURIComponent((_dLang==='es'?`Revisa tu ${tl} aqui`:`Review your ${tl} here`) + ':\n' + viewUrl);
    window.open(`https://mail.google.com/mail/?view=cm&su=${sub}&body=${body}`, '_blank', 'noopener');
  });
  document.getElementById('dsmDone')?.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

// ── Open Doc Creator ──────────────────────────────────────────
function openDocCreator(type = 'invoice', existingDoc = null) {
  _dType        = existingDoc?.type || type;
  _dDesign      = existingDoc?.template || existingDoc?.design || 'classic';
  _dItems       = existingDoc?.items?.length ? existingDoc.items : [{ desc:'', price:0, type:'labor' }];
  _dLogoUrl     = existingDoc?.logoUrl || '';
  _dCurrentDocId = existingDoc?.id || null;
  _dShowPricing  = existingDoc ? (existingDoc.showPricing !== false) : true;
  _dLang         = existingDoc?.lang || 'en';

  const modal = document.getElementById('docCreatorModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Load customers so search works immediately (no need to visit Customers section first)
  if (!_dAllCustomers.length) _dLoadCustomers();

  // Reset form fields
  ['docBizName','docBizAddress','docBizPhone','docBizEmail',
   'docCustName','docCustEmail','docCustPhone','docCustAddress',
   'docCustSearch','docNumber','docDate','docDueDate','docNotes','docContractText',
   'docProjectTitle','docJobOrderedBy','docJobLocation','docDuration','docJobScope',
   'docPayInstructions','docInvoiceRef'].forEach(id => _dSetVal(id, ''));
  _dSetVal('docTaxRate', '0');
  _dSetVal('docAdvancePayment', '0');

  // Reset toggles
  const pChk = document.getElementById('docShowPricing');
  if (pChk) pChk.checked = true;
  document.getElementById('docPricingContent')?.classList.remove('hidden');
  const tcChk = document.getElementById('docIncludeTC');
  if (tcChk) tcChk.checked = false;
  document.getElementById('docTCSection')?.classList.add('hidden');
  _dSetVal('docTermsText', '');
  const saveCust = document.getElementById('docSaveCust');
  if (saveCust) saveCust.checked = false;

  // Reset logo
  const img = document.getElementById('docLogoImg');
  const ph  = document.getElementById('docLogoPlaceholder');
  if (img) { img.src = ''; img.style.display = 'none'; }
  if (ph)  ph.style.display = '';
  const logoInput = document.getElementById('docLogoInput');
  if (logoInput) { logoInput.value = ''; logoInput._dashWired = false; }

  // Pre-fill from business profile
  const biz = bizDoc || {};
  _dSetVal('docBizName',    biz.companyName || biz.name    || biz.bizName    || '');
  _dSetVal('docBizAddress', biz.address     || biz.bizAddress || '');
  _dSetVal('docBizPhone',   biz.phone       || biz.bizPhone   || '');
  _dSetVal('docBizEmail',   biz.email       || biz.bizEmail   || '');

  if (biz.logoUrl) {
    _dLogoUrl = biz.logoUrl;
    if (img) { img.src = _dLogoUrl; img.style.display = 'block'; }
    if (ph)  ph.style.display = 'none';
  }

  // Default notes for new docs
  if (!existingDoc) {
    const noteOwner = biz.companyName || biz.name || 'our team';
    _dSetVal('docNotes', `\u{1F4CC} This estimate is based on the visible and known conditions at the time of preparation. If unforeseen conditions are discovered after access is opened or excavation begins, additional work or materials may be required. Any work outside the scope described above should be discussed with ${noteOwner} and approved by the customer before proceeding.`);
  }

  // Set date + doc number
  _dSetVal('docDate', new Date().toISOString().slice(0,10));
  _dSetVal('docNumber', type.slice(0,3).toUpperCase() + '-' + String(Date.now()).slice(-4));

  // Set type, lang, design
  window._dashDocSetType(_dType);
  window._dashDocSetLang(_dLang);
  window._dashDocSetDesign(_dDesign);

  // Pre-fill existing doc fields for editing
  if (existingDoc) {
    const e = existingDoc;
    _dSetVal('docBizName',       e.bizName        || '');
    _dSetVal('docBizAddress',    e.bizAddress     || '');
    _dSetVal('docBizPhone',      e.bizPhone       || '');
    _dSetVal('docBizEmail',      e.bizEmail       || '');
    _dSetVal('docCustName',      e.customerName   || e.custName    || '');
    _dSetVal('docCustEmail',     e.customerEmail  || e.custEmail   || '');
    _dSetVal('docCustPhone',     e.customerPhone  || e.custPhone   || '');
    _dSetVal('docCustAddress',   e.customerAddress|| e.custAddress || '');
    _dSetVal('docNumber',        e.docNumber      || '');
    _dSetVal('docDate',          e.docDate        || '');
    _dSetVal('docDueDate',       e.docDueDate     || e.dueDate || '');
    _dSetVal('docNotes',         e.notes          || '');
    _dSetVal('docContractText',  e.contractText   || '');
    _dSetVal('docProjectTitle',  e.projectTitle   || '');
    _dSetVal('docJobOrderedBy',  e.jobOrderedBy   || '');
    _dSetVal('docJobLocation',   e.jobLocation    || '');
    _dSetVal('docDuration',      e.duration       || '');
    _dSetVal('docJobScope',      e.jobScope       || '');
    _dSetVal('docPayInstructions', e.payInstructions || '');
    _dSetVal('docInvoiceRef',    e.invoiceRef     || '');
    _dSetVal('docTaxRate',       e.taxRate != null ? String(e.taxRate) : '0');
    _dSetVal('docAdvancePayment', e.advance != null ? String(e.advance) : (e.advancePayment != null ? String(e.advancePayment) : '0'));
    if (e.logoUrl) {
      _dLogoUrl = e.logoUrl;
      if (img) { img.src = e.logoUrl; img.style.display = 'block'; }
      if (ph)  ph.style.display = 'none';
    }
    const pChk2 = document.getElementById('docShowPricing');
    if (pChk2) {
      pChk2.checked = e.showPricing !== false;
      document.getElementById('docPricingContent')?.classList.toggle('hidden', !pChk2.checked);
    }
  }

  // Render items & preview
  window._dashDocRenderItems();
  window._dashDocUpdateTotals();
  window._dashDocUpdatePreview();
  _dWireLogoUpload();

  // Load customers in background
  _dLoadCustomers();

  // Load payment methods
  if (bizId) {
    getDoc(doc(db, 'businesses', bizId)).then(snap => {
      const data = snap.data() || {};
      _dBizPaymentMethods = data.paymentMethods || {};
    }).catch(() => {});
  }

  // Wire close button
  const closeBtn = document.getElementById('dashCloseDocCreator');
  if (closeBtn && !closeBtn._dashWired) {
    closeBtn._dashWired = true;
    closeBtn.addEventListener('click', _dashCloseCreator);
  }

  // Escape key closes creator
  if (!window._dashCreatorEscWired) {
    window._dashCreatorEscWired = true;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.getElementById('docCreatorModal')?.classList.contains('hidden')) {
        _dashCloseCreator();
      }
    });
  }
}

function _dashCloseCreator() {
  const modal = document.getElementById('docCreatorModal');
  if (modal) modal.classList.add('hidden');
  document.body.style.overflow = '';
}

// ── Document Templates ────────────────────────────────────────
let _dAllTemplates = [];

window._dashDocToggleTplMenu = function() {
  document.getElementById('dashDocTplMenu')?.classList.toggle('hidden');
};

window._dashDocSaveTemplate = async function() {
  document.getElementById('dashDocTplMenu')?.classList.add('hidden');
  const name = prompt('Template name:');
  if (!name) return;
  const user = auth.currentUser;
  if (!user) return;
  try {
    await addDoc(collection(db, 'docTemplates'), {
      name,
      type:         _dType,
      lang:         _dLang,
      bizName:      document.getElementById('docBizName')?.value     || '',
      bizAddress:   document.getElementById('docBizAddress')?.value  || '',
      bizPhone:     document.getElementById('docBizPhone')?.value    || '',
      bizEmail:     document.getElementById('docBizEmail')?.value    || '',
      notes:        document.getElementById('docNotes')?.value         || '',
      contractText: document.getElementById('docContractText')?.value  || '',
      projectTitle: document.getElementById('docProjectTitle')?.value  || '',
      jobOrderedBy: document.getElementById('docJobOrderedBy')?.value  || '',
      jobLocation:  document.getElementById('docJobLocation')?.value   || '',
      duration:     document.getElementById('docDuration')?.value      || '',
      jobScope:     document.getElementById('docJobScope')?.value      || '',
      showPricing:  _dShowPricing,
      includeTC:    document.getElementById('docIncludeTC')?.checked   || false,
      termsText:    document.getElementById('docTermsText')?.value     || '',
      taxRate:      parseFloat(document.getElementById('docTaxRate')?.value || 0),
      paymentMethod:document.getElementById('docPaymentMethod')?.value || '',
      items:        _dItems,
      logoUrl:      _dLogoUrl,
      designTemplate: _dDesign,
      ownerUid:     user.uid,
      createdAt:    serverTimestamp()
    });
    showToast('Template saved!', 'success');
  } catch(e) {
    showToast('Error saving template: ' + e.message, 'error');
  }
};

window._dashDocOpenTemplates = async function() {
  document.getElementById('dashDocTplMenu')?.classList.add('hidden');
  await _dashLoadTemplates();
  _dashRenderTemplates();
  document.getElementById('dashDocTemplatePickerModal')?.classList.remove('hidden');
};

async function _dashLoadTemplates() {
  const user = auth.currentUser;
  if (!user) return;
  try {
    const snap = await getDocs(query(
      collection(db, 'docTemplates'),
      where('ownerUid', '==', user.uid),
      orderBy('createdAt', 'desc')
    ));
    _dAllTemplates = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch(e) { _dAllTemplates = []; }
}

function _dashRenderTemplates() {
  const list = document.getElementById('dashDocTemplatePickerList');
  if (!list) return;
  if (!_dAllTemplates.length) {
    list.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:20px">No templates saved yet.</p>';
    return;
  }
  list.innerHTML = _dAllTemplates.map(t => `
    <div class="doc-tpl-item">
      <span class="tpl-name">${_dEsc(t.name)}</span>
      <span class="tpl-type">${t.type || ''}</span>
      <button class="tpl-load" onclick="window._dashDocLoadTemplate('${t.id}')">Load</button>
      <button class="tpl-del"  onclick="window._dashDocDeleteTemplate('${t.id}')">✕</button>
    </div>`).join('');
}

window._dashDocLoadTemplate = function(id) {
  const tpl = _dAllTemplates.find(t => t.id === id);
  if (!tpl) return;
  document.getElementById('dashDocTemplatePickerModal')?.classList.add('hidden');
  _dItems       = tpl.items?.length ? [...tpl.items] : [{ desc:'', price:0, type:'labor' }];
  _dLogoUrl     = tpl.logoUrl || '';
  window._dashDocSetType(tpl.type || 'invoice');
  window._dashDocSetDesign(tpl.designTemplate || 'classic');
  _dSetVal('docBizName',     tpl.bizName     || '');
  _dSetVal('docBizAddress',  tpl.bizAddress  || '');
  _dSetVal('docBizPhone',    tpl.bizPhone    || '');
  _dSetVal('docBizEmail',    tpl.bizEmail    || '');
  _dSetVal('docNotes',         tpl.notes        || '');
  _dSetVal('docContractText',  tpl.contractText || '');
  _dSetVal('docProjectTitle',  tpl.projectTitle || '');
  _dSetVal('docJobOrderedBy',  tpl.jobOrderedBy || '');
  _dSetVal('docJobLocation',   tpl.jobLocation  || '');
  _dSetVal('docDuration',      tpl.duration     || '');
  _dSetVal('docJobScope',      tpl.jobScope     || '');
  _dSetVal('docTaxRate',       tpl.taxRate      || 0);
  _dSetVal('docAdvancePayment', 0);
  _dShowPricing = tpl.showPricing !== false;
  const pChk = document.getElementById('docShowPricing');
  if (pChk) pChk.checked = _dShowPricing;
  document.getElementById('docPricingContent')?.classList.toggle('hidden', !_dShowPricing);
  if (tpl.paymentMethod) {
    const pmEl = document.getElementById('docPaymentMethod');
    if (pmEl) pmEl.value = tpl.paymentMethod;
  }
  const tcChk = document.getElementById('docIncludeTC');
  const tcChecked = !!tpl.includeTC;
  if (tcChk) tcChk.checked = tcChecked;
  document.getElementById('docTCSection')?.classList.toggle('hidden', !tcChecked);
  _dSetVal('docTermsText', tpl.termsText || '');
  if (_dLogoUrl) {
    const img = document.getElementById('docLogoImg');
    const ph  = document.getElementById('docLogoPlaceholder');
    if (img) { img.src = _dLogoUrl; img.style.display = 'block'; }
    if (ph)  ph.style.display = 'none';
  }
  window._dashDocRenderItems();
  window._dashDocUpdateTotals();
  window._dashDocUpdatePreview();
  showToast('Template loaded', 'success');
};

window._dashDocDeleteTemplate = async function(id) {
  if (!confirm('Delete this template?')) return;
  try {
    await deleteDoc(doc(db, 'docTemplates', id));
    _dAllTemplates = _dAllTemplates.filter(t => t.id !== id);
    _dashRenderTemplates();
    showToast('Template deleted', 'success');
  } catch(e) {
    showToast('Error deleting template', 'error');
  }
};

// ============================================================
// AI HELP CHAT
// ============================================================
let _aiHistory    = [];
let _aiPendingImg = null; // { base64, mediaType }
let _aiChatOpen   = false;

function _aiInitSupport() {
  const fab = document.getElementById('aiHelpFab');
  if (!fab) return;
  fab.style.display = 'flex';
  fab.classList.remove('hidden');

  // Paste screenshot anywhere on page
  document.addEventListener('paste', e => {
    if (!_aiChatOpen) return;
    const item = Array.from(e.clipboardData?.items || []).find(i => i.type.startsWith('image/'));
    if (item) _aiLoadImageFile(item.getAsFile());
  });
}

window._aiToggleChat = function() {
  const modal = document.getElementById('aiChatModal');
  if (!modal) return;
  _aiChatOpen = !_aiChatOpen;
  modal.style.display = _aiChatOpen ? 'flex' : 'none';
  if (_aiChatOpen) {
    if (!_aiHistory.length) _aiAddMsg('assistant', 'Hi! I\'m your EP Local Pro AI assistant. Describe your issue or paste/attach a screenshot and I\'ll help you troubleshoot.');
    document.getElementById('aiInput')?.focus();
  }
};

window._aiHandleFile = function(input) {
  const file = input.files?.[0];
  if (file) _aiLoadImageFile(file);
  input.value = '';
};

function _aiLoadImageFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const dataUrl = e.target.result;
    const [header, base64] = dataUrl.split(',');
    const mediaType = header.match(/data:([^;]+)/)?.[1] || 'image/png';
    _aiPendingImg = { base64, mediaType };
    const preview = document.getElementById('aiImgPreview');
    const wrap    = document.getElementById('aiImgPreviewWrap');
    if (preview) preview.src = dataUrl;
    if (wrap)    wrap.style.display = 'block';
  };
  reader.readAsDataURL(file);
}

window._aiClearImg = function() {
  _aiPendingImg = null;
  const wrap = document.getElementById('aiImgPreviewWrap');
  if (wrap) wrap.style.display = 'none';
};

window._aiSend = async function() {
  const input = document.getElementById('aiInput');
  const text  = (input?.value || '').trim();
  if (!text && !_aiPendingImg) return;

  const userContent = [];
  if (_aiPendingImg) {
    userContent.push({ type: 'image', source: { type: 'base64', media_type: _aiPendingImg.mediaType, data: _aiPendingImg.base64 } });
  }
  if (text) userContent.push({ type: 'text', text });

  _aiAddMsg('user', text, _aiPendingImg ? '📎 image attached' : null);
  if (input) input.value = '';
  window._aiClearImg();

  _aiHistory.push({ role: 'user', content: userContent });
  if (_aiHistory.length > 20) _aiHistory = _aiHistory.slice(-20);

  const thinkId = _aiAddMsg('assistant', '…', null, true);

  try {
    const uid = currentUser?.uid;
    const res = await fetch('/.netlify/functions/ai-support', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, messages: _aiHistory })
    });
    const data = await res.json();
    _aiRemoveThinking(thinkId);
    if (!res.ok) {
      _aiAddMsg('assistant', data.error || 'Something went wrong. Please try again.');
      return;
    }
    const reply = data.text || '';
    _aiHistory.push({ role: 'assistant', content: reply });
    _aiAddMsg('assistant', reply);
  } catch (e) {
    _aiRemoveThinking(thinkId);
    _aiAddMsg('assistant', 'Could not reach the AI service. Check your connection and try again.');
  }
};

function _aiAddMsg(role, text, note, isThinking = false) {
  const container = document.getElementById('aiMsgs');
  if (!container) return null;
  const id  = 'ai-msg-' + Date.now() + Math.random().toString(36).slice(2);
  const div = document.createElement('div');
  div.id = id;
  const isUser = role === 'user';
  div.style.cssText = `display:flex;flex-direction:column;align-items:${isUser ? 'flex-end' : 'flex-start'};gap:2px;`;
  const bubble = document.createElement('div');
  bubble.style.cssText = `max-width:88%;padding:8px 11px;border-radius:${isUser ? '12px 12px 2px 12px' : '12px 12px 12px 2px'};font-size:0.82rem;line-height:1.5;white-space:pre-wrap;word-break:break-word;background:${isUser ? '#6366f1' : '#2a2a3e'};color:${isUser ? '#fff' : '#e2e8f0'};`;
  bubble.textContent = isThinking ? '⏳ Thinking…' : (text || '');
  div.appendChild(bubble);
  if (note) {
    const small = document.createElement('small');
    small.style.cssText = 'color:#64748b;font-size:0.7rem;';
    small.textContent = note;
    div.appendChild(small);
  }
  container.appendChild(div);
  _aiScrollMsgs();
  return id;
}

function _aiRemoveThinking(id) {
  if (id) document.getElementById(id)?.remove();
}

function _aiScrollMsgs() {
  const c = document.getElementById('aiMsgs');
  if (c) c.scrollTop = c.scrollHeight;
}

// ============================================================
// FINANCING SECTION
// ============================================================
let _finDocs = [];

window._loadFinancingSection = async function() {
  const list    = document.getElementById('finDashList');
  const urlWarn = document.getElementById('finDashUrlWarn');
  const reqEl   = document.getElementById('finDashRequests');
  const enEl    = document.getElementById('finDashEnabled');
  if (!list) return;

  list.innerHTML = '<p style="color:#94a3b8;font-size:0.85rem;padding:12px 0">Loading…</p>';

  // Check financing URL config
  let finUrl = '';
  try {
    const cfg = await getDoc(doc(db, 'config', 'financing'));
    finUrl = cfg.data()?.url || '';
  } catch(_) {}
  if (urlWarn) urlWarn.style.display = finUrl ? 'none' : 'block';

  // Load this business's documents
  try {
    const snap = await getDocs(query(
      collection(db, 'documents'),
      where('businessId', '==', bizId)
    ));
    _finDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        // Sort: requested first, then enabled, then rest by date
        const ar = a.financingRequested ? 2 : a.financingEnabled ? 1 : 0;
        const br = b.financingRequested ? 2 : b.financingEnabled ? 1 : 0;
        if (ar !== br) return br - ar;
        return (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0);
      });

    const requests = _finDocs.filter(d => d.financingRequested).length;
    const enabled  = _finDocs.filter(d => d.financingEnabled).length;
    if (reqEl) reqEl.textContent = requests;
    if (enEl)  enEl.textContent  = enabled;

    _renderFinancingDocs(_finDocs, finUrl);
  } catch(e) {
    console.error('_loadFinancingSection error:', e);
    list.innerHTML = '<div class="empty-state"><p>Error loading documents.</p></div>';
  }
};

function _renderFinancingDocs(docs, finUrl) {
  const list = document.getElementById('finDashList');
  if (!list) return;
  if (!docs.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📄</div><p>No documents yet.</p></div>';
    return;
  }

  const rows = docs.map(d => {
    const on  = d.financingEnabled === true;
    const req = d.financingRequested === true;
    const type = (d.type||'').replace(/^\w/,c=>c.toUpperCase());
    const date = d.docDate || (d.createdAt?.toDate?.()?.toLocaleDateString() || '—');
    const amt  = d.total != null ? `$${Number(d.total).toFixed(2)}` : '—';
    return `<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #f1f5f9;flex-wrap:wrap;">
      <div style="width:4px;min-height:40px;border-radius:4px;background:${req?'#f59e0b':on?'#22c55e':'#e2e8f0'};flex-shrink:0;"></div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:0.88rem;color:#1e293b;">${escHTML(d.finRequestName||d.custName||'—')}</div>
        ${req && (d.finRequestEmail||d.finRequestPhone) ? `<div style="font-size:0.73rem;color:#92400e;">${escHTML(d.finRequestEmail||'')}${d.finRequestPhone?' · '+escHTML(d.finRequestPhone):''}</div>` : ''}
        <div style="font-size:0.75rem;color:#94a3b8;">${type} · ${escHTML(d.docNumber||'')} · ${date}</div>
      </div>
      <div style="font-size:0.9rem;font-weight:700;color:#1e293b;min-width:70px;text-align:right;">${amt}</div>
      ${req ? '<span style="background:#fef3c7;color:#92400e;border-radius:20px;padding:3px 9px;font-size:0.72rem;font-weight:700;white-space:nowrap;">🔔 Requested</span>' : ''}
      <button onclick="window._dashToggleDocFinancing('${escHTML(d.id)}',${!on})"
        style="padding:6px 14px;border-radius:8px;border:1.5px solid ${on?'#22c55e':'#e2e8f0'};background:${on?'#dcfce7':'#f8fafc'};color:${on?'#15803d':'#64748b'};font-size:0.8rem;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;">
        ${on ? '✅ ON' : '🏦 Enable'}
      </button>
    </div>`;
  }).join('');

  list.innerHTML = `<div style="border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">${rows}</div>`;
}

window._filterFinancingDocs = function(q) {
  const filtered = q
    ? _finDocs.filter(d => (d.custName||'').toLowerCase().includes(q.toLowerCase()) || (d.docNumber||'').includes(q))
    : _finDocs;
  _renderFinancingDocs(filtered, '');
};

window._dashToggleDocFinancing = async function(docId, enable) {
  try {
    let finUrl = '';
    if (enable) {
      const cfg = await getDoc(doc(db, 'config', 'financing'));
      finUrl = cfg.data()?.url || '';
      if (!finUrl) { showToast('Financing URL is not configured yet. Contact your administrator.', 'error'); return; }
    }
    await updateDoc(doc(db, 'documents', docId), {
      financingEnabled: enable,
      financingUrl: enable ? finUrl : ''
    });
    showToast(`Financing ${enable ? 'enabled' : 'disabled'}`, 'success');
    window._loadFinancingSection();
  } catch(e) {
    console.error('_dashToggleDocFinancing error:', e);
    showToast('Could not update financing', 'error');
  }
};

// ── Google My Business ────────────────────────────────────────

let _gmbRequestId = null;

window._loadGmbSection = async function() {
  const banner   = document.getElementById('gmbStatusBanner');
  const form     = document.getElementById('gmbRequestForm');
  const noteBox  = document.getElementById('gmbAdminNote');
  const noteText = document.getElementById('gmbAdminNoteText');
  if (!banner || !form) return;

  // Pre-fill form from business profile
  const biz = bizDoc || {};
  const owner = ownerDoc || {};
  const setV = (id, val) => { const el = document.getElementById(id); if (el && !el.value) el.value = val || ''; };
  setV('gmbBizName',   biz.companyName || biz.name || '');
  setV('gmbOwnerName', owner.name || owner.displayName || '');
  setV('gmbPhone',     biz.phone || '');
  setV('gmbEmail',     biz.email || currentUser?.email || '');
  setV('gmbAddress',   biz.address || '');
  setV('gmbCategory',  biz.category || bizCategory || '');
  setV('gmbWebsite',   biz.website || '');

  // Check for existing request
  try {
    const snap = await getDocs(query(
      collection(db, 'gmb_requests'),
      where('uid', '==', currentUser.uid),
      limit(1)
    ));
    if (!snap.empty) {
      const req = snap.docs[0].data();
      _gmbRequestId = snap.docs[0].id;
      _gmbShowStatus(banner, form, req);
      if (req.adminNotes) {
        noteText.textContent = req.adminNotes;
        noteBox.style.display = '';
      } else {
        noteBox.style.display = 'none';
      }
    } else {
      _gmbRequestId = null;
      banner.style.display = 'none';
      form.style.display = '';
      noteBox.style.display = 'none';
    }
  } catch(e) {
    console.error('_loadGmbSection error:', e);
  }
};

function _gmbShowStatus(banner, form, req) {
  const statusMap = {
    pending:     { label: '⏳ Pending Review',    bg: '#fef9c3', border: '#fde047', text: '#78350f' },
    'in-progress':{ label: '🔄 In Progress',      bg: '#dbeafe', border: '#93c5fd', text: '#1e40af' },
    completed:   { label: '✅ Completed',         bg: '#dcfce7', border: '#86efac', text: '#14532d' },
  };
  const s = statusMap[req.status] || statusMap.pending;
  banner.style.cssText = `display:block;border-radius:12px;padding:16px 20px;margin-bottom:20px;background:${s.bg};border:1.5px solid ${s.border};color:${s.text};`;
  const reqDate = req.requestedAt?.toDate?.()?.toLocaleDateString() || '';
  const reviewBlock = req.reviewLink
    ? `<div style="margin-top:14px;padding:12px 14px;background:rgba(255,255,255,.65);border-radius:9px;border:1px solid rgba(0,0,0,.08);">
        <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">⭐ Your Google Review Link</div>
        <div style="font-size:0.82rem;margin-bottom:8px;">Share this link with customers to collect Google reviews.</div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
          <input readonly value="${escHTML(req.reviewLink)}" style="flex:1;min-width:200px;padding:6px 10px;border-radius:7px;border:1px solid rgba(0,0,0,.12);background:rgba(255,255,255,.8);font-size:0.78rem;" onclick="this.select()" />
          <button onclick="navigator.clipboard.writeText('${escHTML(req.reviewLink)}').then(()=>showToast('Copied!','success'))"
            style="padding:6px 12px;border-radius:7px;border:1.5px solid currentColor;background:transparent;color:inherit;font-size:0.78rem;font-weight:600;cursor:pointer;">📋 Copy</button>
          <a href="${escHTML(req.reviewLink)}" target="_blank"
            style="padding:6px 12px;border-radius:7px;border:1.5px solid currentColor;background:transparent;color:inherit;font-size:0.78rem;font-weight:600;text-decoration:none;">↗ Open</a>
        </div>
      </div>`
    : '';
  banner.innerHTML = `<div style="font-size:1rem;font-weight:800;margin-bottom:4px;">${s.label}</div>
    <div style="font-size:0.82rem;opacity:.85;">Your Google My Business setup request was submitted${reqDate?' on '+reqDate:''}. We will contact you soon.</div>
    ${reviewBlock}
    ${req.status !== 'completed' ? `<button onclick="window._cancelGmbRequest()" style="margin-top:12px;padding:6px 14px;border-radius:8px;border:1.5px solid currentColor;background:transparent;color:inherit;font-size:0.78rem;font-weight:600;cursor:pointer;">Cancel Request</button>` : ''}`;
  form.style.display = 'none';
}

window._submitGmbRequest = async function() {
  const btn = document.getElementById('gmbSubmitBtn');
  const bizName   = document.getElementById('gmbBizName')?.value.trim();
  const ownerName = document.getElementById('gmbOwnerName')?.value.trim();
  const phone     = document.getElementById('gmbPhone')?.value.trim();
  const email     = document.getElementById('gmbEmail')?.value.trim();
  const address   = document.getElementById('gmbAddress')?.value.trim();
  if (!bizName || !ownerName || !phone || !email || !address) {
    showToast('Please fill in all required fields.', 'error'); return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
  try {
    const ref = await addDoc(collection(db, 'gmb_requests'), {
      uid:         currentUser.uid,
      businessId:  bizId,
      bizName,
      ownerName,
      phone,
      email,
      address,
      category:  document.getElementById('gmbCategory')?.value.trim() || '',
      website:   document.getElementById('gmbWebsite')?.value.trim()  || '',
      notes:     document.getElementById('gmbNotes')?.value.trim()    || '',
      status:    'pending',
      requestedAt: serverTimestamp()
    });
    _gmbRequestId = ref.id;
    showToast('Request submitted! We will reach out soon.', 'success');
    window._loadGmbSection();
  } catch(e) {
    console.error('_submitGmbRequest error:', e);
    showToast('Could not submit request. Please try again.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🚀 Request Google My Business Setup'; }
  }
};

window._cancelGmbRequest = async function() {
  if (!_gmbRequestId) return;
  if (!confirm('Cancel your Google My Business setup request?')) return;
  try {
    await updateDoc(doc(db, 'gmb_requests', _gmbRequestId), { status: 'cancelled', updatedAt: serverTimestamp() });
    _gmbRequestId = null;
    const banner = document.getElementById('gmbStatusBanner');

    const form   = document.getElementById('gmbRequestForm');
    if (banner) banner.style.display = 'none';
    if (form)   form.style.display   = '';
    showToast('Request cancelled.', 'success');
  } catch(e) {
    showToast('Could not cancel request.', 'error');
  }
};

// ── Job Photo Documentation ───────────────────────────────────

let _allPhotos         = [];
let _filteredPhotos    = [];
let _lightboxIndex     = 0;
let _pendingFiles      = [];
let _photoSearchQ      = '';
let _photoDisplayCount = 24;

const PHOTO_LABEL_STYLE = {
  before:    { bg: '#fef3c7', color: '#92400e', dot: '🟠' },
  after:     { bg: '#dcfce7', color: '#14532d', dot: '🟢' },
  progress:  { bg: '#dbeafe', color: '#1e40af', dot: '🔵' },
  completed: { bg: '#f3e8ff', color: '#6b21a8', dot: '🟣' },
};

window._loadPhotosSection = async function() {
  const gallery = document.getElementById('photoGallery');
  if (!gallery || !currentUser) return;
  gallery.innerHTML = `<div class="empty-state"><p>⏳ Loading…</p></div>`;

  try {
    const snap = await getDocs(query(
      collection(db, 'job_photos'),
      where('uid', '==', currentUser.uid),
      orderBy('uploadedAt', 'desc'),
      limit(200)
    ));
    _allPhotos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _updatePhotoStats();
    _filterPhotos('all');
  } catch(e) {
    console.error('_loadPhotosSection:', e);
    gallery.innerHTML = `<div class="empty-state"><p>⚠️ Could not load photos.</p></div>`;
  }
};

function _updatePhotoStats() {
  const counts = { before: 0, after: 0, progress: 0, completed: 0 };
  _allPhotos.forEach(p => { if (counts[p.label] !== undefined) counts[p.label]++; });
  const s = id => document.getElementById(id);
  if (s('photoStatTotal'))    s('photoStatTotal').textContent    = _allPhotos.length;
  if (s('photoStatBefore'))   s('photoStatBefore').textContent   = counts.before;
  if (s('photoStatAfter'))    s('photoStatAfter').textContent    = counts.after;
  if (s('photoStatProgress')) s('photoStatProgress').textContent = counts.progress;
}

window._filterPhotos = function(filter) {
  document.querySelectorAll('[data-photo-filter]').forEach(b => {
    b.classList.toggle('active', b.dataset.photoFilter === filter);
  });
  _photoDisplayCount = 24;
  _applyPhotoFilters(filter);
};

window._searchPhotos = function(q) {
  _photoSearchQ = q.trim().toLowerCase();
  _photoDisplayCount = 24;
  _applyPhotoFilters(null);
};

function _applyPhotoFilters(labelOverride) {
  const active = document.querySelector('[data-photo-filter].active');
  const label = labelOverride !== null ? labelOverride : (active?.dataset.photoFilter || 'all');
  if (labelOverride !== null) {
    document.querySelectorAll('[data-photo-filter]').forEach(b => {
      b.classList.toggle('active', b.dataset.photoFilter === label);
    });
  }
  let photos = label === 'all' ? [..._allPhotos] : _allPhotos.filter(p => p.label === label);
  if (_photoSearchQ) {
    photos = photos.filter(p =>
      (p.jobRef       || '').toLowerCase().includes(_photoSearchQ) ||
      (p.customerName || '').toLowerCase().includes(_photoSearchQ) ||
      (p.caption      || '').toLowerCase().includes(_photoSearchQ)
    );
  }
  _filteredPhotos = photos;
  _renderPhotoGallery();
}

function _renderPhotoGallery() {
  const gallery = document.getElementById('photoGallery');
  if (!gallery) return;
  if (!_filteredPhotos.length) {
    gallery.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📷</div><p>No photos in this category yet.</p></div>`;
    return;
  }
  const visible = _filteredPhotos.slice(0, _photoDisplayCount);
  const hasMore = _filteredPhotos.length > _photoDisplayCount;
  const groups = {}, noRef = [];
  visible.forEach(p => {
    if (p.jobRef) { (groups[p.jobRef] = groups[p.jobRef] || []).push(p); }
    else noRef.push(p);
  });
  let html = '';
  Object.entries(groups).forEach(([jobRef, photos]) => {
    html += `<div style="margin-bottom:24px;">
      <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #f1f5f9;">
        📋 ${escHTML(jobRef)}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;">
        ${photos.map(p => _photoCard(p, _filteredPhotos.indexOf(p))).join('')}
      </div>
    </div>`;
  });
  if (noRef.length) {
    html += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;">
      ${noRef.map(p => _photoCard(p, _filteredPhotos.indexOf(p))).join('')}
    </div>`;
  }
  if (hasMore) {
    html += `<div style="text-align:center;margin-top:20px;">
      <button onclick="window._loadMorePhotos()" style="padding:10px 28px;background:#f1f5f9;border:1.5px solid #e2e8f0;border-radius:9px;font-size:0.88rem;font-weight:600;color:#374151;cursor:pointer;">
        Load More (${_filteredPhotos.length - _photoDisplayCount} remaining)
      </button>
    </div>`;
  }
  gallery.innerHTML = html;
}

window._loadMorePhotos = function() {
  _photoDisplayCount += 24;
  _renderPhotoGallery();
};

function _photoCard(p, idx) {
  const s = PHOTO_LABEL_STYLE[p.label] || PHOTO_LABEL_STYLE.before;
  const date = p.uploadedAt?.toDate?.()?.toLocaleDateString() || '';
  return `<div style="border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;background:#fff;cursor:pointer;transition:box-shadow .2s;" onclick="window._openLightbox(${idx})">
    <div style="position:relative;padding-top:75%;background:#f1f5f9;">
      <img src="${escHTML(p.thumbUrl || p.photoUrl)}" alt="${escHTML(p.caption||'')}"
        style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" loading="lazy" />
      <span style="position:absolute;top:8px;left:8px;padding:3px 9px;border-radius:20px;font-size:0.7rem;font-weight:700;background:${s.bg};color:${s.color};">${s.dot} ${p.label.charAt(0).toUpperCase()+p.label.slice(1)}</span>
    </div>
    <div style="padding:9px 12px;">
      ${p.caption ? `<div style="font-size:0.8rem;font-weight:600;color:#1e293b;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHTML(p.caption)}</div>` : ''}
      ${p.customerName ? `<div style="font-size:0.72rem;color:#64748b;margin-bottom:2px;">👤 ${escHTML(p.customerName)}</div>` : ''}
      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
        <span style="font-size:0.7rem;color:#94a3b8;">${date}</span>
        <button onclick="event.stopPropagation();window._deleteJobPhoto('${escHTML(p.id)}','${escHTML(p.storagePath||'')}')"
          style="background:none;border:none;cursor:pointer;font-size:0.85rem;color:#ef4444;padding:2px 4px;" title="Delete">🗑️</button>
      </div>
    </div>
  </div>`;
}

window._openLightbox = function(idx) {
  _lightboxIndex = idx;
  const lb = document.getElementById('photoLightbox');
  if (!lb) return;
  lb.style.display = 'flex';
  _lightboxShow();
};

function _lightboxShow() {
  const p = _filteredPhotos[_lightboxIndex];
  if (!p) return;
  document.getElementById('lightboxImg').src = p.photoUrl || p.thumbUrl;
  const s = PHOTO_LABEL_STYLE[p.label] || PHOTO_LABEL_STYLE.before;
  const cap = [s.dot + ' ' + (p.label.charAt(0).toUpperCase()+p.label.slice(1)), p.caption, p.jobRef ? '📋 ' + p.jobRef : ''].filter(Boolean).join('  ·  ');
  document.getElementById('lightboxCaption').textContent = cap;
  document.getElementById('lightboxPrev').style.display = _lightboxIndex > 0 ? '' : 'none';
  document.getElementById('lightboxNext').style.display = _lightboxIndex < _filteredPhotos.length - 1 ? '' : 'none';
}

window._lightboxNav = function(dir) {
  _lightboxIndex = Math.max(0, Math.min(_filteredPhotos.length - 1, _lightboxIndex + dir));
  _lightboxShow();
};

// Close lightbox on backdrop click
document.addEventListener('click', e => {
  const lb = document.getElementById('photoLightbox');
  if (lb && e.target === lb) lb.style.display = 'none';
});

window._togglePhotoUpload = function() {
  const form = document.getElementById('photoUploadForm');
  if (!form) return;
  const showing = form.style.display !== 'none';
  form.style.display = showing ? 'none' : '';
  if (!showing) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window._photoOnDrop = function(event) {
  event.preventDefault();
  const dz = document.getElementById('photoDropZone');
  if (dz) { dz.style.borderColor = '#c7d2fe'; dz.style.background = '#f8fafc'; }
  window._photoFilesSelected(event.dataTransfer.files);
};

window._photoFilesSelected = function(files) {
  _pendingFiles = Array.from(files);
  const previews = document.getElementById('photoFilePreviews');
  if (!previews) return;
  previews.innerHTML = _pendingFiles.map((f, i) => {
    const url = URL.createObjectURL(f);
    return `<div style="position:relative;width:72px;height:72px;border-radius:8px;overflow:hidden;border:2px solid #e2e8f0;">
      <img src="${url}" style="width:100%;height:100%;object-fit:cover;" />
      <span style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.55);color:#fff;font-size:0.6rem;padding:2px 4px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${f.name}</span>
    </div>`;
  }).join('');
};

window._uploadJobPhotos = async function() {
  if (!_pendingFiles.length) { showToast('Select at least one photo first.', 'error'); return; }
  const btn          = document.getElementById('photoUploadBtn');
  const progress     = document.getElementById('photoUploadProgress');
  const label        = document.getElementById('photoLabel')?.value        || 'before';
  const jobRef       = document.getElementById('photoJobRef')?.value.trim()       || '';
  const caption      = document.getElementById('photoCaption')?.value.trim()      || '';
  const customerName = document.getElementById('photoCustomer')?.value.trim()     || '';
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
  if (progress) { progress.style.display = ''; progress.innerHTML = ''; }
  let done = 0;
  for (const file of _pendingFiles) {
    try {
      const [thumbBlob, fullBlob] = await Promise.all([
        resizeLogo(file, 400, 300),
        resizeLogo(file, 1200, 900)
      ]);
      const fname     = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const thumbPath = `job_photos/${currentUser.uid}/thumbs/${fname}.webp`;
      const fullPath  = `job_photos/${currentUser.uid}/full/${fname}.webp`;
      const [thumbSnap, fullSnap] = await Promise.all([
        uploadBytes(storageRef(storage, thumbPath), thumbBlob, { contentType: 'image/webp' }),
        uploadBytes(storageRef(storage, fullPath),  fullBlob,  { contentType: 'image/webp' })
      ]);
      const [thumbUrl, photoUrl] = await Promise.all([
        getDownloadURL(thumbSnap.ref),
        getDownloadURL(fullSnap.ref)
      ]);
      await addDoc(collection(db, 'job_photos'), {
        uid: currentUser.uid, businessId: bizId,
        thumbUrl, photoUrl,
        storagePaths: [thumbPath, fullPath],
        label, jobRef, caption, customerName,
        uploadedAt: serverTimestamp()
      });
      done++;
      if (progress) progress.innerHTML = `<div style="font-size:0.82rem;color:#15803d;">✅ Uploaded ${done} of ${_pendingFiles.length}</div>`;
    } catch(e) {
      console.error('photo upload error:', e);
      if (progress) progress.innerHTML += `<div style="font-size:0.82rem;color:#dc2626;">⚠️ Failed: ${e.message}</div>`;
    }
  }
  if (btn) { btn.disabled = false; btn.textContent = '📤 Upload Photos'; }
  _pendingFiles = [];
  ['photoFileInput','photoJobRef','photoCaption','photoCustomer'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('photoFilePreviews').innerHTML = '';
  if (done > 0) {
    showToast(`${done} photo${done > 1 ? 's' : ''} uploaded!`, 'success');
    window._togglePhotoUpload();
    window._loadPhotosSection();
  }
};

window._deleteJobPhoto = async function(photoId, storagePath) {
  if (!confirm('Delete this photo permanently?')) return;
  try {
    const snap = _allPhotos.find(p => p.id === photoId);
    await deleteDoc(doc(db, 'job_photos', photoId));
    const paths = snap?.storagePaths || (storagePath ? [storagePath] : []);
    for (const path of paths) {
      try { await deleteObject(storageRef(storage, path)); } catch(_) {}
    }
    _allPhotos = _allPhotos.filter(p => p.id !== photoId);
    _filteredPhotos = _filteredPhotos.filter(p => p.id !== photoId);
    _updatePhotoStats();
    _renderPhotoGallery();
    showToast('Photo deleted.', 'success');
  } catch(e) {
    showToast('Could not delete photo.', 'error');
  }
};

window._sharePhotoPortfolio = function() {
  if (!bizId) { showToast('No business profile found.', 'error'); return; }
  const url = `${window.location.origin}/portfolio.html?uid=${currentUser.uid}`;
  navigator.clipboard.writeText(url).then(() => {
    showToast('Portfolio link copied! Share it with potential customers.', 'success');
  }).catch(() => {
    prompt('Copy your portfolio link:', url);
  });
};

// ── My Leads ─────────────────────────────────────────────────

let _myLeadsAll = [];
let _leadsUnsub = null;

function _initLeadsBadge() {
  if (!currentUser) return;
  if (_leadsUnsub) _leadsUnsub();
  _leadsUnsub = onSnapshot(
    query(collection(db, 'lead_requests'),
      where('assignedTo', '==', currentUser.uid),
      where('contractorSeen', '==', false)),
    snap => {
      const count = snap.size;
      const badge = document.getElementById('dashLeadsBadge');
      if (badge) { badge.textContent = count; badge.style.display = count > 0 ? '' : 'none'; }
    }
  );
}

window._loadMyLeads = async function() {
  const container = document.getElementById('myLeadsContainer');
  if (!container || !currentUser) return;
  container.innerHTML = '<div class="empty-state"><p>⏳ Loading…</p></div>';
  try {
    const snap = await getDocs(query(
      collection(db, 'lead_requests'),
      where('assignedTo', '==', currentUser.uid),
      orderBy('assignedAt', 'desc'),
      limit(100)
    ));
    _myLeadsAll = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Update stats
    const counts = { new: 0, contacted: 0, won: 0 };
    _myLeadsAll.forEach(l => { if (counts[l.contractorStatus] !== undefined) counts[l.contractorStatus]++; });
    const el = id => document.getElementById(id);
    if (el('myLeadStatNew'))       el('myLeadStatNew').textContent       = counts.new;
    if (el('myLeadStatContacted')) el('myLeadStatContacted').textContent = counts.contacted;
    if (el('myLeadStatWon'))       el('myLeadStatWon').textContent       = counts.won;

    // Mark all as seen
    _myLeadsAll.filter(l => !l.contractorSeen).forEach(l => {
      updateDoc(doc(db, 'lead_requests', l.id), { contractorSeen: true }).catch(() => {});
    });

    _renderMyLeads(_myLeadsAll);
  } catch(e) {
    console.error('_loadMyLeads:', e);
    container.innerHTML = '<div class="empty-state"><p>⚠️ Could not load leads.</p></div>';
  }
};

function _renderMyLeads(leads) {
  const container = document.getElementById('myLeadsContainer');
  if (!container) return;
  if (!leads.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🎯</div><p>No leads assigned yet. Admin will notify you when a matching job comes in.</p></div>';
    return;
  }

  const statusStyle = {
    new:       { bg: '#fef9c3', color: '#78350f', label: '🆕 New' },
    contacted: { bg: '#dbeafe', color: '#1e40af', label: '📞 Contacted' },
    won:       { bg: '#dcfce7', color: '#14532d', label: '🏆 Won' },
    lost:      { bg: '#fee2e2', color: '#7f1d1d', label: '❌ Lost' },
  };

  container.innerHTML = leads.map(l => {
    const s = statusStyle[l.contractorStatus || 'new'] || statusStyle.new;
    const date = l.assignedAt?.toDate?.()?.toLocaleDateString() || l.postedAt?.toDate?.()?.toLocaleDateString() || '';
    return `<div style="background:#fff;border-radius:14px;border:1px solid #e2e8f0;padding:20px;margin-bottom:14px;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
        <div>
          <div style="font-size:1rem;font-weight:800;color:#1e293b;margin-bottom:2px;">${escHTML(l.title||'—')}</div>
          <div style="font-size:0.78rem;color:#64748b;">${escHTML(l.category||'')} · 📍 ${escHTML(l.zipCode||'')} · ${date}</div>
        </div>
        <span style="padding:4px 12px;border-radius:20px;font-size:0.75rem;font-weight:700;background:${s.bg};color:${s.color};white-space:nowrap;">${s.label}</span>
      </div>

      ${l.description ? `<p style="font-size:0.83rem;color:#475569;line-height:1.6;margin-bottom:14px;border-left:3px solid #e2e8f0;padding-left:12px;">${escHTML(l.description)}</p>` : ''}

      ${l.photoUrls?.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;">${l.photoUrls.map(u=>`<a href="${escAttr(u)}" target="_blank"><img src="${escAttr(u)}" style="width:70px;height:70px;object-fit:cover;border-radius:7px;border:1.5px solid #e2e8f0;" /></a>`).join('')}</div>` : ''}

      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
        ${l.jobSize  ? `<span style="background:#f1f5f9;border-radius:8px;padding:4px 10px;font-size:0.75rem;font-weight:600;">📐 ${escHTML(l.jobSize)}</span>` : ''}
        ${l.timing   ? `<span style="background:#f1f5f9;border-radius:8px;padding:4px 10px;font-size:0.75rem;font-weight:600;">⏱️ ${escHTML(l.timing)}</span>` : ''}
      </div>

      <!-- Homeowner contact info -->
      <div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:10px;padding:14px 16px;margin-bottom:14px;">
        <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#15803d;margin-bottom:8px;">👤 Homeowner Contact</div>
        <div style="display:flex;flex-wrap:wrap;gap:12px;">
          <div><span style="font-size:0.75rem;color:#64748b;">Name</span><br/><strong style="font-size:0.88rem;">${escHTML(l.name||'—')}</strong></div>
          <div><span style="font-size:0.75rem;color:#64748b;">Phone</span><br/>
            <a href="tel:${escHTML(l.phone||'')}" style="font-size:0.88rem;font-weight:700;color:#15803d;text-decoration:none;">📞 ${escHTML(l.phone||'—')}</a>
          </div>
          ${l.email ? `<div><span style="font-size:0.75rem;color:#64748b;">Email</span><br/>
            <a href="mailto:${escHTML(l.email)}" style="font-size:0.88rem;font-weight:700;color:#15803d;text-decoration:none;">✉️ ${escHTML(l.email)}</a>
          </div>` : ''}
        </div>
      </div>

      <!-- Status update -->
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="font-size:0.75rem;font-weight:600;color:#64748b;">Update status:</span>
        ${['new','contacted','won','lost'].map(st => {
          const ss = statusStyle[st];
          return `<button onclick="window._updateMyLeadStatus('${escHTML(l.id)}','${st}')"
            style="padding:5px 12px;border-radius:20px;border:1.5px solid ${l.contractorStatus===st?ss.color:'#e2e8f0'};
                   background:${l.contractorStatus===st?ss.bg:'#fff'};color:${l.contractorStatus===st?ss.color:'#64748b'};
                   font-size:0.75rem;font-weight:700;cursor:pointer;">${ss.label}</button>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');
}

window._updateMyLeadStatus = async function(leadId, status) {
  try {
    await updateDoc(doc(db, 'lead_requests', leadId), { contractorStatus: status });
    const lead = _myLeadsAll.find(l => l.id === leadId);
    if (lead) { lead.contractorStatus = status; _renderMyLeads(_myLeadsAll); }
    showToast('Status updated', 'success');
  } catch(e) {
    showToast('Could not update status', 'error');
  }
};
