'use strict';

// Run with: node --test tests/test_web_export.cjs (requires ffmpeg/ffprobe).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ff = require('../lib/ffmpeg');

let dir, source, image;
function run(args) {
  const result = spawnSync(ff.FFMPEG, ['-v', 'error', '-y', ...args], { encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result;
}
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-export-test-'));
  source = path.join(dir, 'source.mp4');
  image = path.join(dir, 'red.png');
  run(['-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', source]);
  run(['-f', 'lavfi', '-i', 'color=c=red:s=80x40', '-frames:v', '1', '-threads', '1', image]);
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function render(name, params) {
  const output = path.join(dir, name + '.' + (params.format || 'mp4'));
  const built = ff.buildExportArgs(source, output, params);
  try { run(built.args); } finally {
    for (const file of built.tempFiles) fs.rmSync(file, { force: true });
  }
  return { output, meta: ff.probe(output) };
}
function frame(file) {
  const result = spawnSync(ff.FFMPEG, ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}
function pixel(data, width, x, y) {
  const offset = (y * width + x) * 3;
  return [...data.subarray(offset, offset + 3)];
}
const text = { type: 'text', text: 'Hello', x: 40, y: 30, size: 24, color: '#ffffff' };

test('full export retains the source video and audio', () => {
  const { meta } = render('full', { start: 0, end: null, format: 'mp4' });
  assert.ok(meta.format.duration >= 1);
  assert.equal(meta.video.codec, 'h264');
  assert.equal(meta.audio.codec, 'aac');
});

test('rotated text renders visible glyphs on a transparent layer and terminates', () => {
  const { output, meta } = render('rotated', { start: 0, end: null, overlays: [{ ...text, rotation: 30 }] });
  assert.ok(meta.format.duration >= 1 && meta.format.duration < 1.2);
  const pixels = frame(output);
  const corner = pixel(pixels, 320, 300, 160);
  assert.ok(corner[2] > 200 && corner[0] < 20, 'transparent layer must preserve the blue background');
  let white = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    if (pixels[i] > 180 && pixels[i + 1] > 180 && pixels[i + 2] > 180) white++;
  }
  assert.ok(white > 40, 'rotated glyphs must be visible');
});

test('WebM overlays use compatible video and audio codecs', () => {
  const { meta } = render('webm', { start: 0, end: 1, format: 'webm', overlays: [text] });
  assert.equal(meta.video.codec, 'vp9');
  assert.equal(meta.audio.codec, 'opus');
});

test('resized image overlays retain normalized bounds', () => {
  const { output, meta } = render('image', { start: 0, end: 1, height: 90, overlays: [{ type: 'image', file: image, x: 0.5, y: 0.5, w: 0.25, h: 0.25 }] });
  assert.equal(meta.video.width, 160);
  assert.equal(meta.video.height, 90);
  const pixels = frame(output);
  const inside = pixel(pixels, 160, 100, 55);
  const outside = pixel(pixels, 160, 60, 55);
  assert.ok(inside[0] > 200 && inside[2] < 30, 'expected red overlay at scaled coordinates');
  assert.ok(outside[2] > 200 && outside[0] < 30, 'expected blue outside overlay');
});

test('text coordinates and font size scale with the output frame', () => {
  const large = render('text-large', { start: 0, end: 1, overlays: [{ ...text, x: 160, y: 90 }] });
  const small = render('text-small', { start: 0, end: 1, height: 90, overlays: [{ ...text, x: 160, y: 90 }] });
  function bounds(output, width) {
    const pixels = frame(output);
    let minX = width, minY = Infinity, maxX = -1, maxY = -1;
    for (let i = 0; i < pixels.length; i += 3) {
      if (pixels[i] > 180 && pixels[i + 1] > 180) {
        const x = (i / 3) % width, y = Math.floor(i / 3 / width);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    assert.ok(maxX >= 0, 'text must be visible');
    return { minX, minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }
  const a = bounds(large.output, 320), b = bounds(small.output, 160);
  for (const key of ['minX', 'minY', 'width', 'height']) assert.ok(Math.abs(b[key] - a[key] / 2) <= 3, key);
});
