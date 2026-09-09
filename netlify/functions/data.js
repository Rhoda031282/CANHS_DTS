// Castor Alviar NHS — Document Tracking System
// Backend API: reads and writes shared data using Netlify Blobs, sends email
// (via SMTP/nodemailer) and SMS (via Semaphore) notifications, and stores
// uploaded files for the Principal's Transmittal Slip.
// This single function backs every screen in public/index.html.

const { getStore } = require("@netlify/blobs");

const STORE_NAME = "canhs-dts";
const FILES_STORE_NAME = "canhs-dts-files";

const DEFAULT_OFFICES = [
  "Office of the School Principal", "Office of the Assistant Principal", "Registrar's Office",
  "Guidance Office", "Records / Administrative Office", "Property & Supply Office",
  "Accounting / Disbursing Office", "General Services"
];

// Fixed checklist vocabulary — matches the school's actual paper forms.
const ACTION_NEEDED_OPTIONS = ["For signature/approval", "For review/comment", "For filing", "For recommendation", "Others"];
const ACTION_TAKEN_OPTIONS = ["reviewed/approved", "reviewed/for revision", "incomplete attachment/return to owner", "noted/for filing"];
const TRANSMITTAL_ACTIONS = {
  col1: ["Congratulations!", "Thanks for your effort", "Let us discuss", "For submission/DTS", "For filing", "For dissemination"],
  col2: ["For your information", "For comment", "For checking", "For signature", "For compliance", "For implementation"],
  col3: ["Please give an update", "Please draft a reply", "Please prepare response", "Please review/recommend", "Please prepare indorsement"]
};
// Signatory directory for the Transmittal Slip — limited to 3 per category per school request.
const PERSONNEL_SEED = [
  { name: "Gerald M. Flores", category: "Department Head" },
  { name: "Luz D. Gibas", category: "Department Head" },
  { name: "Catherine B. Canape", category: "Department Head" },
  { name: "JMar I. Almazan", category: "Master Teacher" },
  { name: "Rio R. Avila", category: "Master Teacher" },
  { name: "Rey Gene B. Cordovilla", category: "Master Teacher" },
  { name: "Marilou Lladones", category: "SPC/Finance" },
  { name: "Klein Angelo B. Estenor", category: "SPC/Finance" },
  { name: "Brian Kenneth Q. Sipriaso", category: "SPC/Finance" }
];

function uid(prefix) { return prefix + Math.random().toString(36).slice(2, 9); }
function randCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ123456789";
  let s = "";
  for (let i = 0; i < 3; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function nowIso() { return new Date().toISOString(); }
function escHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

async function getJSON(store, key, fallback) {
  const v = await store.get(key, { type: "json" });
  return v == null ? fallback : v;
}

/* ============================================================
   Notifications — email via SMTP (nodemailer) and SMS via
   Semaphore (semaphore.co). Both are optional: if the matching
   environment variables are not set in the Netlify site (Site
   settings → Environment variables), sending is skipped and the
   API call that triggered it still succeeds normally.
   ============================================================ */

async function sendEmail({ to, subject, html, attachments }) {
  if (!to) return { sent: false, reason: "no_recipient" };
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return { sent: false, reason: "not_configured" };
  }
  try {
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_PORT) === "465",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to, subject, html, attachments: attachments || []
    });
    return { sent: true };
  } catch (e) {
    console.error("[email] send failed:", e);
    return { sent: false, reason: String((e && e.message) || e) };
  }
}

function normalizePhone(n) {
  n = String(n || "").replace(/[^0-9+]/g, "");
  if (n.startsWith("+63")) return "0" + n.slice(3);
  if (n.startsWith("63") && n.length === 12) return "0" + n.slice(2);
  return n;
}

async function sendSms(number, message) {
  if (!number) return { sent: false, reason: "no_recipient" };
  if (!process.env.SEMAPHORE_API_KEY) return { sent: false, reason: "not_configured" };
  try {
    const params = new URLSearchParams();
    params.set("apikey", process.env.SEMAPHORE_API_KEY);
    params.set("number", normalizePhone(number));
    params.set("message", String(message).slice(0, 600));
    if (process.env.SEMAPHORE_SENDER_NAME) params.set("sendername", process.env.SEMAPHORE_SENDER_NAME);
    const res = await fetch("https://api.semaphore.co/api/v4/messages", { method: "POST", body: params });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { sent: false, reason: data ? JSON.stringify(data) : ("http_" + res.status) };
    return { sent: true, data };
  } catch (e) {
    console.error("[sms] send failed:", e);
    return { sent: false, reason: String((e && e.message) || e) };
  }
}

// Notify the document owner (the "origin" of the file) by email + SMS
// whenever their submission is logged, routed, or its status changes.
async function notifyOwner(doc, schoolInfo, headline) {
  const shortName = (schoolInfo.schoolName || "Castor Alviar NHS").replace(/National High School/i, "NHS");
  const subject = "[" + (schoolInfo.schoolId || "") + "-" + shortName + "] " + headline + " — " + doc.dtsNo;
  const html =
    "<p>Hello " + escHtml(doc.documentOwner) + ",</p>" +
    "<p>" + escHtml(headline) + " for your document <strong>" + escHtml(doc.title) + "</strong>.</p>" +
    "<p><strong>Document Control No.:</strong> " + escHtml(doc.dtsNo) + "<br>" +
    "<strong>Current status:</strong> " + escHtml(doc.status) + "<br>" +
    "<strong>Current office:</strong> " + escHtml(doc.destinationOfficeName) + "</p>" +
    "<p>You can check this anytime on the school's Document Tracking System using the Document Control Number above.</p>" +
    "<p>— " + escHtml(schoolInfo.schoolName || "Castor Alviar National High School") + " Document Tracking System</p>";
  const smsText = (schoolInfo.schoolId || "") + " DTS " + doc.dtsNo + ": " + headline + ". Status: " + doc.status + " at " + doc.destinationOfficeName + ".";

  const email = await sendEmail({ to: doc.email, subject, html });
  const sms = await sendSms(doc.contactNo, smsText);
  return { email, sms };
}

/* ============================================================ */

async function ensureSeeded(store) {
  const seeded = await store.get("seeded", { type: "json" });
  if (seeded) return;

  const offices = {};
  DEFAULT_OFFICES.forEach((name, i) => { const id = "off_" + i; offices[id] = { id, name, order: i }; });
  const offByName = (n) => { for (const k in offices) if (offices[k].name === n) return k; return Object.keys(offices)[0]; };

  const staff = {
    st_1: { id: "st_1", name: "Ruby B. Rodelas", title: "School Incharge", officeId: offByName("Records / Administrative Office"), role: "admin", pin: "1234" },
    st_2: { id: "st_2", name: "Registrar Clerk", title: "Registrar's Office Staff", officeId: offByName("Registrar's Office"), role: "staff", pin: "2222" }
  };

  const schoolInfo = {
    schoolId: "301527", schoolName: "Castor Alviar National High School",
    address: "Masili, Calamba City, Laguna", contact: "", email: "",
    principalName: "Rhoda O. Dela Cruz", principalTitle: "School Principal"
  };

  const personnel = {};
  PERSONNEL_SEED.forEach((p) => { const id = uid("per_"); personnel[id] = { id, name: p.name, category: p.category, email: "" }; });

  function dtsNo(seq, code) { return schoolInfo.schoolId + "-" + code + "-2026-" + String(seq).padStart(6, "0"); }
  function mkDoc(id, seq, code, type, title, owner, contact, email, folders, numPages, destName, action, subType, status, hist, daysAgo) {
    const created = new Date(Date.now() - daysAgo * 86400000).toISOString();
    return {
      id, dtsNo: dtsNo(seq, code), docType: type, title, documentOwner: owner, contactNo: contact, email,
      foldersBoxes: folders, numPages: numPages,
      destinationOfficeId: offByName(destName), destinationOfficeName: destName, actionNeeded: action, actionOtherText: "",
      submissionType: subType, fileLink: "", status, sample: true, createdAt: created, updatedAt: hist[hist.length - 1].at,
      createdBy: "Ruby B. Rodelas", history: hist
    };
  }

  const documents = {};
  documents.doc_1 = mkDoc("doc_1", 1220, "QTP", "DepEd Order / Advisory", "DepEd Order No. 010, s. 2026 – Revised School Calendar for SY 2026-2027",
    "Office of the School Principal", "09171934722", "principal@canhs.deped.gov.ph", "1 folder", "3", "Office of the School Principal", "For filing", "Hard Copy", "In Process",
    [
      { label: "Received at Records / Administrative Office", status: "Pending", remarks: "Received via SDO liaison.", byStaffName: "Ruby B. Rodelas", officeName: "Records / Administrative Office", actionTaken: [], actionOther: "", at: new Date(Date.now() - 6 * 86400000).toISOString() },
      { label: "Forwarded to Office of the School Principal", status: "In Process", remarks: "For instruction and dissemination to department heads.", byStaffName: "Ruby B. Rodelas", officeName: "Office of the School Principal", actionTaken: ["noted/for filing"], actionOther: "", at: new Date(Date.now() - 5 * 86400000).toISOString() }
    ], 6);
  documents.doc_2 = mkDoc("doc_2", 1221, "OQ8", "Request", "Application for Leave (Form 6) of Reynalyn Romales (Study Leave)",
    "Reynalyn Romales", "09175551234", "reynalyn.romales@deped.gov.ph", "—", "1", "Records / Administrative Office", "For signature/approval", "Hard Copy", "Released / Completed",
    [
      { label: "Received at Records / Administrative Office", status: "Pending", remarks: "Walk-in submission.", byStaffName: "Ruby B. Rodelas", officeName: "Records / Administrative Office", actionTaken: [], actionOther: "", at: new Date(Date.now() - 4 * 86400000).toISOString() },
      { label: "Marked In Process", status: "In Process", remarks: "Endorsed for approval.", byStaffName: "Ruby B. Rodelas", officeName: "Records / Administrative Office", actionTaken: ["reviewed/approved"], actionOther: "", at: new Date(Date.now() - 3 * 86400000).toISOString() },
      { label: "Marked Released / Completed", status: "Released / Completed", remarks: "Approved and released to employee 201 file.", byStaffName: "Ruby B. Rodelas", officeName: "Records / Administrative Office", actionTaken: ["noted/for filing"], actionOther: "", at: new Date(Date.now() - 2 * 86400000).toISOString() }
    ], 4);
  documents.doc_3 = mkDoc("doc_3", 1222, "JFD", "Report", "September 2026 Monthly Accomplishment Report",
    "Office of the School Principal", "09171934722", "principal@canhs.deped.gov.ph", "—", "5", "Records / Administrative Office", "For filing", "Soft Copy", "Pending",
    [
      { label: "Logged for transmittal at Records / Administrative Office", status: "Pending", remarks: "Awaiting Principal's signature before transmittal to SDO.", byStaffName: "Ruby B. Rodelas", officeName: "Records / Administrative Office", actionTaken: [], actionOther: "", at: new Date(Date.now() - 1 * 86400000).toISOString() }
    ], 1);
  documents.doc_4 = mkDoc("doc_4", 1223, "OTM", "Letter / Communication", "Clearance of Leila L. Aniel re Division Clearance for Retirement from Service",
    "Leila L. Aniel", "09171934722", "ruby.rodelas@deped.gov.ph", "1 envelope", "1", "Registrar's Office", "For signature/approval", "Hard Copy", "In Process",
    [
      { label: "Received at Records / Administrative Office", status: "Pending", remarks: "", byStaffName: "Ruby B. Rodelas", officeName: "Records / Administrative Office", actionTaken: [], actionOther: "", at: new Date(Date.now() - 2 * 86400000).toISOString() },
      { label: "Forwarded to Registrar's Office", status: "In Process", remarks: "For preparation of clearance and Form 137.", byStaffName: "Registrar Clerk", officeName: "Registrar's Office", actionTaken: ["reviewed/approved"], actionOther: "", at: new Date(Date.now() - 1.2 * 86400000).toISOString() }
    ], 2);

  const messages = {
    msg_1: {
      id: "msg_1", dtsNo: documents.doc_4.dtsNo, subject: "Follow-up DTS No. " + documents.doc_4.dtsNo,
      from: schoolInfo.schoolId + "-Castor Alviar NHS", body: "Please attach the notarized affidavit before we can process the clearance further.",
      sentAt: new Date(Date.now() - 1 * 86400000).toISOString(), read: true
    }
  };

  await store.setJSON("offices", offices);
  await store.setJSON("staff", staff);
  await store.setJSON("documents", documents);
  await store.setJSON("messages", messages);
  await store.setJSON("schoolInfo", schoolInfo);
  await store.setJSON("personnel", personnel);
  await store.setJSON("transmittals", {});
  await store.setJSON("counter", 1223);
  await store.setJSON("seeded", true);
}

function publicStaff(staff) {
  const out = {};
  Object.keys(staff).forEach((id) => {
    const rest = Object.assign({}, staff[id]);
    delete rest.pin;
    out[id] = rest;
  });
  return out;
}

async function loadAll(store) {
  const [offices, staff, documents, messages, schoolInfo, personnel, transmittals] = await Promise.all([
    getJSON(store, "offices", {}), getJSON(store, "staff", {}), getJSON(store, "documents", {}),
    getJSON(store, "messages", {}), getJSON(store, "schoolInfo", {}), getJSON(store, "personnel", {}),
    getJSON(store, "transmittals", {})
  ]);
  return {
    offices, documents, messages, schoolInfo, personnel, transmittals,
    staffPublic: publicStaff(staff),
    actionNeededOptions: ACTION_NEEDED_OPTIONS, actionTakenOptions: ACTION_TAKEN_OPTIONS, transmittalActions: TRANSMITTAL_ACTIONS
  };
}

function officeName(offices, id) { return (offices[id] && offices[id].name) || "—"; }

exports.handler = async function (event) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  };
  const ok = (body) => ({ statusCode: 200, headers, body: JSON.stringify(body) });
  const err = (message) => ok({ ok: false, error: message });

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const store = getStore(STORE_NAME);
  const filesStore = getStore(FILES_STORE_NAME);

  try {
    await ensureSeeded(store);

    if (event.httpMethod === "GET") {
      return ok(await loadAll(store));
    }
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
    }

    const body = JSON.parse(event.body || "{}");
    const op = body.op;

    if (op === "login") {
      const staff = await getJSON(store, "staff", {});
      const s = staff[body.staffId];
      if (!s || String(s.pin) !== String(body.pin)) return ok({ ok: false });
      const rest = Object.assign({}, s);
      delete rest.pin;
      return ok({ ok: true, staff: rest });
    }

    // File uploads live in their own store, keyed independently of the JSON collections.
    if (op === "uploadFile") {
      const { filename, mimeType, dataBase64 } = body;
      if (!dataBase64) return err("No file data received.");
      const buffer = Buffer.from(dataBase64, "base64");
      if (buffer.length > 4.5 * 1024 * 1024) return err("File is too large (max ~4 MB).");
      const fileId = uid("file_");
      await filesStore.set(fileId, buffer, { metadata: { filename: filename || "attachment", mimeType: mimeType || "application/octet-stream", size: buffer.length } });
      return ok({ ok: true, fileId, filename, mimeType, size: buffer.length });
    }

    const offices = await getJSON(store, "offices", {});
    const staff = await getJSON(store, "staff", {});
    const documents = await getJSON(store, "documents", {});
    const messages = await getJSON(store, "messages", {});
    const personnel = await getJSON(store, "personnel", {});
    const transmittals = await getJSON(store, "transmittals", {});
    let schoolInfo = await getJSON(store, "schoolInfo", {});
    const actorName = (id) => (staff[id] && staff[id].name) || "Staff";

    let newId = null;
    let notify = null;

    if (op === "addDocument") {
      const p = body.payload || {};
      let counter = await getJSON(store, "counter", 0);
      counter += 1;
      await store.setJSON("counter", counter);
      const code = randCode();
      const year = new Date().getFullYear();
      const dtsNo = (schoolInfo.schoolId || "301527") + "-" + code + "-" + year + "-" + String(counter).padStart(6, "0");
      const id = uid("doc_");
      const ts = nowIso();
      const destName = officeName(offices, p.destinationOfficeId);
      const doc = {
        id, dtsNo, docType: p.docType, title: p.title, documentOwner: p.documentOwner, contactNo: p.contactNo,
        email: p.email, foldersBoxes: p.foldersBoxes || "", numPages: p.numPages || "",
        destinationOfficeId: p.destinationOfficeId, destinationOfficeName: destName,
        actionNeeded: p.actionNeeded, actionOtherText: p.actionOtherText || "", submissionType: p.submissionType, fileLink: p.fileLink || "",
        status: "Pending", sample: false, createdAt: ts, updatedAt: ts, createdBy: actorName(body.actorStaffId),
        history: [{ label: "Forwarded to " + destName, status: "Pending", remarks: "", byStaffName: actorName(body.actorStaffId), officeName: destName, actionTaken: [], actionOther: "", at: ts }]
      };
      documents[id] = doc;
      await store.setJSON("documents", documents);
      newId = id;
      notify = await notifyOwner(doc, schoolInfo, "Your document has been received and logged");
    } else if (op === "forwardDocument") {
      const d = documents[body.docId];
      if (!d) return err("Document not found");
      const ts = nowIso();
      const destName = officeName(offices, body.toOfficeId);
      d.history = (d.history || []).concat([{
        label: "Forwarded to " + destName, status: "In Process", remarks: body.remarks || "",
        byStaffName: actorName(body.actorStaffId), officeName: destName,
        actionTaken: Array.isArray(body.actionTaken) ? body.actionTaken : [], actionOther: body.actionOther || "",
        at: ts
      }]);
      d.destinationOfficeId = body.toOfficeId;
      d.destinationOfficeName = destName;
      d.status = "In Process";
      d.updatedAt = ts;
      await store.setJSON("documents", documents);
      notify = await notifyOwner(d, schoolInfo, "Your document has been forwarded to " + destName);
    } else if (op === "updateStatus") {
      const d = documents[body.docId];
      if (!d) return err("Document not found");
      const ts = nowIso();
      d.history = (d.history || []).concat([{
        label: "Marked " + body.status, status: body.status, remarks: body.remarks || "",
        byStaffName: actorName(body.actorStaffId), officeName: d.destinationOfficeName,
        actionTaken: Array.isArray(body.actionTaken) ? body.actionTaken : [], actionOther: body.actionOther || "",
        at: ts
      }]);
      d.status = body.status;
      d.updatedAt = ts;
      await store.setJSON("documents", documents);
      notify = await notifyOwner(d, schoolInfo, "Your document status has been updated to “" + body.status + "”");
    } else if (op === "sendMessage") {
      const d = documents[body.docId];
      if (!d) return err("Document not found");
      const id = uid("msg_");
      messages[id] = {
        id, dtsNo: d.dtsNo, subject: body.subject, body: body.body,
        from: (schoolInfo.schoolId || "") + "-" + (schoolInfo.schoolName || "").replace(/National High School/i, "NHS"),
        sentAt: nowIso(), read: false
      };
      await store.setJSON("messages", messages);
    } else if (op === "markMessagesRead") {
      Object.values(messages).forEach((m) => { m.read = true; });
      await store.setJSON("messages", messages);
    } else if (op === "addOffice") {
      const id = uid("off_");
      offices[id] = { id, name: body.name, order: Object.keys(offices).length };
      await store.setJSON("offices", offices);
    } else if (op === "removeOffice") {
      const inUse = Object.values(documents).some((d) => d.destinationOfficeId === body.id) || Object.values(staff).some((s) => s.officeId === body.id);
      if (inUse) return err("Can't remove — office is in use by staff or documents.");
      delete offices[body.id];
      await store.setJSON("offices", offices);
    } else if (op === "addStaff") {
      if (!body.name || !/^[0-9]{4}$/.test(body.pin)) return err("Enter a name and a 4-digit PIN.");
      const id = uid("st_");
      staff[id] = { id, name: body.name, title: body.title || "Staff", officeId: body.officeId, role: body.role, pin: body.pin };
      await store.setJSON("staff", staff);
    } else if (op === "removeStaff") {
      const admins = Object.values(staff).filter((s) => s.role === "admin");
      if (staff[body.id] && staff[body.id].role === "admin" && admins.length <= 1) return err("Can't remove the last admin account.");
      delete staff[body.id];
      await store.setJSON("staff", staff);
    } else if (op === "saveSchoolInfo") {
      schoolInfo = body.data;
      await store.setJSON("schoolInfo", schoolInfo);
    } else if (op === "clearSamples") {
      Object.keys(documents).forEach((id) => { if (documents[id].sample) delete documents[id]; });
      await store.setJSON("documents", documents);
    } else if (op === "savePersonnelEmail") {
      if (personnel[body.id]) { personnel[body.id].email = body.email || ""; await store.setJSON("personnel", personnel); }
    } else if (op === "sendTransmittal") {
      const p = body.payload || {};
      const linkedDoc = p.dtsId ? documents[p.dtsId] : null;
      const ts = nowIso();

      // Keep the personnel directory's saved emails up to date.
      (p.recipients || []).forEach((r) => {
        if (r.id && personnel[r.id] && r.email && personnel[r.id].email !== r.email) personnel[r.id].email = r.email;
      });
      await store.setJSON("personnel", personnel);

      let attachment = null;
      if (p.fileId) {
        const entry = await filesStore.getWithMetadata(p.fileId, { type: "buffer" });
        if (entry) attachment = { filename: (entry.metadata && entry.metadata.filename) || "attachment", content: entry.data, contentType: entry.metadata && entry.metadata.mimeType };
      }

      const principalName = schoolInfo.principalName || "Rhoda O. Dela Cruz";
      const principalTitle = schoolInfo.principalTitle || "School Principal";
      const actionsChecked = (p.actionsToBeTaken || []).concat(p.actionOtherText ? ["For appropriate action: " + p.actionOtherText] : []);

      const results = [];
      for (const r of (p.recipients || [])) {
        if (!r.email) { results.push({ recipient: r.name, sent: false, reason: "no_email" }); continue; }
        const subject = "Transmittal Slip — " + (p.title || (linkedDoc && linkedDoc.title) || "Document") + (linkedDoc ? " (DTS " + linkedDoc.dtsNo + ")" : "");
        const html =
          "<p>Dear " + escHtml(r.name) + ",</p>" +
          "<p>The Office of the School Principal is transmitting the following document to you for appropriate action:</p>" +
          "<p><strong>Document Title:</strong> " + escHtml(p.title || (linkedDoc && linkedDoc.title) || "") + "<br>" +
          (linkedDoc ? ("<strong>Document Control No. (DTS):</strong> " + escHtml(linkedDoc.dtsNo) + "<br><strong>Current status:</strong> " + escHtml(linkedDoc.status) + "<br>") : "") +
          "<strong>Date:</strong> " + escHtml(new Date(ts).toLocaleDateString()) + "</p>" +
          (actionsChecked.length ? ("<p><strong>Action to be taken:</strong><br>" + actionsChecked.map(escHtml).join("<br>") + "</p>") : "") +
          (p.remarks ? ("<p><strong>Remarks:</strong> " + escHtml(p.remarks) + "</p>") : "") +
          "<p>" + (attachment ? "The file is attached to this email." : "") + "</p>" +
          "<p>Respectfully,<br><strong>" + escHtml(principalName) + "</strong><br>" + escHtml(principalTitle) + "</p>";
        const emailResult = await sendEmail({ to: r.email, subject, html, attachments: attachment ? [attachment] : [] });
        results.push({ recipient: r.name, email: r.email, sent: emailResult.sent, reason: emailResult.reason });
      }

      const id = uid("tr_");
      transmittals[id] = {
        id, dtsId: p.dtsId || null, dtsNo: linkedDoc ? linkedDoc.dtsNo : "", title: p.title || (linkedDoc && linkedDoc.title) || "",
        date: ts, recipients: p.recipients || [], actionsToBeTaken: p.actionsToBeTaken || [], actionOtherText: p.actionOtherText || "",
        remarks: p.remarks || "", fileId: p.fileId || "", fileName: (attachment && attachment.filename) || "",
        principalName, principalTitle, sentAt: ts, sentBy: actorName(body.actorStaffId), results
      };
      await store.setJSON("transmittals", transmittals);

      if (linkedDoc) {
        linkedDoc.history = (linkedDoc.history || []).concat([{
          label: "Transmittal slip sent to " + (p.recipients || []).map((r) => r.name).join(", "),
          status: linkedDoc.status, remarks: p.remarks || "", byStaffName: actorName(body.actorStaffId),
          officeName: linkedDoc.destinationOfficeName, actionTaken: [], actionOther: "", at: ts
        }]);
        linkedDoc.updatedAt = ts;
        await store.setJSON("documents", documents);
      }

      const data = await loadAll(store);
      return ok({ ok: true, data, id, results });
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Unknown op" }) };
    }

    const data = await loadAll(store);
    return ok(Object.assign({ ok: true, data }, newId ? { id: newId } : {}, notify ? { notify } : {}));
  } catch (e) {
    console.error("[data function] error:", e);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: String((e && e.message) || e) }) };
  }
};
