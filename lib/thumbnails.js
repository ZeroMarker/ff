'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function createThumbnailCache({ directory, queue, ff }) {
  const pending = new Map();

  return function getThumbnail(input) {
    const real = fs.realpathSync(input);
    const st = fs.statSync(real);
    // Use a new namespace so incomplete caches from older versions are ignored.
    const cache = path.join(directory, ff.md5('v2:' + real + ':' + st.size + ':' + st.mtimeMs) + '.jpg');
    if (pending.has(cache)) return pending.get(cache);
    if (fs.existsSync(cache)) return Promise.resolve(cache);

    const task = queue.push(async () => {
      if (fs.existsSync(cache)) return cache;
      fs.mkdirSync(directory, { recursive: true });
      const temporary = path.join(directory, crypto.randomUUID() + '.tmp.jpg');
      try {
        const meta = ff.probe(real);
        const at = Math.min(1, Math.max(0, (meta.format.duration || 2) * 0.3));
        await ff.runFFmpegAsync(ff.buildThumbArgs(real, temporary, { at }).args, 240000);
        if (fs.statSync(temporary).size === 0) throw new Error('缩略图为空');
        fs.renameSync(temporary, cache);
        return cache;
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    }).finally(() => pending.delete(cache));
    pending.set(cache, task);
    return task;
  };
};
