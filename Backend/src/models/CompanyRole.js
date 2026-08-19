import mongoose from 'mongoose';

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