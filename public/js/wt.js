/* ============================================================
   EP Local Pro AI — wt.js  v20
   Two-way Staff Radio. No login required.
   Employee mode : /wt?b=BIZID&e=EMPCODE
   Owner mobile  : /wt?b=BIZID&o=OWNERTOKEN
   ============================================================ */

import { db, storage } from '/js/firebase.js';
import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, onSnapshot,
  query, where, serverTimestamp, increment
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

// ── URL params ───────────────────────────────────────────────
const params     = new URLSearchParams(window.location.search);
const bizId      = params.get('b');
const empCode    = params.get('e');   // employee mode
const ownerToken = params.get('o');   // owner mobile mode

// ── Identity (set after auth) ─────────────────────────────────
let identity     = null;
let _bizOwnerId  = null; // WT plan check

// ── State ────────────────────────────────────────────────────
const playedSet   = new Set();
let heartbeat     = null;
// Timestamp when the page loaded — messages older than this are historical and skipped.
// Replaces the historyLoaded flag which had a race condition when the initial snapshot
// was slow (new messages sent during load got added to playedSet but never played).
const PAGE_LOAD_MS = Date.now();

// MediaRecorder
let mediaStream  = null;
let recorder     = null;
let audioChunks  = [];
let isRecording  = false;
let recTimer     = null;

// Audio playback queue
let audioQueue   = [];
let audioPlaying = false;
// Holds the resolve() of the current drainAudioQueue Promise so recording
// can cleanly terminate active playback without waiting 25 seconds.
let _resolveRxAudio = null;

// PTT hold state — used so stream recovery can auto-start recording
// if the user is still pressing the button when getUserMedia resolves.
let pttHeld        = false;
let micRequesting  = false;

// Persistent <audio> element for URL-based playback.
// MUST be pre-unlocked by a silent play() inside onActivate (a real user gesture)
// so iOS Safari allows async play() calls on it later. Fresh elements created
// outside a gesture are always blocked by iOS autoplay policy.
const $wtRxAudio = (() => {
  const el = document.createElement('audio');
  el.preload = 'none';
  document.body.appendChild(el);
  return el;
})();

// AudioContext — unlocked in onActivate alongside $wtRxAudio.
// Its presence keeps iOS in PlayAndRecord mode: once $wtRxAudio is fully
// abandoned (src='', load()), iOS exits Playback and reverts to PlayAndRecord
// so the next getUserMedia call gets a live mic.
let rxAudioCtx    = null;
let rxAudioSource = null; // active AudioBufferSourceNode (base64 path)

function getRxAudioCtx() {
  if (!rxAudioCtx || rxAudioCtx.state === 'closed') {
    rxAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return rxAudioCtx;
}

function stopRxAudio() {
  if (rxAudioSource) { try { rxAudioSource.stop(); } catch (_) {} rxAudioSource = null; }
  // Fully abandon $wtRxAudio so iOS exits Playback mode
  $wtRxAudio.pause();
  $wtRxAudio.onended = null;
  $wtRxAudio.onerror = null;
  $wtRxAudio.src  = '';
  $wtRxAudio.load();
}

// Push notifications
let swRegistration = null;
const VAPID_PUBLIC_KEY = 'BImnaD28aQfG8YdR9_PjwdlPLIfiGk4vfBfbmzo2uDOF21EEgDruZVxBUlupf2ObNL3zP5ATrlEgZDFRlhsEFxY';

// Contacts / channel targeting (employee side)
let empSelectedTarget = null;   // null = all staff; 'owner' = boss; empCode = specific employee
let empLastSpeakerId  = null;   // from field of most recent incoming message
let empEmployeeList   = [];     // other employees in this business
let empContactsOpen   = false;
let ownerIsOnline     = false;

// ── DOM ──────────────────────────────────────────────────────
const $loading    = document.getElementById('wtLoading');
const $error      = document.getElementById('wtError');
const $main       = document.getElementById('wtMain');
const $pttBtn     = document.getElementById('wtPttBtn');
const $pttHint    = document.getElementById('wtPttHint');
const $audioInd   = document.getElementById('wtAudioIndicator');
const $audioFrom  = document.getElementById('wtAudioFrom');
const $onlineText = document.getElementById('wtOnlineText');

// ── Boot ─────────────────────────────────────────────────────
init();

async function init() {
  registerSW();
  if (!bizId || (!empCode && !ownerToken)) {
    return showError('Missing Parameters', 'The link you followed is incomplete. Ask your manager for a new link.');
  }

  try {
    const bizSnap = await getDoc(doc(db, 'businesses', bizId));
    if (!bizSnap.exists()) {
      return showError('Invalid Link', 'Business not found. Ask your manager for a new link.');
    }
    const bizData  = bizSnap.data();
    const bizName  = bizData.name || bizData.bizName || 'Your Business';
    _bizOwnerId    = bizData.ownerId || null;

    if (ownerToken) {
      // ── OWNER MOBILE MODE ────────────────────────────────────
      if (!bizData.wtOwnerToken || bizData.wtOwnerToken !== ownerToken) {
        return showError('Invalid Link', 'This owner link is invalid or has been reset. Get a new one from your dashboard.');
      }
      identity = { from: 'owner', name: bizData.name || 'Owner', role: 'Owner', empId: null };
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

    loadOnlineList();
    setInterval(loadOnlineList, 30_000);
    loadEmpContacts();
    setInterval(loadEmpContacts, 30_000);
    subscribeMessages();
    wirePtt();

    document.getElementById('wtContactsToggle')
      ?.addEventListener('click', toggleEmpContacts);

  } catch (err) {
    console.error('wt init error:', err);
    showError('Connection Error', 'Failed to connect. Check your internet connection and try again.');
  }
}

// ── WT Message Limit ─────────────────────────────────────────
const WT_PLAN_LIMITS = { starter: 1000, pro: 2000 };

async function wtCheckLimit() {
  if (!_bizOwnerId) return { canSend: true };
  try {
    const monthKey = new Date().toISOString().slice(0, 7);
    const [bizSnap, ownerSnap] = await Promise.all([
      getDoc(doc(db, 'businesses', bizId)),
      getDoc(doc(db, 'owners', _bizOwnerId))
    ]);
    const biz   = bizSnap.data()  || {};
    const owner = ownerSnap.data() || {};
    const plan  = owner.addOns?.wtPlan    || 'starter';
    const extra = owner.addOns?.wtMsgExtra || 0;
    const total = (WT_PLAN_LIMITS[plan] || 200) + extra;
    const count = (biz.wtMsgMonth === monthKey) ? (biz.wtMsgCount || 0) : 0;
    if (count >= total) {
      return { canSend: false, limitMsg: `📵 Monthly limit reached (${count}/${total} messages). Contact support to add more.` };
    }
    return { canSend: true, monthKey, isNewMonth: biz.wtMsgMonth !== monthKey };
  } catch (e) {
    console.error('wtCheckLimit error:', e);
    return { canSend: true };
  }
}

async function wtIncrementUsage(monthKey, isNewMonth) {
  try {
    await updateDoc(doc(db, 'businesses', bizId),
      isNewMonth ? { wtMsgMonth: monthKey, wtMsgCount: 1 } : { wtMsgCount: increment(1) }
    );
  } catch (e) {
    console.error('wtIncrementUsage error:', e);
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

    const bizSnap = await getDoc(doc(db, 'businesses', bizId));
    if (bizSnap.exists()) {
      const bd = bizSnap.data();
      const ls = bd.wtOwnerLastSeen?.toMillis?.() ?? 0;
      if (bd.wtOwnerOnline && (now - ls) < twoMin) {
        names.push(identity?.from === 'owner' ? 'You (Owner)' : 'Owner');
      }
    }

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
    where('bizId', '==', bizId)
  );

  onSnapshot(q, snap => {
    snap.docChanges().forEach(change => {
      if (change.type !== 'added') return;
      const msgId = change.doc.id;
      const data  = change.doc.data();

      if (playedSet.has(msgId)) return;
      playedSet.add(msgId);

      // Skip historical messages sent before this page session loaded.
      // A 5-second buffer handles server timestamp skew; null createdAt (pending write)
      // defaults to now so it always plays.
      const msgMs = data.createdAt?.toMillis?.() ?? Date.now();
      if (msgMs < PAGE_LOAD_MS - 5000) return;

      // Skip messages not addressed to this employee (supports string or array `to`)
      if (data.to) {
        const toList = Array.isArray(data.to) ? data.to : [data.to];
        if (!toList.includes(identity?.from)) return;
      }

      if (data.from !== identity?.from) {
        const name = data.fromName || (data.from === 'owner' ? 'Boss' : 'Staff');

        // Track who last spoke (for the 🔊 indicator in contacts)
        empLastSpeakerId = data.from;

        // Auto-select the sender as reply target — but only for direct messages.
        // A broadcast (no `to` field) must not override the current target, or an
        // employee's reply would be re-routed to the last broadcaster instead of the
        // person they were already talking to. Owner never auto-switches target.
        if (identity?.from !== 'owner' && data.to) {
          empSelectedTarget = data.from;
          empContactsOpen   = true;
          document.getElementById('wtContacts')?.classList.add('open');
        }

        renderEmpContacts();
        if (!isRecording) updatePttHint();

        notifyIncoming(name);
        if (data.audioUrl) {
          enqueueAudio(name, data.audioUrl, null);
        } else if (data.audioB64) {
          enqueueAudio(name, null, { b64: data.audioB64, type: data.mimeType || 'audio/mp4' });
        }
      }
    });
  }, err => {
    console.error('wt_messages snapshot error:', err);
    $pttHint.textContent = '⚠️ Connection error — please refresh the page';
  });
}

// ── Audio playback queue ──────────────────────────────────────
function enqueueAudio(fromName, audioUrl, b64Data) {
  audioQueue.push({ fromName, audioUrl, b64Data });
  if (!audioPlaying) drainAudioQueue();
}

async function drainAudioQueue() {
  if (isRecording || !audioQueue.length) { audioPlaying = false; return; }
  audioPlaying = true;
  const { fromName, audioUrl, b64Data } = audioQueue.shift();

  if ($audioFrom) $audioFrom.textContent = fromName;
  $audioInd?.classList.remove('hidden');

  try {
    const ctx = getRxAudioCtx();
    if (ctx.state === 'suspended') await ctx.resume();

    if (b64Data?.b64) {
      // Base64 path — decode directly through AudioContext (no CORS needed).
      // AudioContext stays in PlayAndRecord mode so the mic is never blocked.
      const bytes = Uint8Array.from(atob(b64Data.b64), c => c.charCodeAt(0));
      const buf   = await ctx.decodeAudioData(bytes.buffer);

      await new Promise(resolve => {
        const timeout = setTimeout(() => { _resolveRxAudio = null; resolve(); }, 25_000);
        _resolveRxAudio = resolve;
        rxAudioSource = ctx.createBufferSource();
        rxAudioSource.buffer = buf;
        rxAudioSource.connect(ctx.destination);
        rxAudioSource.onended = () => {
          if (!_resolveRxAudio) return;
          _resolveRxAudio = null; clearTimeout(timeout); rxAudioSource = null; resolve();
        };
        rxAudioSource.start();
      });

    } else if (audioUrl) {
      // URL path — reuse persistent $wtRxAudio (pre-unlocked in onActivate).
      // Fresh elements created outside a user gesture are blocked by iOS autoplay.
      // <audio>.src bypasses CORS restrictions that block fetch().
      $wtRxAudio.onended = null;
      $wtRxAudio.onerror = null;
      $wtRxAudio.src = audioUrl;

      await new Promise(resolve => {
        const timeout = setTimeout(() => { _resolveRxAudio = null; resolve(); }, 25_000);
        _resolveRxAudio = resolve;
        $wtRxAudio.onended = () => {
          if (!_resolveRxAudio) return;
          _resolveRxAudio = null; clearTimeout(timeout); resolve();
        };
        $wtRxAudio.onerror = () => {
          const code = $wtRxAudio.error?.code ?? 0;
          if (code === 1) return; // MEDIA_ERR_ABORTED from src change — load continues
          clearTimeout(timeout); _resolveRxAudio = null; resolve();
        };
        $wtRxAudio.play().catch(() => { clearTimeout(timeout); _resolveRxAudio = null; resolve(); });
      });
    }
  } catch (err) {
    console.error('[WT] playback error:', err);
  } finally {
    _resolveRxAudio = null;
    stopRxAudio();
    $audioInd?.classList.add('hidden');
    drainAudioQueue();
  }
}

// ── PTT ───────────────────────────────────────────────────────
// Two-phase UX (same pattern as EP HUB voice channel):
//   Phase 1 — user taps to activate → getUserMedia → mic permission dialog
//   Phase 2 — PTT is live; hold to record, release to send
function wirePtt() {
  if (!navigator.mediaDevices?.getUserMedia) {
    $pttBtn.disabled = true;
    $pttHint.textContent = '⚠️ Microphone not supported on this browser.';
    return;
  }

  $pttBtn.classList.add('wt-ptt-activate');
  $pttBtn.querySelector('.wt-ptt-label').textContent = 'Activate';
  $pttHint.textContent = 'Tap once to activate your radio';

  function onActivate(e) {
    e.preventDefault();
    e.stopPropagation();
    $pttBtn.classList.remove('wt-ptt-activate');
    $pttBtn.querySelector('.wt-ptt-label').textContent = 'Hold to Talk';
    $pttHint.textContent = '🎤 Allow microphone in the popup…';

    // Unlock both audio systems inside this user gesture.
    // $wtRxAudio needs a real play() to be allowed async calls later on iOS.
    // AudioContext.resume() claims PlayAndRecord mode so the mic stays usable.
    try {
      $wtRxAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
      $wtRxAudio.play().catch(() => {});
    } catch (_) {}
    try { getRxAudioCtx().resume().catch(() => {}); } catch (_) {}

    // getUserMedia MUST be called via .then() inside a user-gesture handler —
    // do NOT convert to async/await; iOS Safari requires the call stack to remain
    // synchronous from the touch/click event.
    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(stream => {
        mediaStream = stream;
        $pttHint.textContent = 'Hold to talk · Release to send';
        requestNotifPermission();
        subscribePush();

        $pttBtn.addEventListener('mousedown',  startRec, { passive: false });
        $pttBtn.addEventListener('touchstart', startRec, { passive: false });
        $pttBtn.addEventListener('mouseup',    stopRec,  { passive: false });
        $pttBtn.addEventListener('touchend',   stopRec,  { passive: false });
        $pttBtn.addEventListener('mouseleave', stopRec,  { passive: false });
      })
      .catch(() => {
        $pttBtn.classList.add('wt-ptt-activate');
        $pttBtn.querySelector('.wt-ptt-label').textContent = 'Activate';
        $pttHint.textContent = '⚠️ Mic blocked — tap 🔒 in your browser bar, allow mic, then tap again';
      });
  }

  $pttBtn.addEventListener('click',      onActivate, { once: true, passive: false });
  $pttBtn.addEventListener('touchstart', onActivate, { once: true, passive: false });
}

function startRec(e) {
  e.preventDefault();
  if (isRecording || micRequesting || !mediaStream) return;
  pttHeld = true;
  micRequesting = true;

  // Stop active playback before requesting mic. For URL audio this fully
  // abandons the <audio> element (src='', load()), which signals iOS to release
  // the Playback session so getUserMedia gets a live mic.
  if (_resolveRxAudio) {
    const res = _resolveRxAudio;
    _resolveRxAudio = null;
    stopRxAudio();
    audioPlaying = false;
    res();
  }

  navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    .then(stream => {
      micRequesting = false;
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = stream;
      if (pttHeld && !isRecording) beginRecording();
      else updatePttHint();
    })
    .catch(() => {
      micRequesting = false;
      pttHeld = false;
      $pttHint.textContent = '⚠️ Mic unavailable — allow mic access and try again';
    });
}

function beginRecording() {
  // Belt-and-suspenders: stop any audio that arrived between startRec and now
  if (_resolveRxAudio) {
    const res = _resolveRxAudio;
    _resolveRxAudio = null;
    stopRxAudio();
    audioPlaying = false;
    res();
  }

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
  pttHeld = false;
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
    $pttHint.textContent = '⚠️ No audio — hold button and speak, then release';
    setTimeout(updatePttHint, 3000);
    return;
  }

  // Some older Android Chrome versions report 'video/webm' for audio-only tracks.
  let mimeType = audioChunks[0]?.type || 'audio/mp4';
  if (mimeType.startsWith('video/')) mimeType = mimeType.replace('video/', 'audio/');

  const blob  = new Blob(audioChunks, { type: mimeType });
  audioChunks = [];

  if (blob.size < 500) {
    $pttHint.textContent = '⚠️ No audio captured — try holding again';
    setTimeout(updatePttHint, 3000);
    return;
  }

  $pttHint.textContent = 'Sending…';
  const durationSec = Math.max(1, Math.round(blob.size / 3000));

  try {
    const payload = {
      bizId,
      from:      identity.from,
      fromName:  identity.name,
      mimeType,
      duration:  durationSec,
      createdAt: serverTimestamp()
    };
    if (empSelectedTarget) payload.to = empSelectedTarget;

    const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('wav') ? 'wav' : 'webm';
    const aRef = storageRef(storage, `wt_audio/${bizId}/${Date.now()}_${identity.from}.${ext}`);
    const snap  = await uploadBytes(aRef, blob, { contentType: mimeType });
    payload.audioUrl    = await getDownloadURL(snap.ref);
    payload.storagePath = snap.ref.fullPath;

    const limitCheck = await wtCheckLimit();
    if (!limitCheck.canSend) {
      $pttHint.textContent = limitCheck.limitMsg;
      return;
    }

    await addDoc(collection(db, 'wt_messages'), payload);
    wtIncrementUsage(limitCheck.monthKey, limitCheck.isNewMonth).catch(() => {});
    sendWtPush(identity.name, payload.to ?? null);
    updatePttHint();
    if (!audioPlaying) drainAudioQueue();

  } catch (err) {
    console.error('sendAudio error:', err);
    $pttHint.textContent = '⚠️ Send failed — check connection and try again';
  }
}

// Try audio/mp4 first — supported on iOS Safari AND Chrome/Android.
// audio/webm is NOT playable on iOS, so preferring mp4 ensures cross-device playback.
function getSupportedMimeType() {
  const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

// ── Employee contacts ─────────────────────────────────────────
async function loadEmpContacts() {
  if (!bizId || !identity) return;
  try {
    const now    = Date.now();
    const twoMin = 120_000;

    const bizSnap = await getDoc(doc(db, 'businesses', bizId));
    if (bizSnap.exists()) {
      const bd = bizSnap.data();
      const ls = bd.wtOwnerLastSeen?.toMillis?.() ?? 0;
      ownerIsOnline = !!(bd.wtOwnerOnline && (now - ls) < twoMin);
    }

    const snap = await getDocs(query(collection(db, 'employees'), where('bizId', '==', bizId)));
    empEmployeeList = snap.docs
      .filter(d => d.data().wtActive !== false && d.data().code !== identity?.from)
      .map(d => {
        const e  = d.data();
        const ls = e.lastSeen?.toMillis?.() ?? 0;
        return {
          empId:   d.id,
          empCode: e.code,
          name:    e.name || 'Staff',
          role:    e.role || 'Employee',
          online:  !!(e.wtOnline && (now - ls) < twoMin)
        };
      });
    renderEmpContacts();
  } catch {}
}

function renderEmpContacts() {
  const list = document.getElementById('wtContactList');
  if (!list) return;
  list.innerHTML = '';

  // Safety: if the owner somehow has themselves selected as target, reset to broadcast
  if (identity?.from === 'owner' && empSelectedTarget === 'owner') {
    empSelectedTarget = null;
  }

  const mk = (isActive, isSelected, icon, name, role, online, code) => {
    const btn = document.createElement('button');
    btn.className = 'wt-contact-item'
      + (isSelected ? ' selected' : '')
      + (isActive   ? ' activity' : '');
    btn.innerHTML = icon
      ? `<span class="wt-contact-icon">${icon}</span>
         <span class="wt-contact-info"><span class="wt-contact-name">${name}</span></span>
         ${isActive ? '<span class="wt-contact-badge">🔊</span>' : ''}`
      : `<span class="wt-contact-dot ${online ? 'online' : ''}"></span>
         <span class="wt-contact-info">
           <span class="wt-contact-name">${name}</span>
           <span class="wt-contact-role">${role}</span>
         </span>
         ${isActive ? '<span class="wt-contact-badge">🔊</span>' : ''}`;
    btn.addEventListener('click', () => selectEmpTarget(code));
    return btn;
  };

  list.appendChild(mk(false, empSelectedTarget === null, '📡', 'All Staff', '', false, null));
  // Only show "Boss" contact for employees — owner shouldn't see themselves as a send target
  if (identity?.from !== 'owner') {
    list.appendChild(mk(empLastSpeakerId === 'owner', empSelectedTarget === 'owner', null, 'Boss', 'Owner', ownerIsOnline, 'owner'));
  }
  empEmployeeList.forEach(emp =>
    list.appendChild(mk(empLastSpeakerId === emp.empCode, empSelectedTarget === emp.empCode, null, emp.name, emp.role, emp.online, emp.empCode))
  );

  updateEmpContactsToggle();
}

function selectEmpTarget(code) {
  empSelectedTarget = code;
  empContactsOpen   = false;
  document.getElementById('wtContacts')?.classList.remove('open');
  renderEmpContacts();
  if (!isRecording) updatePttHint();
}

function toggleEmpContacts() {
  empContactsOpen = !empContactsOpen;
  document.getElementById('wtContacts')?.classList.toggle('open', empContactsOpen);
}

function updateEmpContactsToggle() {
  const el = document.getElementById('wtContactsCurrent');
  if (!el) return;
  if (empSelectedTarget === null) {
    el.textContent = identity?.from === 'owner' ? '📡 Broadcast to All' : '📡 All Staff';
  } else if (empSelectedTarget === 'owner') {
    el.textContent = '👤 Boss';
  } else {
    const emp = empEmployeeList.find(e => e.empCode === empSelectedTarget);
    el.textContent = `🎯 ${emp?.name || empSelectedTarget} only`;
  }
  el.classList.toggle('has-activity', empLastSpeakerId === empSelectedTarget && empSelectedTarget !== null);
  document.getElementById('wtContacts')?.classList.toggle('open', empContactsOpen);
}

function updatePttHint() {
  if (empSelectedTarget === null) {
    $pttHint.textContent = identity?.from === 'owner'
      ? 'Hold to broadcast to all staff'
      : 'Hold to talk · Release to send';
  } else if (empSelectedTarget === 'owner') {
    $pttHint.textContent = 'Hold to reply to Boss only';
  } else {
    const emp = empEmployeeList.find(e => e.empCode === empSelectedTarget);
    $pttHint.textContent = `Hold to send to ${emp?.name || 'Staff'} only`;
  }
}

// ── Notifications ────────────────────────────────────────────
let notifGranted = false;

function requestNotifPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') { notifGranted = true; return; }
  if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(p => { notifGranted = (p === 'granted'); }).catch(() => {});
  }
}

function notifyIncoming(senderName) {
  navigator.vibrate?.([150, 50, 150]);
  if (!notifGranted) return;
  try {
    new Notification(`📻 ${senderName} is talking`, {
      body:      'Staff Radio — tap to listen',
      tag:       'wt-incoming',
      renotify:  true
    });
  } catch {}
}

// ── Push notifications (locked screen) ───────────────────────
function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    swRegistration = await navigator.serviceWorker.register('/sw.js');
  } catch {}
}

async function subscribePush() {
  if (!swRegistration || !identity?.from || !bizId) return;
  try {
    let sub = await swRegistration.pushManager.getSubscription();
    if (!sub) {
      sub = await swRegistration.pushManager.subscribe({
        userVisibleOnly:    true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }
    await setDoc(doc(db, 'wt_push_subs', `${bizId}_${identity.from}`), {
      bizId,
      identity: identity.from,
      subscription: sub.toJSON(),
      url: window.location.href,
      updatedAt: serverTimestamp()
    });
  } catch {}
}

async function sendWtPush(fromName, to) {
  try {
    let q;
    if (!to) {
      q = query(collection(db, 'wt_push_subs'), where('bizId', '==', bizId));
    } else {
      const toList = Array.isArray(to) ? to : [to];
      q = query(collection(db, 'wt_push_subs'), where('bizId', '==', bizId), where('identity', 'in', toList));
    }
    const snap = await getDocs(q);
    const items = [];
    snap.forEach(d => {
      const data = d.data();
      if (data.identity !== identity?.from && data.subscription) {
        items.push({ subscription: data.subscription, url: data.url || '/' });
      }
    });
    if (!items.length) return;
    fetch('/.netlify/functions/send-wt-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items,
        title: '📻 Staff Radio',
        body:  `${fromName} sent a voice message — tap to listen`,
        tag:   'wt-call'
      })
    }).catch(() => {});
  } catch {}
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
    // Re-activate both audio systems after returning from background.
    $wtRxAudio.play().catch(() => {});
    if (rxAudioCtx && rxAudioCtx.state === 'suspended') rxAudioCtx.resume().catch(() => {});
  }
});
