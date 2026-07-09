import puppeteer from "puppeteer";
import { readFile } from "node:fs/promises";
import { renderNotesHtml } from "../src/template.js";

const notes = JSON.parse(await readFile(new URL("../output/notes.json", import.meta.url)));
const html = renderNotesHtml(notes);

const runs = Number(process.argv[2] || 3);
const results = [];

for (let i = 0; i < runs; i++) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();

    const t0 = performance.now();
    await page.setContent(html, { waitUntil: "load", timeout: 60000 });
    const t1 = performance.now();

    await page.evaluate(() => document.fonts.ready);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const t2 = performance.now();

    await page.pdf({
      path: `output/benchmark-run${i}.pdf`,
      printBackground: true,
      format: "A4",
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });
    const t3 = performance.now();

    results.push({
      setContent: t1 - t0,
      fontsAndSettle: t2 - t1,
      pdfPrint: t3 - t2,
      total: t3 - t0,
    });
  } finally {
    await browser.close();
  }
}

console.log(`HTML size: ${(html.length / 1024).toFixed(1)} KB, pages: ${notes.pages.length}`);
for (const [i, r] of results.entries()) {
  console.log(
    `run ${i}: setContent=${r.setContent.toFixed(0)}ms fonts+settle=${r.fontsAndSettle.toFixed(0)}ms pdf=${r.pdfPrint.toFixed(0)}ms total=${r.total.toFixed(0)}ms`
  );
}
const avg = (key) => results.reduce((s, r) => s + r[key], 0) / results.length;
console.log(
  `avg: setContent=${avg("setContent").toFixed(0)}ms fonts+settle=${avg("fontsAndSettle").toFixed(0)}ms pdf=${avg("pdfPrint").toFixed(0)}ms total=${avg("total").toFixed(0)}ms`
);
