// Projects on the phone: pure functions, no React and no imports, so node can test them (test/phone-projects.test.mjs).
// A project is the absolute path the server puts on each plan (`plan.project`); its short name is the last segment.

export type ProjectPlan = { id: string; title: string; created: string; project?: string | null };
export type Group<P extends ProjectPlan = ProjectPlan> = { project: string | null; name: string; plans: P[] };

export const shortName = (project?: string | null): string => {
  const parts = String(project || '').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
};

const newest = (a: ProjectPlan, b: ProjectPlan) => String(b.created).localeCompare(String(a.created));

// null or '' means « Tous les projets ».
export const filterPlans = <P extends ProjectPlan>(plans: P[], project?: string | null): P[] =>
  project ? plans.filter((p) => p.project === project) : plans;

// Plans grouped by project: the group with the newest plan first, its plans newest first; plans without a project last.
export const groupPlans = <P extends ProjectPlan>(plans: P[]): Group<P>[] => {
  const by = new Map<string | null, P[]>();
  for (const p of plans) { const k = p.project || null; by.set(k, [...(by.get(k) || []), p]); }
  const groups: Group<P>[] = [...by].map(([project, list]) => ({ project, name: shortName(project), plans: [...list].sort(newest) }));
  return groups.sort((a, b) => (a.project === null ? 1 : b.project === null ? -1 : newest(a.plans[0], b.plans[0])));
};

export const projectsOf = <P extends ProjectPlan>(plans: P[]): { path: string; name: string; count: number }[] =>
  groupPlans(plans).filter((g) => g.project).map((g) => ({ path: g.project as string, name: g.name, count: g.plans.length }))
    .sort((a, b) => a.name.localeCompare(b.name));

export const projectOfPlan = (plans: ProjectPlan[], planId?: string | null): string | null =>
  plans.find((p) => p.id === planId)?.project || null;

// The plan to show: the current one if it is still in the list, else the newest.
export const pickPlan = <P extends ProjectPlan>(plans: P[], current?: string | null): string | null =>
  plans.some((p) => p.id === current) ? (current as string) : [...plans].sort(newest)[0]?.id || null;

// A stored project that no plan has any more (renamed, deleted) is forgotten: back to « Tous ».
export const validProject = (plans: ProjectPlan[], project?: string | null): string | null =>
  project && plans.some((p) => p.project === project) ? project : null;
