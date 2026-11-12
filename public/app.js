const form = document.querySelector('#entry-form');
const fileInput = document.querySelector('#photo');
const drop = document.querySelector('#dropzone');
const preview = document.querySelector('#photo-preview');
const title = document.querySelector('#photo-title');
const hint = document.querySelector('#photo-hint');
const button = document.querySelector('#submit-button');
const label = document.querySelector('#submit-label');
const message = document.querySelector('#form-message');

let uploaded = null;
let previewUrl = null;

function showMessage(text, isError = true) {
  message.textContent = text;
  message.className = `form-message is-${isError ? 'error' : 'success'}`;
}

function setFieldError(id, text) {
  document.querySelector(`#${id}`).textContent = text;
}

function clearPhotoPreview() {
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
  preview.removeAttribute('src');
  drop.classList.remove('has-photo');
  title.textContent = 'Tap to upload your photo';
  hint.textContent = 'JPG/JPEG or PNG · Maximum 5 MB';
}

function validate() {
  for (const id of ['photo-error', 'name-error', 'phone-error', 'nickname-error']) {
    setFieldError(id, '');
  }

  let valid = true;
  if (!fileInput.files[0] && !uploaded) {
    setFieldError('photo-error', 'Choose a portrait before submitting.');
    valid = false;
  }

  const name = document.querySelector('#full-name').value.trim();
  const phone = document.querySelector('#phone').value.trim();
  const nickname = document.querySelector('#nickname').value.trim();

  if (name.length < 2) {
    setFieldError('name-error', 'Please enter your full name.');
    valid = false;
  }
  if (!/^\+?[0-9 ()-]{7,20}$/.test(phone)) {
    setFieldError('phone-error', 'Enter a valid phone number.');
    valid = false;
  }
  if (!nickname || nickname.length > 50) {
    setFieldError('nickname-error', 'Please enter a nickname.');
    valid = false;
  }
  if (!document.querySelector('#consent').checked) {
    showMessage('Please agree to the magazine use of your photo and details.');
    valid = false;
  }

  return valid;
}

fileInput.addEventListener('change', () => {
  uploaded = null;
  setFieldError('photo-error', '');

  const file = fileInput.files[0];
  if (!file) {
    clearPhotoPreview();
    return;
  }

  if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 5 * 1024 * 1024) {
    fileInput.value = '';
    clearPhotoPreview();
    setFieldError('photo-error', 'Choose a JPG/JPEG or PNG image that is 5 MB or smaller.');
    return;
  }

  clearPhotoPreview();
  previewUrl = URL.createObjectURL(file);
  preview.src = previewUrl;
  drop.classList.add('has-photo');
  title.textContent = file.name;
  hint.textContent = 'Selected · ready to upload';
});

for (const eventName of ['dragenter', 'dragover']) {
  drop.addEventListener(eventName, (event) => {
    event.preventDefault();
    drop.classList.add('is-dragging');
  });
}

for (const eventName of ['dragleave', 'drop']) {
  drop.addEventListener(eventName, (event) => {
    event.preventDefault();
    drop.classList.remove('is-dragging');
  });
}

drop.addEventListener('drop', (event) => {
  const file = event.dataTransfer.files[0];
  if (!file) return;

  const transfer = new DataTransfer();
  transfer.items.add(file);
  fileInput.files = transfer.files;
  fileInput.dispatchEvent(new Event('change'));
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.className = 'form-message';
  if (!validate()) return;

  button.disabled = true;
  try {
    if (!uploaded) {
      label.textContent = 'SECURING YOUR PORTRAIT…';
      const body = new FormData();
      body.append('photo', fileInput.files[0]);
      const response = await fetch('/api/upload', { method: 'POST', body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The photo could not be uploaded.');
      uploaded = data;
    }

    label.textContent = 'ADDING YOU TO THE ARCHIVE…';
    const payload = {
      fullName: document.querySelector('#full-name').value.trim(),
      phone: document.querySelector('#phone').value.trim(),
      nickname: document.querySelector('#nickname').value.trim(),
      photoId: uploaded.photoId,
      photoToken: uploaded.photoToken,
      consent: document.querySelector('#consent').checked,
      website: form.elements.website.value,
    };
    const response = await fetch('/api/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Your details could not be submitted.');

    clearPhotoPreview();
    form.innerHTML = `
      <div class="thanks">
        <span class="step-label">ENTRY RECEIVED · REF ${String(data.reference).padStart(4, '0')}</span>
        <h2>You’re part<br>of the record.</h2>
        <p class="entry-intro">Thanks for adding your story to the Klass of 2k26 magazine. Your details have been received by the class magazine team.</p>
      </div>
    `;
  } catch (error) {
    showMessage(error.message);
    button.disabled = false;
    label.textContent = 'TRY SUBMITTING AGAIN';
  }
});

window.addEventListener('pagehide', clearPhotoPreview, { once: true });
