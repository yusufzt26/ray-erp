// Saves an Excel / CSV file. The file is made in the browser, sent to the server once, and then
// opened from a normal link: that works in every browser and in the installed phone app, where
// downloads of in-page files are often blocked.
const CSRF = { "content-type": "application/json", "x-requested-with": "ray-erp" };

export async function saveWorkbook(wb, filename, fmt = "xlsx") {
  const bookType = fmt === "csv" ? "csv" : "xlsx";
  try {
    const data = XLSX.write(wb, { bookType, type: "base64" });
    const res = await fetch("/api/download", { method: "POST", headers: CSRF, credentials: "same-origin", body: JSON.stringify({ name: filename, fmt: bookType, data }) });
    const out = await res.json();
    if (!res.ok || !out.url) throw new Error(out.error || "Download failed");
    const a = document.createElement("a");
    a.href = out.url; a.download = filename; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
  } catch (err) {
    // Server not reachable: fall back to saving straight from the page.
    XLSX.writeFile(wb, filename, { bookType });
  }
}

/** One sheet (or several, Excel only) from arrays of rows. */
export function saveSheets(filename, sheets, fmt = "xlsx") {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa, cols] of fmt === "csv" ? sheets.slice(0, 1) : sheets) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = cols || (aoa[0] || []).map((hd) => ({ wch: Math.max(12, Math.min(40, String(hd).length + 4)) }));
    XLSX.utils.book_append_sheet(wb, ws, String(name).slice(0, 31));
  }
  return saveWorkbook(wb, filename, fmt);
}
