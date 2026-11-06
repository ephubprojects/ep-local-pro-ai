/* ============================================================
   EP Local Pro AI — admin.js
   Super-admin panel logic. Firebase module script.
   ============================================================ */

import { auth, db } from '/js/firebase.js';
import {
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  collection, doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, onSnapshot, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── Category data (inline — no fetch needed) ────────────────
const CATEGORIES = [
  { id: 'coffee_shop', name: 'Coffee Shop',       emoji: '☕' },
  { id: 'restaurant',  name: 'Restaurant',         emoji: '🍽️' },
  { id: 'plumber',     name: 'Plumber',            emoji: '🔧' },
  { id: 'electrician', name: 'Electrician',        emoji: '⚡' },
  { id: 'salon',       name: 'Salon & Spa',        emoji: '💇' },
  { id: 'roofer',      name: 'Roofing',            emoji: '🏠' },
  { id: 'painter',     name: 'Painter',            emoji: '🎨' },
  { id: 'carpenter',   name: 'Carpenter / Handyman', emoji: '🪚' },
  { id: 'retail',      name: 'Retail Store',       emoji: '🛍️' },
  { id: 'florist',     name: 'Florist',            emoji: '💐' }
];

// Category quick-lookup map
const CAT_MAP = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

// State
let currentUser = null;
let demosPendingDeleteId = null;
let allDemos = [];

// ── Slug helper ─────────────────────────────────────────────
function toSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── Relative time helper ─────────────────────────────────────
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

// ── Format date ──────────────────────────────────────────────
function fmtDate(ts) {
  if (!ts) return '—';
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Toast notification ───────────────────────────────────────
function showToast(msg, type = '') {
  const existing = document.querySelector('.admin-toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = `admin-toast${type ? ' ' + type : ''}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 350);
  }, 3000);
}

// ── Badge HTML ────────────────────────────────────────────────
function badgeHTML(status) {
  const map = {
    active:    'badge-active',
    demo:      'badge-demo',
    inactive:  'badge-inactive',
    trial:     'badge-trial',
    invited:   'badge-invited',
    suspended: 'badge-suspended'
  };
  const cls = map[status] || 'badge-inactive';
  return `<span class="badge ${cls}">${status}</span>`;
}

// ── Category badge HTML ───────────────────────────────────────
function catHTML(categoryId) {
  const cat = CAT_MAP[categoryId];
  if (!cat) return categoryId || '—';
  return `${cat.emoji} ${cat.name}`;
}

// ============================================================
// INIT — Auth gate
// ============================================================
const ADMIN_EMAIL = 'ezperfilsystem@gmail.com';

async function initAdmin() {
  // Wait until Firebase has fully restored the session before deciding to redirect.
  // onAuthStateChanged can fire with null while session is still loading from storage.
  await auth.authStateReady();
  const user = auth.currentUser;

  if (!user) {
    window.location.href = '/auth.html?from=admin_no_user';
    return;
  }

  // Primary check: Firestore role. Fallback: admin email.
  let isAdmin = false;
  try {
    const ownerSnap = await getDoc(doc(db, 'owners', user.uid));
    if (ownerSnap.exists()) {
      isAdmin = ownerSnap.data().role?.toLowerCase() === 'admin';
    }
  } catch (err) {
    console.warn('Firestore role check failed, using email fallback:', err.code);
  }
  if (!isAdmin) isAdmin = user.email === ADMIN_EMAIL;

  if (!isAdmin) {
    window.location.href = '/auth.html?from=admin_not_admin';
    return;
  }

  currentUser = user;
  onAdminReady(user);

  // Listen for future signouts
  onAuthStateChanged(auth, u => { if (!u) window.location.href = '/auth.html'; });
}

function onAdminReady(user) {
  // Populate sidebar user info
  const email = user.email || '';
  const initials = email.substring(0, 2).toUpperCase();
  const avatarEl = document.getElementById('userAvatar');
  const emailEl  = document.getElementById('userEmail');
  if (avatarEl) avatarEl.textContent = initials;
  if (emailEl)  emailEl.textContent  = email;

  // Populate settings email
  const settingEmail = document.getElementById('settingEmail');
  if (settingEmail) settingEmail.value = email;

  // Populate category select in demo modal
  populateCategorySelect();

  // Populate categories section
  renderCategoriesSection();

  // Start on dashboard
  showSection('dashboard');
  loadDashboardStats();
  loadRecentActivity();

  // Wire up nav
  document.querySelectorAll('[data-nav]').forEach(link => {
    link.addEventListener('click', () => {
      const name = link.dataset.nav;
      showSection(name);
      closeSidebar();
    });
  });

  // Create Demo buttons
  document.getElementById('topCreateDemoBtn')?.addEventListener('click', openCreateDemoModal);
  document.getElementById('dashCreateDemoBtn')?.addEventListener('click', openCreateDemoModal);
  document.getElementById('demosCreateBtn')?.addEventListener('click', openCreateDemoModal);

  // View all businesses quick action
  document.getElementById('dashViewBizBtn')?.addEventListener('click', () => showSection('businesses'));

  // Demo search / filter
  document.getElementById('demoSearch')?.addEventListener('input', filterDemos);
  document.getElementById('demoCatFilter')?.addEventListener('change', filterDemos);

  // Modal close buttons
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });

  // Click outside modal to close
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  // Demo modal: auto-slug from name
  document.getElementById('dmBizName')?.addEventListener('input', e => {
    const slugInput = document.getElementById('dmSlug');
    const preview   = document.getElementById('dmSlugPreview');
    if (slugInput && !slugInput.dataset.edited) {
      const slug = toSlug(e.target.value);
      slugInput.value = slug;
      if (preview) preview.textContent = slug || '…';
    }
  });

  document.getElementById('dmSlug')?.addEventListener('input', e => {
    e.target.dataset.edited = 'true';
    const preview = document.getElementById('dmSlugPreview');
    if (preview) preview.textContent = e.target.value || '…';
  });

  // Add menu item button
  document.getElementById('addMenuItemBtn')?.addEventListener('click', () => addMenuItemRow());

  // Save demo button
  document.getElementById('saveDemoBtn')?.addEventListener('click', saveDemoModal);

  // Settings save
  document.getElementById('saveSettingsBtn')?.addEventListener('click', saveSettings);

  // Logout
  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    await signOut(auth);
    window.location.href = '/auth.html';
  });

  // Copy invite link
  document.getElementById('copyInviteBtn')?.addEventListener('click', () => {
    const input = document.getElementById('inviteLinkInput');
    if (!input) return;
    navigator.clipboard.writeText(input.value).then(() => {
      const btn = document.getElementById('copyInviteBtn');
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 2000);
    });
  });

  // Sidebar toggle (mobile)
  document.getElementById('sidebarToggle')?.addEventListener('click', toggleSidebar);
  document.getElementById('sidebarBackdrop')?.addEventListener('click', closeSidebar);
}

// ============================================================
// SECTION NAVIGATION
// ============================================================
function showSection(name) {
  // Update page title
  const titles = {
    dashboard:  'Dashboard',
    demos:      'Demo Management',
    businesses: 'Business Accounts',
    categories: 'Categories',
    settings:   'Settings'
  };
  const titleEl = document.getElementById('pageTitle');
  if (titleEl) titleEl.textContent = titles[name] || name;

  // Show/hide sections
  document.querySelectorAll('[data-section]').forEach(el => {
    el.classList.toggle('hidden', el.dataset.section !== name);
  });

  // Update sidebar active state
  document.querySelectorAll('[data-nav]').forEach(link => {
    link.classList.toggle('active', link.dataset.nav === name);
  });

  // Load data for section on first visit
  if (name === 'demos')      loadDemos();
  if (name === 'businesses') loadBusinesses();
}

// ============================================================
// MOBILE SIDEBAR
// ============================================================
function toggleSidebar() {
  const sidebar  = document.getElementById('adminSidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  sidebar?.classList.toggle('open');
  backdrop?.classList.toggle('open');
}

function closeSidebar() {
  document.getElementById('adminSidebar')?.classList.remove('open');
  document.getElementById('sidebarBackdrop')?.classList.remove('open');
}

// ============================================================
// MODAL HELPERS
// ============================================================
function openModal(id) {
  document.getElementById(id)?.classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id)?.classList.add('hidden');
}

// ============================================================
// DASHBOARD STATS
// ============================================================
async function loadDashboardStats() {
  try {
    const [demosSnap, bizSnap, ordersSnap] = await Promise.all([
      getDocs(collection(db, 'demos')),
      getDocs(collection(db, 'businesses')),
      getDocs(collection(db, 'orders'))
    ]);

    const demoCount  = demosSnap.size;
    const bizCount   = bizSnap.docs.filter(d => d.data().status === 'active').length;
    const orderCount = ordersSnap.size;

    // Revenue: sum order totals for current month
    const now      = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    let revenue = 0;
    ordersSnap.docs.forEach(d => {
      const data = d.data();
      const created = data.createdAt?.toDate?.() || null;
      if (created && created >= monthStart) {
        revenue += (data.total || 0);
      }
    });

    setStatCard('statDemos',   demoCount,   `${demoCount} total demo sites`);
    setStatCard('statBiz',     bizCount,    `${bizCount} active accounts`);
    setStatCard('statOrders',  orderCount,  `${orderCount} total orders`);
    setStatCard('statRevenue', `$${revenue.toFixed(2)}`, 'month to date');
  } catch (err) {
    console.error('loadDashboardStats error:', err);
  }
}

function setStatCard(valueId, value, trend) {
  const valEl   = document.getElementById(valueId);
  const trendEl = document.getElementById(valueId + 'Trend');
  if (valEl)   valEl.textContent   = value;
  if (trendEl) trendEl.textContent = trend;
}

// ============================================================
// RECENT ACTIVITY
// ============================================================
async function loadRecentActivity() {
  const feedEl = document.getElementById('activityFeed');
  if (!feedEl) return;

  try {
    const q = query(collection(db, 'orders'), orderBy('createdAt', 'desc'), limit(10));
    const snap = await getDocs(q);

    if (snap.empty) {
      feedEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📋</div>
          <p>No activity yet.</p>
        </div>`;
      return;
    }

    feedEl.innerHTML = snap.docs.map(d => {
      const data = d.data();
      const time = relativeTime(data.createdAt);
      const biz  = data.bizName || data.businessId || 'Unknown Business';
      const total = data.total != null ? ` — $${Number(data.total).toFixed(2)}` : '';
      return `
        <div class="activity-item">
          <div class="activity-dot"></div>
          <div class="activity-text">New order at <strong>${escHTML(biz)}</strong>${escHTML(total)}</div>
          <div class="activity-time">${time}</div>
        </div>`;
    }).join('');
  } catch (err) {
    console.error('loadRecentActivity error:', err);
    feedEl.innerHTML = `<p class="text-muted text-sm">Could not load activity.</p>`;
  }
}

// ============================================================
// DEMOS
// ============================================================
async function loadDemos() {
  const tbody = document.getElementById('demosTableBody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="empty-state-icon">⏳</div><p>Loading…</p></div></td></tr>`;

  try {
    const snap = await getDocs(query(collection(db, 'demos'), orderBy('createdAt', 'desc')));
    allDemos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderDemosTable(allDemos);
  } catch (err) {
    console.error('loadDemos error:', err);
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>Error loading demos.</p></div></td></tr>`;
  }
}

function filterDemos() {
  const search = (document.getElementById('demoSearch')?.value || '').toLowerCase();
  const cat    = document.getElementById('demoCatFilter')?.value || '';

  const filtered = allDemos.filter(d => {
    const matchSearch = !search ||
      (d.bizName || '').toLowerCase().includes(search) ||
      (d.slug || '').toLowerCase().includes(search);
    const matchCat = !cat || d.categoryId === cat;
    return matchSearch && matchCat;
  });

  renderDemosTable(filtered);
}

function renderDemosTable(demos) {
  const tbody = document.getElementById('demosTableBody');
  if (!tbody) return;

  if (!demos.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="empty-state-icon">🔍</div><p>No demos found.</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = demos.map(demo => renderDemoRow(demo, demo.id)).join('');
}

function renderDemoRow(demo, id) {
  const cat    = CAT_MAP[demo.categoryId] || {};
  const catStr = cat.emoji ? `${cat.emoji} ${cat.name}` : (demo.categoryId || '—');
  const slug   = demo.slug || '—';
  const demoUrl = slug !== '—' ? `https://eplocalproai.com/demo/${slug}` : '—';
  const ref    = demo.referrerUsername || '—';
  const created = fmtDate(demo.createdAt);

  return `
    <tr>
      <td class="cell-name">${escHTML(demo.bizName || '—')}</td>
      <td>${escHTML(catStr)}</td>
      <td>${badgeHTML(demo.status || 'demo')}</td>
      <td class="cell-mono">
        ${slug !== '—'
          ? `<a href="${escHTML(demoUrl)}" target="_blank" style="color:var(--indigo);text-decoration:none;">${escHTML(slug)}</a>`
          : '—'}
      </td>
      <td>${escHTML(ref)}</td>
      <td>${escHTML(created)}</td>
      <td>
        <div class="row-actions">
          <button class="btn-action" onclick="window._adminEditDemo('${id}')">Edit</button>
          <button class="btn-action primary" onclick="window._adminConvertDemo('${id}')">Convert</button>
          <button class="btn-action danger" onclick="window._adminDeleteDemo('${id}')">Delete</button>
        </div>
      </td>
    </tr>`;
}

// ============================================================
// CREATE / EDIT DEMO MODAL
// ============================================================
function populateCategorySelect() {
  const select = document.getElementById('dmCategory');
  if (!select) return;
  select.innerHTML = '<option value="">Select category…</option>' +
    CATEGORIES.map(c => `<option value="${c.id}">${c.emoji} ${c.name}</option>`).join('');
}

function openCreateDemoModal() {
  clearDemoModal();
  document.getElementById('demoModalTitle').textContent = 'Create Demo';
  document.getElementById('demoModalId').value = '';
  openModal('demoModal');
}

async function openEditDemoModal(demoId) {
  clearDemoModal();
  document.getElementById('demoModalTitle').textContent = 'Edit Demo';
  document.getElementById('demoModalId').value = demoId;

  try {
    const snap = await getDoc(doc(db, 'demos', demoId));
    if (!snap.exists()) { showToast('Demo not found', 'error'); return; }
    const data = snap.data();

    document.getElementById('dmBizName').value     = data.bizName || '';
    document.getElementById('dmCategory').value    = data.categoryId || '';
    const slugEl = document.getElementById('dmSlug');
    slugEl.value = data.slug || '';
    slugEl.dataset.edited = 'true';
    const preview = document.getElementById('dmSlugPreview');
    if (preview) preview.textContent = data.slug || '…';
    document.getElementById('dmReferrer').value    = data.referrerUsername || '';
    document.getElementById('dmGreeting').value    = data.greeting || '';

    // Language
    const lang = data.lang || 'en';
    document.querySelectorAll('input[name="dmLang"]').forEach(r => {
      r.checked = r.value === lang;
    });

    // Menu items
    const menuList = document.getElementById('menuItemsList');
    menuList.innerHTML = '';
    (data.menuItems || []).forEach(item => addMenuItemRow(item));
  } catch (err) {
    console.error('openEditDemoModal error:', err);
    showToast('Error loading demo', 'error');
  }

  openModal('demoModal');
}

function clearDemoModal() {
  document.getElementById('dmBizName').value  = '';
  document.getElementById('dmCategory').value = '';
  const slugEl = document.getElementById('dmSlug');
  slugEl.value = '';
  delete slugEl.dataset.edited;
  const preview = document.getElementById('dmSlugPreview');
  if (preview) preview.textContent = '…';
  document.getElementById('dmReferrer').value  = '';
  document.getElementById('dmGreeting').value  = '';
  document.querySelectorAll('input[name="dmLang"]').forEach(r => {
    r.checked = r.value === 'en';
  });
  const menuList = document.getElementById('menuItemsList');
  if (menuList) menuList.innerHTML = '';
}

async function saveDemoModal() {
  const bizName = document.getElementById('dmBizName')?.value.trim();
  if (!bizName) { showToast('Business name is required', 'error'); return; }

  const categoryId = document.getElementById('dmCategory')?.value;
  if (!categoryId) { showToast('Please select a category', 'error'); return; }

  const slug = document.getElementById('dmSlug')?.value.trim() || toSlug(bizName);
  const lang = document.querySelector('input[name="dmLang"]:checked')?.value || 'en';
  const referrerUsername = document.getElementById('dmReferrer')?.value.trim() || '';
  const greeting = document.getElementById('dmGreeting')?.value.trim() || '';

  // Collect menu items
  const menuItems = [];
  document.querySelectorAll('#menuItemsList .menu-item-row').forEach(row => {
    const inputs = row.querySelectorAll('input');
    const name  = inputs[0]?.value.trim();
    const price = parseFloat(inputs[1]?.value) || 0;
    const emoji = inputs[2]?.value.trim() || '';
    const desc  = inputs[3]?.value.trim() || '';
    if (name) menuItems.push({ name, price, emoji, desc });
  });

  const demoId = document.getElementById('demoModalId')?.value;

  const payload = {
    bizName,
    categoryId,
    slug,
    lang,
    referrerUsername,
    greeting,
    menuItems,
    updatedAt: serverTimestamp()
  };

  const saveBtn = document.getElementById('saveDemoBtn');
  if (saveBtn) { saveBtn.textContent = 'Saving…'; saveBtn.disabled = true; }

  try {
    if (demoId) {
      // Update existing
      await updateDoc(doc(db, 'demos', demoId), payload);
      showToast('Demo updated', 'success');
    } else {
      // Create new
      await addDoc(collection(db, 'demos'), {
        ...payload,
        status: 'demo',
        createdAt: serverTimestamp()
      });
      showToast('Demo created', 'success');
    }
    closeModal('demoModal');
    loadDemos();
    loadDashboardStats();
  } catch (err) {
    console.error('saveDemoModal error:', err);
    showToast('Error saving demo: ' + (err.message || err), 'error');
  } finally {
    if (saveBtn) { saveBtn.textContent = 'Save Demo'; saveBtn.disabled = false; }
  }
}

// ── Menu item row ─────────────────────────────────────────────
function addMenuItemRow(item = {}) {
  const list = document.getElementById('menuItemsList');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'menu-item-row';
  row.innerHTML = `
    <input type="text"   class="item-name"  placeholder="Name"   value="${escAttr(item.name  || '')}" />
    <input type="number" class="item-price" placeholder="Price"  value="${escAttr(String(item.price != null ? item.price : ''))}" step="0.01" min="0" />
    <input type="text"   class="item-emoji" placeholder="Emoji"  value="${escAttr(item.emoji || '')}" />
    <input type="text"   class="item-desc"  placeholder="Description" value="${escAttr(item.desc  || '')}" />
    <button class="btn-remove-item" type="button" title="Remove">✕</button>
  `;
  row.querySelector('.btn-remove-item').addEventListener('click', () => row.remove());
  list.appendChild(row);
}

// ============================================================
// DELETE DEMO
// ============================================================
function deleteDemoConfirm(demoId) {
  demosPendingDeleteId = demoId;
  openModal('confirmModal');

  const confirmBtn = document.getElementById('confirmDeleteBtn');
  // Remove old listener, add fresh one
  const newBtn = confirmBtn.cloneNode(true);
  confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);
  newBtn.addEventListener('click', async () => {
    if (!demosPendingDeleteId) return;
    try {
      await deleteDoc(doc(db, 'demos', demosPendingDeleteId));
      showToast('Demo deleted', 'success');
      closeModal('confirmModal');
      loadDemos();
      loadDashboardStats();
    } catch (err) {
      console.error('deleteDemoConfirm error:', err);
      showToast('Error deleting demo', 'error');
    }
    demosPendingDeleteId = null;
  });
}

// ============================================================
// CONVERT DEMO → ACCOUNT (Invite)
// ============================================================
async function convertDemoToAccount(demoId) {
  try {
    const snap = await getDoc(doc(db, 'demos', demoId));
    if (!snap.exists()) { showToast('Demo not found', 'error'); return; }
    const demo = snap.data();

    const ref  = demo.referrerUsername ? `ref=${encodeURIComponent(demo.referrerUsername)}&` : '';
    const link = `https://eplocalproai.com/auth.html?${ref}demo=${demoId}`;

    // Show invite modal
    const linkInput = document.getElementById('inviteLinkInput');
    if (linkInput) linkInput.value = link;
    openModal('inviteModal');

    // Update demo status to invited
    await updateDoc(doc(db, 'demos', demoId), { status: 'invited', updatedAt: serverTimestamp() });
    loadDemos();
    loadDashboardStats();
  } catch (err) {
    console.error('convertDemoToAccount error:', err);
    showToast('Error generating invite link', 'error');
  }
}

// ============================================================
// BUSINESSES
// ============================================================
async function loadBusinesses() {
  const tbody = document.getElementById('bizTableBody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="empty-state-icon">⏳</div><p>Loading…</p></div></td></tr>`;

  try {
    const snap = await getDocs(query(collection(db, 'businesses'), orderBy('createdAt', 'desc')));

    if (snap.empty) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="empty-state-icon">🏢</div><p>No business accounts yet.</p></div></td></tr>`;
      return;
    }

    const rows = await Promise.all(snap.docs.map(async d => {
      const biz  = { id: d.id, ...d.data() };
      const cat  = CAT_MAP[biz.categoryId] || {};
      const plan = biz.plan || 'trial';

      // Count orders this month
      let monthOrders = 0;
      try {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const oSnap = await getDocs(query(
          collection(db, 'orders'),
          where('businessId', '==', biz.id),
          where('createdAt', '>=', monthStart)
        ));
        monthOrders = oSnap.size;
      } catch (_) { /* orders may not exist yet */ }

      const detailRowId = `biz-detail-${biz.id}`;

      return `
        <tr class="biz-main-row" data-bizid="${biz.id}" onclick="window._adminToggleBizDetail('${biz.id}')">
          <td class="cell-name">${escHTML(biz.bizName || biz.name || '—')}</td>
          <td>${escHTML(biz.ownerEmail || '—')}</td>
          <td>${escHTML(cat.emoji || '')} ${escHTML(cat.name || biz.categoryId || '—')}</td>
          <td>${badgeHTML(plan)}</td>
          <td>${escHTML(fmtDate(biz.createdAt))}</td>
          <td>${monthOrders}</td>
          <td>
            <div class="row-actions">
              <button class="btn-action" onclick="event.stopPropagation();window._adminViewBiz('${biz.id}')">View</button>
              <button class="btn-action danger" onclick="event.stopPropagation();window._adminSuspendBiz('${biz.id}', '${escAttr(biz.bizName || '')}')">Suspend</button>
            </div>
          </td>
        </tr>
        <tr id="${detailRowId}" class="biz-detail-row hidden">
          <td colspan="7">
            <div class="biz-detail-inner">
              <div>
                <div class="text-xs text-muted fw-600" style="margin-bottom:4px;">Business ID</div>
                <div class="cell-mono text-sm">${escHTML(biz.id)}</div>
              </div>
              <div>
                <div class="text-xs text-muted fw-600" style="margin-bottom:4px;">Owner Email</div>
                <div class="text-sm">${escHTML(biz.ownerEmail || '—')}</div>
              </div>
              <div>
                <div class="text-xs text-muted fw-600" style="margin-bottom:4px;">Orders This Month</div>
                <div class="text-sm">${monthOrders}</div>
              </div>
              <div>
                <div class="text-xs text-muted fw-600" style="margin-bottom:4px;">Status</div>
                <div>${badgeHTML(biz.status || 'active')}</div>
              </div>
            </div>
          </td>
        </tr>`;
    }));

    tbody.innerHTML = rows.join('');
  } catch (err) {
    console.error('loadBusinesses error:', err);
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>Error loading businesses.</p></div></td></tr>`;
  }
}

// Toggle business detail row
function toggleBizDetail(bizId) {
  const row = document.getElementById(`biz-detail-${bizId}`);
  row?.classList.toggle('hidden');
}

// View business (placeholder — extend as needed)
function viewBiz(bizId) {
  showToast(`Business ID: ${bizId}`, '');
}

// Suspend business
async function suspendBiz(bizId, name) {
  if (!confirm(`Suspend "${name}"? Their demo will be marked inactive.`)) return;
  try {
    await updateDoc(doc(db, 'businesses', bizId), { status: 'suspended', updatedAt: serverTimestamp() });
    showToast('Business suspended', 'success');
    loadBusinesses();
  } catch (err) {
    console.error('suspendBiz error:', err);
    showToast('Error suspending business', 'error');
  }
}

// ============================================================
// CATEGORIES SECTION
// ============================================================
function renderCategoriesSection() {
  const grid = document.getElementById('categoryGrid');
  if (!grid) return;

  // Category colors from categories.json (hardcoded here to match)
  const colors = {
    coffee_shop: '#6f4e37',
    restaurant:  '#dc2626',
    plumber:     '#2563eb',
    electrician: '#d97706',
    salon:       '#db2777',
    roofer:      '#7c3aed',
    painter:     '#059669',
    carpenter:   '#92400e',
    retail:      '#0891b2',
    florist:     '#be185d'
  };

  const orderTypes = {
    coffee_shop: ['pickup', 'delivery', 'dine-in'],
    restaurant:  ['dine-in', 'pickup', 'delivery'],
    plumber:     ['appointment', 'estimate'],
    electrician: ['appointment', 'estimate'],
    salon:       ['appointment'],
    roofer:      ['appointment', 'estimate'],
    painter:     ['appointment', 'estimate'],
    carpenter:   ['appointment', 'estimate'],
    retail:      ['pickup', 'delivery'],
    florist:     ['pickup', 'delivery']
  };

  const docTypes = {
    coffee_shop: ['invoice', 'receipt'],
    restaurant:  ['invoice', 'receipt'],
    plumber:     ['estimate', 'invoice', 'contract', 'receipt'],
    electrician: ['estimate', 'invoice', 'contract', 'receipt'],
    salon:       ['invoice', 'receipt'],
    roofer:      ['estimate', 'invoice', 'contract', 'receipt'],
    painter:     ['estimate', 'invoice', 'contract', 'receipt'],
    carpenter:   ['estimate', 'invoice', 'contract', 'receipt'],
    retail:      ['invoice', 'receipt'],
    florist:     ['invoice', 'receipt']
  };

  grid.innerHTML = CATEGORIES.map(c => `
    <div class="category-card">
      <div class="category-card-top">
        <span class="category-emoji">${c.emoji}</span>
        <div>
          <div class="category-name">${escHTML(c.name)}</div>
          <span class="category-color-dot" style="background:${colors[c.id] || '#888'};"></span>
        </div>
      </div>
      <div class="category-meta">
        <strong>Orders:</strong> ${(orderTypes[c.id] || []).join(', ')}<br/>
        <strong>Docs:</strong> ${(docTypes[c.id] || []).join(', ')}
      </div>
    </div>
  `).join('');
}

// ============================================================
// SETTINGS
// ============================================================
async function saveSettings() {
  const name          = document.getElementById('settingName')?.value.trim() || '';
  const platformName  = document.getElementById('settingPlatformName')?.value.trim() || '';
  const supportEmail  = document.getElementById('settingSupportEmail')?.value.trim() || '';

  try {
    if (currentUser) {
      await updateDoc(doc(db, 'owners', currentUser.uid), {
        displayName:    name,
        platformName,
        supportEmail,
        updatedAt: serverTimestamp()
      });
    }
    showToast('Settings saved', 'success');
  } catch (err) {
    console.error('saveSettings error:', err);
    showToast('Error saving settings', 'error');
  }
}

// ============================================================
// ESCAPE HELPERS
// ============================================================
function escHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================================
// GLOBAL BINDINGS (called from inline onclick in table rows)
// ============================================================
window._adminEditDemo      = id => openEditDemoModal(id);
window._adminDeleteDemo    = id => deleteDemoConfirm(id);
window._adminConvertDemo   = id => convertDemoToAccount(id);
window._adminToggleBizDetail = id => toggleBizDetail(id);
window._adminViewBiz       = id => viewBiz(id);
window._adminSuspendBiz    = (id, name) => suspendBiz(id, name);

// ── Boot ─────────────────────────────────────────────────────
initAdmin();
