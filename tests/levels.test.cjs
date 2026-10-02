const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../levels.js');

test('all three levels keep objectives and rock safety across 200 seeds', () => {
  const objectives = [8, 10, 12];
  for (let index = 0; index < L.LEVEL_COUNT; index++) {
    for (let seed = 0; seed < 200; seed++) {
      const level = L.buildLevel(index, L.levelSeed(seed, index));
      assert.equal(level.sparks.length, objectives[index]);
      assert.equal(level.checkpoints.length, 2);
      assert.ok(level.beacon.x < level.width);
      for (let i = 0; i < level.rocks.length; i++) {
        const rock = level.rocks[i];
        assert.ok(rock.x >= 0 && rock.x + rock.w <= level.width);
        assert.ok(L.rockKeepouts(level).every(([a, b]) => rock.x + rock.w <= a || rock.x >= b));
        if (i) assert.ok(rock.x - (level.rocks[i - 1].x + level.rocks[i - 1].w) >= L.TUNING.rocks.minGap);
      }
    }
  }
});

test('seeds reproduce layouts, while different seeds vary the rocks', () => {
  const layout = (seed) => L.buildLevel(0, L.levelSeed(seed, 0)).rocks;
  assert.deepEqual(layout(14), layout(14));
  assert.notDeepEqual(layout(14), layout(15));
});
