// Super Claude — level data, tuning and pure generation helpers.
// No DOM and no game state in this file, so it also loads in Node for checks.
(function (root) {
  'use strict';

  const GROUND_Y = 540;
  const VIEW_W = 1280;
  const VIEW_H = 720;
  const PLAYER = { w: 56, h: 56, startX: 110 };

  const PHYS = {
    gravity: 2400,
    jumpSpeed: 860,     // full jump peaks ≈ 154px, ≈ 244px long at full speed
    jumpCut: 300,       // releasing jump early caps upward speed (short hop)
    jumpBuffer: 0.1,
    maxSpeed: 340,
    accel: 2600,
    turnAccel: 4200,
    decel: 3000,
    maxFall: 1500,
    stompBounce: 560,
  };

  // Platform tiers: every step up is 110px, well inside the 154px jump.
  const TIER = [0, 110, 220, 330];
  const PLAT_H = 22;

  // ------------------------------------------------------------------ tuning
  const TUNING = {
    lives: 3,
    invulnSeconds: 1.5,        // after losing a heart
    shieldInvuln: 1.0,         // after the shield absorbs a hit
    respawnInvuln: 2,
    respawnMeteorGrace: 3,     // no new meteor this long after a respawn
    score: { spark: 100, ember: 10, stomp: 50, levelClear: 250 },
    rocks: {
      spacing: 300,            // one candidate per this much zone length
      minGap: 240,             // edge to edge
      sparkSafe: 200,          // from any spark
      highSparkSafe: 272,      // from sparks jumped for from the ground: covers take-off and landing
      zoneMargin: 60,
      widths: [30, 36, 42, 48, 54, 60],
      heights: [24, 30, 36, 42, 48],
      cell: 6,
      hitInset: 3,
    },
    enemy: { w: 46, h: 34, stompTolerance: 10 },
    meteor: {
      warnSeconds: 1.3,
      fallSeconds: 0.55,
      impactSeconds: 0.5,
      radius: 50,              // damage circle around the impact point, same as the marker
      nearPlayer: 380,         // impact points fall within this range of Clawd
      viewMargin: 100,         // and this far inside the visible area
      edgeMargin: 150,         // away from pit edges and surface ends (jump take-off / landing)
      protectRadius: 260,      // around the spawn point, checkpoints and the beacon
      minSurface: 300,         // never on a narrow foothold
      escapeRoom: 90,          // free standing room required right next to the blast
      separation: 260,         // between two simultaneous impact points
      shakePixels: 5,
      shakeSeconds: 0.3,
    },
    // Per level: rock density, patrol speed and the meteor schedule.
    levels: [
      { rockChance: 0.6, enemySpeed: 55,
        meteor: { firstDelay: 6, checkEvery: 3, chance: 0.4, cooldown: 6, maxActive: 1, doubleChance: 0, stagger: 0 } },
      { rockChance: 0.7, enemySpeed: 70,
        meteor: { firstDelay: 5, checkEvery: 3, chance: 0.55, cooldown: 5, maxActive: 1, doubleChance: 0, stagger: 0 } },
      { rockChance: 0.8, enemySpeed: 85,
        meteor: { firstDelay: 5, checkEvery: 2.5, chance: 0.65, cooldown: 4, maxActive: 2, doubleChance: 0.5, stagger: 0.9 } },
    ],
  };

  // --------------------------------------------------------------- utilities
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Each level of an adventure gets its own seed.
  function levelSeed(adventureSeed, index) {
    return (Math.imul((adventureSeed >>> 0) ^ 0x9e3779b9, 2654435761) + index * 0x85ebca6b) >>> 0;
  }

  // Decides when a meteor event may start, from accumulated play time only.
  // The cooldown is measured from the actual start of the previous event.
  function createMeteorScheduler(cfg, rng) {
    return {
      clock: 0,
      nextCheck: cfg.firstDelay,
      lastStart: -Infinity,
      rolls: 0,
      tick(dt) {
        this.clock += dt;
        if (this.clock < this.nextCheck) return false;
        if (this.clock - this.lastStart < cfg.cooldown) return false; // re-checked every step until it has passed
        this.nextCheck = this.clock + cfg.checkEvery;
        this.rolls += 1;
        return rng() < cfg.chance;
      },
      started() {
        this.lastStart = this.clock;
      },
      delay(seconds) {
        this.nextCheck = Math.max(this.nextCheck, this.clock + seconds);
      },
    };
  }

  // ------------------------------------------------------------ chunk library
  // Levels are sequences of hand-designed terrain chunks. Each chunk starts and
  // ends on plain ground and records what it placed in `lv.layout`.

  const plat = (x, tier, w) => ({ x, y: GROUND_Y - TIER[tier], w, h: PLAT_H });

  function emberArc(lv, x0, x1, baseH, rise, n) {
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      lv.embers.push({ x: Math.round(x0 + (x1 - x0) * t), y: Math.round(GROUND_Y - baseH - rise * 4 * t * (1 - t)) });
    }
  }

  const CHUNKS = {
    start(lv, x, p) {
      const len = p.len || 600;
      return { len };
    },

    // Plain ground: optional spark, and a zone where seeded rocks may appear.
    flat(lv, x, p) {
      const len = p.len || 900;
      const info = { len };
      if (p.spark) {
        const high = p.spark === 'high';
        const spark = { x: x + len / 2, y: GROUND_Y - (high ? 150 : 34), fromGround: high };
        lv.sparks.push(spark);
        info.spark = spark;
        if (high) emberArc(lv, spark.x - 46, spark.x + 46, 96, 0, 2);
      }
      if (p.rocks !== false) lv.rockZones.push([x + TUNING.rocks.zoneMargin, x + len - TUNING.rocks.zoneMargin]);
      return info;
    },

    // Staircase of platforms with a spark on top and an optional side branch.
    steps(lv, x, p) {
      const tiers = p.tiers || 2;
      const plats = [plat(x + 200, 1, 220), plat(x + 510, 2, 220)];
      if (tiers === 3) plats.push(plat(x + 820, 3, 220));
      lv.platforms.push(...plats);
      const top = plats[plats.length - 1];
      const spark = { x: top.x + top.w / 2, y: top.y - 34 };
      lv.sparks.push(spark);
      emberArc(lv, x + 110, x + 250, 60, 70, 3);
      emberArc(lv, x + 400, x + 560, 170, 70, 3);
      const info = { len: tiers === 3 ? 1300 : 1000, plats, spark };
      if (p.bonus) {
        // exploration branch: a ledge back to the left, reached from the second step
        const ledge = plat(x + 210, 3, 190);
        lv.platforms.push(ledge);
        const item = { x: ledge.x + 40, y: ledge.y - 30 };
        if (p.bonus === 'heart') lv.hearts.push(item);
        else if (p.bonus === 'shield') lv.shields.push(item);
        emberArc(lv, ledge.x + 80, ledge.x + 170, TIER[3] + 30, 0, p.bonus === 'embers' ? 5 : 3);
        info.bonus = { ledge, kind: p.bonus };
      }
      return info;
    },

    pit(lv, x, p) {
      const pit = { x: x + 220, w: p.w };
      lv.pits.push(pit);
      emberArc(lv, pit.x - 30, pit.x + pit.w + 30, 70, 60, 5);
      return { len: 440 + p.w, pit };
    },

    // Open ground with one or two patrollers.
    patrol(lv, x, p) {
      const len = p.len || 800;
      const ranges = p.n === 2
        ? [[x + 140, x + len / 2 - 50], [x + len / 2 + 50, x + len - 150]]
        : [[x + 160, x + len - 170]];
      const enemies = ranges.map(([minX, maxX], i) => ({ minX, maxX, surfaceY: GROUND_Y, x: i % 2 ? minX : maxX - TUNING.enemy.w, dir: i % 2 ? 1 : -1 }));
      lv.enemies.push(...enemies);
      emberArc(lv, x + len / 2 - 90, x + len / 2 + 90, 110, 30, 4);
      const info = { len, enemies };
      if (p.spark) {
        info.spark = { x: x + len - 70, y: GROUND_Y - 34 };
        lv.sparks.push(info.spark);
      }
      return info;
    },

    // A wide pit crossed on a platform that slides left and right.
    bridge(lv, x, p) {
      const pit = { x: x + 220, w: p.w || 300 };
      lv.pits.push(pit);
      const mover = { w: 140, h: PLAT_H, ax: pit.x + 8, ay: GROUND_Y, bx: pit.x + pit.w - 148, by: GROUND_Y, period: 6 };
      lv.movers.push(mover);
      emberArc(lv, pit.x + 60, pit.x + pit.w - 60, 46, 0, 3);
      return { len: 440 + pit.w, pit, mover };
    },

    // A lift up to a long ledge with a spark (and sometimes a patroller).
    lift(lv, x, p) {
      const ledge = plat(x + 360, 2, 440);
      lv.platforms.push(ledge);
      const mover = { w: 130, h: PLAT_H, ax: x + 200, ay: GROUND_Y - 30, bx: x + 200, by: ledge.y - 6, period: 7 };
      lv.movers.push(mover);
      const spark = { x: ledge.x + 100, y: ledge.y - 34 };
      lv.sparks.push(spark);
      emberArc(lv, ledge.x + 330, ledge.x + 410, TIER[2] + 30, 0, 3);
      const info = { len: 1100, ledge, mover, spark };
      if (p.enemy) {
        const enemy = { minX: ledge.x + 190, maxX: ledge.x + ledge.w - 20, surfaceY: ledge.y, x: ledge.x + ledge.w - 20 - TUNING.enemy.w, dir: -1 };
        lv.enemies.push(enemy);
        info.enemies = [enemy];
      }
      return info;
    },

    // A long pit crossed by hopping between small islands.
    islands(lv, x, p) {
      const n = p.n || 2;
      const gap = p.gap || 110;
      const w = 160;
      const pit = { x: x + 220, w: gap * (n + 1) + w * n };
      lv.pits.push(pit);
      const plats = [];
      for (let i = 0; i < n; i++) {
        const island = { x: pit.x + gap + i * (w + gap), y: GROUND_Y, w, h: PLAT_H };
        plats.push(island);
        emberArc(lv, island.x - gap + 10, island.x - 10, 70, 50, 3);
      }
      lv.platforms.push(...plats);
      const info = { len: 440 + pit.w, pit, plats };
      if (p.spark) {
        const mid = plats[Math.floor(n / 2)];
        info.spark = { x: mid.x + mid.w / 2, y: GROUND_Y - 34 };
        lv.sparks.push(info.spark);
      }
      return info;
    },

    checkpoint(lv, x) {
      const cp = { x: x + 250 };
      lv.checkpoints.push(cp);
      return { len: 500, checkpoint: cp };
    },

    beacon(lv, x) {
      lv.beacon = { x: x + 420 };
      return { len: 700 };
    },
  };

  // ------------------------------------------------------------------ levels
  const LEVEL_DEFS = [
    {
      name: 'Forest Trail',
      sparksRequired: 8,
      sky: [14, 21, 33],
      chunks: [
        ['start', { hint: 'Collect every spark, then reach the beacon.' }],
        ['flat', { len: 900, spark: 'ground' }],
        ['flat', { len: 1100, spark: 'high', hint: 'Jump over rocks. Hold jump longer to go higher.' }],
        ['steps', { tiers: 2, bonus: 'embers', hint: 'Climb the platforms. Side ledges hide extra embers.' }],
        ['patrol', { len: 800, n: 1, hint: 'Stomp patrollers from above. Their sides hurt.' }],
        ['flat', { len: 900, spark: 'ground' }],
        ['checkpoint', {}],
        ['pit', { w: 120, hint: 'Mind the gaps. A fall costs a heart.' }],
        ['flat', { len: 1100, spark: 'high' }],
        ['steps', { tiers: 2, bonus: 'shield', hint: 'A shield absorbs one hit.' }],
        ['patrol', { len: 900, n: 1 }],
        ['flat', { len: 900 }],
        ['pit', { w: 140 }],
        ['checkpoint', {}],
        ['bridge', { w: 300, hint: 'Sliding platforms carry you across.' }],
        ['flat', { len: 900 }],
        ['patrol', { len: 800, n: 1 }],
        ['pit', { w: 130 }],
        ['flat', { len: 900, spark: 'ground' }],
        ['steps', { tiers: 3, bonus: 'heart' }],
        ['patrol', { len: 800, n: 1 }],
        ['flat', { len: 800 }],
        ['beacon', {}],
      ],
    },
    {
      name: 'Falling Stars',
      sparksRequired: 10,
      sky: [13, 19, 34],
      chunks: [
        ['start', { hint: 'More stars are falling tonight. Watch the markers.' }],
        ['flat', { len: 900, spark: 'ground' }],
        ['pit', { w: 150 }],
        ['steps', { tiers: 3, bonus: 'embers' }],
        ['patrol', { len: 900, n: 2, spark: true }],
        ['flat', { len: 900 }],
        ['islands', { n: 2, spark: true, hint: 'Hop across the islands.' }],
        ['flat', { len: 1100, spark: 'high' }],
        ['checkpoint', {}],
        ['lift', { enemy: false, hint: 'Lifts rise and fall. Step off at the top.' }],
        ['pit', { w: 160 }],
        ['flat', { len: 800 }],
        ['bridge', { w: 320 }],
        ['patrol', { len: 900, n: 2 }],
        ['pit', { w: 150 }],
        ['steps', { tiers: 2, bonus: 'heart' }],
        ['patrol', { len: 900, n: 2 }],
        ['checkpoint', {}],
        ['islands', { n: 3 }],
        ['flat', { len: 1100, spark: 'high' }],
        ['lift', { enemy: true }],
        ['flat', { len: 900 }],
        ['pit', { w: 165 }],
        ['steps', { tiers: 3, bonus: 'shield' }],
        ['patrol', { len: 800, n: 1 }],
        ['flat', { len: 900 }],
        ['beacon', {}],
      ],
    },
    {
      name: 'Before Dawn',
      sparksRequired: 12,
      sky: [17, 22, 37],
      chunks: [
        ['start', { hint: 'Almost dawn. Everything at once now.' }],
        ['pit', { w: 160 }],
        ['flat', { len: 1100, spark: 'high' }],
        ['islands', { n: 3, gap: 120, spark: true }],
        ['patrol', { len: 900, n: 2, spark: true }],
        ['steps', { tiers: 3, bonus: 'heart' }],
        ['bridge', { w: 340 }],
        ['flat', { len: 900 }],
        ['pit', { w: 165 }],
        ['lift', { enemy: true }],
        ['flat', { len: 1000, spark: 'ground' }],
        ['checkpoint', {}],
        ['islands', { n: 3, gap: 120, spark: true }],
        ['steps', { tiers: 3, bonus: 'shield' }],
        ['flat', { len: 900 }],
        ['patrol', { len: 900, n: 2 }],
        ['pit', { w: 165 }],
        ['pit', { w: 150 }],
        ['lift', { enemy: true }],
        ['flat', { len: 1100, spark: 'high' }],
        ['checkpoint', {}],
        ['bridge', { w: 340 }],
        ['islands', { n: 3, gap: 125, spark: true }],
        ['patrol', { len: 900, n: 2 }],
        ['steps', { tiers: 3, bonus: 'heart' }],
        ['pit', { w: 165 }],
        ['flat', { len: 1000 }],
        ['beacon', {}],
      ],
    },
  ];

  // ------------------------------------------------------------ rock seeding
  function makeRock(rng, centre) {
    const cfg = TUNING.rocks;
    const c = cfg.cell;
    const pick = (list) => list[Math.floor(rng() * list.length)];
    const w = pick(cfg.widths);
    const h = pick(cfg.heights);
    // a wide base slab with an optional narrower cap
    const baseH = Math.min(h, Math.max(2 * c, Math.round((h * (0.5 + rng() * 0.25)) / c) * c));
    const capW = Math.max(3 * c, Math.round((w * (0.45 + rng() * 0.25)) / c) * c);
    const capX = Math.round((rng() * (w - capW)) / c) * c;
    return { x: Math.round(centre - w / 2), w, h, baseH, capW, capX };
  }

  // Collision rectangles of a rock, slightly inside its drawn outline.
  function rockHitRects(rock) {
    const inset = TUNING.rocks.hitInset;
    const rects = [{ x: rock.x + inset, y: GROUND_Y - rock.baseH + inset, w: rock.w - inset * 2, h: rock.baseH - inset }];
    if (rock.h > rock.baseH) {
      rects.push({ x: rock.x + rock.capX + inset, y: GROUND_Y - rock.h + inset, w: rock.capW - inset * 2, h: rock.h - rock.baseH });
    }
    return rects;
  }

  // Ground stretches where a rock may never stand: [x0, x1] pairs.
  function rockKeepouts(lv) {
    const cfg = TUNING.rocks;
    const out = [[0, PLAYER.startX + PLAYER.w + 400]];
    for (const s of lv.sparks) {
      const reach = s.fromGround ? cfg.highSparkSafe : cfg.sparkSafe;
      out.push([s.x - reach, s.x + reach]);
    }
    for (const p of lv.pits) out.push([p.x - 220, p.x + p.w + 220]);
    for (const c of lv.checkpoints) out.push([c.x - 220, c.x + 220]);
    for (const e of lv.enemies) if (e.surfaceY === GROUND_Y) out.push([e.minX - 100, e.maxX + 100]);
    for (const p of lv.platforms) out.push([p.x - 200, p.x + p.w + 200]); // take-off and drop zones
    for (const m of lv.movers) out.push([Math.min(m.ax, m.bx) - 200, Math.max(m.ax, m.bx) + m.w + 200]);
    out.push([lv.beacon.x - 260, lv.width]);
    return out;
  }

  function generateRocks(lv, seed) {
    const cfg = TUNING.rocks;
    const rng = mulberry32(seed);
    const keepouts = rockKeepouts(lv);
    const placed = [];
    const spare = [];
    let candidates = 0;

    const fits = (rock, x, zone) =>
      x >= zone[0] && x + rock.w <= zone[1] &&
      keepouts.every(([a, b]) => x + rock.w <= a || x >= b) &&
      placed.every((o) => x >= o.x + o.w + cfg.minGap || x + rock.w <= o.x - cfg.minGap);
    const tryPlace = (rock, zone) => {
      for (const shift of [0, 40, -40, 80, -80, 120, -120, 160, -160, 200, -200]) {
        if (fits(rock, rock.x + shift, zone)) {
          rock.x += shift;
          placed.push(rock);
          return true;
        }
      }
      return false;
    };

    for (const zone of lv.rockZones) {
      const span = zone[1] - zone[0];
      const n = Math.max(1, Math.floor(span / cfg.spacing));
      for (let i = 0; i < n; i++) {
        candidates += 1;
        const centre = zone[0] + (span * (i + 0.5)) / n + (rng() - 0.5) * (span / n) * 0.5;
        const chosen = rng() < TUNING.levels[lv.index].rockChance;
        const rock = makeRock(rng, centre);
        if (!chosen || !tryPlace(rock, zone)) spare.push({ rock, zone });
      }
    }
    // keep rocks a regular sight: at least 45% of the candidate count
    const min = Math.ceil(candidates * 0.45);
    while (placed.length < min && spare.length) {
      const { rock, zone } = spare.splice(Math.floor(rng() * spare.length), 1)[0];
      tryPlace(rock, zone);
    }
    placed.sort((a, b) => a.x - b.x);
    for (const rock of placed) rock.rects = rockHitRects(rock);
    return { rocks: placed, candidates };
  }

  // ------------------------------------------------------------------ build
  function buildLevel(index, seed) {
    const def = LEVEL_DEFS[index];
    const lv = {
      index,
      seed: seed >>> 0,
      name: def.name,
      sparksRequired: def.sparksRequired,
      sky: def.sky,
      tuning: TUNING.levels[index],
      width: 0,
      pits: [], platforms: [], movers: [], sparks: [], embers: [], enemies: [],
      hearts: [], shields: [], checkpoints: [], rockZones: [], hints: [], layout: [],
      beacon: null,
      spawn: { x: PLAYER.startX },
    };
    let x = 0;
    for (const [type, params] of def.chunks) {
      const info = CHUNKS[type](lv, x, params);
      lv.layout.push(Object.assign({ type, x, w: info.len }, info, { len: undefined }));
      if (params.hint) lv.hints.push({ x: x + 40, text: params.hint, id: `${index}:${lv.hints.length}` });
      x += info.len;
    }
    lv.width = x;
    lv.pits.sort((a, b) => a.x - b.x);

    // ground: everything except the pits
    lv.ground = [];
    let cursor = 0;
    for (const pit of lv.pits) {
      lv.ground.push({ x: cursor, y: GROUND_Y, w: pit.x - cursor, h: VIEW_H - GROUND_Y + 200, ground: true });
      cursor = pit.x + pit.w;
    }
    lv.ground.push({ x: cursor, y: GROUND_Y, w: lv.width - cursor, h: VIEW_H - GROUND_Y + 200, ground: true });

    for (const e of lv.enemies) {
      e.w = TUNING.enemy.w;
      e.h = TUNING.enemy.h;
      e.speed = lv.tuning.enemySpeed;
    }

    const generated = generateRocks(lv, seed);
    lv.rocks = generated.rocks;
    lv.rockCandidates = generated.candidates;
    // an ember arc over every rock hints at the jump
    for (const rock of lv.rocks) emberArc(lv, rock.x + rock.w / 2 - 55, rock.x + rock.w / 2 + 55, rock.h + 34, 26, 3);

    if (lv.sparks.length !== def.sparksRequired) {
      throw new Error(`${def.name}: ${lv.sparks.length} sparks placed, ${def.sparksRequired} required`);
    }
    return lv;
  }

  const api = {
    GROUND_Y, VIEW_W, VIEW_H, PLAYER, PHYS, TIER, PLAT_H, TUNING,
    LEVEL_COUNT: LEVEL_DEFS.length,
    LEVEL_NAMES: LEVEL_DEFS.map((d) => d.name),
    mulberry32, levelSeed, createMeteorScheduler, buildLevel, rockHitRects, rockKeepouts,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ClawdLevels = api;
})(typeof window !== 'undefined' ? window : globalThis);
