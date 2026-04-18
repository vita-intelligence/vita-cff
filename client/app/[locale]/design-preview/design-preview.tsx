"use client";

import { MOCK_PROJECT } from "./mock-project";
import { ProjectOverviewModern } from "./project-overview-modern";


/**
 * Preview shell. Renders the chosen modern treatment of the
 * proposed Project Overview tab with real Valley Low Fat Burner
 * numbers. Deleted once the full workspace refactor lands.
 */
export function DesignPreview() {
  return (
    <div className="mt-10">
      <header className="mb-8 flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-1000 md:text-3xl">
          Project overview — design preview
        </h1>
        <p className="max-w-3xl text-sm text-ink-600">
          Candidate style for the Project workspace overview tab.
          Numbers are pulled from the Valley Low Fat Burner project
          (MA210367). Once you sign off on this treatment, it carries
          into the full workspace refactor — tabs, breadcrumbs,
          project status chip, and every child route (batch /
          validation / spec sheet) gets the same styling.
        </p>
      </header>

      <ProjectOverviewModern project={MOCK_PROJECT} />
    </div>
  );
}
