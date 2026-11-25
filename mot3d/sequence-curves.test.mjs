import assert from 'node:assert/strict';
import test from 'node:test';
import { retentionScale, verticalScale } from './sequence-curves.js';

test('原子数跨数量级时展开低值，零点和刻度仍对应原子数', () => {
  // 7062.977 ms 游标读数与用户提供的纵轴上限。
  const atoms = 1_025_019, peak = 4e7;
  const values = [0, peak, atoms];
  const automatic = verticalScale('atoms', values, 'auto');
  const linear = verticalScale('atoms', values, 'linear');
  assert.equal(linear.fraction(atoms), atoms / peak);
  assert.ok(Math.abs(automatic.fraction(atoms) - Math.log10(1 + atoms) / Math.log10(1 + peak)) < 1e-12);
  assert.equal(automatic.fraction(0), 0);
  assert.equal(automatic.fraction(peak), 1);
  assert.equal(automatic.ticks[0], 0);
  assert.equal(automatic.ticks.at(-1), peak);
  assert.ok(automatic.ticks.every((n,i) => i === 0 || n > automatic.ticks[i-1]));
});

test('空阱有零刻度，窄范围的自动原子数轴使用线性刻度', () => {
  for (const mode of ['auto','linear','log']) {
    const empty = verticalScale('atoms', [0], mode);
    assert.deepEqual(empty.ticks, [0]);
    assert.equal(empty.fraction(0), 0);
  }
  const narrow = verticalScale('atoms', [1e6,2e6], 'auto');
  assert.equal(narrow.fraction(1e6), .5);
});

test('关源衰减的百分比按关源值归一，低于 1/e 和随后回升的值同样遵循线性刻度', () => {
  const loaded = 1e8;
  for (const peak of [loaded, 1.4*loaded]) {
    const scale = retentionScale([peak, loaded/Math.E, .02*loaded, 0], loaded);
    assert.equal(scale.fraction(0), 0);
    assert.equal(scale.fraction(peak), 1);
    assert.equal(scale.tickLabel(loaded), '100%');
    assert.equal(scale.tickLabel(loaded/Math.E), '36.8%');
    assert.ok(Math.abs(scale.fraction(.02*loaded)/scale.fraction(loaded)-.02) < 1e-14);
    assert.ok(scale.ticks.includes(loaded/Math.E));
  }
});
