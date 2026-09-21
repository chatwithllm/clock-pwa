import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarBannerMode, calendarBannerView } from '../js/calendar-banner.js';

test('active calendar event exposes its message', () => {
  const out = calendarBannerView({
    state: 'on',
    attributes: { message: 'Kids pickup at 2:30', location: 'South entrance' },
  });
  assert.deepEqual(out, {
    text: 'Kids pickup at 2:30', mode: 'static', location: 'South entrance', start: '', end: '',
    key: '||Kids pickup at 2:30',
  });
});

test('short events stay static; long events scroll', () => {
  assert.equal(calendarBannerMode('Pickup at 2:30 PM'), 'static');
  assert.equal(calendarBannerMode('Drop off at the south entrance'), 'static');
  assert.equal(calendarBannerMode('This is an important Matrix calendar message that cannot fit comfortably'), 'scroll');
});

test('inactive or unavailable calendar does not replace the clock', () => {
  assert.equal(calendarBannerView({ state:'off', attributes:{ message:'Later' } }), null);
  assert.equal(calendarBannerView({ state:'unavailable', attributes:{ message:'Later' } }), null);
  assert.equal(calendarBannerView(null), null);
});

test('active calendar without a title does not replace the clock', () => {
  assert.equal(calendarBannerView({ state:'on', attributes:{} }), null);
  assert.equal(calendarBannerView({ state:'on', attributes:{ message:'   ' } }), null);
});
