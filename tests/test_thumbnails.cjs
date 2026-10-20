'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Queue = require('../lib/queue');
const createThumbnailCache = require('../lib/thumbnails');
const realFF = require('../lib/ffmpeg');

function fixture(t, limit = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-thumbnails-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'thumbs');
  const queue = new Queue(limit);
  const runs = [];
  const ff = {
    md5: realFF.md5,
    probe: () => ({ format: { duration: 2 } }),
    buildThumbArgs: realFF.buildThumbArgs,
    runFFmpegAsync(args) {
      const output = args.at(-1);
      fs.writeFileSync(output, 'PARTIAL');
      return new Promise((resolve, reject) => runs.push({
        output,
        finish() { fs.writeFileSync(output, 'COMPLETE'); resolve(); },
        fail() { reject(new Error('encoder failed')); },
      }));
    },
  };
  const get = createThumbnailCache({ directory, queue, ff });
  const input = (name) => {
    const file = path.join(root, name + '.mp4');
    fs.writeFileSync(file, 'video');
    return file;
  };
  return { root, directory, queue, runs, get, input };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('concurrent requests share generation and only publish a complete cache', async t => {
  const f = fixture(t);
  const input = f.input('source');
  const first = f.get(input);
  await tick();
  const second = f.get(input);
  assert.equal(first, second);
  assert.equal(f.runs.length, 1);
  assert.deepEqual(fs.readdirSync(f.directory), [path.basename(f.runs[0].output)]);
  let settled = false;
  second.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false, 'partial file must not satisfy the next request');
  f.runs[0].finish();
  const [cache, other] = await Promise.all([first, second]);
  assert.equal(cache, other);
  assert.equal(fs.readFileSync(cache, 'utf8'), 'COMPLETE');
  assert.deepEqual(fs.readdirSync(f.directory), [path.basename(cache)]);
  assert.equal(await f.get(input), cache);
  assert.equal(f.runs.length, 1, 'completed cache should avoid another encoder');
});

test('thumbnail work shares the queue concurrency limit with other tasks', async t => {
  const f = fixture(t, 1);
  let release;
  const other = f.queue.push(() => new Promise(resolve => { release = resolve; }));
  const first = f.get(f.input('one'));
  const second = f.get(f.input('two'));
  await tick();
  assert.equal(f.runs.length, 0);
  release();
  await other;
  await tick();
  assert.equal(f.runs.length, 1);
  f.runs[0].finish();
  await first;
  await tick();
  assert.equal(f.runs.length, 2);
  f.runs[1].finish();
  await second;
});

test('failed generation cleans up and permits a retry', async t => {
  const f = fixture(t);
  const input = f.input('source');
  const first = f.get(input);
  const second = f.get(input);
  const checked = Promise.all([
    assert.rejects(first, /encoder failed/),
    assert.rejects(second, /encoder failed/),
  ]);
  await tick();
  f.runs[0].fail();
  await checked;
  assert.deepEqual(fs.readdirSync(f.directory), []);
  const retry = f.get(input);
  await tick();
  assert.equal(f.runs.length, 2);
  f.runs[1].finish();
  assert.equal(fs.readFileSync(await retry, 'utf8'), 'COMPLETE');
});
