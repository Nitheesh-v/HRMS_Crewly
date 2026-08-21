import mongoose from 'mongoose';

export const PERMISSION_ACTIONS = [
  'READ',
  'CREATE',
  'UPDATE',
  'DELETE',
  'APPROVE',
  'REJECT',
  'EXPORT',
  'IMPORT',
  'MANAGE',
  'SUBMIT',
];

export const PERMISSION_SCOPES = [
  'ALL',
  'DEPARTMENT',
  'TEAM',
  'SELF',
];

const permissionSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },

    resource: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      index: true,
    },

    action: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      index: true,
    },

    scope: {
      type: String,
      enum: PERMISSION_SCOPES,
      default: 'ALL',
    },

    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: 300,
    },

    group: {
      type: String,
      default: '',
      uppercase: true,
      trim: true,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

permissionSchema.index({
  resource: 1,
  action: 1,
  scope: 1,
});

export default mongoose.model(
  'Permission',
  permissionSchema
);

export { permissionSchema };