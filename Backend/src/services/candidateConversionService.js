import mongoose from 'mongoose';
import Candidate from '../models/Candidate.js';
import CandidateDocumentRequirement from '../models/CandidateDocumentRequirement.js';
import CandidateEmployeeConversion from '../models/CandidateEmployeeConversion.js';
import CandidateHistory from '../models/CandidateHistory.js';
import Company from '../models/Company.js';
import CompanyRole from '../models/CompanyRole.js';
import Department from '../models/Department.js';
import EmployeeLifecycle from '../models/EmployeeLifecycle.js';
import OfferLetter from '../models/OfferLetter.js';
import PreOnboarding from '../models/PreOnboarding.js';
import Shift from '../models/Shift.js';
import Subscription from '../models/Subscription.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import { ROLES } from '../utils/constants.js';
import { nextEmployeeCode } from '../utils/employeeIdentifiers.js';
import { notifyUser } from '../utils/notify.js';
import { recordAudit } from '../utils/securityauditService.js';
import {
  evaluatePreOnboardingReadiness,
} from './preOnboardingService.js';
import { transitionCandidateStage } from './candidatePipelineService.js';
import {
  generateUnusablePassword,
  resendAccountSetupForUser,
  sendAccountSetupInvitation,
} from './accountSetupService.js';
import { evaluateBgvForConversion } from './backgroundVerificationService.js';
import { bumpRecruitmentAnalyticsGeneration } from './analyticsCacheInvalidation.js';

const isObjectId = (value) => mongoose.isValidObjectId(value);

const cleanString = (value, maximum = 200) =>
  String(value || '').trim().slice(0, maximum);

const ASSIGNABLE_ROLES = [
  ROLES.EMPLOYEE,
  ROLES.TEAM_LEAD,
  ROLES.MANAGER,
  ROLES.HR_MANAGER,
];

const safeDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const timeline = async ({
  companyId,
  candidate,
  job,
  action,
  actorId = null,
  actorType = 'TENANT_USER',
  metadata = {},
}) =>
  CandidateHistory.create({
    companyId,
    candidate,
    job,
    action,
    source: 'PIPELINE',
    actorType,
    actor: actorId,
    metadata,
    eventAt: new Date(),
  });

const conversionDto = (row) => ({
  id: row._id,
  status: row.status,
  employeeId: row.employee || null,
  employeeCode: row.employeeCode || '',
  accountSetupStatus: row.accountSetupStatus,
  onboardingStarted: Boolean(row.onboardingStarted),
  convertedAt: row.convertedAt,
  snapshot: row.snapshot || {},
  failureCategory: row.failureCategory || '',
  failureMessage: row.failureMessage || '',
});

const employeeDto = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  employeeCode: user.employeeCode || '',
  designation: user.designation || '',
  dateOfJoining: user.dateOfJoining || null,
  department: user.department || null,
  reportingTo: user.reportingTo || null,
  candidateId: user.candidateId || null,
  accountSetupRequired: Boolean(user.accountSetupRequired),
  status: user.status,
});

const loadConversionContext = async ({ companyId, candidateRef }) => {
  const candidateFilter = isObjectId(candidateRef)
    ? { _id: candidateRef, companyId }
    : {
        companyId,
        candidateCode: String(candidateRef || '').trim().toUpperCase(),
      };

  const candidate = await Candidate.findOne(candidateFilter).lean();
  if (!candidate) throw ApiError.notFound('Candidate not found');

  const offer = await OfferLetter.findOne({
    companyId,
    candidate: candidate._id,
    status: 'ACCEPTED',
  })
    .sort({ acceptedAt: -1, createdAt: -1 })
    .lean();

  const preOnboarding = await PreOnboarding.findOne({
    companyId,
    candidate: candidate._id,
    status: 'READY_TO_JOIN',
    activeKey: 'ACTIVE',
  })
    .select('+activeKey')
    .lean();

  const requirements = preOnboarding
    ? await CandidateDocumentRequirement.find({
        companyId,
        preOnboarding: preOnboarding._id,
      })
        .sort({ displayOrder: 1 })
        .lean()
    : [];

  const readiness = evaluatePreOnboardingReadiness(requirements);

  return { candidate, offer, preOnboarding, requirements, readiness };
};

export const evaluateConversionEligibility = ({
  candidate,
  offer,
  preOnboarding,
  readiness,
}) => {
  const blockingReasons = [];

  if (!candidate) blockingReasons.push('Candidate was not found');
  if (candidate?.convertedUser) {
    blockingReasons.push('Candidate is already converted to an employee');
  }
  if (['JOINED', 'HIRED'].includes(candidate?.currentStage || candidate?.stage)) {
    blockingReasons.push('Candidate is already in JOINED stage');
  }
  if ((candidate?.currentStage || candidate?.stage) !== 'PRE_ONBOARDING') {
    blockingReasons.push('Candidate must be in PRE_ONBOARDING before conversion');
  }
  if (!offer || offer.status !== 'ACCEPTED') {
    blockingReasons.push('An accepted offer is required');
  }
  if (!preOnboarding || preOnboarding.status !== 'READY_TO_JOIN') {
    blockingReasons.push('Pre-onboarding must be READY_TO_JOIN');
  }
  if (preOnboarding && offer && String(preOnboarding.offer) !== String(offer._id)) {
    blockingReasons.push('Pre-onboarding is not linked to the accepted offer');
  }
  if (!readiness?.ready) {
    blockingReasons.push(
      ...(readiness?.blockingReasons?.length
        ? readiness.blockingReasons
        : ['All mandatory pre-onboarding documents must be verified'])
    );
  }

  return {
    eligible: blockingReasons.length === 0,
    blockingReasons,
  };
};

const mapCandidateToEmployeeFields = ({
  candidate,
  offer,
  payload = {},
}) => {
  const terms = offer?.terms || {};
  const compensation = offer?.compensationSnapshot || {};
  const joiningDate =
    safeDate(payload.joiningDate) ||
    safeDate(terms.joiningDate) ||
    safeDate(candidate.offerJoiningDate);

  return {
    name: cleanString(payload.name || candidate.name, 60) || candidate.name,
    email: String(candidate.email || '').toLowerCase().trim(),
    phone: cleanString(payload.phone || candidate.phone, 20),
    designation: cleanString(
      payload.designation || terms.designation || offer?.jobSnapshot?.title || '',
      80
    ),
    dateOfJoining: joiningDate,
    location: cleanString(
      payload.location || terms.location || candidate.location || '',
      120
    ),
    employmentType: cleanString(
      payload.employmentType || terms.employmentType || 'FULL_TIME',
      40
    ),
    compensationSummary: {
      currency: compensation.currency || 'INR',
      annualCTC: compensation.annualCTC || 0,
    },
  };
};

const validateInternalAssignments = async ({
  companyId,
  actorRole,
  payload = {},
}) => {
  const departmentId = payload.departmentId || null;
  const managerId = payload.managerId || payload.reportingTo || null;
  const shiftId = payload.shiftId || null;
  const role = String(payload.role || ROLES.EMPLOYEE).toUpperCase();

  if (!ASSIGNABLE_ROLES.includes(role)) {
    throw ApiError.forbidden('Selected role cannot be assigned during conversion');
  }
  if (role === ROLES.COMPANY_ADMIN || role === 'SUPER_ADMIN') {
    throw ApiError.forbidden('That role cannot be assigned during conversion');
  }

  // Actor may only assign roles they can create in normal user creation.
  const rights = {
    COMPANY_ADMIN: ASSIGNABLE_ROLES,
    HR_MANAGER: [ROLES.EMPLOYEE, ROLES.TEAM_LEAD, ROLES.MANAGER],
  };
  const allowed = rights[actorRole] || [ROLES.EMPLOYEE];
  if (!allowed.includes(role)) {
    throw ApiError.forbidden(`Your role cannot assign ${role}`);
  }

  let department = null;
  if (departmentId) {
    if (!isObjectId(departmentId)) throw ApiError.badRequest('Choose a valid department');
    department = await Department.findOne({ _id: departmentId, companyId })
      .select('_id name')
      .lean();
    if (!department) throw ApiError.badRequest('Department is not valid for your company');
  }

  let manager = null;
  if (managerId) {
    if (!isObjectId(managerId)) throw ApiError.badRequest('Choose a valid manager');
    manager = await User.findOne({
      _id: managerId,
      companyId,
      status: 'ACTIVE',
    })
      .select('_id name role')
      .lean();
    if (!manager) throw ApiError.badRequest('Reporting manager is not valid for your company');
  }

  let shift = null;
  if (shiftId) {
    if (!isObjectId(shiftId)) throw ApiError.badRequest('Choose a valid shift');
    shift = await Shift.findOne({ _id: shiftId, companyId, isActive: true })
      .select('_id name')
      .lean();
    if (!shift) throw ApiError.badRequest('Shift is not valid for your company');
  }

  let roleRef = null;
  if (payload.roleId) {
    if (!isObjectId(payload.roleId)) throw ApiError.badRequest('Choose a valid company role');
    roleRef = await CompanyRole.findOne({
      _id: payload.roleId,
      companyId,
      isActive: true,
    })
      .select('_id name code systemRoleKey')
      .lean();
    if (!roleRef) throw ApiError.badRequest('Company role is not valid');
    if (roleRef.systemRoleKey && roleRef.systemRoleKey !== role) {
      throw ApiError.badRequest('Selected company role does not match the conversion role');
    }
  }

  return { department, manager, shift, role, roleRef };
};

const ensureEmployeeLimit = async (companyId) => {
  const subscription = await Subscription.findOne({ company: companyId }).lean();
  const limit = subscription?.limits?.employees;
  if (!limit) return;
  const active = await User.countDocuments({ companyId, status: 'ACTIVE' });
  if (active >= limit) {
    throw ApiError.forbidden(
      `Employee limit reached (${limit}) on your plan. Upgrade to convert more.`
    );
  }
};

const startEmployeeOnboarding = async ({
  companyId,
  userId,
  actorId,
  joiningDate,
}) => {
  const existing = await EmployeeLifecycle.findOne({ companyId, user: userId });
  if (existing) {
    return { lifecycle: existing, created: false };
  }

  const joinedOn = joiningDate || new Date();
  try {
    const lifecycle = await EmployeeLifecycle.create({
      companyId,
      user: userId,
      stage: 'ONBOARDING',
      joinedOn,
      events: [
        {
          type: 'JOINED',
          title: 'Joined via recruitment conversion',
          note: 'Employee created from READY_TO_JOIN candidate conversion',
          fromStage: '',
          toStage: 'ONBOARDING',
          by: actorId,
          at: new Date(),
        },
        {
          type: 'ONBOARDING_STARTED',
          title: 'Employee onboarding started',
          fromStage: '',
          toStage: 'ONBOARDING',
          by: actorId,
          at: new Date(),
        },
      ],
    });
    return { lifecycle, created: true };
  } catch (error) {
    if (error.code === 11000) {
      const raced = await EmployeeLifecycle.findOne({ companyId, user: userId });
      return { lifecycle: raced, created: false };
    }
    throw error;
  }
};

export const getConversionPreview = async ({ companyId, candidateRef }) => {
  const context = await loadConversionContext({ companyId, candidateRef });
  const eligibility = evaluateConversionEligibility(context);
  const bgvEligibility = await evaluateBgvForConversion({
    companyId,
    candidateId: context.candidate._id,
  });
  if (bgvEligibility.required && !bgvEligibility.satisfied) {
    eligibility.blockingReasons.push(...bgvEligibility.blockingReasons);
    eligibility.eligible = false;
  }

  const existingConversion = await CandidateEmployeeConversion.findOne({
    companyId,
    candidate: context.candidate._id,
  }).lean();

  if (existingConversion?.status === 'COMPLETED' && existingConversion.employee) {
    const employee = await User.findOne({
      _id: existingConversion.employee,
      companyId,
    })
      .select('-password')
      .lean();
    return {
      eligible: false,
      blockingReasons: ['Candidate is already converted'],
      alreadyConverted: true,
      conversion: conversionDto(existingConversion),
      employee: employee ? employeeDto(employee) : null,
      candidate: null,
      prefill: null,
    };
  }

  const mapped = mapCandidateToEmployeeFields({
    candidate: context.candidate,
    offer: context.offer,
    payload: {},
  });

  const [departments, managers, shifts] = await Promise.all([
    Department.find({ companyId })
      .select('_id name')
      .sort({ name: 1 })
      .lean(),
    User.find({
      companyId,
      status: 'ACTIVE',
      role: { $in: ['COMPANY_ADMIN', 'HR_MANAGER', 'MANAGER', 'TEAM_LEAD'] },
    })
      .select('_id name role designation')
      .sort({ name: 1 })
      .lean(),
    Shift.find({ companyId, isActive: true })
      .select('_id name type startTime endTime')
      .sort({ name: 1 })
      .lean(),
  ]);

  return {
    eligible: eligibility.eligible,
    blockingReasons: eligibility.blockingReasons,
    bgv: bgvEligibility,
    alreadyConverted: false,
    conversion: existingConversion ? conversionDto(existingConversion) : null,
    candidate: {
      id: context.candidate._id,
      candidateCode: context.candidate.candidateCode,
      name: context.candidate.name,
      email: context.candidate.email,
      phone: context.candidate.phone || '',
      currentStage: context.candidate.currentStage,
      skills: context.candidate.skills || [],
      education: context.candidate.education || {},
      experience: {
        total: context.candidate.totalExperience ?? 0,
        relevant: context.candidate.relevantExperience ?? 0,
      },
    },
    offer: context.offer
      ? {
          id: context.offer._id,
          offerCode: context.offer.offerCode,
          status: context.offer.status,
          designation: context.offer.terms?.designation || '',
          departmentName: context.offer.terms?.departmentName || '',
          location: context.offer.terms?.location || '',
          employmentType: context.offer.terms?.employmentType || '',
          workMode: context.offer.terms?.workMode || '',
          joiningDate: context.offer.terms?.joiningDate || null,
          compensation: {
            currency: context.offer.compensationSnapshot?.currency || 'INR',
            annualCTC: context.offer.compensationSnapshot?.annualCTC || 0,
          },
          jobTitle: context.offer.jobSnapshot?.title || '',
        }
      : null,
    preOnboarding: context.preOnboarding
      ? {
          id: context.preOnboarding._id,
          preOnboardingCode: context.preOnboarding.preOnboardingCode,
          status: context.preOnboarding.status,
          readiness: context.readiness,
          verifiedRequired: context.readiness.verifiedRequired,
          totalRequired: context.readiness.totalRequired,
        }
      : null,
    prefill: {
      name: mapped.name,
      email: mapped.email,
      phone: mapped.phone,
      designation: mapped.designation,
      joiningDate: mapped.joiningDate,
      location: mapped.location,
      employmentType: mapped.employmentType,
      role: ROLES.EMPLOYEE,
      departmentId: context.candidate.job ? null : null,
      managerId: context.candidate.hiringManager || null,
      employeeCode: '',
      compensation: mapped.compensationSummary,
    },
    options: {
      departments: departments.map((item) => ({
        id: item._id,
        name: item.name,
      })),
      managers: managers.map((item) => ({
        id: item._id,
        name: item.name,
        role: item.role,
        designation: item.designation || '',
      })),
      shifts: shifts.map((item) => ({
        id: item._id,
        name: item.name,
        type: item.type,
      })),
      roles: ASSIGNABLE_ROLES.map((value) => ({ value, label: value })),
    },
    requiredHrFields: [
      'departmentId',
      'designation',
      'joiningDate',
      'role',
    ],
  };
};

export const convertCandidateToEmployee = async ({
  companyId,
  candidateRef,
  actor,
  payload = {},
  requestContext = null,
}) => {
  const context = await loadConversionContext({ companyId, candidateRef });
  const { candidate, offer, preOnboarding, readiness } = context;

  const existingCompleted = await CandidateEmployeeConversion.findOne({
    companyId,
    candidate: candidate._id,
    status: 'COMPLETED',
  }).lean();

  if (existingCompleted?.employee) {
    const employee = await User.findOne({
      _id: existingCompleted.employee,
      companyId,
    })
      .select('-password')
      .lean();
    return {
      idempotent: true,
      employee: employee ? employeeDto(employee) : null,
      conversion: conversionDto(existingCompleted),
    };
  }

  if (candidate.convertedUser) {
    const employee = await User.findOne({
      _id: candidate.convertedUser,
      companyId,
    })
      .select('-password')
      .lean();
    return {
      idempotent: true,
      employee: employee ? employeeDto(employee) : null,
      conversion: {
        status: 'COMPLETED',
        employeeId: candidate.convertedUser,
        accountSetupStatus: employee?.accountSetupRequired ? 'SENT' : 'COMPLETED',
        onboardingStarted: true,
      },
    };
  }

  const eligibility = evaluateConversionEligibility(context);
  const bgvEligibility = await evaluateBgvForConversion({
    companyId,
    candidateId: candidate._id,
  });
  if (bgvEligibility.required && !bgvEligibility.satisfied) {
    eligibility.blockingReasons.push(...bgvEligibility.blockingReasons);
    eligibility.eligible = false;
  }
  if (!eligibility.eligible) {
    throw ApiError.conflict(eligibility.blockingReasons[0] || 'Candidate is not eligible');
  }

  const assignments = await validateInternalAssignments({
    companyId,
    actorRole: actor.role,
    payload,
  });
  const mapped = mapCandidateToEmployeeFields({ candidate, offer, payload });
  if (!mapped.designation) throw ApiError.badRequest('Designation is required');
  if (!mapped.dateOfJoining) throw ApiError.badRequest('Joining date is required');
  if (!assignments.department) throw ApiError.badRequest('Department is required');

  await ensureEmployeeLimit(companyId);

  const email = mapped.email;
  const existingUser = await User.findOne({ email, companyId })
    .select('_id name email employeeCode candidateId status role')
    .lean();

  if (existingUser) {
    if (
      existingUser.candidateId &&
      String(existingUser.candidateId) !== String(candidate._id)
    ) {
      throw ApiError.conflict(
        'This email already belongs to another employee in your company'
      );
    }
    if (!existingUser.candidateId) {
      throw ApiError.conflict(
        'A user with this email already exists in your company. Resolve the email conflict before conversion.'
      );
    }
  }

  let conversion = await CandidateEmployeeConversion.findOneAndUpdate(
    {
      companyId,
      candidate: candidate._id,
      status: { $in: ['PENDING', 'FAILED'] },
    },
    {
      $set: {
        status: 'PROCESSING',
        offer: offer._id,
        preOnboarding: preOnboarding._id,
        failureCategory: '',
        failureMessage: '',
        snapshot: {
          candidateName: candidate.name,
          candidateEmail: email,
          offerCode: offer.offerCode,
          preOnboardingCode: preOnboarding.preOnboardingCode,
          designation: mapped.designation,
          joiningDate: mapped.dateOfJoining,
        },
      },
      $setOnInsert: {
        companyId,
        candidate: candidate._id,
        convertedBy: actor.id,
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    }
  ).catch(async (error) => {
    if (error.code !== 11000) throw error;
    const raced = await CandidateEmployeeConversion.findOne({
      companyId,
      candidate: candidate._id,
    });
    if (raced?.status === 'COMPLETED') return raced;
    if (raced?.status === 'PROCESSING') {
      throw ApiError.conflict(
        'Conversion is already in progress. Refresh and try again in a moment.'
      );
    }
    throw error;
  });

  if (conversion.status === 'COMPLETED' && conversion.employee) {
    const employee = await User.findOne({
      _id: conversion.employee,
      companyId,
    })
      .select('-password')
      .lean();
    return {
      idempotent: true,
      employee: employee ? employeeDto(employee) : null,
      conversion: conversionDto(conversion),
    };
  }

  await timeline({
    companyId,
    candidate: candidate._id,
    job: candidate.job,
    action: 'CANDIDATE_CONVERSION_STARTED',
    actorId: actor.id,
    metadata: {
      offerCode: offer.offerCode,
      preOnboardingCode: preOnboarding.preOnboardingCode,
    },
  });

  await recordAudit({
    req: requestContext,
    action: 'CANDIDATE_CONVERSION_STARTED',
    companyId,
    actorId: actor.id,
    resource: 'Candidate',
    resourceId: candidate._id,
    metadata: {
      offerId: offer._id,
      preOnboardingId: preOnboarding._id,
    },
    critical: true,
  });

  let employeeCode;
  try {
    employeeCode = await nextEmployeeCode(companyId, payload.employeeCode);
  } catch (error) {
    await CandidateEmployeeConversion.updateOne(
      { _id: conversion._id, companyId },
      {
        $set: {
          status: 'FAILED',
          failureCategory: 'EMPLOYEE_CODE',
          failureMessage: cleanString(error.message, 500),
        },
      }
    );
    if (error.statusCode === 409) throw ApiError.conflict(error.message);
    throw error;
  }

  let user;
  try {
    user = await User.create({
      name: mapped.name,
      email,
      password: generateUnusablePassword(),
      role: assignments.role,
      roleRef: assignments.roleRef?._id || null,
      companyId,
      department: assignments.department._id,
      reportingTo: assignments.manager?._id || null,
      status: 'ACTIVE',
      employeeCode,
      designation: mapped.designation,
      dateOfJoining: mapped.dateOfJoining,
      candidateId: candidate._id,
      accountSetupRequired: true,
      phone: mapped.phone || '',
    });
  } catch (error) {
    await CandidateEmployeeConversion.updateOne(
      { _id: conversion._id, companyId },
      {
        $set: {
          status: 'FAILED',
          failureCategory: 'USER_CREATE',
          failureMessage: cleanString(error.message, 500),
        },
      }
    );
    if (error.code === 11000) {
      throw ApiError.conflict(
        'Employee or email uniqueness conflict. Refresh and try again.'
      );
    }
    throw error;
  }

  // Link candidate → user (compare-and-set).
  const linkedCandidate = await Candidate.findOneAndUpdate(
    {
      _id: candidate._id,
      companyId,
      $or: [{ convertedUser: null }, { convertedUser: { $exists: false } }],
    },
    {
      $set: {
        convertedUser: user._id,
        offerStatus: 'ACCEPTED',
        offerJoiningDate: mapped.dateOfJoining,
        offerSalary: offer.compensationSnapshot?.annualCTC
          ? Math.round(Number(offer.compensationSnapshot.annualCTC) / 12)
          : candidate.offerSalary || 0,
      },
    },
    { returnDocument: 'after' }
  );

  if (!linkedCandidate) {
    await User.deleteOne({ _id: user._id, companyId, candidateId: candidate._id }).catch(
      () => {}
    );
    const again = await Candidate.findOne({ _id: candidate._id, companyId })
      .select('convertedUser')
      .lean();
    if (again?.convertedUser) {
      const employee = await User.findOne({
        _id: again.convertedUser,
        companyId,
      })
        .select('-password')
        .lean();
      return {
        idempotent: true,
        employee: employee ? employeeDto(employee) : null,
        conversion: conversionDto(
          (await CandidateEmployeeConversion.findOne({
            companyId,
            candidate: candidate._id,
          }).lean()) || { status: 'COMPLETED', employee: again.convertedUser }
        ),
      };
    }
    throw ApiError.conflict('Candidate conversion changed in another request');
  }

  // Optional shift membership on existing Shift.employees array.
  if (assignments.shift?._id) {
    await Shift.updateOne(
      { _id: assignments.shift._id, companyId },
      { $addToSet: { employees: user._id } }
    ).catch(() => {});
  }

  let pipelineTransition = null;
  try {
    pipelineTransition = await transitionCandidateStage({
      companyId,
      candidateId: candidate._id,
      targetStage: 'JOINED',
      reason: `${preOnboarding.preOnboardingCode} converted to ${employeeCode}`,
      actorId: actor.id,
      metadata: {
        source: 'PIPELINE',
        action: 'EMPLOYEE_CONVERSION',
      },
      requestContext,
    });
  } catch (error) {
    // Roll back candidate link + user if pipeline cannot complete.
    await Candidate.updateOne(
      { _id: candidate._id, companyId, convertedUser: user._id },
      { $set: { convertedUser: null } }
    ).catch(() => {});
    await User.deleteOne({ _id: user._id, companyId, candidateId: candidate._id }).catch(
      () => {}
    );
    await CandidateEmployeeConversion.updateOne(
      { _id: conversion._id, companyId },
      {
        $set: {
          status: 'FAILED',
          failureCategory: 'PIPELINE',
          failureMessage: cleanString(error.message, 500),
        },
      }
    );
    throw error;
  }

  const { lifecycle, created: onboardingCreated } = await startEmployeeOnboarding({
    companyId,
    userId: user._id,
    actorId: actor.id,
    joiningDate: mapped.dateOfJoining,
  });

  const company = await Company.findById(companyId).select('name code').lean();
  const setupDelivery = await sendAccountSetupInvitation({
    companyId,
    user,
    companyName: company?.name || '',
    companyCode: company?.code || '',
    designation: mapped.designation,
    joiningDate: mapped.dateOfJoining,
    actorId: actor.id,
    requestContext,
  });

  conversion = await CandidateEmployeeConversion.findOneAndUpdate(
    { _id: conversion._id, companyId },
    {
      $set: {
        status: 'COMPLETED',
        employee: user._id,
        employeeCode,
        accountSetupStatus: setupDelivery.delivered ? 'SENT' : 'FAILED',
        onboardingStarted: true,
        lifecycleId: lifecycle?._id || null,
        convertedAt: new Date(),
        failureCategory: '',
        failureMessage: setupDelivery.delivered
          ? ''
          : cleanString(setupDelivery.error || 'Setup email failed', 500),
      },
    },
    { returnDocument: 'after' }
  );

  await timeline({
    companyId,
    candidate: candidate._id,
    job: candidate.job,
    action: 'CANDIDATE_CONVERTED',
    actorId: actor.id,
    metadata: {
      employeeCode,
      employeeId: user._id,
      offerCode: offer.offerCode,
    },
  });
  await timeline({
    companyId,
    candidate: candidate._id,
    job: candidate.job,
    action: 'EMPLOYEE_CREATED',
    actorId: actor.id,
    metadata: { employeeCode, employeeId: user._id },
  });
  await timeline({
    companyId,
    candidate: candidate._id,
    job: candidate.job,
    action: 'ACCOUNT_SETUP_SENT',
    actorId: actor.id,
    metadata: {
      delivered: setupDelivery.delivered,
      mode: setupDelivery.mode,
    },
  });
  if (onboardingCreated) {
    await timeline({
      companyId,
      candidate: candidate._id,
      job: candidate.job,
      action: 'ONBOARDING_STARTED',
      actorId: actor.id,
      metadata: { lifecycleId: lifecycle?._id },
    });
  }
  await timeline({
    companyId,
    candidate: candidate._id,
    job: candidate.job,
    action: 'CANDIDATE_JOINED',
    actorId: actor.id,
    metadata: {
      employeeCode,
      pipelineHistoryId: pipelineTransition?.pipelineHistoryId,
    },
  });

  await recordAudit({
    req: requestContext,
    action: 'CANDIDATE_CONVERTED',
    companyId,
    actorId: actor.id,
    resource: 'Candidate',
    resourceId: candidate._id,
    newValue: {
      employeeId: user._id,
      employeeCode,
      stage: 'JOINED',
    },
    metadata: {
      offerId: offer._id,
      preOnboardingId: preOnboarding._id,
      conversionId: conversion._id,
      onboardingStarted: true,
      accountSetupDelivered: setupDelivery.delivered,
    },
    critical: true,
  });

  await recordAudit({
    req: requestContext,
    action: 'EMPLOYEE_CREATED',
    companyId,
    actorId: actor.id,
    resource: 'User',
    resourceId: user._id,
    newValue: {
      employeeCode,
      role: user.role,
      candidateId: candidate._id,
    },
    critical: true,
  });

  if (onboardingCreated) {
    await recordAudit({
      req: requestContext,
      action: 'ONBOARDING_STARTED',
      companyId,
      actorId: actor.id,
      resource: 'EmployeeLifecycle',
      resourceId: lifecycle?._id,
      metadata: { employeeId: user._id },
      critical: true,
    });
  }

  notifyUser(companyId, user._id, {
    type: 'USER',
    title: 'Welcome to Crewly',
    message:
      'Your employee account was created from recruitment. Check your email to set your password.',
    link: '/login',
  }).catch(() => {});

  const safeUser = await User.findById(user._id)
    .select('-password')
    .populate('department', 'name')
    .populate('reportingTo', 'name role')
    .lean();

  // 28.7: analytics cache generation bump (fire-and-forget, never throws).
  bumpRecruitmentAnalyticsGeneration(companyId).catch(() => {});

  return {
    idempotent: false,
    employee: employeeDto(safeUser),
    conversion: conversionDto(conversion),
    meta: {
      accountSetup: setupDelivery.delivered ? 'SENT' : 'FAILED',
      onboardingStarted: true,
      pipeline: {
        fromStage: pipelineTransition?.fromStage,
        toStage: pipelineTransition?.toStage,
      },
    },
  };
};

export const resendConversionAccountSetup = async ({
  companyId,
  employeeId,
  actorId,
  requestContext = null,
}) => {
  if (!isObjectId(employeeId)) throw ApiError.notFound('Employee not found');

  const conversion = await CandidateEmployeeConversion.findOne({
    companyId,
    employee: employeeId,
    status: 'COMPLETED',
  }).lean();

  if (!conversion) {
    // Still allow resend for any employee with setup pending.
    const user = await User.findOne({
      _id: employeeId,
      companyId,
      accountSetupRequired: true,
    })
      .select('_id')
      .lean();
    if (!user) throw ApiError.notFound('Conversion account setup not found');
  }

  const company = await Company.findById(companyId).select('name code').lean();
  const delivery = await resendAccountSetupForUser({
    companyId,
    userId: employeeId,
    actorId,
    companyName: company?.name || '',
    companyCode: company?.code || '',
    requestContext,
  });

  if (conversion) {
    await CandidateEmployeeConversion.updateOne(
      { _id: conversion._id, companyId },
      {
        $set: {
          accountSetupStatus: delivery.delivered ? 'SENT' : 'FAILED',
          failureMessage: delivery.delivered
            ? ''
            : cleanString(delivery.error || 'Setup email failed', 500),
        },
      }
    );
  }

  return {
    delivered: delivery.delivered,
    mode: delivery.mode,
    expiresAt: delivery.expiresAt,
  };
};

export const getEmployeeRecruitmentOrigin = async ({
  companyId,
  employeeId,
}) => {
  if (!isObjectId(employeeId)) throw ApiError.notFound('Employee not found');

  const employee = await User.findOne({ _id: employeeId, companyId })
    .select('_id name email employeeCode candidateId dateOfJoining designation')
    .lean();
  if (!employee) throw ApiError.notFound('Employee not found');
  if (!employee.candidateId) {
    return { hasRecruitmentOrigin: false, origin: null };
  }

  const conversion = await CandidateEmployeeConversion.findOne({
    companyId,
    employee: employeeId,
    status: 'COMPLETED',
  }).lean();

  const candidate = await Candidate.findOne({
    _id: employee.candidateId,
    companyId,
  })
    .select('candidateCode name email currentStage job requisition')
    .populate('job', 'title jobCode')
    .lean();

  return {
    hasRecruitmentOrigin: true,
    origin: {
      employeeCode: employee.employeeCode,
      candidateId: employee.candidateId,
      candidateCode: candidate?.candidateCode || '',
      candidateName: candidate?.name || '',
      jobTitle: candidate?.job?.title || conversion?.snapshot?.designation || '',
      jobCode: candidate?.job?.jobCode || '',
      offerCode: conversion?.snapshot?.offerCode || '',
      preOnboardingCode: conversion?.snapshot?.preOnboardingCode || '',
      convertedAt: conversion?.convertedAt || null,
      joiningDate: employee.dateOfJoining || null,
    },
  };
};
