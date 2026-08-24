import { SettingsForm } from "@/components/SettingsForm";
import { StatsPanel } from "@/components/StatsPanel";

export default function SettingsPage() {
  return (
    <div className="space-y-10 p-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Settings</h1>
        <p className="mt-1 text-sm text-muted">Discovery, AI budget, and cost overview.</p>
      </div>

      <StatsPanel />
      <SettingsForm />
    </div>
  );
}
