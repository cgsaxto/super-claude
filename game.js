(() => {
  'use strict';

  const {
    GROUND_Y, VIEW_W, VIEW_H, PLAYER, PHYS, TUNING, LEVEL_COUNT,
    mulberry32, levelSeed, createMeteorScheduler, buildLevel,
  } = window.ClawdLevels;

  // Sound is optional: every call is guarded so audio can never break the game.
  const audio = window.SuperAudio || null;
  const sfx = (name, opts) => {
    try { if (audio) audio.play(name, opts); } catch (e) { /* stay silent */ }
  };
  const audioCall = (method, arg) => {
    try { if (audio) audio[method](arg); } catch (e) { /* stay silent */ }
  };

  // ---------------------------------------------------------------- constants
  const PLAYER_W = PLAYER.w;
  const PLAYER_H = PLAYER.h;
  const CAMERA_STIFFNESS = 6;
  const NOTE_SECONDS = 3.6;
  const RESTART_GUARD = 0.5;    // ignore panel buttons right after a level ends
  const DAWN_SECONDS = 2;       // background lift after the adventure is won
  const MAX_PARTICLES = 140;
  const SPARK_RADIUS = 20;
  const EMBER_RADIUS = 14;
  const ITEM_RADIUS = 18;

  const G = 8;                  // pitch of the scenery dot grid
  const TILE = 2048;            // scenery layers repeat every TILE px (256 dots)
  const SCENE_OY = GROUND_Y - 4;
  const MAX_CANVAS_W = 2560;    // caps the backing store on very dense displays
  const TAU = Math.PI * 2;

  // Palette sampled from the reference character image: a deep blue-black
  // field with Clawd's flat orange as the single strong accent.
  const COLORS = {
    clawd: '#ea6d41',
    eye: '#000000',
    stars: '#c9d3e6',
    moon: '#c5d0e4',
    clouds: '#8fa0bd',
    far: '#7f93b5',
    mid: '#a9b8d2',
    ground: '#93a3bf',
    sun: '#f2c48a',
    title: '#e0693f',
    dust: '#6f7c94',
    warm: ['#ea6d41', '#f6a55c', '#ffcf8a', '#ea6d41', '#f3ead8'],
    rockEdge: '#c3cfe3',
    rockMid: '#8395b4',
    rockDim: '#4d5b76',
    rockFill: '#172131',
    pit: '#070b12',
    enemy: '#93a5c4',
    enemyDark: '#5f7090',
    cool: '#dfe7f5',
  };
  const SKY_DAWN = [29, 28, 37];

  const KEYS = {
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
    jump: ['Space', 'KeyW', 'ArrowUp'],
  };
  const GAME_KEYS = new Set([...KEYS.left, ...KEYS.right, ...KEYS.jump]);

  // ---------------------------------------------------------------------- DOM
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const noteEl = $('note');
  const heartsEl = document.querySelector('#hud .hearts');
  const heartEls = [...heartsEl.querySelectorAll('.heart')];
  const volumeEl = $('volume');

  // -------------------------------------------------------------------- state
  // 'title' | 'playing' | 'paused' | 'gameover' | 'levelclear' | 'completed'
  let state = 'title';
  let time = 0;            // drives purely visual motion (clouds, shimmer)
  let endTime = 0;         // seconds since the current end panel appeared
  let cameraX = 0;
  let noteTimer = 0;
  let titleFade = 1;
  let dawn = 0;
  let hurtFlash = 0;
  let shakeT = 0;

  let level = null;        // static layout from buildLevel()
  let solids = [];         // ground, platforms and movers
  let moverClock = 0;
  let lives = TUNING.lives;
  let shield = false;
  let invuln = 0;
  let cpIndex = -1;        // last activated checkpoint
  let respawns = 0;
  let hitRequested = null; // set by any hazard during a step, applied once
  let meteors = [];
  let pendingMeteor = null;
  let scheduler = null;
  let hazardRng = null;
  let meteorLog = [];      // play-clock start time of every meteor event
  let warningLog = [];     // play-clock time every single warning began
  let maxActiveMeteors = 0;
  let particles = [];
  let run = null;          // this attempt at the current level
  let adventure = null;    // { seed, levelIndex, banked: [], hints: Set }

  const held = new Set();
  const player = {};
  // Draw-only animation state; never read by physics or collision.
  const anim = {};

  // A fixed ?seed=<number> replays the same layouts; ?level=<1-3> starts there.
  const params = new URLSearchParams(window.location.search);
  const fixedSeed = /^\d+$/.test(params.get('seed') || '') ? Number(params.get('seed')) >>> 0 : null;
  const requestedLevel = Number(params.get('level'));
  const startLevel = Number.isInteger(requestedLevel) && requestedLevel >= 1 && requestedLevel <= LEVEL_COUNT
    ? requestedLevel - 1 : 0;
  const pickSeed = () => (fixedSeed !== null ? fixedSeed : (Math.random() * 4294967296) >>> 0);

  // ---------------------------------------------------------- level lifecycle
  function placePlayer(centreX) {
    Object.assign(player, {
      x: centreX - PLAYER_W / 2,
      y: GROUND_Y - PLAYER_H,
      prevY: GROUND_Y - PLAYER_H,
      vx: 0,
      vy: 0,
      onGround: true,
      ride: null,
      facing: 1,
      jumpBuffer: 0,
      walkPhase: 0,
    });
    Object.assign(anim, { jumpT: 99, landT: 99, hopT: 99, turn: 0, bob: 0 });
    held.clear();
    cameraX = Math.max(0, Math.min(centreX - VIEW_W / 2 + 90, level.width - VIEW_W));
  }

  function resetLevel(index) {
    level = buildLevel(index, levelSeed(adventure.seed, index));
    for (const s of level.sparks) Object.assign(s, { taken: false, popT: 0, phase: s.x * 0.013 });
    for (const e of level.embers) e.taken = false;
    for (const h of level.hearts) h.taken = false;
    for (const s of level.shields) s.taken = false;
    for (const e of level.enemies) Object.assign(e, { alive: true, squashT: 0, y: e.surfaceY - e.h });
    for (const c of level.checkpoints) c.active = false;
    for (const m of level.movers) Object.assign(m, { x: m.ax, y: m.ay, dx: 0, dy: 0, mover: true });
    for (const rock of level.rocks) rock.cells = rockCells(rock);
    for (const p of level.platforms) p.cells = slabCells(p, false);
    for (const m of level.movers) m.cells = slabCells(m, true);
    level.beacon.unlocked = false;
    solids = [...level.ground, ...level.platforms, ...level.movers];
    level.meteorSurfaces = [...level.ground, ...level.platforms].filter((s) => s.w >= TUNING.meteor.minSurface);

    moverClock = 0;
    lives = TUNING.lives;
    shield = false;
    invuln = 0;
    cpIndex = -1;
    respawns = 0;
    hitRequested = null;
    meteors = [];
    pendingMeteor = null;
    meteorLog = [];
    warningLog = [];
    maxActiveMeteors = 0;
    // meteors use their own stream so they never disturb the rock layout
    hazardRng = mulberry32((level.seed ^ 0x9e3779b9) >>> 0);
    scheduler = createMeteorScheduler(level.tuning.meteor, hazardRng);
    particles = [];
    hurtFlash = 0;
    shakeT = 0;
    dawn = 0;
    endTime = 0;
    run = { time: 0, hits: 0, score: 0, sparks: 0, embers: 0, stomps: 0 };
    placePlayer(level.spawn.x + PLAYER_W / 2);
    hideNote();
    updateHud();
  }

  function newAdventure() {
    adventure = { seed: pickSeed(), levelIndex: startLevel, banked: [], hints: new Set() };
    resetLevel(adventure.levelIndex);
  }

  function setState(next) {
    state = next;
    stage.dataset.state = next;
  }

  function beginPlay() {
    audioCall('setBlocked', false);
    setState('playing');
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  // The first game keeps the layout already shown behind the title.
  function startGame() {
    beginPlay();
    sfx('confirm');
  }

  function continueAdventure() {
    audioCall('stopAll'); // nothing from the finished level may carry over
    adventure.levelIndex += 1;
    resetLevel(adventure.levelIndex);
    beginPlay();
    sfx('confirm');
  }

  // Same level again: this attempt's score is dropped, earlier levels stay banked.
  function retryLevel() {
    audioCall('stopAll');
    resetLevel(adventure.levelIndex);
    beginPlay();
    sfx('confirm');
  }

  function restartAdventure() {
    audioCall('stopAll');
    newAdventure();
    beginPlay();
    sfx('confirm');
  }

  function completeLevel() {
    run.score += TUNING.score.levelClear;
    adventure.banked.push({
      name: level.name,
      sparks: run.sparks,
      sparksTotal: level.sparks.length,
      embers: run.embers,
      embersTotal: level.embers.length,
      time: run.time,
      hits: run.hits,
      score: run.score,
    });
    // success ends every danger at once
    meteors = [];
    pendingMeteor = null;
    hitRequested = null;
    invuln = 0;
    held.clear();
    player.jumpBuffer = 0;
    endTime = 0;
    anim.hopT = 0;
    burst(level.beacon.x, GROUND_Y - 100, 18);
    hideNote();
    const last = adventure.levelIndex === LEVEL_COUNT - 1;
    fillResults(last);
    setState(last ? 'completed' : 'levelclear');
    sfx(last ? 'complete' : 'levelClear'); // a jingle silences every other sound first
    $(last ? 'again-btn' : 'continue-btn').focus({ preventScroll: true });
  }

  // cause: 'hurt' or 'pit'. Its sound plays first, then the game-over phrase.
  function gameOver(cause) {
    audioCall('stopAll');
    sfx(cause);
    sfx('gameover', { delay: cause === 'pit' ? 0.36 : 0.26, keep: true });
    setState('gameover');
    endTime = 0;
    held.clear();
    player.jumpBuffer = 0;
    meteors = meteors.filter((m) => m.phase === 'impact');
    pendingMeteor = null;
    $('gameover-count').textContent =
      `${level.name} · Sparks ${run.sparks} / ${level.sparks.length} · Embers ${run.embers}`;
    hideNote();
    $('retry-btn').focus({ preventScroll: true });
  }

  function togglePause() {
    if (state === 'playing') {
      setState('paused');
      audioCall('setBlocked', true); // silences ringing and scheduled sounds
      sfx('pause');
      clearInput();
      $('resume-btn').focus({ preventScroll: true });
    } else if (state === 'paused') {
      clearInput(); // stale keys must not move Clawd on resume
      beginPlay();
      sfx('resume');
      // old sounds are never replayed; a still-pending warning gets one reminder
      if (meteors.some((m) => m.phase === 'warning')) sfx('warning');
    }
  }

  // --------------------------------------------------------------- HUD, panels
  const fmtTime = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

  function updateHud() {
    $('hud-level').textContent = `${level.index + 1} · ${level.name}`;
    heartEls.forEach((el, i) => el.classList.toggle('lost', i >= lives));
    heartsEl.setAttribute('aria-label', `${lives} of ${TUNING.lives} lives`);
    $('spark-count').textContent = String(run.sparks);
    $('spark-total').textContent = String(level.sparks.length);
    $('ember-count').textContent = String(run.embers);
    $('hud-shield').hidden = !shield;
  }

  function statRows(el, rows) {
    el.replaceChildren(...rows.flatMap(([label, value]) => {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = value;
      return [dt, dd];
    }));
  }

  function fillResults(last) {
    const r = adventure.banked[adventure.banked.length - 1];
    if (!last) {
      $('levelclear-title').textContent = `${r.name} complete`;
      statRows($('levelclear-stats'), [
        ['Sparks', `${r.sparks} / ${r.sparksTotal}`],
        ['Embers', `${r.embers} / ${r.embersTotal}`],
        ['Time', fmtTime(r.time)],
        ['Hits taken', String(r.hits)],
        ['Level score', String(r.score)],
      ]);
      return;
    }
    const sum = (key) => adventure.banked.reduce((a, b) => a + b[key], 0);
    statRows($('complete-stats'), [
      ...adventure.banked.map((b) => [b.name, `${b.score} · ${fmtTime(b.time)}`]),
      ['Sparks', `${sum('sparks')} / ${sum('sparksTotal')}`],
      ['Embers', `${sum('embers')} / ${sum('embersTotal')}`],
      ['Total time', fmtTime(sum('time'))],
      ['Hits taken', String(sum('hits'))],
      ['Total score', String(sum('score'))],
    ]);
  }

  // A single note element: a new message replaces the current one, so text
  // can never overlap.
  function showNote(text) {
    noteEl.textContent = text;
    noteEl.classList.add('show');
    noteTimer = NOTE_SECONDS;
  }

  function hideNote() {
    noteEl.classList.remove('show');
    noteTimer = 0;
  }

  // -------------------------------------------------------------------- input
  function isDown(action) {
    return KEYS[action].some((code) => held.has(code));
  }

  function clearInput() {
    held.clear();
    player.jumpBuffer = 0;
  }

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target === volumeEl && e.code !== 'KeyM') return; // arrow keys adjust the slider while it has focus
    audioCall('unlock');               // a real key press may start / resume audio
    if (e.code === 'KeyM') {
      if (!e.repeat) audioCall('toggleMute');
      return;
    }
    const isGameKey = GAME_KEYS.has(e.code);
    if (isGameKey) e.preventDefault(); // no page scrolling

    if (state === 'title') {
      if ((e.code === 'Enter' || e.code === 'Space') && !e.repeat) {
        e.preventDefault();
        startGame();
      }
      return;
    }
    if (state === 'levelclear' || state === 'completed' || state === 'gameover') {
      if (e.code === 'Enter') {
        e.preventDefault(); // the guard below also covers a focused button
        if (!e.repeat && endTime > RESTART_GUARD) {
          if (state === 'levelclear') continueAdventure();
          else if (state === 'gameover') retryLevel();
          else restartAdventure();
        }
      }
      return;
    }
    if (e.code === 'Escape' || e.code === 'KeyP') {
      e.preventDefault();
      if (!e.repeat) togglePause();
      return;
    }
    if (state === 'paused') {
      if (e.code === 'Enter') e.preventDefault(); // resume only via Esc, P or the button
      return;
    }
    if (!isGameKey) return;
    // A jump needs a fresh press: key repeat and held keys never re-trigger.
    if (KEYS.jump.includes(e.code) && !e.repeat && !held.has(e.code)) {
      player.jumpBuffer = PHYS.jumpBuffer;
    }
    held.add(e.code);
  });

  window.addEventListener('keyup', (e) => {
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    held.delete(e.code);
  });

  window.addEventListener('blur', clearInput);
  document.addEventListener('visibilitychange', () => {
    clearInput();
    // Leaving the tab pauses the game; the player resumes it by hand.
    if (document.hidden && state === 'playing') togglePause();
    audioCall('setHidden', document.hidden); // no sound from a background tab
  });
  document.addEventListener('pointerdown', () => audioCall('unlock'));

  const guarded = (fn, wanted) => () => {
    if (state === wanted && endTime > RESTART_GUARD) fn();
  };
  $('start-btn').addEventListener('click', () => { if (state === 'title') startGame(); });
  $('continue-btn').addEventListener('click', guarded(continueAdventure, 'levelclear'));
  $('again-btn').addEventListener('click', guarded(restartAdventure, 'completed'));
  $('retry-btn').addEventListener('click', guarded(retryLevel, 'gameover'));
  $('restart-btn').addEventListener('click', guarded(restartAdventure, 'gameover'));
  $('resume-btn').addEventListener('click', () => { if (state === 'paused') togglePause(); });

  // ------------------------------------------------------------------ physics
  function approach(value, target, step) {
    return value < target ? Math.min(value + step, target) : Math.max(value - step, target);
  }

  const EPS = 0.001;
  function overlaps(ax, ay, aw, ah, b) {
    return ax < b.x + b.w - EPS && ax + aw > b.x + EPS && ay < b.y + b.h - EPS && ay + ah > b.y + EPS;
  }
  const playerOverlaps = (r) => overlaps(player.x, player.y, PLAYER_W, PLAYER_H, r);

  function playerInCircle(cx, cy, radius) {
    const nx = Math.max(player.x, Math.min(cx, player.x + PLAYER_W));
    const ny = Math.max(player.y, Math.min(cy, player.y + PLAYER_H));
    return (cx - nx) ** 2 + (cy - ny) ** 2 <= radius * radius;
  }

  // Movers ease between their two end points and dwell briefly at each.
  function updateMovers(dt) {
    moverClock += dt;
    for (const m of level.movers) {
      const u = (moverClock / m.period) % 1;
      const f = Math.max(0, Math.min(1, (0.5 - 0.5 * Math.cos(u * TAU)) * 1.3 - 0.15));
      const nx = m.ax + (m.bx - m.ax) * f;
      const ny = m.ay + (m.by - m.ay) * f;
      m.dx = nx - m.x;
      m.dy = ny - m.y;
      m.x = nx;
      m.y = ny;
    }
  }

  function updatePlayer(dt) {
    const playing = state === 'playing';
    const dir = playing ? (isDown('right') ? 1 : 0) - (isDown('left') ? 1 : 0) : 0;
    const wasOnGround = player.onGround;
    player.prevY = player.y;

    // carried by the platform Clawd stands on
    if (player.ride) {
      player.x += player.ride.dx;
      player.y = player.ride.y - PLAYER_H;
      player.prevY = player.y;
    }
    // a mover that slid into Clawd pushes him out of its way
    for (const m of level.movers) {
      if (m === player.ride || !playerOverlaps(m)) continue;
      if (m.dx !== 0) {
        player.x = m.dx > 0 ? m.x + m.w : m.x - PLAYER_W;
      } else if (m.dy > 0) {
        // descending lift: slide out sideways rather than being crushed
        player.x = player.x + PLAYER_W / 2 < m.x + m.w / 2 ? m.x - PLAYER_W : m.x + m.w;
      } else {
        player.y = m.y - PLAYER_H; // rising under Clawd: lift him
        player.vy = Math.min(player.vy, 0);
      }
    }

    if (dir !== 0) {
      const turning = Math.sign(player.vx) === -dir;
      player.vx = approach(player.vx, dir * PHYS.maxSpeed, (turning ? PHYS.turnAccel : PHYS.accel) * dt);
      player.facing = dir;
    } else {
      player.vx = approach(player.vx, 0, PHYS.decel * dt);
    }

    if (player.jumpBuffer > 0) {
      if (playing && player.onGround) {
        player.vy = -PHYS.jumpSpeed;
        player.onGround = false;
        player.ride = null;
        player.jumpBuffer = 0;
        anim.jumpT = 0;
        sfx('jump'); // only an actual take-off makes this sound
      } else {
        player.jumpBuffer -= dt;
      }
    }
    // Short hop when the jump key is released early.
    if (!player.onGround && player.vy < -PHYS.jumpCut && !(playing && isDown('jump'))) {
      player.vy = -PHYS.jumpCut;
    }
    player.vy = Math.min(player.vy + PHYS.gravity * dt, PHYS.maxFall);

    // horizontal move, then push out of anything solid
    const xBefore = player.x;
    player.x += player.vx * dt;
    for (const s of solids) {
      if (!playerOverlaps(s)) continue;
      const slack = 2 + Math.abs(s.dx || 0);
      const fromLeft = xBefore + PLAYER_W <= s.x + slack;
      const fromRight = xBefore >= s.x + s.w - slack;
      if (fromLeft || (!fromRight && player.x + PLAYER_W / 2 < s.x + s.w / 2)) {
        player.x = s.x - PLAYER_W;
        if (player.vx > 0) player.vx = 0;
      } else {
        player.x = s.x + s.w;
        if (player.vx < 0) player.vx = 0;
      }
    }
    if (player.x < 0) {
      player.x = 0;
      player.vx = 0;
    } else if (player.x > level.width - PLAYER_W) {
      player.x = level.width - PLAYER_W;
      player.vx = 0;
    }

    // vertical move: land on tops, bump the head on undersides
    const yBefore = player.y;
    const fallSpeed = player.vy;
    player.y += player.vy * dt;
    let landed = null;
    // The landing test reaches half a pixel below the feet, so standing still
    // counts as grounded however small the time step is.
    const probe = player.vy >= 0 ? 0.5 : 0;
    for (const s of solids) {
      if (!overlaps(player.x, player.y, PLAYER_W, PLAYER_H + probe, s)) continue;
      const slack = 2 + Math.abs(s.dy || 0);
      if (yBefore + PLAYER_H <= s.y + slack) {
        player.y = s.y - PLAYER_H;
        player.vy = 0;
        landed = s;
      } else if (yBefore >= s.y + s.h - slack) {
        player.y = s.y + s.h;
        if (player.vy < 0) player.vy = 0;
      }
    }
    player.onGround = landed !== null;
    player.ride = landed && landed.mover ? landed : null;
    if (landed && !wasOnGround && fallSpeed > 250) {
      anim.landT = 0;
      dust(player.x + PLAYER_W / 2, player.y + PLAYER_H);
      if (playing) sfx('land');
    }

    const walking = player.onGround && Math.abs(player.vx) > 20;
    player.walkPhase = walking ? player.walkPhase + Math.abs(player.vx) * dt / 30 : 0;

    anim.jumpT += dt;
    anim.landT += dt;
    anim.hopT += dt;
    anim.turn = approach(anim.turn, dir !== 0 || Math.abs(player.vx) > 20 ? player.facing : 0, dt * 9);
  }

  // ----------------------------------------------------------------- entities
  function updateEnemies(dt) {
    for (const e of level.enemies) {
      if (!e.alive) {
        e.squashT = Math.max(0, e.squashT - dt);
        continue;
      }
      e.x += e.dir * e.speed * dt;
      if (e.x <= e.minX) {
        e.x = e.minX;
        e.dir = 1;
      } else if (e.x + e.w >= e.maxX) {
        e.x = e.maxX - e.w;
        e.dir = -1;
      }
    }
  }

  function sparkY(spark) {
    return spark.y + Math.sin(time * 1.8 + spark.phase) * 5;
  }

  function collect(dt) {
    for (const spark of level.sparks) {
      if (spark.taken) {
        spark.popT = Math.max(0, spark.popT - dt);
        continue;
      }
      const sy = sparkY(spark);
      if (!playerInCircle(spark.x, sy, SPARK_RADIUS)) continue;
      spark.taken = true;
      spark.popT = 0.3;
      spark.popY = sy;
      run.sparks += 1;
      run.score += TUNING.score.spark;
      sfx('spark');
      anim.hopT = 0;
      burst(spark.x, sy, 14);
      if (run.sparks === level.sparks.length) {
        // the last spark only lights the beacon; Clawd is not safe yet
        level.beacon.unlocked = true;
        showNote('All sparks found. The beacon is lit — reach it.');
      }
      updateHud();
    }
    for (const ember of level.embers) {
      if (ember.taken || !playerInCircle(ember.x, ember.y, EMBER_RADIUS)) continue;
      ember.taken = true;
      run.embers += 1;
      run.score += TUNING.score.ember;
      sfx('ember');
      burst(ember.x, ember.y, 3);
      updateHud();
    }
    for (const heart of level.hearts) {
      // left in place while Clawd is at full health
      if (heart.taken || lives >= TUNING.lives || !playerInCircle(heart.x, heart.y, ITEM_RADIUS)) continue;
      heart.taken = true;
      lives += 1;
      sfx('heart');
      burst(heart.x, heart.y, 8);
      showNote('A heart restored.');
      updateHud();
    }
    for (const item of level.shields) {
      if (item.taken || shield || !playerInCircle(item.x, item.y, ITEM_RADIUS)) continue;
      item.taken = true;
      shield = true;
      sfx('shieldGet');
      burst(item.x, item.y, 8);
      showNote('Shield up. It absorbs one hit.');
      updateHud();
    }
    const cx = player.x + PLAYER_W / 2;
    level.checkpoints.forEach((cp, i) => {
      if (cp.active || cx < cp.x) return;
      cp.active = true;
      cpIndex = Math.max(cpIndex, i);
      sfx('checkpoint');
      burst(cp.x, GROUND_Y - 70, 8);
      showNote('Checkpoint reached.');
    });
    for (const hint of level.hints) {
      if (adventure.hints.has(hint.id) || cx < hint.x) continue;
      adventure.hints.add(hint.id); // each hint shows once per adventure
      showNote(hint.text);
    }
  }

  const beaconRect = () => ({ x: level.beacon.x - 30, y: GROUND_Y - 124, w: 60, h: 124 });

  // ------------------------------------------------------------------ hazards
  // Rocks, patrollers and meteors only *request* a hit; at most one is applied
  // per update step, and invulnerability starts immediately.
  function requestHit(source) {
    if (invuln <= 0 && !hitRequested) hitRequested = source;
  }

  function applyHit() {
    const source = hitRequested;
    hitRequested = null;
    if (!source || invuln > 0) return;
    const cx = player.x + PLAYER_W / 2;
    const cy = player.y + PLAYER_H / 2;
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * TAU;
      const life = 0.3 + Math.random() * 0.2;
      addParticle({
        x: cx, y: cy,
        vx: Math.cos(angle) * 150,
        vy: Math.sin(angle) * 150 - 40,
        gravity: 300,
        life, maxLife: life,
        size: 4,
        color: shield ? COLORS.cool : i % 2 ? COLORS.warm[4] : COLORS.warm[0],
      });
    }
    if (shield) {
      shield = false;
      invuln = TUNING.shieldInvuln;
      sfx('shieldBreak');
      showNote('The shield took the hit.');
      updateHud();
      return;
    }
    lives -= 1;
    run.hits += 1;
    invuln = TUNING.invulnSeconds;
    hurtFlash = 0.18;
    updateHud();
    if (lives <= 0) gameOver('hurt');
    else sfx('hurt');
  }

  // Falling into a pit: the shield does not help. Back to the last checkpoint.
  function pitFall() {
    lives -= 1;
    run.hits += 1;
    hurtFlash = 0.18;
    updateHud();
    if (lives <= 0) {
      gameOver('pit');
      return;
    }
    sfx('pit');
    respawns += 1;
    const point = cpIndex >= 0 ? level.checkpoints[cpIndex].x : level.spawn.x + PLAYER_W / 2;
    placePlayer(point);
    invuln = TUNING.respawnInvuln;
    meteors = [];
    pendingMeteor = null;
    scheduler.delay(TUNING.respawnMeteorGrace);
    hitRequested = null;
  }

  function checkEnemies() {
    for (const e of level.enemies) {
      if (!e.alive || !overlaps(player.x + 3, player.y, PLAYER_W - 6, PLAYER_H, e)) continue;
      // A stomp needs Clawd to be falling and to have been above the enemy on
      // the previous step, so a side bump is never mistaken for one.
      const fromAbove = player.vy > 0 && player.prevY + PLAYER_H <= e.y + TUNING.enemy.stompTolerance;
      if (fromAbove) {
        e.alive = false;
        e.squashT = 0.3;
        sfx('stomp');
        player.vy = -PHYS.stompBounce;
        player.onGround = false;
        player.ride = null;
        run.stomps += 1;
        run.score += TUNING.score.stomp;
        burst(e.x + e.w / 2, e.y + e.h / 2, 8, COLORS.enemy);
      } else {
        requestHit('enemy');
      }
    }
  }

  // Chooses a fixed impact point: visible, near Clawd, on a roomy surface and
  // with free standing room right beside the blast. Returns null to cancel.
  function pickMeteorTarget() {
    const m = TUNING.meteor;
    const R = m.radius;
    const cx = player.x + PLAYER_W / 2;
    const feet = player.y + PLAYER_H;
    const protectedXs = [level.spawn.x + PLAYER_W / 2, level.beacon.x, ...level.checkpoints.map((c) => c.x)];
    for (let i = 0; i < 12; i++) {
      const raw = cx + (hazardRng() * 2 - 1) * m.nearPlayer;
      const side = hazardRng() < 0.5 ? -1 : 1;
      const x = Math.round(Math.max(cameraX + m.viewMargin, Math.min(cameraX + VIEW_W - m.viewMargin, raw)));

      // never mid-jump over a pit or on a narrow foothold
      const candidates = level.meteorSurfaces.filter((s) => x >= s.x + m.edgeMargin && x <= s.x + s.w - m.edgeMargin);
      if (!candidates.length) continue;
      const surface = candidates.reduce((a, b) => (Math.abs(b.y - feet) < Math.abs(a.y - feet) ? b : a));
      if (protectedXs.some((p) => Math.abs(p - x) < m.protectRadius)) continue;
      if (meteors.some((o) => Math.abs(o.x - x) < m.separation)) continue;

      // at least one side must offer free standing room just outside the blast
      const free = (dir) => {
        const lo = Math.min(x + dir * R, x + dir * (R + m.escapeRoom));
        const hi = lo + m.escapeRoom;
        if (lo < surface.x + 10 || hi > surface.x + surface.w - 10) return false;
        if (surface.ground && level.rocks.some((r) => r.x < hi && r.x + r.w > lo)) return false;
        // a platform or lift standing in that strip would block the way out
        const blocked = (q, x0, x1) => x0 < hi && x1 > lo && q.y < surface.y - 1 && q.y + q.h > surface.y - PLAYER_H;
        if (level.platforms.some((q) => blocked(q, q.x, q.x + q.w))) return false;
        if (level.movers.some((q) => blocked({ y: Math.min(q.ay, q.by), h: Math.abs(q.ay - q.by) + q.h }, Math.min(q.ax, q.bx), Math.max(q.ax, q.bx) + q.w))) return false;
        if (level.enemies.some((e) => e.alive && e.surfaceY === surface.y && e.x < hi + 60 && e.x + e.w > lo - 60)) return false;
        if (meteors.some((o) => Math.abs(o.y - surface.y) < 60 && o.x - R - PLAYER_W < hi && o.x + R + PLAYER_W > lo)) return false;
        return true;
      };
      const left = free(-1);
      const right = free(1);
      if (!left && !right) continue;
      return { x, y: surface.y, fromX: x + side * 300, phase: 'warning', t: 0, escape: left && right ? 0 : left ? -1 : 1 };
    }
    return null;
  }

  function meteorImpact(meteor) {
    shakeT = TUNING.meteor.shakeSeconds;
    for (let i = 0; i < 20; i++) {
      const angle = Math.PI + (i / 19) * Math.PI; // upper half only
      const speed = 120 + Math.random() * 220;
      const life = 0.25 + Math.random() * 0.25;    // gone within impactSeconds
      addParticle({
        x: meteor.x, y: meteor.y - 4,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        gravity: 700,
        life, maxLife: life,
        size: i % 4 === 0 ? 5 : 3,
        color: COLORS.warm[i % COLORS.warm.length],
      });
    }
    // Damage is judged exactly once, against Clawd's real collision box and the
    // same circle the marker shows. Being high enough in the air avoids it.
    if (playerInCircle(meteor.x, meteor.y, TUNING.meteor.radius)) requestHit('meteor');
  }

  function updateMeteors(dt) {
    const m = TUNING.meteor;
    const cfg = level.tuning.meteor;

    if (scheduler.tick(dt)) {
      const target = meteors.length < cfg.maxActive ? pickMeteorTarget() : null;
      if (target) {
        meteors.push(target);
        sfx('warning');
        scheduler.started();
        meteorLog.push(scheduler.clock);
        warningLog.push(scheduler.clock);
        // level three: sometimes a second, staggered meteor in the same event
        pendingMeteor = cfg.maxActive > 1 && hazardRng() < cfg.doubleChance ? { at: scheduler.clock + cfg.stagger } : null;
      }
    }
    if (pendingMeteor && scheduler.clock >= pendingMeteor.at) {
      pendingMeteor = null;
      const second = meteors.length < cfg.maxActive ? pickMeteorTarget() : null;
      if (second) {
        meteors.push(second);
        sfx('warning');
        warningLog.push(scheduler.clock);
      }
    }
    maxActiveMeteors = Math.max(maxActiveMeteors, meteors.length);

    for (const meteor of meteors) {
      meteor.t += dt;
      if (meteor.phase === 'warning' && meteor.t >= m.warnSeconds) {
        meteor.phase = 'falling';
        meteor.t -= m.warnSeconds;
        sfx('meteorFall');
      }
      if (meteor.phase === 'falling' && meteor.t >= m.fallSeconds) {
        meteor.phase = 'impact';
        meteor.t = 0;
        sfx('impact');
        meteorImpact(meteor);
      }
    }
    meteors = meteors.filter((meteor) => !(meteor.phase === 'impact' && meteor.t >= m.impactSeconds));
  }

  // ---------------------------------------------------------------- particles
  function addParticle(p) {
    if (particles.length < MAX_PARTICLES) particles.push(p);
  }

  function burst(x, y, count, color) {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * TAU + Math.random() * 0.5;
      const speed = 90 + Math.random() * 170;
      const life = 0.4 + Math.random() * 0.45;
      addParticle({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 60,
        gravity: 380,
        life, maxLife: life,
        size: i % 3 === 0 ? 5 : 3,
        color: color || COLORS.warm[i % COLORS.warm.length],
      });
    }
  }

  function dust(x, y) {
    for (let i = 0; i < 4; i++) {
      const side = i < 2 ? -1 : 1;
      const life = 0.25 + Math.random() * 0.15;
      addParticle({
        x: x + side * 24, y: y - 2,
        vx: side * (40 + Math.random() * 60),
        vy: -30 - Math.random() * 40,
        gravity: 200,
        life, maxLife: life,
        size: 3,
        color: COLORS.dust,
      });
    }
  }

  function updateParticles(dt) {
    // Rising embers over a lit beacon, and everywhere once the adventure is won.
    if (level.beacon.unlocked && Math.random() < dt * 9) {
      const life = 0.8 + Math.random() * 0.6;
      addParticle({
        x: level.beacon.x + (Math.random() - 0.5) * 30, y: GROUND_Y - 124,
        vx: 0, vy: -50, gravity: 0,
        life, maxLife: life,
        size: 3,
        color: COLORS.warm[1],
      });
    }
    if (state === 'completed' && particles.length < 70 && Math.random() < dt * 14) {
      const life = 1.8 + Math.random() * 1.6;
      addParticle({
        x: cameraX + Math.random() * VIEW_W,
        y: GROUND_Y - Math.random() * 24,
        vx: (Math.random() - 0.5) * 24,
        vy: -40 - Math.random() * 70,
        gravity: 0,
        life, maxLife: life,
        size: 3,
        color: COLORS.warm[Math.floor(Math.random() * COLORS.warm.length)],
      });
    }
    for (const p of particles) {
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    particles = particles.filter((p) => p.life > 0);
  }

  function updateCamera(dt) {
    const target = player.x + PLAYER_W / 2 - VIEW_W / 2 + player.facing * 90;
    cameraX += (target - cameraX) * (1 - Math.exp(-CAMERA_STIFFNESS * dt));
    cameraX = Math.max(0, Math.min(cameraX, level.width - VIEW_W));
  }

  // ------------------------------------------------------------------- update
  // One fixed step of actual play. Order matters:
  // move → collect → beacon (success wins) → hazards → one hit at most → pit.
  function step(dt) {
    run.time += dt;
    invuln = Math.max(0, invuln - dt);
    updateMovers(dt);
    updatePlayer(dt);
    updateEnemies(dt);
    collect(dt);

    if (level.beacon.unlocked && playerOverlaps(beaconRect())) {
      completeLevel();
      return;
    }

    updateMeteors(dt);
    checkEnemies();
    if (level.rocks.some((rock) => rock.rects.some(playerOverlaps))) requestHit('rock');
    applyHit();
    if (state === 'playing' && player.y > VIEW_H + 60) pitFall();
  }

  function update(dt) {
    if (state === 'paused') return; // nothing advances: physics, hazards, particles, timers
    time += dt;
    hurtFlash = Math.max(0, hurtFlash - dt);
    shakeT = Math.max(0, shakeT - dt);

    if (state === 'title') {
      titleFade = 1;
      updateMovers(dt);
      return;
    }
    titleFade = Math.max(0, titleFade - dt / 0.5);

    if (state === 'playing') {
      step(dt);
    } else {
      // an end panel is up: let Clawd settle, keep only visual leftovers moving
      endTime += dt;
      updatePlayer(dt);
      for (const meteor of meteors) meteor.t += dt;
      meteors = meteors.filter((meteor) => meteor.t < TUNING.meteor.impactSeconds);
      for (const spark of level.sparks) spark.popT = Math.max(0, spark.popT - dt);
      if (state === 'completed') dawn = Math.min(1, endTime / DAWN_SECONDS);
    }
    updateParticles(dt);
    updateCamera(dt);

    if (noteTimer > 0) {
      noteTimer -= dt;
      if (noteTimer <= 0) hideNote();
    }
  }

  // ==================================================================== scene
  // All scenery is generated once from fixed seeds as dots on an 8px grid and
  // painted into offscreen tiles that repeat every TILE px, so any level
  // length is covered without seams or huge canvases.

  class DotGrid {
    constructor() {
      this.dots = new Map();
    }
    set(cx, cy, alpha, big) {
      const key = cx + ',' + cy;
      const prev = this.dots.get(key);
      if (!prev || prev.alpha < alpha) this.dots.set(key, { cx, cy, alpha, big: !!big });
    }
    bounds() {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const d of this.dots.values()) {
        x0 = Math.min(x0, d.cx); x1 = Math.max(x1, d.cx);
        y0 = Math.min(y0, d.cy); y1 = Math.max(y1, d.cy);
      }
      return { x0, y0, x1, y1 };
    }
    paint(c, ox, oy, color) {
      c.fillStyle = color;
      for (const d of this.dots.values()) {
        c.globalAlpha = d.alpha;
        c.beginPath();
        c.arc(ox + d.cx * G, oy + d.cy * G, d.big ? 2.7 : 1.9, 0, TAU);
        c.fill();
      }
      c.globalAlpha = 1;
    }
  }

  // Fills the union of ellipses (in cell units) with dots: a bright rim on the
  // upper-left edges and a dimmer, dithered interior that thins out downwards.
  function addBlob(grid, rng, ellipses, o) {
    const inside = (cx, cy) =>
      (o.maxCy === undefined || cy <= o.maxCy) &&
      ellipses.some((e) => ((cx - e.x) / e.rx) ** 2 + ((cy - e.y) / e.ry) ** 2 <= 1);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of ellipses) {
      x0 = Math.min(x0, Math.floor(e.x - e.rx)); x1 = Math.max(x1, Math.ceil(e.x + e.rx));
      y0 = Math.min(y0, Math.floor(e.y - e.ry)); y1 = Math.max(y1, Math.ceil(e.y + e.ry));
    }
    for (let cy = y0; cy <= y1; cy++) {
      const t = (cy - y0) / Math.max(1, y1 - y0);
      for (let cx = x0; cx <= x1; cx++) {
        if (!inside(cx, cy)) continue;
        const roll = rng();
        const shade = rng();
        if (!inside(cx, cy - 1)) {
          grid.set(cx, cy, o.edge, o.bigEdge);
        } else if (!inside(cx - 1, cy) && t < 0.6) {
          grid.set(cx, cy, o.edge * 0.75, o.bigEdge);
        } else if (roll < o.density * (1 - o.fade * t * t)) {
          grid.set(cx, cy, o.fillLo + shade * (o.fillHi - o.fillLo));
        }
      }
    }
  }

  function addBroadTree(grid, rng, bx, height) {
    const fork = Math.round(height * 0.5);
    for (let r = 0; r <= fork; r++) {
      grid.set(bx, -r, 0.24 + rng() * 0.08);
      grid.set(bx + 1, -r, 0.16 + rng() * 0.06);
    }
    grid.set(bx - 1, 0, 0.14);
    grid.set(bx + 2, 0, 0.14);

    const tips = [];
    for (const dir of [-1, 1]) {
      let x = dir < 0 ? bx : bx + 1;
      let y = -fork;
      const length = 3 + Math.floor(rng() * 4);
      for (let i = 0; i < length; i++) {
        x += dir;
        y -= 1;
        grid.set(x, y, 0.25);
        if (rng() < 0.45) {
          y -= 1;
          grid.set(x, y, 0.22);
        }
      }
      tips.push({ x, y });
    }
    const top = fork + 2 + Math.floor(rng() * 4);
    for (let r = fork + 1; r <= top; r++) grid.set(bx, -r, 0.2);
    tips.push({ x: bx, y: -top });

    const crowns = tips.map((tip) => ({
      x: tip.x + (rng() - 0.5) * 2,
      y: tip.y - 2 - rng() * 2,
      rx: 4 + rng() * 3.5,
      ry: 3 + rng() * 2,
    }));
    addBlob(grid, rng, crowns, { edge: 0.42, bigEdge: true, fillLo: 0.07, fillHi: 0.2, density: 0.8, fade: 0.55 });
  }

  function addPine(grid, rng, bx, height) {
    for (let r = 0; r <= 2; r++) {
      grid.set(bx, -r, 0.24);
      grid.set(bx + 1, -r, 0.18);
    }
    for (let i = 0; i <= height; i++) {
      const cy = -(height + 3) + i;
      const half = Math.floor(i * 0.36);
      for (let dx = -half; dx <= half + 1; dx++) {
        if (dx === -half) grid.set(bx + dx, cy, 0.38, true);
        else if (rng() < 0.78) grid.set(bx + dx, cy, 0.07 + rng() * 0.13);
      }
    }
  }

  function addSapling(grid, rng, bx, height) {
    for (let r = 0; r <= height; r++) grid.set(bx, -r, 0.22);
    grid.set(bx - 1, -height + 2, 0.18);
    grid.set(bx + 1, -height + 1, 0.18);
    addBlob(grid, rng, [{ x: bx, y: -height - 2, rx: 2.6 + rng() * 1.6, ry: 2 + rng() }],
      { edge: 0.38, bigEdge: true, fillLo: 0.08, fillHi: 0.18, density: 0.85, fade: 0.4 });
  }

  const PARALLAX = { stars: 0.02, moon: 0.006, clouds: 0.1, far: 0.25, mid: 0.55 };
  const TILE_CELLS = TILE / G;

  function buildForestGrid() {
    const rng = mulberry32(20261001);
    const grid = new DotGrid();
    let x = 5;
    while (x < TILE_CELLS - 12) {
      const roll = rng();
      if (roll < 0.55) addBroadTree(grid, rng, x, 12 + Math.floor(rng() * 11));
      else if (roll < 0.75) addPine(grid, rng, x, 10 + Math.floor(rng() * 8));
      else addSapling(grid, rng, x, 5 + Math.floor(rng() * 5));
      x += 13 + Math.floor(rng() * 15);
    }
    return grid;
  }

  function buildCanopyGrid() {
    const rng = mulberry32(77031);
    const grid = new DotGrid();
    const ellipses = [];
    for (let x = 0; x < TILE_CELLS; x += 4 + rng() * 5) {
      ellipses.push({
        x,
        y: -22 + Math.sin((x / TILE_CELLS) * TAU * 5) * 5 + (rng() - 0.5) * 7,
        rx: 6 + rng() * 5,
        ry: 4 + rng() * 4,
      });
    }
    // repeat the edge blobs on the far side so the tile wraps cleanly
    const wrapped = ellipses.flatMap((e) => [e, { ...e, x: e.x - TILE_CELLS }, { ...e, x: e.x + TILE_CELLS }])
      .filter((e) => e.x > -14 && e.x < TILE_CELLS + 14);
    addBlob(grid, rng, wrapped, { edge: 0.29, fillLo: 0.05, fillHi: 0.13, density: 0.78, fade: 0.9 });
    return grid;
  }

  function buildCloudGrid(rng) {
    const grid = new DotGrid();
    const lumps = 2 + Math.floor(rng() * 3);
    const ellipses = [];
    let x = 0;
    for (let i = 0; i < lumps; i++) {
      const rx = 3 + rng() * 3;
      ellipses.push({ x: x + rx, y: -0.5 - rng(), rx, ry: 2.4 + rng() * 2.6 });
      x += rx * (1.1 + rng() * 0.5);
    }
    addBlob(grid, rng, ellipses, { maxCy: 0, edge: 0.26, fillLo: 0.11, fillHi: 0.17, density: 1, fade: 0 });
    const b = grid.bounds();
    for (let cx = b.x0 - 1; cx <= b.x1 + 1; cx++) grid.set(cx, 0, 0.17);
    return grid;
  }

  function buildMoonGrid() {
    const grid = new DotGrid();
    for (let cy = -7; cy <= 7; cy++) {
      for (let cx = -7; cx <= 7; cx++) {
        const outer = Math.hypot(cx, cy);
        const inner = Math.hypot(cx - 3.3, cy + 0.6);
        if (outer > 6.6 || inner <= 5.7) continue;
        grid.set(cx, cy, inner > 6.6 ? 0.44 : 0.28, inner > 6.6);
      }
    }
    return grid;
  }

  function buildSunGrid() {
    const rng = mulberry32(5);
    const grid = new DotGrid();
    for (let cy = -9; cy <= 9; cy++) {
      for (let cx = -9; cx <= 9; cx++) {
        const d = Math.hypot(cx, cy);
        const onRay = cx === 0 || cy === 0 || Math.abs(cx) === Math.abs(cy);
        if (d <= 2.6) grid.set(cx, cy, 0.6, true);
        else if (d <= 4.6) grid.set(cx, cy, 0.34);
        else if (d <= 9 && onRay) grid.set(cx, cy, 0.3 - (d - 4.6) * 0.045);
        else if (d <= 7 && rng() < 0.4) grid.set(cx, cy, 0.09);
      }
    }
    return grid;
  }

  function buildStars() {
    const rng = mulberry32(424242);
    const stars = [];
    for (let i = 0; i < 110; i++) {
      stars.push({
        x: rng() * (TILE - 4),
        y: 14 + rng() * 300,
        size: rng() < 0.2 ? 3 : 2,
        alpha: 0.14 + rng() * 0.34,
      });
    }
    return stars;
  }

  function buildGround() {
    const rng = mulberry32(90210);
    const dots = [];
    const rows = Math.ceil((VIEW_H - GROUND_Y) / G);
    for (let col = 0; col < TILE_CELLS; col++) {
      if (rng() < 0.07) dots.push({ col, row: -1, alpha: 0.2, r: 1.6 }); // grass tuft
      for (let row = 0; row < rows; row++) {
        const roll = rng();
        const shade = rng();
        if (row === 0) dots.push({ col, row, alpha: 0.42, r: 1.9 });            // surface line
        else if (row <= 2) dots.push({ col, row, alpha: 0.2 + shade * 0.1, r: 1.8 }); // topsoil
        else if (roll < 0.05) dots.push({ col, row, alpha: 0.36 + shade * 0.2, r: 2.1 }); // fleck
        else if (roll > 0.14) dots.push({ col, row, alpha: 0.09 + shade * 0.08, r: 1.7 }); // subsoil
      }
    }
    return dots;
  }

  const sceneData = (() => {
    const cloudRng = mulberry32(1357);
    const clouds = [];
    for (let i = 0; i < 9; i++) {
      clouds.push({
        grid: buildCloudGrid(cloudRng),
        baseX: i * 270 + cloudRng() * 120,
        y: 46 + cloudRng() * 190,
        drift: 3 + cloudRng() * 4,
      });
    }
    return {
      forest: buildForestGrid(),
      canopy: buildCanopyGrid(),
      moon: buildMoonGrid(),
      sun: buildSunGrid(),
      stars: buildStars(),
      ground: buildGround(),
      clouds,
    };
  })();
  const CLOUD_SPAN = 9 * 270;

  // ---- offscreen caches, repainted only when the render scale changes
  let renderScale = 1;
  let cache = null;

  function makeCanvas(logW, logH, scale, paint) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(logW * scale));
    c.height = Math.max(1, Math.ceil(logH * scale));
    const cx = c.getContext('2d');
    cx.scale(scale, scale);
    paint(cx);
    return { canvas: c, w: c.width / scale, h: c.height / scale };
  }

  function makeSprite(grid, color, scale) {
    const b = grid.bounds();
    const pad = 4;
    const sprite = makeCanvas((b.x1 - b.x0) * G + pad * 2, (b.y1 - b.y0) * G + pad * 2, scale,
      (c) => grid.paint(c, pad - b.x0 * G, pad - b.y0 * G, color));
    sprite.ox = b.x0 * G - pad;
    sprite.oy = b.y0 * G - pad;
    return sprite;
  }

  // A repeating band: dots that spill past one edge are also drawn at the other.
  function makeBand(grid, top, color, scale) {
    const band = makeCanvas(TILE, GROUND_Y - top, scale, (c) => {
      for (const shift of [-TILE, 0, TILE]) grid.paint(c, G / 2 + shift, SCENE_OY - top, color);
    });
    band.top = top;
    return band;
  }

  function buildCache(scale) {
    const stars = makeCanvas(TILE, 330, scale, (c) => {
      c.fillStyle = COLORS.stars;
      for (const s of sceneData.stars) {
        c.globalAlpha = s.alpha;
        c.fillRect(s.x, s.y, s.size, s.size);
      }
    });
    stars.top = 0;

    const ground = makeCanvas(TILE, VIEW_H - GROUND_Y + G, scale, (c) => {
      c.fillStyle = COLORS.ground;
      for (const d of sceneData.ground) {
        c.globalAlpha = d.alpha;
        c.beginPath();
        c.arc(d.col * G + G / 2, G + 4 + d.row * G, d.r, 0, TAU);
        c.fill();
      }
    });
    ground.top = GROUND_Y - G;

    cache = {
      scale,
      stars,
      ground,
      far: makeBand(sceneData.canopy, 220, COLORS.far, scale),
      mid: makeBand(sceneData.forest, 180, COLORS.mid, scale),
      moon: makeSprite(sceneData.moon, COLORS.moon, scale),
      sun: makeSprite(sceneData.sun, COLORS.sun, scale),
      clouds: sceneData.clouds.map((cl) => makeSprite(cl.grid, COLORS.clouds, scale)),
    };
  }

  // ------------------------------------------------------------------- render
  // Snap logical coordinates to whole device pixels so cached layers and
  // Clawd's pixels stay sharp at any stage size.
  const snap = (v) => Math.round(v * renderScale) / renderScale;
  const onScreen = (x, w) => x - cameraX < VIEW_W + 40 && x + w - cameraX > -40;

  function blit(img, x, y, alpha) {
    ctx.globalAlpha = alpha;
    ctx.drawImage(img.canvas, snap(x), snap(y), img.w, img.h);
  }

  function blitTiled(img, offset, alpha) {
    const start = -(((offset % TILE) + TILE) % TILE);
    for (let x = start; x < VIEW_W; x += TILE) blit(img, x, img.top, alpha);
  }

  function drawScene() {
    const ease = dawn * dawn * (3 - 2 * dawn);
    const sky = level.sky.map((n, i) => Math.round(n + (SKY_DAWN[i] - n) * ease));
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgb(${sky[0]},${sky[1]},${sky[2]})`;
    ctx.fillRect(-16, -16, VIEW_W + 32, VIEW_H + 32);

    const moonX = 1090 - cameraX * PARALLAX.moon;
    const moonY = 214;
    if (ease > 0) {
      const glow = ctx.createRadialGradient(moonX, moonY + 60, 0, moonX, moonY + 60, 460);
      glow.addColorStop(0, `rgba(243, 150, 96, ${0.075 * ease})`);
      glow.addColorStop(1, 'rgba(243, 150, 96, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, VIEW_W, GROUND_Y);
    }

    const lift = 0.84 + 0.16 * ease; // scenery brightens slightly at dawn
    blitTiled(cache.stars, cameraX * PARALLAX.stars, 1 - 0.5 * ease);
    if (ease < 1) blit(cache.moon, moonX + cache.moon.ox, moonY + cache.moon.oy, 1 - ease);
    if (ease > 0) blit(cache.sun, moonX + cache.sun.ox, moonY + cache.sun.oy, ease);

    sceneData.clouds.forEach((cloud, i) => {
      const sprite = cache.clouds[i];
      const raw = cloud.baseX - cameraX * PARALLAX.clouds - time * cloud.drift;
      const x = ((raw % CLOUD_SPAN) + CLOUD_SPAN) % CLOUD_SPAN - 420;
      if (x < VIEW_W && x + sprite.w > 0) blit(sprite, x, cloud.y + sprite.oy, lift);
    });

    blitTiled(cache.far, cameraX * PARALLAX.far, lift);
    blitTiled(cache.mid, cameraX * PARALLAX.mid, lift);

    // ground: the repeating tile, clipped to each stretch between pits
    for (const seg of level.ground) {
      if (!onScreen(seg.x, seg.w)) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(snap(seg.x - cameraX), 0, seg.w, VIEW_H + 16);
      ctx.clip();
      blitTiled(cache.ground, cameraX, lift);
      ctx.restore();
    }
    // pits: a dark drop with lit walls, visible well before the jump
    for (const pit of level.pits) {
      if (!onScreen(pit.x, pit.w)) continue;
      const px = snap(pit.x - cameraX);
      ctx.globalAlpha = 1;
      ctx.fillStyle = COLORS.pit;
      ctx.fillRect(px, GROUND_Y, pit.w, VIEW_H - GROUND_Y + 16);
      ctx.fillStyle = COLORS.ground;
      for (let row = 0; row * G < VIEW_H - GROUND_Y; row++) {
        ctx.globalAlpha = Math.max(0.08, 0.6 - row * 0.05);
        ctx.fillRect(px + 2, GROUND_Y + 4 + row * G, 3, 3);
        ctx.fillRect(px + pit.w - 5, GROUND_Y + 4 + row * G, 3, 3);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- dot-matrix slabs: platforms and movers share the look of the rocks
  function slabCells(slab, moving) {
    const c = 6;
    const cols = Math.floor(slab.w / c);
    const rows = Math.max(1, Math.floor(slab.h / c));
    const rng = mulberry32((slab.ax || slab.x) * 13 + slab.w);
    const cells = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        let color = rng() < 0.25 ? COLORS.rockMid : COLORS.rockDim;
        if (row === 0 || col === 0) color = COLORS.rockEdge;
        else if (col === cols - 1) color = COLORS.rockMid;
        // movers carry warm end caps so they read as "this one moves"
        if (moving && row === 0 && (col < 2 || col >= cols - 2)) color = COLORS.warm[1];
        cells.push({ col, row, color });
      }
    }
    return cells;
  }

  function drawSlabs(list) {
    ctx.globalAlpha = 1;
    for (const s of list) {
      if (!onScreen(s.x, s.w)) continue;
      const sx = snap(s.x - cameraX);
      const sy = snap(s.y);
      ctx.fillStyle = COLORS.rockFill;
      ctx.fillRect(sx, sy, s.w, s.h);
      for (const cell of s.cells) {
        ctx.fillStyle = cell.color;
        ctx.fillRect(sx + cell.col * 6 + 1, sy + cell.row * 6 + 1, 4, 4);
      }
    }
  }

  // ---- rocks: dot-matrix boulders whose cells follow the collision slabs
  function rockCells(rock) {
    const c = TUNING.rocks.cell;
    const cols = rock.w / c;
    const rows = rock.h / c;
    const baseRows = rock.baseH / c;
    const cap0 = rock.capX / c;
    const cap1 = cap0 + rock.capW / c;
    const inside = (col, row) =>
      col >= 0 && col < cols && row >= 0 && row < rows && (row < baseRows || (col >= cap0 && col < cap1));
    const rng = mulberry32(rock.x * 31 + rock.w * 7 + rock.h);
    const cells = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (!inside(col, row)) continue;
        const shade = rng();
        let color = shade < 0.2 ? COLORS.rockMid : COLORS.rockDim;
        if (!inside(col, row + 1) || !inside(col - 1, row)) color = COLORS.rockEdge; // lit top and left
        else if (!inside(col + 1, row)) color = COLORS.rockMid;                      // shaded right
        cells.push({ col, row, color });
      }
    }
    return cells;
  }

  function drawRocks() {
    const c = TUNING.rocks.cell;
    ctx.globalAlpha = 1;
    for (const rock of level.rocks) {
      if (!onScreen(rock.x, rock.w)) continue;
      const rx = rock.x - cameraX;
      // solid backing separates the rock from the forest dots behind it
      ctx.fillStyle = COLORS.rockFill;
      ctx.fillRect(snap(rx), snap(GROUND_Y - rock.baseH), rock.w, rock.baseH + 2);
      if (rock.h > rock.baseH) ctx.fillRect(snap(rx + rock.capX), snap(GROUND_Y - rock.h), rock.capW, rock.h - rock.baseH);
      for (const cell of rock.cells) {
        ctx.fillStyle = cell.color;
        ctx.fillRect(snap(rx + cell.col * c + 1), snap(GROUND_Y - (cell.row + 1) * c + 1), 4, 4);
      }
    }
  }

  // ---- checkpoints and the beacon
  function drawCheckpoints() {
    for (const cp of level.checkpoints) {
      if (!onScreen(cp.x - 20, 40)) continue;
      const x = snap(cp.x - cameraX);
      ctx.globalAlpha = 1;
      ctx.fillStyle = COLORS.rockMid;
      ctx.fillRect(x - 2, GROUND_Y - 78, 4, 78);
      ctx.fillRect(x - 10, GROUND_Y - 6, 20, 6);
      if (cp.active) {
        const pulse = 0.5 + 0.5 * Math.sin(time * 4);
        const glow = ctx.createRadialGradient(x, GROUND_Y - 88, 0, x, GROUND_Y - 88, 34);
        glow.addColorStop(0, `rgba(246, 160, 80, ${0.3 + 0.15 * pulse})`);
        glow.addColorStop(1, 'rgba(246, 160, 80, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(x - 34, GROUND_Y - 122, 68, 68);
      }
      // the lantern: dull until Clawd passes, burning afterwards
      ctx.fillStyle = cp.active ? COLORS.warm[0] : COLORS.rockDim;
      ctx.fillRect(x - 9, GROUND_Y - 98, 18, 20);
      ctx.fillStyle = cp.active ? COLORS.warm[2] : COLORS.rockFill;
      ctx.fillRect(x - 4, GROUND_Y - 93, 8, 10);
    }
  }

  function drawBeacon() {
    const b = level.beacon;
    if (!onScreen(b.x - 90, 180)) return;
    const x = snap(b.x - cameraX);
    const lit = b.unlocked;
    ctx.globalAlpha = 1;
    if (lit) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 3);
      const glow = ctx.createRadialGradient(x, GROUND_Y - 104, 0, x, GROUND_Y - 104, 90);
      glow.addColorStop(0, `rgba(246, 160, 80, ${0.32 + 0.14 * pulse})`);
      glow.addColorStop(1, 'rgba(246, 160, 80, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(x - 90, GROUND_Y - 194, 180, 180);
    }
    ctx.fillStyle = COLORS.rockFill;
    ctx.fillRect(x - 20, GROUND_Y - 84, 40, 84);
    ctx.fillStyle = COLORS.rockMid;
    ctx.fillRect(x - 28, GROUND_Y - 14, 56, 14);
    ctx.fillRect(x - 26, GROUND_Y - 90, 52, 8);
    ctx.fillRect(x - 18, GROUND_Y - 128, 36, 8);
    ctx.fillStyle = COLORS.rockEdge;
    for (let row = 0; row < 11; row++) {
      ctx.fillRect(x - 19, GROUND_Y - 80 + row * 6, 4, 4);
      if (row % 2) ctx.fillRect(x + 9, GROUND_Y - 80 + row * 6, 4, 4);
    }
    // the lamp: dark while sparks are missing, burning once every spark is found
    ctx.fillStyle = lit ? COLORS.warm[0] : COLORS.rockDim;
    ctx.fillRect(x - 12, GROUND_Y - 120, 24, 30);
    ctx.fillStyle = lit ? COLORS.warm[2] : COLORS.rockFill;
    ctx.fillRect(x - 6, GROUND_Y - 114, 12, 18);
  }

  // ---- collectibles
  // A small dotted star: a bright core with short rays on a 6px pitch.
  const SPARK_DOTS = (() => {
    const dots = [{ x: 0, y: 0, ring: 0 }];
    for (let k = 1; k <= 3; k++) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) dots.push({ x: dx * k, y: dy * k, ring: k });
      if (k <= 2) for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) dots.push({ x: dx * k, y: dy * k, ring: k + 0.5 });
    }
    return dots;
  })();

  function drawSparks() {
    const pitch = 6;
    for (const spark of level.sparks) {
      const sx = spark.x - cameraX;
      if (sx < -60 || sx > VIEW_W + 60) continue;

      if (spark.taken) {
        if (spark.popT <= 0) continue;
        // collected: the star opens outwards and fades
        const k = 1 - spark.popT / 0.3;
        ctx.fillStyle = COLORS.warm[1];
        for (const d of SPARK_DOTS) {
          if (d.ring === 0) continue;
          ctx.globalAlpha = (1 - k) * 0.8;
          ctx.fillRect(snap(sx + d.x * pitch * (1 + k * 1.6) - 1.5), snap(spark.popY + d.y * pitch * (1 + k * 1.6) - 1.5), 3, 3);
        }
        continue;
      }

      const sy = sparkY(spark);
      const pulse = 0.5 + 0.5 * Math.sin(time * 3.1 + spark.phase * 2);
      const halo = ctx.createRadialGradient(sx, sy, 0, sx, sy, 24);
      halo.addColorStop(0, `rgba(246, 160, 80, ${0.16 + 0.08 * pulse})`);
      halo.addColorStop(1, 'rgba(246, 160, 80, 0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = halo;
      ctx.fillRect(sx - 24, sy - 24, 48, 48);

      for (const d of SPARK_DOTS) {
        const falloff = 1 - d.ring / 4.2;
        ctx.globalAlpha = Math.min(1, falloff * (0.75 + 0.45 * pulse));
        ctx.fillStyle = d.ring === 0 ? '#ffe9bd' : d.ring < 2 ? '#f8b765' : '#f09a4a';
        const size = d.ring === 0 ? 4 : 3;
        ctx.fillRect(snap(sx + d.x * pitch - size / 2), snap(sy + d.y * pitch - size / 2), size, size);
      }
    }
    ctx.globalAlpha = 1;
  }

  // Embers: small orange coins, much plainer than a spark.
  function drawEmbers() {
    for (const ember of level.embers) {
      if (ember.taken || !onScreen(ember.x - 8, 16)) continue;
      const x = snap(ember.x - cameraX);
      const y = snap(ember.y + Math.sin(time * 3 + ember.x * 0.05) * 2);
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = COLORS.warm[0];
      ctx.fillRect(x - 5, y - 2, 10, 4);
      ctx.fillRect(x - 2, y - 5, 4, 10);
      ctx.fillStyle = COLORS.warm[2];
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;
  }

  const HEART_ROWS = ['0110110', '1111111', '1111111', '0111110', '0011100', '0001000'];
  const SHIELD_ROWS = ['1111111', '1111111', '1111111', '1111111', '0111110', '0011100', '0001000'];

  function drawPixelIcon(rows, cx, cy, unit, color) {
    ctx.fillStyle = color;
    const left = snap(cx - (rows[0].length * unit) / 2);
    const top = snap(cy - (rows.length * unit) / 2);
    rows.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) if (row[c] === '1') ctx.fillRect(left + c * unit, top + r * unit, unit, unit);
    });
  }

  function drawItems() {
    const bob = Math.sin(time * 2.6) * 3;
    ctx.globalAlpha = 1;
    for (const heart of level.hearts) {
      if (heart.taken || !onScreen(heart.x - 14, 28)) continue;
      drawPixelIcon(HEART_ROWS, heart.x - cameraX, heart.y + bob, 4, COLORS.warm[0]);
      ctx.fillStyle = COLORS.warm[4];
      ctx.fillRect(snap(heart.x - cameraX - 10), snap(heart.y + bob - 8), 4, 4);
    }
    for (const item of level.shields) {
      if (item.taken || !onScreen(item.x - 14, 28)) continue;
      drawPixelIcon(SHIELD_ROWS, item.x - cameraX, item.y + bob, 4, COLORS.cool);
      drawPixelIcon(['111', '111', '010'], item.x - cameraX, item.y + bob - 2, 4, COLORS.warm[0]);
    }
  }

  // ---- patrollers: squat cold-blue creatures that shuffle back and forth
  function drawEnemies() {
    for (const e of level.enemies) {
      if (!onScreen(e.x, e.w) || (!e.alive && e.squashT <= 0)) continue;
      const squash = e.alive ? 1 : (e.squashT / 0.3) * 0.5;
      const x = snap(e.x - cameraX);
      const bottom = e.y + e.h;
      const h = e.h * squash;
      const stepFrame = Math.floor(time * 6 + e.minX) % 2;
      ctx.globalAlpha = e.alive ? 1 : e.squashT / 0.3;
      ctx.fillStyle = COLORS.enemy;
      ctx.fillRect(x + 4, snap(bottom - h), e.w - 8, 6 * squash);
      ctx.fillRect(x, snap(bottom - h + 6 * squash), e.w, h - 14 * squash);
      ctx.fillStyle = COLORS.enemyDark;
      ctx.fillRect(x, snap(bottom - 14 * squash), e.w, 6 * squash);
      if (e.alive) {
        for (let i = 0; i < 4; i++) {
          const lift = i % 2 === stepFrame ? 3 : 0;
          ctx.fillRect(x + 4 + i * 11, bottom - 8, 6, 8 - lift);
        }
        ctx.fillStyle = COLORS.eye;
        const look = e.dir > 0 ? 6 : 0;
        ctx.fillRect(x + 9 + look, bottom - e.h + 9, 5, 8);
        ctx.fillRect(x + 26 + look, bottom - e.h + 9, 5, 8);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- meteors: warning marker, falling head with a pixel tail, impact ring
  function drawMeteors() {
    const cfg = TUNING.meteor;
    const R = cfg.radius;
    for (const meteor of meteors) {
      const mx = meteor.x - cameraX;
      const my = meteor.y;

      if (meteor.phase !== 'impact') {
        const elapsed = meteor.phase === 'warning' ? meteor.t : cfg.warnSeconds + meteor.t;
        const urgency = elapsed / (cfg.warnSeconds + cfg.fallSeconds);
        const blink = 0.5 + 0.5 * Math.sin(elapsed * (9 + urgency * 26));

        // marker spanning the damage width, with end posts
        ctx.fillStyle = COLORS.warm[0];
        ctx.globalAlpha = 0.55 + 0.45 * blink;
        for (let dx = -R; dx <= R; dx += 10) ctx.fillRect(snap(mx + dx - 2), my + 2, 4, 4);
        ctx.fillRect(snap(mx - R - 2), my - 12, 4, 14);
        ctx.fillRect(snap(mx + R - 2), my - 12, 4, 14);
        // dotted arc: the exact damage circle
        ctx.fillStyle = COLORS.warm[1];
        ctx.globalAlpha = 0.45 + 0.4 * blink;
        for (let i = 1; i < 14; i++) {
          const a = Math.PI + (i / 14) * Math.PI;
          ctx.fillRect(snap(mx + Math.cos(a) * R - 1.5), snap(my + Math.sin(a) * R - 1.5), 3, 3);
        }
        // warning sign: a stepped triangle with an exclamation mark
        const signY = my - 118 + Math.round(Math.sin(elapsed * 6) * 2);
        ctx.fillStyle = COLORS.warm[0];
        ctx.globalAlpha = 0.7 + 0.3 * blink;
        for (let row = 0; row < 6; row++) ctx.fillRect(snap(mx - 2 - row * 3), signY + row * 4, 4 + row * 6, 4);
        ctx.fillStyle = COLORS.eye;
        ctx.globalAlpha = 1;
        ctx.fillRect(snap(mx - 1), signY + 7, 3, 9);
        ctx.fillRect(snap(mx - 1), signY + 18, 3, 3);
      }

      if (meteor.phase === 'falling') {
        const at = (k) => ({
          x: meteor.fromX + (meteor.x - meteor.fromX) * k - cameraX,
          y: -40 + (my + 40) * k,
        });
        const k = meteor.t / cfg.fallSeconds;
        for (let i = 7; i >= 1; i--) {
          const p = at(Math.max(0, k - i * 0.03));
          const size = 11 - i;
          ctx.globalAlpha = 1 - i / 9;
          ctx.fillStyle = COLORS.warm[i % 3];
          ctx.fillRect(snap(p.x - size / 2), snap(p.y - size / 2), size, size);
        }
        const head = at(k);
        ctx.globalAlpha = 1;
        ctx.fillStyle = COLORS.warm[0];
        ctx.fillRect(snap(head.x - 8), snap(head.y - 8), 16, 16);
        ctx.fillStyle = COLORS.warm[4];
        ctx.fillRect(snap(head.x - 4), snap(head.y - 4), 8, 8);
      }

      if (meteor.phase === 'impact') {
        const k = Math.min(1, meteor.t / cfg.impactSeconds);
        const fade = (1 - k) * (1 - k);
        const flash = ctx.createRadialGradient(mx, my, 0, mx, my, R);
        flash.addColorStop(0, `rgba(255, 207, 138, ${0.55 * fade})`);
        flash.addColorStop(1, 'rgba(234, 109, 65, 0)');
        ctx.globalAlpha = 1;
        ctx.fillStyle = flash;
        ctx.fillRect(mx - R, my - R, R * 2, R);
        const ring = R * Math.min(1, 0.35 + k * 2.2);
        ctx.fillStyle = COLORS.warm[1];
        ctx.globalAlpha = fade;
        for (let i = 0; i <= 16; i++) {
          const a = Math.PI + (i / 16) * Math.PI;
          ctx.fillRect(snap(mx + Math.cos(a) * ring - 2), snap(my + Math.sin(a) * ring - 2), 4, 4);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  // Clawd's fixed base figure, measured from the reference image and scaled
  // so the whole figure is 56px tall and centred on the 56x56 collision box.
  // x is measured from the centre line; every animation reuses these parts.
  const CLAWD = {
    body: { w: 58, h: 45 },
    leg: { w: 5, h: 11, xs: [-25, -15, 10, 20] },
    arm: { w: 11, h: 12, top: 20 },            // top: offset below the body top
    eye: { w: 5, h: 10, top: 10, xs: [-19, 14] },
  };

  // Drawing only: poses move or resize the base parts by a few pixels and
  // never touch the collision box, speed or jump height.
  function drawPlayer() {
    const grounded = player.onGround;
    const walking = grounded && Math.abs(player.vx) > 20;

    // small squash & stretch around the soles
    let sx = 1;
    let sy = 1;
    if (anim.landT < 0.14) {
      const k = 1 - anim.landT / 0.14;
      sy = 1 - 0.12 * k;
      sx = 1 + 0.07 * k;
    } else if (anim.jumpT < 0.06) {
      sy = 0.9;
      sx = 1.06;
    } else if (anim.jumpT < 0.28) {
      const k = 1 - (anim.jumpT - 0.06) / 0.22;
      sy = 1 + 0.08 * k;
      sx = 1 - 0.05 * k;
    }

    // little hop right after collecting a spark
    const hop = anim.hopT < 0.32 ? -Math.sin((anim.hopT / 0.32) * Math.PI) * 7 : 0;

    const fx = snap(player.x + PLAYER_W / 2 - cameraX);
    const fy = player.y + PLAYER_H + hop;
    // Equal parts get equal device-pixel sizes, so legs and eyes stay uniform.
    const len = (v) => Math.max(1, Math.round(v * renderScale)) / renderScale;
    const rect = (x, y, w, h) => ctx.fillRect(snap(fx + x * sx), snap(fy + y * sy), len(w * sx), len(h * sy));

    const { body, leg, arm, eye } = CLAWD;
    const stepFrame = Math.floor(player.walkPhase) % 2;
    let bob = 0;
    if (walking) bob = Math.floor(player.walkPhase * 2) % 2 ? -1 : 0;
    else if (grounded) bob = Math.sin(time * 2.4) > 0.3 ? -1 : 0; // idle
    anim.bob = bob;
    const bodyBottom = -leg.h + bob;
    const bodyTop = bodyBottom - body.h;

    // flicker while invulnerable after a hit
    const alpha = state === 'playing' && invuln > 0 && Math.floor(invuln * 10) % 2 === 0 ? 0.35 : 1;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = COLORS.clawd;

    // four legs; each overlaps 2px into the body so no seam can appear
    leg.xs.forEach((lx, i) => {
      let length = leg.h - bob;
      let shift = 0;
      if (!grounded) {
        if (player.vy < 0) {
          length = leg.h - 3;               // slightly tucked while rising
        } else {
          length = leg.h + 1;               // reaching for the ground
          shift = i === 0 ? -1 : i === 3 ? 1 : 0;
        }
      } else if (walking && i % 2 === stepFrame) {
        length = leg.h - 4 - bob;           // lifted pair
        shift = player.facing;
      }
      rect(lx + shift, bodyBottom - 2, leg.w, length + 2);
    });

    // body and arms
    rect(-body.w / 2, bodyTop, body.w, body.h);
    const armTop = bodyTop + arm.top + (grounded ? 0 : -3);
    rect(-body.w / 2 - arm.w, armTop, arm.w + 2, arm.h);
    rect(body.w / 2 - 2, armTop, arm.w + 2, arm.h);

    // eyes: always two upright black rectangles
    const look = Math.round(anim.turn * 2);
    ctx.fillStyle = COLORS.eye;
    for (const ex of eye.xs) rect(ex + look, bodyTop + eye.top, eye.w, eye.h);

    // shield: a calm ring of cool dots marching around Clawd
    if (shield) {
      ctx.fillStyle = COLORS.cool;
      const n = 22;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + time * 1.2;
        ctx.globalAlpha = i % 2 ? 0.85 : 0.5;
        ctx.fillRect(snap(fx + Math.cos(a) * 52 - 1.5), snap(fy - PLAYER_H / 2 + Math.sin(a) * 42 - 1.5), 3, 3);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawParticles() {
    for (const p of particles) {
      ctx.globalAlpha = Math.min(1, p.life / p.maxLife * 1.6);
      ctx.fillStyle = p.color;
      ctx.fillRect(snap(p.x - cameraX - p.size / 2), snap(p.y - p.size / 2), p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  // ---- title: 5x7 dot-matrix letters
  const GLYPHS = {
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
    L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  };

  function layoutTitleLine(text) {
    const cells = [];
    let cursor = 0;
    for (const ch of text) {
      const glyph = GLYPHS[ch];
      glyph.forEach((row, cy) => {
        for (let cx = 0; cx < row.length; cx++) {
          if (row[cx] === '1') cells.push({ cx: cursor + cx, cy });
        }
      });
      cursor += glyph[0].length + 1;
    }
    return { cells, width: cursor - 2 };
  }
  const TITLE_LINES = [
    { ...layoutTitleLine('SUPER'), top: 126 },
    { ...layoutTitleLine('CLAUDE'), top: 238 },
  ];

  function drawTitle() {
    const pitch = 12;
    ctx.fillStyle = COLORS.title;
    for (const line of TITLE_LINES) {
      const left = VIEW_W / 2 - (line.width * pitch) / 2;
      for (const cell of line.cells) {
        const shimmer = 0.78 + 0.12 * Math.sin(time * 1.6 + cell.cx * 0.35 + cell.cy * 0.2);
        ctx.globalAlpha = shimmer * titleFade;
        ctx.beginPath();
        ctx.arc(left + cell.cx * pitch, line.top + cell.cy * pitch, 3.1, 0, TAU);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function render() {
    // Camera shake is a drawing offset only; world coordinates never move.
    ctx.save();
    if (shakeT > 0) {
      const k = (shakeT / TUNING.meteor.shakeSeconds) * TUNING.meteor.shakePixels;
      ctx.translate(snap(Math.sin(time * 97) * k), snap(Math.cos(time * 71) * k));
    }
    drawScene();
    if (titleFade > 0) drawTitle();
    drawSlabs(level.platforms);
    drawSlabs(level.movers);
    drawCheckpoints();
    drawBeacon();
    drawRocks();
    drawEmbers();
    drawItems();
    drawSparks();
    drawEnemies();
    drawMeteors();
    drawPlayer();
    drawParticles();
    ctx.restore();

    if (hurtFlash > 0) {
      ctx.globalAlpha = (hurtFlash / 0.18) * 0.1;
      ctx.fillStyle = COLORS.warm[0];
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
    if (state === 'paused' || state === 'gameover' || state === 'levelclear' || state === 'completed') {
      ctx.globalAlpha = state === 'paused' ? 0.5 : Math.min(state === 'completed' ? 0.3 : 0.5, endTime);
      ctx.fillStyle = '#080c13';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------- sizing
  // The backing store follows the displayed size (capped) for sharp pixels,
  // while all drawing stays in 1280x720 logical units.
  let rebuildTimer = 0;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.min(MAX_CANVAS_W, Math.round(rect.width * dpr)));
    const height = Math.max(1, Math.round(width * VIEW_H / VIEW_W));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    renderScale = width / VIEW_W;
    ctx.setTransform(renderScale, 0, 0, height / VIEW_H, 0, 0);
    ctx.imageSmoothingEnabled = false;

    // Cached layers are repainted at the new scale once resizing settles.
    if (!cache) {
      buildCache(renderScale);
    } else if (cache.scale !== renderScale) {
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => buildCache(renderScale), 140);
    }
  }
  window.addEventListener('resize', resize);

  // --------------------------------------------------------------------- loop
  const MAX_DT = 0.05;
  const STEP = 1 / 120;
  let last = performance.now();

  function frame(now) {
    let dt = Math.min((now - last) / 1000, MAX_DT);
    last = now;
    // Fixed sub-steps keep physics identical across refresh rates.
    while (dt > 0) {
      const slice = Math.min(dt, STEP);
      update(slice);
      dt -= slice;
    }
    render();
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------- read-only snapshot
  const box = (o) => ({ x: o.x, y: o.y, w: o.w, h: o.h });
  const dynamicState = () => ({
    state,
    paused: state === 'paused',
    level: level.index + 1,
    lives,
    shield,
    invuln,
    checkpoint: cpIndex,
    respawns,
    cameraX,
    player: { x: player.x, y: player.y, vx: player.vx, vy: player.vy, onGround: player.onGround, facing: player.facing, riding: !!player.ride },
    sparksTaken: run.sparks,
    embersTaken: run.embers,
    beaconUnlocked: level.beacon.unlocked,
    enemies: level.enemies.map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h, dir: e.dir, alive: e.alive, surfaceY: e.surfaceY })),
    movers: level.movers.map((m) => ({ x: m.x, y: m.y, w: m.w, h: m.h, dx: m.dx, dy: m.dy })),
    meteors: meteors.map((m) => ({ x: m.x, y: m.y, phase: m.phase, t: m.t, escape: m.escape })),
    time: { level: run.time, meteorClock: scheduler.clock },
    hits: run.hits,
    score: run.score,
  });

  const debugApi = {
    // Lightweight per-frame view: everything that changes while playing.
    state: dynamicState,
    // Full view: dynamic state plus the static layout of the current level.
    snapshot: () => ({
      ...dynamicState(),
      seed: adventure.seed,
      levelSeed: level.seed,
      levelName: level.name,
      levelIndex: level.index,
      width: level.width,
      layout: JSON.parse(JSON.stringify(level.layout)),
      ground: level.ground.map(box),
      pits: level.pits.map((p) => ({ x: p.x, w: p.w })),
      platforms: level.platforms.map(box),
      moverPaths: level.movers.map((m) => ({ ax: m.ax, ay: m.ay, bx: m.bx, by: m.by, w: m.w, period: m.period })),
      rocks: level.rocks.map((r) => ({ x: r.x, w: r.w, h: r.h, rects: r.rects.map(box) })),
      rockCount: level.rocks.length,
      sparks: level.sparks.map((s) => ({ x: s.x, y: s.y, taken: s.taken })),
      embers: level.embers.map((e) => ({ x: e.x, y: e.y, taken: e.taken })),
      hearts: level.hearts.map((h) => ({ x: h.x, y: h.y, taken: h.taken })),
      shields: level.shields.map((s) => ({ x: s.x, y: s.y, taken: s.taken })),
      checkpoints: level.checkpoints.map((c) => ({ x: c.x, active: c.active })),
      beacon: { x: level.beacon.x, unlocked: level.beacon.unlocked },
      enemyRanges: level.enemies.map((e) => ({ minX: e.minX, maxX: e.maxX, surfaceY: e.surfaceY })),
      meteorSchedule: {
        clock: scheduler.clock, nextCheck: scheduler.nextCheck, lastStart: scheduler.lastStart,
        rolls: scheduler.rolls, starts: [...meteorLog], warnings: [...warningLog], maxActive: maxActiveMeteors,
      },
      run: { ...run },
      banked: adventure.banked.map((b) => ({ ...b })),
      totalScore: adventure.banked.reduce((a, b) => a + b.score, 0),
      endTime,
      dawn,
      shake: shakeT,
      particles: particles.length,
      heldKeys: [...held],
      anim: { ...anim },
      note: noteEl.classList.contains('show') ? noteEl.textContent : null,
      tuning: JSON.parse(JSON.stringify(TUNING)),
      world: { groundY: GROUND_Y, viewW: VIEW_W, viewH: VIEW_H, playerW: PLAYER_W, playerH: PLAYER_H },
      render: { scale: renderScale, cacheScale: cache ? cache.scale : null },
      audio: audio ? audio.stats() : null,
    }),
  };
  window.superClaude = debugApi;
  window.clawdsQuest = debugApi; // earlier name, kept so existing tools keep working

  // ----------------------------------------------------------- audio controls
  const muteBtn = $('mute-btn');
  function showAudioSettings() {
    const a = audio ? audio.getSettings() : { volume: 0, muted: true, audible: false };
    muteBtn.setAttribute('aria-pressed', String(!a.audible));
    muteBtn.setAttribute('aria-label', a.audible ? 'Mute sound (M)' : 'Unmute sound (M)');
    muteBtn.title = a.audible ? 'Sound on — press M to mute' : 'Sound off — press M to unmute';
    $('mute-label').textContent = a.audible ? 'SOUND' : 'MUTED';
    stage.dataset.sound = a.audible ? 'on' : 'off';
    volumeEl.value = String(Math.round((a.muted ? 0 : a.volume) * 100));
    volumeEl.setAttribute('aria-valuetext', a.audible ? `${Math.round(a.volume * 100)} percent` : 'muted');
  }
  if (audio) audio.onChange(showAudioSettings);
  muteBtn.addEventListener('click', () => {
    audioCall('unlock');
    audioCall('toggleMute');
    sfx('confirm');
    muteBtn.blur(); // keep Space / Enter for the game
  });
  volumeEl.addEventListener('input', () => audioCall('setVolume', Number(volumeEl.value) / 100));
  volumeEl.addEventListener('change', () => sfx('confirm')); // a short sample at the new level
  volumeEl.addEventListener('pointerup', () => volumeEl.blur()); // after a drag, keys go back to the game
  showAudioSettings();

  newAdventure();
  resize();
  requestAnimationFrame(frame);
})();
