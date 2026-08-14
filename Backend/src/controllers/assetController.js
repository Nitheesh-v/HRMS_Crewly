// ============================================================
// 🖥 ASSET CONTROLLER — inventory, assign, return (history log)
// HR/Admin manage; employees view their own assets.
// ============================================================
import * as AssetNS from '../models/Asset.js';
import * as UserNS from '../models/User.js';
import asyncHandler from '../utils/asyncHandler.js';
import { notifySmart } from '../utils/notifyPref.js';

const pickModel = (ns) => (typeof ns.default === 'function' ? ns.default : ns.default || ns);
const Asset = pickModel(AssetNS);
const User = pickModel(UserNS);

const ok = (res, status, data, message) =>
  res.status(status).json({ statusCode: status, success: true, data, message });
const fail = (res, status, message) =>
  res.status(status).json({ statusCode: status, success: false, message });

const HR_ROLES = ['COMPANY_ADMIN', 'HR_MANAGER'];
const isHR = (req) => HR_ROLES.includes(req.user.role);
const CATS = ['LAPTOP', 'MONITOR', 'KEYBOARD', 'MOUSE', 'MOBILE', 'ID_CARD', 'OTHER'];

const notifyAsset = async (userId, payload) => {
  try {
    if (userId) await notifySmart(userId, { category: 'ASSET', ...payload });
  } catch {}
};

/* ── POST /assets — HR/Admin adds equipment ── */
export const createAsset = asyncHandler(async (req, res) => {
  if (!isHR(req)) return fail(res, 403, 'Only HR or the company admin manage assets');
  const { name, category = 'OTHER', serialNumber = '', note = '' } = req.body;
  if (!name?.trim()) return fail(res, 400, 'Asset name is required');

  const asset = await Asset.create({
    companyId: req.companyId,
    name: name.trim(),
    category: CATS.includes(category) ? category : 'OTHER',
    serialNumber: serialNumber.trim(),
    note: note.trim(),
  });
  ok(res, 201, asset, 'Asset added 🖥');
});

/* ── GET /assets?status= — HR/Admin inventory ── */
export const listAssets = asyncHandler(async (req, res) => {
  if (!isHR(req)) return fail(res, 403, 'Only HR or the company admin view inventory');
  const filter = { companyId: req.companyId };
  if (req.query.status && CATS && req.query.status !== 'ALL') filter.status = req.query.status;
  const rows = await Asset.find(filter)
    .populate('currentHolder', 'name email role designation')
    .populate('assignments.user', 'name')
    .sort('-createdAt')
    .limit(500)
    .lean();
  ok(res, 200, rows, 'Assets');
});

/* ── GET /assets/my — equipment in MY hands ── */
export const myAssets = asyncHandler(async (req, res) => {
  const rows = await Asset.find({ companyId: req.companyId, currentHolder: req.user._id })
    .sort('-updatedAt')
    .lean();
  ok(res, 200, rows, 'My assets');
});

/* ── POST /assets/:id/assign { userId, note } — HR/Admin ── */
export const assignAsset = asyncHandler(async (req, res) => {
  if (!isHR(req)) return fail(res, 403, 'Only HR or the company admin assign assets');
  const { userId, note = '' } = req.body;

  const [asset, employee] = await Promise.all([
    Asset.findOne({ _id: req.params.id, companyId: req.companyId }),
    User.findOne({ _id: userId, companyId: req.companyId }).select('name status'),
  ]);
  if (!asset) return fail(res, 404, 'Asset not found');
  if (!employee) return fail(res, 404, 'Employee not found in your company');
  if (asset.status !== 'AVAILABLE') return fail(res, 409, 'Asset is currently assigned — return it first');

  asset.status = 'ASSIGNED';
  asset.currentHolder = employee._id;
  asset.assignments.push({ user: employee._id, assignedAt: new Date(), assignedBy: req.user._id, note: note.trim() });
  await asset.save();

  notifyAsset(employee._id, {
    title: '🖥 Asset assigned to you',
    message: `${asset.name}${asset.serialNumber ? ` (S/N ${asset.serialNumber})` : ''} is now in your care${note ? ` — "${note}"` : ''}`,
    link: '/app/assets',
  });
  ok(res, 200, asset, `Assigned to ${employee.name} 🖥`);
});

/* ── POST /assets/:id/return { note } — HR/Admin ── */
export const returnAsset = asyncHandler(async (req, res) => {
  if (!isHR(req)) return fail(res, 403, 'Only HR or the company admin process returns');
  const { note = '' } = req.body;

  const asset = await Asset.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!asset) return fail(res, 404, 'Asset not found');
  if (asset.status !== 'ASSIGNED') return fail(res, 409, 'Asset is not assigned');

  const holderId = asset.currentHolder;
  const open = asset.assignments[asset.assignments.length - 1];
  if (open && !open.returnedAt) {
    open.returnedAt = new Date();
    open.returnedBy = req.user._id;
    open.returnNote = note.trim();
  }
  asset.status = 'AVAILABLE';
  asset.currentHolder = null;
  await asset.save();

  notifyAsset(holderId, { title: '↩️ Asset return confirmed', message: `${asset.name} was returned to the inventory. Thank you!`, link: '/app/assets' });
  ok(res, 200, asset, 'Asset returned — available again ✅');
});

/* ── DELETE /assets/:id — HR/Admin, only when AVAILABLE ── */
export const deleteAsset = asyncHandler(async (req, res) => {
  if (!isHR(req)) return fail(res, 403, 'Only HR or the company admin delete assets');
  const asset = await Asset.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!asset) return fail(res, 404, 'Asset not found');
  if (asset.status !== 'AVAILABLE') return fail(res, 409, 'Return the asset before deleting it');
  await asset.deleteOne();
  ok(res, 200, { id: asset._id }, 'Asset removed');
});