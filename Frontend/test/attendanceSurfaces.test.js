// ═══════════════════════════════════════════════════════════════════════════
// ATTENDANCE SURFACES — My Attendance and the Attendance Report.
//
// Both pages were rebuilt to the owner's mock. What is pinned here is what a
// redesign usually breaks: the endpoints that do the work, the fact that every
// figure comes from the response, and the absence of the dashboard furniture
// the mock carries but neither API ever had (terminal IDs, geofences, biometric
// photo strips, per-day heatmaps, PDF audits).
// ═══════════════════════════════════════════════════════════════════════════
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const myAttendance = read('src/pages/attendance/AttendancePage.jsx');
const reportPage = read('src/pages/attendance/AttendanceReportPage.jsx');
const kioskCard = read('src/components/attendance/KioskPinCard.jsx');

describe('my attendance', () => {
  test('reads the live snapshot and the month record, and nothing else', () => {
    assert.match(myAttendance, /todayLive\(\)/);
    assert.match(myAttendance, /attendanceService\.my\(month\)|\.my\(month\)/);
    assert.equal(myAttendance.includes('/attendance/export'), false, 'there is no personal export endpoint');
  });

  test('the month ribbon counts the summary the API returns', () => {
    for (const field of ['s.present', 's.late', 's.halfDay', 's.absent', 's.totalHours', 's.workingDays']) {
      assert.ok(myAttendance.includes(field), `the ribbon no longer shows ${field}`);
    }
    assert.match(myAttendance, /label: 'Present'[\s\S]*label: 'Late'[\s\S]*label: 'Half day'[\s\S]*label: 'Absent'[\s\S]*label: 'Hours'/);
  });

  test('the worked-vs-target bar needs a rostered shift before it is drawn', () => {
    assert.match(myAttendance, /const targetMinutes = Number\(live\?\.schedule\?\.scheduledMinutes\) \|\| null;/);
    // a hard-coded eight-hour target would be a promise the record cannot keep
    assert.equal(myAttendance.includes('480'), false, 'no invented shift length');
    assert.match(myAttendance, /\{targetMinutes && live\.liveState !== 'NOT_IN' \? \(/);
  });

  test('the session trace is the recorded punches plus one planned shift end', () => {
    assert.match(myAttendance, /live\?\.timeline \|\| \[\]/);
    assert.match(myAttendance, /scheduledEndAt/);
    assert.match(myAttendance, /tag: 'Planned'/);
  });

  test('the actions stay the ones the snapshot allows', () => {
    for (const action of ['CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END']) {
      assert.ok(myAttendance.includes(`doAction('${action}'`), `missing the ${action} action`);
    }
    assert.match(myAttendance, /live\.allowedActions|can\('CLOCK_OUT'\)/);
  });

  test('corrections leave for the request screen instead of a fake modal', () => {
    assert.match(myAttendance, /\/app\/attendance\/regularizations/);
    assert.match(myAttendance, /\/app\/schedules/);
  });

  test('the CSV is built from the rows already on screen', () => {
    assert.match(myAttendance, /exportMonthCsv/);
    assert.match(myAttendance, /Blob\(/);
    assert.match(myAttendance, /my-attendance-\$\{month\}\.csv/);
  });

  test('no terminal, geofence or biometric telemetry that was never recorded', () => {
    for (const claim of [
      'Terminal ID',
      'HQ-01',
      'Geofence radius',
      'Biometric',
      'Syncing Live Biometric',
      'Punctuality',
      'Fingerprint',
      'Est. completion',
    ]) {
      assert.equal(myAttendance.includes(claim), false, `"${claim}" is not in the record`);
    }
    // the policy pill may only describe location enforcement, which the API states
    assert.match(myAttendance, /locationEnforcement/);
  });

  test('the kiosk card is the PIN self-service, not a terminal gallery', () => {
    assert.match(kioskCard, /getKioskPinStatus\(\)/);
    assert.match(kioskCard, /setKioskPin\(/);
    assert.equal(kioskCard.includes('<img'), false, 'there are no kiosk photos to show');
  });
});

describe('attendance report', () => {
  test('uses the company and monthly endpoints, with the department filter', () => {
    assert.match(reportPage, /attendanceService\s*\n?\s*\.company\(date\)|\.company\(date\)/);
    assert.match(reportPage, /\.report\(month, department\)/);
  });

  test('the day ribbon counts the day counts', () => {
    for (const field of ['c.punchedIn', 'c.punchedOut', 'c.late', 'c.absent', 'c.total']) {
      assert.ok(reportPage.includes(field), `the ribbon no longer shows ${field}`);
    }
    assert.match(reportPage, /label: 'On duty'[\s\S]*label: 'Done shifts'[\s\S]*label: 'Late in'[\s\S]*label: 'Absent'[\s\S]*label: 'Headcount'/);
  });

  test('the month ribbon adds up the rows it was given', () => {
    assert.match(reportPage, /rows\.reduce\(\(acc, row\) => acc \+ \(Number\(pick\(row\)\) \|\| 0\), 0\)/);
    assert.match(reportPage, /avgPerPresentDay/);
    // the score shown under a bar is the person's own percentage
    assert.match(reportPage, /\{r\.attendancePct\}%/);
  });

  test('filters narrow the loaded rows and the count agrees with the table', () => {
    assert.match(reportPage, /const needle = query\.trim\(\)\.toLowerCase\(\)/);
    assert.match(reportPage, /departmentName/);
    assert.match(reportPage, /Showing \{shown\} of \{total\}/);
  });

  test('export covers the tab on screen and nothing more', () => {
    assert.match(reportPage, /attendance-\$\{month\}/);
    assert.match(reportPage, /attendance-\$\{date\}/);
    for (const claim of ['PDF', 'Audit PDF', 'pdf']) {
      assert.equal(reportPage.includes(claim), false, `there is no ${claim} generator`);
    }
  });

  test('no live reload, heatmap percentages or shift adherence it cannot compute', () => {
    for (const claim of ['Live Reload', 'Shift Adherence', 'Total Overtime', 'heatmap', 'calendar heatmap']) {
      assert.equal(reportPage.includes(claim), false, `"${claim}" has no data source`);
    }
    // the report rows carry one percentage per person for the month, not a
    // figure for every day of it — a calendar grid would have to invent them
    assert.equal(reportPage.includes('perDay'), false, 'no per-day percentage source exists');
    assert.equal(/days\.map\(/.test(reportPage), false, 'there is no day grid to draw');
  });

  test('the roster columns are the fields the rows carry', () => {
    for (const field of ['user.name', 'user.department?.name', 'record?.punchIn', 'record?.punchOut', 'record?.workMinutes']) {
      assert.ok(reportPage.includes(field), `the roster no longer shows ${field}`);
    }
    assert.match(reportPage, /reconciliation\?\.leave\?\.portion/);
  });
});
