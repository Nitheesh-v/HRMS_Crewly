/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import superAdminService from '../../services/superAdminService.js';

const panel =
  'rounded-xl border border-slate-800 bg-slate-900 p-4';

const inp =
  'rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-orange-500';

const TABS = [
  'Overview',
  'Company Information',
  'Subscription',
  'Users',
  'Employees',
  'Usage',
  'Activity',
  'Billing',
  'Audit Logs',
];

const money = (value) =>
  `₹${Number(
    value || 0
  ).toLocaleString('en-IN')}`;

const date = (value) =>
  value
    ? new Date(
        value
      ).toLocaleDateString(
        'en-IN'
      )
    : '—';

const List = ({
  rows = [],
  empty,
  render,
}) => (
  <div className={panel}>
    {rows.map((row) => (
      <div
        key={row._id}
        className="flex justify-between gap-4 border-b border-slate-800 py-3 text-sm last:border-0"
      >
        {render(row)}
      </div>
    ))}

    {!rows.length && (
      <p className="text-slate-500">
        {empty}
      </p>
    )}
  </div>
);

const SuperAdminCompanyDetailPage =
  () => {
    const { companyId } =
      useParams();

    const [data, setData] =
      useState(null);

    const [tab, setTab] =
      useState('Overview');

    const [edit, setEdit] =
      useState(null);

    const [
      message,
      setMessage,
    ] = useState('');

    const load = async () => {
      try {
        const result =
          await superAdminService
            .company(companyId);

        setData(result);
        setEdit(result.company);
      } catch (error) {
        setMessage(
          error?.message ||
            'Could not load company'
        );
      }
    };

    useEffect(() => {
      load();
    }, [companyId]);

    if (!data) {
      return (
        <p className="text-slate-400">
          Loading company…
        </p>
      );
    }

    const saveCompany =
      async () => {
        try {
          await superAdminService
            .updateCompany(
              companyId,
              edit
            );

          setMessage(
            'Company information updated'
          );

          await load();
        } catch (error) {
          setMessage(
            error?.message ||
              'Update failed'
          );
        }
      };

    const setStatus =
      async (status) => {
        const confirmed =
          window.confirm(
            `Set company status to ${status}?`
          );

        if (!confirmed) return;

        try {
          await superAdminService
            .setCompanyStatus(
              companyId,
              status
            );

          setMessage(
            `Company is now ${status}`
          );

          await load();
        } catch (error) {
          setMessage(
            error?.message ||
              'Status update failed'
          );
        }
      };

    const saveSubscription =
      async (event) => {
        event.preventDefault();

        try {
          const body =
            Object.fromEntries(
              new FormData(
                event.currentTarget
              )
            );

          await superAdminService
            .updateSubscription(
              companyId,
              body
            );

          setMessage(
            'Subscription updated'
          );

          await load();
        } catch (error) {
          setMessage(
            error?.message ||
              'Subscription update failed'
          );
        }
      };

    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-orange-400">
              Customer Company
            </p>

            <h1 className="text-2xl font-black">
              {
                data.overview
                  .name
              }
            </h1>

            <p className="text-sm text-slate-500">
              {
                data.overview
                  .code
              }{' '}
              · created{' '}
              {date(
                data.overview
                  .createdAt
              )}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                setStatus(
                  'ACTIVE'
                )
              }
              className="rounded-lg bg-emerald-500/15 px-3 py-2 text-sm text-emerald-300"
            >
              Activate
            </button>

            <button
              type="button"
              onClick={() =>
                setStatus(
                  'SUSPENDED'
                )
              }
              className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300"
            >
              Suspend
            </button>

            <button
              type="button"
              onClick={() =>
                setStatus(
                  'DEACTIVATED'
                )
              }
              className="rounded-lg border border-slate-700 px-3 py-2 text-sm"
            >
              Deactivate
            </button>
          </div>
        </div>

        {message && (
          <div className="rounded-lg border border-orange-500/30 bg-orange-500/10 p-3 text-orange-200">
            {message}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {TABS.map(
            (tabName) => (
              <button
                type="button"
                key={tabName}
                onClick={() =>
                  setTab(tabName)
                }
                className={
                  tab === tabName
                    ? 'rounded-lg bg-orange-500 px-3 py-2 text-sm font-semibold text-slate-950'
                    : 'rounded-lg bg-slate-900 px-3 py-2 text-sm text-slate-400'
                }
              >
                {tabName}
              </button>
            )
          )}
        </div>

        {tab === 'Overview' && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              [
                'Plan',
                data.overview.plan ===
                'PRO'
                  ? 'PROFESSIONAL'
                  : data.overview
                      .plan,
              ],
              [
                'Status',
                data.overview
                  .status,
              ],
              [
                'Employees',
                data.overview
                  .employees,
              ],
              [
                'Users',
                data.overview
                  .users,
              ],
              [
                'Storage',
                `${(
                  data.overview
                    .storageBytes /
                  1024 /
                  1024
                ).toFixed(1)} MB`,
              ],
              [
                'API requests',
                data.overview
                  .apiRequests,
              ],
              [
                'Last login',
                date(
                  data.overview
                    .lastLogin
                ),
              ],
              [
                'Subscription',
                data.overview
                  .subscriptionStatus,
              ],
            ].map(
              ([
                label,
                value,
              ]) => (
                <div
                  key={label}
                  className={
                    panel
                  }
                >
                  <p className="text-xs text-slate-500">
                    {label}
                  </p>

                  <p className="mt-1 text-xl font-bold">
                    {value ?? '—'}
                  </p>
                </div>
              )
            )}
          </div>
        )}

        {tab ===
          'Company Information' &&
          edit && (
            <div className={panel}>
              <div className="grid gap-3 md:grid-cols-2">
                {[
                  'name',
                  'email',
                  'phone',
                  'industry',
                  'country',
                  'timezone',
                  'currency',
                  'logoUrl',
                ].map((key) => (
                  <div key={key}>
                    <label className="mb-1 block text-xs capitalize text-slate-500">
                      {key}
                    </label>

                    <input
                      className={`${inp} w-full`}
                      value={
                        edit[key] ||
                        ''
                      }
                      onChange={(
                        event
                      ) =>
                        setEdit(
                          (
                            current
                          ) => ({
                            ...current,
                            [key]:
                              event
                                .target
                                .value,
                          })
                        )
                      }
                    />
                  </div>
                ))}

                {[
                  'line',
                  'city',
                  'state',
                  'pincode',
                ].map((key) => (
                  <div key={key}>
                    <label className="mb-1 block text-xs capitalize text-slate-500">
                      Address {key}
                    </label>

                    <input
                      className={`${inp} w-full`}
                      value={
                        edit.address?.[
                          key
                        ] || ''
                      }
                      onChange={(
                        event
                      ) =>
                        setEdit(
                          (
                            current
                          ) => ({
                            ...current,

                            address: {
                              ...current.address,

                              [key]:
                                event
                                  .target
                                  .value,
                            },
                          })
                        )
                      }
                    />
                  </div>
                ))}

                <div className="md:col-span-2">
                  <label className="mb-1 block text-xs text-slate-500">
                    Platform notes
                  </label>

                  <textarea
                    className={`${inp} w-full`}
                    value={
                      edit.platformNotes ||
                      ''
                    }
                    onChange={(
                      event
                    ) =>
                      setEdit(
                        (
                          current
                        ) => ({
                          ...current,

                          platformNotes:
                            event
                              .target
                              .value,
                        })
                      )
                    }
                  />
                </div>
              </div>

              <button
                type="button"
                onClick={
                  saveCompany
                }
                className="mt-4 rounded-lg bg-orange-500 px-4 py-2 font-semibold text-slate-950"
              >
                Save company
                information
              </button>
            </div>
          )}

        {tab ===
          'Subscription' && (
          <form
            onSubmit={
              saveSubscription
            }
            className={`${panel} grid gap-3 md:grid-cols-2`}
          >
            <div>
              <label className="mb-1 block text-xs text-slate-500">
                Plan
              </label>

              <select
                name="plan"
                defaultValue={
                  data.subscription
                    ?.plan
                }
                className={`${inp} w-full`}
              >
                <option value="TRIAL">
                  TRIAL
                </option>
                <option value="BASIC">
                  BASIC
                </option>
                <option value="PRO">
                  PROFESSIONAL
                </option>
                <option value="ENTERPRISE">
                  ENTERPRISE
                </option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs text-slate-500">
                Status
              </label>

              <select
                name="status"
                defaultValue={
                  data.subscription
                    ?.status
                }
                className={`${inp} w-full`}
              >
                <option>
                  TRIAL
                </option>
                <option>
                  ACTIVE
                </option>
                <option>
                  GRACE_PERIOD
                </option>
                <option>
                  EXPIRED
                </option>
                <option>
                  SUSPENDED
                </option>
                <option>
                  CANCELLED
                </option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs text-slate-500">
                Start date
              </label>

              <input
                name="startDate"
                type="date"
                defaultValue={
                  data.subscription
                    ?.startDate
                    ?.slice?.(
                      0,
                      10
                    )
                }
                className={`${inp} w-full`}
              />
            </div>

            <div>
              <label className="mb-1 block text-xs text-slate-500">
                End date
              </label>

              <input
                name="endDate"
                type="date"
                defaultValue={
                  data.subscription
                    ?.endDate
                    ?.slice?.(
                      0,
                      10
                    )
                }
                className={`${inp} w-full`}
              />
            </div>

            <div>
              <label className="mb-1 block text-xs text-slate-500">
                Billing cycle
              </label>

              <select
                name="billingCycle"
                defaultValue={
                  data.subscription
                    ?.billingCycle
                }
                className={`${inp} w-full`}
              >
                <option>
                  MONTHLY
                </option>
                <option>
                  YEARLY
                </option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs text-slate-500">
                Expiration policy
              </label>

              <select
                name="expirationBehavior"
                defaultValue={
                  data.subscription
                    ?.expirationBehavior
                }
                className={`${inp} w-full`}
              >
                <option>
                  READ_ONLY
                </option>
                <option>
                  FEATURE_RESTRICTED
                </option>
                <option>
                  FULL_ACCESS_BLOCKED
                </option>
              </select>
            </div>

            <button className="rounded-lg bg-orange-500 px-4 py-2 font-semibold text-slate-950 md:col-span-2">
              Update subscription
            </button>
          </form>
        )}

        {tab === 'Users' && (
          <div className={panel}>
            <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              {Object.entries(
                data.userStats
              )
                .filter(
                  ([key]) =>
                    key !== '_id'
                )
                .map(
                  ([
                    key,
                    value,
                  ]) => (
                    <div key={key}>
                      <p className="text-xs capitalize text-slate-500">
                        {key}
                      </p>

                      <b>
                        {String(
                          value ?? 0
                        )}
                      </b>
                    </div>
                  )
                )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-slate-500">
                  <tr>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>
                      Last login
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {data.users.map(
                    (companyUser) => (
                      <tr
                        key={
                          companyUser._id
                        }
                        className="border-t border-slate-800"
                      >
                        <td className="py-2">
                          {
                            companyUser.name
                          }

                          <p className="text-xs text-slate-500">
                            {
                              companyUser.email
                            }
                          </p>
                        </td>

                        <td>
                          {
                            companyUser.role
                          }
                        </td>

                        <td>
                          {
                            companyUser.status
                          }
                        </td>

                        <td>
                          {date(
                            companyUser.lastLogin
                          )}
                        </td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'Employees' && (
          <List
            rows={data.users.filter(
              (companyUser) =>
                companyUser.role ===
                'EMPLOYEE'
            )}
            empty="No employees"
            render={(
              employee
            ) => (
              <>
                <span>
                  <b>
                    {employee.name}
                  </b>

                  <small className="block text-slate-500">
                    {employee.designation ||
                      employee.email}
                  </small>
                </span>

                <span>
                  {employee.status} ·{' '}
                  {date(
                    employee.lastLogin
                  )}
                </span>
              </>
            )}
          />
        )}

        {tab === 'Usage' && (
          <div className="grid gap-3 md:grid-cols-3">
            <div className={panel}>
              <p className="text-xs text-slate-500">
                API requests
              </p>

              <b className="text-2xl">
                {
                  data.usage
                    .apiRequests
                }
              </b>
            </div>

            <div className={panel}>
              <p className="text-xs text-slate-500">
                Active users
              </p>

              <b className="text-2xl">
                {
                  data.usage
                    .activeUsers
                }
              </b>
            </div>

            <div className={panel}>
              <p className="text-xs text-slate-500">
                Storage
              </p>

              <b className="text-2xl">
                {(
                  data.usage
                    .storageBytes /
                  1024 /
                  1024
                ).toFixed(1)}{' '}
                MB
              </b>
            </div>

            <div
              className={`${panel} md:col-span-3`}
            >
              <h3 className="mb-3 font-semibold">
                Module usage
              </h3>

              {Object.entries(
                data.usage
                  .moduleUsage ||
                  {}
              ).map(
                ([
                  moduleName,
                  count,
                ]) => (
                  <div
                    key={
                      moduleName
                    }
                    className="flex justify-between border-b border-slate-800 py-2"
                  >
                    <span>
                      {moduleName}
                    </span>

                    <b>{count}</b>
                  </div>
                )
              )}
            </div>
          </div>
        )}

        {tab === 'Activity' && (
          <List
            rows={data.tickets}
            empty="No recent support activity"
            render={(row) => (
              <>
                <b>{row.subject}</b>

                <span>
                  {row.status} ·{' '}
                  {date(
                    row.createdAt
                  )}
                </span>
              </>
            )}
          />
        )}

        {tab === 'Billing' && (
          <List
            rows={data.payments}
            empty="No payments"
            render={(row) => (
              <>
                <b>
                  {row.plan} ·{' '}
                  {money(
                    row.amount
                  )}
                </b>

                <span>
                  {row.status} ·{' '}
                  {date(
                    row.createdAt
                  )}
                </span>
              </>
            )}
          />
        )}

        {tab === 'Audit Logs' && (
          <List
            rows={data.audits}
            empty="No audit events"
            render={(row) => (
              <>
                <b>{row.action}</b>

                <span>
                  {row.actorName ||
                    row.actorRole}{' '}
                  ·{' '}
                  {date(
                    row.createdAt
                  )}
                </span>
              </>
            )}
          />
        )}
      </div>
    );
  };

export default SuperAdminCompanyDetailPage;