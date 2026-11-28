/* ============================================================
   EP Local Pro AI — channel.js  v1
   EP HUB Channel — Group voice communication. No login required.
   Member mode    : /channel?c=CHANNELID&m=MEMBERCODE
   Organizer mode : /channel?c=CHANNELID&o=ORGTOKEN
   ============================================================ */

import { db, storage } from '/js/firebase.js';
import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, onSnapshot,
  query, where, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

// ── URL params ───────────────────────────────────────────────
const params     = new URLSearchParams(window.location.search);
const channelId  = params.get('c');
const memberCode = params.get('m');   // member mode
const orgToken   = params.get('o');   // organizer mode

// ── Identity (set after auth) ─────────────────────────────────
let identity = null;

// ── State ────────────────────────────────────────────────────
const playedSet    = new Set();
let heartbeat      = null;
const PAGE_LOAD_MS = Date.now();

// MediaRecorder
let mediaStream = null;
let recorder    = null;
let audioChunks = [];
let isRecording = false;
let recTimer    = null;

// Audio playback queue
let audioQueue   = [];
let audioPlaying = false;
// Holds resolve() of the current drainAudioQueue Promise so recording
// can cleanly terminate active playback.
let _resolveRxAudio = null;

// PTT hold state — used so stream recovery can auto-start recording
// if the user is still pressing the button when getUserMedia resolves.
let pttHeld       = false;
let micRequesting = false;

// Persistent <audio> element for URL-based playback.
// MUST be pre-unlocked by a silent play() inside onActivate (a real user gesture)
// so iOS Safari allows async play() calls on it later.
const $chRxAudio = (() => {
  const el = document.createElement('audio');
  el.preload = 'none';
  document.body.appendChild(el);
  return el;
})();

// AudioContext — unlocked in onActivate alongside $chRxAudio.
// Its presence keeps iOS in PlayAndRecord mode so the mic is never blocked.
let rxAudioCtx    = null;
let rxAudioSource = null;

function getRxAudioCtx() {
  if (!rxAudioCtx || rxAudioCtx.state === 'closed') {
    rxAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return rxAudioCtx;
}

function stopRxAudio() {
  if (rxAudioSource) { try { rxAudioSource.stop(); } catch (_) {} rxAudioSource = null; }
  // Fully abandon $chRxAudio so iOS exits Playback mode
  $chRxAudio.pause();
  $chRxAudio.onended = null;
  $chRxAudio.onerror = null;
  $chRxAudio.src  = '';
  $chRxAudio.load();
}

// Push notifications
let swRegistration = null;
const VAPID_PUBLIC_KEY = 'BImnaD28aQfG8YdR9_PjwdlPLIfiGk4vfBfbmzo2uDOF21EEgDruZVxBUlupf2ObNL3zP5ATrlEgZDFRlhsEFxY';

// Contacts / targeting
let chSelectedTarget = null;   // null = broadcast all; 'org' = organizer; memberCode = specific member
let chLastSpeakerId  = null;
let chMemberList     = [];
let chContactsOpen   = false;
let orgIsOnline      = false;

// ── DOM ──────────────────────────────────────────────────────
const $loading    = document.getElementById('chLoading');
const $error      = document.getElementById('chError');
const $main       = document.getElementById('chMain');
const $pttBtn     = document.getElementById('chPttBtn');
const $pttHint    = document.getElementById('chPttHint');
const $audioInd   = document.getElementById('chAudioIndicator');
const $audioFrom  = document.getElementById('chAudioFrom');
const $onlineText = document.getElementById('chOnlineText');

// ── Boot ─────────────────────────────────────────────────────
init();

async function init() {
  registerSW();
  if (!channelId || (!memberCode && !orgToken)) {
    return showError('Missing Parameters', 'The link you followed is incomplete. Ask your organizer for a new link.');
  }

  try {
    const channelSnap = await getDoc(doc(db, 'hub_channels', channelId));
    if (!channelSnap.exists()) {
      return showError('Invalid Link', 'Channel not found. Ask your organizer for a new link.');
    }
    const channelData = channelSnap.data();
    const channelName = channelData.name || 'EP HUB Channel';

    if (orgToken) {
      // ── ORGANIZER MODE ───────────────────────────────────────
      if (!channelData.orgToken || channelData.orgToken !== orgToken) {
        return showError('Invalid Link', 'This organizer link is invalid or has been reset.');
      }
      identity = { from: 'org', name: channelData.orgName || 'Organizer', role: 'Channel Organizer', memberId: null };
      markOrgOnline();
      heartbeat = setInterval(markOrgOnline, 30_000);

    } else {
      // ── MEMBER MODE ──────────────────────────────────────────
      const memQ = query(
        collection(db, 'hub_members'),
        where('channelId', '==', channelId),
        where('code', '==', memberCode)
      );
      const memSnap = await getDocs(memQ);

      if (memSnap.empty) {
        return showError('Invalid Link', 'This link is no longer valid. Ask your organizer for a new one.');
      }

      const memDocSnap = memSnap.docs[0];
      const memData    = memDocSnap.data();

      if (memData.active === false) {
        return showError('Access Removed', 'Your channel access has been removed. Contact your organizer.');
      }

      identity = {
        from:     memberCode,
        name:     memData.name || 'User',
        role:     memData.role || 'Member',
        memberId: memDocSnap.id
      };

      markMemberOnline();
      heartbeat = setInterval(markMemberOnline, 30_000);
    }

    document.getElementById('chChannelName').textContent = channelName;
    document.getElementById('chRole').textContent        = identity.role;
    document.getElementById('chNameBadge').textContent   = identity.name;

    showScreen('main');
    initAttachments();

    loadOnlineList();
    setInterval(loadOnlineList, 30_000);
    loadContacts();
    setInterval(loadContacts, 30_000);
    subscribeMessages();
    wirePtt();

    document.getElementById('chContactsToggle')
      ?.addEventListener('click', toggleContacts);

  } catch (err) {
    console.error('channel init error:', err);
    showError('Connection Error', 'Failed to connect. Check your internet connection and try again.');
  }
}

// ── Presence ─────────────────────────────────────────────────
async function markMemberOnline() {
  if (!identity?.memberId) return;
  try {
    await updateDoc(doc(db, 'hub_members', identity.memberId), {
      hubOnline:   true,
      hubLastSeen: serverTimestamp()
    });
  } catch {}
}

async function markOrgOnline() {
  try {
    await updateDoc(doc(db, 'hub_channels', channelId), {
      orgOnline:   true,
      orgLastSeen: serverTimestamp()
    });
  } catch {}
}

async function loadOnlineList() {
  try {
    const now    = Date.now();
    const twoMin = 120_000;
    const names  = [];

    const channelSnap = await getDoc(doc(db, 'hub_channels', channelId));
    if (channelSnap.exists()) {
      const cd = channelSnap.data();
      const ls = cd.orgLastSeen?.toMillis?.() ?? 0;
      if (cd.orgOnline && (now - ls) < twoMin) {
        names.push(identity?.from === 'org' ? 'You (Organizer)' : 'Organizer');
      }
    }

    const memSnap = await getDocs(
      query(collection(db, 'hub_members'), where('channelId', '==', channelId))
    );
    memSnap.docs.forEach(d => {
      const m  = d.data();
      const ls = m.hubLastSeen?.toMillis?.() ?? 0;
      if (m.hubOnline && (now - ls) < twoMin) {
        names.push(m.code === memberCode ? 'You' : (m.name || 'User'));
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
    collection(db, 'hub_messages'),
    where('channelId', '==', channelId)
  );

  onSnapshot(q, snap => {
    snap.docChanges().forEach(change => {
      if (change.type !== 'added') return;
      const msgId = change.doc.id;
      const data  = change.doc.data();

      if (playedSet.has(msgId)) return;
      playedSet.add(msgId);

      const msgMs = data.createdAt?.toMillis?.() ?? Date.now();
      if (msgMs < PAGE_LOAD_MS - 5000) return;

      const isMine    = data.from === identity?.from;
      const fromLabel = isMine ? 'You' : (data.fromName || (data.from === 'org' ? 'Organizer' : 'User'));
      const msgType   = data.type || (data.audioUrl || data.audioB64 ? 'voice' : null);

      // For messages from others: apply "to" filter before showing
      if (!isMine && data.to) {
        const toList = Array.isArray(data.to) ? data.to : [data.to];
        if (!toList.includes(identity?.from)) return;
      }

      if (msgType) appendFeedMsg(fromLabel, msgType, data, isMine);

      if (isMine) return; // own messages: feed only, no audio/notify

      chLastSpeakerId = data.from;

      if (identity?.from !== 'org' && data.to) {
        chSelectedTarget = data.from;
        chContactsOpen   = true;
        document.getElementById('chContacts')?.classList.add('open');
      }

      renderContacts();
      if (!isRecording) updatePttHint();

      if (msgType === 'voice') {
        notifyIncoming(fromLabel);
        if (data.audioUrl) {
          enqueueAudio(fromLabel, data.audioUrl, null);
        } else if (data.audioB64) {
          enqueueAudio(fromLabel, null, { b64: data.audioB64, type: data.mimeType || 'audio/mp4' });
        }
      }
    });
  }, err => {
    console.error('hub_messages snapshot error:', err);
    $pttHint.textContent = '⚠️ Connection error — please refresh the page';
  });
}

function appendFeedMsg(fromLabel, type, data, isMine) {
  const $feed = document.getElementById('chFeed');
  if (!$feed) return;

  const div = document.createElement('div');
  div.className = 'ch-bubble ' + (isMine ? 'mine' : 'theirs');

  if (!isMine) {
    const nameEl = document.createElement('div');
    nameEl.className = 'ch-bubble-from';
    nameEl.textContent = fromLabel;
    div.appendChild(nameEl);
  }

  if (type === 'voice') {
    return; // voice is heard, not shown in feed
  } else if (type === 'image') {
    const img = document.createElement('img');
    img.className = 'ch-img';
    img.src = data.imageUrl;
    img.alt = 'Image';
    img.loading = 'lazy';
    img.addEventListener('click', () => window.open(data.imageUrl, '_blank'));
    div.appendChild(img);
  } else if (type === 'link') {
    const a = document.createElement('a');
    a.className = 'ch-link';
    a.href = data.linkUrl || '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = data.linkText || data.linkUrl || 'Link';
    div.appendChild(a);
  } else {
    return; // unknown type — skip
  }

  $feed.appendChild(div);
  $feed.scrollTop = $feed.scrollHeight;
}

async function sendImage(file) {
  if (!file || !identity) return;
  try {
    const ext  = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, 'jpg');
    const iRef = storageRef(storage, `hub_images/${channelId}/${Date.now()}_${identity.from}.${ext}`);
    const snap = await uploadBytes(iRef, file, { contentType: file.type || 'image/jpeg' });
    const imageUrl = await getDownloadURL(snap.ref);

    const payload = {
      channelId,
      type:        'image',
      from:        identity.from,
      fromName:    identity.name,
      imageUrl,
      storagePath: snap.ref.fullPath,
      createdAt:   serverTimestamp()
    };
    if (chSelectedTarget) payload.to = chSelectedTarget;

    await addDoc(collection(db, 'hub_messages'), payload);
    sendChPush(identity.name, payload.to ?? null);
  } catch (err) {
    console.error('sendImage error:', err);
  }
}

async function sendLink(url, text) {
  if (!url || !identity) return;
  if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
  try {
    const payload = {
      channelId,
      type:      'link',
      from:      identity.from,
      fromName:  identity.name,
      linkUrl:   url,
      linkText:  text || url,
      createdAt: serverTimestamp()
    };
    if (chSelectedTarget) payload.to = chSelectedTarget;

    await addDoc(collection(db, 'hub_messages'), payload);
    sendChPush(identity.name, payload.to ?? null);
  } catch (err) {
    console.error('sendLink error:', err);
  }
}

function initAttachments() {
  const imgInput   = document.getElementById('chImgInput');
  const linkToggle = document.getElementById('chLinkToggle');
  const linkRow    = document.getElementById('chLinkRow');
  const linkUrl    = document.getElementById('chLinkUrl');
  const linkText   = document.getElementById('chLinkText');
  const linkSend   = document.getElementById('chLinkSend');

  imgInput?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (file) sendImage(file);
    e.target.value = '';
  });

  linkToggle?.addEventListener('click', () => {
    linkRow?.classList.toggle('hidden');
    if (!linkRow?.classList.contains('hidden')) linkUrl?.focus();
  });

  linkSend?.addEventListener('click', () => {
    const url = (linkUrl?.value || '').trim();
    if (!url) return;
    sendLink(url, (linkText?.value || '').trim());
    if (linkUrl)  linkUrl.value  = '';
    if (linkText) linkText.value = '';
    linkRow?.classList.add('hidden');
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
      // Try proxy → fetch → decodeAudioData first.
      // The proxy fetches from Firebase Storage server-side (no CORS) and returns
      // the full file. decodeAudioData reads actual audio data, so Chrome-recorded
      // WebM blobs with missing duration metadata play completely instead of cutting off.
      let decoded = false;
      try {
        const proxyUrl = `/.netlify/functions/audio-proxy?url=${encodeURIComponent(audioUrl)}`;
        const resp = await fetch(proxyUrl);
        if (resp.ok) {
          const ab  = await resp.arrayBuffer();
          const buf = await ctx.decodeAudioData(ab);

          await new Promise(resolve => {
            const timeout = setTimeout(() => { _resolveRxAudio = null; resolve(); }, 60_000);
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
          decoded = true;
        }
      } catch (_) { /* fall through to <audio> */ }

      if (!decoded) {
        // Fallback: stream directly via pre-unlocked <audio> element.
        $chRxAudio.onended = null;
        $chRxAudio.onerror = null;
        $chRxAudio.src = audioUrl;

        await new Promise(resolve => {
          const timeout = setTimeout(() => { _resolveRxAudio = null; resolve(); }, 60_000);
          _resolveRxAudio = resolve;
          $chRxAudio.onended = () => {
            if (!_resolveRxAudio) return;
            _resolveRxAudio = null; clearTimeout(timeout); resolve();
          };
          $chRxAudio.onerror = () => {
            const code = $chRxAudio.error?.code ?? 0;
            if (code === 1) return;
            clearTimeout(timeout); _resolveRxAudio = null; resolve();
          };
          $chRxAudio.play().catch(() => { clearTimeout(timeout); _resolveRxAudio = null; resolve(); });
        });
      }
    }
  } catch (err) {
    console.error('[CH] playback error:', err);
  } finally {
    _resolveRxAudio = null;
    stopRxAudio();
    $audioInd?.classList.add('hidden');
    drainAudioQueue();
  }
}

// ── PTT ───────────────────────────────────────────────────────
function wirePtt() {
  if (!navigator.mediaDevices?.getUserMedia) {
    $pttBtn.disabled = true;
    $pttHint.textContent = '⚠️ Microphone not supported on this browser.';
    return;
  }

  $pttBtn.classList.add('wt-ptt-activate');
  $pttBtn.querySelector('.wt-ptt-label').textContent = 'Activate';
  $pttHint.textContent = 'Tap once to activate your channel';

  function onActivate(e) {
    e.preventDefault();
    e.stopPropagation();
    $pttBtn.classList.remove('wt-ptt-activate');
    $pttBtn.querySelector('.wt-ptt-label').textContent = 'Hold to Talk';
    $pttHint.textContent = '🎤 Allow microphone in the popup…';

    // Unlock both audio systems inside this user gesture.
    try {
      $chRxAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
      $chRxAudio.play().catch(() => {});
    } catch (_) {}
    try { getRxAudioCtx().resume().catch(() => {}); } catch (_) {}

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

  // Stop active playback before requesting mic. Fully abandoning $chRxAudio
  // (src='', load()) signals iOS to release Playback so getUserMedia gets a live mic.
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
      channelId,
      type:      'voice',
      from:      identity.from,
      fromName:  identity.name,
      mimeType,
      duration:  durationSec,
      createdAt: serverTimestamp()
    };
    if (chSelectedTarget) payload.to = chSelectedTarget;

    const ext  = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('wav') ? 'wav' : 'webm';
    const aRef = storageRef(storage, `hub_audio/${channelId}/${Date.now()}_${identity.from}.${ext}`);
    const snap  = await uploadBytes(aRef, blob, { contentType: mimeType });
    payload.audioUrl    = await getDownloadURL(snap.ref);
    payload.storagePath = snap.ref.fullPath;

    await addDoc(collection(db, 'hub_messages'), payload);
    sendChPush(identity.name, payload.to ?? null);
    updatePttHint();
    if (!audioPlaying) drainAudioQueue();

  } catch (err) {
    console.error('sendAudio error:', err);
    $pttHint.textContent = '⚠️ Send failed — check connection and try again';
  }
}

function getSupportedMimeType() {
  const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

// ── Contacts ─────────────────────────────────────────────────
async function loadContacts() {
  if (!channelId || !identity) return;
  try {
    const now    = Date.now();
    const twoMin = 120_000;

    const channelSnap = await getDoc(doc(db, 'hub_channels', channelId));
    if (channelSnap.exists()) {
      const cd = channelSnap.data();
      const ls = cd.orgLastSeen?.toMillis?.() ?? 0;
      orgIsOnline = !!(cd.orgOnline && (now - ls) < twoMin);
    }

    const snap = await getDocs(query(collection(db, 'hub_members'), where('channelId', '==', channelId)));
    chMemberList = snap.docs
      .filter(d => d.data().active !== false && d.data().code !== identity?.from)
      .map(d => {
        const m  = d.data();
        const ls = m.hubLastSeen?.toMillis?.() ?? 0;
        return {
          memberId: d.id,
          code:     m.code,
          name:     m.name || 'User',
          role:     m.role || 'Member',
          online:   !!(m.hubOnline && (now - ls) < twoMin)
        };
      });
    renderContacts();
  } catch {}
}

function renderContacts() {
  const list = document.getElementById('chContactList');
  if (!list) return;
  list.innerHTML = '';

  if (identity?.from === 'org' && chSelectedTarget === 'org') {
    chSelectedTarget = null;
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
    btn.addEventListener('click', () => selectTarget(code));
    return btn;
  };

  list.appendChild(mk(false, chSelectedTarget === null, '📡', 'All Users', '', false, null));
  if (identity?.from !== 'org') {
    list.appendChild(mk(
      chLastSpeakerId === 'org',
      chSelectedTarget === 'org',
      null, 'Organizer', 'Channel Organizer', orgIsOnline, 'org'
    ));
  }
  chMemberList.forEach(m =>
    list.appendChild(mk(chLastSpeakerId === m.code, chSelectedTarget === m.code, null, m.name, m.role, m.online, m.code))
  );

  updateContactsToggle();
}

function selectTarget(code) {
  chSelectedTarget = code;
  chContactsOpen   = false;
  document.getElementById('chContacts')?.classList.remove('open');
  renderContacts();
  if (!isRecording) updatePttHint();
}

function toggleContacts() {
  chContactsOpen = !chContactsOpen;
  document.getElementById('chContacts')?.classList.toggle('open', chContactsOpen);
}

function updateContactsToggle() {
  const el = document.getElementById('chContactsCurrent');
  if (!el) return;
  if (chSelectedTarget === null) {
    el.textContent = identity?.from === 'org' ? '📡 Broadcast to All' : '📡 All Users';
  } else if (chSelectedTarget === 'org') {
    el.textContent = '👤 Organizer';
  } else {
    const mem = chMemberList.find(m => m.code === chSelectedTarget);
    el.textContent = `🎯 ${mem?.name || chSelectedTarget} only`;
  }
  el.classList.toggle('has-activity', chLastSpeakerId === chSelectedTarget && chSelectedTarget !== null);
  document.getElementById('chContacts')?.classList.toggle('open', chContactsOpen);
}

function updatePttHint() {
  if (chSelectedTarget === null) {
    $pttHint.textContent = identity?.from === 'org'
      ? 'Hold to broadcast to all users'
      : 'Hold to talk · Release to send';
  } else if (chSelectedTarget === 'org') {
    $pttHint.textContent = 'Hold to reply to Organizer only';
  } else {
    const mem = chMemberList.find(m => m.code === chSelectedTarget);
    $pttHint.textContent = `Hold to send to ${mem?.name || 'User'} only`;
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
    new Notification(`📡 ${senderName} is talking`, {
      body:     'EP HUB Channel — tap to listen',
      tag:      'ch-incoming',
      renotify: true
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
  if (!swRegistration || !identity?.from || !channelId) return;
  try {
    let sub = await swRegistration.pushManager.getSubscription();
    if (!sub) {
      sub = await swRegistration.pushManager.subscribe({
        userVisibleOnly:    true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }
    await setDoc(doc(db, 'hub_push_subs', `${channelId}_${identity.from}`), {
      channelId,
      identity: identity.from,
      subscription: sub.toJSON(),
      url:       window.location.href,
      updatedAt: serverTimestamp()
    });
  } catch {}
}

async function sendChPush(fromName, to) {
  try {
    let q;
    if (!to) {
      q = query(collection(db, 'hub_push_subs'), where('channelId', '==', channelId));
    } else {
      const toList = Array.isArray(to) ? to : [to];
      q = query(collection(db, 'hub_push_subs'), where('channelId', '==', channelId), where('identity', 'in', toList));
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
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        items,
        title: '📡 EP HUB Channel',
        body:  `${fromName} sent a voice message — tap to listen`,
        tag:   'ch-call'
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
  document.getElementById('chErrorTitle').textContent = title;
  document.getElementById('chErrorMsg').textContent   = msg;
  showScreen('error');
}

// ── Presence cleanup on page hide ────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInterval(heartbeat);
    if (identity?.memberId) {
      updateDoc(doc(db, 'hub_members', identity.memberId), { hubOnline: false }).catch(() => {});
    }
    if (identity?.from === 'org') {
      updateDoc(doc(db, 'hub_channels', channelId), { orgOnline: false }).catch(() => {});
    }
  } else {
    if (identity?.memberId) markMemberOnline();
    if (identity?.from === 'org') markOrgOnline();
    heartbeat = setInterval(
      identity?.from === 'org' ? markOrgOnline : markMemberOnline,
      30_000
    );
    // Re-activate both audio systems after returning from background
    $chRxAudio.play().catch(() => {});
    if (rxAudioCtx && rxAudioCtx.state === 'suspended') rxAudioCtx.resume().catch(() => {});
  }
});
