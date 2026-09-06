'use client';
// 轻量 toast（移植 app.js toast() L4418-4421：底部居中，2.6s 自动消失）
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function toast(msg: string): void {
  if (typeof document === 'undefined') return;
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t && t.classList.add('hidden'), 2600);
}
