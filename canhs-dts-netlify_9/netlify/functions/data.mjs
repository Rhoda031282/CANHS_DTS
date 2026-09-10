// Castor Alviar NHS — Document Tracking System
// Backend API: reads and writes shared data using Netlify Blobs, sends email
// (via SMTP/nodemailer) and SMS (via Semaphore) notifications, and stores
// uploaded files for the Principal's Transmittal Slip.
// This single function backs every screen in public/index.html.
//
// Written using the modern Netlify Functions (v2) API — a plain ESM module
// exporting a default (req, context) handler that returns a standard
// Response object. This matters for Netlify Blobs specifically: the
// automatic, zero-config `getStore(name)` context is only reliably injected
// for v2-style functions; the older `exports.handler = (event) => {...}`
// (v1/Lambda-compatible) signature can throw MissingBlobsEnvironmentError
// even when the code looks correct, because Netlify's Blobs auto-wiring
// happens through the v2 request pipeline.

import { getStore } from "@netlify/blobs";
import nodemailer from "nodemailer";
import { buildRoutingSlipPdf, buildTransmittalSlipPdf } from "./pdf-slips.mjs";

const STORE_NAME = "canhs-dts";
const FILES_STORE_NAME = "canhs-dts-files";

const DEFAULT_OFFICES = [
  "Office of the School Principal", "Office of the Assistant Principal", "Registrar's Office",
  "Guidance Office", "Records / Administrative Office", "Property & Supply Office",
  "Accounting / Disbursing Office", "General Services"
];

// Fixed checklist vocabulary — matches the school's actual paper forms.
const ACTION_TAKEN_OPTIONS = ["reviewed and approved", "reviewed, need revision", "noted, for filing"];
const TRANSMITTAL_ACTIONS = {
  col1: ["Congratulations!", "Thanks for your effort", "Let us discuss", "For submission/DTS", "For filing", "For dissemination"],
  col2: ["For your information", "For comment", "For checking", "For signature", "For compliance", "For implementation"],
  col3: ["Please give an update", "Please draft a reply", "Please prepare response", "Please review/recommend", "Please prepare indorsement"]
};
// The "Action Needed" dropdown on Send Documents reuses the same options as
// the Transmittal Slip's action checkboxes, plus "Others" for free text.
const ACTION_NEEDED_OPTIONS = TRANSMITTAL_ACTIONS.col1.concat(TRANSMITTAL_ACTIONS.col2, TRANSMITTAL_ACTIONS.col3, ["Others"]);
const TEMPLATE_CATEGORIES = ["DLL ILAW framework aligned", "BoW", "TOS", "Exam", "Monitoring and Evaluation Tools"];
const SIGNATORY_CATEGORIES = ["Department Head", "Master Teacher", "SPC/Finance"];
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
function nowIso() { return new Date().toISOString(); }
function initialsOf(name) { return String(name || "").trim().split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(0, 4) || "NA"; }
function slugTitle(title, maxLen) { return String(title || "").trim().replace(/[^A-Za-z0-9]+/g, "").slice(0, maxLen || 24) || "Document"; }

// Tracking / Document Control Number: "CANHS-yyyy-mm-001" — a running number
// that starts at 001 on the 1st of every month (a fresh count each month, not
// a single ever-increasing number). Stored as { "2026-09": 3, "2026-10": 1, ... }
// under the "counters" key so each month's sequence is independent.
async function nextTrackingNumber(store) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const periodKey = yyyy + "-" + mm;
  const counters = await getJSON(store, "counters", {});
  const next = (counters[periodKey] || 0) + 1;
  counters[periodKey] = next;
  await store.setJSON("counters", counters);
  return "CANHS-" + yyyy + "-" + mm + "-" + String(next).padStart(3, "0");
}
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

  // No sample/demo documents or messages are seeded — a freshly deployed site
  // starts completely empty and the first real submission gets "CANHS-yyyy-mm-001".
  const documents = {};
  const messages = {};

  await store.setJSON("offices", offices);
  await store.setJSON("staff", staff);
  await store.setJSON("documents", documents);
  await store.setJSON("messages", messages);
  await store.setJSON("schoolInfo", schoolInfo);
  await store.setJSON("personnel", personnel);
  await store.setJSON("transmittals", {});
  await store.setJSON("requests", {});
  await store.setJSON("templates", {});
  await store.setJSON("counters", {});
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
  const [offices, staff, documents, messages, schoolInfo, personnel, transmittals, requests, templates] = await Promise.all([
    getJSON(store, "offices", {}), getJSON(store, "staff", {}), getJSON(store, "documents", {}),
    getJSON(store, "messages", {}), getJSON(store, "schoolInfo", {}), getJSON(store, "personnel", {}),
    getJSON(store, "transmittals", {}), getJSON(store, "requests", {}), getJSON(store, "templates", {})
  ]);
  return {
    offices, documents, messages, schoolInfo, personnel, transmittals, requests, templates,
    staffPublic: publicStaff(staff),
    actionNeededOptions: ACTION_NEEDED_OPTIONS, actionTakenOptions: ACTION_TAKEN_OPTIONS, transmittalActions: TRANSMITTAL_ACTIONS,
    templateCategories: TEMPLATE_CATEGORIES
  };
}

function officeName(offices, id) { return (offices[id] && offices[id].name) || "—"; }

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

export default async (req, context) => {
  const ok = (body) => jsonResponse(200, body);
  const err = (message) => ok({ ok: false, error: message });

  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: CORS_HEADERS });

  try {
    const store = getStore(STORE_NAME);
    const filesStore = getStore(FILES_STORE_NAME);
    await ensureSeeded(store);

    if (req.method === "GET") {
      const url = new URL(req.url);
      if (url.searchParams.get("op") === "downloadFile") {
        const fileId = url.searchParams.get("fileId");
        const entry = fileId ? await filesStore.getWithMetadata(fileId, { type: "buffer" }) : null;
        if (!entry) return jsonResponse(404, { error: "File not found" });
        const desiredName = url.searchParams.get("name") || (entry.metadata && entry.metadata.filename) || "download";
        return new Response(entry.data, {
          status: 200,
          headers: Object.assign({}, CORS_HEADERS, {
            "Content-Type": (entry.metadata && entry.metadata.mimeType) || "application/octet-stream",
            "Content-Disposition": "attachment; filename=\"" + desiredName.replace(/"/g, "") + "\""
          })
        });
      }
      return ok(await loadAll(store));
    }
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "Method not allowed" });
    }

    const body = await req.json().catch(() => ({}));
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
    const requests = await getJSON(store, "requests", {});
    const templates = await getJSON(store, "templates", {});
    let schoolInfo = await getJSON(store, "schoolInfo", {});
    const actorName = (id) => (staff[id] && staff[id].name) || "Staff";

    let newId = null;
    let notify = null;

    if (op === "addDocument") {
      const p = body.payload || {};
      const dtsNo = await nextTrackingNumber(store);
      const id = uid("doc_");
      const ts = nowIso();
      const destName = officeName(offices, p.destinationOfficeId);

      // For an online submission with an uploaded file, rename it (for display/
      // download purposes) to "<tracking number>_<owner initials>_<short title>.<ext>"
      // now that the tracking number is known.
      let fileDisplayName = "", fileMimeType = "", fileSize = 0;
      if (p.fileId) {
        const entry = await filesStore.getWithMetadata(p.fileId, { type: "buffer" });
        if (entry) {
          const origName = (entry.metadata && entry.metadata.filename) || "file";
          const extMatch = origName.match(/\.[A-Za-z0-9]+$/);
          fileDisplayName = dtsNo + "_" + initialsOf(p.documentOwner) + "_" + slugTitle(p.title) + (extMatch ? extMatch[0] : "");
          fileMimeType = (entry.metadata && entry.metadata.mimeType) || "";
          fileSize = (entry.metadata && entry.metadata.size) || 0;
        }
      }

      const doc = {
        id, dtsNo, docType: p.docType, title: p.title, documentOwner: p.documentOwner, contactNo: p.contactNo,
        email: p.email, foldersBoxes: p.foldersBoxes || "", numPages: p.numPages || "",
        destinationOfficeId: p.destinationOfficeId, destinationOfficeName: destName,
        actionNeeded: p.actionNeeded, actionOtherText: p.actionOtherText || "", submissionType: p.submissionType, fileLink: p.fileLink || "",
        fileId: p.fileId || "", fileDisplayName, fileMimeType, fileSize,
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
    } else if (op === "addRequest") {
      const p = body.payload || {};
      if (!p.fromOfficeId || !p.title) return err("Choose an office and describe the document being requested.");
      const id = uid("req_");
      requests[id] = {
        id, requestedByStaffId: body.actorStaffId, requestedByName: actorName(body.actorStaffId),
        fromOfficeId: p.fromOfficeId, fromOfficeName: officeName(offices, p.fromOfficeId),
        title: p.title, note: p.note || "", status: "Open",
        createdAt: nowIso(), respondedAt: "", responseNote: "", responseFileId: "", responseFilename: ""
      };
      await store.setJSON("requests", requests);
    } else if (op === "respondRequest") {
      const r = requests[body.id];
      if (!r) return err("Request not found");
      r.status = "Fulfilled";
      r.respondedAt = nowIso();
      r.responseNote = body.note || "";
      r.responseFileId = body.fileId || "";
      if (body.fileId) {
        const entry = await filesStore.getWithMetadata(body.fileId, { type: "buffer" });
        r.responseFilename = (entry && entry.metadata && entry.metadata.filename) || "attachment";
      }
      await store.setJSON("requests", requests);
    } else if (op === "addTemplate") {
      const p = body.payload || {};
      if (!p.category || !p.title || !p.fileId) return err("Choose a category, title and file.");
      const id = uid("tpl_");
      templates[id] = {
        id, category: p.category, title: p.title, fileId: p.fileId, filename: p.filename || "file",
        uploadedBy: actorName(body.actorStaffId), uploadedAt: nowIso()
      };
      await store.setJSON("templates", templates);
    } else if (op === "removeTemplate") {
      delete templates[body.id];
      await store.setJSON("templates", templates);
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
    } else if (op === "generateSlipPdf") {
      // Renders a real PDF (server-side, via pdf-lib) for either printable
      // slip, saves it into the file repository (so it's there to download
      // again later), and hands back the fileId so the browser can also
      // trigger an immediate download of this copy.
      const kind = body.kind;
      const fileId = uid("file_");
      let bytes, filename;
      if (kind === "routingSlip") {
        const d = documents[body.recordId];
        if (!d) return err("Document not found");
        bytes = await buildRoutingSlipPdf({ doc: d, schoolInfo, constants: { TRANSMITTAL_ACTIONS, ACTION_TAKEN_OPTIONS } });
        filename = d.dtsNo + "_Routing-Slip.pdf";
        await filesStore.set(fileId, Buffer.from(bytes), { metadata: { filename, mimeType: "application/pdf", size: bytes.length } });
        d.generatedFiles = (d.generatedFiles || []).concat([{ fileId, filename, kind: "routingSlip", savedAt: nowIso(), savedBy: actorName(body.actorStaffId) }]);
        await store.setJSON("documents", documents);
      } else if (kind === "transmittalSlip") {
        const t = transmittals[body.recordId];
        if (!t) return err("Transmittal not found");
        bytes = await buildTransmittalSlipPdf({
          t, schoolInfo, constants: { TRANSMITTAL_ACTIONS, SIGNATORY_CATEGORIES },
          personnelByCategory: (cat) => Object.values(personnel).filter((p) => p.category === cat)
        });
        filename = "Transmittal-Slip_" + (t.dtsNo || t.id) + ".pdf";
        await filesStore.set(fileId, Buffer.from(bytes), { metadata: { filename, mimeType: "application/pdf", size: bytes.length } });
        t.generatedFiles = (t.generatedFiles || []).concat([{ fileId, filename, kind: "transmittalSlip", savedAt: nowIso(), savedBy: actorName(body.actorStaffId) }]);
        await store.setJSON("transmittals", transmittals);
      } else {
        return err("Unknown slip kind.");
      }
      const data = await loadAll(store);
      return ok({ ok: true, data, fileId, filename });
    } else {
      return jsonResponse(400, { ok: false, error: "Unknown op" });
    }

    const data = await loadAll(store);
    return ok(Object.assign({ ok: true, data }, newId ? { id: newId } : {}, notify ? { notify } : {}));
  } catch (e) {
    console.error("[data function] error:", e);
    return jsonResponse(500, { ok: false, error: String((e && e.message) || e) });
  }
};
