// calendar-banner.js — pure projection of a Home Assistant calendar entity.
// HA calendar entities are `on` while an event is active and expose the
// current event title as attributes.message.

export function calendarBannerMode(text){
  return String(text || '').trim().length <= 40 ? 'static' : 'scroll';
}

// Static headlines longer than this wrap to two lines on shallow landscape
// displays, where the corner clocks leave little vertical room. CSS shrinks the
// type for these so the copy stays clear of both clocks.
export const LONG_HEADLINE_CHARS = 24;

export function calendarBannerLong(text){
  return String(text || '').trim().length > LONG_HEADLINE_CHARS;
}

export function calendarBannerView(entity){
  if (!entity || entity.state !== 'on') return null;
  const attrs = entity.attributes && typeof entity.attributes === 'object' ? entity.attributes : {};
  const text = typeof attrs.message === 'string' ? attrs.message.trim() : '';
  if (!text) return null;
  return {
    text,
    mode: calendarBannerMode(text),
    long: calendarBannerLong(text),
    location: typeof attrs.location === 'string' ? attrs.location.trim() : '',
    start: typeof attrs.start_time === 'string' ? attrs.start_time : '',
    end: typeof attrs.end_time === 'string' ? attrs.end_time : '',
    key: [attrs.start_time || '', attrs.end_time || '', text].join('|'),
  };
}
