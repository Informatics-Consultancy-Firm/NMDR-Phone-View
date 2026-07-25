/* NMDR Portal offline layer, browser side.

   Loaded by index.html as:
       <script src="nmdr-offline.js"></script>

   Drives the Update button (id nmdrUpdate, status span nmdrUpdateStatus)
   in the sidebar footer. If no such button exists a floating one is added.

   Everything reports through the console with the prefix below, so if the
   button misbehaves open DevTools and look for it.
*/

(function () {
  'use strict';

  var LOG = '[NMDR update]';
  var UPDATED_FLAG = 'nmdrJustUpdated';
  var LAST_UPDATE  = 'nmdrLastUpdate';

  var STATUS_EL, BTN, INSTALL_BTN;
  var installEvent = null;
  var busy    = false;
  var blocked = null;   // why updates cannot run at all
  var regErr  = null;   // registration threw

  /* ------------------------------------------------- can this page do it? */

  if (!('serviceWorker' in navigator)) {
    blocked = (location.protocol === 'file:')
      ? 'This page was opened directly from a file. Offline updates only work when the portal is served over https, for example on GitHub Pages.'
      : 'This browser does not support offline updates.';
  } else if (window.isSecureContext === false) {
    blocked = 'Offline updates need https. This page is on ' + location.protocol;
  }

  console.log(LOG, blocked ? 'unavailable: ' + blocked : 'supported');

  /* Set this to true to hide Chrome's own install banner and rely only on the
     sidebar Install button. Left false so the browser keeps offering to
     install by itself, which is what field users are used to seeing. */
  var SUPPRESS_BROWSER_BANNER = false;

  /* Must be registered immediately, not on DOMContentLoaded. The browser fires
     this once, early, and the reference is needed for the sidebar button.
     Note: calling preventDefault() here is what stops Chrome's own banner on
     Android, so it is deliberately NOT called by default. Saving the event
     without cancelling it still allows prompt() later. */
  window.addEventListener('beforeinstallprompt', function (e) {
    if (SUPPRESS_BROWSER_BANNER) e.preventDefault();
    installEvent = e;
    console.log(LOG, 'app can be installed');
    showInstall();
  });

  window.addEventListener('appinstalled', function () {
    installEvent = null;
    console.log(LOG, 'app installed');
    if (INSTALL_BTN) INSTALL_BTN.style.display = 'none';
    toast('NMDR installed. You can now open it from your home screen.');
  });

  /* ------------------------------------------------------------- register */

  if (!blocked) {
    navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' })
      .then(function (reg) {
        console.log(LOG, 'registered, scope', reg.scope);
      })
      .catch(function (e) {
        regErr = e;
        console.warn(LOG, 'could not register sw.js.', e && e.message);
      });
  }

  /* The button is wired even when updates are blocked, otherwise clicking it
     does nothing at all and there is no way to tell why. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireUp);
  } else {
    wireUp();
  }

  function wireUp() {
    BTN = document.getElementById('nmdrUpdate') || buildFloatingButton();
    STATUS_EL = document.getElementById('nmdrUpdateStatus') || BTN;
    BTN.addEventListener('click', runUpdate);

    INSTALL_BTN = document.getElementById('nmdrInstall');
    if (INSTALL_BTN) {
      INSTALL_BTN.addEventListener('click', runInstall);
      showInstall();
    }

    injectStyles();
    console.log(LOG, 'button wired' + (standalone() ? ', running as an installed app' : ''));

    // Confirm the previous press worked, now that the reload has happened.
    if (get(UPDATED_FLAG)) {
      del(UPDATED_FLAG);
      toast('Portal updated.');
    }
  }

  /* --------------------------------------------------------------- update */

  function runUpdate() {
    if (busy) return;

    if (blocked)           { toast(blocked); return; }
    if (!navigator.onLine) { toast('No connection. Reconnect and press Update again.'); return; }

    busy = true;
    BTN.classList.add('is-busy');
    setStatus('checking');

    navigator.serviceWorker.getRegistration()
      .then(function (reg) {
        // Registration may still be in flight on a very fast first click.
        if (reg) return reg;
        return navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' });
      })
      .then(function (reg) {
        if (!reg) throw new Error('no registration');
        // A failed update check should not abort the file refresh below.
        return reg.update().then(function () { return reg; }, function () { return reg; });
      })
      .then(function (reg) {
        var incoming = reg.installing || reg.waiting;
        if (incoming) return activateNew(incoming);
        return refreshFiles(reg);
      })
      .catch(function (e) {
        console.warn(LOG, 'failed:', e && e.message);
        finish(explain(e));
      });
  }

  function explain(e) {
    var m = (e && e.message) || '';
    if (regErr || m === 'no registration') {
      return 'Could not load sw.js. Check that sw.js sits in the same folder as index.html.';
    }
    if (m === 'timed out') {
      return 'The update took too long. Check your connection and try again.';
    }
    return 'Update failed. Open the browser console for details.';
  }

  /* A new sw.js was published: install it, then reload onto it. */
  function activateNew(worker) {
    console.log(LOG, 'new version found, installing');
    setStatus('installing');

    return new Promise(function (resolve) {
      var done = false;

      function go() {
        if (done) return;
        done = true;
        markUpdated();
        window.location.reload();
        resolve();
      }

      navigator.serviceWorker.addEventListener('controllerchange', go, { once: true });

      function push() {
        if (worker.state === 'installed') worker.postMessage({ type: 'SKIP_WAITING' });
      }
      push();
      worker.addEventListener('statechange', push);

      // The new worker may install without ever taking control. A plain reload
      // picks it up, so reload rather than leave the user on a stuck button.
      setTimeout(go, 12000);
    });
  }

  /* sw.js unchanged, but the pages and assets may have: re-download them.
     reg.active is used as well as controller, because on the very first load
     the page is not yet controlled by any worker. */
  function refreshFiles(reg) {
    var target = navigator.serviceWorker.controller || reg.active;

    if (!target) {
      console.log(LOG, 'worker not active yet, reloading to let it take over');
      window.location.reload();
      return;
    }

    setStatus('downloading');

    return send(target, { type: 'REFRESH_CONTENT' }, 120000).then(function (res) {
      if (!res || res.type !== 'REFRESH_DONE') throw new Error('bad reply');

      console.log(LOG, 'refreshed ' + res.updated + ' file(s)', res);
      if (res.failed && res.failed.length) console.warn(LOG, 'could not refresh:', res.failed);

      if (res.updated === 0) {
        finish('Nothing downloaded. Check your connection and try again.');
        return;
      }

      setStatus('updating');
      markUpdated();
      setTimeout(function () { window.location.reload(); }, 400);
    });
  }

  function send(worker, message, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var ch = new MessageChannel();
      var timer = setTimeout(function () { reject(new Error('timed out')); }, timeoutMs || 20000);

      ch.port1.onmessage = function (ev) {
        clearTimeout(timer);
        if (ev.data && ev.data.error) reject(new Error(ev.data.error));
        else resolve(ev.data);
      };

      try {
        worker.postMessage(message, [ch.port2]);
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  /* -------------------------------------------------------------- install */

  function standalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
           window.navigator.standalone === true;
  }

  /* The button is always visible unless the portal is already running as an
     installed app. It used to wait for beforeinstallprompt, but that event
     never fires when the app is already installed on the device or when any
     install criterion fails, so the button simply never appeared. */
  function showInstall() {
    if (!INSTALL_BTN) return;
    INSTALL_BTN.style.display = standalone() ? 'none' : 'flex';
  }

  function iOS() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) ||
           (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);  // iPadOS
  }

  function runInstall() {
    if (!installEvent) {
      // No prompt to show. Either the app is already installed, the browser
      // does not support prompting, or the criteria are not met. Tell the user
      // how to install by hand on their platform.
      toast(iOS()
        ? 'On iPhone and iPad, tap the Share button then Add to Home Screen.'
        : 'Use the browser menu and choose Install app, or Add to Home screen. If it is missing, NMDR is probably installed already.');
      return;
    }
    installEvent.prompt();
    installEvent.userChoice.then(function (res) {
      console.log(LOG, 'install choice:', res && res.outcome);
      if (res && res.outcome === 'accepted' && INSTALL_BTN) {
        INSTALL_BTN.style.display = 'none';
      }
      installEvent = null;
    }).catch(function (e) {
      console.warn(LOG, 'install prompt failed', e);
    });
  }

  /* ---------------------------------------------------------------- state */

  function markUpdated() {
    set(UPDATED_FLAG, '1');
    set(LAST_UPDATE, new Date().toISOString());
  }

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function del(k) { try { localStorage.removeItem(k); } catch (e) {} }

  /* ------------------------------------------------------------------- ui */

  /* With a separate status span the button keeps its label and the span
     carries the state. With the floating button the label IS the state. */
  function setStatus(text) {
    if (!STATUS_EL) return;
    if (STATUS_EL === BTN) STATUS_EL.textContent = text ? text : 'Update';
    else STATUS_EL.textContent = text ? ' \u00b7 ' + text : '';
  }

  function finish(message) {
    busy = false;
    if (BTN) BTN.classList.remove('is-busy');
    setStatus('');
    if (message) toast(message);
  }

  function buildFloatingButton() {
    var b = document.createElement('button');
    b.id = 'nmdrUpdate';
    b.className = 'nmdr-update-btn nmdr-update-float';
    b.type = 'button';
    b.textContent = 'Update';
    document.body.appendChild(b);
    return b;
  }

  function toast(text) {
    var t = document.createElement('div');
    t.className = 'nmdr-toast';
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('is-out'); }, 5200);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 5800);
  }

  function injectStyles() {
    if (document.getElementById('nmdr-offline-css')) return;
    var s = document.createElement('style');
    s.id = 'nmdr-offline-css';
    s.textContent = [
      '.nmdr-update-btn{font:600 13px/1 inherit;letter-spacing:.04em;',
      'text-transform:uppercase;color:#004080;background:#ffc107;',
      'border:0;border-radius:4px;padding:9px 16px;cursor:pointer;}',
      '.nmdr-update-btn:hover{background:#ffcd39;}',
      '.nmdr-update-btn.is-busy{opacity:.65;cursor:progress;}',
      '.nmdr-update-float{position:fixed;right:16px;bottom:16px;z-index:9998;',
      'box-shadow:0 4px 14px rgba(0,0,0,.28);}',
      '.nmdr-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);',
      'z-index:10001;max-width:88vw;background:#004080;color:#fff;',
      'font:500 13px/1.45 inherit;padding:12px 18px;border-radius:6px;',
      'box-shadow:0 6px 18px rgba(0,0,0,.3);transition:opacity .4s;}',
      '.nmdr-toast.is-out{opacity:0;}',
      '@media (prefers-reduced-motion:reduce){.nmdr-toast{transition:none;}}'
    ].join('');
    document.head.appendChild(s);
  }
})();
