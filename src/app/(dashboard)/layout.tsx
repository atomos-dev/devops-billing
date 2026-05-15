/**
 * Dashboard layout — wraps all authenticated pages with Sidebar and page header area.
 */
import { Sidebar } from "@/components/layout/sidebar";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex-1 pl-60">
        <main className="p-8">{children}</main>
      </div>
    </div>
  );
}
