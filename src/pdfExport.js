import puppeteer from "puppeteer";

/**
 * Renders the given HTML headlessly and exports it to a PDF at outputPath.
 * Relies on the template's `.notebook-page { break-after: page }` CSS so
 * each notebook page lands on its own PDF page, rather than stitching
 * per-page screenshots back together.
 *
 * Returns per-stage timings (ms) instead of just logging them, so callers
 * with different reporting needs - the CLI's console, a job store keyed by
 * jobId for the API - can each do what they want with the numbers.
 */
export async function exportHtmlToPdf(html, outputPath) {
  const t0 = performance.now();
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 60000 });
    const t1 = performance.now();

    // Give KaTeX/webfonts a moment to finish rendering before printing.
    await page.evaluate(() => document.fonts.ready);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const t2 = performance.now();

    await page.pdf({
      path: outputPath,
      printBackground: true,
      format: "A4",
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });
    const t3 = performance.now();

    return {
      setContent: t1 - t0,
      fontsAndSettle: t2 - t1,
      print: t3 - t2,
      total: t3 - t0,
    };
  } finally {
    await browser.close();
  }
}
