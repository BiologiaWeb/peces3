// ═══════════════════════════════════════════════════════
//  FCB — app.js · Facultad de Ciencias Biológicas
//  Roles: admin · supervisor · operador
// ═══════════════════════════════════════════════════════

import { initializeApp }  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore,
  collection, addDoc, getDocs,
  query, orderBy, limit, where,
  doc, setDoc, updateDoc, getDoc, deleteDoc,
  serverTimestamp, increment
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Firebase ───────────────────────────────────────────
// Firebase config — la API key de cliente es pública por diseño de Firebase.
// La seguridad real se configura en Firebase Security Rules (servidor).
const _k = ['AIzaSyBkawcfBFAugbhfs6R3lDuyDmhlhx832N8','peces-3fa4d.firebaseapp.com',
            'peces-3fa4d','peces-3fa4d.firebasestorage.app','1053419003639',
            '1:1053419003639:web:ab162a748a2f187ad27df2'];
const db = getFirestore(initializeApp({
  apiKey:_k[0], authDomain:_k[1], projectId:_k[2],
  storageBucket:_k[3], messagingSenderId:_k[4], appId:_k[5]
}));

// ══════════════════════════════════════════════════════
//  ESTADO  (privado — no expuesto en window)
// ══════════════════════════════════════════════════════
// ── Estado (PRIVADO — no expuesto en window) ───────────
let _session        = null;
let _pondsCache     = [];
let _fishCache      = [];
let _currentLogRows = [];
let _supervisors    = [];
let _detPondId = null, _detPondName = null;  // estanque abierto en modal
let _detFishId = null;                       // fauna abierta en modal

// ══════════════════════════════════════════════════════
//  HELPERS  DOM  /  Utilidades
// ══════════════════════════════════════════════════════
// ── Helpers DOM
const $     = id  => document.getElementById(id);
const $$    = sel => document.querySelectorAll(sel);
const $show = (id, v) => { const el = $(id); if (el) el.style.display = v ? '' : 'none'; };
const _open = id  => $(id)?.classList.add('open');
const _today   = () => new Date().toISOString().slice(0, 10);
const _daysAgo = n => { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); };

// ══════════════════════════════════════════════════════
//  ROLES  Y  PERMISOS
// ══════════════════════════════════════════════════════
// ── Roles ──────────────────────────────────────────────
const isAdmin      = () => _session?.role === 'admin';
const isSupervisor = () => _session?.role === 'supervisor';
const isOperator   = () => _session?.role === 'operador';
const canManage    = () => isAdmin() || isSupervisor();
const canEditPond  = () => canManage() && !isMortArea();  // mortalidad no edita estanques
const canDoActions = () => canManage() && !isMortArea();  // mortalidad no registra acciones (excepto mortalidad)
// Supervisor de mortalidad: ve todo pero SOLO él puede registrar mortalidad
const isMortSup    = () => isSupervisor() && _session?.areaId === 'mortalidad';
const isMortOp     = () => isOperator()   && _session?.areaId === 'mortalidad';
const isMortArea   = () => isMortSup() || isMortOp();  // cualquier usuario de mortalidad
// Área del usuario actual
const myArea       = () => _session?.areaId || null;

// Etiqueta y color por área
const AREAS = {
  conservacion: { label: 'Conservación', color: '#0e7490' },
  urin:         { label: 'URIN',         color: '#7c3aed' },
  mortalidad:   { label: 'Mortalidad',   color: '#b91c1c' },
};
const _name        = () => _session?.name     || 'Usuario';
const _user        = () => _session?.username || '?';

function _contextSup() {
  if (isAdmin())      return null;
  if (isSupervisor()) return _session.uid;
  return _session?.supervisorId || null;
}

function _scope(items) {
  if (isAdmin())    return items;
  if (isMortArea()) return items;  // mortalidad ve todo

  const area = myArea();

  if (isSupervisor()) {
    // Supervisor: ve todo lo de su área
    return area ? items.filter(i => i.areaId === area) : [];
  }

  // Operador: siempre filtra por supervisorId (su jefe directo)
  // Si además tiene área, esa área ya fue asignada al crear/reasignar
  const sup = _session?.supervisorId || null;
  if (sup)  return items.filter(i => i.supervisorId === sup);
  if (area) return items.filter(i => i.areaId === area);  // fallback: sin sup, usa área
  return [];
}

// ══════════════════════════════════════════════════════
//  AUTH  /  SESIÓN  /  INIT
// ══════════════════════════════════════════════════════
// ── Crypto: SHA-256 ────────────────────────────────────
async function _hash(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Sesión (localStorage, sin datos sensibles) ─────────
// Solo se guarda uid, username, name, role, supervisorId
// La contraseña NUNCA llega al cliente en claro
function _saveSession(d) {
  _session = d;
  const safe = { uid: d.uid, username: d.username, name: d.name, role: d.role, areaId: d.areaId || null, supervisorId: d.supervisorId || null };
  try { localStorage.setItem('_s', JSON.stringify(safe)); } catch {}
}
function _clearSession() {
  _session = null;
  try { localStorage.removeItem('_s'); } catch {}
}
function _loadSession() {
  try { const r = localStorage.getItem('_s'); return r ? JSON.parse(r) : null; } catch { return null; }
}

// ── Init ───────────────────────────────────────────────
async function _init() {
  await _ensureAdmin();
  const saved = _loadSession();
  if (saved?.uid) {
    try {
      const snap = await getDoc(doc(db, 'users', saved.uid));
      if (snap.exists()) {
        const ud = snap.data();
        // Refrescar desde Firestore (detecta cambios de rol/supervisor)
        _saveSession({ uid: saved.uid, username: ud.username, name: ud.name, role: ud.role, areaId: ud.areaId || null, supervisorId: ud.supervisorId || null });
        _enterApp();
        return;
      }
    } catch { /* sin conexión — usar sesión guardada */ }
  }
  _showLogin();
}

async function _ensureAdmin() {
  try {
    const snap = await getDocs(query(collection(db, 'users'), limit(1)));
    if (!snap.empty) return;
    await setDoc(doc(db, 'users', 'administrador'), {
      username: 'administrador', name: 'Administrador',
      role: 'admin', password: await _hash('Administrador$26'),
      createdAt: serverTimestamp()
    });
  } catch {}
}

// ── Login / Logout ─────────────────────────────────────
window.doLogin = async () => {
  const u    = $('login-user').value.trim().toLowerCase();
  const p    = $('login-pass').value;
  const btn  = document.querySelector('#auth-screen .btn-primary');
  const errEl = $('login-error');

  const _showErr = msg => {
    _toast(msg, 'err');
    if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
    if (btn)   { btn.textContent = 'Ingresar'; btn.disabled = false; }
  };

  if (!u || !p) { _showErr('Completa usuario y contraseña'); return; }
  if (btn)   { btn.textContent = 'Verificando…'; btn.disabled = true; }
  if (errEl) { errEl.style.display = 'none'; }

  try {
    const snap = await getDocs(query(collection(db, 'users'), where('username', '==', u)));
    if (snap.empty) { _showErr('Usuario no encontrado'); return; }
    const d  = snap.docs[0];
    const ud = d.data();
    if ((await _hash(p)) !== ud.password) { _showErr('Contraseña incorrecta'); return; }
    if (btn) { btn.textContent = 'Entrando…'; }
    _saveSession({ uid: d.id, username: ud.username, name: ud.name, role: ud.role, areaId: ud.areaId || null, supervisorId: ud.supervisorId || null });
    try {
      await _enterApp();
    } catch (appErr) {
      console.error('_enterApp error:', appErr);
      _showErr('Error al cargar la app. Recarga la página.');
    }
  } catch (e) {
    console.error('Login error:', e);
    _showErr('Error de conexión con Firebase');
  }
};

window.doLogout = () => { _clearSession(); _showLogin(); };

// ── Pantallas ──────────────────────────────────────────
function _showLogin() {
  $('login-user').value = '';
  $('login-pass').value = '';
  $('auth-screen').style.display = 'flex';
  $('app-screen').style.display  = 'none';
}

async function _enterApp() {
  // Helper seguro: nunca crashea si el elemento no existe en el HTML
  const $  = id => document.getElementById(id);
  const $$ = sel => document.querySelectorAll(sel);

  $('auth-screen').style.display = 'none';
  $('app-screen').style.display  = 'block';
  $('user-avatar').textContent      = _session.name.slice(0, 2).toUpperCase();
  $('user-name-header').textContent = _session.name;

  // Badge de área en el header
  const badge = $('header-area-badge');
  if (badge) {
    const aInfo = AREAS[_session?.areaId];
    if (aInfo) {
      badge.textContent = aInfo.label;
      badge.style.cssText = `display:inline-block;font-size:.65rem;font-weight:700;padding:.12rem .5rem;border-radius:99px;letter-spacing:.05em;text-transform:uppercase;background:${aInfo.color}18;color:${aInfo.color};border:1px solid ${aInfo.color}40;margin-left:.4rem`;
    } else {
      badge.style.display = 'none';
    }
  }

  if ($('tab-users')) $('tab-users').style.display = isAdmin()   ? 'block' : 'none';
  if ($('tab-exps'))   $('tab-exps').style.display   = (isMortArea() || isAdmin()) ? 'block' : 'none';
  if ($('tab-params')) $('tab-params').style.display = (isMortArea() || isAdmin()) ? 'block' : 'none';
  if ($('btn-gestionar-areas')) $('btn-gestionar-areas').style.display = (isMortSup() || isAdmin()) ? '' : 'none';

  if ($('pond-admin-btns')) $('pond-admin-btns').style.display = canEditPond() ? 'flex' : 'none';
  if ($('fish-admin-btns')) $('fish-admin-btns').style.display = canEditPond() ? 'flex' : 'none';

  // isMortSup ve la opción 'mortalidad' pero no las otras acciones de supervisión
  $$('.action-sup-only').forEach(o => { o.style.display = canDoActions() ? '' : 'none'; });
  $$('.log-filter-sup-only').forEach(o => { o.style.display = canManage() ? '' : 'none'; });
  $$('.admin-only-role').forEach(o   => { o.style.display = isAdmin()    ? '' : 'none'; });

  await _loadSupervisors();
  if (canManage()) await _loadUsersFilter();
  await _loadPonds();
  // Cargar config de áreas/piletas si es mortalidad o admin
  if (isMortArea() || isAdmin()) _loadParamAreasConfig();
  // Fechas por defecto: bitácora y parámetros
  const _setDates = (f, t) => { if ($(f) && !$(f).value) $(f).value = _daysAgo(5); if ($(t) && !$(t).value) $(t).value = _today(); };
  _setDates('filter-date-from', 'filter-date-to');
  _setDates('param-filter-from', 'param-filter-to');
}

// ── Navegación ─────────────────────────────────────────
window.switchTab = (e, tab) => {
  $$('.tab').forEach(t => t.classList.remove('active'));
  $$('.page').forEach(p => p.classList.remove('active'));
  e.currentTarget.classList.add('active');
  document.getElementById('page-' + tab).classList.add('active');
  if (tab === 'log') {
    // Poner fechas por defecto: desde hace 5 días hasta hoy (inclusive)
    const todayStr = new Date().toISOString().slice(0, 10);
    const fromEl   = $('filter-date-from');
    const toEl     = $('filter-date-to');
    if (fromEl && !fromEl.value) {
      const d5 = new Date(); d5.setDate(d5.getDate() - 5);
      fromEl.value = d5.toISOString().slice(0, 10);
    }
    if (toEl && !toEl.value) toEl.value = todayStr;
    _loadLog();
    // Auto-actualizar cada 30 segundos mientras la tab esté activa
    clearInterval(window._logInterval);
    window._logInterval = setInterval(() => {
      if ($('page-log')?.classList.contains('active')) _loadLog();
      else clearInterval(window._logInterval);
    }, 30000);
  }
  if (tab === 'fish')  _loadFish();
  if (tab === 'users') _loadUsers();
  if (tab === 'exps')   _loadExps();
  if (tab === 'params') _loadParams();
};

// ── Helpers UI ─────────────────────────────────────────
window.closeModal = id => document.getElementById(id)?.classList.remove('open');

function _toast(msg, type = 'ok') {
  const t = $('toast');
  t.textContent = msg; t.className = `show toast-${type}`;
  clearTimeout(t._tid); t._tid = setTimeout(() => { t.className = ''; }, 2800);
}
// Exponer solo para uso desde HTML onclick en botones de acción (necesario)
window.showToast = _toast;

function _fmt(ts) {
  const d = ts?.toDate?.() ?? new Date(ts);
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function _tagClass(action) {
  return ({
    'alimentación': 'tag-feed', 'limpieza': 'tag-clean', 'tratamiento': 'tag-treatment',
    'medicamento':  'tag-treatment', 'cambio de agua': 'tag-water', 'medición': 'tag-measure',
    'mortalidad': 'tag-mortality', 'nacimiento': 'tag-birth', 'introducción': 'tag-intro',
  })[action] || 'tag-other';
}

function _catBadge(f) {
  const out = [];
  if (f.alevines)  out.push(`<span class="cat-badge cat-alevin">A:${f.alevines}</span>`);
  if (f.juveniles) out.push(`<span class="cat-badge cat-juvenil">J:${f.juveniles}</span>`);
  if (f.adultos)   out.push(`<span class="cat-badge cat-adulto">Ad:${f.adultos}</span>`);
  return out.join('');
}

function _total(f) { return (f.alevines || 0) + (f.juveniles || 0) + (f.adultos || 0); }

// ── Selects ────────────────────────────────────────────
async function _loadSupervisors() {
  try {
    const snap = await getDocs(query(collection(db, 'users'), where('role', '==', 'supervisor')));
    _supervisors = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
  } catch { _supervisors = []; }
}

function _fillSupSelect(id, allowEmpty = true) {
  const sel = document.getElementById(id);
  if (!sel) return;
  sel.innerHTML = (allowEmpty ? '<option value="">— Sin asignar —</option>' : '') +
    _supervisors.map(s => `<option value="${s.uid}">@${s.username} — ${s.name}</option>`).join('');
}

function _fillPondSelects(ids) {
  (ids || ['action-pond', 'create-fish-pond', 'add-units-pond', 'filter-pond', 'filter-fish-pond']).forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = (id.startsWith('filter') ? '<option value="">Todos los estanques</option>' : '<option value="">— Selecciona —</option>') +
      _pondsCache.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
  });
}

function _fillFishSelect(id, pondId) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const items = pondId ? _fishCache.filter(f => f.pondId === pondId) : [];
  sel.innerHTML = items.length
    ? '<option value="">— Selecciona especie —</option>' + items.map(f => `<option value="${f.id}">${f.name}</option>`).join('')
    : '<option value="">Sin especies en este estanque</option>';
}

// ══════════════════════════════════════════════════════
//  USUARIOS
// ══════════════════════════════════════════════════════
window.openAddUser = () => {
  ['new-user-name', 'new-user-username', 'new-user-pass'].forEach(id => document.getElementById(id).value = '');
  $('new-user-role').value = 'operador';
  $('new-user-role-group').style.display = isSupervisor() ? 'none' : 'block';
  onNewUserRoleChange();
  $('add-user-modal-title').textContent = 'Nuevo Usuario';
  _open('modal-add-user');
};

window.onNewUserRoleChange = () => {
  const role = $('new-user-role').value;
  const hint = { operador: 'Ve solo su bitácora; acciones básicas.', supervisor: 'Gestiona sus estanques y fauna.', admin: 'Acceso total.' };
  $('new-user-role-hint').textContent = hint[role] || '';
  const areaGrp = $('new-user-area-group');
  if (areaGrp) areaGrp.style.display = (role === 'supervisor' || (isAdmin() && role === 'operador')) ? 'block' : 'none';
  const showSup = isAdmin() && role === 'operador';
  $('new-user-supervisor-group').style.display = showSup ? 'block' : 'none';
  if (showSup) _fillSupSelectByArea();  // filtra por área seleccionada
};

// Llena el select de supervisores filtrando por área si está seleccionada
function _fillSupSelectByArea() {
  const areaId = $('new-user-area')?.value || '';
  const sel    = $('new-user-supervisor');
  if (!sel) return;
  const sups = areaId
    ? _supervisors.filter(s => s.areaId === areaId)
    : _supervisors;
  sel.innerHTML = '<option value="">— Sin asignar —</option>' +
    sups.map(s => `<option value="${s.uid}">@${s.username} — ${s.name}${s.areaId ? ' (' + (AREAS[s.areaId]?.label || s.areaId) + ')' : ''}</option>`).join('');
}

// Cuando cambia el área en el modal de usuario, actualizar lista de supervisores
window.onNewUserAreaChange = () => {
  const role = $('new-user-role').value;
  if (isAdmin() && role === 'operador') _fillSupSelectByArea();
};

window.saveUser = async () => {
  const name  = $('new-user-name').value.trim();
  const uname = $('new-user-username').value.trim().toLowerCase();
  const pass  = $('new-user-pass').value;
  const role  = isSupervisor() ? 'operador' : $('new-user-role').value;
  if (!name || !uname || !pass)         { _toast('Completa todos los campos', 'err'); return; }
  if (pass.length < 6)                  { _toast('Contraseña mínimo 6 caracteres', 'err'); return; }
  if (!/^[a-z0-9_]+$/.test(uname))     { _toast('Usuario: solo letras minúsculas, números y _', 'err'); return; }
  const dup = await getDocs(query(collection(db, 'users'), where('username', '==', uname)));
  if (!dup.empty)                       { _toast('Ese nombre de usuario ya existe', 'err'); return; }
  let supervisorId = null;
  if (role === 'operador') supervisorId = isSupervisor() ? _session.uid : ($('new-user-supervisor').value || null);
  try {
    // areaId: explícito si es supervisor; heredado del supervisor si es operador
    let areaId = $('new-user-area')?.value || null;
    if (role === 'operador' && supervisorId) {
      const supData = _supervisors.find(s => s.uid === supervisorId);
      if (supData?.areaId) areaId = supData.areaId;
      else if (isSupervisor()) areaId = myArea(); // supervisor creando operador hereda su área
    }
    const data = { username: uname, name, role, password: await _hash(pass), createdAt: serverTimestamp(), createdBy: _user() };
    if (areaId)       data.areaId       = areaId;
    if (supervisorId) data.supervisorId = supervisorId;
    await addDoc(collection(db, 'users'), data);
    closeModal('modal-add-user');
    _toast(`Usuario @${uname} creado`);
    _loadUsers();
  } catch { _toast('Error al crear usuario', 'err'); }
};

window.deleteUser = async (uid, username) => {
  if (!isAdmin()) return;
  if (uid === _session.uid) { _toast('No puedes eliminarte a ti mismo', 'err'); return; }
  if (!confirm(`¿Eliminar al usuario @${username}?`)) return;
  try { await deleteDoc(doc(db, 'users', uid)); _toast(`@${username} eliminado`); _loadUsers(); }
  catch { _toast('Error al eliminar', 'err'); }
};

window.openChangePassword = (uid, username) => {
  $('chpass-uid').value        = uid;
  $('chpass-user').textContent = `@${username}`;
  $('chpass-new').value        = '';
  _open('modal-change-pass');
};

window.saveChangePassword = async () => {
  const uid  = $('chpass-uid').value;
  const pass = $('chpass-new').value;
  if (pass.length < 6) { _toast('Mínimo 6 caracteres', 'err'); return; }
  try {
    await updateDoc(doc(db, 'users', uid), { password: await _hash(pass) });
    closeModal('modal-change-pass'); _toast('Contraseña actualizada');
  } catch { _toast('Error al actualizar contraseña', 'err'); }
};

window.openReassignSupervisor = (uid, username, currentSupId, userAreaId) => {
  if (!isAdmin()) return;
  $('reassign-uid').value              = uid;
  $('reassign-uid-area').value         = userAreaId || '';   // guardamos área del usuario
  $('reassign-user-label').textContent = `@${username}`;
  // Mostrar solo supervisores del área de este usuario
  _fillSupSelectByArea('reassign-supervisor', userAreaId || '');
  setTimeout(() => {
    const sel = $('reassign-supervisor');
    for (let i = 0; i < sel.options.length; i++) if (sel.options[i].value === currentSupId) { sel.selectedIndex = i; break; }
  }, 30);
  _open('modal-reassign-sup');
};

window.saveReassignSupervisor = async () => {
  const uid    = $('reassign-uid').value;
  const supId  = $('reassign-supervisor').value;
  // Heredar el área del supervisor nuevo (mantener consistencia)
  let newArea  = $('reassign-uid-area').value || null;
  if (supId) {
    const supData = _supervisors.find(s => s.uid === supId);
    if (supData?.areaId) newArea = supData.areaId;
  }
  try {
    await updateDoc(doc(db, 'users', uid), {
      supervisorId: supId || null,
      areaId:       newArea || null,
    });
    closeModal('modal-reassign-sup'); _toast('Supervisor actualizado'); _loadUsers();
  } catch { _toast('Error al actualizar', 'err'); }
};

window.openCambiarArea = (uid, username, currentAreaId) => {
  if (!isAdmin()) return;
  $('cambiar-area-uid').value        = uid;
  $('cambiar-area-user').textContent = `@${username}`;
  $('cambiar-area-nueva').value      = currentAreaId || '';
  _open('modal-cambiar-area');
};

window.guardarCambioArea = async () => {
  const uid    = $('cambiar-area-uid').value;
  const areaId = $('cambiar-area-nueva').value;
  try {
    await updateDoc(doc(db, 'users', uid), { areaId: areaId || null });
    // Actualizar también todos sus operadores al mismo área
    const opsSnap = await getDocs(query(collection(db, 'users'), where('supervisorId', '==', uid)));
    const updates = opsSnap.docs.map(d => updateDoc(doc(db, 'users', d.id), { areaId: areaId || null }));
    await Promise.all(updates);
    closeModal('modal-cambiar-area');
    _toast('Área actualizada' + (opsSnap.docs.length ? ` (y ${opsSnap.docs.length} operadores)` : ''));
    _loadUsers();
  } catch { _toast('Error al actualizar área', 'err'); }
};

async function _loadUsers() {
  if (!isAdmin()) return;
  await _loadSupervisors();
  const snap  = await getDocs(query(collection(db, 'users'), orderBy('createdAt', 'asc')));
  const users = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
  const badge = r => ({ admin: `<span class="action-tag role-admin">admin</span>`, supervisor: `<span class="action-tag role-supervisor">supervisor</span>`, operador: `<span class="action-tag role-operador">operador</span>` })[r] || r;
  const supLbl  = id => { const s = _supervisors.find(x => x.uid === id); return s ? `<span style="font-size:.75rem;color:var(--brand)">@${s.username}</span>` : '<span style="color:var(--text-lt);font-size:.75rem">—</span>'; };
  const areaLbl = aId => {
    const a = AREAS[aId];
    return a ? `<span style="font-size:.7rem;font-weight:700;padding:.12rem .45rem;border-radius:99px;background:${a.color}18;color:${a.color}">${a.label}</span>` : '<span style="color:var(--text-lt);font-size:.75rem">—</span>';
  };
  $('users-tbody').innerHTML = users.map(u => `
    <tr>
      <td style="font-weight:700;color:var(--brand)">@${u.username}</td>
      <td>${u.name}</td>
      <td>${badge(u.role)}</td>
      <td>${areaLbl(u.areaId)}</td>
      <td>${supLbl(u.supervisorId)}</td>
      <td style="color:var(--text-lt);font-size:.75rem">${u.createdAt ? _fmt(u.createdAt) : '—'}</td>
      <td><div style="display:flex;gap:.4rem;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" onclick="openChangePassword('${u.uid}','${u.username}')">Contraseña</button>
        ${u.role === 'supervisor' ? `<button class="btn btn-ghost btn-sm" onclick="openCambiarArea('${u.uid}','${u.username}','${u.areaId||''}')">Área</button>` : ''}
        ${u.role === 'operador' ? `<button class="btn btn-ghost btn-sm" onclick="openReassignSupervisor('${u.uid}','${u.username}','${u.supervisorId||''}','${u.areaId||''}')">Supervisor</button>` : ''}
        ${u.uid !== _session.uid ? `<button class="btn btn-danger btn-sm" onclick="deleteUser('${u.uid}','${u.username}')">✕</button>` : ''}
      </div></td>
    </tr>`).join('');
}

// ══════════════════════════════════════════════════════
//  ESTANQUES
// ══════════════════════════════════════════════════════
window.openAddPond = () => {
  if (!canEditPond()) return;
  ['pond-name', 'pond-type', 'pond-cap', 'pond-notes'].forEach(id => document.getElementById(id).value = '');
  $('pond-edit-id').value = '';
  $('pond-modal-title').textContent = 'Nuevo Estanque';
  $('btn-save-pond').textContent    = 'Guardar estanque';
  _open('modal-add-pond');
};

window.openEditPond = id => {
  if (!canManage()) return;
  const p = _pondsCache.find(x => x.id === id);
  if (!p) return;
  $('pond-edit-id').value  = id;
  $('pond-name').value     = p.name     || '';
  $('pond-type').value     = p.type     || '';
  $('pond-cap').value      = p.capacity || '';
  $('pond-notes').value    = p.notes    || '';
  $('pond-modal-title').textContent = 'Editar Estanque';
  $('btn-save-pond').textContent    = 'Actualizar estanque';
  _open('modal-add-pond');
};

window.savePond = async () => {
  if (!canEditPond()) return;
  const name   = $('pond-name').value.trim();
  const editId = $('pond-edit-id').value;
  if (!name) { _toast('El nombre es obligatorio', 'err'); return; }
  const data = { name, type: $('pond-type').value.trim(), capacity: Number($('pond-cap').value) || 0, notes: $('pond-notes').value.trim() };
  try {
    if (editId) { await updateDoc(doc(db, 'ponds', editId), data); _toast('Estanque actualizado'); }
    else {
      await addDoc(collection(db, 'ponds'), { ...data, areaId: myArea(), supervisorId: isSupervisor() ? _session.uid : null, createdBy: _name(), createdByUser: _user(), createdAt: serverTimestamp() });
      _toast('Estanque creado');
    }
    closeModal('modal-add-pond');
    await _loadPonds();
  } catch { _toast('Error al guardar estanque', 'err'); }
};

window.deletePond = async (id, name) => {
  if (!canEditPond()) return;
  // Verificar que no haya fauna antes de eliminar
  try {
    const fSnap = await getDocs(query(collection(db, 'fish'), where('pondId', '==', id)));
    const fishWithStock = fSnap.docs.filter(d => {
      const f = d.data();
      return (f.alevines || 0) + (f.juveniles || 0) + (f.adultos || 0) > 0;
    });
    if (fishWithStock.length > 0) {
      const total = fishWithStock.reduce((s, d) => {
        const f = d.data();
        return s + (f.alevines || 0) + (f.juveniles || 0) + (f.adultos || 0);
      }, 0);
      _toast(`No se puede eliminar: hay ${total} organismos en este estanque. Lleva la fauna a 0 primero.`, 'err');
      return;
    }
  } catch { /* si falla la verificación, continuar */ }
  if (!confirm(`¿Eliminar el estanque "${name}"?`)) return;
  try { await deleteDoc(doc(db, 'ponds', id)); _toast(`Estanque "${name}" eliminado`); await _loadPonds(); }
  catch { _toast('Error al eliminar', 'err'); }
};

async function _loadPonds() {
  try {
    const snap = await getDocs(query(collection(db, 'ponds'), orderBy('createdAt', 'asc')));
    _pondsCache = _scope(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch { _pondsCache = []; }
  _renderPonds();
  _fillPondSelects();
}

function _renderPonds() {
  const grid = $('pond-grid');
  if (!_pondsCache.length) { grid.innerHTML = `<div class="empty"><div class="icon">~</div><p>No hay estanques todavía.</p></div>`; return; }
  grid.innerHTML = _pondsCache.map(p => `
    <div class="pond-card" onclick="openPondDetail('${p.id}')">
      <div class="pond-card-accent"></div>
      <div class="pond-header"><div>
        <div class="pond-name">${p.name}</div>
        <div class="pond-type">${p.type || 'Sin tipo especificado'}</div>
      </div></div>
      <div class="pond-body">
        <div class="stat-row"><span class="stat-label">Capacidad</span><span class="stat-value">${p.capacity ? p.capacity.toLocaleString() + ' L' : '—'}</span></div>
        ${p.notes ? `<div class="stat-row"><span class="stat-label">Notas</span><span class="stat-value">${p.notes}</span></div>` : ''}
      </div>
      ${canEditPond() ? `<div class="pond-footer">
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openEditPond('${p.id}')">Editar</button>
        <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();deletePond('${p.id}','${p.name.replace(/'/g, "\\'")}')">✕ Eliminar</button>
      </div>` : ''}
    </div>`).join('');
}

// ── Detalle estanque ───────────────────────────────────
window.openPondDetail = async pondId => {
  const p = _pondsCache.find(x => x.id === pondId);
  if (!p) return;
  _detPondId = pondId; _detPondName = p.name;
  $('pond-detail-title').textContent = p.name;
  $('pond-detail-log').innerHTML = '<p style="color:var(--text-lt);font-size:.82rem">Cargando…</p>';
  _open('modal-pond-detail');

  // Cargar fauna en tiempo real desde Firestore
  let pondFish = [];
  try {
    const fSnap = await getDocs(query(collection(db, 'fish'), where('pondId', '==', pondId)));
    pondFish = fSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Actualizar cache local también
    _fishCache = [..._fishCache.filter(f => f.pondId !== pondId), ...pondFish];
  } catch { pondFish = _fishCache.filter(f => f.pondId === pondId); }

  const faunaHtml = pondFish.length
    ? `<div class="pond-detail-section-title" style="margin-top:.75rem">Fauna en este estanque</div>
       <div style="display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:.75rem">
         ${pondFish.map(f => `
           <div style="background:var(--bg-main);border:1px solid var(--border);border-radius:var(--radius);padding:.4rem .75rem;font-size:.78rem;display:flex;align-items:center;gap:.4rem">
             <span style="font-weight:700">${f.name}</span>
             ${f.species ? `<span style="color:var(--text-lt);font-size:.7rem;font-style:italic">${f.species}</span>` : ''}
             <span>${_catBadge(f)}</span>
             <span style="font-weight:700;color:var(--brand);font-size:.85rem">${_total(f)}</span>
           </div>`).join('')}
       </div>`
    : `<div style="color:var(--text-lt);font-size:.82rem;padding:.4rem 0 .75rem">Sin fauna registrada.</div>`;

  $('pond-detail-info').innerHTML = `
    <div class="pond-detail-meta">
      <div class="pond-detail-row"><span class="pd-label">Tipo / uso</span><span class="pd-value">${p.type || '—'}</span></div>
      <div class="pond-detail-row"><span class="pd-label">Capacidad</span><span class="pd-value">${p.capacity ? p.capacity.toLocaleString() + ' L' : '—'}</span></div>
      ${p.notes ? `<div class="pond-detail-row"><span class="pd-label">Notas</span><span class="pd-value">${p.notes}</span></div>` : ''}
    </div>
    ${faunaHtml}`;

  $('pond-detail-admin-btns').style.display = canEditPond() ? 'flex' : 'none';
  // Botón "+ Registrar acción" en el modal de detalle
  const _btnAccion = document.querySelector('#modal-pond-detail .btn-primary[onclick="openActionFromDetail()"]');
  if (_btnAccion) {
    // Mortalidad: solo isMortSup lo ve. Resto: canDoActions
    _btnAccion.style.display = (canDoActions() || isMortSup()) ? '' : 'none';
  }
  // En el action-type select: opción "Mortalidad" solo para isMortSup
  $$('.action-sup-only').forEach(o => {
    o.style.display = canDoActions() ? '' : 'none';
  });
  // Solo isMortSup puede ver la opción "mortalidad" en el select
  const _mortOpt = document.querySelector('#action-type option[value="mortalidad"]');
  if (_mortOpt) _mortOpt.style.display = (isMortSup() || isAdmin()) ? '' : 'none';

  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const snap  = await getDocs(query(collection(db, 'actions'), where('pondId', '==', pondId)));
    const rows  = snap.docs.map(d => d.data())
      .filter(a => { const t = a.timestamp?.toDate?.() ?? new Date(a.timestamp); return t >= today; })
      .sort((a, b) => (b.timestamp?.toDate?.() ?? new Date(b.timestamp)) - (a.timestamp?.toDate?.() ?? new Date(a.timestamp)));
    $('pond-detail-log').innerHTML = rows.length
      ? rows.map(a => `<div class="pond-log-entry"><span class="action-tag ${_tagClass(a.action)}">${a.action}</span><span class="pond-log-time">${_fmt(a.timestamp)}</span><span class="pond-log-user">@${a.username || a.userName}</span>${a.notes ? `<span class="pond-log-notes">${a.notes}</span>` : ''}</div>`).join('')
      : '<p style="color:var(--text-lt);font-size:.82rem;padding:.5rem 0">Sin actividad hoy.</p>';
  } catch {
    $('pond-detail-log').innerHTML = `<p style="color:var(--red);font-size:.82rem">Error al cargar</p>`;
  }
};

window.openActionFromDetail = () => { if (!canDoActions() && !isMortSup()) return; closeModal('modal-pond-detail'); openRegisterAction(_detPondId); };
window.editPondFromDetail   = () => { closeModal('modal-pond-detail'); openEditPond(_detPondId); };
window.deletePondFromDetail = async () => { closeModal('modal-pond-detail'); await deletePond(_detPondId, _detPondName); };

// ══════════════════════════════════════════════════════
//  ACCIONES
// ══════════════════════════════════════════════════════
window.openRegisterActionGlobal = () => {
  if (!canDoActions() && !isMortSup()) { _toast('Sin permiso para registrar acciones', 'err'); return; }
  openRegisterAction(null);
};

window.openRegisterAction = pondId => {
  $('action-notes').value = '';
  const selGrp    = $('action-pond-selector-group');
  const fixedGrp  = $('action-pond-fixed-group');
  const fixedName = $('action-pond-fixed-name');
  if (pondId) {
    const p = _pondsCache.find(x => x.id === pondId);
    selGrp.style.display = 'none'; fixedGrp.style.display = 'block';
    fixedName.textContent = p ? p.name : pondId; fixedName.dataset.pondId = pondId;
  } else {
    selGrp.style.display = 'block'; fixedGrp.style.display = 'none';
  }
  $('action-type').value = 'alimentación';
  onActionTypeChange();
  if (pondId) { _fillFishSelect('mort-fish', pondId); _fillFishSelect('birth-fish', pondId); _fillFishSelect('intro-fish', pondId); }
  _open('modal-action');
};

window.onActionPondChange = () => {
  const id = $('action-pond').value;
  if (!id) return;
  _fillFishSelect('mort-fish', id); _fillFishSelect('birth-fish', id); _fillFishSelect('intro-fish', id);
};

window.onActionTypeChange = () => {
  const t = $('action-type').value;
  $('mortality-fields').style.display = t === 'mortalidad'   ? 'block' : 'none';
  $('birth-fields').style.display     = t === 'nacimiento'   ? 'block' : 'none';
  $('intro-fields').style.display     = t === 'introducción' ? 'block' : 'none';
};

window.onIntroTypeChange = () => {
  const t = document.querySelector('input[name="intro-type-radio"]:checked')?.value ?? 'nueva';
  $('intro-type').value = t;
  $('intro-new-fields').style.display      = t === 'nueva'     ? 'block' : 'none';
  $('intro-existing-fields').style.display = t === 'existente' ? 'block' : 'none';
};

window.saveAction = async () => {
  const sel    = $('action-pond-selector-group');
  const pondId = sel.style.display !== 'none' ? $('action-pond').value : $('action-pond-fixed-name').dataset.pondId;
  const action = $('action-type').value;
  const notes  = $('action-notes').value.trim();
  if (!pondId) { _toast('Selecciona un estanque', 'err'); return; }

  const pond  = _pondsCache.find(p => p.id === pondId);
  const supId = pond?.supervisorId || (isSupervisor() ? _session.uid : null);
  const base  = { pondId, pondName: pond?.name || '?', supervisorId: supId, userName: _name(), username: _user(), userId: _session.uid, timestamp: serverTimestamp() };

  try {
    if (action === 'mortalidad') {
      if (!isMortSup() && !isAdmin()) { _toast('Solo el área de Mortalidad puede registrar bajas', 'err'); return; }
      const fishId = $('mort-fish').value;
      const cat    = $('mort-cat').value;
      const qty    = Number($('mort-qty').value);
      if (!fishId || !qty) { _toast('Completa especie y cantidad', 'err'); return; }
      const f = _fishCache.find(x => x.id === fishId);
      if (!f || qty > (f[cat] || 0)) { _toast(`Solo hay ${f?.[cat] || 0} ${cat} disponibles`, 'err'); return; }
      const upd = {}; upd[cat] = increment(-qty);
      await updateDoc(doc(db, 'fish', fishId), upd);
      await addDoc(collection(db, 'actions'), { ...base, action, notes: notes || `${qty} ${cat} de ${f.name} fallecidos`, extra: { fishId, fishName: f.name, category: cat, qty } });
      closeModal('modal-action'); _toast('Mortalidad registrada'); await _loadFish(); return;
    }

    if (action === 'nacimiento') {
      if (!canDoActions() && !isAdmin()) { _toast('Sin permiso', 'err'); return; }
      const fishId = $('birth-fish').value;
      const qty    = Number($('birth-qty').value);
      if (!fishId || !qty) { _toast('Completa especie y cantidad', 'err'); return; }
      const f = _fishCache.find(x => x.id === fishId);
      if (!f) { _toast('Especie no encontrada', 'err'); return; }
      await updateDoc(doc(db, 'fish', fishId), { alevines: increment(qty) });
      await addDoc(collection(db, 'actions'), { ...base, action, notes: notes || `${qty} alevines nacidos de ${f.name}`, extra: { fishId, fishName: f.name, category: 'alevines', qty } });
      closeModal('modal-action'); _toast('Nacimiento registrado'); await _loadFish(); return;
    }

    if (action === 'introducción') {
      if (!canDoActions() && !isAdmin()) { _toast('Sin permiso', 'err'); return; }
      const tipo = $('intro-type').value;
      if (tipo === 'existente') {
        const fishId = $('intro-fish').value;
        const cat    = $('intro-cat').value;
        const qty    = Number($('intro-qty-existing').value);
        if (!fishId || !qty) { _toast('Completa especie y cantidad', 'err'); return; }
        const f = _fishCache.find(x => x.id === fishId);
        if (!f) { _toast('Especie no encontrada', 'err'); return; }
        const upd = {}; upd[cat] = increment(qty);
        await updateDoc(doc(db, 'fish', fishId), upd);
        await addDoc(collection(db, 'actions'), { ...base, action, notes: notes || `Introducción de ${qty} ${cat} de ${f.name}`, extra: { fishId, fishName: f.name, category: cat, qty } });
      } else {
        const name = $('intro-name').value.trim();
        if (!name) { _toast('El nombre común es obligatorio', 'err'); return; }
        if (_fishCache.find(f => f.pondId === pondId && f.name.toLowerCase() === name.toLowerCase())) { _toast(`Ya existe "${name}" en este estanque`, 'err'); return; }
        const al = Number($('intro-qty-alevin').value)  || 0;
        const jv = Number($('intro-qty-juvenil').value) || 0;
        const ad = Number($('intro-qty-adulto').value)  || 0;
        const ref = await addDoc(collection(db, 'fish'), { pondId, pondName: pond?.name || '?', areaId: myArea(), supervisorId: supId, name, species: $('intro-species').value.trim(), notes: $('intro-fish-notes').value.trim(), alevines: al, juveniles: jv, adultos: ad, addedBy: _name(), addedByUser: _user(), addedAt: serverTimestamp() });
        await addDoc(collection(db, 'actions'), { ...base, action, notes: notes || `Nueva especie: ${name} (A:${al} J:${jv} Ad:${ad})`, extra: { fishId: ref.id, fishName: name, alevines: al, juveniles: jv, adultos: ad } });
      }
      closeModal('modal-action'); _toast('Introducción registrada'); await _loadFish(); return;
    }

    // Acción general — mortalidad no puede hacer acciones genéricas
    if (isMortArea() && !isAdmin()) { _toast('El área de Mortalidad no puede registrar acciones generales', 'err'); return; }
    await addDoc(collection(db, 'actions'), { ...base, action, notes });
    closeModal('modal-action'); _toast('Acción registrada');
    await _loadPonds();
    if (_detPondId === pondId) openPondDetail(pondId);
  } catch { _toast('Error al guardar acción', 'err'); }
};

// ══════════════════════════════════════════════════════
//  BITÁCORA
// ══════════════════════════════════════════════════════
async function _loadUsersFilter() {
  try {
    const snap = await getDocs(query(collection(db, 'users'), orderBy('createdAt', 'asc')));
    const sel  = $('filter-user');
    if (!sel) return;
    const prev = sel.value;
    let users = snap.docs.map(d => d.data());
    // Supervisor: solo ve usuarios de su misma área
    if (isSupervisor() && !isAdmin()) {
      const myAreaId = _session?.areaId;
      if (myAreaId) users = users.filter(u => u.areaId === myAreaId);
    }
    sel.innerHTML = '<option value="">Todos los responsables</option>' +
      users.map(u => `<option value="${u.username}">@${u.username} — ${u.name}</option>`).join('');
    if (prev) sel.value = prev;
  } catch {}
}

window.loadLog = async () => {
  const pf   = $('filter-pond').value;
  const af   = $('filter-action').value;
  const uf   = canManage() ? $('filter-user')?.value : '';
  const from = $('filter-date-from').value;
  const to   = $('filter-date-to').value;

  const snap = await getDocs(query(collection(db, 'actions'), orderBy('timestamp', 'desc'), limit(500)));
  let rows   = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Scope de bitácora por rol
  if (isAdmin()) {
    // admin: ve todo, sin restricción
  } else if (isMortSup()) {
    // supervisor de mortalidad: solo ve las acciones de tipo "mortalidad"
    rows = rows.filter(r => r.action === 'mortalidad');
  } else if (isSupervisor()) {
    // supervisor de otras áreas: solo su área
    const myAreaId = _session?.areaId;
    if (myAreaId) rows = rows.filter(r => r.areaId === myAreaId);
    else { const sup = _contextSup(); rows = sup ? rows.filter(r => r.supervisorId === sup) : []; }
  } else {
    // operador: solo lo suyo
    rows = rows.filter(r => r.userId === _session.uid);
  }

  if (pf)   rows = rows.filter(r => r.pondId === pf);
  if (af)   rows = rows.filter(r => r.action === af);
  if (uf)   rows = rows.filter(r => (r.username || r.userName) === uf);
  if (from) { const d = new Date(from); d.setHours(0,0,0,0); rows = rows.filter(r => (r.timestamp?.toDate?.() ?? new Date(r.timestamp)) >= d); }
  if (to)   { const d = new Date(to);   d.setHours(23,59,59,999); rows = rows.filter(r => (r.timestamp?.toDate?.() ?? new Date(r.timestamp)) <= d); }
  _currentLogRows = rows;

  const tb = $('log-tbody');
  if (!rows.length) { tb.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:2.5rem;color:var(--text-lt)">Sin registros con esos filtros</td></tr>`; return; }

  tb.innerHTML = rows.map((r, i) => {
    const hasD = r.extra || r.notes;
    const did  = `ld-${i}`;
    return `
      <tr>
        <td style="width:32px;text-align:center">${hasD ? `<button class="log-expand-btn" onclick="toggleLogDetail('${did}')">▶</button>` : ''}</td>
        <td style="color:var(--text-lt);font-family:var(--ff-mono);font-size:.72rem;white-space:nowrap">${r.timestamp ? _fmt(r.timestamp) : '—'}</td>
        <td style="font-weight:700">${r.pondName}</td>
        <td><span class="action-tag ${_tagClass(r.action)}">${r.action}</span></td>
        <td style="color:var(--text-md);max-width:200px;font-size:.78rem">${r.notes || '—'}</td>
        <td style="font-weight:700;color:var(--brand)">@${r.username || r.userName}</td>
      </tr>
      ${hasD ? `<tr id="${did}" class="log-detail-row" style="display:none"><td colspan="6">${_logDetail(r)}</td></tr>` : ''}`;
  }).join('');
};

function _logDetail(r) {
  const p = [];
  if (r.notes) p.push(`<strong>Notas:</strong> ${r.notes}`);
  if (r.extra) {
    const e = r.extra;
    if (e.fishName)    p.push(`<strong>Especie:</strong> ${e.fishName}`);
    if (e.category)    p.push(`<strong>Categoría:</strong> ${e.category}`);
    if (e.qty != null) p.push(`<strong>Cantidad:</strong> ${e.qty}`);
    if (e.alevines != null) p.push(`Alevines: ${e.alevines}  Juveniles: ${e.juveniles}  Adultos: ${e.adultos}`);
  }
  return p.join(' &nbsp;·&nbsp; ');
}

window.toggleLogDetail = id => {
  const row = document.getElementById(id);
  const btn = row?.previousElementSibling?.querySelector('.log-expand-btn');
  if (!row) return;
  const h = row.style.display === 'none';
  row.style.display = h ? 'table-row' : 'none';
  if (btn) btn.textContent = h ? '▼' : '▶';
};

window.downloadLogCSV = () => {
  if (!_currentLogRows.length) { _toast('No hay registros', 'err'); return; }
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const detail = r => {
    const p = [];
    if (r.notes) p.push(r.notes);
    if (r.extra) {
      const e = r.extra;
      if (e.fishName)    p.push(`Especie: ${e.fishName}`);
      if (e.category)    p.push(`Categoría: ${e.category}`);
      if (e.qty != null) p.push(`Cantidad: ${e.qty}`);
      if (e.alevines != null) p.push(`Alevines: ${e.alevines}  Juveniles: ${e.juveniles}  Adultos: ${e.adultos}`);
    }
    return p.join(' · ');
  };
  const lines = [
    ['Fecha/Hora', 'Estanque', 'Acción', 'Detalle', 'Responsable'].map(esc).join(','),
    ..._currentLogRows.map(r => [r.timestamp ? _fmt(r.timestamp) : '', r.pondName || '', r.action || '', detail(r), `@${r.username || r.userName || ''}`].map(esc).join(','))
  ];
  const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' }));
  Object.assign(document.createElement('a'), { href: url, download: `bitacora_fcb_${new Date().toISOString().slice(0, 10)}.csv` }).click();
  URL.revokeObjectURL(url);
  _toast('CSV descargado');
};

// ══════════════════════════════════════════════════════
//  FAUNA
// ══════════════════════════════════════════════════════
window.openCreateFish = () => {
  if (!canManage()) return;
  ['create-fish-name', 'create-fish-species', 'create-fish-notes'].forEach(id => document.getElementById(id).value = '');
  ['create-fish-alevin', 'create-fish-juvenil', 'create-fish-adulto'].forEach(id => document.getElementById(id).value = '0');
  $('create-fish-edit-id').value        = '';
  $('create-fish-title').textContent    = 'Crear Especie';
  $('btn-save-create-fish').textContent = 'Guardar especie';
  const pf = $('filter-fish-pond').value;
  setTimeout(() => {
    const s = $('create-fish-pond');
    if (pf) for (let i = 0; i < s.options.length; i++) if (s.options[i].value === pf) { s.selectedIndex = i; break; }
  }, 30);
  _open('modal-create-fish');
};

window.saveCreateFish = async () => {
  if (!canManage()) return;
  const pondId = $('create-fish-pond').value;
  const name   = $('create-fish-name').value.trim();
  const editId = $('create-fish-edit-id').value;
  if (!pondId || !name) { _toast('Estanque y nombre son obligatorios', 'err'); return; }
  if (!editId && _fishCache.find(f => f.pondId === pondId && f.name.toLowerCase() === name.toLowerCase())) { _toast(`Ya existe "${name}" en este estanque`, 'err'); return; }
  const pond = _pondsCache.find(p => p.id === pondId);
  const data = { pondId, pondName: pond?.name || '?', supervisorId: pond?.supervisorId || (isSupervisor() ? _session.uid : null), name, species: $('create-fish-species').value.trim(), notes: $('create-fish-notes').value.trim(), alevines: Number($('create-fish-alevin').value) || 0, juveniles: Number($('create-fish-juvenil').value) || 0, adultos: Number($('create-fish-adulto').value) || 0 };
  try {
    if (editId) { await updateDoc(doc(db, 'fish', editId), data); _toast('Especie actualizada'); }
    else { await addDoc(collection(db, 'fish'), { ...data, areaId: myArea(), addedBy: _name(), addedByUser: _user(), addedAt: serverTimestamp() }); _toast('Especie creada'); }
    closeModal('modal-create-fish'); await _loadFish();
  } catch { _toast('Error al guardar especie', 'err'); }
};

window.openAddUnitsFish = () => {
  if (!canManage()) return;
  $('add-units-fish').innerHTML = '<option value="">— Selecciona estanque primero —</option>';
  $('add-units-cats').style.display = 'none';
  ['add-units-alevin', 'add-units-juvenil', 'add-units-adulto'].forEach(id => document.getElementById(id).value = '0');
  const pf = $('filter-fish-pond').value;
  setTimeout(() => {
    const s = $('add-units-pond');
    if (pf) for (let i = 0; i < s.options.length; i++) if (s.options[i].value === pf) { s.selectedIndex = i; onAddUnitsPondChange(); break; }
  }, 30);
  _open('modal-add-units-fish');
};

window.onAddUnitsPondChange = () => { _fillFishSelect('add-units-fish', $('add-units-pond').value); $('add-units-cats').style.display = 'none'; };

window.onAddUnitsFishChange = () => {
  const f = _fishCache.find(x => x.id === $('add-units-fish').value);
  if (!f) { $('add-units-cats').style.display = 'none'; return; }
  $('add-units-cats').style.display = 'block';
  $('add-units-current').textContent = `Conteo actual — Alevines: ${f.alevines || 0}  Juveniles: ${f.juveniles || 0}  Adultos: ${f.adultos || 0}  Total: ${_total(f)}`;
};

window.saveAddUnitsFish = async () => {
  if (!canManage()) return;
  const fishId = $('add-units-fish').value;
  const al = Number($('add-units-alevin').value)  || 0;
  const jv = Number($('add-units-juvenil').value) || 0;
  const ad = Number($('add-units-adulto').value)  || 0;
  if (!fishId)        { _toast('Selecciona una especie', 'err'); return; }
  if (!al && !jv && !ad) { _toast('Ingresa al menos una cantidad', 'err'); return; }
  try { await updateDoc(doc(db, 'fish', fishId), { alevines: increment(al), juveniles: increment(jv), adultos: increment(ad) }); closeModal('modal-add-units-fish'); _toast('Fauna actualizada'); await _loadFish(); }
  catch { _toast('Error al actualizar fauna', 'err'); }
};

window.openEditFish = () => {
  if (!canManage() || !_detFishId) return;
  closeModal('modal-fish-detail');
  getDoc(doc(db, 'fish', _detFishId)).then(snap => {
    if (!snap.exists()) { _toast('Fauna no encontrada', 'err'); return; }
    const f = snap.data();
    $('create-fish-edit-id').value        = _detFishId;
    $('create-fish-name').value           = f.name     || '';
    $('create-fish-species').value        = f.species  || '';
    $('create-fish-notes').value          = f.notes    || '';
    $('create-fish-alevin').value         = f.alevines  || 0;
    $('create-fish-juvenil').value        = f.juveniles || 0;
    $('create-fish-adulto').value         = f.adultos   || 0;
    $('create-fish-title').textContent    = 'Editar Especie';
    $('btn-save-create-fish').textContent = 'Actualizar especie';
    setTimeout(() => {
      const s = $('create-fish-pond');
      for (let i = 0; i < s.options.length; i++) if (s.options[i].value === f.pondId) { s.selectedIndex = i; break; }
    }, 30);
    _open('modal-create-fish');
  });
};

window.deleteFishFromDetail = async () => {
  if (!canManage() || !_detFishId) return;
  if (!confirm('¿Eliminar esta especie?')) return;
  try { await deleteDoc(doc(db, 'fish', _detFishId)); _toast('Especie eliminada'); closeModal('modal-fish-detail'); await _loadFish(); }
  catch { _toast('Error al eliminar especie', 'err'); }
};

window.openFishDetail = fishId => {
  const f = _fishCache.find(x => x.id === fishId);
  if (!f) return;
  _detFishId = fishId;
  const total = _total(f);
  $('fish-detail-body').innerHTML = `
    <div class="fish-detail-wrap">
      <div class="fish-detail-name">${f.name}</div>
      <div class="fish-detail-species">${f.species || 'Especie no especificada'}</div>
      <div class="fish-cats-detail">
        <div class="cat-detail-item cat-alevin"><div class="num">${f.alevines || 0}</div><div class="lbl">Alevines</div></div>
        <div class="cat-detail-item cat-juvenil"><div class="num">${f.juveniles || 0}</div><div class="lbl">Juveniles</div></div>
        <div class="cat-detail-item cat-adulto"><div class="num">${f.adultos || 0}</div><div class="lbl">Adultos</div></div>
        <div class="cat-detail-item" style="background:var(--bg-main);border:1px solid var(--border)"><div class="num">${total}</div><div class="lbl">Total</div></div>
      </div>
      <div class="fish-detail-grid" style="margin-top:1rem">
        <div class="fd-row"><span class="fd-label">Estanque</span><span class="fd-value">${f.pondName}</span></div>
        ${f.notes ? `<div class="fd-row"><span class="fd-label">Notas</span><span class="fd-value">${f.notes}</span></div>` : ''}
        <div class="fd-row"><span class="fd-label">Registrado por</span><span class="fd-value">@${f.addedByUser || f.addedBy || '—'}</span></div>
        ${f.addedAt ? `<div class="fd-row"><span class="fd-label">Fecha</span><span class="fd-value">${_fmt(f.addedAt)}</span></div>` : ''}
      </div>
    </div>`;
  $('fish-detail-admin-btns').style.display = canManage() ? 'flex' : 'none';
  _open('modal-fish-detail');
};

async function _loadFish() {
  const pf   = $('filter-fish-pond').value;
  const snap = await getDocs(collection(db, 'fish'));
  _fishCache = _scope(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  const items = pf ? _fishCache.filter(f => f.pondId === pf) : _fishCache;
  const c     = $('fish-list');
  if (!items.length) { c.innerHTML = `<div class="empty"><div class="icon">·</div><p>No hay fauna registrada todavía.</p></div>`; return; }
  _fillFishSelect('mort-fish',  pf || '');
  _fillFishSelect('birth-fish', pf || '');
  _fillFishSelect('intro-fish', pf || '');
  c.innerHTML = items.map(f => `
    <div class="fish-row" onclick="openFishDetail('${f.id}')">
      <div class="fish-info">
        <div class="fname">${f.name} <span style="color:var(--text-lt);font-size:.72rem;font-weight:600">· ${f.pondName}</span></div>
        <div class="fspec">${f.species || 'Especie no especificada'}</div>
        <div class="fish-cats">${_catBadge(f)}</div>
      </div>
      <div class="fish-qty">${_total(f).toLocaleString()}</div>
    </div>`).join('');
}

// Exponer loadFishView como alias (referenciado desde HTML onchange)
window.loadFishView = _loadFish;

// ══════════════════════════════════════════════════════
//  EXPEDIENTES
// ══════════════════════════════════════════════════════

// ── Genera tubos microbiológicos en el modal ──────────
function _buildMicroTubos() {
  const wrap = $('micro-tubos-wrap');
  if (!wrap || wrap.children.length) return; // ya construido
  wrap.innerHTML = [1,2,3,4,5].map(i => `
    <div style="border:1px solid var(--border);border-radius:var(--radius);padding:.6rem .75rem">
      <div style="font-size:.7rem;font-weight:700;color:var(--text-lt);margin-bottom:.35rem;text-transform:uppercase;letter-spacing:.05em">Tubo ${i}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:.35rem">
        <div class="form-group" style="margin:0"><label class="form-label" style="font-size:.68rem">Tubo</label>
          <input id="micro-${i}-tubo" class="form-control" placeholder="…"/></div>
        <div class="form-group" style="margin:0"><label class="form-label" style="font-size:.68rem">Caja</label>
          <input id="micro-${i}-caja" class="form-control" placeholder="…"/></div>
        <div class="form-group" style="margin:0"><label class="form-label" style="font-size:.68rem">Tinción Gram</label>
          <input id="micro-${i}-tincion" class="form-control" placeholder="…"/></div>
        <div class="form-group" style="margin:0"><label class="form-label" style="font-size:.68rem">Identificación</label>
          <input id="micro-${i}-ident" class="form-control" placeholder="…"/></div>
      </div>
    </div>`).join('');
}

// ── Genera el ID automático: 2 iniciales + DDMM ──────
window.genExpId = () => {
  const especie = $('exp-especie').value;
  const fecha   = $('exp-fecha').value;
  if (!especie || !fecha) { $('exp-id-display').value = '—'; return; }
  const palabras = especie.trim().split(/\s+/);
  const iniciales = (palabras[0]?.[0] || '') + (palabras[1]?.[0] || '');
  const [y, m, d] = fecha.split('-');
  $('exp-id-display').value = (iniciales + d + m).toUpperCase();
};

// ── Carga expedientes desde Firestore ────────────────
async function _loadExps() {
  _buildMicroTubos();
  const snap = await getDocs(query(collection(db, 'expedientes'), orderBy('fecha', 'desc'), limit(500)));
  _exps = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  _renderExps(_exps);
}

// ── Filtra la tabla en tiempo real ───────────────────
window.filterExps = () => {
  const q    = $('exp-filter-q').value.toLowerCase();
  const area = $('exp-filter-area').value;
  const from = $('exp-filter-from').value;
  const to   = $('exp-filter-to').value;
  let rows = [..._exps];
  if (q)    rows = rows.filter(r => (r.especie + ' ' + (r.observaciones||'')).toLowerCase().includes(q));
  if (area) rows = rows.filter(r => r.area === area);
  if (from) rows = rows.filter(r => r.fecha >= from);
  if (to)   rows = rows.filter(r => r.fecha <= to);
  _renderExps(rows);
};

function _renderExps(rows) {
  const tb = $('exp-tbody');
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="13" style="text-align:center;padding:2rem;color:var(--text-lt)">Sin expedientes registrados</td></tr>`;
    return;
  }
  const esc = v => (v ?? '—').toString();
  tb.innerHTML = rows.map(r => `
    <tr style="cursor:pointer" onclick="viewExp('${r.id}')">
      <td style="font-weight:700;color:var(--red);font-family:var(--ff-mono);white-space:nowrap">${esc(r.expId)}</td>
      <td style="white-space:nowrap;color:var(--text-lt)">${esc(r.fecha)}</td>
      <td style="font-weight:600;max-width:160px">${esc(r.especie)}</td>
      <td style="text-align:center">${esc(r.cantidad)}</td>
      <td><span class="action-tag ${r.area==='Conservación'?'tag-feed':'tag-intro'}" style="font-size:.68rem">${esc(r.area)}</span></td>
      <td>${esc(r.acuario)}</td>
      <td style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.colecto)}</td>
      <td style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.entrego)}</td>
      <td style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.proceso)}</td>
      <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.observaciones)}</td>
      <td style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.realizoProceso)}</td>
      <td style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.realizoFicha)}</td>
      <td onclick="event.stopPropagation()">
        <div style="display:flex;gap:.3rem">
          ${isMortSup() ? `<button class="btn btn-ghost btn-sm" onclick="openEditExp('${r.id}')">✎</button>` : ''}
          ${isMortSup() ? `<button class="btn btn-danger btn-sm" onclick="confirmDelExp('${r.id}')">✕</button>` : ''}
        </div>
      </td>
    </tr>`).join('');
}

// ── Abrir modal nuevo ─────────────────────────────────
window.openNewExp = () => {
  _buildMicroTubos();
  _clearExpForm();
  // Fecha = hoy
  $('exp-fecha').value = new Date().toISOString().slice(0, 10);
  genExpId();
  $('exp-modal-title').textContent = 'Nuevo Expediente';
  _open('modal-exp');
};

// ── Abrir modal editar ────────────────────────────────
window.openEditExp = id => {
  _buildMicroTubos();
  const r = _exps.find(x => x.id === id);
  if (!r) return;
  _fillExpForm(r);
  $('exp-modal-title').textContent = 'Editar Expediente — ' + (r.expId || '');
  _open('modal-exp');
};

// ── Limpiar formulario ────────────────────────────────
function _clearExpForm() {
  $('exp-edit-id').value        = '';
  $('exp-especie').value        = '';
  $('exp-fecha').value          = '';
  $('exp-id-display').value     = '—';
  $('exp-cantidad').value       = '';
  $('exp-area').value           = '';
  $('exp-acuario').value        = '';
  $('exp-colecto').value        = '';
  $('exp-entrego').value        = '';
  $('exp-proceso').value        = '';
  $('exp-obs').value            = '';
  $('exp-realizo-proceso').value = '';
  $('exp-realizo-ficha').value  = '';
  // Micro
  [1,2,3,4,5].forEach(i => {
    ['tubo','caja','tincion','ident'].forEach(f => {
      const el = document.getElementById(`micro-${i}-${f}`);
      if (el) el.value = '';
    });
  });
  // Par
  ['trematodos','cestodos','nematodos','acanto','sangui','cope',
   'fases-juv','estado1','larvas','estado2','protozoo','fijador','preservador'].forEach(f => {
    const el = document.getElementById(`par-${f}`);
    if (el) el.value = '';
  });
  // Mic
  ['toma','colorante','observado'].forEach(f => {
    const el = document.getElementById(`mic-${f}`);
    if (el) el.value = '';
  });
}

// ── Rellenar formulario con datos existentes ──────────
function _fillExpForm(r) {
  $('exp-edit-id').value         = r.id;
  $('exp-especie').value         = r.especie       || '';
  $('exp-fecha').value           = r.fecha         || '';
  $('exp-id-display').value      = r.expId         || '—';
  $('exp-cantidad').value        = r.cantidad      || '';
  $('exp-area').value            = r.area          || '';
  $('exp-acuario').value         = r.acuario       || '';
  $('exp-colecto').value         = r.colecto       || '';
  $('exp-entrego').value         = r.entrego       || '';
  $('exp-proceso').value         = r.proceso       || '';
  $('exp-obs').value             = r.observaciones || '';
  $('exp-realizo-proceso').value = r.realizoProceso || '';
  $('exp-realizo-ficha').value   = r.realizoFicha  || '';
  // Micro
  const micro = r.microbiologico || {};
  [1,2,3,4,5].forEach(i => {
    const t = micro[i] || {};
    ['tubo','caja','tincion','ident'].forEach(f => {
      const el = document.getElementById(`micro-${i}-${f}`);
      if (el) el.value = t[f] || '';
    });
  });
  // Par
  const par = r.parasitologico || {};
  ['trematodos','cestodos','nematodos','acanto','sangui','cope',
   'fases-juv','estado1','larvas','estado2','protozoo','fijador','preservador'].forEach(f => {
    const el = document.getElementById(`par-${f}`);
    if (el) el.value = par[f] || '';
  });
  // Mic
  const mic = r.micologico || {};
  ['toma','colorante','observado'].forEach(f => {
    const el = document.getElementById(`mic-${f}`);
    if (el) el.value = mic[f] || '';
  });
}

// ── Recoger todos los campos del formulario ───────────
function _collectExpForm() {
  const especie = $('exp-especie').value.trim();
  const fecha   = $('exp-fecha').value;

  // Construir objeto microbiológico
  const microbiologico = {};
  [1,2,3,4,5].forEach(i => {
    const t = {
      tubo:    document.getElementById(`micro-${i}-tubo`)?.value.trim()    || '',
      caja:    document.getElementById(`micro-${i}-caja`)?.value.trim()    || '',
      tincion: document.getElementById(`micro-${i}-tincion`)?.value.trim() || '',
      ident:   document.getElementById(`micro-${i}-ident`)?.value.trim()   || '',
    };
    if (t.tubo || t.caja || t.tincion || t.ident) microbiologico[i] = t;
  });

  // Parasitológico
  const parsKeys = ['trematodos','cestodos','nematodos','acanto','sangui','cope',
                    'fases-juv','estado1','larvas','estado2','protozoo','fijador','preservador'];
  const parasitologico = {};
  parsKeys.forEach(f => {
    const v = document.getElementById(`par-${f}`)?.value.trim() || '';
    if (v) parasitologico[f] = v;
  });

  // Micológico
  const micologico = {};
  ['toma','colorante','observado'].forEach(f => {
    const v = document.getElementById(`mic-${f}`)?.value.trim() || '';
    if (v) micologico[f] = v;
  });

  // ID: 2 iniciales del nombre científico + DDMM
  const palabras = especie.trim().split(/\s+/);
  const ini = ((palabras[0]?.[0] || '') + (palabras[1]?.[0] || '')).toUpperCase();
  const [y, m, d] = (fecha || '----').split('-');
  const expId = ini + (d || '00') + (m || '00');

  return {
    expId, especie, fecha,
    cantidad:       Number($('exp-cantidad').value) || 0,
    area:           $('exp-area').value,
    acuario:        $('exp-acuario').value.trim(),
    colecto:        $('exp-colecto').value.trim(),
    entrego:        $('exp-entrego').value.trim(),
    proceso:        $('exp-proceso').value,
    observaciones:  $('exp-obs').value.trim(),
    realizoProceso: $('exp-realizo-proceso').value.trim(),
    realizoFicha:   $('exp-realizo-ficha').value.trim(),
    microbiologico, parasitologico, micologico,
  };
}

// ── Guardar (crear o actualizar) ─────────────────────
window.saveExp = async () => {
  const data = _collectExpForm();
  if (!data.especie || !data.fecha) { _toast('Especie y fecha son obligatorios', 'err'); return; }
  if (!data.area)                   { _toast('Selecciona el área', 'err'); return; }
  const editId = $('exp-edit-id').value;
  if (editId && !isMortSup() && !isAdmin()) { _toast('Solo el supervisor de Mortalidad puede editar expedientes', 'err'); return; }
  try {
    if (editId) {
      await updateDoc(doc(db, 'expedientes', editId), { ...data, updatedAt: serverTimestamp(), updatedBy: _user() });
      _toast('Expediente actualizado');
    } else {
      await addDoc(collection(db, 'expedientes'), { ...data, createdAt: serverTimestamp(), createdBy: _user() });
      _toast('Expediente creado — ID: ' + data.expId);
    }
    closeModal('modal-exp');
    await _loadExps();
  } catch { _toast('Error al guardar expediente', 'err'); }
};

// ── Ver detalle ───────────────────────────────────────
window.viewExp = id => {
  const r = _exps.find(x => x.id === id);
  if (!r) return;
  _detailExpId = id;
  $('exp-detail-title').textContent = r.expId || 'Expediente';

  const row = (label, value) => value
    ? `<div class="pond-detail-row"><span class="pd-label">${label}</span><span class="pd-value">${value}</span></div>`
    : '';

  // Micro
  let microHtml = '';
  if (r.microbiologico && Object.keys(r.microbiologico).length) {
    microHtml = '<div class="form-section-title" style="margin-top:1rem">Microbiológico</div>';
    [1,2,3,4,5].forEach(i => {
      const t = r.microbiologico[i];
      if (!t) return;
      microHtml += `<div style="background:var(--bg-main);border:1px solid var(--border);border-radius:var(--radius);padding:.5rem .75rem;margin-bottom:.3rem;font-size:.78rem">
        <strong>Tubo ${i}</strong>
        ${t.tubo    ? ` · Tubo: <em>${t.tubo}</em>` : ''}
        ${t.caja    ? ` · Caja: <em>${t.caja}</em>` : ''}
        ${t.tincion ? ` · Tinción: <em>${t.tincion}</em>` : ''}
        ${t.ident   ? ` · ID: <em>${t.ident}</em>` : ''}
      </div>`;
    });
  }

  // Par
  let parHtml = '';
  if (r.parasitologico && Object.keys(r.parasitologico).length) {
    const parLabels = {
      trematodos: 'Tremátodos', cestodos: 'Céstodos', nematodos: 'Nemátodos',
      acanto: 'Acantocéfalos', sangui: 'Sanguijuelas', cope: 'Copépodos',
      'fases-juv': 'Fases juveniles', estado1: 'Estado', larvas: 'Larvas de',
      estado2: 'Estado (larvas)', protozoo: 'Protozoarios', fijador: 'Fijador usado',
      preservador: 'Preservador usado'
    };
    parHtml = '<div class="form-section-title" style="margin-top:1rem">Parasitológico</div>';
    parHtml += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:.2rem;font-size:.78rem">';
    Object.entries(r.parasitologico).forEach(([k, v]) => {
      parHtml += `<div><span style="color:var(--text-lt)">${parLabels[k]||k}:</span> ${v}</div>`;
    });
    parHtml += '</div>';
  }

  // Mic
  let micHtml = '';
  if (r.micologico && Object.keys(r.micologico).length) {
    micHtml = '<div class="form-section-title" style="margin-top:1rem">Micológico</div>';
    micHtml += `<div style="font-size:.78rem;display:flex;gap:1rem;flex-wrap:wrap">
      ${r.micologico.toma      ? `<span><span style="color:var(--text-lt)">Toma:</span> ${r.micologico.toma}</span>` : ''}
      ${r.micologico.colorante ? `<span><span style="color:var(--text-lt)">Colorante:</span> ${r.micologico.colorante}</span>` : ''}
      ${r.micologico.observado ? `<span><span style="color:var(--text-lt)">Observado:</span> ${r.micologico.observado}</span>` : ''}
    </div>`;
  }

  $('exp-detail-body').innerHTML = `
    <div class="pond-detail-meta">
      ${row('ID',              r.expId)}
      ${row('Especie',         r.especie)}
      ${row('Fecha',           r.fecha)}
      ${row('Cantidad',        r.cantidad)}
      ${row('Área',            r.area)}
      ${row('Acuario',         r.acuario)}
      ${row('Colectó',         r.colecto)}
      ${row('Entregó',         r.entrego)}
      ${row('Se procede a',    r.proceso)}
      ${row('Observaciones',   r.observaciones)}
      ${row('Realizó proceso', r.realizoProceso)}
      ${row('Realizó ficha',   r.realizoFicha)}
    </div>
    ${microHtml}${parHtml}${micHtml}`;

  _open('modal-exp-detail');
};

window.editExpFromDetail = () => {
  closeModal('modal-exp-detail');
  openEditExp(_detailExpId);
};

window.deleteExpFromDetail = () => confirmDelExp(_detailExpId);

window.confirmDelExp = async id => {
  if (!confirm('¿Eliminar este expediente?')) return;
  try {
    await deleteDoc(doc(db, 'expedientes', id));
    closeModal('modal-exp-detail');
    _toast('Expediente eliminado');
    await _loadExps();
  } catch { _toast('Error al eliminar', 'err'); }
};

// ── Descargar CSV ─────────────────────────────────────
window.downloadExpCSV = () => {
  if (!_exps.length) { _toast('Sin expedientes para exportar', 'err'); return; }
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const headers = ['ID','Fecha','Especie','Cantidad','Área','Acuario','Colectó','Entregó',
                   'Se procede a','Observaciones','Realizó proceso','Realizó ficha'];
  const lines = [
    headers.map(esc).join(','),
    ..._exps.map(r => [
      r.expId, r.fecha, r.especie, r.cantidad, r.area, r.acuario,
      r.colecto, r.entrego, r.proceso, r.observaciones, r.realizoProceso, r.realizoFicha
    ].map(esc).join(','))
  ];
  const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' }));
  Object.assign(document.createElement('a'), {
    href: url, download: `expedientes_fcb_${new Date().toISOString().slice(0,10)}.csv`
  }).click();
  URL.revokeObjectURL(url);
  _toast('CSV descargado');
};

// ══════════════════════════════════════════════════════
//  PARÁMETROS
// ══════════════════════════════════════════════════════

// ── Mapa de áreas → sectores → piletas ───────────────
const PARAM_AREAS = {
  conservacion_piletas: {
    label: 'Conservación — Piletas',
    sectores: {
      'Sector A': ['A1','A2','A3','A4','A5','A6'],
      'Sector B': ['B1','B2','B3','B4','B5','B6','B7','B8'],
      'Sector C': ['C1','C2','C3','C4','C5','C6','C7','C8','C9'],
      'Sector D': ['D1','D2','D3','D4','D5','D6','D7','D8'],
      'Sector E': ['E1','E2','E3','E4','E5','E6','E7','E8','E9','E10','E11','E12'],
      'Sector F': ['F1','F2','F3','F4','F5','F6','F7','F8'],
    }
  },
  conservacion_tc: {
    label: 'Conservación — Temp. Controlada',
    sectores: {
      'Sector 1': ['IA1','IA2','IA3','IA4','IA5','IB1','IB2','IB3','IB4','IB5'],
      'Sector 2': ['IIA2','IIA3','IIA4','IIA6','IIB1','IIB2','IIB3','IIB4','IIB5','IIB6'],
      'Sector 3': ['IIIA1','IIIA2','IIIA3','IIIA4','IIIA5','IIIA6','IIIB1','IIIB2','IIIB3','IIIB4','IIIB5','IIIB6'],
      'Sector 5': ['VB1','VB2','VB3','VB4','VB5','VB6','VB7','VB8','VB9','VB10','VB11','VB12','VB13'],
      'Sector 6': ['larvas','Cachorritos 3','Cachorritos 4','Lagos 6','VI-Larvas','VI-Cachorrito'],
    }
  },
  conservacion_frio: {
    label: 'Conservación — Temperaria Fría',
    sectores: {
      'Sector A': ['IA1','IA2','IA3','IA4','IB1','IB2','IB3','IB4','IB5'],
      'Sector B': ['IIA1','IIA2','IIB3'],
    }
  },
  urin_tc: {
    label: 'URIN — Temp. Controlada',
    sectores: {
      'Sector 1': ['1A1','1A2','1B1','1B2','1B3'],
      'Sector 2': ['2A1','2A2','2A3','2A4','2B1','2B2','2B3','2B4'],
      'Sector 3': ['3A1','3B1','3B2','3C1'],
      'Sector 4': ['4A1','4B1','4C1'],
    }
  },
  urin_piletas: {
    label: 'URIN — Piletas Exterior',
    sectores: {
      'Piletas': ['A1','A1C','A2','A2C','A3','A3C','A4','A4C','A5','A5C','A6','A6C','A7','A7C',
                  'B1','B2','B3','B3C','B4','B4C','B5','C1','C1C','C2','C3','C5'],
    }
  },
};

let _params        = [];   // cache bitácora
let _sesionParam   = null; // { fecha, area, participantes:[{uid,username,name}] }

// ── Activar tab solo para mortalidad ─────────────────
// (se llama desde _enterApp)

// ── Cargar bitácora de parámetros ─────────────────────
async function _loadParams() {
  // Pre-setear fechas por defecto al entrar al tab
  const _todayP = new Date().toISOString().slice(0, 10);
  const _fromP  = $('param-filter-from');
  const _toP    = $('param-filter-to');
  if (_fromP && !_fromP.value) {
    const d5 = new Date(); d5.setDate(d5.getDate() - 5);
    _fromP.value = d5.toISOString().slice(0, 10);
  }
  if (_toP && !_toP.value) _toP.value = _todayP;

  const snap = await getDocs(query(collection(db, 'parametros'), orderBy('fecha', 'desc'), limit(500)));
  let all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  // Operador de mortalidad solo ve lo que él registró
  if (isMortOp()) { all = all.filter(r => (r.usernames || []).includes(_session.username) || r.creadoPor === _session.username); }
  _params = all;
  // Aplicar filtro de fechas automáticamente
  filterParams();
}

function _renderParams(rows) {
  const tb = $('params-tbody');
  if (!tb) return;
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:2rem;color:var(--text-lt)">Sin registros</td></tr>`;
    return;
  }
  const phColor = v => {
    if (!v && v !== 0) return 'var(--text-md)';
    const n = parseFloat(v);
    if (n < 6.5 || n > 8.5) return 'var(--red)';
    if (n < 7.0 || n > 8.0) return '#d97706';
    return 'var(--green)';
  };
  tb.innerHTML = rows.map(r => `
    <tr>
      <td style="color:var(--text-lt);font-family:var(--ff-mono);font-size:.72rem;white-space:nowrap">${r.fechaHora || r.fechaStr || '—'}</td>
      <td style="font-size:.75rem">${_getParamAreas()[r.area]?.label || r.area || '—'}</td>
      <td style="font-size:.75rem">${r.sector || '—'}</td>
      <td style="font-weight:700">${r.pileta || '—'}</td>
      <td style="text-align:center;font-weight:700;color:${phColor(r.ph)}">${r.ph ?? '—'}</td>
      <td style="text-align:center">${r.temperatura ?? '—'}</td>
      <td style="font-size:.75rem;max-width:180px">${(r.participantes || [r.creadoPor || '—']).join(', ')}</td>
    </tr>`).join('');
}

// Filtros de área/sector/pileta/fecha
window.onParamAreaChange = () => {
  const area = $('param-filter-area').value;
  const secSel = $('param-filter-sector');
  const pilSel = $('param-filter-pileta');
  secSel.innerHTML = '<option value="">Todos los sectores</option>';
  pilSel.innerHTML = '<option value="">Todas las piletas</option>';
  if (area && _getParamAreas()[area]) {
    Object.keys(_getParamAreas()[area].sectores).forEach(s => {
      secSel.innerHTML += `<option value="${s}">${s}</option>`;
    });
  }
  filterParams();
};

window.filterParams = () => {
  const area   = $('param-filter-area').value;
  const sector = $('param-filter-sector').value;
  const pileta = $('param-filter-pileta').value;
  const from   = $('param-filter-from').value;
  const to     = $('param-filter-to').value;

  // Populate pileta filter when sector changes
  if (area && sector && _getParamAreas()[area]) {
    const pilSel = $('param-filter-pileta');
    const pils = _getParamAreas()[area].sectores[sector] || [];
    if (pilSel.options.length <= 1) {
      pils.forEach(p => { pilSel.innerHTML += `<option value="${p}">${p}</option>`; });
    }
  }

  let rows = [..._params];
  if (area)   rows = rows.filter(r => r.area === area);
  if (sector) rows = rows.filter(r => r.sector === sector);
  if (pileta) rows = rows.filter(r => r.pileta === pileta);
  if (from) rows = rows.filter(r => (r.fechaStr || r.fechaHora || '') >= from);
  if (to)   rows = rows.filter(r => (r.fechaStr || r.fechaHora || '') <= to);
  _renderParams(rows);
};

// ── SESIÓN DE MEDICIÓN ────────────────────────────────
window.openIniciarSesion = () => {
  _sesionParam = {
    fecha: new Date().toISOString().slice(0, 10),
    area:  '',
    participantes: [{ uid: _session.uid, username: _session.username, name: _session.name }],
  };
  $('sesion-fecha').value = _sesionParam.fecha;
  $('sesion-area').value  = '';
  $('add-part-usuario').value = '';
  $('add-part-pass').value    = '';
  $('add-part-error').style.display = 'none';
  _renderParticipantes();
  _open('modal-iniciar-sesion');
};

function _renderParticipantes() {
  const cont = $('sesion-participantes');
  if (!cont) return;
  cont.innerHTML = (_sesionParam?.participantes || []).map(p => `
    <div style="display:inline-flex;align-items:center;gap:.3rem;padding:.2rem .65rem;background:var(--brand-lt);color:var(--brand);border-radius:99px;font-size:.78rem;font-weight:700">
      @${p.username}
      ${p.uid !== _session.uid
        ? `<button onclick="quitarParticipante('${p.uid}')" style="background:none;border:none;cursor:pointer;color:var(--brand);padding:0;line-height:1;font-size:.9rem">✕</button>`
        : ''}
    </div>`).join('');
}

window.quitarParticipante = uid => {
  if (!_sesionParam) return;
  _sesionParam.participantes = _sesionParam.participantes.filter(p => p.uid !== uid);
  _renderParticipantes();
};

window.agregarParticipante = async () => {
  const uname = $('add-part-usuario').value.trim().toLowerCase();
  const pass  = $('add-part-pass').value;
  const errEl = $('add-part-error');
  errEl.style.display = 'none';

  if (!uname || !pass) { errEl.textContent = 'Ingresa usuario y contraseña'; errEl.style.display = 'block'; return; }
  if (_sesionParam.participantes.find(p => p.username === uname)) {
    errEl.textContent = 'Este usuario ya está en la sesión'; errEl.style.display = 'block'; return;
  }
  try {
    const snap = await getDocs(query(collection(db, 'users'), where('username', '==', uname)));
    if (snap.empty) { errEl.textContent = 'Usuario no encontrado'; errEl.style.display = 'block'; return; }
    const ud = snap.docs[0].data();
    if ((await _hash(pass)) !== ud.password) { errEl.textContent = 'Contraseña incorrecta'; errEl.style.display = 'block'; return; }
    _sesionParam.participantes.push({ uid: snap.docs[0].id, username: ud.username, name: ud.name });
    _renderParticipantes();
    $('add-part-usuario').value = '';
    $('add-part-pass').value    = '';
    _toast(`@${uname} agregado a la sesión`);
  } catch { errEl.textContent = 'Error al verificar usuario'; errEl.style.display = 'block'; }
};

// Populate sector select in modal-registrar-param
window.onSesionAreaChange = () => {
  const area = $('sesion-area').value;
  if (_sesionParam) _sesionParam.area = area;
};

window.confirmarSesion = () => {
  const area  = $('sesion-area').value;
  const fecha = $('sesion-fecha').value;
  if (!area)  { _toast('Selecciona un área', 'err'); return; }
  if (!fecha) { _toast('Ingresa la fecha', 'err'); return; }
  _sesionParam.area  = area;
  _sesionParam.fecha = fecha;
  closeModal('modal-iniciar-sesion');
  _mostrarBannerSesion();
  openRegistrarParametro();
};

function _mostrarBannerSesion() {
  const banner = $('sesion-activa-banner');
  const info   = $('sesion-activa-info');
  if (!banner || !_sesionParam) return;
  const names = _sesionParam.participantes.map(p => p.name).join(', ');
  const aLabel = _getParamAreas()[_sesionParam.area]?.label || _sesionParam.area;
  info.textContent = `${_sesionParam.fecha} · ${aLabel} · ${names}`;
  banner.style.display = 'flex';
}

window.cerrarSesion = () => {
  _sesionParam = null;
  const banner = $('sesion-activa-banner');
  if (banner) banner.style.display = 'none';
  closeModal('modal-registrar-param');
  _toast('Sesión terminada');
};

window.openRegistrarParametro = () => {
  if (!_sesionParam) { _toast('Inicia una sesión primero', 'err'); return; }

  // Info banner en el modal
  const info = $('param-sesion-info');
  if (info) {
    const names  = _sesionParam.participantes.map(p => p.name).join(', ');
    const aLabel = _getParamAreas()[_sesionParam.area]?.label || _sesionParam.area;
    info.innerHTML = `<strong>${_sesionParam.fecha}</strong> · ${aLabel}<br/><span style="color:var(--text-md)">Realizado por: ${names}</span>`;
  }

  // Poblar sectores según área de la sesión
  const secSel   = $('param-sector');
  const secLabel = $('param-sector-label');
  const sectores = _getParamAreas()[_sesionParam.area]?.sectores || {};
  const secKeys  = Object.keys(sectores);

  if (secKeys.length === 1) {
    // Solo 1 sector: ocultarlo y tomarlo automáticamente
    secSel.innerHTML = `<option value="${secKeys[0]}">${secKeys[0]}</option>`;
    secSel.value = secKeys[0];
    if (secLabel) secLabel.style.display = 'none';
    secSel.style.display = 'none';
    // Precargar las piletas del sector único
    onParamSectorChange();
  } else {
    // Múltiples sectores: mostrar normalmente
    secSel.innerHTML = '<option value="">— Sin sector —</option>';
    secKeys.forEach(s => { secSel.innerHTML += `<option value="${s}">${s}</option>`; });
    secSel.value = '';
    if (secLabel) secLabel.style.display = '';
    secSel.style.display = '';
  }

  // Limpiar campos de medición
  ['param-ph','param-temp'].forEach(id => {
    document.getElementById(id).value = '';
  });
  $('param-pileta').value = '';
  $('piletas-sugeridas').innerHTML = '';

  _open('modal-registrar-param');
};

window.onParamSectorChange = () => {
  const area   = _sesionParam?.area;
  const sector = $('param-sector').value;
  const dl     = $('piletas-sugeridas');
  dl.innerHTML = '';
  if (area && sector && _getParamAreas()[area]) {
    (_getParamAreas()[area].sectores[sector] || []).forEach(p => {
      dl.innerHTML += `<option value="${p}">`;
    });
  }
};

// ── Áreas/sectores/piletas editables ─────────────────
// El supervisor de mortalidad puede personalizar estas listas
// Se guardan en Firestore colección 'param_config' doc 'areas'
let _paramAreasDynamic = null;  // null = usar PARAM_AREAS por defecto

function _getParamAreas() {
  return _paramAreasDynamic || PARAM_AREAS;
}

async function _loadParamAreasConfig() {
  try {
    const snap = await getDocs(query(collection(db, 'param_config')));
    if (!snap.empty) {
      const d = snap.docs[0].data();
      if (d.areas) _paramAreasDynamic = d.areas;
    }
  } catch {}
}

async function _saveParamAreasConfig() {
  try {
    const snap = await getDocs(query(collection(db, 'param_config')));
    const data = { areas: _paramAreasDynamic || PARAM_AREAS, updatedAt: serverTimestamp(), updatedBy: _user() };
    if (snap.empty) await addDoc(collection(db, 'param_config'), data);
    else            await updateDoc(doc(db, 'param_config', snap.docs[0].id), data);
  } catch { _toast('Error al guardar configuración', 'err'); }
}

// Abrir modal de gestión de áreas
window.openGestionAreas = async () => {
  if (!isMortSup() && !isAdmin()) { _toast('Sin permiso', 'err'); return; }
  await _loadParamAreasConfig();
  _renderGestionAreas();
  _open('modal-gestion-areas');
};

function _renderGestionAreas() {
  const areas = _getParamAreas();
  const cont  = $('gestion-areas-body');
  if (!cont) return;
  cont.innerHTML = Object.entries(areas).map(([areaKey, areaData]) => `
    <div style="border:1px solid var(--border);border-radius:var(--radius);padding:.75rem;margin-bottom:.75rem">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem">
        <strong style="font-size:.9rem">${areaData.label}</strong>
      </div>
      ${Object.entries(areaData.sectores).map(([secKey, piletas]) => `
        <div style="margin-bottom:.5rem">
          <div style="font-size:.78rem;font-weight:700;color:var(--text-md);margin-bottom:.25rem">${secKey}</div>
          <div style="display:flex;flex-wrap:wrap;gap:.25rem;margin-bottom:.3rem">
            ${piletas.map(p => `
              <span style="background:var(--bg-main);border:1px solid var(--border);border-radius:4px;padding:.1rem .45rem;font-size:.72rem;display:inline-flex;align-items:center;gap:.25rem">
                ${p}
                <button onclick="quitarPileta('${areaKey}','${secKey}','${p}')" style="background:none;border:none;cursor:pointer;color:var(--text-lt);padding:0;font-size:.75rem;line-height:1">✕</button>
              </span>`).join('')}
          </div>
          <div style="display:flex;gap:.4rem">
            <input id="new-pileta-${areaKey}-${secKey.replace(/\s/g,'-')}" class="form-control" placeholder="Nueva pileta…" style="font-size:.78rem;padding:.25rem .5rem;height:auto;flex:1"/>
            <button class="btn btn-ghost btn-sm" onclick="agregarPileta('${areaKey}','${secKey}')">+ Agregar</button>
          </div>
        </div>`).join('')}
    </div>`).join('');
}

window.quitarPileta = async (areaKey, secKey, pileta) => {
  if (!confirm(`¿Quitar "${pileta}" de ${secKey}?`)) return;
  const areas = JSON.parse(JSON.stringify(_getParamAreas()));
  areas[areaKey].sectores[secKey] = areas[areaKey].sectores[secKey].filter(p => p !== pileta);
  _paramAreasDynamic = areas;
  await _saveParamAreasConfig();
  _renderGestionAreas();
  _toast(`"${pileta}" eliminada`);
};

window.agregarPileta = async (areaKey, secKey) => {
  const inputId = `new-pileta-${areaKey}-${secKey.replace(/\s/g,'-')}`;
  const val     = document.getElementById(inputId)?.value.trim();
  if (!val) { _toast('Escribe el nombre de la pileta', 'err'); return; }
  const areas = JSON.parse(JSON.stringify(_getParamAreas()));
  if (!areas[areaKey].sectores[secKey].includes(val)) {
    areas[areaKey].sectores[secKey].push(val);
  }
  _paramAreasDynamic = areas;
  await _saveParamAreasConfig();
  _renderGestionAreas();
  _toast(`"${val}" agregada`);
};

let _piletaQueue = [];   // cola de piletas para registro rápido
let _piletaQueueIdx = 0;

// Iniciar registro rápido por sector completo
window.registrarSectorCompleto = () => {
  if (!_sesionParam) { _toast('Inicia parámetros primero', 'err'); return; }
  const area   = _sesionParam.area;
  const sector = $('param-sector').value;
  if (!area)   { _toast('Selecciona un área en la sesión', 'err'); return; }
  if (!sector) { _toast('Selecciona un sector primero', 'err'); return; }
  const piletas = _getParamAreas()[area]?.sectores[sector] || [];
  if (!piletas.length) { _toast('No hay piletas definidas para este sector', 'err'); return; }
  _piletaQueue    = [...piletas];
  _piletaQueueIdx = 0;
  $('param-pileta').value = _piletaQueue[0];
  _actualizarProgresoPiletas();
  _toast(`Modo rápido: ${piletas.length} piletas en cola`);
};

function _actualizarProgresoPiletas() {
  const el = $('param-progreso');
  if (!el) return;
  if (_piletaQueue.length > 0) {
    el.textContent = `Pileta ${_piletaQueueIdx + 1} de ${_piletaQueue.length}: ${_piletaQueue[_piletaQueueIdx]}`;
    el.style.display = 'block';
  } else {
    el.style.display = 'none';
  }
}

window.guardarParametro = async () => {
  if (!_sesionParam) { _toast('Sin sesión activa', 'err'); return; }
  const pileta = $('param-pileta').value.trim();
  const ph     = $('param-ph').value;
  const temp   = $('param-temp').value;
  const sector = $('param-sector').value;

  if (!pileta) { _toast('Ingresa la pileta o acuario', 'err'); return; }
  if (!ph)     { _toast('El pH es obligatorio', 'err'); return; }
  if (!temp)   { _toast('La temperatura es obligatoria', 'err'); return; }

  try {
    const _horaActual = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    await addDoc(collection(db, 'parametros'), {
      fechaStr:  _sesionParam.fecha,
      fechaHora: `${_sesionParam.fecha} ${_horaActual}`,
      fecha:     serverTimestamp(),
      area:          _sesionParam.area,
      sector:        sector || null,
      pileta,
      ph:            parseFloat(ph),
      temperatura:   parseFloat(temp),
      participantes: _sesionParam.participantes.map(p => p.name),
      usernames:     _sesionParam.participantes.map(p => p.username),
      creadoPor:     _session.username,
      creadoPorNombre: _session.name,
    });
    // Avanzar cola de piletas si está activa
    if (_piletaQueue.length > 0) {
      _piletaQueueIdx++;
      if (_piletaQueueIdx < _piletaQueue.length) {
        _toast(`✓ ${pileta} · Siguiente: ${_piletaQueue[_piletaQueueIdx]}`);
        ['param-ph','param-temp'].forEach(id => { document.getElementById(id).value = ''; });
        $('param-pileta').value = _piletaQueue[_piletaQueueIdx];
        _actualizarProgresoPiletas();
      } else {
        _piletaQueue = []; _piletaQueueIdx = 0;
        _toast(`✓ ${pileta} · Sector completo`);
        ['param-ph','param-temp'].forEach(id => { document.getElementById(id).value = ''; });
        $('param-pileta').value = '';
        const el = $('param-progreso');
        if (el) el.style.display = 'none';
      }
    } else {
      _toast(`✓ ${pileta} guardado`);
      ['param-ph','param-temp'].forEach(id => { document.getElementById(id).value = ''; });
      $('param-pileta').value = '';
    }
    _loadParams();
  } catch { _toast('Error al guardar', 'err'); }
};

window.downloadParamsCSV = () => {
  if (!_params.length) { _toast('Sin registros para exportar', 'err'); return; }
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const headers = ['Fecha','Área','Sector','Pileta','pH','Temperatura °C','Realizado por'];
  const lines = [
    headers.map(esc).join(','),
    ..._params.map(r => [
      r.fechaStr,
      _getParamAreas()[r.area]?.label || r.area,
      r.sector,
      r.pileta,
      r.ph,
      r.temperatura,
      (r.participantes || [r.creadoPor]).join('; ')
    ].map(esc).join(','))
  ];
  const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' }));
  Object.assign(document.createElement('a'), {
    href: url, download: `parametros_fcb_${new Date().toISOString().slice(0,10)}.csv`
  }).click();
  URL.revokeObjectURL(url);
  _toast('CSV descargado');
};

// ══════════════════════════════════════════════════════
//  ARRANQUE  (siempre al final — después de todos los const)
// ══════════════════════════════════════════════════════
$$('.modal-bg').forEach(bg =>
  bg.addEventListener('click', e => { if (e.target === bg) bg.classList.remove('open'); })
);
$('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') window.doLogin(); });
_init();
