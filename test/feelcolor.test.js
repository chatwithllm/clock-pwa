import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weatherColor } from '../js/feelcolor.js';

const hue = (c) => Number(/hsl\((\d+)/.exec(c.fg)[1]);
const sat = (c) => Number(/hsl\(\d+,\s*(\d+)%/.exec(c.fg)[1]);

test('null temp returns the neutral palette', () => {
  const p = weatherColor(null, 50);
  assert.equal(p.fg, '#e6e6e6');
});

test('hot has a warmer (lower) hue than cold', () => {
  assert.ok(hue(weatherColor(35, 40)) < hue(weatherColor(-10, 40)));
});

test('freezing clamps to an icy blue hue (~200)', () => {
  const h = hue(weatherColor(-20, 40));
  assert.ok(h >= 195 && h <= 215, `hue was ${h}`);
});

test('high humidity desaturates vs dry air at the same temp', () => {
  assert.ok(sat(weatherColor(25, 85)) < sat(weatherColor(25, 25)));
});

test('always returns all five palette keys as truthy strings', () => {
  const p = weatherColor(20, 50);
  for (const k of ['fg', 'dim', 'accent', 'hand', 'hsec']) assert.ok(p[k], `missing ${k}`);
});
