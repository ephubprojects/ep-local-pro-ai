/* ============================================================
   EP Local Pro AI — wt.js  v2
   Two-way Staff Radio. No Firebase Auth required.
   URL: /wt?b=BIZID&e=EMPCODE
   ============================================================ */

import { db } from '/js/firebase.js';
import {
  collection, doc, getDocs, addDoc, updateDoc, onSnapshot,
  query, where, orderBy, limit, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── URL params ───────────────────────────────────────────────
const params  = new URLSearchParams(window.location.search);
const bizId   = params.get('b');
const empCode = params.get('e');

// ── State ────────────────────────────────────────────────────
let empDoc       = null;
let empId        = null;
let isRecording  = false;
let recognition  = null;
let loadTime     = Date.now();
const playedSet  = new Set();
let heartbeat    = null;
let ttsQueue     = [];
let ttsPlaying   = false;

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
  if (!bizId || !empCode) {
    return showError('Missing Parameters', 'The link you followed is missing required parameters. Ask your manager for a new link.');
  }

  try {
    const empQ    = query(collection(db, 'employees'), where('bizId', '==', bizId), where('code', '==', empCode));
    const empSnap = await getDocs(empQ);

    if (empSnap.empty) {
      return showError('Invalid Link', 'This link is no longer valid. Ask your manager for a new one.');
    }

    empId  = empSnap.docs[0].id;
    empDoc = empSnap.docs[0].data();

    let bizName = 'Your Business';
    try {
      const bizQ = query(collection(db, 'businesses'), where('ownerId', '==', empDoc.ownerId));
      const bizS = await getDocs(bizQ);
      if (!bizS.empty) bizName = bizS.docs[0].data().name || bizName;
    } catch {}

    document.getElementById('wtBizName').textContent   = bizName;
    document.getElementById('wtRole').textContent      = empDoc.role || 'Employee';
    document.getElementById('wtNameBadge').textContent = empDoc.name || 'You';

    showScreen('main');
    loadTime = Date.now();

    markOnline();
    heartbeat = setInterval(markOnline, 30_000);
    loadOnlineList();
    setInterval(loadOnlineList, 30_000);

    subscribeMessages();
    wirePtt();

  } catch (err) {
    console.error('wt init error:', err);
    showError('Connection Error', 'Failed to connect. Check your internet and try again.');
  }
}

// ── Presence ─────────────────────────────────────────────────
async function markOnline() {
  if (!empId) return;
  try {
    await updateDoc(doc(db, 'employees', empId), { wtOnline: true, lastSeen: serverTimestamp() });
  } catch {}
}

async function loadOnlineList() {
  try {
    const snap = await getDocs(query(collection(db, 'employees'), where('bizId', '==', bizId)));
    const now    = Date.now();
    const twoMin = 120_000;
    const online = snap.docs.map(d => d.data()).filter(e => {
      const ls = e.lastSeen?.toMillis?.() ?? 0;
      return e.wtOnline && (now - ls) < twoMin;
    });
    const names = online.map(e => e.code === empCode ? 'You' : (e.name || 'Staff')).join(', ');
    $onlineText.textContent = online.length
      ? `${online.length} online: ${names}`
      : 'You are online';
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

      // TTS for messages not from me, arriving after page load
      const msgTime = data.createdAt?.toMillis?.() ?? 0;
      if (data.from !== empCode && msgTime >= loadTime) {
        const name = data.fromName || (data.from === 'owner' ? 'Boss' : 'Staff');
        enqueueTts(msgId, name, data.text);
      }
    });
  }, err => console.error('wt_messages snapshot error:', err));
}

function appendMessage(data) {
  const hint = document.getElementById('wtFeedHint');
  if (hint) hint.remove();

  const isMe    = data.from === empCode;
  const isOwner = data.from === 'owner';
  const sender  = isMe ? 'You' : (data.fromName || (isOwner ? 'Boss' : 'Staff'));
  const time    = data.createdAt?.toDate?.()?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || '';

  const row = document.createElement('div');
  row.className = 'wt-msg' + (isMe ? ' wt-msg-me' : isOwner ? ' wt-msg-owner' : '');
  row.innerHTML = `
    <span class="wt-msg-sender">${esc(sender)}</span>
    <div class="wt-msg-bubble">${esc(data.text || '')}</div>
    <span class="wt-msg-time">${time}</span>`;
  $feed.appendChild(row);
  $feed.scrollTop = $feed.scrollHeight;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── TTS queue ─────────────────────────────────────────────────
function enqueueTts(msgId, fromName, text) {
  if (!text) return;
  ttsQueue.push({ msgId, fromName, text });
  if (!ttsPlaying) drainTtsQueue();
}

async function drainTtsQueue() {
  if (!ttsQueue.length) { ttsPlaying = false; return; }
  ttsPlaying = true;
  const { msgId, fromName, text } = ttsQueue.shift();

  $audioFrom.textContent = fromName;
  $audioInd.classList.remove('hidden');

  try {
    const res = await fetch('/.netlify/functions/wt-tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) throw new Error('TTS failed');
    const { audio } = await res.json();

    const bytes  = Uint8Array.from(atob(audio), c => c.charCodeAt(0));
    const url    = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
    const player = new Audio(url);

    player.onended = () => {
      URL.revokeObjectURL(url);
      $audioInd.classList.add('hidden');
      drainTtsQueue();
    };
    await player.play();
    await updateDoc(doc(db, 'wt_messages', msgId), { played: true }).catch(() => {});

  } catch (err) {
    console.error('playTts error:', err);
    $audioInd.classList.add('hidden');
    drainTtsQueue();
  }
}

// ── PTT ───────────────────────────────────────────────────────
function wirePtt() {
  if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
    $pttBtn.disabled = true;
    $pttHint.textContent = '⚠️ Voice not supported — use Chrome';
    return;
  }

  $pttBtn.addEventListener('mousedown',  startRec);
  $pttBtn.addEventListener('touchstart', startRec,  { passive: false });
  $pttBtn.addEventListener('mouseup',    stopRec);
  $pttBtn.addEventListener('touchend',   stopRec,   { passive: false });
  $pttBtn.addEventListener('mouseleave', stopRec);
}

function startRec(e) {
  e.preventDefault();
  if (isRecording) return;
  isRecording = true;
  $pttBtn.classList.add('recording');
  $pttHint.textContent = '🔴 Recording… release to send';

  const SR   = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous     = false;
  recognition.interimResults = false;
  recognition.lang           = empDoc?.lang === 'es' ? 'es-US' : 'en-US';
  recognition.onresult       = ev => sendMessage(ev.results[0][0].transcript);
  recognition.onerror        = ()  => resetPtt();
  recognition.onend          = ()  => resetPtt();
  try { recognition.start(); } catch { resetPtt(); }
}

function stopRec() {
  if (!isRecording) return;
  recognition?.stop();
  resetPtt();
}

function resetPtt() {
  isRecording = false;
  $pttBtn.classList.remove('recording');
  $pttHint.textContent = 'Release to send to all staff';
  recognition = null;
}

async function sendMessage(text) {
  if (!text?.trim()) return;
  try {
    await addDoc(collection(db, 'wt_messages'), {
      bizId,
      from:      empCode,
      fromName:  empDoc?.name || 'Staff',
      empId,
      text:      text.trim(),
      createdAt: serverTimestamp()
    });
  } catch (err) {
    console.error('sendMessage error:', err);
  }
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
    if (empId) updateDoc(doc(db, 'employees', empId), { wtOnline: false }).catch(() => {});
  } else {
    markOnline();
    heartbeat = setInterval(markOnline, 30_000);
  }
});
