// The Home page's top tabs and its settings page, kept apart from home-assistant-page.ts so that file stays under its line
// budget (U7-U18 of the second UX review added code to it). HOME_TABS_JS is pasted INSIDE the page's script, after everything
// it uses (pref, chipData, esc, ...), and before start() runs. Template string: no backticks, no dollar-brace, no backslashes.

export const HOME_TABS_JS = `
  function chipShort(c) {
    var x = c.x || {};
    if (c.id === 'lights') return c.on ? x.big + ' on' : 'Lights off';
    if (c.id === 'media') return x.playing ? (c.main) : c.on ? c.main : 'Quiet';
    // WHY the words (U16, UX review 2): "77° · 74° in" read as a puzzle. Outside says "out", inside says "in"; with no weather the one number is the inside.
    if (c.id === 'climate') return x.unit === 'outside' ? x.big + ' out' + (x.inside != null ? ' · ' + x.inside + '° in' : '') : x.big === '—' ? x.big : x.big + ' in';
    if (c.id === 'activity') return 'Activity';
    if (c.id === 'cameras') return c.main;
    return c.x.sevs.high + c.x.sevs.mid + c.x.sevs.low ? c.main : 'All good';
  }
  // ── The gear's settings (round 4, Q-settings: a gear next to Edit).
  var PREF_ROWS = [
    ['chip-lights', 'Lights tab'], ['chip-media', 'Media tab'], ['chip-climate', 'Climate tab'], ['chip-cameras', 'Cameras tab'], ['chip-problems', 'Problems tab'],
    ['scenes', 'Light scenes in each room'], ['favourites', 'Favorites row'], ['cameras', 'Camera pictures'],
  ];
  // Settings are a page of their own (round 4 settings note: "should
  // probably be a full page menu"), grouped into sections.
  var PREF_SECTIONS = [
    { title: 'At a glance', note: 'The tabs across the top of the page.', rows: PREF_ROWS.slice(0, 5) },
    { title: 'In each room', note: 'What each room card shows.', rows: PREF_ROWS.slice(5) },
  ];
  function settingsPageHtml() {
    return '<div class="set-grid">' + PREF_SECTIONS.map(function (sec) {
      return '<section class="yc-card set-sec"><h3>' + sec.title + '</h3><p class="yc-caption">' + sec.note + '</p>' +
        sec.rows.map(function (r) {
          var on = pref(r[0]);
          return '<label class="set-row"><span>' + r[1] + '</span><button class="tog" role="switch" aria-checked="' + on + '" data-pref="' + r[0] + '"><span></span></button></label>';
        }).join('') + '</section>';
    }).join('') + '</div>';
  }
`;
