'use strict';

// Keep the v1.0 injection mechanism: registered userScripts are persistent and
// are injected at document_start independently of service-worker start-up.
const SCRIPT_ID = 'domain-locale-timezone';
const STORAGE_KEY = 'siteRules';
const ENABLED_KEY = 'globalEnabled';
const RULES_START = 1000;
const RULES_END = 20000;

function matchPattern(domain) {
  return domain === 'localhost' ? '*://localhost/*' : `*://*.${domain}/*`;
}
function headerFor(locale) {
  const base = locale.split('-')[0];
  return base === locale ? locale : `${locale},${base};q=0.9`;
}

let applying = Promise.resolve();
function applySettings({ cleanupPermissions = false } = {}) {
  // Serialize startup, options and popup operations. No competing DNR updates.
  applying = applying.catch(() => {}).then(async () => {
    const result = await syncSettings();
    if (cleanupPermissions) {
      const { siteRules = [] } = await chrome.storage.local.get(STORAGE_KEY);
      result.cleanup = await pruneHostPermissions(siteRules);
    }
    return result;
  });
  return applying;
}

async function updateBadge(isEnabled) {
  await chrome.action.setBadgeBackgroundColor({ color: '#D72D36' });
  await chrome.action.setBadgeText({ text: isEnabled ? '' : 'OFF' });
  await chrome.action.setTitle({
    title: isEnabled ? 'Domain Locale & Timezone — включено' : 'Domain Locale & Timezone — выключено'
  });
}

async function clearOurRules() {
  const old = (await chrome.declarativeNetRequest.getDynamicRules())
    .filter(rule => rule.id >= RULES_START && rule.id < RULES_END)
    .map(rule => rule.id);
  if (old.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old });
  }
}

async function unregisterOurScript() {
  try {
    if (!chrome.userScripts?.getScripts) return;
    const existing = await chrome.userScripts.getScripts({ ids: [SCRIPT_ID] });
    if (existing.length) await chrome.userScripts.unregister({ ids: [SCRIPT_ID] });
  } catch (_error) {
    // Chrome can hide userScripts API until Allow User Scripts is enabled.
  }
}

async function syncSettings() {
  const stored = await chrome.storage.local.get([STORAGE_KEY, ENABLED_KEY]);
  const globallyEnabled = stored[ENABLED_KEY] !== false; // Migration from v1.0: ON.
  await updateBadge(globallyEnabled);

  if (!globallyEnabled) {
    await unregisterOurScript();
    await clearOurRules();
    return { active: false, globallyEnabled: false, count: 0,
      message: 'Расширение выключено для всех сайтов. Обновите открытые вкладки.' };
  }

  const sites = (stored[STORAGE_KEY] || []).filter(entry => entry.enabled !== false);
  let scriptsApiIsActive = false;
  try {
    if (chrome.userScripts?.getScripts) {
      await chrome.userScripts.getScripts();
      scriptsApiIsActive = true;
    }
  } catch (_error) { /* Allow User Scripts is disabled */ }
  if (!scriptsApiIsActive) {
    await clearOurRules();
    return { active: false, globallyEnabled: true, count: 0,
      message: 'Включите Allow User Scripts на странице сведений о расширении.' };
  }

  const existing = await chrome.userScripts.getScripts({ ids: [SCRIPT_ID] });
  if (!sites.length) {
    if (existing.length) await chrome.userScripts.unregister({ ids: [SCRIPT_ID] });
    await clearOurRules();
    return { active: true, globallyEnabled: true, count: 0,
      message: 'Нет активных правил для сайтов.' };
  }

  // Keep proven v1.0 source loading; it runs only when registering/updating,
  // NOT on every navigation. Chrome performs the subsequent early injections.
  const response = await fetch(chrome.runtime.getURL('inject.js'));
  if (!response.ok) throw Error('Не удалось загрузить inject.js');
  const source = await response.text();
  const profileData = sites.map(({ domain, locale, timezone }) => ({ domain, locale, timezone }));
  const code = `${source}\n;(() => {
    const sites = ${JSON.stringify(profileData)};
    const host = location.hostname.toLowerCase();
    const rule = sites.filter(s => host === s.domain || host.endsWith('.' + s.domain))
      .sort((a, b) => b.domain.length - a.domain.length)[0];
    if (rule) installLocaleSpoof(rule);
  })();`;
  const definition = {
    id: SCRIPT_ID,
    matches: [...new Set(sites.map(s => matchPattern(s.domain)))],
    js: [{ code }],
    world: 'MAIN',
    allFrames: true,
    runAt: 'document_start'
  };
  if (existing.length) await chrome.userScripts.update([definition]);
  else await chrome.userScripts.register([definition]);

  const rules = [];
  const sorted = [...sites].sort((a, b) => b.domain.length - a.domain.length);
  for (let index = 0; index < sorted.length; index++) {
    const entry = sorted[index];
    const priority = 100 + entry.domain.length;
    const action = {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Accept-Language', operation: 'set', value: headerFor(entry.locale) }]
    };
    rules.push({
      id: RULES_START + index * 2, priority, action,
      condition: { requestDomains: [entry.domain], resourceTypes: ['main_frame', 'sub_frame'] }
    });
    rules.push({
      id: RULES_START + index * 2 + 1, priority, action,
      condition: {
        initiatorDomains: [entry.domain],
        excludedResourceTypes: ['main_frame', 'sub_frame'],
        regexFilter: '^https?://'
      }
    });
  }
  const oldIds = (await chrome.declarativeNetRequest.getDynamicRules())
    .filter(rule => rule.id >= RULES_START && rule.id < RULES_END)
    .map(rule => rule.id);
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: oldIds, addRules: rules });
  return { active: true, globallyEnabled: true, count: sites.length,
    message: `Активных доменов: ${sites.length}. Обновите открытые вкладки.` };
}

function hostnameFromOriginPattern(pattern) {
  // Only touch normal optional HTTP(S) grants managed by this extension.
  // getAll() can return a scheme-specific grant instead of the original *://.
  const match = /^(?:\*|https?):\/\/(\*\.)?([^/]+)\//i.exec(pattern);
  if (!match) return null;
  return match[2].toLowerCase().replace(/\.$/, '');
}

async function pruneHostPermissions(siteRules) {
  // Disabled but SAVED domains keep their grants. Deleted/renamed ones do not.
  const keep = new Set(siteRules.map(rule => rule.domain));
  const all = await chrome.permissions.getAll();
  const obsolete = (all.origins || []).filter(origin => {
    const host = hostnameFromOriginPattern(origin);
    return host !== null && !keep.has(host);
  });
  const removed = [];
  const failed = [];
  for (const origin of obsolete) {
    try {
      if (await chrome.permissions.remove({ origins: [origin] })) removed.push(origin);
      else failed.push(origin);
    } catch (error) {
      failed.push(`${origin} (${error.message})`);
    }
  }
  return { removed, failed };
}

chrome.runtime.onInstalled.addListener(() => {
  applySettings({ cleanupPermissions: true }).catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  applySettings({ cleanupPermissions: true }).catch(console.error);
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'APPLY_SETTINGS') return false;
  applySettings({ cleanupPermissions: message.cleanupPermissions === true })
    .then(sendResponse, error => sendResponse({ error: error.message }));
  return true;
});
