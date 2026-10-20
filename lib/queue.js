'use strict';

class Queue {
  constructor(limit) { this.limit = limit; this.running = 0; this.waiting = []; }
  push(fn) {
    return new Promise((resolve, reject) => {
      this.waiting.push({ fn, resolve, reject });
      this.pump();
    });
  }
  pump() {
    if (this.running >= this.limit || !this.waiting.length) return;
    this.running++;
    const { fn, resolve, reject } = this.waiting.shift();
    Promise.resolve().then(fn).then(
      (v) => { this.running--; this.pump(); resolve(v); },
      (e) => { this.running--; this.pump(); reject(e); },
    );
  }
}

module.exports = Queue;
