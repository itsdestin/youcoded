#!/usr/bin/env python3
"""Builds `xlsx-kitchen-sink.xlsx` -- the doc-comments build's permanent
"everything a whole-workbook-rewrite can corrupt" regression fixture
(docs/active/specs/2026-09-26-doc-comments-build-design.md §4.3, the T13
xlsx-comments.ts surgical-write rewrite).

WHY LibreOffice via its own UNO scripting API, not exceljs/openpyxl: the
whole point of this fixture is a workbook authored the way a REAL human using
REAL Office software would produce one -- custom document properties, `$`-
absolute defined names, merged cells, freeze panes, conditional formatting,
data validation, a hyperlink, an embedded image, sheet protection, rich text,
and a pre-existing, deliberately RESIZED legacy cell note -- so a test can
prove the NEW surgical xlsx write path (which edits only the specific
comment/VML/rels/[Content_Types].xml parts a note change actually needs)
leaves every one of these OTHER features byte-identical, the exact class of
corruption a prior implementation review found in the old exceljs-based
whole-workbook-rewrite write path (docProps/custom.xml LOST, defined names'
`$` absoluteness ALTERED, resized comment boxes reset, etc). Driving real
LibreOffice via UNO (not hand-typed OOXML/ODF) is what makes this a REAL
regression fixture rather than a hand-crafted one nobody's software actually
produces.

Run (from `desktop/`, with `soffice`/`libreoffice` on PATH -- LibreOffice
26.2.4.2 confirmed working):

    python3 tests/fixtures/doc-comments/build-xlsx-kitchen-sink.py

It launches its own headless `soffice` listener on a private UNO socket port,
builds the workbook, saves it to
`tests/fixtures/doc-comments/xlsx-kitchen-sink.xlsx`, and shuts that listener
down again -- it does not touch any other running LibreOffice/soffice
process (never `pkill -f`; it tracks and kills only the PID it itself
started).

WHAT'S IN IT, and where:

- Sheet "Data" (sheetId 1):
  - A1/B1 -- plain header values ("Region"/"Rate").
  - A2 -- RICH TEXT: a bold "West" run followed by a plain " region" run in
    ONE shared string (not a comment) -- proves genuinely multi-run text
    elsewhere in the workbook survives untouched.
  - B2 -- 0.075, the cell `TaxRate` (see defined name below) points at.
  - C3 -- a HYPERLINK to https://example.com/rates.
  - D1:E1 -- MERGED CELLS ("Merged header").
  - Columns A/B -- explicit custom WIDTHS.
  - Row 10 (1-based) -- HIDDEN, with a value in A10.
  - F1:F5 -- a DATA VALIDATION rule (whole number, 1-100).
  - G1:G5 -- values 10/20/30/40/50 under a CONDITIONAL FORMATTING rule
    (value > 50 -> the "Good" style).
  - Freeze panes: row 1 + column A FROZEN (`controller.freezeAtPosition`).
  - An embedded IMAGE (a tiny solid PNG) anchored near D2.
  - E1 -- a PRE-EXISTING legacy note ("This note has been deliberately
    resized -- it must stay untouched."), its VISUAL SHAPE explicitly resized
    away from any default box size/position via
    `XSheetAnnotationShapeSupplier.getAnnotationShape()` (LibreOffice's own
    default note box is far smaller) -- this app's own eventual writer style
    is `width:97.8pt;height:59.1pt` (T18's spike reference); this note's own
    captured style is `margin-left:85.05pt;margin-top:5.65pt;
    width:170.05pt;height:113.35pt` -- deliberately different from BOTH
    LibreOffice's own default AND this app's own default, so a test asserting
    "this exact style string survived" can't accidentally pass by matching a
    coincidental default.
  - Defined name `TaxRate` = `Data!$B$2` -- ABSOLUTE (`$`) references on
    both column and row, the exact shape a prior review found the old
    exceljs-based write path could alter.
  - A custom document property `ReviewedBy` = `"QA Team"`
    (docProps/custom.xml).

- Sheet "Notes" (sheetId 2): a single plain value, NO comments/notes at all
  -- exercises the "add the very first note to a worksheet that has none
  yet" fresh-wiring path (creating commentsN.xml/vmlDrawingN.vml/rels/
  legacyDrawing/[Content_Types].xml entries for the first time). Also
  SHEET-PROTECTED (no password) -- proves a protected sheet's protection
  survives an unrelated comment mutation elsewhere in the workbook.

WHAT'S DELIBERATELY NOT HERE: an `xl/externalLinks/*` cross-workbook formula
reference. Attempted via UNO (`com.sun.star.sheet.SheetLinkable` and a raw
`='file:///...'#$Sheet.A1` formula string) and via a hand-authored Flat ODF
`<table:cell-range-source>` external reference; LibreOffice's headless
`storeToURL` with the xlsx export filter did not reliably materialize an
`xl/externalLinks/` part for either approach within a reasonable number of
attempts (unlike the other features here, external links appear to need an
interactive "update links" pass LibreOffice's headless mode doesn't run by
default). Rather than spend disproportionate effort or ship a fragile,
non-reproducible external-link fixture, this one feature is dropped; the
coordinating session's own byte-identity test does not assert anything about
`xl/externalLinks/*` as a result. If a future session gets this working, add
it here rather than building a second fixture.
"""
import subprocess
import sys
import time
import os
from pathlib import Path

FIXTURE_DIR = Path(__file__).resolve().parent
OUT_XLSX = FIXTURE_DIR / "xlsx-kitchen-sink.xlsx"
LOGO_PNG = FIXTURE_DIR / "xlsx-kitchen-sink-logo.png"
UNO_PORT = 2091  # an unlikely-to-collide private port for this script's own soffice instance

# The pre-existing note's deliberately non-default size/position (1/100 mm
# units, UNO's native unit for drawing shapes).
RESIZED_WIDTH_100MM = 6000
RESIZED_HEIGHT_100MM = 4000
RESIZED_X_100MM = 3000
RESIZED_Y_100MM = 200


def ensure_logo_png() -> None:
    """A tiny real (not fabricated-corrupt) PNG for the embedded image
    feature -- generated with ImageMagick if the fixture doesn't already have
    one checked in, so this script is runnable from a clean checkout without
    requiring a binary asset to be regenerated by hand."""
    if LOGO_PNG.exists():
        return
    subprocess.run(["convert", "-size", "8x8", "xc:red", str(LOGO_PNG)], check=True)


def start_soffice() -> subprocess.Popen:
    proc = subprocess.Popen(
        [
            "soffice",
            "--headless",
            "--invisible",
            "--norestore",
            "--nologo",
            "--nofirststartwizard",
            f"--accept=socket,host=localhost,port={UNO_PORT};urp;",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return proc


def wait_for_uno(timeout_s: float = 30.0):
    import uno

    deadline = time.time() + timeout_s
    last_err = None
    while time.time() < deadline:
        try:
            local_context = uno.getComponentContext()
            resolver = local_context.ServiceManager.createInstanceWithContext(
                "com.sun.star.bridge.UnoUrlResolver", local_context)
            ctx = resolver.resolve(
                f"uno:socket,host=localhost,port={UNO_PORT};urp;StarOffice.ComponentContext")
            return ctx
        except Exception as e:  # noqa: BLE001 -- retry loop, any failure just means "not ready yet"
            last_err = e
            time.sleep(0.5)
    raise RuntimeError(f"soffice UNO socket never became ready: {last_err}")


def build_workbook(ctx) -> None:
    import uno
    from com.sun.star.beans import PropertyValue
    from com.sun.star.table import CellAddress
    from com.sun.star.awt import Size, Point

    def mkprop(name, value):
        p = PropertyValue()
        p.Name = name
        p.Value = value
        return p

    smgr = ctx.ServiceManager
    desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)

    # WHY Hidden=False even though soffice runs --headless (no real display):
    # freeze-pane state (XViewFreezable.freezeAtPosition) lives on the VIEW,
    # which a Hidden=True document never fully materializes -- confirmed
    # empirically: with Hidden=True the frozen-pane state silently failed to
    # serialize into the saved .xlsx's <pane state="frozen"/> element at all.
    # soffice --headless still renders an off-screen view when Hidden=False,
    # which is enough for view-state properties to persist on save.
    doc = desktop.loadComponentFromURL(
        "private:factory/scalc", "_blank", 0, (mkprop("Hidden", False),))

    sheets = doc.Sheets
    sheets.getByIndex(0).Name = "Data"
    data = sheets.getByName("Data")

    sheets.insertNewByName("Notes", 1)
    notes_sheet = sheets.getByName("Notes")
    notes_sheet.getCellByPosition(0, 0).setString("This sheet starts with zero comments.")

    data.getCellByPosition(0, 0).setString("Region")
    data.getCellByPosition(1, 0).setString("Rate")
    data.getCellByPosition(1, 1).setValue(0.075)  # B2 -- TaxRate's target

    a2 = data.getCellByPosition(0, 1)
    text = a2.getText()
    text.setString("")
    cursor = text.createTextCursor()
    bold = uno.getConstantByName("com.sun.star.awt.FontWeight.BOLD")
    normal = uno.getConstantByName("com.sun.star.awt.FontWeight.NORMAL")
    cursor.setPropertyValue("CharWeight", bold)
    text.insertString(cursor, "West", False)
    cursor.setPropertyValue("CharWeight", normal)
    text.insertString(cursor, " region", False)

    c3 = data.getCellByPosition(2, 2)
    c3text = c3.getText()
    c3text.setString("")
    hl = doc.createInstance("com.sun.star.text.TextField.URL")
    hl.URL = "https://example.com/rates"
    hl.Representation = "More info"
    c3text.insertTextContent(c3text.createTextCursor(), hl, False)

    data.getCellRangeByName("D1:E1").merge(True)
    data.getCellByPosition(3, 0).setString("Merged header")

    data.Columns.getByIndex(0).Width = 3500
    data.Columns.getByIndex(1).Width = 2200

    hidden_row_index = 9  # row 10, 1-based
    data.Rows.getByIndex(hidden_row_index).IsVisible = False
    data.getCellByPosition(0, hidden_row_index).setString("Hidden row content")

    controller = doc.CurrentController
    controller.setActiveSheet(data)
    controller.freezeAtPosition(1, 1)

    validation_range = data.getCellRangeByName("F1:F5")
    validation = validation_range.Validation
    validation.Type = uno.Enum("com.sun.star.sheet.ValidationType", "WHOLE")
    validation.setOperator(uno.Enum("com.sun.star.sheet.ConditionOperator", "BETWEEN"))
    validation.Formula1 = "1"
    validation.Formula2 = "100"
    validation.ShowErrorMessage = True
    validation_range.Validation = validation

    for i in range(5):
        data.getCellByPosition(6, i).setValue(10 * (i + 1))
    cf_range = data.getCellRangeByName("G1:G5")
    cond_formats = cf_range.ConditionalFormat
    cond_formats.clear()
    cond_formats.addNew((
        mkprop("Operator", uno.Enum("com.sun.star.sheet.ConditionOperator", "GREATER")),
        mkprop("Formula1", "50"),
        mkprop("Formula2", ""),
        mkprop("StyleName", "Good"),
    ))
    cf_range.ConditionalFormat = cond_formats

    doc.NamedRanges.addNewByName("TaxRate", "$Data.$B$2", CellAddress(0, 0, 0), 0)

    doc_props = doc.getDocumentProperties()
    udp = doc_props.UserDefinedProperties
    if not udp.getPropertySetInfo().hasPropertyByName("ReviewedBy"):
        udp.addProperty("ReviewedBy", 0, "")
    udp.setPropertyValue("ReviewedBy", "QA Team")

    graphic_provider = smgr.createInstance("com.sun.star.graphic.GraphicProvider")
    graphic = graphic_provider.queryGraphic((mkprop("URL", LOGO_PNG.as_uri()),))
    image_shape = doc.createInstance("com.sun.star.drawing.GraphicObjectShape")
    data.DrawPage.add(image_shape)
    image_shape.Graphic = graphic
    image_shape.Size = Size(2000, 2000)
    image_shape.Position = Point(8000, 500)

    e1 = CellAddress(data.RangeAddress.Sheet, 4, 0)  # E1
    annotations = data.Annotations
    annotations.insertNew(e1, "This note has been deliberately resized -- it must stay untouched.")
    ann = annotations.getByIndex(annotations.Count - 1)
    ann.IsVisible = False
    # The visual note box is reached via XSheetAnnotationShapeSupplier, not a
    # property on the annotation object itself.
    shape_supplier = ann.queryInterface(
        uno.getTypeByName("com.sun.star.sheet.XSheetAnnotationShapeSupplier"))
    note_shape = shape_supplier.getAnnotationShape()
    note_shape.Size = Size(RESIZED_WIDTH_100MM, RESIZED_HEIGHT_100MM)
    note_shape.Position = Point(RESIZED_X_100MM, RESIZED_Y_100MM)

    notes_sheet.protect("")

    doc.storeToURL(
        OUT_XLSX.as_uri(),
        (mkprop("FilterName", "Calc MS Excel 2007 XML"), mkprop("Overwrite", True)),
    )
    doc.close(False)


def main() -> None:
    ensure_logo_png()
    proc = start_soffice()
    try:
        ctx = wait_for_uno()
        build_workbook(ctx)
    finally:
        # Kill only the PID this script itself started -- never `pkill -f`
        # (would signal any other soffice/Claude Code process on the
        # machine, per .claude/rules/code-search.md's own PID-only rule).
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
    print(f"SAVED {OUT_XLSX}")


if __name__ == "__main__":
    main()
