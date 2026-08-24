import { SourcesPanel } from "@/components/SourcesPanel";

export default function SourcesPage() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-foreground">Sources</h1>
      <p className="mt-1 text-sm text-muted">
        Enable or disable which platforms discovery searches. Adding a new connector is a matter
        of implementing the shared source interface — see{" "}
        <code className="rounded bg-surface-2 px-1 py-0.5">src/sources/</code>.
      </p>
      <div className="mt-6">
        <SourcesPanel />
      </div>
    </div>
  );
}
