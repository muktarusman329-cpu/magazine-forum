import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { downloadExportThumbnail, thumbnailSize } from '../lib/export-photo.js';

test('downloadExportThumbnail creates a bounded square JPEG from the private photo', async () => {
  const source = await sharp({
    create: { width: 40, height: 20, channels: 3, background: '#0c4b38' },
  }).jpeg().toBuffer();
  let downloadOptions;
  const thumbnail = await downloadExportThumbnail(
    'klass-2k26/submissions/example',
    {
      utils: {
        private_download_url: (photoId, format, options) => {
          assert.equal(photoId, 'klass-2k26/submissions/example');
          assert.equal(format, 'jpg');
          assert.equal(options.type, 'authenticated');
          return 'https://photos.example/private.jpg';
        },
      },
    },
    async (url, options) => {
      assert.equal(url, 'https://photos.example/private.jpg');
      downloadOptions = options;
      return { ok: true, arrayBuffer: async () => source };
    },
  );

  assert.ok(downloadOptions.signal);
  const metadata = await sharp(thumbnail).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.width, thumbnailSize);
  assert.equal(metadata.height, thumbnailSize);
});

test('an exported workbook can embed and reopen a portrait thumbnail', async () => {
  const source = await sharp({
    create: { width: 20, height: 20, channels: 3, background: '#c5a15e' },
  }).jpeg().toBuffer();
  const thumbnail = await downloadExportThumbnail(
    'klass-2k26/submissions/example',
    { utils: { private_download_url: () => 'https://photos.example/private.jpg' } },
    async () => ({ ok: true, arrayBuffer: async () => source }),
  );
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Magazine submissions');
  sheet.columns = [{ header: 'Reference', key: 'id' }, { header: 'Portrait', key: 'portrait' }];
  sheet.addRow({ id: 1 });
  sheet.getRow(2).height = 88;
  const imageId = workbook.addImage({ buffer: thumbnail, extension: 'jpeg' });
  sheet.addImage(imageId, {
    tl: { col: 1, row: 1 },
    ext: { width: thumbnailSize, height: thumbnailSize },
  });

  const exported = Buffer.from(await workbook.xlsx.writeBuffer());
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(exported);
  assert.equal(reopened.getWorksheet('Magazine submissions').getImages().length, 1);
});

test('downloadExportThumbnail reports unavailable private photos', async () => {
  await assert.rejects(
    downloadExportThumbnail(
      'klass-2k26/submissions/unavailable',
      { utils: { private_download_url: () => 'https://photos.example/private.jpg' } },
      async () => ({ ok: false, status: 404 }),
    ),
    /HTTP 404/,
  );
});
