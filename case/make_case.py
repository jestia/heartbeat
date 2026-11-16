#!/usr/bin/env python3
"""Generates the printable "Pulse" case for the grid-heartbeat device: base + snap-on lid.

    pip install manifold3d numpy
    python make_case.py            # writes pulse-case-base.stl and pulse-case-lid.stl next to this file

All sizes are millimetres. If a part does not fit, change the numbers in the first two blocks
and run it again. Model origin: centre of the case footprint, z = 0 on the underside. The USB-C
opening is on the -X end.
"""

import pathlib
import struct

import numpy as np
from manifold3d import CrossSection, JoinType, Manifold

# --- What goes inside ---------------------------------------------------------------------
PCB_L, PCB_W = 21.0, 17.8   # Seeed XIAO ESP32-C3 outline (USB-C on a short edge)
PCB_T_MAX = 1.6             # thickest board the hold-down ribs allow for
USB_CENTRE_ABOVE_FLOOR = 3.75  # centre of the USB-C socket above the inner floor
ANT_L, ANT_W = 40.0, 20.0   # Seeed FPC antenna A-01 patch (40 x 20 x 0.2, 80 mm cable); lies flat in the antenna bay

# --- Fit and print tuning -----------------------------------------------------------------
FIT = 0.35        # gap around the board
LID_FIT = 0.15    # gap between the lid's lip and the base wall, per side. Raise if the lid is too tight
SNAP = 0.25       # how far the lid's snap bumps bite into the wall. Lower if the lid will not close

# --- Case shape ---------------------------------------------------------------------------
WALL, FLOOR, LID_T = 1.6, 1.2, 1.6
WIDTH = 30.0
HEIGHT = 11.0
CORNER_R = 7.0
CHAMFER_TOP, CHAMFER_BOTTOM = 1.0, 0.8
REST = 0.8                    # the board sits on rails this high
BOARD_GAP = 0.6               # between the board's USB edge and the end wall
BAY_L = ANT_L + 5.0           # antenna bay behind the board
USB_OPENING = (12.6, 7.6)     # wide x tall; big enough for a cable's plastic grip
LIP_H, LIP_T = 3.0, 1.2
SEGMENTS = 72

LENGTH = WALL + BOARD_GAP + PCB_L + 1.2 + BAY_L + WALL
Z_SPLIT = HEIGHT - LID_T                      # where base and lid meet
X0 = -LENGTH / 2                              # outer face of the USB end
BOARD_X0 = X0 + WALL + BOARD_GAP              # board's USB edge
BOARD_X1 = BOARD_X0 + PCB_L
PCB_TOP_MAX = FLOOR + REST + PCB_T_MAX
USB_Z = FLOOR + USB_CENTRE_ABOVE_FLOOR


def rounded_rect(length, width, radius):
    radius = max(radius, 0.05)
    core = CrossSection.square([length - 2 * radius, width - 2 * radius], True)
    return core.offset(radius, JoinType.Round, 2.0, SEGMENTS)


def outline(inset=0.0):
    return rounded_rect(LENGTH - 2 * inset, WIDTH - 2 * inset, CORNER_R - inset)


def prism(section, z0, z1):
    return Manifold.extrude(section, z1 - z0).translate([0, 0, z0])


def box(x0, x1, y0, y1, z0, z1):
    return Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0])


def rod_x(x0, x1, y, z, radius):
    """A round bar lying along X."""
    return Manifold.cylinder(x1 - x0, radius, radius, 24).rotate([0, 90, 0]).translate([x0, y, z])


def pulse_mark(scale, stroke):
    """The heartbeat line: flat, small rise, deep dip, recovery, flat."""
    pts = np.array([(-9, 0), (-5, 0), (-3, 5), (0, -4), (2, 0), (9, 0)], dtype=float) * scale
    dots = [CrossSection.circle(stroke / 2, 24).translate(tuple(p)) for p in pts]
    strokes = [CrossSection.batch_hull([a, b]) for a, b in zip(dots, dots[1:])]
    mark = strokes[0]
    for s in strokes[1:]:
        mark = mark + s
    return mark


def make_base():
    # Outer shell with a chamfer around the underside, hollowed from the floor up.
    shell = Manifold.batch_hull([
        prism(outline(CHAMFER_BOTTOM), 0, 0.02),
        prism(outline(), CHAMFER_BOTTOM, Z_SPLIT),
    ])
    base = shell - prism(outline(WALL), FLOOR, Z_SPLIT + 1)

    half = PCB_W / 2
    guide_top = PCB_TOP_MAX + 1.0
    for side in (-1, 1):
        # Rail the board's long edge rests on, and a guide just outside that edge.
        y = side * (half - 1.0)
        base += box(BOARD_X0 + 1, BOARD_X1 - 1, y - 0.8, y + 0.8, FLOOR, FLOOR + REST)
        y = side * (half + FIT + 0.6)
        base += box(BOARD_X0 + 5, BOARD_X1 - 3, y - 0.6, y + 0.6, FLOOR, guide_top)
    # Stop behind the board: takes the push when a cable is plugged in.
    base += box(BOARD_X1 + FIT, BOARD_X1 + FIT + 1.2, -5, 5, FLOOR, guide_top)

    # USB-C opening, cut down from the rim so the lid closes it off.
    w, h = USB_OPENING
    base -= box(X0 - 1, X0 + WALL + 0.3, -w / 2, w / 2, USB_Z - h / 2, Z_SPLIT + 1)

    # Grooves the lid's snap bumps click into, and a thumbnail notch for opening it.
    inner_half = WIDTH / 2 - WALL
    for side in (-1, 1):
        base -= rod_x(BOARD_X1 + 4, BOARD_X1 + 16, side * (inner_half + 0.05), Z_SPLIT - 1.8, SNAP + 0.3)
    base -= box(LENGTH / 2 - 0.9, LENGTH / 2 + 1, -5, 5, Z_SPLIT - 0.9, Z_SPLIT + 1)
    return base


def make_lid():
    # Top plate with a chamfered upper edge.
    lid = Manifold.batch_hull([
        prism(outline(), Z_SPLIT, HEIGHT - CHAMFER_TOP),
        prism(outline(CHAMFER_TOP), HEIGHT - 0.02, HEIGHT),
    ])
    # Lip that drops inside the base wall.
    ring = outline(WALL + LID_FIT) - outline(WALL + LID_FIT + LIP_T)
    lip = prism(ring, Z_SPLIT - LIP_H, Z_SPLIT)
    w, _ = USB_OPENING
    lip -= box(X0, X0 + WALL + LID_FIT + LIP_T + 1, -w / 2 - 0.4, w / 2 + 0.4, 0, Z_SPLIT)
    lid += lip

    # Snap bumps on the lip's long sides.
    lip_face = WIDTH / 2 - WALL - LID_FIT
    for side in (-1, 1):
        bump = rod_x(BOARD_X1 + 5, BOARD_X1 + 15, side * (lip_face - 0.3 + LID_FIT + SNAP), Z_SPLIT - 1.8, 0.3)
        lid += bump

    # Ribs that hold the board down along its two rows of unused pins.
    for side in (-1, 1):
        y = side * (PCB_W / 2 - 0.9)
        lid += box(BOARD_X0 + 4, BOARD_X1 - 1, y - 0.6, y + 0.6, PCB_TOP_MAX + 0.2, Z_SPLIT)

    # Heartbeat line sunk into the top.
    mark = pulse_mark(scale=min(LENGTH * 0.6 / 18, (WIDTH - 10) / 9), stroke=1.6)
    lid -= prism(mark, HEIGHT - 0.6, HEIGHT + 1)
    return lid


def write_stl(solid, path):
    mesh = solid.to_mesh()
    verts = np.asarray(mesh.vert_properties, dtype=np.float32)[:, :3]
    tris = verts[np.asarray(mesh.tri_verts)]
    normals = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = np.divide(normals, lengths, out=np.zeros_like(normals), where=lengths > 0)
    with open(path, "wb") as f:
        f.write(b"grid-heartbeat pulse case".ljust(80, b" "))
        f.write(struct.pack("<I", len(tris)))
        for n, t in zip(normals, tris):
            f.write(struct.pack("<12fH", *n, *t.ravel(), 0))


def lid_for_printing(lid):
    """Flip the lid so its flat top lies on the print bed and no supports are needed."""
    return lid.rotate([180, 0, 0]).translate([0, 0, HEIGHT])


if __name__ == "__main__":
    here = pathlib.Path(__file__).parent
    base, lid = make_base(), make_lid()
    write_stl(base, here / "pulse-case-base.stl")
    write_stl(lid_for_printing(lid), here / "pulse-case-lid.stl")
    print(f"Case outside: {LENGTH:.1f} x {WIDTH:.1f} x {HEIGHT:.1f} mm")
    for name, part in (("base", base), ("lid", lid)):
        print(f"  {name}: {part.volume() / 1000:.2f} cm3, {part.num_tri()} triangles")
