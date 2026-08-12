import mongoose from 'mongoose';
import Project from '../models/Project.js';
import Task from '../models/Task.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { getScopedUserIds } from '../utils/scope.js';
import { notifyUser } from '../utils/notify.js';

const ADMIN_ROLES = ['COMPANY_ADMIN', 'HR_MANAGER'];
const CREATE_ROLES = ['COMPANY_ADMIN', 'HR_MANAGER'];   // spec: only Admin/HR create projects
const MANAGER_CAPABLE = ['MANAGER', 'COMPANY_ADMIN', 'HR_MANAGER'];
const TL_CAPABLE = ['TEAM_LEAD', 'MANAGER'];

const isAdmin = (req) => ADMIN_ROLES.includes(req.user.role);

const ok = (res, status, data, message) =>
  res.status(status).json({ statusCode: status, success: true, data, message });

const notify = async (userId, payload) => {
  try {
    if (userId) await notifyUser(userId, payload);
  } catch (e) { /* notifications never block */ }
};

// Load users and HARD-validate same company
const getCompanyUsers = async (req, ids) => {
  const users = await User.find({ _id: { $in: ids } }).select('name role companyId');
  const map = new Map(users.map((u) => [String(u._id), u]));
  return ids.map((id) => map.get(String(id))); // undefined = not found
};

// ---- role-based project visibility ----
const projectScope = async (req) => {
  const base = { company: req.companyId };
  if (isAdmin(req)) return base;
  const or = [
    { manager: req.user._id },
    { teamLeads: req.user._id },
    { members: req.user._id },
  ];
  if (req.user.role === 'MANAGER' && req.user.department) {
    or.push({ department: req.user.department });
  }
  // TL/Employee also sees any project where they have a task
  if (['EMPLOYEE', 'TEAM_LEAD'].includes(req.user.role)) {
    const ids = await Task.distinct('project', {
      company: req.companyId,
      assignedTo: req.user._id,
      project: { $ne: null },
    });
    if (ids.length) or.push({ _id: { $in: ids } });
  }
  return { ...base, $or: or };
};

// GET /api/projects
export const listProjects = asyncHandler(async (req, res) => {
  const filter = await projectScope(req);
  if (req.query.status) filter.status = req.query.status;
  if (req.query.priority) filter.priority = req.query.priority;
  if (req.query.q) filter.name = { $regex: req.query.q, $options: 'i' };

  const projects = await Project.find(filter)
    .populate('manager', 'name email role avatarUrl')
    .populate('teamLeads', 'name email role avatarUrl')
    .populate('department', 'name')
    .sort({ createdAt: -1 });

  const stats = await Task.aggregate([
    { $match: { company: new mongoose.Types.ObjectId(String(req.companyId)), project: { $ne: null } } },
    {
      $group: {
        _id: '$project',
        total: { $sum: 1 },
        done: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
      },
    },
  ]);
  const byId = {};
  stats.forEach((s) => { byId[String(s._id)] = s; });

  const data = projects.map((p) => {
    const s = byId[String(p._id)] || { total: 0, done: 0 };
    return { ...p.toObject(), taskCount: s.total, doneCount: s.done, progress: s.total ? Math.round((s.done / s.total) * 100) : 0 };
  });

  ok(res, 200, data, 'Projects fetched');
});

// GET /api/projects/:id
export const getProject = asyncHandler(async (req, res) => {
  const project = await Project.findOne({ _id: req.params.id, company: req.companyId })
    .populate('manager', 'name email role avatarUrl')
    .populate('teamLeads', 'name email role avatarUrl')
    .populate('members', 'name email role designation avatarUrl')
    .populate('department', 'name');
  if (!project) throw new ApiError(404, 'Project not found');

  if (!isAdmin(req)) {
    const me = String(req.user._id);
    const involved = [project.manager, ...(project.teamLeads || []), ...(project.members || [])]
      .some((u) => String(u?._id || u) === me);
    const deptHit =
      req.user.role === 'MANAGER' &&
      req.user.department &&
      String(project.department?._id || project.department || '') === String(req.user.department);
    const hasTask = await Task.exists({ project: project._id, assignedTo: req.user._id });
    if (!involved && !deptHit && !hasTask) throw new ApiError(403, 'This project is outside your visibility');
  }

  const tasks = await Task.find({ project: project._id })
    .populate('assignedTo', 'name email role avatarUrl')
    .populate('assignedBy', 'name')
    .sort({ createdAt: -1 });

  const total = tasks.length;
  const done = tasks.filter((t) => t.status === 'COMPLETED').length;
  const stats = {
    total,
    done,
    inProgress: tasks.filter((t) => t.status === 'IN_PROGRESS').length,
    inReview: tasks.filter((t) => t.status === 'IN_REVIEW').length,
    blocked: tasks.filter((t) => t.status === 'BLOCKED').length,
    todo: tasks.filter((t) => t.status === 'TODO').length,
  };

  ok(res, 200, { project, tasks, stats, progress: total ? Math.round((done / total) * 100) : 0 }, 'Project fetched');
});

// POST /api/projects  (Admin/HR ONLY — assigns ONLY the Project Manager)
export const createProject = asyncHandler(async (req, res) => {
  if (!CREATE_ROLES.includes(req.user.role)) {
    throw new ApiError(403, 'Only Company Admin or HR can create projects');
  }
  const { name, description = '', managerId, departmentId, startDate, endDate, priority = 'MEDIUM' } = req.body;
  if (!name?.trim()) throw new ApiError(400, 'Project name is required');

  const managerFinal = managerId || req.user._id;
  const [mgr] = await getCompanyUsers(req, [managerFinal]);
  if (!mgr) throw new ApiError(400, 'Selected manager not found');
  if (String(mgr.companyId) !== String(req.companyId)) {
    throw new ApiError(400, 'Project Manager must belong to your company');
  }
  if (!MANAGER_CAPABLE.includes(mgr.role)) {
    throw new ApiError(400, `${mgr.name} does not have a manager-level role`);
  }

  const project = await Project.create({
    name: name.trim(),
    description,
    company: req.companyId,
    department: departmentId || null,
    manager: managerFinal,
    teamLeads: [],               // manager assigns TLs later — per spec
    members: [managerFinal],
    startDate: startDate || null,
    endDate: endDate || null,
    priority,
  });

  if (String(managerFinal) !== String(req.user._id)) {
    notify(managerFinal, {
      title: '📁 You are the Project Manager',
      message: `"${project.name}" was assigned to you — open it and assign your Team Leads`,
      link: `/app/projects/${project._id}`,
    });
  }

  ok(res, 201, project, 'Project created');
});

// PUT /api/projects/:id  (admin or the project's manager — manager assigns TLs + team here)
export const updateProject = asyncHandler(async (req, res) => {
  const project = await Project.findOne({ _id: req.params.id, company: req.companyId });
  if (!project) throw new ApiError(404, 'Project not found');

  const isManagerOfProject = String(project.manager) === String(req.user._id);
  if (!isAdmin(req) && !isManagerOfProject) {
    throw new ApiError(403, 'Only the project manager or company admin can manage this project');
  }

  const prevTLs = new Set((project.teamLeads || []).map(String));
  const prevMembers = new Set((project.members || []).map(String));
  const prevManager = String(project.manager);

  const scope = await getScopedUserIds(req); // manager → dept ids; admin → null
  const assertInScope = (ids, label) => {
    if (!scope) return;
    const allowed = new Set(scope.map(String));
    if (ids.some((x) => !allowed.has(String(x)))) {
      throw new ApiError(403, `${label} must be inside your department`);
    }
  };

  const { name, description, teamLeadIds, memberIds, startDate, endDate, priority, status, departmentId, managerId } = req.body;

  if (name !== undefined) project.name = name.trim();
  if (description !== undefined) project.description = description;
  if (startDate !== undefined) project.startDate = startDate || null;
  if (endDate !== undefined) project.endDate = endDate || null;
  if (priority) project.priority = priority;
  if (status) project.status = status;
  if (isAdmin(req) && departmentId !== undefined) project.department = departmentId || null;

  if (isAdmin(req) && managerId) {
    const [mgr] = await getCompanyUsers(req, [managerId]);
    if (!mgr) throw new ApiError(400, 'Selected manager not found');
    if (String(mgr.companyId) !== String(req.companyId)) throw new ApiError(400, 'Manager must belong to your company');
    if (!MANAGER_CAPABLE.includes(mgr.role)) throw new ApiError(400, `${mgr.name} does not have a manager-level role`);
    project.manager = managerId;
  }

  if (teamLeadIds !== undefined) {
    const ids = [...new Set(teamLeadIds.map(String))];
    const users = await getCompanyUsers(req, ids);
    if (users.some((u) => !u)) throw new ApiError(400, 'One or more Team Leads not found');
    users.forEach((u) => {
      if (String(u.companyId) !== String(req.companyId)) throw new ApiError(400, `${u.name} must belong to your company`);
      if (!TL_CAPABLE.includes(u.role)) throw new ApiError(400, `${u.name} is not a Team Lead`);
    });
    assertInScope(ids, 'Team Leads');
    project.teamLeads = ids;
  }

  if (memberIds !== undefined) {
    const ids = [...new Set(memberIds.map(String))];
    const users = await getCompanyUsers(req, ids);
    if (users.some((u) => !u)) throw new ApiError(400, 'One or more members not found');
    users.forEach((u) => {
      if (String(u.companyId) !== String(req.companyId)) throw new ApiError(400, `${u.name} must belong to your company`);
    });
    assertInScope(ids, 'Members');
    project.members = ids;
  }

  // Manager + TLs are always members
  const union = new Set((project.members || []).map(String));
  union.add(String(project.manager));
  (project.teamLeads || []).forEach((t) => union.add(String(t)));
  project.members = [...union];

  await project.save();

  // 🔔 assignment notifications
  if (String(project.manager) !== prevManager) {
    notify(project.manager, { title: '📁 You are the Project Manager', message: `"${project.name}" was assigned to you`, link: `/app/projects/${project._id}` });
  }
  (project.teamLeads || [])
    .filter((t) => !prevTLs.has(String(t)))
    .forEach((t) => notify(t, { title: '🧑‍🤝‍🧑 You are now Team Lead', message: `Project "${project.name}" — start assigning tasks to your team`, link: `/app/projects/${project._id}` }));
  project.members
    .filter((m) => !prevMembers.has(String(m)) && String(m) !== String(project.manager))
    .forEach((m) => notify(m, { title: '📁 Added to project', message: `You were added to project "${project.name}"`, link: `/app/projects/${project._id}` }));

  ok(res, 200, project, 'Project updated');
});

// DELETE /api/projects/:id  (admin only)
export const deleteProject = asyncHandler(async (req, res) => {
  if (!isAdmin(req)) throw new ApiError(403, 'Only Company Admin or HR can delete projects');
  const project = await Project.findOne({ _id: req.params.id, company: req.companyId });
  if (!project) throw new ApiError(404, 'Project not found');

  await Task.deleteMany({ project: project._id });
  await project.deleteOne();
  ok(res, 200, { id: req.params.id }, 'Project and its tasks deleted');
});