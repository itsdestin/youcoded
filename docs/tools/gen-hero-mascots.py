"""Generate the hero's four rigged mascot buttons for youcoded/docs/index.html.

Run from the repo root:  python3 docs/tools/gen-hero-mascots.py
Paste its output over the two <div class="mrow"> blocks in docs/index.html.

NOT a build step -- index.html is hand-edited and is the live page. This exists so
that when a theme's mascot changes, or the picker's four themes change, the markup
can be regenerated instead of four 7 KB SVG blocks being edited by hand.

WHERE THE ART COMES FROM. Each button wears its theme's OWN mascot, vendored into
docs/mascots/<slug>.rig.svg from wecoded-themes/themes/<slug>/assets/mascot-rig.svg
-- the rigs rebuilt to the rig contract in wecoded-themes/mascots/README.md
(f52cc85, 130afab). They are complete characters with hardcoded identity colours
and six authored faces, so nothing here tints them.

A theme with no mascot of its own falls back to the app's built-in default buddy
(desktop/src/renderer/components/mascot/default-buddy-rig.ts), which IS tinted --
and its face socket is deliberately a DARK theme colour, never the theme's
on-accent. Passing on-accent gave white-on-purple eyes and a white mouth, and
Destin's word for the result was "terrifying" (2026-09-04). The rig library says
the same thing in prose: "paint eyes on top in a DARK socket colour".
"""
import os
import re
import sys

DEFAULT_RIG_TS = 'desktop/src/renderer/components/mascot/default-buddy-rig.ts'
THEME_RIG = 'docs/mascots/%s.rig.svg'

# slug, display name, accent, WARM (does this rig take the promo film's warm face
# set?), LONG IDLE, and the minor poses it cycles.
#
# Which rigs get the warm faces is the film's own list, not a guess:
# Host.tsx DEFAULT_RIG_SLUGS -- everything on the default rig, plus Golden
# Sunbreak, "which shares its face geometry". Halftone keeps its visor and the
# two cats keep their cat faces; those ARE their characters.
#
# Two layers on purpose (Destin 2026-09-04: "a different default long pose with
# 1-2 other minor poses they cycle through"). The long idle never stops and is
# what gives each one a resting personality; the minor poses interrupt it every
# few seconds, in rotation rather than at random so both actually get seen.
#
# 2026-09-10: WARM is False on every row now. WHY: the theme rigs carry the warm set
# themselves (wecoded-themes 817e6b6), and Cotton Candy Sky and Meadow Mist ship their
# own rigs (3e87b17) instead of borrowing the tinted default — so overwriting a rig's
# faces here would paint this script's older copies over the characters' current ones.
# Refresh docs/mascots/<slug>.rig.svg from the registry before running.
PICKER = [
    ('cotton-candy-sky',   'Cotton Candy Sky',   '#8B47B8', False, 'float',   'wave cheer'),
    ('meadow-mist',        'Meadow Mist',        '#2F7D55', False, 'breathe', 'shrug nod'),
    ('halftone-dimension', 'Halftone Dimension', '#E51F48', False, 'scan',    'think startle'),
    ('golden-sunbreak',    'Golden Sunbreak',    '#ffc030', False, 'bob',     'tada armwave'),
]

# Dropped: the mittens that grip a screen edge (there is no screen edge in a
# 62px chip) and the dizzy face (nothing here spins).
#
# NOT DROPPED, and this was a real mistake on the first pass: slot-hat and
# slot-eyewear. They read like empty scaffolding, but the rig library puts each
# theme's SIGNATURE in them -- "the dimensional visor is eyewear, Kuromi's
# jester hat and Strawberry Kitty's ears-and-bow are hats" (wecoded-themes/
# mascots/README.md -> Component slots). Stripping them turned Halftone's bot
# into a featureless dark blob and left both cats bald. An empty slot costs 20
# bytes; an emptied one costs the character.
# `shutdown` joined every theme rig on 2026-09-05 (wecoded-themes 817e6b6); the picker never
# powers a mascot down, so it goes too rather than shipping ~1 KB per button of a hidden face.
# `slot-item` is what a mascot holds (Cotton Candy Sky's star wand). Destin, 2026-09-11: "remove wand
# from purple's hand" — at 45px a held item reads as a stray shape, and the picker's other three hold
# nothing. The in-app mascot keeps it; only these buttons drop it.
DROP_GROUPS = ['rig-hand-peek-right', 'rig-hand-peek-left', 'rig-face-dizzy', 'rig-face-shutdown', 'slot-item']

PARTS = ['rig-root', 'rig-arm-left', 'rig-arm-right', 'rig-leg-left',
         'rig-leg-right', 'rig-body', 'rig-tail']
FACES = ['idle', 'welcome', 'curious', 'shocked', 'blink', 'happy']


# --- WARM FACES ------------------------------------------------------------
# Ported verbatim from the promo film's face set:
#   worktrees/promo (feat/promo-video) scripts/promo/src/host/faces.ts -> WARM
# written 2026-09-04 after Destin: "some of the eyes models for the different
# poses (like surprised) look SCARY".
#
# THE RULE THE SET IS BUILT ON: every expression keeps the welcome face's eyes --
# the big dark ellipses with three sparkle highlights -- and the expression is
# carried by BROWS, LIDS and the MOUTH. Nothing is ever a hollow black disc. The
# classic shocked face was two 2.1-radius holes with a single glint, which is
# exactly the thing that read as scary; the classic curious face had one eye
# bigger than the other.
#
# Ink and highlights use the rig's own variables, so one set works on every tint.
INK = 'var(--rig-on-accent, #2a1004)'
HI, HI2, HI3 = ('var(--rig-accent, #ffc030)', 'var(--rig-accent, #ffe090)',
                'var(--rig-accent, #ffd060)')


def warm_eye(cx, cy, sx=1.0, lid=0.0):
    """The welcome eye: a dark ellipse and its three sparkles (in a .pupil group,
    which is what the film's `look` action slides). `lid` 0..1 closes it from
    the top."""
    rx, ry = 1.6 * sx, 2.2 * sx
    top = cy - ry + 2 * ry * lid
    cid = 'lid-%s-%s-%s' % (cx, cy, lid)
    return (
        '<clipPath id="%s"><rect x="%.3f" y="%.3f" width="%.3f" height="%.3f"/></clipPath>'
        '<g clip-path="url(#%s)"><ellipse cx="%s" cy="%s" rx="%.3f" ry="%.3f" fill="%s"/>'
        '<g class="pupil">'
        '<circle cx="%.3f" cy="%.3f" r="%.3f" fill="%s"/>'
        '<circle cx="%.3f" cy="%.3f" r="%.3f" fill="%s" fill-opacity="0.8"/>'
        '<circle cx="%.3f" cy="%.3f" r="%.3f" fill="%s" fill-opacity="0.65"/>'
        '</g></g>'
    ) % (cid, cx - rx - 0.2, top, rx * 2 + 0.4, ry * 2 + 0.4,
         cid, cx, cy, rx, ry, INK,
         cx + 0.7 * sx, cy + 0.7 * sx, 0.3 * sx, HI,
         cx + 0.05 * sx, cy + 1.3 * sx, 0.2 * sx, HI2,
         cx + 1.0 * sx, cy + 1.3 * sx, 0.14 * sx, HI3)


def warm_brow(cx, y, tilt=0.0):
    return ('<path d="M%.3f %.3f Q%s %.3f %.3f %.3f" fill="none" stroke="%s" '
            'stroke-width="0.5" stroke-linecap="round"/>'
            ) % (cx - 1.35, y + tilt, cx, y - 0.6, cx + 1.35, y - tilt, INK)


SMILE = ('<g transform="rotate(-2 12 13.3)"><path d="M10.8 13.3 Q10.8 13 12 13 '
         'Q13.2 13 13.2 13.3 A1.1 1 0 0 1 10.8 13.3 Z" fill="%s"/></g>') % INK

# The five the rig contract names, plus `happy` for the poses that deserve it.
WARM_FACES = {
    'welcome': warm_eye(9.3, 9.55) + warm_eye(14.7, 9.25) + SMILE,
    # curious: the SAME two eyes, one brow up, a small off-centre mouth.
    'curious': (warm_eye(9.3, 9.55) + warm_eye(14.7, 9.25)
                + '<path d="M8 7.1 L10.6 6.9" fill="none" stroke="%s" stroke-width="0.5" stroke-linecap="round"/>' % INK
                + warm_brow(14.7, 6.3, 0.3)
                + '<ellipse cx="12.05" cy="13.35" rx="0.45" ry="0.5" fill="%s"/>' % INK),
    # surprised: the same eyes a touch bigger with their sparkles, both brows up,
    # a small round mouth. THIS is the face that replaces the scary one.
    'shocked': (warm_eye(9.3, 9.7, 1.12) + warm_eye(14.7, 9.4, 1.12)
                + warm_brow(9.3, 6.5) + warm_brow(14.7, 6.2)
                + '<ellipse cx="12" cy="13.6" rx="0.7" ry="0.85" fill="%s"/>' % INK),
    'blink': ('<path d="M8 10 Q9.3 10.5 10.6 10" fill="none" stroke="%s" stroke-width="0.85" stroke-linecap="round"/>'
              '<path d="M13.4 9.8 Q14.7 10.3 16 9.8" fill="none" stroke="%s" stroke-width="0.85" stroke-linecap="round"/>%s'
              ) % (INK, INK, SMILE),
    # happy: eyes closed in two upward arcs, the smile wide open.
    'happy': ('<path d="M8 10.4 Q9.3 8.6 10.6 10.4" fill="none" stroke="%s" stroke-width="0.9" stroke-linecap="round"/>'
              '<path d="M13.4 10.1 Q14.7 8.3 16 10.1" fill="none" stroke="%s" stroke-width="0.9" stroke-linecap="round"/>'
              '<path d="M10.3 13 Q10.3 12.7 12 12.7 Q13.7 12.7 13.7 13 A1.7 1.5 0 0 1 10.3 13 Z" fill="%s"/>'
              ) % (INK, INK, INK),
    # idle stays the rig's own (the chevron/closed eyes); the picker never shows it.
}


def ink_for(accent):
    """The ink the default rig draws its eyes and mouth in: a DEEP SHADE OF THE
    BODY COLOUR, never the theme's on-accent. On Cotton Candy, Meadow Mist and
    Halftone the on-accent is WHITE, and white eyes on a coloured body read as
    glowing and soulless (Destin, 2026-09-04). Ported from themes.ts -> inkFor;
    k = 0.32 is his number, 0.22 read a smidge too dark."""
    h = accent.lstrip('#')
    k = 0.32
    return '#' + ''.join('%02x' % round(int(h[i:i + 2], 16) * k) for i in (0, 2, 4))


def inner_svg(svg: str) -> str:
    """Everything between <svg …> and </svg>."""
    return svg[svg.index('>', svg.index('<svg')) + 1: svg.rindex('</svg>')]


def load_rig(slug: str) -> str:
    try:
        return inner_svg(open(THEME_RIG % slug, encoding='utf-8').read())
    except FileNotFoundError:
        src = open(DEFAULT_RIG_TS, encoding='utf-8').read()
        m = re.search(r'DEFAULT_BUDDY_RIG = `([\s\S]*?)`;', src)
        if not m:
            sys.exit('could not find DEFAULT_BUDDY_RIG in ' + DEFAULT_RIG_TS)
        return inner_svg(m.group(1))


def drop_group(svg: str, gid: str) -> str:
    """Remove <g id="gid" …>…</g>, or its self-closing form, balancing nesting."""
    self_closing = re.search(r'<g id="%s"\s*/>' % re.escape(gid), svg)
    if self_closing:
        return svg[:self_closing.start()] + svg[self_closing.end():]
    open_m = re.search(r'<g id="%s"[^>]*>' % re.escape(gid), svg)
    if not open_m:
        return svg
    depth, i = 1, open_m.end()
    while depth:
        nxt = re.search(r'<g\b|</g>', svg[i:])
        if not nxt:
            sys.exit('unbalanced <g> hunting ' + gid)
        i += nxt.end()
        depth += 1 if nxt.group() == '<g' else -1
    return svg[:open_m.start()] + svg[i:]


def button(slug, name, accent, warm, idle, acts) -> str:
    body = load_rig(slug)
    for gid in DROP_GROUPS:
        body = drop_group(body, gid)
        assert 'id="%s"' % gid not in body, (slug, gid)

    if warm:
        # Replace each face group's INNER markup, walking to the BALANCED close
        # tag: a face group can hold nested <g> (the smile, the pupil clusters),
        # so stopping at the first </g> would cut it in half.
        for face, markup in WARM_FACES.items():
            m = re.search(r'<g id="rig-face-%s"[^>]*>' % face, body)
            if not m:
                # The set adds faces the rig has not got (happy): give it a group.
                body = re.sub(r'(<g id="rig-face-blink")',
                              '<g id="rig-face-%s">%s</g>\\n\\1' % (face, markup), body, count=1)
                continue
            depth, i = 1, m.end()
            while depth:
                nxt = re.search(r'<g\\b|</g>', body[i:])
                i += nxt.end()
                depth += 1 if nxt.group() == '<g' else -1
            body = body[:m.end()] + markup + body[i - len('</g>'):]

    # Rig hooks become CLASSES. The driver and the stylesheet address parts by
    # class precisely because four rigs are inlined into one document and four
    # elements called rig-arm-left would be a trap.
    for part in PARTS:
        body = body.replace('<g id="%s"' % part, '<g class="%s"' % part)
    for face in FACES:
        # The inline display:none goes with it -- an inline style outranks the
        # stylesheet, and the stylesheet is what switches faces.
        body = re.sub(r'<g id="rig-face-%s"[^>]*>' % face,
                      '<g class="rig-face rig-face-%s">' % face, body)
    assert 'id="rig-' not in body, slug

    # Every id that SURVIVES is a gradient/filter/clip the art references. Suffix
    # them per button: four inlined rigs otherwise share whichever "gs-hi" the
    # document happens to define first, and one theme's lighting silently paints
    # another's body.
    for rid in sorted(set(re.findall(r'id="([^"]+)"', body)), key=len, reverse=True):
        body = body.replace('id="%s"' % rid, 'id="%s-%s"' % (rid, slug))
        body = body.replace('url(#%s)' % rid, 'url(#%s-%s)' % (rid, slug))
        body = body.replace('href="#%s"' % rid, 'href="#%s-%s"' % (rid, slug))
    assert 'url(#' not in body or all(
        ref.endswith('-' + slug) for ref in re.findall(r'url\(#([^)]+)\)', body)), slug

    body = re.sub(r'\n\s+', '\n', body).strip()

    # A SECOND transform layer, wrapping rig-root. The long idle rides here and
    # the one-shot poses ride on rig-root, so an arm-wave can play THROUGH a
    # breathing idle instead of replacing it -- one CSS animation per element is
    # the whole reason this group exists. <defs> stays outside it: a transform on
    # a gradient definition is meaningless and would only invite confusion.
    defs_end = body.rindex('</defs>') + len('</defs>') if '</defs>' in body else 0
    body = body[:defs_end] + '\n<g class="rig-idle">' + body[defs_end:] + '</g>'

    # Only a tinted rig needs the ink told to it. A theme rig paints its own
    # face in its own identity colour and must not be overridden.
    tinted = not os.path.exists(THEME_RIG % slug)
    style = '--a:%s' % accent + (';--rig-on-accent:%s' % ink_for(accent) if tinted else '')
    return (
        '<button class="mascot" data-theme="%s" data-idle="%s" data-acts="%s" data-face="welcome"\n'
        '  aria-label="Use the %s look" style="%s"><span class="m-chip"></span>\n'
        '<svg class="m-art m-rig" viewBox="-3 -5 30 30" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">\n'
        '%s\n</svg><span class="m-name">%s</span></button>'
    ) % (slug, idle, acts, name, style, body, name)


def main():
    out = [button(*row) for row in PICKER]
    print('<!--LEFT-->\n' + '\n'.join(out[:2]))
    print('<!--RIGHT-->\n' + '\n'.join(out[2:]))


main()
