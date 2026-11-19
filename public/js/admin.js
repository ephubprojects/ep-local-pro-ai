/* ============================================================
   EP Local Pro AI — admin.js
   Super-admin panel logic. Firebase module script.
   ============================================================ */

import { auth, db, storage } from '/js/firebase.js';
import {
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  ref as storageRef, uploadBytes, getDownloadURL
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';
import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc,
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
let customCategories = [];
let catIconDataUrl = '';

// Demo modal — widget / bg state
let dmWidgetTheme  = 'cyan';
let dmWidgetImgUrl = '';
let dmBgImageUrl   = '';

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
    live:      'badge-live',
    paused:    'badge-paused',
    inactive:  'badge-inactive',
    trial:     'badge-trial',
    invited:   'badge-invited',
    suspended: 'badge-suspended'
  };
  const cls = map[status] || 'badge-inactive';
  return `<span class="badge ${cls}">${status}</span>`;
}

// ── All categories (built-in + custom) ───────────────────────
function getAllCategories() {
  return [...CATEGORIES, ...customCategories];
}

// ── Category badge HTML ───────────────────────────────────────
function catHTML(categoryId) {
  const cat = CAT_MAP[categoryId] || customCategories.find(c => c.id === categoryId);
  if (!cat) return categoryId || '—';
  if (cat.emoji?.startsWith('data:image')) {
    return `<img src="${cat.emoji}" style="width:18px;height:18px;vertical-align:middle;object-fit:contain;border-radius:3px;"> ${escHTML(cat.name)}`;
  }
  return `${cat.emoji} ${escHTML(cat.name)}`;
}

// ── Resize uploaded category icon ─────────────────────────────
function resizeCatIcon(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = e => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 64;
        const ctx = canvas.getContext('2d');
        const size = Math.min(img.width, img.height);
        const sx = (img.width  - size) / 2;
        const sy = (img.height - size) / 2;
        ctx.drawImage(img, sx, sy, size, size, 0, 0, 64, 64);
        resolve(canvas.toDataURL('image/png', 0.9));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function setCatIcon(dataUrl) {
  catIconDataUrl = dataUrl || '';
  const imgEl = document.getElementById('catIconImg');
  if (!imgEl) return;
  if (dataUrl) {
    imgEl.src = dataUrl;
    imgEl.classList.add('has-icon');
  } else {
    imgEl.src = '';
    imgEl.classList.remove('has-icon');
  }
}

// ============================================================
// INIT — Auth gate
// ============================================================
const ADMIN_EMAIL = 'ezperfilsystem@gmail.com';

async function initAdmin() {
  // One-shot: resolve on first onAuthStateChanged fire, then unsubscribe.
  const user = await new Promise(resolve => {
    const unsub = onAuthStateChanged(auth, u => { unsub(); resolve(u); });
  });

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

async function onAdminReady(user) {
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

  // Load admin profile fields + populate My Links
  try {
    const ownerSnap = await getDoc(doc(db, 'owners', user.uid));
    if (ownerSnap.exists()) {
      const od = ownerSnap.data();
      const sfn = document.getElementById('settingFirstName');
      const sln = document.getElementById('settingLastName');
      const sph = document.getElementById('settingPhone');
      const sun = document.getElementById('settingUsername');
      if (sfn) sfn.value = od.firstName || '';
      if (sln) sln.value = od.lastName  || '';
      if (sph) sph.value = od.phone     || '';
      if (sun) sun.value = od.username  || '';

      const username = od.username || '';
      if (username) {
        const refUrl  = `https://ep-local-pro-ai.netlify.app/auth.html?ref=${username}`;
        const refDisp = document.getElementById('adminRefLinkDisplay');
        const refBtn  = document.getElementById('adminCopyRefBtn');
        if (refDisp) refDisp.textContent = refUrl;
        if (refBtn)  refBtn.onclick = () => copyToClipboard(refUrl, refBtn);

        // Look up demo link: first demo where referrerUsername matches
        try {
          const demoQ = query(
            collection(db, 'demos'),
            where('referrerUsername', '==', username),
            limit(1)
          );
          const demoSnap = await getDocs(demoQ);
          const demoDisp = document.getElementById('adminDemoLinkDisplay');
          const demoBtn  = document.getElementById('adminCopyDemoBtn');
          if (!demoSnap.empty) {
            const slug = demoSnap.docs[0].data().slug || '';
            const demoUrl = `https://ep-local-pro-ai.netlify.app/demo/${slug}?ref=${username}`;
            if (demoDisp) demoDisp.textContent = demoUrl;
            if (demoBtn)  demoBtn.onclick = () => copyToClipboard(demoUrl, demoBtn);
          } else {
            if (demoDisp) demoDisp.textContent = 'No demo assigned yet';
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

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
      if (name === 'demos')          loadDemos();
      if (name === 'businesses')     loadBusinesses();
      if (name === 'users')          loadUsers();
      if (name === 'localBusiness')  loadLocalBiz();
      if (name === 'categories')     renderCategoriesSection();
      if (name === 'documents')      loadAdminDocuments();
      if (name === 'calendar')       { loadCalendarConfig(); window._adminLoadBookings(); }
    });
  });

  // Calendar: copy booking link
  document.getElementById('calCopyLinkBtn')?.addEventListener('click', () => {
    const urlEl = document.getElementById('calBookingLink');
    if (!urlEl) return;
    navigator.clipboard.writeText(urlEl.textContent.trim())
      .then(() => { const b = document.getElementById('calCopyLinkBtn'); if(b){ const t=b.textContent; b.textContent='Copied!'; setTimeout(()=>b.textContent=t,1500); } })
      .catch(() => {});
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

  // Scan & Extract button
  document.getElementById('scanBizBtn')?.addEventListener('click', scanAndExtract);

  // Add menu item button
  document.getElementById('addMenuItemBtn')?.addEventListener('click', () => addMenuItemRow());

  // Save demo button
  document.getElementById('saveDemoBtn')?.addEventListener('click', saveDemoModal);

  // Add category button
  document.getElementById('addCategoryBtn')?.addEventListener('click', openAddCategoryModal);

  // Category icon file upload
  document.getElementById('catIconFile')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { showToast('Image must be under 2MB', 'error'); return; }
    try {
      const dataUrl = await resizeCatIcon(file);
      setCatIcon(dataUrl);
    } catch { showToast('Failed to load image', 'error'); }
    e.target.value = '';
  });

  // Clear icon button
  document.getElementById('clearCatIconBtn')?.addEventListener('click', () => setCatIcon(''));

  // Save category button
  document.getElementById('saveCatBtn')?.addEventListener('click', saveCategoryModal);

  // Color picker ↔ hex input sync
  document.getElementById('catColorPicker')?.addEventListener('input', e => {
    const hex = document.getElementById('catColorHex');
    if (hex) hex.value = e.target.value;
  });
  document.getElementById('catColorHex')?.addEventListener('input', e => {
    const val = e.target.value;
    if (/^#[0-9a-fA-F]{6}$/.test(val)) {
      const picker = document.getElementById('catColorPicker');
      if (picker) picker.value = val;
    }
  });

  // Profile save
  document.getElementById('saveProfileBtn')?.addEventListener('click', saveProfile);

  // Cancel my own account
  document.getElementById('cancelMyAccountBtn')?.addEventListener('click', cancelMyAccount);

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
    dashboard:     'Dashboard',
    demos:         'Demo Management',
    businesses:    'Business Accounts',
    users:         'Registered Users',
    localBusiness: 'Local Business Accounts',
    categories:    'Categories',
    calendar:      'Calendar',
    profile:       'My Profile',
    settings:      'Settings'
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
  if (name === 'demos')      { loadDemos(); window._adminLoadDemoRequests(); }
  if (name === 'businesses') loadBusinesses();
  if (name === 'settings')   loadSettings();
  if (name === 'calendar')   { loadCalendarConfig(); window._adminLoadBookings(); }
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
  const demoUrl = slug !== '—' ? `https://ep-local-pro-ai.netlify.app/ai/${slug}` : '—';
  const ref    = demo.referrerUsername || '—';
  const created = fmtDate(demo.createdAt);
  const bizEncoded = encodeURIComponent(demo.bizName || '');
  const isPaused = demo.status === 'paused';
  const isLive   = demo.status === 'live';

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
          <button class="btn-action ${isLive ? 'live-on' : 'live-off'}"
            onclick="window._adminToggleDemoLive('${id}','${demo.status || 'demo'}')"
            title="${isLive ? 'Click to set back to Demo mode' : 'Click to go Live'}"
            ${isPaused ? 'disabled' : ''}>
            ${isLive ? '🟢 Live' : '⚪ Demo'}
          </button>
          <button class="btn-action ${isPaused ? 'paused-on' : 'paused-off'}"
            onclick="window._adminToggleDemoPaused('${id}','${demo.status || 'demo'}','${escAttr(demo.prevStatus || '')}')"
            title="${isPaused ? 'Click to unpause' : 'Click to pause this demo'}">
            ${isPaused ? '⏸ Paused' : '▶ Pause'}
          </button>
          <button class="btn-action" onclick="window._adminEditDemo('${id}')">Edit</button>
          <button class="btn-action primary" onclick="window._adminConvertDemo('${id}')">Convert</button>
          <button class="btn-action" onclick="window._setDemoShareUrl('${bizEncoded}');document.getElementById('local-demo-share-url').scrollIntoView({behavior:'smooth',block:'center'})" title="Copy AI demo link to widget above">🔗 Share</button>
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
    getAllCategories().map(c => {
      const icon = c.emoji?.startsWith('data:image') ? '' : (c.emoji + ' ');
      return `<option value="${c.id}">${icon}${c.name}</option>`;
    }).join('');
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
    document.getElementById('dmReferrer').value      = data.referrerUsername || '';
    document.getElementById('dmGreeting').value      = data.greeting        || '';
    document.getElementById('dmWebsite').value       = data.website         || '';
    document.getElementById('dmAiPrompt').value      = data.aiPromptBase    || '';
    document.getElementById('dmCalendarUrl').value   = data.calendarUrl     || '';
    document.getElementById('dmAssignedUser').value  = data.assignedUser    || '';
    document.getElementById('dmPhone').value       = data.phone    || '';
    document.getElementById('dmServices').value    = data.services || '';
    document.getElementById('dmBio').value         = data.bio      || '';

    // Language
    const lang = data.lang || 'en';
    document.querySelectorAll('input[name="dmLang"]').forEach(r => {
      r.checked = r.value === lang;
    });

    // Menu items
    const menuList = document.getElementById('menuItemsList');
    menuList.innerHTML = '';
    (data.menuItems || []).forEach(item => addMenuItemRow(item));

    // Widget theme / image
    dmWidgetTheme  = data.widgetTheme  || 'cyan';
    dmWidgetImgUrl = data.widgetImgUrl || '';
    dmBgImageUrl   = data.aiBgImage    || '';
    dmApplyThemeUI();
    if (dmWidgetImgUrl) {
      const thumb   = document.getElementById('dmWidgetImgThumb');
      const preview = document.getElementById('dmWidgetImgPreview');
      if (thumb)   thumb.src = dmWidgetImgUrl;
      if (preview) preview.style.display = 'flex';
    }
    if (dmBgImageUrl) {
      const bgThumb   = document.getElementById('dmBgThumb');
      const bgPreview = document.getElementById('dmBgPreview');
      if (bgThumb)   bgThumb.src = dmBgImageUrl;
      if (bgPreview) bgPreview.style.display = 'flex';
    }
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
  document.getElementById('dmReferrer').value     = '';
  document.getElementById('dmGreeting').value     = '';
  document.getElementById('dmWebsite').value      = '';
  document.getElementById('dmAiPrompt').value     = '';
  document.getElementById('dmCalendarUrl').value  = '';
  document.getElementById('dmAssignedUser').value = '';
  document.getElementById('dmPhone').value     = '';
  document.getElementById('dmServices').value  = '';
  document.getElementById('dmBio').value       = '';
  const scanStatus = document.getElementById('scanStatus');
  if (scanStatus) { scanStatus.textContent = ''; scanStatus.className = 'scan-status'; }
  document.querySelectorAll('input[name="dmLang"]').forEach(r => {
    r.checked = r.value === 'en';
  });
  const menuList = document.getElementById('menuItemsList');
  if (menuList) menuList.innerHTML = '';
  dmWidgetTheme  = 'cyan';
  dmWidgetImgUrl = '';
  dmBgImageUrl   = '';
  dmApplyThemeUI();
  const bgPreview = document.getElementById('dmBgPreview');
  if (bgPreview) bgPreview.style.display = 'none';
  const bgStatus = document.getElementById('dmBgStatus');
  if (bgStatus) bgStatus.textContent = '';
}

// ── Demo widget / bg helpers ──────────────────────────────
function dmApplyThemeUI() {
  document.querySelectorAll('#dmWidgetThemeRow .wt-swatch').forEach(s => {
    s.classList.toggle('selected', s.dataset.theme === dmWidgetTheme && !dmWidgetImgUrl);
  });
  const labels   = { cyan: 'Cyan (default)', red: 'Red', gold: 'Gold' };
  const statusEl = document.getElementById('dmWidgetThemeStatus');
  if (statusEl) {
    statusEl.textContent = dmWidgetImgUrl
      ? 'Style: Custom Image'
      : 'Style: ' + (labels[dmWidgetTheme] || dmWidgetTheme);
  }
}

window.dmPickTheme = function(theme) {
  dmWidgetTheme  = theme;
  dmWidgetImgUrl = '';
  const previewEl = document.getElementById('dmWidgetImgPreview');
  if (previewEl) previewEl.style.display = 'none';
  dmApplyThemeUI();
};

window.dmUploadWidgetImg = async function(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { showToast('Image must be under 2MB', 'error'); input.value = ''; return; }
  const statusEl = document.getElementById('dmWidgetThemeStatus');
  if (statusEl) statusEl.textContent = 'Uploading…';
  try {
    const path = `demos/widget-img/${Date.now()}_${file.name}`;
    const snap = await uploadBytes(storageRef(storage, path), file);
    dmWidgetImgUrl = await getDownloadURL(snap.ref);
    const thumb   = document.getElementById('dmWidgetImgThumb');
    const preview = document.getElementById('dmWidgetImgPreview');
    if (thumb)   thumb.src = dmWidgetImgUrl;
    if (preview) preview.style.display = 'flex';
    dmApplyThemeUI();
  } catch (err) {
    console.error('dmUploadWidgetImg error:', err);
    showToast('Upload failed', 'error');
    if (statusEl) statusEl.textContent = '';
  }
  input.value = '';
};

window.dmClearWidgetImg = function() {
  dmWidgetImgUrl = '';
  const thumb   = document.getElementById('dmWidgetImgThumb');
  const preview = document.getElementById('dmWidgetImgPreview');
  if (thumb)   thumb.src = '';
  if (preview) preview.style.display = 'none';
  dmApplyThemeUI();
};

window.dmUploadBg = async function(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { showToast('Image must be under 5MB', 'error'); input.value = ''; return; }
  const statusEl = document.getElementById('dmBgStatus');
  if (statusEl) statusEl.textContent = 'Uploading…';
  try {
    const path = `demos/bg-img/${Date.now()}_${file.name}`;
    const snap = await uploadBytes(storageRef(storage, path), file);
    dmBgImageUrl = await getDownloadURL(snap.ref);
    const thumb   = document.getElementById('dmBgThumb');
    const preview = document.getElementById('dmBgPreview');
    if (thumb)   thumb.src = dmBgImageUrl;
    if (preview) preview.style.display = 'flex';
    if (statusEl) statusEl.textContent = 'Background uploaded';
  } catch (err) {
    console.error('dmUploadBg error:', err);
    showToast('Upload failed', 'error');
    if (statusEl) statusEl.textContent = '';
  }
  input.value = '';
};

window.dmClearBg = function() {
  dmBgImageUrl = '';
  const thumb   = document.getElementById('dmBgThumb');
  const preview = document.getElementById('dmBgPreview');
  if (thumb)   thumb.src = '';
  if (preview) preview.style.display = 'none';
  const statusEl = document.getElementById('dmBgStatus');
  if (statusEl) statusEl.textContent = '';
};

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

  const website        = document.getElementById('dmWebsite')?.value.trim()       || '';
  const aiPromptBase   = document.getElementById('dmAiPrompt')?.value.trim()      || '';
  const calendarUrl    = document.getElementById('dmCalendarUrl')?.value.trim()   || '';
  const assignedUser   = document.getElementById('dmAssignedUser')?.value.trim()  || '';
  const phone       = document.getElementById('dmPhone')?.value.trim()    || '';
  const services    = document.getElementById('dmServices')?.value.trim() || '';
  const bio         = document.getElementById('dmBio')?.value.trim()      || '';

  const payload = {
    bizName,
    categoryId,
    slug,
    lang,
    referrerUsername,
    greeting,
    menuItems,
    website,
    aiPromptBase,
    calendarUrl,
    assignedUser,
    phone,
    services,
    bio,
    widgetTheme:  dmWidgetTheme,
    widgetImgUrl: dmWidgetImgUrl,
    aiBgImage:    dmBgImageUrl,
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

// ── Scan & Extract ────────────────────────────────────────────
async function scanAndExtract() {
  const urlInput = document.getElementById('dmWebsite');
  const url = urlInput?.value.trim();
  if (!url) { showToast('Enter a website URL first', 'error'); return; }

  const btn      = document.getElementById('scanBizBtn');
  const statusEl = document.getElementById('scanStatus');

  btn.textContent = '⏳ Scanning…';
  btn.disabled    = true;
  if (statusEl) statusEl.textContent = '';

  try {
    const resp = await fetch('/.netlify/functions/ls-scan-biz', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url })
    });
    const data = await resp.json();

    if (!resp.ok || data.error) {
      if (statusEl) { statusEl.textContent = '✗ ' + (data.error || 'Scan failed'); statusEl.className = 'scan-status err'; }
      showToast(data.error || 'Scan failed', 'error');
      return;
    }

    const e = data.extracted || {};

    // Auto-fill — only overwrite blank fields
    const nameEl = document.getElementById('dmBizName');
    if (e.bizName && nameEl && !nameEl.value.trim()) {
      nameEl.value = e.bizName;
      nameEl.dispatchEvent(new Event('input')); // triggers slug generation
    }

    const catEl = document.getElementById('dmCategory');
    if (e.category && catEl && !catEl.value) {
      const catLower = e.category.toLowerCase();
      const matched  = getAllCategories().find(c =>
        catLower.includes(c.name.toLowerCase().split(' ')[0]) ||
        c.name.toLowerCase().includes(catLower.split(' ')[0])
      );
      if (matched) catEl.value = matched.id;
    }

    if (e.phone)    { const el = document.getElementById('dmPhone');     if (el && !el.value.trim())    el.value = e.phone; }
    if (e.services) { const el = document.getElementById('dmServices');  if (el && !el.value.trim())    el.value = e.services; }
    if (e.bio)      { const el = document.getElementById('dmBio');       if (el && !el.value.trim())    el.value = e.bio; }
    if (e.aiPrompt) { const el = document.getElementById('dmAiPrompt'); if (el && !el.value.trim())    el.value = e.aiPrompt; }

    if (statusEl) { statusEl.textContent = '✓ Extracted successfully'; statusEl.className = 'scan-status ok'; }
    showToast('Business info extracted!', 'success');

  } catch (err) {
    console.error('scanAndExtract error:', err);
    if (statusEl) { statusEl.textContent = '✗ Could not reach the scan service'; statusEl.className = 'scan-status err'; }
    showToast('Scan failed — check the URL', 'error');
  } finally {
    btn.textContent = '🔍 Scan & Extract';
    btn.disabled    = false;
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
    const link = `https://ep-local-pro-ai.netlify.app/auth.html?${ref}demo=${demoId}`;

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

// ============================================================
// USERS (personal / referrer accounts)
// ============================================================
let _allUsers = [];

async function loadUsers() {
  const tbody   = document.getElementById('usersTableBody');
  const countEl = document.getElementById('usersCount');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="empty-state-icon">⏳</div><p>Loading…</p></div></td></tr>`;
  try {
    const snap = await getDocs(query(collection(db, 'owners'), orderBy('createdAt', 'desc')));
    _allUsers = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(u => (u.acctType || 'personal') === 'personal');
    if (countEl) countEl.textContent = `${_allUsers.length} user${_allUsers.length !== 1 ? 's' : ''}`;
    renderUsersTable(_allUsers);
  } catch (err) {
    console.error('loadUsers error:', err);
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>Error loading users. Publish Firestore rules first.</p></div></td></tr>`;
  }
}

function renderUsersTable(users) {
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;
  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div class="empty-state-icon">👥</div><p>No users yet.</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = users.map(u => `
    <tr>
      <td>${escHTML(((u.firstName || '') + ' ' + (u.lastName || '')).trim() || '—')}</td>
      <td class="cell-mono">${escHTML(u.username || '—')}</td>
      <td>${escHTML(u.email || '—')}</td>
      <td>${escHTML(u.phone || '—')}</td>
      <td>${escHTML(u.sponsorUsername || '—')}</td>
      <td>${badgeHTML(u.plan || 'trial')}</td>
      <td>${escHTML(fmtDate(u.createdAt))}</td>
      <td><button class="btn-action danger" onclick="window._adminCancelUser('${escAttr(u.id)}','${escAttr(((u.firstName||'')+' '+(u.lastName||'')).trim()||u.email||'this user')}')">Cancel</button></td>
    </tr>`).join('');
}

function filterUsers() {
  const q = (document.getElementById('userSearch')?.value || '').toLowerCase();
  if (!q) { renderUsersTable(_allUsers); return; }
  renderUsersTable(_allUsers.filter(u =>
    `${u.firstName} ${u.lastName} ${u.email} ${u.username}`.toLowerCase().includes(q)
  ));
}

// ============================================================
// LOCAL BUSINESS (business-type owner accounts)
// ============================================================
let _allLocalBiz = [];

async function loadLocalBiz() {
  const tbody   = document.getElementById('localBizTableBody');
  const countEl = document.getElementById('localBizCount');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div class="empty-state-icon">⏳</div><p>Loading…</p></div></td></tr>`;
  try {
    const snap = await getDocs(query(collection(db, 'owners'), orderBy('createdAt', 'desc')));
    _allLocalBiz = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(u => u.acctType === 'business');
    if (countEl) countEl.textContent = `${_allLocalBiz.length} business${_allLocalBiz.length !== 1 ? 'es' : ''}`;
    renderLocalBizTable(_allLocalBiz);
  } catch (err) {
    console.error('loadLocalBiz error:', err);
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><p>Error loading. Publish Firestore rules first.</p></div></td></tr>`;
  }
}

function renderLocalBizTable(list) {
  const tbody = document.getElementById('localBizTableBody');
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><div class="empty-state-icon">🏪</div><p>No local business accounts yet.</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(u => {
    const cat = CAT_MAP[u.categoryId] || {};
    return `
    <tr>
      <td>${escHTML(u.companyName || '—')}</td>
      <td>${escHTML((cat.emoji || '') + ' ' + (cat.name || u.categoryId || '—')).trim()}</td>
      <td>${escHTML(((u.firstName || '') + ' ' + (u.lastName || '')).trim() || '—')}</td>
      <td>${escHTML(u.email || '—')}</td>
      <td>${escHTML(u.phone || '—')}</td>
      <td>${escHTML(u.sponsorUsername || '—')}</td>
      <td>${badgeHTML(u.plan || 'trial')}</td>
      <td>${escHTML(fmtDate(u.createdAt))}</td>
      <td><button class="btn-action danger" onclick="window._adminCancelUser('${escAttr(u.id)}','${escAttr(((u.firstName||'')+' '+(u.lastName||'')).trim()||u.email||'this user')}')">Cancel</button></td>
    </tr>`;
  }).join('');
}

function filterLocalBiz() {
  const q = (document.getElementById('localBizSearch')?.value || '').toLowerCase();
  if (!q) { renderLocalBizTable(_allLocalBiz); return; }
  renderLocalBizTable(_allLocalBiz.filter(u =>
    `${u.companyName} ${u.email} ${u.categoryId}`.toLowerCase().includes(q)
  ));
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
const BUILTIN_COLORS = {
  coffee_shop: '#6f4e37', restaurant: '#dc2626', plumber: '#2563eb',
  electrician: '#d97706', salon: '#db2777',      roofer:  '#7c3aed',
  painter:     '#059669', carpenter: '#92400e',  retail:  '#0891b2',
  florist:     '#be185d'
};
const BUILTIN_ORDER_TYPES = {
  coffee_shop: ['pickup','delivery','dine-in'], restaurant: ['dine-in','pickup','delivery'],
  plumber: ['appointment','estimate'],          electrician: ['appointment','estimate'],
  salon: ['appointment'],                       roofer: ['appointment','estimate'],
  painter: ['appointment','estimate'],          carpenter: ['appointment','estimate'],
  retail: ['pickup','delivery'],                florist: ['pickup','delivery']
};
const BUILTIN_DOC_TYPES = {
  coffee_shop: ['invoice','receipt'],           restaurant: ['invoice','receipt'],
  plumber: ['estimate','invoice','contract','receipt'],
  electrician: ['estimate','invoice','contract','receipt'],
  salon: ['invoice','receipt'],
  roofer: ['estimate','invoice','contract','receipt'],
  painter: ['estimate','invoice','contract','receipt'],
  carpenter: ['estimate','invoice','contract','receipt'],
  retail: ['invoice','receipt'],                florist: ['invoice','receipt']
};

async function loadCustomCategories() {
  try {
    const snap = await getDocs(collection(db, 'categories'));
    customCategories = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
  } catch (err) {
    console.warn('loadCustomCategories error:', err);
  }
}

async function renderCategoriesSection() {
  const grid = document.getElementById('categoryGrid');
  if (!grid) return;

  grid.innerHTML = `<div class="empty-state"><p style="padding:20px 0;">Loading…</p></div>`;
  await loadCustomCategories();
  populateCategorySelect();

  const countsEl = document.getElementById('catCounts');
  if (countsEl) countsEl.textContent = `${CATEGORIES.length} built-in · ${customCategories.length} custom`;

  const builtInHTML = CATEGORIES.map(c => `
    <div class="category-card" style="border-top:3px solid ${BUILTIN_COLORS[c.id] || '#888'};">
      <div class="category-card-top">
        <span class="category-emoji">${c.emoji}</span>
        <div>
          <div class="category-name">${escHTML(c.name)}</div>
          <span class="cat-type-badge builtin">Built-in</span>
        </div>
      </div>
      <div class="category-meta">
        <strong>Orders:</strong> ${(BUILTIN_ORDER_TYPES[c.id] || []).join(', ')}<br/>
        <strong>Docs:</strong> ${(BUILTIN_DOC_TYPES[c.id] || []).join(', ')}
      </div>
    </div>`).join('');

  const customHTML = customCategories.map(c => `
    <div class="category-card" style="border-top:3px solid ${escHTML(c.color || '#4f46e5')};">
      <div class="category-card-top">
        ${c.emoji?.startsWith('data:image')
          ? `<img src="${c.emoji}" class="category-emoji-img" />`
          : `<span class="category-emoji">${escHTML(c.emoji || '📌')}</span>`}
        <div>
          <div class="category-name">${escHTML(c.name)}</div>
          <span class="cat-type-badge custom">Custom</span>
        </div>
      </div>
      <div class="category-card-actions">
        <button class="btn-action" onclick="window._adminEditCat('${escAttr(c._docId)}')">Edit</button>
        <button class="btn-action danger" onclick="window._adminDeleteCat('${escAttr(c._docId)}')">Delete</button>
      </div>
    </div>`).join('');

  grid.innerHTML = builtInHTML + customHTML || `<div class="empty-state"><div class="empty-state-icon">📂</div><p>No categories yet.</p></div>`;
}

// ── Add / Edit category modal ─────────────────────────────────
function openAddCategoryModal() {
  document.getElementById('catModalTitle').textContent = 'Add Category';
  document.getElementById('catModalDocId').value = '';
  document.getElementById('catName').value = '';
  document.getElementById('catColorPicker').value = '#4f46e5';
  document.getElementById('catColorHex').value = '#4f46e5';
  setCatIcon('');
  openModal('categoryModal');
}

function openEditCategoryModal(docId) {
  const cat = customCategories.find(c => c._docId === docId);
  if (!cat) { showToast('Category not found', 'error'); return; }

  document.getElementById('catModalTitle').textContent = 'Edit Category';
  document.getElementById('catModalDocId').value = docId;
  document.getElementById('catName').value = cat.name || '';
  const color = cat.color || '#4f46e5';
  document.getElementById('catColorPicker').value = color;
  document.getElementById('catColorHex').value = color;
  setCatIcon(cat.emoji?.startsWith('data:image') ? cat.emoji : '');
  openModal('categoryModal');
}

async function saveCategoryModal() {
  const name = document.getElementById('catName')?.value.trim();
  if (!name) { showToast('Category name is required', 'error'); return; }
  if (!catIconDataUrl) { showToast('Please upload an icon image', 'error'); return; }
  const emoji = catIconDataUrl;
  const color = document.getElementById('catColorHex')?.value.trim() || '#4f46e5';
  const existingDocId = document.getElementById('catModalDocId')?.value;
  const catId = existingDocId || toSlug(name);

  if (!existingDocId && CATEGORIES.find(c => c.id === catId)) {
    showToast('A built-in category with this name already exists', 'error');
    return;
  }

  const payload = { id: catId, name, emoji, color, isCustom: true };

  const saveBtn = document.getElementById('saveCatBtn');
  if (saveBtn) { saveBtn.textContent = 'Saving…'; saveBtn.disabled = true; }

  try {
    if (existingDocId) {
      await updateDoc(doc(db, 'categories', existingDocId), payload);
      showToast('Category updated', 'success');
    } else {
      await setDoc(doc(db, 'categories', catId), { ...payload, createdAt: serverTimestamp() });
      showToast('Category added', 'success');
    }
    closeModal('categoryModal');
    renderCategoriesSection();
  } catch (err) {
    console.error('saveCategoryModal error:', err);
    showToast('Error saving category: ' + (err.message || err), 'error');
  } finally {
    if (saveBtn) { saveBtn.textContent = 'Save Category'; saveBtn.disabled = false; }
  }
}

async function deleteCustomCategory(docId) {
  const cat = customCategories.find(c => c._docId === docId);
  if (!confirm(`Delete category "${cat?.name || docId}"? This cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, 'categories', docId));
    showToast('Category deleted', 'success');
    renderCategoriesSection();
  } catch (err) {
    console.error('deleteCustomCategory error:', err);
    showToast('Error deleting category', 'error');
  }
}

// ============================================================
// PROFILE
// ============================================================
function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  });
}

async function saveProfile() {
  const firstName = document.getElementById('settingFirstName')?.value.trim() || '';
  const lastName  = document.getElementById('settingLastName')?.value.trim()  || '';
  const phone     = document.getElementById('settingPhone')?.value.trim()     || '';

  try {
    if (currentUser) {
      await updateDoc(doc(db, 'owners', currentUser.uid), {
        firstName, lastName, phone,
        name: `${firstName} ${lastName}`.trim(),
        updatedAt: serverTimestamp()
      });
    }
    showToast('Profile saved', 'success');
  } catch (err) {
    console.error('saveProfile error:', err);
    showToast('Error saving profile', 'error');
  }
}

async function cancelMyAccount() {
  if (!confirm('Cancel your own admin account? This action cannot be undone.')) return;
  try {
    if (currentUser) {
      await updateDoc(doc(db, 'owners', currentUser.uid), {
        status: 'cancelled',
        cancelledAt: serverTimestamp()
      });
    }
    showToast('Account cancelled. Signing out…', 'success');
    setTimeout(async () => {
      await signOut(auth);
      window.location.href = '/auth.html';
    }, 2000);
  } catch (err) {
    console.error('cancelMyAccount error:', err);
    showToast('Error cancelling account', 'error');
  }
}

// ============================================================
// SETTINGS
// ============================================================
async function saveSettings() {
  const platformName = document.getElementById('settingPlatformName')?.value.trim() || '';
  const supportEmail = document.getElementById('settingSupportEmail')?.value.trim() || '';
  const demoAgentId  = document.getElementById('settingDemoAgentId')?.value.trim()  || '';
  const demoVoiceEn  = document.getElementById('settingDemoVoiceEn')?.value          || '';
  const demoVoiceEs  = document.getElementById('settingDemoVoiceEs')?.value          || '';

  try {
    if (currentUser) {
      await Promise.all([
        updateDoc(doc(db, 'owners', currentUser.uid), {
          platformName, supportEmail, demoAgentId, demoVoiceEn, demoVoiceEs,
          updatedAt: serverTimestamp()
        }),
        setDoc(doc(db, 'config', 'demo'), {
          demoAgentId, demoVoiceEn, demoVoiceEs,
          updatedAt: serverTimestamp()
        })
      ]);
    }
    showToast('Settings saved', 'success');
  } catch (err) {
    console.error('saveSettings error:', err);
    showToast('Error saving settings', 'error');
  }
}

async function loadSettings() {
  if (!currentUser) return;
  try {
    const snap = await getDoc(doc(db, 'owners', currentUser.uid));
    if (!snap.exists()) return;
    const d = snap.data();
    const sfn = document.getElementById('settingPlatformName');
    const sse = document.getElementById('settingSupportEmail');
    const sda = document.getElementById('settingDemoAgentId');
    const sde = document.getElementById('settingDemoVoiceEn');
    const sds = document.getElementById('settingDemoVoiceEs');
    if (sfn && d.platformName) sfn.value = d.platformName;
    if (sse && d.supportEmail) sse.value = d.supportEmail;
    if (sda && d.demoAgentId) sda.value = d.demoAgentId;
    if (sde && d.demoVoiceEn) sde.value = d.demoVoiceEn;
    if (sds && d.demoVoiceEs) sds.value = d.demoVoiceEs;
  } catch (err) {
    console.error('loadSettings error:', err);
  }
}

// ============================================================
// AI VOICE DEMO WIDGET
// ============================================================
let _localDemoSession = null;

window._localDemoStartCall = async function () {
  const btn    = document.getElementById('local-demo-talk-btn');
  const status = document.getElementById('local-demo-call-status');
  if (btn)    { btn.disabled = true; btn.textContent = '⏳ Connecting…'; }
  if (status)   status.textContent = 'Connecting to Demo AI…';

  try {
    // Load demoAgentId from Firestore config
    const EP_HUB_AGENT_ID = 'agent_2001m53k7x82fdeb6zygz5e9gwrt';
    const configSnap = await getDoc(doc(db, 'config', 'demo'));
    const agentId = (configSnap.exists() && configSnap.data().demoAgentId)
      ? configSnap.data().demoAgentId
      : EP_HUB_AGENT_ID;

    // Get signed URL from ai-session function
    const res  = await fetch('/.netlify/functions/ai-session', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ agentId }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    // Load ElevenLabs ConvAI SDK
    const { Conversation } = await import(
      'https://cdn.jsdelivr.net/npm/@11labs/client@latest/dist/index.esm.js'
    );

    const sessionConfig = data.signed_url
      ? { signedUrl: data.signed_url }
      : { agentId: data.agentId };

    _localDemoSession = await Conversation.startSession({
      ...sessionConfig,
      onStatusChange: (s) => {
        if (!status) return;
        if (s === 'connected')    status.textContent = '🟢 Connected — speak now';
        else if (s === 'disconnected') { status.textContent = ''; _localDemoSession = null; }
        else status.textContent = s;
        if (s === 'connected' && btn) { btn.disabled = false; btn.textContent = '🎤 Talk to Demo AI'; }
      },
      onError: (e) => {
        if (status) status.textContent = '❌ ' + (e?.message || String(e));
        if (btn) { btn.disabled = false; btn.textContent = '🎤 Talk to Demo AI'; }
      },
    });
  } catch (e) {
    if (status) status.textContent = '❌ ' + e.message;
    if (btn) { btn.disabled = false; btn.textContent = '🎤 Talk to Demo AI'; }
  }
};

window._localDemoEndCall = function () {
  if (_localDemoSession) {
    try { _localDemoSession.endSession(); } catch {}
    _localDemoSession = null;
  }
  const status = document.getElementById('local-demo-call-status');
  if (status) status.textContent = '';
  const btn = document.getElementById('local-demo-talk-btn');
  if (btn) { btn.disabled = false; btn.textContent = '🎤 Talk to Demo AI'; }
};

// Called from demo table rows to populate the share URL field
window._setDemoShareUrl = function (bizEncoded) {
  const input = document.getElementById('local-demo-share-url');
  if (!input) return;
  const params = bizEncoded ? '?biz=' + bizEncoded : '';
  input.value = location.origin + '/demo.html' + params;
};

// ============================================================
// DEMO REQUESTS
// ============================================================
window._adminLoadDemoRequests = async function () {
  const list  = document.getElementById('demoRequestsList');
  const badge = document.getElementById('demoReqBadge');
  if (!list) return;
  list.innerHTML = '<div style="color:#94a3b8;font-size:13px;padding:12px;">Loading…</div>';
  try {
    const snap = await getDocs(query(collection(db, 'demoRequests'), orderBy('createdAt', 'desc')));
    if (snap.empty) {
      list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📬</div><p>No demo requests yet.</p></div>';
      if (badge) badge.style.display = 'none';
      return;
    }
    const pending = snap.docs.filter(d => d.data().status === 'pending').length;
    if (badge) { badge.textContent = pending; badge.style.display = pending ? 'inline' : 'none'; }
    list.innerHTML = snap.docs.map(d => _renderDemoRequestCard(d.data(), d.id)).join('');
  } catch (e) {
    console.error('loadDemoRequests:', e);
    list.innerHTML = '<div style="color:#ef4444;font-size:12px;padding:12px;">Error loading requests.</div>';
  }
};

function _renderDemoRequestCard(r, id) {
  const statusColor = { pending: '#f59e0b', created: '#10b981', paused: '#6366f1' }[r.status] || '#94a3b8';
  return `<div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:6px;">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;">
      <div>
        <span style="font-size:14px;font-weight:800;color:#1e293b;">${escHTML(r.bizName || '—')}</span>
        <span style="font-size:11px;color:#64748b;margin-left:8px;">${escHTML(r.bizType || '')}</span>
      </div>
      <span style="font-size:10px;font-weight:800;text-transform:uppercase;padding:2px 10px;border-radius:20px;background:${statusColor}20;color:${statusColor};">${r.status || 'pending'}</span>
    </div>
    <div style="font-size:12px;color:#475569;display:flex;flex-wrap:wrap;gap:12px;">
      ${r.clientName ? `<span>👤 ${escHTML(r.clientName)}</span>` : ''}
      ${r.referrerUsername ? `<span>@ ${escHTML(r.referrerUsername)}</span>` : ''}
      ${r.phone   ? `<span>📞 ${escHTML(r.phone)}</span>`   : ''}
      ${r.email   ? `<span>✉️ ${escHTML(r.email)}</span>`   : ''}
      ${r.location ? `<span>📍 ${escHTML(r.location)}</span>` : ''}
    </div>
    ${r.notes ? `<div style="font-size:11px;color:#64748b;font-style:italic;">${escHTML(r.notes)}</div>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;">
      <button class="btn-action primary" onclick="window._adminFillFromRequest('${id}')">✏️ Fill Form</button>
      <button class="btn-action" onclick="window._adminEditRequest('${id}')">Edit</button>
      <button class="btn-action danger" onclick="window._adminDeleteRequest('${id}')">Delete</button>
    </div>
  </div>`;
}

window._adminFillFromRequest = async function (id) {
  try {
    const snap = await getDoc(doc(db, 'demoRequests', id));
    if (!snap.exists()) { showToast('Request not found', 'error'); return; }
    const r = snap.data();
    clearDemoModal();
    document.getElementById('demoModalId').value  = '';
    document.getElementById('dmBizName').value    = r.bizName    || '';
    document.getElementById('dmReferrer').value   = r.referrerUsername || '';
    document.getElementById('dmPhone').value      = r.phone      || '';
    document.getElementById('dmServices').value   = r.services   || '';
    document.getElementById('dmBio').value        = r.bio        || '';
    document.getElementById('dmWebsite').value    = r.website    || '';
    document.getElementById('dmAiPrompt').value   = r.aiPrompt   || '';
    document.getElementById('dmAssignedUser').value = r.assignedUser || r.referrerUsername || '';
    const catEl = document.getElementById('dmCategory');
    if (catEl && r.bizType) catEl.value = r.bizType;
    openModal('demoModal');
    showToast('Form filled from request — review and save', 'success');
  } catch (e) { showToast('Error filling form', 'error'); }
};

window._adminDeleteRequest = async function (id) {
  if (!confirm('Delete this demo request?')) return;
  try {
    await deleteDoc(doc(db, 'demoRequests', id));
    showToast('Request deleted', 'success');
    window._adminLoadDemoRequests();
  } catch (e) { showToast('Error deleting request', 'error'); }
};

window._adminEditRequest = async function (id) {
  const bizName = prompt('Business Name:');
  if (bizName === null) return;
  try {
    await updateDoc(doc(db, 'demoRequests', id), { bizName, updatedAt: serverTimestamp() });
    showToast('Request updated', 'success');
    window._adminLoadDemoRequests();
  } catch (e) { showToast('Error updating request', 'error'); }
};

// ============================================================
// DEMO TEMPLATES
// ============================================================
window._adminLoadTemplates = async function () {
  const list = document.getElementById('demoTemplatesList');
  if (!list) return;
  list.innerHTML = '<div style="color:#94a3b8;font-size:13px;padding:12px;">Loading…</div>';
  try {
    const snap = await getDocs(query(collection(db, 'demoTemplates'), orderBy('createdAt', 'desc')));
    if (snap.empty) {
      list.innerHTML = '<div class="empty-state" style="width:100%;"><div class="empty-state-icon">📂</div><p>No templates saved yet. Create a demo and click "Save as Template".</p></div>';
      return;
    }
    list.innerHTML = snap.docs.map(d => _renderTemplateCard(d.data(), d.id)).join('');
  } catch (e) {
    list.innerHTML = '<div style="color:#ef4444;font-size:12px;padding:12px;">Error loading templates.</div>';
  }
};

function _renderTemplateCard(t, id) {
  return `<div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;padding:14px;min-width:200px;max-width:280px;flex:1;">
    <div style="font-size:13px;font-weight:800;color:#1e293b;margin-bottom:4px;">${escHTML(t.templateName || 'Unnamed Template')}</div>
    <div style="font-size:11px;color:#6366f1;margin-bottom:6px;">${escHTML(t.bizType || '')}</div>
    ${t.services ? `<div style="font-size:11px;color:#64748b;margin-bottom:8px;">${escHTML(t.services)}</div>` : ''}
    <div style="display:flex;gap:6px;">
      <button class="btn-action primary" onclick="window._adminApplyTemplate('${id}')" style="flex:1;">Use Template</button>
      <button class="btn-action danger" onclick="window._adminDeleteTemplate('${id}')">🗑</button>
    </div>
  </div>`;
}

window._adminSaveAsTemplate = async function () {
  const bizName    = document.getElementById('dmBizName')?.value.trim();
  const bizType    = document.getElementById('dmCategory')?.value;
  const services   = document.getElementById('dmServices')?.value.trim()   || '';
  const bio        = document.getElementById('dmBio')?.value.trim()        || '';
  const aiPrompt   = document.getElementById('dmAiPrompt')?.value.trim()   || '';
  const greeting   = document.getElementById('dmGreeting')?.value.trim()   || '';
  const calendarUrl= document.getElementById('dmCalendarUrl')?.value.trim()|| '';
  if (!bizName) { showToast('Enter a business name before saving as template', 'error'); return; }
  const templateName = prompt('Template name:', bizName + (bizType ? ` (${bizType})` : ''));
  if (!templateName) return;
  try {
    await addDoc(collection(db, 'demoTemplates'), {
      templateName, bizType: bizType || '', services, bio, aiPromptBase: aiPrompt, greeting, calendarUrl,
      createdAt: serverTimestamp(),
    });
    showToast('Template saved!', 'success');
  } catch (e) { showToast('Error saving template', 'error'); }
};

window._adminApplyTemplate = async function (id) {
  try {
    const snap = await getDoc(doc(db, 'demoTemplates', id));
    if (!snap.exists()) { showToast('Template not found', 'error'); return; }
    const t = snap.data();
    const catEl = document.getElementById('dmCategory');
    if (catEl && t.bizType) catEl.value = t.bizType;
    if (t.services)    document.getElementById('dmServices').value    = t.services;
    if (t.bio)         document.getElementById('dmBio').value         = t.bio;
    if (t.aiPromptBase)document.getElementById('dmAiPrompt').value    = t.aiPromptBase;
    if (t.greeting)    document.getElementById('dmGreeting').value    = t.greeting;
    if (t.calendarUrl) document.getElementById('dmCalendarUrl').value = t.calendarUrl;
    openModal('demoModal');
    showToast('Template applied — fill in business name & save', 'success');
  } catch (e) { showToast('Error applying template', 'error'); }
};

window._adminDeleteTemplate = async function (id) {
  if (!confirm('Delete this template?')) return;
  try {
    await deleteDoc(doc(db, 'demoTemplates', id));
    showToast('Template deleted', 'success');
    window._adminLoadTemplates();
  } catch (e) { showToast('Error deleting template', 'error'); }
};

// ============================================================
// GO LIVE TOGGLE
// ============================================================
async function toggleDemoLive(id, currentStatus) {
  const goingLive = currentStatus !== 'live';
  const newStatus = goingLive ? 'live' : 'demo';
  const label     = goingLive ? 'Go Live' : 'Set back to Demo';

  if (!confirm(`${label} for this demo?\n\n${goingLive
    ? 'The business owner will be able to use this as their personalized AI assistant page.'
    : 'This will return the page to demo/preview mode.'}`)) return;

  try {
    await updateDoc(doc(db, 'demos', id), { status: newStatus, updatedAt: serverTimestamp() });
    showToast(goingLive ? '🟢 Demo is now Live!' : '⚪ Reverted to Demo mode', 'success');
    loadDemos();
  } catch (err) {
    console.error('toggleDemoLive error:', err);
    showToast('Error updating status', 'error');
  }
}

async function toggleDemoPaused(id, currentStatus, prevStatus) {
  const pausing = currentStatus !== 'paused';

  if (pausing) {
    if (!confirm('Pause this demo?\n\nThe AI page will be inaccessible until you unpause it.')) return;
    try {
      await updateDoc(doc(db, 'demos', id), {
        status: 'paused',
        prevStatus: currentStatus,
        updatedAt: serverTimestamp()
      });
      showToast('⏸ Demo paused', 'success');
      loadDemos();
    } catch (err) {
      console.error('toggleDemoPaused error:', err);
      showToast('Error pausing demo', 'error');
    }
  } else {
    const restoreTo = prevStatus || 'demo';
    if (!confirm(`Unpause this demo?\n\nIt will be restored to "${restoreTo}" status.`)) return;
    try {
      await updateDoc(doc(db, 'demos', id), {
        status: restoreTo,
        prevStatus: null,
        updatedAt: serverTimestamp()
      });
      showToast(`▶ Demo unpaused — restored to ${restoreTo}`, 'success');
      loadDemos();
    } catch (err) {
      console.error('toggleDemoPaused error:', err);
      showToast('Error unpausing demo', 'error');
    }
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
async function cancelUserAccount(uid, name) {
  if (!confirm(`Cancel account for "${name}"? This will mark their account as cancelled.`)) return;
  try {
    await updateDoc(doc(db, 'owners', uid), {
      status: 'cancelled',
      cancelledAt: serverTimestamp()
    });
    showToast(`Account cancelled for ${name}`, 'success');
    loadUsers();
    loadLocalBiz();
  } catch (err) {
    console.error('cancelUserAccount error:', err);
    showToast('Error cancelling account', 'error');
  }
}

window._adminEditDemo        = id => openEditDemoModal(id);
window._adminDeleteDemo      = id => deleteDemoConfirm(id);
window._adminConvertDemo     = id => convertDemoToAccount(id);
window._adminToggleDemoLive   = (id, status) => toggleDemoLive(id, status);
window._adminToggleDemoPaused = (id, status, prev) => toggleDemoPaused(id, status, prev);
window._adminToggleBizDetail = id => toggleBizDetail(id);
window._adminViewBiz         = id => viewBiz(id);
window._adminSuspendBiz      = (id, name) => suspendBiz(id, name);
window._adminEditCat         = id => openEditCategoryModal(id);
window._adminDeleteCat       = id => deleteCustomCategory(id);
window._adminCancelUser      = (uid, name) => cancelUserAccount(uid, name);
window.filterUsers           = filterUsers;
window.filterLocalBiz        = filterLocalBiz;

// ── Admin Documents ───────────────────────────────────────────
let adminAllDocs        = [];
let adminDocFilter      = 'all';

async function loadAdminDocuments() {
  const list = document.getElementById('adminDocsList');
  if (!list) return;
  list.innerHTML = `<div class="empty-state"><p>Loading…</p></div>`;

  document.querySelectorAll('#adminDocsList ~ .docs-tabs-bar .docs-tab, [data-section="documents"] .docs-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('[data-section="documents"] .docs-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      adminDocFilter = tab.dataset.filter;
      renderAdminDocCards();
    };
  });

  try {
    const snap = await getDocs(query(collection(db, 'documents'), orderBy('createdAt', 'desc'), limit(300)));
    adminAllDocs = [];
    snap.forEach(d => adminAllDocs.push({ id: d.id, ...d.data() }));
    updateAdminDocCounts();
    renderAdminDocCards();
  } catch (err) {
    console.error('loadAdminDocuments error:', err);
    list.innerHTML = `<div class="empty-state"><p>Failed to load documents.</p></div>`;
  }
}

function updateAdminDocCounts() {
  const counts = { all: adminAllDocs.length, invoice: 0, estimate: 0, contract: 0, receipt: 0 };
  adminAllDocs.forEach(d => { if (d.type && counts[d.type] !== undefined) counts[d.type]++; });
  const map = { all: 'adCountAll', invoice: 'adCountInvoice', estimate: 'adCountEstimate', contract: 'adCountContract', receipt: 'adCountReceipt' };
  Object.entries(map).forEach(([type, id]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = counts[type] ?? 0;
  });
}

function renderAdminDocCards() {
  const list = document.getElementById('adminDocsList');
  if (!list) return;
  const filtered = adminDocFilter === 'all'
    ? adminAllDocs
    : adminAllDocs.filter(d => d.type === adminDocFilter);

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📄</div><p>No ${adminDocFilter === 'all' ? '' : adminDocFilter + ' '}documents found.</p></div>`;
    return;
  }

  const typeLabels = { invoice: 'Invoice', estimate: 'Estimate', contract: 'Contract', receipt: 'Receipt' };
  const badgeCls   = { invoice: 'badge-invoice', estimate: 'badge-estimate', contract: 'badge-contract', receipt: 'badge-receipt' };

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
            ${docData.businessId ? `<span class="doc-card-meta-dot">${docData.businessId}</span>` : ''}
          </div>
        </div>
        <div class="doc-card-amount">${amount}</div>
      </div>
      <div class="doc-card-actions">
        ${docData.htmlContent ? `<button class="btn-action" data-view>👁 View</button>` : ''}
      </div>`;

    if (docData.htmlContent) {
      card.querySelector('[data-view]')?.addEventListener('click', () => {
        const win = window.open('', '_blank');
        if (win) { win.document.write(docData.htmlContent); win.document.close(); }
      });
    }
    list.appendChild(card);
  });
}

// ============================================================
// CALENDAR MANAGEMENT
// ============================================================

const CAL_DAYS = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' }
];

const CAL_MONTHS = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];

let _calAllBookings = []; // cached for search + CSV
let _calMiniYear = new Date().getFullYear();
let _calMiniMonth = new Date().getMonth();

// ── Availability grid ────────────────────────────────────────
function renderCalAvailGrid(availability = {}) {
  const grid = document.getElementById('calAvailGrid');
  if (!grid) return;
  grid.innerHTML = CAL_DAYS.map(({ key, label }) => {
    const av = availability[key];
    const enabled = !!(av && av.length >= 2);
    const start = enabled ? av[0] : '09:00';
    const end   = enabled ? av[1] : '17:00';
    return `
      <div class="cal-avail-row">
        <input type="checkbox" id="calDay_${key}" ${enabled ? 'checked' : ''}
          onchange="window._adminCalDayToggle('${key}')">
        <span class="day-label">${label}</span>
        <input type="time" id="calStart_${key}" value="${start}" ${enabled ? '' : 'disabled'}>
        <input type="time" id="calEnd_${key}"   value="${end}"   ${enabled ? '' : 'disabled'}>
      </div>`;
  }).join('');
}

window._adminCalDayToggle = function(key) {
  const cb = document.getElementById(`calDay_${key}`);
  const s  = document.getElementById(`calStart_${key}`);
  const e  = document.getElementById(`calEnd_${key}`);
  if (!cb || !s || !e) return;
  s.disabled = !cb.checked;
  e.disabled = !cb.checked;
};

// ── Load config ──────────────────────────────────────────────
async function loadCalendarConfig() {
  renderCalAvailGrid();
  try {
    const snap = await getDoc(doc(db, 'config', 'calendar'));
    const data = snap.exists() ? snap.data() : {};
    const biz  = (data.businesses || [])[0] || {};

    _setVal('calBizName',       biz.name         || '');
    _setVal('calSlotDuration',  biz.slotDuration  || 30);
    _setVal('calDescription',   biz.description   || '');
    _setVal('calColor',         biz.color         || '#4f46e5');
    _setVal('calMeetingLink',   biz.meetingLink    || '');
    _setVal('calLabel',         biz.calLabel       || '');
    _setVal('calColorBg',       biz.colorBg        || '#0f172a');
    _setVal('calColorCard',     biz.colorCard      || '#1e293b');
    _setVal('calColorAccent',   biz.colorAccent    || '#4f46e5');
    _setVal('calProfileName',   biz.profile?.displayName || '');
    _setVal('calProfileTitle',  biz.profile?.title       || '');
    _setVal('calProfilePhone',  biz.profile?.phone       || '');
    _setVal('calProfilePhoto',  biz.profile?.photoUrl    || '');
    _setVal('calIntGoogle',    (biz.integrations || {}).google   || '');
    _setVal('calIntOutlook',   (biz.integrations || {}).outlook  || '');
    _setVal('calIntCalendly',  (biz.integrations || {}).calendly || '');
    _setVal('calIntAcuity',    (biz.integrations || {}).acuity   || '');

    const actEl = document.getElementById('calActive');
    if (actEl) actEl.checked = biz.active !== false;

    renderCalAvailGrid(biz.availability || {});
    _updateCalBookingLink();
    _wireCalShareBtns();
    _wireCalQr();
    _renderCalMini();

    // Show demo AI link (read-only)
    const aiLinkEl = document.getElementById('calAiLinkDisplay');
    if (aiLinkEl) aiLinkEl.textContent = `${window.location.origin}/ai/ep-hub`;

    // Export CSV button
    document.getElementById('calExportCsvBtn')?.addEventListener('click', _calExportCsv, { once: true });

  } catch(e) {
    console.error('loadCalendarConfig', e);
  }
}

function _setVal(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.tagName === 'SELECT' || el.type === 'checkbox') return;
  el.value = val;
}

function _updateCalBookingLink() {
  const url = `${window.location.origin}/calendar.html?biz=0`;
  const el  = document.getElementById('calBookingLink');
  if (el) el.textContent = url;
  const openEl = document.getElementById('calBookingLinkOpen');
  if (openEl) openEl.href = url;
}

// ── Share buttons ────────────────────────────────────────────
function _wireCalShareBtns() {
  const getUrl = () => document.getElementById('calBookingLink')?.textContent?.trim() || '';

  document.getElementById('calCopyLinkBtn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(getUrl()).then(() => {
      const b = document.getElementById('calCopyLinkBtn');
      if (b) { const t = b.textContent; b.textContent = 'Copied!'; setTimeout(() => b.textContent = t, 1500); }
    }).catch(() => {});
  });

  document.getElementById('calShareWA')?.addEventListener('click', () =>
    window.open(`https://wa.me/?text=${encodeURIComponent('Book an appointment: ' + getUrl())}`, '_blank'));
  document.getElementById('calShareTG')?.addEventListener('click', () =>
    window.open(`https://t.me/share/url?url=${encodeURIComponent(getUrl())}`, '_blank'));
  document.getElementById('calShareSMS')?.addEventListener('click', () =>
    window.open(`sms:?body=${encodeURIComponent('Book an appointment: ' + getUrl())}`, '_blank'));
  document.getElementById('calShareFB')?.addEventListener('click', () =>
    window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(getUrl())}`, '_blank'));
  document.getElementById('calShareEM')?.addEventListener('click', () =>
    window.open(`mailto:?subject=Book an Appointment&body=${encodeURIComponent('Click to book: ' + getUrl())}`, '_blank'));
}

// ── QR Code ──────────────────────────────────────────────────
function _wireCalQr() {
  const cb    = document.getElementById('calShowQR');
  const box   = document.getElementById('calQrBox');
  const img   = document.getElementById('calQrImg');
  if (!cb || !box || !img) return;
  cb.addEventListener('change', () => {
    if (cb.checked) {
      const url = document.getElementById('calBookingLink')?.textContent?.trim() || '';
      img.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;
      box.style.display = 'block';
    } else {
      box.style.display = 'none';
    }
  });
}

// ── Mini calendar ────────────────────────────────────────────
function _renderCalMini() {
  const labelEl = document.getElementById('calMiniLabel');
  const headEl  = document.getElementById('calMiniHead');
  const gridEl  = document.getElementById('calMiniGrid');
  if (!labelEl || !headEl || !gridEl) return;

  const today = new Date();
  const y = _calMiniYear, m = _calMiniMonth;
  labelEl.textContent = `${CAL_MONTHS[m]} ${y}`;

  headEl.innerHTML = ['S','M','T','W','T','F','S'].map(d => `<span>${d}</span>`).join('');

  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();

  // Gather dates that have bookings
  const bookedDates = new Set(_calAllBookings.map(b => b.date));

  let cells = '';
  for (let i = 0; i < firstDay; i++) cells += `<div class="cal-mini-cell empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday = today.getFullYear() === y && today.getMonth() === m && today.getDate() === d;
    const hasB    = bookedDates.has(dateStr);
    cells += `<div class="cal-mini-cell ${isToday ? 'today' : ''} ${hasB ? 'has-bookings' : ''}">${d}</div>`;
  }
  gridEl.innerHTML = cells;

  document.getElementById('calMiniPrev')?.addEventListener('click', () => {
    _calMiniMonth--;
    if (_calMiniMonth < 0) { _calMiniMonth = 11; _calMiniYear--; }
    _renderCalMini();
  }, { once: true });
  document.getElementById('calMiniNext')?.addEventListener('click', () => {
    _calMiniMonth++;
    if (_calMiniMonth > 11) { _calMiniMonth = 0; _calMiniYear++; }
    _renderCalMini();
  }, { once: true });
}

// ── Save config ──────────────────────────────────────────────
window._adminSaveCalConfig = async function() {
  const btn = document.getElementById('saveCalConfigBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const availability = {};
    CAL_DAYS.forEach(({ key }) => {
      const cb = document.getElementById(`calDay_${key}`);
      const s  = document.getElementById(`calStart_${key}`);
      const e  = document.getElementById(`calEnd_${key}`);
      if (cb?.checked && s?.value && e?.value) availability[key] = [s.value, e.value];
    });

    const snap = await getDoc(doc(db, 'config', 'calendar'));
    const existing = snap.exists() ? snap.data() : {};
    const businesses = [...(existing.businesses || [])];
    businesses[0] = {
      ...(businesses[0] || {}),
      name:         document.getElementById('calBizName')?.value.trim()     || 'Book an Appointment',
      slotDuration: parseInt(document.getElementById('calSlotDuration')?.value) || 30,
      description:  document.getElementById('calDescription')?.value.trim() || '',
      color:        document.getElementById('calColor')?.value               || '#4f46e5',
      meetingLink:  document.getElementById('calMeetingLink')?.value.trim() || '',
      calLabel:     document.getElementById('calLabel')?.value.trim()        || '',
      colorBg:      document.getElementById('calColorBg')?.value             || '#0f172a',
      colorCard:    document.getElementById('calColorCard')?.value           || '#1e293b',
      colorAccent:  document.getElementById('calColorAccent')?.value         || '#4f46e5',
      active:       document.getElementById('calActive')?.checked !== false,
      availability,
      integrations: {
        google:   document.getElementById('calIntGoogle')?.value.trim()   || '',
        outlook:  document.getElementById('calIntOutlook')?.value.trim()  || '',
        calendly: document.getElementById('calIntCalendly')?.value.trim() || '',
        acuity:   document.getElementById('calIntAcuity')?.value.trim()   || ''
      },
      profile: {
        displayName: document.getElementById('calProfileName')?.value.trim()  || '',
        title:       document.getElementById('calProfileTitle')?.value.trim() || '',
        phone:       document.getElementById('calProfilePhone')?.value.trim() || '',
        photoUrl:    document.getElementById('calProfilePhoto')?.value.trim() || ''
      }
    };

    await setDoc(doc(db, 'config', 'calendar'), { businesses }, { merge: true });
    if (btn) { btn.disabled = false; btn.textContent = '💾 Save Calendar Settings'; }
    alert('Calendar settings saved!');
  } catch(e) {
    console.error('saveCalConfig', e);
    if (btn) { btn.disabled = false; btn.textContent = '💾 Save Calendar Settings'; }
    alert('Error saving: ' + e.message);
  }
};

// ── Load bookings ────────────────────────────────────────────
window._adminLoadBookings = async function() {
  const tbody = document.getElementById('bookingsTableBody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#94a3b8;padding:20px">Loading…</td></tr>`;
  try {
    const q = query(collection(db, 'bookings'), orderBy('date', 'desc'), limit(200));
    const snap = await getDocs(q);

    _calAllBookings = [];
    snap.forEach(d => _calAllBookings.push({ id: d.id, ...d.data() }));

    _renderBookingsTable(_calAllBookings);
    _updateCalStats(_calAllBookings);
    _renderCalMini();
  } catch(e) {
    console.error('loadBookings', e);
    tbody.innerHTML = `<tr><td colspan="9" style="color:#ef4444;padding:20px">${e.message}</td></tr>`;
  }
};

function _renderBookingsTable(rows) {
  const tbody = document.getElementById('bookingsTableBody');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#94a3b8;padding:20px">No appointments yet</td></tr>`;
    return;
  }
  tbody.innerHTML = '';
  rows.forEach(b => {
    const status   = b.status || 'pending';
    const badgeCls = status === 'confirmed' ? 'badge-booking-confirmed'
                   : status === 'cancelled' ? 'badge-booking-cancelled'
                   : 'badge-booking-pending';
    const tr = document.createElement('tr');
    tr.dataset.id = b.id;
    tr.innerHTML = `
      <td title="${b.clientName || ''}">${b.clientName  || '—'}</td>
      <td title="${b.clientEmail|| ''}">${b.clientEmail || '—'}</td>
      <td>${b.clientPhone || '—'}</td>
      <td>${b.date  || '—'}</td>
      <td>${b.time  || '—'}</td>
      <td title="${b.reason||''}">${b.reason || '—'}</td>
      <td title="${b.notes ||''}">${b.notes  || '—'}</td>
      <td><span class="badge ${badgeCls}">${status}</span></td>
      <td style="white-space:nowrap">
        ${status !== 'confirmed' ? `<button class="btn-action btn-sm" onclick="window._adminConfirmBooking('${b.id}')">✓</button>` : ''}
        ${status !== 'cancelled' ? `<button class="btn-action btn-sm" style="margin-left:4px" onclick="window._adminCancelBooking('${b.id}')">✕</button>` : ''}
      </td>`;
    tbody.appendChild(tr);
  });
}

function _updateCalStats(rows) {
  document.getElementById('calStatTotal')?.    textContent !== undefined &&
    (document.getElementById('calStatTotal').textContent     = rows.length);
  document.getElementById('calStatConfirmed')?.textContent !== undefined &&
    (document.getElementById('calStatConfirmed').textContent = rows.filter(b => b.status === 'confirmed').length);
  document.getElementById('calStatPending')?.  textContent !== undefined &&
    (document.getElementById('calStatPending').textContent   = rows.filter(b => !b.status || b.status === 'pending').length);
  document.getElementById('calStatCancelled')?.textContent !== undefined &&
    (document.getElementById('calStatCancelled').textContent = rows.filter(b => b.status === 'cancelled').length);
}

window._adminFilterBookings = function() {
  const q = (document.getElementById('bookingSearch')?.value || '').toLowerCase();
  const filtered = q
    ? _calAllBookings.filter(b =>
        (b.clientName  || '').toLowerCase().includes(q) ||
        (b.clientEmail || '').toLowerCase().includes(q) ||
        (b.clientPhone || '').toLowerCase().includes(q))
    : _calAllBookings;
  _renderBookingsTable(filtered);
};

function _calExportCsv() {
  if (!_calAllBookings.length) { alert('No bookings to export.'); return; }
  const cols = ['Name','Email','Phone','Date','Time','Reason','Notes','Status'];
  const rows = _calAllBookings.map(b => [
    b.clientName, b.clientEmail, b.clientPhone, b.date, b.time, b.reason, b.notes, b.status
  ].map(v => `"${(v||'').replace(/"/g,'""')}"`).join(','));
  const csv  = [cols.join(','), ...rows].join('\n');
  const a    = document.createElement('a');
  a.href     = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = `bookings-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}

window._adminConfirmBooking = async function(id) {
  if (!confirm('Mark this booking as confirmed?')) return;
  try {
    await updateDoc(doc(db, 'bookings', id), { status: 'confirmed' });
    window._adminLoadBookings();
  } catch(e) { alert('Error: ' + e.message); }
};

window._adminCancelBooking = async function(id) {
  if (!confirm('Cancel this booking?')) return;
  try {
    await updateDoc(doc(db, 'bookings', id), { status: 'cancelled' });
    window._adminLoadBookings();
  } catch(e) { alert('Error: ' + e.message); }
};

// ── Boot ─────────────────────────────────────────────────────
initAdmin();
