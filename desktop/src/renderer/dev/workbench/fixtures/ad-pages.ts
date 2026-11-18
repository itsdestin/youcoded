// Practice pages for the "you coded that." campaign films (2026-11-18). Workbench only.
//
// WHY this file: the site scenario pins just Home and Finance, and the workbench's own trip board is
// a four-row sample wearing a "refresh failed" band (it exists to show that error state). The
// campaign needs a trip page that looks like something a person would be proud to have asked for,
// and the paint studio pinned beside it. Reached with `?adPages=paint,trip` (mock-shim.ts), which
// replaces the site scenario's page list for that take only; every other scenario is untouched.
// Practice data only: fictional people and places-as-tourists, no bookings that mean anything.
import type { PageDocument } from '../../../../shared/pages-types';
import { seedPages } from './pages';

const TRIP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Lisbon with Ana</title>
<style>
  .tiles { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 12px; }
  .tile b { display:block; font-size: 26px; font-weight: 600; line-height: 1.1; margin-top: 4px; }
  .day { display:flex; align-items:center; gap:14px; padding: 12px 4px; border-top: 1px solid var(--edge-dim); }
  .day:first-child { border-top: 0; }
  .day .when { width: 64px; flex: none; }
  .day .when b { display:block; font-size: 15px; font-weight: 600; }
  .day .what { flex: 1; min-width: 0; }
  .day .what b { display:block; font-weight: 500; }
  .two { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 720px) { .tiles { grid-template-columns: 1fr 1fr 1fr; } .two { grid-template-columns: 1fr; } }
</style></head>
<body>
<div class="yc-page yc-stack">
  <div class="yc-row yc-row--between">
    <div><div class="yc-eyebrow">Lisbon · 3–9 October</div><h1>Lisbon with Ana</h1></div>
    <span class="yc-status yc-status--ok yc-status--dot">All set</span>
  </div>
  <div class="tiles">
    <div class="yc-card tile"><span class="yc-eyebrow">Days</span><b>7</b><span class="yc-muted yc-small">in the city</span></div>
    <div class="yc-card tile"><span class="yc-eyebrow">Booked</span><b id="bk">4 of 7</b><span class="yc-muted yc-small">tap a day to book</span></div>
    <div class="yc-card tile"><span class="yc-eyebrow">Forecast</span><b>23°</b><span class="yc-muted yc-small">mostly sun</span></div>
  </div>
  <div class="two">
    <div class="yc-card yc-stack" style="gap:8px"><span class="yc-title">Flights</span>
      <div class="yc-list">
        <div class="yc-list-row yc-row yc-row--between"><span>Fri 3 · Arrive</span><span class="yc-muted">14:10</span></div>
        <div class="yc-list-row yc-row yc-row--between"><span>Thu 9 · Home</span><span class="yc-muted">11:25</span></div>
      </div></div>
    <div class="yc-card yc-stack" style="gap:8px"><span class="yc-title">Where you're staying</span>
      <div class="yc-list">
        <div class="yc-list-row yc-row yc-row--between"><span>Alfama apartment</span><span class="yc-muted">6 nights</span></div>
        <div class="yc-list-row yc-row yc-row--between"><span>Two beds, by the tram</span><span class="yc-muted">sleeps 2</span></div>
      </div></div>
  </div>
  <div class="yc-card yc-stack" style="gap:4px">
    <div class="yc-row yc-row--between"><span class="yc-title">Day by day</span><span class="yc-muted yc-small">booked days are ticked</span></div>
    <div id="days"></div>
  </div>
</div>
<script>
  var D = [
    ['Fri 3','Arrive and wander','Alfama at golden hour, dinner near the apartment',1],
    ['Sat 4','Old town and the river','Castelo views, a custard tart in every shop',1],
    ['Sun 5','Museum morning','Gulbenkian before the showers, long lunch',1],
    ['Mon 6','Day trip to Sintra','Train at 09:41, palace and gardens',1],
    ['Tue 7','Belém','Pastries, the tower, a ride along the water',0],
    ['Wed 8','Ana\\'s pick','Whatever she has been saving up',0],
    ['Thu 9','Last coffee','One more walk, then the airport',0]
  ];
  function count(){ var n = document.querySelectorAll('#days .yc-switch[aria-checked="true"]').length; document.getElementById('bk').textContent = n + ' of 7'; }
  document.getElementById('days').innerHTML = D.map(function(d,i){
    return '<div class="day"><div class="when"><b>'+d[0].split(' ')[0]+'</b><span class="yc-muted yc-small">'+d[0].split(' ')[1]+' Oct</span></div>' +
      '<div class="what"><b>'+d[1]+'</b><span class="yc-muted yc-small">'+d[2]+'</span></div>' +
      '<button class="yc-switch" role="switch" aria-checked="'+(d[3]?'true':'false')+'" aria-label="Book '+d[0]+'" data-day="'+i+'"></button></div>';
  }).join('');
  document.getElementById('days').addEventListener('click', function(){ setTimeout(count, 30); });
</script>
</body></html>`;

/** The pages an `?adPages=` take pins, in the order asked. `paint` opens blank (data.ops empty)
 *  so a person's strokes are the whole picture; the studio's own sample scene would hide them. */
export function adPages(which: string[]): PageDocument[] {
  const seed = seedPages();
  const paint = seed.find((p) => p.id === 'page-paint')!;
  const trip: PageDocument = {
    id: 'page-trip-lisbon', name: 'Lisbon with Ana', icon: 'calendar', home: { kind: 'personal' }, pinned: true,
    description: 'Seven days in Lisbon: flights, the apartment, and what is planned each day.',
    updatedAt: '2026-10-02T09:00:00.000Z', htmlStamp: 1790000000000, html: TRIP_HTML, data: null,
  };
  const out: Record<string, PageDocument> = {
    paint: { ...paint, name: 'Paint studio', pinned: true, data: { ops: [] } },
    trip,
  };
  return which.map((k) => out[k]).filter(Boolean);
}
