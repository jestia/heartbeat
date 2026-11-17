#!/usr/bin/env python3
"""Adds ventilation and a name to the "ESP32 S3 Zero Case Snap Fit" from MakerWorld.

The case itself is someone else's design (https://makerworld.com/en/models/1776012), so it is not
in this repository. Download its 3MF from MakerWorld, then:

    pip install manifold3d numpy matplotlib
    python personalise_case.py Esp32s3-closed.3mf --name ZEYNEP --style raised
    python personalise_case.py Esp32s3-closed.3mf --name ZZS --style engraved
    python personalise_case.py Esp32s3-closed.3mf                  # ventilation only, no name

Each run writes a 3MF with both parts laid out for printing, and the same parts as STL files.

What it changes, in the case's own coordinates (millimetres, the board lies in x 0..18, y 0..23.5,
the USB-C end is at high y, the lid's top face is at z = 4.5):
  - two slots in the lid between the buttons, directly above the ESP32-S3 chip, continuing two of
    the existing vent columns;
  - four slots in the end wall opposite the USB-C opening, matching the slots in the long sides;
  - optionally a name on the lid, in the free strip between the buttons and the USB-C end,
    either raised 0.6 mm (for a second filament colour) or engraved 0.4 mm.
"""

import argparse
import pathlib
import re
import struct
import unicodedata
import xml.etree.ElementTree as ET
import zipfile

import numpy as np
from manifold3d import CrossSection, FillRule, Manifold, Mesh

NS = {"m": "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"}

# Measured from the original model.
LID_TOP = 4.5            # top face of the lid
LID_UNDERSIDE = 3.5
END_WALL_Y = (-1.2, -0.15)  # the wall opposite the USB-C opening
SIDE_SLOT_Z = (0.0, 3.0)    # height of the existing slots in the long sides
TEXT_BOX = (0.4, 17.6, 16.7, 23.5)  # free strip on the lid: x0, x1, y0, y1

# Added ventilation.
CHIP_SLOTS_X = (8.0, 10.0)    # centres; the existing lid slots are at 4, 6, 8, 10, 12, 14
CHIP_SLOTS_Y = (10.6, 15.4)   # between the button cut-outs, which end at y 10 and 16
END_SLOTS_X = (3.0, 7.0, 11.0, 15.0)
SLOT_WIDTH_LID = 1.0
SLOT_WIDTH_WALL = 2.0

RAISED = 0.6
ENGRAVED = 0.4
FONTS = ["/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf", "/Library/Fonts/Inter-ExtraBold.otf"]


def load_parts(path):
    """Returns (bottom, lid) from the 3MF, telling them apart by height rather than by name."""
    root = ET.fromstring(zipfile.ZipFile(path).read("3D/3dmodel.model"))
    solids = []
    for obj in root.find("m:resources", NS).findall("m:object", NS):
        mesh = obj.find("m:mesh", NS)
        if mesh is None:
            continue
        v = np.array([[float(x.get(a)) for a in "xyz"] for x in mesh.find("m:vertices", NS)], dtype=np.float32)
        t = np.array([[int(x.get(a)) for a in ("v1", "v2", "v3")] for x in mesh.find("m:triangles", NS)], dtype=np.uint32)
        solid = Manifold(Mesh(vert_properties=v, tri_verts=t))
        if solid.status().name != "NoError":
            raise SystemExit(f"Part {obj.get('name')!r} in {path} is not a closed solid; cannot modify it safely.")
        solids.append(solid)
    if len(solids) != 2:
        raise SystemExit(f"Expected the case's two parts in {path}, found {len(solids)}.")
    solids.sort(key=lambda s: s.bounding_box()[2])
    bottom, lid = solids
    if abs(lid.bounding_box()[5] - 6.0) > 0.05 or abs(bottom.bounding_box()[2] + 4.5) > 0.05:
        raise SystemExit("This does not look like the ESP32 S3 Zero snap-fit case this script was measured on.")
    return bottom, lid


def stadium(x0, y0, x1, y1):
    """A slot with fully rounded ends inside the given rectangle, as a 2D shape."""
    r = min(x1 - x0, y1 - y0) / 2
    a = CrossSection.circle(r, 32).translate([x0 + r, y0 + r])
    b = CrossSection.circle(r, 32).translate([x1 - r, y1 - r])
    return CrossSection.batch_hull([a, b])


def lid_slots():
    cut = None
    for x in CHIP_SLOTS_X:
        slot = Manifold.extrude(stadium(x - SLOT_WIDTH_LID / 2, CHIP_SLOTS_Y[0], x + SLOT_WIDTH_LID / 2, CHIP_SLOTS_Y[1]), 2.0)
        slot = slot.translate([0, 0, LID_UNDERSIDE - 0.5])
        cut = slot if cut is None else cut + slot
    return cut


def end_wall_slots():
    """Upright slots with round tops, so they print without bridging."""
    cut = None
    depth = END_WALL_Y[1] - END_WALL_Y[0] + 0.4
    for x in END_SLOTS_X:
        shape = stadium(x - SLOT_WIDTH_WALL / 2, SIDE_SLOT_Z[0], x + SLOT_WIDTH_WALL / 2, SIDE_SLOT_Z[1])
        # Drawn in the x-z plane, then pushed through the wall along y.
        slot = Manifold.extrude(shape, depth).rotate([90, 0, 0]).translate([0, END_WALL_Y[1] + 0.2, 0])
        cut = slot if cut is None else cut + slot
    return cut


def text_shape(text, font):
    from matplotlib.font_manager import FontProperties
    from matplotlib.textpath import TextPath

    path = TextPath((0, 0), text, size=10, prop=FontProperties(fname=font))
    letters = CrossSection([p.tolist() for p in path.to_polygons(closed_only=True)], FillRule.EvenOdd)
    x0, y0, x1, y1 = letters.bounds()
    bx0, bx1, by0, by1 = TEXT_BOX
    scale = min((bx1 - bx0) / (x1 - x0), (by1 - by0) / (y1 - y0))
    cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
    return letters.translate([-(x0 + x1) / 2, -(y0 + y1) / 2]).scale([scale, scale]).translate([cx, cy])


def personalise(bottom, lid, name=None, style="raised", font=None):
    bottom = bottom - end_wall_slots()
    lid = lid - lid_slots()
    if name:
        letters = text_shape(name, font)
        if style == "raised":
            lid = lid + Manifold.extrude(letters, RAISED + 0.05).translate([0, 0, LID_TOP - 0.05])
        else:
            lid = lid - Manifold.extrude(letters, ENGRAVED + 1).translate([0, 0, LID_TOP - ENGRAVED])
    return bottom, lid


def for_printing(bottom, lid):
    """Base standing on its floor and lid upright, side by side, both resting on z = 0."""
    b = bottom.translate([0, 0, -bottom.bounding_box()[2]])
    lid_box = lid.bounding_box()
    width = b.bounding_box()[3] - b.bounding_box()[0]
    lid = lid.translate([width + 6, 0, -lid_box[2]])
    return b, lid


def mesh_arrays(solid):
    mesh = solid.to_mesh()
    return np.asarray(mesh.vert_properties, dtype=np.float64)[:, :3], np.asarray(mesh.tri_verts)


def write_stl(solid, path):
    verts, tris = mesh_arrays(solid)
    tri = verts[tris].astype(np.float32)
    normals = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = np.divide(normals, lengths, out=np.zeros_like(normals), where=lengths > 0)
    with open(path, "wb") as f:
        f.write(b"ESP32-S3 Zero case, personalised".ljust(80, b" "))
        f.write(struct.pack("<I", len(tri)))
        for n, t in zip(normals, tri):
            f.write(struct.pack("<12fH", *n, *t.ravel(), 0))


def write_3mf(parts, path):
    """A plain 3MF that any slicer opens, with each part as its own object."""
    objects, items = [], []
    for i, (name, solid) in enumerate(parts, start=1):
        verts, tris = mesh_arrays(solid)
        v = "".join(f'<vertex x="{x:.4f}" y="{y:.4f}" z="{z:.4f}"/>' for x, y, z in verts)
        t = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in tris)
        objects.append(f'<object id="{i}" name="{name}" type="model"><mesh><vertices>{v}</vertices><triangles>{t}</triangles></mesh></object>')
        items.append(f'<item objectid="{i}"/>')
    model = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<model unit="millimeter" xml:lang="en-US" xmlns="{NS["m"]}">'
        f'<resources>{"".join(objects)}</resources><build>{"".join(items)}</build></model>'
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
        z.writestr("_rels/.rels",
                   '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
        z.writestr("3D/3dmodel.model", model)


def slug(text):
    plain = unicodedata.normalize("NFD", text).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", plain).strip("-") or "name"


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("original", help="the 3MF downloaded from MakerWorld")
    parser.add_argument("--name", help="text for the lid, for example ZEYNEP")
    parser.add_argument("--style", choices=["raised", "engraved"], default="raised")
    parser.add_argument("--font", help="an OTF or TTF file for the lettering (default: Inter ExtraBold, else DejaVu Sans Bold)")
    parser.add_argument("--out", default=".", help="folder for the output files")
    args = parser.parse_args()

    font = args.font or next((f for f in FONTS if pathlib.Path(f).exists()), None)
    if args.name and not font:
        import matplotlib

        font = str(pathlib.Path(matplotlib.get_data_path()) / "fonts/ttf/DejaVuSans-Bold.ttf")
    bottom, lid = personalise(*load_parts(args.original), args.name, args.style, font)
    label = f"{slug(args.name)}-{args.style}" if args.name else "vented"
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    printable = for_printing(bottom, lid)
    write_3mf([("base", printable[0]), (f"lid {args.name or ''}".strip(), printable[1])], out / f"s3-zero-case-{label}.3mf")
    write_stl(printable[0], out / "s3-zero-case-base-vented.stl")
    write_stl(printable[1], out / f"s3-zero-case-lid-{label}.stl")
    print(f"Wrote s3-zero-case-{label}.3mf, s3-zero-case-base-vented.stl and s3-zero-case-lid-{label}.stl to {out}")


if __name__ == "__main__":
    main()
