"""Creates two sample PDFs to try the upload feature with."""
import os
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

HERE = os.path.dirname(os.path.abspath(__file__))
ss = getSampleStyleSheet()


def build(path, title_lines, meta, header, rows, totals):
    doc = SimpleDocTemplate(path, pagesize=A4, topMargin=36, bottomMargin=36)
    story = [Paragraph(f"<b>{title_lines[0]}</b>", ss["Title"])]
    for t in title_lines[1:]:
        story.append(Paragraph(t, ss["Normal"]))
    story.append(Spacer(1, 10))
    for m in meta:
        story.append(Paragraph(m, ss["Normal"]))
    story.append(Spacer(1, 10))
    t = Table([header] + rows + totals, repeatRows=1)
    t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                           ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
                           ("FONTSIZE", (0, 0), (-1, -1), 8)]))
    story.append(t)
    doc.build(story)


build(os.path.join(HERE, "sample_customer_po.pdf"),
      ["Sunrise Auto Components Pvt Ltd", "Plot 22, MIDC Chakan, Pune, Maharashtra 410501",
       "GSTIN: 27AAACS1234F1Z9"],
      ["<b>PURCHASE ORDER</b>", "PO No: SAC/PO/2526/0457", "PO Date: 05/11/2026",
       "Delivery Date: 25/11/2026",
       "To: Ray Precicomp, GSTIN: 27AAJFR9876K1Z2"],
      ["Sr", "Part No", "Description", "HSN", "Qty", "UOM", "Rate", "Amount"],
      [["1", "SAC-FL-0812", "Nylon Fuel Line Assy 8x10 L=450", "87089900", "500", "NOS", "142.50", "71,250.00"],
       ["2", "SAC-VL-0608", "Vapour Line Assy 6x8 L=620", "87089900", "300", "NOS", "118.00", "35,400.00"],
       ["3", "SAC-CL-0101", "Nylon Clip Double 8mm", "39269099", "2000", "NOS", "3.25", "6,500.00"]],
      [["", "", "Sub Total", "", "", "", "", "1,13,150.00"],
       ["", "", "IGST 18%", "", "", "", "", "20,367.00"],
       ["", "", "Grand Total", "", "", "", "", "1,33,517.00"]])

build(os.path.join(HERE, "sample_vendor_invoice.pdf"),
      ["Polytube Extrusions LLP", "Survey 41, Vasai East, Palghar, Maharashtra",
       "GSTIN: 27AAFFP5555Q1ZK"],
      ["<b>TAX INVOICE</b>", "Invoice No: PTE/1189 &nbsp;&nbsp; Invoice Date: 08-Nov-2026",
       "Buyer: Ray Precicomp GSTIN 27AAJFR9876K1Z2"],
      ["S.No", "Description of Goods", "HSN/SAC", "Quantity", "Unit", "Rate", "Taxable Value"],
      [["1", "PA12 Tube 8x10 Black", "39173100", "2500", "MTR", "21.80", "54,500.00"],
       ["2", "PA12 Tube 6x8 Black", "39173100", "1500", "MTR", "16.40", "24,600.00"]],
      [["", "Total", "", "", "", "", "79,100.00"],
       ["", "CGST 9%", "", "", "", "", "7,119.00"],
       ["", "SGST 9%", "", "", "", "", "7,119.00"],
       ["", "Total Invoice Value", "", "", "", "", "93,338.00"]])
print("ok")

# The same customer PO as an Excel sheet, a scanned image and a scanned (image-only) PDF.
import subprocess
from openpyxl import Workbook
from PIL import Image

wb = Workbook(); ws = wb.active; ws.title = "PO"
for r in [["Sunrise Auto Components Pvt Ltd"], ["Plot 22, MIDC Chakan, Pune, Maharashtra 410501"], ["GSTIN:", "27AAACS1234F1Z9"], [],
          ["PURCHASE ORDER"], ["PO No:", "SAC/PO/2526/0458"], ["PO Date:", "06/11/2026"], ["Delivery Date:", "26/11/2026"], [],
          ["Sr", "Part No", "Description", "HSN", "Qty", "UOM", "Rate", "Amount"],
          [1, "SAC-FL-0812", "Nylon Fuel Line Assy 8x10 L=450", "87089900", 400, "NOS", 142.5, 57000],
          [2, "SAC-CL-0101", "Nylon Clip Double 8mm", "39269099", 1000, "NOS", 3.25, 3250], [],
          ["", "", "Sub Total", "", "", "", "", 60250], ["", "", "IGST 18%", "", "", "", "", 10845], ["", "", "Grand Total", "", "", "", "", 71095]]:
    ws.append(r)
wb.save(os.path.join(HERE, "sample_customer_po.xlsx"))

png = os.path.join(HERE, "sample_customer_po_scan")
subprocess.run(["pdftoppm", "-r", "200", "-gray", "-singlefile", "-png", os.path.join(HERE, "sample_customer_po.pdf"), png], check=True)
img = Image.open(png + ".png").convert("L").rotate(0.8, fillcolor=255, expand=True)
img.save(png + ".jpg", quality=80)
img.save(os.path.join(HERE, "sample_customer_po_scan.pdf"), resolution=200)
os.remove(png + ".png")
print("excel + scan samples written")
