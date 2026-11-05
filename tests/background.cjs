'use strict';
const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const inject = fs.readFileSync(path.join(root, 'inject.js'), 'utf8');
const store = {
  siteRules: [
    {domain:'example.com',locale:'en-US',timezone:'America/New_York',enabled:true},
    {domain:'sub.example.com',locale:'ru-RU',timezone:'Europe/Moscow',enabled:true},
    {domain:'disabled.org',locale:'de-DE',timezone:'Europe/Berlin',enabled:false}
  ]
};
let dynamicRules = [];
let scripts = [];
let badge = '', badgeColor, badgeTitle;
let allowedOrigins = ['*://*.example.com/*', '*://*.sub.example.com/*', '*://*.disabled.org/*',
  '*://*.deleted.com/*', 'https://retired.net/*', '*://*/*'];
let listener, onInstalled, onStartup;
const chrome = {
  storage: { local: {get: async keys => {
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter(key => key in store).map(key => [key, store[key]]));
    return keys in store ? { [keys]: store[keys] } : {};
  } } },
  userScripts: {
    getScripts: async ({ids}={}) => ids ? scripts.filter(script => ids.includes(script.id)) : scripts,
    register: async definitions => { scripts.push(...definitions); },
    update: async definitions => { for (const def of definitions) scripts[scripts.findIndex(s => s.id === def.id)] = def; },
    unregister: async ({ids}) => { scripts = scripts.filter(s => !ids.includes(s.id)); }
  },
  declarativeNetRequest: {
    getDynamicRules: async () => dynamicRules,
    updateDynamicRules: async ({removeRuleIds=[],addRules=[]}) => {
      dynamicRules = dynamicRules.filter(rule => !removeRuleIds.includes(rule.id)).concat(addRules);
    }
  },
  action: {
    setBadgeText: async ({text}) => { badge = text; },
    setBadgeBackgroundColor: async ({color}) => { badgeColor = color; },
    setTitle: async ({title}) => { badgeTitle = title; }
  },
  permissions: {
    getAll: async () => ({origins:[...allowedOrigins]}),
    remove: async ({origins}) => {
      const origin = origins[0];
      if (!allowedOrigins.includes(origin)) return false;
      allowedOrigins = allowedOrigins.filter(value => value !== origin);
      return true;
    }
  },
  runtime: {
    getURL: () => 'chrome-extension://mock/inject.js',
    onInstalled: {addListener: fn => {onInstalled=fn;}},
    onStartup: {addListener: fn => {onStartup=fn;}},
    onMessage: {addListener: fn => {listener=fn;}}
  }
};
const context = vm.createContext({chrome,console,fetch:async () => ({ok:true,text:async () => inject})});
vm.runInContext(source, context);
function apply(cleanupPermissions=false) {
  return new Promise((resolve, reject) => {
    const isAsync = listener({type:'APPLY_SETTINGS',cleanupPermissions}, null, resolve);
    assert.equal(isAsync, true);
    setTimeout(() => reject(new Error('apply timeout')), 1500).unref();
  });
}
(async () => {
  // Migration: no globalEnabled key means ON, script still starts at document_start.
  const status = await apply(true);
  assert.equal(status.active,true);
  assert.equal(status.globallyEnabled,true);
  assert.equal(status.count,2);
  assert.equal(badge,'');
  assert.equal(badgeColor,'#D72D36');
  assert.equal(scripts.length,1);
  assert.equal(scripts[0].world,'MAIN');
  assert.equal(scripts[0].runAt,'document_start');
  assert.equal(scripts[0].allFrames,true);
  assert.equal(dynamicRules.length,4);
  assert.equal(dynamicRules[0].condition.requestDomains.join(),'sub.example.com');
  assert.equal(dynamicRules[1].condition.regexFilter,'^https?://');
  assert.equal(dynamicRules[0].action.requestHeaders[0].value,'ru-RU,ru;q=0.9');
  assert.ok(scripts[0].js[0].code.includes('installLocaleSpoof(rule)'));
  assert.ok(status.cleanup.removed.length === 3);
  assert.deepEqual(allowedOrigins, ['*://*.example.com/*', '*://*.sub.example.com/*', '*://*.disabled.org/*']);
  // Confirm that a user page receives the spoofed settings.
  const page = vm.createContext({navigator:{language:'en-GB',languages:['en-GB']},location:{hostname:'sub.example.com'}});
  vm.runInContext(scripts[0].js[0].code,page);
  assert.equal(vm.runInContext('navigator.language',page),'ru-RU');
  assert.equal(vm.runInContext('Intl.DateTimeFormat().resolvedOptions().timeZone',page),'Europe/Moscow');

  // Whole-extension OFF: user script AND DNR are removed, red OFF badge.
  store.globalEnabled = false;
  const off = await apply();
  assert.equal(off.active,false);
  assert.equal(off.globallyEnabled,false);
  assert.equal(badge,'OFF');
  assert.match(badgeTitle,/выключено/);
  assert.equal(scripts.length,0);
  assert.equal(dynamicRules.length,0);
  assert.equal(allowedOrigins.length,3); // no revocation for merely disabled extension

  // Re-enable: persist same host rules, no new permission requests necessary.
  store.globalEnabled = true;
  const on = await apply();
  assert.equal(on.count,2);
  assert.equal(badge,'');
  assert.equal(scripts.length,1);
  assert.equal(dynamicRules.length,4);

  // Deleting a domain revokes its old Chrome host access, but saved disabled stays.
  store.siteRules = store.siteRules.filter(rule => rule.domain !== 'sub.example.com');
  const deleted = await apply(true);
  assert.equal(deleted.count,1);
  assert.deepEqual(Array.from(deleted.cleanup.removed),['*://*.sub.example.com/*']);
  assert.deepEqual(allowedOrigins, ['*://*.example.com/*','*://*.disabled.org/*']);
  assert.equal(dynamicRules.length,2);

  store.siteRules = [];
  const empty = await apply(true);
  assert.equal(empty.count,0);
  assert.equal(scripts.length,0);
  assert.equal(dynamicRules.length,0);
  assert.deepEqual(allowedOrigins,[]);
  assert.equal(badge,'');
  assert.ok(onInstalled && onStartup);
  console.log('OK — global OFF/ON, badge, early MAIN injection, rules, permission cleanup incl. disabled domains');
})().catch(error=>{console.error(error);process.exitCode=1;});
