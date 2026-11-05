'use strict';
const current = document.getElementById('current');
const switcher = document.getElementById('globalEnabled');
const switchTitle = document.getElementById('switchTitle');
const message = document.getElementById('message');
let currentHost = '';

document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

async function render() {
  const { siteRules = [], globalEnabled = true } = await chrome.storage.local.get(['siteRules', 'globalEnabled']);
  switcher.checked = globalEnabled !== false;
  switchTitle.textContent = switcher.checked ? 'Расширение включено' : 'Расширение выключено';
  current.classList.toggle('off', !switcher.checked);
  if (!switcher.checked) {
    current.textContent = 'Подмена выключена на всех сайтах';
    return;
  }
  const host = currentHost;
  const rule = siteRules.filter(item => item.enabled !== false &&
    (host === item.domain || host.endsWith('.' + item.domain)))
    .sort((a, b) => b.domain.length - a.domain.length)[0];
  current.textContent = rule
    ? `${host}\n${rule.locale} · ${rule.timezone}`
    : `${host || 'Текущая вкладка'}: нет активного правила`;
}

switcher.addEventListener('change', async () => {
  switcher.disabled = true;
  message.textContent = '';
  try {
    await chrome.storage.local.set({ globalEnabled: switcher.checked });
    const result = await chrome.runtime.sendMessage({ type: 'APPLY_SETTINGS' });
    if (result?.error) throw Error(result.error);
    if (switcher.checked && !result?.active) message.textContent = result?.message || 'Не удалось включить подмену';
  } catch (error) {
    message.textContent = `Ошибка: ${error.message}`;
  } finally {
    try { await render(); } catch (error) { message.textContent = `Ошибка: ${error.message}`; }
    switcher.disabled = false;
  }
});

(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentHost = tab?.url ? new URL(tab.url).hostname.toLowerCase() : '';
  } catch (_error) { /* chrome:// pages and tabs without a URL */ }
  await render();
})().catch(error => { current.textContent = `Ошибка загрузки: ${error.message}`; });
