/*
 * Уведомления о погоде по расписанию.
 *
 * KaiOS 2.5: системный будильник navigator.mozAlarms (разрешение "alarms") будит
 * приложение даже закрытым и присылает системное сообщение "alarm"
 * (manifest.webapp → messages). Ставим всегда ровно ОДИН будильник — на ближайшее
 * время; когда он срабатывает, приложение показывает уведомление и ставит следующий.
 * Так в системе не копятся десятки будильников и ничего не крутится в фоне.
 *
 * Время — локальное время телефона ('ignoreTimezone').
 */
(function (W) {
  'use strict';

  var TYPE = 'wx-notify';
  var TAG = 'wx-weather';

  function alarms() { return navigator.mozAlarms || null; }

  function parseTime(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
    if (!m) return -1;
    var h = +m[1], mi = +m[2];
    return (h < 24 && mi < 60) ? h * 60 + mi : -1;
  }

  function dayAllowed(date, days) {
    var wd = date.getDay();
    if (days === 'weekdays') return wd >= 1 && wd <= 5;
    if (days === 'weekends') return wd === 0 || wd === 6;
    return true;
  }

  // Минуты суток, в которые надо присылать уведомление (по возрастанию)
  function slots(cfg) {
    var out = [], i;
    if (cfg.mode === 'times') {
      for (i = 0; i < (cfg.times || []).length; i++) {
        var v = parseTime(cfg.times[i]);
        if (v >= 0 && out.indexOf(v) < 0) out.push(v);
      }
    } else {
      var every = Math.max(1, cfg.every | 0), from = cfg.from | 0, to = cfg.to | 0;
      var span = (to - from + 24) % 24; // окно может переходить через полночь
      for (i = 0; i * every <= span; i++) {
        var h = (from + i * every) % 24;
        if (out.indexOf(h * 60) < 0) out.push(h * 60);
      }
    }
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  // Ближайшее время срабатывания строго позже now (или null)
  function nextTime(cfg, now) {
    now = now || new Date();
    var s = slots(cfg);
    if (!cfg.on || !s.length) return null;
    for (var d = 0; d <= 8; d++) {
      var day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
      if (!dayAllowed(day, cfg.days)) continue;
      for (var i = 0; i < s.length; i++) {
        var at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(s[i] / 60), s[i] % 60, 0, 0);
        if (at.getTime() > now.getTime() + 30000) return at;
      }
    }
    return null;
  }

  function req(r) {
    return new Promise(function (resolve) {
      if (!r) { resolve(null); return; }
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { resolve(null); };
    });
  }

  function clear() {
    var A = alarms();
    if (!A) return Promise.resolve();
    return req(A.getAll()).then(function (list) {
      (list || []).forEach(function (a) {
        if (a && a.data && a.data.type === TYPE) { try { A.remove(a.id); } catch (e) { /* ignore */ } }
      });
    });
  }

  // Переставить будильник по настройкам. Возвращает Date следующего срабатывания или null.
  // Вызовы выполняются строго по очереди: иначе два одновременных «снять + поставить»
  // могут оставить в системе два будильника.
  var queue = Promise.resolve();
  function schedule(cfg) {
    var run = function () {
      var A = alarms();
      return clear().then(function () {
        var at = A ? nextTime(cfg, new Date()) : null;
        if (!at) return null;
        // tz — смещение часового пояса на момент планирования (см. проверку опоздания в app.js)
        return req(A.add(at, 'ignoreTimezone', { type: TYPE, at: at.getTime(), tz: at.getTimezoneOffset() })).then(function (id) {
          return id === null ? null : at;
        });
      });
    };
    queue = queue.then(run, run);
    return queue;
  }

  function launchSelf() {
    try {
      if (navigator.mozApps && navigator.mozApps.getSelf) {
        var r = navigator.mozApps.getSelf();
        r.onsuccess = function () { if (r.result) r.result.launch(); };
        return;
      }
    } catch (e) { /* ignore */ }
    try { W.focus(); } catch (e2) { /* ignore */ }
  }

  function permission() {
    return new Promise(function (resolve) {
      if (typeof W.Notification === 'undefined') { resolve(false); return; }
      if (W.Notification.permission === 'granted') { resolve(true); return; }
      if (W.Notification.permission === 'denied') { resolve(false); return; }
      try {
        var p = W.Notification.requestPermission(function (res) { resolve(res === 'granted'); });
        if (p && p.then) p.then(function (res) { resolve(res === 'granted'); });
      } catch (e) { resolve(false); }
    });
  }

  function show(title, body, icon) {
    return permission().then(function (ok) {
      if (!ok) return false;
      try {
        var n = new W.Notification(title, { body: body, icon: icon, tag: TAG, data: { type: TYPE } });
        n.onclick = function () { launchSelf(); try { n.close(); } catch (e) { /* ignore */ } };
        return true;
      } catch (e) { return false; }
    });
  }

  W.WxNotify = {
    TYPE: TYPE,
    supported: function () { return !!alarms(); },
    canNotify: function () { return typeof W.Notification !== 'undefined'; },
    slots: slots,
    nextTime: nextTime,
    parseTime: parseTime,
    schedule: schedule,
    clear: clear,
    show: show,
    permission: permission,
    launchSelf: launchSelf
  };
})(window);
