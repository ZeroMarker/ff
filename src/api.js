/* src/api.js — 后端 API 封装（仅请求本机后端，无任何 URL 输入入口） */
const TOKEN_KEY = 'ff_token';
export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);

/* 相对路径：兼容 Caddy handle_path 前缀剥离部署；本地开发(/)下等价 */
export const rel = (p) => './' + String(p || '').replace(/^\/+/g, '');

export async function api(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const t = getToken();
  if (t) headers['x-auth-token'] = t;
  const res = await fetch(rel(url), { ...opts, headers });
  if (res.status === 401) throw new Error('需要访问口令');
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

/** 带进度回调的上传（本地文件 -> 服务器） */
export function uploadFile(url, field, file, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append(field, file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', rel(url));
    const t = getToken();
    if (t) xhr.setRequestHeader('x-auth-token', t);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(fd);
  });
}

export const fmtSize = (b) => {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 ? 0 : 1) + ' ' + u[i];
};

export const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
  return `${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
};

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const toast = (msg, type = 'info') => {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
};