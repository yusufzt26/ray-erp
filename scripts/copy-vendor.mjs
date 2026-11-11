// Copies browser libraries from node_modules into public/vendor (run by `npm run build`).
import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("public/vendor", { recursive: true });
for (const [from, to] of [
  ["node_modules/pdfjs-dist/legacy/build/pdf.min.mjs", "public/vendor/pdf.min.mjs"],
  ["node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs", "public/vendor/pdf.worker.min.mjs"],
  ["node_modules/xlsx/dist/xlsx.full.min.js", "public/vendor/xlsx.full.min.js"],
]) copyFileSync(from, to);
console.log("vendor files copied");
