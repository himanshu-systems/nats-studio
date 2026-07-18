import { Icon } from "./Icon";
import { Badge, Panel } from "./ui";
import type { NavItem } from "../nav";

/**
 * Honest placeholder for a not-yet-built feature: shows exactly what the view
 * will do and which roadmap phase delivers it, so the app's map is complete
 * and navigable without pretending the feature works.
 */
export function ComingSoon({ item }: { item: NavItem }): JSX.Element {
  return (
    <div className="mx-auto flex h-full max-w-lg flex-col items-center justify-center gap-5 p-10 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-surface-2 text-accent">
        <Icon name={item.icon} size={30} />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-center gap-2">
          <h2 className="text-lg font-semibold text-content">{item.label}</h2>
          {item.phase && <Badge tone="accent">{item.phase}</Badge>}
        </div>
        <p className="text-sm leading-relaxed text-muted">{item.blurb}</p>
      </div>
      <Panel className="w-full p-4 text-left">
        <p className="text-xs leading-relaxed text-muted">
          This feature is on the roadmap and its backend is being built one crate at a time
          (JetStream, monitoring and services adapters). The navigation, design system and
          per-connection isolation are already in place, so it will slot in here when ready.
        </p>
      </Panel>
    </div>
  );
}
