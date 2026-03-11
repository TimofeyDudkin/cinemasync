// ═══════════════════════════════════════
//  CinemaSync — Redirect Sync Module
//  Подключите этот файл в index.html перед </body>
// ═══════════════════════════════════════

// ── ОТКРЫТЬ МОДАЛКУ ПЕРЕХОДА
function openRedirectModal() {
  const bg = document.getElementById('redirect-modal-bg');
  if (!bg) { createRedirectUI(); setTimeout(openRedirectModal, 50); return; }
  bg.classList.add('show');
}
function closeRedirectModal(e) {
  if (e && e.target !== document.getElementById('redirect-modal-bg')) return;
  document.getElementById('redirect-modal-bg').classList.remove('show');
}
function setRedirectQuick(url) {
  document.getElementById('redirect-url-inp').value = url;
}
function sendRedirectBoth() {
  let url = document.getElementById('redirect-url-inp').value.trim();
  if (!url) { toast && toast('Введите адрес'); return; }
  if (!/^https?:\/\//.test(url)) url = 'https://' + url;
  document.getElementById('redirect-modal-bg').classList.remove('show');
  // Notify peer via existing sendSync
  if (typeof sendSync === 'function') sendSync({ type: 'redirect-both', url });
  startRedirectCd(url);
}
function startRedirectCd(url) {
  const ov = document.getElementById('rd-overlay');
  if (!ov) return;
  document.getElementById('rd-url-lbl').textContent = url.length > 50 ? url.slice(0, 50) + '...' : url;
  ov.style.display = 'flex';
  let n = 3;
  document.getElementById('rd-counter').textContent = n;
  const t = setInterval(() => {
    n--;
    if (n <= 0) { clearInterval(t); window.open(url, '_blank'); }
    else document.getElementById('rd-counter').textContent = n;
  }, 1000);
}
function goToCallPage() {
  if (typeof roomId === 'undefined' || !roomId) return;
  const base = typeof IS_SERVER !== 'undefined' && IS_SERVER ? location.origin : '';
  const url = base + '/call.html?room=' + roomId;
  if (typeof sendSync === 'function') sendSync({ type: 'redirect-both', url });
  startRedirectCd(url);
}

// ── INJECT UI если ещё не добавлено
function createRedirectUI() {
  if (document.getElementById('redirect-modal-bg')) return;

  // Modal
  const modalHTML = `
  <div class="modal-bg" id="redirect-modal-bg" onclick="closeRedirectModal(event)" style="z-index:7000">
    <div class="modal">
      <h2>🔗 Открыть сайт вместе</h2>
      <p>Оба участника перейдут на сайт одновременно</p>
      <input class="inp" id="redirect-url-inp" placeholder="https://..." type="url" autocomplete="off" style="text-align:left;margin:4px 0">
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px">
        <button class="btn btn-s" style="max-width:unset;padding:7px 13px;font-size:.72rem;border-radius:10px" onclick="setRedirectQuick('https://youtube.com')">YouTube</button>
        <button class="btn btn-s" style="max-width:unset;padding:7px 13px;font-size:.72rem;border-radius:10px" onclick="setRedirectQuick('https://netflix.com')">Netflix</button>
        <button class="btn btn-s" style="max-width:unset;padding:7px 13px;font-size:.72rem;border-radius:10px" onclick="setRedirectQuick('https://vkvideo.ru')">VK Видео</button>
        <button class="btn btn-s" style="max-width:unset;padding:7px 13px;font-size:.72rem;border-radius:10px" onclick="setRedirectQuick('https://kinopoisk.ru')">Кинопоиск</button>
      </div>
      <div class="modal-btns">
        <button class="btn btn-s" onclick="document.getElementById('redirect-modal-bg').classList.remove('show')">Отмена</button>
        <button class="btn btn-p" onclick="sendRedirectBoth()">🚀 Открыть вместе</button>
      </div>
    </div>
  </div>

  <div id="rd-overlay" style="display:none;position:fixed;inset:0;z-index:8500;background:rgba(7,9,15,.97);backdrop-filter:blur(20px);flex-direction:column;align-items:center;justify-content:center;gap:18px;text-align:center;padding:32px">
    <div style="font-size:3rem;animation:rdPulse 1s ease infinite">🚀</div>
    <div style="font-family:'Instrument Serif',serif;font-style:italic;font-size:1.8rem;background:linear-gradient(135deg,#4f9cf9,#9b6df8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">Переходим вместе!</div>
    <p id="rd-url-lbl" style="color:#7a90a4;font-size:.88rem;max-width:320px;word-break:break-all"></p>
    <div id="rd-counter" style="width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,#4f9cf9,#9b6df8);display:flex;align-items:center;justify-content:center;font-size:1.8rem;font-weight:700;color:#fff;box-shadow:0 0 40px rgba(79,156,249,.4)">3</div>
  </div>
  <style>@keyframes rdPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}</style>`;

  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

// ── HOOK INTO EXISTING handleSync to catch redirect-both
// We patch handleSync after page load
(function patchHandleSync() {
  const maxTries = 50;
  let tries = 0;
  const interval = setInterval(() => {
    tries++;
    // Look for the existing handleSync function
    if (typeof handleSync === 'function') {
      clearInterval(interval);
      const origHandleSync = handleSync;
      window.handleSync = function(msg) {
        if (msg && msg.type === 'redirect-both') {
          startRedirectCd(msg.url);
          return;
        }
        origHandleSync(msg);
      };
      console.log('[CinemaSync] redirect-sync hooked into handleSync');
    }
    if (tries >= maxTries) clearInterval(interval);
  }, 100);
})();

// ── ADD BUTTONS to invite sheet when room UI appears
(function injectButtons() {
  createRedirectUI();

  // Wait for room to be shown
  const obs = new MutationObserver(() => {
    const inviteBody = document.querySelector('#sheet-invite .sheet-body, .d-ipanel');
    if (!inviteBody) return;

    // Avoid double injection
    if (document.getElementById('cs-redirect-btns')) return;

    const leaveBtn = inviteBody.querySelector('button[onclick*="leaveRoom"]');
    if (!leaveBtn) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'cs-redirect-btns';
    wrapper.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-bottom:8px';
    wrapper.innerHTML = `
      <button class="btn btn-s" onclick="goToCallPage()" style="font-size:.84rem;padding:12px 0;color:#2dd4a0;border-color:rgba(45,212,160,.2)">📞 Перейти в звонок</button>
      <button class="btn btn-s" onclick="openRedirectModal()" style="font-size:.84rem;padding:12px 0;color:#4f9cf9;border-color:rgba(79,156,249,.2)">🔗 Открыть сайт вместе</button>
    `;
    leaveBtn.parentNode.insertBefore(wrapper, leaveBtn);
    obs.disconnect();
  });
  obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
})();
