/*
 * public/app.js — gather browser-side signals and POST them to /log.
 * Each collector is isolated so a single failure never breaks the rest.
 * Bouncers are handled via a pagehide/visibilitychange beacon fallback.
 */
(function () {
  'use strict';

  var sent = false;

  function safe(fn, fallback) {
    try {
      var v = fn();
      return v === undefined ? (fallback === undefined ? null : fallback) : v;
    } catch (e) {
      return fallback === undefined ? null : fallback;
    }
  }

  // Run fn(); resolve to its value, or fallback on throw/reject/timeout.
  function safeAsync(fn, fallback, timeoutMs) {
    timeoutMs = timeoutMs || 2000;
    return Promise.race([
      Promise.resolve().then(fn).then(
        function (v) { return v === undefined ? fallback : v; },
        function () { return fallback; }
      ),
      new Promise(function (resolve) { setTimeout(function () { resolve(fallback); }, timeoutMs); })
    ]).catch(function () { return fallback; });
  }

  function hashStr(data) {
    var h = 0;
    for (var i = 0; i < data.length; i++) { h = (Math.imul(h, 31) + data.charCodeAt(i)) | 0; }
    return (h >>> 0).toString(16);
  }

  function canvasFingerprint() {
    var c = document.createElement('canvas');
    c.width = 240; c.height = 60;
    var ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.textBaseline = 'top';
    ctx.font = '16px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('VisitorLogger ⏹㊗', 2, 15);
    ctx.fillStyle = 'rgba(102,204,0,0.7)';
    ctx.fillText('VisitorLogger ⏹㊗', 4, 17);
    return { hash: hashStr(c.toDataURL()), sample: c.toDataURL().slice(0, 48) };
  }

  function webglInfo() {
    var c = document.createElement('canvas');
    var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return null;
    var ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
      shading_language: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      max_texture_size: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    };
  }

  function detectFonts() {
    var base = ['monospace', 'sans-serif', 'serif'];
    var test = 'mmmmmmmmmmlli';
    var list = ['Arial','Arial Black','Arial Narrow','Calibri','Cambria','Candara','Comic Sans MS','Consolas','Courier','Courier New','Georgia','Helvetica','Impact','Lucida Console','Lucida Sans Unicode','Microsoft Sans Serif','Microsoft YaHei','MS Gothic','Palatino Linotype','Segoe Print','Segoe Script','Segoe UI','Segoe UI Emoji','Segoe UI Symbol','SimSun','SimHei','Tahoma','Times','Times New Roman','Trebuchet MS','Verdana','Webdings','Wingdings','Wingdings 2','Wingdings 3'];
    var span = document.createElement('span');
    span.style.fontSize = '72px';
    span.style.position = 'absolute';
    span.style.left = '-9999px';
    span.style.top = '0';
    span.style.visibility = 'hidden';
    document.body.appendChild(span);
    var baseline = {};
    base.forEach(function (b) { span.style.fontFamily = b; span.textContent = test; baseline[b] = span.offsetWidth + '|' + span.offsetHeight; });
    var found = [];
    list.forEach(function (f) {
      for (var i = 0; i < base.length; i++) {
        var b = base[i];
        span.style.fontFamily = "'" + f + "'," + b;
        var m = span.offsetWidth + '|' + span.offsetHeight;
        if (m !== baseline[b]) { found.push(f); break; }
      }
    });
    document.body.removeChild(span);
    return found;
  }

  // Use WebRTC ICE gathering to discover local + public IPs.
  function collectWebRtcIps() {
    return new Promise(function (resolve) {
      var ips = {};
      var RTC = window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection;
      if (!RTC) return resolve([]);
      var pc;
      try {
        pc = new RTC({
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' },
          ]
        });
      } catch (e) { return resolve([]); }
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        try { pc.close(); } catch (e) {}
        resolve(Object.keys(ips));
      }
      pc.onicecandidate = function (e) {
        if (!e.candidate) { finish(); return; }
        var cand = (e.candidate && e.candidate.candidate) || '';
        var parts = cand.split(' ');
        var ip = parts[4];
        if (ip && (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || /^[0-9a-fA-F:]+$/.test(ip))) ips[ip] = true;
      };
      setTimeout(finish, 3000);
      try {
        pc.createDataChannel('');
        pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(finish);
      } catch (e) { finish(); }
    });
  }

  function detectAdblock() {
    return new Promise(function (resolve) {
      var bait = document.createElement('div');
      bait.className = 'ad-banner ads ad adsbox pub_300x250 pub_300x250m pub_728x90 text-ad textAd adserver adserver-top';
      bait.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;';
      bait.innerHTML = '&nbsp;';
      document.body.appendChild(bait);
      setTimeout(function () {
        var cs = window.getComputedStyle ? getComputedStyle(bait) : {};
        var blocked = bait.offsetParent === null || bait.offsetHeight === 0 || bait.clientHeight === 0 || cs.display === 'none' || cs.visibility === 'hidden';
        try { document.body.removeChild(bait); } catch (e) {}
        resolve({ likely_blocked: !!blocked });
      }, 150);
    });
  }

  // OfflineAudioContext fingerprint.
  function audioFp() {
    return new Promise(function (resolve) {
      try {
        var AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!AC) return resolve(null);
        var ctx = new AC(1, 5000, 4410);
        var osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(10000, 0);
        var comp = ctx.createDynamicsCompressor();
        osc.connect(comp); comp.connect(ctx.destination);
        osc.start(0);
        var rendered = ctx.startRendering();
        if (!rendered || !rendered.then) return resolve(null);
        rendered.then(function (buffer) {
          try {
            var d = buffer.getChannelData(0);
            var h = 0;
            for (var i = 0; i < d.length; i++) { h = (Math.imul(h, 31) + (d[i] * 1e6 | 0)) | 0; }
            resolve({ hash: (h >>> 0).toString(16), samples: d.length });
          } catch (e) { resolve(null); }
        }, function () { resolve(null); });
      } catch (e) { resolve(null); }
      setTimeout(function () { resolve(null); }, 2500);
    });
  }

  function gather() {
    var n = navigator;
    var s = screen;
    return {
      page: {
        href: location.href,
        origin: location.origin,
        path: location.pathname,
        search: location.search,
        hash: location.hash,
        referrer: document.referrer || null,
        title: document.title,
        character_set: document.characterSet,
        history_length: history.length,
      },
      time: {
        timezone: safe(function () { return Intl.DateTimeFormat().resolvedOptions().timeZone; }),
        timezone_offset: new Date().getTimezoneOffset(),
        locale: safe(function () { return Intl.DateTimeFormat().resolvedOptions().locale; }),
        calendar: safe(function () { return Intl.DateTimeFormat().resolvedOptions().calendar; }),
        numbering_system: safe(function () { return Intl.DateTimeFormat().resolvedOptions().numberingSystem; }),
        now: Date.now(),
      },
      navigator: {
        user_agent: n.userAgent,
        app_name: n.appName,
        app_version: n.appVersion,
        platform: n.platform,
        vendor: n.vendor,
        vendor_sub: n.vendorSub,
        product: n.product,
        product_sub: n.productSub,
        oscpu: n.oscpu || null,
        build_id: n.buildID || null,
        language: n.language,
        languages: (n.languages || []).slice(),
        cookie_enabled: n.cookieEnabled,
        do_not_track: n.doNotTrack,
        hardware_concurrency: safe(function () { return n.hardwareConcurrency; }),
        device_memory: safe(function () { return n.deviceMemory; }),
        max_touch_points: safe(function () { return n.maxTouchPoints; }),
        pdf_viewer_enabled: safe(function () { return n.pdfViewerEnabled; }),
        webdriver: safe(function () { return n.webdriver; }),
        standalone: safe(function () { return n.standalone; }),
        ua_data: safe(function () { var u = n.userAgentData; return u ? { brands: u.brands.slice(), mobile: u.mobile, platform: u.platform } : null; }),
      },
      screen: {
        width: s.width,
        height: s.height,
        avail_width: s.availWidth,
        avail_height: s.availHeight,
        color_depth: s.colorDepth,
        pixel_depth: s.pixelDepth,
        orientation: safe(function () { return { type: s.orientation && s.orientation.type, angle: s.orientation && s.orientation.angle }; }),
      },
      window: {
        device_pixel_ratio: window.devicePixelRatio,
        inner_width: window.innerWidth,
        inner_height: window.innerHeight,
        outer_width: window.outerWidth,
        outer_height: window.outerHeight,
        screen_x: window.screenX,
        screen_y: window.screenY,
      },
      touch: { ontouchstart: 'ontouchstart' in window },
      storage: {
        local_storage: safe(function () { return !!window.localStorage; }),
        session_storage: safe(function () { return !!window.sessionStorage; }),
        indexed_db: safe(function () { return !!window.indexedDB; }),
        cookies: document.cookie || null,
      },
      connection: safe(function () {
        var c = n.connection || n.mozConnection || n.webkitConnection;
        return c ? { effective_type: c.effectiveType, downlink: c.downlink, rtt: c.rtt, save_data: c.saveData, type: c.type } : null;
      }),
      plugins: safe(function () { return Array.prototype.map.call(n.plugins || [], function (p) { return p.name; }); }),
      mime_types: safe(function () { return Array.prototype.map.call(n.mimeTypes || [], function (m) { return m.type; }); }),
      speech_voices: safe(function () {
        return window.speechSynthesis ? speechSynthesis.getVoices().map(function (v) { return v.name + ' (' + v.lang + ')'; }) : [];
      }),
      performance: safe(function () {
        var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
        var mem = performance.memory || null;
        return {
          navigation_type: nav && nav.type,
          time_origin: performance.timeOrigin,
          ttfb: nav && nav.responseStart,
          dom_complete: nav && nav.domComplete,
          load_end: nav && nav.loadEventEnd,
          transfer_size: nav && nav.transferSize,
          encoded_body_size: nav && nav.encodedBodySize,
          memory: mem ? { js_heap_size_limit: mem.jsHeapSizeLimit, used: mem.usedJSHeapSize, total: mem.totalJSHeapSize } : null,
        };
      }),
      worker: safe(function () {
        return {
          worker: typeof Worker !== 'undefined',
          shared_worker: typeof SharedWorker !== 'undefined',
          service_worker: !!(n.serviceWorker),
          sw_controller: (n.serviceWorker && n.serviceWorker.controller) ? n.serviceWorker.controller.scriptURL : null,
        };
      }),
      sensors: safe(function () {
        return {
          accelerometer: 'Accelerometer' in window,
          gyroscope: 'Gyroscope' in window,
          magnetometer: 'Magnetometer' in window,
          ambient_light: 'AmbientLightSensor' in window,
          absolute_orientation: 'AbsoluteOrientationSensor' in window,
          relative_orientation: 'RelativeOrientationSensor' in window,
          linear_acceleration: 'LinearAccelerationSensor' in window,
          gravity: 'GravitySensor' in window,
        };
      }),
      gamepads: safe(function () {
        if (!n.getGamepads) return [];
        return Array.prototype.map.call(n.getGamepads(), function (g) {
          return g ? { id: g.id, mapping: g.mapping, axes: g.axes.length, buttons: g.buttons.length } : null;
        }).filter(Boolean);
      }),
      tab: safe(function () { return { visibility: document.visibilityState, hidden: document.hidden, has_focus: document.hasFocus ? document.hasFocus() : null }; }),
      media: safe(function () {
        var mq = function (q) { try { return window.matchMedia(q).matches; } catch (e) { return null; } };
        return {
          prefers_color_scheme: mq('(prefers-color-scheme: dark)'),
          prefers_reduced_motion: mq('(prefers-reduced-motion: reduce)'),
          forced_colors: mq('(forced-colors: active)'),
          pointer_fine: mq('(pointer: fine)'),
          pointer_coarse: mq('(pointer: coarse)'),
          hover: mq('(hover: hover)'),
          color_gamut_p3: mq('(color-gamut: p3)'),
          inverted_colors: mq('(inverted-colors: inverted)'),
        };
      }),
      canvas_fingerprint: safe(canvasFingerprint),
      webgl: safe(webglInfo),
      fonts: safe(detectFonts),
      // filled in asynchronously below
      adblock: null,
      media_devices_count: null,
      permissions: null,
      battery: null,
      webrtc_ips: null,
      audio: null,
      ua_data_high: null,
      codecs: null,
      storage_estimate: null,
      webauthn: null,
      collected_at: new Date().toISOString(),
    };
  }

  function send(payload) {
    var body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon) {
        var ok = navigator.sendBeacon('/log', new Blob([body], { type: 'application/json' }));
        if (ok) return Promise.resolve(true);
      }
    } catch (e) {}
    return fetch('/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true })
      .then(function () { return true; })
      .catch(function () { return false; });
  }

  // Fire-and-forget beacon for bouncers (pagehide / tab hidden).
  function maybeBeacon(payload) {
    if (sent) return;
    sent = true;
    var body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon('/log', new Blob([body], { type: 'application/json' }))) return;
    } catch (e) {}
    try {
      fetch('/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
    } catch (e) {}
  }

  var data;
  try { data = gather(); }
  catch (e) { data = { _gather_error: String(e), collected_at: new Date().toISOString() }; }

  // Bouncer fallback: no longer needed — fingerprint is sent early via __vlReady.
  // visitSent flag prevents double-sending.
  window.addEventListener('pagehide', function () {
    if (!visitSent && !sent) {
      visitSent = true;
      sent = true;
      maybeBeacon(Object.assign({}, data, { kind: 'visit', source: 'client' }));
    }
  });
  window.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden' && !visitSent && !sent) {
      visitSent = true;
      sent = true;
      maybeBeacon(Object.assign({}, data, { kind: 'visit', source: 'client' }));
    }
  });

  var asyncCollectors = [
    ['media_devices_count', safeAsync(function () {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return null;
      return navigator.mediaDevices.enumerateDevices().then(function (d) { return d.length; });
    }, null, 2000)],
    ['permissions', safeAsync(function () {
      var names = ['geolocation','notifications','camera','microphone','clipboard-read','clipboard-write','persistent','push','midi','background-sync','accelerometer','gyroscope','magnetometer','ambient-light-sensor','payment-handler','nfc','screen-wake-lock','storage-access','window-management','local-fonts','display-capture'];
      var results = {};
      return Promise.all(names.map(function (name) {
        return Promise.resolve().then(function () { return navigator.permissions.query({ name: name }); })
          .then(function (r) { results[name] = r.state; }, function () { results[name] = 'unsupported'; });
      })).then(function () { return results; });
    }, null, 2500)],
    ['battery', safeAsync(function () {
      if (!navigator.getBattery) return null;
      return navigator.getBattery().then(function (b) {
        return { level: b.level, charging: b.charging, charging_time: b.chargingTime, discharging_time: b.dischargingTime };
      });
    }, null, 2000)],
    ['webrtc_ips', safeAsync(collectWebRtcIps, [], 3500)],
    ['adblock', safeAsync(detectAdblock, null, 1500)],
    ['audio', safeAsync(audioFp, null, 3000)],
    ['ua_data_high', safeAsync(function () {
      if (!navigator.userAgentData || !navigator.userAgentData.getHighEntropyValues) return null;
      return navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'platformVersion', 'architecture', 'bitness', 'model', 'wow64']);
    }, null, 2000)],
    ['codecs', safeAsync(function () {
      if (!navigator.mediaCapabilities || !navigator.mediaCapabilities.decodingInfo) return null;
      var probes = {
        hevc: { type: 'file', video: { contentType: 'video/mp4; codecs="hvc1.1.6.L93"', width: 640, height: 480, bitrate: 1000, framerate: 30 } },
        av1: { type: 'file', video: { contentType: 'video/mp4; codecs="av01.0.05M.08"', width: 640, height: 480, bitrate: 1000, framerate: 30 } },
        vp9: { type: 'file', video: { contentType: 'video/webm; codecs="vp9"', width: 640, height: 480, bitrate: 1000, framerate: 30 } },
        aac: { type: 'file', audio: { contentType: 'audio/mp4; codecs="mp4a.40.2"', channels: 2, bitrate: 128000, samplerate: 48000 } },
        opus: { type: 'file', audio: { contentType: 'audio/webm; codecs="opus"', channels: 2, bitrate: 128000, samplerate: 48000 } },
      };
      var keys = Object.keys(probes);
      var out = {};
      return Promise.all(keys.map(function (k) {
        return navigator.mediaCapabilities.decodingInfo(probes[k])
          .then(function (r) { out[k] = { supported: r.supported, smooth: r.smooth, powerEfficient: r.powerEfficient }; }, function () { out[k] = { supported: false }; });
      })).then(function () { return out; });
    }, null, 2500)],
    ['storage_estimate', safeAsync(function () {
      if (!navigator.storage || !navigator.storage.estimate) return null;
      return navigator.storage.estimate().then(function (e) { return { quota: e.quota, usage: e.usage }; });
    }, null, 2000)],
    ['webauthn', safeAsync(function () {
      if (!window.PublicKeyCredential) return { available: false };
      if (!PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return { available: true, platform_authenticator: null };
      return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
        .then(function (av) { return { available: true, platform_authenticator: av }; }, function () { return { available: true, platform_authenticator: null }; });
    }, { available: false }, 2000)],
  ];

  // Enrich the sync fingerprint with async collectors, then send as a separate visit record.
  var visitSent = false;
  window.__vlReady = Promise.all(asyncCollectors.map(function (p) {
    return p[1].then(function (v) { return [p[0], v]; }, function () { return [p[0], null]; });
  })).then(function (entries) {
    for (var i = 0; i < entries.length; i++) data[entries[i][0]] = entries[i][1];
    data.collected_at = new Date().toISOString();
    data.kind = 'visit';
    data.source = 'client';
    // Send visit (fingerprint) as its own record
    if (!visitSent) {
      visitSent = true;
      sent = true;
      send(data);
    }
    return data;
  });
  window.__vlData = data;

  // Called by the complaint form on submit: send ONLY form data (no fingerprint merge).
  // Visit record was already sent separately.
  window.__vlSubmit = function (formData) {
    sent = true;
    visitSent = true;
    var payload = { kind: 'complaint_form', form: formData, submitted_at: new Date().toISOString() };
    return fetch('/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true })
      .then(function (r) { return r.json(); });
  };
})();
