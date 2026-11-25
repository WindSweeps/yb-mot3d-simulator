import assert from 'node:assert/strict';
import test from 'node:test';
import { linearScale, retentionScale } from './sequence-curves.js';

test('原子数和相空间密度跨越多个数量级时，纵坐标高度与数值成正比', () => {
  for (const values of [[0, 1_025_019, 4e7], [1e-12, 1e-9, 1e-6]]) {
    const peak = Math.max(...values);
    const axis = linearScale(values);
    assert.deepEqual(axis.ticks, [0, peak/2, peak]);
    for (const value of values) assert.equal(axis.fraction(value), value/peak);
    assert.equal(axis.fraction(0), 0);
    assert.equal(axis.fraction(peak/2), .5);
  }
});

test('无可用数据或阱内原子数为零时，纵轴保留零刻度', () => {
  for (const values of [[], [0]]) {
    const empty = linearScale(values);
    assert.deepEqual(empty.ticks, [0]);
    assert.equal(empty.fraction(0), 0);
  }
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
