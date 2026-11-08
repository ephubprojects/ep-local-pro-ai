/* ============================================================
   EP Local Pro AI — wt.js  v4
   Two-way Staff Radio. No login required.
   Employee mode : /wt?b=BIZID&e=EMPCODE
   Owner mobile  : /wt?b=BIZID&o=OWNERTOKEN
   ============================================================ */

import { db, storage } from '/js/firebase.js';
import {
  collection, doc, getDoc, getDocs, addDoc, updateDoc, onSnapshot,
  query, where, orderBy, limit, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
  ref, uploadBytes, getDownloadURL
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

// ── URL params ───────────────────────────────────────────────
const params     = new URLSearchParams(window.location.search);
const bizId      = params.get('b');
const empCode    = params.get('e');   // employee mode
const ownerToken = params.get('o');   // owner mobile mode

// ── Identity (set after auth) ─────────────────────────────────
// { from, name, role, empId | null }
let identity = null;

// ── State ────────────────────────────────────────────────────
let loadTime     = Date.now();
const playedSet  = new Set();
let heartbeat    = null;

// MediaRecorder
let mediaStream  = null;
let recorder     = null;
let audioChunks  = [];
let isRecording  = false;
let recTimer     = null;

// Audio playback queue
let audioQueue   = [];
let audioPlaying = false;

// ── DOM ──────────────────────────────────────────────────────
const $loading    = document.getElementById('wtLoading');
const $error      = document.getElementById('wtError');
const $main       = document.getElementById('wtMain');
const $pttBtn     = document.getElementById('wtPttBtn');
const $pttHint    = document.getElementById('wtPttHint');
const $feed       = document.getElementById('wtFeed');
const $audioInd   = document.getElementById('wtAudioIndicator');
const $audioFrom  = document.getElementById('wtAudioFrom');
const $onlineText = document.getElementById('wtOnlineText');

// ── Boot ─────────────────────────────────────────────────────
init();

async function init() {
  if (!bizId || (!empCode && !ownerToken)) {
    return showError('Missing Parameters', 'The link you followed is incomplete. Ask your manager for a new link.');
  }

  try {
    // Load business doc (always needed)
    const bizSnap = await getDoc(doc(db, 'businesses', bizId));
    if (!bizSnap.exists()) {
      return showError('Invalid Link', 'Business not found. Ask your manager for a new link.');
    }
    const bizData = bizSnap.data();
    const bizName = bizData.name || bizData.bizName || 'Your Business';

    if (ownerToken) {
      // ── OWNER MOBILE MODE ────────────────────────────────────
      if (!bizData.wtOwnerToken || bizData.wtOwnerToken !== ownerToken) {
        return showError('Invalid Link', 'This owner link is invalid or has been reset. Get a new one from your dashboard.');
      }
      identity = { from: 'owner', name: bizData.name || 'Owner', role: 'Owner', empId: null };

      // Owner presence in business doc
      markOwnerOnline();
      heartbeat = setInterval(markOwnerOnline, 30_000);

    } else {
      // ── EMPLOYEE MODE ────────────────────────────────────────
      const empQ    = query(
        collection(db, 'employees'),
        where('bizId', '==', bizId),
        where('code', '==', empCode)
      );
      const empSnap = await getDocs(empQ);

      if (empSnap.empty) {
        return showError('Invalid Link', 'This link is no longer valid. Ask your manager for a new one.');
      }

      const empDocSnap = empSnap.docs[0];
      const empData    = empDocSnap.data();

      if (empData.wtActive === false) {
        return showError('Access Removed', 'Your walkie talkie access has been removed. Contact your manager.');
      }

      identity = {
        from:  empCode,
        name:  empData.name || 'Staff',
        role:  empData.role || 'Employee',
        empId: empDocSnap.id
      };

      markEmpOnline();
      heartbeat = setInterval(markEmpOnline, 30_000);
    }

    document.getElementById('wtBizName').textContent   = bizName;
    document.getElementById('wtRole').textContent      = identity.role;
    document.getElementById('wtNameBadge').textContent = identity.name;

    showScreen('main');
    loadTime = Date.now();

    loadOnlineList();
    setInterval(loadOnlineList, 30_000);
    subscribeMessages();
    await setupMic();

  } catch (err) {
    console.error('wt init error:', err);
    showError('Connection Error', 'Failed to connect. Check your internet connection and try again.');
  }
}

// ── Presence ─────────────────────────────────────────────────
async function markEmpOnline() {
  if (!identity?.empId) return;
  try {
    await updateDoc(doc(db, 'employees', identity.empId), {
      wtOnline: true,
      lastSeen: serverTimestamp()
    });
  } catch {}
}

async function markOwnerOnline() {
  try {
    await updateDoc(doc(db, 'businesses', bizId), {
      wtOwnerOnline:   true,
      wtOwnerLastSeen: serverTimestamp()
    });
  } catch {}
}

async function loadOnlineList() {
  try {
    const now    = Date.now();
    const twoMin = 120_000;
    const names  = [];

    // Check owner online status
    const bizSnap = await getDoc(doc(db, 'businesses', bizId));
    if (bizSnap.exists()) {
      const bd = bizSnap.data();
      const ls = bd.wtOwnerLastSeen?.toMillis?.() ?? 0;
      if (bd.wtOwnerOnline && (now - ls) < twoMin) {
        names.push(identity?.from === 'owner' ? 'You (Owner)' : 'Owner');
      }
    }

    // Check employee online status
    const empSnap = await getDocs(
      query(collection(db, 'employees'), where('bizId', '==', bizId))
    );
    empSnap.docs.forEach(d => {
      const e  = d.data();
      const ls = e.lastSeen?.toMillis?.() ?? 0;
      if (e.wtOnline && (now - ls) < twoMin) {
        names.push(e.code === empCode ? 'You' : (e.name || 'Staff'));
      }
    });

    $onlineText.textContent = names.length
      ? `${names.length} online: ${names.join(', ')}`
      : 'Only you online';
  } catch {}
}

// ── Message feed ─────────────────────────────────────────────
function subscribeMessages() {
  const q = query(
    collection(db, 'wt_messages'),
    where('bizId', '==', bizId),
    orderBy('createdAt', 'asc'),
    limit(100)
  );

  onSnapshot(q, snap => {
    snap.docChanges().forEach(change => {
      if (change.type !== 'added') return;
      const msgId = change.doc.id;
      const data  = change.doc.data();

      if (playedSet.has(msgId)) return;
      playedSet.add(msgId);

      appendMessage(data);

      // Play audio for messages not from me, arriving after page load
      const msgTime = data.createdAt?.toMillis?.() ?? 0;
      if (data.from !== identity?.from && msgTime >= loadTime) {
        const name = data.fromName || (data.from === 'owner' ? 'Boss' : 'Staff');
        if (data.audioUrl) {
          enqueueAudio(name, data.audioUrl, null);
        } else if (data.audioB64) {
          enqueueAudio(name, null, { b64: data.audioB64, type: data.mimeType || 'audio/webm' });
        }
      }
    });
  }, err => console.error('wt_messages snapshot error:', err));
}

function appendMessage(data) {
  const hint = document.getElementById('wtFeedHint');
  if (hint) hint.remove();

  const isMe    = data.from === identity?.from;
  const isOwner = data.from === 'owner';
  const sender  = isMe ? 'You' : (data.fromName || (isOwner ? 'Boss' : 'Staff'));
  const time    = data.createdAt?.toDate?.()?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || '';
  const dur     = data.duration ? ` · ${data.duration}s` : '';

  const row = document.createElement('div');
  row.className = 'wt-msg' + (isMe ? ' wt-msg-me' : isOwner ? ' wt-msg-owner' : '');
  row.innerHTML = `
    <span class="wt-msg-sender">${esc(sender)}</span>
    <div class="wt-msg-bubble">🎤 Voice message${dur}</div>
    <span class="wt-msg-time">${time}</span>`;
  $feed.appendChild(row);
  $feed.scrollTop = $feed.scrollHeight;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Audio playback queue ──────────────────────────────────────
function enqueueAudio(fromName, audioUrl, b64Data) {
  audioQueue.push({ fromName, audioUrl, b64Data });
  if (!audioPlaying) drainAudioQueue();
}

async function drainAudioQueue() {
  if (!audioQueue.length) { audioPlaying = false; return; }
  audioPlaying = true;
  const { fromName, audioUrl, b64Data } = audioQueue.shift();

  if ($audioFrom) $audioFrom.textContent = fromName;
  $audioInd?.classList.remove('hidden');

  try {
    let url = audioUrl;
    let isObjectUrl = false;
    if (!url && b64Data?.b64) {
      const bytes = Uint8Array.from(atob(b64Data.b64), c => c.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bytes], { type: b64Data.type }));
      isObjectUrl = true;
    }
    if (!url) { $audioInd?.classList.add('hidden'); drainAudioQueue(); return; }

    const player = new Audio(url);
    player.onended = () => {
      if (isObjectUrl) URL.revokeObjectURL(url);
      $audioInd?.classList.add('hidden');
      drainAudioQueue();
    };
    player.onerror = () => {
      if (isObjectUrl) URL.revokeObjectURL(url);
      $audioInd?.classList.add('hidden');
      drainAudioQueue();
    };
    await player.play();
  } catch (err) {
    console.error('playAudio error:', err);
    $audioInd?.classList.add('hidden');
    drainAudioQueue();
  }
}

// ── Mic setup ─────────────────────────────────────────────────
async function setupMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    $pttBtn.disabled = true;
    $pttBtn.style.opacity = '0.5';
    $pttHint.textContent = '⚠️ Microphone not supported on this browser.';
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    $pttHint.textContent = 'Hold to talk · Release to send';
    wirePtt();
  } catch (err) {
    console.warn('Mic access denied:', err);
    $pttBtn.disabled = true;
    $pttBtn.style.opacity = '0.5';
    $pttHint.innerHTML = '⚠️ Microphone access required.<br>Tap the lock icon in your browser bar, allow mic, then reload.';
  }
}

// ── PTT ───────────────────────────────────────────────────────
function wirePtt() {
  $pttBtn.addEventListener('mousedown',  startRec,  { passive: false });
  $pttBtn.addEventListener('touchstart', startRec,  { passive: false });
  $pttBtn.addEventListener('mouseup',    stopRec,   { passive: false });
  $pttBtn.addEventListener('touchend',   stopRec,   { passive: false });
  $pttBtn.addEventListener('mouseleave', stopRec,   { passive: false });
}

function startRec(e) {
  e.preventDefault();
  if (isRecording || !mediaStream) return;
  isRecording = true;
  audioChunks = [];

  $pttBtn.classList.add('recording');
  $pttHint.textContent = '🔴 Recording… release to send';

  const mimeType = getSupportedMimeType();
  try {
    recorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : {});
  } catch {
    recorder = new MediaRecorder(mediaStream);
  }
  recorder.ondataavailable = ev => { if (ev.data.size > 0) audioChunks.push(ev.data); };
  recorder.onstop = onRecordingStop;
  recorder.start(100);

  recTimer = setTimeout(() => { if (isRecording) stopRec(); }, 20_000);
}

function stopRec(e) {
  if (e) e.preventDefault();
  if (!isRecording) return;
  clearTimeout(recTimer);
  isRecording = false;
  $pttBtn.classList.remove('recording');
  $pttHint.textContent = 'Sending…';
  if (recorder?.state === 'recording') recorder.stop();
}

async function onRecordingStop() {
  recorder = null;
  if (!audioChunks.length) {
    $pttHint.textContent = 'Hold to talk · Release to send';
    return;
  }

  const mimeType   = audioChunks[0]?.type || 'audio/webm';
  const blob       = new Blob(audioChunks, { type: mimeType });
  audioChunks      = [];

  if (blob.size < 500) {
    $pttHint.textContent = 'Hold to talk · Release to send';
    return;
  }

  $pttHint.textContent = 'Sending…';
  const durationSec = Math.max(1, Math.round(blob.size / 3000));

  try {
    const payload = { bizId, from: identity.from, fromName: identity.name, mimeType, duration: durationSec, createdAt: serverTimestamp() };

    // Try Firebase Storage first; fall back to base64 in Firestore
    try {
      const ext     = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm';
      const path    = `wt_audio/${bizId}/${Date.now()}_${identity.from}.${ext}`;
      const sRef    = ref(storage, path);
      await uploadBytes(sRef, blob);
      payload.audioUrl = await getDownloadURL(sRef);
    } catch {
      payload.audioB64 = await blobToBase64(blob);
    }

    await addDoc(collection(db, 'wt_messages'), payload);
  } catch (err) {
    console.error('sendAudio error:', err);
    $pttHint.textContent = '⚠️ Send failed — try again';
    setTimeout(() => { $pttHint.textContent = 'Hold to talk · Release to send'; }, 3000);
    return;
  }

  $pttHint.textContent = 'Hold to talk · Release to send';
}

function getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ── UI helpers ───────────────────────────────────────────────
function showScreen(name) {
  [$loading, $error, $main].forEach(el => el?.classList.add('hidden'));
  if (name === 'loading') $loading?.classList.remove('hidden');
  if (name === 'error')   $error?.classList.remove('hidden');
  if (name === 'main')    $main?.classList.remove('hidden');
}

function showError(title, msg) {
  document.getElementById('wtErrorTitle').textContent = title;
  document.getElementById('wtErrorMsg').textContent   = msg;
  showScreen('error');
}

// ── Presence cleanup on page hide ────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInterval(heartbeat);
    if (identity?.empId) {
      updateDoc(doc(db, 'employees', identity.empId), { wtOnline: false }).catch(() => {});
    }
    if (identity?.from === 'owner') {
      updateDoc(doc(db, 'businesses', bizId), { wtOwnerOnline: false }).catch(() => {});
    }
  } else {
    if (identity?.empId) markEmpOnline();
    if (identity?.from === 'owner') markOwnerOnline();
    heartbeat = setInterval(
      identity?.from === 'owner' ? markOwnerOnline : markEmpOnline,
      30_000
    );
  }
});
