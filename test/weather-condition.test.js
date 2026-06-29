import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveCondition, normalizeForecast } from '../js/weather.js';

test('thunderstorm dry (0mm, 0%) -> Storms possible, calm', () => {
  const e = effectiveCondition(95, 0, 0);
  assert.equal(e.dry, true);
  assert.equal(e.label, 'Storms possible');
  assert.equal(e.icon, '⛅');
  assert.equal(e.code, 2);
});

test('thunderstorm actually raining (2mm) -> raw', () => {
  const e = effectiveCondition(95, 2, 0);
  assert.equal(e.dry, false);
  assert.equal(e.label, 'Thunderstorm');
});

test('thunderstorm brewing (0mm but 60% chance) -> raw', () => {
  const e = effectiveCondition(95, 0, 60);
  assert.equal(e.dry, false);
});

test('rain dry (0mm, 10%) -> Rain possible', () => {
  const e = effectiveCondition(63, 0, 10);
  assert.equal(e.dry, true);
  assert.equal(e.label, 'Rain possible');
});

test('clear (not a precip code) -> raw, never dry', () => {
  const e = effectiveCondition(0, 0, 0);
  assert.equal(e.dry, false);
  assert.equal(e.label, 'Clear sky');
});

test('missing precip data -> raw (fail safe)', () => {
  assert.equal(effectiveCondition(95, undefined, 0).dry, false);
  assert.equal(effectiveCondition(95, null, 0).dry, false);
  assert.equal(effectiveCondition(95, 0, null).dry, false);
  assert.equal(effectiveCondition(95, 0, undefined).dry, false);
});

test('normalizeForecast surfaces precip + current-hour precipProb', () => {
  const j = {
    current: { temperature_2m: 31, weather_code: 95, precipitation: 0, time: '2026-06-29T13:30' },
    daily: {},
    hourly: { precipitation_probability: Array.from({length:24}, (_,i)=>i) }, // [0..23]
  };
  const out = normalizeForecast(j, {});
  assert.equal(out.precip, 0);
  assert.equal(out.precipProb, 13);   // hour 13
});

test('normalizeForecast tolerates absent hourly', () => {
  const out = normalizeForecast({ current: { temperature_2m: 20 }, daily: {} }, {});
  assert.equal(out.precipProb, null);
});
