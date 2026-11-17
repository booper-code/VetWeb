import type { Metadata } from "next";
import "./globals.css";
import OfflineStatus from "@/components/OfflineStatus";

export const metadata: Metadata = {
  title: "VetCloudPro | Biñan Animal Clinic",
  description:
    "Practice management for Biñan Animal Clinic: patient records, inventory, laboratory results and service billing.",
  manifest: "/manifest.webmanifest",
  other: process.env.VETCLOUD_STATIC_EXPORT === '1' ? { 'vetcloud-static-shell': '1' } : {},
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <OfflineStatus staticShell={process.env.VETCLOUD_STATIC_EXPORT === '1'} />
        {process.env.VETCLOUD_STATIC_EXPORT === '1' && (
          <div role="note" className="bg-amber-100 px-4 py-2 text-center text-sm font-bold text-amber-950">
            TEST STAGING — fictional records only. Shared Firebase project; not production-ready.
          </div>
        )}
        {children}
      </body>
    </html>
  );
}
