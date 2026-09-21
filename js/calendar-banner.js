// calendar-banner.js — pure projection of a Home Assistant calendar entity.
// HA calendar entities are `on` while an event is active and expose the
// current event title as attributes.message.

export function calendarBannerMode(text){
  return String(text || '').trim().length <= 40 ? 'static' : 'scroll';
}

export function calendarBannerView(entity){
  if (!entity || entity.state !== 'on') return null;
  const attrs = entity.attributes && typeof entity.attributes === 'object' ? entity.attributes : {};
  const text = typeof attrs.message === 'string' ? attrs.message.trim() : '';
  if (!text) return null;
  return {
    text,
    mode: calendarBannerMode(text),
    location: typeof attrs.location === 'string' ? attrs.location.trim() : '',
    start: typeof attrs.start_time === 'string' ? attrs.start_time : '',
    end: typeof attrs.end_time === 'string' ? attrs.end_time : '',
    key: [attrs.start_time || '', attrs.end_time || '', text].join('|'),
  };
}
