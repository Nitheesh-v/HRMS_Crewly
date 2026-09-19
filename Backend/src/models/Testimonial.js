import mongoose from 'mongoose';

const testimonialSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    role: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    company: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    avatarUrl: {
      type: String,
      default: '',
      trim: true,
    },
    avatarInitial: {
      type: String,
      default: '',
      trim: true,
      maxlength: 2,
    },
    rating: {
      type: Number,
      min: 1,
      max: 5,
      default: 5,
    },
    quote: {
      type: String,
      required: true,
      trim: true,
      maxlength: 600,
    },
    verified: {
      type: Boolean,
      default: true,
    },
    featured: {
      type: Boolean,
      default: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

testimonialSchema.index({ isActive: 1, featured: -1, sortOrder: 1, createdAt: -1 });

const Testimonial = mongoose.model('Testimonial', testimonialSchema);
export default Testimonial;
