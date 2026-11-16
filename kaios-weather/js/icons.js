/*
 * Лёгкие векторные иконки погоды (inline SVG, без картинок и шрифтов).
 * Коды — номера иконок AccuWeather (1–44).
 */
(function (W) {
  'use strict';

  var SUN = '#FFC83D', HOT = '#FF8A3D', MOON = '#F3E7B5', CLOUD = '#F4F7FA',
    RAIN = '#8FD0FF', SNOW = '#FFFFFF', BOLT = '#FFD84D', COLD = '#BFE6FF', LINE = '#E3EAF2';

  // [светило, облачность 0..3, осадки]
  var MAP = {
    1: ['sun', 0], 2: ['sun', 1], 3: ['sun', 1], 4: ['sun', 2], 5: ['sun', 0, 'haze'],
    6: ['sun', 2], 7: [null, 3], 8: [null, 3], 11: [null, 3, 'fog'],
    12: [null, 3, 'rain'], 13: ['sun', 2, 'rain'], 14: ['sun', 1, 'rain'],
    15: [null, 3, 'storm'], 16: ['sun', 2, 'storm'], 17: ['sun', 1, 'storm'],
    18: [null, 3, 'rain'], 19: [null, 3, 'snow'], 20: ['sun', 2, 'snow'], 21: ['sun', 1, 'snow'],
    22: [null, 3, 'snow'], 23: ['sun', 2, 'snow'], 24: [null, 0, 'ice'], 25: [null, 3, 'sleet'],
    26: [null, 3, 'sleet'], 29: [null, 3, 'sleet'], 30: ['hot', 0], 31: [null, 0, 'cold'],
    32: [null, 0, 'wind'], 33: ['moon', 0], 34: ['moon', 1], 35: ['moon', 1], 36: ['moon', 2],
    37: ['moon', 0, 'haze'], 38: ['moon', 2], 39: ['moon', 1, 'rain'], 40: ['moon', 2, 'rain'],
    41: ['moon', 1, 'storm'], 42: ['moon', 2, 'storm'], 43: ['moon', 2, 'snow'], 44: ['moon', 2, 'snow']
  };

  // Облако в рамке ~ x 1.5..40, y 0..29
  var CLOUD_PATH = 'M10 29h22a8 8 0 0 0 0-16 11 11 0 0 0-21-2A9 9 0 0 0 10 29z';

  function sun(cx, cy, r, color) {
    var s = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + color + '"/>';
    var rays = '';
    for (var i = 0; i < 8; i++) {
      var a = i * Math.PI / 4;
      var x1 = cx + Math.cos(a) * (r + 4), y1 = cy + Math.sin(a) * (r + 4);
      var x2 = cx + Math.cos(a) * (r + 9), y2 = cy + Math.sin(a) * (r + 9);
      rays += 'M' + x1.toFixed(1) + ' ' + y1.toFixed(1) + 'L' + x2.toFixed(1) + ' ' + y2.toFixed(1);
    }
    return s + '<path d="' + rays + '" stroke="' + color + '" stroke-width="3.5" stroke-linecap="round"/>';
  }

  function moon(cx, cy, r) {
    // полумесяц: большой круг минус смещённый круг
    var x0 = cx + r * 0.35, y0 = cy - r;
    return '<path fill="' + MOON + '" d="M' + x0.toFixed(1) + ' ' + y0.toFixed(1) +
      'A' + r + ' ' + r + ' 0 1 0 ' + (cx + r).toFixed(1) + ' ' + (cy + r * 0.45).toFixed(1) +
      'A' + (r * 0.85).toFixed(1) + ' ' + (r * 0.85).toFixed(1) + ' 0 0 1 ' + x0.toFixed(1) + ' ' + y0.toFixed(1) + 'z"/>';
  }

  function cloud(x, y, s, fill) {
    return '<path transform="translate(' + x + ' ' + y + ') scale(' + s + ')" fill="' + (fill || CLOUD) + '" d="' + CLOUD_PATH + '"/>';
  }

  function lines(d, color, w) {
    return '<path d="' + d + '" stroke="' + color + '" stroke-width="' + (w || 3.5) + '" stroke-linecap="round" fill="none"/>';
  }

  function precip(kind) {
    switch (kind) {
      case 'rain': return lines('M22 49l-3 8M32 49l-3 8M42 49l-3 8', RAIN);
      case 'snow': return '<g fill="' + SNOW + '"><circle cx="21" cy="52" r="3"/><circle cx="32" cy="57" r="3"/><circle cx="43" cy="52" r="3"/></g>';
      case 'sleet': return lines('M22 49l-3 8M42 49l-3 8', RAIN) + '<circle cx="31" cy="55" r="3" fill="' + SNOW + '"/>';
      case 'storm': return '<path fill="' + BOLT + '" d="M33 42l-9 12h7l-4 10 12-14h-7l4-8z"/>' + lines('M19 50l-2 6M47 50l-2 6', RAIN, 3);
      case 'fog': return lines('M14 49h36M18 56h28', LINE, 3.5);
      default: return '';
    }
  }

  function flake(cx, cy, r, color) {
    var d = '';
    for (var i = 0; i < 3; i++) {
      var a = i * Math.PI / 3 + Math.PI / 2;
      var dx = Math.cos(a) * r, dy = Math.sin(a) * r;
      d += 'M' + (cx - dx).toFixed(1) + ' ' + (cy - dy).toFixed(1) + 'L' + (cx + dx).toFixed(1) + ' ' + (cy + dy).toFixed(1);
    }
    return lines(d, color, 3.5);
  }

  function body(kind, cx, cy, r) {
    if (kind === 'sun') return sun(cx, cy, r, SUN);
    if (kind === 'hot') return sun(cx, cy, r, HOT);
    if (kind === 'moon') return moon(cx, cy, r + 3);
    return '';
  }

  function svg(code) {
    var m = MAP[code] || [null, 3];
    var b = m[0], level = m[1], p = m[2];
    var dy = p && p !== 'haze' ? -9 : 0;
    var out = '';

    if (p === 'wind') {
      out = lines('M8 24h30a7 7 0 1 0-7-7M8 34h42a7 7 0 1 1-7 7M8 44h22', LINE);
    } else if (p === 'cold' || p === 'ice') {
      out = flake(32, 32, 20, COLD);
    } else if (level === 0) {
      out = body(b, 32, 32 + dy, 13);
      if (p === 'haze') out = body(b, 32, 26, 11) + precip('fog');
    } else if (level === 3) {
      out = cloud(5, 14 + dy, 1.35);
    } else if (level === 1) {
      out = body(b, 24, 24 + dy, 10) + cloud(22, 29 + dy, 0.95);
    } else {
      out = body(b, 22, 21 + dy, 9) + cloud(13, 23 + dy, 1.2);
    }
    if (p && p !== 'haze' && p !== 'wind' && p !== 'cold' && p !== 'ice') out += precip(p);
    return out;
  }

  var cache = {};

  W.WxIcons = {
    svg: function (code, size, cls) {
      var key = code + ':' + size;
      if (!cache[key]) cache[key] = svg(code);
      return '<svg class="wi ' + (cls || '') + '" width="' + size + '" height="' + size +
        '" viewBox="0 0 64 64" aria-hidden="true">' + cache[key] + '</svg>';
    },
    pin: function (size) {
      return '<svg class="pin" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';
    },
    drop: function (size) {
      return '<svg class="drop" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path fill="currentColor" d="M12 2C9 7 5 10.5 5 15a7 7 0 0 0 14 0c0-4.5-4-8-7-13z"/></svg>';
    },
    // Тема фона по коду иконки
    theme: function (code, isDay) {
      var m = MAP[code] || [null, 3];
      var p = m[2];
      if (p === 'storm') return 'storm';
      if (p === 'rain' || p === 'sleet') return 'rain';
      if (p === 'snow' || p === 'ice' || p === 'cold') return 'snow';
      if (p === 'fog' || p === 'haze') return 'fog';
      if (m[1] >= 2) return isDay ? 'cloudy-day' : 'cloudy-night';
      return isDay ? 'clear-day' : 'clear-night';
    }
  };
})(window);
