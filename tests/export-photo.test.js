import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { ZipArchive } from 'archiver';
import ExcelJS from 'exceljs';
import { PassThrough, Readable } from 'node:stream';
import { downloadExportPhoto } from '../lib/export-photo.js';

test('downloadExportPhoto retrieves the authenticated full-size JPEG', async () => {
  const photo = Buffer.from('full-size-jpeg-data');
  let downloadOptions;
  const downloaded = await downloadExportPhoto(
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
      return { ok: true, body: Readable.toWeb(Readable.from([photo])) };
    },
  );

  assert.ok(downloadOptions.signal);
  assert.deepEqual(downloaded, photo);
});

test('photo archives contain separate spreadsheet and portrait files', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Magazine submissions');
  sheet.columns = [{ header: 'Reference', key: 'id' }, { header: 'Portrait file', key: 'portrait' }];
  sheet.addRow({ id: 123, portrait: 'portraits/123.jpg' });
  const spreadsheet = await workbook.xlsx.writeBuffer();
  const archive = new ZipArchive({ zlib: { level: 0 } });
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk));
  archive.pipe(output);
  archive.append(Buffer.from(spreadsheet), { name: 'submissions.xlsx' });
  archive.append(Buffer.from('full-size-jpeg'), { name: 'portraits/123.jpg' });
  const finished = once(output, 'end');

  await archive.finalize();
  await finished;
  const contents = Buffer.concat(chunks).toString('latin1');
  assert.ok(contents.includes('submissions.xlsx'));
  assert.ok(contents.includes('portraits/123.jpg'));
  assert.ok(contents.includes('full-size-jpeg'));
});

test('downloadExportPhoto reports unavailable private photos', async () => {
  await assert.rejects(
    downloadExportPhoto(
      'klass-2k26/submissions/unavailable',
      { utils: { private_download_url: () => 'https://photos.example/private.jpg' } },
      async () => ({ ok: false, status: 404 }),
    ),
    /HTTP 404/,
  );
});

test('downloadExportPhoto stops responses larger than the upload limit', async () => {
  const oversizedPhoto = Buffer.alloc(5 * 1024 * 1024 + 1);
  await assert.rejects(
    downloadExportPhoto(
      'klass-2k26/submissions/oversized',
      { utils: { private_download_url: () => 'https://photos.example/private.jpg' } },
      async () => ({ ok: true, body: Readable.toWeb(Readable.from([oversizedPhoto])) }),
    ),
    /exceeded the size limit/,
  );
});
