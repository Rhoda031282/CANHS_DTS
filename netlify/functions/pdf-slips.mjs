// Shared PDF layout for the Submission and Routing Slip / Claim Stub and the
// Transmittal Slip. Pure functions: given plain data (a document, a sent
// transmittal record, school info, and the shared vocabulary constants) they
// return PDF bytes (Uint8Array). No knowledge of Netlify Blobs or the local
// test harness's in-memory store lives here — both backends call into this
// file and just save the returned bytes wherever their own file store lives.
//
// Imported as an ES module both by netlify/functions/data.mjs (native `import`)
// and by the local test-server (`await import(...)`, since that harness is
// CommonJS) — Node resolves the bare "pdf-lib" specifier below relative to
// THIS file's own location, so it finds netlify-project/node_modules either way.

import pdfLibPkg from "pdf-lib";
const { PDFDocument, StandardFonts, rgb } = pdfLibPkg;

const PAGE_W = 612, PAGE_H = 792, MARGIN = 46;
const INK = rgb(0.09, 0.09, 0.11);
const FAINT = rgb(0.45, 0.45, 0.48);
const RULE = rgb(0.15, 0.15, 0.18);
const HEAD_FILL = rgb(0.93, 0.94, 0.96);
const GOLD = rgb(0.7, 0.55, 0.15);

function wrapText(font, size, text, maxWidth) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return [""];
  const lines = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (font.widthOfTextAtSize(test, size) > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function drawCheckbox(page, bold, x, y, checked, size) {
  size = size || 7;
  page.drawRectangle({ x, y: y - size * 0.2, width: size, height: size, borderColor: INK, borderWidth: 0.75 });
  if (checked) page.drawText("X", { x: x + size * 0.14, y: y - size * 0.05, size: size - 0.5, font: bold, color: INK });
}

class Writer {
  constructor(pdfDoc, font, bold, italic) {
    this.pdfDoc = pdfDoc;
    this.font = font; this.bold = bold; this.italic = italic;
    this.left = MARGIN; this.right = PAGE_W - MARGIN; this.width = this.right - this.left;
    this.newPage();
  }
  newPage() {
    this.page = this.pdfDoc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
  }
  down(n) { this.y -= n; }
  text(str, opts) {
    opts = opts || {};
    const size = opts.size || 9;
    const f = opts.bold ? this.bold : (opts.italic ? this.italic : this.font);
    const x = opts.x != null ? opts.x : this.left;
    this.page.drawText(String(str == null ? "" : str), { x, y: this.y, size, font: f, color: opts.color || INK });
    if (opts.advance !== false) this.down(opts.lineHeight || (size + 4));
  }
  centerText(str, opts) {
    opts = opts || {};
    const size = opts.size || 9;
    const f = opts.bold ? this.bold : this.font;
    const w = f.widthOfTextAtSize(String(str || ""), size);
    this.text(str, Object.assign({}, opts, { x: this.left + Math.max(0, (this.width - w) / 2) }));
  }
  wrapped(str, opts) {
    opts = opts || {};
    const size = opts.size || 9;
    const f = opts.bold ? this.bold : this.font;
    const maxW = opts.maxWidth || this.width;
    const lines = wrapText(f, size, str, maxW);
    lines.forEach((ln) => this.text(ln, opts));
    return lines.length;
  }
  hr(opts) {
    opts = opts || {};
    this.page.drawLine({ start: { x: this.left, y: this.y }, end: { x: this.right, y: this.y }, thickness: opts.thickness || 1, color: opts.color || RULE });
    this.down(opts.gap != null ? opts.gap : 10);
  }
  sectionTitle(str) {
    this.down(2);
    this.text(str.toUpperCase(), { bold: true, size: 9.5, color: rgb(0.03, 0.24, 0.43) });
    this.page.drawLine({ start: { x: this.left, y: this.y + 3 }, end: { x: this.right, y: this.y + 3 }, thickness: 0.6, color: rgb(0.75, 0.75, 0.78) });
    this.down(4);
  }
  field(label, value, opts) {
    opts = opts || {};
    const size = opts.size || 9;
    const labelW = this.font === this.bold ? 0 : this.bold.widthOfTextAtSize(label + "  ", size);
    const x = opts.x != null ? opts.x : this.left;
    this.page.drawText(label, { x, y: this.y, size, font: this.bold, color: INK });
    this.page.drawText(String(value == null ? "" : value), { x: x + labelW, y: this.y, size, font: this.font, color: INK });
    if (opts.advance !== false) this.down(opts.lineHeight || (size + 6));
  }

  /** Draw a bordered grid table. columns=[header,...] colWidths sum to this.width. rows=[[cell,...],...] */
  table(columns, colWidths, rows, opts) {
    opts = opts || {};
    const fontSize = opts.fontSize || 7.3;
    const pad = 3.5;
    let x = this.left;
    const headerH = fontSize + pad * 2 + 1;
    columns.forEach((h, i) => {
      this.page.drawRectangle({ x, y: this.y - headerH, width: colWidths[i], height: headerH, borderColor: INK, borderWidth: 0.75, color: HEAD_FILL });
      const lines = wrapText(this.bold, fontSize, h, colWidths[i] - pad * 2);
      lines.forEach((ln, li) => this.page.drawText(ln, { x: x + pad, y: this.y - pad - fontSize - li * (fontSize + 1), size: fontSize, font: this.bold, color: INK }));
      x += colWidths[i];
    });
    this.y -= headerH;

    rows.forEach((row) => {
      const cellLines = row.map((cell, i) => wrapText(this.font, fontSize, cell, colWidths[i] - pad * 2));
      const maxLines = Math.max(1, ...cellLines.map((l) => l.length));
      const rowH = maxLines * (fontSize + 2) + pad * 2;
      x = this.left;
      row.forEach((cell, i) => {
        this.page.drawRectangle({ x, y: this.y - rowH, width: colWidths[i], height: rowH, borderColor: rgb(0.4, 0.4, 0.42), borderWidth: 0.5 });
        cellLines[i].forEach((ln, li) => {
          this.page.drawText(ln, { x: x + pad, y: this.y - pad - fontSize - li * (fontSize + 2), size: fontSize, font: this.font, color: INK });
        });
        x += colWidths[i];
      });
      this.y -= rowH;
    });
    this.down(8);
  }

  /** Multi-column checkbox lists. columns = [{title?, items:[str,...], isChecked(item)=>bool}] */
  checkColumns(columns, opts) {
    opts = opts || {};
    const fontSize = opts.fontSize || 8;
    const gap = opts.gap != null ? opts.gap : 14;
    const n = columns.length;
    const colW = (this.width - gap * (n - 1)) / n;
    const startY = this.y;
    let minY = startY;
    columns.forEach((col, ci) => {
      let cy = startY;
      const x = this.left + ci * (colW + gap);
      (col.items || []).forEach((item) => {
        const checked = col.isChecked ? !!col.isChecked(item) : false;
        drawCheckbox(this.page, this.bold, x, cy, checked, fontSize - 1);
        const lines = wrapText(this.font, fontSize, item, colW - (fontSize + 8));
        lines.forEach((ln, li) => {
          this.page.drawText(ln, { x: x + fontSize + 5, y: cy - li * (fontSize + 1), size: fontSize, font: this.font, color: INK });
        });
        cy -= Math.max(fontSize + 6, lines.length * (fontSize + 1) + 5);
      });
      minY = Math.min(minY, cy);
    });
    this.y = minY - 4;
  }
}

async function newContext() {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setProducer("CANHS-DTS");
  pdfDoc.setCreator("CANHS-DTS");
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  return { pdfDoc, font, bold, italic };
}

function letterhead(w, schoolInfo, titleLines) {
  w.centerText("Republic of the Philippines", { size: 9, italic: true, color: FAINT });
  w.centerText("Department of Education", { size: 12, bold: true });
  const schName = (schoolInfo.schoolId ? schoolInfo.schoolId + " - " : "") + (schoolInfo.schoolName || "Castor Alviar National High School");
  w.centerText(schName, { size: 9.5, color: FAINT });
  w.down(4);
  w.page.drawLine({ start: { x: w.left, y: w.y }, end: { x: w.right, y: w.y }, thickness: 1.4, color: GOLD });
  w.down(12);
  (titleLines || []).forEach((t, i) => {
    w.centerText(t.text, { size: t.size || 13, bold: true, color: t.color || rgb(0.03, 0.24, 0.43) });
    w.down(i === titleLines.length - 1 ? 8 : 2);
  });
  w.hr({ gap: 10 });
}

function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
  catch (e) { return "—"; }
}
function fmtTime(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
  catch (e) { return "—"; }
}

/**
 * Submission and Routing Slip — page 1 is the office copy ("Action Taken"),
 * page 2 is the Claim Stub ("Acknowledgement of Receipt"), matching the
 * school's paper form and the on-screen printable modal.
 */
export async function buildRoutingSlipPdf({ doc, schoolInfo, constants }) {
  const { TRANSMITTAL_ACTIONS, ACTION_TAKEN_OPTIONS } = constants;
  const { pdfDoc, font, bold, italic } = await newContext();
  const hist = doc.history || [];

  function drawCopy(stub) {
    const w = new Writer(pdfDoc, font, bold, italic);
    if (pdfDoc.getPageCount() > 1) { /* already added via newPage below */ }
    letterhead(w, schoolInfo, stub
      ? [{ text: "CLAIM STUB", size: 10, color: GOLD }, { text: "SUBMISSION AND ROUTING SLIP" }]
      : [{ text: "SUBMISSION AND ROUTING SLIP" }]);

    w.field("Document Control Number:  ", doc.dtsNo, { x: w.left });
    w.field("Date:  ", fmtDate(doc.createdAt), { x: w.left + 260, advance: false });
    w.down(15);
    w.wrapped("Title:  " + (doc.title || ""), { size: 9.5, maxWidth: w.width });
    w.down(2);
    w.field("Document Owner:  ", doc.documentOwner || "—");
    w.field("Destination:  ", doc.destinationOfficeName || "—");
    w.field("No. of folder/box/envelope:  ", doc.foldersBoxes || "—", { advance: false });
    w.field("No. of pages:  ", doc.numPages || "—", { x: w.left + 260 });
    w.down(6);

    w.sectionTitle("Please check the appropriate action");
    const isChecked = (item) => doc.actionNeeded === item;
    w.checkColumns([
      { items: TRANSMITTAL_ACTIONS.col1, isChecked },
      { items: TRANSMITTAL_ACTIONS.col2, isChecked },
      { items: TRANSMITTAL_ACTIONS.col3.concat(["For appropriate action: " + (doc.actionNeeded === "Others" ? (doc.actionOtherText || "") : "__________")]), isChecked: (item) => item.indexOf("For appropriate action:") === 0 ? doc.actionNeeded === "Others" : isChecked(item) }
    ]);

    if (stub) {
      w.sectionTitle("Acknowledgement of Receipt");
      const rows = [];
      for (let i = 0; i < 5; i++) {
        const h = hist[i];
        rows.push(h ? [String(i + 1), h.officeName || "", fmtDate(h.at), ""] : [String(i + 1), "—", "—", ""]);
      }
      w.table(["No.", "Received by", "Date received", "Signature"], [30, w.width - 30 - 130 - 120, 130, 120], rows);
    } else {
      w.sectionTitle("Action Taken");
      const rows = [];
      for (let i = 0; i < 5; i++) {
        const h = hist[i];
        if (!h) { rows.push([String(i + 1), "—", "—", "—", "", "—"]); continue; }
        let actionText;
        if (i === 0) {
          actionText = "Forwarded to " + (h.officeName || "") + (h.remarks ? (" — \"" + h.remarks + "\"") : "");
        } else {
          const checked = ACTION_TAKEN_OPTIONS.filter((o) => (h.actionTaken || []).indexOf(o) >= 0);
          if (h.actionOther) checked.push(h.actionOther);
          actionText = checked.length ? checked.join("; ") : "—";
          if (h.remarks) actionText += (checked.length ? " — " : "") + "\"" + h.remarks + "\"";
        }
        rows.push([String(i + 1), h.officeName || "", fmtDate(h.at), fmtTime(h.at), actionText, h.byStaffName || ""]);
      }
      w.table(["No.", "Received by", "Date", "Time", "Action taken / remarks", "Signature"], [24, 95, 62, 55, w.width - 24 - 95 - 62 - 55 - 90, 90], rows);
      if (hist.length > 5) w.text("Showing the first 5 of " + hist.length + " routing actions — full history is in the app's document detail screen.", { size: 7.5, italic: true, color: FAINT });
    }
  }

  drawCopy(false);
  pdfDoc.addPage; // no-op reference to keep intent explicit
  // second page for the claim stub
  drawCopy(true);

  return pdfDoc.save();
}

/**
 * Transmittal Slip — single page, matching the school's paper form: document
 * details, destination (signatories checked from the current roster), the
 * 3-column "action to be taken" checklist, remarks, attachment, and the
 * Principal's signature line.
 */
export async function buildTransmittalSlipPdf({ t, schoolInfo, constants, personnelByCategory }) {
  const { TRANSMITTAL_ACTIONS, SIGNATORY_CATEGORIES } = constants;
  const { pdfDoc, font, bold, italic } = await newContext();
  const w = new Writer(pdfDoc, font, bold, italic);

  letterhead(w, schoolInfo, [{ text: "TRANSMITTAL SLIP" }]);

  w.field("Date:  ", fmtDate(t.date || t.sentAt), { x: w.left, advance: false });
  if (t.dtsNo) w.field("DTS No.:  ", t.dtsNo, { x: w.left + 260 });
  w.down(15);
  w.wrapped("Document Title:  " + (t.title || ""), { size: 9.5, maxWidth: w.width });
  w.down(6);

  const recipientIds = {};
  (t.recipients || []).forEach((r) => { if (r.id) recipientIds[r.id] = true; });
  const othersNames = (t.recipients || []).filter((r) => !r.id).map((r) => r.name);

  w.sectionTitle("Destination");
  const sigColumns = SIGNATORY_CATEGORIES.map((cat) => {
    const people = personnelByCategory(cat);
    return {
      items: people.length ? people.map((p) => p.name) : ["(none on file)"],
      isChecked: (name) => {
        const p = people.find((pp) => pp.name === name);
        return p ? !!recipientIds[p.id] : false;
      }
    };
  });
  w.checkColumns(sigColumns);
  if (othersNames.length) {
    w.text("Others:  " + othersNames.join(", "), { size: 8.5 });
    w.down(2);
  }

  w.sectionTitle("Action to be taken");
  const checkedActions = t.actionsToBeTaken || [];
  const isActChecked = (item) => checkedActions.indexOf(item) >= 0;
  w.checkColumns([
    { items: TRANSMITTAL_ACTIONS.col1, isChecked: isActChecked },
    { items: TRANSMITTAL_ACTIONS.col2, isChecked: isActChecked },
    { items: TRANSMITTAL_ACTIONS.col3.concat(["For appropriate action: " + (t.actionOtherText || "__________")]), isChecked: (item) => item.indexOf("For appropriate action:") === 0 ? !!t.actionOtherText : isActChecked(item) }
  ]);

  if (t.remarks) {
    w.sectionTitle("Remarks");
    w.wrapped(t.remarks, { size: 9 });
    w.down(4);
  }
  if (t.fileName) {
    w.text("Attachment:  " + t.fileName, { size: 9 });
  }

  w.down(26);
  const sigW = 230;
  const sigX = w.right - sigW;
  w.page.drawLine({ start: { x: sigX, y: w.y }, end: { x: w.right, y: w.y }, thickness: 0.8, color: INK });
  w.down(11);
  const nameW = bold.widthOfTextAtSize(t.principalName || schoolInfo.principalName || "", 10);
  w.page.drawText(t.principalName || schoolInfo.principalName || "", { x: sigX + Math.max(0, (sigW - nameW) / 2), y: w.y, size: 10, font: bold, color: INK });
  w.down(12);
  const titleTxt = t.principalTitle || schoolInfo.principalTitle || "";
  const titleW = font.widthOfTextAtSize(titleTxt, 8.5);
  w.page.drawText(titleTxt, { x: sigX + Math.max(0, (sigW - titleW) / 2), y: w.y, size: 8.5, font, color: FAINT });

  return pdfDoc.save();
}
