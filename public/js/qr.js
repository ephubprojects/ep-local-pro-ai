/**
 * EP Local Pro AI — qr.js
 * Dynamic QR code landing page.
 * Loads QR code data from Firestore and shows/redirects.
 * No auth required — public read.
 */

import { db } from '/js/firebase.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const params  = new URLSearchParams(location.search);
const bizId   = params.get('biz');
const adminId = params.get('admin');
const qrId    = params.get('id');

document.addEventListener('DOMContentLoaded', async () => {
  if (!qrId || (!bizId && !adminId)) {
    return showState('error');
  }

  try {
    let qrData = null;

    if (bizId) {
      const snap = await getDoc(doc(db, 'businesses', bizId));
      if (snap.exists()) {
        const codes = snap.data().qrCodes;
        if (Array.isArray(codes)) qrData = codes.find(q => q.id === qrId) || null;
      }
    } else if (adminId) {
      const snap = await getDoc(doc(db, 'owners', adminId));
      if (snap.exists()) {
        const codes = snap.data().qrCodes;
        if (Array.isArray(codes)) qrData = codes.find(q => q.id === qrId) || null;
      }
    }

    if (!qrData) return showState('error');

    if (qrData.enabled === false) return showState('inactive');

    // Active — show content and redirect
    document.title = qrData.name || 'QR Code';
    document.getElementById('qr-title').textContent = qrData.name || '';
    document.getElementById('qr-desc').textContent  = qrData.description || '';
    const link = document.getElementById('qr-link');
    link.href = qrData.targetUrl || '#';
    showState('active');

    if (qrData.targetUrl) {
      let secs = 3;
      const countEl = document.getElementById('qr-countdown');
      countEl.textContent = `Redirecting in ${secs}s…`;
      const t = setInterval(() => {
        secs--;
        if (secs <= 0) {
          clearInterval(t);
          window.location.href = qrData.targetUrl;
        } else {
          countEl.textContent = `Redirecting in ${secs}s…`;
        }
      }, 1000);
    }

  } catch (err) {
    console.error('qr.js error:', err);
    showState('error');
  }
});

function showState(state) {
  ['loading','active','inactive','error'].forEach(s => {
    document.getElementById('state-' + s).style.display = s === state ? 'block' : 'none';
  });
}
