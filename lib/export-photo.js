import sharp from 'sharp';

const maxPhotoBytes = 5 * 1024 * 1024;
const thumbnailSize = 112;

export async function downloadExportThumbnail(photoPublicId, cloudinary, fetchImpl = fetch) {
  const url = cloudinary.utils.private_download_url(photoPublicId, 'jpg', {
    resource_type: 'image',
    type: 'authenticated',
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
  });
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Portrait download failed with HTTP ${response.status}.`);
  }

  const source = Buffer.from(await response.arrayBuffer());
  if (!source.length || source.length > maxPhotoBytes) {
    throw new Error('Portrait download was empty or exceeded the size limit.');
  }

  return sharp(source, { limitInputPixels: 25_000_000 })
    .rotate()
    .resize(thumbnailSize, thumbnailSize, { fit: 'cover' })
    .jpeg({ quality: 72, mozjpeg: true })
    .toBuffer();
}

export { thumbnailSize };
