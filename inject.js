/* Runs only in matching pages, in the MAIN world at document_start.
 * This function is injected together with a serialized site profile.
 * No network calls, telemetry, or extension messaging occur on pages.
 */
function installLocaleSpoof(profile) {
  'use strict';

  const locale = profile.locale;
  const timeZone = profile.timezone;
  const NativeDate = Date;
  const NativeIntl = Intl;
  const dateProto = NativeDate.prototype;
  const native = {
    getTime: dateProto.getTime,
    getUTCMilliseconds: dateProto.getUTCMilliseconds,
    setTime: dateProto.setTime,
    setUTCFullYear: dateProto.setUTCFullYear,
    setUTCHours: dateProto.setUTCHours,
    toLocaleString: dateProto.toLocaleString,
    toLocaleDateString: dateProto.toLocaleDateString,
    toLocaleTimeString: dateProto.toLocaleTimeString,
    numberToLocale: Number.prototype.toLocaleString,
    stringLocaleCompare: String.prototype.localeCompare,
    stringToLocaleLowerCase: String.prototype.toLocaleLowerCase,
    stringToLocaleUpperCase: String.prototype.toLocaleUpperCase,
    bigintToLocale: typeof BigInt === 'function' ? BigInt.prototype.toLocaleString : null
  };

  // Prefer changing an existing prototype getter over adding a tell-tale own property.
  function replaceNavigatorGetter(key, result) {
    let target = navigator;
    while (target) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor && descriptor.configurable) {
        try {
          Object.defineProperty(target, key, { configurable: true, enumerable: descriptor.enumerable, get: () => result });
          return;
        } catch (_error) { break; }
      }
      if (descriptor && !descriptor.configurable) break;
      target = Object.getPrototypeOf(target);
    }
    try { Object.defineProperty(navigator, key, { configurable: true, get: () => result }); }
    catch (_error) { /* A non-configurable browser object cannot be overridden. */ }
  }

  replaceNavigatorGetter('language', locale);
  replaceNavigatorGetter('languages', Object.freeze([locale, locale.split('-')[0]].filter((item, i, items) => items.indexOf(item) === i)));
  for (const key of ['userLanguage', 'browserLanguage', 'systemLanguage']) {
    if (key in navigator) replaceNavigatorGetter(key, locale);
  }

  // Patch default Intl locale everywhere that the page can directly construct a formatter.
  // Explicitly supplied locales remain explicit, as required by the Web Intl APIs.
  const intlTypes = ['DateTimeFormat', 'NumberFormat', 'RelativeTimeFormat', 'PluralRules',
    'Collator', 'ListFormat', 'DisplayNames', 'Segmenter', 'DurationFormat'];
  for (const name of intlTypes) {
    const Original = NativeIntl[name];
    if (typeof Original !== 'function') continue;
    const wrapped = new Proxy(Original, {
      apply(target, receiver, args) {
        const patched = [...args];
        if (patched[0] === undefined) patched[0] = locale;
        if (name === 'DateTimeFormat') patched[1] = withTimeZone(patched[1]);
        return Reflect.apply(target, receiver, patched);
      },
      construct(target, args, newTarget) {
        const patched = [...args];
        if (patched[0] === undefined) patched[0] = locale;
        if (name === 'DateTimeFormat') patched[1] = withTimeZone(patched[1]);
        return Reflect.construct(target, patched, newTarget);
      }
    });
    try { NativeIntl[name] = wrapped; } catch (_error) { /* read-only Intl property */ }
  }

  function withTimeZone(options) {
    if (options == null) return { timeZone };
    // Respect a timezone explicitly selected by website code; spoof the browser default.
    if ('timeZone' in Object(options)) return options;
    return { ...Object(options), timeZone };
  }

  // Engines implement toLocaleString() natively; they do NOT necessarily use
  // the overridden Intl constructors, so patch their default locale separately.
  const useDefault = (candidate) => candidate === undefined ? locale : candidate;
  function overrideMethod(object, key, value) {
    try { Object.defineProperty(object, key, { configurable: true, writable: true, value }); }
    catch (_error) { /* cannot override */ }
  }
  overrideMethod(Number.prototype, 'toLocaleString', function (languages, options) {
    return native.numberToLocale.call(this, useDefault(languages), options);
  });
  if (native.bigintToLocale) {
    overrideMethod(BigInt.prototype, 'toLocaleString', function (languages, options) {
      return native.bigintToLocale.call(this, useDefault(languages), options);
    });
  }
  overrideMethod(String.prototype, 'localeCompare', function (that, languages, options) {
    return native.stringLocaleCompare.call(this, that, useDefault(languages), options);
  });
  overrideMethod(String.prototype, 'toLocaleLowerCase', function (languages) {
    return native.stringToLocaleLowerCase.call(this, useDefault(languages));
  });
  overrideMethod(String.prototype, 'toLocaleUpperCase', function (languages) {
    return native.stringToLocaleUpperCase.call(this, useDefault(languages));
  });

  const wallFormatter = new NativeIntl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit'
  });
  const nameFormatter = new NativeIntl.DateTimeFormat('en-US', {
    timeZone, timeZoneName: 'long'
  });
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  const valid = (date) => Number.isFinite(native.getTime.call(date));
  function wallParts(timestamp) {
    const fields = {};
    for (const part of wallFormatter.formatToParts(timestamp)) {
      if (part.type !== 'literal') fields[part.type] = Number(part.value);
    }
    // Intl allows 24:00 at midnight in some engines/locales. Normalize it.
    const year = fields.year, month = fields.month, day = fields.day;
    const hour = fields.hour === 24 ? 0 : fields.hour;
    const temp = new NativeDate(0);
    native.setUTCFullYear.call(temp, year, month - 1, day);
    native.setUTCHours.call(temp, 0, 0, 0, 0);
    return { year, month: month - 1, date: day, day: temp.getUTCDay(),
      hour, minute: fields.minute, second: fields.second,
      millisecond: ((timestamp % 1000) + 1000) % 1000 };
  }
  function utcFromWall(year, month, date, hour, minute, second, ms) {
    const out = new NativeDate(0);
    native.setUTCFullYear.call(out, year, month, date);
    native.setUTCHours.call(out, hour, minute, second, ms);
    return native.getTime.call(out);
  }
  function offsetMinutes(timestamp) {
    const p = wallParts(timestamp);
    const reconstructed = utcFromWall(p.year, p.month, p.date, p.hour, p.minute, p.second, p.millisecond);
    // Mirrors Date#getTimezoneOffset: positive in timezones west of UTC.
    return (timestamp - reconstructed) / 60000;
  }
  function instantFromWall(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
    const desired = utcFromWall(year, month, day, hour, minute, second, ms);
    if (!Number.isFinite(desired)) return NaN;
    const offsets = new Set();
    for (const d of [-172800000, -86400000, -43200000, 0, 43200000, 86400000, 172800000]) {
      try { offsets.add(offsetMinutes(desired + d)); } catch (_e) { /* out of supported range */ }
    }
    const matches = [];
    const afterGap = [];
    for (const offset of offsets) {
      const instant = desired + offset * 60000;
      if (!Number.isFinite(instant)) continue;
      try {
        const p = wallParts(instant);
        const rendered = utcFromWall(p.year, p.month, p.date, p.hour, p.minute, p.second, p.millisecond);
        const difference = rendered - desired;
        if (difference === 0) matches.push(instant);
        else if (difference > 0) afterGap.push({ instant, difference });
      } catch (_e) { /* out of supported range */ }
    }
    // Disambiguation matches the Temporal 'compatible' convention: earlier instant
    // on fall-back overlaps; advance through nonexistent spring-forward wall times.
    if (matches.length) return Math.min(...matches);
    afterGap.sort((a, b) => a.difference - b.difference || a.instant - b.instant);
    if (afterGap.length) return afterGap[0].instant;
    const first = offsets.values().next().value;
    return first === undefined ? NaN : desired + first * 60000;
  }
  const getWall = (date) => wallParts(native.getTime.call(date));
  const getters = {
    getFullYear: p => p.year,
    getYear: p => p.year - 1900,
    getMonth: p => p.month,
    getDate: p => p.date,
    getDay: p => p.day,
    getHours: p => p.hour,
    getMinutes: p => p.minute,
    getSeconds: p => p.second,
    getMilliseconds: p => p.millisecond
  };
  for (const [method, select] of Object.entries(getters)) {
    overrideMethod(dateProto, method, function () {
      if (!valid(this)) return NaN;
      return select(getWall(this));
    });
  }
  overrideMethod(dateProto, 'getTimezoneOffset', function () {
    if (!valid(this)) return NaN;
    return offsetMinutes(native.getTime.call(this));
  });

  function localSet(date, changes, defaultsInvalid) {
    const t = native.getTime.call(date);
    const p = Number.isFinite(t) ? wallParts(t) : defaultsInvalid;
    if (!p) return native.setTime.call(date, NaN);
    const result = instantFromWall(
      changes.year ?? p.year, changes.month ?? p.month, changes.date ?? p.date,
      changes.hour ?? p.hour, changes.minute ?? p.minute, changes.second ?? p.second,
      changes.millisecond ?? p.millisecond
    );
    return native.setTime.call(date, result);
  }
  overrideMethod(dateProto, 'setFullYear', function (y, m, d) {
    return localSet(this, { year: Number(y), month: m === undefined ? undefined : Number(m),
      date: d === undefined ? undefined : Number(d) },
    { year: 1970, month: 0, date: 1, hour: 0, minute: 0, second: 0, millisecond: 0 });
  });
  overrideMethod(dateProto, 'setMonth', function (m, d) {
    return localSet(this, { month: Number(m), date: d === undefined ? undefined : Number(d) });
  });
  overrideMethod(dateProto, 'setDate', function (d) { return localSet(this, { date: Number(d) }); });
  overrideMethod(dateProto, 'setHours', function (h, m, s, ms) {
    return localSet(this, { hour: Number(h), minute: m === undefined ? undefined : Number(m),
      second: s === undefined ? undefined : Number(s),
      millisecond: ms === undefined ? undefined : Number(ms) });
  });
  overrideMethod(dateProto, 'setMinutes', function (m, s, ms) {
    return localSet(this, { minute: Number(m), second: s === undefined ? undefined : Number(s),
      millisecond: ms === undefined ? undefined : Number(ms) });
  });
  overrideMethod(dateProto, 'setSeconds', function (s, ms) {
    return localSet(this, { second: Number(s), millisecond: ms === undefined ? undefined : Number(ms) });
  });
  overrideMethod(dateProto, 'setMilliseconds', function (ms) {
    return localSet(this, { millisecond: Number(ms) });
  });
  overrideMethod(dateProto, 'setYear', function (year) {
    const value = Number(year);
    return localSet(this, { year: Number.isFinite(value) && value >= 0 && value <= 99 ? value + 1900 : value },
      { year: 1970, month: 0, date: 1, hour: 0, minute: 0, second: 0, millisecond: 0 });
  });

  function nameOfZone(date) {
    return nameFormatter.formatToParts(date).find(p => p.type === 'timeZoneName')?.value || timeZone;
  }
  function offsetLabel(date) {
    const minutes = -offsetMinutes(native.getTime.call(date));
    return `GMT${minutes >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(minutes) / 60))}${pad(Math.floor(Math.abs(minutes) % 60))}`;
  }
  function englishDate(date) {
    const p = getWall(date);
    return `${weekdays[p.day]} ${months[p.month]} ${pad(p.date)} ${pad(p.year, 4)}`;
  }
  function englishTime(date) {
    const p = getWall(date);
    return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)} ${offsetLabel(date)} (${nameOfZone(date)})`;
  }
  overrideMethod(dateProto, 'toString', function () {
    if (!valid(this)) return 'Invalid Date';
    return `${englishDate(this)} ${englishTime(this)}`;
  });
  overrideMethod(dateProto, 'toDateString', function () { return valid(this) ? englishDate(this) : 'Invalid Date'; });
  overrideMethod(dateProto, 'toTimeString', function () { return valid(this) ? englishTime(this) : 'Invalid Date'; });
  function dateLocale(original, date, languages, options) {
    if (options !== undefined && options !== null && 'timeZone' in Object(options)) {
      return original.call(date, useDefault(languages), options);
    }
    return original.call(date, useDefault(languages), { ...Object(options), timeZone });
  }
  overrideMethod(dateProto, 'toLocaleString', function (languages, options) {
    return dateLocale(native.toLocaleString, this, languages, options);
  });
  overrideMethod(dateProto, 'toLocaleDateString', function (languages, options) {
    return dateLocale(native.toLocaleDateString, this, languages, options);
  });
  overrideMethod(dateProto, 'toLocaleTimeString', function (languages, options) {
    return dateLocale(native.toLocaleTimeString, this, languages, options);
  });

  // The ECMAScript Date constructor's multi-argument form is *local* time.
  // Date.now(), timestamps, ISO strings with Z/offset, and UTC methods remain real.
  const parseLocalISO = (value) => {
    if (typeof value !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
    if (!m) return null;
    const [, y, mo, day, h, minute, second, fraction] = m;
    // Invalid ISO dates are rejected instead of silently normalizing them.
    if (+mo < 1 || +mo > 12 || +day < 1 || +day > 31 || +h > 24 || +minute > 59 || +(second || 0) > 59 ||
        (+h === 24 && (+minute !== 0 || +(second || 0) !== 0 || +(fraction || 0) !== 0))) return NaN;
    const calendarDate = new NativeDate(0);
    native.setUTCFullYear.call(calendarDate, +y, +mo - 1, +day);
    if (calendarDate.getUTCFullYear() !== +y || calendarDate.getUTCMonth() !== +mo - 1 ||
        calendarDate.getUTCDate() !== +day) return NaN;
    return instantFromWall(+y, +mo - 1, +day, +h, +minute, +(second || 0), +(fraction || '0').padEnd(3, '0'));
  };
  const ProxyDate = new Proxy(NativeDate, {
    apply() { return new NativeDate().toString(); },
    construct(target, args, newTarget) {
      if (args.length >= 2) {
        const [year, month, day = 1, hour = 0, minute = 0, second = 0, ms = 0] = args.map(Number);
        const adjustedYear = Number.isFinite(year) && year >= 0 && year <= 99 ? year + 1900 : year;
        return Reflect.construct(target, [instantFromWall(adjustedYear, month, day, hour, minute, second, ms)], newTarget);
      }
      if (args.length === 1 && typeof args[0] === 'string') {
        const parsed = parseLocalISO(args[0]);
        if (parsed !== null) return Reflect.construct(target, [parsed], newTarget);
      }
      return Reflect.construct(target, args, newTarget);
    }
  });
  const originalParse = NativeDate.parse;
  overrideMethod(ProxyDate, 'parse', function (input) {
    const parsed = parseLocalISO(input);
    return parsed === null ? Reflect.apply(originalParse, NativeDate, [input]) : parsed;
  });
  try { globalThis.Date = ProxyDate; } catch (_error) { /* cannot patch global Date */ }

  // Temporal is being rolled out in browsers; its 'system timezone' endpoint
  // is another direct leak, where available.
  try {
    if (typeof Temporal !== 'undefined' && Temporal.Now && typeof Temporal.Now.timeZoneId === 'function') {
      Object.defineProperty(Temporal.Now, 'timeZoneId', {
        configurable: true, writable: true, value: () => timeZone
      });
    }
  } catch (_error) { /* Temporal may be frozen */ }
}
