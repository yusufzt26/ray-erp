// Makes every printed document (.inv-page) fill exactly one A4 sheet: blank item rows are added or removed
// to use the page, and a long document is shrunk slightly so it still fits on one sheet when that stays readable.

const MM = 96 / 25.4;
const PAGE_MM = 297 - 16 - 3; // A4 minus the 8 mm print margins, with a little room to spare
const MIN_ZOOM = 0.7;

// Cells that must stay on one line (GSTIN, numbers, dates): shrink the text until it fits the cell.
function shrinkCells(pg) {
  for (const td of pg.querySelectorAll("tr.nw td, td.nw, tr.item td.r, tr.item td.c")) {
    td.style.fontSize = "";
    let size = parseFloat(getComputedStyle(td).fontSize);
    for (let i = 0; i < 12 && td.scrollWidth > td.clientWidth + 1 && size > 8; i++) { size -= 0.5; td.style.fontSize = size + "px"; }
  }
}

function fitOne(pg) {
  pg.style.zoom = "";
  shrinkCells(pg);
  const limit = PAGE_MM * MM;
  const items = [...pg.querySelectorAll("tr.item")];
  if (!items.length) return;
  const empties = () => [...pg.querySelectorAll("tr.item.empty")];
  for (let e = empties(); pg.offsetHeight > limit && e.length; e = empties()) e.pop().remove();
  const last = [...pg.querySelectorAll("tr.item")].pop();
  const blank = last.cloneNode(true);
  blank.className = "item empty";
  blank.querySelectorAll("td").forEach((td) => { td.textContent = ""; td.removeAttribute("class"); });
  for (let i = 0; i < 80 && pg.offsetHeight <= limit; i++) {
    const row = blank.cloneNode(true);
    const after = [...pg.querySelectorAll("tr.item")].pop();
    after.after(row);
    if (pg.offsetHeight > limit) { row.remove(); break; }
  }
  const h = pg.offsetHeight;
  if (h > limit && limit / h >= MIN_ZOOM) pg.style.zoom = (Math.floor((limit / h) * 1000) / 1000).toString();
}

export async function fitPages(root = document) {
  const imgs = [...root.querySelectorAll(".inv-page img")];
  await Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
  root.querySelectorAll(".inv-page").forEach(fitOne);
}
