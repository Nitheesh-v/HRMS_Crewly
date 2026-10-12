// Weekly-hours flexi target — frontend source pins.
//
// "Finish the weekly hours goal early, rest the remaining working days."
// The feature must be configurable in the policy editor, visible as a
// truthful chip on the dashboard, and labelled truthfully on the timesheet
// (an earned-rest day is NOT a roster weekly off).
//
// Source pins (the repo's frontend test convention).

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFile(join(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');

test('policy service: the frontend reads the weekly-target endpoint', async () => {
  const service = await read('src/services/attendanceWeeklyTargetService.js');
  assert.match(service, /api\.get\('\/attendance\/weekly-target'\)/);
  assert.match(service, /const envelope = \(promise\) =>/, 'meta/bare response normalization');
});

test('policy editor: the weekly target block is configurable per-field', async () => {
  const page = await read('src/pages/attendance/AttendancePolicyPage.jsx');

  // defaults — OFF, 40h goal, auto-mark, regular hours only
  assert.match(page, /weeklyTarget: \{\s*enabled: false,\s*targetHours: 40,\s*restDayMode: 'AUTO_MARK',\s*includeApprovedOvertime: false,\s*\}/);
  // hydration from the saved policy (minutes → hours)
  assert.match(page, /targetHours: policy\.weeklyTarget\?\.targetMinutes != null/);
  // payload conversion (hours → minutes)
  assert.match(page, /targetMinutes: Math\.round\(Number\(form\.weeklyTarget\.targetHours \|\| 0\) \* 60\) \|\| 2400/);
  // the editor section exists with the truth about earned rest
  assert.match(page, /Weekly hours target \(flexi week\)/);
  assert.match(page, /never absent, never LOP, no leave deducted/);
  assert.match(page, /value="AUTO_MARK">Auto-mark remaining days as earned rest/);
  assert.match(page, /value="SUGGEST_ONLY">Only suggest \(no auto-marking\)/);
  assert.match(page, /Count approved overtime toward the goal/);
  // the Target icon must actually be imported (section header icon)
  assert.match(page, /  Target,\n\} from 'lucide-react';/);
});

test('dashboard: the weekly goal chip is additive and truthful', async () => {
  const page = await read('src/pages/dashboard/DashboardPage.jsx');
  assert.match(page, /import attendanceWeeklyTargetService from "\.\.\/\.\.\/services\/attendanceWeeklyTargetService\.js";/);
  assert.match(page, /const \[weekTarget, setWeekTarget\] = useState\(null\);/);
  assert.match(page, /weeklyTarget\(\)/);
  assert.match(page, /\.catch\(\(\) => setWeekTarget\(null\)\)/, 'chip failure must be silent');
  assert.match(page, /\{weekTarget\?\.enabled \? \(/, 'chip renders only when the policy is on');
  assert.match(page, /Weekly hours goal/);
  assert.match(page, /earned rest/);
  assert.match(page, /no leave deducted/, 'rest days are never a leave-balance deduction');
});

test('timesheet: earned-rest days read truthfully, not as roster weekly offs', async () => {
  const view = await read('src/components/attendance/TimesheetMonthView.jsx');
  assert.match(view, /const dayOutcomeLabel = \(day\) =>/);
  assert.match(view, /'Earned off \(weekly target\)'/);
  // every OUTCOME_LABEL[day.bucket] display site routes through the helper
  assert.doesNotMatch(view, /OUTCOME_LABEL\[day\.bucket\]/, 'all day labels go through dayOutcomeLabel');
  // the drawer explains WHY the day is off
  assert.match(view, /Weekly hours goal met/);
  // the plain "Day type: Weekly off" row is suppressed for earned rest
  assert.match(view, /!day\.calendar\?\.holiday && !day\.weeklyTarget \? \(\s*<Row label="Day type">Weekly off<\/Row>/);
});
