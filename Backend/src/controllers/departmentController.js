import Department from '../models/Department.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';

// GET /api/departments — list with member counts (all company users can view)
export const getDepartments = asyncHandler(async (req, res) => {
  const departments = await Department.find({
      companyId: req.companyId,
      // 🔒 Phase 10 — a manager sees only their own department; Admin/HR see all
      ...(req.user.role === 'MANAGER' && req.user.department ? { _id: req.user.department } : {}),
    }).sort('name');

  const counts = await User.aggregate([
    { $match: { companyId: req.companyId, status: 'ACTIVE', department: { $ne: null } } },
    { $group: { _id: '$department', count: { $sum: 1 } } },
  ]);
  const countMap = {};
  counts.forEach((c) => { countMap[c._id.toString()] = c.count; });

  const data = departments.map((d) => ({
    ...d.toObject(),
    memberCount: countMap[d._id.toString()] || 0,
  }));

  ApiResponse.success(res, { message: 'Departments', data });
});

// POST /api/departments
export const createDepartment = asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  const department = await Department.create({ name, description, companyId: req.companyId });
  ApiResponse.created(res, { message: 'Department created', data: department });
});

// PUT /api/departments/:id
export const updateDepartment = asyncHandler(async (req, res) => {
  const department = await Department.findOneAndUpdate(
    { _id: req.params.id, companyId: req.companyId }, // tenant-scoped!
    { $set: { name: req.body.name, description: req.body.description, status: req.body.status } },
    { new: true, runValidators: true }
  );
  if (!department) throw ApiError.notFound('Department not found');
  ApiResponse.success(res, { message: 'Department updated', data: department });
});

// DELETE /api/departments/:id — blocked while members are assigned
export const deleteDepartment = asyncHandler(async (req, res) => {
  const department = await Department.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!department) throw ApiError.notFound('Department not found');

  const members = await User.countDocuments({ department: department._id, companyId: req.companyId, status: 'ACTIVE' });
  if (members > 0) {
    throw ApiError.conflict(`Cannot delete — ${members} active employee(s) are in this department. Reassign them first.`);
  }

  await department.deleteOne();
  ApiResponse.success(res, { message: 'Department deleted' });
});