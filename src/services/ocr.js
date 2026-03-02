const fs = require('fs');
const path = require('path');

const OCR_URL = process.env.OCR_URL || 'http://ocr:8010';

/**
 * Send an image file to the OCR service and get extracted text.
 * @param {string} filePath - absolute path to the image file
 * @returns {Promise<{text: string, lines: Array, line_count: number}>}
 */
async function extractText(filePath) {
  const fileName = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  const blob = new Blob([fileBuffer]);

  const form = new FormData();
  form.append('file', blob, fileName);

  const res = await fetch(`${OCR_URL}/ocr`, {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OCR service error (${res.status}): ${err}`);
  }

  return res.json();
}

module.exports = { extractText };
