/** What font resource name does pdf-lib generate for each standard variant?
 *  /DA embeds that name, and the read-back parses it back into family+style,
 *  so this decides whether bold/italic survive a save → reopen cycle. */
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';

const doc = await PDFDocument.create();
const variants = [
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
];
for (const family of variants) {
  const f = await doc.embedFont(family);
  console.log(`${family.padEnd(22)} -> name="${f.name}"`);
}
