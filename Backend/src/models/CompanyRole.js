import mongoose from 'mongoose';

import { PAYROLL_SCOPE_LIST } from '../utils/payrollScope.js';

export const SYSTEM_COMPANY_ROLES = [
  'COMPANY_ADMIN',
  'HR_MANAGER',
  'MANAGER',
  'TEAM_LEAD',
  'EMPLOYEE',
];

const companyRoleSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },

    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },

    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },

    permissions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Permission',
      },
    ],

    // Phase 29.1 RBAC update — organizational scope.
    // `payrollScope` is the role's default data reach for payroll
    // (empty = derive from the role key). `permissionScopes` narrows or
    // widens that per permission, e.g. EMPLOYEE_SALARY_READ → OWN TEAM.
    payrollScope: {
      type: String,
      enum: ['', ...PAYROLL_SCOPE_LIST],
      default: '',
    },
    permissionScopes: [
      {
        _id: false,
        permission: {
          type: String,
          trim: true,
          uppercase: true,
        },
        scope: {
          type: String,
          enum: PAYROLL_SCOPE_LIST,
          default: 'COMPANY',
        },
      },
    ],

    // Links protected roles to existing User.role values.
    systemRoleKey: {
      type: String,
      enum: [
        '',
        ...SYSTEM_COMPANY_ROLES,
      ],
      default: '',
    },

    isSystemRole: {
      type: Boolean,
      default: false,
      index: true,
    },

permissionVersion: {
  type: Number,
  default: 0,
},

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

companyRoleSchema.index(
  {
    companyId: 1,
    code: 1,
  },
  {
    unique: true,
  }
);

companyRoleSchema.index(
  {
    companyId: 1,
    name: 1,
  },
  {
    unique: true,
  }
);

companyRoleSchema.index({
  companyId: 1,
  isActive: 1,
});

export default mongoose.model(
  'CompanyRole',
  companyRoleSchema
);

export { companyRoleSchema };