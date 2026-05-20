/* VirtualBox-like splash -> boot text -> load site
   Sequence changed:
   - Show splash (5s)
   - Show a single boot line that updates in place (cycles dot variants)
   - After a short period, load the site
*/

const SPLASH_DURATION = 3000; // milliseconds
const DOT_INTERVAL = 500;     // time between dot updates
const BOOT_TOTAL_DURATION = 3500; // how long the boot-up cycle runs before proceeding
const POST_BOOT_DELAY = 300;  // wait after cycle before loading site
const BOOT_VARIANTS = [
  "Booting From Hard Disk",
  "Booting From Hard Disk.",
  "Booting From Hard Disk..",
  "Booting From Hard Disk...",
  "Booting From Hard Disk....",
  "Booting From Hard Disk.....",
  "Booting From Hard Disk......"
];

const splashEl = document.getElementById('splash');
const bootEl = document.getElementById('boot');
const runtimeEl = document.getElementById('runtime');
const bootTextEl = document.getElementById('boot-text');
const iframe = document.getElementById('site-frame');
const biosEl = document.getElementById('bios');

// best-effort fullscreen when iframe content loads (helps with sites that take time to navigate)
// Request fullscreen on the documentElement so persistent UI controls (Restart) remain inside fullscreen.
if (iframe) {
  iframe.addEventListener('load', async () => {
    try {
      const target = document.documentElement;
      if (target.requestFullscreen) {
        await target.requestFullscreen();
      } else if (target.webkitRequestFullscreen) {
        await target.webkitRequestFullscreen();
      } else if (target.msRequestFullscreen) {
        await target.msRequestFullscreen();
      }
    } catch (err) {
      // ignore fullscreen failures
    }
  });
}
// detect touch capability early so mobile-specific logic can safely reference it
const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

/* store a selected disk URL so the boot sequence can load it after normal boot
   and store a selected RAM allocation (MB) from BIOS settings */
let selectedDiskUrl = null;
let selectedRamMb = 512; // default RAM in MB (must be within slider 1-1000)

let skipSequence = false; // set true if F12 pressed to open BIOS
let bootIntervalHandle = null;
let outsideKbdClickHandler = null;

function show(el){
  el.classList.remove('hidden');
  el.style.display = 'flex';
}

function hide(el){
  el.classList.add('hidden');
  el.style.display = 'none';
}

function createSingleBootLine(){
  // create one line that will update its text content
  bootTextEl.innerHTML = '';
  const line = document.createElement('div');
  line.className = 'boot-line visible'; // visible immediately
  line.textContent = BOOT_VARIANTS[0];
  bootTextEl.appendChild(line);
  return line;
}

function startBootCycle({onComplete} = {}) {
  // ensure any previous interval is cleared so we never run multiple timers concurrently
  if (bootIntervalHandle) {
    clearInterval(bootIntervalHandle);
    bootIntervalHandle = null;
  }

  // create or reuse the single boot line so text updates are predictable
  const line = createSingleBootLine();
  let idx = 0;
  const start = Date.now();

  // defensive: ensure BOOT_VARIANTS is a non-empty array
  const variants = Array.isArray(BOOT_VARIANTS) && BOOT_VARIANTS.length ? BOOT_VARIANTS : ["Booting From Hard Disk"];

  // immediately set first frame to avoid initial blank/lag
  line.textContent = variants[0];

  bootIntervalHandle = setInterval(() => {
    // if the boot stage has been hidden or BIOS was opened, stop the cycle early
    if (skipSequence || bootEl.classList.contains('hidden')) {
      clearInterval(bootIntervalHandle);
      bootIntervalHandle = null;
      if (onComplete) onComplete();
      return;
    }

    idx = (idx + 1) % variants.length;
    line.textContent = variants[idx];

    if (Date.now() - start >= BOOT_TOTAL_DURATION) {
      clearInterval(bootIntervalHandle);
      bootIntervalHandle = null;
      if (onComplete) onComplete();
    }
  }, DOT_INTERVAL);
}

function openBIOS(){
  // hide the on-screen restart controls while BIOS is visible
  hideRestartBtn();
  hideReveal();

  // show BIOS and stop the normal splash->boot->runtime flow
  skipSequence = true;
  if (bootIntervalHandle) {
    clearInterval(bootIntervalHandle);
    bootIntervalHandle = null;
  }
  hide(splashEl);
  hide(bootEl);
  hide(runtimeEl);
  show(biosEl);
  biosEl.setAttribute('aria-hidden','false');

  // small focus and wire up BIOS menu interactions
  const panel = document.getElementById('bios-panel');
  setTimeout(()=> panel && panel.focus && panel.focus(), 50);

  // toggle submenu visibility
  document.querySelectorAll('.menu-btn').forEach(btn => {
    btn.onclick = (ev) => {
      const action = btn.getAttribute('data-action');
      // If a simple action like hide-bios or fullscreen or shutdown/restart
      if (action === 'hide-bios') {
        closeBIOSAndStartBoot();
        return;
      }
      if (action === 'fullscreen') {
        // enter fullscreen
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(()=>{});
        } else {
          document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
        }
        return;
      }
      // toggle corresponding submenu
      const submenu = document.querySelector(`.submenu[data-for="${action}"]`);
      if (submenu) submenu.classList.toggle('visible');
    };
  });

  // Initialize RAM slider UI inside BIOS and wire up change events
  const ramSlider = document.getElementById('ram-slider');
  const ramValueLabel = document.getElementById('ram-value');

  // New: Refresh-rate (Hz) slider elements and default
  const hzSlider = document.getElementById('hz-slider');
  const hzValueLabel = document.getElementById('hz-value');
  // session-scoped selectedHz variable (default 60.00)
  let selectedHz = typeof window.selectedHz !== 'undefined' ? window.selectedHz : 60.00;

  if (ramSlider && ramValueLabel) {
    // ensure selectedRamMb is always within allowed bounds [1,1000]
    const clampRam = (v) => Math.min(1000, Math.max(1, Number(v) || 1));

    // sync UI with current selectedRamMb (clamped)
    selectedRamMb = clampRam(selectedRamMb);
    ramSlider.min = 1;
    ramSlider.max = 1000;
    ramSlider.value = selectedRamMb;
    ramValueLabel.textContent = `${selectedRamMb} MB`;

    // update on input for instant feedback (and clamp)
    ramSlider.addEventListener('input', (ev) => {
      const v = clampRam(ramSlider.value);
      selectedRamMb = v;
      ramSlider.value = v;
      ramValueLabel.textContent = `${v} MB`;
    });

    // on change (when user releases), persist the setting (in-memory) and confirm
    ramSlider.addEventListener('change', (ev) => {
      selectedRamMb = clampRam(ramSlider.value);
      ramSlider.value = selectedRamMb;
      const footer = document.getElementById('bios-footer');
      if (footer) {
        footer.innerHTML = `<small class="muted">RAM set to ${selectedRamMb} MB.</small>`;
        setTimeout(() => {
          if (footer) footer.innerHTML = `<small class="muted">Use touch or click to choose an option.</small>`;
        }, 2200);
      }
    });
  }

  // Initialize Hz slider UI inside BIOS and wire up change events
  if (hzSlider && hzValueLabel) {
    // clamp helper for Hz with two-decimal handling
    const clampHz = (v) => {
      const num = Number(v) || 56.25;
      const min = 56.25;
      const max = 98.95;
      const clamped = Math.min(max, Math.max(min, num));
      // normalize to two decimals
      return Math.round(clamped * 100) / 100;
    };

    // small helper: map selectedHz to simulated FPS (Hz < 75 => 13 FPS, else => 85 FPS)
    const computeSimulatedFps = (hz) => {
      const n = Number(hz) || 56.25;
      return n < 75 ? 13 : 85;
    };

    // sync UI with current selectedHz (clamped)
    selectedHz = clampHz(selectedHz);
    hzSlider.min = 56.25;
    hzSlider.max = 98.95;
    hzSlider.step = 0.01;
    // ensure value string uses dot and two decimals for input compatibility
    hzSlider.value = selectedHz.toFixed(2);
    hzValueLabel.textContent = `${selectedHz.toFixed(2)} Hz`;

    // initialize and expose simulated FPS
    window.selectedHz = selectedHz;
    window.simulatedFps = computeSimulatedFps(selectedHz);
    // show initial simulated FPS in BIOS footer briefly
    const initFooter = document.getElementById('bios-footer');
    if (initFooter) {
      initFooter.innerHTML = `<small class="muted">Simulated FPS: ${window.simulatedFps} FPS</small>`;
      setTimeout(() => {
        if (initFooter) initFooter.innerHTML = `<small class="muted">Use touch or click to choose an option.</small>`;
      }, 1800);
    }

    // update on input for instant feedback (and clamp)
    hzSlider.addEventListener('input', (ev) => {
      const v = clampHz(hzSlider.value);
      selectedHz = v;
      hzSlider.value = v.toFixed(2);
      hzValueLabel.textContent = `${v.toFixed(2)} Hz`;
      // live-update simulated fps preview
      window.selectedHz = selectedHz;
      window.simulatedFps = computeSimulatedFps(selectedHz);
      const footer = document.getElementById('bios-footer');
      if (footer) footer.innerHTML = `<small class="muted">Simulated FPS: ${window.simulatedFps} FPS</small>`;
    });

    // on change (when user releases), persist the setting (in-memory) and confirm
    hzSlider.addEventListener('change', (ev) => {
      selectedHz = clampHz(hzSlider.value);
      hzSlider.value = selectedHz.toFixed(2);
      // persist and display confirmation
      window.selectedHz = selectedHz;
      window.simulatedFps = computeSimulatedFps(selectedHz);
      const footer = document.getElementById('bios-footer');
      if (footer) {
        footer.innerHTML = `<small class="muted">Refresh rate set to ${selectedHz.toFixed(2)} Hz — Simulated FPS: ${window.simulatedFps} FPS.</small>`;
        setTimeout(() => {
          if (footer) footer.innerHTML = `<small class="muted">Use touch or click to choose an option.</small>`;
        }, 2200);
      }
      // expose to global session if other code needs it
      window.selectedHz = selectedHz;
    });
  }

  // shutdown / restart handlers (simulate by hiding BIOS and loading/or not loading site)
  document.querySelectorAll('[data-action="shutdown"]').forEach(el=>{
    el.onclick = ()=> {
      // simulate shutdown: hide BIOS and do not continue to runtime
      hide(biosEl);
      biosEl.setAttribute('aria-hidden','true');
      // restore on-screen restart controls so the user can restart/shutdown from the normal UI
      showRestartBtn();
      // leave page on white panel (no further action)
    };
  });
  document.querySelectorAll('[data-action="restart"]').forEach(el=>{
    el.onclick = ()=> {
      // simulate restart: restart the sequence from splash
      hide(biosEl);
      biosEl.setAttribute('aria-hidden','true');
      // restore restart control and reset state and restart sequence
      showRestartBtn();
      skipSequence = false;
      startSequence();
    };
  });

  // helper to attach click behavior to a disk button element
  function attachDiskClick(el) {
    el.onclick = () => {
      const url = el.getAttribute('data-disk-url');
      selectedDiskUrl = url;
      hide(biosEl);
      biosEl.setAttribute('aria-hidden','true');
      showRestartBtn();
      skipSequence = false;
      startSequence();
    };
  }

  // initial disk item clicks: set iframe and proceed to runtime
  document.querySelectorAll('.disk-item').forEach(item=>{
    attachDiskClick(item);
  });

  // Upload Hard Disk handler: prompt for a website URL and add a new disk entry named <host>-harddisk
  document.querySelectorAll('.disk-upload').forEach(btn=>{
    btn.onclick = async () => {
      // prompt user for a URL (a website that should act as the "hard disk")
      const raw = window.prompt('Enter website URL to upload as hard disk (example: https://example.com):');
      if (!raw) return;
      let url;
      try {
        // normalize and validate URL
        url = new URL(raw.trim());
      } catch (err) {
        // if user omitted scheme, try adding https
        try {
          url = new URL('https://' + raw.trim());
        } catch (err2) {
          alert('Invalid URL');
          return;
        }
      }
      // derive a friendly disk name using hostname and ensure it ends with -harddisk
      const hostname = url.hostname.replace(/^www\./, '');
      const diskName = `${hostname}-harddisk`;

      // create button element and append into hard-disk submenu
      const hardDiskContainer = document.querySelector('.submenu.nested[data-for="hard-disk"]');
      if (!hardDiskContainer) {
        alert('Unable to locate Hard Disk container.');
        return;
      }
      const newBtn = document.createElement('button');
      newBtn.className = 'disk-item';
      newBtn.setAttribute('data-disk-name', diskName);
      newBtn.setAttribute('data-disk-url', url.href);
      newBtn.textContent = diskName;

      // append and attach click handler
      hardDiskContainer.appendChild(newBtn);
      attachDiskClick(newBtn);

      // hide BIOS and start boot with the newly uploaded disk selected
      selectedDiskUrl = url.href;
      hide(biosEl);
      biosEl.setAttribute('aria-hidden','true');
      showRestartBtn();
      skipSequence = false;
      startSequence();
    };
  });

  // Boot sector menu handling
  document.querySelectorAll('[data-action="boot-sector-open"]').forEach(el=>{
    el.onclick = (ev) => {
      // show confirmation modal inside BIOS
      const modal = document.getElementById('boot-sector-modal');
      if (!modal) return;
      modal.classList.remove('hidden');
      modal.setAttribute('aria-hidden','false');

      // wire up buttons
      const noBtn = document.getElementById('boot-sector-no');
      const yesBtn = document.getElementById('boot-sector-yes');

      function closeModal(){
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden','true');
        if (noBtn) noBtn.onclick = null;
        if (yesBtn) yesBtn.onclick = null;
      }

      if (noBtn) noBtn.onclick = () => { closeModal(); };
      if (yesBtn) yesBtn.onclick = () => {
        // user confirmed — hide BIOS and enter boot-sector terminal (do NOT load the normal site)
        closeModal();
        hide(biosEl);
        biosEl.setAttribute('aria-hidden','true');
        showBootSectorTerminal();
      };
    };
  });

  // Shutdown / restart handlers
  document.querySelectorAll('[data-action="shutdown"]').forEach(el=>{
    el.onclick = ()=> {
      hide(biosEl);
      biosEl.setAttribute('aria-hidden','true');
      showRestartBtn();
    };
  });
  document.querySelectorAll('[data-action="restart"]').forEach(el=>{
    el.onclick = ()=> {
      hide(biosEl);
      biosEl.setAttribute('aria-hidden','true');
      showRestartBtn();
      skipSequence = false;
      startSequence();
    };
  });

  // show a simple boot-sector terminal that accepts special commands
  function showBootSectorTerminal() {
    // ensure other stages hidden and show boot stage
    hide(splashEl);
    hide(runtimeEl);
    show(bootEl);

    // prepare boot text and terminal area
    bootTextEl.innerHTML = '';
    const line = document.createElement('div');
    line.className = 'boot-line visible';
    line.textContent = BOOT_VARIANTS[0];
    bootTextEl.appendChild(line);

    const term = document.createElement('div');
    term.style.marginTop = '14px';
    term.style.width = '96%';
    term.style.maxWidth = '1200px';
    term.style.fontFamily = 'monospace';
    term.style.fontSize = '15px';
    term.style.color = 'var(--text)';
    term.style.whiteSpace = 'pre-wrap';

    // initial prompt info
    term.innerText = "Boot Sector Console\nType !help for commands\n\n> ";
    bootTextEl.appendChild(term);

    // create an invisible but focusable input to capture typed commands (mobile-friendly)
    const cmdInput = document.createElement('input');
    cmdInput.type = 'text';
    // place it just off-screen but keep it focusable so IME and virtual keyboards work
    cmdInput.style.position = 'fixed';
    cmdInput.style.left = '8px';
    cmdInput.style.top = '8px';
    cmdInput.style.opacity = '0';
    cmdInput.style.width = '2px';
    cmdInput.style.height = '2px';
    cmdInput.style.pointerEvents = 'auto';
    cmdInput.autocapitalize = 'off';
    cmdInput.autocomplete = 'off';
    cmdInput.spellcheck = false;
    document.body.appendChild(cmdInput);
    // ensure focus so keydown reads the input's value
    setTimeout(()=> cmdInput.focus(), 10);

    // buffer to show in terminal
    function appendToTerm(text) {
      term.innerText = term.innerText + text;
      // keep prompt at end
      if (!term.innerText.endsWith('\n\n> ')) {
        if (!term.innerText.endsWith('> ')) term.innerText += '\n';
        term.innerText += '> ';
      }
      // keep viewport stable
      window.scrollTo(0,0);
    }

    // process commands typed via global keydown when terminal active
    function onKeyDown(e){
      // if an input or textarea is focused elsewhere, ignore
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active !== cmdInput) return;

      // handle Enter: submit current buffer
      if (e.key === 'Enter') {
        e.preventDefault();
        const raw = (cmdInput.value || '').trim();
        cmdInput.value = '';
        // echo command
        term.innerText = term.innerText.replace(/\> $/,'') + raw + '\n\n> ';
        handleBootCommand(raw.toLowerCase());
        return;
      }

      // handle Backspace: edit the buffer
      if (e.key === 'Backspace') {
        e.preventDefault();
        const v = cmdInput.value || '';
        if (v.length > 0) {
          cmdInput.value = v.slice(0, -1);
        }
        return;
      }

      // ignore modifier keys and navigation keys
      if (e.key.length !== 1) return;

      // printable character: append to buffer and ensure focus
      e.preventDefault();
      cmdInput.value = (cmdInput.value || '') + e.key;
      // keep keyboard focus on the hidden input for IME support
      try { cmdInput.focus(); } catch (err) {}
    }
    document.addEventListener('keydown', onKeyDown);

    // command logic
    let deletedSystem = false;
    function handleBootCommand(cmd){
      if (!cmd) return;
      if (cmd === '!help') {
        appendToTerm("\nAvailable commands:\n1. !help\n2. !Del\n3. !Copy\n4. !Paste\n5. !Edit\n6. !mostdonated\n\nUse exact paths for deletion (example: !Del C:\\Windows\\System32)\n\n");
        return;
      }
      // new: most donated listing
      if (cmd === '!mostdonated') {
        appendToTerm("\n1. Xmcgrath2010 Donated 1000♦\n\n");
        return;
      }
      if (cmd.startsWith('!del')) {
        // support forms like: !del c:\windows\system32
        if (cmd.includes('c:\\windows\\system32')) {
          deletedSystem = true;
          appendToTerm("\nDeleting C:\\Windows\\System32 ...\nOperation completed.\n\n");
        } else {
          appendToTerm("\nSpecified file/folder not found or permission denied.\n\n");
        }
        return;
      }
      if (cmd === '!rs') {
        // perform restart but if deleted system then simulate boot failure and DO NOT load site
        appendToTerm("\nRestarting...\n\n");
        document.removeEventListener('keydown', onKeyDown);
        cmdInput.remove();
        // restart animation: show boot line cycling then show failure if deletedSystem
        runBootCycleThenHandleError(deletedSystem);
        return;
      }
      // fallback responses for other commands
      appendToTerm("\nUnknown command. Type !help for a list of commands.\n\n");
    }

    // helper to animate boot line then either load site or show boot files error
    function runBootCycleThenHandleError(errorState) {
      // animate the single-line cycle quickly
      let idx = 0;
      line.textContent = BOOT_VARIANTS[0];
      const start = Date.now();
      const total = 2500;
      const iv = setInterval(() => {
        idx = (idx + 1) % BOOT_VARIANTS.length;
        line.textContent = BOOT_VARIANTS[idx];
        if (Date.now() - start >= total) {
          clearInterval(iv);
          // if errorState true, show failure and do not load site
          if (errorState) {
            const fail = document.createElement('div');
            fail.className = 'boot-line visible';
            fail.style.marginTop = '10px';
            fail.textContent = "Windows can't load boot files.";
            bootTextEl.appendChild(fail);
            // keep runtime hidden, do not set iframe src
            // restore restart control so the user can try again
            showRestartBtn();
          } else {
            // otherwise proceed to runtime as normal
            hide(bootEl);
            show(runtimeEl);
            // attempt to enter fullscreen when the runtime (game) starts
            (async function enterFullscreenIfPossible(){
              try {
                // prefer requesting fullscreen on the runtime iframe (better chance to succeed)
                const target = iframe || document.getElementById('site-frame') || runtimeEl || document.documentElement;
                if (target.requestFullscreen) {
                  await target.requestFullscreen();
                } else if (target.webkitRequestFullscreen) {
                  await target.webkitRequestFullscreen();
                } else if (target.msRequestFullscreen) {
                  await target.msRequestFullscreen();
                }
              } catch (err) {
                // ignore fullscreen failures
              }
            })();
            // compute and attach simulated FPS indicator before navigating
            window.simulatedFps = window.simulatedFps || (typeof window.selectedHz !== 'undefined' ? (window.selectedHz < 75 ? 13 : 85) : 13);
            const fpsLine = document.createElement('div');
            fpsLine.className = 'boot-line visible';
            fpsLine.style.marginTop = '8px';
            fpsLine.textContent = `Running at ${window.simulatedFps} FPS`;
            bootTextEl.appendChild(fpsLine);

            iframe.src = selectedDiskUrl || "https://xp.quenq.com/";
          }
        }
      }, DOT_INTERVAL);
    }
  }

  // initialize keyboard toggle button; on mobile we auto-open and keep the keyboard persistent
  const kbdToggle = document.getElementById('kbd-toggle');
  const vkbd = document.getElementById('virtual-kbd');

  function hideVirtualKeyboard() {
    if (!vkbd) return;
    vkbd.classList.add('hidden');
    vkbd.setAttribute('aria-hidden','true');
    if (kbdToggle) kbdToggle.setAttribute('aria-pressed','false');
  }

  if (kbdToggle) {
    kbdToggle.onclick = () => {
      const pressed = kbdToggle.getAttribute('aria-pressed') === 'true';
      const willOpen = !pressed;
      kbdToggle.setAttribute('aria-pressed', String(willOpen));
      if (!vkbd) return;
      if (!willOpen) {
        hideVirtualKeyboard();
      } else {
        vkbd.classList.remove('hidden');
        vkbd.setAttribute('aria-hidden','false');
        // do NOT attach outside-click or auto-hide timers on mobile — keyboard stays until user hides it
      }
    };
  }

  // auto-open keyboard immediately on mobile devices when BIOS opens
  if (vkbd && ('ontouchstart' in window || navigator.maxTouchPoints > 0)) {
    vkbd.classList.remove('hidden');
    vkbd.setAttribute('aria-hidden','false');
    if (kbdToggle) kbdToggle.setAttribute('aria-pressed','true');
  }

  // build keyboard UI if not present
  if (vkbd && !vkbd.dataset.built) {
    buildVirtualKeyboard(vkbd);
    vkbd.dataset.built = '1';
  }
}

function closeBIOSAndStartBoot(){
  // close BIOS and start boot sequence directly
  hide(biosEl);
  biosEl.setAttribute('aria-hidden','true');
  // restore on-screen restart controls when BIOS closes
  showRestartBtn();
  // ensure virtual keyboard is hidden when BIOS closes
  const vkbd = document.getElementById('virtual-kbd');
  const kbdToggle = document.getElementById('kbd-toggle');
  if (vkbd) {
    vkbd.classList.add('hidden');
    vkbd.setAttribute('aria-hidden','true');
    if (vkbd._autoHideTimer) { clearTimeout(vkbd._autoHideTimer); delete vkbd._autoHideTimer; }
    document.removeEventListener('pointerdown', outsideKbdClickHandler);
  }
  if (kbdToggle) kbdToggle.setAttribute('aria-pressed','false');

  // start boot stage immediately
  startBootOnly();
}

async function startBootOnly(){
  // show boot stage (skip splash)
  hide(splashEl);
  hide(runtimeEl);
  show(bootEl);
  // start the single-line updating boot cycle
  await new Promise(r => setTimeout(r, 120));
  await new Promise((resolve) => {
    startBootCycle({ onComplete: resolve });
  });
  await new Promise(r => setTimeout(r, POST_BOOT_DELAY));
  // If allocated RAM is too small, show a clear error instead of loading the site
  if (typeof selectedRamMb === 'number' && selectedRamMb < 16) {
    const fail = document.createElement('div');
    fail.className = 'boot-line visible';
    fail.style.marginTop = '10px';
    fail.textContent = "Not Enough RAM!";
    bootTextEl.appendChild(fail);
    // keep runtime hidden and restore restart control
    showRestartBtn();
    return;
  }
  hide(bootEl);
  show(runtimeEl);
  // attempt to enter fullscreen when the runtime (game) starts
  (async function enterFullscreenIfPossible(){
    try {
      const docEl = document.documentElement;
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen();
      } else if (docEl.webkitRequestFullscreen) {
        await docEl.webkitRequestFullscreen();
      } else if (docEl.msRequestFullscreen) {
        await docEl.msRequestFullscreen();
      }
    } catch (err) {
      // ignore fullscreen failures
    }
  })();
  iframe.src = selectedDiskUrl || "https://xp.quenq.com/";
}

async function startSequence(){
  // 1) show splash for duration
  show(splashEl);
  hide(bootEl);
  hide(runtimeEl);

  // Ensure Restart button is visible/enabled while splash is shown (so user can always restart)
  showRestartBtn();

  // Request fullscreen on the documentElement (not the splash element) so in-fullscreen UI remains clickable.
  (async function trySplashFullscreen(){
    try {
      const docEl = document.documentElement;
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen();
      } else if (docEl.webkitRequestFullscreen) {
        await docEl.webkitRequestFullscreen();
      } else if (docEl.msRequestFullscreen) {
        await docEl.msRequestFullscreen();
      }
    } catch (err) {
      // ignore fullscreen failures
    }
  })();

  await new Promise(r => setTimeout(r, SPLASH_DURATION));

  // If BIOS was opened during splash, do nothing (BIOS is shown)
  if (skipSequence) return;

  // 2) show boot stage with single updating line
  hide(splashEl);
  show(bootEl);

  await new Promise(r => setTimeout(r, 120));
  await new Promise((resolve) => {
    startBootCycle({ onComplete: resolve });
  });

  // short pause then load site
  await new Promise(r => setTimeout(r, POST_BOOT_DELAY));
  // If allocated RAM is too small, show a clear error instead of loading the site
  if (typeof selectedRamMb === 'number' && selectedRamMb < 16) {
    const fail = document.createElement('div');
    fail.className = 'boot-line visible';
    fail.style.marginTop = '10px';
    fail.textContent = "Not Enough RAM!";
    bootTextEl.appendChild(fail);
    showRestartBtn();
    return;
  }
  hide(bootEl);
  show(runtimeEl);
  // attempt to enter fullscreen when the runtime (game) starts
  (async function enterFullscreenIfPossible(){
    try {
      const docEl = document.documentElement;
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen();
      } else if (docEl.webkitRequestFullscreen) {
        await docEl.webkitRequestFullscreen();
      } else if (docEl.msRequestFullscreen) {
        await docEl.msRequestFullscreen();
      }
    } catch (err) {
      // ignore fullscreen failures
    }
  })();
  iframe.src = selectedDiskUrl || "https://xp.quenq.com/";
}

 // Key handling: F12 opens BIOS during splash; Esc closes BIOS and proceeds to boot
document.addEventListener('keydown', (e) => {
  if (e.key === 'F12') {
    // Only open BIOS if splash is visible
    if (!splashEl.classList.contains('hidden')) {
      e.preventDefault();
      openBIOS();
    }
  } else if (e.key === 'Escape') {
    // If BIOS open, close and continue to boot
    if (!biosEl.classList.contains('hidden')) {
      e.preventDefault();
      closeBIOSAndStartBoot();
    }
  }
});

// Mobile triple-tap on splash opens BIOS: count quick taps (3 within 800ms window)
if (isTouchDevice && splashEl) {
  let splashTapCount = 0;
  let splashTapTimer = null;
  const SPLASH_TRIPLE_TAP_WINDOW = 800; // ms
  splashEl.addEventListener('pointerdown', (ev) => {
    // only consider taps from touch/pen
    if (ev.pointerType === 'touch' || ev.pointerType === 'pen') {
      splashTapCount += 1;
      if (splashTapTimer) clearTimeout(splashTapTimer);
      splashTapTimer = setTimeout(() => {
        splashTapCount = 0;
        splashTapTimer = null;
      }, SPLASH_TRIPLE_TAP_WINDOW);
      if (splashTapCount >= 3) {
        // reset and open BIOS only if splash currently visible
        splashTapCount = 0;
        if (!splashEl.classList.contains('hidden')) {
          openBIOS();
        }
      }
    }
  }, {passive:true});
}

/* Virtual keyboard builder and helpers */
function buildVirtualKeyboard(container){
  // layout rows (simple compact keyboard)
  const rows = [
    ['1','2','3','4','5','6','7','8','9','0','Back'],
    ['q','w','e','r','t','y','u','i','o','p'],
    ['a','s','d','f','g','h','j','k','l','Enter'],
    ['z','x','c','v','b','n','m',',','.','/'],
    ['Space']
  ];
  rows.forEach(r=>{
    const row = document.createElement('div');
    row.className = 'kbd-row';
    r.forEach(key => {
      const k = document.createElement('button');
      k.type = 'button';
      k.className = 'kbd-key';
      if (key === 'Space') k.classList.add('wide');
      if (key === 'Enter' || key === 'Back') k.classList.add('wide');
      k.textContent = key;
      k.onclick = () => {
        handleVirtualKey(key);
        // no auto-hide behavior on mobile; keyboard remains until explicitly closed
      };
      row.appendChild(k);
    });
    container.appendChild(row);
  });
  // small hint row
  const hint = document.createElement('div');
  hint.className = 'kbd-row';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'kbd-key wide';
  closeBtn.textContent = 'Close';
  closeBtn.onclick = () => {
    const kbdToggle = document.getElementById('kbd-toggle');
    if (container) { container.classList.add('hidden'); container.setAttribute('aria-hidden','true'); }
    if (kbdToggle) kbdToggle.setAttribute('aria-pressed','false');
    // clear auto-hide timer
    if (container && container._autoHideTimer) { clearTimeout(container._autoHideTimer); delete container._autoHideTimer; }
    document.removeEventListener('pointerdown', outsideKbdClickHandler);
  };
  hint.appendChild(closeBtn);
  container.appendChild(hint);
}

function handleVirtualKey(key){
  // Try to send key to focused element (if it's an input or contenteditable)
  const act = document.activeElement;
  let eventKey = key;
  if (key === 'Back') {
    // emulate Backspace
    const kb = new KeyboardEvent('keydown',{key:'Backspace',bubbles:true});
    act && act.dispatchEvent(kb);
    // also modify value if it's an input/textarea
    if (act && (act.tagName === 'INPUT' || act.tagName === 'TEXTAREA')) {
      const start = act.selectionStart || 0;
      const end = act.selectionEnd || 0;
      if (start === end && start > 0) {
        const val = act.value;
        act.value = val.slice(0, start-1) + val.slice(end);
        act.setSelectionRange(start-1, start-1);
        act.dispatchEvent(new Event('input',{bubbles:true}));
      } else if (start !== end) {
        const val = act.value;
        act.value = val.slice(0, start) + val.slice(end);
        act.setSelectionRange(start, start);
        act.dispatchEvent(new Event('input',{bubbles:true}));
      }
    }
    return;
  }
  if (key === 'Enter') {
    const kb = new KeyboardEvent('keydown',{key:'Enter',bubbles:true});
    act && act.dispatchEvent(kb);
    return;
  }
  if (key === 'Space') eventKey = ' ';
  // for normal characters, try to insert into input/textarea or send key events
  if (act && (act.tagName === 'INPUT' || act.tagName === 'TEXTAREA')) {
    const start = act.selectionStart || 0;
    const end = act.selectionEnd || 0;
    const val = act.value || '';
    act.value = val.slice(0, start) + eventKey + val.slice(end);
    const newPos = start + eventKey.length;
    act.setSelectionRange(newPos, newPos);
    act.dispatchEvent(new Event('input',{bubbles:true}));
    act.focus();
    return;
  }
  // else, dispatch a KeyboardEvent globally so interactive elements can react
  const kb = new KeyboardEvent('keydown',{key:eventKey,bubbles:true});
  document.dispatchEvent(kb);
}



/* Start immediately */
startSequence();