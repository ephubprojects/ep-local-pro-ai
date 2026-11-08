/* ============================================================
   EP Local Pro AI — wt.js  v3
   Two-way Staff Radio. MediaRecorder push-to-talk.
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
    await setupMic();

  } catch (err) {
    console.error('wt init error:', err);
    showError('Connection Error', 'Failed to connect. Check your internet and try again.');
  }
}

// ── Mic setup ─────────────────────────────────────────────────
async function setupMic() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    $pttHint.textContent = 'Hold to talk · Release to send';
    wirePtt();
  } catch (err) {
    console.warn('Mic access denied:', err);
    $pttBtn.disabled = true;
    $pttBtn.style.opacity = '0.5';
    $pttHint.textContent = '⚠️ Tap the lock icon in your browser bar to allow microphone access, then reload.';
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

      // Play audio for messages not from me, arriving after page load
      const msgTime = data.createdAt?.toMillis?.() ?? 0;
      if (data.from !== empCode && msgTime >= loadTime && data.audioB64) {
        const name = data.fromName || (data.from === 'owner' ? 'Boss' : 'Staff');
        enqueueAudio(name, data.audioB64, data.mimeType || 'audio/webm');
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
function enqueueAudio(fromName, audioB64, mimeType) {
  audioQueue.push({ fromName, audioB64, mimeType });
  if (!audioPlaying) drainAudioQueue();
}

async function drainAudioQueue() {
  if (!audioQueue.length) { audioPlaying = false; return; }
  audioPlaying = true;
  const { fromName, audioB64, mimeType } = audioQueue.shift();

  if ($audioFrom) $audioFrom.textContent = fromName;
  $audioInd?.classList.remove('hidden');

  try {
    const bytes  = Uint8Array.from(atob(audioB64), c => c.charCodeAt(0));
    const url    = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    const player = new Audio(url);

    player.onended = () => {
      URL.revokeObjectURL(url);
      $audioInd?.classList.add('hidden');
      drainAudioQueue();
    };
    player.onerror = () => {
      URL.revokeObjectURL(url);
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

// ── PTT ───────────────────────────────────────────────────────
function wirePtt() {
  $pttBtn.addEventListener('mousedown',  startRec,  { passive: false });
  $pttBtn.addEventListener('touchstart', startRec,  { passive: false });
  $pttBtn.addEventListener('mouseup',    stopRec);
  $pttBtn.addEventListener('touchend',   stopRec,   { passive: false });
  $pttBtn.addEventListener('mouseleave', stopRec);
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
  recorder.start(100); // collect chunks every 100ms

  // Auto-stop after 20 seconds
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

  const mimeType = audioChunks[0]?.type || 'audio/webm';
  const blob     = new Blob(audioChunks, { type: mimeType });
  audioChunks    = [];

  if (blob.size < 500) {
    $pttHint.textContent = 'Hold to talk · Release to send';
    return;
  }

  const durationSec = Math.round(blob.size / 3000); // rough estimate

  try {
    const buffer = await blob.arrayBuffer();
    let binary = '';
    new Uint8Array(buffer).forEach(b => { binary += String.fromCharCode(b); });
    const audioB64 = btoa(binary);

    await addDoc(collection(db, 'wt_messages'), {
      bizId,
      from:      empCode,
      fromName:  empDoc?.name || 'Staff',
      empId,
      audioB64,
      mimeType,
      duration:  durationSec,
      createdAt: serverTimestamp()
    });
  } catch (err) {
    console.error('sendAudio error:', err);
  } finally {
    $pttHint.textContent = 'Hold to talk · Release to send';
  }
}

function getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
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
