/* ============================================================
   EP Local Pro AI — user-dashboard.js
   Personal / referrer account dashboard.
   ============================================================ */

import { auth, db } from '/js/firebase.js';
import {
  onAuthStateChanged,
  signOut,
  deleteUser
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  collection, doc, getDoc, getDocs, updateDoc, deleteDoc,
  query, where, orderBy, limit, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── State ────────────────────────────────────────────────────
let currentUser = null;
let ownerDoc    = null;

// ── Helpers ──────────────────────────────────────────────────
function qs(sel, parent = document) { return parent.querySelector(sel); }

function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function showToast(msg, type = 'success') {
  const t = qs('#toast');
  t.textContent = msg;
  t.className = `toast ${type} visible`;
  clearTimeout(t._timeout);
  t._timeout = setTimeout(() => { t.className = 'toast'; }, 3200);
}

function hideLoading() {
  qs('#pageLoading').classList.add('hidden');
}

// ── Auth Gate ────────────────────────────────────────────────
const _authUnsub = onAuthStateChanged(auth, async (user) => {
  _authUnsub();
  if (!user) {
    window.location.href = '/auth.html?from=udash_no_user';
    return;
  }
  currentUser = user;
  await initUserDash();
  onAuthStateChanged(auth, u => { if (!u) window.location.href = '/auth.html?from=udash_signout'; });
});

async function initUserDash() {
  qs('#logoutBtn')?.addEventListener('click', signOutUser);
  qs('#sidebarToggle')?.addEventListener('click', toggleSidebar);
  qs('#sidebarBackdrop')?.addEventListener('click', closeSidebar);

  try {
    const ownerSnap = await getDoc(doc(db, 'owners', currentUser.uid));

    if (!ownerSnap.exists()) {
      window.location.href = '/auth.html?from=udash_no_doc';
      return;
    }

    ownerDoc = ownerSnap.data();

    // Redirect admins and business accounts
    if (ownerDoc.role?.toLowerCase() === 'admin') {
      window.location.href = '/admin.html';
      return;
    }
    if (ownerDoc.acctType === 'business') {
      window.location.href = '/dashboard.html';
      return;
    }

    // Populate sidebar
    qs('#sidebarUserName').textContent = ownerDoc.name || currentUser.email;

    // Referral link
    const username = ownerDoc.username || '';
    const refUrl = username
      ? `https://eplocalproai.com/auth.html?ref=${username}`
      : '';

    if (refUrl) {
      qs('#refLinkDisplay').textContent = refUrl;
      qs('#topRefLink').textContent = refUrl;
      qs('#topCopyBtn').onclick = () => copyText(refUrl, '#topCopyBtn', 'Copied!', 'Copy');
      qs('#copyRefLinkBtn').onclick = () => copyText(refUrl, '#copyRefLinkBtn', '✅ Copied!', '📋 Copy');
    } else {
      qs('#refLinkDisplay').textContent = 'Set a username in Account to get your referral link';
      qs('#topRefLinkWrap').style.display = 'none';
    }

    hideLoading();
    showSection('overview');
    wireNav();

  } catch (err) {
    console.error('initUserDash error:', err);
    showToast('Failed to load dashboard.', 'error');
    hideLoading();
    showSection('overview');
    wireNav();
  }
}

function copyText(text, btnSel, doneLabel, resetLabel) {
  navigator.clipboard.writeText(text).then(() => {
    const btn = qs(btnSel);
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = doneLabel;
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = resetLabel || orig; btn.classList.remove('copied'); }, 2000);
  }).catch(() => showToast('Could not copy to clipboard.', 'error'));
}

// ── Section Navigation ───────────────────────────────────────
function showSection(name) {
  document.querySelectorAll('.sidebar-nav a[data-nav]').forEach(a => {
    a.classList.toggle('active', a.dataset.nav === name);
  });
  document.querySelectorAll('[data-section]').forEach(el => {
    el.classList.toggle('hidden', el.dataset.section !== name);
  });

  const titles = { overview: 'Overview', referrals: 'My Referrals', account: 'Account' };
  qs('#pageTitle').textContent = titles[name] || 'Overview';

  if (name === 'overview')  loadOverview();
  if (name === 'referrals') loadAllReferrals();
  if (name === 'account')   loadAccount();
}

let _navWired = false;
function wireNav() {
  if (_navWired) return;
  _navWired = true;

  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      showSection(el.dataset.nav);
      closeSidebar();
    });
  });
}

// ── Sidebar ──────────────────────────────────────────────────
function toggleSidebar() {
  qs('#dashSidebar').classList.toggle('open');
  qs('#sidebarBackdrop').classList.toggle('visible');
}
function closeSidebar() {
  qs('#dashSidebar').classList.remove('open');
  qs('#sidebarBackdrop').classList.remove('visible');
}

// ── Overview ─────────────────────────────────────────────────
async function loadOverview() {
  const username = ownerDoc?.username;
  if (!username) {
    setStats(0, 0, 0);
    renderRefTable('#recentRefTableBody', [], 3);
    return;
  }

  try {
    const q = query(
      collection(db, 'ep_referrals'),
      where('sponsorUsername', '==', username)
    );
    const snap = await getDocs(q);
    const refs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonth = refs.filter(r => {
      const d = r.convertedAt?.toDate ? r.convertedAt.toDate() : new Date(r.convertedAt || 0);
      return d >= monthStart;
    });

    setStats(refs.length, refs.length, thisMonth.length);

    // Sort by date desc for recent
    refs.sort((a, b) => {
      const ta = a.convertedAt?.toMillis ? a.convertedAt.toMillis() : 0;
      const tb = b.convertedAt?.toMillis ? b.convertedAt.toMillis() : 0;
      return tb - ta;
    });

    renderRefTable('#recentRefTableBody', refs.slice(0, 5), 3);

  } catch (err) {
    console.error('loadOverview error:', err);
    setStats(0, 0, 0);
    renderRefTable('#recentRefTableBody', [], 3);
  }
}

function setStats(total, converted, month) {
  qs('#statTotal').textContent    = total;
  qs('#statConverted').textContent = converted;
  qs('#statMonth').textContent    = month;
}

// ── All Referrals ────────────────────────────────────────────
async function loadAllReferrals() {
  const username = ownerDoc?.username;
  const tbody = qs('#allRefTableBody');
  tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p>Loading…</p></div></td></tr>`;

  if (!username) {
    tbody.innerHTML = `<tr><td colspan="3">${noUsernameMsg()}</td></tr>`;
    return;
  }

  try {
    const q = query(
      collection(db, 'ep_referrals'),
      where('sponsorUsername', '==', username)
    );
    const snap = await getDocs(q);
    const refs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    refs.sort((a, b) => {
      const ta = a.convertedAt?.toMillis ? a.convertedAt.toMillis() : 0;
      const tb = b.convertedAt?.toMillis ? b.convertedAt.toMillis() : 0;
      return tb - ta;
    });

    qs('#allRefCount').textContent = `${refs.length} total`;
    renderRefTable('#allRefTableBody', refs, 3);

  } catch (err) {
    console.error('loadAllReferrals error:', err);
    tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><p>Failed to load referrals.</p></div></td></tr>`;
  }
}

function noUsernameMsg() {
  return `<div class="ref-empty-state">
    <div class="ref-empty-icon">👤</div>
    <h3>Set your username first</h3>
    <p>Go to Account settings to set your username, then share your referral link.</p>
  </div>`;
}

function renderRefTable(tbodySel, refs, cols) {
  const tbody = qs(tbodySel);
  if (!refs.length) {
    tbody.innerHTML = `<tr><td colspan="${cols}">
      <div class="ref-empty-state">
        <div class="ref-empty-icon">🤝</div>
        <h3>No referrals yet</h3>
        <p>Share your referral link with local businesses to get started.</p>
      </div>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  refs.forEach(ref => {
    const planCap = ref.plan ? ref.plan.charAt(0).toUpperCase() + ref.plan.slice(1) : '—';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${ref.ownerEmail || '—'}</td>
      <td><span class="badge badge-${ref.plan || ''}">${planCap}</span></td>
      <td>${fmtDate(ref.convertedAt)}</td>`;
    tbody.appendChild(tr);
  });
}

// ── Account ──────────────────────────────────────────────────
async function loadAccount() {
  if (!ownerDoc) return;
  qs('#accFirstName').value = ownerDoc.firstName || '';
  qs('#accLastName').value  = ownerDoc.lastName  || '';
  qs('#accUsername').value  = ownerDoc.username  || '';
  qs('#accEmail').value     = currentUser.email  || '';
  qs('#accPhone').value     = ownerDoc.phone     || '';

  qs('#saveAccountBtn').onclick = saveAccount;

  // Populate My Links
  const username = ownerDoc.username || '';
  const refDisp  = qs('#accRefLinkDisplay');
  const refBtn   = qs('#accCopyRefBtn');
  const demoDisp = qs('#accDemoLinkDisplay');
  const demoBtn  = qs('#accCopyDemoBtn');

  if (username) {
    const refUrl = `https://eplocalproai.com/auth.html?ref=${username}`;
    if (refDisp) refDisp.textContent = refUrl;
    if (refBtn)  refBtn.onclick = () => copyText(refUrl, '#accCopyRefBtn', 'Copied!', 'Copy');

    try {
      const demoQ    = query(collection(db, 'demos'), where('referrerUsername', '==', username), limit(1));
      const demoSnap = await getDocs(demoQ);
      if (!demoSnap.empty) {
        const slug    = demoSnap.docs[0].data().slug || '';
        const demoUrl = `https://eplocalproai.com/demo/${slug}?ref=${username}`;
        if (demoDisp) demoDisp.textContent = demoUrl;
        if (demoBtn)  demoBtn.onclick = () => copyText(demoUrl, '#accCopyDemoBtn', 'Copied!', 'Copy');
      } else {
        if (demoDisp) demoDisp.textContent = 'No demo assigned yet';
      }
    } catch (_) {}
  } else {
    if (refDisp)  refDisp.textContent  = 'Set a username to get your links';
    if (demoDisp) demoDisp.textContent = 'Set a username to get your links';
  }

  // Load sponsor details
  await loadSponsorCard();

  // Wire cancel account
  qs('#cancelAccountBtn').onclick = cancelAccount;
}

async function saveAccount() {
  const btn = qs('#saveAccountBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Saving…';

  try {
    const firstName = qs('#accFirstName').value.trim();
    const lastName  = qs('#accLastName').value.trim();
    const phone     = qs('#accPhone').value.trim();

    await updateDoc(doc(db, 'owners', currentUser.uid), {
      firstName,
      lastName,
      name: `${firstName} ${lastName}`,
      phone
    });

    ownerDoc.firstName = firstName;
    ownerDoc.lastName  = lastName;
    ownerDoc.name      = `${firstName} ${lastName}`;
    ownerDoc.phone     = phone;

    qs('#sidebarUserName').textContent = ownerDoc.name;
    showToast('Profile saved!');
  } catch (err) {
    console.error('saveAccount error:', err);
    showToast('Failed to save.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  }
}

// ── Sponsor Card ─────────────────────────────────────────────
async function loadSponsorCard() {
  const card = qs('#sponsorCard');
  if (!card) return;

  const sponsorUsername = ownerDoc?.sponsorUsername;
  if (!sponsorUsername) {
    card.innerHTML = `<p class="form-hint" style="padding:4px 0;">No sponsor on record.</p>`;
    return;
  }

  // EZ Perfil is the platform sponsor — show hardcoded details if username matches
  const EZ_PERFIL = { name: 'EZ Perfil', username: 'ezperfil', email: 'eddieezperfil@gmail.com', phone: '1 (805) 707-3721' };
  if (sponsorUsername === 'ezperfil') {
    renderSponsorCard(card, EZ_PERFIL);
    return;
  }

  // Try to look up the sponsor in Firestore
  try {
    const q = query(collection(db, 'owners'), where('username', '==', sponsorUsername), limit(1));
    const snap = await getDocs(q);
    if (!snap.empty) {
      const s = snap.docs[0].data();
      renderSponsorCard(card, {
        name:     ((s.firstName || '') + ' ' + (s.lastName || '')).trim() || s.name || sponsorUsername,
        username: s.username || sponsorUsername,
        email:    s.email    || '—',
        phone:    s.phone    || '—'
      });
    } else {
      renderSponsorCard(card, { name: sponsorUsername, username: sponsorUsername, email: '—', phone: '—' });
    }
  } catch {
    renderSponsorCard(card, { name: sponsorUsername, username: sponsorUsername, email: '—', phone: '—' });
  }
}

function renderSponsorCard(card, s) {
  card.innerHTML = `
    <div class="sponsor-info-grid">
      <div class="sponsor-info-item">
        <span class="sponsor-info-label">Name</span>
        <span class="sponsor-info-value">${s.name}</span>
      </div>
      <div class="sponsor-info-item">
        <span class="sponsor-info-label">Username</span>
        <span class="sponsor-info-value">@${s.username}</span>
      </div>
      <div class="sponsor-info-item">
        <span class="sponsor-info-label">Email</span>
        <span class="sponsor-info-value">${s.email}</span>
      </div>
      <div class="sponsor-info-item">
        <span class="sponsor-info-label">Phone</span>
        <span class="sponsor-info-value">${s.phone}</span>
      </div>
    </div>`;
}

// ── Cancel Account ────────────────────────────────────────────
async function cancelAccount() {
  const confirmed = confirm(
    'Are you sure you want to cancel your account?\n\nThis will deactivate your account immediately. You will be signed out.'
  );
  if (!confirmed) return;

  const btn = qs('#cancelAccountBtn');
  btn.disabled = true;
  btn.textContent = 'Cancelling…';

  try {
    // Mark account as cancelled in Firestore
    await updateDoc(doc(db, 'owners', currentUser.uid), {
      status: 'cancelled',
      cancelledAt: serverTimestamp()
    });
    showToast('Account cancelled. Signing you out…', 'success');
    setTimeout(async () => {
      await signOut(auth);
      window.location.href = '/auth.html?from=cancelled';
    }, 2000);
  } catch (err) {
    console.error('cancelAccount error:', err);
    showToast('Failed to cancel account. Please contact support.', 'error');
    btn.disabled = false;
    btn.textContent = 'Cancel My Account';
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
