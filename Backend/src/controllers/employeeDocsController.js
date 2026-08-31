// ============================================================
// 📁 EMPLOYEE DOCUMENTS (Phase 14)
// HR: file cabinet per employee, upload on behalf, set expiry,
//     request documents. Employee: sees requests, fulfills them.
// Storage: Cloudinary (object storage) → Mongo keeps URL+metadata only.
// ============================================================
import * as DocumentNS from '../models/Document.js';
import * as DocumentRequestNS from '../models/DocumentRequest.js';
import * as UserNS from '../models/User.js';
import asyncHandler from '../utils/asyncHandler.js';
import { notifySmart } from '../utils/notifyPref.js';
import { cloudinaryReady } from '../config/cloudinary.js';
import cloudinary from '../config/cloudinary.js';

const pickModel = (ns) => (typeof ns.default === 'function' ? ns.default : ns.default || ns);
const Document = pickModel(DocumentNS);
const DocumentRequest = pickModel(DocumentRequestNS);
const User = pickModel(UserNS);

const ok = (res, status, data, message) =>
  res.status(status).json({ statusCode: status, success: true, data, message });
const fail = (res, status, message) =>
  res.status(status).json({ statusCode: status, success: false, message });

const HR_ROLES = ['COMPANY_ADMIN', 'HR_MANAGER'];
const isHR = (req) => HR_ROLES.includes(req.user.role);

// 🩹 grab the uploaded file no matter which form field carried it
const getFile = (req) => req.file || (Array.isArray(req.files) ? req.files[0] : null) || null;

export const DOC_CATEGORY_LABELS = {
  AADHAAR_ID: 'Aadhaar / ID',
  OFFER_LETTER: 'Offer Letter',
  JOINING_LETTER: 'Joining Letter',
  EXPERIENCE_LETTER: 'Experience Letter',
  SALARY_DOCUMENT: 'Salary Document',
  CERTIFICATE: 'Certificate',
  CONTRACT: 'Contract',
  OTHER: 'Other Document',
};
const DOC_CATEGORIES = Object.keys(DOC_CATEGORY_LABELS);
const labelOf = (c) => DOC_CATEGORY_LABELS[c] || 'Document';

const notifyDoc = async (userId, payload) => {
  try {
    if (userId) await notifySmart(userId, { category: 'DOCUMENT', ...payload });
  } catch {}
};

// ☁️ hardened upload path (cloud → inline fallback)
const uploadBuffer = async (companyId, file) => {
  const isImage = /^image\//.test(file.mimetype);
  const resourceType = isImage ? 'image' : 'raw';
  if (cloudinaryReady) {
    try {
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: `crewly/documents/${companyId}`, resource_type: resourceType },
          (err, r) => (err ? reject(err) : resolve(r))
        );
        stream.end(file.buffer);
      });
      return { url: result.secure_url, publicId: result.public_id };
    } catch { /* fall back to inline */ }
  }
  return { url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}`, publicId: '' };
};

const safeDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/* ── GET /documents/meta/categories — everyone (for selects) ── */
export const getDocCategories = asyncHandler(async (req, res) => {
  // Data to frontend - response to frontend
  ok(res, 200, DOC_CATEGORIES.map((value) => ({ value, label: DOC_CATEGORY_LABELS[value] })), 'Document categories');
});

/* ── GET /documents/employee/:userId — HR file cabinet ── */
export const employeeDocuments = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!isHR(req)) return fail(res, 403, 'Only HR or the company admin can open employee files');

  // DB Logic - DB logics
  const employee = await User.findOne({ _id: req.params.userId, companyId: req.companyId })
    .select('name email role designation department')
    .lean();
  if (!employee) return fail(res, 404, 'Employee not found in your company');

  const [documents, requests] = await Promise.all([
    Document.find({ companyId: req.companyId, user: req.params.userId })
      .populate('uploadedBy', 'name role')
      .sort('-createdAt')
      .lean(),
    DocumentRequest.find({ companyId: req.companyId, user: req.params.userId })
      .populate('requestedBy', 'name')
      .sort('-createdAt')
      .lean(),
  ]);

  // Data to frontend - response to frontend
  ok(res, 200, { employee, documents, requests }, 'Employee file cabinet');
});

/* ── POST /documents/for/:userId — HR uploads on behalf of an employee ── */
export const hrUploadDocument = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!isHR(req)) return fail(res, 403, 'Only HR or the company admin can upload employee documents');

  const file = getFile(req);
if (!file) {
      console.warn('📁 [docs] no file — content-type:', req.headers['content-type'], '| body keys:', Object.keys(req.body || {}), '| files:', Array.isArray(req.files) ? req.files.length : 0);
      return fail(res, 400, 'No file received by the server');
    }

  // DB Logic - DB logics
  const employee = await User.findOne({ _id: req.params.userId, companyId: req.companyId }).select('name');
  if (!employee) return fail(res, 404, 'Employee not found in your company');

  const { name, category = 'OTHER', expiryDate = null, note = '' } = req.body;
  const { url, publicId } = await uploadBuffer(req.companyId, file);

  const doc = await Document.create({
    companyId: req.companyId,
    user: employee._id,
    name: name?.trim() || file.originalname,
    category: DOC_CATEGORIES.includes(category) ? category : 'OTHER',
    fileUrl: url,
    publicId,
    mimeType: file.mimetype,
    size: file.size,
    expiryDate: safeDate(expiryDate),
    uploadedBy: req.user._id,
    note: note?.trim?.() || '',
  });

  notifyDoc(employee._id, {
    title: '📄 New document added to your file',
    message: `${doc.name} (${labelOf(doc.category)}) was uploaded by ${req.user.name}${doc.expiryDate ? ` · expires ${doc.expiryDate.toISOString().slice(0, 10)}` : ''}`,
    link: '/app/documents',
  });

  // Data to frontend - response to frontend
  ok(res, 201, doc, 'Document uploaded');
});

/* ── POST /documents/requests — HR asks an employee to upload ── */
export const createDocRequest = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!isHR(req)) return fail(res, 403, 'Only HR or the company admin can request documents');

  const { userId, category = 'OTHER', note = '', dueDate = null } = req.body;
  // DB Logic - DB logics
  const employee = await User.findOne({ _id: userId, companyId: req.companyId }).select('name');
  if (!employee) return fail(res, 404, 'Employee not found in your company');

  const request = await DocumentRequest.create({
    companyId: req.companyId,
    user: userId,
    category: DOC_CATEGORIES.includes(category) ? category : 'OTHER',
    note: note?.trim?.() || '',
    dueDate: safeDate(dueDate),
    requestedBy: req.user._id,
  });

  notifyDoc(userId, {
    title: '📥 Document requested',
    message: `${req.user.name} requested your ${labelOf(request.category)}${request.note ? ` — "${request.note}"` : ''}${request.dueDate ? ` · due ${request.dueDate.toISOString().slice(0, 10)}` : ''}`,
    link: '/app/documents',
  });

  // Data to frontend - response to frontend
  ok(res, 201, request, 'Document request sent');
});

/* ── GET /documents/requests/my — employee's request inbox ── */
export const myDocRequests = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const requests = await DocumentRequest.find({ companyId: req.companyId, user: req.user._id })
    .populate('requestedBy', 'name role')
    .sort('-createdAt')
    .lean();
  // Data to frontend - response to frontend
  ok(res, 200, requests, 'My document requests');
});

/* ── GET /documents/requests?userId=&status= — HR overview ── */
const DOC_REQUEST_FILTER = ['PENDING', 'FULFILLED', 'CANCELLED'];
export const listDocRequests = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!isHR(req)) return fail(res, 403, 'Only HR or the company admin can view document requests');

  const filter = { companyId: req.companyId };
  if (req.query.userId) filter.user = req.query.userId;
  if (req.query.status && DOC_REQUEST_FILTER.includes(req.query.status)) filter.status = req.query.status;

  // DB Logic - DB logics
  const requests = await DocumentRequest.find(filter)
    .populate('user', 'name email role designation')
    .populate('requestedBy', 'name')
    .sort('-createdAt')
    .limit(200)
    .lean();
  // Data to frontend - response to frontend
  ok(res, 200, requests, 'Document requests');
});

/* ── POST /documents/requests/:id/fulfill — employee uploads the requested file ── */
export const fulfillDocRequest = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const request = await DocumentRequest.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!request) return fail(res, 404, 'Request not found');
  // Data from frontend - requests from frontend
  if (String(request.user) !== String(req.user._id)) return fail(res, 403, 'This request is for another employee');
  if (request.status !== 'PENDING') return fail(res, 409, `This request is already ${request.status.toLowerCase()}`);

  const file = getFile(req);
  if (!file) return fail(res, 400, 'No file received by the server');

  const { url, publicId } = await uploadBuffer(req.companyId, file);

  const doc = await Document.create({
    companyId: req.companyId,
    user: req.user._id,
    name: req.body.name?.trim?.() || file.originalname,
    category: request.category,
    fileUrl: url,
    publicId,
    mimeType: file.mimetype,
    size: file.size,
    uploadedBy: req.user._id,
  });

  request.status = 'FULFILLED';
  request.fulfilledAt = new Date();
  request.document = doc._id;
  await request.save();

  notifyDoc(request.requestedBy, {
    title: '📄 Requested document uploaded',
    message: `${req.user.name} uploaded ${doc.name} (${labelOf(request.category)})`,
    link: '/app/employee-files',
  });

  // Data to frontend - response to frontend
  ok(res, 201, { request, document: doc }, 'Uploaded — request fulfilled ✅');
});

/* ── PATCH /documents/requests/:id/cancel — HR withdraws a pending request ── */
export const cancelDocRequest = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!isHR(req)) return fail(res, 403, 'Only HR or the company admin can cancel requests');

  // DB Logic - DB logics
  const request = await DocumentRequest.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!request) return fail(res, 404, 'Request not found');
  if (request.status !== 'PENDING') return fail(res, 409, 'Only pending requests can be cancelled');

  request.status = 'CANCELLED';
  await request.save();

  notifyDoc(request.user, {
    title: '📥 Document request withdrawn',
    message: `The ${labelOf(request.category)} request from HR was withdrawn`,
    link: '/app/documents',
  });

  // Data to frontend - response to frontend
  ok(res, 200, request, 'Request cancelled');
});