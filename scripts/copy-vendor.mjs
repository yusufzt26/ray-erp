// Copies browser libraries from node_modules into public/vendor (run by `npm run build`).
import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("public/vendor/tess", { recursive: true });
for (const [from, to] of [
  ["node_modules/pdfjs-dist/legacy/build/pdf.min.mjs", "public/vendor/pdf.min.mjs"],
  ["node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs", "public/vendor/pdf.worker.min.mjs"],
  ["node_modules/xlsx/dist/xlsx.full.min.js", "public/vendor/xlsx.full.min.js"],
  // text recognition for photos and scanned PDFs (served from our own site, nothing sent elsewhere)
  ["node_modules/tesseract.js/dist/tesseract.min.js", "public/vendor/tess/tesseract.min.js"],
  ["node_modules/tesseract.js/dist/worker.min.js", "public/vendor/tess/worker.min.js"],
  ["node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js", "public/vendor/tess/tesseract-core-simd-lstm.wasm.js"],
  ["node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js", "public/vendor/tess/tesseract-core-lstm.wasm.js"],
  ["node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "public/vendor/tess/eng.traineddata.gz"],
]) copyFileSync(from, to);
console.log("vendor files copied");
