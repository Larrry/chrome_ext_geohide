'use strict';

const list = document.getElementById('rules');
const template = document.getElementById('rowTemplate');
const state = document.getElementById('state');
const saveButton = document.getElementById('save');
const localeDefaults = ['en-US', 'en-GB', 'ru-RU', 'de-DE', 'fr-FR', 'es-ES', 'tr-TR', 'ja-JP'];
const timezoneDefaults = ['UTC', 'Europe/Moscow', 'Europe/Amsterdam', 'Europe/London', 'Europe/Berlin',
  'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Dubai', 'Europe/Istanbul'];
let usedLocales = [];
let usedTimezones = [];

function status(text, type = 'neutral') {
  state.textContent = text;
  state.dataset.type = type;
}
function normalizeDomain(value) {
  let raw = value.trim().toLowerCase().replace(/^\*\./, '');
  if (!raw) throw Error('Укажи домен.');
  if (!/^https?:\/\//.test(raw)) raw = `https://${raw}`;
  let url;
  try { url = new URL(raw); } catch { throw Error(`Некорректный домен: ${value}`); }
  const host = url.hostname.replace(/\.$/, '');
  if (!host || host.includes(':') || !/^[a-z0-9.-]+$/.test(host) ||
      host.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-')) ||
      host.length > 253) throw Error(`Некорректный домен: ${value}`);
  if (!host.includes('.') && host !== 'localhost') throw Error(`Нужен полный домен, например example.com: ${value}`);
  return host;
}
function normalizeLocale(value) {
  const input = value.trim();
  try { return Intl.getCanonicalLocales(input)[0] || 'en-US'; }
  catch { throw Error(`Некорректная локаль: ${value}`); }
}
function normalizeTimeZone(value) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone; }
  catch { throw Error(`Некорректный часовой пояс: ${value}`); }
}
function unique(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()))];
}
function fillDatalist(id, values) {
  const element = document.getElementById(id);
  element.replaceChildren(...values.map(value => {
    const option = document.createElement('option');
    option.value = value;
    return option;
  }));
}
function refreshSuggestions() {
  // Previously saved values first; suggestions after them. Never discard history.
  fillDatalist('locales', unique([...usedLocales, ...localeDefaults]));
  fillDatalist('timezones', unique([...usedTimezones, ...timezoneDefaults]));
}
function addRule(rule = { domain: '', locale: 'en-US', timezone: 'America/New_York', enabled: true }) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.querySelector('.domain').value = rule.domain;
  node.querySelector('.locale').value = rule.locale;
  node.querySelector('.timezone').value = rule.timezone;
  node.querySelector('.enabled').checked = rule.enabled !== false;
  node.querySelector('.delete').addEventListener('click', () => { node.remove(); showEmpty(); });
  list.appendChild(node);
  showEmpty();
  return node;
}
function showEmpty() { document.getElementById('empty').hidden = list.children.length > 0; }
function collectRules() {
  const rules = [], domains = new Set();
  for (const node of list.children) {
    const domain = normalizeDomain(node.querySelector('.domain').value);
    if (domains.has(domain)) throw Error(`Повторяющийся домен: ${domain}`);
    domains.add(domain);
    const locale = normalizeLocale(node.querySelector('.locale').value);
    const timezone = normalizeTimeZone(node.querySelector('.timezone').value);
    rules.push({ domain, locale, timezone, enabled: node.querySelector('.enabled').checked });
  }
  if (rules.length > 100) throw Error('Не более 100 правил.');
  return rules;
}
function scriptsAvailable() {
  return typeof chrome.userScripts?.getScripts === 'function';
}
async function load() {
  const { siteRules = [], usedLocales: locales = [], usedTimezones: timezones = [], globalEnabled = true } =
    await chrome.storage.local.get(['siteRules', 'usedLocales', 'usedTimezones', 'globalEnabled']);
  usedLocales = unique([...locales, ...siteRules.map(rule => rule.locale)]);
  usedTimezones = unique([...timezones, ...siteRules.map(rule => rule.timezone)]);
  refreshSuggestions();
  siteRules.forEach(addRule);
  showEmpty();
  if (!scriptsAvailable()) {
    status('Нужно включить Allow User Scripts: chrome://extensions → это расширение → Сведения. Затем нажми «Сохранить и применить».', 'warn');
  } else if (globalEnabled === false) {
    status('Общий выключатель в положении OFF. Правила сохранены, но не применяются.', 'warn');
  } else {
    status('User Scripts разрешён. Настройки готовы к редактированию.', 'good');
  }
}

document.getElementById('addButton').addEventListener('click', () => addRule().querySelector('.domain').focus());
saveButton.addEventListener('click', async () => {
  let rules;
  try { rules = collectRules(); } catch (error) { status(error.message, 'bad'); return; }
  const origins = [...new Set(rules.filter(rule => rule.enabled).map(rule =>
    rule.domain === 'localhost' ? '*://localhost/*' : `*://*.${rule.domain}/*`))];
  saveButton.disabled = true;
  try {
    // Request must originate in this user-click handler for Chrome's grant UI.
    if (origins.length) {
      const allowed = await chrome.permissions.request({ origins });
      if (!allowed) throw Error('Chrome не предоставил доступ к доменам. Настройки не изменены.');
    }
    usedLocales = unique([...rules.map(rule => rule.locale), ...usedLocales]);
    usedTimezones = unique([...rules.map(rule => rule.timezone), ...usedTimezones]);
    await chrome.storage.local.set({ siteRules: rules, usedLocales, usedTimezones });
    refreshSuggestions();
    const result = await chrome.runtime.sendMessage({ type: 'APPLY_SETTINGS', cleanupPermissions: true });
    if (result?.error) throw Error(result.error);
    const removed = result?.cleanup?.removed?.length || 0;
    const failed = result?.cleanup?.failed || [];
    const cleanupText = removed ? ` Удалено устаревших разрешений: ${removed}.` : '';
    if (failed.length) {
      status(`Сохранено. ${result.message}${cleanupText} Не удалось отозвать доступ: ${failed.join(', ')}. Можно удалить вручную в Chrome.`, 'warn');
    } else if (!result?.active && result?.globallyEnabled !== false) {
      status(`Сохранено. ${result.message}${cleanupText}`, 'warn');
    } else {
      status(`Сохранено. ${result.message}${cleanupText}`, 'good');
    }
  } catch (error) { status(`Ошибка: ${error.message}`, 'bad'); }
  finally { saveButton.disabled = false; }
});

load().catch(error => status(`Ошибка загрузки: ${error.message}`, 'bad'));
