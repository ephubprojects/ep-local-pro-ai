/* ============================================================
   EP Local Pro AI — user-dashboard.js
   Personal / referrer account dashboard.
   ============================================================ */

import { auth, db } from '/js/firebase.js';
import {
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  collection, doc, getDoc, getDocs, updateDoc,
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
function loadAccount() {
  if (!ownerDoc) return;
  qs('#accFirstName').value = ownerDoc.firstName || '';
  qs('#accLastName').value  = ownerDoc.lastName  || '';
  qs('#accUsername').value  = ownerDoc.username  || '';
  qs('#accEmail').value     = currentUser.email  || '';
  qs('#accPhone').value     = ownerDoc.phone     || '';
  qs('#accSponsor').value   = ownerDoc.sponsorUsername || '—';

  qs('#saveAccountBtn').onclick = saveAccount;
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
