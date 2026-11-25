import assert from 'node:assert/strict';
import test from 'node:test';
import { verticalScale } from './sequence-curves.js';

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
