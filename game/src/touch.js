// Mobile touch controls: virtual joystick + action buttons.
// Injects DOM elements and wires them to the game input/world.

export function attachTouchControls(doc, win, world, input, chooseOption) {
  const hasTouch = "ontouchstart" in win || (win.navigator && win.navigator.maxTouchPoints > 0);
  if (!hasTouch) return () => {};

  // Prevent default page gestures on the game canvas area.
  doc.body.style.touchAction = "none";

  const style = doc.createElement("style");
  style.textContent = `
    #_joy {
      position: fixed; left: 20px; bottom: 100px; z-index: 999;
      width: 112px; height: 112px; border-radius: 50%;
      background: rgba(255,255,255,0.10);
      border: 2px solid rgba(255,255,255,0.28);
      touch-action: none; user-select: none;
      display: flex; align-items: center; justify-content: center;
    }
    #_joy-knob {
      width: 46px; height: 46px; border-radius: 50%;
      background: rgba(255,255,255,0.45);
      border: 2px solid rgba(255,255,255,0.75);
      pointer-events: none;
    }
    #_act {
      position: fixed; right: 20px; bottom: 100px; z-index: 999;
      display: flex; flex-direction: column; gap: 10px; align-items: flex-end;
      touch-action: none;
    }
    ._tb {
      width: 54px; height: 54px; border-radius: 50%;
      background: rgba(255,255,255,0.15);
      border: 2px solid rgba(255,255,255,0.38);
      color: #fff; font: bold 13px/1 monospace;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; touch-action: manipulation; user-select: none;
      -webkit-tap-highlight-color: transparent;
    }
    ._tb:active { background: rgba(255,255,255,0.35); }
    #_btn-hit { background: rgba(220,50,50,0.28); border-color: rgba(220,50,50,0.6); width: 62px; height: 62px; }
    #_dlg {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 999;
      display: none; justify-content: center; gap: 10px; padding: 10px 14px;
      background: rgba(0,0,0,0.45); touch-action: manipulation;
    }
    #_dlg ._tb { width: 66px; height: 66px; font-size: 15px; }
    #_btn-esc { background: rgba(80,100,220,0.28); border-color: rgba(80,100,220,0.6); }
  `;
  doc.head.appendChild(style);

  // Joystick
  const joy = doc.createElement("div");
  joy.id = "_joy";
  const knob = doc.createElement("div");
  knob.id = "_joy-knob";
  joy.appendChild(knob);
  doc.body.appendChild(joy);

  // Action buttons
  const act = doc.createElement("div");
  act.id = "_act";
  const mk = (id, label) => {
    const b = doc.createElement("div");
    b.id = id;
    b.className = "_tb";
    b.textContent = label;
    return b;
  };
  const btnT   = mk("_btn-t",   "T");
  const btnE   = mk("_btn-e",   "E");
  const btnHit = mk("_btn-hit", "HIT");
  act.appendChild(btnT);
  act.appendChild(btnE);
  act.appendChild(btnHit);
  doc.body.appendChild(act);

  // Dialogue buttons
  const dlgEl  = doc.createElement("div");
  dlgEl.id     = "_dlg";
  const btn1   = mk("_btn-1",   "1");
  const btn2   = mk("_btn-2",   "2");
  const btn3   = mk("_btn-3",   "3");
  const btnEsc = mk("_btn-esc", "ESC");
  dlgEl.appendChild(btn1);
  dlgEl.appendChild(btn2);
  dlgEl.appendChild(btn3);
  dlgEl.appendChild(btnEsc);
  doc.body.appendChild(dlgEl);

  // --- Joystick tracking ---------------------------------------------------
  let joyId = null;
  let joyOx = 0, joyOy = 0;
  const DEAD = 14, MAX = 44;

  joy.addEventListener("touchstart", (e) => {
    e.preventDefault();
    if (joyId !== null) return;
    const t = e.changedTouches[0];
    joyId = t.identifier;
    const r = joy.getBoundingClientRect();
    joyOx = r.left + r.width  / 2;
    joyOy = r.top  + r.height / 2;
  }, { passive: false });

  win.addEventListener("touchmove", (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== joyId) continue;
      e.preventDefault();
      const dx  = t.clientX - joyOx;
      const dy  = t.clientY - joyOy;
      const mag = Math.hypot(dx, dy);
      const cl  = Math.min(mag, MAX);
      knob.style.transform = mag > 0
        ? `translate(${(dx / mag) * cl}px,${(dy / mag) * cl}px)`
        : "";
      input.up    = dy < -DEAD;
      input.down  = dy >  DEAD;
      input.left  = dx < -DEAD;
      input.right = dx >  DEAD;
    }
  }, { passive: false });

  const joyEnd = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== joyId) continue;
      joyId = null;
      knob.style.transform = "";
      input.up = input.down = input.left = input.right = false;
    }
  };
  win.addEventListener("touchend",    joyEnd);
  win.addEventListener("touchcancel", joyEnd);

  // --- Action buttons -------------------------------------------------------
  const tap = (el, fn) =>
    el.addEventListener("touchstart", (e) => { e.preventDefault(); fn(); }, { passive: false });

  tap(btnT, () => input.pressed.add("talk"));
  tap(btnE, () => input.pressed.add("interact"));

  btnHit.addEventListener("touchstart", (e) => {
    e.preventDefault();
    input.brake = true;
    input.pressed.add("punch");
  }, { passive: false });
  btnHit.addEventListener("touchend",    () => { input.brake = false; });
  btnHit.addEventListener("touchcancel", () => { input.brake = false; });

  // Dialogue taps
  tap(btn1,   () => { if (world.dialogue?.options) chooseOption(world, 0); });
  tap(btn2,   () => { if (world.dialogue?.options) chooseOption(world, 1); });
  tap(btn3,   () => { if (world.dialogue?.options) chooseOption(world, 2); });
  tap(btnEsc, () => { world.dialogue = null; });

  // --- Frame sync (show/hide dialogue panel) --------------------------------
  let prevInDlg = false;
  return () => {
    const inDlg = world.dialogue !== null;
    if (inDlg !== prevInDlg) {
      prevInDlg        = inDlg;
      dlgEl.style.display = inDlg ? "flex" : "none";
      act.style.display   = inDlg ? "none" : "flex";
    }
    if (inDlg) {
      const hasOpts = !!world.dialogue?.options;
      btn1.style.visibility = hasOpts && world.dialogue.options[0] ? "" : "hidden";
      btn2.style.visibility = hasOpts && world.dialogue.options[1] ? "" : "hidden";
      btn3.style.visibility = hasOpts && world.dialogue.options[2] ? "" : "hidden";
      btnEsc.textContent    = hasOpts ? "ESC" : "OK";
    }
  };
}
