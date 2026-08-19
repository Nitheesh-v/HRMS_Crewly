import api from './api.js';

const unwrap = (r) =>
  r?.data?.data ??
  r?.data ??
  r ??
  {};

const permissionService = {
  myPermissions: () =>
    api
      .get('/permissions/me')
      .then(unwrap),

  permissions: () =>
    api
      .get('/permissions')
      .then(unwrap),

  roles: () =>
    api
      .get('/roles')
      .then(unwrap),

  role: (roleId) =>
    api
      .get(`/roles/${roleId}`)
      .then(unwrap),

  createRole: (body) =>
    api
      .post('/roles', body)
      .then(unwrap),

  updateRole: (roleId, body) =>
    api
      .patch(
        `/roles/${roleId}`,
        body
      )
      .then(unwrap),

  duplicateRole: (
    roleId,
    body
  ) =>
    api
      .post(
        `/roles/${roleId}/duplicate`,
        body
      )
      .then(unwrap),

  deactivateRole: (roleId) =>
    api
      .delete(`/roles/${roleId}`)
      .then(unwrap),

  saveRolePermissions: (
    roleId,
    permissions
  ) =>
    api
      .put(
        `/roles/${roleId}/permissions`,
        { permissions }
      )
      .then(unwrap),

  users: () =>
    api
      .get('/users', {
        params: { limit: 500 },
      })
      .then(unwrap),

  assignUserRole: (
    userId,
    roleId
  ) =>
    api
      .patch(
        `/users/${userId}/role`,
        { roleId }
      )
      .then(unwrap),

  userPermissions: (userId) =>
    api
      .get(
        `/users/${userId}/permissions`
      )
      .then(unwrap),

  saveUserOverrides: (
    userId,
    overrides
  ) =>
    api
      .put(
        `/users/${userId}/permissions`,
        { overrides }
      )
      .then(unwrap),
};

export default permissionService;
export { permissionService };