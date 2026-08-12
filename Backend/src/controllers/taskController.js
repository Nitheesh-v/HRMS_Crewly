import Task, { TASK_STATUS } from '../models/Task.js';
import Project from '../models/Project.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { getScopedUserIds } from '../utils/scope.js';
import { notifyUser } from '../utils/notify.js';
import {  cloudinaryReady } from '../config/cloudinary.js';
import cloudinary  from '../config/cloudinary.js';
// ── WORKFLOW SWITCH ──────────────────────────────────────────────
// true  → employee submits IN_REVIEW; TL/Manager approves to COMPLETED (Phase-11 workflow)
// false → employees may mark their own tasks COMPLETED directly
const REQUIRE_REVIEW = true;
// ─────────────────────────────────────────────────────────────────

const ADMIN_ROLES = ['COMPANY_ADMIN', 'HR_MANAGER'];
const ASSIGN_ROLES = ['COMPANY_ADMIN', 'HR_MANAGER', 'MANAGER', 'TEAM_LEAD'];
const EMPLOYEE_TARGETS = REQUIRE_REVIEW ? ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED'] : TASK_STATUS;

const isAdmin = (req) => ADMIN_ROLES.includes(req.user.role);

const ok = (res, status, data, message) =>
  res.status(status).json({ statusCode: status, success: true, data, message });

const notify = async (userId, payload) => {
  try {
    if (userId) await notifyUser(userId, payload);
  } catch (e) { /* silent */ }
};

const canViewTask = async (req, task) => {
  const me = String(req.user._id);
  if (isAdmin(req)) return true;
  if (String(task.assignedTo) === me || String(task.assignedBy) === me) return true;

  const scope = await getScopedUserIds(req);
  if (!scope) return true;
  if (scope.map(String).includes(String(task.assignedTo))) return true;

  if (task.project) {
    const prj = await Project.findById(task.project).select('manager teamLeads members department');
    if (prj) {
      if ([prj.manager, ...(prj.teamLeads || []), ...(prj.members || [])].some((u) => String(u) === me)) return true;
      if (req.user.role === 'MANAGER' && req.user.department && String(prj.department || '') === String(req.user.department)) return true;
    }
  }
  return false;
};

const canReviewTask = async (req, task) => {
  const me = String(req.user._id);
  if (isAdmin(req)) return true;
  if (String(task.assignedBy) === me) return true;
  if (!ASSIGN_ROLES.includes(req.user.role)) return false;
  const scope = await getScopedUserIds(req);
  if (!scope) return true;
  return scope.map(String).includes(String(task.assignedTo));
};

// GET /api/tasks
export const listTasks = asyncHandler(async (req, res) => {
  const filter = { company: req.companyId };
  const scope = await getScopedUserIds(req);
  if (scope) {
    filter.$or = [{ assignedTo: { $in: scope } }, { assignedBy: req.user._id }];
  }

  const { status, priority, project, assignee, q, view } = req.query;
  if (status) filter.status = status;
  if (priority) filter.priority = priority;
  if (project) filter.project = project;
  if (assignee) filter.assignedTo = assignee;
  if (view === 'mine') filter.assignedTo = req.user._id;
  if (view === 'created') filter.assignedBy = req.user._id;
  if (q) filter.title = { $regex: q, $options: 'i' };

  const tasks = await Task.find(filter)
    .populate('assignedTo', 'name email role avatarUrl')
    .populate('assignedBy', 'name')
    .populate('project', 'name status')
    .sort({ createdAt: -1 })
    .limit(300);

  ok(res, 200, tasks, 'Tasks fetched');
});

// GET /api/tasks/:id
export const getTask = asyncHandler(async (req, res) => {
  const task = await Task.findOne({ _id: req.params.id, company: req.companyId });
  if (!task) throw new ApiError(404, 'Task not found');
  if (!(await canViewTask(req, task))) throw new ApiError(403, 'This task is outside your visibility');

  await task.populate([
    { path: 'assignedTo', select: 'name email role designation avatarUrl' },
    { path: 'assignedBy', select: 'name email role' },
    { path: 'reviewedBy', select: 'name' },
    { path: 'project', select: 'name status' },
    { path: 'comments.user', select: 'name avatarUrl role' },
    { path: 'attachments.uploadedBy', select: 'name' },
  ]);

  ok(res, 200, task, 'Task fetched');
});

// POST /api/tasks  — TL/Manager/Admin assign; fan-out per employee
export const createTask = asyncHandler(async (req, res) => {
  if (!ASSIGN_ROLES.includes(req.user.role)) {
    throw new ApiError(403, 'Employees cannot assign tasks — ask your Team Lead or Manager');
  }
  const { title, description = '', projectId = null, assigneeIds = [], priority = 'MEDIUM', dueDate = null } = req.body;
  if (!title?.trim()) throw new ApiError(400, 'Task title is required');

  const assignees = [...new Set(assigneeIds.map(String))];
  if (!assignees.length) throw new ApiError(400, 'Pick at least one employee');

  // 1) same-company validation on EVERY assignee (API-bypass proof)
  const users = await User.find({ _id: { $in: assignees } }).select('name role companyId');
  if (users.length !== assignees.length) throw new ApiError(400, 'One or more assignees not found');
  users.forEach((u) => {
    if (String(u.companyId) !== String(req.companyId)) {
      throw new ApiError(403, `${u.name} does not belong to your company`);
    }
  });

  // 2) a TL assigns only to EMPLOYEES (their reports) or themselves
  if (req.user.role === 'TEAM_LEAD') {
    const notEmployee = users.filter((u) => u.role !== 'EMPLOYEE' && String(u._id) !== String(req.user._id));
    if (notEmployee.length) {
      throw new ApiError(403, 'Team Leads can only assign tasks to employees under them');
    }
  }

  // 3) org-scope: TL → reports+self, Manager → department, Admin/HR → everyone
  const scope = await getScopedUserIds(req);
  if (scope) {
    const allowed = new Set(scope.map(String));
    if (assignees.some((a) => !allowed.has(a))) {
      throw new ApiError(403, 'You can only assign tasks inside your own team');
    }
  }

  // 4) project rules (spec: manager monitors once TLs exist; TL owns task assignment)
  let project = null;
  if (projectId) {
    project = await Project.findOne({ _id: projectId, company: req.companyId });
    if (!project) throw new ApiError(404, 'Project not found');

    const me = String(req.user._id);
    if (req.user.role === 'TEAM_LEAD' && !(project.teamLeads || []).map(String).includes(me)) {
      throw new ApiError(403, 'You are not a Team Lead of this project');
    }
    if (req.user.role === 'MANAGER' && (project.teamLeads || []).length > 0) {
      throw new ApiError(403, 'This project has Team Leads — they assign tasks to the team. You monitor 📊');
    }
  }

  const docs = await Task.insertMany(
    assignees.map((a) => ({
      title: title.trim(),
      description,
      company: req.companyId,
      project: projectId || null,
      assignedTo: a,
      assignedBy: req.user._id,
      priority,
      dueDate: dueDate || null,
    }))
  );

  // assignees become project members → they can SEE the project (spec: employees see their projects)
  if (project) {
    await Project.updateOne(
      { _id: project._id },
      { $addToSet: { members: { $each: docs.map((d) => d.assignedTo) } } }
    );
  }

  docs.forEach((t) => {
    if (String(t.assignedTo) !== String(req.user._id)) {
      notify(t.assignedTo, { title: '📝 New task assigned', message: `"${t.title}" was assigned to you`, link: '/app/tasks' });
    }
  });

  ok(res, 201, docs, `${docs.length} task(s) created`);
});

// PUT /api/tasks/:id
export const updateTask = asyncHandler(async (req, res) => {
  const task = await Task.findOne({ _id: req.params.id, company: req.companyId });
  if (!task) throw new ApiError(404, 'Task not found');

  const isCreator = String(task.assignedBy) === String(req.user._id);
  if (!isAdmin(req) && !isCreator) {
    throw new ApiError(403, 'Only the task creator or company admin can edit details');
  }

  const { title, description, priority, dueDate, projectId, assignedToId } = req.body;
  if (title !== undefined) task.title = title.trim();
  if (description !== undefined) task.description = description;
  if (priority) task.priority = priority;
  if (dueDate !== undefined) task.dueDate = dueDate || null;
  if (projectId !== undefined) task.project = projectId || null;

  if (assignedToId) {
    const [u] = await User.find({ _id: assignedToId }).select('name companyId').limit(1);
    if (u && String(u.companyId) !== String(req.companyId)) throw new ApiError(403, 'Assignee must belong to your company');
    const scope = await getScopedUserIds(req);
    if (scope && !scope.map(String).includes(String(assignedToId))) {
      throw new ApiError(403, 'You can only assign inside your team');
    }
    task.assignedTo = assignedToId;
    notify(assignedToId, { title: '📝 Task reassigned to you', message: `"${task.title}"`, link: '/app/tasks' });
  }

  await task.save();
  ok(res, 200, task, 'Task updated');
});

// PATCH /api/tasks/:id/status
export const updateTaskStatus = asyncHandler(async (req, res) => {
  const task = await Task.findOne({ _id: req.params.id, company: req.companyId });
  if (!task) throw new ApiError(404, 'Task not found');

  const { status, note = '' } = req.body;
  if (!TASK_STATUS.includes(status)) throw new ApiError(400, 'Invalid status');

  const me = String(req.user._id);
  const isAssignee = String(task.assignedTo) === me;
  const reviewer = await canReviewTask(req, task);

  if (!reviewer) {
    if (!isAssignee) throw new ApiError(403, 'This task is outside your visibility');
    if (task.status === 'COMPLETED') throw new ApiError(403, 'Already completed — ask your reviewer to reopen it');
    if (!EMPLOYEE_TARGETS.includes(status)) {
      throw new ApiError(403, 'Only your reviewer can mark a task COMPLETED — submit it for review instead');
    }
  }

  const prev = task.status;
  task.status = status;
  if (status === 'IN_REVIEW') task.submittedAt = new Date();
  if (status === 'COMPLETED') {
    task.completedAt = new Date();
    task.reviewedBy = req.user._id;
    if (note) task.reviewNote = note;
  }
  if (prev === 'IN_REVIEW' && status !== 'COMPLETED') {
    task.reviewedBy = req.user._id;
    if (note) task.reviewNote = note;
  }
  await task.save();

  if (isAssignee && status === 'IN_REVIEW') {
    notify(task.assignedBy, { title: '📤 Task ready for review', message: `"${task.title}" was submitted for review`, link: '/app/tasks' });
  }
  if (!isAssignee && String(task.assignedTo) !== me) {
    const title = status === 'COMPLETED'
      ? '✅ Task approved'
      : prev === 'IN_REVIEW' && status === 'IN_PROGRESS'
        ? '🔁 Task sent back for rework'
        : `Task moved to ${status}`;
    notify(task.assignedTo, { title, message: `"${task.title}"${note ? ` — ${note}` : ''}`, link: '/app/tasks' });
  }

  ok(res, 200, task, 'Status updated');
});

// POST /api/tasks/:id/comments
export const addComment = asyncHandler(async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) throw new ApiError(400, 'Comment text is required');

  const task = await Task.findOne({ _id: req.params.id, company: req.companyId });
  if (!task) throw new ApiError(404, 'Task not found');
  if (!(await canViewTask(req, task))) throw new ApiError(403, 'This task is outside your visibility');

  task.comments.push({ user: req.user._id, text: text.trim() });
  await task.save();

  const me = String(req.user._id);
  if (String(task.assignedTo) !== me) {
    notify(task.assignedTo, { title: '💬 New comment on your task', message: `"${task.title}"`, link: '/app/tasks' });
  } else if (String(task.assignedBy) !== me) {
    notify(task.assignedBy, { title: '💬 New comment', message: `"${task.title}"`, link: '/app/tasks' });
  }

  await task.populate({ path: 'comments.user', select: 'name avatarUrl role' });
  ok(res, 201, task.comments, 'Comment added');
});

// POST /api/tasks/:id/attachments
export const uploadAttachment = asyncHandler(async (req, res) => {
  const task = await Task.findOne({ _id: req.params.id, company: req.companyId });
  if (!task) throw new ApiError(404, 'Task not found');
  if (!(await canViewTask(req, task))) throw new ApiError(403, 'This task is outside your visibility');
  if (!req.file) throw new ApiError(400, 'No file uploaded');

  const isImage = /^image\//.test(req.file.mimetype);
  const resourceType = isImage ? 'image' : 'raw';
  let url = null;
  let publicId = null;

  if (cloudinaryReady) {
    try {
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: `crewly/${req.companyId}/tasks`, resource_type: resourceType },
          (err, r) => (err ? reject(err) : resolve(r))
        );
        stream.end(req.file.buffer);
      });
      url = result.secure_url;
      publicId = result.public_id;
    } catch (e) {
      url = null;
    }
  }
  if (!url) url = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

  task.attachments.push({ name: req.file.originalname, url, publicId, resourceType, size: req.file.size, uploadedBy: req.user._id });
  await task.save();
  ok(res, 201, task.attachments, 'Attachment uploaded');
});

// DELETE /api/tasks/:id/attachments/:attachmentId
export const deleteAttachment = asyncHandler(async (req, res) => {
  const task = await Task.findOne({ _id: req.params.id, company: req.companyId });
  if (!task) throw new ApiError(404, 'Task not found');

  const att = task.attachments.id(req.params.attachmentId);
  if (!att) throw new ApiError(404, 'Attachment not found');

  const me = String(req.user._id);
  const allowed = isAdmin(req) || String(task.assignedBy) === me || String(att.uploadedBy) === me;
  if (!allowed) throw new ApiError(403, 'You cannot remove this attachment');

  att.deleteOne();
  await task.save();
  ok(res, 200, task.attachments, 'Attachment removed');
});

// DELETE /api/tasks/:id
export const deleteTask = asyncHandler(async (req, res) => {
  const task = await Task.findOne({ _id: req.params.id, company: req.companyId });
  if (!task) throw new ApiError(404, 'Task not found');

  const isCreator = String(task.assignedBy) === String(req.user._id);
  if (!isAdmin(req) && !isCreator) throw new ApiError(403, 'Only the task creator or company admin can delete');

  await task.deleteOne();
  ok(res, 200, { id: req.params.id }, 'Task deleted');
});