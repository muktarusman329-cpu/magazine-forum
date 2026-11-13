const maxPhotoBytes = 5 * 1024 * 1024;

async function readPhoto(response) {
  if (!response.body) throw new Error('Portrait download returned no content.');

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxPhotoBytes) {
        await reader.cancel();
        throw new Error('Portrait download exceeded the size limit.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  if (!totalBytes) throw new Error('Portrait download was empty.');
  return Buffer.concat(chunks, totalBytes);
}

export async function downloadExportPhoto(photoPublicId, cloudinary, fetchImpl = fetch, signal) {
  const url = cloudinary.utils.private_download_url(photoPublicId, 'jpg', {
    resource_type: 'image',
    type: 'authenticated',
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
  });
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetchImpl(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    throw new Error(`Portrait download failed with HTTP ${response.status}.`);
  }

  return readPhoto(response);
}
