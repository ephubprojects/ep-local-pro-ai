import { db } from '/js/firebase.js';
import {
  doc, getDoc, collection, addDoc, getDocs,
  query, where, orderBy, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const DAYS_EN   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DAYS_ES   = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
const MONTHS_EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const DAY_KEYS  = ['sun','mon','tue','wed','thu','fri','sat'];

const p      = new URLSearchParams(location.search);
const bizIdx = parseInt(p.get('biz') || '0', 10);

let bizData      = null;
let currentYear  = new Date().getFullYear();
let currentMonth = new Date().getMonth();
let selectedDate = null;
let selectedSlot = null;
let takenSlots   = [];
let lang         = 'en';
let chatMessages = [];

// ── Boot ──────────────────────────────────────────────────
(async () => {
  const urlLang = (p.get('lang') || navigator.language || 'en').toLowerCase();
  lang = urlLang.startsWith('es') ? 'es' : 'en';

  applyLangLabels();
  setLangBtns();

  try {
    const snap = await getDoc(doc(db, 'config', 'calendar'));
    if (!snap.exists()) { showError('Calendar not configured yet.'); return; }

    const cfg        = snap.data();
    const businesses = cfg.businesses || [];
    bizData          = businesses[bizIdx] ?? businesses[0];

    if (!bizData || bizData.active === false) {
      showError('This calendar is not currently available.');
      return;
    }

    setText('cal-biz-name', bizData.name || 'Book an Appointment');
    setText('cal-biz-desc', bizData.description || '');

    await loadTakenSlots();
    renderCalendar();

    document.getElementById('cal-loading').style.display = 'none';
    document.getElementById('cal-main').classList.remove('hidden');
  } catch (e) {
    console.error('calendar init error:', e);
    showError(e.message || 'Failed to load calendar.');
  }
})();

function showError(msg) {
  document.getElementById('cal-loading').style.display = 'none';
  setText('cal-error-msg', msg);
  document.getElementById('cal-error').classList.remove('hidden');
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ── Load taken slots for current month ───────────────────
async function loadTakenSlots() {
  takenSlots = [];
  try {
    const monthStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`;
    const snap = await getDocs(query(
      collection(db, 'bookings'),
      where('bizIndex', '==', bizIdx),
      where('status', 'in', ['pending', 'confirmed'])
    ));
    takenSlots = snap.docs
      .map(d => d.data())
      .filter(d => d.date && d.date.startsWith(monthStr));
  } catch (e) {
    console.warn('loadTakenSlots error:', e);
  }
}

// ── Calendar render ───────────────────────────────────────
function renderCalendar() {
  const days   = lang === 'es' ? DAYS_ES   : DAYS_EN;
  const months = lang === 'es' ? MONTHS_ES : MONTHS_EN;

  setText('calMonthLabel', `${months[currentMonth]} ${currentYear}`);

  const headEl = document.getElementById('calGridHead');
  headEl.innerHTML = days.map(d => `<span>${d}</span>`).join('');

  const grid  = document.getElementById('calGrid');
  const today = new Date(); today.setHours(0,0,0,0);

  const firstDay    = new Date(currentYear, currentMonth, 1).getDay();
  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();

  let html = '';
  for (let i = 0; i < firstDay; i++) html += `<div class="cal-day empty"></div>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const date    = new Date(currentYear, currentMonth, d);
    const dateStr = formatDate(currentYear, currentMonth + 1, d);
    const isPast  = date < today;
    const isToday = date.getTime() === today.getTime();
    const dowKey  = DAY_KEYS[date.getDay()];
    const avail   = bizData.availability || {};
    const hasAvail = !!(avail[dowKey] && avail[dowKey].length === 2);
    const slots   = (hasAvail && !isPast) ? computeSlots(avail[dowKey]) : [];
    const taken   = takenSlots.filter(s => s.date === dateStr);
    const hasOpen = slots.length > taken.length;
    const full    = slots.length > 0 && slots.length <= taken.length;
    const isSelected = dateStr === selectedDate;

    let cls = 'cal-day';
    if (isPast || !hasAvail) {
      cls += isPast ? ' past' : ' unavail';
    } else if (full) {
      cls += ' full';
    } else {
      cls += ' avail';
      if (hasOpen) cls += ' has-slots';
    }
    if (isToday)    cls += ' today';
    if (isSelected) cls += ' selected';

    const clickable = hasAvail && !isPast && !full;
    html += `<div class="${cls}"${clickable ? ` onclick="selectDate('${dateStr}')"` : ''}>${d}</div>`;
  }

  grid.innerHTML = html;
}

function computeSlots(avRange) {
  if (!avRange || avRange.length < 2) return [];
  const [sh, sm] = avRange[0].split(':').map(Number);
  const [eh, em] = avRange[1].split(':').map(Number);
  const duration = bizData.slotDuration || 30;
  const slots = [];
  let cur = sh * 60 + sm;
  const end = eh * 60 + em;
  while (cur + duration <= end) {
    slots.push(`${String(Math.floor(cur/60)).padStart(2,'0')}:${String(cur%60).padStart(2,'0')}`);
    cur += duration;
  }
  return slots;
}

function formatDate(y, m, d) {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function formatTime12(t) {
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${ampm}`;
}

// ── Date selection ────────────────────────────────────────
window.selectDate = function(dateStr) {
  selectedDate = dateStr;
  selectedSlot = null;
  renderCalendar();
  showSlots(dateStr);
};

function showSlots(dateStr) {
  const avail  = bizData.availability || {};
  const date   = new Date(dateStr + 'T12:00:00');
  const dowKey = DAY_KEYS[date.getDay()];
  const avRange = avail[dowKey];
  const slots  = avRange ? computeSlots(avRange) : [];
  const taken  = takenSlots.filter(s => s.date === dateStr).map(s => s.time);

  const months = lang === 'es' ? MONTHS_ES : MONTHS_EN;
  const [y, mo, d] = dateStr.split('-').map(Number);
  setText('slotDateLabel', `${months[mo - 1]} ${d}, ${y}`);

  const grid = document.getElementById('slotsGrid');
  if (!slots.length) {
    grid.innerHTML = `<p style="color:#94a3b8;font-size:13px;grid-column:span 2;">${lang === 'es' ? 'No hay horarios disponibles este día.' : 'No available slots on this day.'}</p>`;
  } else {
    grid.innerHTML = slots.map(t => {
      const isTaken = taken.includes(t);
      return `<button class="slot-btn${isTaken ? ' taken' : ''}" ${isTaken ? 'disabled' : `onclick="selectSlot('${t}')"`}>${formatTime12(t)}</button>`;
    }).join('');
  }

  hideRight();
  document.getElementById('slotsView').classList.remove('hidden');
}

// ── Slot selection ────────────────────────────────────────
window.selectSlot = function(time) {
  selectedSlot = time;
  const months = lang === 'es' ? MONTHS_ES : MONTHS_EN;
  const [y, mo, d] = selectedDate.split('-').map(Number);
  setText('formDateLabel', `${months[mo - 1]} ${d}, ${y} · ${formatTime12(time)}`);
  hideRight();
  document.getElementById('bookingForm').classList.remove('hidden');
};

window.backToSlots = function() {
  if (selectedDate) showSlots(selectedDate);
};

// ── Booking submission ────────────────────────────────────
window.submitBooking = async function() {
  const name   = document.getElementById('bfName').value.trim();
  const phone  = document.getElementById('bfPhone').value.trim();
  const email  = document.getElementById('bfEmail').value.trim();
  const reason = document.getElementById('bfReason').value.trim();

  if (!name)  { alert(lang === 'es' ? 'Por favor ingresa tu nombre.'   : 'Please enter your name.'); return; }
  if (!phone) { alert(lang === 'es' ? 'Por favor ingresa tu teléfono.' : 'Please enter your phone number.'); return; }

  const btn = document.getElementById('submitBookingBtn');
  btn.disabled = true;
  setText('submitBtnLabel', lang === 'es' ? 'Guardando…' : 'Saving…');

  try {
    await addDoc(collection(db, 'bookings'), {
      clientName:  name,
      clientPhone: phone,
      clientEmail: email  || '',
      reason:      reason || '',
      date:        selectedDate,
      time:        selectedSlot,
      bizIndex:    bizIdx,
      status:      'pending',
      source:      'web',
      bizName:     bizData.name || '',
      createdAt:   serverTimestamp()
    });

    const months = lang === 'es' ? MONTHS_ES : MONTHS_EN;
    const [y, mo, d] = selectedDate.split('-').map(Number);
    const dateLabel  = `${months[mo - 1]} ${d}, ${y}`;

    setText('confirmTitle', lang === 'es' ? '¡Cita Confirmada!' : 'Appointment Confirmed!');
    setText('confirmDetail',
      lang === 'es'
        ? `${name}, tu cita es el ${dateLabel} a las ${formatTime12(selectedSlot)}.`
        : `${name}, your appointment is on ${dateLabel} at ${formatTime12(selectedSlot)}.`
    );

    hideRight();
    document.getElementById('bookingConfirm').classList.remove('hidden');

    takenSlots.push({ date: selectedDate, time: selectedSlot, bizIndex: bizIdx, status: 'pending' });
    renderCalendar();
  } catch (e) {
    alert(lang === 'es' ? 'Error al guardar la cita: ' + e.message : 'Error saving appointment: ' + e.message);
  } finally {
    btn.disabled = false;
    setText('submitBtnLabel', lang === 'es' ? 'Confirmar Cita' : 'Confirm Appointment');
  }
};

window.resetBooking = function() {
  selectedDate = null;
  selectedSlot = null;
  ['bfName','bfPhone','bfEmail','bfReason'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  hideRight();
  document.getElementById('calPlaceholder').classList.remove('hidden');
  renderCalendar();
};

function hideRight() {
  ['slotsView','bookingForm','bookingConfirm','calPlaceholder'].forEach(id =>
    document.getElementById(id).classList.add('hidden')
  );
}

// ── Month navigation ──────────────────────────────────────
window.navMonth = async function(dir) {
  currentMonth += dir;
  if (currentMonth < 0)  { currentMonth = 11; currentYear--; }
  if (currentMonth > 11) { currentMonth = 0;  currentYear++; }
  selectedDate = null;
  selectedSlot = null;
  await loadTakenSlots();
  renderCalendar();
  hideRight();
  document.getElementById('calPlaceholder').classList.remove('hidden');
};

// ── Language ──────────────────────────────────────────────
window.setCalLang = function(l) {
  lang = l;
  setLangBtns();
  applyLangLabels();
  renderCalendar();
  if (selectedDate) showSlots(selectedDate);
};

function setLangBtns() {
  document.getElementById('clbEn').classList.toggle('on', lang === 'en');
  document.getElementById('clbEs').classList.toggle('on', lang === 'es');
}

function applyLangLabels() {
  const es = lang === 'es';
  const s = (id, en, esStr) => setText(id, es ? esStr : en);
  s('lbl-avail',         'Available',             'Disponible');
  s('lbl-taken',         'Fully booked',          'Lleno');
  s('lbl-name',          'Full Name *',           'Nombre Completo *');
  s('lbl-phone',         'Phone *',               'Teléfono *');
  s('lbl-email',         'Email',                 'Correo Electrónico');
  s('lbl-reason',        'Reason / Notes',        'Motivo / Notas');
  s('submitBtnLabel',    'Confirm Appointment',   'Confirmar Cita');
  s('backToSlotsBtn',    '← Back to time slots',  '← Volver a horarios');
  s('bookAnotherBtn',    'Book another',          'Agendar otra cita');
  s('cal-placeholder-txt', 'Select a date to see available time slots',
                            'Selecciona una fecha para ver los horarios disponibles');
  s('chatHeaderTitle',   'AI Booking Assistant',  'Asistente de Reservas IA');
  const fab = document.getElementById('calChatFab');
  if (fab) fab.title = es ? 'Agendar con asistente IA' : 'Book with AI assistant';
}

// ── AI Chat ───────────────────────────────────────────────
window.toggleChat = function() {
  const panel = document.getElementById('calChatPanel');
  const isOpen = panel.classList.toggle('open');
  if (isOpen && chatMessages.length === 0) {
    addChatBubble('ai', lang === 'es'
      ? '¡Hola! Soy tu asistente de reservas. ¿Te gustaría agendar una cita?'
      : "Hi! I'm your booking assistant. Would you like to schedule an appointment?");
  }
};

window.sendChatMsg = async function() {
  const input = document.getElementById('chatInput');
  const text  = input.value.trim();
  if (!text) return;
  input.value = '';

  addChatBubble('user', text);
  chatMessages.push({ role: 'user', content: text });

  const typingId = addChatBubble('ai', '…', true);

  try {
    const taken = takenSlots.map(s => ({ date: s.date, time: s.time }));
    const res   = await fetch('/.netlify/functions/calendar-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages:   chatMessages,
        bizContext: {
          name:         bizData.name        || '',
          description:  bizData.description || '',
          availability: bizData.availability || {},
          slotDuration: bizData.slotDuration || 30,
        },
        takenSlots: taken,
        lang: lang === 'es' ? 'es-MX' : 'en'
      })
    });
    const data = await res.json();
    removeChatBubble(typingId);

    const reply    = data.reply || (lang === 'es' ? 'Lo siento, no pude responder.' : 'Sorry, could not respond.');
    const cleanMsg = reply.replace(/BOOKING_DATA:\{[^}]+\}/, '').trim();
    addChatBubble('ai', cleanMsg);
    chatMessages.push({ role: 'assistant', content: cleanMsg });

    const match = reply.match(/BOOKING_DATA:(\{[^}]+\})/);
    if (match) {
      try {
        const bd = JSON.parse(match[1]);
        await addDoc(collection(db, 'bookings'), {
          clientName:  bd.clientName  || '',
          clientPhone: bd.clientPhone || '',
          clientEmail: bd.clientEmail || '',
          reason:      bd.notes       || 'Booked via AI Chat',
          date:        bd.date        || '',
          time:        bd.time        || '',
          bizIndex:    bizIdx,
          status:      'pending',
          source:      'ai_chat',
          bizName:     bizData.name || '',
          createdAt:   serverTimestamp()
        });
        if (bd.date && bd.time) {
          takenSlots.push({ date: bd.date, time: bd.time, bizIndex: bizIdx, status: 'pending' });
          renderCalendar();
        }
      } catch (e) { console.warn('AI booking save error:', e); }
    }
  } catch (e) {
    removeChatBubble(typingId);
    addChatBubble('ai', lang === 'es' ? 'Error de conexión. Intenta de nuevo.' : 'Connection error. Please try again.');
  }
};

let _cid = 0;
function addChatBubble(role, text, isTyping = false) {
  const id  = 'cb-' + (++_cid);
  const box = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.id        = id;
  div.className = `chat-bubble ${role}${isTyping ? ' typing' : ''}`;
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return id;
}

function removeChatBubble(id) {
  document.getElementById(id)?.remove();
}
