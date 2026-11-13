const login = document.querySelector('#login');
const dashboard = document.querySelector('#dashboard');
const form = document.querySelector('#login-form');
const loginError = document.querySelector('#login-error');
const passwordInput = document.querySelector('#admin-password');
const passwordToggle = document.querySelector('#password-toggle');
const entries = document.querySelector('#entries');
const status = document.querySelector('#status');
const count = document.querySelector('#count');
const recentCount = document.querySelector('#recent-count');
const searchInput = document.querySelector('#search-input');
const dateFilter = document.querySelector('#date-filter');
const recordDialog = document.querySelector('#record-dialog');
const recordError = document.querySelector('#record-error');
const editDialog = document.querySelector('#edit-dialog');
const editForm = document.querySelector('#edit-form');
const editError = document.querySelector('#edit-error');
const activeTab = document.querySelector('#active-tab');
const pendingTab = document.querySelector('#pending-tab');
const activeView = document.querySelector('#active-view');
const pendingView = document.querySelector('#pending-view');
const pendingEntries = document.querySelector('#pending-entries');
const pendingStatus = document.querySelector('#pending-status');
const pendingCount = document.querySelector('#pending-count');

let records = [];
let currentRecord = null;

passwordToggle.addEventListener('click', () => {
  const isVisible = passwordInput.type === 'password';
  passwordInput.type = isVisible ? 'text' : 'password';
  passwordToggle.textContent = isVisible ? 'HIDE' : 'SHOW';
  passwordToggle.setAttribute('aria-label', isVisible ? 'Hide password' : 'Show password');
  passwordToggle.setAttribute('aria-pressed', String(isVisible));
});

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });

  if (response.status === 401 && url !== '/api/admin/login') {
    showLogin();
    throw new Error('Your session ended. Sign in again.');
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const fallback = response.status === 429
      ? 'Too many requests. Please wait before trying again.'
      : `The request failed (HTTP ${response.status}).`;
    throw new Error(data && typeof data.error === 'string' ? data.error : fallback);
  }
  return response.status === 204 ? null : response.json();
}

function showLogin() {
  records = [];
  dashboard.hidden = true;
  login.hidden = false;
}

function showDashboard() {
  login.hidden = true;
  dashboard.hidden = false;
  loadEntries();
  loadPendingDeletions();
}

function isWithinDays(value, days, now = Date.now()) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp)
    && timestamp >= now - days * 24 * 60 * 60 * 1000
    && timestamp <= now;
}

function updateStatistics() {
  count.textContent = String(records.length);
  recentCount.textContent = String(records.filter((row) => isWithinDays(row.createdAt, 7)).length);
}

function filterRecords() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  const period = dateFilter.value;

  return records.filter((row) => {
    const matchesQuery = [row.fullName, row.phone, row.nickname]
      .some((value) => String(value).toLocaleLowerCase().includes(query));
    const matchesPeriod = period === 'all' || isWithinDays(row.createdAt, Number(period));
    return matchesQuery && matchesPeriod;
  });
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString();
}

function openRecord(row) {
  currentRecord = row;
  recordError.textContent = '';
  document.querySelector('#detail-reference').textContent = `· ${row.id}`;
  document.querySelector('#detail-name').textContent = row.fullName;
  document.querySelector('#detail-phone').textContent = row.phone;
  document.querySelector('#detail-nickname').textContent = row.nickname;
  document.querySelector('#detail-date').textContent = formatDate(row.createdAt);

  const photo = document.querySelector('#detail-photo');
  photo.src = row.photoUrl;
  photo.alt = `Portrait of ${row.fullName}`;
  recordDialog.showModal();
}

function createRecordCard(row) {
  const card = document.createElement('article');
  card.className = 'record-card';

  const image = document.createElement('img');
  image.src = row.photoUrl;
  image.alt = `Portrait of ${row.fullName}`;
  image.loading = 'lazy';

  const details = document.createElement('div');
  const name = document.createElement('h2');
  const phone = document.createElement('p');
  const nickname = document.createElement('p');
  const date = document.createElement('p');
  const openButton = document.createElement('button');

  name.textContent = row.fullName;
  phone.textContent = row.phone;
  nickname.textContent = `“${row.nickname}”`;
  date.className = 'record-date';
  date.textContent = formatDate(row.createdAt);
  openButton.className = 'record-open';
  openButton.type = 'button';
  openButton.append(
    document.createTextNode('OPEN RECORD'),
    window.lucideIcon('arrow-up-right'),
  );
  openButton.addEventListener('click', () => openRecord(row));

  details.append(name, phone, nickname, date, openButton);
  card.append(image, details);
  return card;
}

function renderEntries() {
  const filtered = filterRecords();
  entries.replaceChildren();

  if (!filtered.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = records.length
      ? 'No records match this search and period.'
      : 'The archive has no registrations yet.';
    entries.append(empty);
    status.textContent = records.length
      ? 'No matching records.'
      : 'No registrations in the archive.';
    return;
  }

  for (const row of filtered) entries.append(createRecordCard(row));
  status.textContent = `Showing ${filtered.length} of ${records.length} records.`;
}

async function loadEntries() {
  status.textContent = 'Consulting the archive…';
  status.hidden = false;

  try {
    const result = await api('/api/admin/submissions');
    if (!Array.isArray(result.rows)) throw new Error('The archive response was not valid.');
    records = result.rows;
    updateStatistics();
    renderEntries();
  } catch (error) {
    status.textContent = error.message;
    status.hidden = false;
  }
}

function renderPendingDeletions(rows) {
  pendingEntries.replaceChildren();
  pendingCount.textContent = String(rows.length);

  if (!rows.length) {
    pendingStatus.textContent = 'There are no registrations awaiting permanent deletion.';
    return;
  }

  pendingStatus.textContent = `${rows.length} registration${rows.length === 1 ? '' : 's'} awaiting permanent deletion.`;
  for (const row of rows) {
    const item = document.createElement('article');
    item.className = 'pending-card';

    const details = document.createElement('div');
    const name = document.createElement('h3');
    const contact = document.createElement('p');
    const schedule = document.createElement('p');
    const restore = document.createElement('button');

    name.textContent = row.fullName;
    contact.textContent = `${row.phone} · “${row.nickname}”`;
    schedule.textContent = `Scheduled for permanent deletion ${formatDate(row.purgeAfter)}`;
    schedule.className = 'pending-date';
    restore.type = 'button';
    restore.className = 'restore-button';
    restore.textContent = new Date(row.purgeAfter).getTime() <= Date.now()
      ? 'PURGE DUE'
      : 'RESTORE RECORD';
    restore.disabled = new Date(row.purgeAfter).getTime() <= Date.now();
    restore.addEventListener('click', async () => {
      restore.disabled = true;
      try {
        await api(`/api/admin/submissions/${row.id}/restore`, { method: 'POST' });
        await Promise.all([loadEntries(), loadPendingDeletions()]);
      } catch (error) {
        pendingStatus.textContent = error.message;
        restore.disabled = false;
      }
    });

    details.append(name, contact, schedule);
    item.append(details, restore);
    pendingEntries.append(item);
  }
}

async function loadPendingDeletions() {
  pendingStatus.textContent = 'Checking pending deletions…';
  try {
    const result = await api('/api/admin/deleted-submissions');
    if (!Array.isArray(result.rows)) throw new Error('The pending-deletion response was not valid.');
    renderPendingDeletions(result.rows);
  } catch (error) {
    pendingEntries.replaceChildren();
    pendingStatus.textContent = error.message;
  }
}

function showArchiveView(view) {
  const isPending = view === 'pending';
  activeView.hidden = isPending;
  pendingView.hidden = !isPending;
  activeTab.classList.toggle('is-active', !isPending);
  pendingTab.classList.toggle('is-active', isPending);
  activeTab.setAttribute('aria-pressed', String(!isPending));
  pendingTab.setAttribute('aria-pressed', String(isPending));
  if (isPending) loadPendingDeletions();
}

function openEditDialog(row) {
  editForm.elements.fullName.value = row.fullName;
  editForm.elements.phone.value = row.phone;
  editForm.elements.nickname.value = row.nickname;
  editError.textContent = '';
  editForm.elements.fullName.setAttribute('aria-invalid', 'false');
  editForm.elements.phone.setAttribute('aria-invalid', 'false');
  editForm.elements.nickname.setAttribute('aria-invalid', 'false');
  recordDialog.close();
  editDialog.showModal();
}

function validateEditForm() {
  const fields = editForm.elements;
  const values = {
    fullName: fields.fullName.value.trim(),
    phone: fields.phone.value.trim(),
    nickname: fields.nickname.value.trim(),
  };
  const validation = [
    [fields.fullName, values.fullName.length >= 2 && values.fullName.length <= 100, 'Enter a full name between 2 and 100 characters.'],
    [fields.phone, /^\+?[0-9 ()-]{7,20}$/.test(values.phone), 'Enter a valid phone number.'],
    [fields.nickname, values.nickname.length >= 1 && values.nickname.length <= 50, 'Enter a nickname between 1 and 50 characters.'],
  ];

  for (const [field, valid, message] of validation) {
    field.setAttribute('aria-invalid', String(!valid));
    if (!valid) {
      editError.textContent = message;
      field.focus();
      return false;
    }
  }

  editError.textContent = '';
  return true;
}

editForm.addEventListener('input', (event) => {
  event.target.setAttribute('aria-invalid', 'false');
  editError.textContent = '';
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.textContent = '';
  const data = Object.fromEntries(new FormData(form));

  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify(data) });
    showDashboard();
  } catch (error) {
    loginError.textContent = error.message;
  }
});

searchInput.addEventListener('input', renderEntries);
dateFilter.addEventListener('change', renderEntries);
activeTab.addEventListener('click', () => showArchiveView('active'));
pendingTab.addEventListener('click', () => showArchiveView('pending'));

document.querySelector('#export').addEventListener('click', () => {
  window.location.href = '/api/admin/export.xlsx';
});

document.querySelector('#logout').addEventListener('click', async () => {
  try {
    await api('/api/admin/logout', { method: 'POST' });
    showLogin();
  } catch (error) {
    loginError.textContent = error.message;
  }
});

document.querySelector('#close-record').addEventListener('click', () => recordDialog.close());
recordDialog.addEventListener('click', (event) => {
  if (event.target === recordDialog) recordDialog.close();
});
document.querySelector('#edit-record').addEventListener('click', () => {
  if (currentRecord) openEditDialog(currentRecord);
});
document.querySelector('#delete-record').addEventListener('click', async () => {
  if (!currentRecord || !window.confirm(`Move ${currentRecord.fullName} to pending deletion? It can be restored until its scheduled purge date.`)) return;
  const button = document.querySelector('#delete-record');
  button.disabled = true;
  recordError.textContent = '';
  try {
    await api(`/api/admin/submissions/${currentRecord.id}`, { method: 'DELETE' });
    recordDialog.close();
    currentRecord = null;
    showArchiveView('active');
    await Promise.all([loadEntries(), loadPendingDeletions()]);
  } catch (error) {
    recordError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
document.querySelector('#cancel-edit').addEventListener('click', () => editDialog.close());
editDialog.addEventListener('click', (event) => {
  if (event.target === editDialog) editDialog.close();
});
editForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentRecord || !validateEditForm()) return;
  const saveButton = document.querySelector('#save-edit');
  saveButton.disabled = true;
  editError.textContent = '';
  const body = {
    ...Object.fromEntries(new FormData(editForm)),
    updatedAt: currentRecord.updatedAt,
  };
  try {
    await api(`/api/admin/submissions/${currentRecord.id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    editDialog.close();
    await loadEntries();
  } catch (error) {
    editError.textContent = error.message;
  } finally {
    saveButton.disabled = false;
  }
});

api('/api/admin/session')
  .then((data) => data.authenticated ? showDashboard() : showLogin())
  .catch(showLogin);
