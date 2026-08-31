// ============================================================
// 👤 PROFILE CONTROLLER — self-service "My Profile" (ALL roles)
// Hardened: if Cloudinary upload throws (bad keys/quota/network)
// → graceful inline fallback instead of a 500.
// ============================================================
import * as UserNS from '../models/User.js';
import * as asyncHandlerNS from '../utils/asyncHandler.js';
import cloudinary, { cloudinaryReady } from '../config/cloudinary.js';

const pickModel = (ns) =>
  typeof ns.default === 'function' ? ns.default : ns.default || ns;
const User = pickModel(UserNS);
const asyncHandler =
  typeof asyncHandlerNS.default === 'function'
    ? asyncHandlerNS.default
    : asyncHandlerNS.asyncHandler;

// ⚠️ Whitelist — role / salary / reportingTo can NEVER be self-edited
const SELF_EDITABLE = ['phone', 'gender', 'dateOfBirth', 'address', 'emergencyContact', 'bankAccount', 'ifsc'];

// ── GET my profile ──────────────────────────────────────────────────────────
const getMyProfile = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const user = await User.findById(req.user._id)
    .populate('department', 'name')
    .populate('reportingTo', 'name designation role')
    .lean();
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  // Data to frontend - response to frontend
  res.json({ success: true, data: user });
});

// ── UPDATE my profile (whitelisted fields only) ─────────────────────────────
const updateMyProfile = asyncHandler(async (req, res) => {
  const updates = {};
  SELF_EDITABLE.forEach((key) => {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  });
  if (updates.gender === '') delete updates.gender;

  // DB Logic - DB logics
  const user = await User.findByIdAndUpdate(
    // Data from frontend - requests from frontend
    req.user._id,
    { $set: updates },
    { new: true, runValidators: true }
  )
    .populate('department', 'name')
    .populate('reportingTo', 'name designation role');

  // Data to frontend - response to frontend
  res.json({ success: true, message: 'Profile updated ✅', data: user });
});

// ── helper: stream buffer → Cloudinary ──────────────────────────────────────
const streamToCloudinary = (buffer, options) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) =>
      err ? reject(err) : resolve(result)
    );
    stream.end(buffer);
  });

// ── UPLOAD avatar (cloud → inline fallback, never 500s) ────────────────────
const uploadAvatar = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'Attach an image as field "avatar"' });
  }

  // DB Logic - DB logics
  const user = await User.findById(req.user._id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  let toCloud = false;
  if (cloudinaryReady) {
    try {
      if (user.avatarPublicId) {
        try { await cloudinary.uploader.destroy(user.avatarPublicId); } catch { /* ignore */ }
      }
      const result = await streamToCloudinary(req.file.buffer, {
        folder: `crewly/avatars/${req.companyId || 'platform'}`,
        public_id: `user-${user._id}`,
        overwrite: true,
        resource_type: 'image',
        transformation: [{ width: 256, height: 256, crop: 'fill', gravity: 'face', fetch_format: 'auto' }],
      });
      user.avatarUrl = result.secure_url;
      user.avatarPublicId = result.public_id;
      toCloud = true;
    } catch (cloudErr) {
      console.warn('☁️  Cloudinary avatar upload failed, inline fallback used:', cloudErr.message);
    }
  }
  if (!toCloud) {
    user.avatarUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    user.avatarPublicId = undefined;
  }

  await user.save();
  // Data to frontend - response to frontend
  res.json({
    success: true,
    message: toCloud ? 'Profile photo updated ☁️' : 'Profile photo updated (inline fallback mode)',
    data: { avatarUrl: user.avatarUrl },
  });
});

// ── REMOVE avatar ───────────────────────────────────────────────────────────
const removeAvatar = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const user = await User.findById(req.user._id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  if (cloudinaryReady && user.avatarPublicId) {
    try { await cloudinary.uploader.destroy(user.avatarPublicId); } catch { /* ignore */ }
  }
  user.avatarUrl = '';
  user.avatarPublicId = undefined;
  await user.save();
  // Data to frontend - response to frontend
  res.json({ success: true, message: 'Profile photo removed', data: { avatarUrl: '' } });
});

export { getMyProfile, updateMyProfile, uploadAvatar, removeAvatar };
export default { getMyProfile, updateMyProfile, uploadAvatar, removeAvatar };