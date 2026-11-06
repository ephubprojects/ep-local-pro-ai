/* ============================================================
   EP Local Pro AI — wt.js
   Employee walkie talkie mobile page. No Firebase Auth.
   URL: /wt.html?b=BIZID&e=EMPCODE
   ============================================================ */

import { db } from '/js/firebase.js';
import {
  collection, doc, getDocs, addDoc, updateDoc, onSnapshot,
  query, where, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ── URL params ───────────────────────────────────────────────
const params  = new URLSearchParams(window.location.search);
const bizId   = params.get('b');
const empCode = params.get('e');

// ── State ────────────────────────────────────────────────────
let empDoc       = null;
let empId        = null;
let recognition  = null;
let isRecording  = false;
let loadTime     = Date.now();
const playedSet  = new Set();

// ── DOM refs ─────────────────────────────────────────────────
const wtLoading   = document.getElementById('wtLoading');
const wtError     = document.getElementById('wtError');
const wtMain      = document.getElementById('wtMain');
const wtPttBtn    = document.getElementById('wtPttBtn');
const wtPttStatus = document.getElementById('wtPttStatus');
const wtIncoming  = document.getElementById('wtIncomingText');
const wtAudioInd  = document.getElementById('wtAudioIndicator');

// ── Boot ─────────────────────────────────────────────────────
init();

async function init() {
  if (!bizId || !empCode) {
    return showError('Missing Parameters', 'The link you followed is missing required parameters. Ask your manager for a new link.');
  }

  try {
    // Look up employee by bizId + code
    const empQ = query(
      collection(db, 'employees'),
      where('bizId', '==', bizId),
      where('code', '==', empCode)
    );
    const empSnap = await getDocs(empQ);

    if (empSnap.empty) {
      return showError('Invalid Link', 'This link is no longer valid. Please ask your manager for a new link.');
    }

    const empDocSnap = empSnap.docs[0];
    empId  = empDocSnap.id;
    empDoc = empDocSnap.data();

    // Look up business name
    let bizName = 'Your Business';
    try {
      const bizQ = query(collection(db, 'businesses'), where('ownerId', '==', empDoc.ownerId));
      const bizSnap = await getDocs(bizQ);
      if (!bizSnap.empty) bizName = bizSnap.docs[0].data().name || bizName;
    } catch { /* non-critical */ }

    // Show main screen
    document.getElementById('wtBizName').textContent = bizName;
    document.getElementById('wtRole').textContent    = empDoc.role || 'Employee';
    document.getElementById('wtName').textContent    = empDoc.name || 'You';

    showScreen('main');
    loadTime = Date.now();

    // Listen for incoming messages from owner
    subscribeMessages();

    // Wire PTT
    wirePtt();

  } catch (err) {
    console.error('wt init error:', err);
    showError('Connection Error', 'Failed to connect. Check your internet connection and try again.');
  }
}

// ── Message listener ─────────────────────────────────────────
function subscribeMessages() {
  const q = query(
    collection(db, 'wt_messages'),
    where('bizId', '==', bizId),
    where('empCode', '==', empCode)
  );

  onSnapshot(q, (snap) => {
    snap.docChanges().forEach(change => {
      if (change.type !== 'added') return;
      const data = change.doc.data();
      const msgId = change.doc.id;

      if (data.from !== 'owner') return;
      if (playedSet.has(msgId)) return;

      const msgTime = data.createdAt?.toMillis ? data.createdAt.toMillis() : 0;
      if (msgTime < loadTime) return;

      playedSet.add(msgId);
      playMessage(msgId, data.text);
    });
  }, (err) => {
    console.error('wt_messages snapshot error:', err);
  });
}

// ── TTS playback ─────────────────────────────────────────────
async function playMessage(msgId, text) {
  if (!text) return;
  wtIncoming.textContent = `Boss: "${text}"`;
  wtAudioInd.classList.remove('hidden');

  try {
    const res = await fetch('/.netlify/functions/wt-tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });

    if (!res.ok) throw new Error('TTS failed');
    const { audio } = await res.json();

    const bytes = Uint8Array.from(atob(audio), c => c.charCodeAt(0));
    const blob  = new Blob([bytes], { type: 'audio/mpeg' });
    const url   = URL.createObjectURL(blob);
    const player = new Audio(url);

    player.onended = () => {
      URL.revokeObjectURL(url);
      wtAudioInd.classList.add('hidden');
    };

    await player.play();

    // Mark as played
    await updateDoc(doc(db, 'wt_messages', msgId), { played: true }).catch(() => {});

  } catch (err) {
    console.error('playMessage error:', err);
    wtAudioInd.classList.add('hidden');
  }
}

// ── PTT ──────────────────────────────────────────────────────
function wirePtt() {
  if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
    const warn = document.createElement('div');
    warn.className = 'wt-no-speech';
    warn.textContent = 'Your browser does not support voice recording. Use Chrome for best results.';
    document.body.appendChild(warn);
    wtPttBtn.disabled = true;
    return;
  }

  wtPttBtn.addEventListener('mousedown',  startRecording);
  wtPttBtn.addEventListener('touchstart', startRecording, { passive: true });
  wtPttBtn.addEventListener('mouseup',    stopRecording);
  wtPttBtn.addEventListener('touchend',   stopRecording, { passive: true });
  wtPttBtn.addEventListener('mouseleave', stopRecording);
}

function startRecording(e) {
  e.preventDefault();
  if (isRecording) return;
  isRecording = true;

  wtPttBtn.classList.add('recording');
  wtPttStatus.textContent = '🔴 Recording… release to send';

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous    = false;
  recognition.interimResults = false;
  recognition.lang          = 'en-US';

  recognition.onresult = (ev) => {
    const text = ev.results[0][0].transcript;
    sendMessage(text);
  };

  recognition.onerror = (ev) => {
    console.error('speech error:', ev.error);
    resetPtt();
  };

  recognition.onend = () => {
    resetPtt();
  };

  recognition.start();
}

function stopRecording() {
  if (!isRecording) return;
  if (recognition) {
    recognition.stop();
  }
  resetPtt();
}

function resetPtt() {
  isRecording = false;
  wtPttBtn.classList.remove('recording');
  wtPttStatus.textContent = 'Release to send';
  recognition = null;
}

// ── Send message ─────────────────────────────────────────────
async function sendMessage(text) {
  if (!text || !text.trim()) return;

  try {
    await addDoc(collection(db, 'wt_messages'), {
      bizId,
      empCode,
      empId,
      from:      'employee',
      text:      text.trim(),
      played:    false,
      createdAt: serverTimestamp()
    });
  } catch (err) {
    console.error('sendMessage error:', err);
  }
}

// ── UI helpers ───────────────────────────────────────────────
function showScreen(name) {
  wtLoading.classList.add('hidden');
  wtError.classList.add('hidden');
  wtMain.classList.add('hidden');

  if (name === 'loading') wtLoading.classList.remove('hidden');
  if (name === 'error')   wtError.classList.remove('hidden');
  if (name === 'main')    wtMain.classList.remove('hidden');
}

function showError(title, msg) {
  document.getElementById('wtErrorTitle').textContent = title;
  document.getElementById('wtErrorMsg').textContent   = msg;
  showScreen('error');
}
