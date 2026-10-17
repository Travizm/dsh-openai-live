#!/usr/bin/env python3
"""Emit a Lean containment gate over renderer-extracted bounding boxes.

The text-overlap gate proves text-vs-text. The defect this exists for is text ESCAPING its container,
which that predicate cannot express — so the theorem here is `inside`, and each width of the sweep
becomes its own theorem.

Containment is exact: no ≥2px padding. A control one pixel outside its border is still outside it,
and the pad that the overlap gate needs (to ignore font-padding touches) would here manufacture a pass.

usage: plate-containment-gate.py <dump.json> <theorem-name> <out.lean> [--shift LABEL DX]

TODO — limits of this gate, and what to extend before trusting it for more than it proves:

  * ONE SNAPSHOT, ONE WIDTH. The theorem is a kernel decision over a fixed list of boxes, so a PASS
    says nothing about any other width or any other state of the panel. Width coverage comes from the
    SWEEP (scripts/plate-containment-sweep.mjs over several viewports), never from the proof. Add a width to the
    sweep, or the proof silently becomes the whole claim.
  * CONTAINMENT ONLY — IT IS NOT THE OVERLAP GATE. Text-vs-text overlap is a different predicate
    (`interW ≥ 2 && interH ≥ 2`) and this file does not assert it. A plate could pass here with two
    labels stacked on top of each other and still be inside the border. Run both predicates, or say
    which one is being claimed.
  * IT PROVES THE BOX, NOT THE PIXELS. Everything comes from getBoundingClientRect, so: no glyph
    overflow beyond the reported box (italic overhang, a chevron drawn as a background), no clipping by
    an ancestor's overflow:hidden, no scroll, no occlusion by a sibling stacked above it, nothing about
    legibility, contrast or touch-target size. A box inside the border can still be unreadable.
  * ANCESTOR CLIPPING IS INVISIBLE HERE. If the pane clips the plate, every leaf can be inside the
    plate's own border while the plate itself is outside the visible pane. Extend by extracting the
    ancestor chain's rects and asserting each level contains the one below (`inside` again, applied
    chain-wise) — or assert leaves ⊆ viewport as a cheap second theorem.
  * THE DOCKED STRIP IS NOT COVERED. The plate's layout rules live in the panel face; the audio face's
    own strip still lays out one non-wrapping row, so it overflows in a narrow window exactly as this
    did. Gate it separately if it is ever revived.
  * ONE LEVEL OF ONE PANEL. The plate carries drill-through levels and settings rows that are not the
    collapsed row measured here. They need their own dumps and their own theorems — an unmeasured
    level is an unproven one.
  * THE RUNNER IS NOT IN CI. Extraction needs a live app (or the CLI-served web instance) over CDP,
    which a CI runner does not have. Until a headless harness exists, this gate is a local check that
    must be run by hand — and a gate nobody runs is a comment.
"""
import json
import sys


def lean_rect(name, r):
    return f'  ("{name}", {{ x0 := {r["x0"]}, y0 := {r["y0"]}, x1 := {r["x1"]}, y1 := {r["y1"]} }})'


def main(argv):
    dump, theorem, out = argv[1], argv[2], argv[3]
    shift_label, shift_dx = None, 0
    if '--shift' in argv:
        i = argv.index('--shift')
        shift_label, shift_dx = argv[i + 1], int(argv[i + 2])

    data = json.load(open(dump))
    box = data['box']
    leaves = data['leaves']
    if shift_label:
        for leaf in leaves:
            if leaf['text'].startswith(shift_label) or leaf['cls'] in shift_label:
                leaf['x0'] += shift_dx
                leaf['x1'] += shift_dx

    outside = [l for l in leaves
               if l['x0'] < box['x0'] or l['y0'] < box['y0'] or l['x1'] > box['x1'] or l['y1'] > box['y1']]
    print(f'  pre-flight (same predicate, in Python): {len(outside)} of {len(leaves)} leaves outside the box')
    for l in outside:
        print(f'    {l["text"][:22]:24s} right+{max(0, l["x1"] - box["x1"])}px  left+{max(0, box["x0"] - l["x0"])}px  bottom+{max(0, l["y1"] - box["y1"])}px')

    lines = [
        '/-',
        '  Containment gate for the VOICE plate, generated from the renderer (CDP getBoundingClientRect).',
        '  Every text leaf must lie inside the plate box. Exact — no padding, unlike the overlap gate.',
        f'  Source dump: {dump.split("/")[-1]} · viewport {data["viewport"][0]}px',
        '-/',
        'structure Rect where',
        '  x0 : Int',
        '  y0 : Int',
        '  x1 : Int',
        '  y1 : Int',
        '  deriving Repr, DecidableEq',
        '',
        'def inside (b r : Rect) : Bool :=' ,
        '  r.x0 ≥ b.x0 && r.y0 ≥ b.y0 && r.x1 ≤ b.x1 && r.y1 ≤ b.y1',
        '',
        'def allInside (b : Rect) (rs : List (String × Rect)) : Bool :=',
        '  rs.all (fun p => inside b p.2)',
        '',
        f'def box : Rect := {{ x0 := {box["x0"]}, y0 := {box["y0"]}, x1 := {box["x1"]}, y1 := {box["y1"]} }}',
        '',
        'def leaves : List (String × Rect) := [',
    ]
    for i, l in enumerate(leaves):
        comma = ',' if i < len(leaves) - 1 else ''
        lines.append(lean_rect(f'{l["text"][:18]} [{l["cls"]}]', l) + comma)
    lines += [
        ']',
        '',
        f'theorem {theorem} : allInside box leaves = true := by',
        '  decide',
        '',
        f'#print axioms {theorem}',
        '',
    ]
    open(out, 'w').write('\n'.join(lines))
    print(f'  wrote {out}')
    return 1 if outside else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
