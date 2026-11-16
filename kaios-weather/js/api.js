/*
 * Клиент AccuWeather.
 * На KaiOS запросы идут через XMLHttpRequest({mozSystem: true}) — это обходит CORS
 * (нужно разрешение systemXHR в манифесте, приложение типа privileged).
 * Ответы сжимаются до компактного вида, чтобы кэш в localStorage был маленьким.
 */
(function (W) {
  'use strict';

  var BASE = 'https://dataservice.accuweather.com';
  var TIMEOUT = 20000;
  var getKey = function () { return ''; };

  function ApiError(type, status) {
    this.type = type;
    this.status = status || 0;
  }

  function request(path, params) {
    return new Promise(function (resolve, reject) {
      var key = getKey();
      if (!key) { reject(new ApiError('nokey')); return; }

      var q = ['apikey=' + encodeURIComponent(key)];
      for (var k in params) {
        if (params.hasOwnProperty(k) && params[k] !== null && params[k] !== undefined) {
          q.push(k + '=' + encodeURIComponent(params[k]));
        }
      }

      var xhr;
      try { xhr = new XMLHttpRequest({ mozSystem: true }); } catch (e) { xhr = new XMLHttpRequest(); }
      xhr.open('GET', BASE + path + '?' + q.join('&'), true);
      xhr.timeout = TIMEOUT;
      xhr.onload = function () {
        var data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
        var s = xhr.status;
        if (s >= 200 && s < 300 && data !== null) resolve(data);
        else if (s === 401) reject(new ApiError('key', s));
        else if (s === 403) reject(new ApiError('forbidden', s));
        else if (s === 429 || s === 503) reject(new ApiError('limit', s));
        else if (s === 0) reject(new ApiError('net', s));
        else reject(new ApiError('server', s));
      };
      xhr.onerror = function () { reject(new ApiError('net')); };
      xhr.ontimeout = function () { reject(new ApiError('net')); };
      xhr.send();
    });
  }

  function num(v) { return (typeof v === 'number' && !isNaN(v)) ? v : null; }
  function val(o, unit) {
    // { Metric: {Value}, Imperial: {Value} } или { Value }
    if (!o) return null;
    if (unit && o[unit]) return num(o[unit].Value);
    return num(o.Value);
  }

  function normLoc(r) {
    if (!r || !r.Key) return null;
    return {
      key: String(r.Key),
      name: r.LocalizedName || r.EnglishName || '',
      admin: (r.AdministrativeArea && r.AdministrativeArea.LocalizedName) || '',
      country: (r.Country && r.Country.LocalizedName) || '',
      lat: r.GeoPosition ? r.GeoPosition.Latitude : null,
      lon: r.GeoPosition ? r.GeoPosition.Longitude : null
    };
  }

  function uvOf(list) {
    if (!list) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].Name === 'UVIndex') return { v: num(list[i].Value), t: list[i].Category || '' };
    }
    return null;
  }

  function half(h, metric) {
    h = h || {};
    var w = h.Wind || {};
    return {
      icon: h.Icon,
      phrase: h.IconPhrase || '',
      long: h.LongPhrase || h.ShortPhrase || h.IconPhrase || '',
      pop: num(h.PrecipitationProbability),
      wind: w.Speed ? num(w.Speed.Value) : null,
      dir: (w.Direction && w.Direction.Localized) || ''
    };
  }

  function normalize(cur, hourly, daily, metric) {
    var U = metric ? 'Metric' : 'Imperial';
    cur = (cur && cur[0]) || {};
    var wind = cur.Wind || {};
    var out = {
      t: Date.now(),
      m: metric,
      cur: {
        temp: val(cur.Temperature, U),
        feels: val(cur.RealFeelTemperature, U),
        text: cur.WeatherText || '',
        icon: cur.WeatherIcon || 7,
        day: cur.IsDayTime !== false,
        hum: num(cur.RelativeHumidity),
        wind: wind.Speed ? val(wind.Speed, U) : null,
        dir: (wind.Direction && wind.Direction.Localized) || '',
        uv: num(cur.UVIndex),
        uvText: cur.UVIndexText || '',
        vis: val(cur.Visibility, U),
        pres: val(cur.Pressure, U),
        dew: val(cur.DewPoint, U),
        cloud: num(cur.CloudCover),
        obs: cur.LocalObservationDateTime || ''
      },
      hours: [],
      days: [],
      headline: (daily && daily.Headline && daily.Headline.Text) || ''
    };

    (hourly || []).forEach(function (h) {
      out.hours.push({
        dt: h.DateTime || '',
        icon: h.WeatherIcon,
        temp: val(h.Temperature),
        pop: num(h.PrecipitationProbability),
        day: h.IsDaylight !== false
      });
    });

    ((daily && daily.DailyForecasts) || []).forEach(function (d) {
      var t = d.Temperature || {}, rf = d.RealFeelTemperature || {}, uv = uvOf(d.AirAndPollen);
      out.days.push({
        date: d.Date || '',
        min: val(t.Minimum),
        max: val(t.Maximum),
        fmin: val(rf.Minimum),
        fmax: val(rf.Maximum),
        d: half(d.Day, metric),
        n: half(d.Night, metric),
        rise: (d.Sun && d.Sun.Rise) || '',
        set: (d.Sun && d.Sun.Set) || '',
        uv: uv ? uv.v : null,
        uvText: uv ? uv.t : '',
        sunH: num(d.HoursOfSun)
      });
    });
    return out;
  }

  W.WxApi = {
    Error: ApiError,
    init: function (opts) { if (opts && opts.getKey) getKey = opts.getKey; },

    searchCities: function (q, lang) {
      return request('/locations/v1/cities/search', { q: q, language: lang }).then(function (list) {
        var out = [];
        (list || []).forEach(function (r) { var l = normLoc(r); if (l) out.push(l); });
        return out.slice(0, 15);
      });
    },

    geoposition: function (lat, lon, lang) {
      return request('/locations/v1/cities/geoposition/search', {
        q: lat.toFixed(4) + ',' + lon.toFixed(4), language: lang
      }).then(function (r) {
        var l = normLoc(r);
        if (!l) throw new ApiError('server');
        return l;
      });
    },

    // 3 запроса: текущая погода, 12 часов, 5 дней
    weather: function (key, lang, metric) {
      var p = { language: lang, details: 'true' };
      var pm = { language: lang, details: 'true', metric: metric ? 'true' : 'false' };
      var k = encodeURIComponent(key);
      return Promise.all([
        request('/currentconditions/v1/' + k, p),
        request('/forecasts/v1/hourly/12hour/' + k, pm),
        request('/forecasts/v1/daily/5day/' + k, pm)
      ]).then(function (r) { return normalize(r[0], r[1], r[2], metric); });
    }
  };
})(window);
