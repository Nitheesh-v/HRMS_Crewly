import { DateTime, IANAZone } from 'luxon';
import ApiError from './ApiError.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isValidInterviewTimezone = (timezone) =>
  typeof timezone === 'string' &&
  timezone.length <= 100 &&
  IANAZone.isValidZone(timezone);

export const interviewWallClockToUtc = ({
  date,
  time,
  timezone,
  durationMinutes,
}) => {
  if (!DATE_PATTERN.test(String(date || '')) || !TIME_PATTERN.test(String(time || ''))) {
    throw ApiError.badRequest('Choose a valid interview date and time');
  }
  if (!isValidInterviewTimezone(timezone)) {
    throw ApiError.badRequest('Choose a valid IANA scheduling timezone');
  }

  const duration = Number(durationMinutes);
  if (!Number.isInteger(duration) || duration < 15 || duration > 480) {
    throw ApiError.badRequest('Interview duration must be between 15 and 480 minutes');
  }

  const local = DateTime.fromISO(`${date}T${time}`, {
    zone: timezone,
    setZone: true,
  });

  if (!local.isValid) {
    throw ApiError.badRequest('The selected local interview time does not exist');
  }

  const roundTrip = local.toFormat("yyyy-MM-dd'T'HH:mm");
  if (roundTrip !== `${date}T${time}`) {
    throw ApiError.badRequest(
      'The selected local interview time is ambiguous or unavailable in this timezone'
    );
  }

  const start = local.toUTC();
  const end = start.plus({ minutes: duration });

  return {
    scheduledStartAt: start.toJSDate(),
    scheduledEndAt: end.toJSDate(),
    timezone,
    durationMinutes: duration,
  };
};

export const companyDayUtcRange = ({ date, timezone }) => {
  const zone = isValidInterviewTimezone(timezone) ? timezone : 'Asia/Kolkata';
  const localDate = date
    ? DateTime.fromISO(date, { zone, setZone: true })
    : DateTime.now().setZone(zone);

  if (!localDate.isValid) {
    throw ApiError.badRequest('Choose a valid date filter');
  }

  return {
    start: localDate.startOf('day').toUTC().toJSDate(),
    end: localDate.plus({ days: 1 }).startOf('day').toUTC().toJSDate(),
  };
};

export const reminderDispatchAfter = (scheduledStartAt, now = new Date()) => {
  const start = DateTime.fromJSDate(new Date(scheduledStartAt), { zone: 'utc' });
  const current = DateTime.fromJSDate(new Date(now), { zone: 'utc' });
  const dayBefore = start.minus({ hours: 24 });
  const hourBefore = start.minus({ hours: 1 });

  if (dayBefore > current) return dayBefore.toJSDate();
  if (hourBefore > current) return hourBefore.toJSDate();
  return current.toJSDate();
};

export const formatInterviewSchedule = ({ startAt, timezone }) =>
  DateTime.fromJSDate(new Date(startAt), { zone: 'utc' })
    .setZone(isValidInterviewTimezone(timezone) ? timezone : 'UTC')
    .toFormat("dd LLL yyyy, hh:mm a '('") +
  `${isValidInterviewTimezone(timezone) ? timezone : 'UTC'})`;
