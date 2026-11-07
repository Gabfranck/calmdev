// A retired plan (Dev, 6 November 2026): nothing of it starts or costs again until it is reopened.
//   isRetired(plan)              → true for a plan retired by POST /api/plan/:id/retire or closed by hand (status 'closed',
//                                  closed: true or a closedAt), read the same way, without migration
//   retiredError()               → the Error every starting point throws (status 409, the path that works in its message)
//   retiredPlan(plan, why, at)   → the plan with status 'closed', closed, closedAt, closedWhy (closedAt kept when already retired)
//   reopenedPlan(plan, at)       → the plan without those fields, reopenedAt set

import { msg } from './i18n.mjs';

export const isRetired = (plan) => !!plan && (plan.status === 'closed' || plan.closed === true || !!plan.closedAt);

export const retiredError = () => Object.assign(new Error(msg('srv.e.retired')), { status: 409, retired: true });

export const retiredPlan = (plan, why, at) => {
  const w = String(why ?? '').trim().slice(0, 300);
  return { ...plan, status: 'closed', closed: true, closedAt: isRetired(plan) && plan.closedAt ? plan.closedAt : at, closedWhy: w || plan.closedWhy || '' };
};

export const reopenedPlan = (plan, at) => {
  const { status, closed, closedAt, closedWhy, ...rest } = plan;
  return { ...rest, ...(status && status !== 'closed' ? { status } : {}), reopenedAt: at };
};
