// Small SVG charts for the dashboards. No library: plain SVG strings.

const h = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const COLORS = ["#1b65a6", "#e08a1e", "#2e9e6b", "#8a5cc2", "#c94a4a", "#5b7083"];

/** Indian short money: 1,23,45,678 -> 1.23 Cr, 4,56,789 -> 4.57 L, 12,345 -> 12.3 K */
export function short(n) {
  const a = Math.abs(Number(n) || 0), s = n < 0 ? "-" : "";
  if (a >= 1e7) return s + (a / 1e7).toFixed(2) + " Cr";
  if (a >= 1e5) return s + (a / 1e5).toFixed(2) + " L";
  if (a >= 1e3) return s + (a / 1e3).toFixed(1) + " K";
  return s + a.toFixed(a % 1 ? 2 : 0);
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthLabel = (ym) => MONTHS[Number(ym.slice(5, 7)) - 1] + " " + ym.slice(2, 4);

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/** Column chart. labels: [..], series: [{ name, values: [..], color }] */
export function columns(labels, series, { height = 230, fmt = short } = {}) {
  const W = 640, H = height, L = 52, B = 26, T = 12, R = 8;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values.map(Number))));
  const cw = (W - L - R) / Math.max(1, labels.length), gap = cw * 0.22, bw = (cw - gap) / series.length;
  const y = (v) => T + (H - T - B) * (1 - v / max);
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" class="gl"/><text x="${L - 6}" y="${yy + 4}" class="ax" text-anchor="end">${fmt(v)}</text>`;
  }
  labels.forEach((lab, i) => {
    series.forEach((s, j) => {
      const v = Number(s.values[i]) || 0, x = L + i * cw + gap / 2 + j * bw, yy = y(Math.max(0, v));
      g += `<rect x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${(y(0) - yy).toFixed(1)}" rx="2" fill="${s.color}"><title>${h(lab)} · ${h(s.name)}: ${h(fmt(v))}</title></rect>`;
    });
    g += `<text x="${(L + i * cw + cw / 2).toFixed(1)}" y="${H - 8}" class="ax" text-anchor="middle">${h(lab)}</text>`;
  });
  const legend = series.length > 1 ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${h(s.name)}</span>`).join("")}</div>` : "";
  return `${legend}<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">${g}</svg>`;
}

/** Horizontal bars with labels and values. rows: [{ label, value, sub? }] */
export function bars(rows, { color = COLORS[0], fmt = short, empty = "Nothing yet." } = {}) {
  if (!rows.length) return `<p class="muted small">${h(empty)}</p>`;
  const max = Math.max(...rows.map((r) => Math.abs(Number(r.value) || 0)), 1);
  return `<div class="hbars">${rows.map((r) => {
    const v = Number(r.value) || 0, w = Math.max(1, (Math.abs(v) / max) * 100);
    return `<div class="hb"><div class="hb-l" title="${h(r.label)}">${h(r.label)}${r.sub ? `<small>${h(r.sub)}</small>` : ""}</div>
      <div class="hb-t"><div class="hb-f" style="width:${w.toFixed(1)}%;background:${v < 0 ? "#c94a4a" : r.color || color}"></div></div><div class="hb-v">${h(fmt(v))}</div></div>`;
  }).join("")}</div>`;
}

/** Donut with legend. parts: [{ label, value }] */
export function donut(parts, { fmt = short, center = "" } = {}) {
  const list = parts.filter((p) => Number(p.value) > 0);
  const total = list.reduce((t, p) => t + Number(p.value), 0);
  if (!total) return `<p class="muted small">Nothing yet.</p>`;
  const R = 70, C = 2 * Math.PI * R;
  let off = 0, arcs = "";
  list.forEach((p, i) => {
    const len = (Number(p.value) / total) * C;
    arcs += `<circle r="${R}" cx="90" cy="90" fill="none" stroke="${COLORS[i % COLORS.length]}" stroke-width="28" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 90 90)"><title>${h(p.label)}: ${h(fmt(p.value))}</title></circle>`;
    off += len;
  });
  return `<div class="donut"><svg viewBox="0 0 180 180" role="img">${arcs}<text x="90" y="86" text-anchor="middle" class="dc1">${h(center || fmt(total))}</text><text x="90" y="104" text-anchor="middle" class="dc2">total</text></svg>
    <div class="legend col">${list.map((p, i) => `<span><i style="background:${COLORS[i % COLORS.length]}"></i>${h(p.label)} <b>${h(fmt(p.value))}</b> <small>${Math.round((p.value / total) * 100)}%</small></span>`).join("")}</div></div>`;
}
