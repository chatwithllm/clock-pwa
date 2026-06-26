import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeForecast } from '../js/weather.js';

test('normalizeForecast surfaces relative_humidity_2m as rh', () => {
  const j = { current: { temperature_2m: 22, relative_humidity_2m: 64, weather_code: 1 }, daily: {} };
  const out = normalizeForecast(j, { city: 'X' });
  assert.equal(out.rh, 64);
});

test('normalizeForecast tolerates a missing humidity field', () => {
  const out = normalizeForecast({ current: { temperature_2m: 10 }, daily: {} }, {});
  assert.equal(out.rh, undefined);
});
