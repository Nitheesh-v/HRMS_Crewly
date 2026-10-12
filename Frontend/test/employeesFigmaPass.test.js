// Employees Figma pass (list surface) — source pins.
//
// Convention: these tests READ the source file and assert the contract,
// the same way every other frontend test in this repo does. They pin the
// decisions the Figma pass made against the artwork (screens: Employee,
// Employee - Filter, Employee - New Profile, Employee - New Profile -
// Select Date, Employee - Directory):
//
//   · the page keeps the REAL backend contract — GET /api/users filters
//     (search/role/department/status) + pagination, POST /api/users for
//     create, PATCH /users/:id for edit, POST /users/:id/reset-password,
//   · the Figma "Add New Profile" drawer maps first+last onto the backend's
//     single `name`, and KEEPS the role + initial-password fields the
//     artwork omits but the backend requires,
//   · Download is a real client-side CSV export (blob + createObjectURL),
//     never a dead button,
//   · no fabricated employee states — the artwork's ON BOARDING /
//     PROBATION / ON LEAVE pills have no backend field, so they must not
//     appear as data; only ACTIVE / INACTIVE render,
//   · filters map onto real backend filters (Departments / Roles / Status)
//     — the artwork's "All Offices" has no backend column,
//   · no artwork typos ("Employeee", "director board"), no emojis.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const read = (rel) =>
  readFile(join(dirname(fileURLToPath(import.meta.url)), "..", rel), "utf8");

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

test("employees page: Figma list surface wired to the real backend", async () => {
  const src = await read("src/pages/users/UsersPage.jsx");

  // header actions from the artwork, both real
  assert.match(src, /Add New/, "Figma Add New button");
  assert.match(src, /Download/, "Figma Download button");
  assert.match(src, /createObjectURL/, "Download exports a real CSV blob");
  assert.match(src, /employees\.csv/, "CSV download filename");

  // drawer (artwork's Add New Profile slide-over)
  assert.match(src, /Add New Profile/, "drawer title from the artwork");
  assert.match(src, /First Name/, "drawer first name field");
  assert.match(src, /Last Name/, "drawer last name field");
  assert.match(src, /Join Date/, "drawer join date field");
  assert.match(src, /This field is required\./, "artwork inline required error");

  // backend contract preserved
  assert.match(src, /api\.post\('\/users'/, "create still POSTs /api/users");
  assert.match(src, /api\.patch\(`\/users\/\$\{u\._id\}`/, "edit still PATCHes /users/:id");
  assert.match(src, /reset-password/, "reset password flow preserved");
  assert.match(src, /Initial Password/, "backend-required password kept (artwork omits it)");

  // views + filters
  assert.match(src, /Directory view/, "directory card grid toggle");
  assert.match(src, /All Departments/, "filter mapped to real department column");
  assert.match(src, /All Roles/, "filter mapped to real role column");
  assert.match(src, /All Status/, "filter mapped to real status column");
  assert.match(src, /pageItems/, "numbered pagination like the artwork");
});

test("employees page: no fabricated data, no artwork typos, no emojis", async () => {
  const src = await read("src/pages/users/UsersPage.jsx");

  // artwork-only employee states with no backend field must not render
  assert.ok(!/ON BOARDING/i.test(src), "no fabricated ON BOARDING state");
  assert.ok(!/PROBATION/i.test(src), "no fabricated PROBATION state");
  assert.ok(!/ON LEAVE/i.test(src), "no fabricated ON LEAVE state");

  // artwork filter with no backend column must not appear
  assert.ok(!/All Offices/.test(src), "no Offices filter (no backend column)");

  // artwork typos never propagated
  assert.ok(!/Employeee/.test(src), "no 'Employeee' typo");
  assert.ok(!/director board/i.test(src), "no 'director board' typo");

  assert.ok(!EMOJI.test(src), "no emojis in the employees surface");
});

test("employees page: status pills render only backend states", async () => {
  const src = await read("src/pages/users/UsersPage.jsx");
  assert.match(src, /ACTIVE' : 'INACTIVE'/, "pill text comes from the stored status only");
  assert.match(src, /status === 'ACTIVE'/, "active check against the real field");
});
