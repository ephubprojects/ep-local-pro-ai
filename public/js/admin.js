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
  query, where, orderBy, limit, onSnapshot, serverTimestamp, arrayUnion, arrayRemove
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
let _paymentMethodsData = { cashapp:{enabled:false,value:''}, zelle:{enabled:false,value:''}, card:{enabled:false,value:''}, financing:{enabled:false,value:'',adminEnabled:false} };
let _allUsersForFinancing = [];
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
  if (cat.emoji?.startsWith('http') || cat.emoji?.startsWith('data:')) {
    return `<img src="${cat.emoji}" style="width:18px;height:18px;vertical-align:middle;object-fit:contain;border-radius:3px;"> ${escHTML(cat.name)}`;
  }
  return `${cat.emoji} ${escHTML(cat.name)}`;
}

// ── Resize image file → Blob ──────────────────────────────────
function resizeToBlob(file, w, h, mime = 'image/webp', q = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = e => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), mime, q);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

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
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png', 0.9);
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

      // Load biz info fields + cache for doc pre-fill
      _adminBizProfile = { bizName: od.bizName || '', bizAddress: od.bizAddress || '', bizPhone: od.bizPhone || '', bizEmail: od.bizEmail || '', bizLogoUrl: od.photoURL || '' };
      // Fallback: seed from calendar config if profile biz info not yet saved
      if (!_adminBizProfile.bizName) {
        try {
          const calSnap = await getDoc(doc(db, 'config', 'calendar'));
          if (calSnap.exists()) {
            const firstBiz = calSnap.data().businesses?.[0] || {};
            _adminBizProfile.bizName    = firstBiz.name             || '';
            _adminBizProfile.bizPhone   = firstBiz.profile?.phone   || '';
            _adminBizProfile.bizLogoUrl = _adminBizProfile.bizLogoUrl || firstBiz.profile?.photoUrl || '';
          }
        } catch (_) {}
      }
      const sbn = document.getElementById('settingBizName');
      const sba = document.getElementById('settingBizAddress');
      const sbph = document.getElementById('settingBizPhone');
      const sbem = document.getElementById('settingBizEmail');
      if (sbn)  sbn.value  = od.bizName    || _adminBizProfile.bizName    || '';
      if (sba)  sba.value  = od.bizAddress || '';
      if (sbph) sbph.value = od.bizPhone   || _adminBizProfile.bizPhone   || '';
      if (sbem) sbem.value = od.bizEmail   || '';

      // Load avatar
      _profileSetAvatar(od.photoURL || '', (od.firstName || '') + ' ' + (od.lastName || ''));

      // Load payment methods into form
      if (od.paymentMethods) {
        _paymentMethodsData = od.paymentMethods;
        _populatePaymentMethodsForm(od.paymentMethods);
      }

      // AI Help FAB
      if (od.aiSupport === true) _aiInitSupport();

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
  _initAdminLeadsBadge();

  // Wire up nav
  document.querySelectorAll('[data-nav]').forEach(link => {
    link.addEventListener('click', () => {
      const name = link.dataset.nav;
      showSection(name);
      closeSidebar();
      if (name === 'demos')          loadDemos();
      if (name === 'businesses')     loadBusinesses();
      if (name === 'users')          loadUsers();
      if (name === 'localBusiness')   loadLocalBiz();
      if (name === 'material-search') _msLoadUsers();
      if (name === 'categories')     renderCategoriesSection();
      if (name === 'documents')      loadAdminDocuments();
      if (name === 'financing')      loadFinancingTab();
      if (name === 'gmb')            loadGmbRequests();
      if (name === 'leads')          loadLeads();
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
      const blob = await resizeCatIcon(file);
      const snap = await uploadBytes(storageRef(storage, `categories/icons/${Date.now()}`), blob, { contentType: 'image/png' });
      const url  = await getDownloadURL(snap.ref);
      setCatIcon(url);
    } catch (err) { showToast('Failed to upload icon: ' + (err.message || err), 'error'); }
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
    documents:     'Documents',
    financing:     'Financing',
    calendar:      'Calendar',
    'market-rate':     'Market Rate Calculator',
    'material-search': 'Material Pricing Search',
    profile:           'My Profile',
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
  if (name === 'demos')        { loadDemos(); window._adminLoadDemoRequests(); }
  if (name === 'businesses')   loadBusinesses();
  if (name === 'settings')     { loadSettings(); adminLoadFinancingUsers(); }
  if (name === 'calendar')     { loadCalendarConfig(); window._adminLoadBookings(); }
  if (name === 'market-rate')  _mrRenderHistory(document.getElementById('mrHistoryAdmin'), (svc, cty) => {
    const s = document.getElementById('mrServiceAdmin');
    const c = document.getElementById('mrCityAdmin');
    if (s) s.value = svc;
    if (c) c.value = cty;
    window._mrGetRatesAdmin();
  });
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
  // Always restore scroll — the doc-creator sets overflow:hidden on open
  document.body.style.overflow = '';
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
  tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><div class="empty-state-icon">⏳</div><p>Loading…</p></div></td></tr>`;
  try {
    const snap = await getDocs(query(collection(db, 'owners'), orderBy('createdAt', 'desc')));
    _allUsers = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(u => (u.acctType || 'personal') === 'personal');
    if (countEl) countEl.textContent = `${_allUsers.length} user${_allUsers.length !== 1 ? 's' : ''}`;
    renderUsersTable(_allUsers);
  } catch (err) {
    console.error('loadUsers error:', err);
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><p>Error loading users. Publish Firestore rules first.</p></div></td></tr>`;
  }
}

function renderUsersTable(users) {
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;
  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><div class="empty-state-icon">👥</div><p>No users yet.</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = users.map(u => {
    const aiOn = u.aiSupport === true;
    return `
    <tr>
      <td>${escHTML(((u.firstName || '') + ' ' + (u.lastName || '')).trim() || '—')}</td>
      <td class="cell-mono">${escHTML(u.username || '—')}</td>
      <td>${escHTML(u.email || '—')}</td>
      <td>${escHTML(u.phone || '—')}</td>
      <td>${escHTML(u.sponsorUsername || '—')}</td>
      <td>${badgeHTML(u.plan || 'trial')}</td>
      <td>${escHTML(fmtDate(u.createdAt))}</td>
      <td style="text-align:center;">
        <button class="btn-action ${aiOn ? 'success' : ''}" style="min-width:60px"
          onclick="window._adminToggleAiSupport('${escAttr(u.id)}', ${!aiOn})">
          ${aiOn ? 'ON' : 'OFF'}
        </button>
      </td>
      <td><button class="btn-action danger" onclick="window._adminCancelUser('${escAttr(u.id)}','${escAttr(((u.firstName||'')+' '+(u.lastName||'')).trim()||u.email||'this user')}')">Cancel</button></td>
    </tr>`;
  }).join('');
}

window._adminToggleAiSupport = async function(uid, enable) {
  try {
    await updateDoc(doc(db, 'owners', uid), { aiSupport: enable });
    const aiRef = doc(db, 'config', 'aiAccess');
    if (enable) {
      await setDoc(aiRef, { enabledUids: arrayUnion(uid) }, { merge: true });
    } else {
      await setDoc(aiRef, { enabledUids: arrayRemove(uid) }, { merge: true });
    }
    showToast(`AI Help ${enable ? 'enabled' : 'disabled'}`, 'success');
    await loadUsers();
  } catch (e) {
    console.error('toggleAiSupport error:', e);
    showToast('Could not update AI access', 'error');
  }
};

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
let _wtPackConfig = { pack250: 5.00, pack500: 10.00, pack1000: 20.00 };

async function _loadWtPackConfig() {
  try {
    const snap = await getDoc(doc(db, 'config', 'wtMsgPacks'));
    if (snap.exists()) {
      const d = snap.data();
      _wtPackConfig = {
        pack250:  parseFloat(d.pack250)  || 5,
        pack500:  parseFloat(d.pack500)  || 10,
        pack1000: parseFloat(d.pack1000) || 20,
      };
    }
    const i250  = document.getElementById('wtPack250Price');
    const i500  = document.getElementById('wtPack500Price');
    const i1000 = document.getElementById('wtPack1000Price');
    if (i250)  i250.value  = _wtPackConfig.pack250.toFixed(2);
    if (i500)  i500.value  = _wtPackConfig.pack500.toFixed(2);
    if (i1000) i1000.value = _wtPackConfig.pack1000.toFixed(2);
  } catch(e) {
    console.warn('Could not load WT pack config:', e);
  }
}


window._adminSaveWtPackPrices = async function() {
  const p250  = parseFloat(document.getElementById('wtPack250Price')?.value)  || 5;
  const p500  = parseFloat(document.getElementById('wtPack500Price')?.value)  || 10;
  const p1000 = parseFloat(document.getElementById('wtPack1000Price')?.value) || 20;
  try {
    await setDoc(doc(db, 'config', 'wtMsgPacks'), { pack250: p250, pack500: p500, pack1000: p1000 }, { merge: true });
    _wtPackConfig = { pack250: p250, pack500: p500, pack1000: p1000 };
    const statusEl = document.getElementById('wtPackSaveStatus');
    if (statusEl) { statusEl.style.display = 'block'; setTimeout(() => { statusEl.style.display = 'none'; }, 2500); }
    showToast('Message pack prices saved ✓', 'success');
  } catch(e) {
    console.error('Save pack prices error:', e);
    showToast('Could not save prices.', 'error');
  }
};

async function loadLocalBiz() {
  const tbody   = document.getElementById('localBizTableBody');
  const countEl = document.getElementById('localBizCount');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div class="empty-state-icon">⏳</div><p>Loading…</p></div></td></tr>`;
  _loadWtPackConfig();
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
    const cat    = CAT_MAP[u.categoryId] || {};
    const mrOn   = u.addOns?.marketRate === true;
    const wtPlan = u.addOns?.wtPlan || 'starter';
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
      <td>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;">
          <label class="addon-toggle" title="Market Rate Calculator add-on" style="flex-shrink:0;">
            <input type="checkbox" ${mrOn ? 'checked' : ''} onchange="window._adminToggleMarketRate('${escAttr(u.id)}', ${mrOn})"/>
            <span class="toggle-track"></span>
            <span class="toggle-label" style="font-size:0.7rem;">📊 MktRate</span>
          </label>
          <span style="color:#e2e8f0;font-size:0.8rem;">|</span>
          <select style="font-size:0.72rem;border:1.5px solid #c7d2fe;border-radius:6px;padding:3px 6px;background:#f8fafc;cursor:pointer;color:#4f46e5;font-weight:700;max-width:170px;" onchange="window._adminSetWtPlan('${escAttr(u.id)}', this.value)">
            <option value="starter" ${wtPlan === 'starter' ? 'selected' : ''}>⭐ Live Premium · $49.99</option>
            <option value="pro"     ${wtPlan === 'pro'     ? 'selected' : ''}>🚀 Live Stream · $279.99</option>
          </select>
          <button style="font-size:0.7rem;padding:3px 8px;border:1.5px solid #c7d2fe;border-radius:6px;cursor:pointer;background:#eef2ff;color:#4f46e5;font-weight:700;white-space:nowrap;" onclick="window._adminAddWtMsgs('${escAttr(u.id)}','${escAttr(u.companyName || u.email || 'Business')}')">+Msgs</button>
          <span style="font-size:0.7rem;color:#64748b;white-space:nowrap;">🎥 ${wtPlan === 'pro' ? '200' : '100'} att.</span>
        </div>
      </td>
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

window._adminToggleMarketRate = async function(uid, currentVal) {
  const newVal = !currentVal;
  try {
    await updateDoc(doc(db, 'owners', uid), { 'addOns.marketRate': newVal, updatedAt: serverTimestamp() });
    const idx = _allLocalBiz.findIndex(u => u.id === uid);
    if (idx !== -1) {
      _allLocalBiz[idx].addOns = { ...(_allLocalBiz[idx].addOns || {}), marketRate: newVal };
      renderLocalBizTable(_allLocalBiz);
    }
    showToast(`Market Rate add-on ${newVal ? 'enabled ✓' : 'disabled'}`, newVal ? 'success' : 'info');
  } catch (e) {
    console.error('Toggle market rate error:', e);
    showToast('Could not update add-on.', 'error');
  }
};

window._adminSetWtPlan = async function(uid, plan) {
  const cap = plan === 'pro' ? 200 : 100;
  const planLabel = plan === 'pro' ? 'EP HUB LIVE STREAM · $279.99 · 2,000 msgs · 200 attendees'
                                   : 'EP HUB Live Premium · $49.99 · 1,000 msgs · 100 attendees';
  try {
    await updateDoc(doc(db, 'owners', uid), { 'addOns.wtPlan': plan, 'addOns.liveCap': cap, updatedAt: serverTimestamp() });
    const idx = _allLocalBiz.findIndex(u => u.id === uid);
    if (idx !== -1) _allLocalBiz[idx].addOns = { ...(_allLocalBiz[idx].addOns || {}), wtPlan: plan, liveCap: cap };
    renderLocalBizTable(_allLocalBiz);
    showToast(`Plan set: ${planLabel} ✓`, 'success');
  } catch (e) {
    console.error('_adminSetWtPlan error:', e);
    showToast('Could not update plan.', 'error');
  }
};

window._adminAddWtMsgs = function(uid, bizName) {
  const modal    = document.getElementById('wtPackModal');
  const bizNameEl = document.getElementById('wtPackModalBizName');
  const cardsEl  = document.getElementById('wtPackCards');
  if (!modal || !cardsEl) return;

  bizNameEl.textContent = `Business: ${bizName}`;

  const packs = [
    { msgs: 250,  price: _wtPackConfig.pack250,  label: '250 Messages' },
    { msgs: 500,  price: _wtPackConfig.pack500,  label: '500 Messages' },
    { msgs: 1000, price: _wtPackConfig.pack1000, label: '1,000 Messages' },
  ];

  cardsEl.innerHTML = packs.map(p => `
    <button
      onclick="window._adminConfirmWtPack('${uid}','${bizName.replace(/'/g, '&apos;')}',${p.msgs},${p.price.toFixed(2)})"
      style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border:1.5px solid #e2e8f0;border-radius:10px;background:#f8fafc;cursor:pointer;font-family:inherit;width:100%;text-align:left;transition:border-color .15s,background .15s;"
      onmouseover="this.style.borderColor='#818cf8';this.style.background='#eef2ff';"
      onmouseout="this.style.borderColor='#e2e8f0';this.style.background='#f8fafc';">
      <div>
        <div style="font-size:0.95rem;font-weight:800;color:#1a1a1a;">📦 ${p.label}</div>
        <div style="font-size:0.75rem;color:#64748b;margin-top:2px;">Add ${p.msgs.toLocaleString()} WT messages to monthly allowance</div>
      </div>
      <div style="font-size:1.1rem;font-weight:900;color:#4f46e5;white-space:nowrap;margin-left:12px;">$${p.price.toFixed(2)}</div>
    </button>
  `).join('');

  modal.style.display = 'flex';
};

window._adminCloseWtModal = function() {
  const modal = document.getElementById('wtPackModal');
  if (modal) modal.style.display = 'none';
};

window._adminConfirmWtPack = async function(uid, bizName, msgs, price) {
  if (!confirm(`Add ${msgs.toLocaleString()} messages to ${bizName} for $${parseFloat(price).toFixed(2)}?`)) return;
  window._adminCloseWtModal();
  try {
    const bizQ = await getDocs(query(collection(db, 'businesses'), where('ownerId', '==', uid), limit(1)));
    if (bizQ.empty) { showToast('No business found for this owner', 'error'); return; }
    const bizRef = bizQ.docs[0].ref;
    const currentExtra = bizQ.docs[0].data().wtMsgExtra || 0;
    await updateDoc(bizRef, { wtMsgExtra: currentExtra + msgs, updatedAt: serverTimestamp() });
    showToast(`Added ${msgs.toLocaleString()} extra WT messages for ${bizName} ✓`, 'success');
  } catch (e) {
    console.error('_adminConfirmWtPack error:', e);
    showToast('Could not add messages.', 'error');
  }
};

window._adminSetLiveCap = async function(uid, cap) {
  try {
    await updateDoc(doc(db, 'owners', uid), { 'addOns.liveCap': cap, updatedAt: serverTimestamp() });
    const idx = _allLocalBiz.findIndex(u => u.id === uid);
    if (idx !== -1) _allLocalBiz[idx].addOns = { ...(_allLocalBiz[idx].addOns || {}), liveCap: cap };
    showToast(cap ? `Live cap set to ${cap} attendees ✓` : 'Live cap removed', 'success');
  } catch (e) {
    console.error('_adminSetLiveCap error:', e);
    showToast('Could not update live cap.', 'error');
  }
};

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
  const firstName  = document.getElementById('settingFirstName')?.value.trim()  || '';
  const lastName   = document.getElementById('settingLastName')?.value.trim()   || '';
  const phone      = document.getElementById('settingPhone')?.value.trim()      || '';
  const bizName    = document.getElementById('settingBizName')?.value.trim()    || '';
  const bizAddress = document.getElementById('settingBizAddress')?.value.trim() || '';
  const bizPhone   = document.getElementById('settingBizPhone')?.value.trim()   || '';
  const bizEmail   = document.getElementById('settingBizEmail')?.value.trim()   || '';

  try {
    if (currentUser) {
      await updateDoc(doc(db, 'owners', currentUser.uid), {
        firstName, lastName, phone,
        name: `${firstName} ${lastName}`.trim(),
        bizName, bizAddress, bizPhone, bizEmail,
        updatedAt: serverTimestamp()
      });
    }
    // Update cache so next new doc immediately uses the new values
    _adminBizProfile = { bizName, bizAddress, bizPhone, bizEmail, bizLogoUrl: _adminBizProfile.bizLogoUrl || '' };
    // Update avatar name label live
    _profileSetAvatarName(`${firstName} ${lastName}`.trim());
    showToast('Profile saved', 'success');
  } catch (err) {
    console.error('saveProfile error:', err);
    showToast('Error saving profile', 'error');
  }
}

// ── Profile avatar helpers ────────────────────────────────────
function _profileSetAvatar(url, name) {
  const img  = document.getElementById('profileAvatarImg');
  const ph   = document.getElementById('profileAvatarPlaceholder');
  const rmBtn = document.getElementById('profileAvatarRemoveBtn');
  _profileSetAvatarName(name);
  if (url) {
    if (img) { img.src = url; img.style.display = 'block'; }
    if (ph)  ph.style.display = 'none';
    if (rmBtn) rmBtn.style.display = 'inline-block';
  } else {
    if (img) img.style.display = 'none';
    if (ph)  ph.style.display = 'flex';
    if (rmBtn) rmBtn.style.display = 'none';
  }
}

function _profileSetAvatarName(name) {
  const el = document.getElementById('profileAvatarName');
  if (el) el.textContent = name || '—';
}

document.getElementById('profileAvatarInput')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file || !currentUser) return;
  const wrap = document.getElementById('profileAvatarWrap');
  wrap?.classList.add('profile-avatar-uploading');
  try {
    const path = `owners/${currentUser.uid}/avatar`;
    const snap = await uploadBytes(storageRef(storage, path), file);
    const url  = await getDownloadURL(snap.ref);
    await updateDoc(doc(db, 'owners', currentUser.uid), { photoURL: url, updatedAt: serverTimestamp() });
    _adminBizProfile.bizLogoUrl = url;
    _profileSetAvatar(url, document.getElementById('profileAvatarName')?.textContent || '');
    showToast('Photo updated', 'success');
  } catch (err) {
    console.error('Avatar upload error:', err);
    showToast('Upload failed', 'error');
  } finally {
    wrap?.classList.remove('profile-avatar-uploading');
    e.target.value = '';
  }
});

document.getElementById('profileAvatarRemoveBtn')?.addEventListener('click', async () => {
  if (!currentUser) return;
  if (!confirm('Remove your profile photo?')) return;
  try {
    await updateDoc(doc(db, 'owners', currentUser.uid), { photoURL: '', updatedAt: serverTimestamp() });
    _profileSetAvatar('', document.getElementById('profileAvatarName')?.textContent || '');
    showToast('Photo removed', 'success');
  } catch (err) {
    showToast('Error removing photo', 'error');
  }
});

function _populatePaymentMethodsForm(methods) {
  if (!methods) return;
  ['cashapp','zelle','card','financing'].forEach(k => {
    const key = k.charAt(0).toUpperCase() + k.slice(1);
    const cb  = document.getElementById(`pm${key}Enabled`);
    const inp = document.getElementById(`pm${key}Value`);
    if (cb)  cb.checked = !!(methods[k]?.enabled);
    if (inp) inp.value  = methods[k]?.value || '';
  });
  const finRow = document.getElementById('pmFinancingRow');
  if (finRow) finRow.style.display = methods.financing?.adminEnabled ? '' : 'none';
}

async function savePaymentMethods() {
  const btn = document.getElementById('savePaymentMethodsBtn');
  const orig = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving…'; }
  try {
    const methods = {
      cashapp:   { enabled: document.getElementById('pmCashappEnabled')?.checked   || false, value: document.getElementById('pmCashappValue')?.value.trim()   || '' },
      zelle:     { enabled: document.getElementById('pmZelleEnabled')?.checked     || false, value: document.getElementById('pmZelleValue')?.value.trim()     || '' },
      card:      { enabled: document.getElementById('pmCardEnabled')?.checked      || false, value: document.getElementById('pmCardValue')?.value.trim()      || '' },
      financing: { enabled: document.getElementById('pmFinancingEnabled')?.checked || false, value: document.getElementById('pmFinancingValue')?.value.trim() || '', adminEnabled: _paymentMethodsData.financing?.adminEnabled || false }
    };
    await updateDoc(doc(db, 'owners', currentUser.uid), { paymentMethods: methods, updatedAt: serverTimestamp() });
    _paymentMethodsData = methods;
    showToast('Payment methods saved ✓', 'success');
  } catch (err) {
    console.error('savePaymentMethods:', err);
    showToast('Error saving payment methods', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

function _buildPaymentBlockHtml() {
  const methods = _paymentMethodsData;
  if (!methods) return '';
  const PM_CFG = {
    cashapp:   { icon:'💚', label:'Pay with CashApp', bg:'#00c244', color:'#000', href: v => v.startsWith('http') ? v : `https://cash.app/${v.startsWith('$')?v:'$'+v}` },
    zelle:     { icon:'💜', label:'Send via Zelle',   bg:'#6b1fbf', color:'#fff', href: v => v.startsWith('http') ? v : null },
    card:      { icon:'💳', label:'Pay by Card',      bg:'#1a56db', color:'#fff', href: v => v.startsWith('http') ? v : null },
    financing: { icon:'🏦', label:'Apply Financing',  bg:'#ea580c', color:'#fff', href: v => v.startsWith('http') ? v : null }
  };
  const btns = [];
  for (const [key, cfg] of Object.entries(PM_CFG)) {
    const m = methods[key];
    if (!m?.enabled || !m?.value) continue;
    if (key === 'financing' && !m.adminEnabled) continue;
    const link = cfg.href(m.value);
    const style = `display:inline-flex;align-items:center;gap:7px;padding:10px 20px;background:${cfg.bg};color:${cfg.color};border-radius:8px;font-size:0.82rem;font-weight:700;text-decoration:none;letter-spacing:.01em;`;
    btns.push(link
      ? `<a href="${_esc(link)}" target="_blank" rel="noopener" style="${style}">${cfg.icon} ${cfg.label}</a>`
      : `<span style="${style}">${cfg.icon} ${cfg.label}: ${_esc(m.value)}</span>`);
  }
  return btns.join('');
}

// ── Admin: Financing Gateway ──────────────────────────────────
async function adminLoadFinancingUsers() {
  const tbody = document.getElementById('financingUsersBody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p>⏳ Loading…</p></div></td></tr>`;
  try {
    const snap = await getDocs(query(collection(db, 'owners'), orderBy('createdAt', 'desc')));
    _allUsersForFinancing = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(u => (u.acctType || 'personal') === 'personal');
    renderFinancingUsersTable(_allUsersForFinancing);
  } catch (err) {
    console.error('adminLoadFinancingUsers:', err);
    tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p>Error loading users.</p></div></td></tr>`;
  }
}

function renderFinancingUsersTable(users) {
  const tbody = document.getElementById('financingUsersBody');
  if (!tbody) return;
  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p>No users yet.</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = users.map(u => {
    const on = u.paymentMethods?.financing?.adminEnabled || false;
    return `<tr>
      <td>${escHTML(((u.firstName||'')+' '+(u.lastName||'')).trim()||'—')}</td>
      <td class="cell-mono">${escHTML(u.username||'—')}</td>
      <td>${escHTML(u.email||'—')}</td>
      <td style="text-align:center;">
        <label class="pm-toggle-label">
          <input type="checkbox" class="pm-toggle-input" ${on?'checked':''} onchange="adminToggleFinancing('${escAttr(u.id)}',this.checked)"/>
          <span class="pm-toggle-track"><span class="pm-toggle-thumb"></span></span>
        </label>
      </td>
    </tr>`;
  }).join('');
}

async function adminToggleFinancing(uid, enabled) {
  try {
    const ref = doc(db, 'owners', uid);
    const snap = await getDoc(ref);
    const existing = snap.exists() ? (snap.data().paymentMethods || {}) : {};
    await updateDoc(ref, { paymentMethods: { ...existing, financing: { ...(existing.financing||{}), adminEnabled: enabled } } });
    const u = _allUsersForFinancing.find(x => x.id === uid);
    if (u) { if (!u.paymentMethods) u.paymentMethods = {}; if (!u.paymentMethods.financing) u.paymentMethods.financing = {}; u.paymentMethods.financing.adminEnabled = enabled; }
    showToast(`Financing ${enabled?'enabled':'disabled'}`, 'success');
  } catch (err) {
    console.error('adminToggleFinancing:', err);
    showToast('Error updating financing', 'error');
  }
}

async function adminToggleFinancingAll(enabled) {
  if (!_allUsersForFinancing.length) await adminLoadFinancingUsers();
  if (!confirm(`${enabled?'Enable':'Disable'} financing for all ${_allUsersForFinancing.length} user(s)?`)) return;
  try {
    await Promise.all(_allUsersForFinancing.map(async u => {
      const ref = doc(db, 'owners', u.id);
      const snap = await getDoc(ref);
      const existing = snap.exists() ? (snap.data().paymentMethods || {}) : {};
      return updateDoc(ref, { paymentMethods: { ...existing, financing: { ...(existing.financing||{}), adminEnabled: enabled } } });
    }));
    await adminLoadFinancingUsers();
    showToast(`Financing ${enabled?'enabled':'disabled'} for all users`, 'success');
  } catch (err) {
    console.error('adminToggleFinancingAll:', err);
    showToast('Error updating financing for all users', 'error');
  }
}

// ── Per-document financing toggle ─────────────────────────────
window._searchFinDocs = async function() {
  const q       = (document.getElementById('finDocSearch')?.value || '').trim();
  const results = document.getElementById('finDocResults');
  if (!results || !q) return;
  results.innerHTML = '<p style="color:#64748b;font-size:0.85rem;padding:8px 0">Searching…</p>';
  try {
    const snap1 = await getDocs(query(
      collection(db, 'documents'),
      where('custName', '>=', q),
      where('custName', '<=', q + ''),
      limit(20)
    ));
    const snap2 = await getDocs(query(
      collection(db, 'documents'),
      where('docNumber', '==', q),
      limit(5)
    ));
    const seen = new Set();
    const docs = [...snap1.docs, ...snap2.docs]
      .filter(d => { if (seen.has(d.id)) return false; seen.add(d.id); return true; })
      .map(d => ({ id: d.id, ...d.data() }));
    renderFinDocResults(docs);
  } catch(e) {
    console.error('_searchFinDocs error:', e);
    results.innerHTML = '<p style="color:#ef4444;font-size:0.85rem;">Error searching. Check Firestore indexes and try again.</p>';
  }
};

function renderFinDocResults(docs) {
  const results = document.getElementById('finDocResults');
  if (!results) return;
  if (!docs.length) {
    results.innerHTML = '<p style="color:#64748b;font-size:0.85rem;padding:8px 0">No documents found. Names are case-sensitive — try capitalizing the first letter.</p>';
    return;
  }
  const rows = docs.map(d => {
    const on = d.financingEnabled === true;
    return `<tr>
      <td>${escHTML((d.type||'').replace(/^\w/,c=>c.toUpperCase()))}</td>
      <td>${escHTML(d.custName||'—')}</td>
      <td>${escHTML(d.docNumber||'—')}</td>
      <td>${escHTML(d.docDate||fmtDate(d.createdAt))}</td>
      <td style="text-align:center;">
        <button class="btn-action ${on?'success':''}" style="min-width:60px"
          onclick="window._toggleDocFinancing('${escAttr(d.id)}',${!on})">
          ${on?'ON':'OFF'}
        </button>
      </td>
    </tr>`;
  }).join('');
  results.innerHTML = `
    <div class="admin-table-wrap" style="max-height:300px;overflow-y:auto;margin-top:4px;">
      <table class="admin-table">
        <thead><tr><th>Type</th><th>Customer</th><th>Doc #</th><th>Date</th><th style="text-align:center;">Financing</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

window._toggleDocFinancing = async function(docId, enable) {
  try {
    const cfgSnap = await getDoc(doc(db, 'config', 'financing'));
    const finUrl  = cfgSnap.data()?.url || '';
    if (enable && !finUrl) {
      showToast('Set the Prequalification Form URL above and Save Settings first.', 'error');
      return;
    }
    await updateDoc(doc(db, 'documents', docId), {
      financingEnabled: enable,
      financingUrl: enable ? finUrl : ''
    });
    showToast(`Financing ${enable ? 'enabled' : 'disabled'}`, 'success');
    window._searchFinDocs();
  } catch(e) {
    console.error('_toggleDocFinancing error:', e);
    showToast('Could not update financing', 'error');
  }
};

// ── Financing Tab ─────────────────────────────────────────────
async function loadFinancingTab() {
  const reqBody     = document.getElementById('finRequestsBody');
  const reqCount    = document.getElementById('finRequestCount');
  const enCount     = document.getElementById('finEnabledCount');
  if (!reqBody) return;

  reqBody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>⏳ Loading…</p></div></td></tr>`;

  try {
    // Load requests (financingRequested=true) and enabled (financingEnabled=true) in parallel
    const [reqSnap, enSnap] = await Promise.all([
      getDocs(query(collection(db, 'documents'), where('financingRequested', '==', true), limit(100))),
      getDocs(query(collection(db, 'documents'), where('financingEnabled',   '==', true), limit(100)))
    ]);

    const requests = reqSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const enabled  = enSnap.docs.map(d => d.id);

    if (reqCount) reqCount.textContent = requests.length;
    if (enCount)  enCount.textContent  = enabled.length;

    if (!requests.length) {
      reqBody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="empty-state-icon">🎉</div><p>No pending requests.</p></div></td></tr>`;
      return;
    }

    reqBody.innerHTML = requests.map(d => {
      const finOn   = d.financingEnabled === true;
      const reqDate = d.financingRequestedAt?.toDate?.()?.toLocaleDateString() || fmtDate(d.createdAt);
      const name    = d.finRequestName  || d.custName  || '—';
      const email   = d.finRequestEmail || d.custEmail || '—';
      const phone   = d.finRequestPhone || d.custPhone || '—';
      return `<tr>
        <td>${escHTML((d.type||'').replace(/^\w/,c=>c.toUpperCase()))}</td>
        <td>${escHTML(name)}</td>
        <td>${escHTML(email)}</td>
        <td>${escHTML(phone)}</td>
        <td>${escHTML(d.docNumber||'—')}</td>
        <td style="white-space:nowrap;color:#f59e0b;font-weight:600;">🔔 ${reqDate}</td>
        <td style="text-align:center;">
          <button class="btn-action ${finOn?'success':''}" style="min-width:60px"
            onclick="window._toggleDocFinancing('${escAttr(d.id)}',${!finOn});loadFinancingTab();">
            ${finOn?'ON':'OFF'}
          </button>
        </td>
      </tr>`;
    }).join('');
  } catch(e) {
    console.error('loadFinancingTab error:', e);
    if (reqBody) reqBody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>Error loading. Try again.</p></div></td></tr>`;
  }
}

window._searchFinTab = async function() {
  const q       = (document.getElementById('finTabSearch')?.value || '').trim();
  const results = document.getElementById('finTabResults');
  if (!results || !q) return;
  results.innerHTML = '<p style="color:#64748b;font-size:0.85rem;padding:8px 0">Searching…</p>';
  try {
    const snap1 = await getDocs(query(
      collection(db, 'documents'),
      where('custName', '>=', q),
      where('custName', '<=', q + ''),
      limit(20)
    ));
    const snap2 = await getDocs(query(
      collection(db, 'documents'),
      where('docNumber', '==', q),
      limit(5)
    ));
    const seen = new Set();
    const docs = [...snap1.docs, ...snap2.docs]
      .filter(d => { if (seen.has(d.id)) return false; seen.add(d.id); return true; })
      .map(d => ({ id: d.id, ...d.data() }));

    if (!docs.length) {
      results.innerHTML = '<p style="color:#64748b;font-size:0.85rem;padding:8px 0">No documents found. Names are case-sensitive.</p>';
      return;
    }
    const rows = docs.map(d => {
      const on  = d.financingEnabled === true;
      const req = d.financingRequested === true;
      return `<tr>
        <td>${escHTML((d.type||'').replace(/^\w/,c=>c.toUpperCase()))}</td>
        <td>${escHTML(d.custName||'—')} ${req?'<span style="color:#f59e0b;font-size:0.75rem;font-weight:700;">🔔 Requested</span>':''}</td>
        <td>${escHTML(d.docNumber||'—')}</td>
        <td>${escHTML(d.docDate||fmtDate(d.createdAt))}</td>
        <td style="text-align:center;">
          <button class="btn-action ${on?'success':''}" style="min-width:60px"
            onclick="window._toggleDocFinancing('${escAttr(d.id)}',${!on})">
            ${on?'ON':'OFF'}
          </button>
        </td>
      </tr>`;
    }).join('');
    results.innerHTML = `
      <div class="admin-table-wrap" style="max-height:300px;overflow-y:auto;margin-top:4px;">
        <table class="admin-table">
          <thead><tr><th>Type</th><th>Customer</th><th>Doc #</th><th>Date</th><th style="text-align:center;">Financing</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch(e) {
    console.error('_searchFinTab error:', e);
    results.innerHTML = '<p style="color:#ef4444;font-size:0.85rem;">Error searching.</p>';
  }
};

window.loadFinancingTab = loadFinancingTab;

// Expose to global scope (required because admin.js loads as type="module")
window.savePaymentMethods   = savePaymentMethods;
window.adminToggleFinancing    = adminToggleFinancing;
window.adminToggleFinancingAll = adminToggleFinancingAll;

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
  const platformName  = document.getElementById('settingPlatformName')?.value.trim()  || '';
  const supportEmail  = document.getElementById('settingSupportEmail')?.value.trim()  || '';
  const demoAgentId   = document.getElementById('settingDemoAgentId')?.value.trim()   || '';
  const demoVoiceEn   = document.getElementById('settingDemoVoiceEn')?.value           || '';
  const demoVoiceEs   = document.getElementById('settingDemoVoiceEs')?.value           || '';
  const financingUrl  = document.getElementById('settingFinancingUrl')?.value.trim()  || '';

  try {
    if (currentUser) {
      await Promise.all([
        updateDoc(doc(db, 'owners', currentUser.uid), {
          platformName, supportEmail, demoAgentId, demoVoiceEn, demoVoiceEs, financingUrl,
          updatedAt: serverTimestamp()
        }),
        setDoc(doc(db, 'config', 'demo'), {
          demoAgentId, demoVoiceEn, demoVoiceEs,
          updatedAt: serverTimestamp()
        }),
        setDoc(doc(db, 'config', 'financing'), {
          url: financingUrl,
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
    if (sfn && d.platformName)  sfn.value = d.platformName;
    if (sse && d.supportEmail)  sse.value = d.supportEmail;
    if (sda && d.demoAgentId)   sda.value = d.demoAgentId;
    if (sde && d.demoVoiceEn)   sde.value = d.demoVoiceEn;
    if (sds && d.demoVoiceEs)   sds.value = d.demoVoiceEs;
    const sfu = document.getElementById('settingFinancingUrl');
    if (sfu && d.financingUrl)  sfu.value = d.financingUrl;
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
    const adminUid = auth.currentUser?.uid || '';
    const snap = await getDocs(query(collection(db, 'documents'), where('ownerUid', '==', adminUid), limit(300)));
    adminAllDocs = [];
    snap.forEach(d => adminAllDocs.push({ id: d.id, ...d.data() }));
    adminAllDocs.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
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

let _adminDocsSearchQ = '';

window._adminDocsSearch = function(q) {
  _adminDocsSearchQ = q.trim().toLowerCase();
  renderAdminDocCards();
};

function renderAdminDocCards() {
  const list = document.getElementById('adminDocsList');
  if (!list) return;

  let filtered = adminDocFilter === 'all'
    ? adminAllDocs
    : adminAllDocs.filter(d => d.type === adminDocFilter);

  if (_adminDocsSearchQ) {
    const q = _adminDocsSearchQ;
    filtered = filtered.filter(d =>
      (d.custName      || '').toLowerCase().includes(q) ||
      (d.customerName  || '').toLowerCase().includes(q) ||
      (d.docNumber     || '').toLowerCase().includes(q) ||
      (d.custPhone     || '').replace(/\D/g,'').includes(q.replace(/\D/g,''))
    );
  }

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📄</div><p>No documents found.</p></div>`;
    return;
  }

  const typeLabels = { invoice: 'Invoice', estimate: 'Estimate', contract: 'Contract', receipt: 'Receipt' };
  const badgeCls   = { invoice: 'badge-invoice', estimate: 'badge-estimate', contract: 'badge-contract', receipt: 'badge-receipt' };

  list.innerHTML = '';
  filtered.forEach(docData => {
    const typeLbl    = typeLabels[docData.type] || docData.type || '—';
    const badgeClass = badgeCls[docData.type] || '';
    let amountNum = Number(docData.amount) || 0;
    if (!amountNum && docData.items?.length) {
      const sub = docData.items.reduce((s,it)=>s+(it.price||0),0);
      amountNum = sub * (1 + (docData.taxRate||0)/100);
    }
    const amount    = amountNum ? `$${amountNum.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}` : '—';
    const custLabel = docData.customerName || docData.custName || '—';

    const st = docData.status || 'pending';
    const row = document.createElement('div');
    row.className = 'doc-row';
    row.innerHTML = `
      <div class="doc-row-bar stripe-${docData.type || ''}"></div>
      <div class="doc-row-type">
        <span class="badge ${badgeClass}">${typeLbl}</span>
        ${docData.docNumber ? `<span class="doc-row-num">${docData.docNumber}</span>` : ''}
      </div>
      <div class="doc-row-customer">${custLabel}</div>
      <div class="doc-row-date">${fmtDate(docData.createdAt)}</div>
      <div class="doc-row-amount">${amount}</div>
      <div class="doc-row-status">
        <button class="status-btn status-approved ${st === 'approved' ? 'active' : ''}" data-status-approve title="Mark Approved">✓ Approved</button>
        <button class="status-btn status-declined ${st === 'declined' ? 'active' : ''}" data-status-decline title="Mark Declined">✕ Declined</button>
      </div>
      <div class="doc-row-actions">
        ${docData.htmlContent ? `<button class="btn-action" data-view>👁 View</button>` : ''}
        <button class="btn-action" data-edit>✏️ Edit</button>
        ${docData.id ? `<button class="btn-action btn-action-share" data-share>📤 Share</button>` : ''}
        ${docData.id ? `<button class="btn-action btn-action-copy" data-copy>🔗 Copy Link</button>` : ''}
        ${(docData.type==='estimate'||docData.type==='contract') ? `<button class="btn-action btn-action-sign" data-sign title="${docData.ownerSig ? 'Re-sign / View Signature' : 'Owner: Sign Document'}">✍️ Sign</button>` : ''}
        <button class="btn-action btn-action-del" data-del>🗑 Delete</button>
      </div>`;

    if (docData.htmlContent) {
      row.querySelector('[data-view]')?.addEventListener('click', () => window._docViewDoc(docData.id));
    }
    row.querySelector('[data-edit]')?.addEventListener('click', () => window._docEditDoc(docData.id));
    row.querySelector('[data-share]')?.addEventListener('click', () => {
      const viewUrl = `${window.location.origin}/view.html?id=${docData.id}`;
      _docShowShareModal(viewUrl, docData.docNumber, docData.type);
    });
    row.querySelector('[data-copy]')?.addEventListener('click', (e) => {
      const btn = e.currentTarget;
      const url = `${window.location.origin}/view.html?id=${docData.id}`;
      navigator.clipboard.writeText(url).then(() => {
        btn.textContent = '✓ Copied!';
        btn.style.color = '#16a34a';
        setTimeout(() => { btn.textContent = '🔗 Copy Link'; btn.style.color = ''; }, 2000);
      }).catch(() => alert('Could not copy to clipboard.'));
    });
    row.querySelector('[data-sign]')?.addEventListener('click', () => window._docOwnerSign(docData.id));
    row.querySelector('[data-del]')?.addEventListener('click',  () => window._docDeleteDoc(docData.id));
    row.querySelector('[data-status-approve]')?.addEventListener('click', () => window._docSetStatus(docData.id, st === 'approved' ? 'pending' : 'approved'));
    row.querySelector('[data-status-decline]')?.addEventListener('click', () => window._docSetStatus(docData.id, st === 'declined' ? 'pending' : 'declined'));
    list.appendChild(row);
  });
}

window._docSetStatus = async function(docId, newStatus) {
  if (!docId) return;
  try {
    await updateDoc(doc(db, 'documents', docId), { status: newStatus, updatedAt: serverTimestamp() });
    const idx = adminAllDocs.findIndex(d => d.id === docId);
    if (idx !== -1) {
      adminAllDocs[idx].status = newStatus;
      renderAdminDocCards();
    }
  } catch (e) {
    console.error('Status update failed:', e);
    showToast('Could not update status.', 'error');
  }
};

function _sigInjectInFrame(iframe, data) {
  try {
    const fdoc = iframe.contentDocument;
    if (!fdoc) return;
    const toDate = v => v?.toDate ? v.toDate() : (v ? new Date(v) : null);
    const fmtD   = d => d ? d.toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}) : '';
    const html   = (name, date, ip, consented) =>
      `<div style="font-family:Georgia,serif;font-size:22pt;font-style:italic;font-weight:bold;color:#15803d;line-height:1.1;">${name}</div>` +
      `<div style="font-size:0.62rem;color:#94a3b8;margin-top:3px;">Signed ${fmtD(date)}${ip?' · IP: '+ip:''}</div>` +
      (consented
        ? `<div style="display:inline-flex;align-items:center;gap:5px;margin-top:6px;padding:3px 8px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:20px;">` +
          `<span style="font-size:0.65rem;color:#15803d;">✅ Reviewed &amp; consented to terms</span></div>`
        : '');
    if (data.ownerSig?.name) {
      const el = fdoc.getElementById('ep-sig-owner');
      if (el) { el.style.borderBottom='none'; el.style.height='auto'; el.innerHTML=html(data.ownerSig.name,toDate(data.ownerSig.signedAt),'',data.ownerSig.consentGiven); }
    }
    if (data.customerSig?.name) {
      const el = fdoc.getElementById('ep-sig-client');
      if (el) { el.style.borderBottom='none'; el.style.height='auto'; el.innerHTML=html(data.customerSig.name,toDate(data.customerSig.signedAt),data.customerSig.ip||'',data.customerSig.consentGiven); }
    }
  } catch(_) {}
}

window._docOwnerSign = async function(docId) {
  const docData = adminAllDocs.find(d => d.id === docId);
  if (!docData) return;

  // Load fresh data for htmlContent + current sigs
  let snap, data;
  try { snap = await getDoc(doc(db,'documents',docId)); data = snap.data(); }
  catch(e) { alert('Could not load document: '+e.message); return; }

  const existing = data?.ownerSig;
  const typeLabel = (docData.type||'document').charAt(0).toUpperCase()+(docData.type||'document').slice(1);

  const overlay = document.createElement('div');
  overlay.id = '_ownerSignOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9999;display:flex;flex-direction:column;';
  overlay.innerHTML = `
    <div style="background:#0f172a;padding:12px 20px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;gap:12px;">
      <div style="color:#fff;font-weight:700;font-size:0.9rem;">✍️ Sign — ${typeLabel}${docData.docNumber?' #'+docData.docNumber:''}</div>
      <button id="_osc" style="background:rgba(255,255,255,.1);border:none;color:#fff;border-radius:6px;padding:5px 12px;font-size:0.82rem;cursor:pointer;">✕ Close</button>
    </div>
    <div style="flex:1;overflow-y:auto;background:#f1f5f9;" id="_osScroll">
      <iframe id="_osFrame" style="width:100%;border:none;display:block;" scrolling="no"></iframe>
      <div style="max-width:620px;margin:0 auto;padding:24px 16px 48px;">
        ${existing ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:12px 16px;margin-bottom:16px;font-size:0.82rem;color:#166534;">✅ Already signed by <strong>${existing.name}</strong> — you can update it below.</div>` : ''}
        <div style="background:#fff;border-radius:14px;padding:24px 24px 20px;box-shadow:0 4px 24px rgba(0,0,0,.08);">
          <div style="font-size:0.95rem;font-weight:800;color:#1e293b;margin-bottom:4px;">Owner / Business Signature</div>
          <div style="font-size:0.8rem;color:#64748b;margin-bottom:18px;">Review the document above, then type your full legal name and confirm your consent below.</div>
          <div style="font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:6px;">Full Legal Name</div>
          <input id="_osInp" type="text" placeholder="Type your name…" autocomplete="name"
            style="width:100%;padding:12px 16px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:1rem;outline:none;box-sizing:border-box;margin-bottom:14px;transition:border-color .15s;"
            value="${existing ? existing.name : ''}"/>
          <div style="background:#f8fafc;border-radius:10px;padding:14px 18px;min-height:60px;border:1.5px dashed #cbd5e1;margin-bottom:20px;display:flex;flex-direction:column;justify-content:flex-end;">
            <div id="_osPrev" style="font-family:Georgia,serif;font-size:26pt;font-style:italic;font-weight:bold;color:#15803d;line-height:1.1;">${existing ? existing.name : ''}</div>
            <div style="font-size:0.6rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-top:6px;">Signature Preview</div>
          </div>
          <label id="_osConsentWrap" style="display:flex;gap:12px;align-items:flex-start;padding:14px 16px;background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;cursor:pointer;margin-bottom:16px;transition:border-color .15s;">
            <input type="checkbox" id="_osConsent" style="margin-top:2px;width:16px;height:16px;accent-color:#15803d;flex-shrink:0;cursor:pointer;"/>
            <span style="font-size:0.8rem;color:#475569;line-height:1.6;">
              I have reviewed this <strong>${typeLabel}</strong> and agree to the described scope, pricing, and terms.
              I declare my consent to proceed and understand that this electronic signature is legally binding
              under the ESIGN Act and UETA.
            </span>
          </label>
          <button id="_osConfirm" disabled style="width:100%;background:#94a3b8;color:#fff;border:none;border-radius:10px;padding:14px;font-size:0.95rem;font-weight:800;cursor:not-allowed;transition:background .15s;">✅ Sign Document</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  // Load document into iframe
  const iframe = document.getElementById('_osFrame');
  if (data?.htmlContent) {
    iframe.srcdoc = data.htmlContent;
    iframe.onload = () => {
      _sigInjectInFrame(iframe, data);
      try { const h = iframe.contentDocument?.body?.scrollHeight; if (h>100) iframe.style.height=h+'px'; } catch(_) {}
      setTimeout(() => {
        try { const h = iframe.contentDocument?.body?.scrollHeight; if (h>100) iframe.style.height=h+'px'; } catch(_) {}
      }, 600);
    };
  }

  const inp     = document.getElementById('_osInp');
  const prev    = document.getElementById('_osPrev');
  const consent = document.getElementById('_osConsent');
  const btn     = document.getElementById('_osConfirm');
  const wrap    = document.getElementById('_osConsentWrap');

  function _osUpdateBtn() {
    const ready = inp.value.trim() && consent.checked;
    btn.disabled = !ready;
    btn.style.background  = ready ? '#15803d' : '#94a3b8';
    btn.style.cursor      = ready ? 'pointer'  : 'not-allowed';
    wrap.style.borderColor = consent.checked ? '#15803d' : '#e2e8f0';
    wrap.style.background  = consent.checked ? '#f0fdf4' : '#f8fafc';
  }

  inp.focus();
  inp.addEventListener('input', () => { prev.textContent = inp.value; _osUpdateBtn(); });
  consent.addEventListener('change', _osUpdateBtn);

  document.getElementById('_osc').addEventListener('click', () => overlay.remove());

  btn.addEventListener('click', async () => {
    const name = inp.value.trim();
    if (!name)         { inp.style.borderColor='#dc2626'; inp.focus(); return; }
    if (!consent.checked) { wrap.style.borderColor='#dc2626'; return; }
    btn.textContent='⏳ Signing…'; btn.disabled=true;
    try {
      await updateDoc(doc(db,'documents',docId), {
        ownerSig: { name, signedAt: serverTimestamp(), consentGiven: true, consentAt: serverTimestamp() },
        updatedAt: serverTimestamp()
      });
      _sigInjectInFrame(iframe, { ownerSig:{name,signedAt:new Date()}, customerSig: data.customerSig });
      const idx = adminAllDocs.findIndex(d=>d.id===docId);
      if (idx!==-1) adminAllDocs[idx].ownerSig={name,signedAt:new Date(),consentGiven:true};
      renderAdminDocCards();
      showToast('Document signed!','success');
      btn.textContent='✅ Signed!';
      btn.style.background='#166534';
      setTimeout(() => overlay.remove(), 1400);
    } catch(e) {
      btn.textContent='✅ Sign Document'; btn.disabled=false;
      alert('Error saving signature: '+e.message);
    }
  });
};

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
let _calMiniYear    = new Date().getFullYear();
let _calMiniMonth   = new Date().getMonth();
let _calActiveIdx   = 0;   // which calendar tab is selected
let _calAllBizData  = [];  // full businesses array from Firestore

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

// ── Tabs ─────────────────────────────────────────────────────
function _renderCalTabs(businesses) {
  const row = document.getElementById('calTabsRow');
  if (!row) return;
  row.innerHTML = '';
  businesses.forEach((biz, i) => {
    const btn = document.createElement('button');
    btn.className = `cal-tab${i === _calActiveIdx ? ' active' : ''}`;
    const name = biz.name || `Calendar ${i}`;
    btn.innerHTML = name + (i === 0 ? `<span class="cal-tab-default-badge">DEFAULT</span>` : '');
    btn.addEventListener('click', () => window._adminSwitchCalTab(i));
    row.appendChild(btn);
  });
}

window._adminSwitchCalTab = function(idx) {
  _calActiveIdx = idx;
  _populateCalForm(_calAllBizData[idx] || {});
  _renderCalTabs(_calAllBizData);
  _updateCalBookingLink();
  window._adminLoadBookings();
};

window._adminAddCalendar = async function() {
  const name = prompt('New calendar name:');
  if (!name || !name.trim()) return;
  try {
    const snap = await getDoc(doc(db, 'config', 'calendar'));
    const data = snap.exists() ? snap.data() : {};
    const businesses = [...(data.businesses || [])];
    businesses.push({ name: name.trim(), slotDuration: 30, active: true, availability: {} });
    await setDoc(doc(db, 'config', 'calendar'), { businesses }, { merge: true });
    _calAllBizData = businesses;
    _calActiveIdx  = businesses.length - 1;
    _renderCalTabs(businesses);
    _populateCalForm(businesses[_calActiveIdx]);
    _updateCalBookingLink();
    window._adminLoadBookings();
  } catch(e) { alert('Error creating calendar: ' + e.message); }
};

// ── Load config ──────────────────────────────────────────────
async function loadCalendarConfig() {
  renderCalAvailGrid();
  try {
    const snap = await getDoc(doc(db, 'config', 'calendar'));
    const data = snap.exists() ? snap.data() : {};

    // Ensure at least one calendar exists
    _calAllBizData = data.businesses?.length ? data.businesses : [{ name: 'Calendar 0', slotDuration: 30, active: true, availability: {} }];
    if (_calActiveIdx >= _calAllBizData.length) _calActiveIdx = 0;

    _renderCalTabs(_calAllBizData);
    _populateCalForm(_calAllBizData[_calActiveIdx]);
    _updateCalBookingLink();
    _wireCalShareBtns();
    _wireCalQr();
    _wireCalPhotoUpload();
    _renderCalMini();

    const aiLinkEl = document.getElementById('calAiLinkDisplay');
    if (aiLinkEl) aiLinkEl.textContent = `${window.location.origin}/ai/ep-hub`;

    document.getElementById('calExportCsvBtn')?.addEventListener('click', _calExportCsv, { once: true });

  } catch(e) {
    console.error('loadCalendarConfig', e);
  }
}

function _populateCalForm(biz) {
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

  const slotEl = document.getElementById('calSlotDuration');
  if (slotEl) slotEl.value = biz.slotDuration || 30;
  const actEl = document.getElementById('calActive');
  if (actEl) actEl.checked = biz.active !== false;

  renderCalAvailGrid(biz.availability || {});
  window._adminCalPhotoPreview(biz.profile?.photoUrl || '');

  const nameEl = document.getElementById('calApptCalName');
  if (nameEl) nameEl.textContent = biz.name || `Calendar ${_calActiveIdx}`;
}

function _setVal(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.tagName === 'SELECT' || el.type === 'checkbox') return;
  el.value = val;
}

function _updateCalBookingLink() {
  const url = `${window.location.origin}/calendar.html?biz=${_calActiveIdx}`;
  const el  = document.getElementById('calBookingLink');
  if (el) el.textContent = url;
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

// ── Profile photo preview & upload ──────────────────────────
window._adminCalPhotoPreview = function(url) {
  const img = document.getElementById('calProfilePhotoPreview');
  if (!img) return;
  if (url) { img.src = url; img.style.display = 'block'; }
  else      { img.src = ''; img.style.display = 'none';  }
};

function _wireCalPhotoUpload() {
  const btn   = document.getElementById('calPhotoUploadBtn');
  const input = document.getElementById('calPhotoFileInput');
  if (!btn || !input) return;
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    try {
      const path = `calendar/profile/${Date.now()}_${file.name}`;
      const ref  = storageRef(storage, path);
      await uploadBytes(ref, file);
      const url  = await getDownloadURL(ref);
      const urlEl = document.getElementById('calProfilePhoto');
      if (urlEl) urlEl.value = url;
      window._adminCalPhotoPreview(url);
    } catch(e) {
      alert('Upload failed: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '📷 Upload from Device';
      input.value = '';
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
    const idx = _calActiveIdx;
    businesses[idx] = {
      ...(businesses[idx] || {}),
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
    _calAllBizData = businesses;
    _renderCalTabs(businesses);
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
    const q = query(collection(db, 'bookings'), orderBy('date', 'desc'), limit(500));
    const snap = await getDocs(q);

    _calAllBookings = [];
    snap.forEach(d => {
      const b = d.data();
      // filter by active calendar index (or include legacy bookings with no bizIndex on Calendar 0)
      const bIdx = b.bizIndex !== undefined ? b.bizIndex : 0;
      if (bIdx === _calActiveIdx) _calAllBookings.push({ id: d.id, ...b });
    });

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
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#94a3b8;padding:24px">No appointments yet</td></tr>`;
    return;
  }
  tbody.innerHTML = '';
  rows.forEach(b => {
    const status   = b.status || 'pending';
    const badgeCls = status === 'confirmed' ? 'badge-booking-confirmed'
                   : status === 'cancelled' ? 'badge-booking-cancelled'
                   : 'badge-booking-pending';
    const phone = b.clientPhone || '';
    const phoneCell = phone
      ? `<div class="bk-phone-cell">
           <a class="bk-phone-icon call" href="tel:${phone}" title="Call">📞</a>
           <a class="bk-phone-icon wa"   href="https://wa.me/${phone.replace(/\D/g,'')}" target="_blank" title="WhatsApp">💬</a>
           <span>${phone}</span>
         </div>`
      : '—';

    const tr = document.createElement('tr');
    tr.dataset.id = b.id;
    tr.innerHTML = `
      <td style="font-weight:600">${b.clientName  || '—'}</td>
      <td><a href="mailto:${b.clientEmail||''}" style="color:var(--indigo);text-decoration:none">${b.clientEmail || '—'}</a></td>
      <td>${phoneCell}</td>
      <td>${b.date  || '—'}</td>
      <td>${b.time  || '—'}</td>
      <td title="${b.reason||''}">${b.reason || '—'}</td>
      <td title="${b.notes ||''}">${b.notes  || '—'}</td>
      <td><span class="${badgeCls}">${status.toUpperCase()}</span></td>
      <td>
        <div class="bk-actions">
          <button class="bk-btn view"    title="View"    onclick="window._adminViewBooking('${b.id}')">👁</button>
          <button class="bk-btn edit"    title="Edit"    onclick="window._adminEditBooking('${b.id}')">✏️</button>
          <button class="bk-btn del"     title="Delete"  onclick="window._adminDeleteBooking('${b.id}')">🗑</button>
          ${status !== 'confirmed' ? `<button class="bk-btn confirm" title="Confirm" onclick="window._adminConfirmBooking('${b.id}')">✓</button>` : ''}
          ${status !== 'cancelled' ? `<button class="bk-btn cancel"  title="Cancel"  onclick="window._adminCancelBooking('${b.id}')">✕</button>` : ''}
        </div>
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

window._adminViewBooking = function(id) {
  const b = _calAllBookings.find(x => x.id === id);
  if (!b) return;
  alert(
    `📋 Appointment Details\n\n` +
    `Name:   ${b.clientName  || '—'}\n` +
    `Email:  ${b.clientEmail || '—'}\n` +
    `Phone:  ${b.clientPhone || '—'}\n` +
    `Date:   ${b.date  || '—'}  ${b.time || ''}\n` +
    `Reason: ${b.reason || '—'}\n` +
    `Notes:  ${b.notes  || '—'}\n` +
    `Status: ${b.status || 'pending'}`
  );
};

window._adminEditBooking = function(id) {
  const b = _calAllBookings.find(x => x.id === id);
  if (!b) return;
  document.getElementById('editBookingId').value    = id;
  document.getElementById('editBfName').value       = b.clientName  || '';
  document.getElementById('editBfPhone').value      = b.clientPhone || '';
  document.getElementById('editBfEmail').value      = b.clientEmail || '';
  document.getElementById('editBfDate').value       = b.date   || '';
  document.getElementById('editBfTime').value       = b.time   || '';
  document.getElementById('editBfReason').value     = b.reason || '';
  document.getElementById('editBfNotes').value      = b.notes  || '';
  document.getElementById('editBfStatus').value     = b.status || 'pending';
  document.getElementById('editBookingModal')?.classList.remove('hidden');
};

window._adminSaveEditBooking = async function() {
  const id  = document.getElementById('editBookingId')?.value;
  if (!id) return;
  const btn = document.getElementById('saveEditBookingBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await updateDoc(doc(db, 'bookings', id), {
      clientName:  document.getElementById('editBfName').value.trim(),
      clientPhone: document.getElementById('editBfPhone').value.trim(),
      clientEmail: document.getElementById('editBfEmail').value.trim(),
      date:        document.getElementById('editBfDate').value,
      time:        document.getElementById('editBfTime').value,
      reason:      document.getElementById('editBfReason').value.trim(),
      notes:       document.getElementById('editBfNotes').value.trim(),
      status:      document.getElementById('editBfStatus').value
    });
    document.getElementById('editBookingModal')?.classList.add('hidden');
    window._adminLoadBookings();
  } catch(e) {
    alert('Error saving: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
  }
};

window._adminDeleteBooking = async function(id) {
  if (!confirm('Permanently delete this appointment?')) return;
  try {
    const { deleteDoc: _del } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    await _del(doc(db, 'bookings', id));
    window._adminLoadBookings();
  } catch(e) { alert('Error deleting: ' + e.message); }
};

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

// ══════════════════════════════════════════════════════════════
//  DOCUMENT CREATOR
// ══════════════════════════════════════════════════════════════

// ── State ────────────────────────────────────────────────────
let _adminBizProfile  = {};   // cached biz info for doc pre-fill
let _docLang          = 'en';
let _docType          = 'invoice';
let _docItems         = [];
let _docLogoDataUrl   = '';
let _docAllCustomers  = [];
let _docAllTemplates  = [];
let _docCurrentId     = null;
let _docShowPricing   = true;
let _docDesignTemplate = 'classic';
let _docVoiceRecognizer = null;

// Labels per language
const DOC_LABELS = {
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
    billTo:'Facturar a', date:'Fecha', due:'Vencimiento', docNum:'Número',
    desc:'Descripción', qty:'Cant.', price:'Precio', total:'Total',
    subtotal:'Subtotal', tax:'Impuesto', grandTotal:'TOTAL',
    advance:'Anticipo Recibido', balance:'Saldo Pendiente',
    notes:'Notas', terms:'Términos y Condiciones', tcTitle:'TÉRMINOS Y CONDICIONES',
    thankYou:'¡Gracias por su preferencia!',
    page:'Página'
  }
};

// ── Open / Close ──────────────────────────────────────────────
window._openDocCreator = function(existingDoc) {
  _docCurrentId = existingDoc?.id || null;
  const modal = document.getElementById('docCreatorModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Update save button label and edit-mode banner
  const saveBtn = document.getElementById('docSaveBtn');
  let editBanner = document.getElementById('docEditModeBanner');
  if (_docCurrentId) {
    if (saveBtn) saveBtn.innerHTML = '✏️ Update Document';
    if (!editBanner) {
      editBanner = document.createElement('div');
      editBanner.id = 'docEditModeBanner';
      editBanner.style.cssText = 'background:#fef9c3;border-bottom:1px solid #fde047;padding:6px 16px;font-size:0.78rem;color:#78350f;font-weight:600;display:flex;align-items:center;gap:8px;';
      modal.querySelector('.doc-creator-wrap')?.prepend(editBanner);
    }
    editBanner.innerHTML = `✏️ Editing document — changes will overwrite the saved version. <span style="opacity:.7">${existingDoc?.docNumber || ''}</span>`;
    editBanner.style.display = 'flex';
  } else {
    if (saveBtn) saveBtn.innerHTML = '💾 Save Document';
    if (editBanner) editBanner.style.display = 'none';
  }

  // Load customers so search works immediately (no need to visit Customers panel first)
  if (!_docAllCustomers.length) loadCustomers();

  // Reset state
  _docItems = existingDoc?.items || [{ desc:'', qty:1, price:0 }];
  _docType  = existingDoc?.type || 'invoice';
  _docLogoDataUrl = existingDoc?.logoUrl || existingDoc?.logoDataUrl || '';
  window._docSetType(_docType);
  window._docSetLang(_docLang);

  // Pre-fill from existing doc or from business profile
  if (existingDoc) {
    _setDocVal('docBizName',    existingDoc.bizName || '');
    _setDocVal('docBizAddress', existingDoc.bizAddress || '');
    _setDocVal('docBizPhone',   existingDoc.bizPhone || '');
    _setDocVal('docBizEmail',   existingDoc.bizEmail || '');
    _setDocVal('docCustName',   existingDoc.custName || '');
    _setDocVal('docCustEmail',  existingDoc.custEmail || '');
    _setDocVal('docCustPhone',  existingDoc.custPhone || '');
    _setDocVal('docCustAddress',existingDoc.custAddress || '');
    _setDocVal('docNumber',     existingDoc.docNumber || '');
    _setDocVal('docDate',       existingDoc.docDate || '');
    _setDocVal('docDueDate',    existingDoc.docDueDate || '');
    _setDocVal('docNotes',         existingDoc.notes        || '');
    _setDocVal('docContractText',  existingDoc.contractText || '');
    _setDocVal('docProjectTitle',  existingDoc.projectTitle || '');
    _setDocVal('docJobOrderedBy',  existingDoc.jobOrderedBy || '');
    _setDocVal('docJobLocation',   existingDoc.jobLocation  || '');
    _setDocVal('docDuration',      existingDoc.duration     || '');
    _setDocVal('docJobScope',      existingDoc.jobScope     || '');
    _setDocVal('docAdvancePayment', existingDoc.advance || 0);
    if (existingDoc.paymentMethod) { const pmEl = document.getElementById('docPaymentMethod'); if (pmEl) pmEl.value = existingDoc.paymentMethod; }
    // Restore pricing toggle
    _docShowPricing = existingDoc.showPricing !== false;
    const _pChk = document.getElementById('docShowPricing');
    if (_pChk) _pChk.checked = _docShowPricing;
    document.getElementById('docPricingContent')?.classList.toggle('hidden', !_docShowPricing);
    if (existingDoc.taxRate !== undefined) _setDocVal('docTaxRate', existingDoc.taxRate);
    // Restore T&C
    const tcChecked = !!existingDoc.includeTC;
    const tcEl = document.getElementById('docIncludeTC');
    if (tcEl) tcEl.checked = tcChecked;
    document.getElementById('docTCSection')?.classList.toggle('hidden', !tcChecked);
    _setDocVal('docTermsText', existingDoc.termsText || '');
    const _storedLogo = existingDoc.logoUrl || existingDoc.logoDataUrl || '';
    if (_storedLogo) {
      _docLogoDataUrl = _storedLogo;
      const img = document.getElementById('docLogoImg');
      const ph  = document.getElementById('docLogoPlaceholder');
      if (img) { img.src = _docLogoDataUrl; img.style.display = 'block'; }
      if (ph)  ph.style.display = 'none';
    }
    _docDesignTemplate = existingDoc?.designTemplate || 'classic';
    window._docSetDesign(_docDesignTemplate);
  } else {
    // Clear form
    ['docBizName','docBizAddress','docBizPhone','docBizEmail',
     'docCustName','docCustEmail','docCustPhone','docCustAddress',
     'docNumber','docDate','docDueDate','docNotes','docContractText',
     'docProjectTitle','docJobOrderedBy','docJobLocation','docDuration','docJobScope'].forEach(id => _setDocVal(id,''));
    _setDocVal('docTaxRate', '0');
    _setDocVal('docAdvancePayment', '0');
    // Reset pricing toggle
    _docShowPricing = true;
    const _pChk2 = document.getElementById('docShowPricing');
    if (_pChk2) _pChk2.checked = true;
    document.getElementById('docPricingContent')?.classList.remove('hidden');
    // Reset T&C
    const tcEl2 = document.getElementById('docIncludeTC');
    if (tcEl2) tcEl2.checked = false;
    document.getElementById('docTCSection')?.classList.add('hidden');
    _setDocVal('docTermsText', '');
    // Reset design template
    _docDesignTemplate = 'classic';
    window._docSetDesign('classic');
    // Set today's date
    _setDocVal('docDate', new Date().toISOString().slice(0,10));
    // Auto-increment doc number
    _setDocVal('docNumber', _docType.slice(0,3).toUpperCase() + '-' + String(Date.now()).slice(-4));
    // Pre-fill biz info from saved profile (fallback: calendar config DOM)
    const bizName  = _adminBizProfile.bizName    || document.getElementById('calBizName')?.value  || '';
    const bizAddr  = _adminBizProfile.bizAddress || document.getElementById('calAddress')?.value  || '';
    const bizPhone = _adminBizProfile.bizPhone   || document.getElementById('calPhone')?.value    || '';
    const bizEmail = _adminBizProfile.bizEmail   || document.getElementById('calEmail')?.value    || '';
    if (bizName)  _setDocVal('docBizName',    bizName);
    if (bizAddr)  _setDocVal('docBizAddress', bizAddr);
    if (bizPhone) _setDocVal('docBizPhone',   bizPhone);
    if (bizEmail) _setDocVal('docBizEmail',   bizEmail);
    // Default notes with business owner name
    const noteOwner = bizName || 'our team';
    _setDocVal('docNotes', `\u{1F4CC} This estimate is based on the visible and known conditions at the time of preparation. If unforeseen conditions are discovered after access is opened or excavation begins, additional work or materials may be required. Any work outside the scope described above should be discussed with ${noteOwner} and approved by the customer before proceeding.`);
    // Pre-fill logo from saved profile or calendar config
    const profilePhoto = _adminBizProfile.bizLogoUrl || document.getElementById('calProfilePhoto')?.value;
    if (profilePhoto) {
      const img = document.getElementById('docLogoImg');
      const ph  = document.getElementById('docLogoPlaceholder');
      if (img) { img.src = profilePhoto; img.style.display = 'block'; }
      if (ph)  ph.style.display = 'none';
      _docLogoDataUrl = profilePhoto;
    }
  }

  _docRenderItems();
  _docUpdateTotals();
  _docUpdatePreview();
  _wireDocLogoUpload();
};

function _setDocVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

// ── Close via data-close (already handled by existing modal logic) ──

// ── Language toggle ───────────────────────────────────────────
window._docSetLang = function(lang) {
  _docLang = lang;
  document.getElementById('docLangEn')?.classList.toggle('active', lang === 'en');
  document.getElementById('docLangEs')?.classList.toggle('active', lang === 'es');
  // Update all data-en / data-es labels inside doc creator
  const modal = document.getElementById('docCreatorModal');
  if (!modal) return;
  modal.querySelectorAll('[data-en]').forEach(el => {
    el.textContent = el.getAttribute(`data-${lang}`) || el.getAttribute('data-en');
  });
  _docApplyTypeLayout();
  _docUpdatePreview();
};

// ── Document type ─────────────────────────────────────────────
window._docSetType = function(type) {
  _docType = type;
  document.querySelectorAll('.doc-type-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.doctype === type);
  });
  // Update doc number prefix if it still matches the auto-generated pattern
  const numEl = document.getElementById('docNumber');
  if (numEl && /^(INV|EST|CON|REC)-\d+$/i.test(numEl.value)) {
    const suffix = numEl.value.split('-')[1];
    numEl.value = type.slice(0,3).toUpperCase() + '-' + suffix;
  }
  _docApplyTypeLayout();
  _docUpdatePreview();
};

function _docApplyTypeLayout() {
  const show = (id, v) => { const el = document.getElementById(id); if (el) el.style.display = v ? '' : 'none'; };
  const setTxt = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };

  const isInvoice  = _docType === 'invoice';
  const isEstimate = _docType === 'estimate';
  const isContract = _docType === 'contract';
  const isReceipt  = _docType === 'receipt';
  const es = _docLang === 'es';

  // ── Type Purpose Banner ───────────────────────────────────
  const BANNER = {
    invoice:  { icon:'📄', color:'#4f46e5', title: es?'Factura':'Invoice',
                desc: es?'Solicitar pago por trabajo completado':'Request payment for completed work' },
    estimate: { icon:'📋', color:'#059669', title: es?'Estimación':'Estimate',
                desc: es?'Proponer un precio antes de comenzar el trabajo':'Propose a price before starting the job' },
    contract: { icon:'📝', color:'#7c3aed', title: es?'Contrato':'Contract',
                desc: es?'Acuerdo legal entre usted y su cliente':'Legal agreement between you and your client' },
    receipt:  { icon:'🧾', color:'#0891b2', title: es?'Recibo':'Receipt',
                desc: es?'Confirmar que se recibió el pago':'Confirm payment has been received in full' },
  };
  const bd = BANNER[_docType] || BANNER.invoice;
  setTxt('docTypeBannerIcon', bd.icon);
  setTxt('docTypeBannerTitle', bd.title);
  setTxt('docTypeBannerDesc', bd.desc);
  const bannerEl = document.getElementById('docTypeBanner');
  if (bannerEl) bannerEl.style.borderLeftColor = bd.color;

  // ── Invoice Reference # (receipt only) ───────────────────
  show('docInvoiceRefRow', isReceipt);

  // ── Payment Instructions (invoice only) ──────────────────
  show('docPayInstructRow', isInvoice);

  // Project Title — estimates & contracts only
  show('docProjectTitleRow', isEstimate || isContract);

  // Due Date — hidden for receipt; label adapts
  show('docDueDateWrap', !isReceipt);
  if (isEstimate)      setTxt('docDueDateLabel', es ? 'Válido Hasta' : 'Valid Until');
  else if (isContract) setTxt('docDueDateLabel', es ? 'Fecha de Fin' : 'End Date');
  else                 setTxt('docDueDateLabel', es ? 'Vencimiento' : 'Due Date');

  // Payment Method — receipt only
  show('docPaymentMethodRow', isReceipt);

  // Job Details section — estimate & contract only (invoice & receipt don't need job location)
  show('docJobDetailsSection', isEstimate || isContract);
  // Ordered By — estimate only (contract client IS the person who ordered)
  show('docOrderedByRow', isEstimate);
  // Duration — estimate only
  show('docDurationRow', isEstimate);
  // Job Details title adapts
  setTxt('docJobDetailsTitle', isContract
    ? (es ? 'Detalles del Proyecto' : 'Project Details')
    : (es ? 'Detalles del Trabajo' : 'Job Details'));

  // Scope of Work — estimates & contracts only
  show('docScopeSection', isEstimate || isContract);

  // Line Items — hidden for contract
  const liSec = document.getElementById('docLineItemsSection');
  if (liSec) liSec.classList.toggle('hidden', isContract);

  // Line Items title adapts by type
  if (isReceipt)      setTxt('docLineItemsTitle', es ? 'Artículos / Servicios Pagados' : 'Items / Services Paid');
  else if (isEstimate) setTxt('docLineItemsTitle', es ? 'Partidas del Proyecto' : 'Project Items & Costs');
  else                 setTxt('docLineItemsTitle', es ? 'Partidas y Precios' : 'Line Items & Pricing');

  // Tax row — hidden for receipt (receipt shows what was paid, not tax calculation)
  show('docTaxRow', !isReceipt);

  // Advance & Balance rows — hidden for receipt (already paid) and contract
  show('docAdvanceRow', !isReceipt && !isContract);
  show('docBalanceRow', !isReceipt && !isContract);

  // Grand Total label
  if (isReceipt) setTxt('docGrandTotalLabelSpan', es ? 'Total Recibido' : 'Amount Received');
  else           setTxt('docGrandTotalLabelSpan', es ? 'Total' : 'Total');

  // Contract Terms section — contract only
  const conSec = document.getElementById('docContractSection');
  if (conSec) conSec.classList.toggle('hidden', !isContract);

  // T&C section — hidden for receipt; force-checked for contract
  show('docTCFormSection', !isReceipt);
  if (isContract) {
    const cb = document.getElementById('docIncludeTC');
    if (cb && !cb.checked) { cb.checked = true; document.getElementById('docTCSection')?.classList.remove('hidden'); }
  }

  // Bill To label
  if (isReceipt)       setTxt('docBillToLabel', es ? 'Para' : 'To');
  else if (isContract) setTxt('docBillToLabel', es ? 'Cliente' : 'Client');
  else if (isEstimate) setTxt('docBillToLabel', es ? 'Preparado Para' : 'Prepared For');
  else                 setTxt('docBillToLabel', es ? 'Facturar a' : 'Bill To');

  // Notes placeholder adapts by type
  const notesEl = document.getElementById('docNotes');
  if (notesEl) {
    const ph = notesEl.dataset['ph' + _docType.charAt(0).toUpperCase() + _docType.slice(1)];
    if (ph) notesEl.placeholder = ph;
  }
}

// ── Line items ────────────────────────────────────────────────
window._docAddItem = function() {
  _docItems.push({ desc:'', qty:1, price:0, type:'labor' });
  _docRenderItems();
  _docUpdateTotals();
  _docUpdatePreview();
};

window._docRemoveItem = function(idx) {
  _docItems.splice(idx, 1);
  if (_docItems.length === 0) _docItems.push({ desc:'', qty:1, price:0, type:'labor' });
  _docRenderItems();
  _docUpdateTotals();
  _docUpdatePreview();
};

const DOC_ITEM_TYPES = [
  { value:'labor',     label:'🔧 Labor',     labelEs:'🔧 Mano de Obra' },
  { value:'parts',     label:'🔩 Parts',     labelEs:'🔩 Partes'       },
  { value:'material',  label:'🪵 Material',  labelEs:'🪵 Material'     },
  { value:'equipment', label:'⚙️ Equipment', labelEs:'⚙️ Equipo'       },
  { value:'permit',    label:'📋 Permit',    labelEs:'📋 Permiso'      },
  { value:'service',   label:'🛠️ Service',   labelEs:'🛠️ Servicio'     },
  { value:'other',     label:'📌 Other',     labelEs:'📌 Otro'         },
];

// Inline oninput/onchange handlers run in global scope; this bridge accesses module-scoped _docItems
window._docItemSet = function(i, field, val) {
  if (!_docItems[i]) return;
  _docItems[i][field] = (field === 'desc' || field === 'type') ? val : (parseFloat(val) || 0);
  window._docUpdateTotals();
  window._docUpdatePreview();
};

function _docRenderItems() {
  const container = document.getElementById('docItemsList');
  if (!container) return;
  container.innerHTML = _docItems.map((item, i) => `
    <div class="doc-item-row">
      <select class="doc-item-type" onchange="window._docItemSet(${i},'type',this.value)">
        ${DOC_ITEM_TYPES.map(t => `<option value="${t.value}"${item.type===t.value?' selected':''}>${_docLang==='es'?t.labelEs:t.label}</option>`).join('')}
      </select>
      <input type="text" value="${_esc(item.desc)}" placeholder="Description / Notes"
        oninput="window._docItemSet(${i},'desc',this.value)" />
      <input type="number" value="${item.price}" min="0" step="0.01" placeholder="0.00"
        oninput="window._docItemSet(${i},'price',this.value)" />
      <button class="doc-item-del" onclick="window._docRemoveItem(${i})">✕</button>
    </div>`).join('');
}

function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Totals ────────────────────────────────────────────────────
window._docUpdateTotals = function() {
  const subtotal = _docItems.reduce((s, it) => s + (it.price||0), 0);
  const taxRate  = parseFloat(document.getElementById('docTaxRate')?.value || 0);
  const taxAmt   = subtotal * taxRate / 100;
  const grand    = subtotal + taxAmt;
  if (document.getElementById('docSubtotal'))  document.getElementById('docSubtotal').textContent  = '$' + subtotal.toFixed(2);
  if (document.getElementById('docTaxAmt'))    document.getElementById('docTaxAmt').textContent    = '$' + taxAmt.toFixed(2);
  if (document.getElementById('docGrandTotal'))document.getElementById('docGrandTotal').textContent= '$' + grand.toFixed(2);
  // Advance payment & remaining balance — always recalculate
  const advance  = parseFloat(document.getElementById('docAdvancePayment')?.value || 0);
  const balance  = Math.max(0, grand - advance);
  const balEl = document.getElementById('docBalanceDue');
  if (balEl) {
    if (advance > 0 && advance >= grand) {
      balEl.textContent = '✓ Paid in Full';
      balEl.style.color = '#15803d';
    } else {
      balEl.textContent = '$' + balance.toFixed(2);
      balEl.style.color = '';
    }
  }
};

// ── Preview ───────────────────────────────────────────────────
window._docUpdatePreview = function() {
  const frame = document.getElementById('docPreviewFrame');
  if (!frame) return;
  const html = _docGenerateHTML();
  frame.onload = () => {
    try {
      const h = frame.contentDocument?.body?.scrollHeight;
      if (h && h > 100) frame.style.height = h + 'px';
    } catch(_) {}
  };
  frame.srcdoc = html;
  const hint = document.getElementById('docPaymentHint');
  if (hint) {
    const hasPayment = _buildPaymentBlockHtml().length > 0;
    hint.style.display = hasPayment ? 'none' : 'flex';
  }
};

window._docCloseAndOpenPayment = function() {
  const modal = document.getElementById('docCreatorModal');
  if (modal) modal.classList.add('hidden');
  const panel = document.getElementById('docPaymentPanel');
  const btn   = document.getElementById('docPaymentToggle');
  if (panel) { panel.classList.remove('hidden'); }
  if (btn)   { btn.textContent = '💳 Hide Payment'; }
  document.getElementById('docSection')?.scrollIntoView({ behavior:'smooth' });
};

// ── Design Template Switcher ──────────────────────────────────
window._docSetDesign = function(name) {
  _docDesignTemplate = name;
  document.querySelectorAll('.doc-design-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('docDesign-' + name);
  if (btn) btn.classList.add('active');
  _docUpdatePreview();
};

// ── HTML Generator — shared data extractor ────────────────────
function _docGetData() {
  const L = DOC_LABELS[_docLang];
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
  const subtotal   = _docItems.reduce((s, it) => s + (it.price||0), 0);
  const taxAmt     = subtotal * taxRate / 100;
  const grand      = subtotal + taxAmt;
  const balance    = Math.max(0, grand - advance);
  const grandTotalLabel = _docType === 'estimate'
    ? (_docLang === 'es' ? 'COSTO ESTIMADO DEL PROYECTO' : 'ESTIMATED PROJECT COST')
    : L.grandTotal;
  const typeLabel  = L[_docType] || _docType;
  const custLabel  = _docType === 'receipt'  ? (_docLang === 'es' ? 'Para'           : 'To')
                   : _docType === 'contract' ? (_docLang === 'es' ? 'Cliente'        : 'Client')
                   : _docType === 'estimate' ? (_docLang === 'es' ? 'Preparado Para' : 'Prepared For')
                   :                           (_docLang === 'es' ? 'Facturar a'     : 'Bill To');
  const fmtDate    = d => { if (!d) return ''; const [y,m,day] = d.split('-'); return `${m}/${day}/${y}`; };
  const TYPE_COLORS   = { labor:'#4f46e5', parts:'#0891b2', material:'#059669', equipment:'#d97706', permit:'#7c3aed', service:'#db2777', other:'#64748b' };
  const TYPE_LABELS_ES= { labor:'Mano de Obra', parts:'Partes', material:'Material', equipment:'Equipo', permit:'Permiso', service:'Servicio', other:'Otro' };
  const scopeHtml = (() => {
    if (!jobScope) return '';
    const lines = jobScope.split('\n'); let html = ''; let inList = false;
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('- ') || t.startsWith('• ') || t.startsWith('* ')) {
        if (!inList) { html += '<ul style="margin:6px 0 8px 18px;padding:0">'; inList = true; }
        html += `<li style="margin:3px 0;font-size:0.82rem;color:#475569">${_esc(t.slice(2))}</li>`;
      } else { if (inList) { html += '</ul>'; inList = false; } if (t) html += `<p style="margin:0 0 6px;font-size:0.82rem;color:#475569">${_esc(t)}</p>`; }
    }
    if (inList) html += '</ul>'; return html;
  })();
  const logoHtml = _docLogoDataUrl ? `<img src="${_docLogoDataUrl}" alt="Logo" style="max-height:70px;max-width:150px;object-fit:contain;"/>` : '';
  const paymentMethod = document.getElementById('docPaymentMethod')?.value || '';
  const PM_LABELS = { cash:'Cash', check:'Check', card:'Card / Debit', zelle:'Zelle', venmo:'Venmo', cashapp:'Cash App', transfer:'Bank Transfer', other:'Other' };
  const PM_LABELS_ES = { cash:'Efectivo', check:'Cheque', card:'Tarjeta / Débito', zelle:'Zelle', venmo:'Venmo', cashapp:'Cash App', transfer:'Transferencia', other:'Otro' };
  const paymentMethodLabel = (_docLang === 'es' ? PM_LABELS_ES[paymentMethod] : PM_LABELS[paymentMethod]) || paymentMethod;
  const pmRowLabel = _docLang === 'es' ? 'Método de Pago' : 'Payment Method';
  const receiptPaymentHtml = (_docType === 'receipt' && paymentMethod)
    ? `<tr><td style="padding:6px 10px;font-size:0.82rem;color:#475569;">${pmRowLabel}</td><td style="padding:6px 10px;text-align:right;font-weight:700;color:#15803d;">${_esc(paymentMethodLabel)}</td></tr>`
    : '';

  // Receipt: Invoice Reference # and PAID IN FULL stamp
  const invoiceRef = document.getElementById('docInvoiceRef')?.value || '';
  const paidInFullHtml = (_docType === 'receipt')
    ? `<div style="margin:16px 0;padding:12px 20px;background:linear-gradient(135deg,#15803d,#166534);color:#fff;border-radius:10px;text-align:center;font-size:1.05rem;font-weight:800;letter-spacing:.06em;">✅ ${_docLang==='es'?'PAGO RECIBIDO EN SU TOTALIDAD':'PAID IN FULL'}</div>`
    : '';

  // Invoice: Payment Instructions
  const payInstructions = document.getElementById('docPayInstructions')?.value || '';
  const payInstructionsHtml = (_docType === 'invoice' && payInstructions)
    ? `<div style="margin-top:12px;padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-left:4px solid #4f46e5;border-radius:6px;"><div style="font-size:0.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:5px;">💳 ${_docLang==='es'?'Instrucciones de Pago':'Payment Instructions'}</div><div style="font-size:0.82rem;color:#475569;white-space:pre-wrap;">${_esc(payInstructions)}</div></div>`
    : '';

  return { L, bizName, bizAddress, bizPhone, bizEmail, custName, custEmail, custPhone, custAddr,
    docNumber, docDate, docDueDate, notes, contractTxt, projectTitle, jobOrderedBy, jobLocation,
    duration, jobScope, taxRate, advance, includeTC, termsText, subtotal, taxAmt, grand, balance,
    grandTotalLabel, typeLabel, custLabel, fmtDate, logoHtml, TYPE_COLORS, TYPE_LABELS_ES, scopeHtml,
    paymentMethod, paymentMethodLabel, receiptPaymentHtml, invoiceRef, paidInFullHtml,
    payInstructions, payInstructionsHtml, paymentBlockHtml: _buildPaymentBlockHtml() };
}

function _docGenerateHTML() {
  switch (_docDesignTemplate) {
    case 'bold':       return _docTplBold();
    case 'executive':  return _docTplExecutive();
    case 'modern':     return _docTplModern();
    case 'minimal':    return _docTplMinimal();
    default:           return _docTplClassic();
  }
}

// ── Shared electronic signature section (estimate + contract only) ───────
function _docSigSection(custName, bizName) {
  const es = _docLang === 'es';
  return `<div style="margin-top:36px;padding-top:20px;border-top:2px solid #e2e8f0;">
  <div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:20px;">✍️ ${es?'Firmas Autorizadas':'Authorized Signatures'}</div>
  <div style="display:flex;gap:40px;flex-wrap:wrap;">
    <div style="flex:1;min-width:200px;">
      <div style="font-size:0.62rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:8px;">${es?'Negocio / Propietario':'Business / Owner'}</div>
      <div id="ep-sig-owner" style="min-height:40px;border-bottom:1px dashed #cbd5e1;margin-bottom:6px;display:flex;align-items:flex-end;padding-bottom:4px;"></div>
      <div style="font-size:0.72rem;font-weight:600;color:#1e293b;">${_esc(bizName)||'—'}</div>
    </div>
    <div style="flex:1;min-width:200px;">
      <div style="font-size:0.62rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:8px;">${es?'Cliente / Firmante':'Customer / Client'}</div>
      <div id="ep-sig-client" style="min-height:40px;border-bottom:1px dashed #cbd5e1;margin-bottom:6px;display:flex;align-items:flex-end;padding-bottom:4px;"></div>
      <div style="font-size:0.72rem;font-weight:600;color:#1e293b;">${_esc(custName)||'—'}</div>
    </div>
  </div>
</div>`;
}

// ── Template 1: Classic ───────────────────────────────────────
function _docTplClassic() {
  const L = DOC_LABELS[_docLang];
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

  const subtotal   = _docItems.reduce((s, it) => s + (it.price||0), 0);
  const taxAmt     = subtotal * taxRate / 100;
  const grand      = subtotal + taxAmt;
  const balance    = Math.max(0, grand - advance);

  // "Estimated Project Cost" for estimates, "TOTAL" for other types
  const grandTotalLabel = _docType === 'estimate'
    ? (_docLang === 'es' ? 'COSTO ESTIMADO DEL PROYECTO' : 'ESTIMATED PROJECT COST')
    : L.grandTotal;

  // Pre-build payment terms strings to avoid deep template nesting
  const ptLabel = _docLang === 'es' ? 'Términos de Pago' : 'Payment Terms';
  const ptLine1 = _docLang === 'es'
    ? 'Un anticipo de <strong>$' + advance.toFixed(2) + '</strong> se aplica al costo total estimado del proyecto de <strong>$' + grand.toFixed(2) + '</strong>.'
    : 'A <strong>$' + advance.toFixed(2) + '</strong> advance payment is applied toward the total estimated project cost of <strong>$' + grand.toFixed(2) + '</strong>.';
  const ptLine2 = _docLang === 'es'
    ? 'El saldo restante de <strong>$' + balance.toFixed(2) + '</strong> vence al completar el trabajo.'
    : 'The remaining <strong>$' + balance.toFixed(2) + '</strong> balance is due upon completion of the work.';
  const durationLabel = _docLang === 'es' ? 'Duración Estimada' : 'Estimated Duration';
  const durationApprox = _docLang === 'es' ? 'Aproximadamente' : 'Approximately';
  const durationNote   = _docLang === 'es' ? ', sujeto a las condiciones del sitio.' : ', subject to actual site conditions.';

  // Scope formatter — converts lines starting with "- " or "• " to bullet list
  const scopeHtml = (() => {
    if (!jobScope) return '';
    const lines = jobScope.split('\n');
    let html = '';
    let inList = false;
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('- ') || t.startsWith('• ') || t.startsWith('* ')) {
        if (!inList) { html += '<ul style="margin:6px 0 8px 18px;padding:0">'; inList = true; }
        html += `<li style="margin:3px 0;font-size:0.82rem;color:#475569">${_esc(t.slice(2))}</li>`;
      } else {
        if (inList) { html += '</ul>'; inList = false; }
        if (t) html += `<p style="margin:0 0 6px;font-size:0.82rem;color:#475569">${_esc(t)}</p>`;
      }
    }
    if (inList) html += '</ul>';
    return html;
  })();

  const logoHtml = _docLogoDataUrl
    ? `<img src="${_docLogoDataUrl}" alt="Logo" style="max-height:70px;max-width:150px;object-fit:contain;"/>`
    : '';

  const paymentMethod = document.getElementById('docPaymentMethod')?.value || '';
  const PM_LABELS = { cash:'Cash', check:'Check', card:'Card / Debit', zelle:'Zelle', venmo:'Venmo', cashapp:'Cash App', transfer:'Bank Transfer', other:'Other' };
  const PM_LABELS_ES = { cash:'Efectivo', check:'Cheque', card:'Tarjeta / Débito', zelle:'Zelle', venmo:'Venmo', cashapp:'Cash App', transfer:'Transferencia', other:'Otro' };
  const paymentMethodLabel = (_docLang === 'es' ? PM_LABELS_ES[paymentMethod] : PM_LABELS[paymentMethod]) || paymentMethod;
  const pmRowLabel = _docLang === 'es' ? 'Método de Pago' : 'Payment Method';
  const receiptPaymentHtml = (_docType === 'receipt' && paymentMethod)
    ? `<tr><td style="padding:6px 10px;font-size:0.82rem;color:#475569;">${pmRowLabel}</td><td style="padding:6px 10px;text-align:right;font-weight:700;color:#15803d;">${_esc(paymentMethodLabel)}</td></tr>`
    : '';
  const invoiceRef = document.getElementById('docInvoiceRef')?.value || '';
  const paidInFullHtml = (_docType === 'receipt')
    ? `<div style="margin:16px 0;padding:12px 20px;background:linear-gradient(135deg,#15803d,#166534);color:#fff;border-radius:10px;text-align:center;font-size:1.05rem;font-weight:800;letter-spacing:.06em;">✅ ${_docLang==='es'?'PAGO RECIBIDO EN SU TOTALIDAD':'PAID IN FULL'}</div>`
    : '';
  const payInstructions = document.getElementById('docPayInstructions')?.value || '';
  const payInstructionsHtml = (_docType === 'invoice' && payInstructions)
    ? `<div style="margin-top:12px;padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-left:4px solid #4f46e5;border-radius:6px;"><div style="font-size:0.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:5px;">💳 ${_docLang==='es'?'Instrucciones de Pago':'Payment Instructions'}</div><div style="font-size:0.82rem;color:#475569;white-space:pre-wrap;">${_esc(payInstructions)}</div></div>`
    : '';
  const paymentBlockHtml = _buildPaymentBlockHtml();

  const typeLabel = L[_docType] || _docType;
  const custLabel = _docType === 'receipt'  ? (_docLang === 'es' ? 'Para'           : 'To')
                  : _docType === 'contract' ? (_docLang === 'es' ? 'Cliente'        : 'Client')
                  : _docType === 'estimate' ? (_docLang === 'es' ? 'Preparado Para' : 'Prepared For')
                  :                           (_docLang === 'es' ? 'Facturar a'     : 'Bill To');

  // Format dates nicely
  const fmtDate = d => {
    if (!d) return '';
    const [y,m,day] = d.split('-');
    return `${m}/${day}/${y}`;
  };

  const TYPE_COLORS = { labor:'#4f46e5', parts:'#0891b2', material:'#059669', equipment:'#d97706', permit:'#7c3aed', service:'#db2777', other:'#64748b' };
  const TYPE_LABELS_ES = { labor:'Mano de Obra', parts:'Partes', material:'Material', equipment:'Equipo', permit:'Permiso', service:'Servicio', other:'Otro' };

  const itemsRowsHtml = _docType !== 'contract' ? _docItems.map(it => {
    const typeKey = it.type || 'other';
    const typeColor = TYPE_COLORS[typeKey] || '#64748b';
    const typeLabel = _docLang === 'es' ? (TYPE_LABELS_ES[typeKey] || typeKey) : typeKey.charAt(0).toUpperCase() + typeKey.slice(1);
    const typeBadge = `<span style="display:inline-block;padding:2px 7px;border-radius:12px;font-size:0.65rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;background:${typeColor}18;color:${typeColor};border:1px solid ${typeColor}44;">${_esc(typeLabel)}</span>`;
    return `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;">${typeBadge}<br><span style="font-size:0.82rem">${_esc(it.desc)}</span></td>
      <td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:600;">$${(it.price||0).toFixed(2)}</td>
    </tr>`;
  }).join('') : '';

  return `<!DOCTYPE html>
<html lang="${_docLang === 'es' ? 'es' : 'en'}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${typeLabel} ${docNumber}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #1e293b; background: #fff; padding: 32px; font-size: 13px; line-height: 1.5; }
  .doc-wrap { max-width: 760px; margin: 0 auto; }
  .doc-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; gap: 16px; flex-wrap: wrap; }
  .doc-top-left { flex: 1; min-width: 200px; }
  .doc-top-right { text-align: right; min-width: 160px; }
  .doc-type-title { font-size: 2rem; font-weight: 800; color: #4f46e5; letter-spacing: -0.02em; text-transform: uppercase; }
  .biz-name { font-size: 1rem; font-weight: 700; color: #1e293b; margin-top: 6px; }
  .biz-detail { font-size: 0.78rem; color: #64748b; margin-top: 2px; }
  .doc-meta { font-size: 0.82rem; color: #475569; margin-top: 4px; }
  .doc-meta strong { color: #1e293b; }
  .doc-parties { display: flex; gap: 24px; margin-bottom: 24px; flex-wrap: wrap; }
  .doc-party { flex: 1; min-width: 180px; background: #f8fafc; border-radius: 8px; padding: 12px 16px; border: 1px solid #e2e8f0; }
  .party-label { font-size: 0.68rem; font-weight: 800; color: #94a3b8; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
  .party-name  { font-size: 0.95rem; font-weight: 700; color: #1e293b; margin-bottom: 2px; }
  .party-detail{ font-size: 0.78rem; color: #64748b; line-height: 1.4; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  thead tr { background: #4f46e5; color: #fff; }
  thead th { padding: 10px 10px; text-align: left; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  thead th:not(:first-child) { text-align: right; }
  tbody tr:nth-child(even) { background: #f8fafc; }
  .totals-table { margin-left: auto; width: auto; min-width: 220px; }
  .totals-table td { padding: 5px 10px; font-size: 0.85rem; color: #475569; }
  .totals-table .grand td { font-size: 1rem; font-weight: 800; color: #1e293b; border-top: 2px solid #4f46e5; padding-top: 8px; }
  .doc-contract { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 20px; white-space: pre-wrap; font-size: 0.82rem; color: #475569; line-height: 1.6; }
  .doc-notes { background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 12px 16px; font-size: 0.82rem; color: #78350f; }
  .doc-footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; font-size: 0.72rem; color: #94a3b8; }
  .accent-bar { height: 4px; background: linear-gradient(90deg,#4f46e5,#7c3aed); border-radius: 2px; margin-bottom: 24px; }
  @media print {
    body { padding: 16px; }
    .doc-wrap { max-width: 100%; }
  }
</style>
</head>
<body>
<div class="doc-wrap">
  <div class="accent-bar"></div>
  <div class="doc-top">
    <div class="doc-top-left">
      ${logoHtml}
      ${bizName ? `<div class="biz-name">${_esc(bizName)}</div>` : ''}
      ${bizAddress ? `<div class="biz-detail">${_esc(bizAddress)}</div>` : ''}
      ${bizPhone  ? `<div class="biz-detail">📞 ${_esc(bizPhone)}</div>` : ''}
      ${bizEmail  ? `<div class="biz-detail">✉ ${_esc(bizEmail)}</div>` : ''}
    </div>
    <div class="doc-top-right">
      <div class="doc-type-title">${typeLabel}</div>
      ${docNumber ? `<div class="doc-meta">#&nbsp;<strong>${_esc(docNumber)}</strong></div>` : ''}
      ${docDate   ? `<div class="doc-meta">${L.date}:&nbsp;<strong>${fmtDate(docDate)}</strong></div>` : ''}
      ${docDueDate && _docType !== 'receipt' && _docType !== 'contract'
          ? `<div class="doc-meta">${L.due}:&nbsp;<strong>${fmtDate(docDueDate)}</strong></div>` : ''}
      ${invoiceRef && _docType === 'receipt' ? `<div class="doc-meta">${_docLang==='es'?'Factura Ref':'Ref Invoice'}:&nbsp;<strong>${_esc(invoiceRef)}</strong></div>` : ''}
    </div>
  </div>

  <div class="doc-parties">
    <div class="doc-party">
      <div class="party-label">${_docLang==='es'?'De':'From'}</div>
      <div class="party-name">${_esc(bizName)}</div>
      ${bizAddress ? `<div class="party-detail">${_esc(bizAddress)}</div>` : ''}
      ${bizPhone   ? `<div class="party-detail">${_esc(bizPhone)}</div>` : ''}
      ${bizEmail   ? `<div class="party-detail">${_esc(bizEmail)}</div>` : ''}
    </div>
    <div class="doc-party">
      <div class="party-label">${custLabel}</div>
      <div class="party-name">${_esc(custName) || '—'}</div>
      ${custAddr  ? `<div class="party-detail">${_esc(custAddr)}</div>` : ''}
      ${custPhone ? `<div class="party-detail">${_esc(custPhone)}</div>` : ''}
      ${custEmail ? `<div class="party-detail">${_esc(custEmail)}</div>` : ''}
    </div>
  </div>

  ${(jobOrderedBy || jobLocation) ? `
  <div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap;">
    ${jobOrderedBy ? `
    <div style="flex:1;min-width:160px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;">
      <div style="font-size:0.68rem;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">
        ${_docLang === 'es' ? 'Ordenado Por' : 'Ordered By'}
      </div>
      <div style="font-size:0.9rem;font-weight:600;color:#1e293b;">${_esc(jobOrderedBy)}</div>
    </div>` : ''}
    ${jobLocation ? `
    <div style="flex:1;min-width:160px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;">
      <div style="font-size:0.68rem;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">
        ${_docLang === 'es' ? 'Ubicación del Trabajo' : 'Job Location'}
      </div>
      <div style="font-size:0.9rem;font-weight:600;color:#1e293b;">${_esc(jobLocation)}</div>
    </div>` : ''}
  </div>` : ''}

  ${projectTitle ? `
  <div style="margin-bottom:20px;border-left:4px solid #4f46e5;padding-left:14px;">
    <div style="font-size:1.05rem;font-weight:800;color:#1e293b;line-height:1.3;">${_esc(projectTitle)}</div>
  </div>` : ''}

  ${jobScope ? `
  <div style="margin-bottom:20px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;">
    <div style="font-size:0.68rem;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">
      📋 ${_docLang === 'es' ? 'Alcance del Trabajo' : 'Scope of Work'}
    </div>
    ${scopeHtml}
  </div>` : ''}

  ${(_docShowPricing && _docType !== 'contract') ? `
  <table>
    <thead>
      <tr>
        <th>${L.desc}</th>
        <th style="text-align:right">${L.total}</th>
      </tr>
    </thead>
    <tbody>
      ${itemsRowsHtml}
    </tbody>
  </table>

  <table class="totals-table">
    <tr><td>${L.subtotal}</td><td style="text-align:right">$${subtotal.toFixed(2)}</td></tr>
    ${taxRate > 0 ? `<tr><td>${L.tax} (${taxRate}%)</td><td style="text-align:right">$${taxAmt.toFixed(2)}</td></tr>` : ''}
    <tr class="grand"><td><strong>${grandTotalLabel}</strong></td><td style="text-align:right"><strong>$${grand.toFixed(2)}</strong></td></tr>
    ${receiptPaymentHtml}
    ${advance > 0 ? `<tr><td style="color:#15803d;">${L.advance}</td><td style="text-align:right;color:#15803d;">- $${advance.toFixed(2)}</td></tr>` : ''}
    ${advance > 0 ? `<tr class="balance-due"><td><strong style="color:#dc2626;">${L.balance}</strong></td><td style="text-align:right;color:#dc2626;font-weight:800;font-size:1.1rem;">$${balance.toFixed(2)}</td></tr>` : ''}
  </table>
  ${paidInFullHtml}
  ${payInstructionsHtml}` : ''}

  ${_docType === 'estimate' && advance > 0 ? `
  <div style="margin-bottom:20px;padding:14px 16px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;">
    <div style="font-size:0.68rem;font-weight:800;color:#1d4ed8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">💳 ${ptLabel}</div>
    <p style="font-size:0.82rem;color:#1e3a5f;margin:0 0 6px;">${ptLine1}</p>
    <p style="font-size:0.82rem;color:#1e3a5f;margin:0;">${ptLine2}</p>
  </div>` : ''}

  ${duration ? `
  <div style="margin-bottom:20px;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
    <div style="font-size:0.68rem;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">⏱ ${durationLabel}</div>
    <p style="font-size:0.85rem;color:#1e293b;margin:0;">${durationApprox} <strong>${_esc(duration)}</strong>${durationNote}</p>
  </div>` : ''}

  ${_docType === 'contract' && contractTxt ? `
  <div style="font-size:0.75rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">${L.terms}</div>
  <div class="doc-contract">${_esc(contractTxt)}</div>` : ''}

  ${notes ? `<div class="doc-notes">📌 ${_esc(notes)}</div>` : ''}

  ${includeTC && termsText ? `
  <div style="margin-top:28px;padding-top:16px;border-top:2px solid #e2e8f0;">
    <div style="font-size:0.68rem;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;">
      ⚖️ ${L.tcTitle}
    </div>
    <div style="font-size:0.75rem;color:#475569;line-height:1.7;white-space:pre-wrap;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;">${_esc(termsText)}</div>
  </div>` : ''}

  ${paymentBlockHtml ? `
  <div style="margin-top:28px;padding:18px 20px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;text-align:center;">
    <div style="font-size:0.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:12px;">💳 ${_docLang==='es'?'Opciones de Pago':'Payment Options'}</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;">${paymentBlockHtml}</div>
  </div>` : ''}

  ${(_docType==='estimate'||_docType==='contract') ? _docSigSection(custName, bizName) : ''}

  <div class="doc-footer">
    <span>${L.thankYou}</span>
    <span>${typeLabel} ${_esc(docNumber)}</span>
  </div>
</div>
</body>
</html>`;
}

// ── Template 2: Bold Contractor (red & black) ─────────────────
function _docTplBold() {
  const { L, bizName, bizAddress, bizPhone, bizEmail, custName, custEmail, custPhone, custAddr,
    docNumber, docDate, notes, contractTxt, projectTitle, jobOrderedBy, jobLocation,
    duration, jobScope, taxRate, advance, includeTC, termsText, subtotal, taxAmt, grand, balance,
    grandTotalLabel, typeLabel, custLabel, fmtDate, logoHtml, TYPE_LABELS_ES, scopeHtml,
    receiptPaymentHtml, paidInFullHtml, payInstructionsHtml, invoiceRef, paymentBlockHtml } = _docGetData();

  const itemsHtml = _docType !== 'contract' ? _docItems.map(it => {
    const k = it.type || 'other';
    const tl = _docLang === 'es' ? (TYPE_LABELS_ES[k] || k) : k.charAt(0).toUpperCase() + k.slice(1);
    return `<tr><td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;"><span style="font-size:0.65rem;font-weight:800;text-transform:uppercase;color:#dc2626;">${_esc(tl)}</span><br><span style="font-size:0.82rem;">${_esc(it.desc)}</span></td><td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700;">$${(it.price||0).toFixed(2)}</td></tr>`;
  }).join('') : '';

  return `<!DOCTYPE html><html lang="${_docLang==='es'?'es':'en'}"><head><meta charset="utf-8"/><title>${typeLabel} ${docNumber}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1e293b;background:#fff;padding:0;font-size:13px;line-height:1.5}.wrap{max-width:760px;margin:0 auto}
.hdr{background:#111;display:flex;align-items:stretch;min-height:100px}.hdr-logo{background:#fff;padding:14px 20px;display:flex;align-items:center;justify-content:center;min-width:120px}.hdr-mid{flex:1;padding:16px 20px;display:flex;flex-direction:column;justify-content:center}.hdr-biz{font-size:1rem;font-weight:800;color:#fff}.hdr-det{font-size:0.72rem;color:#94a3b8;margin-top:2px}.hdr-right{background:#dc2626;padding:14px 20px;text-align:center;display:flex;flex-direction:column;justify-content:center;align-items:center;min-width:140px}.hdr-type{font-size:1.3rem;font-weight:900;color:#fff;text-transform:uppercase}.hdr-num{font-size:0.75rem;color:#fecaca;margin-top:4px}
.red-bar{height:5px;background:#dc2626}
.info-row{display:flex}.info-box{flex:1;padding:14px 16px;border:1px solid #e2e8f0;border-top:3px solid #111}.info-box.red{border-top-color:#dc2626}.info-lbl{font-size:0.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:6px}.info-name{font-size:0.9rem;font-weight:700;color:#1e293b}.info-det{font-size:0.75rem;color:#64748b;line-height:1.5;margin-top:2px}
.body{padding:20px}
.field-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}.field-item{}.field-lbl{font-size:0.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:4px}.field-val{font-size:0.85rem;font-weight:600;color:#1e293b;border-bottom:1px solid #e2e8f0;padding-bottom:3px;min-height:20px}
table{width:100%;border-collapse:collapse;margin-bottom:16px}thead tr{background:#111;color:#fff}thead th{padding:9px 12px;text-align:left;font-size:0.72rem;font-weight:800;text-transform:uppercase;letter-spacing:.04em}thead th:not(:first-child){text-align:right}tbody tr:nth-child(even){background:#fafafa}
.totals{margin-left:auto;width:280px;border-top:3px solid #dc2626;border:1px solid #e2e8f0}.totals td{padding:7px 12px;font-size:0.85rem;color:#475569;border-bottom:1px solid #f1f5f9}.totals .grand td{font-size:1rem;font-weight:900;color:#111;background:#f8f8f8}.totals .balance td{font-size:1.05rem;font-weight:900;color:#dc2626;background:#fff5f5}
.scope-box{padding:12px 16px;border:1px solid #e2e8f0;border-left:4px solid #dc2626;background:#fafafa;margin-bottom:16px}.scope-lbl{font-size:0.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:8px}
.notes{background:#fffbeb;border-left:4px solid #d97706;padding:10px 14px;font-size:0.82rem;color:#78350f;margin-bottom:14px}
.foot{background:#111;color:#94a3b8;padding:10px 20px;display:flex;justify-content:space-between;font-size:0.7rem;margin-top:20px}
@media print{body{padding:0}.wrap{max-width:100%}}</style></head>
<body><div class="wrap">
  <div class="hdr">
    <div class="hdr-logo">${logoHtml||`<div style="width:80px;height:60px;background:#f1f5f9;border-radius:4px;"></div>`}</div>
    <div class="hdr-mid"><div class="hdr-biz">${_esc(bizName)}</div>${bizAddress?`<div class="hdr-det">${_esc(bizAddress)}</div>`:''}${bizPhone?`<div class="hdr-det">📞 ${_esc(bizPhone)}</div>`:''}${bizEmail?`<div class="hdr-det">✉ ${_esc(bizEmail)}</div>`:''}</div>
    <div class="hdr-right"><div class="hdr-type">${typeLabel}</div>${docNumber?`<div class="hdr-num">#${_esc(docNumber)}</div>`:''}${docDate?`<div class="hdr-num">${fmtDate(docDate)}</div>`:''}${invoiceRef&&_docType==='receipt'?`<div class="hdr-num">${_docLang==='es'?'Ref':'Ref'}: ${_esc(invoiceRef)}</div>`:''}</div>
  </div>
  <div class="red-bar"></div>
  <div class="info-row">
    <div class="info-box"><div class="info-lbl">${_docLang==='es'?'De':'From'}</div><div class="info-name">${_esc(bizName)||'—'}</div><div class="info-det">${[bizAddress,bizPhone,bizEmail].filter(Boolean).map(x=>_esc(x)).join('<br>')}</div></div>
    <div class="info-box red"><div class="info-lbl">${custLabel}</div><div class="info-name">${_esc(custName)||'—'}</div><div class="info-det">${[custAddr,custPhone,custEmail].filter(Boolean).map(x=>_esc(x)).join('<br>')}</div></div>
  </div>
  <div class="body">
    ${(projectTitle||jobOrderedBy||jobLocation||duration)?`<div class="field-row">${projectTitle?`<div class="field-item"><div class="field-lbl">${_docLang==='es'?'Proyecto':'Project'}</div><div class="field-val">${_esc(projectTitle)}</div></div>`:''} ${jobOrderedBy?`<div class="field-item"><div class="field-lbl">${_docLang==='es'?'Ordenado Por':'Ordered By'}</div><div class="field-val">${_esc(jobOrderedBy)}</div></div>`:''} ${jobLocation?`<div class="field-item"><div class="field-lbl">${_docLang==='es'?'Ubicación':'Location'}</div><div class="field-val">${_esc(jobLocation)}</div></div>`:''} ${duration?`<div class="field-item"><div class="field-lbl">${_docLang==='es'?'Duración':'Duration'}</div><div class="field-val">${_esc(duration)}</div></div>`:''}</div>`:''}
    ${jobScope?`<div class="scope-box"><div class="scope-lbl">${_docLang==='es'?'Alcance del Trabajo':'Scope of Work'}</div>${scopeHtml}</div>`:''}
    ${(_docShowPricing&&_docType!=='contract')?`<table><thead><tr><th>${L.desc}</th><th style="text-align:right;">${L.total}</th></tr></thead><tbody>${itemsHtml}</tbody></table>
    <div style="display:flex;justify-content:flex-end;margin-bottom:20px;"><table class="totals"><tr><td>${L.subtotal}</td><td style="text-align:right;">$${subtotal.toFixed(2)}</td></tr>${taxRate>0?`<tr><td>${L.tax} (${taxRate}%)</td><td style="text-align:right;">$${taxAmt.toFixed(2)}</td></tr>`:''}<tr class="grand"><td><strong>${grandTotalLabel}</strong></td><td style="text-align:right;"><strong>$${grand.toFixed(2)}</strong></td></tr>${receiptPaymentHtml}${advance>0?`<tr><td>${L.advance}</td><td style="text-align:right;color:#15803d;">−$${advance.toFixed(2)}</td></tr>`:''} ${advance>0?`<tr class="balance"><td><strong>${L.balance}</strong></td><td style="text-align:right;"><strong>$${balance.toFixed(2)}</strong></td></tr>`:''}</table></div>${paidInFullHtml}${payInstructionsHtml}`:''}
    ${_docType==='contract'&&contractTxt?`<div style="font-size:0.82rem;color:#475569;white-space:pre-wrap;line-height:1.6;border:1px solid #e2e8f0;padding:14px;margin-bottom:16px;">${_esc(contractTxt)}</div>`:''}
    ${notes?`<div class="notes">📌 ${_esc(notes)}</div>`:''}
    ${includeTC&&termsText?`<div style="margin-top:20px;padding-top:14px;border-top:2px solid #e2e8f0;"><div style="font-size:0.65rem;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;">⚖️ ${L.tcTitle}</div><div style="font-size:0.75rem;color:#475569;line-height:1.7;white-space:pre-wrap;background:#f8fafc;border:1px solid #e2e8f0;padding:12px;">${_esc(termsText)}</div></div>`:''}
    ${paymentBlockHtml?`<div style="margin-top:20px;padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;text-align:center;"><div style="font-size:0.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:10px;">💳 ${_docLang==='es'?'Opciones de Pago':'Payment Options'}</div><div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;">${paymentBlockHtml}</div></div>`:''}
    ${(_docType==='estimate'||_docType==='contract') ? _docSigSection(custName, bizName) : ''}
  </div>
  <div class="foot"><span>${L.thankYou}</span><span>${typeLabel} ${_esc(docNumber)}</span></div>
</div></body></html>`;
}

// ── Template 3: Executive Dark (navy & gold) ──────────────────
function _docTplExecutive() {
  const { L, bizName, bizAddress, bizPhone, bizEmail, custName, custEmail, custPhone, custAddr,
    docNumber, docDate, notes, contractTxt, projectTitle, jobOrderedBy, jobLocation,
    duration, jobScope, taxRate, advance, includeTC, termsText, subtotal, taxAmt, grand, balance,
    grandTotalLabel, typeLabel, custLabel, fmtDate, logoHtml, TYPE_LABELS_ES, scopeHtml,
    receiptPaymentHtml, paidInFullHtml, payInstructionsHtml, invoiceRef, paymentBlockHtml } = _docGetData();

  const gold = '#c9972b'; const navy = '#0f172a';

  const itemsHtml = _docType !== 'contract' ? _docItems.map(it => {
    const k = it.type || 'other';
    const tl = _docLang === 'es' ? (TYPE_LABELS_ES[k] || k) : k.charAt(0).toUpperCase() + k.slice(1);
    return `<tr><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;"><span style="font-size:0.65rem;font-weight:700;color:${gold};text-transform:uppercase;letter-spacing:.04em;">${_esc(tl)}</span><br><span style="font-size:0.82rem;">${_esc(it.desc)}</span></td><td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700;">$${(it.price||0).toFixed(2)}</td></tr>`;
  }).join('') : '';


  return `<!DOCTYPE html><html lang="${_docLang==='es'?'es':'en'}"><head><meta charset="utf-8"/><title>${typeLabel} ${docNumber}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Georgia',serif;color:#1e293b;background:#fff;padding:0;font-size:13px;line-height:1.6}.wrap{max-width:760px;margin:0 auto}
.hdr{background:${navy};padding:28px 32px;display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap}.hdr-left{display:flex;align-items:center;gap:16px}.logo-box{background:rgba(255,255,255,.1);padding:8px;border-radius:4px;min-width:60px;text-align:center}.biz-name{font-size:1.1rem;font-weight:700;color:#fff}.biz-det{font-size:0.75rem;color:#94a3b8;margin-top:2px}.hdr-right{text-align:right}.doc-type{font-size:1.8rem;font-weight:400;color:${gold};letter-spacing:.06em;text-transform:uppercase;font-style:italic}.doc-num{font-size:0.8rem;color:#94a3b8;margin-top:4px}
.gold-bar{height:3px;background:linear-gradient(90deg,${gold},#f5d87a,${gold})}
.party-row{display:flex;gap:1px;background:#e2e8f0}.party{flex:1;background:#fff;padding:16px 20px;border-bottom:3px solid ${gold}}.party.client{border-bottom-color:${navy}}.plbl{font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:${gold};margin-bottom:6px}.pname{font-size:0.95rem;font-weight:700;color:${navy}}.pdet{font-size:0.75rem;color:#64748b;margin-top:3px;line-height:1.5}
.body{padding:24px}
table{width:100%;border-collapse:collapse;margin-bottom:16px}thead tr{background:${navy};color:#fff}thead th{padding:10px 14px;text-align:left;font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em}thead th:not(:first-child){text-align:right}tbody tr:nth-child(even){background:#fafaf8}.totals{margin-left:auto;width:300px;border-top:3px solid ${gold};border:1px solid #e2e8f0}.totals td{padding:8px 14px;font-size:0.85rem;color:#475569;border-bottom:1px solid #f1f5f9}.totals .grand td{font-weight:800;color:${navy};background:#fdf8ef;border-bottom:none}.totals .balance td{font-weight:800;color:#dc2626;background:#fff5f5}
.scope-box{padding:16px 20px;background:#fafaf8;border-left:4px solid ${gold};margin-bottom:20px}.scope-lbl{font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:8px}
.notes{background:#fdf8ef;border:1px solid #fde68a;padding:12px 16px;font-size:0.82rem;color:#78350f;margin-bottom:16px}
.foot{background:${navy};color:#94a3b8;padding:12px 24px;display:flex;justify-content:space-between;font-size:0.7rem;margin-top:24px}
@media print{body{padding:0}.wrap{max-width:100%}}</style></head>
<body><div class="wrap">
  <div class="hdr">
    <div class="hdr-left"><div class="logo-box">${logoHtml||`<div style="width:60px;height:50px;background:rgba(255,255,255,.1);border-radius:4px;"></div>`}</div><div><div class="biz-name">${_esc(bizName)}</div>${bizAddress?`<div class="biz-det">${_esc(bizAddress)}</div>`:''}${bizPhone?`<div class="biz-det">${_esc(bizPhone)}</div>`:''}${bizEmail?`<div class="biz-det">${_esc(bizEmail)}</div>`:''}</div></div>
    <div class="hdr-right"><div class="doc-type">${typeLabel}</div>${docNumber?`<div class="doc-num"># ${_esc(docNumber)}</div>`:''}${docDate?`<div class="doc-num">${fmtDate(docDate)}</div>`:''}${invoiceRef&&_docType==='receipt'?`<div class="doc-num">${_docLang==='es'?'Ref':'Ref'}: ${_esc(invoiceRef)}</div>`:''}</div>
  </div>
  <div class="gold-bar"></div>
  <div class="party-row">
    <div class="party"><div class="plbl">${_docLang==='es'?'De':'From'}</div><div class="pname">${_esc(bizName)}</div><div class="pdet">${[bizAddress,bizPhone,bizEmail].filter(Boolean).map(x=>_esc(x)).join('<br>')}</div></div>
    <div class="party client"><div class="plbl" style="color:${navy}">${custLabel}</div><div class="pname">${_esc(custName)||'—'}</div><div class="pdet">${[custAddr,custPhone,custEmail].filter(Boolean).map(x=>_esc(x)).join('<br>')}</div></div>
  </div>
  <div class="body">
    ${(projectTitle||jobOrderedBy||jobLocation||duration)?`<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px;">${projectTitle?`<div style="padding:10px 14px;background:#fafaf8;border:1px solid #e2e8f0;border-left:3px solid ${gold};"><div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:4px;">${_docLang==='es'?'Proyecto':'Project'}</div><div style="font-size:0.9rem;font-weight:700;color:${navy};">${_esc(projectTitle)}</div></div>`:''} ${jobOrderedBy?`<div style="padding:10px 14px;background:#fafaf8;border:1px solid #e2e8f0;"><div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:4px;">${_docLang==='es'?'Ordenado Por':'Ordered By'}</div><div style="font-size:0.85rem;font-weight:600;">${_esc(jobOrderedBy)}</div></div>`:''} ${jobLocation?`<div style="padding:10px 14px;background:#fafaf8;border:1px solid #e2e8f0;"><div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:4px;">${_docLang==='es'?'Ubicación':'Location'}</div><div style="font-size:0.85rem;font-weight:600;">${_esc(jobLocation)}</div></div>`:''} ${duration?`<div style="padding:10px 14px;background:#fafaf8;border:1px solid #e2e8f0;"><div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:4px;">${_docLang==='es'?'Duración':'Duration'}</div><div style="font-size:0.85rem;font-weight:600;">${_esc(duration)}</div></div>`:''}</div>`:''}
    ${jobScope?`<div class="scope-box"><div class="scope-lbl">${_docLang==='es'?'Alcance del Trabajo':'Scope of Work'}</div>${scopeHtml}</div>`:''}
    ${(_docShowPricing&&_docType!=='contract')?`<table><thead><tr><th>${L.desc}</th><th style="text-align:right;">${L.total}</th></tr></thead><tbody>${itemsHtml}</tbody></table>
    <div style="display:flex;justify-content:flex-end;margin-bottom:20px;"><table class="totals"><tr><td>${L.subtotal}</td><td style="text-align:right;">$${subtotal.toFixed(2)}</td></tr>${taxRate>0?`<tr><td>${L.tax} (${taxRate}%)</td><td style="text-align:right;">$${taxAmt.toFixed(2)}</td></tr>`:''}<tr class="grand"><td><strong>${grandTotalLabel}</strong></td><td style="text-align:right;"><strong>$${grand.toFixed(2)}</strong></td></tr>${receiptPaymentHtml}${advance>0?`<tr><td style="color:#15803d;">${L.advance}</td><td style="text-align:right;color:#15803d;">−$${advance.toFixed(2)}</td></tr>`:''} ${advance>0?`<tr class="balance"><td><strong>${L.balance}</strong></td><td style="text-align:right;"><strong>$${balance.toFixed(2)}</strong></td></tr>`:''}</table></div>${paidInFullHtml}${payInstructionsHtml}`:''}
    ${_docType==='contract'&&contractTxt?`<div style="font-size:0.82rem;color:#475569;white-space:pre-wrap;line-height:1.7;border:1px solid #e2e8f0;padding:16px;background:#fafaf8;margin-bottom:16px;">${_esc(contractTxt)}</div>`:''}
    ${notes?`<div class="notes">📌 ${_esc(notes)}</div>`:''}
    ${includeTC&&termsText?`<div style="margin-top:20px;padding-top:14px;border-top:1px solid #e2e8f0;"><div style="font-size:0.65rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;">⚖️ ${L.tcTitle}</div><div style="font-size:0.75rem;color:#475569;line-height:1.7;white-space:pre-wrap;background:#fafaf8;border:1px solid #e2e8f0;padding:14px;">${_esc(termsText)}</div></div>`:''}
    ${paymentBlockHtml?`<div style="margin-top:20px;padding:16px;background:#fdf8ef;border:1px solid #fde68a;border-radius:10px;text-align:center;"><div style="font-size:0.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#92400e;margin-bottom:10px;">💳 ${_docLang==='es'?'Opciones de Pago':'Payment Options'}</div><div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;">${paymentBlockHtml}</div></div>`:''}
    ${(_docType==='estimate'||_docType==='contract') ? _docSigSection(custName, bizName) : ''}
  </div>
  <div class="foot"><span>${L.thankYou}</span><span>${typeLabel} ${_esc(docNumber)}</span></div>
</div></body></html>`;
}

// ── Template 4: Modern Gradient (purple → teal) ───────────────
function _docTplModern() {
  const { L, bizName, bizAddress, bizPhone, bizEmail, custName, custEmail, custPhone, custAddr,
    docNumber, docDate, notes, contractTxt, projectTitle, jobOrderedBy, jobLocation,
    duration, jobScope, taxRate, advance, includeTC, termsText, subtotal, taxAmt, grand, balance,
    grandTotalLabel, typeLabel, fmtDate, logoHtml, TYPE_COLORS, TYPE_LABELS_ES, scopeHtml,
    receiptPaymentHtml, paidInFullHtml, payInstructionsHtml, invoiceRef, paymentBlockHtml } = _docGetData();

  const itemsHtml = _docType !== 'contract' ? _docItems.map(it => {
    const k = it.type || 'other';
    const tc = TYPE_COLORS[k] || '#64748b';
    const tl = _docLang === 'es' ? (TYPE_LABELS_ES[k] || k) : k.charAt(0).toUpperCase() + k.slice(1);
    return `<tr><td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;"><span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:0.6rem;font-weight:800;text-transform:uppercase;background:${tc};color:#fff;margin-bottom:3px;">${_esc(tl)}</span><br><span style="font-size:0.82rem;">${_esc(it.desc)}</span></td><td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:700;">$${(it.price||0).toFixed(2)}</td></tr>`;
  }).join('') : '';


  return `<!DOCTYPE html><html lang="${_docLang==='es'?'es':'en'}"><head><meta charset="utf-8"/><title>${typeLabel} ${docNumber}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1e293b;background:#f1f5f9;padding:20px;font-size:13px;line-height:1.5}.wrap{max-width:760px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.1)}
.hdr{background:linear-gradient(135deg,#7c3aed 0%,#0891b2 100%);padding:28px 32px;color:#fff;display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}.logo-wrap{background:rgba(255,255,255,.2);border-radius:12px;padding:8px;display:inline-flex;align-items:center;justify-content:center}.hdr-biz{font-size:1rem;font-weight:800}.hdr-det{font-size:0.72rem;color:rgba(255,255,255,.75);margin-top:2px}.doc-type{font-size:2rem;font-weight:900;letter-spacing:-0.02em;text-transform:uppercase}.doc-num{font-size:0.75rem;color:rgba(255,255,255,.75);margin-top:4px}
.party-cards{display:flex;gap:16px;padding:20px 24px;flex-wrap:wrap}.card{flex:1;min-width:200px;background:#f8fafc;border-radius:12px;padding:14px 18px;border:1px solid #e2e8f0}.card-lbl{font-size:0.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:6px}.card-name{font-size:0.95rem;font-weight:700;color:#1e293b}.card-det{font-size:0.75rem;color:#64748b;line-height:1.5;margin-top:3px}
.body{padding:0 24px 24px}
.info-cards{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px}.ic{background:#f8fafc;border-radius:10px;padding:12px 14px;border:1px solid #e2e8f0}.ic-lbl{font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:4px}.ic-val{font-size:0.85rem;font-weight:600;color:#1e293b}
table{width:100%;border-collapse:collapse;margin-bottom:16px;border-radius:12px;overflow:hidden}thead tr{background:linear-gradient(90deg,#7c3aed,#0891b2);color:#fff}thead th{padding:10px 14px;text-align:left;font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em}thead th:not(:first-child){text-align:right}tbody tr:nth-child(even){background:#f8fafc}
.totals-wrap{display:flex;justify-content:flex-end;margin-bottom:20px}.totals{width:300px;background:#f8fafc;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0}.totals td{padding:8px 16px;font-size:0.85rem;color:#475569;border-bottom:1px solid #f1f5f9}.totals .grand td{font-size:1.05rem;font-weight:800;color:#1e293b;background:linear-gradient(90deg,#f0f0ff,#e8f9ff);border-bottom:none}.totals .balance td{font-size:1.05rem;font-weight:800;color:#dc2626;background:#fff5f5}
.scope-card{background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:20px;border:1px solid #e2e8f0;border-left:4px solid #7c3aed}.scope-lbl{font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:8px}
.notes{background:#fffbeb;border-radius:10px;border:1px solid #fde68a;padding:12px 16px;font-size:0.82rem;color:#78350f;margin-bottom:16px}
.foot{background:linear-gradient(135deg,#7c3aed,#0891b2);color:rgba(255,255,255,.8);padding:12px 24px;display:flex;justify-content:space-between;font-size:0.72rem}
@media print{body{padding:0;background:#fff}.wrap{box-shadow:none;border-radius:0;max-width:100%}}</style></head>
<body><div class="wrap">
  <div class="hdr">
    <div style="display:flex;align-items:center;gap:14px;"><div class="logo-wrap">${logoHtml||`<div style="width:52px;height:44px;background:rgba(255,255,255,.2);border-radius:8px;"></div>`}</div><div><div class="hdr-biz">${_esc(bizName)}</div>${bizAddress?`<div class="hdr-det">${_esc(bizAddress)}</div>`:''}${bizPhone?`<div class="hdr-det">${_esc(bizPhone)}</div>`:''}${bizEmail?`<div class="hdr-det">${_esc(bizEmail)}</div>`:''}</div></div>
    <div style="text-align:right;"><div class="doc-type">${typeLabel}</div>${docNumber?`<div class="doc-num">#${_esc(docNumber)}</div>`:''}${docDate?`<div class="doc-num">${fmtDate(docDate)}</div>`:''}${invoiceRef&&_docType==='receipt'?`<div class="doc-num">${_docLang==='es'?'Ref':'Ref'}: ${_esc(invoiceRef)}</div>`:''}</div>
  </div>
  <div class="party-cards">
    <div class="card"><div class="card-lbl">${_docLang==='es'?'De':'From'}</div><div class="card-name">${_esc(bizName)}</div><div class="card-det">${[bizAddress,bizPhone,bizEmail].filter(Boolean).map(x=>_esc(x)).join('<br>')}</div></div>
    <div class="card"><div class="card-lbl">${custLabel}</div><div class="card-name">${_esc(custName)||'—'}</div><div class="card-det">${[custAddr,custPhone,custEmail].filter(Boolean).map(x=>_esc(x)).join('<br>')}</div></div>
  </div>
  <div class="body">
    ${(projectTitle||jobOrderedBy||jobLocation||duration)?`<div class="info-cards">${projectTitle?`<div class="ic" style="border-left:3px solid #7c3aed;"><div class="ic-lbl">${_docLang==='es'?'Proyecto':'Project'}</div><div class="ic-val">${_esc(projectTitle)}</div></div>`:''} ${jobOrderedBy?`<div class="ic"><div class="ic-lbl">${_docLang==='es'?'Ordenado Por':'Ordered By'}</div><div class="ic-val">${_esc(jobOrderedBy)}</div></div>`:''} ${jobLocation?`<div class="ic"><div class="ic-lbl">${_docLang==='es'?'Ubicación':'Location'}</div><div class="ic-val">${_esc(jobLocation)}</div></div>`:''} ${duration?`<div class="ic"><div class="ic-lbl">${_docLang==='es'?'Duración':'Duration'}</div><div class="ic-val">${_esc(duration)}</div></div>`:''}</div>`:''}
    ${jobScope?`<div class="scope-card"><div class="scope-lbl">${_docLang==='es'?'Alcance del Trabajo':'Scope of Work'}</div>${scopeHtml}</div>`:''}
    ${(_docShowPricing&&_docType!=='contract')?`<table><thead><tr><th>${L.desc}</th><th style="text-align:right;">${L.total}</th></tr></thead><tbody>${itemsHtml}</tbody></table>
    <div class="totals-wrap"><table class="totals"><tr><td>${L.subtotal}</td><td style="text-align:right;">$${subtotal.toFixed(2)}</td></tr>${taxRate>0?`<tr><td>${L.tax} (${taxRate}%)</td><td style="text-align:right;">$${taxAmt.toFixed(2)}</td></tr>`:''}<tr class="grand"><td><strong>${grandTotalLabel}</strong></td><td style="text-align:right;"><strong>$${grand.toFixed(2)}</strong></td></tr>${receiptPaymentHtml}${advance>0?`<tr><td style="color:#15803d;">${L.advance}</td><td style="text-align:right;color:#15803d;">−$${advance.toFixed(2)}</td></tr>`:''} ${advance>0?`<tr class="balance"><td><strong>${L.balance}</strong></td><td style="text-align:right;"><strong>$${balance.toFixed(2)}</strong></td></tr>`:''}</table></div>${paidInFullHtml}${payInstructionsHtml}`:''}
    ${_docType==='contract'&&contractTxt?`<div style="font-size:0.82rem;color:#475569;white-space:pre-wrap;line-height:1.7;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;padding:16px;margin-bottom:16px;">${_esc(contractTxt)}</div>`:''}
    ${notes?`<div class="notes">📌 ${_esc(notes)}</div>`:''}
    ${includeTC&&termsText?`<div style="margin-top:20px;padding-top:14px;border-top:1px solid #e2e8f0;"><div style="font-size:0.65rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;">⚖️ ${L.tcTitle}</div><div style="font-size:0.75rem;color:#475569;line-height:1.7;white-space:pre-wrap;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;padding:14px;">${_esc(termsText)}</div></div>`:''}
    ${paymentBlockHtml?`<div style="margin-top:20px;padding:16px;background:#f0f4ff;border:1px solid #c7d2fe;border-radius:12px;text-align:center;"><div style="font-size:0.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#4338ca;margin-bottom:10px;">💳 ${_docLang==='es'?'Opciones de Pago':'Payment Options'}</div><div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;">${paymentBlockHtml}</div></div>`:''}
    ${(_docType==='estimate'||_docType==='contract') ? _docSigSection(custName, bizName) : ''}
  </div>
  <div class="foot"><span>${L.thankYou}</span><span>${typeLabel} ${_esc(docNumber)}</span></div>
</div></body></html>`;
}

// ── Template 5: Minimal Pro (black & white, clean) ────────────
function _docTplMinimal() {
  const { L, bizName, bizAddress, bizPhone, bizEmail, custName, custEmail, custPhone, custAddr,
    docNumber, docDate, notes, contractTxt, projectTitle, jobOrderedBy, jobLocation,
    duration, jobScope, taxRate, advance, includeTC, termsText, subtotal, taxAmt, grand, balance,
    grandTotalLabel, typeLabel, custLabel, fmtDate, logoHtml, TYPE_LABELS_ES, scopeHtml,
    receiptPaymentHtml, paidInFullHtml, payInstructionsHtml, invoiceRef, paymentBlockHtml } = _docGetData();

  const itemsHtml = _docType !== 'contract' ? _docItems.map(it => {
    const k = it.type || 'other';
    const tl = _docLang === 'es' ? (TYPE_LABELS_ES[k] || k) : k.charAt(0).toUpperCase() + k.slice(1);
    return `<tr><td style="padding:10px 0;border-bottom:1px solid #e2e8f0;"><span style="font-size:0.65rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;">${_esc(tl)}</span><br><span style="font-size:0.85rem;">${_esc(it.desc)}</span></td><td style="padding:10px 0;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600;">$${(it.price||0).toFixed(2)}</td></tr>`;
  }).join('') : '';


  return `<!DOCTYPE html><html lang="${_docLang==='es'?'es':'en'}"><head><meta charset="utf-8"/><title>${typeLabel} ${docNumber}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1e293b;background:#fff;padding:40px;font-size:13px;line-height:1.6}.wrap{max-width:720px;margin:0 auto}
.top{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:20px;border-bottom:2px solid #1e293b;margin-bottom:28px;gap:16px;flex-wrap:wrap}.biz-name{font-size:0.9rem;font-weight:700;margin-top:8px}.biz-det{font-size:0.75rem;color:#64748b;margin-top:1px}.doc-type{font-size:2rem;font-weight:300;text-transform:uppercase;letter-spacing:.08em}.doc-num{font-size:0.78rem;color:#94a3b8;margin-top:6px}
.parties{display:flex;gap:40px;margin-bottom:28px;padding-bottom:28px;border-bottom:1px solid #e2e8f0;flex-wrap:wrap}.party{flex:1;min-width:160px}.party-lbl{font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;border-bottom:1px solid #e2e8f0;padding-bottom:4px;margin-bottom:6px}.party-name{font-size:0.9rem;font-weight:600}.party-det{font-size:0.75rem;color:#64748b;margin-top:3px;line-height:1.5}
table{width:100%;border-collapse:collapse;margin-bottom:16px}thead th{padding:8px 0;text-align:left;font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;border-bottom:2px solid #1e293b}thead th:not(:first-child){text-align:right}
.totals{margin-left:auto;width:260px}.totals td{padding:5px 0;font-size:0.85rem;color:#475569;border-bottom:1px solid #f1f5f9}.totals .grand td{font-size:1rem;font-weight:700;color:#1e293b;border-top:2px solid #1e293b;border-bottom:none;padding-top:8px}.totals .balance td{font-size:1.05rem;font-weight:800}
.section-head{font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;border-bottom:1px solid #e2e8f0;padding-bottom:4px;margin-bottom:8px}
.notes{border-left:3px solid #1e293b;padding:8px 14px;font-size:0.82rem;color:#475569;margin-bottom:16px}
.foot{margin-top:40px;padding-top:16px;border-top:2px solid #1e293b;display:flex;justify-content:space-between;font-size:0.7rem;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8}
@media print{body{padding:24px}.wrap{max-width:100%}}</style></head>
<body><div class="wrap">
  <div class="top">
    <div>${logoHtml}<div class="biz-name">${_esc(bizName)}</div>${bizAddress?`<div class="biz-det">${_esc(bizAddress)}</div>`:''}${bizPhone?`<div class="biz-det">${_esc(bizPhone)}</div>`:''}${bizEmail?`<div class="biz-det">${_esc(bizEmail)}</div>`:''}</div>
    <div style="text-align:right;"><div class="doc-type">${typeLabel}</div>${docNumber?`<div class="doc-num"># ${_esc(docNumber)}</div>`:''}${docDate?`<div class="doc-num">${fmtDate(docDate)}</div>`:''}${invoiceRef&&_docType==='receipt'?`<div class="doc-num">${_docLang==='es'?'Ref':'Ref'}: ${_esc(invoiceRef)}</div>`:''}</div>
  </div>
  <div class="parties">
    <div class="party"><div class="party-lbl">${_docLang==='es'?'De':'From'}</div><div class="party-name">${_esc(bizName)||'—'}</div><div class="party-det">${[bizAddress,bizPhone,bizEmail].filter(Boolean).map(x=>_esc(x)).join('<br>')}</div></div>
    <div class="party"><div class="party-lbl">${custLabel}</div><div class="party-name">${_esc(custName)||'—'}</div><div class="party-det">${[custAddr,custPhone,custEmail].filter(Boolean).map(x=>_esc(x)).join('<br>')}</div></div>
    ${jobOrderedBy||jobLocation?`<div class="party">${jobOrderedBy?`<div class="party-lbl">${_docLang==='es'?'Ordenado Por':'Ordered By'}</div><div class="party-name">${_esc(jobOrderedBy)}</div>`:''} ${jobLocation?`<div class="party-lbl" style="margin-top:8px;">${_docLang==='es'?'Ubicación':'Location'}</div><div class="party-det">${_esc(jobLocation)}</div>`:''}</div>`:''}
  </div>
  ${projectTitle?`<div style="margin-bottom:20px;"><div class="section-head">${_docLang==='es'?'Proyecto':'Project'}</div><div style="font-size:1rem;font-weight:600;">${_esc(projectTitle)}</div></div>`:''}
  ${jobScope?`<div style="margin-bottom:24px;"><div class="section-head">${_docLang==='es'?'Alcance del Trabajo':'Scope of Work'}</div>${scopeHtml}</div>`:''}
  ${(_docShowPricing&&_docType!=='contract')?`<table><thead><tr><th>${L.desc}</th><th style="text-align:right;">${L.total}</th></tr></thead><tbody>${itemsHtml}</tbody></table>
  <div style="display:flex;justify-content:flex-end;margin-bottom:24px;"><table class="totals"><tr><td>${L.subtotal}</td><td style="text-align:right;">$${subtotal.toFixed(2)}</td></tr>${taxRate>0?`<tr><td>${L.tax} (${taxRate}%)</td><td style="text-align:right;">$${taxAmt.toFixed(2)}</td></tr>`:''}<tr class="grand"><td><strong>${grandTotalLabel}</strong></td><td style="text-align:right;"><strong>$${grand.toFixed(2)}</strong></td></tr>${receiptPaymentHtml}${advance>0?`<tr><td>${L.advance}</td><td style="text-align:right;">−$${advance.toFixed(2)}</td></tr>`:''} ${advance>0?`<tr class="balance"><td><strong>${L.balance}</strong></td><td style="text-align:right;"><strong>$${balance.toFixed(2)}</strong></td></tr>`:''}</table></div>${paidInFullHtml}${payInstructionsHtml}`:''}
  ${duration?`<div style="margin-bottom:20px;"><div class="section-head">${_docLang==='es'?'Duración Estimada':'Est. Duration'}</div><div style="font-size:0.85rem;">${_esc(duration)}</div></div>`:''}
  ${_docType==='contract'&&contractTxt?`<div style="margin-bottom:20px;"><div class="section-head">${L.terms}</div><div style="font-size:0.82rem;color:#475569;white-space:pre-wrap;line-height:1.7;">${_esc(contractTxt)}</div></div>`:''}
  ${notes?`<div class="notes">Note: ${_esc(notes)}</div>`:''}
  ${includeTC&&termsText?`<div style="margin-top:20px;padding-top:14px;border-top:1px solid #e2e8f0;"><div class="section-head">⚖️ ${L.tcTitle}</div><div style="font-size:0.75rem;color:#475569;line-height:1.7;white-space:pre-wrap;">${_esc(termsText)}</div></div>`:''}
  ${paymentBlockHtml?`<div style="margin-top:28px;padding:16px;border:1px solid #e2e8f0;border-left:3px solid #1e293b;text-align:center;"><div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:10px;">💳 ${_docLang==='es'?'Opciones de Pago':'Payment Options'}</div><div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;">${paymentBlockHtml}</div></div>`:''}
  ${(_docType==='estimate'||_docType==='contract') ? _docSigSection(custName, bizName) : ''}
  <div class="foot"><span>${L.thankYou}</span><span>${typeLabel} ${_esc(docNumber)}</span></div>
</div></body></html>`;
}

// ── Save to Firestore ─────────────────────────────────────────
window._docSave = async function() {
  const btn = document.getElementById('docSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving…'; }
  try {
    const htmlContent = _docGenerateHTML();

    const data = {
      type:         _docType,
      lang:         _docLang,
      bizName:      document.getElementById('docBizName')?.value    || '',
      bizAddress:   document.getElementById('docBizAddress')?.value || '',
      bizPhone:     document.getElementById('docBizPhone')?.value   || '',
      bizEmail:     document.getElementById('docBizEmail')?.value   || '',
      custName:     document.getElementById('docCustName')?.value   || '',
      custEmail:    document.getElementById('docCustEmail')?.value  || '',
      custPhone:    document.getElementById('docCustPhone')?.value  || '',
      custAddress:  document.getElementById('docCustAddress')?.value|| '',
      docNumber:    document.getElementById('docNumber')?.value     || '',
      docDate:      document.getElementById('docDate')?.value       || '',
      docDueDate:   document.getElementById('docDueDate')?.value    || '',
      notes:        document.getElementById('docNotes')?.value        || '',
      contractText: document.getElementById('docContractText')?.value || '',
      projectTitle: document.getElementById('docProjectTitle')?.value || '',
      jobOrderedBy: document.getElementById('docJobOrderedBy')?.value || '',
      jobLocation:  document.getElementById('docJobLocation')?.value  || '',
      duration:     document.getElementById('docDuration')?.value     || '',
      jobScope:     document.getElementById('docJobScope')?.value     || '',
      showPricing:  _docShowPricing,
      advance:      parseFloat(document.getElementById('docAdvancePayment')?.value || 0),
      includeTC:    document.getElementById('docIncludeTC')?.checked  || false,
      termsText:    document.getElementById('docTermsText')?.value    || '',
      taxRate:        parseFloat(document.getElementById('docTaxRate')?.value || 0),
      paymentMethod:  document.getElementById('docPaymentMethod')?.value || '',
      items:          _docItems,
      logoUrl:        _docLogoDataUrl,
      htmlContent:    htmlContent,
      designTemplate: _docDesignTemplate,
      ownerUid:     auth.currentUser?.uid || '',
      createdAt:    serverTimestamp()
    };

    // Save customer if checkbox checked
    if (document.getElementById('docSaveCust')?.checked && data.custName) {
      await _docAutoSaveCustomer(data);
    }

    // Compute amount for card renderer compatibility
    const grand = data.items.reduce((s,it)=>s+(it.price||0),0) * (1 + data.taxRate/100);
    data.customerName = data.custName;
    data.amount       = grand.toFixed(2);

    let savedId = _docCurrentId;
    if (_docCurrentId) {
      await updateDoc(doc(db, 'documents', _docCurrentId), { ...data, updatedAt: serverTimestamp() });
    } else {
      const ref = await addDoc(collection(db, 'documents'), data);
      savedId = ref.id;
      _docCurrentId = savedId;
    }

    // Close creator
    document.getElementById('docCreatorModal')?.classList.add('hidden');
    document.body.style.overflow = '';
    loadAdminDocuments();

    // Show share modal with live link
    const viewUrl = `${window.location.origin}/view.html?id=${savedId}`;
    _docShowShareModal(viewUrl, data.docNumber, data.type);
  } catch(e) {
    alert('Error saving document: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Save Document'; }
  }
};

function _docShowShareModal(viewUrl, docNumber, type) {
  const existing = document.getElementById('docShareModal');
  if (existing) existing.remove();

  const typeLabel = (type || 'document').charAt(0).toUpperCase() + (type || 'document').slice(1);

  const modal = document.createElement('div');
  modal.id = 'docShareModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:28px 28px 24px;max-width:460px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3);">
      <div style="text-align:center;margin-bottom:20px;">
        <div style="font-size:2.5rem;margin-bottom:8px;">✅</div>
        <div style="font-size:1.1rem;font-weight:800;color:#1e293b;">${_docCurrentId ? 'Document Saved!' : 'Document Updated!'}</div>
        <div style="font-size:0.82rem;color:#64748b;margin-top:4px;">${typeLabel}${docNumber ? ' #' + docNumber : ''} — ready to share</div>
      </div>
      <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:6px;">Shareable Link</div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:10px 14px;margin-bottom:8px;display:flex;align-items:center;gap:8px;">
        <span style="font-size:0.78rem;color:#475569;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${viewUrl}</span>
        <button id="shareModalCopyBtn" style="background:#4f46e5;color:#fff;border:none;border-radius:7px;padding:6px 12px;font-size:0.75rem;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;">Copy Link</button>
      </div>
      <div style="font-size:0.73rem;color:#94a3b8;margin-bottom:16px;">🔄 When you edit and save again, the customer's link auto-updates instantly</div>
      ${(type==='estimate'||type==='contract') ? `
      <div style="border-top:1px solid #e2e8f0;padding-top:14px;margin-bottom:14px;">
        <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:6px;">✍️ Signature Request</div>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:10px 14px;margin-bottom:8px;display:flex;align-items:center;gap:8px;">
          <span id="shareModalSignUrl" style="font-size:0.78rem;color:#166534;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
          <button id="shareModalCopySign" style="background:#15803d;color:#fff;border:none;border-radius:7px;padding:6px 12px;font-size:0.75rem;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;">Copy</button>
        </div>
        <div style="font-size:0.72rem;color:#94a3b8;">Send this link to your customer — they can sign electronically</div>
      </div>` : ''}
      <div style="display:flex;gap:10px;">
        <button id="shareModalWA" style="flex:1;background:#22c55e;color:#fff;border:none;border-radius:9px;padding:10px;font-size:0.82rem;font-weight:700;cursor:pointer;">💬 WhatsApp</button>
        <button id="shareModalEmail" style="flex:1;background:#4f46e5;color:#fff;border:none;border-radius:9px;padding:10px;font-size:0.82rem;font-weight:700;cursor:pointer;">📧 Email</button>
        <button id="shareModalClose" style="flex:1;background:#f1f5f9;color:#1e293b;border:none;border-radius:9px;padding:10px;font-size:0.82rem;font-weight:700;cursor:pointer;">Done</button>
      </div>
    </div>`;

  document.body.appendChild(modal);

  document.getElementById('shareModalCopyBtn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(viewUrl).then(() => {
      const b = document.getElementById('shareModalCopyBtn');
      if (b) { b.textContent = '✓ Copied!'; setTimeout(() => { b.textContent = 'Copy Link'; }, 2000); }
    });
  });

  document.getElementById('shareModalWA')?.addEventListener('click', () => {
    const L = DOC_LABELS[_docLang];
    const typeL = L[type] || type;
    const reviewText = _docLang === 'es' ? `Revisa tu ${typeL} aquí` : `Review your ${typeLabel} here`;
    const msg = `${reviewText}:\n${viewUrl}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  });

  document.getElementById('shareModalEmail')?.addEventListener('click', () => {
    const L = DOC_LABELS[_docLang];
    const typeL = L[type] || type;
    const subject = encodeURIComponent(`${typeL}${docNumber ? ' #' + docNumber : ''}`);
    const reviewText = _docLang === 'es' ? `Revisa tu ${typeL} aquí` : `Review your ${typeLabel} here`;
    const body = encodeURIComponent(`${reviewText}:\n${viewUrl}\n\nThis link always shows the latest version.`);
    window.open(`https://mail.google.com/mail/?view=cm&su=${subject}&body=${body}`, '_blank', 'noopener');
  });

  // Signature request link
  const signUrlEl = document.getElementById('shareModalSignUrl');
  if (signUrlEl) {
    const signUrl = `${window.location.origin}/sign.html?id=${_docCurrentId}`;
    signUrlEl.textContent = signUrl;
    document.getElementById('shareModalCopySign')?.addEventListener('click', () => {
      navigator.clipboard.writeText(signUrl).then(() => {
        const b = document.getElementById('shareModalCopySign');
        if (b) { b.textContent = '✓ Copied!'; setTimeout(() => { b.textContent = 'Copy'; }, 2000); }
      });
    });
  }

  document.getElementById('shareModalClose')?.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function _docAutoSaveCustomer(docData) {
  try {
    // Check if customer with same name already exists
    const existing = _docAllCustomers.find(c =>
      c.name.toLowerCase() === docData.custName.toLowerCase());
    if (!existing) {
      await addDoc(collection(db, 'customers'), {
        name:     docData.custName,
        email:    docData.custEmail,
        phone:    docData.custPhone,
        address:  docData.custAddress,
        ownerUid: auth.currentUser?.uid || '',
        createdAt: serverTimestamp()
      });
      await loadCustomers();
    }
  } catch(e) { /* silent */ }
}

// ── Print ─────────────────────────────────────────────────────
window._docPrint = function() {
  const frame = document.getElementById('docPreviewFrame');
  if (!frame || !frame.contentWindow) return;
  frame.contentWindow.focus();
  frame.contentWindow.print();
};

// ── Templates ─────────────────────────────────────────────────
window._docToggleTplMenu = function() {
  document.getElementById('docTplMenu')?.classList.toggle('hidden');
};

window._docSaveTemplate = async function() {
  document.getElementById('docTplMenu')?.classList.add('hidden');
  const name = prompt('Template name:');
  if (!name) return;
  try {
    await addDoc(collection(db, 'docTemplates'), {
      name,
      type:         _docType,
      lang:         _docLang,
      bizName:      document.getElementById('docBizName')?.value    || '',
      bizAddress:   document.getElementById('docBizAddress')?.value || '',
      bizPhone:     document.getElementById('docBizPhone')?.value   || '',
      bizEmail:     document.getElementById('docBizEmail')?.value   || '',
      notes:        document.getElementById('docNotes')?.value        || '',
      contractText: document.getElementById('docContractText')?.value || '',
      projectTitle: document.getElementById('docProjectTitle')?.value || '',
      jobOrderedBy: document.getElementById('docJobOrderedBy')?.value || '',
      jobLocation:  document.getElementById('docJobLocation')?.value  || '',
      duration:     document.getElementById('docDuration')?.value     || '',
      jobScope:     document.getElementById('docJobScope')?.value     || '',
      showPricing:  _docShowPricing,
      includeTC:    document.getElementById('docIncludeTC')?.checked  || false,
      termsText:    document.getElementById('docTermsText')?.value    || '',
      taxRate:        parseFloat(document.getElementById('docTaxRate')?.value || 0),
      paymentMethod:  document.getElementById('docPaymentMethod')?.value || '',
      items:          _docItems,
      logoUrl:        _docLogoDataUrl,
      designTemplate: _docDesignTemplate,
      ownerUid:       auth.currentUser?.uid || '',
      createdAt:    serverTimestamp()
    });
    await _loadDocTemplates();
    alert('Template saved!');
  } catch(e) { alert('Error: ' + e.message); }
};

window._docOpenTemplates = async function() {
  document.getElementById('docTplMenu')?.classList.add('hidden');
  await _loadDocTemplates();
  _renderDocTemplates();
  document.getElementById('docTemplatePickerModal')?.classList.remove('hidden');
};

async function _loadDocTemplates() {
  try {
    const snap = await getDocs(query(
      collection(db, 'docTemplates'),
      where('ownerUid', '==', auth.currentUser?.uid || ''),
      orderBy('createdAt', 'desc')
    ));
    _docAllTemplates = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch(e) { _docAllTemplates = []; }
}

function _renderDocTemplates() {
  const list = document.getElementById('docTemplatePickerList');
  if (!list) return;
  if (!_docAllTemplates.length) {
    list.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:20px">No templates saved yet.</p>';
    return;
  }
  list.innerHTML = _docAllTemplates.map(t => `
    <div class="doc-tpl-item">
      <span class="tpl-name">${_esc(t.name)}</span>
      <span class="tpl-type">${t.type || ''}</span>
      <button class="tpl-load" onclick="window._docLoadTemplate('${t.id}')">Load</button>
      <button class="tpl-del"  onclick="window._docDeleteTemplate('${t.id}')">✕</button>
    </div>`).join('');
}

window._docLoadTemplate = async function(id) {
  const tpl = _docAllTemplates.find(t => t.id === id);
  if (!tpl) return;
  document.getElementById('docTemplatePickerModal')?.classList.add('hidden');
  _docItems       = tpl.items?.length ? [...tpl.items] : [{ desc:'', qty:1, price:0 }];
  _docLogoDataUrl = tpl.logoUrl || tpl.logoDataUrl || '';
  _docSetType(tpl.type || 'invoice');
  _setDocVal('docBizName',    tpl.bizName || '');
  _setDocVal('docBizAddress', tpl.bizAddress || '');
  _setDocVal('docBizPhone',   tpl.bizPhone || '');
  _setDocVal('docBizEmail',   tpl.bizEmail || '');
  _setDocVal('docNotes',         tpl.notes        || '');
  _setDocVal('docContractText',  tpl.contractText || '');
  _setDocVal('docProjectTitle',  tpl.projectTitle || '');
  _setDocVal('docJobOrderedBy',  tpl.jobOrderedBy || '');
  _setDocVal('docJobLocation',   tpl.jobLocation  || '');
  _setDocVal('docDuration',      tpl.duration     || '');
  _setDocVal('docJobScope',      tpl.jobScope     || '');
  _setDocVal('docTaxRate',       tpl.taxRate      || 0);
  _docShowPricing = tpl.showPricing !== false;
  const _tplPChk = document.getElementById('docShowPricing');
  if (_tplPChk) _tplPChk.checked = _docShowPricing;
  document.getElementById('docPricingContent')?.classList.toggle('hidden', !_docShowPricing);
  _setDocVal('docAdvancePayment', 0);
  if (tpl.paymentMethod) { const pmEl = document.getElementById('docPaymentMethod'); if (pmEl) pmEl.value = tpl.paymentMethod; }
  const tplTcEl = document.getElementById('docIncludeTC');
  const tplTcChecked = !!tpl.includeTC;
  if (tplTcEl) tplTcEl.checked = tplTcChecked;
  document.getElementById('docTCSection')?.classList.toggle('hidden', !tplTcChecked);
  _setDocVal('docTermsText', tpl.termsText || '');
  if (_docLogoDataUrl) {
    const img = document.getElementById('docLogoImg');
    const ph  = document.getElementById('docLogoPlaceholder');
    if (img) { img.src = _docLogoDataUrl; img.style.display = 'block'; }
    if (ph)  ph.style.display = 'none';
  }
  _docRenderItems();
  _docUpdateTotals();
  _docUpdatePreview();
};

window._docDeleteTemplate = async function(id) {
  if (!confirm('Delete this template?')) return;
  try {
    const { deleteDoc: _del } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    await _del(doc(db, 'docTemplates', id));
    _docAllTemplates = _docAllTemplates.filter(t => t.id !== id);
    _renderDocTemplates();
  } catch(e) { alert('Error: ' + e.message); }
};

// ── Terms & Conditions ────────────────────────────────────────
const DOC_TC_DEFAULT = {
  en: `TERMS AND CONDITIONS

1. Payment: Full payment is due upon completion of work unless a written payment plan is agreed upon. A finance charge of 1.5% per month (18% per annum) will be applied to all past-due balances.

2. Advance Payment: Any deposit or advance payment applied to this estimate/invoice is non-refundable once materials have been ordered or work has commenced.

3. Scope of Work: Work is limited to items described herein. Additional work or materials discovered during service will be quoted and approved separately before proceeding.

4. Warranty: Workmanship is guaranteed for 90 days from the date of completion. Parts and materials carry only the manufacturer's warranty.

5. Right of Access: Customer shall provide safe and unobstructed access to the work area. Delays caused by lack of access may result in additional charges at our standard hourly rate.

6. Permits & Codes: All work will be performed in accordance with applicable local plumbing codes. Customer is responsible for permit fees unless otherwise specified in writing.

7. Limitation of Liability: Our liability is limited to the value of services rendered. We are not responsible for pre-existing conditions, concealed defects, or consequential damages.

8. Cancellation Policy: Cancellations must be made at least 24 hours in advance. Late cancellations or no-shows may be subject to a service call fee.

9. Lien Rights: We reserve the right to file a mechanic's lien on the property for unpaid services as permitted by applicable law.

10. Governing Law: This agreement is governed by the laws of the state where services are rendered. Customer acknowledges reading, understanding, and accepting these terms.

11. Financing & Payment Plans: Financing options may be available for qualified customers on projects exceeding $1,000. Financed balances are subject to a simple interest rate between 6% and 18% per annum depending on the approved term length. All payment plan agreements must be executed in writing and signed by both parties prior to commencement of work, and are subject to credit approval. Missed or late installment payments will cause the full remaining balance to become immediately due and payable. We reserve the right to charge a processing fee for financed transactions.`,

  es: `TÉRMINOS Y CONDICIONES

1. Pago: El pago total vence al completar el trabajo, salvo acuerdo escrito de plan de pagos. Se aplicará un cargo financiero del 1.5% mensual (18% anual) a todos los saldos vencidos.

2. Anticipo: Cualquier depósito o anticipo aplicado a este presupuesto/factura no es reembolsable una vez que los materiales han sido ordenados o el trabajo ha comenzado.

3. Alcance del Trabajo: El trabajo se limita a los elementos descritos en este documento. El trabajo o materiales adicionales descubiertos durante el servicio serán cotizados y aprobados por separado antes de proceder.

4. Garantía: La mano de obra tiene garantía de 90 días a partir de la fecha de terminación. Las piezas y materiales tienen únicamente la garantía del fabricante.

5. Derecho de Acceso: El cliente proporcionará acceso seguro y sin obstrucciones al área de trabajo. Los retrasos por falta de acceso pueden resultar en cargos adicionales a nuestra tarifa horaria estándar.

6. Permisos y Códigos: Todo el trabajo se realizará de acuerdo con los códigos de plomería locales aplicables. El cliente es responsable de los honorarios de permisos, salvo que se especifique por escrito.

7. Limitación de Responsabilidad: Nuestra responsabilidad se limita al costo de los servicios prestados. No somos responsables de condiciones preexistentes, defectos ocultos ni daños consecuentes.

8. Política de Cancelación: Las cancelaciones deben realizarse con al menos 24 horas de anticipación. Las cancelaciones tardías o ausencias pueden estar sujetas a una tarifa por llamada de servicio.

9. Derecho de Retención: Nos reservamos el derecho de presentar un gravamen de mecánico sobre la propiedad por servicios no pagados, según lo permitido por la ley aplicable.

10. Ley Aplicable: Este acuerdo se rige por las leyes del estado donde se prestan los servicios. El cliente reconoce haber leído, comprendido y aceptado estos términos.

11. Financiamiento y Planes de Pago: El financiamiento puede estar disponible para clientes calificados en proyectos que superen $1,000. Los saldos financiados están sujetos a una tasa de interés simple de entre el 6% y el 18% anual según el plazo aprobado. Todo acuerdo de plan de pago debe ser firmado por escrito por ambas partes antes del inicio del trabajo, y está sujeto a aprobación de crédito. Los pagos de cuotas tardíos o no realizados harán que el saldo total restante sea inmediatamente exigible. Nos reservamos el derecho de cobrar una tarifa de procesamiento por transacciones financiadas.`
};

// ── Pricing toggle ────────────────────────────────────────────
window._docTogglePricing = function() {
  _docShowPricing = document.getElementById('docShowPricing')?.checked ?? true;
  document.getElementById('docPricingContent')?.classList.toggle('hidden', !_docShowPricing);
  window._docUpdatePreview();
};

window._docToggleTC = function() {
  const checked = document.getElementById('docIncludeTC')?.checked;
  document.getElementById('docTCSection')?.classList.toggle('hidden', !checked);
  if (checked) {
    const ta = document.getElementById('docTermsText');
    if (ta && !ta.value.trim()) ta.value = DOC_TC_DEFAULT[_docLang] || DOC_TC_DEFAULT.en;
  }
  window._docUpdatePreview();
};

window._docResetTC = function() {
  const ta = document.getElementById('docTermsText');
  if (ta) ta.value = DOC_TC_DEFAULT[_docLang] || DOC_TC_DEFAULT.en;
  window._docUpdatePreview();
};

// ── Share & Copy ──────────────────────────────────────────────
function _docNeedsSave() {
  showToast('Save the document first to get a shareable link — click 💾 Save Document', 'error');
}

window._docShareWA = function() {
  if (!_docCurrentId) { _docNeedsSave(); return; }
  const L          = DOC_LABELS[_docLang];
  const typeLabel  = L[_docType] || _docType;
  const viewUrl    = `${window.location.origin}/view.html?id=${_docCurrentId}`;
  const reviewText = _docLang === 'es' ? `Revisa tu ${typeLabel} aquí` : `Review your ${typeLabel} here`;
  window.open(`https://wa.me/?text=${encodeURIComponent(`${reviewText}:\n${viewUrl}`)}`, '_blank');
};

window._docShareEmail = function() {
  if (!_docCurrentId) { _docNeedsSave(); return; }
  const L         = DOC_LABELS[_docLang];
  const typeLabel = L[_docType] || _docType;
  const docNum    = document.getElementById('docNumber')?.value  || '';
  const custEmail = document.getElementById('docCustEmail')?.value || '';
  const viewUrl    = `${window.location.origin}/view.html?id=${_docCurrentId}`;
  const reviewText = _docLang === 'es' ? `Revisa tu ${typeLabel} aquí` : `Review your ${typeLabel} here`;
  const subject   = encodeURIComponent(`${typeLabel}${docNum ? ' #' + docNum : ''}`);
  const body      = encodeURIComponent(`${reviewText}:\n${viewUrl}\n\nThis link always shows the latest version.`);
  window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(custEmail)}&su=${subject}&body=${body}`, '_blank', 'noopener');
};

window._docCopySummary = function() {
  if (!_docCurrentId) { _docNeedsSave(); return; }
  const btn = document.getElementById('docCopyBtn');
  const url = `${window.location.origin}/view.html?id=${_docCurrentId}`;
  navigator.clipboard.writeText(url).then(() => {
    if (btn) { btn.textContent = '✓ Copied!'; setTimeout(() => { btn.textContent = '🔗 Copy Link'; }, 2000); }
  }).catch(() => alert('Could not copy to clipboard.'));
};

// ── Logo upload ───────────────────────────────────────────────
function _wireDocLogoUpload() {
  const input = document.getElementById('docLogoInput');
  if (!input || input._wired) return;
  input._wired = true;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    const img = document.getElementById('docLogoImg');
    const ph  = document.getElementById('docLogoPlaceholder');
    // Instant preview while upload runs
    const preview = URL.createObjectURL(file);
    if (img) { img.src = preview; img.style.display = 'block'; }
    if (ph)  ph.style.display = 'none';
    _docUpdatePreview();
    try {
      const uid  = currentUser?.uid || 'shared';
      const blob = await resizeToBlob(file, 300, 120);
      const snap = await uploadBytes(storageRef(storage, `logos/${uid}/logo`), blob, { contentType: 'image/webp' });
      _docLogoDataUrl = await getDownloadURL(snap.ref);
      if (img) img.src = _docLogoDataUrl;
      _docUpdatePreview();
    } catch (err) {
      console.error('logo upload failed:', err);
      showToast('Logo upload failed', 'error');
    }
  });
}

// ── Market Rate Calculator ────────────────────────────────────
const _mrLangs = { admin: 'en-US' };

window._mrSetLang = function(ctx, lang) {
  _mrLangs[ctx] = lang;
  document.getElementById('mrLangAdminEN')?.classList.toggle('active', lang === 'en-US');
  document.getElementById('mrLangAdminES')?.classList.toggle('active', lang === 'es-MX');
};

let _mrVoiceActive = null; // { recognizer, fieldId }

window._mrVoice = function(fieldId, ctx) {
  const btn = document.querySelector(`[data-mr-voice-for="${fieldId}"]`);

  // Second click = stop
  if (_mrVoiceActive) {
    _mrVoiceActive.recognizer.stop();
    return;
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showToast('Voice input is not supported in this browser.', 'error'); return; }

  const lang = _mrLangs[ctx] || 'en-US';
  const inp  = document.getElementById(fieldId);
  const sr   = new SR();
  sr.lang           = lang;
  sr.continuous     = true;   // keep listening through pauses
  sr.interimResults = true;   // show live text as user speaks
  sr.maxAlternatives = 1;

  _mrVoiceActive = { recognizer: sr, fieldId };
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
    _mrVoiceActive = null;
    if (btn) { btn.textContent = '🎤'; btn.title = 'Voice input'; btn.classList.remove('mr-voice-active'); }
    if (inp && inp.value) inp.dispatchEvent(new Event('input'));
  };

  sr.onerror = e => {
    _mrVoiceActive = null;
    if (btn) { btn.textContent = '🎤'; btn.title = 'Voice input'; btn.classList.remove('mr-voice-active'); }
    if (e.error !== 'no-speech' && e.error !== 'aborted') showToast('Voice error: ' + e.error, 'error');
  };

  sr.start();
};

async function _mrFetch(service, city, lang, resultEl, btnEl) {
  if (!service || !city) { showToast('Enter both a service type and a city.', 'error'); return; }

  const cacheKey = `mr_${lang}_${service.toLowerCase().replace(/\s+/g,'-')}_${city.toLowerCase().replace(/\s+/g,'-')}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const { data, ts } = JSON.parse(cached);
      if (Date.now() - ts < 86_400_000) { _mrRenderResult(resultEl, data, service, city, true); return; }
    } catch {}
  }

  if (btnEl) { btnEl.disabled = true; btnEl.textContent = '⏳ Fetching market data…'; }
  if (resultEl) resultEl.innerHTML = '';

  try {
    const resp = await fetch('/.netlify/functions/market-rate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service, city, lang })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to get market rates');
    localStorage.setItem(cacheKey, JSON.stringify({ data, ts: Date.now() }));
    _mrSaveHistory(service, city, data);
    if (resultEl) _mrRenderResult(resultEl, data, service, city, false);
  } catch (e) {
    if (resultEl) resultEl.innerHTML = `<div class="mr-error">⚠️ ${e.message}</div>`;
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = '📊 Get Market Rates'; }
  }
}

const _mrKey = () => `mr_history_${currentUser?.uid || 'anon'}`;

function _mrSaveHistory(service, city, data) {
  try {
    const hist = JSON.parse(localStorage.getItem(_mrKey()) || '[]');
    const entry = { service, city, min: data.min, max: data.max, average: data.average, unit: data.unit, ts: Date.now() };
    const filtered = hist.filter(h => !(h.service === service && h.city === city));
    filtered.unshift(entry);
    localStorage.setItem(_mrKey(), JSON.stringify(filtered.slice(0, 10)));
  } catch {}
}

function _mrDeleteHistoryItem(idx, containerEl, onSelect) {
  try {
    const hist = JSON.parse(localStorage.getItem(_mrKey()) || '[]');
    hist.splice(idx, 1);
    localStorage.setItem(_mrKey(), JSON.stringify(hist));
  } catch {}
  _mrRenderHistory(containerEl, onSelect);
}

function _mrRenderHistory(containerEl, onSelect) {
  if (!containerEl) return;
  try {
    const hist = JSON.parse(localStorage.getItem(_mrKey()) || '[]');
    if (!hist.length) { containerEl.innerHTML = ''; return; }
    containerEl.innerHTML = `
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
            <div class="mr-history-range">${_mrFmt(h.min)} – ${_mrFmt(h.max)} <span class="mr-history-unit">${h.unit || 'per job'}</span></div>
            <button class="mr-del-btn" data-del="${i}" title="Remove">✕</button>
          </div>`).join('')}
      </div>`;

    containerEl.querySelectorAll('.mr-history-item').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('[data-del]')) return;
        const h = hist[+el.dataset.idx];
        if (onSelect) onSelect(h.service, h.city);
      });
    });
    containerEl.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        _mrDeleteHistoryItem(+btn.dataset.del, containerEl, onSelect);
      });
    });
    containerEl.querySelector('[data-clear-all]')?.addEventListener('click', () => {
      localStorage.removeItem(_mrKey());
      containerEl.innerHTML = '';
    });
  } catch {}
}

window._mrGetRatesAdmin = async function() {
  const service = (document.getElementById('mrServiceAdmin')?.value || '').trim();
  const city    = (document.getElementById('mrCityAdmin')?.value    || '').trim();
  await _mrFetch(service, city, _mrLangs.admin || 'en-US',
    document.getElementById('mrResultAdmin'),
    document.getElementById('mrBtnAdmin')
  );
  _mrRenderHistory(document.getElementById('mrHistoryAdmin'), (svc, cty) => {
    const s = document.getElementById('mrServiceAdmin');
    const c = document.getElementById('mrCityAdmin');
    if (s) s.value = svc;
    if (c) c.value = cty;
    window._mrGetRatesAdmin();
  });
};

window._mrClearAdmin = function() {
  const r = document.getElementById('mrResultAdmin');
  if (r) r.innerHTML = '';
};

function _mrFmt(n) {
  if (!n && n !== 0) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function _mrRenderResult(container, d, service, city, fromCache) {
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
          <span class="mr-range-val low">${_mrFmt(d.min)}</span>
        </div>
        <div class="mr-range-item highlight">
          <span class="mr-range-label">Average</span>
          <span class="mr-range-val avg">${_mrFmt(d.average)}</span>
        </div>
        <div class="mr-range-item">
          <span class="mr-range-label">High</span>
          <span class="mr-range-val high">${_mrFmt(d.max)}</span>
        </div>
      </div>
      <div class="mr-suggestion">
        💡 Suggested starting price: <strong>${_mrFmt(d.suggestion)}</strong> <em>${d.unit || 'per job'}</em>
      </div>
      ${d.breakdown ? `<div class="mr-breakdown">${d.breakdown}</div>` : ''}
      ${factors ? `<div class="mr-factors">${factors}</div>` : ''}
      ${refs ? `<ul class="mr-refs">${refs}</ul>` : ''}
      <div class="mr-disclaimer">${d.disclaimer || ''}</div>
    </div>`;
}

// ── Voice Input ───────────────────────────────────────────────
function _startVoice(onResult, lang) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert('Voice input is not supported in this browser.'); return null; }
  if (_docVoiceRecognizer) {
    _docVoiceRecognizer.stop();
    _docVoiceRecognizer = null;
  }
  const rec = new SR();
  rec.lang        = lang === 'es' ? 'es-MX' : 'en-US';
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = e => {
    const text = e.results[0][0].transcript;
    onResult(text);
  };
  rec.onerror = e => { if (e.error !== 'aborted') console.warn('Voice error:', e.error); };
  rec.onend   = () => { _docVoiceRecognizer = null; };
  rec.start();
  _docVoiceRecognizer = rec;
  return rec;
}

window._docVoiceField = function(fieldId) {
  const btn = document.querySelector(`[onclick="window._docVoiceField('${fieldId}')"]`);
  if (!btn) return;
  btn.classList.add('listening');
  const rec = _startVoice(text => {
    const el = document.getElementById(fieldId);
    if (el) {
      el.value += (el.value ? ' ' : '') + text;
      el.dispatchEvent(new Event('input'));
    }
    btn.classList.remove('listening');
  }, _docLang);
  if (!rec) btn.classList.remove('listening');
};

window._docVoiceSearch = function() {
  const btn = document.getElementById('docCustVoiceBtn');
  if (!btn) return;
  btn.classList.add('listening');
  const rec = _startVoice(text => {
    const inp = document.getElementById('docCustSearch');
    if (inp) {
      inp.value = text;
      window._docSearchCustomers(text);
    }
    btn.classList.remove('listening');
  }, _docLang);
  if (!rec) btn.classList.remove('listening');
};

// ── Customer search ───────────────────────────────────────────
window._docSearchCustomers = function(query) {
  const dropdown = document.getElementById('docCustDropdown');
  if (!dropdown) return;
  if (!query.trim()) { dropdown.classList.add('hidden'); dropdown.innerHTML = ''; return; }
  const q = query.toLowerCase();
  const matches = _docAllCustomers.filter(c =>
    (c.name||'').toLowerCase().includes(q) ||
    (c.email||'').toLowerCase().includes(q) ||
    (c.phone||'').includes(q)
  ).slice(0, 8);
  if (!matches.length) { dropdown.classList.add('hidden'); dropdown.innerHTML = ''; return; }
  dropdown.innerHTML = matches.map(c => `
    <div class="doc-cust-item" onclick="window._docSelectCustomer(${JSON.stringify(c).replace(/"/g,'&quot;')})">
      <div class="cust-name">${_esc(c.name)}</div>
      <div class="cust-sub">${[c.email, c.phone].filter(Boolean).join(' · ')}</div>
    </div>`).join('');
  dropdown.classList.remove('hidden');
};

window._docSelectCustomer = function(customer) {
  _setDocVal('docCustName',    customer.name    || '');
  _setDocVal('docCustEmail',   customer.email   || '');
  _setDocVal('docCustPhone',   customer.phone   || '');
  _setDocVal('docCustAddress', customer.address || '');
  _setDocVal('docJobOrderedBy', customer.name   || '');
  const srch = document.getElementById('docCustSearch');
  if (srch) { srch.value = customer.name || ''; }
  document.getElementById('docCustDropdown')?.classList.add('hidden');
  _docUpdatePreview();
};

// ── Customer Management ───────────────────────────────────────
window._docToggleCustomers = function() {
  const panel  = document.getElementById('docCustomersPanel');
  const btn    = document.getElementById('docCustomersToggle');
  if (!panel) return;
  const hidden = panel.classList.toggle('hidden');
  if (btn) btn.textContent = hidden ? '👥 Customers' : '👥 Hide Customers';
  if (!hidden) loadCustomers();
};

window._docTogglePayment = function() {
  const panel = document.getElementById('docPaymentPanel');
  const btn   = document.getElementById('docPaymentToggle');
  if (!panel) return;
  const hidden = panel.classList.toggle('hidden');
  if (btn) btn.textContent = hidden ? '💳 Payment' : '💳 Hide Payment';
};

window._custFilter = function(q) {
  const list = q.trim()
    ? _docAllCustomers.filter(c =>
        (c.name||'').toLowerCase().includes(q.toLowerCase()) ||
        (c.email||'').toLowerCase().includes(q.toLowerCase()) ||
        (c.phone||'').includes(q))
    : _docAllCustomers;
  renderCustomersTable(list);
};

window._custVoiceSearch = function() {
  const btn = document.getElementById('custVoiceBtn');
  if (!btn) return;
  btn.classList.add('listening');
  const rec = _startVoice(text => {
    const inp = document.getElementById('custListSearch');
    if (inp) { inp.value = text; window._custFilter(text); }
    btn.classList.remove('listening');
  }, _docLang);
  if (!rec) btn.classList.remove('listening');
};

window._openAddCustomer = function() {
  ['newCustName','newCustEmail','newCustPhone','newCustAddress','newCustCompany']
    .forEach(id => _setDocVal(id, ''));
  document.getElementById('addCustomerModal')?.classList.remove('hidden');
};

window._custSave = async function() {
  const name = document.getElementById('newCustName')?.value.trim();
  if (!name) { alert('Name is required'); return; }
  const btn = document.querySelector('#addCustomerModal .btn-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await addDoc(collection(db, 'customers'), {
      name,
      email:    document.getElementById('newCustEmail')?.value.trim()   || '',
      phone:    document.getElementById('newCustPhone')?.value.trim()   || '',
      address:  document.getElementById('newCustAddress')?.value.trim() || '',
      company:  document.getElementById('newCustCompany')?.value.trim() || '',
      ownerUid: auth.currentUser?.uid || '',
      createdAt: serverTimestamp()
    });
    document.getElementById('addCustomerModal')?.classList.add('hidden');
    await loadCustomers();
  } catch(e) { alert('Error saving customer: ' + e.message); }
  finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Customer'; }
  }
};

window._custDelete = async function(id) {
  if (!confirm('Delete this customer?')) return;
  try {
    const { deleteDoc: _del } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    await _del(doc(db, 'customers', id));
    await loadCustomers();
  } catch(e) { alert('Error: ' + e.message); }
};

async function loadCustomers() {
  try {
    const snap = await getDocs(query(
      collection(db, 'customers'),
      orderBy('createdAt', 'desc')
    ));
    _docAllCustomers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch(e) {
    _docAllCustomers = [];
  }
  renderCustomersTable(_docAllCustomers);
}

function renderCustomersTable(list) {
  const container = document.getElementById('custListTable');
  if (!container) return;
  if (!list.length) {
    container.innerHTML = '<p style="color:#94a3b8;font-size:0.85rem;padding:12px 0">No customers yet. Click + Add Customer to add one.</p>';
    return;
  }
  container.innerHTML = list.map(c => `
    <div class="cust-row">
      <div>
        <div class="cust-name-col">${_esc(c.name)}</div>
        ${c.company ? `<div class="cust-sub-col">${_esc(c.company)}</div>` : ''}
      </div>
      <div>
        ${c.email ? `<div class="cust-sub-col">${_esc(c.email)}</div>` : ''}
        ${c.phone ? `<div class="cust-sub-col">${_esc(c.phone)}</div>` : ''}
      </div>
      <div class="cust-sub-col">${_esc(c.address || '')}</div>
      <div class="cust-row-actions">
        <button class="btn-use"   onclick="window._docSelectFromList(${JSON.stringify(c).replace(/"/g,'&quot;')})">Use</button>
        <button class="btn-del-c" onclick="window._custDelete('${c.id}')">✕</button>
      </div>
    </div>`).join('');
}

window._docSelectFromList = function(c) {
  // If doc creator is open, fill customer fields
  _setDocVal('docCustName',    c.name    || '');
  _setDocVal('docCustEmail',   c.email   || '');
  _setDocVal('docCustPhone',   c.phone   || '');
  _setDocVal('docCustAddress', c.address || '');
  _docUpdatePreview();
  // If doc creator not open, open it
  const modal = document.getElementById('docCreatorModal');
  if (modal?.classList.contains('hidden')) window._openDocCreator();
};


window._docViewDoc = async function(id) {
  try {
    const snap = await getDoc(doc(db, 'documents', id));
    const data = snap.data();
    if (data?.htmlContent) {
      const w = window.open('', '_blank', 'width=900,height=700');
      if (w) { w.document.write(data.htmlContent); w.document.close(); }
    } else { alert('No preview available for this document.'); }
  } catch(e) { alert('Could not load document: ' + e.message); }
};

window._docEditDoc = async function(id) {
  try {
    const snap = await getDoc(doc(db, 'documents', id));
    if (snap.exists()) window._openDocCreator({ id, ...snap.data() });
  } catch(e) { alert('Error: ' + e.message); }
};

window._docDeleteDoc = async function(id) {
  if (!confirm('Permanently delete this document?')) return;
  try {
    await deleteDoc(doc(db, 'documents', id));
    loadAdminDocuments();
  } catch(e) { alert('Error: ' + e.message); }
};

// ── Boot ─────────────────────────────────────────────────────
initAdmin();

// ============================================================
// AI HELP CHAT (admin panel)
// ============================================================
let _aiHistory    = [];
let _aiPendingImg = null;
let _aiChatOpen   = false;

function _aiInitSupport() {
  const fab = document.getElementById('aiHelpFab');
  if (!fab) return;
  fab.style.display = 'flex';
  fab.classList.remove('hidden');

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
  container.scrollTop = container.scrollHeight;
  return id;
}

function _aiRemoveThinking(id) {
  if (id) document.getElementById(id)?.remove();
}

// ── Google My Business Requests ───────────────────────────────

async function loadGmbRequests() {
  const tbody = document.getElementById('gmbRequestsBody');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>⏳ Loading…</p></div></td></tr>`;

  try {
    const snap = await getDocs(query(collection(db, 'gmb_requests'), orderBy('requestedAt', 'desc'), limit(200)));
    const reqs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Update stats
    const counts = { pending: 0, 'in-progress': 0, completed: 0 };
    reqs.forEach(r => { if (counts[r.status] !== undefined) counts[r.status]++; });
    const el = id => document.getElementById(id);
    if (el('gmbStatPending'))    el('gmbStatPending').textContent    = counts.pending;
    if (el('gmbStatInProgress')) el('gmbStatInProgress').textContent = counts['in-progress'];
    if (el('gmbStatCompleted'))  el('gmbStatCompleted').textContent  = counts.completed;

    if (!reqs.length) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>🎉 No requests yet.</p></div></td></tr>`;
      return;
    }

    const statusBadge = s => {
      const map = {
        pending:      'background:#fef9c3;color:#78350f;',
        'in-progress':'background:#dbeafe;color:#1e40af;',
        completed:    'background:#dcfce7;color:#14532d;',
        cancelled:    'background:#f1f5f9;color:#64748b;',
      };
      const labels = { pending:'⏳ Pending', 'in-progress':'🔄 In Progress', completed:'✅ Completed', cancelled:'🚫 Cancelled' };
      return `<span style="padding:3px 10px;border-radius:20px;font-size:0.72rem;font-weight:700;${map[s]||map.pending}">${labels[s]||s}</span>`;
    };

    tbody.innerHTML = reqs.map(r => {
      const date = r.requestedAt?.toDate?.()?.toLocaleDateString() || '—';
      return `<tr>
        <td><strong>${escHTML(r.bizName||'—')}</strong>${r.address?`<div style="font-size:0.72rem;color:#94a3b8;">${escHTML(r.address)}</div>`:''}</td>
        <td>${escHTML(r.ownerName||'—')}</td>
        <td>${escHTML(r.phone||'—')}</td>
        <td>${escHTML(r.category||'—')}</td>
        <td style="white-space:nowrap;">${date}</td>
        <td>${statusBadge(r.status)}</td>
        <td style="white-space:nowrap;">
          <select onchange="window._updateGmbStatus('${escAttr(r.id)}',this.value)"
            style="padding:4px 8px;border-radius:6px;border:1px solid #e2e8f0;font-size:0.78rem;cursor:pointer;margin-bottom:4px;">
            <option value="pending"      ${r.status==='pending'?'selected':''}>⏳ Pending</option>
            <option value="in-progress"  ${r.status==='in-progress'?'selected':''}>🔄 In Progress</option>
            <option value="completed"    ${r.status==='completed'?'selected':''}>✅ Completed</option>
            <option value="cancelled"    ${r.status==='cancelled'?'selected':''}>🚫 Cancelled</option>
          </select>
          <div style="display:flex;gap:4px;align-items:center;margin-bottom:4px;">
            <input type="text" id="gmbNote-${escAttr(r.id)}" value="${escAttr(r.adminNotes||'')}"
              placeholder="Add note for owner…"
              style="flex:1;padding:4px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:0.75rem;" />
            <button class="btn-action" onclick="window._saveGmbNote('${escAttr(r.id)}')" style="padding:4px 8px;font-size:0.75rem;">💾</button>
          </div>
          <div style="display:flex;gap:4px;align-items:center;margin-bottom:4px;">
            <input type="url" id="gmbReviewLink-${escAttr(r.id)}" value="${escAttr(r.reviewLink||'')}"
              placeholder="⭐ Google Review link…"
              style="flex:1;padding:4px 8px;border:1px solid #bbf7d0;border-radius:6px;font-size:0.75rem;background:${r.reviewLink?'#f0fdf4':'#fff'};" />
            <button class="btn-action success" onclick="window._saveGmbReviewLink('${escAttr(r.id)}','${escAttr(r.uid||'')}')" style="padding:4px 8px;font-size:0.75rem;">⭐</button>
          </div>
          ${r.reviewLink?`<a href="${escAttr(r.reviewLink)}" target="_blank" style="font-size:0.7rem;color:#15803d;">View review page ↗</a><br/>`:''}
          ${r.email?`<a href="mailto:${escAttr(r.email)}" style="font-size:0.72rem;color:#4f46e5;">${escHTML(r.email)}</a>`:''}
        </td>
      </tr>`;
    }).join('');
  } catch(e) {
    console.error('loadGmbRequests error:', e);
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>⚠️ Error loading requests.</p></div></td></tr>`;
  }
}
window.loadGmbRequests = loadGmbRequests;

window._updateGmbStatus = async function(reqId, status) {
  try {
    await updateDoc(doc(db, 'gmb_requests', reqId), { status, updatedAt: serverTimestamp() });
    showToast('Status updated', 'success');
    loadGmbRequests();
  } catch(e) {
    showToast('Could not update status', 'error');
  }
};

window._saveGmbNote = async function(reqId) {
  const note = document.getElementById('gmbNote-' + reqId)?.value.trim() || '';
  try {
    await updateDoc(doc(db, 'gmb_requests', reqId), { adminNotes: note, updatedAt: serverTimestamp() });
    showToast('Note saved', 'success');
  } catch(e) {
    showToast('Could not save note', 'error');
  }
};

window._saveGmbReviewLink = async function(reqId, ownerUid) {
  const link = document.getElementById('gmbReviewLink-' + reqId)?.value.trim() || '';
  if (link && !link.startsWith('http')) { showToast('Please enter a valid URL', 'error'); return; }
  try {
    await updateDoc(doc(db, 'gmb_requests', reqId), { reviewLink: link, updatedAt: serverTimestamp() });
    // Also save to owner profile so review automation can use it later
    if (ownerUid) {
      await updateDoc(doc(db, 'owners', ownerUid), { googleReviewLink: link, updatedAt: serverTimestamp() });
    }
    showToast(link ? '⭐ Review link saved to profile' : 'Link cleared', 'success');
    loadGmbRequests();
  } catch(e) {
    showToast('Could not save review link', 'error');
  }
};

// ── Lead Generation / Job Board ───────────────────────────────

let _allLeads        = [];
let _filteredLeads   = [];
let _allContractors  = [];
let _currentAssignId = null;

function _initAdminLeadsBadge() {
  onSnapshot(
    query(collection(db, 'lead_requests'), where('status', '==', 'new')),
    snap => {
      const count = snap.size;
      const badge = document.getElementById('adminLeadsBadge');
      if (badge) { badge.textContent = count; badge.style.display = count > 0 ? '' : 'none'; }
    }
  );
}

async function loadLeads() {
  const container = document.getElementById('leadsContainer');
  if (!container) return;
  container.innerHTML = '<div class="empty-state"><p>⏳ Loading…</p></div>';

  try {
    const snap = await getDocs(query(collection(db, 'lead_requests'), orderBy('postedAt', 'desc'), limit(300)));
    _allLeads = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    const counts = { new: 0, assigned: 0, completed: 0 };
    _allLeads.forEach(l => { if (counts[l.status] !== undefined) counts[l.status]++; });
    const el = id => document.getElementById(id);
    if (el('leadStatNew'))       el('leadStatNew').textContent       = counts.new;
    if (el('leadStatAssigned'))  el('leadStatAssigned').textContent  = counts.assigned;
    if (el('leadStatCompleted')) el('leadStatCompleted').textContent = counts.completed;

    _filterLeads('all');
  } catch(e) {
    console.error('loadLeads error:', e);
    container.innerHTML = '<div class="empty-state"><p>⚠️ Error loading leads.</p></div>';
  }
}
window.loadLeads = loadLeads;

window._filterLeads = function(filter) {
  document.querySelectorAll('[data-lead-filter]').forEach(b => b.classList.toggle('active', b.dataset.leadFilter === filter));
  _filteredLeads = filter === 'all' ? [..._allLeads] : _allLeads.filter(l => l.status === filter);
  _renderLeads();
};

function _renderLeads() {
  const container = document.getElementById('leadsContainer');
  if (!container) return;
  if (!_filteredLeads.length) {
    container.innerHTML = '<div class="empty-state"><p>🎉 No leads in this category.</p></div>';
    return;
  }

  const statusStyle = {
    new:       { bg: '#fef9c3', color: '#78350f', label: '🆕 New' },
    assigned:  { bg: '#dbeafe', color: '#1e40af', label: '📋 Assigned' },
    completed: { bg: '#dcfce7', color: '#14532d', label: '✅ Completed' },
    cancelled: { bg: '#f1f5f9', color: '#64748b', label: '🚫 Cancelled' },
  };

  container.innerHTML = _filteredLeads.map(l => {
    const s    = statusStyle[l.status] || statusStyle.new;
    const date = l.postedAt?.toDate?.()?.toLocaleDateString() || '—';
    return `<div style="background:#fff;border-radius:14px;border:1px solid ${l.status==='new'?'#fde68a':'#e2e8f0'};padding:20px;margin-bottom:14px;">
      <!-- Header -->
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
        <div>
          <div style="font-size:1rem;font-weight:800;color:#1e293b;">${escHTML(l.title||'—')}</div>
          <div style="font-size:0.78rem;color:#64748b;margin-top:2px;">
            ${escHTML(l.category||'')} · 📍 ${escHTML(l.zipCode||'')} · 📅 ${date}
            ${l.jobSize ? ` · 📐 ${escHTML(l.jobSize)}` : ''}
            ${l.timing ? ` · ⏱️ ${escHTML(l.timing)}` : ''}
          </div>
        </div>
        <span style="padding:4px 12px;border-radius:20px;font-size:0.75rem;font-weight:700;background:${s.bg};color:${s.color};white-space:nowrap;flex-shrink:0;">${s.label}</span>
      </div>

      ${l.description ? `<p style="font-size:0.83rem;color:#475569;line-height:1.6;margin-bottom:14px;border-left:3px solid #e2e8f0;padding-left:12px;">${escHTML(l.description)}</p>` : ''}

      ${l.photoUrls?.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;">${l.photoUrls.map(u=>`<a href="${escAttr(u)}" target="_blank"><img src="${escAttr(u)}" style="width:70px;height:70px;object-fit:cover;border-radius:7px;border:1.5px solid #e2e8f0;" /></a>`).join('')}</div>` : ''}

      <!-- Homeowner contact -->
      <div style="background:#f8fafc;border-radius:10px;padding:12px 14px;margin-bottom:14px;display:flex;flex-wrap:wrap;gap:16px;">
        <div><span style="font-size:0.7rem;color:#94a3b8;font-weight:600;">HOMEOWNER</span><br/><strong>${escHTML(l.name||'—')}</strong></div>
        <div><span style="font-size:0.7rem;color:#94a3b8;font-weight:600;">PHONE</span><br/><a href="tel:${escHTML(l.phone||'')}" style="color:#4f46e5;font-weight:600;">${escHTML(l.phone||'—')}</a></div>
        ${l.email ? `<div><span style="font-size:0.7rem;color:#94a3b8;font-weight:600;">EMAIL</span><br/><a href="mailto:${escHTML(l.email)}" style="color:#4f46e5;font-weight:600;">${escHTML(l.email)}</a></div>` : ''}
      </div>

      ${l.assignedToName ? `<div style="font-size:0.8rem;color:#1e40af;background:#eff6ff;border-radius:8px;padding:8px 12px;margin-bottom:12px;">📋 Assigned to: <strong>${escHTML(l.assignedToName)}</strong></div>` : ''}

      <!-- Admin note -->
      <div style="display:flex;gap:6px;margin-bottom:12px;">
        <input type="text" id="leadNote-${escAttr(l.id)}" value="${escAttr(l.adminNotes||'')}" placeholder="Add admin note…"
          style="flex:1;padding:7px 10px;border:1px solid #e2e8f0;border-radius:7px;font-size:0.78rem;" />
        <button class="btn-action" onclick="window._saveLeadNote('${escAttr(l.id)}')" style="padding:7px 10px;font-size:0.75rem;">💾</button>
      </div>

      <!-- Actions -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${l.status === 'new' || l.status === 'assigned' ? `
        <button class="btn-action success" onclick="window._openAssignModal('${escAttr(l.id)}','${escAttr(l.title||'')}')">
          👤 ${l.assignedTo ? 'Reassign' : 'Assign Contractor'}
        </button>` : ''}
        ${l.status !== 'completed' ? `<button class="btn-action" onclick="window._updateLeadStatus('${escAttr(l.id)}','completed')">✅ Mark Completed</button>` : ''}
        ${l.status !== 'cancelled' ? `<button class="btn-action" style="background:#fee2e2;color:#dc2626;border-color:#fca5a5;" onclick="window._updateLeadStatus('${escAttr(l.id)}','cancelled')">🚫 Cancel</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

window._updateLeadStatus = async function(leadId, status) {
  try {
    await updateDoc(doc(db, 'lead_requests', leadId), { status, updatedAt: serverTimestamp() });
    const lead = _allLeads.find(l => l.id === leadId);
    if (lead) lead.status = status;
    _filterLeads(document.querySelector('[data-lead-filter].active')?.dataset.leadFilter || 'all');
    showToast('Status updated', 'success');
  } catch(e) {
    showToast('Could not update status', 'error');
  }
};

window._saveLeadNote = async function(leadId) {
  const note = document.getElementById('leadNote-' + leadId)?.value.trim() || '';
  try {
    await updateDoc(doc(db, 'lead_requests', leadId), { adminNotes: note, updatedAt: serverTimestamp() });
    const lead = _allLeads.find(l => l.id === leadId);
    if (lead) lead.adminNotes = note;
    showToast('Note saved', 'success');
  } catch(e) {
    showToast('Could not save note', 'error');
  }
};

// ── Assign modal ──────────────────────────────────────────────

window._openAssignModal = async function(leadId, title) {
  _currentAssignId = leadId;
  const modal = document.getElementById('assignModal');
  if (!modal) return;
  document.getElementById('assignLeadTitle').textContent = title || 'this lead';
  modal.style.display = 'flex';
  document.getElementById('assignSearch').value = '';

  if (!_allContractors.length) {
    document.getElementById('contractorList').innerHTML = '<div style="padding:12px;text-align:center;color:#94a3b8;font-size:0.82rem;">⏳ Loading contractors…</div>';
    try {
      const snap = await getDocs(query(collection(db, 'owners'), where('role', '!=', 'admin'), limit(200)));
      _allContractors = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(o => o.role !== 'admin');
    } catch(e) {
      const snap = await getDocs(query(collection(db, 'owners'), limit(200)));
      _allContractors = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(o => o.email !== 'ezperfilsystem@gmail.com');
    }
  }
  window._filterContractors('');
};

window._closeAssignModal = function() {
  const modal = document.getElementById('assignModal');
  if (modal) modal.style.display = 'none';
  _currentAssignId = null;
};

window._filterContractors = function(q) {
  const list = document.getElementById('contractorList');
  if (!list) return;
  const matches = q
    ? _allContractors.filter(c =>
        (c.companyName||c.name||'').toLowerCase().includes(q.toLowerCase()) ||
        (c.email||'').toLowerCase().includes(q.toLowerCase()) ||
        (c.categoryId||c.category||'').toLowerCase().includes(q.toLowerCase()))
    : _allContractors;

  if (!matches.length) {
    list.innerHTML = '<div style="padding:12px;text-align:center;color:#94a3b8;font-size:0.82rem;">No contractors found.</div>';
    return;
  }

  list.innerHTML = matches.map(c => {
    const name = c.companyName || c.name || c.email || 'Unknown';
    const cat  = c.categoryId || c.category || '';
    return `<div onclick="window._confirmAssign('${escAttr(c.id)}','${escAttr(name)}')"
      style="padding:12px 14px;border-bottom:1px solid #f1f5f9;cursor:pointer;display:flex;align-items:center;gap:10px;transition:background .15s;"
      onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">
      <div style="width:36px;height:36px;border-radius:50%;background:#eef2ff;display:flex;align-items:center;justify-content:center;font-size:0.85rem;font-weight:700;color:#4f46e5;flex-shrink:0;">
        ${name.charAt(0).toUpperCase()}
      </div>
      <div>
        <div style="font-size:0.88rem;font-weight:700;color:#1e293b;">${escHTML(name)}</div>
        <div style="font-size:0.72rem;color:#94a3b8;">${escHTML(c.email||'')} ${cat?'· '+cat:''}</div>
      </div>
    </div>`;
  }).join('');
};

window._confirmAssign = async function(contractorUid, contractorName) {
  if (!_currentAssignId) return;
  try {
    await updateDoc(doc(db, 'lead_requests', _currentAssignId), {
      assignedTo:     contractorUid,
      assignedToName: contractorName,
      assignedAt:     serverTimestamp(),
      status:         'assigned',
      contractorSeen: false,
      contractorStatus: 'new',
      updatedAt:      serverTimestamp()
    });
    showToast(`Lead assigned to ${contractorName}`, 'success');
    window._closeAssignModal();
    loadLeads();
  } catch(e) {
    console.error('_confirmAssign error:', e);
    showToast('Could not assign lead', 'error');
  }
};

// ============================================================
// MATERIAL SEARCH
// ============================================================
let _msBizList = [];

window._msSearch = function(store) {
  const q = (document.getElementById('msSearchInput')?.value || '').trim();
  if (!q) { showToast('Enter a material to search', 'info'); return; }
  const encoded = encodeURIComponent(q);
  const url = store === 'hd'
    ? `https://www.homedepot.com/s/${encoded}`
    : `https://www.lowes.com/search?searchTerm=${encoded}`;
  window.open(url, '_blank', 'noopener');
};

async function _msLoadUsers() {
  const tbody   = document.getElementById('msUsersTableBody');
  const countEl = document.getElementById('msUserCount');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><div class="empty-state-icon">⏳</div><p>Loading…</p></div></td></tr>`;
  try {
    const snap = await getDocs(query(collection(db, 'owners'), orderBy('createdAt', 'desc')));
    _msBizList = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(u => u.acctType === 'business');
    if (countEl) countEl.textContent = `${_msBizList.length} business account${_msBizList.length !== 1 ? 's' : ''}`;
    _msRenderTable(_msBizList);
  } catch (err) {
    console.error('_msLoadUsers error:', err);
    if (tbody) tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><p>Error loading users.</p></div></td></tr>`;
  }
}

function _msRenderTable(list) {
  const tbody = document.getElementById('msUsersTableBody');
  if (!tbody) return;
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><div class="empty-state-icon">🔩</div><p>No local business accounts found.</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(u => {
    const msOn = u.addOns?.materialSearch === true;
    return `
    <tr>
      <td>${escHTML(u.companyName || '—')}</td>
      <td>${escHTML(u.sponsorUsername || '—')}</td>
      <td>${escHTML(((u.firstName || '') + ' ' + (u.lastName || '')).trim() || '—')}</td>
      <td>${badgeHTML(u.plan || 'trial')}</td>
      <td>
        <label class="addon-toggle" title="Material Search access">
          <input type="checkbox" ${msOn ? 'checked' : ''} onchange="window._msToggleUser('${escAttr(u.id)}', ${msOn})"/>
          <span class="addon-toggle-track"></span>
        </label>
      </td>
    </tr>`;
  }).join('');
}

window._msFilterUsers = function() {
  const q = (document.getElementById('msUserSearch')?.value || '').toLowerCase();
  _msRenderTable(_msBizList.filter(u =>
    `${u.companyName} ${u.sponsorUsername} ${u.firstName} ${u.lastName}`.toLowerCase().includes(q)
  ));
};

window._msToggleUser = async function(uid, currentVal) {
  const newVal = !currentVal;
  try {
    await updateDoc(doc(db, 'owners', uid), { 'addOns.materialSearch': newVal, updatedAt: serverTimestamp() });
    const idx = _msBizList.findIndex(u => u.id === uid);
    if (idx !== -1) {
      _msBizList[idx].addOns = { ...(_msBizList[idx].addOns || {}), materialSearch: newVal };
      _msRenderTable(_msBizList);
    }
    showToast(`Material Search ${newVal ? 'enabled ✓' : 'disabled'}`, newVal ? 'success' : 'info');
  } catch (e) {
    console.error('_msToggleUser error:', e);
    showToast('Could not update access.', 'error');
  }
};

window._msEnableAll = async function(enable) {
  if (!_msBizList.length) return;
  if (!confirm(`${enable ? 'Enable' : 'Disable'} Material Search for all ${_msBizList.length} business account${_msBizList.length !== 1 ? 's' : ''}?`)) return;
  try {
    for (const u of _msBizList) {
      await updateDoc(doc(db, 'owners', u.id), { 'addOns.materialSearch': enable, updatedAt: serverTimestamp() });
    }
    _msBizList.forEach(u => { u.addOns = { ...(u.addOns || {}), materialSearch: enable }; });
    _msRenderTable(_msBizList);
    showToast(`Material Search ${enable ? 'enabled' : 'disabled'} for all users ✓`, 'success');
  } catch (e) {
    console.error('_msEnableAll error:', e);
    showToast('Error updating users.', 'error');
  }
};
