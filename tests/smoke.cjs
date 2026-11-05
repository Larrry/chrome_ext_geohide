'use strict';
const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const src = fs.readFileSync(__dirname + '/../inject.js', 'utf8');

function createProfile(locale, timezone) {
  const ctx = vm.createContext({ navigator: { language: 'ru-RU', languages: ['ru-RU'] } });
  vm.runInContext(`${src}\ninstallLocaleSpoof(${JSON.stringify({ locale, timezone })});`, ctx);
  return command => vm.runInContext(command, ctx);
}
const ny = createProfile('en-US', 'America/New_York');
assert.equal(ny('navigator.language'), 'en-US');
assert.equal(ny('navigator.languages.join()'), 'en-US,en');
assert.equal(ny('Intl.DateTimeFormat().resolvedOptions().timeZone'), 'America/New_York');
assert.equal(ny('Intl.NumberFormat().resolvedOptions().locale'), 'en-US');
assert.equal(ny('Intl.Collator().resolvedOptions().locale'), 'en-US');
assert.equal(ny('new Date("2026-01-01T12:00:00Z").getHours()'), 7);
assert.equal(ny('new Date("2026-07-01T12:00:00Z").getHours()'), 8);
assert.equal(ny('new Date("2026-01-01T12:00:00Z").getTimezoneOffset()'), 300);
assert.equal(ny('new Date("2026-07-01T12:00:00Z").getTimezoneOffset()'), 240);
assert.equal(ny('new Date(2026,0,1,12,0).toISOString()'), '2026-01-01T17:00:00.000Z');
assert.equal(ny('new Date(2026,6,1,12,0).toISOString()'), '2026-07-01T16:00:00.000Z');
assert.equal(ny('new Date("2026-07-01T12:00:00").toISOString()'), '2026-07-01T16:00:00.000Z');
assert.equal(ny('Date.parse("2026-07-01T12:00:00")'), Date.parse('2026-07-01T16:00:00Z'));
assert.equal(ny('new Date(2026,2,8,2,30).toISOString()'), '2026-03-08T07:30:00.000Z');
assert.equal(ny('new Date(2026,10,1,1,30).toISOString()'), '2026-11-01T05:30:00.000Z');
assert.equal(ny('new Date("2026-01-01T12:00:00Z").toDateString()'), 'Thu Jan 01 2026');
assert.equal(ny('new Date("2026-01-01T12:00:00Z").toString().includes("GMT-0500")'), true);
assert.equal(ny('new Date("bad").toString()'), 'Invalid Date');
assert.equal(ny('new Date(2026,0,1,12,0).toLocaleString("en-US",{timeZone:"UTC"}).includes("12:00")'), false); // 17:00 UTC
assert.equal(ny('new Date(2026,0,1,12,0).toLocaleString("en-US",{timeZone:"UTC"}).includes("5:00")'), true);
const d1 = ny('(() => { const d=new Date("2026-01-01T12:00:00Z"); d.setHours(9); return d.toISOString(); })()');
assert.equal(d1, '2026-01-01T14:00:00.000Z');
const mos = createProfile('ru-RU', 'Europe/Moscow');
assert.equal(mos('Intl.DateTimeFormat().resolvedOptions().locale'), 'ru-RU');
assert.equal(mos('new Date("2026-01-01T12:00:00Z").getHours()'), 15);
assert.equal(mos('new Date("2026-01-01T12:00:00Z").getTimezoneOffset()'), -180);
assert.equal(mos('new Date(2026,0,1,12,0).toISOString()'), '2026-01-01T09:00:00.000Z');
assert.equal(mos('new Date(2026,0,1).getDate()'), 1);
assert.equal(mos('new Date(2026,0,1).getDay()'), 4);
assert.equal(mos('typeof new Date().toLocaleDateString()'), 'string');
console.log('OK — Intl, navigator, Date, DST overlap/gap, setters and locale formatting');
